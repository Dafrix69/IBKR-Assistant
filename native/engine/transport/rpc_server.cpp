#include "transport/rpc_server.h"

#include "util/awake_clock.h"
#include "util/error.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/post.h"
#include "util/keychain.h"
#include "util/zod.h"

#include <QDateTime>
#include <QJsonArray>
#include <QPointer>
#include <QRandomGenerator>

#include <cstdio>

namespace ibkr::rpc {

using namespace Qt::StringLiterals;
using util::OJson;
namespace js = util::js;

// ---------------------------------------------------------------- 道表
const LaneTable& defaultLaneTable() {
    static const LaneTable table = [] {
        LaneTable t;
        // 界面每几秒自动打一次的周期轮询(对应 Python _LOW_PRIORITY_METHODS)。
        // 引擎仍是顺序执行,这里只做"插队":用户亲手发的请求先于轮询处理,
        // 否则「解析并校验」会排在 macro.board / tracker.reconcile 后面。
        t.low = {u"system.status"_s, u"macro.board"_s, u"alerts.poll"_s, u"pending.poll"_s, u"positions.list"_s, u"sectors.quotes"_s, u"pa.analyze"_s, u"book.snapshot"_s};
        // 本地道:同步的本地库 / 配置读写,来了就答,不排队——删一行成分股是一次 SQLite 写,没道理排在等网络的行情请求后面。
        t.local = {
            u"system.status"_s,
            u"sectors.list"_s, u"sectors.add"_s, u"sectors.delete"_s, u"sectors.add_stock"_s, u"sectors.remove_stock"_s, u"sectors.set_tag"_s,
            u"ideas.list"_s, u"ideas.add"_s, u"ideas.update"_s, u"ideas.digests"_s, u"ideas.search"_s,
            u"records.list"_s, u"records.get"_s, u"settings.get"_s, u"breaker.state"_s, u"alerts.list"_s, u"tracker.list"_s,
            // 碰均线的设置:一次 app_prefs 写,底账按新口径重算是 tickTouch 的事
            u"alerts.set_touch_config"_s,
            u"llm.catalog"_s, u"broker.catalog"_s,
            // 盯盘与托管对账的节拍器在引擎里(TradingEngine.startTrackerLoop),这两个请求只是读它最新一轮的结果——不该排在下单、大模型解析后面等
            u"tracker.poll"_s, u"tracker.reconcile"_s,
            // 优质股追踪:同步 SQLite + 读异动循环留在内存里的指标,取行情是循环自己的事(startAnomalyLoop)
            u"quality.list"_s, u"quality.add"_s, u"quality.update"_s, u"quality.remove"_s, u"quality.set_config"_s,
            // 备份清单是读一个目录;出一份备份是一条 VACUUM INTO(几十毫秒到一两秒),不该排在下单、解析后面
            u"data.backups"_s, u"data.backup"_s,
            // 股票池上的两个开关:建 / 删两张表里的一行,同步 SQLite,价位与行情都是别的循环的事
            u"pool.set_watch"_s,
            // IV 记录的状态与开关:数一下目录里的文件、写一行偏好;记的那一路是引擎里自己的循环
            u"options.iv_recorder"_s, u"options.iv_recorder_set"_s,
            // 日内剧本:读循环留在内存里的那一份、写一行偏好;取行情是循环自己的事
            u"options.terrain"_s, u"options.playbook"_s, u"options.playbook_set"_s,
            // 存 API Key / 富途解锁密码:写系统凭证库(子进程,可能等 macOS 弹窗,最多 20 秒)。和下单状态无关,不该让一个没人点的弹窗把排在后面的下单、立即平仓挡住
            u"keychain.set"_s, u"futu.set_password"_s,
            // Discord 跟单:状态是读内存与本地库;存 token 写系统凭证库(同上);重新连接只是换一条 WebSocket。都不碰下单状态
            u"follow.status"_s, u"follow.set_token"_s, u"follow.reconnect"_s,
            // 重要事件的口径与自定义事件:一次 app_prefs 写
            u"events.set_config"_s, u"events.add"_s, u"events.remove"_s,
        };
        // 读道:只读的行情 / 探测 / 纯计算,最多 kReadConcurrency 个并发;彼此独立,也不碰下单状态
        t.read = {
            u"positions.list"_s, u"options.entry_context"_s, u"sectors.earnings"_s, u"sectors.quotes"_s, u"pa.analyze"_s, u"book.snapshot"_s, u"options.wall"_s, u"macro.board"_s,
            u"screener.rs"_s, u"screener.inflection"_s, u"screener.deviation"_s, u"backtest.run"_s, u"backtest.strategies"_s, u"backtest.sweep"_s,
            u"pa.timeframes"_s, u"tws.scan"_s, u"tws.diagnose"_s, u"futu.scan"_s, u"futu.diagnose"_s,
            u"tracker.target_preview"_s,
            // 下单页的历史相似交易:读本地库,过期蝴蝶的结算价可能要取一次日线,放读道不挡下单
            u"ideas.similar_trades"_s,
            // 绩效体检:读本地库算账,过期蝴蝶的结算价可能要取一次日线,同上
            u"review.performance"_s,
            // 信号成绩单:读本地库的信号日志,逐只取日线(10 分钟缓存),纯计算
            u"review.signals"_s,
            // 强势股筛选:和 screener.rs 一样逐只拉日线(10 分钟缓存),纯计算
            u"screener.leaders"_s,
            // 蝴蝶测算:取现价与三条腿的盘口 / IV(自己的行情流,不碰盯盘的),纯计算。开着自动刷新时十秒一次,不该排在交易道上
            u"options.fly_plan"_s,
            // 测算面板上的实时现价:读常驻行情流里的那一笔,界面两秒一次
            u"options.spot"_s,
            // 蝶式入场助手:读剧本快照、日线缓存与两条期权墙(60 秒缓存),只给建议;面板看得见时一分钟一次
            u"options.entry_assist"_s,
            // 重要事件的清单:从没拉到过日历源时同步等它(最多 8 秒),不该挡下单
            u"events.list"_s,
            // 信息链路:读本地库合成时间线,消息上"此刻的价"按批读已订着的行情;档案多读一次持仓(常驻缓存)
            u"intel.feed"_s, u"intel.dossier"_s,
        };
        return t;
    }();
    return table;
}

// ---------------------------------------------------------------- objectParams
namespace {

QString jsonTypeName(const QJsonValue& v) {
    switch (v.type()) {
    case QJsonValue::Null: return u"null"_s;
    case QJsonValue::Bool: return u"boolean"_s;
    case QJsonValue::Double: return u"number"_s;
    case QJsonValue::String: return u"string"_s;
    case QJsonValue::Array: return u"array"_s;
    case QJsonValue::Object: return u"object"_s;
    case QJsonValue::Undefined: return u"undefined"_s;
    }
    return u"unknown"_s;
}

}  // namespace

QJsonObject objectParams(const QString& method, const QJsonValue& params) {
    if (params.isObject()) return params.toObject();
    throw RpcError(-32602, QStringLiteral("%1 的参数不对:params 应为 object,收到 %2").arg(method, jsonTypeName(params)));
}

const OJson& objectParams(const QString& method, const OJson& params) {
    if (params.isObject()) return params;
    throw RpcError(-32602, QStringLiteral("%1 的参数不对:params 应为 object,收到 %2").arg(method, util::zod::parsedTypeName(&params)));
}

// ---------------------------------------------------------------- 构造与登记
namespace {

double nowMs() { return double(QDateTime::currentMSecsSinceEpoch()); }

}  // namespace

RpcServer::RpcServer(Writer out, QObject* parent)
    : QObject(parent), out_(std::move(out)), lanes_(defaultLaneTable()), timings_(nowMs(), [] { return QRandomGenerator::global()->generateDouble(); }) {
    flushTimer_.setInterval(int(kFlushMs));
    connect(&flushTimer_, &QTimer::timeout, this, [this] { flushPerf(); });
}

namespace {
bool g_startupChecked = false;
}
bool startupChecked() { return g_startupChecked; }
void markStartupChecked() { g_startupChecked = true; }
void resetStartupCheckedForTest() { g_startupChecked = false; }

void RpcServer::addAsync(const QString& method, AsyncHandler handler) {
    if (requireStartup_ && method != u"system.status" && !g_startupChecked)
        throw util::JsError(u"启动前的检查(cli::startupChecks:读配置、开交易库)还没跑过,不能登记方法:%1"_s.arg(method));
    // 无原型的表:请求里的 method 是外来字符串,"constructor" / "toString" 不该从别处捞到东西(QHash 没有这个问题,只认登记过的)
    if (table_.contains(method)) throw util::JsError(u"RPC 方法重复登记:%1"_s.arg(method));
    table_.insert(method, std::move(handler));
}

void RpcServer::addOJson(const QString& method, OJsonHandler handler) {
    addAsync(method, [handler = std::move(handler)](const OJson& params) -> util::Task<OJson> {
        // 同步的 handler:抛了就是一个已经失败的 Task(同 TS 里 async call() 把同步抛的错变成 rejected promise)
        try {
            return util::Task<OJson>::resolved(handler(params));
        } catch (...) {
            util::Deferred<OJson> failed;
            failed.reject(std::current_exception());
            return failed.task();
        }
    });
}

void RpcServer::add(const QString& method, Handler handler) {
    addOJson(method, [handler = std::move(handler)](const OJson& params) { return OJson::fromQJson(handler(params.toQJson())); });
}

QStringList RpcServer::methodNames() const {
    QStringList names = table_.keys();
    names.sort();
    return names;
}

Lane RpcServer::laneOf(const QString& method) const {
    if (lanes_.local.contains(method)) return Lane::Local;
    return lanes_.read.contains(method) ? Lane::Read : Lane::Trade;
}

// ---------------------------------------------------------------- 写
void RpcServer::write(const OJson& message) { out_(util::toNodeUtf8(util::stringifyOJson(message, 0))); }

void RpcServer::stderrLine(const QString& line) {
    if (hooks.stderrLine) hooks.stderrLine(line);
    else std::fprintf(stderr, "%s\n", util::toNodeUtf8(line).constData());
}

void RpcServer::emitEvent(const QString& event, const OJson& data) {
    write(js::object({{u"jsonrpc"_s, js::S(u"2.0"_s)},
                      {u"method"_s, js::S(u"event"_s)},
                      {u"params"_s, js::object({{u"event"_s, js::S(event)}, {u"data"_s, data}})}}));
}

void RpcServer::emitEvent(const QString& event, const QJsonObject& data) { emitEvent(event, OJson::fromQJson(data)); }

// ---------------------------------------------------------------- 生命周期
void RpcServer::begin(const QString& configPath) {
    emitEvent(u"ready"_s, js::object({{u"protocol"_s, js::S(QLatin1StringView(kProtocolVersion))}, {u"config"_s, js::S(configPath)}}));
    if (hooks.onServe) hooks.onServe();
    flushTimer_.start();
}

void RpcServer::flushPerf() {
    const OJson extra = hooks.perfExtra ? hooks.perfExtra() : js::object();
    if (const auto line = timings_.flush(nowMs(), extra)) stderrLine(*line);
}

void RpcServer::maybeFinish() {
    if (!closed_ || finished_ || tradeBusy_ || detached_ != 0 || !normal_.empty() || !low_.empty() || !reads_.empty()) return;
    finished_ = true;  // EOF、队列已空、在途请求都答完了,才退出
    flushTimer_.stop();
    flushPerf();
    if (hooks.onShutdown) hooks.onShutdown();
    if (onFinished_) onFinished_(0);
}

// 微任务队列:Node 里同一批来的行是在一个 JS 任务里同步派发的,回执都在之后的微任务里按排队的先后写;这里照着做,
// 才能让「解析不了的行」(交易道主循环醒来时直接写)与本地道 / 读道同步答完的回执的先后同 TS
void RpcServer::enqueueMicro(std::function<void()> f) {
    micro_.push_back(std::move(f));
    if (microPosted_) return;
    microPosted_ = true;
    QPointer<RpcServer> self(this);
    util::postQueued(this, [self] {
        if (!self) return;
        while (!self->micro_.empty()) {  // 跑的过程中新排进来的接着跑(同微任务队列抽到空)
            std::function<void()> next = std::move(self->micro_.front());
            self->micro_.pop_front();
            next();
            if (!self) return;
        }
        self->microPosted_ = false;
    });
}

void RpcServer::schedulePump() {
    if (pumpScheduled_) return;
    pumpScheduled_ = true;
    QPointer<RpcServer> self(this);
    enqueueMicro([self] {
        if (!self) return;
        self->pumpScheduled_ = false;
        self->pumpTrade();
    });
}

void RpcServer::handleEof() {
    closed_ = true;
    schedulePump();
}

// ---------------------------------------------------------------- 读一行
void RpcServer::handleLine(QByteArrayView rawLine) {
    // readline 的断行:\r\n、\r、\n、U+2028、U+2029(一行里夹着这些就是好几行)
    const QString text = util::nodeUtf8(rawLine.toByteArray());
    qsizetype from = 0;
    const auto emitPiece = [&](qsizetype to) { processLine(text.mid(from, to - from)); };
    for (qsizetype i = 0; i < text.size(); ++i) {
        const char16_t c = text[i].unicode();
        if (c == u'\r' || c == u'\n' || c == 0x2028 || c == 0x2029) {
            emitPiece(i);
            if (c == u'\r' && i + 1 < text.size() && text[i + 1] == u'\n') ++i;
            from = i + 1;
        }
    }
    if (from < text.size()) emitPiece(text.size());
}

void RpcServer::processLine(const QString& rawLine) {
    const QString line = util::jsTrim(rawLine);
    if (line.isEmpty()) return;
    const auto parsed = util::parseOJson(line);
    Pending pending;
    pending.receivedUs = util::awakeMicros();
    if (!parsed) {
        pending.bad = true;
        normal_.push_back(std::move(pending));
        schedulePump();
        return;
    }
    pending.request = *parsed;
    dispatch(std::move(pending));
}

namespace {

/// String(request["method"] ?? "")
QString methodOf(const OJson& request) { return js::strOr(js::prop(&request, u"method"_s), QString()); }

}  // namespace

void RpcServer::dispatch(Pending request) {
    const QString method = methodOf(request.request);
    if (lanes_.local.contains(method)) {
        // 本地道:来了就答
        ++detached_;
        QPointer<RpcServer> self(this);
        handle(std::move(request)).onDone([self] {
            if (!self) return;
            --self->detached_;
            self->schedulePump();
        });
        return;
    }
    if (lanes_.read.contains(method)) {
        reads_.push_back(std::move(request));  // 读道:有限并发
        pumpReads();
        return;
    }
    (lanes_.low.contains(method) ? low_ : normal_).push_back(std::move(request));  // 交易道:严格顺序
    schedulePump();
}

void RpcServer::pumpReads() {
    if (pumpingReads_) return;
    pumpingReads_ = true;
    QPointer<RpcServer> self(this);
    while (readsInFlight_ < kReadConcurrency && !reads_.empty()) {
        Pending next = std::move(reads_.front());
        reads_.pop_front();
        ++readsInFlight_;
        ++detached_;
        handle(std::move(next)).onDone([self] {
            if (!self) return;
            --self->readsInFlight_;
            --self->detached_;
            self->pumpReads();
            self->schedulePump();
        });
        if (!self) return;
    }
    pumpingReads_ = false;
}

void RpcServer::pumpTrade() {
    if (pumpingTrade_) {
        pumpTradeAgain_ = true;
        return;
    }
    pumpingTrade_ = true;
    QPointer<RpcServer> self(this);
    do {
        pumpTradeAgain_ = false;
        while (!tradeBusy_) {
            // request = normal.shift() ?? low.shift()
            std::deque<Pending>& queue = !normal_.empty() ? normal_ : low_;
            if (queue.empty()) break;
            Pending next = std::move(queue.front());
            queue.pop_front();
            if (next.bad) {
                write(js::object({{u"jsonrpc"_s, js::S(u"2.0"_s)},
                                  {u"id"_s, js::Null()},
                                  {u"error"_s, js::object({{u"code"_s, js::N(-32700)}, {u"message"_s, js::S(u"无法解析的 JSON"_s)}})}}));
                continue;
            }
            const util::Task<void> task = handle(std::move(next));
            if (!self) return;
            if (task.done()) continue;  // 同步答完的,接着取下一个
            tradeBusy_ = true;
            task.onDone([self] {
                if (!self) return;
                self->tradeBusy_ = false;
                self->pumpTrade();
            });
        }
    } while (pumpTradeAgain_);
    pumpingTrade_ = false;
    maybeFinish();
}

// ---------------------------------------------------------------- 一个请求
util::Task<OJson> RpcServer::call(const QString& method, const OJson& params) {
    // TS 的 async call():同步抛的错也是 rejected promise
    try {
        const auto it = table_.constFind(method);
        if (it == table_.constEnd()) throw RpcError(-32601, u"未知方法:%1"_s.arg(method));
        return (*it)(params);
    } catch (...) {
        util::Deferred<OJson> failed;
        failed.reject(std::current_exception());
        return failed.task();
    }
}

namespace {

OJson errorMessage(const OJson& id, int code, const QString& message) {
    return js::object({{u"jsonrpc"_s, js::S(u"2.0"_s)},
                       {u"id"_s, id},
                       {u"error"_s, js::object({{u"code"_s, js::N(code)}, {u"message"_s, js::S(message)}})}});
}

}  // namespace

util::Task<void> RpcServer::handle(Pending pending) {
    QPointer<RpcServer> self(this);
    const qint64 startedUs = util::awakeMicros();
    const QString method = methodOf(pending.request);
    const OJson* idPtr = js::prop(&pending.request, u"id"_s);
    const OJson requestId = js::nullish(idPtr) ? OJson::null() : *idPtr;  // request["id"] ?? null
    const OJson* paramsPtr = js::prop(&pending.request, u"params"_s);
    const OJson params = js::nullish(paramsPtr) ? js::object() : *paramsPtr;  // request["params"] ?? {}

    // handleInner
    std::exception_ptr failure;
    OJson result;
    try {
        result = co_await call(method, params);
    } catch (...) {
        failure = std::current_exception();
    }
    // handleInner 里 `await this.call(…)` 之后才写回执:同步答完的 handler 也晚一个微任务
    struct NextTick {
        RpcServer* server;
        bool await_ready() const noexcept { return false; }
        void await_suspend(std::coroutine_handle<> h) const { server->enqueueMicro([h] { h.resume(); }); }
        void await_resume() const noexcept {}
    };
    if (!self) co_return;
    co_await NextTick{this};
    if (!self) co_return;
    OJson message;
    if (!failure) {
        message = js::object({{u"jsonrpc"_s, js::S(u"2.0"_s)}, {u"id"_s, requestId}, {u"result"_s, result}});
    } else {
        try {
            std::rethrow_exception(failure);
        } catch (const util::RpcError& exc) {
            message = errorMessage(requestId, exc.code(), exc.message());
        } catch (const util::KeychainError& exc) {
            // 凭证库的错(超时、被拒、读不到)本身是一句人话,原样给界面(超时那句会说去处理系统弹窗);不打调用栈
            message = errorMessage(requestId, -32008, exc.message());
        } catch (const util::JsError& exc) {
            // 没想到的错:调用栈进 stderr,界面只拿一句。TS 是 `${constructor.name}: ${message}`;C++ 这边认不出 JS 的类名,一律是 Error
            stderrLine(u"%1: %2"_s.arg(method, exc.message()));
            message = errorMessage(requestId, -32000, u"Error: %1"_s.arg(exc.message()));
        } catch (const std::exception& exc) {
            stderrLine(u"%1: %2"_s.arg(method, QString::fromUtf8(exc.what())));
            message = errorMessage(requestId, -32000, u"Error: %1"_s.arg(QString::fromUtf8(exc.what())));
        } catch (...) {
            // 抛出来的不是 std::exception(第三方库抛的值之类):不能让它从事件循环里漏出去把整个引擎带走
            stderrLine(u"%1: 不是 std::exception 的异常"_s.arg(method));
            message = errorMessage(requestId, -32000, u"Error: 未知的异常"_s);
        }
    }
    write(message);

    // handle() 的 finally:排队与执行各多久
    const double run = double(util::awakeMicros() - startedUs) / 1000.0;
    const double wait = double(startedUs - pending.receivedUs) / 1000.0;
    timings_.record(method, laneOf(method), wait, run);
    if (const auto slow = slowLine(method, wait, run, slowMs_)) stderrLine(*slow);
}

}  // namespace ibkr::rpc
