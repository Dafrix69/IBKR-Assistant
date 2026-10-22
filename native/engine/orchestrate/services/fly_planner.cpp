#include "orchestrate/services/fly_planner.h"

#include "analysis/fly_plan.h"
#include "domain/config.h"
#include "execution/held_streams.h"
#include "execution/option_marks.h"
#include "util/jsnum.h"
#include "util/jsobj.h"
#include "util/py.h"
#include "util/rpc_error.h"

#include <cmath>

namespace ibkr::orchestrate {

using namespace Qt::StringLiterals;
using util::OJson;
using util::RpcError;
using util::Task;
namespace js = util::js;
namespace fp = analysis::flyplan;

namespace {

class OptionMarksAdapter : public MarksPort {
public:
    explicit OptionMarksAdapter(SvcRuntime& rt)
        : streams_(execution::IntervalTimers{[&rt](int ms, std::function<void()> fn) { return quint64(rt.setInterval(ms, std::move(fn))); },
                                             [&rt](quint64 id) { rt.clearInterval(int(id)); }}) {}
    Task<std::vector<execution::OptionMark>> read(std::shared_ptr<execution::IbSession> session, std::vector<execution::OptionLegSpec> legs, bool delayedOk,
                                                  double silentLimitMs) override {
        return streams_.read(std::move(session), std::move(legs), delayedOk, silentLimitMs);
    }
    void close() override { streams_.close(); }

private:
    execution::OptionMarkStreams streams_;
};

QString jsTrim(const QString& s) {
    qsizetype a = 0, b = s.size();
    while (a < b && util::isJsWhitespace(s[a])) ++a;
    while (b > a && util::isJsWhitespace(s[b - 1])) --b;
    return s.mid(a, b - a);
}

}  // namespace

std::shared_ptr<MarksPort> makeOptionMarksPort(SvcRuntime& runtime) { return std::make_shared<OptionMarksAdapter>(runtime); }

FlyPlannerService::FlyPlannerService(SvcHost& host) : SvcBase(host), marks(makeOptionMarksPort(host.runtime())) {}

bool FlyPlannerService::connected() {
    const auto r = routerPort();
    return r && r->hasSessions();
}

Task<OJson> FlyPlannerService::planFor(OJson params) {
    const OJson* symP = js::prop(&params, u"symbol"_s);
    QString symbol = jsTrim(js::nullish(symP) ? u"SPX"_s : js::str(symP)).toUpper();
    if (symbol.isEmpty()) symbol = u"SPX"_s;
    const auto* cfg = settings().indexConfig(symbol);
    const QString tradingClass = cfg ? cfg->daily_trading_class : QString();
    const domain::EtNow now = domain::nowEt();
    try {
        fp::ScheduleArgs sa;
        sa.symbol = symbol;
        sa.tradingClass = tradingClass;
        sa.targetTime = js::str(js::prop(&params, u"target_time"_s));
        if (const OJson* v = js::prop(&params, u"target_date"_s); !js::nullish(v)) sa.targetDate = js::str(v);
        if (const OJson* v = js::prop(&params, u"expiry"_s); !js::nullish(v)) sa.expiry = js::str(v);
        sa.nowMs = now.epochMs;
        const fp::PlanSchedule schedule = fp::planSchedule(sa, fp::PlanCalendar{[this](const QString& d) { return settings().isTradingDay(d); },
                                                                               [this](const QString& d) { return settings().early_close_days.contains(d); }});
        QStringList warnings = schedule.warnings;
        Spot spot;
        if (const OJson* sp = js::prop(&params, u"spot"_s)) {
            spot = Spot{js::num(sp), u"input"_s, QString()};
        } else {
            spot = co_await liveSpot(symbol);
        }
        const QString right = rightOf(params, spot.price, warnings);
        std::optional<double> ivInput;
        if (const OJson* iv = js::prop(&params, u"iv"_s)) ivInput = js::num(iv) / 100;
        const double center = js::num(js::prop(&params, u"center"_s)), width = js::num(js::prop(&params, u"width"_s));
        const QList<double> strikes{center - width, center, center + width};
        const OJson* costP = js::prop(&params, u"cost"_s);
        const OJson marksJson = co_await liveMarks(Fly{symbol, schedule.expiry, tradingClass, right, strikes}, Given{ivInput.has_value(), costP != nullptr}, &warnings);
        if (onMarks && spot.source != u"input" && !marksJson.fields.isEmpty()) {
            OJson legs = js::array();
            for (double strike : strikes) {
                OJson leg = js::object({{u"strike"_s, js::N(strike)}, {u"right"_s, js::S(right)}});
                const OJson* m = marksJson.get(fp::markKey(strike));
                for (const QString& k : {u"bid"_s, u"ask"_s, u"iv"_s}) leg.set(k, js::copyOrNull(js::prop(m, k)));
                legs.items.append(leg);
            }
            onMarks(js::object({{u"t"_s, js::N(now.epochMs)},
                                {u"symbol"_s, js::S(symbol)},
                                {u"expiry"_s, js::S(schedule.expiry)},
                                {u"trading_class"_s, js::S(tradingClass)},
                                {u"spot"_s, js::N(spot.price)},
                                {u"spot_source"_s, js::S(spot.source)},
                                {u"legs"_s, legs}}));
        }
        fp::FlyPlanInput in;
        in.symbol = symbol;
        in.expiry = schedule.expiry;
        in.tradingClass = tradingClass;
        in.right = right;
        in.center = center;
        in.width = width;
        const OJson* q = js::prop(&params, u"quantity"_s);
        in.quantity = js::nullish(q) ? 1 : js::num(q);
        in.multiplier = 100;
        in.spot = spot.price;
        in.spotSource = spot.source;
        in.spotNote = spot.note;
        in.nowMs = now.epochMs;
        in.expiryMs = schedule.expiryMs;
        in.targetMs = schedule.targetMs;
        in.targetSpot = js::num(js::prop(&params, u"target_spot"_s));
        for (const QString& k : marksJson.fields.isEmpty() ? QStringList() : js::keys(&marksJson)) {
            const OJson* m = js::prop(&marksJson, k);
            fp::LegMark lm;
            for (auto [name, dst] : {std::pair{u"bid"_s, &lm.bid}, std::pair{u"ask"_s, &lm.ask}, std::pair{u"iv"_s, &lm.iv}}) {
                const OJson* v = js::prop(m, name);
                if (v && v->type == OJson::Number) *dst = v->n;
            }
            in.marks[k] = lm;
        }
        if (costP && !js::nullish(costP)) in.cost = js::num(costP);
        in.ivInput = ivInput;
        const OJson* mode = js::prop(&params, u"iv_mode"_s);
        in.ivMode = js::nullish(mode) ? u"auto"_s : js::str(mode);
        if (const OJson* sh = js::prop(&params, u"iv_shift_pct"_s); !js::nullish(sh)) in.ivShiftPct = js::num(sh);
        in.timelineMs = schedule.timelineMs;
        in.warnings = warnings;
        co_return fp::planFly(in);
    } catch (const fp::FlyPlanError& exc) {
        throw RpcError(-32602, exc.message());
    } catch (const execution::OptionMarksError& exc) {
        throw RpcError(-32017, exc.message());
    }
}

QString FlyPlannerService::rightOf(const OJson& params, double spot, QStringList& warnings) {
    const OJson* r = js::prop(&params, u"right"_s);
    const QString given = jsTrim(js::nullish(r) ? QString() : js::str(r)).toUpper();
    if (!given.isEmpty()) {
        static const QHash<QString, QString> rights{{u"C"_s, u"C"_s}, {u"CALL"_s, u"C"_s}, {u"看涨"_s, u"C"_s}, {u"P"_s, u"P"_s}, {u"PUT"_s, u"P"_s}, {u"看跌"_s, u"P"_s}};
        const auto it = rights.constFind(given);
        if (it == rights.cend()) throw fp::FlyPlanError(u"看涨还是看跌要写成 C 或 P,收到「%1」。"_s.arg(js::str(r)));
        return it.value();
    }
    // 和本地速记同一条规则(shorthand.ts):中心在现价上方看涨,下方看跌,相等按看涨
    const double center = js::num(js::prop(&params, u"center"_s));
    const QString right = center >= spot ? u"C"_s : u"P"_s;
    const QString where = center > spot ? u"高于"_s : center < spot ? u"低于"_s : u"等于"_s;
    warnings.append(u"中心 %1 %2现价 %3,按%4蝶算。"_s.arg(util::pyG(center), where, util::pyG(spot), right == u"C" ? u"看涨"_s : u"看跌"_s));
    return right;
}

Task<OJson> FlyPlannerService::spotFor(QString symbol) {
    const double at = domain::nowEt().epochMs;
    const auto none = [&](const QString& note) {
        return js::object({{u"symbol"_s, js::S(symbol)}, {u"price"_s, js::Null()}, {u"source"_s, js::S(u"none"_s)}, {u"note"_s, js::S(note)}, {u"at"_s, js::N(at)}});
    };
    const auto router = routerPort();
    if (!router || !connected()) co_return none(u"没连%1"_s.arg(gatewayLabel()));
    const Asked a = co_await askSpot(symbol);
    if (!a.price || !(*a.price > 0)) co_return none(u"拿不到 %1 的现价"_s.arg(symbol));
    const OJson* srcP = a.info ? js::prop(&*a.info, u"source"_s) : nullptr;
    const QString src = js::isStr(srcP) ? srcP->s : QString();
    const OJson* noteP = a.info ? js::prop(&*a.info, u"note"_s) : nullptr;
    const auto noteOr = [&](const QString& dflt) { return js::nullish(noteP) ? dflt : js::str(noteP); };
    if (a.info && js::isStr(srcP) && src == u"index_stale") {
        co_return js::object({{u"symbol"_s, js::S(symbol)}, {u"price"_s, js::N(*a.price)}, {u"source"_s, js::S(u"stale"_s)},
                              {u"note"_s, js::S(noteOr(u"%1 拿到的是昨收,不是现价"_s.arg(symbol)))}, {u"at"_s, js::N(at)}});
    }
    if (router->upstreamOk() == false) {
        co_return js::object({{u"symbol"_s, js::S(symbol)}, {u"price"_s, js::N(*a.price)}, {u"source"_s, js::S(u"stale"_s)},
                              {u"note"_s, js::S(u"%1 与 IBKR 服务器之间断开了,这是断开前的最后一笔"_s.arg(gatewayName(settings())))}, {u"at"_s, js::N(at)}});
    }
    co_return js::object({{u"symbol"_s, js::S(symbol)}, {u"price"_s, js::N(*a.price)}, {u"source"_s, js::S(js::isStr(srcP) && src == u"futures" ? u"futures"_s : u"quote"_s)},
                          {u"note"_s, js::S(noteOr(QString()))}, {u"at"_s, js::N(at)}});
}

/// 向券商问一次现价,连同它是怎么来的。取价出错当作没有价
Task<FlyPlannerService::Asked> FlyPlannerService::askSpot(QString symbol) {
    const auto router = routerPort();
    if (!router) co_return Asked{};
    Asked out;
    try {
        if (settings().indexConfig(symbol)) {
            out.price = co_await router->indexPrice(symbol);
        } else {
            const OJson quotes = co_await router->streamQuotes({symbol});
            const OJson* last = js::prop(js::prop(&quotes, symbol), u"last"_s);
            if (!js::nullish(last)) out.price = js::num(last);
        }
    } catch (...) {
        out.price.reset();
    }
    out.info = router->spotInfo(symbol);
    co_return out;
}

Task<FlyPlannerService::Spot> FlyPlannerService::liveSpot(QString symbol) {
    if (!routerPort() || !connected()) throw RpcError(-32017, u"没连%1,拿不到现价:先去连接,或者手动填上现价与 IV 再算。"_s.arg(gatewayLabel()));
    const Asked a = co_await askSpot(symbol);
    const OJson* srcP = a.info ? js::prop(&*a.info, u"source"_s) : nullptr;
    // 夜盘推算失败时拿到的是昨收:和盯盘同一条规矩,当作没有现价
    if (js::isStr(srcP) && srcP->s == u"index_stale") {
        const OJson* noteP = js::prop(&*a.info, u"note"_s);
        throw RpcError(-32017, (js::nullish(noteP) ? u"%1 拿到的是昨收,不是现价"_s.arg(symbol) : js::str(noteP)) + u"。可以手动填上现价再算。"_s);
    }
    if (!a.price || !(*a.price > 0)) throw RpcError(-32017, u"拿不到 %1 的现价。可以手动填上现价再算。"_s.arg(symbol));
    const OJson* noteP = a.info ? js::prop(&*a.info, u"note"_s) : nullptr;
    co_return Spot{*a.price, js::isStr(srcP) && srcP->s == u"futures" ? u"futures"_s : u"quote"_s, js::nullish(noteP) ? QString() : js::str(noteP)};
}

/// 三条腿的盘口与模型 IV。取不到时:手动给了 IV 就带着一句话接着算,没给就把原因抛给用户
Task<OJson> FlyPlannerService::liveMarks(Fly fly, Given given, QStringList* warnings) {
    const auto giveUp = [&](const QString& why) -> OJson {
        if (!given.iv) throw RpcError(-32017, why + u"可以手动填上 IV 再算。"_s);
        // 成本已经填了的,不再催一遍
        warnings->append(given.cost ? why : why + u"成本请自己填,否则用的是模型价。"_s);
        return js::object();
    };
    const auto router = routerPort();
    if (!router || !connected()) co_return giveUp(u"没连%1,拿不到盘口与 IV。"_s.arg(gatewayLabel()));
    if (settings().broker.provider != u"ibkr") co_return giveUp(u"蝴蝶测算的期权行情目前只从 IBKR 取。"_s);

    const auto session = router->marketSession();
    const QStringList managed = session->managedAccounts();
    bool delayedOk = !managed.isEmpty();
    for (const QString& id : managed)
        if (!id.startsWith(u'D')) delayedOk = false;
    std::vector<execution::OptionLegSpec> legs;
    for (double strike : fly.strikes) legs.push_back({fly.symbol, fly.expiry, strike, fly.right, u"SMART"_s, fly.tradingClass});
    std::vector<execution::OptionMark> got;
    std::optional<QString> readError;
    try {
        // 开着自动刷新时这批流一直是热的:断线重连后一直没盘口的,过了时限重订(按正股表的时段给时限)
        got = co_await marks->read(session, legs, delayedOk, execution::silenceLimitMs(settings().marketStatus(domain::nowEt())));
    } catch (const execution::OptionMarksError& exc) {
        if (!given.iv) throw;
        readError = exc.message();
    }
    if (readError) co_return giveUp(*readError);
    QStringList refused;
    for (const auto& m : got)
        if (m.error && !m.error->isEmpty() && !m.iv && !m.ask) refused.append(util::pyG(m.strike) + m.right + u' ' + *m.error);
    if (!refused.isEmpty()) co_return giveUp(u"取不到 %1 期权行情,TWS 拒了订阅:%2。"_s.arg(fly.symbol, refused.join(u';')));
    OJson out = js::object();
    for (const auto& m : got) out.set(fp::markKey(m.strike), js::object({{u"bid"_s, js::NOrNull(m.bid)}, {u"ask"_s, js::NOrNull(m.ask)}, {u"iv"_s, js::NOrNull(m.iv)}}));
    co_return out;
}

}  // namespace ibkr::orchestrate
