#include "transport/handlers/tracker_handlers.h"

#include "analysis/fly_model.h"
#include "analysis/tracker_rules.h"
#include "domain/positions.h"
#include "execution/broker_pricing.h"
#include "transport/handlers/handler_util.h"
#include "transport/params.h"
#include "util/tz.h"

#include <cmath>

using namespace Qt::StringLiterals;

namespace ibkr::rpc {

namespace js = util::js;
namespace tk = orchestrate::tracker;
namespace an = analysis;
using util::OJson;
using util::RpcError;

namespace {

/// raw["sec_type"] === type
bool secIs(const OJson& raw, const QString& type) {
    const OJson* v = raw.get(u"sec_type"_s);
    return js::isStr(v) && v->s == type;
}
/// String(raw["sec_type"] ?? "STK")
QString secTypeOf(const OJson& raw) {
    const OJson* v = raw.get(u"sec_type"_s);
    return js::nullish(v) ? u"STK"_s : js::str(v);
}

/// 券商没报盈亏(positions() 兜底路径只有成本)时,用追踪器同一套口径本地算(对应 Python _fill_pnl)。
void fillPnl(OJson& row) {
    const OJson* pnl = row.get(u"unrealized_pnl"_s);
    if (!js::nullish(pnl)) {
        if (js::nullish(row.get(u"pnl_source"_s))) row.set(u"pnl_source"_s, js::S(u"broker"_s));
        return;
    }
    const OJson* price = row.get(u"market_price"_s);
    const auto positionOf = [&row](const OJson& marketPrice) {
        OJson in = js::object();
        in.set(u"account"_s, js::S(js::str(row.get(u"account"_s))));
        in.set(u"symbol"_s, js::S(js::str(row.get(u"symbol"_s))));
        in.set(u"sec_type"_s, js::S(secTypeOf(row)));
        in.set(u"quantity"_s, js::N(hu::numOrDefault(row.get(u"quantity"_s), 0)));
        in.set(u"avg_cost"_s, js::N(hu::numOrDefault(row.get(u"avg_cost"_s), 0)));
        in.set(u"multiplier"_s, js::N(hu::numOrDefault(row.get(u"multiplier"_s), 1)));
        in.set(u"currency"_s, js::S(js::nullish(row.get(u"currency"_s)) ? u"USD"_s : js::str(row.get(u"currency"_s))));
        in.set(u"market_price"_s, marketPrice);
        return tk::makePosition(in);
    };
    if (js::nullish(price)) {
        if (js::nullish(row.get(u"pnl_source"_s))) row.set(u"pnl_source"_s, js::Null());
        // 休市没有现价:按昨收另算一份盈亏给界面(close_pnl),不写进 unrealized_pnl——那个字段是"此刻"的口径
        const OJson* closePrice = row.get(u"close_price"_s);
        const double close = js::num(closePrice);
        if (!js::nullish(closePrice) && std::isfinite(close)) {
            const OJson at = tk::unrealized(positionOf(js::N(close)), close);
            const OJson* p = at.get(u"unrealized_pnl"_s);
            const OJson* pc = at.get(u"unrealized_pct"_s);
            row.set(u"close_pnl"_s, js::nullish(p) ? js::Null() : *p);
            row.set(u"close_pct"_s, js::nullish(pc) ? js::Null() : *pc);
        }
        return;
    }
    const OJson out = tk::unrealized(positionOf(*price), hu::optNumber(price));
    if (js::nullish(row.get(u"market_value"_s))) {
        const OJson* mv = out.get(u"market_value"_s);
        row.set(u"market_value"_s, js::nullish(mv) ? js::Null() : *mv);
    }
    const OJson* p = out.get(u"unrealized_pnl"_s);
    const OJson* pc = out.get(u"unrealized_pct"_s);
    row.set(u"unrealized_pnl"_s, js::nullish(p) ? js::Null() : *p);
    row.set(u"unrealized_pct"_s, js::nullish(pc) ? js::Null() : *pc);
    row.set(u"pnl_source"_s, js::S(u"computed"_s));
}

/// Object.fromEntries(rows.map(r => [r["key"], r])):键是 String(key),后来的盖前面的
OJson keyedRows(const QList<OJson>& rows) {
    OJson out = js::object();
    for (const OJson& r : rows) out.set(js::str(r.get(u"key"_s)), r);
    return out;
}

/// 从持仓行拼 makePosition 的入参:只带这八个字段(TS 里是显式列出来的,market_value / unrealized_pnl / leg 不带)
tk::Position positionFromRaw(const OJson& raw) {
    OJson in = js::object();
    for (const QString& k : {u"account"_s, u"symbol"_s, u"sec_type"_s, u"quantity"_s, u"avg_cost"_s, u"multiplier"_s, u"currency"_s, u"market_price"_s})
        if (const OJson* v = raw.get(k)) in.set(k, *v);
    return tk::makePosition(in);
}

/// 蝶式预设按金额起算要的"每组开仓成本"(美元,含乘数):只认组合行,正股 / 单腿回空(那些仍按比例)。
std::optional<double> flyUnitCost(const OJson& raw) {
    if (hu::strOr(raw.get(u"sec_type"_s)) != u"BAG") return std::nullopt;
    const double cost = std::fabs(js::nullish(raw.get(u"avg_cost"_s)) ? 0 : js::num(raw.get(u"avg_cost"_s)));
    return std::isfinite(cost) && cost > 0 ? std::optional<double>(cost) : std::nullopt;
}

/// 托管到券商就是授权发单:「到价自动平仓」没开,托管单一张都挂不出去(closeBlockers 的 BLOCK_DISABLED)。
/// 打开托管就顺带打开它;只有明说要关掉自动平仓、托管却留着时才拒——那是自相矛盾的一份设置
void requireAutoCloseForHosting(bool hostAtBroker, bool autoClose) {
    if (hostAtBroker && !autoClose) throw RpcError(-32602, u"托管到券商时不能关掉「到价自动平仓」:要停自动平仓,先关托管。"_s);
}

std::optional<double> numField(const OJson& obj, const QString& key) { return hu::optNumber(obj.get(key)); }


/// 美东 MM/dd HH:mm(zh-CN、hour12: false)
QString etWhen(double epochMs) {
    const util::WallParts p = util::wallParts(epochMs, QString::fromUtf16(util::kET));
    return util::pad2(p.month) + u'/' + util::pad2(p.day) + u' ' + util::pad2(p.hour) + u':' + util::pad2(p.minute);
}

[[noreturn]] void invalid(const QString& message) { throw RpcError(-32602, message); }

/// store 抛的什么都变成 -32602(TS 的 `catch (exc) { throw new RpcError(-32602, (exc as Error).message) }`)
[[noreturn]] void rethrowAsInvalid() {
    try {
        throw;
    } catch (const util::JsError& e) {
        invalid(e.message());
    } catch (const std::exception& e) {
        invalid(QString::fromUtf8(e.what()));
    }
}

/// ctx.trackerLock(fn)
template <class T>
util::Task<T> locked(RpcContext& ctx, std::function<util::Task<T>()> fn) {
    return ctx.trackerLock().template run<T>(std::move(fn));
}

}  // namespace

tk::SpotTargetArgs TrackerHandlers::SpotInputs::args(double spotTarget) const {
    tk::SpotTargetArgs a;
    a.spotTarget = spotTarget;
    a.spot = spot;
    a.markPrice = markPrice;
    a.minute = minute;
    a.em = em;
    a.legPrices = legInputs.get(u"legPrices"_s);
    a.spotNote = spotNote;
    a.legIvs = legInputs.get(u"legIvs"_s);
    a.expiryMs = hu::optNumber(legInputs.get(u"expiryMs"_s));
    a.nowMs = nowMs;
    return a;
}

MethodTable TrackerHandlers::methods() {
    ContractTable t;
    t.async(u"tracker.poll"_s, [this](OJson) { return trackerPoll(); });
    t.async(u"tracker.reconcile"_s, [this](OJson) { return trackerReconcile(); });
    t.async(u"tracker.close_now"_s, [this](OJson p) { return trackerCloseNow(std::move(p)); });
    t.async(u"positions.list"_s, [this](OJson) { return positionsList(); });
    t.sync(u"tracker.list"_s, [this](const OJson&) { return trackerList(); });
    t.async(u"tracker.add"_s, [this](OJson p) { return trackerAdd(std::move(p)); });
    t.asyncRaw(u"tracker.update"_s, [this](OJson p, OJson raw) { return trackerUpdate(std::move(p), std::move(raw)); });
    t.async(u"tracker.delete"_s, [this](OJson p) { return trackerDelete(std::move(p)); });
    t.async(u"tracker.target_preview"_s, [this](OJson p) { return trackerTargetPreview(std::move(p)); });
    return t.take();
}

// ---- 持仓追踪 --------------------------------------------------------
util::Task<OJson> TrackerHandlers::positionsList() {
    const auto router = ports_.router();
    if (!router || !router->sessionCount()) throw needConnection(-32018, u"读取持仓"_s);
    QList<OJson> rows;
    try {
        rows = co_await router->positions();
    } catch (const execution::BrokerError& exc) {
        throw RpcError(-32018, exc.message());
    }
    QSet<QString> tracked;
    for (const OJson& t : ports_.engine().store().listTracks()) tracked.insert(tk::trackKey(t));
    // 期权腿按账户/标的/到期日认成组合(蝴蝶/价差/铁鹰),折成一条 BAG 虚拟行:用户盯的是"这只蝴蝶值多少",组合行和腿行都能追踪
    rows = domain::withCombos(rows);
    OJson out = js::array();
    for (OJson& row : rows) {
        const OJson* key = row.get(u"key"_s);
        row.set(u"tracked"_s, js::B(js::isStr(key) && tracked.contains(key->s)));
        fillPnl(row);
        out.items.append(row);
    }
    co_return js::object({{u"positions"_s, out}});
}

OJson TrackerHandlers::trackerList() {
    const QList<OJson> tracks = ports_.engine().store().listTracks();
    // 这条联动加上之前建的追踪:这次运行第一次列追踪时补上盯价位(同 alerts.list 里股票池的一次性迁移,幂等)
    QStringList symbols;
    for (const OJson& t : tracks) symbols.append(js::str(t.get(u"symbol"_s)));
    const QStringList notes = ports_.alerts().adoptTracked(symbols);
    if (!notes.isEmpty()) ports_.engine().notifyWarning(notes.first());
    OJson arr = js::array();
    for (const OJson& t : tracks) arr.items.append(t);
    return js::object({{u"tracks"_s, arr}});
}

/// 算一次预计价位与预估收益:标的走到 spot_target 时,这份持仓按当前波动率该值多少。只读,不建追踪也不发单。
util::Task<OJson> TrackerHandlers::trackerTargetPreview(OJson params) {
    const QString key = hu::strOr(params.get(u"key"_s));
    const std::optional<double> target = optFloat(params.get(u"spot_target"_s));
    if (!target) invalid(u"要给一个标的目标价 spot_target。"_s);
    const OJson rows = keyedRows(domain::withCombos(co_await livePositions()));
    const OJson* rawp = rows.get(key);
    if (!rawp) invalid(u"找不到这个持仓,请刷新持仓列表。"_s);
    const OJson raw = *rawp;
    const auto structure = tk::structureOf(secTypeOf(raw), raw.get(u"contract"_s));
    if (!structure) {
        invalid(u"这份持仓认不出结构,用不了标的目标价:"
                u"正股、单腿期权,以及每条腿都带行权价与看涨/看跌的组合才行。"_s);
    }
    const Position position = positionFromRaw(raw);
    const SpotInputs inputs = co_await spotInputs(raw, rows, *structure);
    OJson st = tk::spotTarget(*structure, position, inputs.args(*target));
    // 设置时会拒的那句(挂上去会立刻成交),试算时就说出来
    const QString warning = tk::fillsNowMessage(position, *structure, st, inputs.markPrice);
    if (!warning.isEmpty()) st.set(u"warning"_s, js::S(warning));
    // 此刻立刻平掉能拿到多少:和"标的到了目标价挂的价"摆在一起,人才知道追价平仓大概落在哪
    if (structure->kind != u"stock" && ports_.router()) {
        const std::optional<double> natural = co_await ports_.engine().naturalCloseFor(raw, position, rows);
        if (natural) {
            st.set(u"natural"_s, js::N(*natural));
            // 追价最多让到哪:自然价按 chase_max_pct 让满(界面没传就按默认)
            OJson in = js::object();
            if (const auto chase = optFloat(params.get(u"chase_max_pct"_s))) in.set(u"chase_max_pct"_s, js::N(*chase));
            const OJson autoClose = tk::makeAutoClose(in);
            st.set(u"chase_floor"_s, js::N(tk::chaseFloor(position, *natural, autoClose)));
            st.set(u"chase_max_pct"_s, js::copyOrNull(autoClose.get(u"chase_max_pct"_s)));
        }
    }
    co_return js::object({{u"spot_target"_s, st}, {u"structure"_s, js::object({{u"kind"_s, js::S(structure->kind)}, {u"label"_s, js::S(structure->label)}})}});
}

/**
 * 追踪目标的校验,新建与修改共用一份——两处各写一份,日后必然走样。
 *  · 方向(多头止盈在上、止损在下……)
 *  · 止盈价与标的目标价二选一
 *  · 组合托管只放开一张按标的目标价的限价止盈单
 *  · 标的目标价要当场算得出、比现价更有利;开了自动平仓或托管的,还得是市场价算出来的
 *  · 标的止损价要在标的现价的保护一侧;拿不到标的现价就不给设
 */
util::Task<> TrackerHandlers::checkTargets(OJson raw, OJson rows, Position position, OJson targets, OJson autoClose) {
    const std::optional<double> spot = numField(targets, u"spot_target"_s);
    if (spot && !js::nullish(targets.get(u"take_profit"_s))) {
        invalid(u"止盈价和标的目标价只能选一个:"
                u"填了标的目标价,止盈价就由引擎按当前波动率每轮现算,不用也不该再自己填。"_s);
    }
    const bool hostAtBroker = js::truthy(autoClose.get(u"host_at_broker"_s));
    const bool autoEnabled = js::truthy(autoClose.get(u"enabled"_s));
    // 组合可以单独托管标的条件止损;限价止盈仍由标的目标价现算。
    const bool brokerSpot = js::truthy(autoClose.get(u"spot_stop_at_broker"_s));
    if (brokerSpot) {
        if (!hostAtBroker || !autoEnabled) invalid(u"IBKR 标的条件止损需要开启自动平仓和托管到券商。"_s);
        if (!secIs(raw, u"OPT"_s) && !secIs(raw, u"BAG"_s)) invalid(u"IBKR 标的条件止损只支持期权与组合。"_s);
        if (!an::hasSpotStop(targets)) invalid(u"IBKR 标的条件止损要先填「标的跌到」或「标的涨到」。"_s);
        if (js::str(autoClose.get(u"order_type"_s)) != u"MKT" && js::str(autoClose.get(u"order_type"_s)) != u"LMT")
            invalid(u"IBKR 标的条件平仓只支持 MKT 或 LMT。"_s);
        if (numField(targets, u"spot_stop_confirm_s"_s).value_or(0) > 0) invalid(u"IBKR 价格条件触线即发,不支持持续秒数确认;请清空确认秒数或关闭标的条件单托管。"_s);
        const auto limit = numField(autoClose, u"spot_stop_limit"_s);
        if ((limit && (!std::isfinite(*limit) || *limit <= 0)) ||
            ((secIs(raw, u"BAG"_s) || js::str(autoClose.get(u"order_type"_s)) == u"LMT") && !limit))
            invalid(u"IBKR 标的条件止损的限价平仓必须填写正数平仓限价(组合填净价)。"_s);
    }
    if (secIs(raw, u"BAG"_s) && hostAtBroker && !spot && !brokerSpot) {
        invalid(u"组合的「托管到券商」要先填标的目标价:"
                u"引擎按当前波动率把它换算成组合净价,挂一张随行情秒级调价的 GTC 限价单。"
                u"止损、利润回撤可以一起设,由引擎盯着,触发时把这张单改到立刻成交的价。"_s);
    }
    try {
        tk::validate(position, targets, hu::optNumber(raw.get(u"market_price"_s)),
                     numField(autoClose, u"rapid_exit_window_s"_s).has_value() && numField(autoClose, u"rapid_exit_pct"_s).has_value());
        co_await checkExits(raw, rows, position, targets, autoClose);
        if (!js::nullish(targets.get(u"spot_stop_below"_s)) || !js::nullish(targets.get(u"spot_stop_above"_s))) {
            // 填在现价另一侧的止损,建好的下一秒就把仓平掉:方向当场核对,取价和盯盘同一个口径
            const QString symbol = js::str(raw.get(u"symbol"_s));
            std::optional<double> liveSpot;
            const auto router = ports_.router();
            if (!(!router || secIs(raw, u"STK"_s))) {
                liveSpot = (co_await orchestrate::underlyingSpot(*router, symbol, settings().indexConfig(symbol) != nullptr)).spot;
                if (brokerSpot && settings().indexConfig(symbol) && router->hasSpotInfo()) {
                    const auto info = router->spotInfo(symbol);
                    if (info && js::str(info->get(u"source"_s)) == u"futures")
                        throw tk::TrackerError(u"IBKR 指数条件使用官方指数,当前是夜盘期货推算价;请等官方指数行情恢复后设置条件止损。"_s);
                }
            }
            const OJson spotJson = js::NOrNull(liveSpot);
            const auto issue = an::spotStopIssue(targets, secTypeOf(raw), symbol, &spotJson);
            if (issue) throw tk::TrackerError(*issue);
        }
        if (spot) {
            // 现在就算一次:算不出来的目标价不设。
            const auto structure = tk::structureOf(secTypeOf(raw), raw.get(u"contract"_s));
            if (!structure) {
                throw tk::TrackerError(u"这份持仓认不出结构,用不了标的目标价:正股、单腿期权,"
                                       u"以及每条腿都带行权价与看涨/看跌的组合才行。"_s);
            }
            const SpotInputs inputs = co_await spotInputs(raw, rows, *structure);
            const OJson st = tk::validateSpotTarget(position, raw.get(u"contract"_s), inputs.args(*spot));
            // 「同意价格后发单」:能拿去发单的只有市场价算出来的数
            static const QStringList marketSigma{u"none"_s, u"ibkr"_s, u"smile"_s, u"net"_s, u"leg"_s};
            if ((autoEnabled || hostAtBroker) && !marketSigma.contains(js::str(st.get(u"sigma_source"_s)))) {
                const QString note = js::str(st.get(u"spot_note"_s));
                throw tk::TrackerError(u"现在拿不到市场报价,这个价是按模型默认波动率算的参考值,不能拿它发单。"_s
                                       + (js::truthy(st.get(u"spot_note"_s)) ? u"(" + note + u")" : QString()) + u"等行情来了再设。"_s);
            }
        }
    } catch (const tk::TrackerError& exc) {
        throw RpcError(-32602, exc.message());
    }
}

/**
 * 出场细则的校验(到点平仓的钟点在取参数时已经查过):
 *  · 分批止盈:各档一档比一档有利、第一档在现价的有利一侧;托管的追踪不能设
 *  · 标的止损的确认秒数:要先有标的止损价
 *  · 止损按可成交价判:只给期权与组合;止损价要在此刻可成交价的保护一侧
 */
util::Task<> TrackerHandlers::checkExits(OJson raw, OJson rows, Position position, OJson targets, OJson autoClose) {
    const auto rapidWindow = numField(autoClose, u"rapid_exit_window_s"_s), rapidPct = numField(autoClose, u"rapid_exit_pct"_s);
    if (rapidWindow.has_value() != rapidPct.has_value()) throw tk::TrackerError(u"急跌保护的观察窗口和不利变动阈值必须一起填写或一起清空。"_s);
    if (rapidWindow) {
        if (!secIs(raw, u"OPT"_s) && !secIs(raw, u"BAG"_s)) throw tk::TrackerError(u"急跌保护只支持单腿期权与组合。"_s);
        if (!ports_.router() || !ports_.router()->hasOptionQuotes()) throw tk::TrackerError(u"这条券商通道取不到期权买卖报价,用不了急跌保护。"_s);
    }
    const bool hostAtBroker = js::truthy(autoClose.get(u"host_at_broker"_s));
    const OJson* tiers = targets.get(u"take_profit_tiers"_s);
    const bool hasTiers = js::isArr(tiers) && !tiers->items.isEmpty();
    if (hasTiers) {
        if (hostAtBroker) throw tk::TrackerError(an::kTiersHostedIssue);
        const auto issue = an::tiersIssue(tiers, tk::isLong(position), raw.get(u"market_price"_s));
        if (issue) throw tk::TrackerError(*issue);
    }
    const bool secTypeIsStk = secIs(raw, u"STK"_s);
    if (!js::nullish(targets.get(u"spot_stop_confirm_s"_s)) && !an::hasSpotStop(targets)) {
        // 正股的标的就是它自己:确认秒数管的是它的止损价 / 跟踪止损。托管的止损由券商触线即发,软件这边等多久都拦不住那张单,所以托管时不收
        if (!secTypeIsStk) throw tk::TrackerError(u"确认秒数是给标的止损价用的:先填「标的跌到」或「标的涨到」。"_s);
        if (js::nullish(targets.get(u"stop_loss"_s)) && js::nullish(targets.get(u"trail_pct"_s))) throw tk::TrackerError(u"正股的止损确认要先填止损价或跟踪止损。"_s);
        if (hostAtBroker) throw tk::TrackerError(u"托管到券商的止损由券商触线即发,确认秒数只在软件自己盯时有用:要用它就别托管。"_s);
    }
    checkExitTime(raw, rows, targets);
    if (js::truthy(autoClose.get(u"peak_confirm"_s)) && secTypeIsStk) {
        throw tk::TrackerError(u"「峰值要连续两秒确认」只给期权与组合用:正股的现价不是几条腿拼出来的。"_s);
    }
    if (js::str(autoClose.get(u"stop_basis"_s)) != u"natural") co_return;
    if (secTypeIsStk) throw tk::TrackerError(u"「止损按可成交价判」只给期权与组合用:正股的现价就是成交价。"_s);
    const auto router = ports_.router();
    if (!router || !router->hasOptionQuotes()) {
        throw tk::TrackerError(u"这条券商通道取不到各腿的买卖价,用不了「止损按可成交价判」:改回按中间价判。"_s);
    }
    const std::optional<double> natural = co_await ports_.engine().naturalCloseFor(raw, position, rows);
    const std::optional<double> stop = numField(targets, u"stop_loss"_s);
    if (natural && stop && (tk::isLong(position) ? *stop >= *natural : *stop <= *natural)) {
        throw tk::TrackerError(u"止损按可成交价判:止损价 "_s + hu::numText(*stop) + u' ' + (tk::isLong(position) ? u"不低于"_s : u"不高于"_s) + u"此刻立刻能成交的价 "_s
                               + hu::numText(*natural) + u"——建好就会触发。"_s
                               + u"把止损价放到可成交价的另一侧,或改回按中间价判。"_s);
    }
}

/**
 * 到点平仓的时刻要落在这份合约到期之前。钟点今天已经过了的,换算出来是明天的——当日到期的蝶 15:46 填 15:45、把下午三点四十五写成 3:45,
 * 存下来的都是一个永远到不了的时刻。认不出到期时刻的(正股、没带交易类的指数期权)不查。
 */
void TrackerHandlers::checkExitTime(const OJson& raw, const OJson& rows, const OJson& targets) {
    const std::optional<double> at = numField(targets, u"exit_at_ms"_s);
    if (!at || secIs(raw, u"STK"_s)) return;
    const OJson* first = &raw;
    if (secIs(raw, u"BAG"_s)) {
        const OJson* legs = raw.get(u"legs"_s);
        QString legKey;
        if (js::isArr(legs) && !legs->items.isEmpty() && !js::nullish(&legs->items.first())) legKey = js::str(&legs->items.first());
        first = rows.get(legKey);
    }
    static const OJson empty = js::object();
    const OJson* contract = first ? first->get(u"contract"_s) : nullptr;
    const OJson* c = js::nullish(contract) ? &empty : contract;
    const QString ymd = util::jsTrim(hu::strOr(c->get(u"lastTradeDateOrContractMonth"_s))).left(8);
    const bool early = settings().early_close_days.contains(ymd.left(4) + u'-' + ymd.mid(4, 2) + u'-' + ymd.mid(6, 2));
    const std::optional<double> expiry = an::expiryEpochMs(hu::strOr(raw.get(u"symbol"_s)), hu::strOr(c->get(u"lastTradeDateOrContractMonth"_s)),
                                                           hu::strOr(c->get(u"tradingClass"_s)), early);
    if (!expiry || *at < *expiry) return;
    throw tk::TrackerError(u"到点平仓「"_s + hu::strOr(targets.get(u"exit_at"_s)) + u"」下一次到点是美东 "_s + etWhen(*at) + u",而这份持仓 "_s + etWhen(*expiry)
                           + u" 就到期了——那时它已经不在了。"_s
                           + u"今天这个钟点已经过了的话,换算出来的是明天的;钟点按 24 小时写(下午三点四十五是 15:45)。"_s);
}

/// 峰值从哪个价起步:止损按可成交价判的期权 / 组合取此刻立刻能成交的价(拿不到是 null,盯盘头两轮自己立起来),别的取现价。
util::Task<OJson> TrackerHandlers::peakSeed(OJson raw, OJson rows, Position position, OJson autoClose) {
    const bool plain = js::str(autoClose.get(u"stop_basis"_s)) != u"natural" || secIs(raw, u"STK"_s) || !ports_.router();
    if (plain) co_return js::nullish(raw.get(u"market_price"_s)) ? js::Null() : *raw.get(u"market_price"_s);
    const std::optional<double> natural = co_await ports_.engine().naturalCloseFor(raw, position, rows);
    co_return js::NOrNull(natural);
}

/// 算预计价位要的三样行情:标的现价、持仓报价、各腿报价。拿不到就是 null,不编。
util::Task<TrackerHandlers::SpotInputs> TrackerHandlers::spotInputs(OJson raw, OJson rows, tk::TargetStructure structure) {
    const QString symbol = js::str(raw.get(u"symbol"_s));
    std::optional<double> spot = hu::optNumber(raw.get(u"market_price"_s));  // 正股自己就是标的
    const auto router = ports_.router();
    if (structure.kind != u"stock") {
        // 和盯盘同一个取法(engine.applySpotTarget):指数走 indexPrice,个股期权的标的走报价流(不认昨收)
        spot = !router ? std::nullopt : (co_await orchestrate::underlyingSpot(*router, symbol, settings().indexConfig(symbol) != nullptr)).spot;
    }
    std::optional<OJson> info;
    if (!(structure.kind == u"stock" || !router) && router->hasSpotInfo()) info = router->spotInfo(js::str(raw.get(u"symbol"_s)));
    // 夜盘推算失败时拿到的是昨收:当作没有现价,和盯盘那一路同一条规矩
    if (info && js::isStr(info->get(u"source"_s)) && info->get(u"source"_s)->s == u"index_stale") spot = std::nullopt;
    const domain::EtNow now = domain::nowEt();
    SpotInputs out;
    out.spot = spot;
    out.markPrice = hu::optNumber(raw.get(u"market_price"_s));
    // 各腿报价、IBKR 模型 IV、到期:和盯盘同一个函数拼,试算与实盘不分叉
    out.legInputs = an::legInputsOf(raw, rows, [](const an::PricedLeg& leg) { return tk::legPriceKey(leg.strike, leg.right); },
                                    [this](const QString& d) { return settings().early_close_days.contains(d); });
    out.minute = now.minutes;
    out.nowMs = now.epochMs;
    out.em = ports_.engine().sessionEmToday(now);
    out.spotNote = info ? hu::strOr(info->get(u"note"_s)) : QString();
    co_return out;
}

OJson TrackerHandlers::targetsInputOf(const OJson& params, const OJson& raw, const std::function<std::optional<double>()>& spotTarget) {
    OJson in = js::object();
    in.set(u"take_profit"_s, js::NOrNull(optFloat(params.get(u"take_profit"_s))));
    in.set(u"stop_loss"_s, js::NOrNull(optFloat(params.get(u"stop_loss"_s))));
    in.set(u"trail_pct"_s, js::NOrNull(optFloat(params.get(u"trail_pct"_s))));
    in.set(u"profit_drawdown_pct"_s, js::NOrNull(optFloat(params.get(u"profit_drawdown_pct"_s))));
    const OJson tiers = drawdownTiersOf(params, flyUnitCost(raw));
    for (const auto& [k, v] : tiers.fields) in.set(k, v);
    in.set(u"spot_target"_s, js::NOrNull(spotTarget()));
    in.set(u"spot_stop_below"_s, js::NOrNull(optFloat(params.get(u"spot_stop_below"_s))));
    in.set(u"spot_stop_above"_s, js::NOrNull(optFloat(params.get(u"spot_stop_above"_s))));
    const OJson exits = exitSettingsOf(params, domain::nowEt().epochMs);
    for (const auto& [k, v] : exits.fields) in.set(k, v);
    return in;
}

/// 新建一个追踪。方向填反了在这里就拒——等触发了才发现已经晚了。
util::Task<OJson> TrackerHandlers::trackerAdd(OJson params) {
    return locked<OJson>(ctx(), [this, params]() { return trackerAddLocked(params); });
}

util::Task<OJson> TrackerHandlers::trackerAddLocked(OJson params) {
    const QString key = hu::strOr(params.get(u"key"_s));
    const OJson rows = keyedRows(domain::withCombos(co_await livePositions()));
    const OJson* rawp = rows.get(key);
    if (!rawp) invalid(u"找不到这个持仓(可能刚刚被平掉了),请刷新持仓列表。"_s);
    const OJson raw = *rawp;
    const std::optional<double> flySpot = optFloat(params.get(u"spot_target"_s));

    const Position position = positionFromRaw(raw);
    OJson targets = tk::makeTargets(targetsInputOf(params, raw, [flySpot] { return flySpot; }));
    OJson autoIn = js::object();
    const OJson* requestedOrderType = params.get(u"order_type"_s);
    if (js::truthy(params.get(u"spot_stop_at_broker"_s)) && !js::nullish(requestedOrderType) &&
        js::str(requestedOrderType) != u"MKT" && js::str(requestedOrderType) != u"LMT")
        invalid(u"IBKR 标的条件平仓只支持 MKT 或 LMT。"_s);
    autoIn.set(u"enabled"_s, js::B(js::truthy(params.get(u"auto_close"_s)) || js::truthy(params.get(u"host_at_broker"_s))));
    autoIn.set(u"order_type"_s, js::S(js::isStr(params.get(u"order_type"_s)) && params.get(u"order_type"_s)->s == u"LMT" ? u"LMT"_s : u"MKT"_s));
    autoIn.set(u"slippage_pct"_s, js::N(hu::numOrDefault(params.get(u"slippage_pct"_s), 0.3)));
    autoIn.set(u"close_fraction_pct"_s, js::N(hu::numOrDefault(params.get(u"close_fraction_pct"_s), 100)));
    autoIn.set(u"host_at_broker"_s, js::B(js::truthy(params.get(u"host_at_broker"_s))));
    if (const OJson* v = params.get(u"spot_stop_at_broker"_s)) autoIn.set(u"spot_stop_at_broker"_s, *v);
    if (const auto limit = optFloat(params.get(u"spot_stop_limit"_s))) autoIn.set(u"spot_stop_limit"_s, js::N(*limit));
    // 追价让价上限:0 也是合法值(至少两跳),所以不能用 || 兜底
    if (const auto chase = optFloat(params.get(u"chase_max_pct"_s))) autoIn.set(u"chase_max_pct"_s, js::N(*chase));
    for (const auto& [k, v] : stopSettingsOf(params).fields) autoIn.set(k, v);
    const OJson autoClose = tk::makeAutoClose(autoIn);
    const bool hostAtBroker = js::truthy(autoClose.get(u"host_at_broker"_s));
    const bool autoEnabled = js::truthy(autoClose.get(u"enabled"_s));
    requireAutoCloseForHosting(hostAtBroker, autoEnabled);
    if (hostAtBroker) requireHostingSupported(js::str(raw.get(u"account"_s)));
    // 拼不出平仓单的结构(自定义组合、比例价差……)只能提醒。建的时候就说清楚
    if (autoEnabled || hostAtBroker) {
        const auto issue = tk::closeContractIssue(&raw);
        if (issue) invalid(*issue);
    }
    co_await checkTargets(raw, rows, position, targets, autoClose);

    OJson track;
    try {
        OJson add = js::object();
        for (const QString& k : {u"account"_s, u"symbol"_s, u"sec_type"_s})
            if (const OJson* v = raw.get(k)) add.set(k, *v);
        add.set(u"leg"_s, js::nullish(raw.get(u"leg"_s)) ? js::S(QString()) : *raw.get(u"leg"_s));
        if (const OJson* c = raw.get(u"contract"_s)) add.set(u"contract"_s, *c);
        add.set(u"targets"_s, targets);
        add.set(u"auto_close"_s, autoClose);
        // 峰值从哪个价起步跟着止损的口径走:按可成交价判的,拿中间价起步会一建好就读成回撤
        add.set(u"peak"_s, co_await peakSeed(raw, rows, position, autoClose));
        add.set(u"note"_s, js::S(hu::strOr(params.get(u"note"_s)).left(200)));
        track = ports_.engine().store().addTrack(add);
    } catch (...) {
        rethrowAsInvalid();
    }
    // account / sec_type 是绩效体检认"这笔股票建仓时计划的止损"用的:追踪行会被删,这条痕只增
    OJson detail = js::object();
    for (const QString& k : {u"symbol"_s, u"account"_s, u"sec_type"_s})
        if (const OJson* v = raw.get(k)) detail.set(k, *v);
    detail.set(u"targets"_s, targets);
    detail.set(u"auto_close"_s, autoClose);
    ports_.engine().store().audit(u"ui"_s, u"tracker_add"_s, &detail);
    // 追踪什么,就盯什么的价位:建不成只提醒,追踪照建
    const auto note = ports_.alerts().adoptForTrack(js::str(raw.get(u"symbol"_s)));
    if (note) ports_.engine().notifyWarning(*note);
    co_return js::object({{u"track"_s, track}});
}

util::Task<OJson> TrackerHandlers::trackerUpdate(OJson params, OJson raw) {
    return locked<OJson>(ctx(), [this, params, raw]() { return trackerUpdateLocked(params, raw); });
}

util::Task<OJson> TrackerHandlers::trackerUpdateLocked(OJson params, OJson rawParams) {
    const auto given = [&rawParams](const QString& k) { return rawParams.get(k) != nullptr; };  // "k" in params
    const QString trackId = hu::strOr(params.get(u"id"_s));
    const std::optional<OJson> trackOpt = ports_.engine().store().getTrack(trackId);
    if (!trackOpt) invalid(u"没有这个追踪"_s);
    const OJson track = *trackOpt;
    OJson fields = js::object();
    if (given(u"enabled"_s)) {
        const bool enabled = js::truthy(params.get(u"enabled"_s));
        fields.set(u"enabled"_s, js::B(enabled));
        // 重新启用等于"再给一次机会":把上一次触发的闩解开
        if (enabled) {
            fields.set(u"fired_at"_s, js::Null());
            fields.set(u"fired_state"_s, js::S(QString()));
            fields.set(u"fired_record"_s, js::S(QString()));
            static const OJson empty = js::object();
            const OJson* storedIn = track.get(u"targets"_s);
            const OJson stored = tk::makeTargets(js::nullish(storedIn) ? empty : *storedIn);
            OJson next = stored;
            bool replaced = false;
            // 分批止盈里"在等成交"的那一档:看它那张平仓单的下场。成交了 → 这一档做完;撤了 / 被拒 / 没发出去 → 解开,可以再触发;
            // 还没有终态 → 不许恢复
            const int waiting = an::pendingTier(stored.get(u"take_profit_tiers"_s));
            if (waiting >= 0) {
                const QString recordId = hu::strOr(track.get(u"fired_record"_s));
                std::optional<OJson> record;
                if (!recordId.isEmpty()) record = ports_.engine().store().getRecord(recordId);
                if (record && !js::truthy(record->get(u"final_status"_s))) {
                    invalid(u"分批止盈第 "_s + QString::number(waiting + 1) + u" 档的平仓单还没有终态,它可能还挂在券商那边。等它成交,或先在 TWS 里撤掉它,再点恢复——"_s
                            + u"现在恢复,它成交之后同一档会再平一次。"_s);
                }
                const OJson* tiers = stored.get(u"take_profit_tiers"_s);
                const OJson patch = (record && js::isStr(record->get(u"final_status"_s)) && record->get(u"final_status"_s)->s == u"filled")
                                        ? js::object({{u"done"_s, js::B(true)}})
                                        : js::object();
                next.set(u"take_profit_tiers"_s, an::markTier(js::nullish(tiers) ? js::array() : *tiers, waiting, patch));
                replaced = true;
            }
            // 到点平仓的时刻已经过了(触发过、或者过期作废了):换成下一次到这个钟点的时刻。不换的话,恢复的下一秒它又到点
            const double nowMs = domain::nowEt().epochMs;
            if (js::truthy(next.get(u"exit_at"_s)) && (js::nullish(next.get(u"exit_at_ms"_s)) || js::num(next.get(u"exit_at_ms"_s)) <= nowMs)) {
                next.set(u"exit_at_ms"_s, js::NOrNull(an::nextOccurrenceMs(next.get(u"exit_at"_s), nowMs)));
                replaced = true;
            }
            if (replaced) fields.set(u"targets"_s, next);
        }
    }
    if (given(u"auto_close"_s)) {
        // **合并**,不是整份替换:没带的键保持原样。
        OJson givenAuto = js::object();
        if (const OJson* a = params.get(u"auto_close"_s); js::isObj(a)) givenAuto = *a;
        stopSettingsOf(givenAuto);  // 范围不对当场拒;值照原样合并
        OJson merged = js::isObj(track.get(u"auto_close"_s)) ? *track.get(u"auto_close"_s) : js::object();
        for (const auto& [k, v] : givenAuto.fields) merged.set(k, v);
        // 这一次打开了托管、又没明说自动平仓:顺带打开
        if (js::truthy(givenAuto.get(u"host_at_broker"_s)) && !givenAuto.get(u"enabled"_s)) merged.set(u"enabled"_s, js::B(true));
        fields.set(u"auto_close"_s, merged);
        // 查的是合并之后的那一份:只关「到价自动平仓」、托管留着,和新建时两个一起填是同一件事
        const bool hosted = js::truthy(merged.get(u"host_at_broker"_s));
        const bool enabled = js::truthy(merged.get(u"enabled"_s));
        requireAutoCloseForHosting(hosted, enabled);
        if (hosted) requireHostingSupported(js::str(track.get(u"account"_s)));
        if (enabled || hosted) {
            const auto issue = tk::closeContractIssue(&track);
            if (issue) invalid(*issue);
        }
        // 只改自动平仓设置、不带目标的那种改法,下面那套目标校验不跑:托管与分批止盈不能并存这一条在这里补上
        static const OJson empty = js::object();
        const OJson* storedTargets = track.get(u"targets"_s);
        const OJson tiersNow = tk::makeTargets(js::nullish(storedTargets) ? empty : *storedTargets);
        const OJson* tiers = tiersNow.get(u"take_profit_tiers"_s);
        if (hosted && js::isArr(tiers) && !tiers->items.isEmpty()) invalid(an::kTiersHostedIssue);
    }
    static const OJson emptyObj = js::object();
    const OJson* trackAuto = track.get(u"auto_close"_s);
    const QString basisBefore = js::str(tk::makeAutoClose(js::nullish(trackAuto) ? emptyObj : *trackAuto).get(u"stop_basis"_s));
    const OJson* pendingAuto = fields.get(u"auto_close"_s);
    const OJson* autoSource = pendingAuto ? pendingAuto : (js::nullish(trackAuto) ? &emptyObj : trackAuto);
    const QString basisAfter = js::str(tk::makeAutoClose(*autoSource).get(u"stop_basis"_s));
    bool targetsGiven = false;
    for (const QString& k : {u"take_profit"_s, u"stop_loss"_s, u"trail_pct"_s, u"profit_drawdown_pct"_s, u"profit_drawdown_tiers"_s, u"profit_drawdown_preset"_s,
                             u"profit_drawdown_arm_pct"_s, u"spot_target"_s, u"spot_stop_below"_s, u"spot_stop_above"_s, u"spot_stop_confirm_s"_s, u"exit_at"_s,
                             u"take_profit_tiers"_s})
        if (given(k)) targetsGiven = true;
    const bool brokerSpotChanged = given(u"auto_close"_s) &&
        (js::truthy(js::prop(trackAuto, u"spot_stop_at_broker"_s)) || js::truthy(js::prop(autoSource, u"spot_stop_at_broker"_s)));
    const OJson* autoPatch = params.get(u"auto_close"_s);
    const bool rapidChanged = js::prop(autoPatch, u"rapid_exit_window_s"_s) || js::prop(autoPatch, u"rapid_exit_pct"_s);
    if (targetsGiven || basisBefore != basisAfter || brokerSpotChanged || rapidChanged) {
        // 改目标和新建走**同一套**校验:以前这里什么都不查,改一下目标价就能绕过「算出来的价比现价还差、挂上去立刻成交」那道拦。
        // 持仓先取:蝶式预设按每组成本把金额线换算成倍数
        const OJson rows = keyedRows(domain::withCombos(co_await livePositions()));
        const OJson* rawp = rows.get(tk::trackKey(track));
        if (!rawp) invalid(u"找不到这个持仓(可能已经平掉了),改不了目标。"_s);
        const OJson raw = *rawp;
        // 分批止盈有一档的平仓单在等成交时不改目标:改完那一档的记号就没了,单成交之后追踪接不上
        static const OJson empty = js::object();
        const OJson* targetsInDb = track.get(u"targets"_s);
        const OJson before = fields.get(u"targets"_s) ? *fields.get(u"targets"_s) : tk::makeTargets(js::nullish(targetsInDb) ? empty : *targetsInDb);
        if (targetsGiven && an::pendingTier(before.get(u"take_profit_tiers"_s)) >= 0) {
            invalid(u"分批止盈有一档的平仓单还在等成交,这时不能改目标:等它成交(追踪会自己接着盯),或先撤掉那张单、点恢复,再改。"_s);
        }
        // 只换了止损的口径(没带目标字段):目标照库里那份重新核对一遍,不清掉
        OJson targets = targetsGiven ? tk::makeTargets(targetsInputOf(params, raw, [&params] { return optFloat(params.get(u"spot_target"_s)); })) : before;
        // 档位没变的,做完的那几档照旧算做完(只改了止损价,不该让第一档回落之后再触发一次)
        if (targetsGiven) {
            const auto carried = an::carryTierMarks(targets.get(u"take_profit_tiers"_s), before.get(u"take_profit_tiers"_s));
            targets.set(u"take_profit_tiers"_s, carried ? *carried : js::Null());
        }
        const OJson* autoNow = fields.get(u"auto_close"_s);
        const OJson autoClose = tk::makeAutoClose(autoNow ? *autoNow : (js::nullish(trackAuto) ? emptyObj : *trackAuto));
        co_await checkTargets(raw, rows, positionFromRaw(raw), targets, autoClose);
        if (targetsGiven) fields.set(u"targets"_s, targets);
        // 换了口径:峰值按新口径从此刻起步——中间价记下的峰值拿可成交价去比,一换就是一次假回撤
        if (basisBefore != basisAfter) fields.set(u"peak"_s, co_await peakSeed(raw, rows, positionFromRaw(raw), autoClose));
    }
    if (fields.fields.isEmpty()) invalid(u"没有要改的字段"_s);
    ports_.engine().store().updateTrack(trackId, fields);
    OJson names = js::array();
    for (const auto& [k, v] : fields.fields) names.items.append(js::S(k));
    const OJson auditDetail = js::object({{u"id"_s, js::S(trackId)}, {u"fields"_s, names}});
    ports_.engine().store().audit(u"ui"_s, u"tracker_update"_s, &auditDetail);
    // 整段都在追踪锁里,tracker.delete 也走同一把锁,刚改过的行一定在;真读不回来就是库被别处动了,如实报
    const std::optional<OJson> updated = ports_.engine().store().getTrack(trackId);
    if (!updated) throw RpcError(-32000, u"追踪改完了,但库里读不回这一行"_s);
    co_return js::object({{u"track"_s, *updated}});
}

util::Task<OJson> TrackerHandlers::trackerDelete(OJson params) {
    return locked<OJson>(ctx(), [this, params]() -> Task<OJson> { return Task<OJson>::resolved(trackerDeleteLocked(params)); });
}

OJson TrackerHandlers::trackerDeleteLocked(const OJson& params) {
    domain::TradeStore& store = ports_.engine().store();
    if (!store.deleteTrack(hu::strOr(params.get(u"id"_s)))) invalid(u"没有这个追踪"_s);
    // 只因为追踪才盯着价位的标的,追踪没了盯单也没了(在股票池里的交给池子管)
    QSet<QString> symbols;
    for (const OJson& t : store.listTracks()) symbols.insert(js::str(t.get(u"symbol"_s)));
    ports_.alerts().releaseForTrack(symbols);
    return js::object({{u"deleted"_s, js::B(true)}});
}

/// 盯盘结果。节拍器在跑就读它最新一轮(即答);没在跑(没连券商)才就地算一次。
/// 触发 / 被拦由节拍器当场推送("tracker" 事件),这里的返回只给界面画行。
util::Task<OJson> TrackerHandlers::trackerPoll() {
    EnginePort& engine = ports_.engine();
    const OJson& loop = engine.trackerLoop();
    if (js::truthy(loop.get(u"running"_s)) && js::truthy(loop.get(u"poll"_s))) {
        // 节拍器在引擎里跑:回上一轮的行,**fired / blocked 清空**——那一轮已经发过通知了,界面再显示一次就是同一件事报两遍
        OJson out = *loop.get(u"poll"_s);
        out.set(u"fired"_s, js::array());
        out.set(u"blocked"_s, js::array());
        out.set(u"loop"_s, engine.trackerHeartbeat());
        co_return out;
    }
    OJson result = co_await locked<OJson>(ctx(), [&engine]() { return engine.pollTrackers(); });
    const auto count = [&result](const QString& k) {
        const OJson* v = result.get(k);
        return js::isArr(v) ? v->items.size() : qsizetype(0);
    };
    if (count(u"fired"_s) || count(u"blocked"_s)) emitEvent(u"tracker"_s, result);
    result.set(u"loop"_s, engine.trackerHeartbeat());
    co_return result;
}

/// host_at_broker 只有 IBKR 账户能开——富途没有可同形托管的 GTC+OCA。在设置那一刻就拒,而不是等对账循环静默跳过。
void TrackerHandlers::requireHostingSupported(const QString& alias) {
    const contract::AccountConfig* account = settings().accountByAlias(alias);
    const QString broker = account ? settings().accountBroker(*account) : u"ibkr"_s;
    if (broker != u"ibkr") throw RpcError(-32602, u"富途账户暂不支持把止盈/止损托管到券商服务器,请用软件盯盘(保持软件开启)。"_s);
}

/// 界面按秒驱动:把券商侧托管单和追踪设置对齐。动态目标(利润回撤)的停损价在这里按秒棘轮调整。
util::Task<OJson> TrackerHandlers::trackerReconcile() {
    EnginePort& engine = ports_.engine();
    const OJson& loop = engine.trackerLoop();
    if (js::truthy(loop.get(u"running"_s)) && js::truthy(loop.get(u"hosted"_s))) {
        OJson out = *loop.get(u"hosted"_s);
        out.set(u"loop"_s, engine.trackerHeartbeat());
        co_return out;
    }
    OJson result = co_await locked<OJson>(ctx(), [&engine]() { return engine.syncHosted(); });
    result.set(u"loop"_s, engine.trackerHeartbeat());
    co_return result;
}

/// 手动一键平仓:走和自动平仓完全相同的那条路——包括同样的闸门。
util::Task<OJson> TrackerHandlers::trackerCloseNow(OJson params) {
    return locked<OJson>(ctx(), [this, params]() { return trackerCloseNowLocked(params); });
}

util::Task<OJson> TrackerHandlers::trackerCloseNowLocked(OJson params) {
    const std::optional<OJson> trackOpt = ports_.engine().store().getTrack(hu::strOr(params.get(u"id"_s)));
    if (!trackOpt) invalid(u"没有这个追踪"_s);
    const OJson track = *trackOpt;
    const OJson rows = keyedRows(domain::withCombos(co_await livePositions()));
    const QString key = tk::trackKey(track);
    const OJson* rawp = rows.get(key);
    if (!rawp) invalid(u"这个持仓已经不在了。"_s);
    const OJson raw = *rawp;

    const Position position = positionFromRaw(raw);
    static const OJson empty = js::object();
    const OJson* trackAuto = track.get(u"auto_close"_s);
    OJson autoClose = tk::makeAutoClose(js::nullish(trackAuto) ? empty : *trackAuto);
    autoClose.set(u"enabled"_s, js::B(true));  // 手动平仓不看"自动平仓"那个开关,是你在点
    const bool hostAtBroker = js::truthy(autoClose.get(u"host_at_broker"_s));
    // 正挂着分批止盈某一档的平仓单:那张单只有这一档的数量,把它说成"已改成追价平仓"是骗人。不另发一张,照实说:等它成交再点一次
    const OJson* trackTargets = track.get(u"targets"_s);
    const int waiting = an::pendingTier(tk::makeTargets(js::nullish(trackTargets) ? empty : *trackTargets).get(u"take_profit_tiers"_s));
    if (waiting >= 0 && !hostAtBroker && tk::sweepReason(track)) {
        throw RpcError(-32019, u"分批止盈第 "_s + QString::number(waiting + 1) + u" 档的平仓单正在追价成交,它只平这一档的数量。等它成交(通常几秒)之后再点一次「立即平仓」平掉剩下的;"_s
                                   + u"等不及就先在 TWS 里撤掉那张单,再点。"_s);
    }
    // 按合约自己的时段判,和到价自动平仓同一口径
    const QString marketStatus = co_await ports_.engine().marketStatusFor(raw, domain::nowEt());
    const util::BreakerState breaker = ports_.engine().killswitch().state();
    tk::CloseGateArgs gate;
    gate.autoClose = &autoClose;
    gate.position = &position;
    gate.breakerEngaged = breaker.engaged;
    gate.marketStatus = marketStatus;
    gate.outsideRth = true;  // 手动平仓同样全时段:盘外自动转限价
    gate.alreadyFired = false;
    const QStringList blockers = tk::closeBlockers(gate);
    if (!blockers.isEmpty()) throw RpcError(-32019, u"不能平仓:"_s + blockers.join(u"、"_s));

    // 券商那边已经有这条追踪的路(托管单那一组、或正在追价的平仓单):改成追价平仓,不另发一张——两张各平一次就是反向开仓
    if (co_await ports_.engine().sweepExisting(track, u"手动平仓"_s)) {
        QString note = u"现有的单改到立刻成交的价追价"_s;
        if (hostAtBroker) {
            // 托管的:现在就对一轮账,把组里的止盈单改到 / 挂在立刻成交的价上,不等下一秒的节拍。挂不出去要当场说
            const OJson tick = co_await ports_.engine().syncHosted();
            const OJson* blocked = tick.get(u"blocked"_s);
            const OJson* stuck = nullptr;
            if (js::isArr(blocked))
                for (const OJson& b : blocked->items)
                    if (js::str(b.get(u"id"_s)) == js::str(track.get(u"id"_s))) {
                        stuck = &b;
                        break;
                    }
            note = stuck ? u"已改成追价平仓,但这一轮没挂出去:"_s + hu::joinJs(*stuck->get(u"blockers"_s), u"、"_s) + u"。之后每秒重试"_s
                         : u"在托管单那一组里改到立刻成交的价追价,一成交券商撤掉组里其余的单"_s;
        }
        co_return js::object({{u"fired"_s, js::object({{u"id"_s, js::S(js::str(track.get(u"id"_s)))},
                                                       {u"symbol"_s, js::S(js::str(track.get(u"symbol"_s)))},
                                                       {u"state"_s, js::S(tk::kStateManual)},
                                                       {u"reason"_s, js::S(u"手动平仓:"_s + note)}})}});
    }
    // 上一次自动平仓发出的单(正股限价、市价、没能追价的)还挂着:再发一张就是两张各平一次
    const std::optional<QString> pending = ports_.engine().pendingCloseRecord(track);
    if (pending) {
        throw RpcError(-32019, u"上一次发出的平仓单(记录 "_s + pending->left(8) + u")还挂在券商侧、没有终态。再发一张就是两张各平一次:等它成交,或先在 TWS 里撤掉它再点。"_s);
    }
    // 期权 / 组合的限价按各腿买卖价合成的立刻成交价算(拿不到才退回现价让滑点),和到价自动平仓同一口径
    const OJson* priceIn = raw.get(u"market_price"_s);
    std::optional<OJson> price = priceIn ? std::optional<OJson>(*priceIn) : std::nullopt;
    if (secIs(raw, u"BAG"_s) || secIs(raw, u"OPT"_s) || secIs(raw, u"FOP"_s)) {
        const std::optional<double> natural = co_await ports_.engine().naturalCloseFor(raw, position, rows);
        if (natural) price = js::N(*natural);
    }
    // 记成 manual:止损护栏数的是"接连止损",人点的平仓(赚着钱也可能点)不数进去(protections.ts)
    OJson result = js::object();
    result.set(u"state"_s, js::S(tk::kStateManual));
    if (price) result.set(u"price"_s, *price);
    result.set(u"reason"_s, js::S(u"手动平仓"_s));
    const std::optional<OJson> fired = co_await ports_.engine().closePosition(track, position, autoClose, result, marketStatus);
    if (!fired) throw RpcError(-32019, u"平仓单没有发出去,详见引擎日志与交易记录。"_s);
    co_return js::object({{u"fired"_s, *fired}});
}

util::Task<QList<OJson>> TrackerHandlers::livePositions() {
    const auto router = ports_.router();
    if (!router || !router->sessionCount()) throw needConnection(-32018, u"读取持仓"_s);
    try {
        co_return co_await router->positions();
    } catch (const execution::BrokerError& exc) {
        throw RpcError(-32018, exc.message());
    }
}

}  // namespace ibkr::rpc
