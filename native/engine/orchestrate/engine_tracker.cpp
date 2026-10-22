// engine.ts 的盯盘调度(节拍器、一轮盯盘)与持仓追踪:到价自动平仓、追价平仓、标的目标价换算。一行对一行搬,不改行为。
#include "analysis/fly_model.h"
#include "domain/models.h"
#include "domain/positions.h"
#include "orchestrate/closing.h"
#include "orchestrate/engine_impl.h"
#include "orchestrate/session_hours.h"
#include "orchestrate/spot_stop.h"
#include "util/jsformat.h"
#include "util/jsobj.h"
#include "util/py.h"

#include <cmath>

namespace ibkr::orchestrate {

using namespace Qt::StringLiterals;
namespace js = util::js;
namespace tk = tracker;
using util::OJson;
using util::Task;

namespace {

double jsRound(double x) { return std::floor(x + 0.5); }

bool isDerivative(const QString& secType) { return secType == u"BAG" || secType == u"OPT" || secType == u"FOP"; }

/// `x ?? null` 之后当 number | null 用
std::optional<double> numOrNull(const OJson* v) {
    if (js::nullish(v)) return std::nullopt;
    return js::num(v);
}

/// 持仓行里 makePosition 要的那十个键(缺了的不给,同 TS 的对象字面量里 undefined 的值)
Rec positionRaw(const Rec& raw) {
    Rec o = js::object();
    for (const QString& k : {u"account"_s, u"symbol"_s, u"sec_type"_s, u"quantity"_s, u"avg_cost"_s, u"multiplier"_s, u"currency"_s, u"market_price"_s, u"market_value"_s,
                             u"unrealized_pnl"_s}) {
        if (const OJson* v = js::prop(&raw, k)) o.set(k, *v);
    }
    return o;
}

/// 提交到一个并行列表里(row 的最终样子在一次迭代的任何出口都写回 out.rows 里它的位置)
struct Commit {
    Rec& dst;
    const Rec& src;
    ~Commit() { dst = src; }
};

}  // namespace

// ======================================================================
// 盯盘节拍器
// ======================================================================
void TradingEngine::scheduleTick(int delayMs, int intervalMs) {
    const qint64 id = ++nextTimerId_;
    liveTimers_.insert(id);
    tickTimer_ = id;
    setTimeout_(delayMs, [this, id, intervalMs, alive = std::weak_ptr<bool>(alive_)]() {
        const auto a = alive.lock();
        if (!a || !*a) return;
        if (!liveTimers_.remove(id)) return;  // clearTimeout 过了
        util::detach(tickLoop(intervalMs));
    });
}

Task<> TradingEngine::tickLoop(int intervalMs) {
    const double t0 = util::dateNow();
    co_await trackerTickOnce();
    if (!js::truthy(trackerLoop.get(u"running"_s))) co_return;
    // 下一轮在这一轮结束之后排:慢了就紧接着跑,不会叠两轮;快了就补足到一个节拍
    scheduleTick(static_cast<int>(std::max(0.0, intervalMs - (util::dateNow() - t0))), intervalMs);
}

void TradingEngine::startTrackerLoop(int intervalMs) {
    if (tickTimer_) return;
    loopMeter_.start();
    trackerLoop.set(u"running"_s, js::B(true));
    trackerLoop.set(u"interval_ms"_s, js::N(intervalMs));
    scheduleTick(0, intervalMs);
}

void TradingEngine::stopTrackerLoop() {
    trackerLoop.set(u"running"_s, js::B(false));
    if (tickTimer_) liveTimers_.remove(*tickTimer_);
    tickTimer_.reset();
    loopMeter_.stop();
    wakeGuard.pause();
}

Task<> TradingEngine::trackerTickOnce(std::optional<domain::EtNow> moment) {
    const double t0 = util::dateNow();
    const double mono = awakeClock();
    try {
        co_await withTrackerLock([this, t0, mono, moment]() { return tickBody(t0, mono, moment); });
    } catch (...) {
        trackerLoop.set(u"last_error"_s, js::S(jsx::errorMessage(std::current_exception()).left(200)));
        storePort_->audit(u"engine"_s, u"tracker_tick_failed"_s, js::object({{u"error"_s, js::copyOrNull(trackerLoop.get(u"last_error"_s))}}));
    }
    loopMeter_.record(trackerLoop, t0, kTrackerSlowMs);
}

Task<> TradingEngine::tickBody(double t0, double mono, std::optional<domain::EtNow> moment) {
    Rec& state = trackerLoop;
    // 执行对账与盯盘无关(没有追踪也要对),但同用一把锁:它会改 orderIndex 与终态
    if (router_ && reconcileDue(t0)) {
        std::optional<QString> failure;
        try {
            co_await reconcileOrders(t0);
        } catch (...) {
            failure = jsx::errorMessage(std::current_exception());
        }
        // 对账炸了不该带倒盯盘:留痕即可,下一轮还会再来
        if (failure) storePort_->audit(u"engine"_s, u"reconcile_failed"_s, js::object({{u"error"_s, js::S(failure->left(300))}}));
    }
    const QList<Rec> tracks = storePort_->listTracks();
    const QString hold = wakeTick(t0, mono, tracks);
    if (!router_ || tracks.isEmpty()) {
        state.set(u"poll"_s, js::object({{u"rows"_s, js::array()}, {u"fired"_s, js::array()}, {u"blocked"_s, js::array()}}));
        state.set(u"hosted"_s, js::object({{u"hosted"_s, js::array()}, {u"blocked"_s, js::array()}, {u"quote_maybe_delayed"_s, js::B(false)}}));
        state.set(u"last_error"_s, js::S(QString()));
        co_return;
    }
    QList<Rec> rows;
    std::optional<QString> readFailure;
    try {
        rows = co_await router_->positions();
    } catch (...) {
        readFailure = jsx::errorMessage(std::current_exception());
    }
    if (readFailure) {
        // 读不到持仓:这一轮不判断、不对账——当成空仓会停掉追踪、撤掉托管单
        state.set(u"last_error"_s, js::S(u"读不到持仓:"_s + readFailure->left(200)));
        co_return;
    }
    if (!hold.isEmpty()) {
        // 醒后这几秒的报价不可信:持仓照读(常驻行情流跟着续订),不判触发、不推峰值、不追价、不改托管单
        Rec held = js::array();
        for (const Rec& t : tracks) {
            Rec r = t;
            r.set(u"state"_s, js::S(tk::kStateHolding));
            r.set(u"reason"_s, js::S(hold));
            held.items.append(r);
        }
        state.set(u"poll"_s, js::object({{u"rows"_s, held}, {u"fired"_s, js::array()}, {u"blocked"_s, js::array()}}));
        state.set(u"last_error"_s, js::S(QString()));
        co_return;
    }
    const Rec poll = co_await pollTrackers(moment, rows);
    const Rec hosted = co_await syncHosted(rows);
    state.set(u"poll"_s, poll);
    state.set(u"hosted"_s, hosted);
    state.set(u"last_error"_s, js::S(QString()));
    if (onTrackerTick) {
        try {
            onTrackerTick(poll, hosted);
        } catch (...) {
            /* 推送失败不影响盯盘 */
        }
    }
}

QString TradingEngine::wakeTick(double wall, double mono, const QList<Rec>& tracks) {
    const wake::LiveTracks live = wake::liveTracksOf(tracks, [this](const QString& id) { return closeChase_.contains(id); });
    wake::WakeSample sample;
    sample.wall = wall;
    sample.mono = mono;
    sample.link = wake::linkOf(router_.get());
    sample.live = live;
    const wake::WakeStep step = wakeGuard.step(sample);
    wake::reportWake(step, *storePort_, *notifier_);
    trackerLoop.set(u"hold"_s, js::S(step.hold));
    trackerLoop.set(u"live_tracks"_s, js::N(live.total));
    return step.hold;
}

Rec TradingEngine::trackerHeartbeat() const { return heartbeatOf(trackerLoop); }

// ======================================================================
// 标的目标价 → 每轮重算的预计价位
// ======================================================================
Task<SpotTargetResult> TradingEngine::applySpotTarget(Rec track, Rec raw, tk::Position position, Rec targets, Rec positions, domain::EtNow at) {
    SpotTargetResult out;
    out.targets = targets;
    const auto target = js::finiteOrNull(targets.get(u"spot_target"_s));
    if (!target) co_return out;
    const QString secType = js::strOr(js::prop(&raw, u"sec_type"_s), u"STK"_s);
    const OJson* contract = js::prop(&raw, u"contract"_s);
    const auto structure = tk::structureOf(secType, contract);
    if (!structure) co_return out;

    std::optional<double> spot = numOrNull(js::prop(&raw, u"market_price"_s));  // 正股自己就是标的
    if (structure->kind != u"stock") {
        // 指数走 indexPrice(夜盘要期货推算);个股期权的标的走报价流,只认成交价、不认昨收。行情失败不炸掉这一轮,下面会退到上一轮的价
        const QString sym = js::str(js::prop(&raw, u"symbol"_s));
        spot = (co_await underlyingSpot(*router_, sym, settings.indexConfig(sym) != nullptr)).spot;
    }
    // 各腿报价、IBKR 模型 IV、到期,与试算同一个函数拼
    const Rec legs = analysis::legInputsOf(
        raw, positions, [](const analysis::PricedLeg& l) { return tk::legPriceKey(l.strike, l.right); },
        [this](const QString& d) { return settings.early_close_days.contains(d); });

    std::optional<OJson> info;
    if (structure->kind != u"stock" && router_->hasSpotInfo()) info = router_->spotInfo(js::str(js::prop(&raw, u"symbol"_s)));
    const QString spotNote = info ? js::strOr(js::prop(&*info, u"note"_s), QString()) : QString();
    // 夜盘推算失败时 indexPrice 退回的是**昨收**:它不会动,拿它反解 σ 算出来的价全是错的。当作"没有现价"
    if (info && js::str(js::prop(&*info, u"source"_s)) == u"index_stale" && js::isStr(js::prop(&*info, u"source"_s))) spot = std::nullopt;
    tk::SpotTargetArgs args;
    args.spotTarget = *target;
    args.spot = spot;
    args.markPrice = numOrNull(js::prop(&raw, u"market_price"_s));
    args.minute = at.minutes;
    args.em = sessionEm.today(at);
    args.legPrices = legs.get(u"legPrices"_s);
    args.spotNote = spotNote;
    args.legIvs = legs.get(u"legIvs"_s);
    args.expiryMs = numOrNull(legs.get(u"expiryMs"_s));
    args.nowMs = at.epochMs;
    Rec st = tk::spotTarget(*structure, position, args);
    const QString tid = js::str(js::prop(&track, u"id"_s));
    const auto last = flyMark_.contains(tid) ? std::optional<double>(flyMark_.value(tid)) : std::nullopt;
    // 只有市场价算出来的数能拿去挂单或改单。clock 档是写死的 EM 算的模型默认值,拿它每秒推一张真单等于按一个假数把止盈位往上抬
    static const QStringList marketSources{u"none"_s, u"ibkr"_s, u"smile"_s, u"net"_s, u"leg"_s};
    const OJson* price = js::prop(&st, u"price"_s);
    const QString sigmaSource = js::str(js::prop(&st, u"sigma_source"_s));
    if (price && price->type != OJson::Null && marketSources.contains(sigmaSource)) {
        flyMark_.insert(tid, price->n);
        Rec t = targets;
        t.set(u"take_profit"_s, *price);
        out.targets = t;
        out.spotTarget = st;
        out.hold = false;
        co_return out;
    }
    if (last) {
        if (!js::truthy(js::prop(&st, u"reason"_s)))
            st.set(u"reason"_s, js::S(u"这一轮没有市场价("_s + (sigmaSource == u"clock" ? u"只有模型默认波动率"_s : u"算不出"_s) + u"),停在最后一次市场价算出的 "_s +
                                      util::jsNumberToString(*last)));
        Rec t = targets;
        t.set(u"take_profit"_s, js::N(*last));
        out.targets = t;
        out.spotTarget = st;
        out.hold = false;
        co_return out;
    }
    // 从来没拿到过市场价:只守不挂。不挂新单,也不撤已经挂着的(重启后认领回来的那张)
    st.set(u"held"_s, js::B(true));
    if (!js::truthy(js::prop(&st, u"reason"_s))) st.set(u"reason"_s, js::S(u"还没拿到市场报价,先不挂单;行情一来就按市场价挂"_s));
    out.targets = targets;
    out.spotTarget = st;
    out.hold = true;
    co_return out;
}

// ======================================================================
// 持仓追踪:到价自动平仓
// ======================================================================
Task<Rec> TradingEngine::pollTrackers(std::optional<domain::EtNow> moment, std::optional<QList<Rec>> rows) {
    const domain::EtNow at = moment ? *moment : domain::nowEt();
    Rec out = js::object({{u"rows"_s, js::array()}, {u"fired"_s, js::array()}, {u"blocked"_s, js::array()}});
    const QList<Rec> tracks = storePort_->listTracks();
    if (tracks.isEmpty() || !router_) co_return out;
    Rec* outRows = out.get(u"rows"_s);
    Rec* outFired = out.get(u"fired"_s);
    Rec* outBlocked = out.get(u"blocked"_s);

    Rec positions = js::object();
    std::optional<QString> posFailure;
    try {
        // 调度器一轮只读一次持仓,判触发和托管对账用同一份(见 trackerTickOnce)
        QList<Rec> source;
        if (rows) source = *rows;
        else source = co_await router_->positions();
        for (const Rec& p : domain::withCombos(source)) positions.set(js::str(js::prop(&p, u"key"_s)), p);
    } catch (...) {
        posFailure = jsx::errorMessage(std::current_exception());
    }
    if (posFailure) {
        // 读不到持仓不该炸掉轮询
        storePort_->audit(u"engine"_s, u"positions_failed"_s, js::object({{u"error"_s, js::S(posFailure->left(300))}}));
        co_return out;
    }

    if (!closeChaseAdopted_) co_await adoptCloseChase(tracks);
    exits_->nextRound();
    const util::BreakerState breaker = breakerPort_->state();
    const std::optional<QSet<QString>> covered = router_->coveredAccounts();
    for (const Rec& track : tracks) {
        const QString key = tk::trackKey(track);
        OJson* rawp = positions.get(key);
        std::optional<QString> unreachable;
        if (!rawp) unreachable = tk::unreachableReason(covered, js::prop(&track, u"account"_s));
        if (unreachable) {
            Rec r = track;
            r.set(u"state"_s, js::S(tk::kStateHolding));
            r.set(u"reason"_s, js::S(*unreachable));
            outRows->items.append(r);
            continue;
        }
        if (!rawp) {
            // 仓位已经不在了。停掉追踪但不删——用户要能看见"它为什么不再盯了"。
            if (js::truthy(js::prop(&track, u"enabled"_s))) {
                storePort_->updateTrack(js::str(js::prop(&track, u"id"_s)), js::object({{u"enabled"_s, js::B(false)}}));
                notifier_->warning(js::str(js::prop(&track, u"symbol"_s)) + u" 的持仓已不存在,追踪自动停止。"_s);
            }
            Rec r = track;
            r.set(u"state"_s, js::S(u"closed"_s));
            r.set(u"reason"_s, js::S(u"持仓已不存在"_s));
            outRows->items.append(r);
            continue;
        }
        const QString tid = js::str(js::prop(&track, u"id"_s));
        const QString symbol = js::str(js::prop(&track, u"symbol"_s));

        // 持仓行里的现价来自 TWS 的 portfolio 推送,盘前/盘后仍可能是空的——退到报价流再要一次(只认成交价,不认昨收);期权腿拿不到就照实说"本轮不判断"
        if (js::nullish(js::prop(rawp, u"market_price"_s)) && js::isStr(js::prop(rawp, u"sec_type"_s)) && js::prop(rawp, u"sec_type"_s)->s == u"STK") {
            const auto fallback = co_await stockSpot(*router_, js::str(js::prop(rawp, u"symbol"_s)));
            if (fallback) jsx::assign(*positions.get(key), js::object({{u"market_price"_s, js::N(*fallback)}, {u"price_source"_s, js::S(u"quote"_s)}}));
        }
        const Rec raw = *positions.get(key);

        const tk::Position position = tk::makePosition(positionRaw(raw));
        // 标的目标价换算成这一轮的止盈价(每轮重算,见 applySpotTarget)
        const OJson* tgtRaw = js::prop(&track, u"targets"_s);
        const SpotTargetResult spotRes = co_await applySpotTarget(track, raw, position, tk::makeTargets(js::nullish(tgtRaw) ? js::object() : *tgtRaw), positions, at);
        const Rec targets = spotRes.targets;
        const std::optional<Rec> spotTargetRow = spotRes.spotTarget;
        // 标的止损价只看标的现价;设了确认秒数的,越线之后待够了才算
        const QString rawSymbol = js::str(js::prop(&raw, u"symbol"_s));
        const std::optional<Rec> stopRaw = co_await spotStopFor(*router_, rawSymbol, targets, spotTargetRow, settings.indexConfig(rawSymbol) != nullptr);
        const std::optional<Rec> spotStopRow = exits_->confirmSpot(tid, targets, stopRaw, at.epochMs);
        const OJson* autoRaw = js::prop(&track, u"auto_close"_s);
        const Rec auto_ = tk::makeAutoClose(js::nullish(autoRaw) ? js::object() : *autoRaw);
        const QString secType = js::str(js::prop(&raw, u"sec_type"_s));
        const bool derivative = isDerivative(secType);
        // 止损类按可成交价判的(stop_basis = natural):这一轮的立刻成交价现取;拿不到(null)这一轮止损类不判
        std::optional<std::optional<double>> natural;
        if (derivative && js::str(js::prop(&auto_, u"stop_basis"_s)) == u"natural") natural = co_await naturalCloseFor(raw, position, positions);
        // 价格触发 → 标的触发 → 分批止盈 → 到点平仓
        TrackExits::JudgeArgs ja;
        ja.track = track;
        ja.position = position;
        ja.targets = targets;
        ja.autoClose = auto_;
        ja.price = numOrNull(js::prop(&raw, u"market_price"_s));
        ja.natural = natural;
        ja.at = at;
        ja.spotTarget = spotTargetRow;
        ja.spotStop = spotStopRow;
        const Rec result = exits_->judge(ja);

        // 峰值只在变了的时候写
        const OJson* peak = js::prop(&result, u"peak"_s);
        if (peak && peak->type != OJson::Null && !js::strictEqual(peak, js::prop(&track, u"peak"_s))) storePort_->updateTrack(tid, js::object({{u"peak"_s, *peak}}));

        // raw 来自券商适配层;到了这里它就是界面读的那一行
        Rec row = track;
        jsx::assign(row, result);
        row.set(u"position"_s, raw);
        if (spotTargetRow) row.set(u"spot_target"_s, *spotTargetRow);
        if (spotStopRow) row.set(u"spot_stop"_s, *spotStopRow);
        outRows->items.append(row);
        Rec& rowSlot = outRows->items.last();
        const Commit commit{rowSlot, row};

        const QString resultState = js::str(js::prop(&result, u"state"_s));
        const QString resultReason = js::str(js::prop(&result, u"reason"_s));

        // 没开托管、平仓单已经发出去的:每轮按最新买卖价追那张单,直到成交(或持仓没了)。追踪本身已经落闩、停用,不看 enabled
        if (closeChase_.contains(tid)) {
            const std::optional<Rec> info = co_await chaseCloseOrder(track, raw, position, positions, auto_);
            row.set(u"sweeping"_s, js::B(true));
            if (info) {
                row.set(u"chase"_s, *info);
            } else {
                outBlocked->items.append(js::object({{u"id"_s, js::copyOrNull(js::prop(&track, u"id"_s))},
                                                      {u"symbol"_s, js::copyOrNull(js::prop(&track, u"symbol"_s))},
                                                      {u"blockers"_s, js::array({js::S(u"正在追价平仓,但这一轮拿不到腿的买卖价,没改价"_s)})}}));
            }
            continue;
        }

        // 分批止盈的一档成交了:划掉这一档、解开闩,下一轮起接着盯剩下的仓
        if (exits_->rearmTier(track, position)) continue;
        if (!js::truthy(js::prop(&track, u"enabled"_s)) || resultState == tk::kStateHolding) continue;

        if (js::truthy(js::prop(&auto_, u"host_at_broker"_s)) && router_->supportsHostedClose()) {
            // 执行归券商托管单(engine/hosted.ts 的 onTriggered + syncHosted)。这里若再另发一张平仓单,就是托管单 + 软件单各平一次——双重平仓等于反向开仓
            HostedOrders::TriggeredArgs ta;
            ta.track = track;
            ta.raw = raw;
            ta.position = position;
            ta.state = resultState;
            ta.reason = resultReason;
            ta.spotReached = spotTargetRow && js::truthy(js::prop(&*spotTargetRow, u"reached"_s));
            ta.spotStop = spotStopRow && js::truthy(js::prop(&*spotStopRow, u"hit"_s));
            hostedOrders_->onTriggered(ta, row, out);
            continue;
        }
        // 追踪止盈全时段有效:盘前/盘后照样平,只有休市才真的发不出去。期权/组合按**合约自己的**时段判
        const QString marketStatus = co_await marketStatusFor(raw, at);
        tk::CloseGateArgs gate;
        gate.autoClose = &auto_;
        gate.position = &position;
        gate.accountIsPaper = accountIsPaper(js::str(js::prop(&track, u"account"_s)));
        gate.autoExecute = settings.policies.auto_execute;
        gate.allowLiveTrading = settings.policies.allow_live_trading;
        // 自动熔断(连续失败)不挡止损类平仓:那是在减仓。手动熔断照旧一律不发
        gate.breakerEngaged = breaker.engaged && !breaker.autoEngaged;
        gate.marketStatus = marketStatus;
        gate.outsideRth = true;
        gate.alreadyFired = js::truthy(js::prop(&track, u"fired_at"_s));
        const QStringList blockers = tk::closeBlockers(gate);
        if (!blockers.isEmpty()) {
            // 到价了但发不出去,必须当场说。只提醒一次,不刷屏。
            if (!js::truthy(js::prop(&track, u"fired_state"_s))) storePort_->updateTrack(tid, js::object({{u"fired_state"_s, js::S(u"blocked"_s)}}));
            if (exits_->warnBlocked(track, resultState)) notifier_->warning(symbol + u" "_s + resultReason + u",但没有平仓:"_s + blockers.join(u"、"_s));
            row.set(u"blocked"_s, js::strings(blockers));
            outBlocked->items.append(js::object({{u"id"_s, js::copyOrNull(js::prop(&track, u"id"_s))},
                                                  {u"symbol"_s, js::copyOrNull(js::prop(&track, u"symbol"_s))},
                                                  {u"reason"_s, js::copyOrNull(js::prop(&result, u"reason"_s))},
                                                  {u"blockers"_s, js::strings(blockers)}}));
            continue;
        }

        // 组合与期权的平仓单挂在各腿买卖价算出的立刻成交价上;拿不到才退回"现价让一点滑点"
        Rec closeResult = result;
        if (derivative) {
            std::optional<double> quote;
            if (natural && *natural) quote = **natural;
            else quote = co_await naturalCloseFor(raw, position, positions);
            if (quote) closeResult.set(u"price"_s, js::N(*quote));
        }
        // 分批止盈:这一档先记成在等成交,平的比例换成这一档的(不是分批的触发,auto 原样)
        const Rec tierAuto = exits_->tierAuto(track, targets, result, auto_, position);
        const std::optional<Rec> fired = co_await closePosition(track, position, tierAuto, closeResult, marketStatus);
        if (fired) outFired->items.append(*fired);
        else exits_->tierNotSent(track);
    }
    co_return out;
}

Rec TradingEngine::closeChaseSnapshot() const {
    QStringList keys = closeChase_.keys();
    keys.sort();
    Rec o = js::object();
    for (const QString& k : keys) o.set(k, *closeChase_.value(k));
    return o;
}

Rec TradingEngine::flyMarkSnapshot() const {
    QStringList keys = flyMark_.keys();
    keys.sort();
    Rec o = js::object();
    for (const QString& k : keys) o.set(k, js::N(flyMark_.value(k)));
    return o;
}

bool TradingEngine::accountIsPaper(const QString& alias) {
    const contract::AccountConfig* account = settings.accountByAlias(alias);
    return account ? account->is_paper : true;
}

Task<QString> TradingEngine::marketStatusFor(Rec raw, domain::EtNow at) { return orchestrate::marketStatusFor(*impl_->hoursHost, std::move(raw), at); }

Task<std::optional<double>> TradingEngine::naturalCloseFor(Rec raw, tk::Position position, Rec positions) {
    if (!router_ || !router_->hasOptionQuotes()) co_return std::nullopt;
    const auto structure = tk::structureOf(js::strOr(js::prop(&raw, u"sec_type"_s), u"STK"_s), js::prop(&raw, u"contract"_s));
    if (!structure || structure->kind == u"stock") co_return std::nullopt;
    QList<Rec> legRows;
    if (structure->kind == u"combo") {
        const OJson* legs = js::prop(&raw, u"legs"_s);
        if (js::isArr(legs)) {
            for (const OJson& k : legs->items) {
                if (const OJson* r = positions.get(js::str(&k))) legRows << *r;
            }
        }
    } else {
        legRows << raw;
    }
    Rec quotes;
    std::optional<QString> failure;
    try {
        quotes = co_await router_->optionQuotes(legRows);
    } catch (...) {
        failure = QString();
    }
    if (failure) co_return std::nullopt;
    Rec book = js::object();
    for (const Rec& row : legRows) {
        const OJson* c = js::prop(&row, u"contract"_s);
        const auto strike = js::finiteOrNull(js::prop(c, u"strike"_s));
        const QString right = js::strOr(js::prop(c, u"right"_s), QString()).left(1).toUpper();
        if (!strike || right.isEmpty()) continue;
        const OJson* q = js::prop(&quotes, js::str(js::prop(&row, u"key"_s)));
        book.set(tk::legPriceKey(*strike, right), q ? *q : js::object({{u"bid"_s, js::Null()}, {u"ask"_s, js::Null()}}));
    }
    co_return tk::naturalClosePrice(position, *structure, book);
}

// ------------------------------------------------------------------ 平仓
std::optional<Rec> TradingEngine::closeUnbuildable(const Rec& track, const QString& message) {
    const OJson* firedState = js::prop(&track, u"fired_state"_s);
    if (!(js::isStr(firedState) && firedState->s == u"blocked")) {
        storePort_->updateTrack(js::str(js::prop(&track, u"id"_s)), js::object({{u"fired_state"_s, js::S(u"blocked"_s)}}));
        notifier_->rejection(u"TRACKER_ERROR"_s, js::str(js::prop(&track, u"symbol"_s)) + u" "_s + message + u"请手动平仓。"_s);
    }
    return std::nullopt;
}

Task<std::optional<Rec>> TradingEngine::closePosition(Rec track, tk::Position position, Rec autoClose, Rec result, std::optional<QString> marketStatus) {
    Rec payload;
    std::optional<QString> buildFailure;
    try {
        payload = tk::buildCloseOrder(position, autoClose, numOrNull(js::prop(&result, u"price"_s)), js::str(js::prop(&result, u"state"_s)),
                                      js::nullish(js::prop(&track, u"contract"_s)) ? js::object() : *js::prop(&track, u"contract"_s),
                                      marketStatus ? *marketStatus : settings.marketStatus(domain::nowEt()));
    } catch (...) {
        buildFailure = jsx::errorMessage(std::current_exception());
    }
    if (buildFailure) co_return closeUnbuildable(track, u"平仓单构造失败:"_s + *buildFailure);
    Rec parsed;
    try {
        const Rec wrapper = js::object({{u"orders"_s, js::array({payload})}, {u"rejections"_s, js::array()}});
        parsed = domain::models::parseLlmPayload(&wrapper);
    } catch (...) {
        buildFailure = jsx::errorMessage(std::current_exception());
    }
    if (buildFailure) co_return closeUnbuildable(track, u"平仓单构造失败:"_s + *buildFailure);
    const OJson* parsedOrders = js::prop(&parsed, u"orders"_s);
    if (!parsedOrders || parsedOrders->items.isEmpty()) co_return closeUnbuildable(track, u"平仓单没有通过 schema 校验,已放弃。"_s);

    const contract::AccountConfig* accountPtr = settings.accountByAlias(js::str(js::prop(&track, u"account"_s)));
    if (!accountPtr) {
        notifier_->rejection(u"TRACKER_ERROR"_s, u"账户别名 "_s + js::str(js::prop(&track, u"account"_s)) + u" 已不存在。"_s);
        co_return std::nullopt;
    }
    const contract::AccountConfig account = *accountPtr;

    const Rec order = parsedOrders->items.first();
    parsing::validator::ApprovedOrder approved;
    approved.order = order;
    approved.account = account;
    const double mult = position.multiplier;
    approved.notional = std::abs(position.quantity) * (position.market_price ? *position.market_price : 0) * ((mult == 0 || std::isnan(mult)) ? 1.0 : mult);
    approved.signature = u"tracker:"_s + js::str(js::prop(&track, u"id"_s));
    approved.warnings = QStringList{u"由持仓追踪自动发出,未经模型解析"_s};
    const QString tid = js::str(js::prop(&track, u"id"_s));
    Rec record = baseRecord(js::str(js::prop(&payload, u"intent_summary"_s)), u"tracker"_s, nullptr);
    record.set(u"account"_s, js::object({{u"alias"_s, js::S(account.alias)}, {u"account_id"_s, js::S(account.account_id)}, {u"is_paper"_s, js::B(account.is_paper)}}));
    record.set(u"contract"_s, js::copyOrNull(js::prop(&order, u"contract"_s)));
    record.set(u"order"_s, js::copyOrNull(js::prop(&order, u"order"_s)));
    record.set(u"execution_type"_s, js::S(u"IMMEDIATE"_s));
    record.set(u"notional_estimate"_s, js::N(approved.notional));
    const QString recordId = storePort_->createRecord(record);
    storePort_->appendEvent(recordId, u"warning"_s, js::object({{u"message"_s, js::copyOrNull(js::prop(&result, u"reason"_s))}}));

    // 先落闩
    storePort_->updateTrack(tid, js::object({{u"fired_at"_s, js::S(nowIsoSecondsEt())},
                                             {u"fired_state"_s, js::copyOrNull(js::prop(&result, u"state"_s))},
                                             {u"fired_record"_s, js::S(recordId)},
                                             {u"enabled"_s, js::B(false)}}));
    execution::PlacementResult placement;
    std::optional<QString> placeFailure;
    try {
        storePort_->markSubmitIntent(recordId);
        placement = co_await router_->place(recordId, approved, std::nullopt);
    } catch (...) {
        placeFailure = jsx::errorMessage(std::current_exception());
    }
    if (placeFailure) {
        const QString detail = u"自动平仓下单失败:"_s + *placeFailure + u"。请立刻手动核对持仓。"_s;
        storePort_->setFinalStatus(recordId, u"ibkr_error"_s, detail);
        const auto engaged = breakerPort_->recordFailure(*placeFailure, u"broker"_s);
        notifier_->rejection(brokerCode(), detail);
        if (engaged) notifier_->breaker(engaged->reason);
        co_return std::nullopt;
    }

    indexPlacement(recordId, placement);
    const auto idOrNull = [](const std::optional<int>& v) { return v ? js::N(*v) : js::Null(); };
    storePort_->appendEvent(recordId, u"status"_s, js::object({{u"status"_s, js::S(placement.status)}, {u"order_id"_s, idOrNull(placement.order_id)}}));
    // 平仓留一条只增的痕:保护规则按它数"最近几次止损"、算同一只标的的冷却期。mark 是触发那一刻的持仓现价
    const OJson* legV = js::prop(&track, u"leg"_s);
    storePort_->audit(u"engine"_s, u"auto_close"_s,
                      js::object({{u"track"_s, js::copyOrNull(js::prop(&track, u"id"_s))},
                                  {u"symbol"_s, js::copyOrNull(js::prop(&track, u"symbol"_s))},
                                  {u"leg"_s, js::nullish(legV) ? js::S(QString()) : *legV},
                                  {u"state"_s, js::copyOrNull(js::prop(&result, u"state"_s))},
                                  {u"record"_s, js::S(recordId)},
                                  {u"mark"_s, js::NOrNull(position.market_price)}}));
    breakerPort_->recordSuccess(u"broker"_s);
    // 期权 / 组合的限价平仓单发出去只是开始:挂在自然价上未必立刻成交,之后每轮按最新买卖价追那张单(chaseCloseOrder)。正股与市价单不追
    const QString secType = js::str(js::prop(js::prop(&order, u"contract"_s), u"secType"_s));
    const OJson* orderSpec = js::prop(&order, u"order"_s);
    const bool chase = placement.order_id && *placement.order_id != 0 && js::str(js::prop(orderSpec, u"orderType"_s)) == u"LMT" && isDerivative(secType) &&
                       router_->hasModifyHosted();
    if (chase) {
        const int orderId = *placement.order_id;
        const OJson* actionV = js::prop(orderSpec, u"action"_s);
        const OJson* intent = js::prop(&payload, u"intent_summary"_s);
        auto entry = std::make_shared<Rec>(js::object({{u"order_id"_s, js::N(orderId)},
                                                       {u"record_id"_s, js::S(recordId)},
                                                       {u"action"_s, js::copyOrNull(actionV)},
                                                       {u"quantity"_s, js::N(js::num(js::prop(orderSpec, u"totalQuantity"_s)))},
                                                       {u"label"_s, js::S(js::nullish(intent) ? u"平仓"_s : js::str(intent))},
                                                       // 发单这一轮算第 0 轮(和托管单第一次挂出同义),下一轮盯盘从第 1 轮接着数
                                                       {u"rounds"_s, js::N(1)},
                                                       {u"limit"_s, js::NOrNull(js::finiteOrNull(js::prop(orderSpec, u"lmtPrice"_s)))},
                                                       {u"natural"_s, js::Null()},
                                                       {u"floor"_s, js::Null()},
                                                       {u"warned"_s, js::B(false)}}));
        closeChase_.insert(tid, entry);
        closeChaseIndex.insert(orderId, tid);
        storePort_->updateTrack(tid, js::object({{u"fired_state"_s, js::S(tk::kSweepPrefix + js::str(js::prop(&result, u"state"_s)))}}));
    }
    notifier_->notify(u"自动平仓已发出"_s,
                      js::str(js::prop(&track, u"symbol"_s)) + u":"_s + js::str(js::prop(&result, u"reason"_s)) + (chase ? u"。限价挂在立刻成交的价上,没成交每秒再追"_s : QString()),
                      domain::redactAccount(account.account_id));
    co_return js::object({{u"id"_s, js::copyOrNull(js::prop(&track, u"id"_s))},
                          {u"symbol"_s, js::copyOrNull(js::prop(&track, u"symbol"_s))},
                          {u"state"_s, js::copyOrNull(js::prop(&result, u"state"_s))},
                          {u"record_id"_s, js::S(recordId)},
                          {u"reason"_s, js::copyOrNull(js::prop(&result, u"reason"_s))},
                          {u"order_id"_s, idOrNull(placement.order_id)}});
}

// ------------------------------------------------------------------ 追价平仓
Task<std::optional<ChaseQuote>> TradingEngine::chaseQuote(Rec raw, tk::Position position, Rec positions, Rec autoClose, std::optional<double> prev, double rounds,
                                                         std::optional<QString> reason) {
    std::optional<double> natural;
    if (js::strOr(js::prop(&raw, u"sec_type"_s), QString()) == u"STK") {
        // 正股没有腿的买卖价可合成:"立刻成交价"取现价朝成交方向让 slippage_pct(和市价平仓转限价同一口径)
        std::optional<double> price = position.market_price;
        if (!price && router_) price = co_await stockSpot(*router_, js::strOr(js::prop(&raw, u"symbol"_s), QString()));
        natural = tk::closeLimitPrice(position, price, js::prop(&autoClose, u"slippage_pct"_s));
    } else {
        natural = co_await naturalCloseFor(raw, position, positions);
    }
    if (!natural) co_return std::nullopt;
    const OJson reasonJson = reason ? js::S(*reason) : js::Null();
    const OJson* reasonPtr = reason ? &reasonJson : nullptr;
    ChaseQuote q;
    q.natural = *natural;
    // 触发原因决定追价节奏:止损类可以另填一套(trackerExits.chaseProfile)
    q.limit = tk::chaseLimit(position, *natural, prev, rounds, autoClose, reasonPtr);
    q.floor = tk::chaseFloor(position, *natural, autoClose, reasonPtr);
    co_return q;
}

void TradingEngine::chaseWarnIfStuck(const Rec& track, Rec& entry, double limit, double natural) {
    if (js::truthy(entry.get(u"warned"_s)) || jsx::numOr(entry.get(u"rounds"_s), 0) < tk::kChaseWarnRounds) return;
    entry.set(u"warned"_s, js::B(true));
    notifier_->warning(js::str(js::prop(&track, u"symbol"_s)) + u" 追价平仓 "_s + js::str(entry.get(u"rounds"_s)) + u" 秒仍未成交:挂 "_s + util::pyG(limit) + u",此刻自然价 "_s +
                       util::pyG(natural) + u"。请留意持仓,必要时手动处理。"_s);
}

Task<std::optional<Rec>> TradingEngine::chaseCloseOrder(Rec track, Rec raw, tk::Position position, Rec positions, Rec autoClose) {
    const QString tid = js::str(js::prop(&track, u"id"_s));
    const auto it = closeChase_.constFind(tid);
    if (it == closeChase_.constEnd()) co_return std::nullopt;
    const std::shared_ptr<Rec> entry = it.value();
    const std::optional<QString> sweep = tk::sweepReason(track);
    const std::optional<ChaseQuote> q = co_await chaseQuote(raw, position, positions, autoClose, numOrNull(entry->get(u"limit"_s)), jsx::numOr(entry->get(u"rounds"_s), 0), sweep);
    if (!q) co_return std::nullopt;
    entry->set(u"natural"_s, js::N(q->natural));
    entry->set(u"floor"_s, js::N(q->floor));
    const std::optional<double> prev = js::finiteOrNull(entry->get(u"limit"_s));
    if (!prev || jsRound(*prev * 100) != jsRound(q->limit * 100)) {
        const OJson* actionV = entry->get(u"action"_s);
        Rec item = js::object({{u"kind"_s, js::S(u"close"_s)},
                               {u"action"_s, js::S(js::nullish(actionV) ? tk::closeSide(position) : js::str(actionV))},
                               {u"order_type"_s, js::S(u"LMT"_s)},
                               {u"quantity"_s, js::N(js::num(entry->get(u"quantity"_s)))},
                               {u"lmt_price"_s, js::N(q->limit)},
                               {u"aux_price"_s, js::Null()},
                               {u"trailing_percent"_s, js::Null()},
                               {u"trail_stop_seed"_s, js::Null()},
                               {u"label"_s, js::S(js::str(entry->get(u"label"_s)))}});
        bool ok = false;
        // 改价被拒时原单还按这个价挂着(closeChaseModifyRejected 恢复它)
        entry->set(u"accepted_limit"_s, js::NOrNull(prev));
        const qint64 orderId = static_cast<qint64>(js::num(entry->get(u"order_id"_s)));
        sentOrders.insert(orderId, SentOrder{util::dateNow(), SentOrder::Kind::Modify});
        std::optional<QString> failure;
        bool linkDown = false;
        try {
            ok = co_await router_->modifyHosted(orderId, item);
        } catch (const execution::LinkDownError& exc) {
            linkDown = true;
            failure = exc.message();
        } catch (...) {
            failure = jsx::errorMessage(std::current_exception());
        }
        if (failure) {
            storePort_->audit(u"engine"_s, u"close_chase_failed"_s, js::object({{u"track"_s, js::S(tid)}, {u"error"_s, js::S(failure->left(300))}}));
            if (!linkDown) breakerPort_->recordFailure(*failure, u"broker"_s);  // 链路断了不是券商拒单,不记熔断(ibLink.LinkDownError)
            co_return js::object({{u"rounds"_s, js::copyOrNull(entry->get(u"rounds"_s))},
                                  {u"limit"_s, js::NOrNull(prev)},
                                  {u"natural"_s, js::N(q->natural)},
                                  {u"floor"_s, js::N(q->floor)}});
        }
        if (!ok) {
            // 券商侧已经不认识这张单(成交 / 撤销的回报还在路上):不再追,回报到了自然落闩
            dropCloseChase(tid);
            co_return std::nullopt;
        }
        entry->set(u"limit"_s, js::N(q->limit));
        storePort_->appendEvent(js::str(entry->get(u"record_id"_s)), u"status"_s,
                                js::object({{u"status"_s, js::S(u"Adjusted"_s)}, {u"lmt_price"_s, js::N(q->limit)}, {u"quantity"_s, *item.get(u"quantity"_s)}}));
    }
    entry->set(u"rounds"_s, js::N(jsx::numOr(entry->get(u"rounds"_s), 0) + 1));
    chaseWarnIfStuck(track, *entry, q->limit, q->natural);
    co_return js::object({{u"rounds"_s, js::copyOrNull(entry->get(u"rounds"_s))},
                          {u"limit"_s, js::copyOrNull(entry->get(u"limit"_s))},
                          {u"natural"_s, js::N(q->natural)},
                          {u"floor"_s, js::N(q->floor)}});
}

void TradingEngine::closeChaseModifyRejected(qint64 orderId) {
    const auto t = closeChaseIndex.constFind(orderId);
    if (t == closeChaseIndex.constEnd()) return;
    const auto e = closeChase_.constFind(t.value());
    if (e == closeChase_.constEnd()) return;
    if (const OJson* accepted = (*e)->get(u"accepted_limit"_s)) (*e)->set(u"limit"_s, *accepted);
}

void TradingEngine::dropCloseChase(const QString& tid) {
    const auto it = closeChase_.constFind(tid);
    if (it == closeChase_.constEnd()) return;
    closeChaseIndex.remove(static_cast<qint64>(js::num((*it)->get(u"order_id"_s))));
    closeChase_.remove(tid);
}

// 重启后认领还挂在券商侧的平仓单(orderRef = 记录 id),接着追。只做一次;认领不到就算了
Task<> TradingEngine::adoptCloseChase(QList<Rec> tracks) {
    closeChaseAdopted_ = true;
    if (!router_ || !router_->hasListHostedOpen()) co_return;
    for (const Rec& track : tracks) {
        const QString tid = js::str(js::prop(&track, u"id"_s));
        const QString recordId = js::strOr(js::prop(&track, u"fired_record"_s), QString());
        if (!tk::sweepReason(track) || recordId.isEmpty() || closeChase_.contains(tid)) continue;
        const OJson* autoRaw = js::prop(&track, u"auto_close"_s);
        const Rec autoCfg = tk::makeAutoClose(js::nullish(autoRaw) ? js::object() : *autoRaw);
        if (js::truthy(js::prop(&autoCfg, u"host_at_broker"_s))) continue;  // 托管的由 adoptHosted 认领
        QList<Rec> rows;
        bool failed = false;
        try {
            rows = co_await router_->listHostedOpenWith(recordId);
        } catch (...) {
            failed = true;
        }
        if (failed) continue;
        const Rec* found = nullptr;
        for (const Rec& r : rows) {
            if (js::strOr(js::prop(&r, u"order_ref"_s), QString()) == recordId && js::truthy(js::prop(&r, u"order_id"_s))) {
                found = &r;
                break;
            }
        }
        if (!found) continue;
        const Rec& row = *found;
        const qint64 orderId = static_cast<qint64>(js::num(js::prop(&row, u"order_id"_s)));
        // 方向不取券商回的 action:BAG 一律以 BUY 提交,真实方向是"平掉这份持仓的那一侧",改单签净价要用它——追价那一轮按持仓现算
        closeChase_.insert(tid, std::make_shared<Rec>(js::object({{u"order_id"_s, js::N(double(orderId))},
                                                                  {u"record_id"_s, js::S(recordId)},
                                                                  {u"action"_s, js::Null()},
                                                                  {u"quantity"_s, js::N(js::num(js::prop(&row, u"quantity"_s)))},
                                                                  {u"label"_s, js::S(js::str(js::prop(&track, u"symbol"_s)) + u" 平仓(重启认领)"_s)},
                                                                  {u"rounds"_s, js::N(0)},
                                                                  {u"limit"_s, js::NOrNull(js::finiteOrNull(js::prop(&row, u"lmt_price"_s)))},
                                                                  {u"natural"_s, js::Null()},
                                                                  {u"floor"_s, js::Null()},
                                                                  {u"warned"_s, js::B(false)}})));
        closeChaseIndex.insert(orderId, tid);
        orderIndex.insert(orderId, recordId);
        if (js::truthy(js::prop(&row, u"perm_id"_s))) orderIndex.insert(static_cast<qint64>(js::num(js::prop(&row, u"perm_id"_s))), recordId);
        storePort_->audit(u"engine"_s, u"close_chase_adopted"_s, js::object({{u"track"_s, js::S(tid)}, {u"order_id"_s, js::N(double(orderId))}}));
    }
}

// 追价平仓单的终态:成交 → 落闩记真正的触发原因;撤销 / 失效 → 摘掉并提醒(持仓还在)
void TradingEngine::closeChaseOnStatus(const Rec& trade) {
    const double orderIdD = jsx::numOr(js::prop(js::prop(&trade, u"order"_s), u"orderId"_s), 0);
    const qint64 orderId = static_cast<qint64>(orderIdD);
    if (orderIdD == 0 || std::isnan(orderIdD)) return;
    const auto it = closeChaseIndex.constFind(orderId);
    if (it == closeChaseIndex.constEnd()) return;
    const QString tid = it.value();
    const QString status = js::strOr(js::prop(js::prop(&trade, u"orderStatus"_s), u"status"_s), QString());
    const std::optional<Rec> track = storePort_->getTrack(tid);
    const std::optional<QString> reason = track ? tk::sweepReason(*track) : std::nullopt;
    const QString sym = track && !js::nullish(js::prop(&*track, u"symbol"_s)) ? js::str(js::prop(&*track, u"symbol"_s)) : u"?"_s;
    if (status == u"Filled") {
        dropCloseChase(tid);
        if (reason) storePort_->updateTrack(tid, js::object({{u"fired_state"_s, js::S(*reason)}}));
        const auto label = HostedOrders::stateLabel(reason ? *reason : QString());
        notifier_->notify(u"追价平仓已成交"_s, sym + u":"_s + (label ? *label : (reason ? *reason : QString())));
    } else if (status == u"Cancelled" || status == u"ApiCancelled" || status == u"Inactive") {
        dropCloseChase(tid);
        if (reason) storePort_->updateTrack(tid, js::object({{u"fired_state"_s, js::S(*reason)}}));
        notifier_->warning(sym + u" 的追价平仓单已"_s + (status == u"Inactive" ? u"失效"_s : u"撤销"_s) + u",持仓可能还在,请手动核对。"_s);
    }
}

Task<bool> TradingEngine::sweepExisting(Rec track, QString reason) {
    const QString tid = js::str(js::prop(&track, u"id"_s));
    if (closeChase_.contains(tid)) co_return true;
    const OJson* autoRaw = js::prop(&track, u"auto_close"_s);
    const Rec auto_ = tk::makeAutoClose(js::nullish(autoRaw) ? js::object() : *autoRaw);
    if (!js::truthy(js::prop(&auto_, u"host_at_broker"_s)) || !router_ || !router_->supportsHostedClose()) co_return false;
    if (!tk::sweepReason(track)) {
        storePort_->updateTrack(tid, js::object({{u"fired_at"_s, js::S(nowIsoSecondsEt())}, {u"fired_state"_s, js::S(tk::kSweepPrefix + tk::kStateManual)}}));
        const OJson* legV = js::prop(&track, u"leg"_s);
        storePort_->audit(u"engine"_s, u"hosted_sweep"_s,
                          js::object({{u"track"_s, js::S(tid)},
                                      {u"symbol"_s, js::copyOrNull(js::prop(&track, u"symbol"_s))},
                                      {u"leg"_s, js::nullish(legV) ? js::S(QString()) : *legV},
                                      {u"state"_s, js::S(tk::kStateManual)},
                                      {u"reason"_s, js::S(reason)}}));
        notifier_->notify(u"追价平仓"_s, js::str(js::prop(&track, u"symbol"_s)) + u":"_s + reason + u"。在托管单那一组里改到立刻成交的价,没成交就每秒再追"_s);
    }
    // 人点了平仓:上一次被拒留下的退避不再等
    hostedOrders_->clearBackoff(tid);
    co_return true;
}

std::optional<QString> TradingEngine::pendingCloseRecord(const Rec& track) {
    const QString recordId = js::strOr(js::prop(&track, u"fired_record"_s), QString());
    if (recordId.isEmpty() || finalized.contains(recordId)) return std::nullopt;
    bool indexed = false;
    for (auto it = orderIndex.constBegin(); it != orderIndex.constEnd(); ++it)
        if (it.value() == recordId) {
            indexed = true;
            break;
        }
    if (!indexed) return std::nullopt;
    const std::optional<Rec> record = storePort_->getRecord(recordId);
    if (!record) return std::nullopt;
    const OJson* channel = js::prop(js::prop(&*record, u"input"_s), u"input_channel"_s);
    if (!(js::isStr(channel) && channel->s == u"tracker")) return std::nullopt;
    return js::truthy(js::prop(&*record, u"final_status"_s)) ? std::nullopt : std::optional<QString>(recordId);
}

}  // namespace ibkr::orchestrate
