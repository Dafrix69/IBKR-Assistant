#include "shell/review_rules.h"

#include "shell/fly_rules.h"
#include "shell/jsvalue.h"
#include "shell/order_rules.h"
#include "shell/track_rules.h"

#include <QSet>

#include <algorithm>
#include <cmath>
#include <map>

namespace ibkr::shell::review {

using namespace Qt::StringLiterals;

/// 蝶价图横轴有几个时刻(不排序;下面 flyResult 判断「有没有蝶价图」用)
qsizetype flyTimeCount(const QJsonValue& r);

namespace {

QString S(const QJsonValue& v) { return jsString(v); }
double N(const QJsonValue& v) { return jsNumber(v); }
bool T(const QJsonValue& v) { return jsTruthy(v); }
bool has(const QJsonValue& v) { return !v.isUndefined() && !v.isNull(); }
QJsonArray arr(const QJsonValue& v) { return v.toArray(); }
/// a ?? '—' 拼进模板串:没有是「—」,有就是 String(a)
QString orDash(const QJsonValue& v) { return has(v) ? S(v) : u"—"_s; }
QString money(const QJsonValue& v) { return track::fmtMoney(v); }

const QHash<QString, QString>& finalStatusLabel() {
    static const QHash<QString, QString> m{{u"filled"_s, u"已成交"_s}, {u"partially_filled"_s, u"部分成交"_s}, {u"cancelled"_s, u"已撤单"_s},
                                           {u"expired_untriggered"_s, u"当日未触发"_s}, {u"rejected_by_validator"_s, u"校验拒绝"_s},
                                           {u"rejected_by_llm"_s, u"模型拒绝"_s}, {u"ibkr_error"_s, u"券商报错"_s}, {u"halted_by_breaker"_s, u"熔断拦下"_s}};
    return m;
}
QString reviewKind(const QJsonValue& kind) {
    static const QHash<QString, QString> m{{u"closed"_s, u"已平仓"_s}, {u"expired"_s, u"已到期"_s}, {u"open"_s, u"持仓中"_s}};
    return m.value(S(kind));
}
QString phaseLabel(const QJsonValue& p) {
    static const QHash<QString, QString> m{{u"A"_s, u"阶段 A"_s}, {u"B"_s, u"阶段 B"_s}, {u"C"_s, u"阶段 C"_s}};
    return m.value(S(p), S(p));
}
/// 「(+4.55%)」;没有是空
QString pctText(const QJsonValue& v) { return !has(v) ? QString() : u" (%1%2%)"_s.arg(N(v) > 0 ? u"+"_s : QString(), S(v)); }
/// signed():钱数(两位、千分位),正绿负红;没有是「—」
QJsonObject signedCell(const QJsonValue& v) {
    return {{u"text"_s, has(v) ? money(v) : u"—"_s}, {u"tone"_s, has(v) && N(v) > 0 ? u"pos"_s : has(v) && N(v) < 0 ? u"neg"_s : QString()}};
}
QString signDist(const QJsonValue& d) { return (N(has(d) ? d : QJsonValue(0)) > 0 ? u"+"_s : QString()) + S(d); }

QString stockLabel(const QJsonValue& c, double nowMs, const QTimeZone& zone) {
    const QString when = orders::fmtTimeShort(c[u"created_at"_s], nowMs, zone);
    const bool lng = S(c[u"side"_s]) == u"LONG";
    const QString acct = T(c[u"account"_s]) ? u" · "_s + S(c[u"account"_s]) : QString();
    const QString flag = T(c[u"opening_assumed"_s]) ? u" · 期初持仓未核对"_s : QString();
    if (T(c[u"carried"_s]) && !T(c[u"entry_qty"_s])) {
        // 没连券商时"卖的是老仓位"是推断(卖出不读成卖空),照样标出来;连上之后按真实持仓重算
        const QString why = T(c[u"opening_assumed"_s]) ? u"按卖出更早买的货算"_s : u"建仓早于已同步的成交"_s;
        return u"%1 · %2 %3 股 %4 @ %5 · %6%7 · IBKR 成交%8"_s.arg(when, lng ? u"卖出"_s : u"买回"_s, S(c[u"exit_qty"_s]), S(c[u"symbol"_s]), orDash(c[u"avg_exit"_s]), why,
                                                                  acct, flag);
    }
    const QString head = u"%1 %2 %3 股 %4 @ %5"_s.arg(when, lng ? u"买"_s : u"卖空"_s, S(c[u"qty"_s]), S(c[u"symbol"_s]), orDash(c[u"avg_entry"_s]));
    if (S(c[u"status"_s]) == u"closed") {
        const QJsonValue pnl = c[u"pnl"_s];
        const QString pnlText = !has(pnl) ? QString() : u" · 盈亏 %1%2"_s.arg(N(pnl) > 0 ? u"+"_s : QString(), S(pnl));
        return u"%1 → %2 平 @ %3%4%5 · IBKR 成交%6"_s.arg(head, orders::fmtTimeShort(c[u"closed_at"_s], nowMs, zone), orDash(c[u"avg_exit"_s]), pnlText, acct, flag);
    }
    const QString trimmed = T(c[u"exit_qty"_s]) ? u" · 已减 %1 股 @ %2"_s.arg(S(c[u"exit_qty"_s]), orDash(c[u"avg_exit"_s])) : QString();
    return u"%1%2%3 · IBKR 成交 · 持仓中 %4 股%5"_s.arg(head, trimmed, acct, S(c[u"open_qty"_s]), flag);
}

QJsonArray detailRows(const QList<std::pair<QString, QJsonValue>>& rows) {
    QJsonArray out;
    for (const auto& [k, v] : rows)
        if (has(v) && !(v.isString() && v.toString().isEmpty())) out.append(QJsonObject{{u"label"_s, k}, {u"value"_s, S(v)}});
    return out;
}
QJsonValue strOrNull(bool ok, const QString& s) { return ok ? QJsonValue(s) : QJsonValue(QJsonValue::Null); }

QJsonArray findingsOf(const QJsonValue& r) {
    QJsonArray out;
    for (const QJsonValue& f : arr(r[u"findings"_s])) out.append(QJsonObject{{u"tone"_s, findingTone(f[u"tone"_s])}, {u"title"_s, S(f[u"title"_s])}, {u"text"_s, S(f[u"text"_s])}});
    return out;
}
QJsonArray notesOf(const QJsonValue& list) {
    QJsonArray out;
    for (const QJsonValue& n : arr(list)) out.append(S(n));
    return out;
}

QJsonObject exitPlanModel(const QJsonValue& r) {
    const QJsonValue plan = r[u"exit_plan"_s];
    const QJsonValue sim = plan[u"simulation"_s];
    const bool run = T(sim) && T(sim[u"applicable"_s]);
    const QJsonValue p = r[u"profile"_s], ph = plan[u"phases"_s];
    const QJsonValue t = run ? sim[u"totals"_s] : QJsonValue(QJsonObject{});
    const QJsonArray events = run ? arr(sim[u"events"_s]) : QJsonArray{};
    QJsonObject out;
    out[u"hint"_s] = u"入场 D = %1,翼宽 W = %2,EM = %3(翼宽 = %4 个日 σ)。阶段 A 到 %5;阶段 C 自 %6 起(σ_剩余 %7 < W/1.6 = %8)。"_s.arg(
                         orDash(p[u"debit"_s]), S(p[u"width"_s]), S(ph[u"em_at_open"_s]), orDash(ph[u"wing_in_sigma"_s]), S(ph[u"a_until"_s]), S(ph[u"c_from"_s]),
                         S(ph[u"sigma_at_switch"_s]), S(ph[u"threshold"_s])) +
                     (has(plan[u"actual_exit_mult"_s]) ? u" 实际平仓价 = %1×D。"_s.arg(S(plan[u"actual_exit_mult"_s])) : QString());
    QJsonArray levels;
    for (const QJsonValue& l : arr(plan[u"levels"_s]))
        levels.append(QJsonObject{{u"label"_s, S(l[u"label"_s])}, {u"price"_s, S(l[u"price"_s])}, {u"mult"_s, S(l[u"mult_of_debit"_s]) + u"×D"_s},
                                  {u"qty"_s, T(l[u"tranche_qty"_s]) ? S(l[u"tranche_qty"_s]) : u"—"_s}, {u"perContract"_s, signedCell(l[u"pnl_per_contract"_s])},
                                  {u"expected"_s, signedCell(l[u"expected_pnl"_s])}});
    out[u"levels"_s] = levels;
    if (T(sim) && sim[u"applicable"_s] == QJsonValue(false)) {
        out[u"notApplicable"_s] = T(sim[u"reason"_s]) ? S(sim[u"reason"_s]) : QString();  // sim.reason || ''
    } else {
        const QJsonValue o = r[u"outcome"_s];
        const QString kind = S(o[u"kind"_s]);
        const QJsonValue peak = t[u"profit_peak"_s];
        const QJsonValue peakPnl = has(peak) && has(p[u"debit"_s]) ? QJsonValue(N(peak) * N(p[u"multiplier"_s]) * N(p[u"qty"_s])) : QJsonValue(QJsonValue::Null);
        const auto row = [](const QString& k, const QJsonValue& v, const QString& note) { return QJsonObject{{u"k"_s, k}, {u"v"_s, signedCell(v)}, {u"note"_s, note}}; };
        out[u"outcomes"_s] = QJsonArray{
            row(u"按策略回放"_s, t[u"strategy"_s], u"%1 次出手"_s.arg(events.size())),
            row(u"实际"_s, t[u"actual"_s], kind == u"closed" ? u"以 %1 平仓"_s.arg(S(o[u"price"_s])) : kind == u"expired" ? u"到期结算"_s : u"持仓中,未计"_s),
            row(u"持到结算 / 最新"_s, t[u"hold_to_settle"_s], u"按最后一根标的 K 线的内在价值"_s),
            row(u"最高蝶价"_s, t[u"best_mid_pnl"_s], has(t[u"best_mid"_s]) ? u"中间价曾到 "_s + S(t[u"best_mid"_s]) : QString()),
            row(u"浮盈高水位"_s, peakPnl, T(peak) ? u"激活之后记到 %1 点,回撤追踪按它算"_s.arg(S(peak)) : u"没到回撤追踪的激活线"_s),
        };
        QJsonArray ev;
        for (const QJsonValue& e : events)
            ev.append(QJsonObject{{u"time"_s, S(e[u"time"_s]).mid(11)}, {u"phase"_s, phaseLabel(e[u"phase"_s])}, {u"qty"_s, S(e[u"qty"_s])},
                                  {u"price"_s, S(e[u"price"_s]) + (S(e[u"source"_s]) == u"model" ? u"(模型)"_s : QString())}, {u"pnl"_s, signedCell(e[u"pnl"_s])},
                                  {u"rule"_s, has(e[u"rule"_s]) ? S(e[u"rule"_s]) : QString()}});
        out[u"events"_s] = ev;
    }
    out[u"notes"_s] = notesOf(plan[u"notes"_s]);
    return out;
}

QJsonObject flyResult(const QJsonValue& r) {
    const QJsonValue p = r[u"profile"_s], z = r[u"zone"_s], o = r[u"outcome"_s], s = r[u"stats"_s];
    const bool open = S(o[u"kind"_s]) == u"open";
    const QJsonValue pnl = open ? o[u"pnl_if_expired_now"_s] : o[u"pnl"_s];
    QJsonObject out{{u"kind"_s, u"butterfly"_s}, {u"local"_s, S(r[u"source"_s]) == u"local"}};
    const auto tile = [](const QString& label, const QString& value, const QString& tone = QString()) { return QJsonObject{{u"label"_s, label}, {u"value"_s, value}, {u"tone"_s, tone}}; };
    out[u"tiles"_s] = QJsonArray{
        tile(u"结构"_s, u"%1 %2/%3/%4 %5"_s.arg(S(p[u"symbol"_s]), S(p[u"lower"_s]), S(p[u"center"_s]), S(p[u"upper"_s]), S(p[u"right_label"_s]))),
        tile(u"权利金"_s + (T(p[u"price_estimated"_s]) ? u"(估算)"_s : QString()), has(p[u"debit"_s]) ? S(p[u"debit"_s]) : u"—"_s),
        tile(u"盈利区"_s, T(z[u"known"_s]) ? u"%1 ~ %2"_s.arg(S(z[u"lower_be"_s]), S(z[u"upper_be"_s])) : u"—"_s),
        tile(u"开仓时标的"_s, u"%1(距中心 %2)"_s.arg(S(s[u"entry_underlying"_s]), signDist(s[u"dist_entry"_s]))),
        tile(open ? u"最新标的"_s : u"结局时标的"_s, u"%1(距中心 %2)"_s.arg(S(s[u"exit_underlying"_s]), signDist(s[u"dist_exit"_s]))),
        tile(open ? u"若此刻到期"_s : u"盈亏"_s, !has(pnl) ? u"—"_s : money(pnl) + (has(o[u"pnl_pct"_s]) ? u" (%1%)"_s.arg(S(o[u"pnl_pct"_s])) : QString()),
             !has(pnl) ? QString() : N(pnl) > 0 ? u"pos"_s : N(pnl) < 0 ? u"neg"_s : QString()),
    };
    out[u"underlyingTitle"_s] = u"标的走势(%1,开仓前后到%2)"_s.arg(S(r[u"timeframe_label"_s]), reviewKind(o[u"kind"_s]) == u"持仓中" ? u"现在"_s : u"结局"_s);
    // 有没有图只看够不够两根(同各图开头那一句),不为一个布尔把整张图的 spec 算一遍
    out[u"hasUnderlying"_s] = arr(r[u"series"_s][u"bars"_s]).size() >= 2;
    if (T(r[u"exit_plan"_s])) {
        const QJsonValue fs = r[u"fly_series"_s];
        out[u"flyTitle"_s] = u"蝶价走势(组合中间价 · 1 分钟 · %1)"_s.arg(S(fs[u"source"_s]) == u"ibkr" ? u"IBKR 真实数据"_s : u"模型价"_s);
        out[u"hasFly"_s] = flyTimeCount(r) >= 2;
        out[u"exitPlan"_s] = exitPlanModel(r);
    }
    out[u"findings"_s] = findingsOf(r);
    const QJsonValue closest = s[u"closest"_s], bt = s[u"best_theoretical"_s], bm = s[u"best_market"_s];
    out[u"details"_s] = detailRows({
        {u"开仓时间(美东)"_s, S(r[u"entry"_s][u"time_et"_s]) + (T(r[u"entry"_s][u"estimated"_s]) ? u"(按提交时间)"_s : QString())},
        {u"结局"_s, (reviewKind(o[u"kind"_s]).isEmpty() ? S(o[u"kind"_s]) : reviewKind(o[u"kind"_s])) + (T(o[u"time_et"_s]) ? u" · "_s + S(o[u"time_et"_s]) : QString())},
        {u"平仓 / 结算价"_s, strOrNull(has(o[u"price"_s]), S(o[u"price"_s]))},
        {u"持有 K 线数"_s, s[u"hold_bars"_s]},
        {u"持有期间标的区间"_s, u"%1 ~ %2"_s.arg(S(s[u"hold_low"_s]), S(s[u"hold_high"_s]))},
        {u"最接近中心"_s, strOrNull(T(closest), u"%1(%2,距 %3)"_s.arg(S(closest[u"price"_s]), S(closest[u"time"_s]), S(closest[u"distance"_s])))},
        {u"盈利区内收盘 K 线"_s, strOrNull(has(s[u"in_zone_bars"_s]), u"%1/%2"_s.arg(S(s[u"in_zone_bars"_s]), S(s[u"hold_bars"_s])))},
        {u"最好的理论时刻(若当时到期)"_s, strOrNull(T(bt), u"%1 · %2"_s.arg(S(bt[u"time"_s]), money(bt[u"pnl"_s])))},
        {u"持有期间最高中间价"_s, strOrNull(T(bm), u"%1 · %2 · %3"_s.arg(S(bm[u"time"_s]), S(bm[u"mid"_s]), money(bm[u"pnl"_s])))},
        {u"最大盈利 / 最大亏损"_s, strOrNull(T(z[u"known"_s]), u"%1 / %2"_s.arg(money(z[u"max_profit"_s]), money(z[u"max_loss"_s])))},
        {u"平仓记录"_s, o[u"record_id"_s]},
    });
    out[u"notes"_s] = notesOf(r[u"notes"_s]);
    return out;
}

QJsonObject stockResult(const QJsonValue& r, double nowMs, const QTimeZone& zone) {
    const QJsonValue p = r[u"profile"_s], o = r[u"outcome"_s], s = r[u"stats"_s];
    const bool lng = S(p[u"side"_s]) == u"LONG";
    const bool open = S(o[u"kind"_s]) == u"open";
    const QJsonValue pnl = o[u"pnl"_s];
    const auto execs = [&](const QJsonValue& list) {
        QStringList parts;
        for (const QJsonValue& e : arr(list))
            parts << u"%1 %2 %3 @ %4"_s.arg(T(e[u"time_et"_s]) ? S(e[u"time_et"_s]) : orders::fmtTimeShort(e[u"time"_s], nowMs, zone), S(e[u"action"_s]) == u"BUY" ? u"买"_s : u"卖"_s,
                                            S(e[u"qty"_s]), S(e[u"price"_s]));
        return parts.join(u';');
    };
    // fmtNum:不是有限数是「—」
    const auto pct0 = [](double v) { return std::isfinite(v) ? jsToFixed(v, 0) : u"—"_s; };
    QJsonObject out{{u"kind"_s, u"stock"_s}};
    const auto tile = [](const QString& label, const QString& value, const QString& tone = QString()) { return QJsonObject{{u"label"_s, label}, {u"value"_s, value}, {u"tone"_s, tone}}; };
    const QJsonValue ep = s[u"entry_position"_s], xp = s[u"exit_position"_s];
    out[u"tiles"_s] = QJsonArray{
        tile(u"交易"_s, u"%1 %2 %3 股"_s.arg(S(p[u"side_label"_s]), S(p[u"symbol"_s]), S(p[u"qty"_s]))),
        tile(lng ? u"买入均价"_s : u"卖空均价"_s, has(p[u"avg_entry"_s]) ? S(p[u"avg_entry"_s]) : u"未知(建仓更早)"_s),
        tile(open ? u"最新价"_s : lng ? u"卖出均价"_s : u"买回均价"_s, open ? S(o[u"underlying"_s]) : has(p[u"avg_exit"_s]) ? S(p[u"avg_exit"_s]) : u"—"_s),
        tile(u"进场位置"_s, !has(ep) ? u"—"_s : u"%1 %2%"_s.arg(lng ? u"离最低"_s : u"离最高"_s, pct0((1 - N(ep)) * 100))),
        tile(u"出场位置"_s, !has(xp) ? u"—"_s : u"区间的 %1%"_s.arg(pct0(N(xp) * 100))),
        tile(open ? u"盈亏(含浮动)"_s : u"盈亏"_s, !has(pnl) ? u"—"_s : money(pnl) + pctText(o[u"pnl_pct"_s]),
             !has(pnl) ? QString() : N(pnl) > 0 ? u"pos"_s : N(pnl) < 0 ? u"neg"_s : QString()),
    };
    out[u"chartTitle"_s] = u"%1 走势(%2,开仓前后到%3)"_s.arg(S(p[u"symbol"_s]), S(r[u"timeframe_label"_s]), open ? u"现在"_s : u"平仓之后"_s);
    out[u"hasChart"_s] = arr(r[u"series"_s][u"bars"_s]).size() >= 2;
    out[u"findings"_s] = findingsOf(r);
    const QJsonValue mfe = s[u"mfe"_s], mae = s[u"mae"_s];
    out[u"details"_s] = detailRows({
        {u"账户"_s, r[u"account"_s]},
        {u"开始时间(美东)"_s, r[u"entry"_s][u"time_et"_s]},
        {u"结局"_s, (reviewKind(o[u"kind"_s]).isEmpty() ? S(o[u"kind"_s]) : reviewKind(o[u"kind"_s])) + (T(o[u"time_et"_s]) ? u" · "_s + S(o[u"time_et"_s]) : QString())},
        {lng ? u"买入"_s : u"卖空"_s, strOrNull(!arr(p[u"entries"_s]).isEmpty(), execs(p[u"entries"_s]))},
        {lng ? u"卖出"_s : u"买回"_s, strOrNull(!arr(p[u"exits"_s]).isEmpty(), execs(p[u"exits"_s]))},
        {u"持有 K 线数"_s, s[u"hold_bars"_s]},
        {u"持有期间区间"_s, strOrNull(has(s[u"hold_low"_s]), u"%1 ~ %2"_s.arg(S(s[u"hold_low"_s]), S(s[u"hold_high"_s])))},
        {u"最大浮盈"_s, strOrNull(T(mfe), u"%1%2 · %3 到 %4"_s.arg(money(mfe[u"amount"_s]), pctText(mfe[u"pct"_s]), S(mfe[u"time"_s]), S(mfe[u"price"_s])))},
        {u"最大浮亏"_s, strOrNull(T(mae), u"%1%2 · %3 到 %4"_s.arg(money(QJsonValue(-N(mae[u"amount"_s]))),
                                                                   pctText(has(mae[u"pct"_s]) ? QJsonValue(-N(mae[u"pct"_s])) : QJsonValue(QJsonValue::Null)), S(mae[u"time"_s]),
                                                                   S(mae[u"price"_s])))},
        {u"兑现了最大浮盈的"_s, strOrNull(has(s[u"capture_pct"_s]), S(s[u"capture_pct"_s]) + u"%"_s)},
        {u"已实现 / 浮动盈亏"_s, strOrNull(has(o[u"realized_pnl"_s]), u"%1 / %2"_s.arg(money(o[u"realized_pnl"_s]), has(o[u"unrealized_pnl"_s]) ? money(o[u"unrealized_pnl"_s]) : u"—"_s))},
        {u"佣金(未扣)"_s, strOrNull(T(o[u"commission"_s]), money(o[u"commission"_s]))},
    });
    out[u"notes"_s] = notesOf(r[u"notes"_s]);
    return out;
}

}  // namespace

QString findingTone(const QJsonValue& tone) {
    static const QHash<QString, QString> m{{u"good"_s, u"ok"_s}, {u"warn"_s, u"warn"_s}, {u"bad"_s, u"bad"_s}, {u"info"_s, u"info"_s}};
    return m.value(S(tone), u"info"_s);
}

const QList<std::pair<QString, QString>>& timeframeOptions() {
    static const QList<std::pair<QString, QString>> l{{u"auto"_s, u"自动周期"_s}, {u"1m"_s, u"1 分钟"_s}, {u"5m"_s, u"5 分钟"_s},
                                                      {u"15m"_s, u"15 分钟"_s}, {u"1h"_s, u"1 小时"_s}, {u"1d"_s, u"日线"_s}};
    return l;
}
const QList<std::pair<QString, QString>>& kindOptions() {
    static const QList<std::pair<QString, QString>> l{{u"all"_s, u"全部"_s}, {u"butterfly"_s, u"蝴蝶"_s}, {u"stock"_s, u"股票"_s}};
    return l;
}

QString candidateLabel(const QJsonValue& c, double nowMs, const QTimeZone& zone) {
    if (S(c[u"kind"_s]) == u"stock") return stockLabel(c, nowMs, zone);
    const QString when = orders::fmtTimeShort(c[u"created_at"_s], nowMs, zone);
    QStringList strikes;
    for (const QJsonValue& k : arr(c[u"strikes"_s])) strikes << S(k);
    const QString fs = S(c[u"final_status"_s]);
    const QString state = S(c[u"source"_s]) == u"ibkr" ? u"IBKR 成交"_s
                          : T(c[u"filled"_s])           ? u"已成交"_s
                          : T(c[u"final_status"_s])     ? finalStatusLabel().value(fs, fs)
                          : T(c[u"status"_s])           ? S(c[u"status"_s])
                                                        : u"本地 · 未成交"_s;
    const QString price = !has(c[u"price"_s]) ? QString() : u" @ %1%2"_s.arg(S(c[u"price"_s]), T(c[u"price_estimated"_s]) ? u"(限价)"_s : QString());
    const QString acct = T(c[u"account"_s]) ? u" · "_s + S(c[u"account"_s]) : QString();
    const QString side = S(c[u"action"_s]) == u"BUY" ? u"买"_s : u"卖"_s;
    if (T(c[u"exit"_s])) {
        const QJsonValue e = c[u"exit"_s];
        const QString pnl = !has(e[u"pnl"_s]) ? QString() : u" · 盈亏 %1%2"_s.arg(N(e[u"pnl"_s]) > 0 ? u"+"_s : QString(), S(e[u"pnl"_s]));
        return u"%1 %2 @ %3 → %4 平 @ %5%6 · %7 张 %8 %9 %10蝴蝶 · 到期 %11%12 · %13"_s.arg(
            when, side, orDash(c[u"price"_s]), orders::fmtTimeShort(e[u"time"_s], nowMs, zone), orDash(e[u"price"_s]), pnl, S(c[u"qty"_s]), S(c[u"symbol"_s]),
            strikes.join(u'/'), S(c[u"right"_s]), S(c[u"expiry"_s]), acct, state);
    }
    return u"%1 · %2 %3 %4 %5 %6蝴蝶 · 到期 %7%8%9 · %10 · 未平仓 / 到期"_s.arg(when, side, S(c[u"qty"_s]), S(c[u"symbol"_s]), strikes.join(u'/'), S(c[u"right"_s]),
                                                                               S(c[u"expiry"_s]), price, acct, state);
}

QJsonArray shownCandidates(const QJsonArray& candidates, const QString& kind) {
    if (kind == u"all") return candidates;
    QJsonArray out;
    for (const QJsonValue& c : candidates)
        if ((T(c[u"kind"_s]) ? S(c[u"kind"_s]) : u"butterfly"_s) == kind) out.append(c);
    return out;
}

// { freshness, kinds: [{ value, label }], kind, options: [{ value, label }], selected, selectedLabel, placeholder, timeframes, timeframe, timeframeLabel,
//   em, emDisabled, includeLocal, loading, error, empty, result: { kind: butterfly | stock, … } | null }
QJsonObject pageModel(const PageInput& in) {
    QJsonObject page;
    page[u"freshness"_s] = in.freshness;
    QJsonArray kinds;
    for (const auto& [k, v] : kindOptions()) kinds.append(QJsonObject{{u"value"_s, k}, {u"label"_s, v}});
    page[u"kinds"_s] = kinds;
    page[u"kind"_s] = in.kind;
    const QJsonArray shown = shownCandidates(in.candidates, in.kind);
    QJsonArray options;
    QString selectedLabel;
    for (const QJsonValue& c : shown) {
        const QString label = candidateLabel(c, in.nowMs, in.zone);
        options.append(QJsonObject{{u"value"_s, S(c[u"id"_s])}, {u"label"_s, label}});
        if (S(c[u"id"_s]) == in.selected) selectedLabel = label;
    }
    page[u"options"_s] = options;
    page[u"selected"_s] = selectedLabel.isEmpty() ? QString() : in.selected;
    page[u"selectedLabel"_s] = selectedLabel;
    const QString what = in.kind == u"stock" ? u"股票交易"_s : in.kind == u"butterfly" ? u"蝴蝶"_s : u"蝴蝶或股票交易"_s;
    page[u"placeholder"_s] = !has(in.available)    ? u"加载中…"_s
                             : T(in.available) ? u"库里和 TWS 最近 7 天的成交里都没有%1(7 天之前的要不到)"_s.arg(what)
                                               : u"还没有同步到任何 IBKR 成交:先连接 TWS 再点「同步成交」"_s;
    QJsonArray tfs;
    QString tfLabel = in.timeframe;
    for (const auto& [k, v] : timeframeOptions()) {
        tfs.append(QJsonObject{{u"value"_s, k}, {u"label"_s, v}});
        if (k == in.timeframe) tfLabel = v;
    }
    page[u"timeframes"_s] = tfs;
    page[u"timeframe"_s] = in.timeframe;
    page[u"timeframeLabel"_s] = tfLabel;
    page[u"em"_s] = has(in.em) ? in.em : QJsonValue(QJsonValue::Null);
    QString selectedKind = u"butterfly"_s;
    for (const QJsonValue& c : in.candidates)
        if (S(c[u"id"_s]) == in.selected) {  // find:取第一个
            if (T(c[u"kind"_s])) selectedKind = S(c[u"kind"_s]);
            break;
        }
    page[u"emDisabled"_s] = selectedKind == u"stock";
    page[u"includeLocal"_s] = in.includeLocal;
    page[u"loading"_s] = in.loading;
    page[u"error"_s] = in.loading ? QString() : in.error;
    if (in.loading || !in.error.isEmpty() || !T(in.data)) {
        page[u"result"_s] = QJsonValue::Null;
        page[u"empty"_s] = !in.loading && in.error.isEmpty() ? u"选一笔交易后点「分析」。"_s : QString();
    } else {
        page[u"result"_s] = S(in.data[u"kind"_s]) == u"stock" ? stockResult(in.data, in.nowMs, in.zone) : flyResult(in.data);
    }
    return page;
}

QStringList pageTexts(const QJsonObject& page) {
    QStringList t{u"交易分析"_s, page[u"freshness"_s].toString()};
    for (const QJsonValue& k : page[u"kinds"_s].toArray()) t << k[u"label"_s].toString();
    t << (page[u"selectedLabel"_s].toString().isEmpty() ? page[u"placeholder"_s].toString() : page[u"selectedLabel"_s].toString());
    t << page[u"timeframeLabel"_s].toString() << u"EM"_s << u"同步成交"_s << u"分析"_s << u"附带本地未成交的记录"_s
      << u"默认只列 IBKR 真实成交过的蝴蝶;打开后把本地校验过但没成交的也列出来(按限价估算)"_s << u"数据来源、结论规则与止盈策略"_s;
    if (page[u"loading"_s].toBool()) return t << u"正在拉取 K 线并复盘…"_s;
    if (!page[u"error"_s].toString().isEmpty()) return t << u"分析失败"_s << page[u"error"_s].toString();
    if (!page[u"result"_s].isObject()) return t << page[u"empty"_s].toString();
    const QJsonObject r = page[u"result"_s].toObject();
    const auto table = [&](const QStringList& head, const QJsonArray& rows, const QStringList& keys) {
        t << head;
        for (const QJsonValue& row : rows)
            for (const QString& k : keys) t << (row[k].isObject() ? row[k][u"text"_s].toString() : row[k].toString());
    };
    if (r[u"local"_s].toBool()) t << u"这是本地记录,不是券商成交"_s << u"这张蝴蝶没有在 IBKR 成交过,下面的权利金按限价、开仓时刻按提交时间估算。"_s;
    for (const QJsonValue& x : r[u"tiles"_s].toArray()) t << x[u"label"_s].toString() << fly::statisticParts(x[u"value"_s].toString());
    if (r[u"kind"_s].toString() == u"stock") {
        t << r[u"chartTitle"_s].toString();
    } else {
        t << r[u"underlyingTitle"_s].toString();
        if (r[u"exitPlan"_s].isObject()) {
            t << r[u"flyTitle"_s].toString();
            if (!r[u"hasFly"_s].toBool()) t << u"没有蝶价数据:引擎未连 TWS,或 IBKR 没有这张组合的历史分钟线。"_s;
            const QJsonObject ep = r[u"exitPlan"_s].toObject();
            t << u"止盈策略(SPX 0DTE 蝶式 v2.1 · 浮盈回撤追踪)"_s << ep[u"hint"_s].toString();
            table({u"点位"_s, u"蝶价"_s, u"倍数"_s, u"张数"_s, u"每张盈亏"_s, u"预计盈亏"_s}, ep[u"levels"_s].toArray(),
                  {u"label"_s, u"price"_s, u"mult"_s, u"qty"_s, u"perContract"_s, u"expected"_s});
            if (ep.contains(u"notApplicable"_s)) {
                t << u"不能回放"_s << ep[u"notApplicable"_s].toString();
            } else {
                table({u"结局对比"_s, u"盈亏"_s, u"说明"_s}, ep[u"outcomes"_s].toArray(), {u"k"_s, u"v"_s, u"note"_s});
                table({u"时间"_s, u"阶段"_s, u"张数"_s, u"蝶价"_s, u"盈亏"_s, u"规则"_s}, ep[u"events"_s].toArray(),
                      {u"time"_s, u"phase"_s, u"qty"_s, u"price"_s, u"pnl"_s, u"rule"_s});
                if (ep[u"events"_s].toArray().isEmpty()) t << u"策略在这段数据里没有出手"_s;
            }
            for (const QJsonValue& n : ep[u"notes"_s].toArray()) t << n.toString();
        }
    }
    for (const QJsonValue& f : r[u"findings"_s].toArray()) t << f[u"title"_s].toString() << f[u"text"_s].toString();
    if (!r[u"details"_s].toArray().isEmpty()) {
        t << u"明细"_s;
        for (const QJsonValue& d : r[u"details"_s].toArray()) t << d[u"label"_s].toString() << d[u"value"_s].toString();
    }
    for (const QJsonValue& n : r[u"notes"_s].toArray()) t << n.toString();
    return t;
}

// ---- 三张图 ----------------------------------------------------------------------------------------

QJsonValue stockChart(const QJsonValue& r) {
    const QJsonArray bars = arr(r[u"series"_s][u"bars"_s]);
    if (bars.size() < 2) return QJsonValue::Null;
    const bool lng = S(r[u"profile"_s][u"side"_s]) == u"LONG";
    QJsonArray hlines;
    for (const QJsonValue& l : arr(r[u"series"_s][u"levels"_s])) {
        const QString k = S(l[u"kind"_s]);
        if (k == u"avg_entry")
            hlines.append(QJsonObject{{u"price"_s, l[u"price"_s]}, {u"color"_s, u"blue"_s}, {u"dash"_s, QJsonArray{}}, {u"alpha"_s, 0.9}, {u"label"_s, lng ? u"买入均价"_s : u"卖空均价"_s}});
        else if (k == u"avg_exit")
            hlines.append(QJsonObject{{u"price"_s, l[u"price"_s]}, {u"color"_s, u"purple"_s}, {u"dash"_s, QJsonArray{4, 3}}, {u"alpha"_s, 0.9}, {u"label"_s, lng ? u"卖出均价"_s : u"买回均价"_s}});
    }
    QJsonArray markers;
    for (const QJsonValue& m : arr(r[u"series"_s][u"markers"_s])) {
        const bool buy = S(m[u"action"_s]) == u"BUY";
        markers.append(QJsonObject{{u"time"_s, m[u"time"_s]}, {u"price"_s, m[u"price"_s]}, {u"shape"_s, buy ? u"tri-up"_s : u"tri-down"_s}, {u"color"_s, buy ? u"blue"_s : u"purple"_s},
                                   {u"label"_s, u"%1 %2"_s.arg(buy ? u"买"_s : u"卖"_s, S(m[u"qty"_s]))}, {u"labelPos"_s, buy ? u"below"_s : u"above"_s}});
    }
    const QJsonArray legend{QJsonArray{u"■"_s, u"up"_s, u"阳线"_s}, QJsonArray{u"■"_s, u"down"_s, u"阴线"_s}, QJsonArray{u"▲"_s, u"blue"_s, u"买入"_s},
                            QJsonArray{u"▼"_s, u"purple"_s, u"卖出"_s}, QJsonArray{u"—"_s, u"blue"_s, lng ? u"买入均价"_s : u"卖空均价"_s},
                            QJsonArray{u"╌"_s, u"purple"_s, lng ? u"卖出均价"_s : u"买回均价"_s}};
    return QJsonObject{{u"ariaLabel"_s, u"股价走势"_s}, {u"viewKey"_s, u"stock:%1:%2"_s.arg(S(r[u"record_id"_s]), S(r[u"series"_s][u"timeframe"_s]))},
                       {u"bars"_s, bars}, {u"hlines"_s, hlines}, {u"markers"_s, markers}, {u"legend"_s, legend}, {u"volume"_s, true}};
}

QJsonValue underlyingChart(const QJsonValue& r) {
    const QJsonArray bars = arr(r[u"series"_s][u"bars"_s]);
    if (bars.size() < 2) return QJsonValue::Null;
    const QJsonArray levels = arr(r[u"series"_s][u"levels"_s]);
    QJsonArray hlines;
    for (const QJsonValue& l : levels) {
        const QString k = S(l[u"kind"_s]);
        QJsonObject h;
        if (k == u"lower") h = {{u"color"_s, u"orange"_s}, {u"dash"_s, QJsonArray{4, 3}}, {u"alpha"_s, 0.8}, {u"label"_s, u"下翼"_s}};
        else if (k == u"center") h = {{u"color"_s, u"blue"_s}, {u"dash"_s, QJsonArray{}}, {u"alpha"_s, 0.9}, {u"label"_s, u"中心"_s}};
        else if (k == u"upper") h = {{u"color"_s, u"orange"_s}, {u"dash"_s, QJsonArray{4, 3}}, {u"alpha"_s, 0.8}, {u"label"_s, u"上翼"_s}};
        else if (k == u"lower_be" || k == u"upper_be") h = {{u"color"_s, u"up"_s}, {u"dash"_s, QJsonArray{2, 2}}, {u"alpha"_s, 0.6}, {u"tag"_s, false}, {u"label"_s, u"盈亏平衡"_s}};
        else continue;
        h.insert(u"price"_s, l[u"price"_s]);
        hlines.append(h);
    }
    // 止盈策略的临界线(|S−K| 的 0.45W / 0.55W / 0.8W):不撑开区间、不占轴,名字写在上沿那条线的左端
    static const std::map<QString, std::pair<QString, QString>> zoneStyle{{u"hold"_s, {u"blue"_s, u"持有"_s}}, {u"half"_s, {u"purple"_s, u"清半"_s}}, {u"stop"_s, {u"down"_s, u"止损"_s}}};
    for (const QJsonValue& z : arr(r[u"exit_plan"_s][u"zones"_s])) {
        const auto it = zoneStyle.find(S(z[u"kind"_s]));
        if (it == zoneStyle.end()) continue;
        hlines.append(QJsonObject{{u"price"_s, z[u"high"_s]}, {u"color"_s, it->second.first}, {u"dash"_s, QJsonArray{2, 3}}, {u"alpha"_s, 0.45}, {u"tag"_s, false}, {u"fit"_s, false},
                                  {u"label"_s, u"%1 ±%2"_s.arg(it->second.second, S(z[u"half_width"_s]))}});
        hlines.append(QJsonObject{{u"price"_s, z[u"low"_s]}, {u"color"_s, it->second.first}, {u"dash"_s, QJsonArray{2, 3}}, {u"alpha"_s, 0.45}, {u"tag"_s, false}, {u"fit"_s, false}});
    }
    QJsonValue lowerBe(QJsonValue::Undefined), upperBe(QJsonValue::Undefined);  // levels.find:没找到是 undefined
    for (const QJsonValue& l : levels) {
        if (S(l[u"kind"_s]) == u"lower_be" && lowerBe.isUndefined()) lowerBe = l;
        if (S(l[u"kind"_s]) == u"upper_be" && upperBe.isUndefined()) upperBe = l;
    }
    const QJsonArray bands = !lowerBe.isUndefined() && !upperBe.isUndefined()
                                 ? QJsonArray{QJsonObject{{u"top"_s, upperBe[u"price"_s]}, {u"bottom"_s, lowerBe[u"price"_s]}, {u"color"_s, u"up"_s}, {u"fill"_s, 0.1}}}
                                 : QJsonArray{};
    static const std::map<QString, std::pair<QString, QString>> mark{{u"entry"_s, {u"blue"_s, u"开仓"_s}}, {u"exit"_s, {u"purple"_s, u"平仓"_s}}, {u"expiry"_s, {u"purple"_s, u"到期"_s}}};
    QJsonArray vlines, markers;
    for (const QJsonValue& m : arr(r[u"series"_s][u"markers"_s])) {
        const auto it = mark.find(S(m[u"kind"_s]));
        const auto& st = it == mark.end() ? mark.at(u"entry"_s) : it->second;
        vlines.append(QJsonObject{{u"time"_s, m[u"time"_s]}, {u"color"_s, st.first}, {u"label"_s, u"%1 %2"_s.arg(st.second, S(m[u"price"_s]))}});
        markers.append(QJsonObject{{u"time"_s, m[u"time"_s]}, {u"price"_s, m[u"price"_s]}, {u"shape"_s, u"dot"_s}, {u"color"_s, st.first}, {u"fit"_s, false}});
    }
    QJsonArray legend{QJsonArray{u"■"_s, u"up"_s, u"阳线"_s}, QJsonArray{u"■"_s, u"down"_s, u"阴线"_s}, QJsonArray{u"—"_s, u"blue"_s, u"中心"_s},
                      QJsonArray{u"╌"_s, u"orange"_s, u"上下翼"_s}, QJsonArray{u"▮"_s, u"up"_s, u"盈利区(到期)"_s}, QJsonArray{u"┆"_s, u"blue"_s, u"开仓"_s},
                      QJsonArray{u"┆"_s, u"purple"_s, u"平仓 / 到期"_s}};
    if (T(r[u"exit_plan"_s])) legend.append(QJsonArray{u"╌"_s, u"label2"_s, u"临界线 ±0.45W / 0.55W / 0.8W"_s});
    return QJsonObject{{u"ariaLabel"_s, u"标的走势"_s}, {u"bars"_s, bars}, {u"hlines"_s, hlines}, {u"bands"_s, bands}, {u"vlines"_s, vlines}, {u"markers"_s, markers},
                       {u"legend"_s, legend}, {u"volume"_s, false}};
}

namespace {
/// 蝶价图的横轴:真实分钟线与策略回放路径的时刻并起来(去重、按 UTF-16 码元排,同 Array.prototype.sort())
QStringList flyTimes(const QJsonValue& r, bool sorted) {
    const QJsonValue sim = r[u"exit_plan"_s][u"simulation"_s];
    const QJsonArray real = arr(r[u"fly_series"_s][u"bars"_s]);
    const QJsonArray path = T(sim) && T(sim[u"applicable"_s]) ? arr(sim[u"series"_s]) : QJsonArray{};
    QStringList times;
    QSet<QString> seen;
    for (const QJsonArray& list : {real, path})
        for (const QJsonValue& b : list)
            if (!seen.contains(S(b[u"time"_s]))) seen.insert(S(b[u"time"_s])), times << S(b[u"time"_s]);
    if (sorted) std::sort(times.begin(), times.end(), [](const QString& a, const QString& b) { return QString::compare(a, b, Qt::CaseSensitive) < 0; });
    return times;
}
}  // namespace

qsizetype flyTimeCount(const QJsonValue& r) { return flyTimes(r, false).size(); }

QJsonValue flyChart(const QJsonValue& r) {
    const QJsonValue fs = r[u"fly_series"_s];
    const QJsonValue plan = r[u"exit_plan"_s];
    const QJsonValue sim = plan[u"simulation"_s];
    const bool run = T(sim) && T(sim[u"applicable"_s]);
    const QJsonArray real = arr(fs[u"bars"_s]);
    const QJsonArray path = run ? arr(sim[u"series"_s]) : QJsonArray{};
    const QStringList times = flyTimes(r, true);
    if (times.size() < 2) return QJsonValue::Null;
    QHash<QString, QJsonValue> pathAt;
    for (const QJsonValue& p : path) pathAt.insert(S(p[u"time"_s]), p);  // new Map:同一个时刻后一个算数
    struct Phase {
        QString phase, from, to;
    };
    QList<Phase> phases;
    int open = -1;
    for (const QString& t : times) {
        const QJsonValue p = pathAt.value(t);
        const QJsonValue ph = p.isUndefined() ? QJsonValue() : p[u"phase"_s];
        if (!T(ph)) {
            open = -1;
            continue;
        }
        if (open >= 0 && phases[open].phase == S(ph)) {
            phases[open].to = t;
        } else {
            phases.append({S(ph), t, t});
            open = int(phases.size()) - 1;
        }
    }
    QJsonArray bands;
    for (const Phase& b : phases) {
        if (b.phase == u"A") continue;
        QJsonObject band{{u"v"_s, true}, {u"from"_s, b.from}, {u"to"_s, b.to}, {u"color"_s, b.phase == u"B" ? u"orange"_s : u"purple"_s}, {u"fill"_s, 0.06}};
        // PHASE_LABEL 里没有的阶段:label 是 undefined,JSON 里不出现
        if (b.phase == u"B" || b.phase == u"C") band.insert(u"label"_s, phaseLabel(b.phase));
        bands.append(band);
    }
    static const std::map<QString, std::pair<QString, QString>> exitStyle{{u"tp1"_s, {u"up"_s, u"第一档"_s}}, {u"tp2"_s, {u"up"_s, u"第二档"_s}},
                                                                         {u"trail_arm"_s, {u"orange"_s, u"回撤追踪激活"_s}}, {u"stop"_s, {u"down"_s, u"止损"_s}}};
    QJsonArray hlines;
    for (const QJsonValue& l : arr(plan[u"levels"_s])) {
        const auto it = exitStyle.find(S(l[u"kind"_s]));
        if (it == exitStyle.end() || !has(l[u"price"_s])) continue;
        hlines.append(QJsonObject{{u"price"_s, l[u"price"_s]}, {u"color"_s, it->second.first}, {u"dash"_s, S(l[u"kind"_s]) == u"trail_arm" ? QJsonArray{2, 2} : QJsonArray{5, 3}},
                                  {u"alpha"_s, 0.8}, {u"label"_s, it->second.second}});
    }
    QJsonArray model, trail;
    for (const QJsonValue& p : path) {
        if (S(p[u"source"_s]) == u"model") model.append(QJsonObject{{u"time"_s, p[u"time"_s]}, {u"value"_s, p[u"price"_s]}});
        if (has(p[u"trail_stop"_s])) trail.append(QJsonObject{{u"time"_s, p[u"time"_s]}, {u"value"_s, p[u"trail_stop"_s]}});
    }
    const QJsonArray lines{QJsonObject{{u"points"_s, model}, {u"color"_s, u"label"_s}, {u"alpha"_s, 0.55}, {u"dash"_s, QJsonArray{3, 2}}, {u"label"_s, u"模型价"_s}},
                           QJsonObject{{u"points"_s, trail}, {u"color"_s, u"orange"_s}, {u"alpha"_s, 0.85}, {u"dash"_s, QJsonArray{4, 2}}, {u"step"_s, true}, {u"label"_s, u"回撤触发价"_s}}};
    static const std::map<QString, std::pair<QString, QString>> mark{{u"entry"_s, {u"blue"_s, u"开仓"_s}}, {u"exit"_s, {u"purple"_s, u"实际平仓"_s}}};
    QJsonArray markers;
    for (const QJsonValue& m : arr(fs[u"markers"_s])) {
        if (!has(m[u"price"_s])) continue;
        const auto it = mark.find(S(m[u"kind"_s]));
        const auto& st = it == mark.end() ? mark.at(u"entry"_s) : it->second;
        markers.append(QJsonObject{{u"time"_s, m[u"time"_s]}, {u"price"_s, m[u"price"_s]}, {u"shape"_s, u"dot"_s}, {u"color"_s, st.first}, {u"label"_s, u"%1 %2"_s.arg(st.second, S(m[u"price"_s]))}});
    }
    for (const QJsonValue& e : run ? arr(sim[u"events"_s]) : QJsonArray{}) {
        const QString color = S(e[u"source"_s]) == u"settle" ? u"purple"_s : N(e[u"pnl"_s]) >= 0 ? u"up"_s : u"down"_s;
        markers.append(QJsonObject{{u"time"_s, e[u"time"_s]}, {u"price"_s, e[u"price"_s]}, {u"shape"_s, u"tri-down"_s}, {u"color"_s, color},
                                   {u"label"_s, u"策略 %1 张 @ %2"_s.arg(S(e[u"qty"_s]), S(e[u"price"_s]))}});
    }
    const QJsonArray legend{QJsonArray{u"╌"_s, u"up"_s, u"止盈档位"_s}, QJsonArray{u"╌"_s, u"down"_s, u"止损"_s}, QJsonArray{u"╌"_s, u"orange"_s, u"回撤激活 / 触发价"_s},
                            QJsonArray{u"·"_s, u"blue"_s, u"开仓"_s}, QJsonArray{u"·"_s, u"purple"_s, u"实际平仓"_s}, QJsonArray{u"╌"_s, u"label2"_s, u"模型价"_s},
                            QJsonArray{u"▼"_s, u"up"_s, u"策略出手点"_s}};
    return QJsonObject{{u"ariaLabel"_s, u"蝶价走势"_s}, {u"times"_s, QJsonArray::fromStringList(times)}, {u"bars"_s, real}, {u"lines"_s, lines}, {u"hlines"_s, hlines},
                       {u"bands"_s, bands}, {u"markers"_s, markers}, {u"legend"_s, legend}, {u"volume"_s, false}, {u"yMin"_s, 0}, {u"padPct"_s, 0.08}};
}

}  // namespace ibkr::shell::review
