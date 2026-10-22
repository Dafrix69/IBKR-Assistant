#include "shell/screener_rules.h"

#include "shell/fly_rules.h"

#include "shell/jsvalue.h"
#include "shell/order_rules.h"

#include <QRegularExpression>
#include <QSet>

#include <algorithm>
#include <cmath>
#include <optional>

namespace ibkr::shell::screener {

using namespace Qt::StringLiterals;

namespace {

QString S(const QJsonValue& v) { return jsString(v); }
bool T(const QJsonValue& v) { return jsTruthy(v); }
double N(const QJsonValue& v) { return jsNumber(v); }
bool has(const QJsonValue& v) { return !v.isNull() && !v.isUndefined(); }
QJsonArray arr(const QJsonValue& v) { return v.isArray() ? v.toArray() : QJsonArray{}; }

QString tfLabel(const QString& tf) {
    for (const auto& [k, v] : timeframeOptions())
        if (k == tf) return v;
    return QString();
}
bool isPending(const QJsonValue& infl) { return infl.isObject() && infl.toObject().contains(u"pending"_s); }

/// rsCellProps:正绿负红,越大底色越深(--heat = min(40, |v| × 1.6),取整)
QJsonObject rsCell(const QJsonValue& value) {
    if (!has(value)) return {{u"cls"_s, u"dim"_s}};
    const double v = N(value);
    return {{u"cls"_s, v >= 0 ? u"pos"_s : u"neg"_s}, {u"heat"_s, jsToFixed(std::min(40.0, std::abs(v) * 1.6), 0)}};
}

QString confirmLabel(const QJsonValue& status) {
    const QString s = status.toString();
    if (s == u"confirmed") return u"已确认"_s;
    if (s == u"waiting") return u"等确认"_s;
    if (s == u"failed") return u"作废"_s;
    if (s == u"n/a") return u"无均线"_s;
    return S(status);
}

/// SignalCell:{ kind: pending / none / err / sig, text, title, cls, sub, second, ok }
QJsonObject signalCell(const QJsonValue& sig, bool pending) {
    if (pending) return {{u"kind"_s, u"none"_s}, {u"text"_s, u"…"_s}};
    if (!T(sig)) return {{u"kind"_s, u"none"_s}, {u"text"_s, u"—"_s}};
    if (sig.toObject().contains(u"error"_s)) return {{u"kind"_s, u"err"_s}, {u"text"_s, u"拿不到"_s}, {u"title"_s, S(sig[u"error"_s])}};
    if (!T(sig[u"signal"_s]))
        return {{u"kind"_s, u"none"_s}, {u"text"_s, N(sig[u"bars"_s]) < 40 ? u"数据少"_s : u"无"_s}, {u"title"_s, T(sig[u"reason"_s]) ? S(sig[u"reason"_s]) : QString()}};
    const QJsonArray pivots = arr(sig[u"pivots"_s]);
    const QJsonValue p1 = pivots.size() > 0 ? pivots[0] : QJsonValue(), p2 = pivots.size() > 1 ? pivots[1] : QJsonValue();
    QString title;
    if (T(p1) && T(p2)) {
        title = u"%1 %2(DIF %3) → %4 %5(DIF %6)\n价差 %7%,DIF 差 %8,最新 DIF %9"_s.arg(S(p1[u"time"_s]), S(p1[u"price"_s]), S(p1[u"dif"_s]), S(p2[u"time"_s]), S(p2[u"price"_s]),
                                                                                  S(p2[u"dif"_s]), num(sig[u"price_gap_pct"_s], 2, true), num(sig[u"dif_gap"_s], 4, true),
                                                                                  num(sig[u"dif_last"_s], 3));
        if (T(sig[u"confirm"_s]) && T(sig[u"confirm"_s][u"at"_s])) title += u"\n均线穿越:"_s + S(sig[u"confirm"_s][u"at"_s]);
    }
    const QJsonValue confirm = sig[u"confirm"_s];
    const QString second = T(confirm) ? u"MA%1 %2"_s.arg(S(confirm[u"ma"_s]), confirmLabel(confirm[u"status"_s])) : T(p2) ? S(p2[u"time"_s]) : QString();
    return {{u"kind"_s, u"sig"_s}, {u"cls"_s, S(sig[u"signal"_s])}, {u"text"_s, S(sig[u"label"_s])}, {u"sub"_s, u"%1 根前"_s.arg(S(sig[u"age"_s]))}, {u"title"_s, title},
            {u"second"_s, second}, {u"ok"_s, T(confirm) && confirm[u"status"_s] == u"confirmed"_s}};
}

std::optional<double> sortValue(const QJsonObject& row, const QString& key) {
    if (key == u"score") return has(row.value("score"_L1)) ? std::optional<double>(N(row.value("score"_L1))) : std::nullopt;
    if (key == u"hits") {
        const QJsonValue infl = row.value("infl"_L1);
        if (!T(infl)) return std::nullopt;
        return N(infl[u"hits"_s]) * 100 + (T(infl[u"confirmed"_s]) ? N(infl[u"confirmed"_s]) : 0);
    }
    const QJsonValue cell = row.value("rs"_L1)[key.mid(1)];
    return T(cell) && has(cell[u"rs_pct"_s]) ? std::optional<double>(N(cell[u"rs_pct"_s])) : std::nullopt;
}

QString fmtShort(const QJsonValue& iso, const PageInput& in) { return orders::fmtTimeShort(iso, in.nowMs, in.zone); }

/// 「+1.2」/「-3.4」/「—」(LeadersSection 的 signed)
QString signedOne(const QJsonValue& v) {
    if (!has(v)) return u"—"_s;
    return (N(v) > 0 ? u"+"_s : QString()) + jsToFixed(N(v), 1);
}

QString joinNums(const QJsonValue& list, const QString& sep) {
    QStringList out;
    for (const QJsonValue& v : arr(list)) out << S(v);
    return out.join(sep);
}

QJsonObject leadersModel(const PageInput& in) {
    QJsonObject out{{u"busy"_s, in.leadersBusy}, {u"error"_s, in.leadersError}, {u"filter"_s, in.leadersFilter}};
    const QJsonValue data = in.leaders;
    if (!T(data)) {
        out[u"data"_s] = QJsonValue::Null;
        return out;
    }
    const QJsonValue market = data[u"market"_s];
    const QString state = market[u"state"_s].toString();
    const QJsonArray dates = arr(market[u"distribution_dates"_s]);
    QStringList ds;
    for (const QJsonValue& d : dates) ds << S(d);
    QJsonArray rows;
    for (const QJsonValue& r : arr(data[u"rows"_s])) {
        if (in.leadersFilter == u"stage2" && !T(r[u"stage2"_s])) continue;
        if (in.leadersFilter == u"vcp" && !T(r[u"vcp"_s][u"found"_s])) continue;
        QJsonArray dots, tips;
        for (const QJsonValue& c : arr(r[u"checks"_s])) {
            const QJsonValue ok = c[u"ok"_s];
            dots.append(ok == QJsonValue(true) ? u"ok"_s : ok == QJsonValue(false) ? u"no"_s : u"na"_s);
            tips.append(u"%1 %2:%3"_s.arg(ok == QJsonValue(true) ? u"✓"_s : ok == QJsonValue(false) ? u"✗"_s : u"?"_s, S(c[u"label"_s]), S(c[u"detail"_s])));
        }
        const QJsonValue v = r[u"vcp"_s];
        QJsonObject vcp;
        if (!T(v[u"found"_s])) {
            const QJsonArray depths = arr(v[u"depths"_s]);
            vcp = {{u"found"_s, false}, {u"text"_s, depths.isEmpty() ? u"—"_s : u"不成形(%1%)"_s.arg(joinNums(depths, u"→"_s))}, {u"title"_s, S(v[u"reason"_s])}};
        } else {
            static const QHash<QString, QString> label{{u"breakout"_s, u"放量突破"_s}, {u"weak_breakout"_s, u"突破量不足"_s}, {u"near_pivot"_s, u"临近枢轴"_s},
                                                       {u"forming"_s, u"收缩中"_s}, {u"none"_s, u"—"_s}};
            const QString status = v[u"status"_s].toString();
            QStringList title{u"回撤 %1%"_s.arg(joinNums(v[u"depths"_s], u" → "_s)), u"枢轴 "_s + S(v[u"pivot"_s]),
                              u"离枢轴 %1%"_s.arg(has(v[u"distance_pct"_s]) ? (N(v[u"distance_pct"_s]) > 0 ? u"+"_s : QString()) + jsToFixed(N(v[u"distance_pct"_s]), 2) : u"—"_s)};
            if (has(v[u"volume_dryup"_s])) title << (T(v[u"volume_dryup"_s]) ? u"最后一次收缩缩量"_s : u"最后一次收缩没有缩量"_s);
            if (T(v[u"reason"_s])) title << S(v[u"reason"_s]);
            vcp = {{u"found"_s, true}, {u"label"_s, label.value(status, S(v[u"status"_s]))}, {u"bull"_s, status == u"breakout" || status == u"near_pivot"},
                   {u"detail"_s, u"%1% · 枢轴 %2"_s.arg(joinNums(v[u"depths"_s], u"→"_s), S(v[u"pivot"_s]))}, {u"title"_s, title.join(u'\n')}};
        }
        const QJsonValue vs = r[u"rs_vs_bench"_s], hi = r[u"pct_from_high"_s], vol = r[u"volume_ratio"_s];
        rows.append(QJsonObject{
            {u"symbol"_s, S(r[u"symbol"_s])}, {u"tip"_s, T(r[u"company"_s]) ? S(r[u"company"_s]) : S(r[u"tag"_s])},
            {u"error"_s, T(r[u"error"_s]) ? S(r[u"error"_s]) : QString()}, {u"dots"_s, dots}, {u"dotsTip"_s, tips},
            {u"passed"_s, u"%1/8"_s.arg(S(r[u"passed"_s]))},
            {u"rating"_s, has(r[u"rs_rating"_s]) ? S(r[u"rs_rating"_s]) : u"—"_s},
            {u"vs"_s, signedOne(vs)}, {u"vsTone"_s, !has(vs) ? QString() : N(vs) > 0 ? u"pos"_s : u"neg"_s},
            {u"high"_s, has(hi) ? jsToFixed(N(hi), 1) + u"%"_s : u"—"_s},
            {u"vcp"_s, vcp},
            {u"vol"_s, has(vol) ? jsToFixed(N(vol), 2) + (T(r[u"new_high_volume"_s]) ? u" · 放量新高"_s : QString()) : u"—"_s},
            {u"verdict"_s, S(r[u"verdict"_s])},
        });
    }
    QJsonArray notes;
    for (const QJsonValue& n : arr(data[u"notes"_s])) notes.append(S(n));
    out[u"data"_s] = QJsonObject{
        {u"segments"_s, QJsonArray{QJsonObject{{u"value"_s, u"all"_s}, {u"label"_s, u"全部 "_s + S(data[u"total"_s])}},
                                   QJsonObject{{u"value"_s, u"stage2"_s}, {u"label"_s, u"8 条全过 "_s + S(data[u"stage2_count"_s])}},
                                   QJsonObject{{u"value"_s, u"vcp"_s}, {u"label"_s, u"有 VCP "_s + S(data[u"vcp_count"_s])}}}},
        {u"info"_s, u"%1 · 对 %2 · %3"_s.arg(S(data[u"sector"_s]), S(data[u"benchmark"_s]), fmtShort(data[u"fetched_at"_s], in))},
        {u"market"_s, QJsonObject{{u"tone"_s, state == u"uptrend" ? u"ok"_s : state == u"pressure" ? u"warn"_s : state == u"correction" ? u"bad"_s : u"info"_s},
                                  {u"title"_s, u"大盘:"_s + S(market[u"label"_s])},
                                  {u"text"_s, S(market[u"text"_s]) + (ds.isEmpty() ? QString() : u" 派发日:%1。"_s.arg(ds.join(u"、"_s)))}}},
        {u"rows"_s, rows}, {u"notes"_s, notes},
    };
    return out;
}

QJsonObject devModel(const PageInput& in, const QJsonArray& pool, const QStringList& order) {
    const DevState& d = in.dev;
    const QString current = !d.symbol.isEmpty() ? d.symbol : order.value(0);
    const qsizetype idx = order.indexOf(current);
    const QString pos = !order.isEmpty() && idx >= 0 ? u"第 %1 / %2 只"_s.arg(idx + 1).arg(order.size()) : QString();
    QStringList head;
    if (!d.status.isEmpty()) head << d.status;
    if (!pos.isEmpty()) head << pos;
    QJsonObject out{{u"status"_s, head.join(u" · "_s)}, {u"busy"_s, d.busy}, {u"free"_s, d.free}, {u"timeframe"_s, d.timeframe}, {u"tfLabel"_s, tfLabel(d.timeframe)},
                    {u"period"_s, d.period}, {u"lookback"_s, d.lookback}, {u"current"_s, current}, {u"hasOrder"_s, !order.isEmpty()}};
    // 下拉:池子里有这一只就显示它(代码 · 公司),否则显示占位(上一次复盘的代码,或「标的」)
    QJsonArray options;
    QString selected;
    for (const QJsonValue& s : pool) {
        const QString sym = S(s[u"symbol"_s]);
        const QString label = T(s[u"company"_s]) ? u"%1 · %2"_s.arg(sym, S(s[u"company"_s])) : sym;
        options.append(QJsonObject{{u"value"_s, sym}, {u"label"_s, label}});
        if (sym == current) selected = label;
    }
    out[u"options"_s] = options;
    out[u"selected"_s] = selected;
    out[u"placeholder"_s] = !d.symbol.isEmpty() ? d.symbol : u"标的"_s;
    const QJsonValue r = d.result;
    if (!T(r)) {
        out[u"state"_s] = d.busy ? u"busy"_s : u"empty"_s;
        out[u"empty"_s] = !order.isEmpty() ? u"点上面表里的一行,或在这里选一只、手输一个代码。"_s : u"股票池是空的:先到「板块」页加成分股,或手输一个代码。"_s;
        return out;
    }
    out[u"symbol"_s] = S(r[u"symbol"_s]);
    const QJsonValue last = r[u"last"_s];
    if (!T(last)) {
        QStringList rd;
        for (const QJsonValue& x : arr(r[u"readout"_s])) rd << S(x);
        out[u"state"_s] = u"short"_s;
        out[u"readout"_s] = rd.join(u' ');
        return out;
    }
    out[u"state"_s] = u"ok"_s;
    const QString extreme = r[u"extreme"_s].toString();
    const QString tone = extreme == u"overbought" ? u"hot"_s : extreme == u"oversold" ? u"cold"_s : QString();
    const double p = has(last[u"pressure"_s]) ? N(last[u"pressure"_s]) : 0;
    out[u"tiles"_s] = QJsonArray{
        QJsonObject{{u"label"_s, u"偏离 MA"_s + S(r[u"period"_s])}, {u"value"_s, num(last[u"dev_pct"_s], 2, true) + u"%"_s}, {u"tone"_s, tone}},
        QJsonObject{{u"label"_s, u"z 分数(近 %1 根)"_s.arg(S(r[u"lookback"_s]))}, {u"value"_s, has(last[u"z"_s]) ? num(last[u"z"_s], 2, true) : u"—"_s}, {u"tone"_s, tone}},
        QJsonObject{{u"label"_s, u"历史分位"_s}, {u"value"_s, has(last[u"rank_pct"_s]) ? num(last[u"rank_pct"_s], 0) + u"%"_s : u"—"_s}, {u"tone"_s, QString()}},
        QJsonObject{{u"label"_s, u"修正版买卖压力"_s}, {u"value"_s, num(last[u"pressure"_s], 3, true)}, {u"tone"_s, p > 0.3 ? u"cold"_s : p < -0.3 ? u"hot"_s : QString()}},
        QJsonObject{{u"label"_s, u"收盘在真实区间"_s}, {u"value"_s, num(last[u"buy_pct"_s], 0) + u"%"_s}, {u"tone"_s, QString()}},
        QJsonObject{{u"label"_s, u"相对量"_s}, {u"value"_s, has(last[u"volume_ratio"_s]) ? num(last[u"volume_ratio"_s], 2) + u"×"_s : u"—"_s}, {u"tone"_s, QString()}},
    };
    QJsonArray readout;
    for (const QJsonValue& x : arr(r[u"readout"_s])) readout.append(S(x));
    out[u"verdict"_s] = QJsonObject{{u"tone"_s, T(r[u"extreme"_s]) ? u"warn"_s : u"ok"_s}, {u"title"_s, S(r[u"extreme_label"_s])}, {u"readout"_s, readout}};
    out[u"devTitle"_s] = u"偏离程度(收盘相对 MA%1,z 分数)"_s.arg(S(r[u"period"_s]));
    out[u"pressureTitle"_s] = u"修正版买卖压力(−1 全卖压 … +1 全买压,量加权 + 平滑)"_s;
    const QJsonValue w = r[u"window"_s];
    out[u"window"_s] = T(w) ? QJsonValue(u"本段偏离 最大 %1%(%2) · 最小 %3%(%4) · 压力 最高 %5(%6) · 最低 %7(%8)"_s.arg(
                                   num(w[u"dev_max"_s][u"dev_pct"_s], 2, true), S(w[u"dev_max"_s][u"time"_s]), num(w[u"dev_min"_s][u"dev_pct"_s], 2, true), S(w[u"dev_min"_s][u"time"_s]),
                                   num(w[u"pressure_max"_s][u"pressure"_s], 2, true), S(w[u"pressure_max"_s][u"time"_s]), num(w[u"pressure_min"_s][u"pressure"_s], 2, true),
                                   S(w[u"pressure_min"_s][u"time"_s])))
                            : QJsonValue(QString());
    return out;
}

}  // namespace

const QList<std::pair<QString, QString>>& timeframeOptions() {
    static const QList<std::pair<QString, QString>> t{{u"1w"_s, u"周线"_s}, {u"1d"_s, u"日线"_s}, {u"1h"_s, u"1 小时"_s}, {u"30m"_s, u"30 分"_s}, {u"15m"_s, u"15 分"_s}};
    return t;
}

QString num(const QJsonValue& v, int digits, bool sign) {
    if (!has(v) || std::isnan(N(v))) return u"—"_s;
    const double n = N(v);
    const QString text = jsToFixed(n, digits);
    return sign && n > 0 ? u"+"_s + text : text;
}

QJsonArray mergeRows(const QJsonValue& rs, const QJsonValue& infl) {
    QList<QJsonObject> rows;
    QHash<QString, qsizetype> at;
    for (const QJsonValue& r : arr(rs[u"rows"_s])) {
        at.insert(S(r[u"symbol"_s]), rows.size());
        rows.append(r.toObject());
    }
    if (!isPending(infl))
        for (const QJsonValue& r : arr(infl[u"rows"_s])) {
            const QString sym = S(r[u"symbol"_s]);
            const auto it = at.constFind(sym);
            if (it != at.cend()) {
                rows[*it][u"infl"_s] = r;
            } else {
                at.insert(sym, rows.size());
                rows.append(QJsonObject{{u"symbol"_s, r[u"symbol"_s]}, {u"tag"_s, r[u"tag"_s]}, {u"last"_s, QJsonValue::Null}, {u"bars"_s, 0}, {u"error"_s, QJsonValue::Null},
                                        {u"rank"_s, QJsonValue::Null}, {u"score"_s, QJsonValue::Null}, {u"rs"_s, QJsonObject{}}, {u"infl"_s, r}});
            }
        }
    QJsonArray out;
    for (const QJsonObject& r : rows) out.append(r);
    return out;
}

QJsonArray sortRows(const QJsonArray& rows, const QString& key, const QString& order) {
    if (key.isEmpty() || order.isEmpty()) return rows;
    const double dir = order == u"ascend" ? 1 : -1;
    QList<QJsonObject> list;
    for (const QJsonValue& r : rows) list.append(r.toObject());
    std::stable_sort(list.begin(), list.end(), [&](const QJsonObject& a, const QJsonObject& b) {
        const auto va = sortValue(a, key), vb = sortValue(b, key);
        if (!va || !vb) return bool(va) && !vb;  // 有数的在前,没数的沉底
        return (*va - *vb) * dir < 0;
    });
    QJsonArray out;
    for (const QJsonObject& r : list) out.append(r);
    return out;
}

QJsonValue devCharts(const QJsonValue& result) {
    if (!T(result) || !T(result[u"last"_s])) return QJsonValue::Null;
    const QJsonArray series = arr(result[u"series"_s]);
    QJsonArray times, z, pressure, raw;
    for (const QJsonValue& s : series) {
        times.append(s[u"time"_s]);
        z.append(s[u"z"_s].isUndefined() ? QJsonValue(QJsonValue::Null) : s[u"z"_s]);
        pressure.append(s[u"pressure"_s].isUndefined() ? QJsonValue(QJsonValue::Null) : s[u"pressure"_s]);
        raw.append(has(s[u"buy_pct"_s]) ? QJsonValue(N(s[u"buy_pct"_s]) / 50 - 1) : QJsonValue(QJsonValue::Null));
    }
    // 翻到下一只或改了参数,两张图重新铺满
    const QString viewKey = u"%1|%2|%3|%4"_s.arg(S(result[u"symbol"_s]), S(result[u"timeframe"_s]), S(result[u"period"_s]), S(result[u"lookback"_s]));
    const QJsonValue ze = result[u"z_extreme"_s];
    const QJsonArray dash33{3, 3}, dash23{2, 3};
    return QJsonObject{
        {u"dev"_s, QJsonObject{
                       {u"ariaLabel"_s, u"偏离 z 分数"_s}, {u"viewKey"_s, viewKey}, {u"times"_s, times},
                       {u"lines"_s, QJsonArray{QJsonObject{{u"values"_s, z}, {u"color"_s, u"blue"_s}, {u"width"_s, 1.5}, {u"label"_s, u"z"_s}}}},
                       {u"hlines"_s, QJsonArray{QJsonObject{{u"price"_s, 0}, {u"color"_s, u"label"_s}, {u"dash"_s, dash33}, {u"alpha"_s, 0.3}, {u"tag"_s, false}},
                                                QJsonObject{{u"price"_s, ze}, {u"color"_s, u"down"_s}, {u"dash"_s, dash23}, {u"alpha"_s, 0.6}, {u"label"_s, u"+%1σ 上方极值"_s.arg(S(ze))}},
                                                QJsonObject{{u"price"_s, -N(ze)}, {u"color"_s, u"up"_s}, {u"dash"_s, dash23}, {u"alpha"_s, 0.6}, {u"label"_s, u"−%1σ 下方极值"_s.arg(S(ze))}}}},
                       {u"legend"_s, QJsonArray{QJsonArray{u"—"_s, u"blue"_s, u"z 分数"_s}, QJsonArray{u"╌"_s, u"down"_s, u"上方极值"_s}, QJsonArray{u"╌"_s, u"up"_s, u"下方极值"_s}}},
                       {u"decimals"_s, 2}, {u"volume"_s, false}}},
        {u"pressure"_s, QJsonObject{
                            {u"ariaLabel"_s, u"买卖压力"_s}, {u"viewKey"_s, viewKey}, {u"times"_s, times},
                            {u"lines"_s, QJsonArray{QJsonObject{{u"values"_s, pressure}, {u"color"_s, u"orange"_s}, {u"width"_s, 1.5}, {u"label"_s, u"压力"_s}},
                                                    QJsonObject{{u"values"_s, raw}, {u"color"_s, u"label2"_s}, {u"alpha"_s, 0.4}, {u"label"_s, u"单根原始"_s}}}},
                            {u"hlines"_s, QJsonArray{QJsonObject{{u"price"_s, 0}, {u"color"_s, u"label"_s}, {u"dash"_s, dash33}, {u"alpha"_s, 0.3}, {u"tag"_s, false}}}},
                            {u"legend"_s, QJsonArray{QJsonArray{u"—"_s, u"orange"_s, u"修正版压力"_s}, QJsonArray{u"—"_s, u"label2"_s, u"单根原始位置"_s}}},
                            {u"decimals"_s, 2}, {u"volume"_s, false}}},
    };
}

// { summary, busy, progress, sector, sectorOptions, benchmark, timeframes: [{ value, label, checked }], ma,
//   hasRows, tagCards: null | { hint } | { cards }, table: { columns, rows }, meta, empty,
//   leaders: { busy, error, filter, data }, dev: {...}, pool }
QJsonObject pageModel(const PageInput& in) {
    QJsonObject page;
    // 股票池:选中的板块(或全部)的成分股去重
    bool known = false;
    for (const QJsonValue& s : in.sectors) known = known || S(s[u"id"_s]) == in.sector;
    const QString sectorValue = known ? in.sector : u"all"_s;
    QJsonArray sectorOptions{QJsonObject{{u"value"_s, u"all"_s}, {u"label"_s, u"全部板块"_s}}};
    QString sectorLabel = u"全部板块"_s;
    QJsonArray pool;
    QSet<QString> seen;
    for (const QJsonValue& s : in.sectors) {
        const QString label = u"%1(%2)"_s.arg(S(s[u"name"_s])).arg(arr(s[u"stocks"_s]).size());
        sectorOptions.append(QJsonObject{{u"value"_s, S(s[u"id"_s])}, {u"label"_s, label}});
        if (S(s[u"id"_s]) == sectorValue) sectorLabel = label;
        if (sectorValue != u"all" && S(s[u"id"_s]) != sectorValue) continue;
        for (const QJsonValue& st : arr(s[u"stocks"_s])) {
            const QString sym = T(st[u"symbol"_s]) ? S(st[u"symbol"_s]) : QString();
            if (sym.isEmpty() || seen.contains(sym)) continue;
            seen.insert(sym);
            pool.append(st);
        }
    }
    page[u"sector"_s] = sectorValue;
    page[u"sectorLabel"_s] = sectorLabel;
    page[u"sectorOptions"_s] = sectorOptions;
    page[u"pool"_s] = pool;
    page[u"benchmark"_s] = in.benchmark;
    QJsonArray tfs;
    for (const auto& [k, v] : timeframeOptions()) tfs.append(QJsonObject{{u"value"_s, k}, {u"label"_s, v}, {u"checked"_s, in.timeframes.contains(k)}});
    page[u"timeframes"_s] = tfs;
    page[u"ma"_s] = in.ma;
    page[u"busy"_s] = in.busy;
    page[u"progress"_s] = in.progress;
    // 状态行
    {
        QStringList bits;
        const bool rs = T(in.rs), infl = T(in.infl) && !isPending(in.infl);
        if (rs) bits << S(in.rs[u"sector"_s]) << u"对 %1(%2)"_s.arg(S(in.rs[u"benchmark"_s]), num(in.rs[u"bench_last"_s])) << u"%1/%2 只有分"_s.arg(S(in.rs[u"counted"_s]), S(in.rs[u"total"_s]));
        if (infl) {
            if (!rs) bits << S(in.infl[u"sector"_s]);
            bits << u"%1/%2 只有背离"_s.arg(S(in.infl[u"hit_count"_s]), S(in.infl[u"total"_s]));
        }
        const QJsonValue at = infl && T(in.infl[u"fetched_at"_s]) ? in.infl[u"fetched_at"_s] : rs ? in.rs[u"fetched_at"_s] : QJsonValue();
        if (T(at)) bits << fmtShort(at, in);
        page[u"summary"_s] = bits.isEmpty() ? u"—"_s : bits.join(u" · "_s);
    }
    // 表
    const QJsonArray rows = mergeRows(in.rs, in.infl);
    const QJsonArray sorted = sortRows(rows, in.sortKey, in.sortOrder);
    page[u"hasRows"_s] = !rows.isEmpty();
    QStringList order;
    for (const QJsonValue& r : sorted) order << S(r[u"symbol"_s]);
    if (order.isEmpty())
        for (const QJsonValue& s : std::as_const(pool)) order << S(s[u"symbol"_s]);
    page[u"order"_s] = QJsonArray::fromStringList(order);
    if (!rows.isEmpty()) {
        // 行业标签卡
        if (T(in.rs)) {
            const QJsonArray tags = arr(in.rs[u"tags"_s]);
            if (!(tags.size() > 1 || (!tags.isEmpty() && T(tags[0]) && tags[0][u"tag"_s] != u"未分类"_s))) {
                page[u"tagCards"_s] = QJsonObject{{u"hint"_s, u"成分股还没有业务标签,按标签汇总要先到「板块」页给股票加标签(AI 选股会自动给)。"_s}};
            } else {
                QJsonArray cards;
                for (const QJsonValue& t : tags) {
                    QJsonArray bars;
                    for (const QJsonValue& w : arr(in.rs[u"windows"_s])) {
                        const QJsonValue cell = t[u"rs"_s][S(w[u"n"_s])];
                        const std::optional<double> v = T(cell) ? std::optional<double>(N(cell[u"median_pct"_s])) : std::nullopt;
                        const double h = !v ? 0 : std::max(2.0, std::min(100.0, (std::abs(*v) / 30) * 100));
                        bars.append(QJsonObject{{u"h"_s, h}, {u"pos"_s, v.has_value() && *v >= 0}, {u"neg"_s, v.has_value() && *v < 0},
                                                {u"text"_s, !v ? u"—"_s : num(QJsonValue(*v), 0, true)}, {u"label"_s, S(w[u"label"_s])},
                                                {u"title"_s, T(cell) ? u"%1:中位数 RS %2%,%3/%4 只跑赢"_s.arg(S(w[u"label"_s]), num(cell[u"median_pct"_s], 2, true), S(cell[u"beats"_s]), S(cell[u"total"_s]))
                                                                     : QString()}});
                    }
                    QStringList syms;
                    for (const QJsonValue& s : arr(t[u"symbols"_s])) syms << S(s);
                    cards.append(QJsonObject{{u"name"_s, u"%1 · %2 只"_s.arg(S(t[u"tag"_s]), S(t[u"count"_s]))},
                                             {u"score"_s, has(t[u"score"_s]) ? num(t[u"score"_s], 1, true) + u"%"_s : u"—"_s}, {u"bars"_s, bars}, {u"symbols"_s, syms.join(u" · "_s)}});
                }
                page[u"tagCards"_s] = QJsonObject{{u"cards"_s, cards}};
            }
        } else {
            page[u"tagCards"_s] = QJsonValue::Null;
        }
        // 列
        const bool rs = T(in.rs);
        const QJsonArray windows = rs ? arr(in.rs[u"windows"_s]) : QJsonArray{};
        const QJsonArray inflTfs = arr(in.infl[u"timeframes"_s]);
        const bool pending = isPending(in.infl);
        const QJsonValue perTf = pending ? QJsonValue() : in.infl[u"per_timeframe"_s];
        QJsonArray columns;
        const auto sortable = [&](const QString& key) { return in.sortKey == key ? in.sortOrder : QString(); };
        if (rs) columns.append(QJsonObject{{u"key"_s, u"rank"_s}, {u"title"_s, u"#"_s}, {u"width"_s, 36}});
        columns.append(QJsonObject{{u"key"_s, u"symbol"_s}, {u"title"_s, u"标的"_s}, {u"width"_s, 72}});
        columns.append(QJsonObject{{u"key"_s, u"tag"_s}, {u"title"_s, u"标签"_s}, {u"width"_s, 76}});
        if (rs) columns.append(QJsonObject{{u"key"_s, u"last"_s}, {u"title"_s, u"现价"_s}, {u"width"_s, 76}, {u"right"_s, true}});
        for (const QJsonValue& w : windows)
            columns.append(QJsonObject{{u"key"_s, u"w"_s + S(w[u"n"_s])}, {u"title"_s, u"RS "_s + S(w[u"label"_s])}, {u"tip"_s, u"%1 个交易日"_s.arg(S(w[u"n"_s]))},
                                       {u"width"_s, 78}, {u"right"_s, true}, {u"sortable"_s, true}, {u"order"_s, sortable(u"w"_s + S(w[u"n"_s]))}});
        if (rs) columns.append(QJsonObject{{u"key"_s, u"score"_s}, {u"title"_s, u"综合"_s}, {u"width"_s, 78}, {u"right"_s, true}, {u"sortable"_s, true}, {u"order"_s, sortable(u"score"_s)}});
        for (const QJsonValue& tfv : inflTfs) {
            const QString tf = S(tfv);
            const QJsonValue c = perTf[tf];
            QJsonObject col{{u"key"_s, u"tf:"_s + tf}, {u"title"_s, tfLabel(tf).isEmpty() ? tf : tfLabel(tf)}};
            if (T(c)) {
                col[u"sub"_s] = u"底 %1 · 顶 %2"_s.arg(S(c[u"bull"_s]), S(c[u"bear"_s]));
                col[u"tip"_s] = u"底背离 %1 只 · 顶背离 %2 只%3"_s.arg(S(c[u"bull"_s]), S(c[u"bear"_s]),
                                                                      !pending && T(in.infl[u"ma_period"_s]) ? u" · 已过 MA%1 确认 %2 只"_s.arg(S(in.infl[u"ma_period"_s]), S(c[u"confirmed"_s])) : QString());
            }
            columns.append(col);
        }
        if (!inflTfs.isEmpty())
            columns.append(QJsonObject{{u"key"_s, u"hits"_s}, {u"title"_s, u"命中"_s}, {u"tip"_s, u"有背离的周期数;括号里是其中已过均线确认的"_s}, {u"width"_s, 68}, {u"right"_s, true},
                                       {u"sortable"_s, true}, {u"order"_s, sortable(u"hits"_s)}});
        // 行
        QJsonArray tableRows;
        for (const QJsonValue& rv : sorted) {
            const QJsonObject row = rv.toObject();
            const QString sym = S(row.value("symbol"_L1));
            const QJsonValue infl = row.value("infl"_L1);
            QJsonObject cells;
            if (rs) cells[u"rank"_s] = has(row.value("rank"_L1)) ? S(row.value("rank"_L1)) : QString();
            cells[u"tag"_s] = T(row.value("tag"_L1)) ? S(row.value("tag"_L1)) : T(infl) && T(infl[u"tag"_s]) ? S(infl[u"tag"_s]) : QString();
            if (rs)
                cells[u"last"_s] = T(row.value("error"_L1)) ? QJsonValue(QJsonObject{{u"err"_s, true}, {u"text"_s, u"拿不到"_s}, {u"title"_s, S(row.value("error"_L1))}})
                                                            : QJsonValue(QJsonObject{{u"text"_s, num(row.value("last"_L1))}});
            for (const QJsonValue& w : windows) {
                const QJsonValue cell = row.value("rs"_L1)[S(w[u"n"_s])];
                QJsonObject c = rsCell(T(cell) ? cell[u"rs_pct"_s] : QJsonValue(QJsonValue::Null));
                c[u"text"_s] = T(cell) ? num(cell[u"rs_pct"_s], 1, true) + u"%"_s : u"—"_s;
                if (T(cell)) c[u"title"_s] = u"自身 %1% · 基准 %2%"_s.arg(num(cell[u"ret_pct"_s], 2, true), num(cell[u"bench_pct"_s], 2, true));
                // 正按这一列排:AntD 给这一列的格子加一层底色(ant-table-column-sort)
                c[u"sorted"_s] = in.sortKey == u"w"_s + S(w[u"n"_s]) && !in.sortOrder.isEmpty();
                cells[u"w"_s + S(w[u"n"_s])] = c;
            }
            if (rs) {
                QJsonObject c = rsCell(row.value("score"_L1).isUndefined() ? QJsonValue(QJsonValue::Null) : row.value("score"_L1));
                c[u"text"_s] = has(row.value("score"_L1)) ? num(row.value("score"_L1), 1, true) + u"%"_s : u"—"_s;
                c[u"sorted"_s] = in.sortKey == u"score" && !in.sortOrder.isEmpty();
                cells[u"score"_s] = c;
            }
            for (const QJsonValue& tfv : inflTfs) cells[u"tf:"_s + S(tfv)] = signalCell(T(infl) ? infl[u"signals"_s][S(tfv)] : QJsonValue(), pending);
            if (!inflTfs.isEmpty())
                cells[u"hits"_s] = T(infl) && T(infl[u"hits"_s]) ? u"%1%2"_s.arg(S(infl[u"hits"_s]), T(infl[u"confirmed"_s]) ? u" (✓%1)"_s.arg(S(infl[u"confirmed"_s])) : QString()) : QString();
            tableRows.append(QJsonObject{{u"symbol"_s, sym}, {u"open"_s, sym == in.dev.symbol}, {u"dim"_s, !has(row.value("score"_L1)) && !(T(infl) && T(infl[u"hits"_s]))}, {u"cells"_s, cells}});
        }
        page[u"table"_s] = QJsonObject{{u"columns"_s, columns}, {u"rows"_s, tableRows}};
        QJsonArray meta;
        if (rs) meta.append(u"RS = (1 + 成员收益) ÷ (1 + 基准收益) − 1,按各自日线算,基准按日期对齐"_s);
        if (T(in.infl)) meta.append(u"背离 ≠ 反转,只是动能与价格不一致;右侧确认才是价格真的过了均线"_s);
        meta.append(u"仅供研究,不构成投资建议"_s);
        page[u"meta"_s] = meta;
    } else {
        page[u"tagCards"_s] = QJsonValue::Null;
        page[u"empty"_s] = in.busy ? QString() : u"选一个股票池,点「扫描」:每只股一行,RS 强度与各周期的背离并排。"_s;
    }
    page[u"leaders"_s] = leadersModel(in);
    page[u"dev"_s] = devModel(in, pool, order);
    return page;
}


QStringList pageTexts(const QJsonObject& page) {
    QStringList t{u"扫描"_s};
    t << (page[u"busy"_s].toBool() ? page[u"progress"_s].toString() : page[u"summary"_s].toString());
    t << page[u"sectorLabel"_s].toString() << u"SPY"_s << u"QQQ"_s;
    for (const QJsonValue& tf : page[u"timeframes"_s].toArray()) t << tf[u"label"_s].toString();
    t << u"扫描"_s << u"这一页的数字怎么算"_s;
    if (page[u"hasRows"_s].toBool()) {
        const QJsonValue tc = page[u"tagCards"_s];
        if (tc.isObject() && tc.toObject().contains(u"hint"_s)) t << tc[u"hint"_s].toString();
        for (const QJsonValue& c : tc[u"cards"_s].toArray()) {
            t << c[u"name"_s].toString() << c[u"score"_s].toString();
            for (const QJsonValue& b : c[u"bars"_s].toArray()) t << b[u"text"_s].toString() << b[u"label"_s].toString();
            t << c[u"symbols"_s].toString();
        }
        const QJsonObject table = page[u"table"_s].toObject();
        // 带滚动的表在 SSR 里渲染两遍表头(固定表头那一张 + 正文里量宽用的那一行)
        for (int pass = 0; pass < 2; ++pass)
            for (const QJsonValue& col : table[u"columns"_s].toArray()) {
                t << col[u"title"_s].toString();
                if (col.toObject().contains(u"sub"_s)) t << col[u"sub"_s].toString();
            }
        for (const QJsonValue& r : table[u"rows"_s].toArray()) {
            const QJsonObject cells = r[u"cells"_s].toObject();
            for (const QJsonValue& col : table[u"columns"_s].toArray()) {
                const QString key = col[u"key"_s].toString();
                if (key == u"symbol") {
                    t << r[u"symbol"_s].toString();
                    continue;
                }
                const QJsonValue c = cells.value(key);
                if (c.isString()) {
                    t << c.toString();
                } else if (key.startsWith(u"tf:"_s)) {
                    t << c[u"text"_s].toString();
                    if (c[u"kind"_s] == u"sig"_s) {
                        t << c[u"sub"_s].toString();
                        if (!c[u"second"_s].toString().isEmpty()) t << c[u"second"_s].toString();
                    }
                } else {
                    t << c[u"text"_s].toString();
                }
            }
        }
        for (const QJsonValue& m : page[u"meta"_s].toArray()) t << m.toString();
    } else if (!page[u"empty"_s].toString().isEmpty()) {
        t << page[u"empty"_s].toString();
    }
    // 强势股
    const QJsonObject ld = page[u"leaders"_s].toObject();
    t << u"强势股筛选 · 趋势模板 + VCP"_s << u"筛选强势股"_s;
    const QJsonValue data = ld[u"data"_s];
    if (data.isObject()) {
        for (const QJsonValue& s : data[u"segments"_s].toArray()) t << s[u"label"_s].toString();
        t << data[u"info"_s].toString();
    }
    t << u"这些规则从哪来、怎么算"_s;
    if (!ld[u"error"_s].toString().isEmpty()) t << u"强势股没筛成"_s << ld[u"error"_s].toString();
    if (ld[u"busy"_s].toBool() && !data.isObject()) t << u"正在拉日线按趋势模板逐只检查…"_s;
    if (data.isObject()) {
        t << data[u"market"_s][u"title"_s].toString() << data[u"market"_s][u"text"_s].toString();
        const QJsonArray rows = data[u"rows"_s].toArray();
        if (rows.isEmpty()) {
            t << u"这个筛选下没有股票。"_s;
        } else {
            for (int pass = 0; pass < 2; ++pass) t << u"代码"_s << u"趋势模板"_s << u"RS 评级"_s << u"比基准"_s << u"离高点"_s << u"VCP"_s << u"量比"_s << u"结论"_s;
            for (const QJsonValue& r : rows) {
                t << r[u"symbol"_s].toString();
                if (!r[u"error"_s].toString().isEmpty()) t << u"拿不到"_s;
                else if (r[u"dots"_s].toArray().isEmpty()) t << u"—"_s << r[u"passed"_s].toString();
                else t << r[u"passed"_s].toString();
                t << r[u"rating"_s].toString() << r[u"vs"_s].toString() << r[u"high"_s].toString();
                const QJsonObject v = r[u"vcp"_s].toObject();
                if (v[u"found"_s].toBool()) t << v[u"label"_s].toString() << v[u"detail"_s].toString();
                else t << v[u"text"_s].toString();
                t << r[u"vol"_s].toString() << r[u"verdict"_s].toString();
            }
        }
        for (const QJsonValue& n : data[u"notes"_s].toArray()) t << n.toString();
    }
    // 极值偏离
    const QJsonObject d = page[u"dev"_s].toObject();
    t << u"极值偏离"_s;
    if (d.contains(u"symbol"_s)) t << d[u"symbol"_s].toString();
    if (!d[u"status"_s].toString().isEmpty()) t << d[u"status"_s].toString();
    t << (d[u"selected"_s].toString().isEmpty() ? d[u"placeholder"_s].toString() : d[u"selected"_s].toString());
    t << d[u"tfLabel"_s].toString() << u"复盘"_s;
    const QString state = d[u"state"_s].toString();
    if (state == u"empty") {
        t << d[u"empty"_s].toString();
    } else if (state == u"short") {
        t << u"数据不够"_s << d[u"readout"_s].toString();
    } else if (state == u"ok") {
        for (const QJsonValue& tile : d[u"tiles"_s].toArray()) t << tile[u"label"_s].toString() << fly::statisticParts(tile[u"value"_s].toString());
        t << d[u"verdict"_s][u"title"_s].toString();
        for (const QJsonValue& x : d[u"verdict"_s][u"readout"_s].toArray()) t << x.toString();
        t << d[u"devTitle"_s].toString() << d[u"pressureTitle"_s].toString();
        if (!d[u"window"_s].toString().isEmpty()) t << d[u"window"_s].toString();
    }
    return t;
}

}  // namespace ibkr::shell::screener
