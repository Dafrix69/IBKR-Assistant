#include "shell/playbook_format.h"

#include "shell/jsvalue.h"

#include <QDateTime>
#include <QTimeZone>

#include <cmath>

using namespace Qt::StringLiterals;

namespace ibkr::shell::playbook {

const QString kGexAssumptionHint = u"净 gamma 的正负建立在「做市商持有看涨、卖出看跌」这个假设上:真实持仓没人看得到,假设反过来结论也反过来。它只用来判断波动会被压住还是放大,不判断方向。"_s;

const QHash<QString, QString>& stateLabel() {
    static const QHash<QString, QString> m{{u"B2"_s, u"B2 上沿扩展"_s}, {u"B3"_s, u"B3 失守续探"_s}, {u"R"_s, u"区间内"_s}, {u"none"_s, u"线还不全"_s}};
    return m;
}

const QHash<QString, QString>& stateHint() {
    static const QHash<QString, QString> m{
        {u"B2"_s, u"取到新一格时现价站上了今日区间的上沿:高出 09:35 那个价的幅度已经超过剩余的预期波动。每 5 分钟取到新一格时判一次;那时现价在进入时那条线下方就失效"_s},
        {u"B3"_s, u"现价跌破了昨日区间的下沿(每一笔现价都判,压过 B2);收回这条线上方就失效"_s},
        {u"R"_s, u"现价在两条触发线之间,没有方向信号"_s},
        {u"none"_s, u"昨日区间与今日区间都还没有,判不了"_s},
    };
    return m;
}

QString fmtLevel(const QJsonValue& value) {
    return value.isDouble() && std::isfinite(value.toDouble()) ? jsToFixed(value.toDouble(), 2) : u"—"_s;
}

QString fmtGap(const QJsonValue& target, const QJsonValue& price) {
    if (!target.isDouble() || !price.isDouble()) return {};
    const double gap = target.toDouble() - price.toDouble();
    return (gap > 0 ? u"+"_s : gap < 0 ? u"−"_s : QString()) + jsToFixed(std::fabs(gap), 1);
}

QString etTime(const QJsonValue& epochMs) {
    if (!epochMs.isDouble()) return {};
    static const QTimeZone et("America/New_York");
    return QDateTime::fromMSecsSinceEpoch(qint64(epochMs.toDouble()), et).toString(u"HH:mm"_s);
}

QString eventTone(const QJsonObject& event) {
    if (event.value("kind"_L1) == u"accel"_s) return event.value("price"_L1).toDouble() >= event.value("level"_L1).toDouble() ? u"up"_s : u"down"_s;
    // 进 B2 与 B3 失效都是往上走;进 B3 与 B2 失效都是往下走
    return (event.value("state"_L1) == u"B2"_s) == (event.value("kind"_L1) == u"enter"_s) ? u"up"_s : u"down"_s;
}

QString eventTitle(const QString& symbol, const QJsonObject& event) {
    const QString level = fmtLevel(event.value("level"_L1));
    const bool b2 = event.value("state"_L1) == u"B2"_s;
    const QString kind = event.value("kind"_L1).toString();
    if (kind == u"accel") return u"%1 %2加速档 %3"_s.arg(symbol, eventTone(event) == u"up" ? u"上穿"_s : u"下破"_s, jsString(event.value("level"_L1)));
    if (kind == u"enter") return b2 ? u"%1 站上 %2,进入 B2 上沿扩展"_s.arg(symbol, level) : u"%1 跌破 %2,进入 B3 失守续探"_s.arg(symbol, level);
    return b2 ? u"%1 跌回 %2 下方,B2 失效"_s.arg(symbol, level) : u"%1 收回 %2 上方,B3 失效"_s.arg(symbol, level);
}

QString eventBody(const QJsonObject& event) {
    return u"现价 %1 · 美东 %2"_s.arg(fmtLevel(event.value("price"_L1)), etTime(event.value("at"_L1)));
}

QJsonArray bandRows(const QJsonObject& snap) {
    const QJsonObject bands = snap.value("bands"_L1).toObject();
    const auto band = [&bands](const char* key) {
        const QJsonValue v = bands.value(QLatin1StringView(key));
        return v.isUndefined() ? QJsonValue(QJsonValue::Null) : v;
    };
    const auto row = [](const QString& key, const QString& label, const QString& when, const QJsonValue& b, bool derived) {
        return QJsonObject{{u"key"_s, key}, {u"label"_s, label}, {u"when"_s, when}, {u"band"_s, b}, {u"derived"_s, derived}};
    };
    const QString every = u"每 %1 分钟"_s.arg(jsNumberToString(jsRound(snap.value("frame_seconds"_L1).toDouble() / 60)));
    return {row(u"prior"_s, u"昨日定价"_s, u"上一个收盘后 10 分钟"_s, band("prior"), false), row(u"open"_s, u"盘初定价"_s, u"09:35"_s, band("open"), false),
            row(u"current"_s, u"当前剩余"_s, every, band("current"), false), row(u"day"_s, u"今日区间"_s, u"09:35 的锚 ± 当前剩余"_s, band("day"), true)};
}

QString gexText(const QJsonObject& wall) {
    const QJsonValue gross = wall.value("gross_gex"_L1);
    const bool legacyBlind = gross.isUndefined() && wall.value("has_greeks"_L1) == QJsonValue(false);
    // 总量是 0 的「抵消」是什么都没称出来(没有未平仓量),不是真的抵消
    const bool weighed = gross.isUndefined() || (gross.isDouble() && gross.toDouble() > 0);
    const QString regime = wall.value("regime"_L1).toString();
    if (regime == u"neutral" && weighed) return u"看涨与看跌的 gamma 正好抵消"_s;
    if (legacyBlind || !weighed || (regime != u"positive" && regime != u"negative")) return u"gamma 环境未知(缺隐含波动率或未平仓量)"_s;
    const QJsonValue ratio = wall.value("net_gex_ratio"_L1);
    const QString share = ratio.isDouble() && std::isfinite(ratio.toDouble()) ? u" · 净额占总量 %1%"_s.arg(jsToFixed(std::fabs(ratio.toDouble()) * 100, 1)) : QString();
    return (regime == u"positive" ? u"正 gamma(波动受压)"_s : u"负 gamma(波动放大)"_s) + share;
}

QString coverageText(const QJsonValue& coverage, const QJsonValue& oiMissing) {
    if (!jsTruthy(coverage)) return {};
    const QJsonObject c = coverage.toObject();
    const QString base = u"%1–%2 共 %3 档"_s.arg(jsString(c.value("lower"_L1)), jsString(c.value("upper"_L1)), jsString(c.value("strikes"_L1)));
    const QJsonValue grid = c.value("grid_strikes"_L1);
    const QString thin = jsTruthy(c.value("thinned"_L1)) && !grid.isNull() ? u"(链上 %1 档,远处只取整数档)"_s.arg(jsString(grid)) : QString();
    const QJsonValue oi = oiMissing.isUndefined() ? QJsonValue(0) : oiMissing;
    return base + thin + (jsTruthy(oi) ? u" · %1 行没等到未平仓量"_s.arg(jsString(oi)) : QString());
}

QString rearmText(const QJsonValue& lost) {
    return lost.isDouble() ? u"B2 已失效:取到新一格时回到这条线下方再站上,或重新站回 %1 之上,才算新的一次"_s.arg(fmtLevel(lost)) : QString();
}

}  // namespace ibkr::shell::playbook
