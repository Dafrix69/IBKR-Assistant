#include "analysis/fly_exit_sweep_spec.h"

#include "analysis/flyexit.h"
#include "analysis/playbook.h"
#include "analysis/tracker_rules.h"
#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/market_calendar.h"
#include "util/py.h"
#include "util/tz.h"

#include <QRegularExpression>
#include <QSet>

#include <algorithm>
#include <cmath>
#include <functional>

namespace ibkr::analysis::sweep {

using namespace Qt::StringLiterals;
using util::OJson;
namespace js = util::js;

namespace {

/// `${n}`
QString numStr(double v) { return util::jsNumberToString(v); }
QString etZone() { return QString::fromUtf16(util::kET); }

bool isFiniteNumber(const OJson* v) { return js::isNum(v) && std::isfinite(v->n); }

bool clockOk(const OJson& v) { return analysis::clockMinutes(&v).has_value(); }

/// checkKeys:写错的键名当场拒
void checkKeys(const OJson& raw, const QStringList& allowed, const QString& what) {
    QStringList unknown;
    for (const QString& k : js::keys(&raw))
        if (!allowed.contains(k)) unknown << k;
    if (!unknown.isEmpty())
        throw SweepError(u"%1里没有「%2」这一项(可用:%3)"_s.arg(what, unknown.join(u"、"_s), allowed.join(u"、"_s)));
}

bool isRecord(const OJson* v) { return js::isObj(v); }

}  // namespace

// ---------------------------------------------------------------- 样本与盘口
std::vector<SignedLeg> flyLegs(const FlySpec& fly) {
    return {{fly.center - fly.wing, fly.right, 1}, {fly.center, fly.right, -2}, {fly.center + fly.wing, fly.right, 1}};
}

double contractsPerFly() {
    double n = 0;
    for (const SignedLeg& leg : flyLegs({0, 1, u"C"_s})) n += std::fabs(leg.ratio);
    return n;
}

QString legKey(double strike, const QString& right) { return util::pyG(strike) + right.left(1).toUpper(); }

Book bookOf(const QuoteSample& sample) {
    Book book;
    for (const QuoteLeg& leg : sample.legs) book.insert(legKey(leg.strike, leg.right), leg);  // new Map(...):重复的键后一个盖前一个
    return book;
}

FlyQuote quoteFrom(const Book& book, const FlySpec& fly) {
    const std::vector<SignedLeg> legs = flyLegs(fly);
    std::vector<const QuoteLeg*> quotes;
    for (const SignedLeg& leg : legs) {
        const auto it = book.constFind(legKey(leg.strike, leg.right));
        quotes.push_back(it == book.constEnd() ? nullptr : &*it);
    }
    for (const QuoteLeg* q : quotes)
        if (!q) return {false, std::nullopt, std::nullopt, std::nullopt};
    double mid = 0, open = 0, close = 0;
    for (size_t i = 0; i < legs.size(); ++i) {
        const QuoteLeg* q = quotes[i];
        const std::optional<double> m = playbook::legMid(q->bid, q->ask);
        if (!m || !q->bid || !q->ask) return {true, std::nullopt, std::nullopt, std::nullopt};
        mid += legs[i].ratio * *m;
        open += legs[i].ratio * (legs[i].ratio > 0 ? *q->ask : *q->bid);
        close += legs[i].ratio * (legs[i].ratio > 0 ? *q->bid : *q->ask);
    }
    return {true, util::pyRound(std::fabs(mid), 4), util::pyRound(open, 4), util::pyRound(close, 4)};
}

FlyQuote flyQuote(const QuoteSample& sample, const FlySpec& fly) { return quoteFrom(bookOf(sample), fly); }

double flyIntrinsic(const FlySpec& fly, double spot) {
    const double sign = fly.right == u"P" ? -1 : 1;
    double acc = 0;
    for (const SignedLeg& leg : flyLegs(fly)) acc = acc + leg.ratio * util::jsmath::max(sign * (spot - leg.strike), 0);
    return util::pyRound(acc, 4);
}

double entryDebit(double mid, double open, double share, double tick) {
    const double raw = mid + share * (open - mid);
    return tick > 0 ? util::pyRound(std::ceil(raw / tick - 1e-9) * tick, 4) : util::pyRound(raw, 4);
}

// ---------------------------------------------------------------- 实盘预设的参数
LiveParams liveReference() {
    const OJson tiers = flyexit::drawdownTiers(nullptr), late = flyexit::drawdownLate(nullptr);
    const auto tierField = [&](qsizetype i, const QString& key) {
        const OJson* item = i < tiers.items.size() ? &tiers.items[i] : nullptr;
        const OJson* v = js::prop(item, key);
        return js::nullish(v) ? std::nan("") : js::num(v);  // tiers[i]?.pct ?? NaN
    };
    LiveParams p;
    p.arm_usd = flyexit::kFlyArmUsd;
    p.tighten_usd = flyexit::kFlyTightenUsd;
    p.loose_pct = tierField(0, u"pct"_s);
    p.mid_pct = tierField(1, u"pct"_s);
    p.tight_pct = tierField(2, u"pct"_s);
    p.tight_at = tierField(2, u"above"_s);
    p.late_after = js::str(late.get(u"after"_s));
    p.late_factor = js::num(late.get(u"factor"_s));
    p.floor = flyexit::drawdownFloor(nullptr);
    return p;
}

OJson liveTargets(const LiveParams& p, double unitCostUsd, double debit, double entryMs) {
    const double cost = std::fabs(unitCostUsd);
    const double tighten = util::pyRound(p.tighten_usd / cost, 6);
    OJson tiers = js::array({js::object({{u"above"_s, js::N(0.0)}, {u"pct"_s, js::N(p.loose_pct)}}),
                             js::object({{u"above"_s, js::N(tighten)}, {u"pct"_s, js::N(p.mid_pct)}})});
    if (p.tight_at > tighten) tiers.items.append(js::object({{u"above"_s, js::N(p.tight_at)}, {u"pct"_s, js::N(p.tight_pct)}}));
    OJson exitAt = OJson::null(), exitAtMs = OJson::null();
    if (p.exit_at) {
        exitAt = js::S(*p.exit_at);
        // 和界面设"到点平仓"同一个函数:入场时已经过了这个钟点的,是明天的——当天不会触发
        exitAtMs = js::NOrNull(analysis::nextOccurrenceMs(&exitAt, entryMs));
    }
    return js::object({
        {u"profit_drawdown_tiers"_s, tiers},
        {u"profit_drawdown_late"_s, js::object({{u"after"_s, js::S(p.late_after)}, {u"factor"_s, js::N(p.late_factor)}})},
        {u"profit_drawdown_arm"_s, js::N(util::pyRound(p.arm_usd / cost, 6))},
        {u"profit_drawdown_floor"_s, js::N(p.floor)},
        {u"stop_loss"_s, p.stop_mult ? js::N(util::pyRound(*p.stop_mult * debit, 4)) : OJson::null()},
        {u"exit_at"_s, exitAt},
        {u"exit_at_ms"_s, exitAtMs},
    });
}

double unitCost(double debit, double multiplier, const std::optional<double>& commission) {
    return debit * multiplier + contractsPerFly() * commission.value_or(0);
}

OJson liveRow(const LiveParams& p) {
    return js::object({
        {u"arm_usd"_s, js::N(p.arm_usd)},
        {u"tighten_usd"_s, js::N(p.tighten_usd)},
        {u"loose_pct"_s, js::N(p.loose_pct)},
        {u"mid_pct"_s, js::N(p.mid_pct)},
        {u"tight_pct"_s, js::N(p.tight_pct)},
        {u"tight_at"_s, js::N(p.tight_at)},
        {u"late_after"_s, js::S(p.late_after)},
        {u"late_factor"_s, js::N(p.late_factor)},
        {u"floor"_s, js::N(p.floor)},
        {u"stop_mult"_s, js::NOrNull(p.stop_mult)},
        {u"exit_at"_s, p.exit_at ? js::S(*p.exit_at) : OJson::null()},
    });
}

namespace {

/// 过了 checkLive 的那一份 JS 对象 → 结构体
LiveParams liveFrom(const OJson& r) {
    LiveParams p;
    p.arm_usd = r.get(u"arm_usd"_s)->n;
    p.tighten_usd = r.get(u"tighten_usd"_s)->n;
    p.loose_pct = r.get(u"loose_pct"_s)->n;
    p.mid_pct = r.get(u"mid_pct"_s)->n;
    p.tight_pct = r.get(u"tight_pct"_s)->n;
    p.tight_at = r.get(u"tight_at"_s)->n;
    p.late_after = r.get(u"late_after"_s)->s;
    p.late_factor = r.get(u"late_factor"_s)->n;
    p.floor = r.get(u"floor"_s)->n;
    if (const OJson* v = r.get(u"stop_mult"_s); v && v->type == OJson::Number) p.stop_mult = v->n;
    if (const OJson* v = r.get(u"exit_at"_s); v && v->type == OJson::String) p.exit_at = v->s;
    return p;
}

void checkLive(const OJson& r) {
    const auto pct = [](double v) { return v > 0 && v <= 100; };
    // 从 JSON 来的值可能是字符串:"50" 在比较里会被悄悄当成数,进了名字与去重就不是同一个东西了
    bool bad = false;
    for (const char16_t* key : {u"arm_usd", u"tighten_usd", u"loose_pct", u"mid_pct", u"tight_pct", u"tight_at", u"late_factor", u"floor"})
        if (!isFiniteNumber(r.get(QString::fromUtf16(key)))) bad = true;
    const OJson* lateAfter = r.get(u"late_after"_s);
    const OJson* stop = r.get(u"stop_mult"_s);
    const OJson* exitAt = r.get(u"exit_at"_s);
    if (bad || !js::isStr(lateAfter) || (!(stop && stop->type == OJson::Null) && !js::isNum(stop)) ||
        (!(exitAt && exitAt->type == OJson::Null) && !js::isStr(exitAt))) {
        throw SweepError(u"参数的取值类型不对:金额、百分比、倍数要是数,钟点要是 \"HH:MM\" 的字符串,不设写 null"_s);
    }
    const LiveParams p = liveFrom(r);
    if (!(p.arm_usd >= 0) || !(p.tighten_usd > 0))
        throw SweepError(u"起算线不能为负、收紧线要是正数(起算 %1、收紧 %2)"_s.arg(numStr(p.arm_usd), numStr(p.tighten_usd)));
    if (!pct(p.loose_pct) || !pct(p.mid_pct) || !pct(p.tight_pct)) throw SweepError(u"三档让的百分比都要在 0(不含)到 100 之间"_s);
    if (!(p.tight_at > 0)) throw SweepError(u"第三档的起点(浮盈 / 成本的倍数)要是正数"_s);
    if (!analysis::clockMinutes(lateAfter) || !(p.late_factor > 0))
        throw SweepError(u"尾盘收紧要写成 \"HH:MM\" 与一个正的系数(%1、%2)"_s.arg(p.late_after, numStr(p.late_factor)));
    if (!(p.floor >= 0)) throw SweepError(u"最少回吐不能为负"_s);
    if (p.stop_mult && !(*p.stop_mult > 0 && *p.stop_mult < 1))
        throw SweepError(u"止损倍数要在 0 到 1 之间(入场价的几成),收到 %1"_s.arg(numStr(*p.stop_mult)));
    if (p.exit_at && !analysis::clockMinutes(exitAt)) throw SweepError(u"到点平仓要写成 \"HH:MM\",收到 %1"_s.arg(*p.exit_at));
}

const QStringList& gridKeys() {
    static const QStringList keys{u"arm_usd"_s, u"tighten_usd"_s, u"tiers"_s,      u"tight_at"_s,  u"late_after"_s,
                                  u"late_factor"_s, u"floor"_s,   u"stop_mult"_s, u"exit_at"_s};
    return keys;
}

}  // namespace

std::vector<LiveParams> liveSets(const LiveParams& reference, const OJson* grid, const QList<OJson>& extra) {
    const OJson refRow = liveRow(liveReference());
    const QStringList paramKeys = js::keys(&refRow);
    const OJson empty = js::object();
    const OJson& g = grid ? *grid : empty;
    // 参照组是结构体,键名写不错:TS 里的 checkKeys(reference, …) 在这里不会拒任何东西
    checkKeys(g, gridKeys(), u"实盘预设的网格"_s);
    for (const OJson& e : extra) checkKeys(e, paramKeys, u"点名的参数组"_s);

    const OJson base = liveRow(reference);
    QList<OJson> combos{base};
    // cross:没给或给的是空 = 不动(取值不是数组的当没给:网格文件在 gridFileFrom 里已经要求是数组)
    const auto cross = [&](const QString& key, const std::function<OJson(OJson, const OJson&)>& apply) {
        const OJson* values = g.get(key);
        if (!js::isArr(values) || values->items.isEmpty()) return;
        QList<OJson> next;
        for (const OJson& p : combos)
            for (const OJson& v : values->items) next.append(apply(p, v));
        combos = next;
    };
    const auto put = [](const QString& key) {
        return [key](OJson p, const OJson& v) {
            p.set(key, v);
            return p;
        };
    };
    cross(u"arm_usd"_s, put(u"arm_usd"_s));
    cross(u"tighten_usd"_s, put(u"tighten_usd"_s));
    cross(u"tiers"_s, [](OJson p, const OJson& v) {
        const OJson* a = js::propStrict(&v, u"0"_s);
        const OJson* b = js::propStrict(&v, u"1"_s);
        const OJson* c = js::propStrict(&v, u"2"_s);
        // v[i] 缺了是 undefined:往后 typeof 不是数,checkLive 报类型不对——这里记成 null 也走同一句
        p.set(u"loose_pct"_s, js::copyOrNull(a));
        p.set(u"mid_pct"_s, js::copyOrNull(b));
        p.set(u"tight_pct"_s, js::copyOrNull(c));
        return p;
    });
    cross(u"tight_at"_s, put(u"tight_at"_s));
    cross(u"late_after"_s, put(u"late_after"_s));
    cross(u"late_factor"_s, put(u"late_factor"_s));
    cross(u"floor"_s, put(u"floor"_s));
    cross(u"stop_mult"_s, put(u"stop_mult"_s));
    cross(u"exit_at"_s, put(u"exit_at"_s));

    QList<OJson> all{base};
    all.append(combos);
    for (const OJson& e : extra) {
        OJson merged = base;
        for (const auto& [k, v] : e.fields) merged.set(k, v);  // {...reference, ...e}
        all.append(merged);
    }
    QSet<QString> seen;
    std::vector<LiveParams> out;
    for (const OJson& r : all) {
        checkLive(r);
        const LiveParams p = liveFrom(r);
        const QString key = js::stringify(liveRow(p));
        if (seen.contains(key)) continue;
        seen.insert(key);
        out.push_back(p);
    }
    return out;
}

QString liveLabel(const LiveParams& p, const LiveParams& reference) {
    QStringList parts;
    if (p.arm_usd != reference.arm_usd) parts << u"起算 $%1"_s.arg(util::pyG(p.arm_usd));
    if (p.tighten_usd != reference.tighten_usd) parts << u"收紧 $%1"_s.arg(util::pyG(p.tighten_usd));
    if (p.loose_pct != reference.loose_pct || p.mid_pct != reference.mid_pct || p.tight_pct != reference.tight_pct)
        parts << u"档位 %1/%2/%3"_s.arg(util::pyG(p.loose_pct), util::pyG(p.mid_pct), util::pyG(p.tight_pct));
    if (p.tight_at != reference.tight_at) parts << u"第三档 %1×成本起"_s.arg(util::pyG(p.tight_at));
    if (p.late_after != reference.late_after || p.late_factor != reference.late_factor)
        parts << u"%1 后 ×%2"_s.arg(p.late_after, util::pyG(p.late_factor));
    if (p.floor != reference.floor) parts << u"最少回吐 %1"_s.arg(util::pyG(p.floor));
    if (p.stop_mult != reference.stop_mult) parts << (p.stop_mult ? u"止损 %1×D"_s.arg(util::pyG(*p.stop_mult)) : u"不设止损"_s);
    if (p.exit_at != reference.exit_at) parts << (p.exit_at ? u"%1 平"_s.arg(*p.exit_at) : u"不设到点"_s);
    return parts.isEmpty() ? u"参照组(现行)"_s : parts.join(u" · "_s);
}

// ---------------------------------------------------------------- 回放策略的参数
QList<ReplayOverride> replaySets(const OJson* grid) {
    const OJson& defaults = flyexit::defaults();
    QList<ReplayOverride> combos{js::object()};
    if (grid) {
        for (const auto& [key, values] : grid->fields) {
            if (!defaults.get(key) || key == u"em") {
                QStringList scannable;
                for (const QString& k : js::keys(&defaults))
                    if (k != u"em") scannable << k;
                throw SweepError(u"回放策略没有参数 %1(可扫:%2)"_s.arg(key, scannable.join(u"、"_s)));
            }
            const bool isClock = analysis::flyexit::isClockKey(key);
            // 取值不是数组的当没给(网格文件在 gridFileFrom 里已经要求是数组)
            if (!js::isArr(&values)) continue;
            for (const OJson& v : values.items) {
                const bool ok = isClock ? (v.type == OJson::String && clockOk(v)) : (v.type == OJson::Number && v.n > 0);
                if (!ok) throw SweepError(u"回放参数 %1 的取值 %2 不对(%3)"_s.arg(key, js::str(&v), isClock ? u"\"HH:MM\""_s : u"正数"_s));
            }
            if (!values.items.isEmpty()) {
                QList<ReplayOverride> next;
                for (const ReplayOverride& c : combos)
                    for (const OJson& v : values.items) {
                        ReplayOverride o = c;
                        o.set(key, v);
                        next.append(o);
                    }
                combos = next;
            }
        }
    }
    QSet<QString> seen;
    QList<ReplayOverride> out;
    QList<ReplayOverride> all{js::object()};
    all.append(combos);
    for (const ReplayOverride& c : all) {
        // JSON.stringify(Object.entries(c).filter(与默认值不同).sort()):默认的 sort 按每一项转成字符串("键,值")比
        QList<std::pair<QString, OJson>> entries;
        for (const auto& [k, v] : c.fields)
            if (!js::strictEqual(defaults.get(k), &v)) entries.append({k, v});
        std::stable_sort(entries.begin(), entries.end(), [](const auto& a, const auto& b) {
            return (a.first + u"," + js::str(&a.second)) < (b.first + u"," + js::str(&b.second));
        });
        OJson arr = js::array();
        for (const auto& [k, v] : entries) arr.items.append(js::array({js::S(k), v}));
        const QString key = js::stringify(arr);
        if (seen.contains(key)) continue;
        seen.insert(key);
        out.append(c);
    }
    return out;
}

QString replayLabel(const ReplayOverride& o) {
    const OJson& defaults = flyexit::defaults();
    QStringList parts;
    for (const auto& [k, v] : o.fields)
        if (!js::strictEqual(defaults.get(k), &v))
            parts << u"%1=%2"_s.arg(k, v.type == OJson::Number ? util::pyG(v.n) : js::str(&v));
    return parts.isEmpty() ? u"参照组(现行)"_s : parts.join(u" "_s);
}

// ---------------------------------------------------------------- 配置
std::optional<double> parseEntryTime(const QString& text) {
    const QString t = util::jsTrim(text);
    static const QRegularExpression wallRe(u"^([0-9]{4})-([0-9]{2})-([0-9]{2})[ T]([0-9]{1,2}):([0-9]{2})(?::([0-9]{2}))?\\z"_s);
    const QRegularExpressionMatch m = wallRe.match(t);
    if (m.hasMatch()) {
        util::WallParts w;
        w.year = m.captured(1).toDouble();
        w.month = m.captured(2).toDouble();
        w.day = m.captured(3).toDouble();
        w.hour = m.captured(4).toDouble();
        w.minute = m.captured(5).toDouble();
        w.second = m.captured(6).isEmpty() ? 0 : m.captured(6).toDouble();
        return util::zonedEpoch(w, etZone());
    }
    static const QRegularExpression zoneRe(u"(Z|[+-][0-9]{2}:?[0-9]{2})\\z"_s);
    if (!zoneRe.match(t).hasMatch()) return std::nullopt;  // 不带时区的别的写法:不猜
    const double ms = util::jsDateParse(t);
    if (!std::isfinite(ms)) return std::nullopt;
    return ms;
}

std::vector<RealEntry> entriesFrom(const OJson& raw) {
    if (!js::isArr(&raw)) throw SweepError(u"真实入场的清单要是一个数组"_s);
    std::vector<RealEntry> out;
    for (qsizetype i = 0; i < raw.items.size(); ++i) {
        const OJson& item = raw.items[i];
        const QString where = u"真实入场第 %1 笔"_s.arg(i + 1);
        if (!isRecord(&item)) throw SweepError(u"%1要是一个对象"_s.arg(where));
        checkKeys(item, {u"time"_s, u"center"_s, u"wing"_s, u"right"_s, u"quantity"_s, u"debit"_s}, where);
        const std::optional<double> t = parseEntryTime(js::strOr(item.get(u"time"_s), QString()));
        if (!t)
            throw SweepError(u"%1的 time 看不懂:「%2」(写成美东 \"YYYY-MM-DD HH:MM\" 或带时区的 ISO)"_s.arg(where, js::str(item.get(u"time"_s))));
        const double center = js::num(item.get(u"center"_s)), wing = js::num(item.get(u"wing"_s));
        const QString right = js::strOr(item.get(u"right"_s), QString()).left(1).toUpper();
        if (!(center > 0) || !(wing > 0) || (right != u"C" && right != u"P"))
            throw SweepError(u"%1要有 center、wing(正数)与 right(C / P)"_s.arg(where));
        RealEntry e;
        e.t = *t;
        e.center = center;
        e.wing = wing;
        e.right = right;
        if (const OJson* q = item.get(u"quantity"_s)) {
            const double quantity = js::num(q);
            if (!(std::isfinite(quantity) && std::floor(quantity) == quantity) || quantity < 1) throw SweepError(u"%1的 quantity 要是正整数"_s.arg(where));
            e.quantity = quantity;
        }
        if (const OJson* d = item.get(u"debit"_s)) {
            const double debit = js::num(d);
            if (!(debit > 0)) throw SweepError(u"%1的 debit 要是正数"_s.arg(where));
            e.debit = debit;
        }
        out.push_back(e);
    }
    return out;
}

GridFile gridFileFrom(const OJson& raw) {
    if (!isRecord(&raw)) throw SweepError(u"网格文件要是一个对象:{\"live\":{…},\"sets\":[…],\"replay\":{…}}"_s);
    checkKeys(raw, {u"live"_s, u"sets"_s, u"replay"_s}, u"网格文件"_s);
    const OJson empty = js::object(), noSets = js::array();
    const OJson* live = js::nullish(raw.get(u"live"_s)) ? &empty : raw.get(u"live"_s);
    const OJson* sets = js::nullish(raw.get(u"sets"_s)) ? &noSets : raw.get(u"sets"_s);
    const OJson* replay = js::nullish(raw.get(u"replay"_s)) ? &empty : raw.get(u"replay"_s);
    bool setsOk = js::isArr(sets);
    if (setsOk)
        for (const OJson& s : sets->items)
            if (!isRecord(&s)) setsOk = false;
    if (!isRecord(live) || !isRecord(replay) || !setsOk) throw SweepError(u"网格文件里 live 与 replay 要是对象,sets 要是对象的数组"_s);
    for (const OJson* section : {live, replay})
        for (const auto& [key, values] : section->fields)
            if (!js::isArr(&values)) throw SweepError(u"网格文件里 %1 的取值要写成数组"_s.arg(key));
    return {*live, *replay, sets->items};
}

}  // namespace ibkr::analysis::sweep
