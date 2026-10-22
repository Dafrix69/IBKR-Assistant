// svc1 簇对拍用的"世界"的 C++ 一半:虚拟的钟与计时器(SvcRuntime)、假宿主(设置、router、引擎、行情都按脚本答、每一次调用都记下来)、
// 真的 TradeStore(临时目录里)、跑一份脚本的 Runner。与 tests/fixtures/svc1_world.mjs 一句对一句——脚本格式与约定在那个文件的开头写着;
// 改任何一边都要同时改另一边。夹具里每个场景带着脚本与期望({log, steps, db}),Runner 读同一份脚本、把日志与结果按同样的形状交回去。
#pragma once

#include "domain/config.h"
#include "domain/store.h"
#include "execution/broker_pricing.h"
#include "execution/option_marks.h"
#include "js_fixture.h"
#include "orchestrate/services/svc1_ports.h"
#include "util/js_runtime.h"
#include "util/jsobj.h"
#include "util/rpc_error.h"
#include "util/sqlite.h"
#include "util/task.h"

#include <QDir>
#include <QHash>
#include <QTemporaryDir>

#include <functional>
#include <memory>
#include <vector>

namespace sw {

using ibkr::util::OJson;
using ibkr::util::Task;
using ibkr::util::Deferred;
namespace js = ibkr::util::js;
namespace orch = ibkr::orchestrate;
using Qt::StringLiterals::operator""_s;

inline QString str(const OJson& o, const QString& k, const QString& fallback = {}) {
    const OJson* v = o.get(k);
    return v && v->type == OJson::String ? v->s : fallback;
}
inline double num(const OJson& o, const QString& k, double fallback = 0) {
    const OJson* v = o.get(k);
    return v && v->type == OJson::Number ? v->n : fallback;
}
inline bool flag(const OJson& o, const QString& k, bool fallback = false) {
    const OJson* v = o.get(k);
    return v && v->type == OJson::Bool ? v->b : fallback;
}
inline OJson optJson(const std::optional<OJson>& v) { return v ? *v : js::Null(); }

/// 脚本里的错误条目 → 异常。kind:plain / rpc / broker / marks
inline std::exception_ptr makeError(const OJson& spec) {
    const QString kind = str(spec, u"kind"_s), message = str(spec, u"message"_s);
    if (kind == u"rpc") return std::make_exception_ptr(ibkr::util::RpcError(static_cast<int>(num(spec, u"code"_s, -32017)), message));
    if (kind == u"broker") return std::make_exception_ptr(ibkr::execution::BrokerError(message));
    if (kind == u"marks") return std::make_exception_ptr(ibkr::execution::OptionMarksError(message));
    return std::make_exception_ptr(ibkr::util::JsError(message));
}

/// 错误在结果里的样子:话 + RpcError 的码(不是 RpcError 的是 null)
inline OJson errOut(std::exception_ptr e) {
    try {
        std::rethrow_exception(e);
    } catch (const ibkr::util::RpcError& r) {
        return js::object({{u"error"_s, js::S(r.message())}, {u"code"_s, js::N(r.code())}});
    } catch (const ibkr::util::JsError& j) {
        return js::object({{u"error"_s, js::S(j.message())}, {u"code"_s, js::Null()}});
    } catch (const std::exception& x) {
        return js::object({{u"error"_s, js::S(QString::fromUtf8(x.what()))}, {u"code"_s, js::Null()}});
    }
}

/// 世界:钟、计时器、日志、假答案队列。同时是 service 看到的 SvcRuntime
class World : public orch::SvcRuntime {
public:
    explicit World(const OJson& script) : script_(script) {
        T = num(script, u"start"_s);
        pushClock();
        ibkr::util::setRandomUUIDForTests([this] { return u"00000000-0000-4000-8000-%1"_s.arg(++uuidN, 12, 10, QChar(u'0')); });
        if (const OJson* fakes = script.get(u"fakes"_s)) {
            for (const auto& [k, list] : fakes->fields) queues_.insert(k, Queue{list, 0});
        }
    }
    ~World() override {
        ibkr::util::setDateNowForTests({});
        ibkr::util::setRandomUUIDForTests({});
        ibkr::domain::setClock(std::nullopt);
    }

    double T = 0;
    OJson log = js::array();
    QTemporaryDir dir;
    const OJson& script() const { return script_; }

    void pushClock() {
        ibkr::util::setDateNowForTests([this] { return T; });
        ibkr::domain::setClock(T);
    }
    void rec(const QString& method, const OJson& args) {
        log.items.append(js::object({{u"t"_s, js::N(T)}, {u"m"_s, js::S(method)}, {u"a"_s, jsfix::enc(args)}}));
    }

    struct Timer {
        double at;
        quint64 seq;
        int id;
        std::function<void()> fn;
    };
    int schedule(double delay, std::function<void()> fn) {
        const int id = nextTimer_++;
        timers_.push_back(Timer{T + delay, counter_++, id, std::move(fn)});
        return id;
    }
    bool cancel(int id) {
        for (auto it = timers_.begin(); it != timers_.end(); ++it) {
            if (it->id == id) {
                timers_.erase(it);
                return true;
            }
        }
        return false;
    }
    Task<> sleep(double delay) {
        Deferred<> d;
        schedule(delay, [d]() mutable { d.resolve(); });
        return d.task();
    }
    /// 最早的一个计时器(同刻按先后)到点:钟走到那一刻,触发。没有计时器或太晚回 false
    bool stepOne(double limit = std::numeric_limits<double>::infinity()) {
        auto best = timers_.end();
        for (auto it = timers_.begin(); it != timers_.end(); ++it) {
            if (best == timers_.end() || it->at < best->at || (it->at == best->at && it->seq < best->seq)) best = it;
        }
        if (best == timers_.end() || best->at > limit) return false;
        Timer t = std::move(*best);
        timers_.erase(best);
        if (t.at > T) T = t.at;
        pushClock();
        t.fn();
        return true;
    }
    void advance(double ms) {
        const double end = T + ms;
        while (stepOne(end)) {}
        if (end > T) T = end;
        pushClock();
    }

    // ---- SvcRuntime:service 用的计时器(记 setTimeout / clearTimeout)
    double perfMs() override { return T; }
    int setTimeout(int ms, std::function<void()> fn) override {
        rec(u"setTimeout"_s, js::array({js::N(ms)}));
        return schedule(ms >= 1 ? ms : 1, std::move(fn));
    }
    void clearTimeout(int id) override {
        if (cancel(id)) rec(u"clearTimeout"_s, js::array());
    }
    int setInterval(int, std::function<void()>) override { qFatal("svc1 不用 setInterval"); }
    void clearInterval(int) override {}
    double random() override { return 0.5; }

    // ---- 假答案队列
    /// 按调用先后各取一个答案,用完重复最后一个;没有这个键回 dflt
    OJson next(const QString& key, const OJson& dflt) {
        auto it = queues_.find(key);
        if (it == queues_.end() || it->list.items.isEmpty()) return dflt;
        const OJson v = it->list.items[qMin<qsizetype>(it->i, it->list.items.size() - 1)];
        it->i += 1;
        return v;
    }
    void setFake(const QString& key, const OJson& list) { queues_.insert(key, Queue{list, 0}); }
    bool has(const QString& key) const { return queues_.contains(key); }
    /// 队列键:有 "<base>|<symbol>" 的队列用它,否则 "<base>|*",再否则缺省
    OJson nextFor(const QString& base, const QString& symbol, const OJson& dflt) {
        return has(base + u"|"_s + symbol) ? next(base + u"|"_s + symbol, dflt) : next(base + u"|*"_s, dflt);
    }

    /// 一条答案 → Task(走计时器队,从不当场 resolve)。conv:ok 值 → T
    template <class R, class Conv>
    Task<R> answer(const OJson& entry, Conv conv) {
        Deferred<R> d;
        const double delay = num(entry, u"delay"_s);
        const OJson* err = entry.get(u"err"_s);
        const OJson errSpec = err ? *err : OJson();
        const OJson ok = entry.get(u"ok"_s) ? jsfix::dec(*entry.get(u"ok"_s)) : OJson();
        const bool failing = err != nullptr;
        schedule(delay, [d, failing, errSpec, ok, conv]() mutable {
            if (failing) d.reject(makeError(errSpec));
            else d.resolve(conv(ok));
        });
        return d.task();
    }

private:
    struct Queue {
        OJson list;
        qsizetype i = 0;
    };
    OJson script_;
    std::vector<Timer> timers_;
    quint64 counter_ = 0;
    int nextTimer_ = 1;
    int uuidN = 0;
    QHash<QString, Queue> queues_;
};

/// 整个库的样子:每张表按 rowid 的全部行(有行的才写)
inline OJson dumpDb(const QString& path) {
    ibkr::util::sqlite::Database db(path, {true, true, 5000});
    const QList<OJson> master = db.prepare(u"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"_s).all();
    OJson tables = js::object();
    for (const OJson& t : master) {
        const QString name = js::str(t.get(u"name"_s));
        if (name.startsWith(u"sqlite_") || name.startsWith(u"ideas_fts")) continue;
        QList<ibkr::util::sqlite::Row> rows;
        try {
            rows = db.prepare(u"SELECT * FROM \"%1\" ORDER BY rowid"_s.arg(name)).allRows();
        } catch (const ibkr::util::JsError&) {
            rows = db.prepare(u"SELECT * FROM \"%1\""_s.arg(name)).allRows();
        }
        if (rows.isEmpty()) continue;
        QList<OJson> out;
        for (const auto& r : rows) {
            QList<OJson> cells;
            for (const auto& c : r.cells) {
                if (std::holds_alternative<QByteArray>(c)) cells << js::object({{u"blob"_s, js::S(QString::fromLatin1(std::get<QByteArray>(c).toHex()))}});
                else cells << ibkr::util::sqlite::cellJson(c);
            }
            out << js::array(cells);
        }
        tables.set(name, js::array(out));
    }
    return tables;
}

/// 通知 / 事件 / stderr 都记在 World 的日志里的假宿主。子类(各 service 的测试)补自己的 Svc1Engine 与 router
class Host : public orch::Svc1Host {
public:
    Host(World& w, ibkr::domain::Settings settings) : w_(w), settings_(std::move(settings)) {}
    const ibkr::domain::Settings& settings() const override { return settings_; }
    void setSettings(ibkr::domain::Settings s) { settings_ = std::move(s); }
    std::shared_ptr<orch::Router> router() const override { return nullptr; }
    orch::TradingEngine& engine() override { qFatal("svc1 的 service 只经 svc1Engine() 碰引擎"); }
    void emitEvent(const QString& event, const OJson& payload) override { w_.rec(u"emit"_s, js::array({js::S(event), payload})); }
    std::shared_ptr<ibkr::execution::BrokerRouter> broker() const override { return nullptr; }
    std::shared_ptr<orch::RouterPort> routerPort() const override { return router_; }
    orch::SvcEngine& svcEngine() override { return svcEngine_; }
    orch::SvcRuntime& runtime() override { return w_; }
    orch::Svc1Engine& svc1Engine() override { return *engine_; }
    void stderrLine(const QString& line) override { w_.rec(u"stderr"_s, js::array({js::S(line)})); }

    void setRouter(std::shared_ptr<orch::RouterPort> r) { router_ = std::move(r); }
    void setEngine(orch::Svc1Engine* e) { engine_ = e; }

private:
    struct NullNotifier : orch::NotifierPort {
        void notify(const QString&, const QString&, const QString&) override {}
        void warning(const QString&) override {}
    };
    struct NullEngine : orch::SvcEngine {
        ibkr::domain::TradeStore& store() override { qFatal("svc1 的测试不走 SvcEngine"); }
        orch::NotifierPort& notifier() override { return n; }
        void reconcileSoon() override {}
        int attachListeners() override { return 0; }
        NullNotifier n;
    };
    World& w_;
    ibkr::domain::Settings settings_;
    std::shared_ptr<orch::RouterPort> router_;
    NullEngine svcEngine_;
    orch::Svc1Engine* engine_ = nullptr;
};

/// 假 router:RouterPort + Svc1Router。状态在 state 里({sessions, volume, covered, noSession}),答案按 "router.<方法>" 的队列(见 svc1_world.mjs 的 makeRouter)
class FakeRouter : public orch::RouterPort, public orch::Svc1Router {
public:
    FakeRouter(World& w, OJson initial) : state(std::move(initial)), w_(w) {}
    OJson state;
    std::shared_ptr<ibkr::execution::IbSession> session;

    bool hasSessions() override { return flag(state, u"sessions"_s, true); }
    Task<QList<OJson>> positions() override {
        w_.rec(u"router.positions"_s, js::array());
        return w_.answer<QList<OJson>>(w_.next(u"router.positions"_s, ok(js::array())), [](const OJson& v) { return v.items; });
    }
    Task<OJson> streamQuotes(QStringList symbols) override {
        w_.rec(u"router.streamQuotes"_s, js::array({js::strings(symbols)}));
        return w_.answer<OJson>(w_.next(u"router.streamQuotes"_s, ok(js::object())), [](const OJson& v) { return v; });
    }
    Task<OJson> stockQuotes(QStringList) override { qFatal("svc1 不用 stockQuotes"); }
    Task<std::optional<double>> indexPrice(QString symbol) override {
        w_.rec(u"router.indexPrice"_s, js::array({js::S(symbol)}));
        return w_.answer<std::optional<double>>(w_.next(u"router.indexPrice"_s, ok(js::Null())), [](const OJson& v) -> std::optional<double> {
            return v.type == OJson::Null ? std::nullopt : std::optional<double>(v.n);
        });
    }
    std::optional<OJson> spotInfo(const QString& symbol) override {
        w_.rec(u"router.spotInfo"_s, js::array({js::S(symbol)}));
        const OJson e = w_.next(u"router.spotInfo"_s, ok(js::Null()));
        if (const OJson* err = e.get(u"err"_s)) std::rethrow_exception(makeError(*err));
        const OJson v = e.get(u"ok"_s) ? jsfix::dec(*e.get(u"ok"_s)) : OJson();
        return v.type == OJson::Null ? std::nullopt : std::optional<OJson>(v);
    }
    bool upstreamOk() override { return true; }
    std::shared_ptr<ibkr::execution::IbSession> marketSession() override {
        w_.rec(u"router.marketSession"_s, js::array());
        if (flag(state, u"noSession"_s)) throw ibkr::execution::BrokerError(u"没有连着的会话"_s);
        return session;
    }
    Task<OJson> optionChain(QString, std::optional<QString>, double, std::optional<double>, QString) override { qFatal("svc1 不用 optionChain"); }
    Task<QList<OJson>> historicalBars(QString symbol, QString start, QString end) override {
        w_.rec(u"router.historicalBars"_s, js::array({js::S(symbol), js::S(start), js::S(end)}));
        return w_.answer<QList<OJson>>(w_.next(u"router.historicalBars"_s, ok(js::array())), [](const OJson& v) { return v.items; });
    }
    Task<ibkr::execution::TaggedBars> intradayBars(QString, QString, bool, std::optional<QString>, bool) override { qFatal("svc1 不用 intradayBars"); }

    bool supportsVolumeQuotes() override { return flag(state, u"volume"_s, true); }
    Task<OJson> volumeQuotes(QStringList symbols) override {
        w_.rec(u"router.volumeQuotes"_s, js::array({js::strings(symbols)}));
        return w_.answer<OJson>(w_.next(u"router.volumeQuotes"_s, ok(js::object())), [](const OJson& v) { return v; });
    }
    int releaseVolumeStreams(QStringList keep) override {
        w_.rec(u"router.releaseVolumeStreams"_s, js::array({js::strings(keep)}));
        const OJson e = w_.next(u"router.releaseVolumeStreams"_s, ok(js::N(0)));
        if (const OJson* err = e.get(u"err"_s)) std::rethrow_exception(makeError(*err));
        return static_cast<int>(num(e, u"ok"_s));
    }
    std::optional<QStringList> coveredAccounts() override {
        const OJson* cov = state.get(u"covered"_s);
        if (!cov || cov->type == OJson::Null) return std::nullopt;
        w_.rec(u"router.coveredAccounts"_s, js::array());
        QStringList out;
        for (const OJson& x : cov->items) out.append(js::str(&x));
        return out;
    }

private:
    static OJson ok(const OJson& v) { return js::object({{u"ok"_s, v}}); }
    World& w_;
};

/// 假 MarketDataService:答案队列 market.wallFor|<代码> / market.spotOf|<代码> / market.dailyHistory|<代码>(没有就 |*)、market.quotesOf
class FakeMarket : public orch::MarketDataPort {
public:
    explicit FakeMarket(World& w) : w_(w) {}
    Task<OJson> wallFor(QString symbol, std::optional<QString> expiry, double width, std::optional<double> span, QString preferClass) override {
        w_.rec(u"market.wallFor"_s, js::array({js::S(symbol), expiry ? js::S(*expiry) : js::Null(), js::N(width), js::NOrNull(span), js::S(preferClass)}));
        return w_.answer<OJson>(w_.nextFor(u"market.wallFor"_s, symbol, js::object({{u"err"_s, js::object({{u"kind"_s, js::S(u"rpc"_s)}, {u"code"_s, js::N(-32017)}, {u"message"_s, js::S(u"没有脚本化的期权墙"_s)}})}})),
                                [](const OJson& v) { return v; });
    }
    Task<std::optional<double>> spotOf(QString symbol) override {
        w_.rec(u"market.spotOf"_s, js::array({js::S(symbol)}));
        return w_.answer<std::optional<double>>(w_.nextFor(u"market.spotOf"_s, symbol, js::object({{u"ok"_s, js::Null()}})), [](const OJson& v) -> std::optional<double> {
            return v.type == OJson::Null ? std::nullopt : std::optional<double>(v.n);
        });
    }
    Task<QList<OJson>> dailyHistory(QString symbol) override {
        w_.rec(u"market.dailyHistory"_s, js::array({js::S(symbol)}));
        return w_.answer<QList<OJson>>(w_.nextFor(u"market.dailyHistory"_s, symbol, js::object({{u"ok"_s, js::array()}})), [](const OJson& v) { return v.items; });
    }
    Task<std::map<QString, std::optional<orch::SpotQuote>>> quotesOf(QStringList symbols) override {
        w_.rec(u"market.quotesOf"_s, js::array({js::strings(symbols)}));
        return w_.answer<std::map<QString, std::optional<orch::SpotQuote>>>(w_.next(u"market.quotesOf"_s, js::object({{u"ok"_s, js::object()}})), [symbols](const OJson& obj) {
            std::map<QString, std::optional<orch::SpotQuote>> out;
            for (const QString& s : symbols) {
                const OJson* q = obj.get(s);
                if (js::nullish(q)) {
                    out[s] = std::nullopt;
                    continue;
                }
                orch::SpotQuote quote;
                quote.price = js::num(q->get(u"price"_s));
                if (const OJson* t = q->get(u"tradedAt"_s); t && t->type == OJson::Number) quote.tradedAt = t->n;
                quote.source = js::strOr(q->get(u"source"_s), QString());
                out[s] = quote;
            }
            return out;
        });
    }

private:
    World& w_;
};

/// Svc1Engine 的底子:库是真的、通知记在日志里,其余(熔断、速记、发单……)各 service 的测试按需要覆盖,没覆盖的被叫到就是测试写错了
class BaseEngine : public orch::Svc1Engine {
public:
    BaseEngine(World& w, ibkr::domain::TradeStore& s) : w_(w), store_(s) {}
    ibkr::domain::TradeStore& store() override { return store_; }
    void notify(const QString& title, const QString& body, const QString& subtitle, bool os) override {
        w_.rec(u"notify"_s, js::array({js::S(title), js::S(body), js::S(subtitle), js::B(os)}));
    }
    orch::BreakerView breaker() override { qFatal("这个测试不该问熔断"); }
    Task<OJson> tryLocalShorthand(QString, orch::PriceSnap&, ibkr::domain::EtNow, ibkr::parsing::shorthand::ShorthandMeta&) override { qFatal("这个测试不该走速记"); }
    Task<OJson> handleInstruction(QString, QString, ibkr::domain::EtNow, orch::PriceSnap, QStringList, bool, orch::InstructionScope) override { qFatal("这个测试不该发单"); }
    QStringList resolveFanoutAccounts(const ibkr::domain::Settings&, const QStringList&) override { qFatal("这个测试不该解析账户"); }
    QString orderLegId(const OJson&) override { qFatal("这个测试不该问腿身份"); }

protected:
    World& w_;
    ibkr::domain::TradeStore& store_;
};

/// 把一份记录里的临时目录路径换成 <DIR>(JS 那边记的时候就换了)
inline OJson cleanDir(const OJson& v, const QString& dir) {
    QString text = js::stringify(v);
    text.replace(dir, u"<DIR>"_s);
    return *js::parse(text);
}

/// 一个场景的三样东西(日志、各步结果、库)逐字比;不一样时报第一个不同的位置。返回是否全部相同
inline bool compareScenario(const QString& name, const OJson& expected, const World& w, const OJson& steps, const OJson& db) {
    const QString dir = w.dir.path();
    bool same = true;
    const auto one = [&](const char16_t* key, const OJson& got) {
        if (!same) return;
        same = jsfix::same(*expected.get(QString::fromUtf16(key)), cleanDir(got, dir), name + u" / "_s + QString::fromUtf16(key));
    };
    one(u"log", w.log);
    one(u"steps", steps);
    one(u"db", db);
    // 变异检验时(SVC1_FAILFAST=1)第一个不一样就结束,省得跑完剩下的场景
    if (!same && qEnvironmentVariableIsSet("SVC1_FAILFAST")) qFatal("SVC1_FAILFAST:%s 不一样", qPrintable(name));
    return same;
}

/// 脚本的设置 = 基础配置 + 脚本补丁 + 步里的补丁 + 临时库路径
inline ibkr::domain::Settings makeSettings(const OJson& base, const World& w, const OJson* patch = nullptr) {
    OJson raw = base;
    if (const OJson* s = w.script().get(u"settings"_s)) raw = ibkr::domain::deepMerge(raw, *s);
    if (patch) raw = ibkr::domain::deepMerge(raw, *patch);
    raw.set(u"storage"_s, js::object({{u"db_path"_s, js::S(w.dir.path() + u"/t.db"_s)}}));
    return ibkr::domain::fromDict(raw);
}

/// Runner:读脚本的步,调 service 的方法;各 service 的测试给 call / extraOps
struct Ctx {
    World& w;
    ibkr::domain::TradeStore& store;
    std::function<Task<OJson>(const QString& m, const OJson& args)> call;
    std::function<void(const OJson& patch)> setSettings;
    std::function<OJson(const QString& m, const OJson& v)> shape = {};
    std::map<QString, std::function<void(const OJson& step, OJson& rec)>> extraOps = {};
    /// router 步:状态 {on?, sessions?, volume?, covered?, noSession?}(set 合并进去)之后重建
    OJson* routerState = nullptr;
    std::function<void()> rebuildRouter = {};
    /// store 步的 as 记下的名字(假引擎造出记录时也往里记)
    QHash<QString, OJson> aliases = {};
};

inline OJson storeCall(ibkr::domain::TradeStore& s, const QString& m, const OJson& a);

inline OJson runSteps(Ctx& c, const OJson& script) {
    OJson steps = js::array();
    QHash<QString, Task<OJson>> started;
    QHash<QString, OJson>& aliases = c.aliases;
    /// {"$ref": "名字"} → 之前某个 store 步 as 记下的 id(或结果)
    std::function<OJson(const OJson&)> resolve = [&](const OJson& v) -> OJson {
        if (v.type == OJson::Array) {
            OJson o = js::array();
            for (const OJson& x : v.items) o.items.append(resolve(x));
            return o;
        }
        if (v.type == OJson::Object) {
            if (const OJson* nw = v.get(u"$now"_s); nw && nw->type == OJson::Number) return js::N(c.w.T + nw->n);
            if (const OJson* r = v.get(u"$ref"_s); r && r->type == OJson::String) {
                if (!aliases.contains(r->s)) throw ibkr::util::JsError(u"没有记过 %1"_s.arg(r->s));
                return aliases.value(r->s);
            }
            if (const OJson* r = v.get(u"$watch"_s); r && r->type == OJson::String) {
                for (const OJson& w : c.store.listWatches()) {
                    if (js::str(w.get(u"symbol"_s)) == r->s) return *w.get(u"id"_s);
                }
                throw ibkr::util::JsError(u"没有这个盯单 %1"_s.arg(r->s));
            }
            OJson o = js::object();
            for (const auto& [k, x] : v.fields) o.set(k, resolve(x));
            return o;
        }
        return v;
    };
    const OJson& list = *script.get(u"steps"_s);
    for (const OJson& step : list.items) {
        const QString op = str(step, u"op"_s);
        OJson rec = js::object({{u"op"_s, js::S(op)}});
        if (const OJson* id = step.get(u"id"_s)) rec.set(u"id"_s, *id);
        const auto outcome = [&](const Task<OJson>& t) {
            if (t.error()) return errOut(t.error());
            const OJson v = t.result();
            return js::object({{u"ok"_s, jsfix::enc(c.shape ? c.shape(str(rec, u"m"_s), v) : v)}});
        };
        const auto runToDone = [&](const Task<OJson>& t) {
            while (!t.done()) {
                if (!c.w.stepOne()) break;
            }
            return t.done();
        };
        if (op == u"call") {
            const QString m = str(step, u"m"_s);
            rec.set(u"m"_s, js::S(m));
            Task<OJson> t;
            try {
                const OJson args = step.get(u"a"_s) ? resolve(jsfix::dec(*step.get(u"a"_s))) : js::array();
                t = c.call(m, args);
            } catch (...) {
                Deferred<OJson> d;
                d.reject(std::current_exception());
                t = d.task();
            }
            if (flag(step, u"start"_s)) {
                started.insert(str(step, u"id"_s), t);
            } else {
                rec.set(u"result"_s, runToDone(t) ? outcome(t) : js::object({{u"pending"_s, js::B(true)}}));
            }
        } else if (op == u"await") {
            const QString id = str(step, u"id"_s);
            if (!started.contains(id)) qFatal("没有启动过 %s", qPrintable(id));
            const Task<OJson> t = started.value(id);
            rec.set(u"result"_s, runToDone(t) ? outcome(t) : js::object({{u"pending"_s, js::B(true)}}));
        } else if (op == u"advance") {
            if (step.get(u"ms"_s)) c.w.advance(num(step, u"ms"_s));
            else c.w.advance(num(step, u"to"_s) - c.w.T);
        } else if (op == u"store") {
            const QString m = str(step, u"m"_s);
            rec.set(u"m"_s, js::S(m));
            try {
                const OJson v = storeCall(c.store, m, step.get(u"a"_s) ? resolve(jsfix::dec(*step.get(u"a"_s))) : js::array());
                if (const OJson* as = step.get(u"as"_s); as && as->type == OJson::String) {
                    const OJson* id = v.type == OJson::Object ? v.get(u"id"_s) : nullptr;
                    aliases.insert(as->s, id ? *id : v);
                }
                rec.set(u"result"_s, js::object({{u"ok"_s, jsfix::enc(v)}}));
            } catch (...) {
                rec.set(u"result"_s, errOut(std::current_exception()));
            }
        } else if (op == u"settings") {
            c.setSettings(*step.get(u"patch"_s));
        } else if (op == u"router") {
            for (const auto& [k, v] : step.get(u"set"_s)->fields) c.routerState->set(k, v);
            c.rebuildRouter();
        } else if (op == u"fake") {
            c.w.setFake(str(step, u"key"_s), *step.get(u"list"_s));
        } else if (op == u"db") {
            rec.set(u"db"_s, dumpDb(c.w.dir.path() + u"/t.db"_s));
        } else {
            auto it = c.extraOps.find(op);
            if (it == c.extraOps.end()) qFatal("不认识的步 %s", qPrintable(op));
            it->second(step, rec);
        }
        rec.set(u"t"_s, js::N(c.w.T));
        steps.items.append(rec);
    }
    return steps;
}

// ---- store 步:准备数据用的库方法(JS 那边 svc1_world.mjs 的 store 步直接调同名方法;follow.* 是跟单日志)
inline OJson storeCall(ibkr::domain::TradeStore& s, const QString& m, const OJson& a) {
    const auto at = [&](int i) -> const OJson* { return i < a.items.size() ? &a.items[i] : nullptr; };
    const auto sAt = [&](int i) { return js::str(at(i)); };
    const auto nAt = [&](int i, double d) { return at(i) && at(i)->type == OJson::Number ? at(i)->n : d; };
    const auto list = [](const QList<OJson>& l) { return js::array(l); };
    const auto opt = [](const std::optional<OJson>& v) { return v ? *v : js::Null(); };
    if (m == u"addWatch") return s.addWatch(sAt(0), nAt(1, 0), at(2) ? sAt(2) : QString());
    if (m == u"listWatches") return list(s.listWatches());
    if (m == u"getWatch") return opt(s.getWatch(sAt(0)));
    if (m == u"updateWatch") return js::B(s.updateWatch(sAt(0), *at(1)));
    if (m == u"deleteWatch") return js::B(s.deleteWatch(sAt(0)));
    if (m == u"setPref") {
        s.setPref(sAt(0), at(1));
        return js::Null();
    }
    if (m == u"getPref") return s.getPref(sAt(0));
    if (m == u"addQualityStock") {
        if (at(1) && at(1)->type == OJson::String) return s.addQualityStock(sAt(0), at(1));
        return s.addQualityStock(sAt(0));
    }
    if (m == u"listQualityStocks") return list(s.listQualityStocks());
    if (m == u"updateQualityStock") return js::B(s.updateQualityStock(sAt(0), *at(1)));
    if (m == u"deleteQualityStock") return js::B(s.deleteQualityStock(sAt(0)));
    if (m == u"addSector") return s.addSector(sAt(0));
    if (m == u"setSectorStocks") return js::B(s.setSectorStocks(sAt(0), *at(1)));
    if (m == u"audit") {
        s.audit(sAt(0), sAt(1), at(2) && at(2)->type != OJson::Null ? at(2) : nullptr);
        return js::Null();
    }
    if (m == u"createRecord") {
        OJson rec = *at(0);
        return js::S(s.createRecord(rec));
    }
    if (m == u"appendEvent") {
        s.appendEvent(sAt(0), sAt(1), *at(2));
        return js::Null();
    }
    if (m == u"setFinalStatus") {
        s.setFinalStatus(sAt(0), sAt(1), at(2) && at(2)->type == OJson::String ? std::optional<QString>(sAt(2)) : std::nullopt);
        return js::Null();
    }
    if (m == u"getRecord") return opt(s.getRecord(sAt(0)));
    if (m == u"listTracks") return list(s.listTracks());
    if (m == u"getTrack") return opt(s.getTrack(sAt(0)));
    if (m == u"updateTrack") return js::B(s.updateTrack(sAt(0), *at(1)));
    if (m == u"deleteTrack") return js::B(s.deleteTrack(sAt(0)));
    if (m == u"addTrack") return s.addTrack(*at(0));
    if (m == u"rawExec") {
        s.rawExec(sAt(0));
        return js::Null();
    }
    if (m == u"follow.add") return js::B(s.follow().add(*at(0)));
    if (m == u"follow.has") return js::B(s.follow().has(sAt(0)));
    if (m == u"follow.addQuote") return js::B(s.follow().addQuote(sAt(0), sAt(1), *at(2)));
    if (m == u"follow.recent") return list(s.follow().recent(nAt(0, 30)));
    qFatal("store 步不认识 %s", qPrintable(m));
}

}  // namespace sw
