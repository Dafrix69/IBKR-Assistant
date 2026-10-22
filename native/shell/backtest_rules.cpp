#include "shell/backtest_rules.h"

#include "shell/fly_rules.h"
#include "shell/jsvalue.h"
#include "shell/track_rules.h"

#include <QRegularExpression>

#include <cmath>

namespace ibkr::shell::backtest {

using namespace Qt::StringLiterals;

namespace {

QString S(const QJsonValue& v) { return jsString(v); }
double N(const QJsonValue& v) { return jsNumber(v); }
bool T(const QJsonValue& v) { return jsTruthy(v); }
/// != null(undefined 与 null 都算没有)
bool has(const QJsonValue& v) { return !v.isUndefined() && !v.isNull(); }
QJsonArray arr(const QJsonValue& v) { return v.toArray(); }

/// Object.keys 的次序:读进来时记下的 "__keys"(见 OJson::toQJsonKeyed),没有就按 QJsonObject 的次序
QStringList keysOf(const QJsonValue& o) {
    QStringList out;
    const QJsonArray order = o[u"__keys"_s].toArray();
    if (!order.isEmpty()) {
        for (const QJsonValue& k : order) out << k.toString();
        return out;
    }
    for (const QString& k : o.toObject().keys())
        if (k != u"__keys") out << k;
    return out;
}

const QHash<QString, QString>& instMap() {
    static const QHash<QString, QString> m = [] {
        QHash<QString, QString> h;
        for (const auto& [k, v] : instLabels()) h.insert(k, v);
        return h;
    }();
    return m;
}

QString pct(const QJsonValue& v) { return !has(v) ? u"—"_s : u"%1%2%"_s.arg(N(v) > 0 ? u"+"_s : QString(), S(v)); }
QString tone(const QJsonValue& v) { return !has(v) ? QString() : N(v) > 0 ? u"pos"_s : N(v) < 0 ? u"neg"_s : QString(); }
QString paramText(const QJsonValue& p) {
    QStringList parts;
    for (const QString& k : keysOf(p)) parts << u"%1=%2"_s.arg(k, S(p[k]));
    return parts.join(u" · "_s);
}
/// 概率:0.1234 → 12.3%
QString prob(const QJsonValue& v) { return !has(v) ? u"—"_s : jsNumberToString(jsRound(N(v) * 1000) / 10) + u"%"_s; }
/// BacktestResult 的 sign:正 pos、负 neg、其余空(NaN 也是空)
QString sign(double v) { return v > 0 ? u"pos"_s : v < 0 ? u"neg"_s : QString(); }

QJsonObject strategyOf(const PageInput& in) {
    for (const QJsonValue& s : in.strategies)
        if (S(s[u"key"_s]) == in.strategyKey) return s.toObject();
    return {};
}

QJsonObject operandModel(const QJsonValue& o) {
    const QString choice = S(o[u"kind"_s]) == u"const" ? u"const"_s : T(o[u"name"_s]) ? S(o[u"name"_s]) : u"close"_s;
    const bool needsNum = choice == u"const" || needsPeriod(choice);
    QString label = choice;
    for (const auto& [k, v] : indicatorOptions())
        if (k == choice) label = v;
    const QJsonValue num = choice == u"const" ? o[u"value"_s] : o[u"period"_s];
    return {{u"choice"_s, choice}, {u"label"_s, label}, {u"needsNum"_s, needsNum}, {u"num"_s, has(num) ? num : QJsonValue(QJsonValue::Null)},
            {u"placeholder"_s, choice == u"const" ? u"数值"_s : u"周期"_s}};
}

const QString kUntested = u" · 几乎没回撤过"_s;
const QString kUntestedTip = u"样本内的回撤还不到它在场时一天的典型波动:基本没经历过回撤(多半只进过一两次场),名次不可靠"_s;

/// AntD 小号分页:页数 ≤ 7 全列出来;多了列 1、当前前后两页、最后一页,中间用「…」顶(jump-prev / jump-next 不是字)
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

QJsonValue resultModel(const QJsonValue& r, const QString& strategyLabel) {
    // 回执里没有这一项时是 NaN,照样显示,不拿界面自己的减法顶
    const double beat = N(r[u"excess_return_pct"_s]);
    const auto num = [](const QJsonValue& v, const QString& suffix) { return !has(v) ? u"—"_s : S(v) + suffix; };
    const auto signedPct = [](const QJsonValue& v) { return !has(v) ? u"—"_s : u"%1%2%"_s.arg(N(v) > 0 ? u"+"_s : QString(), S(v)); };
    const QJsonValue inst = r[u"instrument"_s];
    const QString instType = S(inst[u"type"_s]);
    const QString instLabel = T(inst) && instType != u"stock"
                                  ? u" · %1(DTE %2,投入 %3%)"_s.arg(instMap().value(instType, instType), S(inst[u"dte"_s]), S(inst[u"risk_pct"_s]))
                                  : QString();
    QJsonObject out;
    out[u"tone"_s] = beat >= 0 ? u"ok"_s : u"warn"_s;
    out[u"title"_s] = u"%1 · %2%3 · %4 ~ %5(%6 根日线)"_s.arg(S(r[u"symbol"_s]), !strategyLabel.isEmpty() ? strategyLabel : S(r[u"strategy"_s]), instLabel,
                                                                S(r[u"start"_s]), S(r[u"end"_s]), S(r[u"bars"_s]));
    const auto tile = [](const QString& label, const QString& value, const QString& t = QString()) { return QJsonObject{{u"label"_s, label}, {u"value"_s, value}, {u"tone"_s, t}}; };
    out[u"tiles"_s] = QJsonArray{
        tile(u"策略收益"_s, S(r[u"total_return_pct"_s]) + u"%"_s, sign(N(r[u"total_return_pct"_s]))),
        tile(u"买入持有"_s, S(r[u"buy_hold_return_pct"_s]) + u"%"_s, sign(N(r[u"buy_hold_return_pct"_s]))),
        tile(u"超额"_s, (beat >= 0 ? u"+"_s : QString()) + jsToFixed(beat, 2) + u"%"_s, sign(beat)),
        tile(u"年化"_s, S(r[u"annualized_pct"_s]) + u"%"_s),
        tile(u"最大回撤"_s, S(r[u"max_drawdown_pct"_s]) + u"%"_s, u"neg"_s),
        tile(u"年化波动"_s, num(r[u"volatility_pct"_s], u"%"_s)),
        tile(u"Sharpe"_s, num(r[u"sharpe"_s], QString())),
        tile(u"Sortino"_s, num(r[u"sortino"_s], QString())),
        tile(u"持仓时间占比"_s, S(r[u"exposure_pct"_s]) + u"%"_s),
    };
    out[u"riskMeta"_s] = u"Sharpe / Sortino 按逐日净值算,无风险利率按 0、一年 252 个交易日"_s;
    out[u"statsTitle"_s] = u"交易统计(已平仓 %1 笔 / 共 %2 笔)"_s.arg(S(r[u"closed_trades"_s]), S(r[u"trades"_s]));
    if (T(r[u"closed_trades"_s])) {
        out[u"statTiles"_s] = QJsonArray{
            tile(u"胜率"_s, num(r[u"win_rate_pct"_s], u"%"_s)),
            tile(u"平均盈利"_s, signedPct(r[u"avg_win_pct"_s]), has(r[u"avg_win_pct"_s]) ? u"pos"_s : QString()),
            tile(u"平均亏损"_s, signedPct(r[u"avg_loss_pct"_s]), has(r[u"avg_loss_pct"_s]) ? u"neg"_s : QString()),
            tile(u"盈亏比"_s, num(r[u"payoff_ratio"_s], QString())),
            tile(u"盈利因子"_s, num(r[u"profit_factor"_s], QString())),
            tile(u"每笔期望"_s, signedPct(r[u"expectancy_pct"_s]), sign(has(r[u"expectancy_pct"_s]) ? N(r[u"expectancy_pct"_s]) : 0)),
        };
    } else {
        out[u"statsEmpty"_s] = u"还没有已平仓的交易:胜率、盈亏比这些要有了结的交易才算,没平的那一笔不算数。"_s;
    }
    if (T(r[u"rules"_s])) {
        QStringList entry, exit;
        for (const QJsonValue& c : arr(r[u"rules"_s][u"entry"_s])) entry << fmtCond(c);
        for (const QJsonValue& c : arr(r[u"rules"_s][u"exit"_s])) exit << fmtCond(c);
        out[u"rules"_s] = QJsonObject{{u"entry"_s, u"入场:"_s + entry.join(u" 且 "_s)},
                                      {u"exit"_s, exit.isEmpty() ? u"出场:持有到区间结束"_s : u"出场:"_s + exit.join(u" 且 "_s)}};
    }
    const QJsonArray curve = arr(r[u"curve"_s]);
    out[u"curveTitle"_s] = u"净值曲线(起点 = 1.0)"_s;
    out[u"hasChart"_s] = curve.size() >= 2;
    if (curve.size() >= 2) {
        const QJsonValue first = curve.first(), last = curve.last();
        out[u"curveMeta"_s] = QJsonArray{u"%1 → %2 · 期末净值 策略 %3 / 基准 %4"_s.arg(S(first[u"date"_s]), S(last[u"date"_s]), S(last[u"equity"_s]), S(last[u"bench"_s])),
                                         T(r[u"cost_pct"_s]) ? u"已扣每边成交成本 %1%"_s.arg(S(r[u"cost_pct"_s])) : u"未扣成交成本"_s};
    }
    const QJsonArray trades = arr(r[u"trade_list"_s]);
    if (!trades.isEmpty() && S(r[u"strategy"_s]) != u"buy_hold") {
        QJsonArray rows;
        for (const QJsonValue& t : trades) {
            QStringList strikes;
            for (const QJsonValue& k : arr(t[u"strikes"_s])) strikes << S(k);
            const double ret = N(t[u"return_pct"_s]);
            rows.append(QJsonObject{{u"when"_s, u"%1 → %2%3"_s.arg(S(t[u"entry_date"_s]), T(t[u"exit_date"_s]) ? S(t[u"exit_date"_s]) : u"持有中"_s,
                                                                 strikes.isEmpty() ? QString() : u" · 行权价 "_s + strikes.join(u" / "_s))},
                                    {u"price"_s, u"%1 → %2"_s.arg(track::fmtMoney(t[u"entry_price"_s]), track::fmtMoney(t[u"exit_price"_s]))},
                                    {u"ok"_s, ret >= 0}, {u"ret"_s, u"%1%2%"_s.arg(ret >= 0 ? u"+"_s : QString(), S(t[u"return_pct"_s]))}});
        }
        out[u"trades"_s] = QJsonObject{{u"title"_s, u"交易明细(%1)"_s.arg(trades.size())}, {u"rows"_s, rows}};
    }
    QJsonArray notes;
    for (const QJsonValue& n : arr(r[u"notes"_s])) notes.append(u"· "_s + S(n));
    const bool option = T(inst) && instType != u"stock";
    out[u"notice"_s] = QJsonObject{{u"text"_s, u"收盘出信号、下一根开盘成交,单标的%1。历史收益不代表未来;参数越漂亮越要怀疑过拟合。"_s.arg(option ? u"、每笔按净值的固定比例投入"_s : u"全仓"_s)},
                                   {u"notes"_s, notes}};
    return out;
}

QJsonObject sweepModel(const PageInput& in, const QJsonObject& strategy) {
    const QString key = S(strategy.value("key"_L1));
    QJsonObject out;
    const bool sweepable = !strategy.isEmpty() && key != u"custom" && key != u"buy_hold";
    out[u"sweepable"_s] = sweepable;
    if (!sweepable) {
        out[u"hint"_s] = u"选一个带参数的预置策略(均线交叉、RSI、N 日突破)才能扫参数。"_s;
        return out;
    }
    const QJsonObject grid = defaultGrid(strategy);
    const QJsonValue params = strategy.value("params"_L1);
    QJsonArray rows;
    for (const QString& k : keysOf(params)) {
        const QJsonValue label = strategy.value("param_labels"_L1)[k];
        rows.append(QJsonObject{{u"key"_s, k}, {u"label"_s, u"%1 试哪些值"_s.arg(T(label) ? S(label) : k)}, {u"sub"_s, k},
                                {u"value"_s, in.swGrid.contains(k) ? in.swGrid.value(k).toString() : grid.value(k).toString()}});
    }
    out[u"extra"_s] = in.swExtra;
    out[u"gridRows"_s] = rows;
    out[u"split"_s] = in.swSplit;
    out[u"folds"_s] = in.swFolds;
    out[u"objective"_s] = in.swObjective;
    out[u"canRun"_s] = !jsTrim(in.symbol).isEmpty();
    out[u"running"_s] = in.swRunning;
    out[u"failure"_s] = in.swFailure;
    const QJsonValue res = in.swResult;
    if (!T(res) || in.swRunning) return out;
    const QJsonValue best = res[u"best"_s];
    const QJsonValue wf = res[u"walk_forward"_s];
    const QJsonArray resultRows = arr(res[u"rows"_s]);
    // 名次的分母是进了排名的全部组合,不是表里列出来的前 20 组
    const QJsonValue ranked = has(res[u"ranked"_s]) ? res[u"ranked"_s] : QJsonValue(double(resultRows.size()));
    // 不设"相关多少算好"的线,所以没有绿灯;只在两件不用拍脑袋的事上亮黄
    const bool worse = has(best) && has(res[u"oos_median_return_pct"_s]) && N(best[u"oos"_s][u"return_pct"_s]) < N(res[u"oos_median_return_pct"_s]);
    const bool corrBad = has(res[u"rank_corr"_s]) && N(res[u"rank_corr"_s]) <= 0;
    QStringList symbols;
    for (const QJsonValue& s : arr(res[u"symbols"_s])) symbols << S(s);
    QJsonObject r;
    r[u"tone"_s] = corrBad || worse ? u"warn"_s : u"info"_s;
    r[u"title"_s] = u"%1 · %2 → %3 · 样本外从 %4 起"_s.arg(symbols.join(u"、"_s), S(res[u"start"_s]), S(res[u"end"_s]), S(res[u"split_date"_s]));
    const auto tile = [](const QString& label, const QString& value, const QString& t = QString()) { return QJsonObject{{u"label"_s, label}, {u"value"_s, value}, {u"tone"_s, t}}; };
    const QJsonValue p = res[u"rank_corr_p"_s];
    QJsonArray tiles{
        tile(u"样本内第一名"_s, has(best) ? paramText(best[u"params"_s]) : u"—"_s),
        tile(u"它在样本内"_s, pct(best[u"is"_s][u"return_pct"_s]), tone(best[u"is"_s][u"return_pct"_s])),
        tile(u"它在样本外"_s, pct(best[u"oos"_s][u"return_pct"_s]), tone(best[u"oos"_s][u"return_pct"_s])),
        tile(u"全部组合样本外的中位数"_s, pct(res[u"oos_median_return_pct"_s]), tone(res[u"oos_median_return_pct"_s])),
        tile(u"样本外名次"_s, has(best) ? u"%1 / %2"_s.arg(S(best[u"oos_rank"_s]), S(ranked)) : u"—"_s),
        tile(u"随手挑一组不比它差的概率"_s, prob(res[u"pick_p"_s])),
        tile(u"样本内外排名相关"_s, !has(res[u"rank_corr"_s]) ? u"—"_s : S(res[u"rank_corr"_s])),
        tile(u"相关的 p 值(置换检验)"_s, !has(p) ? u"—"_s : N(p) < 0.001 ? u"< 0.001"_s : S(p)),
    };
    if (T(wf)) {
        tiles.append(tile(u"滚动前推 %1 折"_s.arg(arr(wf[u"folds"_s]).size()), pct(wf[u"total_return_pct"_s]), tone(wf[u"total_return_pct"_s])));
        tiles.append(tile(u"同期买入持有"_s, pct(wf[u"bench_return_pct"_s])));
    }
    r[u"tiles"_s] = tiles;
    QJsonArray meta;
    const int skipped = int(arr(res[u"skipped"_s]).size());
    meta.append(u"试了 %1 组%2"_s.arg(S(res[u"combos"_s]), skipped ? u",%1 组不合法跳过"_s.arg(skipped) : QString()));
    if (T(res[u"cost_pct"_s])) meta.append(u"每边成本 %1%"_s.arg(S(res[u"cost_pct"_s])));
    for (const QJsonValue& n : arr(res[u"notes"_s])) meta.append(S(n));
    r[u"meta"_s] = meta;
    // 每组一行,10 行一页(只有一页时不出分页)
    const int pages = std::max(1, int((resultRows.size() + 9) / 10));
    const int page = std::clamp(in.swPage, 1, pages);
    QJsonArray table;
    for (qsizetype i = (page - 1) * 10; i < std::min<qsizetype>(resultRows.size(), page * 10); ++i) {
        const QJsonValue row = resultRows[i];
        table.append(QJsonObject{{u"key"_s, paramText(row[u"params"_s])}, {u"params"_s, paramText(row[u"params"_s])}, {u"untested"_s, T(row[u"is"_s][u"dd_under_one_day"_s])},
                                 {u"is"_s, pct(row[u"is"_s][u"return_pct"_s])}, {u"isTone"_s, tone(row[u"is"_s][u"return_pct"_s])},
                                 {u"oos"_s, pct(row[u"oos"_s][u"return_pct"_s])}, {u"oosTone"_s, tone(row[u"oos"_s][u"return_pct"_s])},
                                 {u"bench"_s, pct(row[u"oos"_s][u"bench_return_pct"_s])},
                                 {u"excess"_s, pct(row[u"oos"_s][u"excess_return_pct"_s])}, {u"excessTone"_s, tone(row[u"oos"_s][u"excess_return_pct"_s])},
                                 {u"dd"_s, pct(row[u"oos"_s][u"max_drawdown_pct"_s])}, {u"rank"_s, has(row[u"oos_rank"_s]) ? S(row[u"oos_rank"_s]) : QString()}});
    }
    r[u"rows"_s] = table;
    r[u"page"_s] = page;
    r[u"pages"_s] = pages;
    r[u"pager"_s] = pagerItems(pages, page);
    // AntD 的分页过了 50 条自己带上「每页几条」的下拉;页大小是写死的 10,选别的也还是 10
    r[u"sizeChanger"_s] = pages > 1 && resultRows.size() > 50;
    if (T(wf)) {
        QJsonArray folds;
        for (const QJsonValue& f : arr(wf[u"folds"_s]))
            folds.append(QJsonObject{{u"key"_s, S(f[u"test_start"_s])}, {u"trainEnd"_s, S(f[u"train_end"_s])},
                                     {u"test"_s, u"%1 → %2"_s.arg(S(f[u"test_start"_s]), S(f[u"test_end"_s]))}, {u"params"_s, paramText(f[u"params"_s])},
                                     {u"untested"_s, T(f[u"dd_under_one_day"_s])}, {u"ret"_s, pct(f[u"test_return_pct"_s])}, {u"retTone"_s, tone(f[u"test_return_pct"_s])},
                                     {u"bench"_s, pct(f[u"bench_return_pct"_s])}});
        r[u"folds"_s] = folds;
    }
    out[u"result"_s] = r;
    return out;
}

QJsonObject instrumentOf(const PageInput& in) {
    if (in.instType == u"stock") return {{u"type"_s, u"stock"_s}};
    const auto orDefault = [&](const char* k, double d) { const QJsonValue v = in.inst.value(QLatin1StringView(k)); return T(v) ? v : QJsonValue(d); };
    return {{u"type"_s, in.instType}, {u"dte"_s, orDefault("dte", 30)}, {u"offset_pct"_s, orDefault("offset", 0)}, {u"width_pct"_s, orDefault("width", 2)},
            {u"risk_pct"_s, orDefault("risk", 10)}};
}

}  // namespace

const QList<std::pair<QString, QString>>& instLabels() {
    static const QList<std::pair<QString, QString>> l{{u"stock"_s, u"正股"_s}, {u"call"_s, u"买入看涨期权"_s}, {u"put"_s, u"买入看跌期权"_s},
                                                      {u"call_spread"_s, u"看涨借方价差"_s}, {u"put_spread"_s, u"看跌借方价差"_s}, {u"butterfly"_s, u"买入蝴蝶"_s}};
    return l;
}
const QList<std::pair<QString, QString>>& indicatorOptions() {
    static const QList<std::pair<QString, QString>> l{{u"close"_s, u"收盘价"_s}, {u"open"_s, u"开盘价"_s}, {u"high"_s, u"最高价"_s}, {u"low"_s, u"最低价"_s},
                                                      {u"sma"_s, u"SMA均线"_s}, {u"ema"_s, u"EMA均线"_s}, {u"rsi"_s, u"RSI"_s},
                                                      {u"highest"_s, u"前N日最高"_s}, {u"lowest"_s, u"前N日最低"_s}, {u"change_pct"_s, u"N日涨跌幅%"_s},
                                                      {u"const"_s, u"常数"_s}};
    return l;
}
const QList<std::pair<QString, QString>>& opOptions() {
    static const QList<std::pair<QString, QString>> l{{u">"_s, u">"_s}, {u"<"_s, u"<"_s}, {u">="_s, u"≥"_s}, {u"<="_s, u"≤"_s}, {u"cross_up"_s, u"上穿"_s}, {u"cross_down"_s, u"下穿"_s}};
    return l;
}
bool needsPeriod(const QString& name) {
    static const QSet<QString> s{u"sma"_s, u"ema"_s, u"rsi"_s, u"highest"_s, u"lowest"_s, u"change_pct"_s};
    return s.contains(name);
}

QString fmtOperand(const QJsonValue& o) {
    if (S(o[u"kind"_s]) == u"const") return S(o[u"value"_s]);
    const QString name = S(o[u"name"_s]);
    QString label = name;
    for (const auto& [k, v] : indicatorOptions())
        if (k == name) label = v;
    return label + (T(o[u"period"_s]) ? u"(%1)"_s.arg(S(o[u"period"_s])) : QString());
}

QString fmtCond(const QJsonValue& c) {
    const QString op = S(c[u"op"_s]);
    QString opLabel = op;
    for (const auto& [k, v] : opOptions())
        if (k == op) opLabel = v;
    return u"%1 %2 %3"_s.arg(fmtOperand(c[u"left"_s]), opLabel, fmtOperand(c[u"right"_s]));
}

QJsonObject pickOperand(const QJsonObject& operand, const QString& next) {
    // 原版 { kind: 'const', value: operand.value }:没有 value 时那个键是 undefined,JSON 里不出现
    if (next == u"const") {
        QJsonObject o{{u"kind"_s, u"const"_s}};
        if (operand.contains(u"value"_s) && !operand.value(u"value"_s).isUndefined()) o.insert(u"value"_s, operand.value(u"value"_s));
        return o;
    }
    QJsonObject o{{u"kind"_s, u"indicator"_s}, {u"name"_s, next}};
    if (needsPeriod(next)) o.insert(u"period"_s, T(operand.value(u"period"_s)) ? operand.value(u"period"_s) : QJsonValue(20));
    return o;
}

QJsonObject defaultGrid(const QJsonValue& strategy) {
    QJsonObject out;
    const QJsonValue params = strategy[u"params"_s];
    for (const QString& k : keysOf(params)) {
        const double v = N(params[k]);
        out.insert(k, u"%1, %2, %3"_s.arg(jsNumberToString(std::max(1.0, jsRound(v / 2))), jsNumberToString(v), jsNumberToString(jsRound(v * 1.5))));
    }
    return out;
}

QJsonArray parseValues(const QString& text) {
    // JS 的 \s 认 Unicode 空白(全角空格 U+3000、NBSP 都算);QRegularExpression 要开 Unicode 属性才一样
    static const QRegularExpression sep(u"[,,\\s]+"_s, QRegularExpression::UseUnicodePropertiesOption);
    QJsonArray out;
    for (const QString& part : text.split(sep)) {
        // Number(''):0,丢掉;Number('1e2'):100;Number('0x10'):16——都照 JS
        const double x = jsNumber(QJsonValue(part));
        if (std::isfinite(x) && x > 0) out.append(x);
    }
    return out;
}

QJsonObject defaultRules() {
    return {{u"entry"_s, QJsonArray{QJsonObject{{u"left"_s, QJsonObject{{u"kind"_s, u"indicator"_s}, {u"name"_s, u"rsi"_s}, {u"period"_s, 14}}}, {u"op"_s, u"<"_s},
                                                {u"right"_s, QJsonObject{{u"kind"_s, u"const"_s}, {u"value"_s, 30}}}}}},
            {u"exit"_s, QJsonArray{QJsonObject{{u"left"_s, QJsonObject{{u"kind"_s, u"indicator"_s}, {u"name"_s, u"rsi"_s}, {u"period"_s, 14}}}, {u"op"_s, u">"_s},
                                               {u"right"_s, QJsonObject{{u"kind"_s, u"const"_s}, {u"value"_s, 70}}}}}}};
}

// { headExtra, symbol, start, end, strategyOptions, strategy, strategyLabel, custom, builder, params: [{ key, label, sub, value }],
//   instOptions, instType, instLabel, isOption, instRows: [{ key, label, sub, min, max, step, value }], cost: { sub, value }, hint, optionHint,
//   flow: { entry, exit | null, buy, sell, hold } | null, running, failure, result | null, sweep }
QJsonObject pageModel(const PageInput& in) {
    QJsonObject page;
    const QJsonObject strategy = strategyOf(in);
    const QString key = S(strategy.value("key"_L1));
    page[u"headExtra"_s] = u"日线 · 收盘出信号、下一根开盘成交 · 全仓进出"_s;
    page[u"symbol"_s] = in.symbol;
    page[u"start"_s] = in.start;
    page[u"end"_s] = in.end;
    QJsonArray strategyOptions;
    QString strategyLabel = in.strategyKey;  // 不在目录里的键:AntD 的 Select 原样显示值
    for (const QJsonValue& s : in.strategies) {
        strategyOptions.append(QJsonObject{{u"value"_s, S(s[u"key"_s])}, {u"label"_s, S(s[u"label"_s])}});
        if (S(s[u"key"_s]) == in.strategyKey) strategyLabel = S(s[u"label"_s]);
    }
    page[u"strategyOptions"_s] = strategyOptions;
    page[u"strategy"_s] = in.strategyKey;
    page[u"strategyLabel"_s] = strategyLabel;
    const bool custom = key == u"custom";
    page[u"custom"_s] = custom;
    const QJsonObject rules = in.rules.isEmpty() ? defaultRules() : in.rules;
    if (custom) {
        QJsonArray sections;
        for (const auto& [k, title] : {std::pair{u"entry"_s, u"入场条件(全部满足才买入)"_s}, std::pair{u"exit"_s, u"出场条件(全部满足才卖出;留空 = 持有到区间结束)"_s}}) {
            QJsonArray conds;
            for (const QJsonValue& c : arr(rules.value(k))) {
                QString opLabel = S(c[u"op"_s]);
                for (const auto& [ok, ov] : opOptions())
                    if (ok == S(c[u"op"_s])) opLabel = ov;
                conds.append(QJsonObject{{u"left"_s, operandModel(c[u"left"_s])}, {u"op"_s, S(c[u"op"_s])}, {u"opLabel"_s, opLabel}, {u"right"_s, operandModel(c[u"right"_s])}});
            }
            sections.append(QJsonObject{{u"key"_s, k}, {u"title"_s, title}, {u"conds"_s, conds}});
        }
        page[u"builder"_s] = QJsonObject{{u"text"_s, in.ruleText}, {u"generating"_s, in.generating}, {u"button"_s, in.generating ? u"生成中…"_s : u"AI 生成条件"_s},
                                        {u"sections"_s, sections}};
    } else {
        page[u"builder"_s] = QJsonValue::Null;
    }
    QJsonArray params;
    if (!strategy.isEmpty() && !custom) {
        for (const QString& k : keysOf(strategy.value("params"_L1))) {
            const QJsonValue label = strategy.value("param_labels"_L1)[k];
            // 认得出就用中文名,认不出退回原名——总比显示 "参数 buy_below" 强
            params.append(QJsonObject{{u"key"_s, k}, {u"label"_s, T(label) ? S(label) : k}, {u"sub"_s, T(label) ? k : QString()},
                                      {u"value"_s, in.params.contains(k) && !in.params.value(k).isUndefined() ? in.params.value(k) : QJsonValue(QJsonValue::Null)}});
        }
    }
    page[u"params"_s] = params;
    QJsonArray instOptions;
    for (const auto& [k, v] : instLabels()) instOptions.append(QJsonObject{{u"value"_s, k}, {u"label"_s, v}});
    page[u"instOptions"_s] = instOptions;
    page[u"instType"_s] = in.instType;
    page[u"instLabel"_s] = instMap().value(in.instType, in.instType);
    const bool isOption = in.instType != u"stock";
    page[u"isOption"_s] = isOption;
    const auto instRow = [&](const QString& k, const QString& label, const QString& sub, double min, double max, double step) {
        return QJsonObject{{u"key"_s, k}, {u"label"_s, label}, {u"sub"_s, sub}, {u"min"_s, min}, {u"max"_s, max}, {u"step"_s, step}, {u"value"_s, in.inst.value(k)}};
    };
    page[u"instRows"_s] = isOption ? QJsonArray{instRow(u"dte"_s, u"到期天数"_s, u"DTE"_s, 1, 365, 1), instRow(u"offset"_s, u"行权价偏移"_s, u"% 相对入场价"_s, -30, 30, 0.5),
                                                instRow(u"width"_s, u"宽度 / 翼宽"_s, u"% 相对入场价"_s, 0.5, 20, 0.5), instRow(u"risk"_s, u"单笔投入"_s, u"% 净值"_s, 1, 100, 1)}
                                   : QJsonArray{};
    page[u"cost"_s] = QJsonObject{{u"sub"_s, isOption ? u"%,占权利金:佣金 + 半个买卖价差"_s : u"%,占成交额:佣金 + 半个买卖价差"_s}, {u"value"_s, in.cost}};
    page[u"hint"_s] = !strategy.isEmpty() && T(strategy.value("desc"_L1)) ? S(strategy.value("desc"_L1)) : QString();
    // 原版 JSX 跨行的文字在折行处并成一个空格
    page[u"optionHint"_s] = isOption ? u"期权按标的历史走势 + Black-Scholes 理论价模拟:波动率用近 20 日已实现波动率、每天重估(r=0,无偏斜与买卖价差), 时间按交易日计,行权价贴标准挂牌间隔。"
                                       u"已实现波动率通常低于市场的隐含波动率,单腿买方会被算便宜; 前 20 根日线只用来算波动率,不开仓;理论价不到 0.01 美元的也不开仓。 "
                                       u"信号出场按下一根开盘的模型价,到期按内在价值结算,信号持续则下一根开盘续仓。仅用于比较相对优劣。"_s
                                     : QString();
    if (!strategy.isEmpty()) {
        QStringList entry, exit;
        for (const QJsonValue& c : arr(rules.value("entry"_L1))) entry << fmtCond(c);
        for (const QJsonValue& c : arr(rules.value("exit"_L1))) exit << fmtCond(c);
        const QString entryText = custom ? (entry.isEmpty() ? u"(未设置)"_s : entry.join(u" 且 "_s)) : T(strategy.value("desc"_L1)) ? S(strategy.value("desc"_L1)) : QString();
        const QJsonValue exitText = custom ? (exit.isEmpty() ? QJsonValue(QJsonValue::Null) : QJsonValue(exit.join(u" 且 "_s)))
                                    : key == u"buy_hold"         ? QJsonValue(QJsonValue::Null)
                                                                 : QJsonValue(u"策略离场信号触发"_s);
        const QString buy = isOption ? u"%1 · DTE %2 · 偏移 %3% · 投入 %4% 净值 · 下一根开盘按模型价"_s.arg(instMap().value(in.instType, S(QJsonValue())), S(in.inst.value("dte"_L1)),
                                                                                                          S(in.inst.value("offset"_L1)), S(in.inst.value("risk"_L1)))
                                     : u"全仓买入正股(下一根开盘价成交)"_s;
        page[u"flow"_s] = QJsonObject{{u"entry"_s, entryText}, {u"exit"_s, exitText}, {u"buy"_s, buy},
                                      {u"sell"_s, isOption ? u"下一根开盘按模型价卖出;到期按内在价值结算"_s : u"全仓卖出(下一根开盘价成交)"_s},
                                      {u"hold"_s, isOption ? u"持有至到期,按内在价值结算"_s : u"持有到区间结束"_s}};
    } else {
        page[u"flow"_s] = QJsonValue::Null;
    }
    page[u"running"_s] = in.running;
    page[u"failure"_s] = in.failure;
    page[u"result"_s] = T(in.result) && !in.running ? resultModel(in.result, S(strategy.value("label"_L1)) == u"undefined" ? QString() : S(strategy.value("label"_L1)))
                                                    : QJsonValue(QJsonValue::Null);
    page[u"sweep"_s] = sweepModel(in, strategy);
    return page;
}

QStringList pageTexts(const QJsonObject& page) {
    QStringList t{u"回测"_s, page[u"headExtra"_s].toString(), u"标的"_s, u"区间"_s, u"日线,含首尾"_s, u"策略"_s};
    if (!page[u"strategy"_s].toString().isEmpty()) t << page[u"strategyLabel"_s].toString();
    if (page[u"builder"_s].isObject()) {
        const QJsonObject b = page[u"builder"_s].toObject();
        t << b[u"button"_s].toString();
        for (const QJsonValue& s : b[u"sections"_s].toArray()) {
            t << s[u"title"_s].toString();
            for (const QJsonValue& c : s[u"conds"_s].toArray()) t << c[u"left"_s][u"label"_s].toString() << c[u"opLabel"_s].toString() << c[u"right"_s][u"label"_s].toString() << u"✕"_s;
            t << u"+ 添加条件"_s;
        }
    }
    for (const QJsonValue& p : page[u"params"_s].toArray()) {
        t << p[u"label"_s].toString();
        if (!p[u"sub"_s].toString().isEmpty()) t << p[u"sub"_s].toString();
    }
    t << u"交易品种"_s << page[u"instLabel"_s].toString();
    for (const QJsonValue& r : page[u"instRows"_s].toArray()) t << r[u"label"_s].toString() << r[u"sub"_s].toString();
    t << u"每边成交成本"_s << page[u"cost"_s][u"sub"_s].toString();
    if (!page[u"hint"_s].toString().isEmpty()) t << page[u"hint"_s].toString();
    if (!page[u"optionHint"_s].toString().isEmpty()) t << page[u"optionHint"_s].toString();
    t << u"策略流程"_s;
    if (page[u"flow"_s].isObject()) {
        const QJsonObject f = page[u"flow"_s].toObject();
        t << u"开始"_s << u"每根日线收盘评估"_s << u"→"_s << u"持仓是否为空?"_s << u"持有数量 = 0?"_s << u"—是→"_s << u"入场条件是否满足?"_s;
        if (!f[u"entry"_s].toString().isEmpty()) t << f[u"entry"_s].toString();
        t << u"—是→"_s << u"开仓"_s << f[u"buy"_s].toString() << u"└—否→"_s;
        if (f[u"exit"_s].isString()) t << u"出场条件是否满足?"_s << f[u"exit"_s].toString() << u"—是→"_s << u"平仓"_s << f[u"sell"_s].toString();
        else t << u"继续持有"_s << f[u"hold"_s].toString();
    }
    t << u"运行回测"_s << u"数据来自 TWS,需先连接引擎 · 仅供研究参考"_s;
    if (page[u"running"_s].toBool()) t << u"正在拉取历史数据并回测…"_s;
    if (!page[u"failure"_s].toString().isEmpty()) t << u"回测失败"_s << page[u"failure"_s].toString();
    const auto tiles = [&](const QJsonValue& list) {
        for (const QJsonValue& x : list.toArray()) t << x[u"label"_s].toString() << fly::statisticParts(x[u"value"_s].toString());
    };
    if (page[u"result"_s].isObject()) {
        const QJsonObject r = page[u"result"_s].toObject();
        t << r[u"title"_s].toString();
        tiles(r[u"tiles"_s]);
        t << r[u"riskMeta"_s].toString() << r[u"statsTitle"_s].toString();
        if (r.contains(u"statTiles"_s)) tiles(r[u"statTiles"_s]);
        else t << r[u"statsEmpty"_s].toString();
        if (r[u"rules"_s].isObject()) t << u"本次使用的条件"_s << r[u"rules"_s][u"entry"_s].toString() << r[u"rules"_s][u"exit"_s].toString();
        t << r[u"curveTitle"_s].toString();
        for (const QJsonValue& m : r[u"curveMeta"_s].toArray()) t << m.toString();
        if (r[u"trades"_s].isObject()) {
            t << r[u"trades"_s][u"title"_s].toString();
            for (const QJsonValue& x : r[u"trades"_s][u"rows"_s].toArray()) t << x[u"when"_s].toString() << x[u"price"_s].toString() << x[u"ret"_s].toString();
        }
        t << u"注意"_s << r[u"notice"_s][u"text"_s].toString();
        for (const QJsonValue& n : r[u"notice"_s][u"notes"_s].toArray()) t << n.toString();
    }
    t << u"参数扫描 · 样本外"_s;
    const QJsonObject sw = page[u"sweep"_s].toObject();
    if (!sw[u"sweepable"_s].toBool()) {
        t << sw[u"hint"_s].toString();
        return t;
    }
    t << u"再加几只"_s << u"逗号分隔,最多共 8 只;得分取平均"_s;
    for (const QJsonValue& g : sw[u"gridRows"_s].toArray()) t << g[u"label"_s].toString() << g[u"sub"_s].toString();
    t << u"样本内占比"_s << u"%,50–90"_s << u"滚动前推"_s << u"折数,2–6;0 = 不做"_s << u"挑参数按"_s << u"总收益"_s << u"收益回撤比(总收益 ÷ 最大回撤)"_s
      << u"参数只在样本内挑,成绩看样本外;滚动前推每一折只用之前的数据挑参数,连起来的收益才是不偷看未来的数。"_s << u"扫参数 · 看样本外"_s << u"用上面的标的、区间、品种与成交成本"_s;
    if (sw[u"running"_s].toBool()) t << u"正在逐只拉日线、试每一组参数…"_s;
    if (!sw[u"failure"_s].toString().isEmpty()) t << u"扫描失败"_s << sw[u"failure"_s].toString();
    if (sw[u"result"_s].isObject()) {
        const QJsonObject r = sw[u"result"_s].toObject();
        t << r[u"title"_s].toString();
        tiles(r[u"tiles"_s]);
        for (const QJsonValue& m : r[u"meta"_s].toArray()) t << m.toString();
        t << u"参数"_s << u"样本内"_s << u"样本外"_s << u"样本外买入持有"_s << u"样本外超额"_s << u"样本外回撤"_s << u"样本外名次"_s;
        for (const QJsonValue& x : r[u"rows"_s].toArray()) {
            t << x[u"params"_s].toString();
            if (x[u"untested"_s].toBool()) t << kUntested.trimmed();
            t << x[u"is"_s].toString() << x[u"oos"_s].toString() << x[u"bench"_s].toString() << x[u"excess"_s].toString() << x[u"dd"_s].toString();
            if (!x[u"rank"_s].toString().isEmpty()) t << x[u"rank"_s].toString();
        }
        for (const QJsonValue& p : r[u"pager"_s].toArray())
            if (p.isDouble()) t << jsNumberToString(p.toDouble());
        if (r[u"sizeChanger"_s].toBool()) t << u"10 条/页"_s;
        if (r[u"folds"_s].isArray()) {
            t << u"训练到"_s << u"测试段"_s << u"当时选的参数"_s << u"测试段收益"_s << u"买入持有"_s;
            for (const QJsonValue& f : r[u"folds"_s].toArray()) {
                t << f[u"trainEnd"_s].toString() << f[u"test"_s].toString() << f[u"params"_s].toString();
                if (f[u"untested"_s].toBool()) t << kUntested.trimmed();
                t << f[u"ret"_s].toString() << f[u"bench"_s].toString();
            }
        }
    }
    return t;
}

QJsonValue equityChart(const QJsonValue& result) {
    const QJsonArray curve = arr(result[u"curve"_s]);
    if (curve.size() < 2) return QJsonValue::Null;
    QJsonArray times, bench, equity;
    QHash<QString, int> at;
    for (int i = 0; i < curve.size(); ++i) {
        times.append(curve[i][u"date"_s]);
        bench.append(curve[i][u"bench"_s].isUndefined() ? QJsonValue(QJsonValue::Null) : curve[i][u"bench"_s]);
        equity.append(curve[i][u"equity"_s].isUndefined() ? QJsonValue(QJsonValue::Null) : curve[i][u"equity"_s]);
    }
    // new Map(times.map((t, i) => [t, i])):同一个日期出现两次时后一个算数
    for (int i = 0; i < curve.size(); ++i) at.insert(S(curve[i][u"date"_s]), i);
    QJsonArray markers;
    for (const QJsonValue& t : arr(result[u"trade_list"_s])) {
        if (at.contains(S(t[u"entry_date"_s])))
            markers.append(QJsonObject{{u"time"_s, t[u"entry_date"_s]}, {u"price"_s, curve[at.value(S(t[u"entry_date"_s]))][u"equity"_s]}, {u"shape"_s, u"tri-up"_s},
                                       {u"color"_s, u"up"_s}, {u"fit"_s, false}});
        if (T(t[u"exit_date"_s]) && at.contains(S(t[u"exit_date"_s])))
            markers.append(QJsonObject{{u"time"_s, t[u"exit_date"_s]}, {u"price"_s, curve[at.value(S(t[u"exit_date"_s]))][u"equity"_s]}, {u"shape"_s, u"tri-down"_s},
                                       {u"color"_s, u"down"_s}, {u"fit"_s, false}});
    }
    // 换了标的 / 策略 / 品种再跑一次,视图重新铺满,不沿用上一次的缩放
    const QJsonValue inst = result[u"instrument"_s];
    const QString viewKey = u"%1|%2|%3|%4|%5"_s.arg(S(result[u"symbol"_s]), S(result[u"strategy"_s]), has(inst[u"type"_s]) ? S(inst[u"type"_s]) : u"stock"_s,
                                                    S(result[u"start"_s]), S(result[u"end"_s]));
    return QJsonObject{
        {u"ariaLabel"_s, u"净值曲线"_s}, {u"viewKey"_s, viewKey}, {u"times"_s, times},
        {u"lines"_s, QJsonArray{QJsonObject{{u"values"_s, bench}, {u"color"_s, u"label2"_s}, {u"alpha"_s, 0.6}, {u"label"_s, u"买入持有"_s}},
                                QJsonObject{{u"values"_s, equity}, {u"color"_s, u"blue"_s}, {u"width"_s, 1.5}, {u"label"_s, u"策略"_s}}}},
        {u"hlines"_s, QJsonArray{QJsonObject{{u"price"_s, 1}, {u"color"_s, u"label"_s}, {u"dash"_s, QJsonArray{3, 3}}, {u"alpha"_s, 0.25}, {u"tag"_s, false}}}},
        {u"markers"_s, markers},
        {u"legend"_s, QJsonArray{QJsonArray{u"—"_s, u"blue"_s, u"策略"_s}, QJsonArray{u"—"_s, u"label2"_s, u"买入持有"_s}, QJsonArray{u"▲"_s, u"up"_s, u"买入"_s},
                                 QJsonArray{u"▼"_s, u"down"_s, u"卖出"_s}, QJsonArray{u"╌"_s, u"label2"_s, u"起点 1.0"_s}}},
        {u"decimals"_s, 3},
    };
}

QJsonObject runSpec(const PageInput& in) {
    QJsonObject params;
    for (auto it = in.params.begin(); it != in.params.end(); ++it)
        if (it.key() != u"__keys" && !it.value().isNull() && !it.value().isUndefined()) params.insert(it.key(), it.value());
    QJsonObject spec{{u"symbol"_s, jsTrim(in.symbol).toUpper()}, {u"start"_s, in.start}, {u"end"_s, in.end}, {u"strategy"_s, in.strategyKey}, {u"params"_s, params}};
    if (in.strategyKey == u"custom") spec.insert(u"rules"_s, in.rules.isEmpty() ? defaultRules() : in.rules);
    spec.insert(u"instrument"_s, instrumentOf(in));
    if (T(in.cost)) spec.insert(u"cost_pct"_s, in.cost);
    return spec;
}

QJsonObject sweepSpec(const PageInput& in) {
    const QJsonObject strategy = strategyOf(in);
    static const QRegularExpression sep(u"[,,\\s]+"_s, QRegularExpression::UseUnicodePropertiesOption);
    QJsonArray symbols;
    for (const QString& s : QStringList{in.symbol} + in.swExtra.split(sep)) {
        const QString x = jsTrim(s).toUpper();
        if (!x.isEmpty()) symbols.append(x);
    }
    const QJsonObject grid0 = defaultGrid(strategy);
    QJsonObject grid;
    for (const QString& k : keysOf(strategy.value("params"_L1))) {
        const QJsonArray values = parseValues(in.swGrid.contains(k) ? in.swGrid.value(k).toString() : grid0.value(k).toString());
        if (!values.isEmpty()) grid.insert(k, values);
    }
    QJsonObject spec{{u"symbols"_s, symbols}, {u"start"_s, in.start}, {u"end"_s, in.end}, {u"strategy"_s, S(strategy.value("key"_L1))}, {u"grid"_s, grid},
                     {u"instrument"_s, instrumentOf(in)}, {u"split_pct"_s, has(in.swSplit) ? in.swSplit : QJsonValue(70)},
                     {u"folds"_s, has(in.swFolds) ? in.swFolds : QJsonValue(0)}, {u"objective"_s, in.swObjective}};
    if (T(in.cost)) spec.insert(u"cost_pct"_s, in.cost);
    return spec;
}

}  // namespace ibkr::shell::backtest
