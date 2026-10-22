#include "shell/sectors_rules.h"

#include "shell/alert_rules.h"
#include "shell/jsvalue.h"
#include "shell/order_rules.h"
#include "shell/playbook_format.h"
#include "shell/records_rules.h"
#include "shell/trade_rules.h"

#include <QDateTime>

#include <algorithm>
#include <cmath>

namespace ibkr::shell::sectors {

using namespace Qt::StringLiterals;

namespace {

QString S(const QJsonValue& v) { return jsString(v); }
bool T(const QJsonValue& v) { return jsTruthy(v); }
double N(const QJsonValue& v) { return jsNumber(v); }
bool has(const QJsonValue& v) { return !v.isNull() && !v.isUndefined(); }
QJsonArray arr(const QJsonValue& v) { return v.isArray() ? v.toArray() : QJsonArray{}; }
/// typeof v === 'number' && Number.isFinite(v)
bool finiteNum(const QJsonValue& v) { return v.isDouble() && std::isfinite(v.toDouble()); }
/// a ?? b(null / undefined 才换)
QJsonValue orElse(const QJsonValue& a, const QJsonValue& b) { return has(a) ? a : b; }

const QString kGexAssumption = u"假设做市商多看涨、空看跌"_s;
const QString kGexAssumptionHint =
    u"净 gamma 的正负建立在「做市商持有看涨、卖出看跌」这个假设上:真实持仓没人看得到,假设反过来结论也反过来。它只用来判断波动会被压住还是放大,不判断方向。"_s;

QString pad2(int n) { return QString::number(n).rightJustified(2, u'0'); }

/// fmtSigned(v, 2):+1.23% / -0.40% / 0.00%
QString fmtSigned(double v) { return (v > 0 ? u"+"_s : QString()) + jsToFixed(v, 2) + u"%"_s; }

/// lastEvent:at 最大的那一条(相同取后面的)
QJsonValue lastEvent(const QJsonValue& stock) {
    QJsonValue best(QJsonValue::Undefined);
    for (const QJsonValue& e : arr(stock[u"events"_s])) {
        const double a = std::isfinite(N(e[u"at"_s])) ? N(e[u"at"_s]) : 0;
        const double b = best.isUndefined() ? 0 : (std::isfinite(N(best[u"at"_s])) ? N(best[u"at"_s]) : 0);
        if (best.isUndefined() || a >= b) best = e;
    }
    return best;
}

QString shortTitle(const QJsonValue& e, const QString& symbol) {
    const QString t = S(e[u"title"_s]);
    return t.startsWith(symbol + u' ') ? t.mid(symbol.size() + 1) : t;
}

QJsonObject findBy(const QJsonValue& list, const QString& key, const QString& value) {
    for (const QJsonValue& v : arr(list))
        if (v[key].toString() == value) return v.toObject();
    return {};
}

/// DeltaBar(value, scale 5):以 0 为中心、±5% 封顶;{ dir: up / down / "", pct: 半边的百分比 }
QJsonObject deltaBar(double value) {
    const double frac = std::max(-1.0, std::min(1.0, value / 5));
    const double half = std::abs(frac) * 50;
    return {{u"dir"_s, half > 0 ? (frac > 0 ? u"up"_s : u"down"_s) : QString()}, {u"pct"_s, half}};
}

// ---- 心跳一行 -----------------------------------------------------------------------------------
// { hint } 或 { items: [{ text, badge?, warn?, link? }] }
QJsonObject monitorLine(const PageInput& in, const QJsonObject& q) {
    const QString error = q.value("error"_L1).toString();
    const double loadedAt = N(q.value("loadedAt"_L1));
    const double now = in.nowMs;
    if (!error.isEmpty()) {
        QJsonArray items{QJsonObject{{u"badge"_s, u"error"_s}, {u"text"_s, u"读不到异动监控:"_s + error}},
                         QJsonObject{{u"warn"_s, true},
                                     {u"text"_s, loadedAt > 0 ? u"已经 %1 秒没读到引擎的回执,期间报没报过异动都不知道"_s.arg(jsNumberToString(jsRound((now - loadedAt) / 1000)))
                                                             : u"一次都没读到过"_s}}};
        if (loadedAt > 0) items.append(QJsonObject{{u"text"_s, u"上次读到 "_s + fmtWhen(loadedAt, now, in.zone)}});
        return {{u"items"_s, items}};
    }
    const QJsonValue mv = q.value("monitor"_L1);
    if (!T(mv)) return {{u"hint"_s, u"异动监控:等第一轮结果…"_s}};
    const QJsonObject m = mv.toObject();
    const bool connected = T(m.value("connected"_L1));
    int enabledCount = 0;
    for (const QJsonValue& s : arr(q.value("stocks"_L1)))
        if (T(s[u"enabled"_s])) ++enabledCount;
    const auto lastMs = toMs(m.value("last_at"_L1), in.zone);
    const double interval = std::max(1000.0, std::isfinite(N(m.value("interval_ms"_L1))) && N(m.value("interval_ms"_L1)) ? N(m.value("interval_ms"_L1)) : 5000);
    const std::optional<double> age = lastMs ? std::optional<double>(now - *lastMs) : std::nullopt;
    const bool running = T(m.value("running"_L1));
    const bool stale = running && age && *age > std::max(interval * 4, 20000.0);
    const double seconds = jsRound(interval / 100) / 10;
    QString dot = u"default"_s, text, extra;
    const QString note = T(m.value("note"_L1)) ? S(m.value("note"_L1)) : QString();
    if (!connected) {
        text = !note.isEmpty() ? note : u"未连接券商"_s;
        extra = u"连接 %1 之后才开始检测"_s.arg(trade::gatewayName(in.status));
    } else if (!T(m.value("supported"_L1))) {
        dot = u"warning"_s;
        text = !note.isEmpty() ? note : u"当前券商暂不支持异动监控"_s;
    } else if (!running) {
        dot = u"error"_s;
        text = u"异动监控没在跑:放量、急涨急跌都不会再报"_s;
    } else if (T(m.value("last_error"_L1))) {
        dot = u"error"_s;
        text = u"这一轮没做成:"_s + S(m.value("last_error"_L1));
    } else if (stale) {
        dot = u"error"_s;
        text = u"异动监控已经 %1 秒没跳了"_s.arg(jsNumberToString(jsRound(age.value_or(0) / 1000)));
    } else if (!enabledCount) {
        text = u"没有开着「异动」的股:把池子里哪只的「异动」拨开就开始检测"_s;
    } else if (m.value("session"_L1) == u"rth"_s) {
        dot = u"success"_s;
        text = u"监控中 · 每 %1 秒一轮"_s.arg(jsNumberToString(seconds));
        extra = note;
    } else {
        dot = u"warning"_s;
        text = !note.isEmpty() ? note : u"非交易时段:开盘后开始检测"_s;
    }
    QJsonArray items{QJsonObject{{u"badge"_s, dot}, {u"text"_s, text}}};
    if (!extra.isEmpty()) items.append(QJsonObject{{u"text"_s, extra}, {u"warn"_s, dot == u"success"}});
    if (lastMs && connected) items.append(QJsonObject{{u"text"_s, u"上次 "_s + fmtWhen(*lastMs, now, in.zone)}});
    if (has(m.value("last_ms"_L1)) && connected && running) items.append(QJsonObject{{u"text"_s, u"用时 %1 ms"_s.arg(S(m.value("last_ms"_L1)))}});
    if (!connected) items.append(QJsonObject{{u"text"_s, u"去「接入」连接"_s}, {u"link"_s, in.status.value("broker_provider"_L1) == u"futu"_s ? u"futu"_s : u"tws"_s}});
    return {{u"items"_s, items}};
}

// ---- 价位条 ------------------------------------------------------------------------------------
QJsonObject levelsModel(const PageInput& in, const QJsonObject& watch, const QJsonObject& quality, const QJsonValue& spot, bool computing) {
    const QJsonArray levels = arr(watch.value("levels"_L1));
    const QString status = S(quality.value("levels_status"_L1));
    QString err;
    const QString st = has(quality.value("levels_status"_L1)) ? status : QString();
    if (st.startsWith(u"error:"_s)) {
        err = jsTrim(st.mid(6));
        if (err.isEmpty()) err = u"没说原因"_s;
    }
    const QString recalc = computing ? u"计算中…"_s : u"重算墙"_s;
    if (levels.isEmpty()) {
        QJsonObject pending{{u"kind"_s, u"pending"_s}, {u"computing"_s, computing}, {u"id"_s, watch.value("id"_L1)}};
        if (computing) pending[u"text"_s] = u"正在算价位…"_s;
        else if (!err.isEmpty()) pending[u"warn"_s] = u"价位没算出来:%1(过一会儿自动重试)"_s.arg(err);
        else {
            pending[u"text"_s] = u"正在算价位…"_s;
            pending[u"tip"_s] = u"引擎在异动那条 5 秒循环里捎带算价位,每轮最多一只(期权链请求很贵),连着券商、在开盘前后的时段内才做"_s;
        }
        return pending;
    }
    const QJsonObject touch = in.alerts.value("touchConfig"_L1).toObject();
    QJsonArray meta;
    const double step = N(watch.value("step"_L1));
    meta.append(QJsonObject{{u"step"_s, true}, {u"text"_s, u"整数关口步长"_s}, {u"value"_s, step > 0 ? jsNumberToString(step) : u"自动"_s}, {u"stepValue"_s, step > 0 ? step : 0}});
    if (T(watch.value("expiry"_L1))) meta.append(QJsonObject{{u"text"_s, u"到期 "_s + S(watch.value("expiry"_L1))}});
    const QJsonValue wall = watch.value("wall"_L1);
    if (T(wall)) {
        meta.append(QJsonObject{{u"text"_s, u"%1 · %2"_s.arg(playbook::gexText(wall.toObject()), kGexAssumption)}, {u"title"_s, kGexAssumptionHint}});
        if (T(wall[u"max_pain"_s])) meta.append(QJsonObject{{u"text"_s, u"最大痛点 "_s + S(wall[u"max_pain"_s][u"strike"_s])}});
        if (has(wall[u"pc_ratio_oi"_s])) meta.append(QJsonObject{{u"text"_s, u"P/C "_s + S(wall[u"pc_ratio_oi"_s])}});
        if (wall[u"spot_source"_s] == u"parity"_s)
            meta.append(QJsonObject{{u"text"_s, u"现价由期权链反推"_s},
                                    {u"title"_s, u"券商未提供现价,此处由期权链的看跌看涨平价反推;报价不干净时引擎会拒绝计算,而非给出错价。"_s}});
    }
    if ((T(wall) && has(wall[u"days_to_expiry"_s]) ? N(wall[u"days_to_expiry"_s]) : 99) <= 1) meta.append(QJsonObject{{u"text"_s, u"当天到期:OI 是隔夜存量,以成交墙为准"_s}});
    if (T(touch.value("enabled"_L1))) {
        QList<double> periods;
        for (const QJsonValue& p : arr(touch.value("periods"_L1))) periods << N(p);
        for (const QJsonValue& l : arr(watch.value("touch"_L1)[u"lines"_s])) {
            const QJsonArray eps = arr(l[u"episodes"_s]);
            if (!periods.contains(N(l[u"period"_s])) || eps.size() < 2) continue;
            QStringList spans;
            for (const QJsonValue& e : eps) {
                const QString a = S(e[u"start"_s]), b = S(e[u"end"_s]);
                spans << (a == b ? a.mid(5) : u"%1~%2"_s.arg(a.mid(5), b.mid(5)));
            }
            meta.append(QJsonObject{{u"text"_s, u"MA%1 近 %2 日碰过 %3 次"_s.arg(S(l[u"period"_s]), S(touch.value("window_days"_L1))).arg(eps.size())},
                                    {u"title"_s, u"近 %1 个交易日碰过 %2 日线的几段:%3。连着几天贴着线算一段;碰出第 %4 段时提醒"_s.arg(S(touch.value("window_days"_L1)), S(l[u"period"_s]), spans.join(u"、"_s),
                                                                                                          S(touch.value("min_touches"_L1)))}});
        }
    }
    meta.append(QJsonObject{{u"button"_s, recalc}, {u"loading"_s, computing}});
    return {{u"kind"_s, u"list"_s}, {u"id"_s, watch.value("id"_L1)}, {u"computing"_s, computing}, {u"levels"_s, levels},
            {u"spot"_s, has(watch.value("last_price"_L1)) ? watch.value("last_price"_L1) : spot}, {u"meta"_s, meta},
            {u"error"_s, err.isEmpty() ? QString() : u"上一次重算没成:"_s + err}};
}

// ---- 一行 --------------------------------------------------------------------------------------
QJsonObject rowModel(const PageInput& in, const QString& sectorId, const QJsonObject& stock) {
    const QString symbol = S(stock.value("symbol"_L1));
    const QJsonObject quote = in.quotes.value(symbol).toObject();
    const QJsonObject watch = findBy(in.alerts.value("watches"_L1), u"symbol"_s, symbol);
    const QJsonObject quality = findBy(in.quality.value("stocks"_L1), u"symbol"_s, symbol);
    const QJsonValue config = in.quality.value("config"_L1);
    const bool priceOn = !watch.isEmpty();
    const bool disabledRow = !quality.isEmpty() && !T(quality.value("enabled"_L1));
    const bool anomalyOn = !quality.isEmpty() && T(quality.value("enabled"_L1));
    const QJsonValue metrics = quality.isEmpty() ? QJsonValue(QJsonValue::Null) : orElse(quality.value("metrics"_L1), QJsonValue::Null);
    const QJsonValue last = orElse(T(metrics) ? metrics[u"last"_s] : QJsonValue(), quote.value("last"_L1));
    const QJsonValue changePct = orElse(T(metrics) ? metrics[u"change_pct"_s] : QJsonValue(), quote.value("change_pct"_L1));
    const QJsonValue event = quality.isEmpty() ? QJsonValue(QJsonValue::Undefined) : lastEvent(quality);
    QJsonArray busyIds;
    for (const QJsonValue& id : arr(in.alerts.value("busy"_L1))) busyIds.append(id);
    const bool computing = priceOn && busyIds.contains(watch.value("id"_L1));
    const QString busy = in.busy.value(symbol).toString();
    // 行内只放核心竞争点;公司名进悬停提示
    const QString reason = S(orElse(stock.value("reason"_L1), QJsonValue(u""_s)));
    const QString core = has(stock.value("reason"_L1)) && reason != u"手动添加" ? reason : QString();
    const QString company = T(stock.value("company"_L1)) ? S(stock.value("company"_L1)) : QString();
    QStringList tipParts;
    if (!company.isEmpty()) tipParts << company;
    if (!core.isEmpty()) tipParts << core;
    QJsonObject row{{u"symbol"_s, symbol}, {u"sector"_s, sectorId}, {u"focus"_s, in.focusSymbol == symbol},
                    {u"sub"_s, !core.isEmpty() ? core : company}, {u"subTip"_s, tipParts.join(u'\n')}};
    if (!event.isUndefined()) {
        const QString dir = event[u"direction"_s].toString();
        row[u"dot"_s] = QJsonObject{{u"tone"_s, dir == u"up" ? u"up"_s : dir == u"down" ? u"down"_s : u"info"_s},
                                    {u"tip"_s, u"最近异动:%1 · %2%3"_s.arg(shortTitle(event, symbol), fmtWhen(N(event[u"at"_s]) * 1000, in.nowMs, in.zone),
                                                                       T(event[u"text"_s]) ? u"\n"_s + S(event[u"text"_s]) : QString())}};
    }
    const QString tag = jsTrim(T(stock.value("tag"_L1)) ? S(stock.value("tag"_L1)) : QString());
    row[u"tag"_s] = QJsonObject{{u"text"_s, !tag.isEmpty() ? tag : u"＋标签"_s}, {u"value"_s, tag}, {u"none"_s, tag.isEmpty()},
                                {u"editing"_s, in.editingTag == symbol && (in.editingSector.isEmpty() || in.editingSector == sectorId)},
                                {u"tip"_s, !tag.isEmpty() ? u"业务标签:%1(点击修改)"_s.arg(tag) : u"加一个业务标签(如 芯片 / 数据中心),RS 强度按它汇总"_s}};
    // 现价
    if (finiteNum(last)) row[u"price"_s] = QJsonObject{{u"kind"_s, u"num"_s}, {u"text"_s, fmtPrice(last)}, {u"delayed"_s, T(metrics) && T(metrics[u"delayed"_s])}};
    else if (T(quality.value("quote_error"_L1)) && anomalyOn) row[u"price"_s] = QJsonObject{{u"kind"_s, u"error"_s}, {u"text"_s, u"取不到行情"_s}, {u"tip"_s, S(quality.value("quote_error"_L1))}};
    else row[u"price"_s] = QJsonObject{{u"kind"_s, u"none"_s}, {u"text"_s, u"—"_s}};
    // 涨跌
    if (finiteNum(changePct)) {
        const double c = changePct.toDouble();
        row[u"chg"_s] = QJsonObject{{u"text"_s, fmtSigned(c)}, {u"tone"_s, c > 0 ? u"pos"_s : c < 0 ? u"neg"_s : QString()}, {u"bar"_s, deltaBar(c)}};
    } else {
        row[u"chg"_s] = QJsonValue::Null;
    }
    const QString offTip = u"「异动」没开:引擎没在给这只算量比"_s;
    // 全天量比
    {
        const double thr = T(config) && arr(config[u"rvol_tiers"_s]).size() && has(config[u"rvol_tiers"_s][0]) ? N(config[u"rvol_tiers"_s][0]) : 2;
        const QJsonValue v = T(metrics) ? metrics[u"rvol"_s] : QJsonValue();
        if (!anomalyOn) row[u"rvol"_s] = QJsonObject{{u"kind"_s, u"off"_s}, {u"tip"_s, offTip}};
        else if (!finiteNum(v)) row[u"rvol"_s] = QJsonObject{{u"kind"_s, u"none"_s}};
        else {
            const double x = v.toDouble();
            const double max = std::max(thr * 2, 4.0);
            row[u"rvol"_s] = QJsonObject{{u"kind"_s, u"num"_s}, {u"text"_s, jsToFixed(x, 1) + u"×"_s}, {u"hot"_s, x >= thr},
                                         {u"meter"_s, std::max(0.0, std::min(1.0, x / max)) * 100}, {u"tint"_s, x >= thr ? u"orange"_s : u"gray"_s},
                                         {u"tip"_s, u"当日成交量 ÷ 同时段常态(90 日日均量 × 开盘到此刻的常态成交占比)"_s}};
        }
    }
    // 窗口量比
    {
        const QJsonObject verdict = alerts::burstVerdict(metrics, T(config) && has(config[u"burst_ratio"_s]) ? config[u"burst_ratio"_s] : QJsonValue(4));
        const QString level = verdict.value("level"_L1).toString();
        const QJsonValue W = T(config) && T(config[u"window_min"_s]) ? config[u"window_min"_s] : QJsonValue(5);
        if (!anomalyOn) row[u"burst"_s] = QJsonObject{{u"kind"_s, u"off"_s}, {u"tip"_s, offTip}};
        else if (level == u"none") row[u"burst"_s] = QJsonObject{{u"kind"_s, u"none"_s}};
        else
            row[u"burst"_s] = QJsonObject{{u"kind"_s, u"num"_s}, {u"text"_s, jsToFixed(N(metrics[u"burst"_s]), 1) + u"×"_s}, {u"hot"_s, level == u"hot"},
                                          {u"soft"_s, level == u"muted" || level == u"reference"}, {u"reference"_s, level == u"reference"},
                                          {u"tip"_s, T(verdict.value("note"_L1)) ? S(verdict.value("note"_L1))
                                                                                   : u"近 %1 分钟成交量 ÷ 同时段常态;橙色是引擎这一轮真会报的那种放量"_s.arg(S(W))}};
    }
    row[u"priceOn"_s] = priceOn;
    row[u"anomalyOn"_s] = anomalyOn;
    row[u"disabledRow"_s] = disabledRow;
    row[u"qualityId"_s] = quality.value("id"_L1);
    row[u"priceBusy"_s] = busy == u"price";
    row[u"anomalyBusy"_s] = busy == u"anomaly";
    row[u"priceTip"_s] = u"盯这只的期权墙 / 均线 / 整数关口,穿越时弹窗提醒;开着才会去算价位"_s;
    row[u"anomalyTip"_s] = disabledRow ? u"这只在旧版里被停用过:拨开就重新开始检测"_s : u"盘中每 5 秒检测一轮:放量、急涨急跌、大涨大跌时弹窗提醒"_s;
    row[u"levels"_s] = priceOn ? QJsonValue(levelsModel(in, watch, quality, last, computing)) : QJsonValue(QJsonValue::Null);
    return row;
}

}  // namespace

QString fmtPrice(const QJsonValue& v) {
    if (!finiteNum(v)) return u"—"_s;
    const double x = v.toDouble();
    const int digits = std::abs(x) >= 1 ? 2 : 4;
    // toLocaleString('en-US', { min 2, max digits }):先按最多位数舍入,再把多出来的尾零去到只剩两位
    QString s = jsToFixed(std::abs(x), digits);
    if (digits == 4)
        while (s.endsWith(u'0') && s.size() - s.indexOf(u'.') - 1 > 2) s.chop(1);
    const qsizetype dot = s.indexOf(u'.');
    QString intPart = s.left(dot);
    for (qsizetype i = intPart.size() - 3; i > 0; i -= 3) intPart.insert(i, u',');
    return (x < 0 && s.toDouble() != 0 ? u"-"_s : QString()) + intPart + s.mid(dot);
}

QString fmtWhen(double ms, double nowMs, const QTimeZone& zone) {
    if (!std::isfinite(ms) || ms <= 0) return u"—"_s;
    const QDateTime d = QDateTime::fromMSecsSinceEpoch(qint64(ms), zone);
    const QDateTime now = QDateTime::fromMSecsSinceEpoch(qint64(nowMs), zone);
    if (d.date() == now.date()) return u"%1:%2:%3"_s.arg(pad2(d.time().hour()), pad2(d.time().minute()), pad2(d.time().second()));
    return u"%1-%2 %3:%4"_s.arg(pad2(d.date().month()), pad2(d.date().day()), pad2(d.time().hour()), pad2(d.time().minute()));
}

std::optional<double> toMs(const QJsonValue& v, const QTimeZone& zone) {
    if (!has(v) || v == QJsonValue(u""_s)) return std::nullopt;
    if (v.isDouble()) return v.toDouble() > 1e12 ? v.toDouble() : v.toDouble() * 1000;
    const double t = jsDateParse(S(v), zone);
    if (std::isnan(t)) return std::nullopt;
    return t;
}

// { monitor, sectors: [{ id, name, title, count, pickLabel, picking, empty, rows, meta }] , empty, windowMin,
//   anomalyFeed: [{ at, text }], priceFeed, priceSub, popupOn, soundOn,
//   conditions: null | { rvol, burst, window, spike, day, cooldown, marketAdjust, marketWarn, labels... }, crossConfirm, touch: null | {...} }
QJsonObject pageModel(const PageInput& in) {
    QJsonObject page;
    page[u"monitor"_s] = monitorLine(in, in.quality);
    const QJsonValue config = in.quality.value("config"_L1);
    const QJsonValue windowMin = T(config) && T(config[u"window_min"_s]) ? config[u"window_min"_s] : QJsonValue(5);
    page[u"windowMin"_s] = S(windowMin);
    QJsonArray cards;
    for (const QJsonValue& sv : in.sectors) {
        const QJsonObject s = sv.toObject();
        const QString id = S(s.value("id"_L1));
        const QJsonArray stocks = arr(s.value("stocks"_L1));
        const bool picking = in.picking.contains(id);
        QJsonArray rows;
        for (const QJsonValue& st : stocks) rows.append(rowModel(in, id, st.toObject()));
        cards.append(QJsonObject{
            {u"id"_s, id}, {u"name"_s, S(s.value("name"_L1))},
            {u"title"_s, u"%1(%2)"_s.arg(S(s.value("name"_L1))).arg(stocks.size())},
            {u"pickLabel"_s, picking ? u"选股中…"_s : stocks.isEmpty() ? u"AI 选股"_s : u"AI 重新选股"_s}, {u"picking"_s, picking},
            {u"empty"_s, stocks.isEmpty()}, {u"rows"_s, rows},
            {u"meta"_s, QJsonObject{{u"text"_s, u"更新于 %1 · AI 结果仅供参考"_s.arg(orders::fmtTimeShort(s.value("updated_at"_L1), in.nowMs, in.zone))},
                                    {u"title"_s, records::fmtTime(s.value("updated_at"_L1), in.zone)}}},
        });
    }
    page[u"sectors"_s] = cards;
    // 最近异动(异动的事件时间是秒)
    QJsonArray anomaly;
    const QJsonArray qfeed = arr(in.quality.value("feed"_L1));
    for (qsizetype i = 0; i < std::min<qsizetype>(30, qfeed.size()); ++i)
        anomaly.append(QJsonObject{{u"at"_s, fmtWhen(N(qfeed[i][u"at"_s]) * 1000, in.nowMs, in.zone)}, {u"text"_s, u"%1 · %2"_s.arg(S(qfeed[i][u"title"_s]), S(qfeed[i][u"text"_s]))}});
    page[u"anomalyFeed"_s] = anomaly;
    // 最近价位触发:有流水用流水,没有就把各盯单落库的事件拼起来
    const QJsonArray watches = arr(in.alerts.value("watches"_L1));
    QJsonArray history = arr(in.alerts.value("feed"_L1));
    if (history.isEmpty())
        for (const QJsonValue& w : watches)
            for (const QJsonValue& e : arr(w[u"events"_s])) {
                QJsonObject x = e.toObject();
                x[u"symbol"_s] = w[u"symbol"_s];
                history.append(x);
            }
    QJsonArray price;
    for (qsizetype i = 0; i < std::min<qsizetype>(30, history.size()); ++i) {
        const QJsonValue e = history[i];
        price.append(QJsonObject{{u"at"_s, T(e[u"at"_s]) ? fmtWhen(N(e[u"at"_s]) * 1000, in.nowMs, in.zone) : u"—"_s},
                                 {u"text"_s, u"%1 %2"_s.arg(T(e[u"symbol"_s]) ? S(e[u"symbol"_s]) : QString(), T(e[u"text"_s]) ? S(e[u"text"_s]) : QString())}});
    }
    page[u"priceFeed"_s] = price;
    page[u"priceSub"_s] = u"%1 只在盯价位 · %2"_s.arg(watches.size()).arg(S(in.alerts.value("lastCheck"_L1)));
    page[u"popupOn"_s] = in.popupOn;
    page[u"soundOn"_s] = in.soundOn;
    // 触发条件
    if (T(config)) {
        const QJsonValue W = config[u"window_min"_s];
        QStringList rv, ds, df;
        for (const QJsonValue& t : arr(config[u"rvol_tiers"_s])) rv << S(t) + u"×"_s;
        for (const QJsonValue& t : arr(config[u"day_sigma_tiers"_s])) ds << S(t) + u"σ"_s;
        for (const QJsonValue& t : arr(config[u"day_fixed_tiers"_s])) df << S(t) + u"%"_s;
        const QJsonValue monitor = in.quality.value("monitor"_L1);
        const QJsonValue marketRef = T(monitor) && has(monitor[u"market_ref"_s]) ? monitor[u"market_ref"_s] : QJsonValue(QJsonValue::Null);
        page[u"conditions"_s] = QJsonObject{
            {u"rvol"_s, has(config[u"rvol_tiers"_s][0]) ? config[u"rvol_tiers"_s][0] : QJsonValue(2)},
            {u"rvolLabel"_s, u"全天放量:起报倍数"_s},
            {u"rvolSub"_s, u"三档 %1,后两档按 1.5 倍、2.5 倍自动排;每档一天报一次"_s.arg(rv.join(u" / "_s))},
            {u"burst"_s, config[u"burst_ratio"_s]},
            {u"burstLabel"_s, u"%1 分钟放量:倍数"_s.arg(S(W))},
            {u"burstSub"_s, u"近 %1 分钟成交量是同时段常态的几倍就报;回落到一半以下并过了冷却才会再报"_s.arg(S(W))},
            {u"window"_s, W},
            {u"spike"_s, config[u"spike_sigma"_s]},
            {u"spikeLabel"_s, u"%1 分钟急涨急跌:几个 σ"_s.arg(S(W))},
            {u"spikeSub"_s, u"且不低于 %1%;没有历史波动率的股按固定 %2%"_s.arg(S(config[u"spike_min_pct"_s]), S(config[u"spike_fixed_pct"_s]))},
            {u"day"_s, has(config[u"day_sigma_tiers"_s][0]) ? config[u"day_sigma_tiers"_s][0] : QJsonValue(2)},
            {u"daySub"_s, u"三档 %1(日 σ),后两档 +1σ、+2σ;没有历史波动率时按 %2"_s.arg(ds.join(u" / "_s), df.join(u" / "_s))},
            {u"cooldown"_s, config[u"cooldown_min"_s]},
            {u"marketAdjust"_s, T(config[u"market_adjust"_s])},
            {u"marketWarn"_s, T(config[u"market_adjust"_s]) && marketRef == QJsonValue(false)},
        };
    } else {
        page[u"conditions"_s] = QJsonValue::Null;
    }
    page[u"crossConfirm"_s] = in.alerts.value("crossConfirm"_L1) == u"bar_close"_s;
    const QJsonValue touch = in.alerts.value("touchConfig"_L1);
    if (T(touch)) {
        const double n = N(touch[u"window_days"_s]);
        QJsonArray periods;
        static const QList<int> known{5, 10, 20, 30, 50, 60, 120, 200, 250};
        for (const QJsonValue& p : arr(touch[u"periods"_s])) periods.append(known.contains(int(N(p))) && N(p) == std::floor(N(p)) ? S(p) + u" 日"_s : S(p));
        page[u"touch"_s] = QJsonObject{
            {u"enabled"_s, T(touch[u"enabled"_s])}, {u"periods"_s, periods}, {u"periodValues"_s, touch[u"periods"_s]},
            {u"window"_s, touch[u"window_days"_s]}, {u"minTouches"_s, touch[u"min_touches"_s]}, {u"band"_s, touch[u"band_pct"_s]}, {u"most"_s, std::ceil(n / 2)},
            {u"touchesSub"_s, u"%1 个交易日里第 %2 段触碰时报;再碰出新的一段会再报一次"_s.arg(S(touch[u"window_days"_s]), S(touch[u"min_touches"_s]))},
            {u"hint"_s, u"连着几天贴着线走只算一次;两段之间至少隔一天没碰,所以 %1 个交易日里最多分出 %2 段。改完自动保存,各股的底账在接下来几分钟里按新口径重算。"_s.arg(
                            S(touch[u"window_days"_s]), jsNumberToString(std::ceil(n / 2)))},
        };
    } else {
        page[u"touch"_s] = QJsonValue::Null;
    }
    return page;
}

namespace {

void feedTexts(QStringList& t, const QJsonValue& items, const QString& empty) {
    const QJsonArray a = items.toArray();
    if (a.isEmpty()) t << empty;
    for (const QJsonValue& i : a) t << i[u"at"_s].toString() << i[u"text"_s].toString();
}

}  // namespace

QStringList pageTexts(const QJsonObject& page) {
    QStringList t{u"板块"_s, u"刷新行情"_s, u"新建板块"_s, u"池子、两个开关、扫描的关系"_s};
    const QJsonObject mon = page[u"monitor"_s].toObject();
    if (mon.contains(u"hint"_s)) t << mon[u"hint"_s].toString();
    for (const QJsonValue& i : mon[u"items"_s].toArray()) t << i[u"text"_s].toString();
    const QJsonArray sectors = page[u"sectors"_s].toArray();
    if (sectors.isEmpty()) t << u"还没有板块。输入一个主题试试,比如「AI 算力」。"_s;
    for (const QJsonValue& s : sectors) {
        t << s[u"title"_s].toString() << s[u"pickLabel"_s].toString() << u"删除"_s;
        if (s[u"empty"_s].toBool()) {
            t << u"还没有成分股:点「AI 选股」生成,或在下面手动添加。加进来的股默认盯价位、盯异动。"_s;
        } else {
            t << u"现价"_s << u"涨跌"_s << u"量比"_s << page[u"windowMin"_s].toString() + u"分钟"_s << u"价位"_s << u"异动"_s;
            for (const QJsonValue& r : s[u"rows"_s].toArray()) {
                t << r[u"symbol"_s].toString();
                if (!r[u"sub"_s].toString().isEmpty()) t << r[u"sub"_s].toString();
                if (!r[u"tag"_s][u"editing"_s].toBool()) t << r[u"tag"_s][u"text"_s].toString();
                const QJsonObject price = r[u"price"_s].toObject();
                if (price[u"delayed"_s].toBool()) t << u"延迟"_s;
                t << price[u"text"_s].toString();
                t << (r[u"chg"_s].isObject() ? r[u"chg"_s][u"text"_s].toString() : u"—"_s);
                for (const QString& key : {u"rvol"_s, u"burst"_s}) {
                    const QJsonObject c = r[key].toObject();
                    t << (c[u"kind"_s] == u"num"_s ? c[u"text"_s].toString() : u"—"_s);
                    if (c[u"reference"_s].toBool()) t << u"参考"_s;
                }
                t << u"移除"_s;
                if (r[u"levels"_s].isObject()) {
                    const QJsonObject lv = r[u"levels"_s].toObject();
                    if (lv[u"kind"_s] == u"pending"_s) {
                        t << (lv.contains(u"warn"_s) ? lv[u"warn"_s].toString() : lv[u"text"_s].toString()) << u"立刻算"_s;
                    } else {
                        for (const QJsonValue& m : lv[u"meta"_s].toArray()) {
                            if (m[u"step"_s].toBool()) t << m[u"text"_s].toString() << m[u"value"_s].toString();
                            else if (m.toObject().contains(u"button"_s)) t << m[u"button"_s].toString();
                            else t << m[u"text"_s].toString();
                        }
                        if (!lv[u"error"_s].toString().isEmpty()) t << lv[u"error"_s].toString();
                    }
                }
            }
            t << s[u"meta"_s][u"text"_s].toString();
        }
        t << u"添加"_s;
    }
    t << u"最近异动"_s << QString::number(page[u"anomalyFeed"_s].toArray().size());
    feedTexts(t, page[u"anomalyFeed"_s], u"还没有异动。盘中放量、急涨急跌时会出现在这里,同时弹窗提醒。"_s);
    t << u"最近价位触发"_s << QString::number(page[u"priceFeed"_s].toArray().size()) << page[u"priceSub"_s].toString() << u"价位从哪来、什么时候报"_s;
    feedTexts(t, page[u"priceFeed"_s], u"还没有价位触发记录。"_s);
    t << u"提醒方式"_s << u"弹窗提醒"_s << u"屏幕右上角的置顶小窗,不抢键盘焦点;关掉则退回系统通知"_s << u"试弹"_s << u"提示音"_s
      << u"急涨 / 上穿升调,急跌 / 下破降调,放量与反复碰均线是同一个音响两下"_s << u"试听"_s << u"价位提醒与异动提醒共用这两个开关。"_s;
    t << u"触发条件"_s;
    if (!page[u"conditions"_s].isObject()) {
        t << u"阈值还没读到。"_s;
    } else {
        const QJsonObject c = page[u"conditions"_s].toObject();
        t << c[u"rvolLabel"_s].toString() << c[u"rvolSub"_s].toString() << c[u"burstLabel"_s].toString() << c[u"burstSub"_s].toString()
          << u"短时窗口"_s << u"放量与急涨急跌看的是最近多久"_s << u"3 分钟"_s << u"5 分钟"_s << u"10 分钟"_s
          << c[u"spikeLabel"_s].toString() << c[u"spikeSub"_s].toString() << u"大涨大跌:起报 σ"_s << c[u"daySub"_s].toString()
          << u"冷却(分钟)"_s << u"短时放量 / 急涨急跌报过之后,至少隔这么久才会再报同一类"_s << u"急涨急跌、大涨大跌:扣掉大盘同期涨跌"_s
          << u"开:只报扣掉标普 500 同期涨跌之后还够档的(直接相减,不按每只股的 beta);跟着指数走的 ETF 会因此不报。关:照自己的涨跌报,提醒里注明标普同期"_s;
        if (c[u"marketWarn"_s].toBool())
            t << u"· 这一轮读不到标普 500 指数的行情(没有权限、今天还没开始跳、或者停更了):没有在扣,提醒里会写「无大盘参照、未扣」"_s;
        t << u"改完自动保存,下一轮(5 秒内)生效;今天已经报过的档不会重报。"_s;
    }
    t << u"价位穿越"_s << u"穿越要等 1 分钟收盘确认"_s << u"关:两次取价(10 秒一次)之间跨过价位就报。开:跨过的那一分钟收完,最后一笔价还在价位另一侧才报"_s
      << u"开着时提醒会晚几十秒(等那一分钟走完),换来的是不报收回去的假突破。反复碰均线不受这个开关影响。"_s;
    t << u"反复碰均线"_s;
    if (!page[u"touch"_s].isObject()) {
        t << u"设置还没读到。"_s;
    } else {
        const QJsonObject c = page[u"touch"_s].toObject();
        t << u"短期内反复碰同一条均线时提醒"_s << u"只在常规时段判;同一段触碰只报一次,和同一条均线的穿越并成一条"_s << u"看哪几条日均线"_s
          << u"最多 6 条;价位条上画的是 20 / 60 / 120 / 200"_s;
        for (const QJsonValue& p : c[u"periods"_s].toArray()) t << p.toString();
        t << u"「短期内」:最近几个交易日"_s << u"含今天"_s << u"第几次碰到开始报"_s << c[u"touchesSub"_s].toString() << u"离均线多近算碰到(%)"_s
          << u"那天的最高 / 最低价进到均线上下这个范围以内;盘中看现价,两轮之间跨过去也算"_s << c[u"hint"_s].toString();
    }
    return t;
}

}  // namespace ibkr::shell::sectors
