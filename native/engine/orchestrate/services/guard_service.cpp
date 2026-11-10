#include "orchestrate/services/guard_service.h"

#include "analysis/guard_report.h"
#include "analysis/guard_rules.h"
#include "domain/positions.h"
#include "orchestrate/services/guard_push.h"
#include "orchestrate/tracker.h"
#include "util/run_marker.h"
#include "util/tz.h"
#include "util/error.h"
#include "util/jsformat.h"
#include "util/js_runtime.h"
#include "util/jsobj.h"

#include <QDate>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QSaveFile>

#include <cmath>

namespace ibkr::orchestrate {

using namespace Qt::StringLiterals;
using util::OJson;
using util::Task;
namespace js = util::js;
namespace gr = analysis::guard;

namespace {

QString errorText(std::exception_ptr e) {
    try {
        std::rethrow_exception(e);
    } catch (const util::JsError& x) {
        return x.message();
    } catch (const std::exception& x) {
        return QString::fromUtf8(x.what());
    } catch (...) {
    }
    return u"未知错误"_s;
}

QString money(double v) { return util::jsNumberToString(std::round(v * 100.0) / 100.0); }

/// 落了闩(触发过)的追踪:托管对账把它的券商侧单子撤了,不再算保护
bool fired(const OJson& t) { return js::truthy(t.get(u"fired_at"_s)); }

/// 触发过、又不在追价平仓中、而且已经过了 kReArmMs:仓位还在,说明是平完又开了新仓(或平仓没成),可以重新上膛。
/// 刚触发的那一会儿持仓可能还没来得及消失,这时重新上膛就是给一个刚平掉的仓再挂一张止损——一碰就反向开仓
constexpr double kReArmMs = 30'000;
bool staleLatch(const OJson& t) {
    if (!fired(t) || tracker::sweepReason(t)) return false;
    const QDateTime at = QDateTime::fromString(js::str(t.get(u"fired_at"_s)), Qt::ISODate);
    if (!at.isValid()) return true;
    return util::dateNow() - double(at.toMSecsSinceEpoch()) >= kReArmMs;
}

/// 这条追踪是不是已经替这只股票管着止损:启用、没落闩、打开了自动平仓、有止损价或跟踪止损
bool trackProtects(const OJson& t) {
    if (!js::truthy(t.get(u"enabled"_s)) || fired(t)) return false;
    if (!js::truthy(js::prop(t.get(u"auto_close"_s), u"enabled"_s))) return false;
    const OJson* targets = t.get(u"targets"_s);
    return !js::nullish(js::prop(targets, u"stop_loss"_s)) || !js::nullish(js::prop(targets, u"trail_pct"_s));
}

/// tracker.update 会把目标整套换掉:改止损时其余目标原样带回去
const QStringList& targetKeys() {
    static const QStringList k{u"take_profit"_s, u"stop_loss"_s, u"trail_pct"_s, u"profit_drawdown_pct"_s, u"profit_drawdown_tiers"_s, u"profit_drawdown_preset"_s,
                               u"profit_drawdown_arm_pct"_s, u"spot_target"_s, u"spot_stop_below"_s, u"spot_stop_above"_s, u"spot_stop_confirm_s"_s, u"exit_at"_s,
                               u"take_profit_tiers"_s};
    return k;
}

OJson carriedTargets(const OJson& track) {
    OJson out = js::object();
    const OJson* targets = track.get(u"targets"_s);
    for (const QString& k : targetKeys()) {
        const OJson* v = js::prop(targets, k);
        if (!js::nullish(v) && !(js::isStr(v) && v->s.isEmpty())) out.set(k, *v);
    }
    return out;
}

std::optional<double> numOpt(const OJson* v) {
    if (!js::isNum(v) || !std::isfinite(v->n)) return std::nullopt;
    return v->n;
}

}  // namespace

bool GuardService::nag(const QString& key, double nowMs) {
    const auto it = nagAt_.constFind(key);
    if (it != nagAt_.cend() && nowMs - *it < kNagMs) return false;
    nagAt_.insert(key, nowMs);
    return true;
}

void GuardService::bump(OJson* out, const QString& key) { out->set(key, js::N(js::num(out->get(key)) + 1)); }

void GuardService::onExternalCancel(const OJson& track, const QString& kind, const QString& reason) {
    if (!settings().guard.enabled) return;
    if (js::str(track.get(u"sec_type"_s)) != u"STK") return;
    if (kind != u"sl" && kind != u"trail" && kind != u"ptrail") return;
    const QString symbol = js::str(track.get(u"symbol"_s));
    journal(u"guard_violation"_s, js::object({{u"kind"_s, js::S(u"stop_cancelled"_s)},
                                              {u"account"_s, js::copyOrNull(track.get(u"account"_s))},
                                              {u"symbol"_s, js::S(symbol)},
                                              {u"order"_s, js::S(kind)},
                                              {u"reason"_s, js::S(reason)}}));
    tell(u"止损单被撤"_s, u"%1 的券商侧止损单被撤了(%2)。约 60 秒后重新挂上;要真的放开止损,只能在意图里写理由关掉。"_s.arg(symbol, reason), symbol, true);
}

GuardService::~GuardService() {
    *alive_ = false;
    stop();
}

void GuardService::start() {
    if (running_) return;
    const int gen = ++gen_;
    running_ = true;
    const int tickMs = int(settings().guard.tick_s * 1000);
    timer_ = rt().setTimeout(tickMs, [this, alive = std::weak_ptr<bool>(alive_), tickMs, gen] {
        if (alive.expired()) return;
        util::detach(loop(tickMs, gen));
    });
}

Task<> GuardService::loop(int tickMs, int gen) {
    const std::weak_ptr<bool> alive = alive_;
    try {
        co_await tickOnce();
    } catch (...) {
    }
    if (alive.expired() || gen != gen_ || !running_) co_return;
    // 节拍跟着配置走:配置重载后下一轮就用新的
    const int next = int(settings().guard.tick_s * 1000);
    timer_ = rt().setTimeout(next > 0 ? next : tickMs, [this, alive, next, tickMs, gen] {
        if (alive.expired()) return;
        util::detach(loop(next > 0 ? next : tickMs, gen));
    });
}

void GuardService::stop() {
    gen_ += 1;
    running_ = false;
    if (timer_ != 0) rt().clearTimeout(timer_);
    timer_ = 0;
}

QString GuardService::inboxPath() const {
    const QString configured = settings().guard.inbox_path;
    if (!configured.isEmpty()) return QDir::cleanPath(configured.startsWith(u"~/"_s) ? QDir::homePath() + configured.mid(1) : configured);
    return QFileInfo(settings().db_path).path() + u"/guard/intents.jsonl"_s;
}

void GuardService::journal(const QString& action, const OJson& detail) { store().audit(u"guard"_s, action, &detail); }

void GuardService::tell(const QString& title, const QString& body, const QString& symbol, bool push) {
    try {
        eng().notifier().notify(title, body, symbol);
    } catch (...) {
        /* 通知发不出去不影响下一条 */
    }
    emitEvent(u"guard"_s, js::object({{u"title"_s, js::S(title)}, {u"body"_s, js::S(body)}, {u"symbol"_s, js::S(symbol)}}));
    if (push) enqueuePush(title, body);
}

namespace {
constexpr double kPushDedupMs = 10 * 60 * 1000;
constexpr double kPushHourMs = 60 * 60 * 1000;
constexpr int kPushPerHour = 20;
constexpr int kPushQueueCap = 50;
constexpr double kPushRetryMs = 30'000;
constexpr double kPushMaxAgeMs = 24 * 60 * 60 * 1000;
}  // namespace

void GuardService::enqueuePush(const QString& title, const QString& body, bool priority) {
    const contract::GuardConfig& cfg = settings().guard;
    if (!cfg.enabled || !wiring_.push || !guard_push::configured(cfg.push)) return;
    if (priority) {
        pushQueue_.prepend(PendingPush{title, body, util::dateNow(), true});
        return;
    }
    // 同一件事 10 分钟内只推一次(五分钟一次的提醒不该变成每小时 12 次震动)
    const QString key = title + u'\n' + body;
    for (auto it = pushSeen_.begin(); it != pushSeen_.end();) {
        if (now_ - it.value() >= kPushDedupMs) it = pushSeen_.erase(it);
        else ++it;
    }
    if (const auto it = pushSeen_.constFind(key); it != pushSeen_.cend() && now_ - *it < kPushDedupMs) return;
    pushSeen_.insert(key, now_);
    if (pushQueue_.size() >= kPushQueueCap) pushQueue_.removeFirst();
    pushQueue_.append(PendingPush{title, body, util::dateNow()});
}

Task<> GuardService::drainPushes(double nowMs) {
    if (pushBusy_ || pushQueue_.isEmpty() || nowMs < pushRetryAt_ || !wiring_.push) co_return;
    pushBusy_ = true;
    const std::weak_ptr<bool> alive = alive_;
    while (!pushQueue_.isEmpty()) {
        while (!pushSent_.isEmpty() && nowMs - pushSent_.first() >= kPushHourMs) pushSent_.removeFirst();
        const PendingPush item = pushQueue_.first();
        if (!item.priority && pushSent_.size() >= kPushPerHour) break;
        const double age = util::dateNow() - item.createdEpoch;
        if (age > kPushMaxAgeMs) {
            pushQueue_.removeFirst();
            continue;
        }
        QString body = item.body;
        if (age >= 90'000) body += u"\n(推送延迟 %1 分钟:当时发不出去)"_s.arg(util::jsNumberToString(std::round(age / 60'000)));
        std::exception_ptr failure;
        try {
            co_await wiring_.push(u"Datrix:"_s + item.title, body);
        } catch (...) {
            failure = std::current_exception();
        }
        if (alive.expired()) co_return;
        if (failure) {
            pushError_ = errorText(failure);
            pushRetryAt_ = nowMs + kPushRetryMs;
            break;
        }
        pushError_.clear();
        if (!pushQueue_.isEmpty()) pushQueue_.removeFirst();
        if (!item.priority) pushSent_.append(nowMs);
    }
    pushBusy_ = false;
}

void GuardService::onFired(const QString& account, const QString& symbol, const QString& state, const QString& how) {
    if (!settings().guard.enabled) return;
    static const QHash<QString, QString> names{{u"stop_loss"_s, u"止损"_s},       {u"take_profit"_s, u"止盈"_s},      {u"trail"_s, u"跟踪止损"_s},
                                               {u"profit_drawdown"_s, u"利润回撤"_s}, {u"spot_stop"_s, u"标的止损"_s},  {u"spot_target"_s, u"标的目标价"_s},
                                               {u"exit_at"_s, u"到点平仓"_s},      {u"rapid_exit"_s, u"急跌保护"_s}};
    const QString name = names.value(state, state.isEmpty() ? u"平仓"_s : state);
    journal(u"guard_fired"_s, js::object({{u"account"_s, js::S(account)}, {u"symbol"_s, js::S(symbol)}, {u"state"_s, js::S(state)}, {u"how"_s, js::S(how)}}));
    tell(u"%1触发"_s.arg(name), u"%1 %2(%3)。"_s.arg(symbol, name, how), symbol, true);
}

void GuardService::onOrderRejected(const QString& account, const QString& symbol, const QString& reason) {
    if (!settings().guard.enabled) return;
    (void)account;
    enqueuePush(u"拦下一张开仓单"_s, reason);
}

void GuardService::watchLink(double nowMs) {
    const contract::GuardConfig& cfg = settings().guard;
    const auto router = routerPort();
    const bool up = router && router->hasSessions() && router->upstreamOk();
    if (!up) {
        if (!downSince_) {
            downSince_ = nowMs;
            downSinceIso_ = QDateTime::currentDateTimeUtc().toString(Qt::ISODate);
            downSinceLocal_ = QDateTime::currentDateTime().toString(u"HH:mm"_s);
        }
        if (!downTold_ && nowMs - *downSince_ >= cfg.disconnect_alert_s * 1000) {
            downTold_ = true;
            const double minutes = std::round((nowMs - *downSince_) / 60'000);
            journal(u"guard_disconnect"_s, js::object({{u"since"_s, js::S(downSinceIso_)}, {u"router"_s, js::B(router != nullptr)}}));
            tell(u"IBKR 断开"_s,
                 u"和 IBKR 的连接从本机 %1 起断了 %2 分钟(TWS 没开、登出了,或 TWS 与 IBKR 服务器断开)。这期间引擎盯的组合出场、补挂止损都停着;券商侧已挂的止损单不受影响。"_s
                     .arg(downSinceLocal_, util::jsNumberToString(std::max(1.0, minutes))),
                 QString(), true);
        }
        return;
    }
    if (downSince_) {
        if (downTold_) {
            const double minutes = std::round((nowMs - *downSince_) / 60'000);
            journal(u"guard_reconnect"_s, js::object({{u"since"_s, js::S(downSinceIso_)}, {u"minutes"_s, js::N(minutes)}}));
            tell(u"IBKR 已恢复"_s, u"和 IBKR 的连接恢复了(本机 %1 起断的),断了约 %2 分钟。"_s.arg(downSinceLocal_, util::jsNumberToString(std::max(1.0, minutes))), QString(), true);
        }
        downSince_.reset();
        downSinceIso_.clear();
        downTold_ = false;
    }
}

void GuardService::checkRestarts() {
    if (restartsChecked_) return;
    restartsChecked_ = true;
    if (wiring_.runDir.isEmpty()) return;
    const QList<std::pair<QString, QString>> who{{u"app"_s, u"Datrix"_s}, {u"engine"_s, u"交易引擎"_s}};
    for (const auto& [name, label] : who) {
        const auto last = util::run_marker::takeCrashed(wiring_.runDir, name);
        if (!last) continue;
        journal(u"guard_restart"_s, js::object({{u"process"_s, js::S(name)}, {u"last_started"_s, js::S(*last)}}));
        tell(u"%1重启了"_s.arg(label),
             u"%1上一次没有正常退出(崩溃、被强制结束或断电;那一次起于 %2),现在重新起来了。请看一眼持仓和止损单。"_s.arg(label, last->isEmpty() ? u"未知时刻"_s : *last),
             QString(), true);
    }
}

void GuardService::writeHeartbeat(double nowMs) {
    const contract::GuardConfig& cfg = settings().guard;
    if (nowMs - heartbeatAt_ < cfg.heartbeat_s * 1000) return;
    heartbeatAt_ = nowMs;
    const auto router = routerPort();
    const bool up = router && router->hasSessions() && router->upstreamOk();
    const OJson hb = js::object({{u"ts"_s, js::S(QDateTime::currentDateTimeUtc().toString(Qt::ISODate))},
                                 {u"ib_connected"_s, js::B(up)},
                                 {u"n_positions"_s, nPositions_ ? js::N(*nPositions_) : js::Null()},
                                 {u"n_stops"_s, nStops_ ? js::N(*nStops_) : js::Null()},
                                 {u"last_price_change"_s, lastPriceChangeIso_.isEmpty() ? js::Null() : js::S(lastPriceChangeIso_)},
                                 {u"disconnected_since"_s, downSince_ ? js::S(downSinceIso_) : js::Null()},
                                 {u"push"_s, js::object({{u"provider"_s, js::S(cfg.push.provider)},
                                                         {u"queued"_s, js::N(double(pushQueue_.size()))},
                                                         {u"last_error"_s, pushError_.isEmpty() ? js::Null() : js::S(pushError_)}})}});
    const QString path = QFileInfo(inboxPath()).path() + u"/heartbeat.json"_s;
    QDir().mkpath(QFileInfo(path).path());
    QSaveFile f(path);
    if (!f.open(QIODevice::WriteOnly)) return;
    f.write(util::stringifyOJson(hb, 2).toUtf8());
    f.commit();
}

OJson GuardService::handleLine(const QString& raw) {
    const auto parsed = js::parse(raw);
    if (!parsed || !js::isObj(&*parsed)) return js::object({{u"ok"_s, js::B(false)}, {u"error"_s, js::S(u"这一行不是一个 JSON 对象"_s)}});
    const OJson& line = *parsed;
    // 账户:写了就认别名,没写用默认账户
    const QString aliasIn = js::isStr(line.get(u"account"_s)) ? line.get(u"account"_s)->s.trimmed() : QString();
    const contract::AccountConfig* account = aliasIn.isEmpty() ? settings().defaultAccount() : settings().accountByAlias(aliasIn);
    if (!account) return js::object({{u"ok"_s, js::B(false)}, {u"error"_s, js::S(aliasIn.isEmpty() ? u"没有默认账户,请写 account"_s : u"不认识账户 "_s + aliasIn)}});
    const QString alias = account->alias;

    // 试推一条:不带任何凭证,token 只在凭证库里
    if (js::truthy(line.get(u"push_test"_s))) {
        if (!guard_push::configured(settings().guard.push)) return js::object({{u"ok"_s, js::B(false)}, {u"error"_s, js::S(u"guard.push 没配(provider、chat_id / user)"_s)}});
        enqueuePush(u"测试推送"_s, u"guard 的推送通了。"_s);
        return js::object({{u"ok"_s, js::B(true)}, {u"push_test"_s, js::B(true)}});
    }
    if (line.get(u"close"_s)) {
        const QString symbol = js::str(line.get(u"close"_s)).trimmed().toUpper();
        const QString reason = js::isStr(line.get(u"reason"_s)) ? line.get(u"reason"_s)->s.trimmed() : QString();
        if (symbol.isEmpty()) return js::object({{u"ok"_s, js::B(false)}, {u"error"_s, js::S(u"close 要写标的代码"_s)}});
        // 关掉意图就是放开止损的唯一出口:必须写理由
        if (reason.isEmpty()) return js::object({{u"ok"_s, js::B(false)}, {u"error"_s, js::S(u"关掉意图必须写 reason"_s)}});
        const double n = store().guard().close(alias, symbol, reason);
        if (n == 0) return js::object({{u"ok"_s, js::B(false)}, {u"error"_s, js::S(u"%1 在 %2 没有在用的意图"_s.arg(symbol, alias))}});
        journal(u"guard_intent_close"_s, js::object({{u"account"_s, js::S(alias)}, {u"symbol"_s, js::S(symbol)}, {u"reason"_s, js::S(reason)}, {u"closed"_s, js::N(n)}}));
        return js::object({{u"ok"_s, js::B(true)}, {u"closed"_s, js::N(n)}, {u"symbol"_s, js::S(symbol)}});
    }

    gr::IntentVerdict v;
    if (line.get(u"structure"_s)) {
        v = gr::checkOptionIntent(line, alias);
    } else {
        const std::optional<double> nav = wiring_.navOf ? wiring_.navOf(alias) : std::nullopt;
        v = gr::checkStockIntent(line, alias, nav.value_or(0), settings().guard);
    }
    if (!v.ok) return js::object({{u"ok"_s, js::B(false)}, {u"error"_s, js::S(v.error)}});
    const OJson row = store().guard().add(v.intent);
    OJson detail = v.intent;
    detail.set(u"id"_s, js::copyOrNull(row.get(u"id"_s)));
    journal(u"guard_intent_add"_s, detail);
    OJson out = js::object({{u"ok"_s, js::B(true)}, {u"id"_s, js::copyOrNull(row.get(u"id"_s))}, {u"intent"_s, v.intent}});
    if (!v.notes.isEmpty()) out.set(u"notes"_s, js::strings(v.notes));
    return out;
}

OJson GuardService::ingestInbox() {
    OJson summary = js::object({{u"accepted"_s, js::N(0)}, {u"rejected"_s, js::N(0)}, {u"closed"_s, js::N(0)}});
    const QString path = inboxPath();
    const QFileInfo info(path);
    QDir dir = info.dir();
    if (!dir.exists()) dir.mkpath(u"."_s);
    // 先改名接走(改名是原子的,人这时再写会写进一个新文件),再一行行处理;上次处理到一半的也接着处理
    QStringList pending = dir.entryList({info.fileName() + u".processing-*"_s}, QDir::Files, QDir::Name);
    if (info.exists() && info.size() > 0) {
        const QString taken = info.fileName() + u".processing-"_s + QString::number(QDateTime::currentMSecsSinceEpoch());
        if (QFile::rename(path, dir.filePath(taken))) pending.append(taken);
    }
    if (pending.isEmpty()) return summary;
    QFile log(dir.filePath(u"intents.log.jsonl"_s));
    const bool logOpen = log.open(QIODevice::Append | QIODevice::Text);
    for (const QString& name : pending) {
        QFile f(dir.filePath(name));
        if (!f.open(QIODevice::ReadOnly | QIODevice::Text)) continue;
        const QStringList lines = QString::fromUtf8(f.readAll()).split(u'\n');
        f.close();
        for (const QString& rawLine : lines) {
            const QString raw = rawLine.trimmed();
            if (raw.isEmpty() || raw.startsWith(u'#')) continue;
            OJson result;
            try {
                result = handleLine(raw);
            } catch (...) {
                result = js::object({{u"ok"_s, js::B(false)}, {u"error"_s, js::S(errorText(std::current_exception()))}});
            }
            const bool ok = js::truthy(result.get(u"ok"_s));
            const bool closed = ok && (result.get(u"closed"_s) || result.get(u"push_test"_s));
            const QString key = closed ? u"closed"_s : ok ? u"accepted"_s : u"rejected"_s;
            summary.set(key, js::N(js::num(summary.get(key)) + 1));
            OJson entry = js::object({{u"at"_s, js::S(util::nowIsoSeconds())}, {u"line"_s, js::S(raw)}});
            for (const auto& [k, val] : result.fields) entry.set(k, val);
            if (logOpen) log.write((js::stringify(entry) + u'\n').toUtf8());
            if (!ok) {
                const QString why = js::str(result.get(u"error"_s));
                journal(u"guard_reject"_s, js::object({{u"what"_s, js::S(u"intent"_s)}, {u"line"_s, js::S(raw)}, {u"reason"_s, js::S(why)}}));
                tell(u"交易意图没收下"_s, why, QString());
            } else if (!closed) {
                const OJson* intent = result.get(u"intent"_s);
                QString body = u"%1 %2"_s.arg(js::str(js::prop(intent, u"symbol"_s)), js::str(js::prop(intent, u"kind"_s)) == u"option" ? js::str(js::prop(intent, u"structure"_s))
                                                                                                                           : js::str(js::prop(intent, u"side"_s)) + u" "_s +
                                                                                                                                 js::str(js::prop(intent, u"qty"_s)) + u" 股,止损 "_s +
                                                                                                                                 js::str(js::prop(intent, u"stop_price"_s)));
                if (const OJson* notes = result.get(u"notes"_s); js::isArr(notes))
                    for (const OJson& n : notes->items) body += u";"_s + n.s;
                tell(u"交易意图已记下"_s, body, js::str(js::prop(intent, u"symbol"_s)));
            }
        }
        QFile::remove(dir.filePath(name));
    }
    return summary;
}

Task<OJson> GuardService::tickOnce(std::optional<double> nowArg, std::optional<QString> todayArg) {
    OJson out = js::object();
    if (!settings().guard.enabled) co_return out;
    const double nowMs = nowArg ? *nowArg : rt().perfMs();
    now_ = nowMs;
    const QString today = todayArg ? *todayArg : domain::nowEt().date;
    const std::weak_ptr<bool> alive = alive_;
    checkRestarts();
    watchLink(nowMs);
    out.set(u"inbox"_s, ingestInbox());
    out.set(u"positions"_s, co_await watchPositions(nowMs, today));
    if (alive.expired()) co_return out;
    writeHeartbeat(nowMs);
    // 每日报告也不挡这一轮(要读 7 天成交);reportBusy_ 防重入
    util::detach(maybeReport());
    // 推送不挡这一轮:读钥匙串最多等 20 秒、发送最多 15 秒,不能让下一轮盯仓位跟着晚。pushBusy_ 防重入
    util::detach(drainPushes(nowMs));
    co_return out;
}

Task<OJson> GuardService::watchPositions(double nowMs, QString today) {
    OJson out = js::object({{u"warned"_s, js::N(0)}, {u"stopped"_s, js::N(0)}, {u"failed"_s, js::N(0)}, {u"auto_closed"_s, js::N(0)}, {u"placed"_s, js::N(0)},
                            {u"restored"_s, js::N(0)}, {u"raised"_s, js::N(0)}, {u"combo_tracked"_s, js::N(0)}, {u"combo_unmatched"_s, js::N(0)}});
    const auto router = routerPort();
    if (!router || !router->hasSessions()) {
        nPositions_.reset();  // 心跳里写 null:这一轮没读到,不拿旧数冒充
        nStops_.reset();
        co_return out;
    }
    QList<OJson> rows;
    try {
        rows = co_await router->positions();
    } catch (...) {
        nPositions_.reset();
        nStops_.reset();
        co_return out;  // 读不到持仓:不当成空仓,下一轮再看
    }
    const contract::GuardConfig cfg = settings().guard;
    const QList<OJson> tracks = store().listTracks();
    // 心跳用:几份持仓、几条在管的止损、最近一次有持仓现价变动是什么时候(没有逐笔行情的时刻,拿这个代替)
    {
        nPositions_ = double(rows.size());
        double stops = 0;
        for (const OJson& t : tracks)
            if (trackProtects(t)) stops += 1;
        nStops_ = stops;
        bool changed = false;
        QHash<QString, double> prices;
        for (const OJson& r : rows) {
            const double p = js::num(r.get(u"market_price"_s));
            if (!std::isfinite(p)) continue;
            const QString k = js::str(r.get(u"key"_s));
            prices.insert(k, p);
            if (const auto it = lastPrices_.constFind(k); it != lastPrices_.cend() && *it != p) changed = true;
        }
        if (changed) lastPriceChangeIso_ = QDateTime::currentDateTimeUtc().toString(Qt::ISODate);
        lastPrices_ = prices;
    }
    QSet<QString> present;
    QSet<QString> heldStocks;  // account|symbol

    for (const OJson& row : rows) {
        if (js::str(row.get(u"sec_type"_s)) != u"STK") continue;
        const double qty = js::num(row.get(u"quantity"_s));
        if (!std::isfinite(qty) || qty == 0) continue;
        const bool isLong = qty > 0;
        const QString key = js::str(row.get(u"key"_s));
        const QString alias = js::str(row.get(u"account"_s));
        const QString symbol = js::str(row.get(u"symbol"_s));
        const contract::AccountConfig* acct = settings().accountByAlias(alias);
        if (!acct || acct->connection == u"futu") continue;
        heldStocks.insert(alias + u'|' + symbol);

        // 有在用、方向对得上的意图:按意图的止损价挂(或守住)托管止损
        if (const auto intent = store().guard().openStock(alias, symbol)) {
            const QString side = js::str(js::prop(intent->get(u"intent"_s), u"side"_s));
            if ((side == u"BUY") == isLong) {
                store().guard().markSeen(js::num(intent->get(u"id"_s)));
                watch_.remove(key);
                co_await protectStock(row, *intent, tracks, nowMs, &out);
                continue;
            }
        }
        // 已经有追踪替它管着止损:不管
        bool tracked = false;
        bool protectedByTrack = false;
        std::optional<OJson> stkTrack;
        for (const OJson& t : tracks) {
            if (js::str(t.get(u"account"_s)) != alias || js::str(t.get(u"symbol"_s)) != symbol || js::str(t.get(u"sec_type"_s)) != u"STK") continue;
            tracked = true;
            stkTrack = t;
            if (trackProtects(t)) protectedByTrack = true;
        }
        if (protectedByTrack) {
            watch_.remove(key);
            continue;
        }
        present.insert(key);

        auto it = watch_.find(key);
        if (it == watch_.end()) {
            it = watch_.insert(key, Watch{nowMs, false, -1e18});
            const QString what = isLong ? u"买入"_s : u"卖空"_s;
            journal(u"guard_violation"_s, js::object({{u"kind"_s, js::S(u"no_intent"_s)},
                                                      {u"account"_s, js::S(alias)},
                                                      {u"symbol"_s, js::S(symbol)},
                                                      {u"quantity"_s, js::N(qty)},
                                                      {u"avg_cost"_s, js::copyOrNull(row.get(u"avg_cost"_s))}}));
            tell(u"股票仓位没有交易意图"_s,
                 u"%1 %2 %3 股没有意图记录。%4 秒内补录意图,否则按默认规则挂止损。"_s.arg(symbol, what, util::jsNumberToString(std::abs(qty)),
                                                                                         util::jsNumberToString(cfg.grace_s)),
                 symbol, true);
            out.set(u"warned"_s, js::N(js::num(out.get(u"warned"_s)) + 1));
            continue;
        }
        Watch& w = it.value();
        if (w.stopPlaced || nowMs - w.firstSeenMs < cfg.grace_s * 1000) continue;
        // 上一次的止损触发过、落了闩:这份仓位是新开的(或没平成),把那条追踪重新上膛,止损按默认规则重算
        const bool reArm = tracked && stkTrack && staleLatch(*stkTrack);
        if (tracked && stkTrack && fired(*stkTrack) && !reArm) continue;  // 刚触发 / 追价中:等它自己收尾
        if (tracked && !reArm) {
            // 已经有一条追踪但没管止损:不改别人的追踪,只提醒
            if (nowMs - w.lastNagMs >= kNagMs) {
                w.lastNagMs = nowMs;
                journal(u"guard_violation"_s, js::object({{u"kind"_s, js::S(u"track_without_stop"_s)}, {u"account"_s, js::S(alias)}, {u"symbol"_s, js::S(symbol)}}));
                tell(u"股票仓位没有止损"_s, u"%1 的持仓追踪没有止损价或没开自动平仓。guard 不改已有的追踪,请补上止损或补录意图。"_s.arg(symbol), symbol, true);
            }
            continue;
        }

        // 过了补录期:按默认规则挂止损
        double entry = js::num(row.get(u"avg_cost"_s));
        if (!std::isfinite(entry) || entry <= 0) entry = js::num(row.get(u"market_price"_s));
        if (!std::isfinite(entry) || entry <= 0) continue;
        std::optional<double> extreme;
        try {
            const QString start = QDate::fromString(today, Qt::ISODate).addDays(-int(cfg.default_low_days) * 2 - 10).toString(Qt::ISODate);
            const QList<OJson> bars = co_await router->historicalBars(symbol, start, today);
            extreme = gr::priorExtreme(bars, today, int(cfg.default_low_days), isLong);
        } catch (...) {
            /* 日线拿不到就只用比例 */
        }
        const double stop = gr::defaultStop(isLong, entry, extreme, cfg.default_stop_pct);
        OJson detail = js::object({{u"account"_s, js::S(alias)},
                                   {u"symbol"_s, js::S(symbol)},
                                   {u"quantity"_s, js::N(qty)},
                                   {u"entry"_s, js::N(entry)},
                                   {u"extreme"_s, extreme ? js::N(*extreme) : js::Null()},
                                   {u"stop"_s, js::N(stop)}});
        std::exception_ptr failure;
        try {
            if (reArm) {
                if (!wiring_.updateTrack) throw util::JsError(u"改追踪的通道没有接上"_s);
                OJson params = carriedTargets(*stkTrack);
                params.set(u"id"_s, js::copyOrNull(stkTrack->get(u"id"_s)));
                params.set(u"enabled"_s, js::B(true));
                params.set(u"auto_close"_s, js::object({{u"enabled"_s, js::B(true)}, {u"host_at_broker"_s, js::B(true)}}));
                params.set(u"stop_loss"_s, js::N(stop));
                co_await wiring_.updateTrack(params);
                detail.set(u"re_armed"_s, js::B(true));
            } else {
            if (!wiring_.addTrack) throw util::JsError(u"建追踪的通道没有接上"_s);
            const QString note = u"guard 默认止损:没有交易意图,入场 %1 × %2% 与前 %3 日%4 %5 取更近的一条"_s.arg(
                money(entry), util::jsNumberToString(100 - (isLong ? cfg.default_stop_pct : -cfg.default_stop_pct)), util::jsNumberToString(cfg.default_low_days),
                isLong ? u"最低"_s : u"最高"_s, extreme ? money(*extreme) : u"(没取到)"_s);
            co_await wiring_.addTrack(js::object({{u"key"_s, js::S(key)},
                                                  {u"stop_loss"_s, js::N(stop)},
                                                  {u"auto_close"_s, js::B(true)},
                                                  {u"host_at_broker"_s, js::B(true)},
                                                  {u"note"_s, js::S(note)}}));
            }
        } catch (...) {
            failure = std::current_exception();
        }
        if (!failure) {
            w.stopPlaced = true;
            journal(u"guard_default_stop"_s, detail);
            journal(u"guard_violation"_s, js::object({{u"kind"_s, js::S(u"default_stop"_s)}, {u"account"_s, js::S(alias)}, {u"symbol"_s, js::S(symbol)}, {u"stop"_s, js::N(stop)}}));
            tell(u"已挂默认止损"_s, u"%1 没有补录交易意图,已按默认规则在券商挂止损 @%2。"_s.arg(symbol, money(stop)), symbol, true);
            out.set(u"stopped"_s, js::N(js::num(out.get(u"stopped"_s)) + 1));
        } else {
            const QString why = errorText(failure);
            out.set(u"failed"_s, js::N(js::num(out.get(u"failed"_s)) + 1));
            if (nowMs - w.lastNagMs >= kNagMs) {
                w.lastNagMs = nowMs;
                detail.set(u"error"_s, js::S(why));
                journal(u"guard_default_stop_failed"_s, detail);
                tell(u"默认止损挂不上"_s, u"%1 默认止损 %2 挂不上:%3。这只股票现在没有止损,请立即处理。"_s.arg(symbol, money(stop), why), symbol, true);
            }
        }
    }
    // 不在了的仓位不再盯
    for (auto it = watch_.begin(); it != watch_.end();) {
        if (!present.contains(it.key())) it = watch_.erase(it);
        else ++it;
    }
    const std::optional<QStringList> covered = wiring_.coveredAccounts ? wiring_.coveredAccounts() : std::nullopt;
    co_await watchOptions(rows, tracks, today, nowMs, covered, &out);
    // 意图对应的持仓出现过、现在没了:自动关掉。那个账户的会话没连着时持仓里本来就没有它,不下结论
    for (const OJson& intent : store().guard().listOpen()) {
        if (js::str(intent.get(u"kind"_s)) != u"stock" || !js::truthy(intent.get(u"seen_position"_s))) continue;
        const QString alias = js::str(intent.get(u"account"_s));
        if (covered && !covered->contains(alias)) continue;
        const QString symbol = js::str(intent.get(u"symbol"_s));
        if (heldStocks.contains(alias + u'|' + symbol)) continue;
        const double n = store().guard().close(alias, symbol, u"持仓已平"_s, u"stock"_s);
        if (n > 0) {
            journal(u"guard_intent_close"_s, js::object({{u"account"_s, js::S(alias)}, {u"symbol"_s, js::S(symbol)}, {u"reason"_s, js::S(u"持仓已平"_s)}, {u"closed"_s, js::N(n)}}));
            out.set(u"auto_closed"_s, js::N(js::num(out.get(u"auto_closed"_s)) + n));
        }
    }
    co_return out;
}

Task<> GuardService::protectStock(OJson row, OJson intentRow, QList<OJson> tracks, double nowMs, OJson* out) {
    const contract::GuardConfig cfg = settings().guard;
    const OJson* body = intentRow.get(u"intent"_s);
    const double id = js::num(intentRow.get(u"id"_s));
    const bool isLong = js::num(row.get(u"quantity"_s)) > 0;
    const QString key = js::str(row.get(u"key"_s));
    const QString alias = js::str(row.get(u"account"_s));
    const QString symbol = js::str(row.get(u"symbol"_s));
    const double intentStop = js::num(js::prop(body, u"stop_price"_s));
    if (!std::isfinite(intentStop) || intentStop <= 0) co_return;
    const std::optional<double> prev = numOpt(js::prop(body, u"stop_now"_s));
    const double floor = gr::stockFloor(isLong, js::num(row.get(u"avg_cost"_s)), intentStop, js::num(row.get(u"market_price"_s)), cfg.trail_r, prev);
    if (!prev || std::abs(*prev - floor) > 1e-9) {
        store().guard().setIntentField(id, u"stop_now"_s, js::N(floor));
        if (prev) {
            journal(u"guard_trail"_s, js::object({{u"account"_s, js::S(alias)}, {u"symbol"_s, js::S(symbol)}, {u"from"_s, js::N(*prev)}, {u"to"_s, js::N(floor)}}));
            tell(u"止损上抬"_s, u"%1 盈利过了 R 的整数倍,止损从 %2 抬到 %3。"_s.arg(symbol, money(*prev), money(floor)), symbol);
            bump(out, u"raised"_s);
        }
    }

    std::optional<OJson> track;
    for (const OJson& t : tracks)
        if (js::str(t.get(u"account"_s)) == alias && js::str(t.get(u"symbol"_s)) == symbol && js::str(t.get(u"sec_type"_s)) == u"STK") track = t;

    std::exception_ptr failure;
    if (!track) {
        try {
            if (!wiring_.addTrack) throw util::JsError(u"建追踪的通道没有接上"_s);
            const QString note = u"guard 意图止损:%1"_s.arg(js::str(js::prop(body, u"stop_reason"_s)));
            co_await wiring_.addTrack(js::object({{u"key"_s, js::S(key)},
                                                  {u"stop_loss"_s, js::N(floor)},
                                                  {u"auto_close"_s, js::B(true)},
                                                  {u"host_at_broker"_s, js::B(true)},
                                                  {u"note"_s, js::S(note.left(200))}}));
        } catch (...) {
            failure = std::current_exception();
        }
        if (!failure) {
            journal(u"guard_stop_placed"_s, js::object({{u"account"_s, js::S(alias)}, {u"symbol"_s, js::S(symbol)}, {u"stop"_s, js::N(floor)}, {u"intent"_s, js::N(id)}}));
            tell(u"已按意图挂止损"_s, u"%1 已在券商挂止损 @%2(%3)。"_s.arg(symbol, money(floor), js::str(js::prop(body, u"stop_reason"_s))), symbol);
            bump(out, u"placed"_s);
            co_return;
        }
    } else {
        const OJson& t = *track;
        const OJson* ac = t.get(u"auto_close"_s);
        const std::optional<double> current = numOpt(js::path(&t, {u"targets"_s, u"stop_loss"_s}));
        const bool enabled = js::truthy(t.get(u"enabled"_s));
        const bool autoOn = js::truthy(js::prop(ac, u"enabled"_s));
        const bool hosted = js::truthy(js::prop(ac, u"host_at_broker"_s));
        const bool tightEnough = current && gr::atLeastAsTight(isLong, *current, floor);
        const bool latched = fired(t);
        if (latched && !staleLatch(t)) co_return;  // 刚触发 / 追价中:等它自己收尾
        if (enabled && autoOn && hosted && tightEnough && !latched) co_return;
        // 上一次的止损触发过、仓位还在(平完又按意图开了新仓):重新上膛,不算违规
        // 券商侧的托管止损成交时,托管对账把追踪落闩的同时也停用了(enabled = false):落了闩的不看 enabled
        const bool reArmOnly = latched && autoOn && hosted && tightEnough;
        // 只差在底线刚抬上去(跟踪止损):不是违规,照抬
        const bool trailOnly = enabled && autoOn && hosted && current && prev && gr::atLeastAsTight(isLong, *current, *prev);
        const double want = tightEnough ? *current : floor;
        OJson params = carriedTargets(t);
        params.set(u"id"_s, js::copyOrNull(t.get(u"id"_s)));
        params.set(u"enabled"_s, js::B(true));
        params.set(u"auto_close"_s, js::object({{u"enabled"_s, js::B(true)}, {u"host_at_broker"_s, js::B(true)}}));
        params.set(u"stop_loss"_s, js::N(want));
        try {
            if (!wiring_.updateTrack) throw util::JsError(u"改追踪的通道没有接上"_s);
            co_await wiring_.updateTrack(params);
        } catch (...) {
            failure = std::current_exception();
        }
        if (!failure) {
            if (reArmOnly) {
                journal(u"guard_re_armed"_s, js::object({{u"account"_s, js::S(alias)}, {u"symbol"_s, js::S(symbol)}, {u"stop"_s, js::N(want)}}));
                tell(u"止损已重新挂上"_s, u"%1 上一次的止损触发过,仓位还在,已按意图重新挂止损 @%2。"_s.arg(symbol, money(want)), symbol);
            } else if (trailOnly) {
                journal(u"guard_stop_raised"_s, js::object({{u"account"_s, js::S(alias)}, {u"symbol"_s, js::S(symbol)}, {u"stop"_s, js::N(want)}}));
            } else {
                OJson detail = js::object({{u"kind"_s, js::S(u"stop_lowered"_s)}, {u"account"_s, js::S(alias)}, {u"symbol"_s, js::S(symbol)},
                                           {u"before"_s, current ? js::N(*current) : js::Null()}, {u"enabled"_s, js::B(enabled)},
                                           {u"auto_close"_s, js::B(autoOn)}, {u"host_at_broker"_s, js::B(hosted)}, {u"restored"_s, js::N(want)}});
                journal(u"guard_violation"_s, detail);
                tell(u"止损被放松,已恢复"_s,
                     u"%1 的止损被改松或停掉了,已恢复到 %2。要真的放开止损,只能在意图里写理由关掉。"_s.arg(symbol, money(want)), symbol, true);
            }
            bump(out, u"restored"_s);
            co_return;
        }
    }
    bump(out, u"failed"_s);
    if (nag(u"stock|"_s + key, nowMs)) {
        const QString why = errorText(failure);
        journal(u"guard_stop_failed"_s, js::object({{u"account"_s, js::S(alias)}, {u"symbol"_s, js::S(symbol)}, {u"stop"_s, js::N(floor)}, {u"error"_s, js::S(why)}}));
        tell(u"意图止损挂不上"_s, u"%1 止损 %2 挂不上:%3。这只股票现在没有止损,请立即处理。"_s.arg(symbol, money(floor), why), symbol, true);
    }
}

Task<> GuardService::watchOptions(QList<OJson> rows, QList<OJson> tracks, QString today, double nowMs, std::optional<QStringList> covered, OJson* out) {
    QList<OJson> intents;
    for (const OJson& r : store().guard().listOpen())
        if (js::str(r.get(u"kind"_s)) == u"option") intents.append(r);
    if (intents.isEmpty()) co_return;
    const QList<OJson> combos = domain::withCombos(rows);
    for (const OJson& intentRow : intents) {
        const double id = js::num(intentRow.get(u"id"_s));
        const QString tag = util::jsNumberToString(id);
        const OJson* body = intentRow.get(u"intent"_s);
        const QString alias = js::str(intentRow.get(u"account"_s));
        const QString symbol = js::str(intentRow.get(u"symbol"_s));
        if (covered && !covered->contains(alias)) continue;  // 读不到这个账户:什么都不判
        std::optional<OJson> combo;
        for (const OJson& c : combos)
            if (gr::comboMatches(c, *body)) combo = c;
        if (!combo) {
            if (js::truthy(intentRow.get(u"seen_position"_s))) {
                if (store().guard().close(alias, symbol, u"持仓已平"_s, u"option"_s) > 0) {
                    journal(u"guard_intent_close"_s, js::object({{u"account"_s, js::S(alias)}, {u"symbol"_s, js::S(symbol)}, {u"reason"_s, js::S(u"持仓已平"_s)}, {u"intent"_s, js::N(id)}}));
                    bump(out, u"auto_closed"_s);
                }
                continue;
            }
            // 持仓里有这个标的这个到期日的组合、却认不出这一只(行权价写错、腿切不成那个形状):说一次
            bool sameExpiry = false;
            const QString expiry = js::str(js::prop(body, u"expiry"_s)).remove(u'-');
            for (const OJson& c : combos)
                if (js::str(c.get(u"sec_type"_s)) == u"BAG" && js::str(c.get(u"account"_s)) == alias && js::str(c.get(u"symbol"_s)) == symbol &&
                    js::str(c.get(u"leg"_s)).startsWith(expiry))
                    sameExpiry = true;
            if (sameExpiry && !told_.contains(u"unmatched|"_s + tag)) {
                told_.insert(u"unmatched|"_s + tag);
                journal(u"guard_violation"_s, js::object({{u"kind"_s, js::S(u"combo_unmatched"_s)}, {u"account"_s, js::S(alias)}, {u"symbol"_s, js::S(symbol)},
                                                          {u"structure"_s, js::copyOrNull(js::prop(body, u"structure"_s))}, {u"intent"_s, js::N(id)}}));
                tell(u"认不出这只组合"_s,
                     u"%1 在持仓的组合里找不到(行权价写错了,或腿切不成这个形状),guard 管不了它的出场,请自己盯。"_s.arg(js::str(js::prop(body, u"structure"_s))),
                     symbol, true);
                bump(out, u"combo_unmatched"_s);
            }
            continue;
        }
        store().guard().markSeen(id);
        const QString key = js::str(combo->get(u"key"_s));
        const OJson* exits = js::prop(body, u"exits"_s);
        const double units = std::abs(js::num(combo->get(u"quantity"_s)));
        double mult = js::num(combo->get(u"multiplier"_s));
        if (!std::isfinite(mult) || mult <= 0) mult = 100;
        const double unitCost = js::num(js::prop(body, u"cost_usd"_s)) / (units > 0 ? units : 1) / mult;
        const auto tpx = numOpt(js::prop(exits, u"take_profit_x"_s));
        const auto slx = numOpt(js::prop(exits, u"stop_loss_x"_s));
        if (!tpx || !slx || !(unitCost > 0)) continue;
        const double takeProfit = std::round(unitCost * *tpx * 100.0) / 100.0;
        const double stopLoss = std::round(unitCost * *slx * 100.0) / 100.0;
        const bool expiryDay = js::str(js::prop(body, u"expiry"_s)) == today;
        const QString timeStop = js::str(js::prop(exits, u"time_stop_et"_s));

        std::optional<OJson> track;
        for (const OJson& t : tracks)
            if (js::str(t.get(u"key"_s)) == key || (js::str(t.get(u"account"_s)) == alias && js::str(t.get(u"symbol"_s)) == symbol &&
                                                    js::str(t.get(u"sec_type"_s)) == u"BAG" && js::str(t.get(u"leg"_s)) == js::str(combo->get(u"leg"_s))))
                track = t;
        OJson targets = js::object({{u"take_profit"_s, js::N(takeProfit)}, {u"stop_loss"_s, js::N(stopLoss)}});
        if (const auto b = numOpt(js::prop(exits, u"level_stop_below"_s))) targets.set(u"spot_stop_below"_s, js::N(*b));
        if (const auto a = numOpt(js::prop(exits, u"level_stop_above"_s))) targets.set(u"spot_stop_above"_s, js::N(*a));
        // 到点平仓按"下一次到这个钟点"算:只在到期日当天写上去,否则到期前任何一天的这个钟点都会平
        if (expiryDay && !timeStop.isEmpty()) targets.set(u"exit_at"_s, js::S(timeStop));

        std::exception_ptr failure;
        QString done;
        try {
            if (!track) {
                if (!wiring_.addTrack) throw util::JsError(u"建追踪的通道没有接上"_s);
                OJson params = targets;
                params.set(u"key"_s, js::S(key));
                params.set(u"auto_close"_s, js::B(true));
                params.set(u"order_type"_s, js::S(u"LMT"_s));
                params.set(u"note"_s, js::S((u"guard 组合出场:"_s + js::str(js::prop(body, u"structure"_s))).left(200)));
                co_await wiring_.addTrack(params);
                done = u"added"_s;
            } else {
                const OJson& t = *track;
                const std::optional<double> currentSl = numOpt(js::path(&t, {u"targets"_s, u"stop_loss"_s}));
                if (fired(t) && !staleLatch(t)) continue;  // 刚触发 / 追价中:等它自己收尾
                const bool ok = js::truthy(t.get(u"enabled"_s)) && js::truthy(js::path(&t, {u"auto_close"_s, u"enabled"_s})) && currentSl && *currentSl >= stopLoss - 1e-9 &&
                                !fired(t);
                const bool needExit = expiryDay && !timeStop.isEmpty() && js::str(js::path(&t, {u"targets"_s, u"exit_at"_s})) != timeStop;
                if (!ok || needExit) {
                    if (!wiring_.updateTrack) throw util::JsError(u"改追踪的通道没有接上"_s);
                    OJson params = carriedTargets(t);
                    for (const auto& [k, v] : targets.fields)
                        if (k != u"stop_loss"_s || !currentSl || *currentSl < stopLoss) params.set(k, v);
                    params.set(u"id"_s, js::copyOrNull(t.get(u"id"_s)));
                    params.set(u"enabled"_s, js::B(true));
                    params.set(u"auto_close"_s, js::object({{u"enabled"_s, js::B(true)}}));
                    co_await wiring_.updateTrack(params);
                    done = ok ? u"time_stop"_s : fired(t) ? u"re_armed"_s : u"restored"_s;
                }
            }
        } catch (...) {
            failure = std::current_exception();
        }
        if (failure) {
            bump(out, u"failed"_s);
            if (nag(u"combo|"_s + tag, nowMs)) {
                const QString why = errorText(failure);
                journal(u"guard_stop_failed"_s, js::object({{u"account"_s, js::S(alias)}, {u"symbol"_s, js::S(symbol)}, {u"intent"_s, js::N(id)}, {u"error"_s, js::S(why)}}));
                tell(u"组合出场规则挂不上"_s, u"%1 的出场追踪建不上:%2。请自己盯。"_s.arg(js::str(js::prop(body, u"structure"_s)), why), symbol, true);
            }
            continue;
        }
        if (done == u"added"_s) {
            journal(u"guard_combo_tracked"_s, js::object({{u"account"_s, js::S(alias)}, {u"symbol"_s, js::S(symbol)}, {u"intent"_s, js::N(id)},
                                                          {u"key"_s, js::S(key)}, {u"targets"_s, targets}}));
            tell(u"组合已按意图盯出场"_s, u"%1:止盈 %2、止损 %3%4。"_s.arg(js::str(js::prop(body, u"structure"_s)), money(takeProfit), money(stopLoss),
                                                                           expiryDay ? u"、%1 平"_s.arg(timeStop) : u",到期日当天 %1 平"_s.arg(timeStop)),
                 symbol);
            bump(out, u"combo_tracked"_s);
        } else if (done == u"restored"_s) {
            journal(u"guard_violation"_s, js::object({{u"kind"_s, js::S(u"stop_lowered"_s)}, {u"account"_s, js::S(alias)}, {u"symbol"_s, js::S(symbol)}, {u"intent"_s, js::N(id)}}));
            tell(u"组合出场规则被放松,已恢复"_s, u"%1 的出场追踪被停掉或止损被改松,已恢复。"_s.arg(js::str(js::prop(body, u"structure"_s))), symbol, true);
            bump(out, u"restored"_s);
        } else if (done == u"re_armed"_s) {
            journal(u"guard_re_armed"_s, js::object({{u"account"_s, js::S(alias)}, {u"symbol"_s, js::S(symbol)}, {u"intent"_s, js::N(id)}}));
            bump(out, u"restored"_s);
        } else if (done == u"time_stop"_s) {
            journal(u"guard_time_stop_set"_s, js::object({{u"account"_s, js::S(alias)}, {u"symbol"_s, js::S(symbol)}, {u"intent"_s, js::N(id)}, {u"exit_at"_s, js::S(timeStop)}}));
        }
    }
}


// ================================================================ 每日报告
namespace {

namespace rp = analysis::guard_report;

QString etDateOfIso(const QString& iso) {
    const QDateTime t = QDateTime::fromString(iso, Qt::ISODate);
    if (!t.isValid()) return {};
    return domain::etNowFromEpoch(double(t.toMSecsSinceEpoch())).date;
}

QString addDays(const QString& date, int n) { return QDate::fromString(date, Qt::ISODate).addDays(n).toString(Qt::ISODate); }

bool stopLike(const QString& state) {
    static const QSet<QString> s{u"stop_loss"_s, u"trail"_s, u"profit_drawdown"_s, u"spot_stop"_s, u"rapid_exit"_s};
    return s.contains(state);
}

QString shortDate(const QString& yyyymmdd) { return yyyymmdd.size() >= 8 ? yyyymmdd.mid(4, 2) + u'/' + yyyymmdd.mid(6, 2) : yyyymmdd; }

}  // namespace

Task<QList<OJson>> guardFillHistory(std::shared_ptr<execution::BrokerRouter> router) {
    QList<OJson> rows;
    if (!router) co_return rows;
    for (const auto& session : router->sessions()) {
        if (!session->has(execution::Cap::ExecutionHistory)) continue;
        const auto details = co_await raceTimeout(qtRuntime(), session->executionHistory(7), 30'000, [] { return util::JsError(u"读 7 天成交超时"_s); });
        if (!details) continue;
        for (const auto& d : *details) {
            static const OJson emptyObj = js::object();
            const auto row = execution::fillRow(js::nullish(&d.contract) ? emptyObj : d.contract, js::nullish(&d.execution) ? emptyObj : d.execution);
            if (row) rows.append(*row);
        }
    }
    co_return rows;
}

Task<> GuardService::maybeReport() {
    if (reportBusy_) co_return;
    const domain::EtNow at = wiring_.clock ? wiring_.clock() : domain::nowEt();
    if (reportedDate_ == at.date || !settings().isTradingDay(at.date)) co_return;
    const double close = settings().early_close_days.contains(at.date) ? 13 * 60 : 16 * 60;
    if (at.minutes < close + 15 || now_ < reportRetryAt_) co_return;
    // 今天已经发过(重启之后):流水里有这一天的 guard_report 就不再发。查一次就记住
    if (reportScanned_ != at.date) {
        // 回看窗口跟"今天"用同一只钟(wiring_.clock),不另读墙上时间:两只钟一错开,窗口就会把今天的流水切掉
        for (const OJson& r : store().guard().guardAudit(util::utcIso(at.epochMs - 2 * 86'400'000.0)))
            if (js::str(r.get(u"action"_s)) == u"guard_report" && js::str(js::prop(r.get(u"detail"_s), u"date"_s)) == at.date) {
                reportedDate_ = at.date;
                co_return;
            }
        reportScanned_ = at.date;
    }
    // TWS 没连着(比如美东 10:45 自动登出了还没登回来):先不发,每轮再看;到 20:00 还没连上才发一份注明断开的
    constexpr double kDisconnectedCutoff = 20 * 60;
    const auto router = routerPort();
    const bool up = router && router->hasSessions() && router->upstreamOk();
    if (!up && at.minutes < kDisconnectedCutoff) co_return;
    reportBusy_ = true;
    const std::weak_ptr<bool> alive = alive_;
    QString text;
    std::exception_ptr failure;
    try {
        text = co_await composeReport(at);
    } catch (...) {
        failure = std::current_exception();
    }
    if (alive.expired()) co_return;
    reportBusy_ = false;
    if (failure) {
        reportRetryAt_ = now_ + 5 * 60 * 1000;  // 7 天成交读超时这类:别每一轮都去问一遍卡住的 TWS
        if (nag(u"report|"_s + at.date, now_)) journal(u"guard_report_failed"_s, js::object({{u"date"_s, js::S(at.date)}, {u"error"_s, js::S(errorText(failure))}}));
        co_return;
    }
    // 拼的过程中持仓没读到(刚好断了):还没到 20:00 就当没拼,下一轮再来
    if (lastComposeDisconnected_ && at.minutes < kDisconnectedCutoff) co_return;
    if (lastComposeDisconnected_) {
        const qsizetype nl = text.indexOf(u'\n');
        text.insert(nl < 0 ? text.size() : nl + 1, u"TWS 断开,持仓、成交与净值读不到(到美东 20:00 还没连上)\n"_s);
    }
    reportedDate_ = at.date;
    OJson navs = js::object();
    for (const contract::AccountConfig& a : settings().accounts) {
        if (a.connection == u"futu") continue;
        if (const auto nav = wiring_.navOf ? wiring_.navOf(a.alias) : std::nullopt) navs.set(a.alias, js::N(*nav));
    }
    journal(u"guard_report"_s, js::object({{u"date"_s, js::S(at.date)}, {u"navs"_s, navs}}));
    const QString dir = QFileInfo(inboxPath()).path() + u"/reports"_s;
    QDir().mkpath(dir);
    QSaveFile f(dir + u'/' + at.date + u".txt"_s);
    if (f.open(QIODevice::WriteOnly)) {
        f.write((text + u'\n').toUtf8());
        f.commit();
    }
    try {
        eng().notifier().notify(u"每日报告"_s, text.section(u'\n', 1, 3), QString());
    } catch (...) {
    }
    emitEvent(u"guard_report"_s, js::object({{u"date"_s, js::S(at.date)}, {u"text"_s, js::S(text)}}));
    // Pushover 一条最多 1024 字、Telegram 4096:超长的截掉,全文在 reports/ 里
    QString body = text;
    if (body.size() > 1000) body = body.left(960) + u"\n…全文见 guard/reports/%1.txt"_s.arg(at.date);
    enqueuePush(u"每日报告 "_s + at.date, body, true);
}

Task<QString> GuardService::composeReport(domain::EtNow at) {
    const QString today = at.date;
    const double weekday = util::weekdayOfDate(today);  // 0 = 周一
    const QString weekStart = addDays(today, -int(weekday));
    const auto aliasOfId = [this](const QString& id) -> QString {
        for (const contract::AccountConfig& a : settings().accounts)
            if (a.account_id == id) return a.alias;
        return {};
    };

    // 持仓:正股 alias|symbol、期权腿 alias|symbol|到期|行权价|C/P → 带符号的数量
    QList<OJson> rows;
    bool connected = false;
    if (const auto router = routerPort(); router && router->hasSessions()) {
        connected = router->upstreamOk();
        try {
            rows = co_await router->positions();
        } catch (...) {
            connected = false;
        }
    }
    lastComposeDisconnected_ = !connected;
    QHash<QString, double> held;
    for (const OJson& r : rows) {
        const QString st = js::str(r.get(u"sec_type"_s));
        const QString alias = js::str(r.get(u"account"_s));
        const QString symbol = js::str(r.get(u"symbol"_s));
        const double q = js::num(r.get(u"quantity"_s));
        if (st == u"STK") held.insert(alias + u'|' + symbol, q);
        else if (st == u"OPT" || st == u"FOP") {
            const OJson* c = r.get(u"contract"_s);
            QString k = QString::number(js::num(js::prop(c, u"strike"_s)), 'f', 4);
            while (k.contains(u'.') && (k.endsWith(u'0') || k.endsWith(u'.'))) k.chop(1);
            held.insert(alias + u'|' + symbol + u'|' + js::str(js::prop(c, u"lastTradeDateOrContractMonth"_s)).left(8) + u'|' + k + u'|' +
                            js::str(js::prop(c, u"right"_s)).left(1).toUpper(),
                        q);
        }
    }

    // 成交:7 天历史,账号换成别名,按美东日期标(TWS 的"今天"在北京午夜翻篇,不能拿它的当日成交)
    QList<rp::Fill> fills;
    if (wiring_.fillHistory) {
        for (const OJson& f : co_await wiring_.fillHistory()) {
            const QString alias = aliasOfId(js::str(f.get(u"account_id"_s)));
            if (alias.isEmpty()) continue;
            const OJson* c = f.get(u"contract"_s);
            rp::Fill x;
            x.alias = alias;
            x.symbol = js::str(js::prop(c, u"symbol"_s));
            x.secType = js::str(js::prop(c, u"secType"_s));
            x.expiry = js::str(js::prop(c, u"expiry"_s)).left(8);
            x.right = js::str(js::prop(c, u"right"_s)).left(1).toUpper();
            x.strike = js::num(js::prop(c, u"strike"_s));
            if (!std::isfinite(x.strike)) x.strike = 0;
            x.side = js::str(f.get(u"side"_s));
            const OJson* perm = f.get(u"perm_id"_s);
            x.permId = js::nullish(perm) ? QString() : util::jsNumberToString(js::num(perm));
            x.time = js::str(f.get(u"time"_s));
            x.etDate = etDateOfIso(x.time);
            x.shares = js::num(f.get(u"shares"_s));
            x.price = js::num(f.get(u"price"_s));
            fills.append(x);
        }
    }
    const QList<rp::Order> orders = rp::groupOrders(fills);
    const QList<OJson> intents = store().guard().listAll();
    // 这一单开仓的时候有没有在用的意图:建在成交之前、那时还没关
    const auto intentFor = [&](const rp::Order& o) -> std::optional<OJson> {
        for (const OJson& i : intents) {
            if (js::str(i.get(u"account"_s)) != o.alias || js::str(i.get(u"symbol"_s)).toUpper() != o.symbol.toUpper()) continue;
            const QString created = js::str(i.get(u"created_at"_s));
            const QString closed = js::str(i.get(u"closed_at"_s));
            if (created > o.time || (!closed.isEmpty() && closed < o.time)) continue;
            const OJson* body = i.get(u"intent"_s);
            if (o.kind == u"stock" && js::str(i.get(u"kind"_s)) == u"stock") return i;
            if (o.kind != u"stock" && js::str(i.get(u"kind"_s)) == u"option") {
                QList<double> want;
                if (const OJson* ks = js::prop(body, u"strikes"_s); js::isArr(ks))
                    for (const OJson& k : ks->items) want.append(k.n);
                std::sort(want.begin(), want.end());
                if (want == o.strikes && js::str(js::prop(body, u"expiry"_s)).remove(u'-') == o.expiry) return i;
            }
        }
        return std::nullopt;
    };

    rp::Input in;
    in.date = today;
    in.friday = weekday == 4;
    in.connected = connected;

    // 净值:和上一份报告比
    OJson prevNavs = js::object();
    const QList<OJson> audit = store().guard().guardAudit(util::utcIso(at.epochMs - 14 * 86'400'000.0));  // 同上:按报告的钟回看
    for (const OJson& r : audit)
        if (js::str(r.get(u"action"_s)) == u"guard_report" && js::str(js::prop(r.get(u"detail"_s), u"date"_s)) < today)
            prevNavs = *js::prop(r.get(u"detail"_s), u"navs"_s);
    for (const contract::AccountConfig& a : settings().accounts) {
        if (a.connection == u"futu") continue;
        rp::Account acc;
        acc.alias = a.alias;
        acc.nav = wiring_.navOf ? wiring_.navOf(a.alias) : std::nullopt;
        if (!acc.nav) continue;  // 没连着 / 读不到的账户不进报告
        const OJson* prev = js::prop(&prevNavs, a.alias);
        if (js::isNum(prev) && prev->n > 0) acc.changePct = (*acc.nav - prev->n) / prev->n * 100.0;
        in.accounts.append(acc);
    }

    // 开仓:今天(美东)的单里此刻还按那个方向持有的
    for (const rp::Order& o : orders) {
        if (o.etDate != today || !rp::isOpen(o, held)) continue;
        const QString intent = intentFor(o) ? u"有意图"_s : u"无意图"_s;
        if (o.kind == u"stock")
            in.opened << u"%1 %2 %3 股（%4）"_s.arg(o.symbol, o.side == u"BOT" ? u"买入"_s : u"卖空"_s, util::jsNumberToString(o.qty), intent);
        else
            in.opened << u"%1 ×%2（%3）"_s.arg(o.label(), util::jsNumberToString(o.qty), intent);
    }

    // 止损触发、违规、断线:今天与本周的流水
    QMap<QString, QStringList> violations;  // 代码 → 说法(先后)
    QStringList symbolsOrder;
    int disconnects = 0;
    QHash<QString, double> defaultStops;  // 本周默认止损价(正股,别名|代码)
    for (const OJson& r : audit) {
        const QString d = etDateOfIso(js::str(r.get(u"at"_s)));
        const QString action = js::str(r.get(u"action"_s));
        const OJson* det = r.get(u"detail"_s);
        const QString symbol = js::str(js::prop(det, u"symbol"_s));
        if (d >= weekStart && d <= today) {
            if (action == u"guard_violation") in.weekViolations += 1;
            if (action == u"guard_fired" && stopLike(js::str(js::prop(det, u"state"_s)))) in.weekStops += 1;
            if (action == u"guard_default_stop")
                defaultStops.insert(js::str(js::prop(det, u"account"_s)) + u'|' + symbol, js::num(js::prop(det, u"stop"_s)));
        }
        if (d != today) continue;
        if (action == u"guard_disconnect") disconnects += 1;
        if (action == u"guard_fired" && stopLike(js::str(js::prop(det, u"state"_s)))) {
            const QString line = symbol + u" 止损"_s;
            if (!in.fired.contains(line)) in.fired << line;
        }
        if (action == u"guard_violation") {
            const QString kind = js::str(js::prop(det, u"kind"_s));
            QString say;
            if (kind == u"no_intent") say = (js::num(js::prop(det, u"quantity"_s)) < 0 ? u"手动卖空"_s : u"手动买入"_s) + u"无意图记录"_s;
            else if (kind == u"default_stop") say = u"默认止损已挂 @"_s + util::jsNumberToString(js::num(js::prop(det, u"stop"_s)));
            else if (kind == u"stop_lowered") say = u"止损被放松(已恢复)"_s;
            else if (kind == u"stop_cancelled") say = u"止损单被撤(已重挂)"_s;
            else if (kind == u"combo_unmatched") say = u"组合认不出"_s;
            else if (kind == u"track_without_stop") say = u"追踪没有止损"_s;
            else say = kind;
            const QString key = symbol.isEmpty() ? u"?"_s : symbol;
            if (!symbolsOrder.contains(key)) symbolsOrder << key;
            if (!violations[key].contains(say)) violations[key] << say;
        }
    }
    for (const QString& s : symbolsOrder) in.violations << s + u' ' + violations.value(s).join(u'，');
    in.disconnects = disconnects;

    // 明日到期:下一个交易日到期的组合与单腿期权
    QString next = addDays(today, 1);
    for (int i = 0; i < 10 && !settings().isTradingDay(next); ++i) next = addDays(next, 1);
    const QString nextExp = QString(next).remove(u'-');
    QSet<QString> comboBuckets;
    for (const OJson& r : domain::withCombos(rows)) {
        if (js::str(r.get(u"sec_type"_s)) != u"BAG") continue;
        const QString leg = js::str(r.get(u"leg"_s));
        if (!leg.startsWith(nextExp)) continue;
        comboBuckets.insert(js::str(r.get(u"account"_s)) + u'|' + js::str(r.get(u"symbol"_s)) + u'|' + nextExp);
        rp::Order o;
        o.kind = u"combo"_s;
        o.symbol = js::str(r.get(u"symbol"_s));
        QSet<QString> rights;
        for (const QString& part : leg.section(u'|', 1).split(u',')) {
            const qsizetype x = part.indexOf(u'x');
            if (x < 0) continue;
            QString k = part.mid(x + 1);
            QString rt;
            if (k.endsWith(u'C') || k.endsWith(u'P')) {
                rt = k.right(1);
                k.chop(1);
            }
            rights.insert(rt);
            if (!o.strikes.contains(k.toDouble())) o.strikes.append(k.toDouble());
            o.legKeys.append(part);
        }
        std::sort(o.strikes.begin(), o.strikes.end());
        if (rights.size() == 1) o.right = *rights.cbegin();
        in.expiring << u"%1 ×%2（%3）"_s.arg(o.label(), util::jsNumberToString(std::abs(js::num(r.get(u"quantity"_s)))), shortDate(nextExp));
    }
    for (const OJson& r : rows) {
        if (js::str(r.get(u"sec_type"_s)) != u"OPT") continue;
        const OJson* c = r.get(u"contract"_s);
        if (js::str(js::prop(c, u"lastTradeDateOrContractMonth"_s)).left(8) != nextExp) continue;
        if (comboBuckets.contains(js::str(r.get(u"account"_s)) + u'|' + js::str(r.get(u"symbol"_s)) + u'|' + nextExp)) continue;
        QString k = QString::number(js::num(js::prop(c, u"strike"_s)), 'f', 4);
        while (k.contains(u'.') && (k.endsWith(u'0') || k.endsWith(u'.'))) k.chop(1);
        in.expiring << u"%1 %2%3 ×%4（%5）"_s.arg(js::str(r.get(u"symbol"_s)), k, js::str(js::prop(c, u"right"_s)).left(1).toUpper(),
                                                util::jsNumberToString(js::num(r.get(u"quantity"_s))), shortDate(nextExp));
    }

    // 周五:本周做完的每一笔交易的 R 倍数(止损用开仓时意图里的原始止损价,不是抬过的)
    if (in.friday) {
        for (const rp::Trade& t : rp::closedTrades(orders, weekStart, held)) {
            rp::WeekTrade w;
            w.label = t.label;
            std::optional<double> stop;
            // 找开这一笔的那一单,认当时的意图
            for (const rp::Order& o : orders) {
                if (o.instrument() != t.instrument || o.etDate != t.openDate) continue;
                if (const auto i = intentFor(o)) {
                    const OJson* body = i->get(u"intent"_s);
                    if (o.kind == u"stock") stop = js::num(js::prop(body, u"stop_price"_s));
                    else if (const OJson* x = js::path(body, {u"exits"_s, u"stop_loss_x"_s}); js::isNum(x)) stop = t.entry * x->n;
                } else if (o.kind == u"stock") {
                    const auto it = defaultStops.constFind(o.alias + u'|' + o.symbol);
                    if (it != defaultStops.cend()) stop = *it;
                }
                break;
            }
            w.r = rp::rMultiple(t, stop);
            if (!w.r) w.note = stop ? u"止损价不对"_s : u"无止损"_s;
            in.weekTrades.append(w);
        }
    }
    co_return rp::build(in);
}

}  // namespace ibkr::orchestrate
