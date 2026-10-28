#include "parsing/follow.h"

#include "domain/follow_inbox.h"
#include "parsing/shorthand.h"
#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/py.h"
#include "util/tz.h"

#include <QRegularExpression>

#include <cmath>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;
namespace jm = ibkr::util::jsmath;

namespace ibkr::parsing::follow {

namespace {
QString et() { return QString::fromUtf16(util::kET); }
QString G(double v) { return util::pyG(v); }
bool isObj(const OJson* v) { return js::isObj(v); }

/// 在换过代理项的串上找、在原串上换(两串等长对齐,换上去的是同一段文字)
void replaceAll(QString& orig, QString& masked, const QRegularExpression& re, const QString& with) {
    QString o, m;
    qsizetype last = 0;
    auto it = re.globalMatch(masked);
    while (it.hasNext()) {
        const auto mt = it.next();
        o += orig.mid(last, mt.capturedStart() - last) + with;
        m += masked.mid(last, mt.capturedStart() - last) + with;
        last = mt.capturedEnd();
    }
    orig = o + orig.mid(last);
    masked = m + masked.mid(last);
}

struct FlyOrder {
    QString summary;
    double center = 0, quantity = 0, wing = 0;
    std::optional<double> premium;
};
struct CreditOrder {
    QString summary;
    double quantity = 0, width = 0;
    std::optional<double> credit;
};
/// orders 恰好一张、contract / order 都是对象:回那一张
const OJson* onlyOrder(const OJson& payload) {
    const OJson* orders = payload.get(u"orders"_s);
    if (!js::isArr(orders) || orders->items.size() != 1 || !isObj(&orders->items[0])) return nullptr;
    const OJson* item = &orders->items[0];
    if (!isObj(item->get(u"contract"_s)) || !isObj(item->get(u"order"_s))) return nullptr;
    return item;
}
std::vector<double> strikesOf(const OJson* legs) {
    std::vector<double> out;
    for (const OJson& leg : legs->items) out.push_back(isObj(&leg) ? js::num(leg.get(u"strike"_s)) : std::nan(""));
    return out;
}
std::optional<double> priceOf(const OJson* raw) {
    if (js::nullish(raw)) return std::nullopt;
    return js::num(raw);
}
bool strEq(const OJson* v, const char16_t* s) { return js::isStr(v) && v->s == QString::fromUtf16(s); }

std::optional<FlyOrder> readFly(const OJson& payload) {
    const OJson* item = onlyOrder(payload);
    if (!item) return std::nullopt;
    const OJson* contract = item->get(u"contract"_s);
    const OJson* order = item->get(u"order"_s);
    if (!strEq(contract->get(u"combo_strategy"_s), u"BUTTERFLY") || !strEq(order->get(u"action"_s), u"BUY")) return std::nullopt;
    const OJson* legs = contract->get(u"legs"_s);
    if (!js::isArr(legs) || legs->items.size() != 3) return std::nullopt;
    const std::vector<double> strikes = strikesOf(legs);
    const double wing = strikes[1] - strikes[0];
    const double quantity = js::num(order->get(u"totalQuantity"_s));
    const std::optional<double> premium = priceOf(order->get(u"lmtPrice"_s));
    if (!(wing > 0) || !(quantity >= 1) || (premium && !(*premium > 0))) return std::nullopt;
    return FlyOrder{js::strOr(item->get(u"intent_summary"_s), QString()), strikes[1], quantity, wing, premium};
}

std::optional<CreditOrder> readCredit(const OJson& payload) {
    const OJson* item = onlyOrder(payload);
    if (!item) return std::nullopt;
    const OJson* contract = item->get(u"contract"_s);
    const OJson* order = item->get(u"order"_s);
    if (!strEq(contract->get(u"combo_strategy"_s), u"VERTICAL") || !strEq(order->get(u"action"_s), u"SELL")) return std::nullopt;
    const OJson* legs = contract->get(u"legs"_s);
    if (!js::isArr(legs) || legs->items.size() != 2) return std::nullopt;
    const std::vector<double> strikes = strikesOf(legs);
    const double width = std::fabs(strikes[1] - strikes[0]);
    const double quantity = js::num(order->get(u"totalQuantity"_s));
    const std::optional<double> credit = priceOf(order->get(u"lmtPrice"_s));
    if (!(width > 0) || !(quantity >= 1) || (credit && !(*credit > 0 && *credit < width))) return std::nullopt;
    return CreditOrder{js::strOr(item->get(u"intent_summary"_s), QString()), quantity, width, credit};
}
}  // namespace

QString orderText(const QString& content) {
    QString orig = util::jsNormalizeNfkc(content);
    QString masked = util::jsMaskLoneSurrogates(orig);
    static const QRegularExpression mention(u"<[@#][!&]?\\d+>"_s);
    static const QRegularExpression everyone(u"@(?:everyone|here)(?![A-Za-z])"_s, QRegularExpression::CaseInsensitiveOption);
    static const QRegularExpression spaces(u"["_s + util::jsSpaceClassBody() + u"]+"_s);
    replaceAll(orig, masked, mention, u" "_s);
    replaceAll(orig, masked, everyone, u" "_s);
    replaceAll(orig, masked, spaces, u" "_s);
    return util::jsTrim(orig);
}

std::optional<QString> whyUnparsed(const QString& text) {
    if (shorthand::spreadWithoutType(text)) return u"像一张贷方价差,但没写 bull put 还是 bear call:行权价贴着现价时方向猜不得,没有发单"_s;
    return std::nullopt;
}

Triage triage(const contract::FollowConfig& cfg, const FollowMessage& message, double nowMs) {
    const bool wanted = message.channel_id == domain::kLocalChannel ? cfg.local_inbox : !cfg.channel_id.isEmpty() && message.channel_id == cfg.channel_id;
    if (!wanted) return {u"other_channel"_s, {}};
    if (!cfg.author_ids.contains(message.author_id)) return {u"untrusted"_s, {}};
    if (!shorthand::looksLikeOrder(orderText(message.content))) return {u"chatter"_s, {}};
    const double ageSeconds = std::floor((nowMs - message.sentAtMs) / 1000);
    if (ageSeconds > cfg.max_age_seconds)
        return {u"stale"_s, u"消息已经发出 %1 秒,超过 %2 秒不跟(断线后补到的旧消息,或者本机时钟偏快)"_s.arg(util::jsNumberToString(ageSeconds),
                                                                                                   util::jsNumberToString(cfg.max_age_seconds))};
    return {u"parse"_s, {}};
}

std::optional<CenterProblem> relativeCenterProblem(const OJson& payload, double spot) {
    if (!isObj(&payload) || !std::isfinite(spot)) return std::nullopt;
    const auto fly = readFly(payload);
    if (!fly || !std::isfinite(fly->center)) return std::nullopt;
    const double distance = std::fabs(fly->center - spot);
    if (distance < kRelativeCenterMaxPoints) return std::nullopt;
    const double other = fly->center + (spot > fly->center ? 100 : -100);
    return CenterProblem{u"「N蝴蝶」按现价的百位算成中心 "_s + G(fly->center) + u",离现价 "_s + G(util::jsRound(spot * 100) / 100) + u" 有 "_s +
                             G(util::jsRound(distance)) + u" 点;"_s + u"现价在两个百位之间时,说的可能是 "_s + G(other) + u",没法确定,没有发单(写明完整中心,如 "_s +
                             G(other) + u"蝴蝶,就能跟)"_s,
                         fly->summary};
}

double worstCaseUsd(double quantity, std::optional<double> premium, double wing) {
    return util::jsRound(quantity * 100 * (premium ? *premium : wing) * 100) / 100;
}

double creditWorstCaseUsd(double quantity, double credit, double width) {
    return util::jsRound(quantity * 100 * jm::max(width - credit, 0) * 100) / 100;
}

OJson Decision::toJson() const {
    if (summaryFirst) return js::object({{u"outcome"_s, js::S(outcome)}, {u"summary"_s, js::S(summary)}, {u"detail"_s, js::S(detail)}});
    return js::object({{u"outcome"_s, js::S(outcome)}, {u"detail"_s, js::S(detail)}, {u"summary"_s, js::S(summary)}});
}

Decision decide(const contract::FollowConfig& cfg, const OJson& payload, const FollowGates& gates, double sentToday) {
    if (!isObj(&payload)) return {u"unparsed"_s, u"看着像一张单子,但本地速记没有完整接住;跟单不交给大模型猜,没有发单"_s, {}, false};
    const OJson* rejections = payload.get(u"rejections"_s);
    if (js::isArr(rejections) && !rejections->items.isEmpty() && isObj(&rejections->items[0]))
        return {u"rejected"_s, js::strOr(rejections->items[0].get(u"message"_s), u"本地速记拒绝了这一条"_s), {}, false};
    const auto fly = readFly(payload);
    const auto spread = fly ? std::nullopt : readCredit(payload);
    if (!fly && !spread) return {u"unparsed"_s, u"解析出来的不是恰好一张买入蝴蝶或一张贷方价差,没有发单"_s, {}, false};
    const QString summary = fly ? fly->summary : spread->summary;
    if (fly && !fly->premium)
        return {u"unparsed"_s, u"这条消息没写权利金上限(对方可能把价格放在了下一条里),软件不替人定价,没有发单"_s, summary};
    if (spread && !spread->credit)
        return {u"unparsed"_s, u"这条消息没写收的权利金(对方可能把价格放在了下一条里),软件不替人定价,没有发单"_s, summary};
    const double risk = fly ? worstCaseUsd(fly->quantity, fly->premium, fly->wing) : creditWorstCaseUsd(spread->quantity, *spread->credit, spread->width);
    if (risk > cfg.max_risk_usd) {
        const QString how = spread ? u"(宽 "_s + G(spread->width) + u" 点 − 收 "_s + G(*spread->credit) + u")"_s : QString();
        return {u"capped"_s, u"这一单最坏亏 $"_s + G(risk) + how + u",超过跟单的单笔上限 $"_s + G(cfg.max_risk_usd), summary};
    }
    if (!cfg.enabled) return {u"observed"_s, u"只观察,没有发单(这一单最坏亏 $"_s + G(risk) + u")"_s, summary};
    if (gates.breaker) return {u"blocked"_s, u"熔断中("_s + *gates.breaker + u"),没有发单"_s, summary};
    if (!gates.connected) return {u"blocked"_s, u"没有连接券商,没有发单"_s, summary};
    if (sentToday >= cfg.max_orders_per_day)
        return {u"capped"_s, u"今天已经跟了 %1 单,到了每天 %2 单的上限"_s.arg(util::jsNumberToString(sentToday), util::jsNumberToString(cfg.max_orders_per_day)), summary};
    return {u"send"_s, {}, summary};
}

OutcomeResult outcomeOf(const OJson& result) {
    const auto list = [&](const char16_t* k) -> QList<OJson> {
        const OJson* v = result.get(QString::fromUtf16(k));
        return js::isArr(v) ? v->items : QList<OJson>{};
    };
    QList<OJson> sent = list(u"submitted");
    sent += list(u"queued");
    const QList<OJson> validated = list(u"validated_only"), rejections = list(u"rejections"), warnings = list(u"warnings");
    QStringList rejected;
    for (const OJson& r : rejections) rejected << js::str(js::propStrict(&r, u"message"_s));
    if (!sent.isEmpty()) {
        QStringList accounts, ids;
        for (const OJson& o : sent) {
            accounts << js::str(js::propStrict(&o, u"account"_s));
            ids << js::str(js::prop(&o, u"record_id"_s));
        }
        QStringList parts{u"已发出 %1 笔("_s.arg(sent.size()) + accounts.join(u"、"_s) + u")"_s};
        if (!validated.isEmpty()) parts << u"%1 笔过了校验但没发"_s.arg(validated.size());
        if (!rejected.isEmpty()) parts << u"%1 笔被拒:"_s.arg(rejected.size()) + rejected[0];
        return {u"sent"_s, parts.join(u';'), ids};
    }
    if (!validated.isEmpty()) {
        QStringList ids;
        for (const OJson& o : validated) ids << js::str(js::propStrict(&o, u"record_id"_s));
        return {u"held"_s, u"过了校验但没有发出(保护规则暂停中,或自动执行刚被关掉),详见这条记录"_s, ids};
    }
    QStringList ids;
    for (const OJson& r : rejections)
        if (const OJson* id = r.get(u"record_id"_s); js::isStr(id)) ids << id->s;
    const QString detail = !rejected.isEmpty() ? rejected[0] : !warnings.isEmpty() ? js::str(&warnings[0]) : u"没有产生订单"_s;
    return {u"rejected"_s, detail, ids};
}

std::optional<LeaderPrice> leaderPrice(const OJson& contract, const OJson& order) {
    const OJson* lmt = js::prop(&order, u"lmtPrice"_s);
    const double price = js::nullish(lmt) ? std::nan("") : js::num(lmt);
    if (!(price > 0)) return std::nullopt;
    const OJson* strategy = js::prop(&contract, u"combo_strategy"_s);
    const OJson* action = js::prop(&order, u"action"_s);
    if (strEq(strategy, u"BUTTERFLY") && strEq(action, u"BUY")) return LeaderPrice{u"debit"_s, price};
    if (strEq(strategy, u"VERTICAL") && strEq(action, u"SELL")) return LeaderPrice{u"credit"_s, price};
    return std::nullopt;
}

OJson followQuote(const LeaderPrice& leader, double signedMid, double signedNatural, double lagMs, bool paper) {
    const double sign = leader.side == u"debit" ? 1 : -1;
    const double mid = sign * signedMid, natural = sign * signedNatural;
    if (!(mid > 0) || !std::isfinite(natural) || !std::isfinite(lagMs)) return OJson::null();
    return js::object({{u"side"_s, js::S(leader.side)},
                       {u"leader"_s, js::N(leader.price)},
                       {u"mid"_s, js::N(util::pyRound(mid, 4))},
                       {u"natural"_s, js::N(util::pyRound(natural, 4))},
                       {u"lag_s"_s, js::N(jm::max(0, util::jsRound(lagMs / 1000)))},
                       {u"paper"_s, js::B(paper)}});
}

OJson flyTrackParams(const QString& key, const QString& exitAt) {
    const OJson empty = js::S(QString());
    return js::object({{u"key"_s, js::S(key)},
                       {u"take_profit"_s, empty},
                       {u"stop_loss"_s, empty},
                       {u"trail_pct"_s, empty},
                       {u"profit_drawdown_pct"_s, empty},
                       {u"profit_drawdown_preset"_s, js::S(u"fly"_s)},
                       {u"profit_drawdown_arm_pct"_s, empty},
                       {u"spot_target"_s, empty},
                       {u"spot_stop_below"_s, empty},
                       {u"spot_stop_above"_s, empty},
                       {u"auto_close"_s, js::B(true)},
                       {u"order_type"_s, js::S(u"LMT"_s)},
                       {u"host_at_broker"_s, js::B(false)},
                       {u"exit_at"_s, js::S(util::jsTrim(exitAt))},
                       {u"spot_stop_confirm_s"_s, empty},
                       {u"take_profit_tiers"_s, empty},
                       {u"stop_basis"_s, js::S(u"mid"_s)},
                       {u"note"_s, js::S(kFollowTrackNote)}});
}

OJson PendingTrack::toJson() const {
    OJson o = js::object({{u"record_id"_s, js::S(record_id)},
                          {u"message_id"_s, js::S(message_id)},
                          {u"account"_s, js::S(account)},
                          {u"symbol"_s, js::S(symbol)},
                          {u"leg"_s, js::S(leg)},
                          {u"summary"_s, js::S(summary)},
                          {u"at_ms"_s, js::N(at_ms)}});
    if (settled_fills) o.set(u"settled_fills"_s, js::N(*settled_fills));
    if (!side.isEmpty()) o.set(u"side"_s, js::S(side));
    if (stop_below) o.set(u"stop_below"_s, js::N(*stop_below));
    if (stop_above) o.set(u"stop_above"_s, js::N(*stop_above));
    return o;
}

std::vector<PendingTrack> pendingTracksOf(const OJson* raw) {
    std::vector<PendingTrack> out;
    if (!js::isArr(raw)) return out;
    for (const OJson& item : raw->items) {
        if (!isObj(&item)) continue;
        const auto text = [&](const char16_t* k) {
            const OJson* v = item.get(QString::fromUtf16(k));
            return js::isStr(v) ? v->s : QString();
        };
        PendingTrack row{text(u"record_id"), text(u"message_id"), text(u"account"), text(u"symbol"), text(u"leg"), text(u"summary"),
                         js::num(item.get(u"at_ms"_s)), std::nullopt};
        if (const OJson* settled = item.get(u"settled_fills"_s); js::isNum(settled) && std::isfinite(settled->n) && settled->n >= 0) row.settled_fills = settled->n;
        row.side = text(u"side");
        for (const auto& [k, slot] : {std::pair{u"stop_below", &row.stop_below}, std::pair{u"stop_above", &row.stop_above}}) {
            if (const OJson* v = item.get(QString::fromUtf16(k)); js::isNum(v) && std::isfinite(v->n) && v->n > 0) *slot = v->n;
        }
        if (!row.record_id.isEmpty() && !row.account.isEmpty() && !row.symbol.isEmpty() && !row.leg.isEmpty() && std::isfinite(row.at_ms)) out.push_back(row);
    }
    return out;
}

QString pendingLastDay(const QString& leg, double atMs) {
    const QString created = util::dateStrAt(atMs, et());
    const QString raw = leg.left(8);
    static const QRegularExpression ymd(u"^[0-9]{8}\\z"_s);
    const QString expiry = ymd.match(raw).hasMatch() ? raw.left(4) + u'-' + raw.mid(4, 2) + u'-' + raw.mid(6, 2) : created;
    return expiry > created ? util::ordinalToDate(util::dateOrdinal(created) + 1) : created;
}

std::optional<double> creditTakeProfit(double unitCredit) {
    if (!(unitCredit > 0) || !std::isfinite(unitCredit)) return std::nullopt;
    const double tp = util::pyRound(unitCredit * (100 - kCreditTakeProfitPct) / 100, 2);
    return tp > 0 ? std::optional(tp) : std::nullopt;
}

std::optional<double> creditStopLoss(double unitCredit) {
    if (!(unitCredit > 0) || !std::isfinite(unitCredit)) return std::nullopt;
    return util::pyRound(unitCredit * (100 + kCreditStopLossPct) / 100, 2);
}

OJson creditTrackParams(const QString& key, const QString& exitAt, std::optional<double> takeProfit, std::optional<double> stopLoss,
                        std::optional<double> stopBelow, std::optional<double> stopAbove) {
    const OJson empty = js::S(QString());
    const auto numText = [&](std::optional<double> v) { return v ? js::S(util::jsNumberToString(*v)) : empty; };
    return js::object({{u"key"_s, js::S(key)},
                       {u"take_profit"_s, numText(takeProfit)},
                       {u"stop_loss"_s, numText(stopLoss)},
                       {u"trail_pct"_s, empty},
                       {u"profit_drawdown_pct"_s, empty},
                       {u"profit_drawdown_arm_pct"_s, empty},
                       {u"spot_target"_s, empty},
                       {u"spot_stop_below"_s, numText(stopBelow)},
                       {u"spot_stop_above"_s, numText(stopAbove)},
                       {u"auto_close"_s, js::B(true)},
                       {u"order_type"_s, js::S(u"LMT"_s)},
                       {u"host_at_broker"_s, js::B(false)},
                       {u"exit_at"_s, js::S(util::jsTrim(exitAt))},
                       {u"spot_stop_confirm_s"_s, empty},
                       {u"take_profit_tiers"_s, empty},
                       {u"stop_basis"_s, js::S(u"mid"_s)},
                       {u"note"_s, js::S(kFollowTrackNote)}});
}

StopClause takeStopClause(const QString& text) {
    static const QRegularExpression spread(u"bull\\s*put|bear\\s*call"_s, QRegularExpression::CaseInsensitiveOption);
    static const QRegularExpression clause(u"[,，。;；\\s]*(?:站稳|跌破|突破|破)\\s*(\\d{2,5}(?:\\.\\d+)?)\\s*(?:点)?\\s*(?:就)?\\s*止损[,，。!！\\s]*"_s);
    if (!spread.match(text).hasMatch()) return {text, std::nullopt};
    const QRegularExpressionMatch m = clause.match(text);
    if (!m.hasMatch()) return {text, std::nullopt};
    QString rest = text;
    rest.replace(m.capturedStart(0), m.capturedLength(0), u" "_s);
    return {util::jsTrim(rest), m.captured(1)};
}

SpreadStop resolveSpreadStop(const QString& level, bool bullPut, std::optional<double> spot) {
    SpreadStop out;
    const QString side = bullPut ? u"下方"_s : u"上方"_s;
    if (!spot || !(*spot > 0)) {
        out.note = u"拿不到标的现价,止损线「%1」没有设"_s.arg(level);
        return out;
    }
    double at = level.toDouble();
    if (at < 100) {
        // 尾数:现价百位上的三个候选里,取这一侧离现价最近的
        const double base = std::floor(*spot / 100.0) * 100.0 + at;
        std::optional<double> best;
        for (const double c : {base - 100, base, base + 100}) {
            if (bullPut ? c < *spot && (!best || c > *best) : c > *spot && (!best || c < *best)) best = c;
        }
        // 离现价太远的那一档多半不是对方的意思(和「N蝴蝶」同一个上限):不猜
        if (std::fabs(*best - *spot) > kRelativeCenterMaxPoints) {
            out.note = u"止损线「%1」按现价 %2 落不到%3 %4 点以内,没有设"_s.arg(level, util::jsNumberToString(*spot), side,
                                                                           util::jsNumberToString(kRelativeCenterMaxPoints));
            return out;
        }
        at = *best;
    } else if (bullPut ? !(at < *spot) : !(at > *spot)) {
        out.note = u"止损线 %1 不在现价 %2 的%3(%4 只在%3设止损),没有设"_s.arg(level, util::jsNumberToString(*spot), side, bullPut ? u"bull put"_s : u"bear call"_s);
        return out;
    }
    (bullPut ? out.below : out.above) = at;
    return out;
}

QString pendingVerdict(const QString& leg, double atMs, const PendingFacts& facts) {
    if (util::dateStrAt(facts.nowMs, et()) > pendingLastDay(leg, atMs)) return u"expired"_s;
    if (!facts.filled) return facts.final_ ? u"unfilled"_s : u"wait"_s;
    if (!facts.held) return u"wait"_s;
    if (!*facts.held) return facts.final_ && facts.misses >= kPendingMissRounds ? u"no_position"_s : u"wait"_s;
    if (facts.track == u"active") return u"covered"_s;
    return facts.track == u"idle" ? u"idle_track"_s : u"create"_s;
}

QString remainderVerdict(const QString& leg, double atMs, std::optional<double> settledFills, double nowMs, bool final_, double fills, const QString& track) {
    const bool grew = fills > settledFills.value_or(0);
    if (grew && track != u"active") return u"late_fill"_s;
    if (final_ || util::dateStrAt(nowMs, et()) > pendingLastDay(leg, atMs)) return u"done"_s;
    return grew ? u"absorbed"_s : u"wait"_s;
}

QString trackExitsText(const OJson& track, double nowMs) {
    const OJson* t = js::prop(&track, u"targets"_s);
    QStringList parts;
    const OJson* tiersRaw = js::propStrict(t, u"profit_drawdown_tiers"_s);
    static const OJson emptyArr = js::array();
    const OJson* tiers = js::nullish(tiersRaw) ? &emptyArr : tiersRaw;
    // tiers.length 为真却不是数组(串):.map 抛
    if (js::isStr(tiers) && !tiers->s.isEmpty()) throw util::JsError(u"tiers.map is not a function"_s);
    if (js::isArr(tiers) && !tiers->items.isEmpty()) {
        const OJson* arm = js::prop(t, u"profit_drawdown_arm"_s);
        const QString armText = js::isNum(arm) && std::isfinite(arm->n) ? u"浮盈到过成本的 "_s + G(util::pyRound(arm->n * 100, 1)) + u"% 起算,"_s : QString();
        const OJson* late = js::prop(t, u"profit_drawdown_late"_s);
        QStringList pcts;
        for (const OJson& tier : tiers->items) pcts << js::pyG(js::propStrict(&tier, u"pct"_s));
        parts << u"蝶式预设:"_s + armText + u"从峰值回撤 "_s + pcts.join(u" / "_s) + u"% 就平"_s +
                     (js::truthy(late) ? u",美东 "_s + js::str(js::prop(late, u"after"_s)) + u" 之后阈值乘 "_s + js::pyG(js::prop(late, u"factor"_s)) : QString());
    }
    // 贷方价差那一份:止盈价、止损价与标的止损线
    if (const OJson* tp = js::prop(t, u"take_profit"_s); js::isNum(tp) && std::isfinite(tp->n))
        parts << u"组合价到 "_s + G(tp->n) + u" 就止盈"_s;
    if (const OJson* sl = js::prop(t, u"stop_loss"_s); js::isNum(sl) && std::isfinite(sl->n))
        parts << u"组合价到 "_s + G(sl->n) + u" 就止损"_s;
    if (const OJson* below = js::prop(t, u"spot_stop_below"_s); js::isNum(below) && std::isfinite(below->n)) parts << u"标的跌破 "_s + G(below->n) + u" 止损"_s;
    if (const OJson* above = js::prop(t, u"spot_stop_above"_s); js::isNum(above) && std::isfinite(above->n)) parts << u"标的突破 "_s + G(above->n) + u" 止损"_s;
    const OJson* exitAt = js::prop(t, u"exit_at"_s);
    if (js::truthy(exitAt)) {
        const OJson* atRaw = js::prop(t, u"exit_at_ms"_s);
        const std::optional<double> at = js::isNum(atRaw) && std::isfinite(atRaw->n) ? std::optional(atRaw->n) : std::nullopt;
        const bool later = at && util::dateStrAt(*at, et()) != util::dateStrAt(nowMs, et());
        parts << u"到点平仓:美东 "_s + (later ? util::dateStrAt(*at, et()).mid(5) + u" "_s : QString()) + js::str(exitAt) +
                     (later ? u"(今天的这个钟点已经过了)"_s : QString());
    }
    parts << (js::truthy(js::propStrict(js::propStrict(&track, u"auto_close"_s), u"enabled"_s)) ? u"到价由软件自动发平仓单"_s : u"只提醒,不自动平仓"_s);
    return parts.join(u';');
}

}  // namespace ibkr::parsing::follow
