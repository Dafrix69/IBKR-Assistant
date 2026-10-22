#include "shell/track_levels.h"

#include "shell/jsvalue.h"

#include <QStringList>

#include <algorithm>
#include <cmath>

using namespace Qt::StringLiterals;

namespace ibkr::shell::levels {

namespace {

/// 有限、大于 0 的数;别的是空
std::optional<double> num(const QJsonValue& v) {
    if (!v.isDouble() || !std::isfinite(v.toDouble()) || v.toDouble() <= 0) return std::nullopt;
    return v.toDouble();
}
/// a ?? b(JSON 的 null 与缺键都算没有)
QJsonValue orElse(const QJsonValue& a, const QJsonValue& b) { return a.isNull() || a.isUndefined() ? b : a; }
double price(const QJsonObject& l) { return l.value("price"_L1).toDouble(); }

}  // namespace

bool isOwnLine(const QJsonObject& level) { return jsString(orElse(level.value("source"_L1), QString())).startsWith(kOwnPrefix); }

QJsonArray ownLines(const QString& secType, const QJsonObject& targets, const QJsonObject& live) {
    QJsonArray out;
    const auto add = [&out](const QString& key, const QString& label, const QJsonValue& v) {
        if (const auto p = num(v)) out.append(QJsonObject{{u"price"_s, *p}, {u"label"_s, label}, {u"source"_s, kOwnPrefix + key}, {u"kind"_s, u"pivot"_s}});
    };
    if (secType == u"STK") {
        add(u"stop"_s, u"止损"_s, orElse(live.value("stop_effective"_L1), targets.value("stop_loss"_L1)));
        add(u"ptrail"_s, u"回撤线"_s, live.value("profit_trail_stop"_L1));
        add(u"tp"_s, u"止盈"_s, orElse(targets.value("spot_target"_L1), targets.value("take_profit"_L1)));
        return out;
    }
    add(u"stop_below"_s, u"标的止损"_s, targets.value("spot_stop_below"_L1));
    add(u"stop_above"_s, u"标的止损"_s, targets.value("spot_stop_above"_L1));
    add(u"target"_s, u"目标价"_s, targets.value("spot_target"_L1));
    return out;
}

QJsonObject nearestLevels(const QJsonArray& levels, double spot, int n) {
    QList<QJsonObject> below, above;
    for (const QJsonValue& v : levels) {
        const QJsonObject l = v.toObject();
        const double p = price(l);
        if (isOwnLine(l) || !std::isfinite(p) || !(p > 0) || p == spot) continue;
        (p < spot ? below : above).append(l);
    }
    std::stable_sort(below.begin(), below.end(), [](const QJsonObject& a, const QJsonObject& b) { return price(b) < price(a); });
    std::stable_sort(above.begin(), above.end(), [](const QJsonObject& a, const QJsonObject& b) { return price(a) < price(b); });
    const auto gaps = [spot, n](const QList<QJsonObject>& list) {
        QJsonArray out;
        for (qsizetype i = 0; i < list.size() && i < n; ++i) out.append(QJsonObject{{u"level"_s, list[i]}, {u"pct"_s, (price(list[i]) / spot - 1) * 100}});
        return out;
    };
    return {{u"below"_s, gaps(below)}, {u"above"_s, gaps(above)}};
}

QString fmtLevel(double v) { return jsNumberToString(jsToFixed(v, 2).toDouble()); }

QString fmtGap(double pct) { return (pct > 0 ? u"+"_s : pct < 0 ? u"−"_s : QString()) + jsToFixed(std::fabs(pct), 2) + u'%'; }

QString levelName(const QJsonObject& level, const ShortNames& names) {
    const QString s = names.value(level.value("source"_L1).toString());
    if (!s.isEmpty()) return s;
    const QString label = level.value("label"_L1).toString();
    return label.isEmpty() ? u"价位"_s : label;
}

QString levelSummary(const QJsonArray& levels, double spot, const ShortNames& names) {
    const QJsonObject near = nearestLevels(levels, spot);
    const auto part = [&names](const QJsonArray& gaps) {
        QStringList out;
        for (const QJsonValue& g : gaps) {
            const QJsonObject l = g[u"level"].toObject();
            out << u"%1 %2(%3)"_s.arg(levelName(l, names), fmtLevel(price(l)), fmtGap(g[u"pct"].toDouble()));
        }
        return out.join(u"、"_s);
    };
    QStringList parts;
    if (!near[u"below"].toArray().isEmpty()) parts << u"下方 "_s + part(near[u"below"].toArray());
    if (!near[u"above"].toArray().isEmpty()) parts << u"上方 "_s + part(near[u"above"].toArray());
    return parts.join(u" · "_s);
}

std::optional<QString> lineContext(const QJsonObject& line, const QJsonArray& levels, double spot, const ShortNames& names) {
    const double lp = price(line);
    if (!(spot > 0) || !(lp > 0) || lp == spot) return std::nullopt;
    const bool belowSpot = lp < spot;
    std::optional<QJsonObject> near;
    for (const QJsonValue& v : levels) {
        const QJsonObject l = v.toObject();
        const double p = price(l);
        if (isOwnLine(l) || !(p > 0) || !(belowSpot ? p < spot : p > spot)) continue;
        if (!near || std::fabs(p - lp) < std::fabs(price(*near) - lp)) near = l;
    }
    if (!near) return std::nullopt;
    const double np = price(*near);
    const QString name = levelName(*near, names) + u' ' + fmtLevel(np);
    const double gap = std::fabs(np / lp - 1) * 100;
    const QString head = line.value("label"_L1).toString() + u' ' + fmtLevel(lp);
    if (std::fabs(np - lp) <= (spot * kNearPct) / 100) return head + u" 贴着 "_s + name;
    const bool outside = belowSpot ? np > lp : np < lp;  // 价位在线和现价之间
    if (outside) return u"%1 在 %2 之%3 %4%"_s.arg(head, name, belowSpot ? u"下"_s : u"上"_s, jsToFixed(gap, 2));
    return u"%1 在 %2 之%3 %4%:%5没破就先出了"_s.arg(head, name, belowSpot ? u"上"_s : u"下"_s, jsToFixed(gap, 2), belowSpot ? u"支撑"_s : u"阻力"_s);
}

QJsonObject pickSides(const QJsonArray& levels, double spot, const QString& mode, bool isLong, bool derivative) {
    QList<QJsonObject> below, above;
    for (const QJsonValue& v : levels) {
        const QJsonObject l = v.toObject();
        const double p = price(l);
        if (isOwnLine(l) || !(p > 0) || p == spot) continue;
        (p < spot ? below : above).append(l);
    }
    std::stable_sort(below.begin(), below.end(), [](const QJsonObject& a, const QJsonObject& b) { return price(b) < price(a); });
    std::stable_sort(above.begin(), above.end(), [](const QJsonObject& a, const QJsonObject& b) { return price(a) < price(b); });
    const auto arr = [](const QList<QJsonObject>& list) {
        QJsonArray out;
        for (const QJsonObject& o : list) out.append(o);
        return out;
    };
    if (derivative) return {{u"below"_s, arr(below)}, {u"above"_s, arr(above)}};
    const bool wantBelow = mode == u"stop" ? isLong : !isLong;
    return wantBelow ? QJsonObject{{u"below"_s, arr(below)}, {u"above"_s, QJsonArray()}} : QJsonObject{{u"below"_s, QJsonArray()}, {u"above"_s, arr(above)}};
}

std::optional<QString> trackContext(const QString& symbol, const QJsonArray& tracks, const QJsonObject& rows) {
    QStringList parts;
    bool any = false;
    for (const QJsonValue& tv : tracks) {
        const QJsonObject t = tv.toObject();
        if (t.value("symbol"_L1).toString() != symbol || !jsTruthy(t.value("enabled"_L1)) || jsTruthy(t.value("fired_at"_L1))) continue;
        any = true;
        const QJsonObject live = rows.value(t.value("id"_L1).toString()).toObject();
        const QJsonObject targets = t.value("targets"_L1).toObject();
        QString part;
        if (t.value("sec_type"_L1).toString() == u"STK") {
            const auto stop = num(orElse(live.value("stop_effective"_L1), targets.value("stop_loss"_L1)));
            const auto p = num(live.value("price"_L1));
            if (!stop) part = u"正股在追踪,没设止损价"_s;
            else part = !p ? u"止损 "_s + fmtLevel(*stop) : u"止损 %1(距现价 %2)"_s.arg(fmtLevel(*stop), fmtGap((*stop / *p - 1) * 100));
        } else {
            const QJsonObject stop = live.value("spot_stop"_L1).toObject();
            const auto below = num(orElse(stop.value("below"_L1), targets.value("spot_stop_below"_L1)));
            const auto above = num(orElse(stop.value("above"_L1), targets.value("spot_stop_above"_L1)));
            const auto spot = num(stop.value("spot"_L1));
            const auto gap = [](double d) { return d >= 0 ? u"(还差 %1 点)"_s.arg(jsToFixed(d, 2)) : u"(已越过 %1 点)"_s.arg(jsToFixed(-d, 2)); };
            QStringList lines;
            if (below) lines << u"跌到 "_s + fmtLevel(*below) + (spot ? gap(*spot - *below) : QString());
            if (above) lines << u"涨到 "_s + fmtLevel(*above) + (spot ? gap(*above - *spot) : QString());
            part = lines.isEmpty() ? u"期权在追踪,没设标的止损"_s : u"标的止损 "_s + lines.join(u" / "_s);
        }
        if (!parts.contains(part)) parts << part;
    }
    if (!any) return std::nullopt;
    return u"持仓追踪:"_s + parts.join(u";"_s);
}

const ShortNames& sourceShort() {
    static const ShortNames names{
        {u"call_wall"_s, u"C 墙"_s}, {u"put_wall"_s, u"P 墙"_s}, {u"call_vol_wall"_s, u"C 成交墙"_s}, {u"put_vol_wall"_s, u"P 成交墙"_s},
        {u"max_pain"_s, u"痛点"_s}, {u"gamma_flip"_s, u"γ 翻转"_s}, {u"round"_s, u"关口"_s}, {u"ma20"_s, u"MA20"_s}, {u"ma60"_s, u"MA60"_s},
        {u"ma120"_s, u"MA120"_s}, {u"ma200"_s, u"MA200"_s}, {u"low_52w"_s, u"52周低"_s}, {u"high_52w"_s, u"52周高"_s},
    };
    return names;
}

const ShortNames& sourceLabel() {
    static const ShortNames names{
        {u"call_wall"_s, u"持仓墙"_s}, {u"put_wall"_s, u"持仓墙"_s}, {u"call_vol_wall"_s, u"成交墙"_s}, {u"put_vol_wall"_s, u"成交墙"_s},
        {u"max_pain"_s, u"最大痛点"_s}, {u"gamma_flip"_s, u"Gamma 翻转"_s}, {u"round"_s, u"整数关口"_s}, {u"ma20"_s, u"20日线"_s},
        {u"ma60"_s, u"60日线"_s}, {u"ma120"_s, u"120日线"_s}, {u"ma200"_s, u"200日线"_s}, {u"low_52w"_s, u"52周低点"_s}, {u"high_52w"_s, u"52周高点"_s},
    };
    return names;
}

}  // namespace ibkr::shell::levels
