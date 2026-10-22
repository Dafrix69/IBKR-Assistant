#include "analysis/fly_exit_sweep_report.h"

#include "util/jsformat.h"
#include "util/jsobj.h"

#include <algorithm>
#include <cmath>

namespace ibkr::analysis::sweep {

using namespace Qt::StringLiterals;
using util::OJson;
namespace js = util::js;

namespace {

/// `${n}`
QString ns(double v) { return util::jsNumberToString(v); }

QString signedStr(const std::optional<double>& v, int digits) {
    if (!v || !std::isfinite(*v)) return u"—"_s;
    const QString text = util::jsToFixed(std::fabs(*v), digits);
    return QString(*v < 0 && util::jsStringToNumber(text) != 0 ? u"-"_s : u"+"_s) + text;
}
int digitsOf(const QString& objective) { return objective == u"r" ? 3 : 1; }
QString unitOf(const QString& objective) { return objective == u"r" ? u"R"_s : u"$"_s; }

QString intervalStr(const std::optional<Interval>& ci, int digits) {
    if (!ci) return u"给不出"_s;
    return u"[%1, %2]"_s.arg(ci->lo ? signedStr(ci->lo, digits) : u"无界"_s, ci->hi ? signedStr(ci->hi, digits) : u"无界"_s);
}
QString pct(double v) { return ns(util::jsRound(v * 100)) + u"%"_s; }
QString orAny(const std::optional<QString>& v) { return v ? *v : u"不限"_s; }
QString orAny(const std::optional<double>& v) { return v ? ns(*v) : u"不限"_s; }
template <class T, class F>
QString listOr(const std::optional<std::vector<T>>& v, F&& str) {
    if (!v || v->empty()) return u"不限"_s;
    QStringList parts;
    for (const T& x : *v) parts << str(x);
    return parts.join(u',');
}

QString kindLabel(const QString& k) {
    static const QHash<QString, QString> labels{
        {u"profit_trail"_s, u"利润回撤"_s}, {u"stop_loss"_s, u"止损"_s},       {u"time_exit"_s, u"到点"_s},
        {u"take_profit"_s, u"止盈"_s},      {u"day_end"_s, u"拿到最后一笔"_s}, {u"settle"_s, u"拿到收盘结算"_s},
        {u"unfilled"_s, u"触发了但一直卖不掉"_s},
    };
    const auto it = labels.constFind(k);
    return it == labels.constEnd() ? k : *it;
}

/// 显示宽度:中文与全角符号算两格,表格才对得齐
int widthOf(const QString& text) {
    int n = 0;
    for (const char32_t ch : text.toUcs4()) n += ch > 0x2e7f ? 2 : 1;
    return n;
}
QString padEnd(const QString& text, int n) { return text + QString(std::max(0, n - widthOf(text)), u' '); }
QString padStart(const QString& text, int n) { return QString(std::max(0, n - widthOf(text)), u' ') + text; }

QStringList populationLines(const SweepResult& r) {
    const Population& p = r.population;
    if (r.from_entries) return {u"入场:只算给进来的那几笔真实入场(--entries),不枚举;样本来源 --by "_s + p.by};
    const bool free = !p.entry_from && !p.entry_to && !p.wings && !p.rights && !p.debit_min && !p.debit_max && !p.dist_min && !p.dist_max;
    QStringList out{
        u"入场人群(每一项都是参数,没给就是不限):"_s,
        u"  样本来源 --by %1;入场时刻 --entry-from %2 --entry-to %3(美东)"_s.arg(p.by, orAny(p.entry_from), orAny(p.entry_to)),
        u"  翼宽 --wings %1;看涨 / 看跌 --right %2"_s.arg(listOr(p.wings, [](double x) { return ns(x); }), listOr(p.rights, [](const QString& x) { return x; })),
        u"  入场价 D(点)--debit-min %1 --debit-max %2"_s.arg(orAny(p.debit_min), orAny(p.debit_max)),
        u"  中心在现价虚值一侧多少点 --dist-min %1 --dist-max %2(看涨 = 中心 − 现价,看跌 = 现价 − 中心)"_s.arg(orAny(p.dist_min), orAny(p.dist_max)),
    };
    if (free) out << u"  一项都没限:下面是记下来的行权价上摆得出的全部蝶、全部入场时刻,不是你做的那一种。"_s;
    return out;
}

QStringList fillLines(const SweepResult& r) {
    const FillModel& f = r.fill;
    const QString terminal =
        f.terminal == u"natural"
            ? u"按当天最后一笔的立刻成交价了结(--terminal natural)。比真留到结算保守:尾盘价差宽,对拿得久的参数组不利"_s
            : u"记到了收盘的那些天(最后一笔离收盘不超过 %1 分钟)按最后一笔现价的内在价值结算(--terminal settle)。"_s.arg(ns(f.settle_within_min)) +
                  u"那一笔现价不是结算价,差着最后几分钟;没记到收盘的天仍按最后一笔的立刻成交价"_s;
    return {
        u"成交口径:"_s,
        u"  入场:中间价 + %1 ×(立刻买得到的价 − 中间价),朝多付的一侧取到组合的跳动上(--entry-spread-share %2;"_s.arg(pct(f.entry_spread_share),
                                                                                                         ns(f.entry_spread_share)) +
            u"1 = 两翼按卖价、中心按买价)"_s,
        u"  出场:触发的那一笔按各腿买卖价合成的立刻成交价(两翼按买价卖、中心按卖价买回);那一笔拿不到就等下一笔"_s,
        u"  一直没出场的:%1"_s.arg(terminal),
        !f.commission
            ? u"  佣金:没给(--commission)。下面的数都是**扣佣金之前**的;追踪的成本也按不含佣金算——实盘的成本含佣金,$100 / $200 那两条线在实盘到得略晚"_s
            : u"  佣金:每张每边 $%1(--commission);一组蝶 4 张,进出各算一次,结算与归零作废不收;追踪的成本里含入场的那 4 张(和实盘组合行的成本同一个口径)"_s.arg(
                  ns(*f.commission)),
        u"  止损类按%1判(--stop-basis %2);每个情景 %3 组(--qty);乘数 %4"_s.arg(f.stop_basis == u"natural" ? u"立刻成交价"_s : u"中间价"_s, f.stop_basis,
                                                                              ns(f.qty), ns(f.multiplier)),
        u"  判断间隔:每 %1 笔样本判一次(--stride %1)"_s.arg(ns(r.stride)),
    };
}

QString bagStr(const OJson& b) {
    QStringList parts;
    for (const auto& [k, v] : b.fields) parts << u"%1 %2"_s.arg(k, js::str(&v));
    return parts.join(u"、"_s);
}

QStringList scenarioLines(const SweepResult& r) {
    const std::vector<double>& counts = r.live.scenarios;
    QString head = u"情景:%1 个,分在 %2 天"_s.arg(ns(r.scenarios), ns(double(r.live.days.size())));
    if (!counts.empty()) head += u"(每天 %1–%2 个)"_s.arg(ns(*std::min_element(counts.begin(), counts.end())), ns(*std::max_element(counts.begin(), counts.end())));
    QStringList out{head};
    if (r.debit) out << u"  入场价 D 最小 / 中位 / 最大:%1 / %2 / %3 点"_s.arg(ns(r.debit->min), ns(r.debit->median), ns(r.debit->max));
    if (!r.wings.fields.isEmpty()) {
        QStringList parts;
        for (const auto& [w, n] : r.wings.fields) parts << u"%1 → %2"_s.arg(w, js::str(&n));
        out << u"  用到的蝶(翼宽 → 只·天):%1"_s.arg(parts.join(u"、"_s));
    }
    if (!r.skipped.fields.isEmpty()) out << u"  没要的情景:%1"_s.arg(bagStr(r.skipped));
    if (!r.filtered.fields.isEmpty()) out << u"  人群限定筛掉的:%1"_s.arg(bagStr(r.filtered));
    if (r.no_decision_total) {
        out << u"  缺报价、那一笔没判断的:%1 / %2 笔"_s.arg(ns(r.no_decision_missing), ns(r.no_decision_total)) +
                   u"(%1%)"_s.arg(util::jsToFixed(100 * r.no_decision_missing / r.no_decision_total, 1));
    }
    if (r.short_days)
        out << u"  有 %1 天最后一笔离收盘超过 %2 分钟(没记到收盘):那些天\"拿到最后\"的情景停在数据断掉的地方"_s.arg(ns(r.short_days), ns(r.fill.settle_within_min));
    if (r.data.not_same_day) out << u"  有 %1 笔样本不是当日到期的,没用"_s.arg(ns(r.data.not_same_day));
    if (r.data.other_symbol) out << u"  有 %1 笔样本是别的标的的,没用"_s.arg(ns(r.data.other_symbol));
    return out;
}

QStringList tableLines(const FamilyResult& f, const FamilySummary& s) {
    const QString main = s.objective, other = main == u"r" ? u"usd"_s : u"r"_s;
    const QString level = pct(s.primary.level);
    const int dm = digitsOf(main), dother = digitsOf(other);
    const QStringList head{u"#"_s,
                           u"参数组"_s,
                           u"平均%1"_s.arg(unitOf(main)),
                           u"平均%1"_s.arg(unitOf(other)),
                           u"Δ%1"_s.arg(unitOf(main)),
                           u"单看的 %1 区间"_s.arg(level),
                           u"算上挑选的 %1 区间"_s.arg(level),
                           u"不靠假设的下界"_s,
                           u"赢/输/平(天)"_s};
    QList<QStringList> rows;
    for (qsizetype i = 0; i < f.labels.size(); ++i) {
        const QString& label = f.labels[i];
        const SetStat* a = size_t(i) < s.primary.sets.size() ? &s.primary.sets[size_t(i)] : nullptr;
        const SetStat* b = size_t(i) < s.secondary.sets.size() ? &s.secondary.sets[size_t(i)] : nullptr;
        if (!a) continue;
        if (i == 0) {
            rows << QStringList{u"0"_s, label, signedStr(a->mean, dm), signedStr(b ? std::optional<double>(b->mean) : std::nullopt, dother), u"—"_s, u"—"_s, u"—"_s,
                                u"—"_s, u"—"_s};
            continue;
        }
        const double days = s.primary.days;
        std::optional<QString> why;
        if (!days) why = u"—"_s;
        else if (a->ties == days) why = u"每天都与参照组相同"_s;
        else if (a->eligible) why = std::nullopt;
        else if (a->ties) why = u"只有 %1 天不同,给不出"_s.arg(ns(days - a->ties));
        else why = u"只有 %1 天,给不出"_s.arg(ns(days));
        rows << QStringList{QString::number(i),
                            label,
                            signedStr(a->mean, dm),
                            signedStr(b ? std::optional<double>(b->mean) : std::nullopt, dother),
                            signedStr(a->diff, dm),
                            why ? *why : intervalStr(a->ci, dm),
                            !why ? intervalStr(a->band, dm) : u"—"_s,
                            !a->exact || a->ties == days ? u"—"_s : signedStr(a->exact->lo, dm),
                            u"%1/%2/%3"_s.arg(ns(a->wins), ns(a->losses), ns(a->ties))};
    }
    QList<int> widths;
    for (qsizetype c = 0; c < head.size(); ++c) {
        int w = widthOf(head[c]);
        for (const QStringList& row : rows) w = std::max(w, widthOf(c < row.size() ? row[c] : QString()));
        widths << w;
    }
    const auto line = [&](const QStringList& cells) {
        QStringList parts;
        for (qsizetype c = 0; c < cells.size(); ++c) parts << (c == 1 ? padEnd(cells[c], widths[c]) : padStart(cells[c], widths[c]));
        return u"  "_s + parts.join(u"  "_s);
    };
    QStringList out{line(head)};
    for (const QStringList& row : rows) out << line(row);
    out << u"  两个区间只说见过的这些天(在天上重抽,近似;天数少、差值偏或稀时偏窄),不拿它们下结论;「不靠假设的下界」对任何分布都成立,结论只看它。"_s;
    return out;
}

/// 不靠假设的下界用的那个上限是怎么来的
QStringList capLine(const FamilySummary& s, const SweepResult& r) {
    const auto& cap = r.loss_cap;
    const auto& fee = r.fill.commission;
    if (!cap) return {};
    const QString usd = u"翼宽 %1 × 乘数 %2%3 = $%4"_s.arg(ns(cap->wing), ns(r.fill.multiplier), fee ? u" + 一次出场的佣金"_s : QString(), ns(cap->usd));
    if (s.objective == u"usd") return {u"合约条款给的上限:一个情景里一组参数最多比另一组多亏 %1(一边卖在翼宽、另一边归零)。"_s.arg(usd)};
    const bool fromFlag = !r.from_entries && r.population.debit_min && *r.population.debit_min >= cap->debit_floor;
    const QString floor =
        fromFlag ? u"入场价的下限 %1(--debit-min)"_s.arg(ns(cap->debit_floor))
                 : u"入场价的下限按组合的一跳 %1 算(没给 --debit-min,或是真实入场):上限大到几乎下不了结论,给 --debit-min 或改用 --objective usd"_s.arg(ns(cap->debit_floor));
    return {u"合约条款给的上限:一个情景里一组参数最多比另一组多亏 %1,折成 R 是 ÷(入场价的下限 × 乘数)= %2R。%3。"_s.arg(usd, util::jsToFixed(cap->r, 1), floor)};
}

QStringList kindLines(const FamilyResult& f) {
    if (f.days.isEmpty()) return {};
    QStringList refused;
    for (size_t i = 0; i < f.stop_refused.size(); ++i)
        if (f.stop_refused[i]) refused << u"%1 → %2"_s.arg(QString::number(i), ns(f.stop_refused[i]));
    QStringList out{u"出场方式(情景数):"_s};
    for (size_t i = 0; i < f.kinds.size(); ++i) {
        QList<std::pair<QString, double>> entries;
        for (const auto& [k, v] : f.kinds[i].fields) entries.append({k, js::num(&v)});
        std::stable_sort(entries.begin(), entries.end(), [](const auto& a, const auto& b) { return b.second - a.second < 0; });
        QStringList parts;
        for (const auto& [k, n] : entries) parts << u"%1 %2"_s.arg(kindLabel(k), ns(n));
        out << u"  %1 %2"_s.arg(QString::number(i), parts.join(u" · "_s));
    }
    if (!refused.isEmpty())
        out << u"  止损设不上的情景(组 → 个):%1。入场那一刻中间价已经不高于止损价"_s.arg(refused.join(u"、"_s)) +
                   (f.family == u"live" ? u",实盘建追踪时会被拒"_s : u",回放会在入场那一笔就止损(那是入场价差造出来的)"_s) + u";这些情景按不设止损算"_s;
    return out;
}

QStringList verdictLines(const FamilyResult& f, const FamilySummary& s, const SweepResult& r) {
    const Verdict& v = s.verdict;
    const Analysis& a = s.primary;
    const int d = digitsOf(s.objective);
    const QString unit = unitOf(s.objective);
    const QString level = pct(a.level);
    const double tried = double(f.labels.size()) - 1;
    const auto name = [&](const std::optional<size_t>& i) {
        return i ? u"「%1」"_s.arg(*i < size_t(f.labels.size()) ? f.labels[qsizetype(*i)] : QString()) : QString();
    };
    const auto money = [&](const std::optional<double>& x) {
        if (!x) return u"—"_s;
        return QString(unit == u"$" ? u"$"_s : QString()) + util::jsToFixed(std::fabs(*x), d) + QString(unit == u"R" ? u"R"_s : QString());
    };
    const SetStat* stat = v.set && *v.set < a.sets.size() ? &a.sets[*v.set] : nullptr;
    QStringList out{u"结论(一共试了 %1 组;置信水平 %2,每一头的 α 按组数平分):"_s.arg(ns(tried), level)};
    if (v.state == u"nothing_to_compare") {
        out << (tried == 0 ? u"  只有参照组,没有可比的。用 --arm / --tighten / --grid 等给出要比的参数。"_s : u"  没有一天有情景,什么也说不了。"_s);
        return out;
    }
    const std::optional<Interval> band = stat ? stat->band : std::nullopt;
    const QString seenDays = u"Δ%1 %2,%3"_s.arg(unit, signedStr(stat ? std::optional<double>(stat->diff) : std::nullopt, d),
                                                !band ? u"给不出区间"_s : u"算上挑选的 %1 区间 %2"_s.arg(level, intervalStr(band, d)));
    const QString proven = u"不靠分布假设的下界 %1(没见过的那种天按合约上限 %2 算进去了)"_s.arg(
        signedStr(stat && stat->exact ? stat->exact->lo : std::nullopt, d), money(a.cap));
    if (v.state == u"better") {
        out << u"  %1比现行参数好:%2;%3,%4 天。"_s.arg(name(v.set), seenDays, proven, ns(a.days));
        out << u"  三样检查它也都还领先:%1、%2、%3。"_s.arg(kCheckCoarse, kCheckTerminal, kCheckHalves);
    } else if (v.state == u"fragile") {
        out << u"  %1的下界在 0 之上(%2;%3,%4 天),**但「%5」之后它不再领先**。"_s.arg(name(v.set), seenDays, proven, ns(a.days), v.failed.join(u"」「"_s));
        out << u"  这个差别取决于数据里没有的东西(两笔样本之间怎么走、最后几分钟怎么结、是不是只有一半的天撑着),不能当作结论,不要据此改参数。"_s;
    } else if (v.state == u"unproven") {
        out << u"  **下不了结论**(%1 天)。在见过的这些天上%2领先:%3——这只说见过的这类天,不是结论。"_s.arg(ns(a.days), name(v.set), seenDays);
        if (stat && stat->unseen) {
            out << u"  为什么不够:%1 天排除不了出现概率不到 %2% 的那种天(比见过的最差的一天还差);"_s.arg(ns(a.days), util::jsToFixed(100 * *stat->unseen, 1)) +
                       u"合约条款允许它在那种天里一天平均比现行的多亏 %1。"_s.arg(money(a.cap));
            out << (stat->seen.value_or(0) > 0
                        ? u"  见过的这部分的下界是 %1:没见过的那种天里只要多亏到 %2,领先就没了;"_s.arg(signedStr(stat->seen, d), money(stat->breakeven)) +
                              u"见过的这部分照现在的样子不变,要约 %1 天才排除得了。"_s.arg(stat->days_needed ? ns(*stat->days_needed) : u"null"_s)
                        : u"  而且见过的这部分自己的下界还不是正的(%1):把最好的那几天换成最差的一天,领先就没了。"_s.arg(signedStr(stat->seen, d)));
        } else {
            out << u"  不知道一天最多能差多少(没有情景给出翼宽),不靠假设的下界给不出。"_s;
        }
    } else {
        out << u"  数据分不开这几组与现行参数(%1 天)。"_s.arg(ns(a.days)) +
                   ((stat ? stat->diff : 0) > 0 ? u"均值最高的是%1:%2%3。"_s.arg(name(v.set), seenDays, !band ? QString() : u",含 0"_s)
                                                : u"没有一组的均值高过现行参数;最接近的是%1:%2。"_s.arg(name(v.set), seenDays));
        if (!a.eligible) out << u"  没有一组给得出重抽的区间:天数太少,或各组与参照组不同的天太少,估不出标准误。"_s;
    }
    if (a.min_days && a.days < *a.min_days)
        out << u"  这个置信水平、这几组下,少于 %1 天数据再好也下不了结论(那时没见过的那种天还可能占一半以上)。"_s.arg(ns(*a.min_days));
    const std::vector<size_t>& pool = (v.state == u"better" || v.state == u"fragile") ? a.better : a.ahead;
    QStringList also;
    for (const size_t i : pool)
        if (!v.set || i != *v.set) also << name(i);
    if (!also.isEmpty() && v.state != u"not_separated")
        out << u"  %1(按差值从大到小):%2。"_s.arg(v.state == u"unproven" ? u"见过的这些天上同样领先的还有"_s : u"下界同样在 0 之上的还有"_s, also.join(u"、"_s));
    if (!a.worse.empty()) {
        QStringList names;
        for (const size_t i : a.worse) names << name(i);
        out << u"  反过来,现行的比它好(不靠假设的上界在 0 之下)的:%1。"_s.arg(names.join(u"、"_s));
    }
    QStringList behind;
    for (const size_t i : a.behind)
        if (std::find(a.worse.begin(), a.worse.end(), i) == a.worse.end()) behind << name(i);
    if (!behind.isEmpty()) out << u"  见过的这些天上落后于现行参数的(同样不是结论):%1。"_s.arg(behind.join(u"、"_s));
    if (v.set) {
        const QString alt = r.fill.terminal == u"natural" ? u"按最后一笔现价的内在价值结算"_s : u"按最后一笔的立刻成交价了结"_s;
        const std::array<std::optional<double>, 2> halves = stat ? stat->halves : std::array<std::optional<double>, 2>{};
        const auto at = [&](const std::vector<double>& xs) { return *v.set < xs.size() ? std::optional<double>(xs[*v.set]) : std::nullopt; };
        out << u"  换口径看%1:%2 Δ%3 %4;一直没出场的改成%5 Δ%3 %6;"_s.arg(name(v.set), kCheckCoarse, unit, signedStr(at(s.coarse), d), alt, signedStr(at(s.alt_terminal), d)) +
                   u"单数天 Δ%1 %2、双数天 Δ%1 %3"_s.arg(unit, signedStr(halves[0], d), signedStr(halves[1], d));
    }
    out << u"对半检验(在一半的天上挑,拿另一半打分;挑的时候没看过打分的那一半。给人看的,进结论的是上面「单数天、双数天」那两个数):"_s;
    for (const SplitHalf& half : a.split) {
        const QString from = half.picked_on == u"odd" ? u"单数天"_s : u"双数天"_s, to = half.picked_on == u"odd" ? u"双数天"_s : u"单数天"_s;
        if (!half.picked) {
            out << u"  %1上没有哪一组的均值高过参照组。"_s.arg(from);
        } else {
            out << u"  %1上最好的是%2(那一半 Δ%3 %4);放到%5:Δ%3 %6"_s.arg(from, name(half.picked), unit, signedStr(half.in_sample, d), to, signedStr(half.held_out, d)) +
                       u"(%1 天,赢 %2 输 %3),单看的 %4 区间 %5"_s.arg(ns(half.held_out_days), ns(half.wins), ns(half.losses), level, intervalStr(half.ci, d));
        }
    }
    return out;
}

QStringList familyLines(const QString& title, const QStringList& intro, const FamilyResult& f, const FamilySummary& s, const SweepResult& r) {
    const QString objective = s.objective == u"r" ? u"平均 R(每个情景的盈亏 ÷ 付出的权利金)"_s : u"平均每组盈亏(美元)"_s;
    QStringList out{QString(), u"━━ %1 ━━"_s.arg(title)};
    out << intro;
    out << u"目标:%1;先按天平均,天与天等权(--objective %2)。%3 天、%4 组(含参照组)"_s.arg(objective, s.objective, ns(double(f.days.size())),
                                                                                        ns(double(f.labels.size())));
    out << tableLines(f, s) << capLine(s, r) << kindLines(f) << verdictLines(f, s, r);
    return out;
}

}  // namespace

QStringList formatReport(const SweepResult& result, const Summary& summary) {
    const SweepData& d = result.data;
    QStringList out{
        u"蝶式出场参数扫描(离线;只用记下来的腿盘口,没有模型价)"_s,
        u"数据:%1,%2 天%3,%4 笔样本,用了 %5 笔"_s.arg(result.symbol ? *result.symbol : u"(没指定标的)"_s, ns(d.days),
                                                       d.first ? u"(%1 → %2)"_s.arg(*d.first, d.last ? *d.last : u"null"_s) : QString(), ns(d.samples), ns(d.used)),
    };
    out << populationLines(result) << fillLines(result) << scenarioLines(result);
    out << u"统计:置信水平 %1(--level)、在天上重抽 %2 次(--draws)、种子 %3(--seed)"_s.arg(pct(summary.level), ns(summary.draws), ns(summary.seed));
    const OJson noRef = js::object();
    const OJson& ref = result.live.params.empty() ? noRef : result.live.params[0];
    const auto rv = [&](const char* key) { return js::str(ref.get(QString::fromLatin1(key))); };
    const OJson* stop = ref.get(u"stop_mult"_s);
    const OJson* exitAt = ref.get(u"exit_at"_s);
    const QString liveIntro = u"参照组(蝶式预设现在的值,从 flyexit 读):起算 $%1 · 收紧 $%2 · 档位 %3/%4/%5"_s.arg(rv("arm_usd"), rv("tighten_usd"), rv("loose_pct"),
                                                                                                    rv("mid_pct"), rv("tight_pct")) +
                              u"(第三档 %1×成本起)· %2 后 ×%3 · 最少回吐 %4"_s.arg(rv("tight_at"), rv("late_after"), rv("late_factor"), rv("floor")) +
                              u" · %1 · %2"_s.arg((stop && stop->type == OJson::Null) ? u"不设止损"_s : u"止损 %1×D"_s.arg(rv("stop_mult")),
                                                 (exitAt && exitAt->type == OJson::Null) ? u"不设到点"_s : u"%1 平"_s.arg(rv("exit_at")));
    out << familyLines(u"实盘的蝶式预设(tracker.evaluate)"_s, {liveIntro}, result.live, summary.live, result);
    if (result.replay && summary.replay) {
        const auto& em = result.replay->em;
        const QStringList replayIntro{
            u"参照组:flyexit.DEFAULTS 现在的值(止损、激活线、档位、区间、阶段切换),EM 除外"_s,
            u"EM(常规时段全天一个标准差,点):%1;"_s.arg(!em ? u"没有一天取得到"_s : u"最小 / 中位 / 最大 %1 / %2 / %3"_s.arg(ns(em->min), ns(em->median), ns(em->max))) +
                u"有 %1 天没做回放(取不到平值跨式,或是提前收盘日)"_s.arg(ns(result.replay->days_without_em)),
        };
        out << familyLines(u"交易分析的回放策略(flyexit.simulate)"_s, replayIntro, result.replay->family, *summary.replay, result);
    }
    out << QString() << u"读这份报告之前:"_s
        << u"  · 判断只发生在记下来的那几笔上。两笔之间价走到过哪里不知道:真实的峰值只会比这里的高,触发只会比这里的早。"_s
        << u"  · 用的是报出来的买卖价,不是成交价;组合单实际常常成交在比各腿买卖价合成的更好的位置。"_s
        << u"  · 入场是假想的(每一笔样本、每一只摆得出的蝶),不是你的入场;要看自己的单,用 --entries。"_s
        << u"  · 只有一个标的、只有记下来的这段日子。"_s
        << u"  · 多数天略好、偶尔大亏的那种改动(比如去掉止损),样本里还没碰上大亏的那种天时会显得更好:表里那两个区间会被它骗,所以结论只看「不靠假设的下界」。"_s
        << u"  · 那个下界靠两条:天与天互不相关、来自同一个分布;一天最多差出合约的上限。行情换了一种状态,前一条就不成立。"_s
        << u"  · α 只在这一次跑里试的这几组之间平分。换着人群限定、成交口径反复跑,挑结论好看的那一次,它就不作数了。"_s
        << u"  · 实盘推峰值要连续两轮(两秒)都见到,这里每一笔样本都算数;实盘的追价、部分成交、托管单这里都没有。"_s;
    return out;
}

}  // namespace ibkr::analysis::sweep
