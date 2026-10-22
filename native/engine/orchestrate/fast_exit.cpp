#include "orchestrate/fast_exit.h"

#include "domain/positions.h"
#include "orchestrate/engine_router.h"
#include "util/js_runtime.h"
#include "util/jsobj.h"

#include <QSet>
#include <QTimer>

#include <cmath>

namespace ibkr::orchestrate {

using namespace Qt::StringLiterals;
namespace js = util::js;
namespace tk = tracker;
using util::OJson;

namespace {

/// 观察只留这么久(毫秒)。只是存储的上限,不进定价:追价间隔最长 1 秒,窗口用不到这么长
constexpr double kObsKeepMs = 5000;

bool isDerivative(const QString& secType) { return secType == u"BAG" || secType == u"OPT" || secType == u"FOP"; }

/// 持仓行里 makePosition 要的那十个键
OJson positionRaw(const OJson& raw) {
    OJson o = js::object();
    for (const QString& k : {u"account"_s, u"symbol"_s, u"sec_type"_s, u"quantity"_s, u"avg_cost"_s, u"multiplier"_s, u"currency"_s, u"market_price"_s, u"market_value"_s,
                             u"unrealized_pnl"_s}) {
        if (const OJson* v = js::prop(&raw, k)) o.set(k, *v);
    }
    return o;
}

}  // namespace

void FastExit::attach() {
    EngineRouter* router = router_();
    if (router == attachedTo_) return;
    if (detach_) detach_();
    detach_ = {};
    attachedTo_ = router;
    if (!router) return;
    std::weak_ptr<bool> alive = alive_;
    detach_ = router->onOptionTick([this, alive]() {
        if (alive.expired()) return;
        onTick();
    });
}

void FastExit::stop() {
    if (detach_) detach_();
    detach_ = {};
    attachedTo_ = nullptr;
    watches_.clear();
}

void FastExit::arm(const QList<Rec>& rows, const Rec& positions, const std::function<std::optional<double>(const QString&)>& tp, const domain::EtNow& at,
                   const std::function<bool(const QString&)>& chasing) {
    QList<Watch> next;
    QSet<QString> live;
    for (const Rec& row : rows) {
        const OJson* raw = js::prop(&row, u"position"_s);
        if (js::nullish(raw)) continue;
        const QString secType = js::strOr(js::prop(raw, u"sec_type"_s), QString());
        if (!isDerivative(secType)) continue;
        const OJson* autoRaw = js::prop(&row, u"auto_close"_s);
        const Rec autoClose = tk::makeAutoClose(js::nullish(autoRaw) ? js::object() : *autoRaw);
        const QString tid = js::str(js::prop(&row, u"id"_s));
        // 正在追价:这一轮刚发出的没托管平仓单(行里还是触发前的样子,问引擎);托管单那一组看行里的 sweep: 标记——
        // 这一轮刚改成追价的托管追踪下一拍(≤ 1 秒)才排进来。这里不读库:盯盘一轮里多读一次库,和 TS 版的调用次序就对不上了
        const bool sweeping = chasing(tid) || tk::sweepReason(row).has_value();
        const bool armed = !sweeping && js::truthy(js::prop(&row, u"enabled"_s)) && !js::truthy(js::prop(&row, u"fired_at"_s)) &&
                           js::truthy(js::prop(&autoClose, u"enabled"_s)) && js::strOr(js::prop(&row, u"state"_s), QString()) == tk::kStateHolding;
        if (!sweeping && !armed) continue;
        const auto structure = tk::structureOf(secType, js::prop(raw, u"contract"_s));
        if (!structure || structure->kind == u"stock") continue;
        QList<Rec> legRows;
        if (secType == u"BAG") {
            const OJson* legs = js::prop(raw, u"legs"_s);
            if (js::isArr(legs)) {
                for (const OJson& k : legs->items) {
                    if (const OJson* r = js::prop(&positions, js::str(&k))) legRows << *r;
                }
            }
        } else {
            legRows << *raw;
        }
        if (legRows.isEmpty()) continue;
        const OJson* tgtRaw = js::prop(&row, u"targets"_s);
        Rec targets = tk::makeTargets(js::nullish(tgtRaw) ? js::object() : *tgtRaw);
        // 标的目标价的追踪:止盈价是这一轮按标的现算的(只认市场价算出的那个);算不出就只盯止损类
        if (!js::nullish(js::prop(&targets, u"spot_target"_s))) {
            const auto price = tp(tid);
            targets.set(u"take_profit"_s, price ? js::N(*price) : js::Null());
        }
        Watch w;
        w.tid = tid;
        w.key = js::str(js::prop(raw, u"key"_s));
        w.legRows = legRows;
        w.position = tk::makePosition(positionRaw(*raw));
        w.structure = *structure;
        w.targets = targets;
        w.autoClose = autoClose;
        w.peak = js::finiteOrNull(js::prop(&row, u"peak"_s));
        w.minute = at.minutes;
        w.chasing = sweeping;
        w.roundAt = util::dateNow();
        w.roundNatural = js::finiteOrNull(js::prop(js::prop(&row, u"chase"_s), u"natural"_s));
        live.insert(w.key);
        next << w;
    }
    watches_ = next;
    for (auto it = obs_.begin(); it != obs_.end();) it = live.contains(it.key()) ? std::next(it) : obs_.erase(it);
}

void FastExit::onTick() {
    // 同一批推送并成一次(下一圈事件循环),不在行情回调里同步算
    if (queued_ || watches_.isEmpty()) return;
    queued_ = true;
    std::weak_ptr<bool> alive = alive_;
    QTimer::singleShot(0, [this, alive]() {
        if (alive.expired()) return;
        queued_ = false;
        check(util::dateNow());
    });
}

void FastExit::check(double nowMs) {
    EngineRouter* router = router_();
    if (!router || !router->hasOptionQuotesNow()) return;
    bool wake = false;
    for (Watch& w : watches_) {
        if (w.woke) continue;
        Rec book;
        try {
            book = router->optionQuotesNow(w.legRows);
        } catch (...) {
            continue;
        }
        const std::optional<double> natural = tk::naturalClosePrice(w.position, w.structure, legBook(w, book));
        if (natural) observe(w.key, *natural, nowMs);
        if (w.chasing) {
            // 追价:价动了、离上一轮够一个改价间隔,就不等下一拍去改那张单
            if (natural && natural != w.roundNatural && nowMs - w.roundAt >= analysis::chaseIntervalMs(w.autoClose)) w.woke = true;
        } else {
            const std::optional<double> mid = midOf(w, book);
            if (!mid) continue;
            // 和盯盘同一个判定;峰值不在这里推(peakPrice: null)——推峰值只在节拍那一轮,两轮确认的口径才不被打乱
            tk::EvaluateOpts opts;
            opts.hasPeakPrice = true;
            opts.peakPrice = std::nullopt;
            if (js::str(js::prop(&w.autoClose, u"stop_basis"_s)) == u"natural") {
                opts.hasStopPrice = true;
                opts.stopPrice = natural ? natural : mid;
            }
            tk::Position p = w.position;
            p.market_price = mid;
            const OJson verdict = analysis::withTier(tk::evaluate(p, w.targets, mid, w.peak, w.minute, opts), w.targets, tk::isLong(w.position));
            if (js::str(js::prop(&verdict, u"state"_s)) != tk::kStateHolding) w.woke = true;
        }
        if (w.woke) wake = true;
    }
    if (wake && wake_) wake_();
}

FastExit::Rec FastExit::legBook(const Watch& w, const Rec& book) const {
    Rec out = js::object();
    for (const Rec& row : w.legRows) {
        const OJson* c = js::prop(&row, u"contract"_s);
        const auto strike = js::finiteOrNull(js::prop(c, u"strike"_s));
        const QString right = js::strOr(js::prop(c, u"right"_s), QString()).left(1).toUpper();
        if (!strike || right.isEmpty()) continue;
        const OJson* q = js::prop(&book, js::str(js::prop(&row, u"key"_s)));
        out.set(tk::legPriceKey(*strike, right), q ? *q : js::object({{u"bid"_s, js::Null()}, {u"ask"_s, js::Null()}}));
    }
    return out;
}

std::optional<double> FastExit::midOf(const Watch& w, const Rec& book) const {
    // 和持仓那一行同一个算法:腿取买卖中间价(买价为 0 照算),组合按 withCombos 合成。缺一条腿给空
    QList<Rec> legs;
    for (const Rec& row : w.legRows) {
        const OJson* q = js::prop(&book, js::str(js::prop(&row, u"key"_s)));
        const auto bid = js::finiteOrNull(js::prop(q, u"bid"_s)), ask = js::finiteOrNull(js::prop(q, u"ask"_s));
        Rec leg = row;
        leg.set(u"market_price"_s, bid && ask && *ask >= *bid ? js::N(std::round(((*bid + *ask) / 2) * 1e4) / 1e4) : js::Null());
        legs << leg;
    }
    if (w.structure.kind == u"option") return legs.isEmpty() ? std::nullopt : js::finiteOrNull(js::prop(&legs.first(), u"market_price"_s));
    for (const Rec& r : domain::withCombos(legs)) {
        if (js::str(js::prop(&r, u"key"_s)) == w.key) return js::finiteOrNull(js::prop(&r, u"market_price"_s));
    }
    return std::nullopt;
}

void FastExit::observe(const QString& key, double natural, double nowMs) {
    QList<analysis::NaturalObs>& list = obs_[key];
    if (list.isEmpty() || list.last().natural != natural) list.append({nowMs, natural});
    while (list.size() > 2 && list[0].atMs < nowMs - kObsKeepMs && list[1].atMs < nowMs - kObsKeepMs) list.removeFirst();
}

double FastExit::leadFor(const Rec& raw, const tk::Position& position, double natural, const Rec& autoClose, double nowMs) {
    const QString key = js::strOr(js::prop(&raw, u"key"_s), QString());
    observe(key, natural, nowMs);
    const double mult = js::finiteOrNull(js::prop(&autoClose, u"chase_lead"_s)).value_or(analysis::chaseLeadDefault());
    return analysis::momentumLead(obs_.value(key), tk::isLong(position), analysis::chaseIntervalMs(autoClose), mult, nowMs);
}

}  // namespace ibkr::orchestrate
