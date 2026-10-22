#include "shell/performance_rules.h"

#include "shell/fly_rules.h"
#include "shell/jsvalue.h"
#include "shell/order_rules.h"
#include "shell/track_rules.h"
#include "util/jsmath.h"

#include <algorithm>
#include <cmath>

namespace ibkr::shell::performance {

using namespace Qt::StringLiterals;

namespace {

QString S(const QJsonValue& v) { return jsString(v); }
double N(const QJsonValue& v) { return jsNumber(v); }
bool T(const QJsonValue& v) { return jsTruthy(v); }
bool has(const QJsonValue& v) { return !v.isUndefined() && !v.isNull(); }
QJsonArray arr(const QJsonValue& v) { return v.toArray(); }
QJsonValue num(double v) { return QJsonValue(v); }

QString sign(const QJsonValue& v) { return !has(v) ? QString() : N(v) > 0 ? u"pos"_s : N(v) < 0 ? u"neg"_s : QString(); }
QString pct(const QJsonValue& v) { return !has(v) ? u"—"_s : S(v) + u"%"_s; }
QString plain(const QJsonValue& v) { return !has(v) ? u"—"_s : S(v); }
QString rMult(const QJsonValue& v) { return !has(v) ? u"—"_s : S(v) + u"R"_s; }
QString kelly(const QJsonValue& v) { return !has(v) ? u"—"_s : jsToFixed(N(v) * 100, 1) + u"%"_s; }
/// 区间整个在 0 的一边才算分清了正负;跨着 0 的数不上色
bool clear(const QJsonValue& ci) { return has(ci) && (N(ci[u"lo"_s]) > 0 || N(ci[u"hi"_s]) < 0); }
QString signIfClear(const QJsonValue& v, const QJsonValue& ci) { return clear(ci) ? sign(v) : QString(); }
QString findingTone(const QJsonValue& t) {
    static const QHash<QString, QString> m{{u"good"_s, u"ok"_s}, {u"info"_s, u"info"_s}, {u"warn"_s, u"warn"_s}, {u"bad"_s, u"bad"_s}};
    return m.value(S(t), u"info"_s);
}
QString fmtShort(const QJsonValue& iso, const PageInput& in) { return orders::fmtTimeShort(iso, in.nowMs, in.zone); }
QJsonObject tile(const QString& label, const QString& value, const QString& tone = QString()) { return {{u"label"_s, label}, {u"value"_s, value}, {u"tone"_s, tone}}; }
QJsonArray strings(const QList<QJsonValue>& items) {
    QJsonArray out;
    for (const QJsonValue& v : items)
        if (v.isString() && !v.toString().isEmpty()) out.append(v);
    return out;
}
QJsonValue opt(bool ok, const QString& s) { return ok ? QJsonValue(s) : QJsonValue(); }

/// AntD 小号分页(同 shell/backtest_rules 的那一份):≤ 7 页全列;多了 1、当前前后两页、最后一页,中间省略
QJsonArray pagerItems(int pages, int current) {
    QJsonArray out;
    if (pages <= 1) return out;
    if (pages <= 7) {
        for (int i = 1; i <= pages; ++i) out.append(i);
        return out;
    }
    int left = std::max(1, current - 2), right = std::min(pages, current + 2);
    if (current - 1 <= 2) right = 1 + 4;
    if (pages - current <= 2) left = pages - 4;
    out.append(1);
    if (left > 2) out.append(u"prev"_s);
    for (int i = std::max(2, left); i <= std::min(pages - 1, right); ++i) out.append(i);
    if (right < pages - 1) out.append(u"next"_s);
    out.append(pages);
    return out;
}
QJsonObject paged(const QJsonArray& rows, int pageSize, int want) {
    const int pages = std::max(1, int((rows.size() + pageSize - 1) / pageSize));
    const int page = std::clamp(want, 1, pages);
    QJsonArray slice;
    for (qsizetype i = (page - 1) * pageSize; i < std::min<qsizetype>(rows.size(), page * pageSize); ++i) slice.append(rows[i]);
    return {{u"rows"_s, slice}, {u"page"_s, page}, {u"pages"_s, pages}, {u"pager"_s, pagerItems(pages, page)}, {u"sizeChanger"_s, pages > 1 && rows.size() > 50}};
}

QString coverageText(const QJsonValue& r) {
    const QJsonValue c = r[u"r_coverage"_s];
    if (!T(c[u"trades"_s])) return {};
    QStringList basis;
    if (T(c[u"max_loss"_s])) basis << u"按最大可亏 "_s + S(c[u"max_loss"_s]);
    if (T(c[u"stop"_s])) basis << u"按开仓后 %1 分钟内设的止损 %2"_s.arg(S(c[u"stop_window_minutes"_s]), S(c[u"stop"_s]));
    QStringList missing;
    for (const QJsonValue& m : arr(c[u"missing"_s])) missing << u"%1 %2 笔"_s.arg(S(m[u"label"_s]), S(m[u"trades"_s]));
    const QString flats = T(c[u"flats"_s]) ? u",其中 %1 笔持平、不进 R 的统计"_s.arg(S(c[u"flats"_s])) : QString();
    return u"R:%1 笔里 %2 笔有%3%4%5"_s.arg(S(c[u"trades"_s]), S(c[u"with_r"_s]), basis.isEmpty() ? QString() : u"("_s + basis.join(u"、"_s) + u")"_s, flats,
                                            missing.isEmpty() ? QString() : u"。没有的:"_s + missing.join(u';'));
}

QString intervalText(const QJsonValue& r) {
    const QJsonValue s = r[u"stats"_s];
    QStringList bits;
    if (T(s[u"expectancy_ci"_s])) bits << u"期望值 %1 ~ %2"_s.arg(usd(s[u"expectancy_ci"_s][u"lo"_s]), usd(s[u"expectancy_ci"_s][u"hi"_s]));
    if (T(s[u"win_rate_ci"_s])) bits << u"胜率 %1%–%2%"_s.arg(S(s[u"win_rate_ci"_s][u"lo"_s]), S(s[u"win_rate_ci"_s][u"hi"_s]));
    const QJsonValue rci = r[u"r_stats"_s][u"expectancy_ci"_s];
    if (T(rci)) bits << u"R 期望 %1R ~ %2R"_s.arg(S(rci[u"lo"_s]), S(rci[u"hi"_s]));
    if (bits.isEmpty()) return N(s[u"wins"_s]) + N(s[u"losses"_s]) >= 2 ? u"这些交易都在同一天了结,定不出区间:同一天的几笔不算几次独立的试验"_s : QString();
    return u"95% 区间(同一天了结的几笔不当成几次独立的试验):%1。跨着 0 的数不上色"_s.arg(bits.join(u" · "_s));
}

QJsonObject statsModel(const QJsonValue& r, const PageInput& in) {
    const QJsonValue s = r[u"stats"_s], rs = r[u"r_stats"_s];
    const QString streak = S(r[u"streak"_s][u"kind"_s]) == u"none" ? u"—"_s
                                                                    : u"%1 %2 笔"_s.arg(S(r[u"streak"_s][u"kind"_s]) == u"win" ? u"连赚"_s : u"连亏"_s, S(r[u"streak"_s][u"count"_s]));
    const double dd = N(r[u"drawdown"_s][u"max"_s]);
    QJsonArray tiles{
        tile(u"净盈亏"_s, usd(s[u"net_pnl"_s]), sign(s[u"net_pnl"_s])),
        tile(u"期望值(每笔,美元)"_s, usd(s[u"expectancy"_s]), signIfClear(s[u"expectancy"_s], s[u"expectancy_ci"_s])),
        tile(u"胜率"_s, pct(s[u"win_rate"_s])),
        tile(u"保本所需胜率"_s, pct(s[u"breakeven_win_rate"_s])),
        tile(u"盈亏比(按美元)"_s, plain(s[u"payoff_ratio"_s])),
        tile(u"利润因子"_s, plain(s[u"profit_factor"_s])),
        tile(u"平均盈利"_s, usd(s[u"avg_win"_s])),
        tile(u"平均亏损"_s, usd(s[u"avg_loss"_s])),
        tile(u"最大单笔亏损"_s, usd(s[u"largest_loss"_s]), sign(s[u"largest_loss"_s])),
        tile(u"最大回撤(平仓)"_s, usd(num(-dd)), dd > 0 ? u"neg"_s : QString()),
        tile(u"恢复因子"_s, plain(r[u"drawdown"_s][u"recovery_factor"_s])),
        tile(u"最长连亏"_s, S(s[u"max_consecutive_losses"_s]) + u" 笔"_s),
        tile(u"眼下"_s, streak),
        tile(u"凯利比例(按美元)"_s, kelly(r[u"kelly"_s])),
        tile(u"R 期望(%1 笔)"_s.arg(S(rs[u"trades"_s])), rMult(rs[u"expectancy_r"_s]), signIfClear(rs[u"expectancy_r"_s], rs[u"expectancy_ci"_s])),
        tile(u"盈亏比(按 R)"_s, plain(rs[u"payoff_ratio"_s])),
        tile(u"凯利比例(按 R)"_s, kelly(rs[u"kelly"_s])),
        tile(u"SQN"_s, !has(rs[u"sqn"_s]) ? u"—"_s : u"%1 · %2"_s.arg(S(rs[u"sqn"_s]), S(rs[u"sqn_label"_s]))),
    };
    const QJsonValue hold = r[u"hold"_s], perDay = r[u"per_day"_s], recent = r[u"recent"_s];
    const QJsonArray meta1 = strings({
        opt(has(hold[u"win_median_minutes"_s]) && has(hold[u"loss_median_minutes"_s]),
            u"持有中位数:赚的 %1 分钟 · 亏的 %2 分钟"_s.arg(S(hold[u"win_median_minutes"_s]), S(hold[u"loss_median_minutes"_s]))),
        opt(T(perDay[u"days"_s]), u"%1 个交易日里 %2 天为正"_s.arg(S(perDay[u"days"_s]), S(perDay[u"green_days"_s]))),
        opt(T(perDay[u"worst_day"_s]), u"最差一天 %1 %2"_s.arg(S(perDay[u"worst_day"_s][u"date"_s]), usd(perDay[u"worst_day"_s][u"pnl"_s]))),
        opt(T(recent), u"最近 %1 笔期望 %2"_s.arg(S(recent[u"window"_s]), usd(recent[u"stats"_s][u"expectancy"_s]))),
    });
    QStringList kinds;
    for (const QJsonValue& g : arr(r[u"groups"_s][u"kind"_s])) kinds << S(g[u"label"_s]);
    const QString interval = intervalText(r), coverage = coverageText(r);
    const QJsonArray meta2 = strings({
        opt(!interval.isEmpty(), interval),
        opt(!coverage.isEmpty(), coverage),
        opt(kinds.size() > 1, u"这里混着%1:按美元的期望值、盈亏比、凯利由单笔金额大的那一类主导,分开的数在下面「品种」表"_s.arg(kinds.join(u"、"_s))),
        QJsonValue(u"持平(|盈亏| < $1)的不进胜率、盈亏比、期望值、凯利与 R"_s),
    });
    Q_UNUSED(in);
    return {{u"title"_s, u"%1 笔已了结 · 赚 %2 · 亏 %3 · 持平 %4"_s.arg(S(s[u"trades"_s]), S(s[u"wins"_s]), S(s[u"losses"_s]), S(s[u"flats"_s]))},
            {u"tiles"_s, tiles}, {u"meta1"_s, meta1}, {u"meta2"_s, meta2}};
}

/// 分组表的一行:每笔期望区间跨着 0 不上色,悬停看区间
QJsonObject groupRow(const QJsonValue& g, bool kindCols) {
    const QJsonValue ci = g[u"expectancy_ci"_s];
    QJsonObject cells{
        {u"label"_s, S(g[u"label"_s])}, {u"trades"_s, S(g[u"trades"_s])}, {u"win_rate"_s, pct(g[u"win_rate"_s])},
        {u"net_pnl"_s, QJsonObject{{u"text"_s, usd(g[u"net_pnl"_s])}, {u"tone"_s, sign(g[u"net_pnl"_s])}}},
        {u"expectancy"_s, QJsonObject{{u"text"_s, usd(g[u"expectancy"_s])}, {u"tone"_s, signIfClear(g[u"expectancy"_s], ci)},
                                      {u"tip"_s, T(ci) ? u"95% 区间 %1 ~ %2%3"_s.arg(usd(ci[u"lo"_s]), usd(ci[u"hi"_s]), clear(ci) ? QString() : u":正负还没分清"_s) : QString()}}},
        {u"profit_factor"_s, plain(g[u"profit_factor"_s])},
    };
    if (kindCols) {
        cells[u"payoff_ratio"_s] = plain(g[u"payoff_ratio"_s]);
        cells[u"kelly"_s] = kelly(g[u"kelly"_s]);
        cells[u"expectancy_r"_s] = !has(g[u"expectancy_r"_s]) ? u"—"_s : u"%1R(%2 笔)"_s.arg(S(g[u"expectancy_r"_s]), S(g[u"r_trades"_s]));
        cells[u"payoff_r"_s] = plain(g[u"payoff_r"_s]);
        cells[u"kelly_r"_s] = kelly(g[u"kelly_r"_s]);
        cells[u"sqn"_s] = plain(g[u"sqn"_s]);
    }
    return {{u"key"_s, S(g[u"key"_s])}, {u"cells"_s, cells}};
}

QJsonObject groupsModel(const QJsonValue& r) {
    QJsonArray tables;
    const auto add = [&](const QString& title, const QString& key, bool kindCols) {
        QJsonArray rows;
        for (const QJsonValue& g : arr(r[u"groups"_s][key])) rows.append(groupRow(g, kindCols));
        if (!rows.isEmpty()) tables.append(QJsonObject{{u"title"_s, title}, {u"key"_s, key}, {u"wide"_s, kindCols}, {u"rows"_s, rows}});
    };
    add(u"品种"_s, u"kind"_s, true);
    add(u"开仓时段(美东)"_s, u"session"_s, false);
    add(u"星期"_s, u"weekday"_s, false);
    add(u"标的"_s, u"symbol"_s, false);
    return {{u"tables"_s, tables}, {u"meta"_s, QJsonArray{u"一组不到 8 笔时胜率与期望都不稳,只当参考"_s, u"每笔期望的 95% 区间跨着 0 时不上色(鼠标停上去看区间)"_s}}};
}

const QHash<QString, QString>& secLabel() {
    static const QHash<QString, QString> m{{u"STK"_s, u"股票"_s}, {u"OPT"_s, u"单腿期权"_s}, {u"FOP"_s, u"期货期权"_s}, {u"BAG"_s, u"组合"_s}};
    return m;
}

QJsonValue executionModel(const QJsonValue& r, const PageInput& in) {
    const QJsonValue e = r[u"execution"_s];
    if (!T(e[u"samples"_s]) && !T(e[u"missing"_s])) return QJsonValue::Null;
    bool warn = false;
    QJsonArray tiles{
        tile(u"合计让出(不含佣金)"_s, usd(has(e[u"total_usd"_s]) ? num(-N(e[u"total_usd"_s])) : QJsonValue()), has(e[u"total_usd"_s]) && N(e[u"total_usd"_s]) > 0 ? u"neg"_s : QString()),
        tile(u"每笔平均让出"_s, usd(has(e[u"avg_usd"_s]) ? num(-N(e[u"avg_usd"_s])) : QJsonValue())),
        tile(u"这些平仓单的佣金"_s, !has(e[u"commission_usd"_s]) ? u"—"_s : usd(num(-N(e[u"commission_usd"_s])))),
    };
    for (const QJsonValue& g : arr(e[u"by_sec_type"_s])) {
        const QString sec = S(g[u"sec_type"_s]);
        if (has(g[u"median_pct"_s]) && N(g[u"median_pct"_s]) > 3) warn = true;
        const QString value = !has(g[u"median_pct"_s]) ? u"—"_s
                              : T(g[u"median_ci"_s])  ? u"%1%(%2% ~ %3%)"_s.arg(S(g[u"median_pct"_s]), S(g[u"median_ci"_s][u"lo"_s]), S(g[u"median_ci"_s][u"hi"_s]))
                                                      : u"%1% · 样本少"_s.arg(S(g[u"median_pct"_s]));
        tiles.append(tile(u"%1 · %2 笔 · %3的中位数"_s.arg(secLabel().value(sec, sec), S(g[u"samples"_s]), sec == u"STK" ? u"占股价"_s : u"占权利金"_s), value));
    }
    QJsonArray rows;
    for (const QJsonValue& x : arr(e[u"rows"_s])) {
        const QString sec = S(x[u"sec_type"_s]), path = S(x[u"path"_s]);
        const QString pathText = S(x[u"state"_s]) == u"manual" ? u"手动 · "_s + (path == u"hosted_sweep" ? u"托管追价"_s : u"立即平仓"_s)
                                                                : path == u"auto_close" ? u"到价平仓"_s : path == u"hosted_sweep" ? u"托管追价"_s : S(QJsonValue());
        rows.append(QJsonObject{{u"key"_s, u"%1|%2|%3"_s.arg(S(x[u"at"_s]), S(x[u"symbol"_s]), path)},
                                {u"cells"_s, QJsonObject{{u"at"_s, fmtShort(x[u"at"_s], in)},
                                                         {u"symbol"_s, u"%1 · %2%3"_s.arg(S(x[u"symbol"_s]), secLabel().value(sec, sec), T(x[u"paper"_s]) ? u" · 模拟"_s : QString())},
                                                         {u"path"_s, pathText}, {u"px"_s, u"%1 → %2"_s.arg(S(x[u"mark"_s]), S(x[u"fill"_s]))},
                                                         {u"cost"_s, u"%1(%2%)"_s.arg(usd(num(-N(x[u"cost_usd"_s]))), S(x[u"cost_pct"_s]))},
                                                         {u"commission"_s, !has(x[u"commission_usd"_s]) ? u"—"_s : u"$"_s + jsToFixed(N(x[u"commission_usd"_s]), 2)}}}});
    }
    const QJsonArray meta = strings({
        QJsonValue(u"触发价是那一刻的持仓现价(中间价口径),让出 = 平多头卖低了、平空头买高了的部分,只是滑点,佣金另算"_s),
        QJsonValue(u"百分比按合约分开看:股票的是占股价,组合与期权的是占权利金,不能合成一个数。括号里是中位数的 95% 区间"_s),
        QJsonValue(u"回测的「每边成交成本」是佣金 + 滑点:填对应那一类的中位数,再加上佣金占成交额的比例;标着「样本少」的先别用"_s),
        opt(T(e[u"paper"_s]), u"其中 %1 笔是模拟账户的:模拟盘的成交是撮合出来的,不代表真实滑点,要看真实水平切到「实盘」"_s.arg(S(e[u"paper"_s]))),
        opt(T(e[u"missing"_s]), u"%1 条平仓痕算不出:2026-09-26 之前没记触发价,或单子没成交"_s.arg(S(e[u"missing"_s]))),
    });
    return QJsonObject{{u"title"_s, u"自动平仓的执行损耗(%1 笔)"_s.arg(S(e[u"samples"_s]))}, {u"tone"_s, warn ? u"warn"_s : u"info"_s}, {u"tiles"_s, tiles},
                       {u"table"_s, rows.isEmpty() ? QJsonValue(QJsonValue::Null) : QJsonValue(paged(rows, 10, in.execPage))}, {u"meta"_s, meta}};
}

QJsonObject sizerModel(const QJsonValue& r, const PageInput& in) {
    const double streak = std::max(N(r[u"stats"_s][u"max_consecutive_losses"_s]), 1.0);
    const std::optional<Sizing> s = sizePosition(in.sizerEquity, in.sizerPct, in.sizerUnit, num(streak));
    const bool tooHot = has(in.sizerPct) && N(in.sizerPct) > 2;
    QJsonObject out{{u"tone"_s, tooHot ? u"warn"_s : u"info"_s}, {u"equity"_s, in.sizerEquity}, {u"pct"_s, in.sizerPct}, {u"unit"_s, in.sizerUnit}};
    if (s) {
        QJsonArray tiles{tile(u"这一笔的风险预算"_s, u"$"_s + track::fmtMoney(num(s->budget))), tile(u"可做份数"_s, jsNumberToString(s->units), s->units ? QString() : u"neg"_s),
                         tile(u"取整后实际风险"_s, u"$%1 · %2%"_s.arg(track::fmtMoney(num(s->actualRisk)), jsToFixed(s->actualPct, 2)))};
        if (s->streakDrawdownPct)
            tiles.append(tile(u"连亏 %1 笔后的回撤"_s.arg(jsNumberToString(streak)), jsToFixed(*s->streakDrawdownPct, 1) + u"%"_s, *s->streakDrawdownPct >= 20 ? u"neg"_s : QString()));
        out[u"tiles"_s] = tiles;
    }
    out[u"meta"_s] = strings({QJsonValue(u"冠军们的单笔风险多在账户的 0.5%–2%:Minervini 主张每笔最多亏 1.25%–2.5%,连亏时再往下调"_s),
                              opt(tooHot, u"单笔风险超过 2%:历史最大连亏再来一次,回撤会很深"_s), opt(s && !s->units, u"预算连一份都不够:要么换更便宜的结构,要么这一笔不做"_s)});
    return out;
}

QJsonObject ledgerModel(const QJsonValue& r, const PageInput& in) {
    static const QHash<QString, QString> basis{{u"max_loss"_s, u"分母是开仓时的最大可亏"_s}, {u"stop"_s, u"分母是开仓后不久设的止损"_s}};
    static const QHash<QString, QString> missing{{u"no_stop"_s, u"开仓后没及时设止损,没有初始风险"_s}, {u"late_stop"_s, u"止损设得太晚,不算初始风险"_s},
                                                 {u"undefined_risk"_s, u"风险不止权利金"_s}, {u"no_open"_s, u"没配上开仓"_s}, {u"no_cost"_s, u"开仓价或数量不明"_s}};
    QJsonArray rows;
    for (const QJsonValue& t : arr(r[u"trades"_s])) {
        const QJsonValue hold = t[u"hold_minutes"_s];
        const QString holdText = !has(hold) ? u"—"_s : N(hold) >= 1440 ? jsToFixed(N(hold) / 1440, 1) + u" 天"_s : jsNumberToString(jsRound(N(hold))) + u" 分钟"_s;
        const QString rTip = T(t[u"risk_basis"_s]) ? basis.value(S(t[u"risk_basis"_s])) : T(t[u"r_missing"_s]) ? missing.value(S(t[u"r_missing"_s])) : QString();
        rows.append(QJsonObject{{u"key"_s, S(t[u"id"_s])},
                                {u"cells"_s, QJsonObject{{u"closed_at"_s, fmtShort(t[u"closed_at"_s], in)},
                                                         {u"label"_s, S(t[u"label"_s]) + (T(t[u"paper"_s]) ? u" · 模拟"_s : QString())},
                                                         {u"pnl"_s, QJsonObject{{u"text"_s, usd(t[u"pnl"_s])}, {u"tone"_s, sign(t[u"pnl"_s])},
                                                                                {u"tip"_s, T(t[u"net_of_commission"_s]) ? u"已扣佣金"_s : u"未扣佣金"_s}}},
                                                         {u"r"_s, QJsonObject{{u"text"_s, rMult(t[u"r"_s])}, {u"tip"_s, rTip}}}, {u"hold"_s, holdText}}}});
    }
    QStringList excluded;
    const QJsonValue ex = r[u"excluded"_s];
    if (T(ex[u"open"_s])) excluded << u"持仓中 "_s + S(ex[u"open"_s]);
    if (T(ex[u"unknown"_s])) excluded << u"结果不明 %1(多半是到期结算价取不到,连上 TWS 再看)"_s.arg(S(ex[u"unknown"_s]));
    if (T(ex[u"no_cost"_s])) excluded << u"成本不明 %1(建仓早于已同步的成交)"_s.arg(S(ex[u"no_cost"_s]));
    QList<QJsonValue> meta;
    for (const QJsonValue& n : arr(r[u"notes"_s])) meta << QJsonValue(S(n));
    meta << opt(!excluded.isEmpty(), u"没进账本:"_s + excluded.join(u" · "_s));
    return {{u"title"_s, u"账本(新的在前,%1 笔)"_s.arg(rows.size())}, {u"table"_s, paged(rows, 20, in.ledgerPage)}, {u"meta"_s, strings(meta)}};
}

QJsonObject signalsModel(const PageInput& in) {
    QJsonObject out{{u"button"_s, T(in.signalData) ? u"重新打分"_s : u"给信号打分"_s}, {u"loading"_s, in.signalsLoading}, {u"error"_s, in.signalsError}};
    out[u"working"_s] = in.signalsLoading && !T(in.signalData);
    const QJsonValue d = in.signalData;
    if (!T(d)) return out;
    if (!T(d[u"total"_s])) {
        out[u"empty"_s] = u"还没有记下的信号。价位提醒与盯异动每发一条、强势股筛选扫出今天新入选的、K线 PA 读出方向,都会记一笔。"_s;
        return out;
    }
    static const QHash<QString, QString> tone{{u"good"_s, u"ok"_s}, {u"info"_s, u"info"_s}, {u"warn"_s, u"warn"_s}, {u"bad"_s, u"bad"_s}};
    const auto spct = [](const QJsonValue& v) { return !has(v) ? u"—"_s : u"%1%2%"_s.arg(N(v) > 0 ? u"+"_s : QString(), S(v)); };
    QJsonArray groups;
    for (const QJsonValue& g : arr(d[u"groups"_s])) {
        QJsonArray rows;
        for (const QJsonValue& h : arr(g[u"horizons"_s]))
            rows.append(QJsonObject{{u"key"_s, S(h[u"horizon"_s])},
                                    {u"cells"_s, QJsonObject{{u"h"_s, S(h[u"horizon"_s]) + u" 个交易日"_s}, {u"n"_s, S(h[u"n"_s])}, {u"indep"_s, S(h[u"independent"_s])},
                                                             {u"mean"_s, QJsonObject{{u"text"_s, spct(h[u"mean_pct"_s])}, {u"tone"_s, sign(h[u"mean_pct"_s])}}},
                                                             {u"hit"_s, !has(h[u"hit_rate"_s]) ? u"—"_s : S(h[u"hit_rate"_s]) + u"%"_s}, {u"base"_s, spct(h[u"baseline_pct"_s])},
                                                             {u"edge"_s, QJsonObject{{u"text"_s, spct(h[u"edge_pct"_s])}, {u"tone"_s, sign(h[u"edge_pct"_s])}}},
                                                             {u"t"_s, !has(h[u"t"_s]) ? u"—"_s : S(h[u"t"_s])}}}});
        groups.append(QJsonObject{{u"key"_s, u"%1:%2"_s.arg(S(g[u"source"_s]), has(g[u"variant"_s]) ? S(g[u"variant"_s]) : QString())},
                                  {u"tone"_s, tone.value(S(g[u"tone"_s]), u"info"_s)}, {u"title"_s, u"%1 · %2 条"_s.arg(S(g[u"label"_s]), S(g[u"signals"_s]))},
                                  {u"verdict"_s, S(g[u"verdict"_s])}, {u"rows"_s, rows}});
    }
    out[u"groups"_s] = groups;
    QStringList missing;
    for (const QJsonValue& m : arr(d[u"missing_symbols"_s])) missing << S(m);
    const QJsonValue recent = arr(d[u"recent"_s]).isEmpty() ? QJsonValue() : arr(d[u"recent"_s]).first();
    out[u"meta"_s] = strings({opt(!missing.isEmpty(), u"取不到日线:"_s + missing.join(u"、"_s)),
                              opt(T(d[u"dropped"_s][u"uncovered"_s]), u"%1 条比取到的日线还早,没算"_s.arg(S(d[u"dropped"_s][u"uncovered"_s]))),
                              opt(T(d[u"dropped"_s][u"no_baseline"_s]), u"%1 条之前的日线不够,没有基线"_s.arg(S(d[u"dropped"_s][u"no_baseline"_s]))),
                              opt(T(recent), u"最近一条:%1 %2 %3"_s.arg(fmtShort(recent[u"at"_s], in), S(recent[u"symbol"_s]), S(recent[u"label"_s])))});
    QJsonArray notes;
    for (const QJsonValue& n : arr(d[u"notes"_s])) notes.append(S(n));
    out[u"notes"_s] = notes;
    return out;
}

}  // namespace

QString usd(const QJsonValue& v) {
    if (!has(v) || !std::isfinite(N(v))) return u"—"_s;
    const double x = N(v);
    return u"%1$%2"_s.arg(x < 0 ? u"-"_s : x > 0 ? u"+"_s : QString(), track::fmtMoney(num(std::abs(x))));
}

std::optional<Sizing> sizePosition(const QJsonValue& equity, const QJsonValue& riskPct, const QJsonValue& unitRisk, const QJsonValue& losingStreak) {
    const auto ok = [](const QJsonValue& v) { return v.isDouble() && std::isfinite(v.toDouble()) && v.toDouble() > 0; };
    if (!ok(equity) || !ok(riskPct) || !ok(unitRisk) || riskPct.toDouble() >= 100) return std::nullopt;
    const double e = equity.toDouble(), p = riskPct.toDouble(), u = unitRisk.toDouble();
    Sizing s;
    s.budget = (e * p) / 100;
    s.units = std::floor(s.budget / u + 1e-9);
    s.actualRisk = s.units * u;
    s.actualPct = (s.actualRisk / e) * 100;
    if (ok(losingStreak)) s.streakDrawdownPct = (1 - ibkr::util::jsmath::pow(1 - p / 100, std::floor(losingStreak.toDouble()))) * 100;
    return s;
}

QJsonValue typicalUnitRisk(const QJsonValue& r) {
    QList<double> risks;
    for (const QJsonValue& t : arr(r[u"trades"_s]))
        if (has(t[u"risk"_s]) && S(t[u"kind"_s]) == u"butterfly" && std::isfinite(N(t[u"risk"_s]))) risks << N(t[u"risk"_s]);  // NaN 进 sort 是未定义行为
    std::sort(risks.begin(), risks.end());
    return risks.isEmpty() ? QJsonValue(QJsonValue::Null) : QJsonValue(risks[risks.size() / 2]);
}

QString ruleLabel(const QString& rule) {
    static const QHash<QString, QString> m{{u"daily_loss"_s, u"日内亏损上限"_s}, {u"stoploss_guard"_s, u"止损护栏"_s}, {u"cooldown"_s, u"同标的冷却"_s}};
    return m.value(rule, rule);
}

QString adviceText(const QJsonValue& a) {
    const QString rule = S(a[u"rule"_s]);
    const QJsonValue s = a[u"suggested"_s];
    if (rule == u"daily_loss") return u"当天净亏到 $%1 就停"_s.arg(S(s[u"max_loss_usd"_s]));
    if (rule == u"stoploss_guard")
        return u"%1 分钟内止损 %2 次 → 暂停 %3 分钟"_s.arg(S(s[u"lookback_minutes"_s]), S(s[u"trigger_count"_s]), S(s[u"pause_minutes"_s]));
    return u"平仓后 %1 分钟内不再对同一只下新单"_s.arg(S(s[u"minutes"_s]));
}

QJsonObject advicePatch(const QJsonValue& a) {
    const QString rule = S(a[u"rule"_s]);
    const QString key = rule == u"daily_loss" ? u"daily_loss"_s : rule == u"stoploss_guard" ? u"stoploss_guard"_s : u"cooldown"_s;
    return {{u"protections"_s, QJsonObject{{key, a[u"suggested"_s]}}}};
}

QString cardSubtitle(const QJsonValue& r, const QString& scope, const QString& kind, int days) {
    static const QHash<QString, QString> scopeLabel{{u"all"_s, u"全部账户"_s}, {u"live"_s, u"实盘"_s}, {u"paper"_s, u"模拟盘"_s}};
    static const QHash<QString, QString> kindLabel{{u"all"_s, u"全部品种"_s}, {u"butterfly"_s, u"蝴蝶"_s}, {u"stock"_s, u"股票"_s}, {u"option"_s, u"期权"_s}};
    QString s = scopeLabel.value(scope);
    if (scope == u"all") {
        const bool paper = N(r[u"mix"_s][u"paper"_s]) > 0, live = N(r[u"mix"_s][u"live"_s]) > 0;
        s = paper && live ? u"实盘 + 模拟盘"_s : paper ? u"模拟盘"_s : u"实盘"_s;
    }
    return u"%1 · %2 · %3"_s.arg(s, kindLabel.value(kind), days ? u"最近 %1 天"_s.arg(days) : u"全部时间"_s);
}

QString cardFootnote(const QJsonValue& r) {
    const double n = N(r[u"stats"_s][u"trades"_s]);
    const QString base = u"本机代码计算 · 不含账户信息 · 不构成投资建议"_s;
    return n < 20 ? u"样本 %1 笔,偏少 · %2"_s.arg(jsNumberToString(n), base) : base;
}

QString safeImageName(const QString& name) {
    QString out;
    const QString src = name.isEmpty() ? u"交易体检"_s : name;
    // Array.from 按码点走:代理对整个留着(码点不小于 32),再按 UTF-16 截 60
    for (qsizetype i = 0; i < src.size(); ++i) {
        const QChar c = src[i];
        out += c.unicode() < 32 || QStringView(u"\\/:*?\"<>|").contains(c) ? QChar(u'_') : c;
    }
    out.truncate(60);
    return out.isEmpty() ? u"交易体检"_s : out;
}

// { scope, kind, days, scopes, kinds, dayOptions, loading, error, working, empty, mix, share, findings, advice, stats, equity, groups, execution,
//   sizer, ledger, signals }
QJsonObject pageModel(const PageInput& in) {
    QJsonObject page;
    page[u"scope"_s] = in.scope;
    page[u"kind"_s] = in.kind;
    page[u"days"_s] = in.days;
    page[u"scopes"_s] = QJsonArray{QJsonObject{{u"value"_s, u"all"_s}, {u"label"_s, u"实盘 + 模拟"_s}}, QJsonObject{{u"value"_s, u"live"_s}, {u"label"_s, u"实盘"_s}},
                                   QJsonObject{{u"value"_s, u"paper"_s}, {u"label"_s, u"模拟"_s}}};
    page[u"kinds"_s] = QJsonArray{QJsonObject{{u"value"_s, u"all"_s}, {u"label"_s, u"全部品种"_s}}, QJsonObject{{u"value"_s, u"butterfly"_s}, {u"label"_s, u"蝴蝶"_s}},
                                  QJsonObject{{u"value"_s, u"stock"_s}, {u"label"_s, u"股票"_s}}, QJsonObject{{u"value"_s, u"option"_s}, {u"label"_s, u"期权(导入)"_s}}};
    page[u"dayOptions"_s] = QJsonArray{QJsonObject{{u"value"_s, 0}, {u"label"_s, u"全部时间"_s}}, QJsonObject{{u"value"_s, 30}, {u"label"_s, u"最近 30 天"_s}},
                                       QJsonObject{{u"value"_s, 90}, {u"label"_s, u"最近 90 天"_s}}, QJsonObject{{u"value"_s, 180}, {u"label"_s, u"最近半年"_s}},
                                       QJsonObject{{u"value"_s, 365}, {u"label"_s, u"最近一年"_s}}};
    page[u"loading"_s] = in.loading;
    page[u"error"_s] = in.error;
    const QJsonValue r = in.data;
    page[u"working"_s] = in.loading && !T(r);
    const bool trades = T(r) && T(r[u"stats"_s][u"trades"_s]);
    page[u"share"_s] = trades;
    page[u"empty"_s] = T(r) && !trades ? u"这个范围里还没有已了结的交易。连上 TWS 打开一次「交易分析」同步成交,或用命令行导入 Flex 期权仓位。"_s : QString();
    if (T(r) && T(r[u"mix"_s][u"live"_s]) && T(r[u"mix"_s][u"paper"_s]))
        page[u"mix"_s] = u"这个范围里实盘 %1 笔、模拟 %2 笔,下面的数字、结论和保护规则建议都是两边合起来算的。模拟盘的成交与滑点不是真的;要看真实水平,右上角切到「实盘」。"_s.arg(
            S(r[u"mix"_s][u"live"_s]), S(r[u"mix"_s][u"paper"_s]));
    page[u"hasData"_s] = trades;
    if (trades) {
        QJsonArray findings;
        for (const QJsonValue& f : arr(r[u"findings"_s]))
            findings.append(QJsonObject{{u"key"_s, S(f[u"id"_s])}, {u"tone"_s, findingTone(f[u"tone"_s])}, {u"title"_s, S(f[u"title"_s])}, {u"text"_s, S(f[u"text"_s])},
                                        {u"source"_s, u"借鉴:"_s + S(f[u"source"_s])}});
        page[u"findings"_s] = findings;
        QJsonArray advice;
        for (const QJsonValue& a : arr(r[u"protection_advice"_s]))
            advice.append(QJsonObject{{u"rule"_s, S(a[u"rule"_s])}, {u"title"_s, u"%1:%2"_s.arg(ruleLabel(S(a[u"rule"_s])), adviceText(a))}, {u"reason"_s, S(a[u"reason"_s])},
                                      {u"source"_s, u"借鉴:"_s + S(a[u"source"_s])}, {u"busy"_s, in.adviceBusy == S(a[u"rule"_s])}});
        page[u"advice"_s] = advice;
        page[u"stats"_s] = statsModel(r, in);
        const QJsonArray equity = arr(r[u"equity"_s]);
        if (equity.size() >= 2)
            page[u"equity"_s] = QJsonObject{{u"meta"_s, u"%1 → %2 · 共 %3 笔"_s.arg(fmtShort(equity.first()[u"time"_s], in), fmtShort(equity.last()[u"time"_s], in), QString::number(equity.size()))}};
        page[u"groups"_s] = groupsModel(r);
        page[u"execution"_s] = executionModel(r, in);
        page[u"sizer"_s] = sizerModel(r, in);
        if (!arr(r[u"trades"_s]).isEmpty()) page[u"ledger"_s] = ledgerModel(r, in);
    }
    page[u"signals"_s] = signalsModel(in);
    return page;
}

QStringList pageTexts(const QJsonObject& page) {
    QStringList t{u"绩效体检"_s};
    for (const QJsonValue& s : page[u"scopes"_s].toArray()) t << s[u"label"_s].toString();
    for (const QJsonValue& k : page[u"kinds"_s].toArray())
        if (k[u"value"_s] == page[u"kind"_s]) t << k[u"label"_s].toString();
    for (const QJsonValue& d : page[u"dayOptions"_s].toArray())
        if (d[u"value"_s].toInt() == page[u"days"_s].toInt()) t << d[u"label"_s].toString();
    t << u"重新计算"_s;
    if (page[u"share"_s].toBool()) t << u"分享卡片"_s;
    t << u"冠军们天天盯的几个数:胜率 × 盈亏比 = 期望值,再看回撤与行为。"_s;
    if (!page[u"error"_s].toString().isEmpty()) t << u"算不出来"_s << page[u"error"_s].toString();
    if (page[u"working"_s].toBool()) t << u"正在翻账本…"_s;
    if (!page[u"empty"_s].toString().isEmpty()) t << page[u"empty"_s].toString();
    if (page.contains(u"mix"_s)) t << u"实盘和模拟盘混在一起算"_s << page[u"mix"_s].toString();
    const auto tiles = [&](const QJsonValue& list) {
        for (const QJsonValue& x : list.toArray()) t << x[u"label"_s].toString() << fly::statisticParts(x[u"value"_s].toString());
    };
    const auto strs = [&](const QJsonValue& list) {
        for (const QJsonValue& x : list.toArray()) t << x.toString();
    };
    const auto table = [&](const QStringList& head, const QJsonValue& rows, const QStringList& keys, bool twice = false) {
        t << head;
        if (twice) t << head;
        for (const QJsonValue& row : rows.toArray())
            for (const QString& k : keys) {
                const QJsonValue c = row[u"cells"_s][k];
                t << (c.isObject() ? c[u"text"_s].toString() : c.toString());
            }
    };
    const auto pager = [&](const QJsonValue& table) {
        for (const QJsonValue& p : table[u"pager"_s].toArray())
            if (p.isDouble()) t << jsNumberToString(p.toDouble());
        if (table[u"sizeChanger"_s].toBool()) t << u"20 条/页"_s;
    };
    if (page[u"hasData"_s].toBool()) {
        t << u"体检结论"_s << QString::number(page[u"findings"_s].toArray().size());
        for (const QJsonValue& f : page[u"findings"_s].toArray()) t << f[u"title"_s].toString() << f[u"text"_s].toString() << f[u"source"_s].toString();
        const QJsonArray advice = page[u"advice"_s].toArray();
        if (!advice.isEmpty()) t << u"保护规则建议"_s << QString::number(advice.size());
        for (const QJsonValue& a : advice) t << a[u"title"_s].toString() << u"按建议填入"_s << a[u"reason"_s].toString() << a[u"source"_s].toString();
        t << u"核心数字"_s;
        const QJsonObject s = page[u"stats"_s].toObject();
        t << s[u"title"_s].toString();
        tiles(s[u"tiles"_s]);
        strs(s[u"meta1"_s]);
        strs(s[u"meta2"_s]);
        if (page[u"equity"_s].isObject()) t << u"平仓权益曲线(按笔)"_s << page[u"equity"_s][u"meta"_s].toString();
        t << u"分开看:优势在哪儿"_s;
        static const QStringList groupHead{QString(), u"笔数"_s, u"胜率"_s, u"净盈亏"_s, u"每笔期望"_s, u"利润因子"_s};
        static const QStringList kindExtra{u"盈亏比"_s, u"凯利"_s, u"R 期望"_s, u"R 盈亏比"_s, u"R 凯利"_s, u"SQN"_s};
        static const QStringList groupKeys{u"label"_s, u"trades"_s, u"win_rate"_s, u"net_pnl"_s, u"expectancy"_s, u"profit_factor"_s};
        static const QStringList kindKeys{u"payoff_ratio"_s, u"kelly"_s, u"expectancy_r"_s, u"payoff_r"_s, u"kelly_r"_s, u"sqn"_s};
        for (const QJsonValue& g : page[u"groups"_s][u"tables"_s].toArray()) {
            t << g[u"title"_s].toString();
            const bool wide = g[u"wide"_s].toBool();
            QStringList head = groupHead, keys = groupKeys;
            if (wide) head << kindExtra, keys << kindKeys;
            head.removeFirst();  // 第一列没有标题(空字不算一段)
            // 带横向滚动的表:SSR 里表头渲染两遍(量宽用的那一份藏在表体里)
            table(head, g[u"rows"_s], keys, wide);
        }
        strs(page[u"groups"_s][u"meta"_s]);
        if (page[u"execution"_s].isObject()) {
            const QJsonObject e = page[u"execution"_s].toObject();
            t << e[u"title"_s].toString();
            tiles(e[u"tiles"_s]);
            if (e[u"table"_s].isObject()) {
                table({u"触发"_s, u"标的"_s, u"路径"_s, u"触发价 → 成交"_s, u"让出(不含佣金)"_s, u"佣金"_s}, e[u"table"_s][u"rows"_s],
                      {u"at"_s, u"symbol"_s, u"path"_s, u"px"_s, u"cost"_s, u"commission"_s});
                pager(e[u"table"_s]);
            }
            strs(e[u"meta"_s]);
        }
        t << u"下一笔做多大"_s << u"仓位计算器 · 固定风险比例"_s << u"账户权益(美元)"_s << u"单笔风险(%)"_s << u"每份最大亏损(美元)"_s;
        const QJsonObject sz = page[u"sizer"_s].toObject();
        if (sz.contains(u"tiles"_s)) tiles(sz[u"tiles"_s]);
        else t << u"填上账户权益、单笔风险与每份最大亏损,就能算出做几份。"_s;
        strs(sz[u"meta"_s]);
        t << u"明细"_s;
        if (page[u"ledger"_s].isObject()) {
            const QJsonObject l = page[u"ledger"_s].toObject();
            t << l[u"title"_s].toString();
            table({u"了结"_s, u"交易"_s, u"盈亏"_s, u"R"_s, u"持有"_s}, l[u"table"_s][u"rows"_s], {u"closed_at"_s, u"label"_s, u"pnl"_s, u"r"_s, u"hold"_s});
            pager(l[u"table"_s]);
            strs(l[u"meta"_s]);
        }
    }
    t << u"信号成绩单"_s;
    const QJsonObject sg = page[u"signals"_s].toObject();
    t << sg[u"button"_s].toString() << u"价位提醒、盯异动、强势股新入选、K线 PA 读出的方向,每一条之后押对了没有;要连 TWS 取日线"_s;
    if (sg[u"working"_s].toBool()) t << u"正在逐只取日线…"_s;
    if (!sg[u"error"_s].toString().isEmpty()) t << u"算不出来"_s << sg[u"error"_s].toString();
    if (sg.contains(u"empty"_s)) t << sg[u"empty"_s].toString();
    for (const QJsonValue& g : sg[u"groups"_s].toArray()) {
        t << g[u"title"_s].toString() << g[u"verdict"_s].toString();
        table({u"持有"_s, u"走完(条)"_s, u"不重叠(段)"_s, u"平均"_s, u"押对"_s, u"随手一天"_s, u"多出"_s, u"t"_s}, g[u"rows"_s],
              {u"h"_s, u"n"_s, u"indep"_s, u"mean"_s, u"hit"_s, u"base"_s, u"edge"_s, u"t"_s});
    }
    if (sg.contains(u"groups"_s)) {
        strs(sg[u"meta"_s]);
        t << u"这些数是怎么算的、能信到什么程度"_s;
        strs(sg[u"notes"_s]);
    }
    return t;
}

QJsonValue equityChart(const QJsonValue& r) {
    const QJsonArray equity = arr(r[u"equity"_s]);
    if (equity.size() < 2) return QJsonValue::Null;
    QJsonArray times, eq, dd;
    for (int i = 0; i < equity.size(); ++i) {
        times.append(u"#%1"_s.arg(i + 1));
        eq.append(equity[i][u"equity"_s]);
        dd.append(-N(equity[i][u"drawdown"_s]));
    }
    return QJsonObject{
        {u"ariaLabel"_s, u"平仓权益曲线"_s},
        {u"viewKey"_s, u"%1|%2|%3|%4"_s.arg(S(r[u"scope"_s]), S(r[u"kind"_s]), has(r[u"days"_s]) ? S(r[u"days"_s]) : u"all"_s).arg(equity.size())},
        {u"times"_s, times},
        {u"lines"_s, QJsonArray{QJsonObject{{u"values"_s, eq}, {u"color"_s, u"blue"_s}, {u"width"_s, 1.5}, {u"label"_s, u"累计已实现盈亏"_s}},
                                QJsonObject{{u"values"_s, dd}, {u"color"_s, u"down"_s}, {u"alpha"_s, 0.5}, {u"label"_s, u"离峰值"_s}}}},
        {u"hlines"_s, QJsonArray{QJsonObject{{u"price"_s, 0}, {u"color"_s, u"label"_s}, {u"dash"_s, QJsonArray{3, 3}}, {u"alpha"_s, 0.25}, {u"tag"_s, false}}}},
        {u"legend"_s, QJsonArray{QJsonArray{u"—"_s, u"blue"_s, u"累计已实现盈亏"_s}, QJsonArray{u"—"_s, u"down"_s, u"离峰值的回撤"_s}, QJsonArray{u"╌"_s, u"label2"_s, u"0"_s}}},
        {u"decimals"_s, 2},
    };
}

}  // namespace ibkr::shell::performance
