#include "analysis/performance.h"

#include "analysis/inference.h"
#include "analysis/trade_similar.h"
#include "analysis/tradereview.h"
#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/market_js.h"
#include "util/collate.h"
#include "util/py.h"
#include "util/tz.h"

#include <algorithm>
#include <cmath>
#include <functional>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;
namespace jsmath = ibkr::util::jsmath;
namespace tr = ibkr::analysis::tradereview;
namespace inf = ibkr::analysis::inference;

namespace ibkr::analysis::performance {

namespace {

// ---------------------------------------------------------------- 小工具
const OJson* P(const OJson& o, const char16_t* k) { return js::prop(&o, QString::fromUtf16(k)); }
QString Sx(const OJson& o, const char16_t* k) { return js::str(P(o, k)); }
bool isStrEq(const OJson* v, const char16_t* s) { return js::isStr(v) && v->s == QString::fromUtf16(s); }
QString n2s(double v) { return util::jsNumberToString(v); }
/// 模板串里的 `${x}`:null 写成 "null"
QString tpl(const std::optional<double>& v) { return v ? n2s(*v) : u"null"_s; }
OJson optN(const std::optional<double>& v) { return v ? js::N(*v) : js::Null(); }
OJson optS(const std::optional<QString>& v) { return v ? js::S(*v) : js::Null(); }
double dateParse(const QString& s) { return util::jsDateParse(s); }

std::optional<double> num(const OJson* v) {
    if (js::nullish(v) || (v->type == OJson::String && v->s.isEmpty())) return std::nullopt;
    const double out = js::num(v);
    return std::isfinite(out) ? std::optional<double>(out) : std::nullopt;
}

std::optional<QString> isoOf(const OJson* value) {
    const auto when = tr::parseWhen(value);
    return when ? std::optional<QString>(util::utcIso(*when)) : std::nullopt;
}

std::optional<double> minutesBetween(const std::optional<QString>& from, const std::optional<QString>& to) {
    if (!from || !to) return std::nullopt;
    const double a = dateParse(*from);
    const double b = dateParse(*to);
    if (std::isnan(a) || std::isnan(b) || b < a) return std::nullopt;
    return util::pyRound((b - a) / 60'000, 1);
}

/// 账本里 R 那四栏
void riskFields(LedgerTrade& t, double pnl, const std::optional<double>& risk, const QString& basis, const QString& why) {
    if (risk && *risk > 0) {
        t.risk = util::pyRound(*risk, 2);
        t.r = util::pyRound(pnl / *risk, 2);
        t.risk_basis = basis;
        t.r_missing = std::nullopt;
        return;
    }
    t.risk = std::nullopt;
    t.r = std::nullopt;
    t.risk_basis = std::nullopt;
    t.r_missing = risk ? u"no_cost"_s : why;
}

/// pairs[id] 的 role / peer;id 是 Object.prototype 上的名字时 link 是真值,两样都是 undefined
struct Link {
    bool truthy = false;
    const OJson* role = nullptr;
    const OJson* peer = nullptr;
};
Link linkOf(const OJson& pairs, const QString& id) {
    if (const OJson* own = pairs.get(id)) return {true, own->get(u"role"_s), own->get(u"peer"_s)};
    return {tr::onObjectPrototype(id), nullptr, nullptr};
}

const QStringList kDebitRiskStructures{u"蝴蝶"_s, u"垂直价差"_s, u"单腿"_s};

// ---------------------------------------------------------------- 统计用
QString outcome(const LedgerTrade& t) { return std::fabs(t.pnl) < kFlatUsd ? u"flat"_s : t.pnl > 0 ? u"win"_s : u"loss"_s; }

std::optional<double> ratio(double a, double b) { return b > 0 ? std::optional<double>(util::pyRound(a / b, 2)) : std::nullopt; }

std::optional<Interval> rounded(double lo, double hi, int digits, double scale = 1) { return Interval{util::pyRound(lo * scale, digits), util::pyRound(hi * scale, digits)}; }
template <class T>
std::optional<Interval> roundedOpt(const std::optional<T>& ci, int digits, double scale = 1) {
    if (!ci) return std::nullopt;
    return rounded(ci->lo, ci->hi, digits, scale);
}
OJson toJsonI(const std::optional<Interval>& i) { return i ? js::object({{u"lo"_s, js::N(i->lo)}, {u"hi"_s, js::N(i->hi)}}) : js::Null(); }

QString dayOf(const LedgerTrade& t) { return tr::etKey(dateParse(t.closed_at), true); }

std::vector<inf::Clustered> decidedPnl(const Trades& trades) {
    std::vector<inf::Clustered> out;
    for (const LedgerTrade* t : trades)
        if (outcome(*t) != u"flat") out.push_back({t->pnl, dayOf(*t)});
    return out;
}

double mean(const std::vector<double>& xs) {
    double s = 0;
    for (const double x : xs) s = s + x;
    return s / double(xs.size());
}

std::optional<double> median(const std::vector<double>& xs) {
    if (xs.empty()) return std::nullopt;
    std::vector<double> s = xs;
    util::market::sortNumbers(s);
    const size_t mid = s.size() / 2;
    return s.size() % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

std::optional<double> kellyFrom(double decided, const std::optional<double>& winRate, const std::optional<double>& payoff) {
    if (decided < kMinGroup || !winRate || !payoff || *payoff <= 0) return std::nullopt;
    return util::pyRound(*winRate - (1 - *winRate) / *payoff, 3);
}

const QStringList kRMissingOrder{u"no_stop"_s, u"late_stop"_s, u"undefined_risk"_s, u"no_open"_s, u"no_cost"_s};
QString rMissingLabel(const QString& reason) {
    if (reason == u"no_stop") return u"股票,开仓后 "_s + n2s(kInitialStopMinutes) + u" 分钟内没设止损"_s;
    if (reason == u"late_stop") return u"股票,止损是开仓 "_s + n2s(kInitialStopMinutes) + u" 分钟之后才设的"_s;
    if (reason == u"undefined_risk") return u"期权,风险不止权利金(贷方、比例蝶、日历、不对称的卖出蝶)"_s;
    if (reason == u"no_open") return u"导入的期权出场事件,没配上开仓"_s;
    return u"开仓价或数量不明"_s;
}

QString sessionKey(const QString& label) {
    if (label == u"开盘半小时") return u"open30"_s;
    if (label == u"上午") return u"morning"_s;
    if (label == u"午后") return u"afternoon"_s;
    if (label == u"尾盘一小时") return u"close60"_s;
    if (label == u"盘外") return u"off"_s;
    return label;
}
const QStringList kSessionOrder{u"open30"_s, u"morning"_s, u"afternoon"_s, u"close60"_s, u"off"_s};
const QStringList kWeekdays{u"周日"_s, u"周一"_s, u"周二"_s, u"周三"_s, u"周四"_s, u"周五"_s, u"周六"_s};
QString kindLabel(const QString& kind) {
    if (kind == u"butterfly") return u"蝴蝶"_s;
    if (kind == u"stock") return u"股票"_s;
    if (kind == u"option") return u"期权(导入)"_s;
    return u"undefined"_s;  // KIND_LABEL[t.kind] 认不出的种类是 undefined,进对象之后 JSON 里没有这一键;这里写成 "undefined" 的串(生产里 kind 只有这三种)
}

double etWeekday(const QString& iso) {
    const util::WallParts p = util::wallParts(dateParse(iso), QString::fromUtf16(util::kET));
    const double ms = util::dateUtc(p.year, p.month - 1, p.day);
    const double days = std::floor(ms / 86'400'000);
    double wd = std::fmod(days + 4, 7);
    if (wd < 0) wd += 7;
    return wd;
}

struct PerfGroup {
    QString key, label;
    double trades = 0;
    std::optional<double> win_rate;
    double net_pnl = 0;
    std::optional<double> expectancy;
    std::optional<Interval> expectancy_ci;
    std::optional<double> profit_factor, payoff_ratio, kelly;
    double r_trades = 0;
    std::optional<double> expectancy_r, payoff_r, kelly_r, sqn;
};
OJson toJson(const PerfGroup& g) {
    return js::object({{u"key"_s, js::S(g.key)},
                       {u"label"_s, js::S(g.label)},
                       {u"trades"_s, js::N(g.trades)},
                       {u"win_rate"_s, optN(g.win_rate)},
                       {u"net_pnl"_s, js::N(g.net_pnl)},
                       {u"expectancy"_s, optN(g.expectancy)},
                       {u"expectancy_ci"_s, toJsonI(g.expectancy_ci)},
                       {u"profit_factor"_s, optN(g.profit_factor)},
                       {u"payoff_ratio"_s, optN(g.payoff_ratio)},
                       {u"kelly"_s, optN(g.kelly)},
                       {u"r_trades"_s, js::N(g.r_trades)},
                       {u"expectancy_r"_s, optN(g.expectancy_r)},
                       {u"payoff_r"_s, optN(g.payoff_r)},
                       {u"kelly_r"_s, optN(g.kelly_r)},
                       {u"sqn"_s, optN(g.sqn)}});
}

QList<PerfGroup> group(const Trades& trades, const std::function<std::optional<Session>(const LedgerTrade&)>& keyOf) {
    QStringList order;
    QHash<QString, QPair<QString, Trades>> buckets;
    for (const LedgerTrade* t : trades) {
        const auto k = keyOf(*t);
        if (!k) continue;
        if (!buckets.contains(k->key)) {
            order << k->key;
            buckets.insert(k->key, {k->label, {}});
        }
        buckets[k->key].second.push_back(t);
    }
    QList<PerfGroup> out;
    for (const QString& key : order) {
        const auto& [label, rows] = buckets[key];
        const PerfStats s = perfStats(rows);
        const PerfRStats r = rStats(rows);
        out.append({key, label, s.trades, s.win_rate, s.net_pnl, s.expectancy, s.expectancy_ci, s.profit_factor, s.payoff_ratio, kellyOf(s), r.trades,
                    r.expectancy_r, r.payoff_ratio, r.kelly, r.sqn});
    }
    return out;
}

// ---------------------------------------------------------------- 规则
QString money(double v) {
    const QString s = util::jsToFixed(std::fabs(v), 2);
    return v < 0 ? u"-$"_s + s : u"$"_s + s;
}

bool clearlyWorse(const Trades& a, const Trades& b, double level = inf::kConfidence) {
    const auto ci = inf::clusteredDiffInterval(decidedPnl(a), decidedPnl(b), level);
    return ci && ci->hi < 0;
}

struct Verdict {
    double quick = 0, rest = 0;
};
std::optional<Verdict> reentryVerdict(const Split& split) {
    if (split.quick.size() < 5 || split.rest.size() < 5) return std::nullopt;
    const auto q = perfStats(split.quick).expectancy;
    const auto r = perfStats(split.rest).expectancy;
    if (q && r && *q < 0 && clearlyWorse(split.quick, split.rest)) return Verdict{*q, *r};
    return std::nullopt;
}

struct Finding {
    QString id, tone, title, text, source;
};
OJson toJson(const Finding& f) {
    return js::object({{u"id"_s, js::S(f.id)}, {u"tone"_s, js::S(f.tone)}, {u"title"_s, js::S(f.title)}, {u"text"_s, js::S(f.text)}, {u"source"_s, js::S(f.source)}});
}

/// 体检里规则要读的那几样(TS 里读的是同一个 report 对象)
struct Report {
    PerfStats stats;
    PerfRStats r_stats;
    PerfRCoverage r_coverage;
    PerfDrawdown drawdown;
    std::optional<double> holdWin, holdLoss;
    std::optional<double> kelly;
    std::optional<PerfStats> recent;  // window 恒为 kRecentWindow
    PerDay per_day;
    QList<PerfGroup> kind, session;
};

const QString kExpectancySource = u"Van Tharp · 期望值 = 胜率 × 平均盈利 − 败率 × 平均亏损"_s;
const QString kOneDay = u"这些交易都在同一天了结,一天的行情定不出区间"_s;

std::optional<Finding> expectancyFinding(const Report& report) {
    const PerfStats& s = report.stats;
    const auto& ci = s.expectancy_ci;
    if (!s.expectancy || s.wins + s.losses < 5) return std::nullopt;
    const QString range = !ci ? QString() : u"95% 区间 "_s + money(ci->lo) + u" ~ "_s + money(ci->hi) + u"。"_s;
    QStringList kinds;
    for (const PerfGroup& g : report.kind) kinds << g.label;
    const QString tail = (s.win_rate && s.payoff_ratio ? u"胜率 "_s + n2s(*s.win_rate) + u"%、盈亏比 "_s + n2s(*s.payoff_ratio) + u",按这个盈亏比胜率至少要 "_s +
                                                             tpl(s.breakeven_win_rate) + u"% 才不亏。"_s
                                                       : QString()) +
                         (kinds.size() > 1 ? u"这是按美元算的:"_s + kinds.join(u"、"_s) + u"混着时,单笔金额大的那一类说了算,分开的数在「品种」表。"_s : QString());
    if (ci && ci->lo > 0) {
        return Finding{u"expectancy"_s, u"good"_s, u"期望值为正:平均每笔 "_s + money(*s.expectancy),
                       range + tail + u"利润因子 "_s + (s.profit_factor ? n2s(*s.profit_factor) : u"—"_s) + u"。"_s, kExpectancySource};
    }
    if (ci && ci->hi < 0) {
        return Finding{u"expectancy"_s, u"bad"_s, u"期望值为负:平均每笔 "_s + money(*s.expectancy), range + tail + u"在期望值转正之前,多做只会多亏。"_s, kExpectancySource};
    }
    const QString why = !ci ? kOneDay : u"区间跨着 0"_s;
    return Finding{u"expectancy"_s, u"info"_s, u"平均每笔 "_s + money(*s.expectancy) + u",正负还没分清"_s,
                   range + why + u":照这 "_s + n2s(s.wins + s.losses) + u" 笔,说它赚钱还是亏钱都早。"_s + tail, kExpectancySource};
}

std::optional<Finding> kellyFinding(const Report& report) {
    const bool byR = report.r_stats.kelly.has_value();
    const std::optional<double> kelly = report.r_stats.kelly ? report.r_stats.kelly : report.kelly;
    const std::optional<Interval> ci = byR ? report.r_stats.expectancy_ci : report.stats.expectancy_ci;
    if (!kelly) return std::nullopt;
    const QString basis = byR ? u"按 "_s + n2s(report.r_stats.trades) + u" 笔有 R 的交易算"_s
                              : u"按美元盈亏算"_s + (report.kind.size() > 1 ? u"(品种混着时,单笔金额大的那一类说了算)"_s : QString());
    if (ci && ci->hi < 0) {
        return Finding{u"kelly"_s, u"warn"_s, u"按统计没有下注优势(凯利比例 ≤ 0)"_s,
                       basis + u"。照现在的胜率与盈亏比,凯利公式给的是不下注。没有优势时,单笔风险应该压到最小,先把期望值做正。"_s,
                       u"Larry Williams(1987 World Cup 冠军)· 资金管理决定能不能活下来"_s};
    }
    const double pct = util::pyRound(*kelly * 100, 1);
    if (!ci || ci->lo <= 0) {
        const QString unsure = !ci ? kOneDay : u"期望值的 95% 区间跨着 0"_s;
        return Finding{u"kelly"_s, u"info"_s, u"凯利比例 "_s + n2s(pct) + u"%,现在还不能当真"_s,
                       basis + u"。"_s + unsure + u",有没有优势还没分清;凯利公式把眼下的胜率与盈亏比当成确定的,"_s +
                           (*kelly > 0 ? u"这点样本撑不起它给的这个数。"_s : u"眼下的数看不出优势,也还说不上一定没有。"_s),
                       u"Larry Williams · 凯利 / optimal f 只当上限参照"_s};
    }
    return Finding{u"kelly"_s, u"info"_s, u"凯利比例 "_s + n2s(pct) + u"%"_s,
                   basis + u"。这是理论上让长期增长最快的单笔风险(平均亏一笔亏掉账户的百分之几),波动极大。1/4 凯利约 "_s + n2s(util::pyRound(*kelly * 25, 1)) +
                       u"%;冠军们实际的单笔风险多在账户的 0.5%–2%。"_s,
                   u"Larry Williams · 凯利 / optimal f 只当上限参照"_s};
}

Trades sliceTrades(const Trades& t, long long from, long long to) {
    const auto r = util::market::sliceRange(qint64(t.size()), double(from), double(to));
    Trades out;
    for (long long i = r.from; i < r.to; ++i) out.push_back(t[size_t(i)]);
    return out;
}

QList<Finding> edgeFindings(const Trades& trades, const Report& report) {
    QList<Finding> out;
    const PerfStats& s = report.stats;
    if (const auto e = expectancyFinding(report)) out.append(*e);
    if (s.payoff_ratio && *s.payoff_ratio < 1 && s.win_rate && s.breakeven_win_rate && *s.win_rate < *s.breakeven_win_rate + 5) {
        const double gap = util::pyRound(*s.win_rate - *s.breakeven_win_rate, 1);
        out.append({u"payoff"_s, u"warn"_s, u"赚小亏大:平均亏损是平均盈利的 "_s + n2s(util::pyRound(1 / *s.payoff_ratio, 1)) + u" 倍"_s,
                    u"平均盈利 "_s + money(s.avg_win.value_or(0)) + u"、平均亏损 "_s + money(s.avg_loss.value_or(0)) + u"。"_s +
                        (gap >= 0 ? u"胜率只比保本线高 "_s + n2s(gap) + u" 个百分点,几笔不顺就翻成负的。"_s
                                  : u"胜率比保本线("_s + n2s(*s.breakeven_win_rate) + u"%)还低 "_s + n2s(-gap) + u" 个百分点:要么把亏损砍小,要么把盈利拿长。"_s),
                    u"Mark Minervini(1997 / 2021 美国投资锦标赛冠军)· 平均亏损要远小于平均盈利"_s});
    }
    const PerfRStats& r = report.r_stats;
    if (r.sqn) {
        const PerfRCoverage& cov = report.r_coverage;
        const QString part = (cov.with_r < cov.trades ? u"有 R 的只是 "_s + n2s(cov.trades) + u" 笔里的 "_s + n2s(cov.with_r) + u" 笔。"_s : QString()) +
                             (cov.flats != 0 ? u"其中 "_s + n2s(cov.flats) + u" 笔持平,不进统计。"_s : QString());
        const QString mixed = cov.max_loss != 0 && cov.stop != 0
                                  ? u"其中 "_s + n2s(cov.max_loss) + u" 笔的 R 按最大可亏、"_s + n2s(cov.stop) + u" 笔按初始止损,两种分母混着,分品种的在「品种」表。"_s
                                  : QString();
        out.append({u"sqn"_s, *r.sqn >= 2.5 ? u"good"_s : *r.sqn >= 1.6 ? u"info"_s : u"warn"_s, u"SQN "_s + n2s(*r.sqn) + u"("_s + r.sqn_label + u")"_s,
                    n2s(r.trades) + u" 笔有 R、分了输赢的交易,平均每笔 "_s + tpl(r.expectancy_r) + u"R,标准差 "_s + tpl(r.std_r) + u"R。"_s + part + mixed +
                        u"SQN 量的是期望值相对波动有多稳;1.6 以下时,这点期望值和运气还分不开。"_s,
                    u"Van Tharp · R 倍数与系统质量分 SQN"_s});
    }
    if (const auto k = kellyFinding(report)) out.append(*k);
    if (report.recent && report.stats.expectancy && report.recent->expectancy) {
        const double rec = *report.recent->expectancy;
        const double all = *report.stats.expectancy;
        const long long n = qint64(trades.size());
        const Trades latest = sliceTrades(trades, -kRecentWindow, n);
        const Trades earlier = sliceTrades(trades, 0, -kRecentWindow);
        const QString before = u"之前的 "_s + n2s(double(earlier.size())) + u" 笔平均每笔 "_s + money(perfStats(earlier).expectancy.value_or(0)) + u",全部样本 "_s + money(all) + u"。"_s;
        if (rec < 0 && all > 0 && clearlyWorse(latest, earlier)) {
            out.append({u"recent"_s, u"warn"_s, u"最近 "_s + n2s(kRecentWindow) + u" 笔在走弱:平均每笔 "_s + money(rec),
                        before + u"手感变差的时候先缩小仓位,等重新赚起来再一步步放回去。"_s, u"Mark Minervini · 渐进式仓位:赚钱时加、亏钱时减"_s});
        } else if (rec > all && rec > 0 && clearlyWorse(earlier, latest)) {
            out.append({u"recent"_s, u"good"_s, u"最近 "_s + n2s(kRecentWindow) + u" 笔好于平均:每笔 "_s + money(rec), before, u"Mark Minervini · 渐进式仓位:赚钱时加、亏钱时减"_s});
        }
    }
    return out;
}

QList<Finding> riskFindings(const Trades& trades, const Report& report, const OrderedDays& counts) {
    QList<Finding> out;
    const PerfStats& s = report.stats;
    std::vector<double> losses;
    for (const LedgerTrade* t : trades)
        if (outcome(*t) == u"loss") losses.push_back(t->pnl);
    util::market::sortNumbers(losses);
    if (losses.size() >= 5 && s.gross_loss > 0 && s.avg_loss) {
        double sum3 = 0;
        for (size_t i = 0; i < std::min<size_t>(3, losses.size()); ++i) sum3 = sum3 + losses[i];
        const double top3 = -sum3;
        const double share = top3 / s.gross_loss;
        const double worst = losses[0];
        // 亏损笔数少时"最大 3 笔占一半"是必然的:集中度至少要 10 笔亏损才看
        const bool concentrated = losses.size() >= 10 && share >= 0.5;
        if (concentrated || worst <= *s.avg_loss * 3) {
            const QString title = concentrated ? u"几笔大亏吃掉了大半:最大 3 笔占总亏损 "_s + n2s(util::pyRound(share * 100, 0)) + u"%"_s
                                               : u"有一笔亏得太多:"_s + money(worst) + u",是平均亏损的 "_s + n2s(util::pyRound(worst / *s.avg_loss, 1)) + u" 倍"_s;
            out.append({u"tail_loss"_s, u"bad"_s, title,
                        u"最大单笔亏损 "_s + money(worst) + u",平均亏损 "_s + money(*s.avg_loss) + u";最大 3 笔占总亏损 "_s + n2s(util::pyRound(share * 100, 0)) +
                            u"%。止损要在开仓前定好、到了就走,别让一笔单子变成一周的利润。"_s,
                        u"Mark Minervini / William O'Neil · 小亏就走,绝不让亏损扩大"_s});
        }
    }
    const PerfDrawdown& dd = report.drawdown;
    if (dd.max > 0 && trades.size() >= 10) {
        if (dd.recovery_factor && *dd.recovery_factor >= 2) {
            out.append({u"drawdown"_s, u"good"_s, u"最大回撤 "_s + money(dd.max) + u",净盈利是它的 "_s + n2s(*dd.recovery_factor) + u" 倍"_s,
                        u"收益能盖过回撤,曲线是往上走的。"_s, u"期货实盘大赛的综合排名 · 收益与回撤一起看"_s});
        } else {
            out.append({u"drawdown"_s, u"warn"_s, u"最大回撤 "_s + money(dd.max) + u",比净盈利还大"_s,
                        u"净盈亏 "_s + money(s.net_pnl) + u",恢复因子 "_s + (dd.recovery_factor ? n2s(*dd.recovery_factor) : u"—"_s) +
                            u"。赚的钱不够填一次回撤,仓位与止损要先管住回撤。"_s,
                        u"期货实盘大赛的综合排名 · 收益与回撤一起看"_s});
        }
    }
    const auto& worstDay = report.per_day.worst_day;
    const auto& avgLosingDay = report.per_day.avg_losing_day;
    if (worstDay && avgLosingDay && report.per_day.days >= 5 && worstDay->pnl < 0 && worstDay->pnl <= *avgLosingDay * 3) {
        out.append({u"worst_day"_s, u"warn"_s, worstDay->date + u" 一天亏了 "_s + money(worstDay->pnl),
                    u"是亏钱日平均("_s + money(*avgLosingDay) + u")的 "_s + n2s(util::pyRound(worstDay->pnl / *avgLosingDay, 1)) +
                        u" 倍。「设置 → 保护规则」里的日内亏损上限可以在亏到线时停掉当天的新单。"_s,
                    u"职业交易员与自营公司的日亏上限 · 坏日子不许变成灾难日"_s});
    }
    // 过度交易:单日笔数远多于平常的那些天,平均每笔是不是更差
    std::vector<double> countValues;
    for (const auto& [d, c] : counts) countValues.push_back(c);
    const double med = median(countValues).value_or(0);
    const double busyCut = jsmath::max(4, med * 2);
    QStringList busyDays;
    for (const auto& [d, c] : counts)
        if (c >= busyCut && !busyDays.contains(d)) busyDays << d;
    if (busyDays.size() >= 3) {
        const auto onBusy = [&](const LedgerTrade* t) { return busyDays.contains(tr::etKey(dateParse(t->closed_at), true)); };
        Trades busy, other;
        for (const LedgerTrade* t : trades)
            if (onBusy(t)) busy.push_back(t);
        for (const LedgerTrade* t : trades)
            if (!onBusy(t)) other.push_back(t);
        const auto perBusy = perfStats(busy).expectancy;
        const auto perOther = perfStats(other).expectancy;
        if (perBusy && perOther && *perBusy < 0 && clearlyWorse(busy, other)) {
            out.append({u"overtrading"_s, u"warn"_s, u"做得多的日子反而亏:"_s + n2s(double(busyDays.size())) + u" 天单日 ≥ "_s + n2s(busyCut) + u" 笔"_s,
                        u"那几天平均每笔 "_s + money(*perBusy) + u",其余日子 "_s + money(*perOther) + u"。一天里出手越来越多,往往是在追回亏损。"_s,
                        u"Brett Steenbarger · 过度交易是情绪在下单"_s});
        }
    }
    return out;
}

std::optional<Finding> sessionFinding(const Trades& trades, const Report& report) {
    const auto rowsOf = [&](const QString& key) {
        Trades out;
        for (const LedgerTrade* t : trades) {
            const auto s = sessionOf(t->opened_at);
            if (s && s->key == key) out.push_back(t);
        }
        return out;
    };
    struct Row {
        const PerfGroup* g;
        double e;
    };
    std::vector<Row> sessions;
    for (const PerfGroup& g : report.session)
        if (g.trades >= kMinGroup && g.expectancy && g.key != u"off") sessions.push_back({&g, *g.expectancy});
    if (sessions.empty() || sessions.size() < 2) return std::nullopt;
    Row best = sessions[0], worst = sessions[0];
    for (const Row& b : sessions) best = b.e > best.e ? b : best;
    for (const Row& b : sessions) worst = b.e < worst.e ? b : worst;
    // 从 k 个时段里挑最好与最差来比:置信水平按对数收紧(Bonferroni)
    const double pairs = (double(sessions.size()) * (double(sessions.size()) - 1)) / 2;
    if (!(worst.e < 0 && best.e > 0) || !clearlyWorse(rowsOf(worst.g->key), rowsOf(best.g->key), 1 - (1 - inf::kConfidence) / pairs)) return std::nullopt;
    return Finding{u"session"_s, u"info"_s, u"时段差异:"_s + best.g->label + u"赚、"_s + worst.g->label + u"亏"_s,
                   best.g->label + u' ' + n2s(best.g->trades) + u" 笔平均每笔 "_s + money(best.e) + u";"_s + worst.g->label + u' ' + n2s(worst.g->trades) + u" 笔平均每笔 "_s +
                       money(worst.e) + u"。优势只在某些时段时,其余时段少做或不做。"_s,
                   u"Andrea Unger(四届 World Cup 期货冠军)· 用时间过滤器只做有优势的时段"_s};
}

QList<Finding> behaviourFindings(const Trades& trades, const Report& report) {
    QList<Finding> out;
    const auto& holdWin = report.holdWin;
    const auto& holdLoss = report.holdLoss;
    struct DayHold {
        QString day;
        double hold;
    };
    const auto holds = [&](const QString& o) {
        std::vector<DayHold> rows;
        for (const LedgerTrade* t : trades)
            if (outcome(*t) == o && t->hold_minutes) rows.push_back({dayOf(*t), *t->hold_minutes});
        return rows;
    };
    // 每天一个数(当天这一类的中位数)
    const auto perDayMedian = [](const std::vector<DayHold>& rows) {
        QStringList days;
        for (const DayHold& r : rows)
            if (!days.contains(r.day)) days << r.day;
        std::vector<double> out2;
        for (const QString& day : days) {
            std::vector<double> xs;
            for (const DayHold& r : rows)
                if (r.day == day) xs.push_back(r.hold);
            out2.push_back(median(xs).value_or(0));
        }
        return out2;
    };
    const auto winHolds = holds(u"win"_s);
    const auto lossHolds = holds(u"loss"_s);
    if (holdWin && holdLoss && winHolds.size() >= 5 && lossHolds.size() >= 5) {
        // 正 = 亏的那组拿得久
        const double z = inf::mannWhitneyZ(perDayMedian(lossHolds), perDayMedian(winHolds)).value_or(0);
        if (*holdLoss > *holdWin * 1.5 && z >= inf::kZ95) {
            out.append({u"disposition"_s, u"bad"_s, u"亏损单拿得比赚钱单久"_s,
                        u"亏的单持有中位数 "_s + n2s(*holdLoss) + u" 分钟,赚的单 "_s + n2s(*holdWin) + u" 分钟。赚一点就跑、亏了死扛,正好把\"截断亏损、让利润奔跑\"做反了。"_s,
                        u"Jesse Livermore / William O'Neil · 截断亏损,让利润奔跑"_s});
        } else if (*holdWin >= *holdLoss * 1.5 && z <= -inf::kZ95) {
            out.append({u"disposition"_s, u"good"_s, u"亏损单走得比赚钱单快"_s,
                        u"赚的单持有中位数 "_s + n2s(*holdWin) + u" 分钟,亏的单 "_s + n2s(*holdLoss) + u" 分钟:该走的走得干脆。"_s,
                        u"Jesse Livermore / William O'Neil · 截断亏损,让利润奔跑"_s});
        }
    }
    const Split revenge = revengeSplit(trades);
    if (const auto verdict = reentryVerdict(revenge)) {
        out.append({u"revenge"_s, u"bad"_s,
                    u"亏完 "_s + n2s(kRevengeMinutes) + u" 分钟内再开仓的 "_s + n2s(double(revenge.quick.size())) + u" 笔,平均每笔 "_s + money(verdict->quick),
                    u"其余的平均每笔 "_s + money(verdict->rest) + u"。刚亏完的那半小时最容易想\"马上赚回来\"。「保护规则」里的止损护栏与同标的冷却就是为这个设的。"_s,
                    u"Mark Douglas / Brett Steenbarger · 报复性交易"_s});
    }
    const SizeAfterLoss size = sizeAfterLoss(trades);
    const double lossRate = size.afterLoss != 0 ? size.upAfterLoss / size.afterLoss : 0;
    const double winRate = size.afterWin != 0 ? size.upAfterWin / size.afterWin : 0;
    // 亏后放大的比例本身要够高,还要明显高于赢后(差 10 个百分点以上,且两个比例之差的区间不跨 0)
    const auto gap = inf::proportionDiffInterval(size.upAfterLoss, size.afterLoss, size.upAfterWin, size.afterWin);
    if (size.afterLoss >= 5 && size.afterWin >= 5 && lossRate >= 0.3 && lossRate - winRate >= 0.1 && gap && gap->lo > 0) {
        out.append({u"size_after_loss"_s, u"bad"_s,
                    u"亏损之后加码:"_s + n2s(size.afterLoss) + u" 次亏损后有 "_s + n2s(size.upAfterLoss) + u" 次下一笔仓位放大到 1.5 倍以上"_s,
                    u"赢了之后放大的是 "_s + n2s(size.upAfterWin) + u" / "_s + n2s(size.afterWin) + u" 次。冠军的做法正相反:亏的时候缩,赚的时候才放。"_s,
                    u"Mark Minervini · 渐进式仓位;Paul Tudor Jones · 不向亏损加码"_s});
    }
    if (const auto s = sessionFinding(trades, report)) out.append(*s);
    return out;
}

QList<Finding> findingsOf(const Trades& trades, const Report& report, const OrderedDays& counts) {
    QList<Finding> out;
    const PerfStats& s = report.stats;
    if (s.trades == 0) return out;
    if (s.trades < kMinSample) {
        out.append({u"sample"_s, u"info"_s, u"样本只有 "_s + n2s(s.trades) + u" 笔"_s,
                    u"不到 "_s + n2s(kMinSample) + u" 笔时,胜率与期望值会被一两笔大单左右,下面的结论只当提示。"_s,
                    u"Kevin Davey(World Cup 期货冠军)· 样本够多才谈得上优势"_s});
    }
    out.append(edgeFindings(trades, report));
    out.append(riskFindings(trades, report, counts));
    out.append(behaviourFindings(trades, report));
    return out;
}

// ---------------------------------------------------------------- 保护规则建议
double ceil10(double v) { return std::ceil(v / 10) * 10; }

QString dailyLossReason(double losingDays, double avgLosingDay, double worst, double line, const DailyLossReplay& replay) {
    const QString effect = replay.skipped != 0
                               ? u"到线之后当天又开的 "_s + n2s(replay.skipped) + u" 笔(赚 "_s + n2s(replay.skipped_wins) + u"、亏 "_s + n2s(replay.skipped_losses) + u")合计 "_s +
                                     money(replay.skipped_pnl) + u","_s +
                                     (replay.skipped_pnl < 0   ? u"拦下它们少亏 "_s + money(-replay.skipped_pnl)
                                      : replay.skipped_pnl > 0 ? u"拦下它们反而少赚 "_s + money(replay.skipped_pnl)
                                                               : u"拦不拦一样"_s)
                               : u"到线之后当天没有再开过新仓,这条线在这本账上一笔也没拦到"_s;
    return n2s(losingDays) + u" 个亏钱日平均 "_s + money(avgLosingDay) + u",最差一天 "_s + money(worst) + u"。线取亏钱日平均的 2 倍("_s + money(-line) + u")。"_s +
           u"放回这本账上走一遍:"_s + n2s(replay.days_hit) + u" 天净亏碰到过线,"_s + effect + u"。到线之前已经开着的仓照常走完,它们的亏损这条线管不着"_s +
           (replay.unknown_open != 0 ? u";另有 "_s + n2s(replay.unknown_open) + u" 笔开仓时刻不明,判断不了"_s : QString()) +
           u"。线是拿这同一段历史定的,往后未必还合适;回放按整本账算,真规则只数经本软件发出的单。"_s;
}

constexpr double kGuardLookback = 120, kGuardTrigger = 3, kGuardPause = 60;

OJson protectionAdvice(const Trades& trades, const Report& report, const contract::ProtectionsConfig* current) {
    OJson out = js::array();
    const auto& avgLosingDay = report.per_day.avg_losing_day;
    const auto& worstDay = report.per_day.worst_day;
    std::vector<double> losingDays;
    for (const auto& [d, v] : perDay(trades).pnl)
        if (v < 0) losingDays.push_back(v);
    if (avgLosingDay && worstDay && losingDays.size() >= 5) {
        const double line = ceil10(std::fabs(*avgLosingDay) * 2);
        const auto crossed = std::count_if(losingDays.begin(), losingDays.end(), [&](double v) { return v <= -line; });
        const contract::DailyLossConfig* cur = current ? &current->daily_loss : nullptr;
        const bool looser = !cur || !cur->enabled || cur->max_loss_usd > line;
        if (crossed > 0 && looser) {
            const DailyLossReplay replay = dailyLossReplay(trades, line);
            out.items.append(js::object({{u"rule"_s, js::S(u"daily_loss"_s)},
                                         {u"suggested"_s, js::object({{u"enabled"_s, js::B(true)}, {u"max_loss_usd"_s, js::N(line)}})},
                                         {u"replay"_s, toJson(replay)},
                                         {u"reason"_s, js::S(dailyLossReason(double(losingDays.size()), *avgLosingDay, worstDay->pnl, line, replay))},
                                         {u"source"_s, js::S(u"职业交易员与自营公司的日亏上限 · 坏日子不许变成灾难日"_s)}}));
        }
    }
    const double streak = report.stats.max_consecutive_losses;
    const Split split = revengeSplit(trades);
    const auto revenge = reentryVerdict(split);
    if ((streak >= 4 || revenge) && !(current && current->stoploss_guard.enabled)) {
        QStringList why;
        if (streak >= 4) why << u"最长连亏 "_s + n2s(streak) + u" 笔"_s;
        if (revenge)
            why << u"亏完 "_s + n2s(kRevengeMinutes) + u" 分钟内再开的 "_s + n2s(double(split.quick.size())) + u" 笔平均每笔 "_s + money(revenge->quick) + u"(其余 "_s +
                       money(revenge->rest) + u")"_s;
        const double bursts = lossBursts(trades, kGuardLookback, kGuardTrigger, kGuardPause);
        out.items.append(js::object(
            {{u"rule"_s, js::S(u"stoploss_guard"_s)},
             {u"suggested"_s, js::object({{u"enabled"_s, js::B(true)}, {u"lookback_minutes"_s, js::N(kGuardLookback)}, {u"trigger_count"_s, js::N(kGuardTrigger)}, {u"pause_minutes"_s, js::N(kGuardPause)}})},
             {u"reason"_s, js::S(why.join(u';') + u"。两小时内止损 3 次就歇一小时,先把\"马上赚回来\"那一段挡掉。"_s + u"这本账上,两小时内接连了结 3 笔亏损、够它停一次的情形出现过 "_s +
                                 n2s(bursts) + u" 回"_s + (bursts != 0 ? QString() : u":按亏损了结来数,这组参数一次也凑不够"_s) + u"。"_s +
                                 u"它只数持仓追踪到价触发的止损类平仓;追踪上点的「立即平仓」、在 TWS 里直接下的单、指令框里手敲的平仓都不算。"_s)},
             {u"source"_s, js::S(u"Mark Douglas / Brett Steenbarger · 报复性交易;freqtrade Protections"_s)}}));
    }
    const Split same = sameSymbolReentry(trades);
    const auto sameVerdict = reentryVerdict(same);
    const contract::CooldownConfig* cool = current ? &current->cooldown : nullptr;
    if (sameVerdict && (!cool || !cool->enabled || cool->minutes < kRevengeMinutes)) {
        out.items.append(js::object({{u"rule"_s, js::S(u"cooldown"_s)},
                                     {u"suggested"_s, js::object({{u"enabled"_s, js::B(true)}, {u"minutes"_s, js::N(kRevengeMinutes)}})},
                                     {u"reason"_s, js::S(u"同一只标的亏完 "_s + n2s(kRevengeMinutes) + u" 分钟内又开的 "_s + n2s(double(same.quick.size())) + u" 笔,平均每笔 "_s +
                                                         money(sameVerdict->quick) + u";其余 "_s + money(sameVerdict->rest) + u"。刚亏过的标的冷却半小时再说。"_s)},
                                     {u"source"_s, js::S(u"Mark Douglas · 报复性交易;freqtrade Protections 的 CooldownPeriod"_s)}}));
    }
    return out;
}

QStringList ledgerNotes(const Trades& trades) {
    QStringList notes;
    const auto gross = std::count_if(trades.begin(), trades.end(), [](const LedgerTrade* t) { return !t->net_of_commission; });
    if (gross) notes << n2s(double(gross)) + u" 笔的成交回报里没有佣金,盈亏未扣佣金"_s;
    const auto noOpen = std::count_if(trades.begin(), trades.end(), [](const LedgerTrade* t) { return !t->opened_at; });
    if (noOpen) notes << n2s(double(noOpen)) + u" 笔导入的期权出场事件没有配上开仓,不进时段、持有时长,也当不了行为规则里按开仓时刻考察的那一笔"_s;
    notes << u"券商成交里认得出的是股票与三腿蝴蝶;别的期权结构要靠 Flex 导入才进得了账本"_s;
    return notes;
}

}  // namespace

// ================================================================ LedgerTrade
OJson toJson(const LedgerTrade& t) {
    return js::object({{u"id"_s, js::S(t.id)},
                       {u"kind"_s, js::S(t.kind)},
                       {u"symbol"_s, js::S(t.symbol)},
                       {u"label"_s, js::S(t.label)},
                       {u"opened_at"_s, optS(t.opened_at)},
                       {u"closed_at"_s, js::S(t.closed_at)},
                       {u"pnl"_s, js::N(t.pnl)},
                       {u"net_of_commission"_s, js::B(t.net_of_commission)},
                       {u"risk"_s, optN(t.risk)},
                       {u"r"_s, optN(t.r)},
                       {u"risk_basis"_s, optS(t.risk_basis)},
                       {u"r_missing"_s, optS(t.r_missing)},
                       {u"exposure"_s, optN(t.exposure)},
                       {u"hold_minutes"_s, optN(t.hold_minutes)},
                       {u"paper"_s, js::B(t.paper)}});
}

LedgerTrade ledgerTradeFromJson(const OJson& o) {
    const auto optStr = [&](const char16_t* k) -> std::optional<QString> {
        const OJson* v = P(o, k);
        return js::nullish(v) ? std::nullopt : std::optional<QString>(v->s);
    };
    const auto optNum = [&](const char16_t* k) -> std::optional<double> {
        const OJson* v = P(o, k);
        return js::nullish(v) ? std::nullopt : std::optional<double>(v->n);
    };
    LedgerTrade t;
    t.id = Sx(o, u"id");
    t.kind = Sx(o, u"kind");
    t.symbol = Sx(o, u"symbol");
    t.label = Sx(o, u"label");
    t.opened_at = optStr(u"opened_at");
    t.closed_at = Sx(o, u"closed_at");
    t.pnl = js::num(P(o, u"pnl"));
    t.net_of_commission = js::truthy(P(o, u"net_of_commission"));
    t.risk = optNum(u"risk");
    t.r = optNum(u"r");
    t.risk_basis = optStr(u"risk_basis");
    t.r_missing = optStr(u"r_missing");
    t.exposure = optNum(u"exposure");
    t.hold_minutes = optNum(u"hold_minutes");
    t.paper = js::truthy(P(o, u"paper"));
    return t;
}

Trades refs(const QList<LedgerTrade>& trades) {
    Trades out;
    for (const LedgerTrade& t : trades) out.push_back(&t);
    return out;
}

// ================================================================ 账本
QList<LedgerTrade> butterflyLedger(const QList<OJson>& records, const trade_outcomes::SettleClose& settleClose, double now, Excluded& excluded) {
    const OJson pairs = tr::pairButterflies(records);
    QList<LedgerTrade> out;
    for (const OJson& record : records) {
        const QString id = js::strOr(js::propStrict(&record, u"id"_s), QString());
        const Link link = linkOf(pairs, id);
        if (link.truthy && isStrEq(link.role, u"exit")) continue;
        const OJson profile = tr::butterflyProfile(&record);
        if (profile.type == OJson::Null) continue;
        const auto debit = num(P(profile, u"debit"));
        const double mult = num(P(profile, u"multiplier")).value_or(100);
        const double qty = num(P(profile, u"qty")).value_or(1);
        const bool buy = isStrEq(P(profile, u"action"), u"BUY");
        std::optional<double> exitPrice;
        std::optional<QString> closedAt;
        std::optional<double> exitComm;
        if (link.truthy) {
            const OJson* peer = nullptr;
            for (const OJson& r : records)
                if (js::strictEqual(js::propStrict(&r, u"id"_s), link.peer)) {
                    peer = &r;
                    break;
                }
            exitPrice = num(js::path(peer, {u"ibkr"_s, u"avg_fill_price"_s}));
            closedAt = isoOf(js::prop(peer, u"created_at"_s));
            exitComm = num(js::path(peer, {u"ibkr"_s, u"total_commission"_s}));
        } else if (now >= tr::expiryClose(profile)) {
            closedAt = util::utcIso(tr::expiryClose(profile));
            const auto close = settleClose(Sx(profile, u"symbol"), Sx(profile, u"expiry"));
            if (close) exitPrice = tr::payoffPerUnit(profile, *close);
            exitComm = 0;  // 到期结算没有平仓佣金
        } else {
            excluded.open += 1;
            continue;
        }
        if (!debit || !exitPrice || !closedAt) {
            excluded.unknown += 1;
            continue;
        }
        const auto openComm = num(js::path(&record, {u"ibkr"_s, u"total_commission"_s}));
        const double gross = (buy ? 1 : -1) * (*exitPrice - *debit) * mult * qty;
        const double pnl = util::pyRound(gross - openComm.value_or(0) - exitComm.value_or(0), 2);
        const auto width = num(P(profile, u"width"));
        std::optional<double> risk;
        if (buy) risk = *debit * mult * qty;
        else if (js::truthy(P(profile, u"symmetric")) && width && *width > *debit) risk = (*width - *debit) * mult * qty;
        const auto openedAt = isoOf(js::prop(&record, u"created_at"_s));
        LedgerTrade t;
        t.id = id;
        t.kind = u"butterfly"_s;
        t.symbol = Sx(profile, u"symbol");
        t.label = Sx(profile, u"symbol") + u' ' + Sx(profile, u"lower") + u'/' + Sx(profile, u"center") + u'/' + Sx(profile, u"upper") + u' ' + Sx(profile, u"right_label") +
                  u"蝴蝶 "_s + (buy ? u"买入"_s : u"卖出"_s);
        t.opened_at = openedAt;
        t.closed_at = *closedAt;
        t.pnl = pnl;
        t.net_of_commission = openComm.has_value() && exitComm.has_value();
        riskFields(t, pnl, risk, u"max_loss"_s, u"undefined_risk"_s);
        t.exposure = util::pyRound(risk ? *risk : *debit * mult * qty, 2);
        t.hold_minutes = minutesBetween(openedAt, *closedAt);
        t.paper = js::truthy(js::path(&record, {u"account"_s, u"is_paper"_s}));
        out.append(t);
    }
    return out;
}

PlannedStopHit plannedStopFor(const OJson& trip, const std::vector<PlannedStop>& stops) {
    const auto from = tr::parseWhen(js::propStrict(&trip, u"created_at"_s));
    const auto to = tr::parseWhen(P(trip, u"closed_at"));
    const auto entry = num(P(trip, u"avg_entry"));
    if (!from || !to || !entry) return {std::nullopt, false};
    const QString symbol = js::strOr(P(trip, u"symbol"), QString()).toUpper();
    const QString alias = js::strOr(js::path(&trip, {u"account"_s, u"alias"_s}), QString());
    const bool isShort = isStrEq(P(trip, u"side"), u"SHORT");
    std::optional<std::pair<double, double>> first;  // (at, stop)
    for (const PlannedStop& s : stops) {
        if (s.symbol != symbol || (s.sec_type && *s.sec_type != u"STK")) continue;
        if (s.account && !alias.isEmpty() && *s.account != alias) continue;
        const double at = dateParse(s.at);
        if (std::isnan(at) || at < *from || at > *to) continue;
        if (!(isShort ? s.stop > *entry : s.stop < *entry)) continue;
        if (!first || at < first->first) first = {at, s.stop};
    }
    if (!first) return {std::nullopt, false};
    if (first->first - *from <= kInitialStopMinutes * 60'000) return {first->second, false};
    return {std::nullopt, true};
}

QList<LedgerTrade> stockLedger(const QList<OJson>& trips, Excluded& excluded, const std::vector<PlannedStop>& stops) {
    QList<LedgerTrade> out;
    for (const OJson& trip : trips) {
        if (!isStrEq(js::propStrict(&trip, u"status"_s), u"closed")) {
            excluded.open += 1;
            continue;
        }
        const auto realized = num(P(trip, u"realized_pnl"));
        if (js::truthy(P(trip, u"carried")) || !realized) {
            excluded.no_cost += 1;
            continue;
        }
        const auto comm = num(P(trip, u"commission"));
        const auto entry = num(P(trip, u"avg_entry"));
        const auto qty = num(P(trip, u"qty"));
        const auto openedAt = isoOf(P(trip, u"created_at"));
        const auto closedAt = isoOf(P(trip, u"closed_at"));
        if (!closedAt) {
            excluded.unknown += 1;
            continue;
        }
        // R 的分母 = |进场均价 − 初始止损| × 峰值股数
        const PlannedStopHit planned = plannedStopFor(trip, stops);
        const bool sized = entry && qty && *qty > 0;
        const std::optional<double> risk = planned.stop && sized ? std::optional<double>(std::fabs(*entry - *planned.stop) * *qty) : std::nullopt;
        const double pnl = util::pyRound(*realized - comm.value_or(0), 2);
        LedgerTrade t;
        t.id = js::strOr(P(trip, u"id"), QString());
        t.kind = u"stock"_s;
        t.symbol = js::strOr(P(trip, u"symbol"), QString());
        t.label = Sx(trip, u"symbol") + u' ' + (isStrEq(P(trip, u"side"), u"SHORT") ? u"做空"_s : u"做多"_s);
        t.opened_at = openedAt;
        t.closed_at = *closedAt;
        t.pnl = pnl;
        t.net_of_commission = comm.has_value();
        riskFields(t, pnl, risk, u"stop"_s, !sized ? u"no_cost"_s : planned.late ? u"late_stop"_s : u"no_stop"_s);
        t.exposure = entry && qty ? std::optional<double>(util::pyRound(*entry * *qty, 2)) : std::nullopt;
        t.hold_minutes = minutesBetween(openedAt, *closedAt);
        t.paper = js::truthy(js::path(&trip, {u"account"_s, u"is_paper"_s}));
        out.append(t);
    }
    return out;
}

QList<LedgerTrade> positionLedger(const QList<OJson>& rows, const trade_outcomes::IsPaper& isPaper, Excluded& excluded) {
    QList<LedgerTrade> out;
    for (const OJson& p : rows) {
        if (isStrEq(js::propStrict(&p, u"status"_s), u"持仓中") || isStrEq(P(p, u"exit"), u"持仓中") || !js::truthy(P(p, u"closed_et"))) {
            excluded.open += 1;
            continue;
        }
        const OJson* qtyP = P(p, u"qty");
        const std::optional<double> qty = !(qtyP && qtyP->type == OJson::Null) && js::num(qtyP) > 0 ? std::optional<double>(js::num(qtyP)) : std::nullopt;
        const OJson* np = P(p, u"net_price");
        const std::optional<double> debit = qty && !(np && np->type == OJson::Null) && js::num(np) > 0 ? std::optional<double>(js::num(np) * 100 * *qty) : std::nullopt;
        const std::optional<double> risk = debit && kDebitRiskStructures.contains(Sx(p, u"structure")) && !Sx(p, u"direction").contains(u"贷方"_s) ? debit : std::nullopt;
        const double pnl = util::pyRound(js::num(P(p, u"realized_pnl")), 2);
        const QString openedAt = trade_outcomes::etIso(Sx(p, u"open_et"));
        const QString closedAt = trade_outcomes::etIso(Sx(p, u"closed_et"));
        QStringList labelParts;
        for (const char16_t* k : {u"symbol", u"strikes", u"structure", u"direction"})
            if (js::truthy(P(p, k))) labelParts << Sx(p, k);
        LedgerTrade t;
        t.id = Sx(p, u"id");
        t.kind = u"option"_s;
        t.symbol = Sx(p, u"symbol");
        t.label = labelParts.join(u' ');
        t.opened_at = openedAt;
        t.closed_at = closedAt;
        t.pnl = pnl;
        t.net_of_commission = true;
        riskFields(t, pnl, risk, u"max_loss"_s, !debit ? u"no_cost"_s : u"undefined_risk"_s);
        t.exposure = debit ? std::optional<double>(util::pyRound(*debit, 2)) : std::nullopt;
        const OJson* holdMin = P(p, u"hold_min");
        t.hold_minutes = js::nullish(holdMin) ? minutesBetween(openedAt, closedAt) : std::optional<double>(js::num(holdMin));
        t.paper = isPaper(Sx(p, u"account_id"));
        out.append(t);
    }
    return out;
}

QList<LedgerTrade> optionLedger(const QList<OJson>& rows, const trade_outcomes::IsPaper& isPaper) {
    QList<LedgerTrade> out;
    for (const OJson& r : rows) {
        if (isStrEq(js::propStrict(&r, u"action"_s), u"开仓")) continue;
        LedgerTrade t;
        t.id = Sx(r, u"id");
        t.kind = u"option"_s;
        t.symbol = Sx(r, u"symbol");
        t.label = Sx(r, u"symbol") + u' ' + Sx(r, u"structure") + (js::truthy(P(r, u"direction")) ? u'(' + Sx(r, u"direction") + u')' : QString()) + u" · "_s + Sx(r, u"action");
        t.opened_at = std::nullopt;
        t.closed_at = trade_outcomes::etIso(Sx(r, u"time_et"));
        t.pnl = util::pyRound(js::num(P(r, u"realized_pnl")), 2);
        t.net_of_commission = true;
        t.r_missing = u"no_open"_s;
        t.paper = isPaper(Sx(r, u"account_id"));
        out.append(t);
    }
    return out;
}

Ledger buildLedger(const LedgerInputs& inp) {
    Ledger ledger;
    std::vector<LedgerTrade> trades;
    for (const auto& part : {butterflyLedger(inp.butterflies, inp.settleClose, inp.now, ledger.excluded), stockLedger(inp.trips, ledger.excluded, inp.stops),
                             positionLedger(inp.positions, inp.isPaper, ledger.excluded), optionLedger(inp.options, inp.isPaper)})
        for (const LedgerTrade& t : part) trades.push_back(t);
    util::market::jsSort(trades, [](const LedgerTrade& a, const LedgerTrade& b) -> double {
        return a.closed_at < b.closed_at ? -1 : a.closed_at > b.closed_at ? 1 : a.id < b.id ? -1 : 1;
    });
    for (const LedgerTrade& t : trades) ledger.trades.append(t);
    return ledger;
}

// ================================================================ 统计
OJson toJson(const PerfStats& s) {
    return js::object({{u"trades"_s, js::N(s.trades)},
                       {u"wins"_s, js::N(s.wins)},
                       {u"losses"_s, js::N(s.losses)},
                       {u"flats"_s, js::N(s.flats)},
                       {u"win_rate"_s, optN(s.win_rate)},
                       {u"win_rate_ci"_s, toJsonI(s.win_rate_ci)},
                       {u"net_pnl"_s, js::N(s.net_pnl)},
                       {u"gross_profit"_s, js::N(s.gross_profit)},
                       {u"gross_loss"_s, js::N(s.gross_loss)},
                       {u"avg_win"_s, optN(s.avg_win)},
                       {u"avg_loss"_s, optN(s.avg_loss)},
                       {u"payoff_ratio"_s, optN(s.payoff_ratio)},
                       {u"profit_factor"_s, optN(s.profit_factor)},
                       {u"expectancy"_s, optN(s.expectancy)},
                       {u"expectancy_ci"_s, toJsonI(s.expectancy_ci)},
                       {u"breakeven_win_rate"_s, optN(s.breakeven_win_rate)},
                       {u"largest_win"_s, optN(s.largest_win)},
                       {u"largest_loss"_s, optN(s.largest_loss)},
                       {u"max_consecutive_wins"_s, js::N(s.max_consecutive_wins)},
                       {u"max_consecutive_losses"_s, js::N(s.max_consecutive_losses)}});
}

PerfStats perfStats(const Trades& trades) {
    double wins = 0, losses = 0, flats = 0, grossProfit = 0, grossLoss = 0;
    std::optional<double> largestWin, largestLoss;
    double runW = 0, runL = 0, maxW = 0, maxL = 0;
    std::vector<inf::ClusteredHit> hits;
    for (const LedgerTrade* t : trades) {
        const QString o = outcome(*t);
        if (o == u"win") {
            wins += 1;
            grossProfit += t->pnl;
            runW += 1;
            runL = 0;
            largestWin = largestWin ? jsmath::max(*largestWin, t->pnl) : t->pnl;
        } else if (o == u"loss") {
            losses += 1;
            grossLoss += -t->pnl;
            runL += 1;
            runW = 0;
            largestLoss = largestLoss ? jsmath::min(*largestLoss, t->pnl) : t->pnl;
        } else {
            flats += 1;  // 持平不打断连胜连亏,也不算进胜率与期望值
        }
        maxW = jsmath::max(maxW, runW);
        maxL = jsmath::max(maxL, runL);
        if (o != u"flat") hits.push_back({o == u"win", dayOf(*t)});
    }
    double net = 0;
    for (const LedgerTrade* t : trades) net = net + t->pnl;
    const double decided = wins + losses;
    const std::optional<double> avgWin = wins != 0 ? std::optional<double>(grossProfit / wins) : std::nullopt;
    const std::optional<double> avgLoss = losses != 0 ? std::optional<double>(-grossLoss / losses) : std::nullopt;
    const std::optional<double> payoff = avgWin && avgLoss && *avgLoss < 0 ? std::optional<double>(*avgWin / -*avgLoss) : std::nullopt;
    PerfStats s;
    s.trades = double(trades.size());
    s.wins = wins;
    s.losses = losses;
    s.flats = flats;
    if (decided != 0) s.win_rate = util::pyRound((wins / decided) * 100, 1);
    s.win_rate_ci = roundedOpt(inf::clusteredWilsonInterval(hits), 1, 100);
    s.net_pnl = util::pyRound(net, 2);
    s.gross_profit = util::pyRound(grossProfit, 2);
    s.gross_loss = util::pyRound(grossLoss, 2);
    if (avgWin) s.avg_win = util::pyRound(*avgWin, 2);
    if (avgLoss) s.avg_loss = util::pyRound(*avgLoss, 2);
    if (payoff) s.payoff_ratio = util::pyRound(*payoff, 2);
    s.profit_factor = ratio(grossProfit, grossLoss);
    if (decided != 0) s.expectancy = util::pyRound((grossProfit - grossLoss) / decided, 2);
    s.expectancy_ci = roundedOpt(inf::clusteredMeanInterval(decidedPnl(trades)), 2);
    if (payoff) s.breakeven_win_rate = util::pyRound(100 / (1 + *payoff), 1);
    if (largestWin) s.largest_win = util::pyRound(*largestWin, 2);
    if (largestLoss) s.largest_loss = util::pyRound(*largestLoss, 2);
    s.max_consecutive_wins = maxW;
    s.max_consecutive_losses = maxL;
    return s;
}

QString sqnLabel(std::optional<double> sqn) {
    if (!sqn) return {};
    if (*sqn < 1.6) return u"差"_s;
    if (*sqn < 2.0) return u"低于平均"_s;
    if (*sqn < 2.5) return u"平均"_s;
    if (*sqn < 3.0) return u"好"_s;
    if (*sqn < 5.1) return u"优秀"_s;
    if (*sqn < 7.0) return u"极好"_s;
    return u"圣杯"_s;
}

OJson toJson(const PerfRStats& s) {
    return js::object({{u"trades"_s, js::N(s.trades)},
                       {u"expectancy_r"_s, optN(s.expectancy_r)},
                       {u"expectancy_ci"_s, toJsonI(s.expectancy_ci)},
                       {u"std_r"_s, optN(s.std_r)},
                       {u"win_rate"_s, optN(s.win_rate)},
                       {u"payoff_ratio"_s, optN(s.payoff_ratio)},
                       {u"kelly"_s, optN(s.kelly)},
                       {u"sqn"_s, optN(s.sqn)},
                       {u"sqn_label"_s, js::S(s.sqn_label)}});
}

PerfRStats rStats(const Trades& trades) {
    struct Row {
        double r;
        bool win;
        QString day;
    };
    std::vector<Row> rows;
    for (const LedgerTrade* t : trades)
        if (t->r && outcome(*t) != u"flat") rows.push_back({*t->r, outcome(*t) == u"win", dayOf(*t)});
    PerfRStats out;
    if (rows.empty()) return out;
    std::vector<double> rs;
    for (const Row& x : rows) rs.push_back(x.r);
    const double m = mean(rs);
    std::optional<double> sd;
    if (rs.size() > 1) {
        double acc = 0;
        for (const double r : rs) acc = acc + jsmath::pow(r - m, 2);
        sd = std::sqrt(acc / double(rs.size() - 1));
    }
    std::optional<double> sqn;
    if (rs.size() >= 10 && sd && *sd > 0) sqn = util::pyRound((std::sqrt(jsmath::min(double(rs.size()), 100)) * m) / *sd, 2);
    std::vector<double> wins, losses;
    for (const Row& x : rows) (x.win ? wins : losses).push_back(x.r);
    const std::optional<double> avgLoss = !losses.empty() ? std::optional<double>(mean(losses)) : std::nullopt;
    const std::optional<double> payoff = !wins.empty() && avgLoss && *avgLoss < 0 ? std::optional<double>(mean(wins) / -*avgLoss) : std::nullopt;
    const double winRate = double(wins.size()) / double(rows.size());
    std::vector<inf::Clustered> obs;
    for (const Row& x : rows) obs.push_back({x.r, x.day});
    out.trades = double(rs.size());
    out.expectancy_r = util::pyRound(m, 2);
    out.expectancy_ci = roundedOpt(inf::clusteredMeanInterval(obs), 2);
    if (sd) out.std_r = util::pyRound(*sd, 2);
    out.win_rate = util::pyRound(winRate * 100, 1);
    if (payoff) out.payoff_ratio = util::pyRound(*payoff, 2);
    out.kelly = kellyFrom(double(rows.size()), winRate, payoff);
    out.sqn = sqn;
    out.sqn_label = sqnLabel(sqn);
    return out;
}

OJson toJson(const PerfRCoverage& c) {
    OJson missing = js::array();
    for (const auto& m : c.missing) missing.items.append(js::object({{u"reason"_s, js::S(m.reason)}, {u"label"_s, js::S(m.label)}, {u"trades"_s, js::N(m.trades)}}));
    return js::object({{u"trades"_s, js::N(c.trades)},
                       {u"with_r"_s, js::N(c.with_r)},
                       {u"flats"_s, js::N(c.flats)},
                       {u"max_loss"_s, js::N(c.max_loss)},
                       {u"stop"_s, js::N(c.stop)},
                       {u"stop_window_minutes"_s, js::N(kInitialStopMinutes)},
                       {u"missing"_s, missing}});
}

PerfRCoverage rCoverage(const Trades& trades) {
    PerfRCoverage c;
    c.trades = double(trades.size());
    for (const LedgerTrade* t : trades) {
        if (!t->r) continue;
        c.with_r += 1;
        if (outcome(*t) == u"flat") c.flats += 1;
        if (t->risk_basis == u"max_loss") c.max_loss += 1;
        if (t->risk_basis == u"stop") c.stop += 1;
    }
    for (const QString& reason : kRMissingOrder) {
        const double n = double(std::count_if(trades.begin(), trades.end(), [&](const LedgerTrade* t) { return t->r_missing == reason; }));
        if (n != 0) c.missing.append({reason, rMissingLabel(reason), n});
    }
    return c;
}

OJson toJson(const EquityCurve& e) {
    OJson points = js::array();
    for (const EquityPoint& p : e.points) points.items.append(js::object({{u"time"_s, js::S(p.time)}, {u"equity"_s, js::N(p.equity)}, {u"drawdown"_s, js::N(p.drawdown)}}));
    const PerfDrawdown& d = e.drawdown;
    return js::object({{u"points"_s, points},
                       {u"drawdown"_s, js::object({{u"max"_s, js::N(d.max)},
                                                   {u"peak_at"_s, optS(d.peak_at)},
                                                   {u"trough_at"_s, optS(d.trough_at)},
                                                   {u"current"_s, js::N(d.current)},
                                                   {u"recovery_factor"_s, optN(d.recovery_factor)}})}});
}

EquityCurve equityCurve(const Trades& trades) {
    double equity = 0, peak = 0, maxDd = 0;
    std::optional<QString> peakAt, ddPeakAt, troughAt;
    EquityCurve out;
    for (const LedgerTrade* t : trades) {
        equity += t->pnl;
        if (equity > peak) {
            peak = equity;
            peakAt = t->closed_at;
        }
        const double dd = peak - equity;
        if (dd > maxDd) {
            maxDd = dd;
            ddPeakAt = peakAt;
            troughAt = t->closed_at;
        }
        out.points.append({t->closed_at, util::pyRound(equity, 2), util::pyRound(dd, 2)});
    }
    out.drawdown.max = util::pyRound(maxDd, 2);
    out.drawdown.peak_at = ddPeakAt;
    out.drawdown.trough_at = troughAt;
    out.drawdown.current = util::pyRound(peak - equity, 2);
    if (maxDd > 0) out.drawdown.recovery_factor = util::pyRound(equity / maxDd, 2);
    return out;
}

std::optional<Session> sessionOf(const std::optional<QString>& iso) {
    if (!iso) return std::nullopt;
    const double when = dateParse(*iso);
    if (std::isnan(when)) return std::nullopt;
    const QString label = trade_similar::slotOf(when);
    return Session{sessionKey(label), label};
}

OJson toJson(const PerDay& d) {
    const auto dv = [](const std::optional<DayValue>& v) { return v ? js::object({{u"date"_s, js::S(v->date)}, {u"pnl"_s, js::N(v->pnl)}}) : js::Null(); };
    return js::object({{u"days"_s, js::N(d.days)},
                       {u"green_days"_s, js::N(d.green_days)},
                       {u"best_day"_s, dv(d.best_day)},
                       {u"worst_day"_s, dv(d.worst_day)},
                       {u"avg_losing_day"_s, optN(d.avg_losing_day)}});
}

PerDay perDay(const Trades& trades) {
    PerDay out;
    const auto bump = [](OrderedDays& m, const QString& k, double add) {
        for (auto& [key, v] : m)
            if (key == k) {
                v = v + add;
                return;
            }
        m.append({k, 0 + add});
    };
    for (const LedgerTrade* t : trades) {
        const QString d = tr::etKey(dateParse(t->closed_at), true);
        bump(out.pnl, d, t->pnl);
        bump(out.counts, d, 1);
    }
    std::vector<double> losing;
    for (const auto& [date, v] : out.pnl) {
        if (!out.best_day || v > out.best_day->pnl) out.best_day = DayValue{date, util::pyRound(v, 2)};
        if (!out.worst_day || v < out.worst_day->pnl) out.worst_day = DayValue{date, util::pyRound(v, 2)};
        if (v < 0) losing.push_back(v);
    }
    out.days = double(out.pnl.size());
    out.green_days = double(std::count_if(out.pnl.begin(), out.pnl.end(), [](const QPair<QString, double>& p) { return p.second > 0; }));
    if (!losing.empty()) out.avg_losing_day = util::pyRound(mean(losing), 2);
    return out;
}

std::optional<double> kellyOf(const PerfStats& s) {
    return kellyFrom(s.wins + s.losses, s.win_rate ? std::optional<double>(*s.win_rate / 100) : std::nullopt, s.payoff_ratio);
}

Trades filterLedger(const Trades& trades, const PerformanceOptions& opts) {
    const std::optional<double> since = opts.days ? std::optional<double>(opts.now - *opts.days * 86'400'000) : std::nullopt;
    Trades out;
    for (const LedgerTrade* t : trades) {
        if (!(opts.scope == u"all" || (opts.scope == u"paper") == t->paper)) continue;
        if (!(opts.kind == u"all" || opts.kind == t->kind)) continue;
        if (since && !(dateParse(t->closed_at) >= *since)) continue;
        out.push_back(t);
    }
    return out;
}

// ================================================================ 整份体检
OJson performanceReport(const Ledger& ledger, const PerformanceOptions& opts, const PerformanceExtras& extras) {
    const Trades all = refs(ledger.trades);
    const Trades trades = filterLedger(all, opts);
    Report rep;
    rep.stats = perfStats(trades);
    const EquityCurve curve = equityCurve(trades);
    rep.drawdown = curve.drawdown;
    rep.per_day = perDay(trades);
    Trades decided;
    for (const LedgerTrade* t : trades)
        if (outcome(*t) != u"flat") decided.push_back(t);
    const LedgerTrade* last = decided.empty() ? nullptr : decided.back();
    double streakCount = 0;
    if (last) {
        for (long long i = qint64(decided.size()) - 1; i >= 0; i -= 1) {
            if (outcome(*decided[size_t(i)]) != outcome(*last)) break;
            streakCount += 1;
        }
    }
    const auto holdOf = [&](const QString& o) -> std::optional<double> {
        std::vector<double> xs;
        for (const LedgerTrade* t : trades)
            if (outcome(*t) == o && t->hold_minutes) xs.push_back(*t->hold_minutes);
        const auto m = median(xs);
        return m ? std::optional<double>(util::pyRound(*m, 1)) : std::nullopt;
    };
    rep.holdWin = holdOf(u"win"_s);
    rep.holdLoss = holdOf(u"loss"_s);
    if (qint64(trades.size()) >= kRecentWindow * 2) rep.recent = perfStats(sliceTrades(trades, -kRecentWindow, qint64(trades.size())));

    QList<PerfGroup> session = group(trades, [](const LedgerTrade& t) { return sessionOf(t.opened_at); });
    {
        std::vector<PerfGroup> v(session.begin(), session.end());
        util::market::jsSort(v, [](const PerfGroup& a, const PerfGroup& b) { return double(kSessionOrder.indexOf(a.key)) - double(kSessionOrder.indexOf(b.key)); });
        session = QList<PerfGroup>(v.begin(), v.end());
    }
    QList<PerfGroup> weekday = group(trades, [](const LedgerTrade& t) -> std::optional<Session> {
        const double d = etWeekday(t.opened_at ? *t.opened_at : t.closed_at);
        return Session{n2s(d), d >= 0 && d < 7 ? kWeekdays[int(d)] : QString()};
    });
    {
        std::vector<PerfGroup> v(weekday.begin(), weekday.end());
        util::market::jsSort(v, [](const PerfGroup& a, const PerfGroup& b) { return util::jsStringToNumber(a.key) - util::jsStringToNumber(b.key); });
        weekday = QList<PerfGroup>(v.begin(), v.end());
    }
    QList<PerfGroup> symbol = group(trades, [](const LedgerTrade& t) -> std::optional<Session> { return Session{t.symbol, t.symbol}; });
    {
        std::vector<PerfGroup> v(symbol.begin(), symbol.end());
        util::market::jsSort(v, [](const PerfGroup& a, const PerfGroup& b) {
            const double d = b.trades - a.trades;
            return d != 0 && !std::isnan(d) ? d : double(util::localeCompare(a.key, b.key));
        });
        symbol = QList<PerfGroup>(v.begin(), v.begin() + std::min<qsizetype>(qsizetype(v.size()), 12));
    }
    rep.kind = group(trades, [](const LedgerTrade& t) -> std::optional<Session> { return Session{t.kind, kindLabel(t.kind)}; });
    rep.session = session;
    rep.r_stats = rStats(trades);
    rep.r_coverage = rCoverage(trades);
    rep.kelly = kellyOf(rep.stats);
    const double paper = double(std::count_if(trades.begin(), trades.end(), [](const LedgerTrade* t) { return t->paper; }));

    const auto groupsJson = [](const QList<PerfGroup>& gs) {
        OJson a = js::array();
        for (const PerfGroup& g : gs) a.items.append(toJson(g));
        return a;
    };
    OJson findings = js::array();
    for (const Finding& f : findingsOf(trades, rep, rep.per_day.counts)) findings.items.append(toJson(f));
    execquality::ExecutionOptions eo{opts.scope, opts.kind, opts.days, opts.now};
    OJson rows = js::array();
    for (long long i = qint64(trades.size()) - 1, n = 0; i >= 0 && n < kMaxLedgerRows; --i, ++n) rows.items.append(toJson(*trades[size_t(i)]));
    OJson curveJson = toJson(curve);
    return js::object({
        {u"scope"_s, js::S(opts.scope)},
        {u"kind"_s, js::S(opts.kind)},
        {u"days"_s, optN(opts.days)},
        {u"stats"_s, toJson(rep.stats)},
        {u"r_stats"_s, toJson(rep.r_stats)},
        {u"r_coverage"_s, toJson(rep.r_coverage)},
        {u"mix"_s, js::object({{u"live"_s, js::N(double(trades.size()) - paper)}, {u"paper"_s, js::N(paper)}})},
        {u"drawdown"_s, *curveJson.get(u"drawdown"_s)},
        {u"streak"_s, !last ? js::object({{u"kind"_s, js::S(u"none"_s)}, {u"count"_s, js::N(0)}})
                            : js::object({{u"kind"_s, js::S(outcome(*last) == u"win" ? u"win"_s : u"loss"_s)}, {u"count"_s, js::N(streakCount)}})},
        {u"hold"_s, js::object({{u"win_median_minutes"_s, optN(rep.holdWin)}, {u"loss_median_minutes"_s, optN(rep.holdLoss)}})},
        {u"kelly"_s, optN(rep.kelly)},
        {u"recent"_s, rep.recent ? js::object({{u"window"_s, js::N(kRecentWindow)}, {u"stats"_s, toJson(*rep.recent)}}) : js::Null()},
        {u"per_day"_s, toJson(rep.per_day)},
        {u"equity"_s, *curveJson.get(u"points"_s)},
        {u"groups"_s, js::object({{u"kind"_s, groupsJson(rep.kind)}, {u"session"_s, groupsJson(session)}, {u"weekday"_s, groupsJson(weekday)}, {u"symbol"_s, groupsJson(symbol)}})},
        {u"findings"_s, findings},
        {u"execution"_s, execquality::executionCost(extras.traces, eo)},
        {u"protection_advice"_s, protectionAdvice(trades, rep, extras.protections)},
        {u"trades"_s, rows},
        {u"excluded"_s, js::object({{u"open"_s, js::N(ledger.excluded.open)}, {u"unknown"_s, js::N(ledger.excluded.unknown)}, {u"no_cost"_s, js::N(ledger.excluded.no_cost)}})},
        {u"notes"_s, js::strings(ledgerNotes(trades))},
    });
}

// ================================================================ 规则用的几样
Split revengeSplit(const Trades& trades) {
    std::vector<std::pair<const LedgerTrade*, double>> losses;
    for (const LedgerTrade* t : trades)
        if (outcome(*t) == u"loss") losses.emplace_back(t, dateParse(t->closed_at));
    Split out;
    for (const LedgerTrade* t : trades) {
        if (!t->opened_at) continue;
        const double open = dateParse(*t->opened_at);
        const bool after = std::any_of(losses.begin(), losses.end(),
                                       [&](const auto& c) { return c.first != t && open >= c.second && open - c.second <= kRevengeMinutes * 60'000; });
        (after ? out.quick : out.rest).push_back(t);
    }
    return out;
}

Split sameSymbolReentry(const Trades& trades) {
    QHash<QString, std::vector<std::pair<const LedgerTrade*, double>>> lossesBySymbol;
    for (const LedgerTrade* t : trades) {
        if (outcome(*t) != u"loss") continue;
        lossesBySymbol[t->symbol].emplace_back(t, dateParse(t->closed_at));
    }
    Split out;
    for (const LedgerTrade* t : trades) {
        if (!t->opened_at) continue;
        const double open = dateParse(*t->opened_at);
        const auto it = lossesBySymbol.constFind(t->symbol);
        const bool after = it != lossesBySymbol.cend() && std::any_of(it->begin(), it->end(), [&](const auto& c) {
            return c.first != t && open >= c.second && open - c.second <= kRevengeMinutes * 60'000;
        });
        (after ? out.quick : out.rest).push_back(t);
    }
    return out;
}

SizeAfterLoss sizeAfterLoss(const Trades& trades) {
    struct Row {
        const LedgerTrade* t;
        double exposure, opened;
    };
    std::vector<Row> rows;
    for (const LedgerTrade* t : trades)
        if (t->exposure && t->opened_at) rows.push_back({t, *t->exposure, dateParse(*t->opened_at)});
    util::market::jsSort(rows, [](const Row& a, const Row& b) { return a.opened - b.opened; });
    QStringList kinds;
    for (const Row& r : rows)
        if (!kinds.contains(r.t->kind)) kinds << r.t->kind;
    QHash<QString, double> medians;
    for (const QString& kind : kinds) {
        std::vector<double> xs;
        for (const Row& r : rows)
            if (r.t->kind == kind) xs.push_back(r.exposure);
        medians.insert(kind, median(xs).value_or(0));
    }
    // 账本里所有的了结,从早到晚
    std::vector<std::pair<const LedgerTrade*, double>> closes;
    for (const LedgerTrade* t : trades) closes.emplace_back(t, dateParse(t->closed_at));
    util::market::jsSort(closes, [](const auto& a, const auto& b) { return a.second - b.second; });
    SizeAfterLoss out;
    std::vector<double> answered;  // Set<number>:SameValueZero
    const auto has = [&](double v) { return std::any_of(answered.begin(), answered.end(), [&](double a) { return a == v || (std::isnan(a) && std::isnan(v)); }); };
    for (const Row& cur : rows) {
        std::optional<double> lastAt;
        double net = 0;
        for (const auto& [ct, cat] : closes) {
            if (cat > cur.opened) break;
            if (ct == cur.t) continue;
            if (!lastAt || !(cat == *lastAt)) {
                lastAt = cat;
                net = 0;
            }
            net += ct->pnl;
        }
        if (!lastAt || has(*lastAt)) continue;
        answered.push_back(*lastAt);
        const double med = medians.value(cur.t->kind, 0);
        const bool up = med > 0 && cur.exposure > med * 1.5;
        if (net <= -kFlatUsd) {
            out.afterLoss += 1;
            if (up) out.upAfterLoss += 1;
        }
        if (net >= kFlatUsd) {
            out.afterWin += 1;
            if (up) out.upAfterWin += 1;
        }
    }
    return out;
}

OJson toJson(const DailyLossReplay& r) {
    return js::object({{u"days_hit"_s, js::N(r.days_hit)},
                       {u"skipped"_s, js::N(r.skipped)},
                       {u"skipped_wins"_s, js::N(r.skipped_wins)},
                       {u"skipped_losses"_s, js::N(r.skipped_losses)},
                       {u"skipped_pnl"_s, js::N(r.skipped_pnl)},
                       {u"unknown_open"_s, js::N(r.unknown_open)}});
}

DailyLossReplay dailyLossReplay(const Trades& trades, double line) {
    const auto dayKey = [](double ms) { return tr::etKey(ms, true); };
    using Close = std::pair<const LedgerTrade*, double>;
    std::vector<Close> closes;
    for (const LedgerTrade* t : trades) closes.emplace_back(t, dateParse(t->closed_at));
    util::market::jsSort(closes, [](const Close& a, const Close& b) { return a.second - b.second; });
    QStringList dayOrder;
    QHash<QString, std::vector<Close>> closesByDay;
    for (const Close& c : closes) {
        const QString d = dayKey(c.second);
        if (!closesByDay.contains(d)) dayOrder << d;
        closesByDay[d].push_back(c);
    }
    // 按开仓时刻从早到晚定夺
    std::vector<Close> opens;
    for (const LedgerTrade* t : trades)
        if (t->opened_at) opens.emplace_back(t, dateParse(*t->opened_at));
    util::market::jsSort(opens, [](const Close& a, const Close& b) {
        const double d = a.second - b.second;
        return d != 0 && !std::isnan(d) ? d : dateParse(a.first->closed_at) - dateParse(b.first->closed_at);
    });
    std::vector<const LedgerTrade*> skipped;  // Set:插入次序
    const auto isSkipped = [&](const LedgerTrade* t) { return std::find(skipped.begin(), skipped.end(), t) != skipped.end(); };
    for (const Close& o : opens) {
        double realized = 0;
        const auto it = closesByDay.constFind(dayKey(o.second));
        if (it != closesByDay.cend()) {
            for (const Close& c : *it) {
                if (c.second > o.second) break;
                if (c.first != o.first && !isSkipped(c.first)) realized += c.first->pnl;
            }
        }
        if (-realized >= line && !isSkipped(o.first)) skipped.push_back(o.first);
    }
    DailyLossReplay out;
    for (const QString& d : dayOrder) {
        double realized = 0;
        bool hit = false;
        for (const Close& c : closesByDay[d]) {
            if (isSkipped(c.first)) continue;
            if (hit && !c.first->opened_at) out.unknown_open += 1;
            realized += c.first->pnl;
            if (-realized >= line) hit = true;
        }
        if (hit) out.days_hit += 1;
    }
    double pnl = 0;
    for (const LedgerTrade* t : skipped) {
        const QString o = outcome(*t);
        if (o == u"win") out.skipped_wins += 1;
        if (o == u"loss") out.skipped_losses += 1;
        pnl = pnl + t->pnl;
    }
    out.skipped = double(skipped.size());
    out.skipped_pnl = util::pyRound(pnl, 2);
    return out;
}

double lossBursts(const Trades& trades, double lookbackMinutes, double count, double pauseMinutes) {
    std::vector<double> at;
    for (const LedgerTrade* t : trades)
        if (outcome(*t) == u"loss") at.push_back(dateParse(t->closed_at));
    util::market::sortNumbers(at);
    double bursts = 0;
    double pausedUntil = -INFINITY;
    size_t lo = 0;
    for (size_t hi = 0; hi < at.size(); ++hi) {
        const double now = at[hi];
        while ((lo < at.size() ? at[lo] : now) <= now - lookbackMinutes * 60'000) lo += 1;
        if (double(hi) - double(lo) + 1 < count) continue;
        if (now >= pausedUntil) bursts += 1;
        pausedUntil = now + pauseMinutes * 60'000;
    }
    return bursts;
}

}  // namespace ibkr::analysis::performance
