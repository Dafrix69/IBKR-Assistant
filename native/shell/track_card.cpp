#include "shell/track_card.h"

#include "shell/jsvalue.h"
#include "shell/playbook_format.h"
#include "shell/track_levels.h"
#include "shell/track_rules.h"

#include <algorithm>
#include <cmath>

using namespace Qt::StringLiterals;

namespace ibkr::shell::track {

namespace {

bool nullish(const QJsonValue& v) { return v.isNull() || v.isUndefined(); }
std::optional<double> num(const QJsonValue& v) {
    if (v.isDouble()) return v.toDouble();
    return std::nullopt;
}
/// 价位那一块的 num:有限、大于 0 的数
std::optional<double> pos(const QJsonValue& v) {
    if (v.isDouble() && std::isfinite(v.toDouble()) && v.toDouble() > 0) return v.toDouble();
    return std::nullopt;
}
QJsonObject item(const QString& text, const QString& cls = QString()) { return {{u"text"_s, text}, {u"cls"_s, cls}}; }

/// 一条"离触发还有多远"的量表(Gauge)。没有现价就不画——画一条假的比不画更坏
QJsonValue gauge(const QJsonObject& live, const QJsonObject& targets, const QString& symbol) {
    const QJsonValue spotStopValue = live.value("spot_stop"_L1);
    // 标的止损看的是标的现价,和这份持仓有没有报价无关:持仓没价的那一轮也照样摆出来
    const QJsonValue spotStop = jsTruthy(spotStopValue) ? QJsonValue(spotStopLine(symbol, spotStopValue.toObject())) : QJsonValue();
    const auto price = num(live.value("price"_L1));
    if (!price) return QJsonObject{{u"noPrice"_s, u"拿不到现价,本轮不判断"_s}, {u"spotStop"_s, spotStop}};
    struct Row {
        QString label;
        double target;
        QString note;
        QString tone;
    };
    QList<Row> rows;
    QStringList pending;
    const bool hasTrail = jsTruthy(targets.value("profit_drawdown_tiers"_L1)) || !nullish(targets.value("profit_drawdown_pct"_L1));
    if (const auto stop = num(live.value("profit_trail_stop"_L1)); !nullish(live.value("profit_trail_stop"_L1)) && stop) {
        const QJsonValue pct = live.value("profit_drawdown_threshold"_L1);
        const QJsonValue peak = live.value("profit_peak"_L1);
        rows.append({nullish(pct) ? u"利润回撤"_s : u"利润回撤 %1%"_s.arg(fmtNum(pct)), *stop, nullish(peak) ? QString() : u"峰值利润 "_s + fmtMoney(peak), u"warn"_s});
    } else if (hasTrail) {
        // 设了回撤、但峰值利润还没越过成本:回撤无从谈起,不是"没设"
        const QJsonValue peak = live.value("profit_peak"_L1);
        const QJsonValue arm = targets.value("profit_drawdown_arm"_L1);
        if (!nullish(peak) && peak.toDouble() <= 0) {
            pending << u"利润回撤已设,但这笔从建仓起还没盈利过(峰值利润 %1)——先转正才会开始算回撤,在那之前只有止损能保护它。"_s.arg(fmtMoney(peak));
        } else if (!nullish(peak) && !nullish(arm)) {
            const double a = arm.toDouble();
            const QJsonValue cost = live.value("cost_basis"_L1);
            const QString reach = !nullish(cost) ? u"%1(成本的 %2%)"_s.arg(fmtMoney(a * std::fabs(cost.toDouble())), fmtNum(a * 100)) : u"成本的 %1%"_s.arg(fmtNum(a * 100));
            // 起算门槛(蝶式预设的激活线,或自己填的):浮盈只有几毛时,晃一下就是 40% 的回撤,先不追
            pending << u"利润回撤未激活:峰值利润 %1,浮盈到过 %2 才开始追回撤;在那之前只有止损能保护它。"_s.arg(fmtMoney(peak), reach);
        } else {
            pending << u"利润回撤已设,等第一次盈利后开始记峰值。"_s;
        }
    }
    const QJsonObject st = live.value("spot_target"_L1).toObject();
    if (jsTruthy(st.value("held"_L1))) {
        pending << (jsTruthy(st.value("reason"_L1)) ? jsString(st.value("reason"_L1)) : u"还没拿到市场报价,先不挂单。"_s);
    } else if (!nullish(st.value("price"_L1))) {
        // 目标价每轮重算,所以这一行的 target 也每轮变;标签里带上标的位置
        rows.append({u"标的到 "_s + fmtNum(st.value("spot_target"_L1)), st.value("price"_L1).toDouble(),
                     nullish(st.value("pnl"_L1)) ? QString() : u"预估收益 "_s + fmtMoney(st.value("pnl"_L1)), u"ok"_s});
    } else if (!nullish(targets.value("spot_target"_L1))) {
        pending << (jsTruthy(st.value("reason"_L1)) ? jsString(st.value("reason"_L1))
                                                     : u"标的目标价 %1 已设,但这一轮算不出对应的价位。"_s.arg(fmtNum(targets.value("spot_target"_L1))));
    }
    if (!nullish(targets.value("take_profit"_L1)) && nullish(targets.value("spot_target"_L1)))
        rows.append({u"止盈"_s, targets.value("take_profit"_L1).toDouble(), QString(), u"ok"_s});
    if (!nullish(live.value("stop_effective"_L1))) {
        const QJsonValue trail = live.value("trail_stop"_L1);
        const double eff = live.value("stop_effective"_L1).toDouble();
        rows.append({!nullish(trail) && trail.toDouble() == eff ? u"跟踪止损"_s : u"止损"_s, eff, QString(), u"bad"_s});
    }
    if (rows.isEmpty() && pending.isEmpty() && !spotStop.isString()) return QJsonObject{{u"empty"_s, u"没设任何触发条件,只是挂着看"_s}};
    QJsonArray rings;
    for (const Row& r : rows) {
        const double gap = r.target - *price;
        const double pct = *price ? std::fabs(gap / *price) * 100 : 0;
        // 距离越近环越满:20% 以外就算"还远",满环 = 已经贴着触发价
        const double closeness = std::max(0.02, std::min(1.0, 1 - std::min(pct, 20.0) / 20));
        rings.append(QJsonObject{
            {u"label"_s, r.label},
            {u"value"_s, fmtMoney(r.target)},
            {u"gap"_s, u"还差 %1%2%3"_s.arg(gap >= 0 ? u"+"_s : QString(), fmtNum(gap, 4), r.note.isEmpty() ? QString() : u" · "_s + r.note)},
            {u"pct"_s, fmtNum(pct, 1)},
            {u"closeness"_s, closeness},
            {u"tint"_s, r.tone == u"ok" ? u"green"_s : r.tone == u"warn" ? u"orange"_s : u"red"_s},
        });
    }
    return QJsonObject{{u"lines"_s, QJsonArray::fromStringList(pending)}, {u"spotStop"_s, spotStop}, {u"rings"_s, rings}};
}

/// 关键价位那一块(TrackLevelsPanel)
QJsonObject levelsPanel(const CardInput& in) {
    const QJsonObject& t = in.track;
    const QString symbol = t.value("symbol"_L1).toString();
    QJsonObject watch;
    for (const QJsonValue& w : in.watches)
        if (w[u"symbol"].toString() == symbol.toUpper()) {
            watch = w.toObject();
            break;
        }
    const bool computing = !watch.isEmpty() && in.busy.contains(watch.value("id"_L1).toString());
    const QJsonArray levelList = watch.value("levels"_L1).toArray();
    if (watch.isEmpty())
        return {{u"pending"_s, QJsonObject{{u"text"_s, symbol + u" 还没在盯价位(期权墙、均线、整数关口)。"_s}, {u"button"_s, u"算关键价位"_s}, {u"create"_s, true}}}};
    if (levelList.isEmpty())
        return {{u"pending"_s, QJsonObject{{u"text"_s, computing ? u"正在算关键价位…"_s : symbol + u" 的关键价位还没算出来"_s}, {u"button"_s, u"立刻算"_s},
                                            {u"watchId"_s, watch.value("id"_L1)}, {u"computing"_s, computing}}}};
    const QJsonObject& live = in.live;
    std::optional<double> spot;
    if (t.value("sec_type"_L1) == u"STK"_s) spot = pos(live.value("price"_L1));
    else {
        spot = pos(live.value("spot_stop"_L1).toObject().value("spot"_L1));
        if (!spot) spot = pos(live.value("spot_target"_L1).toObject().value("spot"_L1));
    }
    if (!spot) spot = pos(watch.value("last_price"_L1));
    const QJsonArray own = levels::ownLines(t.value("sec_type"_L1).toString(), t.value("targets"_L1).toObject(), live);
    QStringList notes;
    if (spot)
        for (const QJsonValue& line : own)
            if (const auto n = levels::lineContext(line.toObject(), levelList, *spot, levels::sourceShort())) notes << *n;
    const QJsonObject wall = watch.value("wall"_L1).toObject();
    QJsonArray meta;
    if (!wall.isEmpty()) meta.append(item(playbook::gexText(wall), u"gex"_s));
    const QJsonValue maxPain = wall.value("max_pain"_L1);
    if (jsTruthy(maxPain)) meta.append(item(u"最大痛点 "_s + jsString(maxPain[u"strike"])));
    if (jsTruthy(watch.value("expiry"_L1))) meta.append(item(u"墙按 %1 到期"_s.arg(jsString(watch.value("expiry"_L1)))));
    const QJsonValue dte = wall.value("days_to_expiry"_L1);
    if ((nullish(dte) ? 99 : dte.toDouble()) <= 1) meta.append(item(u"当天到期:以成交墙为准"_s));
    meta.append(item(u"穿越时弹窗(和板块页的价位提醒同一套)"_s, u"muted"_s));
    QJsonArray stripLevels = levelList;
    for (const QJsonValue& o : own) stripLevels.append(o);
    return {
        {u"summary"_s, spot ? QJsonValue(levels::levelSummary(levelList, *spot, levels::sourceShort())) : QJsonValue()},
        {u"notes"_s, QJsonArray::fromStringList(notes)},
        {u"meta"_s, meta},
        {u"button"_s, computing ? u"计算中…"_s : u"重算墙"_s},
        {u"strip"_s, QJsonObject{{u"levels"_s, stripLevels}, {u"spot"_s, spot ? QJsonValue(*spot) : QJsonValue()}}},
        {u"watchId"_s, watch.value("id"_L1)},
        {u"computing"_s, computing},
    };
}

}  // namespace

QJsonObject trackCardModel(const CardInput& in) {
    const QJsonObject& t = in.track;
    const QJsonObject& live = in.live;
    const QString symbol = t.value("symbol"_L1).toString();
    const bool fired = jsTruthy(t.value("fired_at"_L1));
    const QString firedState = jsTruthy(t.value("fired_state"_L1)) ? jsString(t.value("fired_state"_L1)) : QString();
    const bool sweeping = firedState.startsWith(u"sweep:"_s);
    const bool enabled = jsTruthy(t.value("enabled"_L1));
    // 止盈绿、止损类红;人点的「立即平仓」不分好坏,用中性色
    const QString firedTone = firedState == u"take_profit" ? u"ok"_s : firedState == u"manual" || firedState == u"time_exit" ? u"info"_s : u"bad"_s;
    const QString firedTint = firedState == u"take_profit" ? u"green"_s : firedState == u"manual" || firedState == u"time_exit" ? u"gray"_s : u"red"_s;
    const QString tone = sweeping ? u"warn"_s : fired ? firedTone : enabled ? u"info"_s : u"warn"_s;
    const QJsonObject targets = t.value("targets"_L1).toObject();
    const QJsonObject autoClose = t.value("auto_close"_L1).toObject();
    const bool ddTiers = jsTruthy(targets.value("profit_drawdown_tiers"_L1));
    const QJsonValue frac = autoClose.value("close_fraction_pct"_L1);
    const QJsonValue now = live.value("profit_drawdown_threshold"_L1);
    const auto& labels = trackStateLabel();
    const QString pillText = fired ? labels.value(firedState, u"已触发"_s)
                             : enabled ? labels.value(jsTruthy(live.value("state"_L1)) ? jsString(live.value("state"_L1)) : QString(), u"持有中"_s)
                                       : u"已暂停"_s;
    const QString pillTint = sweeping ? u"orange"_s : fired ? firedTint : enabled ? u"blue"_s : u"gray"_s;

    QJsonArray meta;
    const auto add = [&meta](const QString& s, const QString& cls = QString()) {
        if (!s.isEmpty()) meta.append(item(s, cls));
    };
    if (jsTruthy(targets.value("take_profit"_L1))) add(u"止盈 "_s + fmtMoney(targets.value("take_profit"_L1)));
    if (jsTruthy(targets.value("stop_loss"_L1))) add(u"止损 "_s + fmtMoney(targets.value("stop_loss"_L1)));
    add(spotStopSummary(num(targets.value("spot_stop_below"_L1)), num(targets.value("spot_stop_above"_L1))));
    // 分档时阈值每一轮都可能变,显示当前生效的那一档而不是配置里的静态值
    if (jsTruthy(targets.value("profit_drawdown_pct"_L1)) || ddTiers) {
        QString s = ddTiers ? u"利润回撤 分档"_s + (nullish(now) ? QString() : u" · 当前 %1%"_s.arg(jsString(now)))
                                           : u"利润回撤 %1%"_s.arg(jsString(targets.value("profit_drawdown_pct"_L1)));
        if (jsTruthy(frac) && frac.toDouble() < 100) s += u" → 平 %1%"_s.arg(jsString(frac));
        add(s);
    }
    if (ddTiers && !nullish(live.value("profit_peak"_L1))) add(u"峰值利润 "_s + fmtMoney(live.value("profit_peak"_L1)));
    if (jsTruthy(targets.value("trail_pct"_L1)))
        add(u"跟踪 %1%%2"_s.arg(jsString(targets.value("trail_pct"_L1)),
                                jsTruthy(live.value("trail_stop"_L1)) ? u" → "_s + fmtMoney(live.value("trail_stop"_L1)) : QString()));
    if (jsTruthy(t.value("peak"_L1))) add(u"最有利价 "_s + fmtMoney(t.value("peak"_L1)));
    for (const QString& s : exitSummary(targets, autoClose, t.value("sec_type"_L1) == u"STK"_s)) add(s);
    add(jsTruthy(autoClose.value("enabled"_L1)) ? u"自动平仓已开"_s : u"仅提醒"_s, jsTruthy(autoClose.value("enabled"_L1)) ? u"tag live"_s : u"tag paper"_s);

    QJsonArray tiers;
    int i = 0;
    for (const QJsonValue& tier : targets.value("take_profit_tiers"_L1).toArray()) tiers.append(tierLabel(tier.toObject(), i++));

    // 止损按可成交价判的:把这一轮拿来判的那个价摆出来(null = 这一轮拿不到各腿买卖价,止损没判)
    QJsonValue stopBasis;
    if (!fired && autoClose.value("stop_basis"_L1) == u"natural"_s && !live.value("stop_price"_L1).isUndefined()) {
        stopBasis = jsTruthy(live.value("stop_fallback"_L1)) || live.value("stop_price"_L1).isNull()
                        ? u"这一轮拿不到可成交价(腿没有报价,或盘口太宽),止损类退回按中间价判"_s
                        : u"止损按可成交价判:此刻立刻平掉约 "_s + fmtMoney(live.value("stop_price"_L1));
    }

    QJsonValue hostedItems;
    if (jsTruthy(autoClose.value("host_at_broker"_L1))) {
        QJsonArray h{item(u"券商托管"_s, u"tag live"_s)};
        const QJsonArray orders = in.hosted[u"orders"].toArray();
        if (!orders.isEmpty()) {
            for (const QJsonValue& o : orders) h.append(item(o[u"kind"] == u"ptrail"_s ? jsString(o[u"label"]) + u"(秒级调整)"_s : jsString(o[u"label"])));
        } else {
            h.append(item(in.connected ? u"托管单尚未挂出(对账中,或被闸门拦住——看下方提示)"_s : u"连接%1后自动挂出"_s.arg(in.gateway), u"muted"_s));
        }
        if (in.delayed) h.append(item(u"行情可能延迟:动态调整或滞后;触发由券商实时行情决定,不受影响"_s, u"muted"_s));
        hostedItems = h;
    }

    // 盈亏的颜色和符号。0 不着色——把 0 画成绿色会让人以为赚了
    QJsonValue pnl;
    if (!live.value("unrealized_pnl"_L1).isUndefined()) {
        const QJsonValue v = live.value("unrealized_pnl"_L1);
        if (v.isNull()) {
            pnl = QJsonObject{{u"text"_s, u"—"_s}, {u"pct"_s, QJsonValue()}, {u"cls"_s, u"muted"_s}};
        } else {
            const bool up = v.toDouble() > 0;
            const QString sign = up ? u"+"_s : QString();
            const QJsonValue pct = live.value("unrealized_pct"_L1);
            pnl = QJsonObject{{u"text"_s, sign + fmtMoney(v)},
                              {u"pct"_s, nullish(pct) ? QJsonValue() : QJsonValue(u"%1%2%"_s.arg(sign, jsString(pct)))},
                              {u"cls"_s, v.toDouble() == 0 ? u"muted"_s : up ? u"up"_s : u"down"_s}};
        }
    }

    // 价位轨:止损 / 现价 / 止盈落在同一根轴上
    QJsonValue rail;
    if (!fired && !nullish(live.value("price"_L1))) {
        const QJsonValue eff = live.value("stop_effective"_L1);
        const QJsonValue trail = live.value("trail_stop"_L1);
        const QJsonObject st = live.value("spot_target"_L1).toObject();
        const QJsonValue stopPrice = nullish(eff) ? targets.value("stop_loss"_L1) : eff;
        QJsonValue tp;
        if (!jsTruthy(st.value("held"_L1))) tp = !nullish(st.value("price"_L1)) ? st.value("price"_L1) : nullish(targets.value("spot_target"_L1)) ? targets.value("take_profit"_L1) : QJsonValue();
        const QJsonArray marks{
            QJsonObject{{u"key"_s, u"stop"_s}, {u"price"_s, stopPrice}, {u"label"_s, !nullish(trail) && !nullish(eff) && eff.toDouble() == trail.toDouble() ? u"跟踪止损"_s : u"止损"_s}, {u"kind"_s, u"stop"_s}},
            QJsonObject{{u"key"_s, u"ptrail"_s}, {u"price"_s, live.value("profit_trail_stop"_L1)}, {u"label"_s, u"回撤线"_s}, {u"kind"_s, u"other"_s}},
            QJsonObject{{u"key"_s, u"now"_s}, {u"price"_s, live.value("price"_L1)}, {u"label"_s, u"现价"_s}, {u"kind"_s, u"now"_s}},
            QJsonObject{{u"key"_s, u"tp"_s}, {u"price"_s, tp}, {u"label"_s, u"止盈"_s}, {u"kind"_s, u"target"_s}},
        };
        QJsonArray liveMarks;
        for (const QJsonValue& m : marks)
            if (m[u"price"].isDouble() && std::isfinite(m[u"price"].toDouble())) liveMarks.append(m);
        if (liveMarks.size() >= 2) rail = liveMarks;
    }

    QString chase;
    const QJsonObject c = live.value("chase"_L1).toObject();
    if (sweeping && !c.isEmpty()) {
        chase = u"追价第 %1 秒:挂 %2"_s.arg(jsString(c.value("rounds"_L1)), fmtMoney(c.value("limit"_L1)));
        if (!nullish(c.value("natural"_L1))) chase += u",此刻立刻成交价 "_s + fmtMoney(c.value("natural"_L1));
        if (!nullish(c.value("floor"_L1))) chase += u",最多让到 "_s + fmtMoney(c.value("floor"_L1));
    }

    const bool watching = !fired && enabled;
    return {
        {u"id"_s, t.value("id"_L1)},
        {u"symbol"_s, symbol},
        {u"tone"_s, tone},
        {u"title"_s, legLabel(symbol, t.value("sec_type"_L1).toString(), t.value("contract"_L1).toObject()) + u" · "_s + jsString(t.value("account"_L1))},
        {u"pill"_s, QJsonObject{{u"tint"_s, pillTint}, {u"text"_s, pillText}}},
        {u"meta"_s, meta},
        {u"tiers"_s, tiers},
        {u"stopBasis"_s, stopBasis},
        {u"hosted"_s, hostedItems},
        {u"pnl"_s, pnl},
        {u"rail"_s, rail},
        {u"gauge"_s, watching ? gauge(live, targets, symbol) : QJsonValue()},
        {u"levels"_s, watching ? QJsonValue(levelsPanel(in)) : QJsonValue()},
        {u"reason"_s, jsTruthy(live.value("reason"_L1)) ? live.value("reason"_L1) : QJsonValue()},
        {u"chase"_s, chase.isEmpty() ? QJsonValue() : QJsonValue(chase)},
        {u"blocked"_s, live.value("blocked"_L1).toArray()},
        {u"toggle"_s, enabled ? u"暂停"_s : u"恢复"_s},
    };
}

QStringList cardTexts(const QJsonObject& m) {
    QStringList out;
    const auto str = [&out](const QJsonValue& v) {
        if (v.isString() && !v.toString().isEmpty()) out << v.toString();
    };
    const auto items = [&out](const QJsonValue& list) {
        for (const QJsonValue& v : list.toArray()) out << (v.isObject() ? v[u"text"].toString() : v.toString());
    };
    str(m[u"title"]);
    str(m[u"pill"][u"text"]);
    items(m[u"meta"]);
    items(m[u"tiers"]);
    str(m[u"stopBasis"]);
    items(m[u"hosted"]);
    if (m[u"pnl"].isObject()) {
        str(m[u"pnl"][u"text"]);
        str(m[u"pnl"][u"pct"]);
        out << u"未实现盈亏"_s;
    }
    if (m[u"rail"].isArray()) {
        QList<QJsonObject> marks;
        for (const QJsonValue& v : m[u"rail"].toArray()) marks.append(v.toObject());
        std::stable_sort(marks.begin(), marks.end(), [](const QJsonObject& a, const QJsonObject& b) { return a[u"price"].toDouble() < b[u"price"].toDouble(); });
        for (const QJsonObject& k : marks) out << k[u"label"].toString() << jsToFixed(k[u"price"].toDouble(), 2);
    }
    const QJsonValue g = m[u"gauge"];
    if (g.isObject()) {
        str(g[u"noPrice"]);
        str(g[u"empty"]);
        for (const QJsonValue& l : g[u"lines"].toArray()) out << l.toString();
        str(g[u"spotStop"]);
        for (const QJsonValue& r : g[u"rings"].toArray()) out << r[u"pct"].toString() << u"%"_s << r[u"label"].toString() << r[u"value"].toString() << r[u"gap"].toString();
    }
    const QJsonValue lv = m[u"levels"];
    if (lv.isObject()) {
        if (lv[u"pending"].isObject()) {
            str(lv[u"pending"][u"text"]);
            str(lv[u"pending"][u"button"]);
        } else {
            out << u"关键价位"_s;
            str(lv[u"summary"]);
            for (const QJsonValue& n : lv[u"notes"].toArray()) out << n.toString();
            items(lv[u"meta"]);
            str(lv[u"button"]);
        }
    }
    str(m[u"reason"]);
    str(m[u"chase"]);
    const QJsonArray blocked = m[u"blocked"].toArray();
    if (!blocked.isEmpty()) {
        QStringList b;
        for (const QJsonValue& v : blocked) b << v.toString();
        out << u"到价了但没有平仓"_s << b.join(u"、"_s);
    }
    out << m[u"toggle"].toString() << u"立即平仓"_s << u"删除"_s;
    return out;
}

}  // namespace ibkr::shell::track
