#include "analysis/tracker_rules.h"

#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/py.h"
#include "util/tz.h"

#include <QDateTime>
#include <QRegularExpression>

#include <cmath>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;

namespace ibkr::analysis {

namespace {
const OJson* f(const OJson* o, const char16_t* k) { return js::prop(o, QString::fromUtf16(k)); }
QString et() { return QString::fromUtf16(util::kET); }
QString etDay(double ms) {
    const util::WallParts w = util::wallParts(ms, et());
    return u"%1-%2-%3"_s.arg(util::jsNumberToString(w.year), util::jsNumberToString(w.month), util::jsNumberToString(w.day));
}
/// {...o, k: v}(已有的键原位换值,新的键排在最后)
OJson with(OJson o, std::initializer_list<std::pair<QString, OJson>> kv) {
    for (const auto& [k, v] : kv) o.set(k, v);
    return o;
}
/// targets.x ?? [](数组以外的当空:TS 里 for…of 一个对象会抛,一个字符串逐字也都落空;引擎里永远是数组)
const QList<OJson>& listOf(const OJson* v) {
    static const QList<OJson> none;
    return js::isArr(v) ? v->items : none;
}
}  // namespace

const QString kTiersHostedIssue = u"分批止盈只支持软件盯盘:托管到券商的单是一组 OCA,一张成交券商就撤掉其余的,分不了批。关掉托管,或改用一个止盈价。"_s;

// ================================================================ 到点平仓
std::optional<double> clockMinutes(const OJson* hhmm) {
    static const QRegularExpression re(u"^([0-9]{1,2}):([0-9]{2})\\z"_s);
    const auto m = re.match(util::jsTrim(js::strOr(hhmm, QString())));
    if (!m.hasMatch()) return std::nullopt;
    const double h = m.captured(1).toDouble(), min = m.captured(2).toDouble();
    if (h > 23 || min > 59) return std::nullopt;
    return h * 60 + min;
}

std::optional<double> nextOccurrenceMs(const OJson* hhmm, double nowMs) {
    const auto minutes = clockMinutes(hhmm);
    if (!minutes || !std::isfinite(nowMs)) return std::nullopt;
    const util::WallParts now = util::wallParts(nowMs, et());
    for (int offset : {0, 1}) {
        const double dayMs = util::dateUtc(now.year, now.month - 1, now.day + offset);
        const QDate d = QDateTime::fromMSecsSinceEpoch(qint64(dayMs), QTimeZone::UTC).date();
        util::WallParts w;
        w.year = d.year();
        w.month = d.month();
        w.day = d.day();
        w.hour = std::floor(*minutes / 60);
        w.minute = std::fmod(*minutes, 60);
        w.second = 0;
        const double at = util::wallToEpoch(w, et());
        if (at > nowMs) return at;
    }
    return std::nullopt;
}

bool timeExitDue(const OJson& targets, double nowMs) {
    const auto at = js::finiteOrNull(f(&targets, u"exit_at_ms"));
    return at && nowMs >= *at && etDay(nowMs) == etDay(*at);
}

bool timeExitLapsed(const OJson& targets, double nowMs) {
    const auto at = js::finiteOrNull(f(&targets, u"exit_at_ms"));
    return at && nowMs >= *at && etDay(nowMs) != etDay(*at);
}

OJson withTimeExit(const OJson& result, const OJson& targets, double nowMs, const QString& holding) {
    if (js::str(f(&result, u"state")) != holding || !js::isStr(f(&result, u"state")) || !timeExitDue(targets, nowMs)) return result;
    return with(result, {{u"state"_s, js::S(kStateTimeExit)}, {u"reason"_s, js::S(u"到点平仓:已到美东 "_s + js::strOr(f(&targets, u"exit_at"), QString()))}});
}

// ================================================================ 分批止盈
std::optional<QString> tiersIssue(const OJson* tiers, bool isLong, const OJson* price) {
    const QList<OJson>& list = listOf(tiers);
    if (list.isEmpty()) return std::nullopt;
    if (list.size() > kMaxTpTiers) return u"分批止盈最多 %1 档。"_s.arg(kMaxTpTiers);
    std::optional<double> prev;
    for (qsizetype i = 0; i < list.size(); ++i) {
        const auto p = js::finiteOrNull(f(&list[i], u"price")), fr = js::finiteOrNull(f(&list[i], u"fraction_pct"));
        if (!p || !(*p > 0)) return u"分批止盈第 %1 档的价要是正数。"_s.arg(i + 1);
        if (!fr || !(*fr > 0 && *fr <= 100)) return u"分批止盈第 %1 档的比例要在 0(不含)到 100 之间。"_s.arg(i + 1);
        if (prev && (isLong ? *p <= *prev : *p >= *prev))
            return u"分批止盈各档的价要一档比一档%1(第 %2 档 %3 不在第 %4 档 %5 的更有利一侧)。"_s.arg(isLong ? u"高"_s : u"低"_s)
                .arg(i + 1)
                .arg(util::pyG(*p))
                .arg(i)
                .arg(util::pyG(*prev));
        prev = p;
    }
    // 方向只核对还没做的头一档:做完的档本来就在现价的另一侧
    qsizetype open = -1;
    for (qsizetype i = 0; i < list.size(); ++i)
        if (!js::truthy(f(&list[i], u"done"))) {
            open = i;
            break;
        }
    const auto now = js::finiteOrNull(price);
    const auto first = open >= 0 ? js::finiteOrNull(f(&list[open], u"price")) : std::nullopt;
    if (open >= 0 && now && first && (isLong ? *first <= *now : *first >= *now))
        return u"分批止盈第 %1 档要%2于现价(现价 %3,你填了 %4)——填在%5方会立刻触发。"_s.arg(open + 1)
            .arg(isLong ? u"高"_s : u"低"_s, util::fmtF(*now, 4), util::pyG(*first), isLong ? u"下"_s : u"上"_s);
    return std::nullopt;
}

int dueTier(const OJson* tiers, bool isLong, const OJson* price) {
    const QList<OJson>& list = listOf(tiers);
    const auto p = js::finiteOrNull(price);
    if (!p) return -1;
    for (const OJson& t : list)
        if (js::truthy(f(&t, u"pending"))) return -1;
    for (qsizetype i = 0; i < list.size(); ++i) {
        const OJson& t = list[i];
        const bool open = !js::truthy(f(&t, u"done")) && !js::truthy(f(&t, u"pending"));
        const double tp = js::num(f(&t, u"price"));
        if (open && (isLong ? *p >= tp : *p <= tp)) return int(i);
    }
    return -1;
}

std::optional<OJson> carryTierMarks(const OJson* next, const OJson* prev) {
    if (!next || next->type == OJson::Null) return std::nullopt;
    const QList<OJson>& n = listOf(next);
    const QList<OJson>& old = listOf(prev);
    bool same = old.size() == n.size();
    for (qsizetype i = 0; same && i < n.size(); ++i)
        same = js::strictEqual(f(&n[i], u"price"), f(&old[i], u"price")) && js::strictEqual(f(&n[i], u"fraction_pct"), f(&old[i], u"fraction_pct"));
    QList<OJson> out;
    for (qsizetype i = 0; i < n.size(); ++i) {
        OJson t = js::object();
        if (const OJson* p = f(&n[i], u"price")) t.set(u"price"_s, *p);
        if (const OJson* fp = f(&n[i], u"fraction_pct")) t.set(u"fraction_pct"_s, *fp);
        if (same && i < old.size() && js::truthy(f(&old[i], u"done"))) t.set(u"done"_s, js::B(true));
        out << t;
    }
    return js::array(out);
}

int pendingTier(const OJson* tiers) {
    const QList<OJson>& list = listOf(tiers);
    for (qsizetype i = 0; i < list.size(); ++i)
        if (js::truthy(f(&list[i], u"pending"))) return int(i);
    return -1;
}

OJson markTier(const OJson& tiers, int index, const OJson& patch) {
    QList<OJson> out;
    const QList<OJson>& list = listOf(&tiers);
    for (qsizetype i = 0; i < list.size(); ++i) {
        if (i != index) {
            out << list[i];
            continue;
        }
        OJson t = js::object();
        if (const OJson* p = f(&list[i], u"price")) t.set(u"price"_s, *p);
        if (const OJson* fp = f(&list[i], u"fraction_pct")) t.set(u"fraction_pct"_s, *fp);
        for (const auto& [k, v] : patch.fields) t.set(k, v);
        out << t;
    }
    return js::array(out);
}

OJson withTier(const OJson& result, const OJson& targets, bool isLong, const QString& holding, const QString& takeProfit) {
    if (js::str(f(&result, u"state")) != holding || !js::isStr(f(&result, u"state"))) return result;
    const OJson* tiers = f(&targets, u"take_profit_tiers");
    const int index = dueTier(tiers, isLong, f(&result, u"price"));
    if (index < 0 || index >= listOf(tiers).size()) return result;
    const OJson& tier = listOf(tiers)[index];
    return with(result, {{u"state"_s, js::S(takeProfit)},
                         {u"tier"_s, js::N(index)},
                         {u"reason"_s, js::S(u"分批止盈第 %1 档:现价 %2 %3 %4,平 %5%"_s.arg(index + 1)
                                                .arg(util::fmtF(js::num(f(&result, u"price")), 4), isLong ? u"涨到"_s : u"跌到"_s,
                                                     js::pyG(f(&tier, u"price")), js::pyG(f(&tier, u"fraction_pct"))))}});
}

// ================================================================ 追价节奏
bool isStopReason(const OJson* reason) {
    const QString text = js::strOr(reason, QString());
    const QString bare = text.contains(u':') ? text.mid(text.lastIndexOf(u':') + 1) : text;
    return bare == u"stop_loss" || bare == u"profit_trail";
}

ChaseProfile chaseProfile(const OJson& autoClose, const OJson* reason) {
    const ChaseProfile base{double(kChaseGraceRounds), double(kChaseStepTicks), std::max(0.0, js::finiteOrNull(f(&autoClose, u"chase_max_pct")).value_or(0))};
    if (!isStopReason(reason)) return base;
    const auto grace = js::finiteOrNull(f(&autoClose, u"stop_chase_grace")), step = js::finiteOrNull(f(&autoClose, u"stop_chase_step"));
    const auto maxPct = js::finiteOrNull(f(&autoClose, u"stop_chase_max_pct"));
    return {grace && *grace >= 0 ? std::trunc(*grace) : base.grace, step && *step >= 1 ? std::trunc(*step) : base.step, maxPct && *maxPct >= 0 ? *maxPct : base.maxPct};
}

// ================================================================ 止损的确认秒数
std::pair<OJson, std::optional<BreachClock>> confirmStockStop(const OJson& result, bool isLong, const OJson* confirmS, const std::optional<BreachClock>& clock,
                                                              double nowMs) {
    const auto need = js::finiteOrNull(confirmS);
    if (!need || !(*need > 0)) return {result, std::nullopt};
    if (js::nullish(f(&result, u"price")) && f(&result, u"price") && f(&result, u"price")->type == OJson::Null) return {result, clock};
    if (!(js::isStr(f(&result, u"state")) && f(&result, u"state")->s == u"stop_loss")) return {result, std::nullopt};
    const QString side = isLong ? u"below"_s : u"above"_s;
    const BreachClock next = clock && clock->side == side ? *clock : BreachClock{side, nowMs};
    const double held = std::max(0.0, (nowMs - next.sinceMs) / 1000);
    if (held >= *need) return {result, next};
    return {with(result, {{u"state"_s, js::S(u"holding"_s)},
                          {u"stop_pending"_s, js::object({{u"held_s"_s, js::N(std::floor(held))}, {u"need_s"_s, js::N(*need)}})},
                          {u"reason"_s, js::S(u"%1,已持续 %2 秒,满 %3 秒才平"_s.arg(js::str(f(&result, u"reason")), util::jsNumberToString(std::floor(held)), util::pyG(*need)))}}),
            next};
}

std::pair<OJson, std::optional<BreachClock>> confirmSpotStop(const OJson& row, const OJson* confirmS, const std::optional<BreachClock>& clock, double nowMs) {
    const auto need = js::finiteOrNull(confirmS);
    if (!need || !(*need > 0)) return {row, std::nullopt};
    const OJson* spot = f(&row, u"spot");
    if (spot && spot->type == OJson::Null) return {row, clock};
    const OJson* hit = f(&row, u"hit");
    if (hit && hit->type == OJson::Null) return {row, std::nullopt};
    const QString side = js::str(hit);
    const BreachClock next = clock && clock->side == side ? *clock : BreachClock{side, nowMs};
    const double held = std::max(0.0, (nowMs - next.sinceMs) / 1000);
    if (held >= *need) return {row, next};
    const OJson* line = side == u"below" ? f(&row, u"below") : f(&row, u"above");
    return {with(row, {{u"hit"_s, js::Null()},
                       {u"pending"_s, js::object({{u"side"_s, js::S(side)}, {u"held_s"_s, js::N(std::floor(held))}, {u"need_s"_s, js::N(*need)}})},
                       {u"reason"_s, js::S(u"标的已%1 %2,持续 %3 秒,满 %4 秒才平"_s.arg(side == u"below" ? u"跌破"_s : u"涨破"_s, util::pyG(js::num(line)),
                                                                                  util::jsNumberToString(std::floor(held)), util::pyG(*need)))}}),
            next};
}

// ================================================================ 利润回撤
namespace {
std::optional<double> minutesOfClock(const OJson* hhmm) {
    const QStringList parts = js::strOr(hhmm, QString()).split(u':');
    if (parts.size() != 2) return std::nullopt;
    const OJson a = OJson::string(parts[0]), b = OJson::string(parts[1]);
    const double h = js::num(&a), m = js::num(&b);
    if (!std::isfinite(h) || !std::isfinite(m)) return std::nullopt;
    return std::trunc(h) * 60 + std::trunc(m);
}
}  // namespace

std::optional<double> drawdownThreshold(const OJson& targets, const OJson* profitPeak, const OJson* basis, const OJson* minute) {
    std::optional<double> pct = js::finiteOrNull(f(&targets, u"profit_drawdown_pct"));
    const QList<OJson>& tiers = listOf(f(&targets, u"profit_drawdown_tiers"));
    const auto peak = js::finiteOrNull(profitPeak);
    const auto base = js::finiteOrNull(basis);
    if (!tiers.isEmpty() && peak && base && *base != 0) {
        const double ratio = *peak / std::abs(*base);
        std::optional<double> bestAbove;
        for (const OJson& tier : tiers) {
            const auto above = js::finiteOrNull(f(&tier, u"above"));
            const auto tierPct = js::finiteOrNull(f(&tier, u"pct"));
            if (!above || !tierPct || ratio < *above) continue;
            if (!bestAbove || *above >= *bestAbove) {
                bestAbove = above;
                pct = tierPct;
            }
        }
    }
    if (!pct) return std::nullopt;
    const OJson* late = f(&targets, u"profit_drawdown_late");
    const OJson* afterV = f(late, u"after");
    const auto after = js::truthy(afterV) ? minutesOfClock(afterV) : std::nullopt;
    const auto factor = js::finiteOrNull(f(late, u"factor"));
    const bool haveMinute = minute && minute->type != OJson::Null;
    if (after && factor && haveMinute && js::num(minute) >= *after) *pct *= *factor;
    return util::pyRound(*pct, 6);
}

bool drawdownArmed(const OJson& targets, const OJson* profitPeak, const OJson* basis) {
    const auto arm = js::finiteOrNull(f(&targets, u"profit_drawdown_arm"));
    const auto base = js::finiteOrNull(basis);
    if (!arm || !base || *base == 0) return true;
    const auto peak = js::finiteOrNull(profitPeak);
    return peak && *peak / std::abs(*base) >= *arm;
}

bool drawdownFloorMet(const OJson& targets, const OJson* peakPrice, const OJson* price) {
    const auto floor = js::finiteOrNull(f(&targets, u"profit_drawdown_floor"));
    if (!floor) return true;
    const auto pk = js::finiteOrNull(peakPrice), p = js::finiteOrNull(price);
    return pk && p && std::abs(*pk - *p) >= *floor - 1e-9;
}

// ================================================================ 标的止损价
bool hasSpotStop(const OJson& targets) {
    return js::finiteOrNull(f(&targets, u"spot_stop_below")).has_value() || js::finiteOrNull(f(&targets, u"spot_stop_above")).has_value();
}

std::optional<OJson> spotStop(const OJson& targets, const QString& symbol, const OJson* spot, const QString& spotNote) {
    if (!hasSpotStop(targets)) return std::nullopt;
    const auto below = js::finiteOrNull(f(&targets, u"spot_stop_below"));
    const auto above = js::finiteOrNull(f(&targets, u"spot_stop_above"));
    const auto s = js::finiteOrNull(spot);
    const std::optional<double> sp = s && *s > 0 ? s : std::nullopt;
    OJson out = js::object({{u"below"_s, js::NOrNull(below)}, {u"above"_s, js::NOrNull(above)}, {u"spot"_s, js::NOrNull(sp)}, {u"spot_note"_s, js::S(spotNote)},
                            {u"hit"_s, js::Null()}, {u"reason"_s, js::S(QString())}});
    if (!sp) {
        out.set(u"reason"_s, js::S(u"拿不到 %1 的现价,标的止损这一轮不判断"_s.arg(symbol)));
        return out;
    }
    QString hit;
    if (below && *sp <= *below) hit = u"below"_s;
    else if (above && *sp >= *above) hit = u"above"_s;
    if (!hit.isEmpty()) {
        out.set(u"hit"_s, js::S(hit));
        const double line = hit == u"below" ? *below : *above;
        out.set(u"reason"_s, js::S(u"标的止损触发:%1 现价 %2 %3 %4"_s.arg(symbol, util::fmtF(*sp, 2), hit == u"below" ? u"跌破"_s : u"涨破"_s, util::pyG(line))));
    }
    return out;
}

std::optional<QString> spotStopIssue(const OJson& targets, const QString& secType, const QString& symbol, const OJson* spot) {
    const OJson* lines[] = {f(&targets, u"spot_stop_below"), f(&targets, u"spot_stop_above")};
    if (js::nullish(lines[0]) && js::nullish(lines[1])) return std::nullopt;
    for (const OJson* v : lines)
        if (!js::nullish(v) && !(js::isNum(v) && std::isfinite(v->n) && v->n > 0)) return u"标的止损价必须是正数。"_s;
    if (secType == u"STK") return u"标的止损价只给期权与组合用:正股的标的就是它自己,直接填止损价。"_s;
    const auto below = js::finiteOrNull(lines[0]);
    const auto above = js::finiteOrNull(lines[1]);
    if (below && above && *below >= *above)
        return u"标的止损价的两条线填反了:「跌到」(%1)要低于「涨到」(%2)。"_s.arg(util::pyG(*below), util::pyG(*above));
    const auto s = js::finiteOrNull(spot);
    if (!s || !(*s > 0)) return u"拿不到 %1 的现价,核对不了标的止损价在现价的哪一侧——等行情来了再设。"_s.arg(symbol);
    if (below && *below >= *s)
        return u"「标的跌到」的止损价要低于 %1 现价(现价 %2,你填了 %3)——填在上方会立刻触发。"_s.arg(symbol, util::fmtF(*s, 2), util::pyG(*below));
    if (above && *above <= *s)
        return u"「标的涨到」的止损价要高于 %1 现价(现价 %2,你填了 %3)——填在下方会立刻触发。"_s.arg(symbol, util::fmtF(*s, 2), util::pyG(*above));
    return std::nullopt;
}

}  // namespace ibkr::analysis
