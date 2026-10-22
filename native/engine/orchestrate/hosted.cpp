#include "orchestrate/hosted.h"

#include "domain/models.h"
#include "domain/positions.h"
#include "execution/broker_pricing.h"
#include "execution/ib_link_down.h"
#include "orchestrate/clock.h"
#include "util/jsformat.h"
#include "util/jsobj.h"
#include "util/market_js.h"
#include "util/zod.h"

#include <algorithm>
#include <cmath>
#include <vector>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;
namespace tk = ibkr::orchestrate::tracker;

namespace ibkr::orchestrate {

namespace {

QString n(double v) { return util::jsNumberToString(v); }

/// 对象字面量里 `k: expr`,expr 是 undefined 时这一键不出现(JSON.stringify 会丢掉它)
void putDefined(OJson& obj, const QString& key, const OJson* v) {
    if (v) obj.set(key, *v);
}

/// 触发状态 → 哪几种托管单在券商侧负责它。组合只托管止盈单,止损类在券商侧本来就没有单
QStringList coveringKinds(const QString& state) {
    if (state == tk::kStateTakeProfit) return {tk::kHostedKindTp};
    if (state == tk::kStateStopLoss) return {tk::kHostedKindSl, tk::kHostedKindTrail};
    if (state == tk::kStateProfitTrail) return {tk::kHostedKindPtrail};
    return {};
}

/// 托管单成交 → 追踪落闩时,kind 映射回软件盯盘同一套触发状态
std::optional<QString> hostedFiredState(const QString& kind) {
    if (kind == u"tp") return u"take_profit"_s;
    if (kind == u"sl" || kind == u"trail") return u"stop_loss"_s;
    if (kind == u"ptrail") return u"profit_trail"_s;
    return std::nullopt;
}

QString labelOf(const QString& kind) {
    const QString l = tk::hostedLabel(kind);
    return l.isEmpty() ? kind : l;
}

bool truthyId(const std::optional<int>& v) { return v && *v != 0; }

}  // namespace

std::optional<QString> HostedOrders::stateLabel(const QString& state) {
    if (state == u"take_profit") return u"止盈"_s;
    if (state == u"stop_loss") return u"止损"_s;
    if (state == u"profit_trail") return u"利润回撤"_s;
    if (state == u"manual") return u"手动平仓"_s;
    if (state == u"time_exit") return u"到点平仓"_s;
    return std::nullopt;
}

HostedOrders::EntryPtr HostedOrders::entryOf(const QString& tid, const QString& kind) const {
    const KindMapPtr* km = hosted_.find(tid);
    if (!km) return nullptr;
    const EntryPtr* e = (*km)->entries.find(kind);
    return e ? *e : nullptr;
}

std::shared_ptr<Rec> HostedOrders::tpEntry(const QString& trackId) const { return entryOf(trackId, tk::kHostedKindTp); }

bool HostedOrders::handleError(qint64 orderId, int code, const QString& message) {
    if (!hostedIndex_.contains(orderId)) return false;
    onError(orderId, code, message);
    return true;
}

QSet<QString> HostedOrders::liveKinds(const QString& trackId) const {
    QSet<QString> out;
    if (const KindMapPtr* km = hosted_.find(trackId)) {
        for (const QString& k : (*km)->entries.keys()) out.insert(k);
    }
    return out;
}

void HostedOrders::clearBackoff(const QString& trackId) {
    for (const QString& key : QList<QString>(hostedRetryAt_.keys())) {
        if (key.startsWith(trackId + u"|"_s)) hostedRetryAt_.remove(key);
    }
}

void HostedOrders::clear() {
    hosted_ = contract::OrderedMap<KindMapPtr>();
    hostedIndex_.clear();
    synced_.clear();
}

Rec HostedOrders::hostedRows(const QString& tid) const {
    Rec rows = js::array();
    const KindMapPtr* km = hosted_.find(tid);
    if (!km) return rows;
    for (const QString& kind : (*km)->entries.keys()) {
        const Rec& v = **(*km)->entries.find(kind);
        Rec row = js::object();
        putDefined(row, u"kind"_s, js::prop(&v, u"kind"_s));
        putDefined(row, u"label"_s, js::prop(&v, u"label"_s));
        putDefined(row, u"quantity"_s, js::prop(&v, u"quantity"_s));
        row.set(u"lmt_price"_s, js::nullish(js::prop(&v, u"lmt_price"_s)) ? js::Null() : *js::prop(&v, u"lmt_price"_s));
        row.set(u"aux_price"_s, js::nullish(js::prop(&v, u"aux_price"_s)) ? js::Null() : *js::prop(&v, u"aux_price"_s));
        row.set(u"trailing_percent"_s, js::nullish(js::prop(&v, u"trailing_percent"_s)) ? js::Null() : *js::prop(&v, u"trailing_percent"_s));
        row.set(u"order_id"_s, js::nullish(js::prop(&v, u"order_id"_s)) ? js::Null() : *js::prop(&v, u"order_id"_s));
        rows.items.append(row);
    }
    return rows;
}

bool HostedOrders::stillHosting(const QString& tid) {
    const std::optional<Rec> fresh = host_.store().getTrack(tid);
    if (!fresh) return false;
    return !js::truthy(js::prop(&*fresh, u"fired_at"_s)) || tk::sweepReason(*fresh).has_value();
}

// ---- 券商托管的止盈/止损:对账循环 -----------------------------------
util::Task<Rec> HostedOrders::syncHosted(std::optional<QList<Rec>> rows) {
    Rec out = js::object({{u"hosted"_s, js::array()}, {u"blocked"_s, js::array()}, {u"quote_maybe_delayed"_s, js::B(false)}});
    const auto pushTo = [&out](const QString& key, const Rec& item) { js::propMut(&out, key)->items.append(item); };
    HostedRouter* router = host_.router();
    if (!router || !router->supportsHostedClose()) co_return out;
    const QList<Rec> tracks = host_.store().listTracks();
    bool wantsHosting = false;
    for (const Rec& t : tracks) {
        if (js::truthy(js::path(&t, {u"auto_close"_s, u"host_at_broker"_s}))) {
            wantsHosting = true;
            break;
        }
    }
    if (!wantsHosting && hosted_.isEmpty()) co_return out;
    // 单独跑的对账(不是盯盘那一轮带着持仓叫的)自己算一轮;同一轮里问到的是盯盘算好的那个价
    if (!rows) host_.exits().nextRound();
    const std::optional<QSet<QString>> covered = router->coveredAccounts();
    const std::optional<QSet<QString>> prev = lastCovered_;
    if (covered && prev) {
        for (const QString& a : *covered) {
            if (!prev->contains(a)) {
                hostedAdopted_ = false;
                break;
            }
        }
    }
    lastCovered_ = covered;
    if (!hostedAdopted_) co_await adoptHosted();
    if (!hostedAdopted_) {
        // 券商侧已经挂着哪些托管单还没认领上(未成交单列表这一轮没取到):不挂、不改、不撤
        for (const Rec& t : tracks) {
            if (js::truthy(js::path(&t, {u"auto_close"_s, u"host_at_broker"_s}))) {
                Rec b = js::object();
                putDefined(b, u"id"_s, js::prop(&t, u"id"_s));
                putDefined(b, u"symbol"_s, js::prop(&t, u"symbol"_s));
                b.set(u"blockers"_s, js::array({js::S(u"还没认领上券商侧已挂的托管单(未成交单列表没取到),这一轮不挂也不改"_s)}));
                pushTo(u"blocked"_s, b);
            }
        }
        co_return out;
    }

    Rec positions = js::object();
    try {
        QList<Rec> source;
        if (rows) source = *rows;
        else source = co_await router->positions();
        for (const Rec& p : domain::withCombos(source)) positions.set(js::str(js::prop(&p, u"key"_s)), p);
    } catch (...) {
        // 读不到持仓不该炸掉对账
        host_.store().audit(u"engine"_s, u"hosted_positions_failed"_s,
                            js::object({{u"error"_s, js::S(jsx::errorMessage(std::current_exception()).left(300))}}));
        co_return out;
    }

    const util::BreakerState breaker = host_.killswitch().state();
    QSet<QString> alive;
    for (const Rec& track : tracks) {
        const QString tid = js::str(js::prop(&track, u"id"_s));
        const Rec auto_ = tk::makeAutoClose(js::nullish(js::prop(&track, u"auto_close"_s)) ? js::object() : *js::prop(&track, u"auto_close"_s));
        if (!js::truthy(js::prop(&auto_, u"host_at_broker"_s))) {
            co_await cancelHostedTrack(tid, u"托管已关闭"_s);
            continue;
        }
        const QString account = js::str(js::prop(&track, u"account"_s));
        if (host_.accountIsPaper(account)) {
            // 模拟账户常拿延迟行情:动态调整可能滞后(且只会偏松,不会偏紧),托管单本身仍由券商实时触发——把这件事告诉界面
            out.set(u"quote_maybe_delayed"_s, js::B(true));
        }
        const QString key = tk::trackKey(track);
        const Rec* rawPtr = js::prop(&positions, key);
        // 账户读不到 ≠ 仓没了:券商侧的托管单原样留着,它们本来就不靠本机盯
        if (!rawPtr && tk::unreachableReason(covered, js::prop(&track, u"account"_s))) continue;
        if (!rawPtr) {
            co_await cancelHostedTrack(tid, u"持仓已不存在"_s);
            continue;
        }
        const Rec raw = *rawPtr;
        Rec posRaw = js::object();
        for (const char16_t* k : {u"account", u"symbol", u"sec_type", u"quantity", u"avg_cost", u"multiplier", u"currency", u"market_price", u"market_value", u"unrealized_pnl"})
            putDefined(posRaw, QString::fromUtf16(k), js::prop(&raw, QString::fromUtf16(k)));
        const tk::Position position = tk::makePosition(posRaw);
        // 托管单只是挂着,不是立刻成交——时段闸门不适用,其余闸门照过:挂单也是发单,授权与熔断一个都不能少。
        // 追价平仓中的追踪已经落了闩(fired_at),但它的托管单正是要继续改的那一张,不算"已触发过"
        const bool sweeping = tk::sweepReason(track).has_value();
        tk::CloseGateArgs gate;
        gate.autoClose = &auto_;
        gate.position = &position;
        gate.accountIsPaper = host_.accountIsPaper(account);
        gate.autoExecute = host_.settings().policies.auto_execute;
        gate.allowLiveTrading = host_.settings().policies.allow_live_trading;
        // 自动熔断不挡追价平仓:那是在减仓,和软件止损同一口径
        gate.breakerEngaged = breaker.engaged && !(breaker.autoEngaged && sweeping);
        gate.marketStatus = u"盘中"_s;
        gate.alreadyFired = js::truthy(js::prop(&track, u"fired_at"_s)) && !sweeping;
        const QStringList blockers = tk::closeBlockers(gate);
        if (!blockers.isEmpty()) {
            // 挡住它的只有**自动**熔断:券商侧已经挂着的托管单原样留着,只是不再挂新的、不再改价
            bool onlyBreaker = true;
            for (const QString& b : blockers) onlyBreaker = onlyBreaker && b == tk::kBlockBreaker;
            if (breaker.autoEngaged && onlyBreaker) {
                Rec b = js::object({{u"id"_s, js::S(tid)}});
                putDefined(b, u"symbol"_s, js::prop(&track, u"symbol"_s));
                b.set(u"blockers"_s, js::array({js::S(tk::kBlockBreaker + u"(自动熔断:券商侧已挂的托管单原样保留,不再改价)"_s)}));
                pushTo(u"blocked"_s, b);
                if (hosted_.contains(tid)) {
                    Rec h = js::object({{u"id"_s, js::S(tid)}});
                    putDefined(h, u"symbol"_s, js::prop(&track, u"symbol"_s));
                    h.set(u"orders"_s, hostedRows(tid));
                    pushTo(u"hosted"_s, h);
                }
                continue;
            }
            co_await cancelHostedTrack(tid, blockers.join(u"、"_s));
            Rec b = js::object({{u"id"_s, js::S(tid)}});
            putDefined(b, u"symbol"_s, js::prop(&track, u"symbol"_s));
            b.set(u"blockers"_s, js::array());
            for (const QString& s : blockers) js::propMut(&b, u"blockers"_s)->items.append(js::S(s));
            pushTo(u"blocked"_s, b);
            continue;
        }

        const OJson* mp = js::prop(&raw, u"market_price"_s);
        const std::optional<double> mark = host_.exits().peakMark(tid, position, js::nullish(mp) ? std::nullopt : std::optional<double>(js::num(mp)),
                                                                  js::truthy(js::prop(&auto_, u"peak_confirm"_s)));
        const OJson* trackPeak = js::prop(&track, u"peak"_s);
        const std::optional<double> peak = tk::advancePeak(position, mark, js::nullish(trackPeak) ? std::nullopt : std::optional<double>(js::num(trackPeak)));
        if (peak) {
            const OJson peakValue = js::N(*peak);
            if (!js::strictEqual(&peakValue, trackPeak)) host_.store().updateTrack(tid, js::object({{u"peak"_s, peakValue}}));
        }
        // 标的目标价:这一轮的止盈价现算。托管单的价格因此**一秒一变**——插针那一下扫过来时,挂着的限价必须已经是当时的合理价
        SpotTargetResult spot = co_await host_.applySpotTarget(
            track, raw, position, tk::makeTargets(js::nullish(js::prop(&track, u"targets"_s)) ? js::object() : *js::prop(&track, u"targets"_s)), positions,
            domain::nowEt());
        Rec targets = spot.targets;
        bool hold = spot.hold;
        alive.insert(tid);
        if (!hosted_.contains(tid)) hosted_.insert(tid, std::make_shared<KindMap>());
        const KindMapPtr current = *hosted_.find(tid);
        std::optional<ChaseQuote> chase;
        if (sweeping) {
            // 追价平仓:止盈单改到此刻立刻能成交的价,每轮按最新的买卖价再追一次,越等越让(tk.chaseLimit)
            const EntryPtr* tpp = current->entries.find(tk::kHostedKindTp);
            const EntryPtr tp = tpp ? *tpp : nullptr;
            const std::optional<double> prevLimit = tp ? js::finiteOrNull(js::nullish(js::prop(&*tp, u"chase_limit"_s)) ? nullptr : js::prop(&*tp, u"chase_limit"_s)) : std::nullopt;
            const double rounds = tp ? jsx::numOr(js::prop(&*tp, u"chase_rounds"_s), 0) : 0;
            chase = co_await host_.chaseQuote(raw, position, positions, auto_, prevLimit, rounds, tk::sweepReason(track));
            if (!chase) {
                // 拿不到腿的买卖价:这一轮不动那张单(更不能把它改回模型价),下一轮再追
                Rec b = js::object({{u"id"_s, js::S(tid)}});
                putDefined(b, u"symbol"_s, js::prop(&track, u"symbol"_s));
                b.set(u"blockers"_s, js::array({js::S(u"正在追价平仓,但这一轮拿不到腿的买卖价,没改价"_s)}));
                pushTo(u"blocked"_s, b);
                Rec h = js::object({{u"id"_s, js::S(tid)}});
                putDefined(h, u"symbol"_s, js::prop(&track, u"symbol"_s));
                h.set(u"sweeping"_s, js::B(true));
                h.set(u"orders"_s, hostedRows(tid));
                pushTo(u"hosted"_s, h);
                continue;
            }
            targets.set(u"take_profit"_s, js::N(chase->limit));
            hold = false;
        }
        Rec plan = tk::hostedPlan(position, targets, auto_, peak);
        // 已经部分成交的托管单:持仓缩了,按持仓算出的数量也跟着缩,可券商那边的总量含已成交的那部分——
        // 总量 = 剩余该平的 + 已成交的,且不超过原总量(用户在别处手动平了一部分才会更小)
        for (Rec& item : plan.items) {
            const EntryPtr* curp = current->entries.find(js::str(js::prop(&item, u"kind"_s)));
            const double filled = curp ? jsx::truncNumOr0(js::prop(&**curp, u"filled"_s)) : 0;
            if (curp && filled > 0) {
                item.set(u"quantity"_s, js::N(jsx::min(jsx::truncNumOr0(js::prop(&**curp, u"quantity"_s)), js::num(js::prop(&item, u"quantity"_s)) + filled)));
            }
        }
        synced_.insert(tid);
        QSet<QString> desired;
        for (const Rec& item : plan.items) desired.insert(js::str(js::prop(&item, u"kind"_s)));
        // 只守不挂的这一轮,止盈单"不在计划里"不等于"该撤":撤掉一张站岗的单比停在旧价危险得多
        if (hold) desired.insert(tk::kHostedKindTp);
        for (const QString& kind : QStringList(current->entries.keys())) {
            if (!desired.contains(kind)) co_await cancelHostedOne(tid, kind, u"该目标已移除"_s);
        }
        const QString oca = u"dafri-trk-"_s + tid.left(8);
        for (Rec& item : plan.items) {
            // 上面每一次 await 券商的空档里,回报都可能已经改了这条追踪(托管单成交落了闩)。拿这一轮开头读的旧快照接着挂,
            // 就是给一个刚平掉的仓再挂一组平仓单——止盈价就是刚成交的那个价,挂上去当场成交,反向开仓
            if (!stillHosting(tid)) break;
            const QString kind = js::str(js::prop(&item, u"kind"_s));
            const QString label = js::str(js::prop(&item, u"label"_s));
            const EntryPtr* curp = current->entries.find(kind);
            const EntryPtr cur = curp ? *curp : nullptr;
            const QString retryKey = tid + u"|"_s + kind;
            std::optional<Retry> retry;
            if (const auto it = hostedRetryAt_.constFind(retryKey); it != hostedRetryAt_.cend()) retry = *it;
            if (retry && retry->warn) {
                hostedRetryAt_[retryKey].warn = false;
                retry->warn = false;
                host_.notifier().warning(js::str(js::prop(&track, u"symbol"_s)) + u" 的"_s + label + u":"_s + retry->reason + u"。60 秒后再挂,期间这一项没有券商侧的单"_s);
            }
            if (!cur && retry) {
                if (retry->at > nowMs()) {
                    // 刚被券商拒过:退避期内不重挂,把原因交给界面
                    Rec b = js::object({{u"id"_s, js::S(tid)}});
                    putDefined(b, u"symbol"_s, js::prop(&track, u"symbol"_s));
                    b.set(u"blockers"_s, js::array({js::S(u"托管单被券商拒绝,没有挂上:"_s + retry->reason)}));
                    pushTo(u"blocked"_s, b);
                    continue;
                }
                hostedRetryAt_.remove(retryKey);
            }
            std::exception_ptr failure;
            try {
                if (!cur) {
                    co_await placeHostedOne(track, item, oca);
                } else if (tk::hostedNeedsUpdate(*cur, item)) {
                    if (retry && retry->at > nowMs()) {
                        // 改价刚被拒:原单还在原价,退避期内不再改
                        const OJson* lmt = js::prop(&*cur, u"lmt_price"_s);
                        const OJson* shown = js::nullish(lmt) ? js::prop(&*cur, u"aux_price"_s) : lmt;
                        Rec b = js::object({{u"id"_s, js::S(tid)}});
                        putDefined(b, u"symbol"_s, js::prop(&track, u"symbol"_s));
                        b.set(u"blockers"_s, js::array({js::S(u"托管单改价被券商拒绝,仍挂在 "_s + js::str(shown) + u":"_s + retry->reason)}));
                        pushTo(u"blocked"_s, b);
                    } else {
                        if (retry) hostedRetryAt_.remove(retryKey);
                        co_await modifyHostedOne(track, cur, item);
                    }
                }
            } catch (...) {
                failure = std::current_exception();
            }
            if (failure) {
                // 单张失败不拖垮整轮。也不每秒重来:退避一分钟;拼不出合约这类我们自己的错,券商那边永远不会好,退避十分钟且不算券商失败
                const QString message = jsx::errorMessage(failure).left(300);
                bool own = false, linkDown = false;
                try {
                    std::rethrow_exception(failure);
                } catch (const HostedPlanError&) {
                    own = true;
                } catch (const execution::LinkDownError&) {
                    linkDown = true;
                } catch (...) {
                }
                host_.store().audit(u"engine"_s, u"hosted_place_failed"_s,
                                    js::object({{u"track"_s, js::S(tid)}, {u"kind"_s, js::S(kind)}, {u"error"_s, js::S(message)}}));
                hostedRetryAt_.insert(retryKey, Retry{nowMs() + (own ? 600'000 : 60'000), message, false});
                host_.notifier().warning(js::str(js::prop(&track, u"symbol"_s)) + u" 的"_s + label + u"没有挂上:"_s + message);
                // 链路断了不是券商拒单:不算失败,不往熔断上记(断线期间每个托管单一分钟一次,几分钟就能把熔断打合上)
                if (!own && !linkDown) {
                    const auto engaged = host_.killswitch().recordFailure(message, u"broker"_s);
                    if (engaged) host_.notifier().breaker(engaged->reason);
                }
            }
        }
        if (chase) {
            // 记下这一轮追到哪了:下一轮从这里接着让,界面也照它显示
            const EntryPtr* tpp = current->entries.find(tk::kHostedKindTp);
            if (tpp) {
                Rec& tp = **tpp;
                tp.set(u"chase_rounds"_s, js::N(jsx::numOr(js::prop(&tp, u"chase_rounds"_s), 0) + 1));
                tp.set(u"chase_limit"_s, js::N(chase->limit));
                tp.set(u"chase_natural"_s, js::N(chase->natural));
                tp.set(u"chase_floor"_s, js::N(chase->floor));
                const Rec roundsNow = *js::prop(&tp, u"chase_rounds"_s);
                tp.set(u"rounds"_s, roundsNow);
                host_.chaseWarnIfStuck(track, tp, chase->limit, chase->natural);
            }
        }
        Rec h = js::object({{u"id"_s, js::S(tid)}});
        putDefined(h, u"symbol"_s, js::prop(&track, u"symbol"_s));
        if (sweeping) h.set(u"sweeping"_s, js::B(true));
        h.set(u"orders"_s, hostedRows(tid));
        if (chase) {
            const EntryPtr* tpp = current->entries.find(tk::kHostedKindTp);
            const OJson* rounds = tpp ? js::prop(&**tpp, u"chase_rounds"_s) : nullptr;
            h.set(u"chase"_s, js::object({{u"rounds"_s, js::nullish(rounds) ? js::N(0) : *rounds},
                                         {u"natural"_s, js::N(chase->natural)},
                                         {u"limit"_s, js::N(chase->limit)},
                                         {u"floor"_s, js::N(chase->floor)}}));
        }
        pushTo(u"hosted"_s, h);
    }

    QSet<QString> known;
    for (const Rec& t : tracks) known.insert(js::str(js::prop(&t, u"id"_s)));
    for (const QString& tid : QStringList(hosted_.keys())) {
        if (!alive.contains(tid) && !known.contains(tid)) co_await cancelHostedTrack(tid, u"追踪已删除"_s);
    }
    co_return out;
}

void HostedOrders::onTriggered(const TriggeredArgs& args, Rec& row, Rec& out) {
    const Rec& track = args.track;
    const Rec& raw = args.raw;
    const QString tid = js::str(js::prop(&track, u"id"_s));
    row.set(u"hosted"_s, js::B(true));
    const QString secType = js::strOr(js::prop(&raw, u"sec_type"_s), QString());
    // 组合与单腿期权的止盈单挂在模型价(中间价口径)上,标的真到了目标价,买价也未必够得着——那时同样改到立刻成交的价
    const bool derivative = secType == u"BAG" || secType == u"OPT" || secType == u"FOP";
    const QSet<QString> live = liveKinds(tid);
    bool covered = false;
    for (const QString& k : coveringKinds(args.state)) covered = covered || live.contains(k);
    // 组合只托管止盈单:止损类在券商侧永远没有单,不用等对账就知道。其余品种要对过一次账才作数(见 synced)
    const bool uncoveredForSure = secType == u"BAG" && args.state != tk::kStateTakeProfit;
    const bool sweep = (derivative && args.spotReached) || args.spotStop || uncoveredForSure || (!covered && synced_.contains(tid));
    if (sweep && !tk::sweepReason(track) && !js::truthy(js::prop(&track, u"fired_at"_s))) {
        const util::BreakerState breaker = host_.killswitch().state();
        const Rec auto_ = tk::makeAutoClose(js::nullish(js::prop(&track, u"auto_close"_s)) ? js::object() : *js::prop(&track, u"auto_close"_s));
        tk::CloseGateArgs gate;
        gate.autoClose = &auto_;
        gate.position = &args.position;
        gate.accountIsPaper = host_.accountIsPaper(js::str(js::prop(&track, u"account"_s)));
        gate.autoExecute = host_.settings().policies.auto_execute;
        gate.allowLiveTrading = host_.settings().policies.allow_live_trading;
        gate.breakerEngaged = breaker.engaged && !breaker.autoEngaged;
        // 托管单挂着等成交,不是立刻发出去:时段闸门不适用(同 syncHosted)
        gate.marketStatus = u"盘中"_s;
        gate.alreadyFired = false;
        const QStringList blockers = tk::closeBlockers(gate);
        if (!blockers.isEmpty()) {
            // 到价了但动不了,必须当场说。只提醒一次,不刷屏(同软件平仓那条路)
            if (!js::truthy(js::prop(&track, u"fired_state"_s))) {
                host_.store().updateTrack(tid, js::object({{u"fired_state"_s, js::S(u"blocked"_s)}}));
                host_.notifier().warning(js::str(js::prop(&track, u"symbol"_s)) + u" "_s + args.reason + u",但没有平仓:"_s + blockers.join(u"、"_s));
            }
            Rec b = js::array();
            for (const QString& s : blockers) b.items.append(js::S(s));
            row.set(u"blocked"_s, b);
            Rec entry = js::object();
            putDefined(entry, u"id"_s, js::prop(&track, u"id"_s));
            putDefined(entry, u"symbol"_s, js::prop(&track, u"symbol"_s));
            entry.set(u"reason"_s, js::S(args.reason));
            entry.set(u"blockers"_s, b);
            if (!js::propMut(&out, u"blocked"_s)) out.set(u"blocked"_s, js::array());
            js::propMut(&out, u"blocked"_s)->items.append(entry);
            return;
        }
        const QString firedState = tk::kSweepPrefix + args.state;
        host_.store().updateTrack(tid, js::object({{u"fired_at"_s, js::S(nowIsoSecondsEt())}, {u"fired_state"_s, js::S(firedState)}}));
        const std::shared_ptr<Rec> tp = tpEntry(tid);
        Rec audit = js::object({{u"track"_s, js::S(tid)}});
        putDefined(audit, u"symbol"_s, js::prop(&track, u"symbol"_s));
        audit.set(u"leg"_s, js::nullish(js::prop(&track, u"leg"_s)) ? js::S(QString()) : *js::prop(&track, u"leg"_s));
        audit.set(u"state"_s, js::S(args.state));
        audit.set(u"reason"_s, js::S(args.reason));
        audit.set(u"mark"_s, js::NOrNull(args.position.market_price));
        const OJson* rec = tp ? js::prop(&*tp, u"record_id"_s) : nullptr;
        audit.set(u"record"_s, js::nullish(rec) ? js::Null() : *rec);
        host_.store().audit(u"engine"_s, u"hosted_sweep"_s, &audit);
        // 该出手了:上一次被拒留下的退避不再等
        clearBackoff(tid);
        host_.notifier().notify(u"追价平仓"_s, js::str(js::prop(&track, u"symbol"_s)) + u":"_s + args.reason + u"。"_s +
                                                   (covered ? u"托管单改到"_s : u"券商侧没有负责这一项的单,在同一组里挂一张止盈单,挂在"_s) +
                                                   u"立刻成交的价,没成交就每秒再追"_s);
        Rec fired = js::object();
        putDefined(fired, u"id"_s, js::prop(&track, u"id"_s));
        putDefined(fired, u"symbol"_s, js::prop(&track, u"symbol"_s));
        fired.set(u"state"_s, js::S(firedState));
        fired.set(u"reason"_s, js::S(args.reason));
        if (!js::propMut(&out, u"fired"_s)) out.set(u"fired"_s, js::array());
        js::propMut(&out, u"fired"_s)->items.append(fired);
    }
    const std::optional<Rec> fresh = host_.store().getTrack(tid);
    if (tk::sweepReason(fresh ? *fresh : track)) {
        row.set(u"sweeping"_s, js::B(true));
        // 托管对账在盯盘之后跑,这里给界面的是上一轮追到的价
        const std::shared_ptr<Rec> tp = tpEntry(tid);
        if (tp && js::prop(&*tp, u"chase_limit"_s)) {
            const auto orNull = [&](const QString& k) { return js::nullish(js::prop(&*tp, k)) ? js::Null() : *js::prop(&*tp, k); };
            row.set(u"chase"_s, js::object({{u"rounds"_s, js::nullish(js::prop(&*tp, u"chase_rounds"_s)) ? js::N(0) : *js::prop(&*tp, u"chase_rounds"_s)},
                                            {u"limit"_s, *js::prop(&*tp, u"chase_limit"_s)},
                                            {u"natural"_s, orNull(u"chase_natural"_s)},
                                            {u"floor"_s, orNull(u"chase_floor"_s)}}));
        }
    }
}

void HostedOrders::onError(qint64 orderId, int code, const QString& message) {
    const auto where = hostedIndex_.constFind(orderId);
    if (where == hostedIndex_.cend()) return;
    const QString tid = where->first, kind = where->second;
    const EntryPtr entry = entryOf(tid, kind);
    if (!entry) return;
    const QString reason = u"IBKR "_s + n(code) + u": "_s + message;
    const std::optional<Rec> track = host_.store().getTrack(tid);
    const QString symbol = track ? js::str(js::prop(&*track, u"symbol"_s)) : u"?"_s;
    // 券商接受过这张单(推过 Submitted / PreSubmitted、或是认领回来的)就说明它在券商侧:之后的错误都是在回某一次改单。
    // 只看 pending 不够——晚到的 Submitted 回执会把"改价中"的标记提前清掉,拿它判成"刚挂的单被拒"就会摘掉一张还活着的单
    const OJson* pending = js::prop(&*entry, u"pending"_s);
    if (code != 202 && ((js::isStr(pending) && pending->s == u"modify") || js::truthy(js::prop(&*entry, u"live"_s)))) {
        if (js::truthy(js::prop(&*entry, u"accepted"_s))) {
            const Rec accepted = *js::prop(&*entry, u"accepted"_s);  // 拷一份:assign 会改 entry,accepted 就住在 entry 里
            jsx::assign(*entry, accepted);
        }
        entry->set(u"pending"_s, js::Null());
        hostedRetryAt_.insert(tid + u"|"_s + kind, Retry{nowMs() + 60'000, reason, false});
        host_.notifier().warning(symbol + u" 的托管单改价被券商拒绝,仍挂在原价:"_s + reason);
        return;
    }
    dropHostedEntry(tid, kind);
    if (code != 202) {
        hostedRetryAt_.insert(tid + u"|"_s + kind, Retry{nowMs() + 60'000, reason, false});
        host_.store().audit(u"engine"_s, u"hosted_rejected"_s,
                            js::object({{u"track"_s, js::S(tid)}, {u"kind"_s, js::S(kind)}, {u"order_id"_s, js::N(static_cast<double>(orderId))}, {u"reason"_s, js::S(reason)}}));
        host_.notifier().warning(symbol + u" 的托管单被券商拒绝,没有挂上:"_s + reason);
    }
}

util::Task<> HostedOrders::adoptHosted() {
    HostedRouter* router = host_.router();
    if (!router || !router->hasListHostedOpen()) {
        hostedAdopted_ = true;
        co_return;
    }
    QList<Rec> rows;
    try {
        // 未成交单的请求本身没有超时:TWS 挂住时它永远不回,而对账在盯盘锁里——整条盯盘跟着停。10 秒放手,下一轮再认
        rows = co_await raceTimeout<QList<Rec>>(router->listHostedOpen(), 10'000, u"券商 10 秒没有回应未成交单列表"_s, setTimeout);
    } catch (...) {
        // 下一轮再试
        host_.store().audit(u"engine"_s, u"hosted_adopt_failed"_s, js::object({{u"error"_s, js::S(jsx::errorMessage(std::current_exception()).left(300))}}));
        co_return;
    }
    // 同一个"追踪 + 单型"在券商那边有多张:以前的 bug 留下的重复单。只认单号最新的那一张,其余当场撤掉——
    // 两张止盈卖单挂在 3 股持仓上,一起成交就是反向开仓
    contract::OrderedMap<std::vector<qsizetype>> byRef;
    for (qsizetype i = 0; i < rows.size(); ++i) {
        const QString ref = js::strOr(js::prop(&rows[i], u"order_ref"_s), QString());
        if (!ref.startsWith(u"trk:"_s)) continue;
        if (!byRef.contains(ref)) byRef.insert(ref, {});
        byRef.find(ref)->push_back(i);
    }
    QSet<qsizetype> keep;
    for (const QString& ref : byRef.keys()) {
        std::vector<qsizetype> group = *byRef.find(ref);
        util::market::jsSort(group, [&](qsizetype a, qsizetype b) {
            return jsx::numOr(js::prop(&rows[b], u"order_id"_s), 0) - jsx::numOr(js::prop(&rows[a], u"order_id"_s), 0);
        });
        keep.insert(group[0]);
        for (size_t g = 1; g < group.size(); ++g) {
            const Rec& dup = rows[group[g]];
            const double orderId = jsx::numOr(js::prop(&dup, u"order_id"_s), 0);
            if (orderId == 0 || std::isnan(orderId)) continue;
            host_.sentOrders().insert(static_cast<qint64>(orderId), SentOrder{nowMs(), SentOrder::Kind::Cancel});
            const Rec* keptId = js::prop(&rows[group[0]], u"order_id"_s);
            try {
                (void)co_await router->cancelHosted(static_cast<qint64>(orderId));
                Rec detail = js::object({{u"order_ref"_s, js::S(ref)}, {u"order_id"_s, js::N(orderId)}});
                putDefined(detail, u"kept"_s, keptId);
                host_.store().audit(u"engine"_s, u"hosted_duplicate_cancelled"_s, &detail);
                host_.notifier().warning(u"撤掉了一张重复的托管单 #"_s + n(orderId) + u"(同一追踪只留 #"_s + js::str(keptId) + u")"_s);
            } catch (...) {
                host_.store().audit(u"engine"_s, u"hosted_duplicate_cancel_failed"_s,
                                    js::object({{u"order_ref"_s, js::S(ref)}, {u"order_id"_s, js::N(orderId)},
                                                {u"error"_s, js::S(jsx::errorMessage(std::current_exception()).left(200))}}));
            }
        }
    }
    for (qsizetype i = 0; i < rows.size(); ++i) {
        if (!keep.contains(i)) continue;
        const Rec& row = rows[i];
        const QStringList parts = js::strOr(js::prop(&row, u"order_ref"_s), QString()).split(u':');
        if (parts.size() != 3 || parts[0] != u"trk") continue;
        const QString tid = parts[1], kind = parts[2];
        const OJson* orderIdV = js::prop(&row, u"order_id"_s);
        Rec entry = js::object({{u"kind"_s, js::S(kind)}, {u"label"_s, js::S(labelOf(kind))}});
        entry.set(u"order_id"_s, js::nullish(orderIdV) ? js::Null() : *orderIdV);
        // 执行对账已经按 orderRef 把这张单认回了它的记录的话,接上:之后的改价、成交落闩都记到那条记录上
        Rec recordId = js::Null();
        if (js::truthy(orderIdV)) {
            const auto it = host_.orderIndex().constFind(static_cast<qint64>(js::num(orderIdV)));
            if (it != host_.orderIndex().cend()) recordId = js::S(*it);
        }
        entry.set(u"record_id"_s, recordId);
        for (const char16_t* k : {u"quantity", u"lmt_price", u"aux_price", u"trailing_percent"}) {
            const OJson* v = js::prop(&row, QString::fromUtf16(k));
            entry.set(QString::fromUtf16(k), js::nullish(v) ? js::Null() : *v);
        }
        // 从券商的未成交单里认领回来的:它就在券商侧
        entry.set(u"live"_s, js::B(true));
        if (!hosted_.contains(tid)) hosted_.insert(tid, std::make_shared<KindMap>());
        (*hosted_.find(tid))->entries.insert(kind, std::make_shared<Rec>(entry));
        if (js::truthy(orderIdV)) hostedIndex_.insert(static_cast<qint64>(js::num(orderIdV)), {tid, kind});
    }
    hostedAdopted_ = true;
    if (!rows.isEmpty()) host_.store().audit(u"engine"_s, u"hosted_adopted"_s, js::object({{u"count"_s, js::N(static_cast<double>(rows.size()))}}));
}

util::Task<> HostedOrders::placeHostedOne(Rec track, Rec item, QString oca) {
    const contract::AccountConfig* accountPtr = host_.settings().accountByAlias(js::str(js::prop(&track, u"account"_s)));
    if (!accountPtr) throw execution::BrokerError(u"账户别名 "_s + js::str(js::prop(&track, u"account"_s)) + u" 已不存在。"_s);
    const contract::AccountConfig account = *accountPtr;
    // 持仓行里的合约不能原样下单,和到价自动平仓走同一个 closeContract——两条路必须拼出同一张单,否则"核对过的"就只是其中一条
    const std::optional<QString> issue = tk::closeContractIssue(&track);
    if (issue) throw HostedPlanError(*issue);
    const Rec* trackContract = js::prop(&track, u"contract"_s);
    const Rec closeSpec = tk::closeContract(js::nullish(trackContract) ? js::object() : *trackContract);
    const auto parsed = util::zod::safeParse(domain::models::contractSpecSchema(), &closeSpec);
    if (!parsed.success || !parsed.data) throw util::JsError(domain::models::briefZodError(parsed.issues));
    const Rec contractSpec = *parsed.data;
    const QString tid = js::str(js::prop(&track, u"id"_s));
    const QString kind = js::str(js::prop(&item, u"kind"_s));
    const QString label = js::str(js::prop(&item, u"label"_s));
    const QString ref = u"trk:"_s + tid + u":"_s + kind;
    Rec record = host_.baseRecord(label + u":"_s + js::str(js::prop(&item, u"action"_s)) + u" "_s + js::str(js::prop(&item, u"quantity"_s)) + u" "_s +
                                      js::str(js::prop(&track, u"symbol"_s)) + u"(GTC,挂在券商服务器)"_s,
                                  u"tracker"_s);
    record.set(u"account"_s, js::object({{u"alias"_s, js::S(account.alias)}, {u"account_id"_s, js::S(account.account_id)}, {u"is_paper"_s, js::B(account.is_paper)}}));
    record.set(u"contract"_s, js::nullish(trackContract) ? js::object() : *trackContract);
    Rec order = js::object();
    for (const char16_t* k : {u"action", u"order_type", u"quantity", u"lmt_price", u"aux_price", u"trailing_percent"}) {
        const QString key = QString::fromUtf16(k);
        putDefined(order, key, js::prop(&item, key));
    }
    record.set(u"order"_s, order);
    record.set(u"execution_type"_s, js::S(u"HOSTED"_s));
    record.set(u"signature"_s, js::S(ref));
    const QString recordId = host_.store().createRecord(record);
    host_.store().markSubmitIntent(recordId);

    const execution::HostedPlacement result = co_await host_.router()->placeHosted(account, contractSpec, item, oca, ref);
    if (truthyId(result.order_id)) host_.sentOrders().insert(*result.order_id, SentOrder{nowMs(), SentOrder::Kind::Place});
    Rec entry = item;
    entry.set(u"order_id"_s, result.order_id ? js::N(*result.order_id) : js::Null());
    entry.set(u"record_id"_s, js::S(recordId));
    entry.set(u"pending"_s, js::S(u"place"_s));
    if (!hosted_.contains(tid)) hosted_.insert(tid, std::make_shared<KindMap>());
    (*hosted_.find(tid))->entries.insert(kind, std::make_shared<Rec>(entry));
    if (truthyId(result.order_id)) {
        hostedIndex_.insert(*result.order_id, {tid, kind});
        host_.orderIndex().insert(*result.order_id, recordId);
    }
    if (truthyId(result.perm_id)) host_.orderIndex().insert(*result.perm_id, recordId);
    host_.store().appendEvent(recordId, u"status"_s,
                              js::object({{u"status"_s, js::S(result.status)}, {u"order_id"_s, result.order_id ? js::N(*result.order_id) : js::Null()}}));
    if (truthyId(result.order_id)) {
        const auto early = host_.earlyOrderErrors().constFind(*result.order_id);
        if (early != host_.earlyOrderErrors().cend()) {
            // 错误比下单返回还早到:现在对上,和晚到的走同一条路
            const EarlyOrderError e = *early;
            host_.earlyOrderErrors().remove(*result.order_id);
            host_.onIbError(js::N(*result.order_id), js::N(e.code), js::S(e.message));
            co_return;
        }
    }
    host_.killswitch().recordSuccess(u"broker"_s);
    host_.notifier().notify(u"托管单已挂出"_s, js::str(js::prop(&track, u"symbol"_s)) + u":"_s + label);
}

util::Task<> HostedOrders::modifyHostedOne(Rec track, EntryPtr current, Rec item) {
    const OJson* orderIdV = js::prop(&*current, u"order_id"_s);
    if (!js::truthy(orderIdV)) co_return;
    const qint64 orderId = static_cast<qint64>(js::num(orderIdV));
    // 改价被拒时券商那边还是这一版:先记下来,拒了就恢复成它(见 onError)
    Rec accepted = js::object();
    for (const char16_t* k : {u"quantity", u"lmt_price", u"aux_price", u"trailing_percent", u"label"}) {
        const QString key = QString::fromUtf16(k);
        putDefined(accepted, key, js::prop(&*current, key));
    }
    current->set(u"accepted"_s, accepted);
    current->set(u"pending"_s, js::S(u"modify"_s));
    host_.sentOrders().insert(orderId, SentOrder{nowMs(), SentOrder::Kind::Modify});
    const bool ok = co_await host_.router()->modifyHosted(orderId, item);
    if (!ok) {
        // 券商侧已经不认识这张单(成交/撤销竞态):丢掉缓存,下一轮重挂
        dropHostedEntry(js::str(js::prop(&track, u"id"_s)), js::str(js::prop(&*current, u"kind"_s)));
        co_return;
    }
    const OJson* recordId = js::prop(&*current, u"record_id"_s);
    if (js::truthy(recordId)) {
        Rec payload = js::object({{u"status"_s, js::S(u"Adjusted"_s)}});
        putDefined(payload, u"lmt_price"_s, js::prop(&item, u"lmt_price"_s));
        putDefined(payload, u"aux_price"_s, js::prop(&item, u"aux_price"_s));
        putDefined(payload, u"quantity"_s, js::prop(&item, u"quantity"_s));
        host_.store().appendEvent(js::str(recordId), u"status"_s, payload);
    }
    for (const char16_t* k : {u"quantity", u"lmt_price", u"aux_price", u"trailing_percent", u"label"}) {
        const QString key = QString::fromUtf16(k);
        if (const OJson* v = js::prop(&item, key)) current->set(key, *v);
        else current->remove(key);
    }
}

util::Task<> HostedOrders::cancelHostedTrack(QString trackId, QString reason) {
    const KindMapPtr* km = hosted_.find(trackId);
    if (!km) co_return;
    const QStringList kinds = (*km)->entries.keys();
    for (const QString& kind : kinds) co_await cancelHostedOne(trackId, kind, reason);
}

util::Task<> HostedOrders::cancelHostedOne(QString trackId, QString kind, QString reason) {
    const EntryPtr entry = entryOf(trackId, kind);
    if (!entry) co_return;
    const OJson* orderIdV = js::prop(&*entry, u"order_id"_s);
    if (js::truthy(orderIdV)) {
        const qint64 orderId = static_cast<qint64>(js::num(orderIdV));  // 先取值:下面 set 会让 orderIdV 失效
        // 撤单回报可能在 cancelHosted 返回之前就到(见 onStatus):先记下是我们撤的
        entry->set(u"cancelling"_s, js::B(true));
        host_.sentOrders().insert(orderId, SentOrder{nowMs(), SentOrder::Kind::Cancel});
        std::exception_ptr failure;
        try {
            (void)co_await host_.router()->cancelHosted(orderId);
        } catch (...) {
            failure = std::current_exception();
        }
        if (failure) {
            // 撤单失败要让人知道,但不炸循环
            host_.store().audit(u"engine"_s, u"hosted_cancel_failed"_s,
                                js::object({{u"track"_s, js::S(trackId)}, {u"kind"_s, js::S(kind)}, {u"error"_s, js::S(jsx::errorMessage(failure).left(300))}}));
            entry->set(u"cancelling"_s, js::B(false));
            co_return;
        }
    }
    const OJson* recordId = js::prop(&*entry, u"record_id"_s);
    if (js::truthy(recordId)) {
        host_.store().appendEvent(js::str(recordId), u"status"_s, js::object({{u"status"_s, js::S(u"Cancelled"_s)}, {u"reason"_s, js::S(reason)}}));
    }
    dropHostedEntry(trackId, kind);
}

void HostedOrders::dropHostedEntry(const QString& trackId, const QString& kind) {
    const KindMapPtr* km = hosted_.find(trackId);
    if (km && (*km)->entries.contains(kind)) {
        const OJson* orderIdV = js::prop(&**(*km)->entries.find(kind), u"order_id"_s);
        if (js::truthy(orderIdV)) hostedIndex_.remove(static_cast<qint64>(js::num(orderIdV)));
        (*km)->entries.remove(kind);
    }
    if (km && (*km)->entries.isEmpty()) hosted_.remove(trackId);
}

void HostedOrders::onStatus(const Rec& trade) {
    const OJson* orderIdV = js::path(&trade, {u"order"_s, u"orderId"_s});
    if (!js::truthy(orderIdV)) return;
    const double idNum = js::num(orderIdV);
    if (std::isnan(idNum)) return;
    const auto where = hostedIndex_.constFind(static_cast<qint64>(idNum));
    if (where == hostedIndex_.cend()) return;
    const QString tid = where->first, kind = where->second;
    const QString status = js::strOr(js::path(&trade, {u"orderStatus"_s, u"status"_s}), QString());
    if (status == u"Filled") {
        const EntryPtr entryPtr = entryOf(tid, kind);
        const Rec entry = entryPtr ? *entryPtr : js::object();
        const std::optional<Rec> before = host_.store().getTrack(tid);
        // 追价平仓成交的:记当初触发的原因(止损 / 利润回撤 / 标的到了目标价),不是笼统的"托管止盈"
        const std::optional<QString> sweep = before ? tk::sweepReason(*before) : std::nullopt;
        const std::optional<QString> mapped = hostedFiredState(kind);
        const QString firedState = sweep ? *sweep : mapped ? *mapped : kind;
        const OJson* entryRecord = js::prop(&entry, u"record_id"_s);
        host_.store().updateTrack(tid, js::object({{u"fired_at"_s, js::S(nowIsoSecondsEt())},
                                                   {u"fired_state"_s, js::S(firedState)},
                                                   {u"fired_record"_s, js::nullish(entryRecord) ? js::S(QString()) : *entryRecord},
                                                   {u"enabled"_s, js::B(false)}}));
        const std::optional<Rec> track = host_.store().getTrack(tid);
        const QString symbol = track ? js::str(js::prop(&*track, u"symbol"_s)) : u"?"_s;
        // 保护规则按审计表数"最近几次止损"、算同一标的的冷却。追价平仓触发时已经记过 hosted_sweep,这里只记券商自己触发的那些
        if (!sweep) {
            Rec detail = js::object({{u"track"_s, js::S(tid)}});
            if (track) {
                putDefined(detail, u"symbol"_s, js::prop(&*track, u"symbol"_s));
                detail.set(u"leg"_s, js::nullish(js::prop(&*track, u"leg"_s)) ? js::S(QString()) : *js::prop(&*track, u"leg"_s));
            } else {
                detail.set(u"symbol"_s, js::S(u"?"_s));
                detail.set(u"leg"_s, js::S(QString()));
            }
            detail.set(u"state"_s, js::S(mapped ? *mapped : kind));
            detail.set(u"record"_s, js::nullish(entryRecord) ? js::Null() : *entryRecord);
            host_.store().audit(u"engine"_s, u"hosted_fill"_s, &detail);
        }
        const OJson* entryLabel = js::prop(&entry, u"label"_s);
        host_.notifier().notify(u"托管单已成交"_s, symbol + u":"_s + (js::nullish(entryLabel) ? kind : js::str(entryLabel)));
        // 整组落闩:OCA 兄弟单券商会自己撤,这里直接清缓存
        if (const KindMapPtr* km = hosted_.find(tid)) {
            const QStringList kinds = (*km)->entries.keys();
            for (const QString& k : kinds) dropHostedEntry(tid, k);
        }
    } else if (status == u"Cancelled" || status == u"ApiCancelled" || status == u"Inactive") {
        const EntryPtr entry = entryOf(tid, kind);
        dropHostedEntry(tid, kind);
        // 不是我们撤的(券商撤了、或有人在 TWS 里撤了):退避 60 秒,并在下一轮对账时说一声
        if (entry && !js::truthy(js::prop(&*entry, u"cancelling"_s))) {
            hostedRetryAt_.insert(tid + u"|"_s + kind,
                                  Retry{nowMs() + 60'000, u"券商侧"_s + (status == u"Inactive" ? u"把这张托管单置为失效"_s : u"撤掉了这张托管单"_s), true});
        }
    } else if (status == u"Submitted" || status == u"PreSubmitted") {
        // 券商接受了这一版(新挂的或改过价的):之后再来的错误就不是"刚才那一下被拒"
        const EntryPtr entry = entryOf(tid, kind);
        if (entry) {
            entry->set(u"pending"_s, js::Null());
            entry->set(u"live"_s, js::B(true));
            // 部分成交:记住已成交的数量,对账改总量时不把剩下的再砍一截(见 syncHosted)
            const OJson* f = js::path(&trade, {u"orderStatus"_s, u"filled"_s});
            const std::optional<double> filled = js::finiteOrNull(js::nullish(f) ? nullptr : f);
            if (filled && *filled > 0) entry->set(u"filled"_s, js::N(*filled));
        }
    }
}

Rec HostedOrders::snapshot() const {
    Rec out = js::object();
    Rec hosted = js::object();
    for (const QString& tid : hosted_.keys()) {
        Rec kinds = js::object();
        for (const QString& kind : (*hosted_.find(tid))->entries.keys()) kinds.set(kind, **(*hosted_.find(tid))->entries.find(kind));
        hosted.set(tid, kinds);
    }
    out.set(u"hosted"_s, hosted);
    QStringList ids;
    for (const qint64 id : hostedIndex_.keys()) ids << QString::number(id);
    ids.sort();
    Rec index = js::object();
    for (const QString& id : ids) {
        const auto& v = hostedIndex_.value(id.toLongLong());
        index.set(id, js::array({js::S(v.first), js::S(v.second)}));
    }
    out.set(u"hostedIndex"_s, index);
    out.set(u"adopted"_s, js::B(hostedAdopted_));
    Rec covered = js::Null();
    if (lastCovered_) {
        QStringList l(lastCovered_->begin(), lastCovered_->end());
        l.sort();
        covered = js::strings(l);
    }
    out.set(u"lastCovered"_s, covered);
    QStringList synced(synced_.begin(), synced_.end());
    synced.sort();
    out.set(u"synced"_s, js::strings(synced));
    QStringList keys = hostedRetryAt_.keys();
    keys.sort();
    Rec retry = js::object();
    for (const QString& k : keys) {
        const Retry& r = hostedRetryAt_[k];
        Rec o = js::object({{u"at"_s, js::N(r.at)}, {u"reason"_s, js::S(r.reason)}});
        if (r.warn) o.set(u"warn"_s, js::B(true));
        retry.set(k, o);
    }
    out.set(u"retryAt"_s, retry);
    return out;
}

}  // namespace ibkr::orchestrate
