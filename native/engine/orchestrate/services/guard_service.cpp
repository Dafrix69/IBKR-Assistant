#include "orchestrate/services/guard_service.h"

#include "analysis/guard_rules.h"
#include "util/error.h"
#include "util/jsformat.h"
#include "util/js_runtime.h"
#include "util/jsobj.h"

#include <QDate>
#include <QDir>
#include <QFile>
#include <QFileInfo>

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

/// 这条追踪是不是已经替这只股票管着止损:启用、打开了自动平仓、有止损价或跟踪止损
bool trackProtects(const OJson& t) {
    if (!js::truthy(t.get(u"enabled"_s))) return false;
    if (!js::truthy(js::prop(t.get(u"auto_close"_s), u"enabled"_s))) return false;
    const OJson* targets = t.get(u"targets"_s);
    return !js::nullish(js::prop(targets, u"stop_loss"_s)) || !js::nullish(js::prop(targets, u"trail_pct"_s));
}

}  // namespace

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

void GuardService::tell(const QString& title, const QString& body, const QString& symbol) {
    try {
        eng().notifier().notify(title, body, symbol);
    } catch (...) {
        /* 通知发不出去不影响下一条 */
    }
    emitEvent(u"guard"_s, js::object({{u"title"_s, js::S(title)}, {u"body"_s, js::S(body)}, {u"symbol"_s, js::S(symbol)}}));
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
            const bool closed = ok && result.get(u"closed"_s);
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
    const QString today = todayArg ? *todayArg : domain::nowEt().date;
    out.set(u"inbox"_s, ingestInbox());
    out.set(u"positions"_s, co_await watchPositions(nowMs, today));
    co_return out;
}

Task<OJson> GuardService::watchPositions(double nowMs, QString today) {
    OJson out = js::object({{u"warned"_s, js::N(0)}, {u"stopped"_s, js::N(0)}, {u"failed"_s, js::N(0)}, {u"auto_closed"_s, js::N(0)}});
    const auto router = routerPort();
    if (!router || !router->hasSessions()) co_return out;
    QList<OJson> rows;
    try {
        rows = co_await router->positions();
    } catch (...) {
        co_return out;  // 读不到持仓:不当成空仓,下一轮再看
    }
    const contract::GuardConfig cfg = settings().guard;
    const QList<OJson> tracks = store().listTracks();
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

        // 有在用、方向对得上的意图:不管(止损归 Step 2)
        if (const auto intent = store().guard().openStock(alias, symbol)) {
            const QString side = js::str(js::prop(intent->get(u"intent"_s), u"side"_s));
            if ((side == u"BUY") == isLong) {
                store().guard().markSeen(js::num(intent->get(u"id"_s)));
                watch_.remove(key);
                continue;
            }
        }
        // 已经有追踪替它管着止损:不管
        bool tracked = false;
        bool protectedByTrack = false;
        for (const OJson& t : tracks) {
            if (js::str(t.get(u"account"_s)) != alias || js::str(t.get(u"symbol"_s)) != symbol || js::str(t.get(u"sec_type"_s)) != u"STK") continue;
            tracked = true;
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
                 symbol);
            out.set(u"warned"_s, js::N(js::num(out.get(u"warned"_s)) + 1));
            continue;
        }
        Watch& w = it.value();
        if (w.stopPlaced || nowMs - w.firstSeenMs < cfg.grace_s * 1000) continue;
        if (tracked) {
            // 已经有一条追踪但没管止损:不改别人的追踪,只提醒
            if (nowMs - w.lastNagMs >= kNagMs) {
                w.lastNagMs = nowMs;
                journal(u"guard_violation"_s, js::object({{u"kind"_s, js::S(u"track_without_stop"_s)}, {u"account"_s, js::S(alias)}, {u"symbol"_s, js::S(symbol)}}));
                tell(u"股票仓位没有止损"_s, u"%1 的持仓追踪没有止损价或没开自动平仓。guard 不改已有的追踪,请补上止损或补录意图。"_s.arg(symbol), symbol);
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
            if (!wiring_.addTrack) throw util::JsError(u"建追踪的通道没有接上"_s);
            const QString note = u"guard 默认止损:没有交易意图,入场 %1 × %2% 与前 %3 日%4 %5 取更近的一条"_s.arg(
                money(entry), util::jsNumberToString(100 - (isLong ? cfg.default_stop_pct : -cfg.default_stop_pct)), util::jsNumberToString(cfg.default_low_days),
                isLong ? u"最低"_s : u"最高"_s, extreme ? money(*extreme) : u"(没取到)"_s);
            co_await wiring_.addTrack(js::object({{u"key"_s, js::S(key)},
                                                  {u"stop_loss"_s, js::N(stop)},
                                                  {u"auto_close"_s, js::B(true)},
                                                  {u"host_at_broker"_s, js::B(true)},
                                                  {u"note"_s, js::S(note)}}));
        } catch (...) {
            failure = std::current_exception();
        }
        if (!failure) {
            w.stopPlaced = true;
            journal(u"guard_default_stop"_s, detail);
            journal(u"guard_violation"_s, js::object({{u"kind"_s, js::S(u"default_stop"_s)}, {u"account"_s, js::S(alias)}, {u"symbol"_s, js::S(symbol)}, {u"stop"_s, js::N(stop)}}));
            tell(u"已挂默认止损"_s, u"%1 没有补录交易意图,已按默认规则在券商挂止损 @%2。"_s.arg(symbol, money(stop)), symbol);
            out.set(u"stopped"_s, js::N(js::num(out.get(u"stopped"_s)) + 1));
        } else {
            const QString why = errorText(failure);
            out.set(u"failed"_s, js::N(js::num(out.get(u"failed"_s)) + 1));
            if (nowMs - w.lastNagMs >= kNagMs) {
                w.lastNagMs = nowMs;
                detail.set(u"error"_s, js::S(why));
                journal(u"guard_default_stop_failed"_s, detail);
                tell(u"默认止损挂不上"_s, u"%1 默认止损 %2 挂不上:%3。这只股票现在没有止损,请立即处理。"_s.arg(symbol, money(stop), why), symbol);
            }
        }
    }
    // 不在了的仓位不再盯
    for (auto it = watch_.begin(); it != watch_.end();) {
        if (!present.contains(it.key())) it = watch_.erase(it);
        else ++it;
    }
    // 意图对应的持仓出现过、现在没了:自动关掉
    for (const OJson& intent : store().guard().listOpen()) {
        if (js::str(intent.get(u"kind"_s)) != u"stock" || !js::truthy(intent.get(u"seen_position"_s))) continue;
        const QString alias = js::str(intent.get(u"account"_s));
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

}  // namespace ibkr::orchestrate
