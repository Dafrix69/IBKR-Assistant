#include "shell/fly_rules.h"

#include "shell/event_rules.h"
#include "shell/jsvalue.h"
#include "shell/playbook_format.h"
#include "shell/spot_levels.h"
#include "shell/track_rules.h"

#include <QDateTime>
#include <QRegularExpression>

#include <algorithm>
#include <cmath>

namespace ibkr::shell::fly {

using namespace Qt::StringLiterals;

namespace {

QString tpl(const QJsonValue& v) { return jsString(v); }
bool present(const QJsonValue& v) { return !v.isUndefined() && !v.isNull(); }
QJsonArray arr(const QJsonValue& v) { return v.isArray() ? v.toArray() : QJsonArray{}; }
double n(const QJsonValue& v) { return jsNumber(v); }
QString fmtNum(const QJsonValue& v, int digits = 2) { return track::fmtNum(v, digits); }

/// flyPlanForm.ts 的 num:空 → 没有(nullopt);写了但不是有限的数 → NaN
std::optional<double> num(const QString& text) {
    const QString t = jsTrim(text);
    if (t.isEmpty()) return std::nullopt;
    const double v = jsNumber(QJsonValue(t));
    return std::isfinite(v) ? v : std::numeric_limits<double>::quiet_NaN();
}

QString field(const QJsonObject& form, const char* key) { return form.value(QLatin1StringView(key)).toString(); }

/// 只认 ASCII 数字,同 JS 的 \d(QRegularExpression 的 \d 默认也只认 ASCII,开了 UseUnicodePropertiesOption 才认全角;写 [0-9] 不靠这个默认)
const QRegularExpression& dateRe() {
    static const QRegularExpression re(u"^[0-9]{4}-[0-9]{2}-[0-9]{2}\\z"_s);
    return re;
}
const QRegularExpression& timeRe() {
    static const QRegularExpression re(u"^([01]?[0-9]|2[0-3]):[0-5][0-9]\\z"_s);
    return re;
}

/// String(Number(value.toFixed(2)))
QString plain(double value) { return jsNumberToString(jsNumber(QJsonValue(jsToFixed(value, 2)))); }

QString nextWeekday(const QString& date) {
    QDate d = QDate::fromString(date, u"yyyy-MM-dd"_s);
    do d = d.addDays(1);
    while (d.dayOfWeek() >= 6);
    return d.toString(u"yyyy-MM-dd"_s);
}

/// toLocaleString('en-US', { maximumFractionDigits: 0 }):四舍五入(一半往远离 0 的方向)、千分位
QString groupedInt(double v) {
    // 不是有限数:toLocaleString 写 NaN / ∞(符号由调用的地方另给,这里只管绝对值)
    if (std::isnan(v)) return u"NaN"_s;
    if (std::isinf(v)) return u"∞"_s;
    const double r = std::round(std::fabs(v));
    QString digits = QString::number(r, 'f', 0);
    for (qsizetype i = digits.size() - 3; i > 0; i -= 3) digits.insert(i, u',');
    return digits;
}

QString tone(double v) { return v > 0 ? u"pos"_s : v < 0 ? u"neg"_s : QString(); }

QString duration(double minutes) {
    if (minutes < 60) return u"%1 分钟"_s.arg(jsNumberToString(minutes));
    const double h = std::floor(minutes / 60);
    const double m = std::fmod(minutes, 60);
    return m != 0 ? u"%1 小时 %2 分"_s.arg(jsNumberToString(h), jsNumberToString(m)) : u"%1 小时"_s.arg(jsNumberToString(h));
}

QString localTime(double ms, const QTimeZone& zone, bool seconds) {
    return QDateTime::fromMSecsSinceEpoch(qint64(ms), zone).toString(seconds ? u"HH:mm:ss"_s : u"HH:mm"_s);
}

QString pnlText(const QJsonObject& v) { return u"%1 · %2"_s.arg(signedUsd(n(v.value("pnl"_L1))), signedPct(n(v.value("pnl_pct"_L1)), 0)); }

QString labelOf(const QHash<QString, QString>& m, const QJsonValue& key) {
    const auto it = m.constFind(jsString(key));
    return it != m.cend() ? *it : u"undefined"_s;
}

QJsonArray compact(std::initializer_list<QJsonValue> items) {
    QJsonArray out;
    for (const QJsonValue& v : items)
        if (v.isString() && !v.toString().isEmpty()) out.append(v);
    return out;
}

/// "7745" / "7724.4" / null → "…"(盈亏平衡缺一侧时的写法)
QString orDots(const QJsonValue& v) { return present(v) ? tpl(v) : u"…"_s; }

}  // namespace

// ---- 表单 ---------------------------------------------------------------------------------------------------------

const QStringList& formKeys() {
    static const QStringList k{u"center"_s, u"width"_s, u"right"_s, u"quantity"_s, u"cost"_s, u"targetSpot"_s, u"targetTime"_s,
                               u"targetDate"_s, u"expiry"_s, u"spot"_s, u"iv"_s, u"ivMode"_s, u"ivShiftPct"_s};
    return k;
}

QJsonObject emptyForm() {
    return {{u"center"_s, u""_s}, {u"width"_s, u"25"_s}, {u"right"_s, u""_s}, {u"quantity"_s, u"1"_s}, {u"cost"_s, u""_s}, {u"targetSpot"_s, u""_s},
            {u"targetTime"_s, u""_s}, {u"targetDate"_s, u""_s}, {u"expiry"_s, u""_s}, {u"spot"_s, u""_s}, {u"iv"_s, u""_s}, {u"ivMode"_s, u"auto"_s},
            {u"ivShiftPct"_s, u""_s}};
}

QStringList formProblems(const QJsonObject& form) {
    QStringList out;
    using Check = std::function<QString(double)>;
    const auto need = [&](const QString& label, const QString& text, const Check& check) {
        const auto v = num(text);
        if (!v) out << label + u"还没填"_s;
        else if (std::isnan(*v)) out << label + u"不是数字"_s;
        else if (const QString why = check(*v); !why.isEmpty()) out << label + why;
    };
    const auto maybe = [&](const QString& label, const QString& text, const Check& check) {
        const auto v = num(text);
        if (!v) return;
        if (std::isnan(*v)) out << label + u"不是数字"_s;
        else if (const QString why = check(*v); !why.isEmpty()) out << label + why;
    };
    const Check positive = [](double v) { return v > 0 ? QString() : u"要大于 0"_s; };
    const auto width = num(field(form, "width"));
    // width !== null && v <= width:width 是 NaN 时比较为假
    need(u"中心行权价"_s, field(form, "center"), [&](double v) { return v > 0 ? (width && v <= *width ? u"要大于翼宽"_s : QString()) : u"要大于 0"_s; });
    need(u"翼宽"_s, field(form, "width"), positive);
    need(u"目标点位"_s, field(form, "targetSpot"), positive);
    const QString time = jsTrim(field(form, "targetTime"));
    if (time.isEmpty()) out << u"到达时刻还没填"_s;
    else if (!timeRe().match(time).hasMatch()) out << u"到达时刻要写成 HH:MM(美东时间)"_s;
    maybe(u"张数"_s, field(form, "quantity"), [](double v) { return v == std::trunc(v) && v >= 1 ? QString() : u"要是不小于 1 的整数"_s; });
    maybe(u"成本"_s, field(form, "cost"), [&](double v) { return v > 0 ? (width && *width > 0 && v >= *width ? u"不应该超过翼宽"_s : QString()) : u"要大于 0"_s; });
    maybe(u"现价"_s, field(form, "spot"), positive);
    maybe(u"IV"_s, field(form, "iv"), [](double v) { return v > 0 && v <= 500 ? QString() : u"要在 0 到 500% 之间"_s; });
    const QString date = jsTrim(field(form, "targetDate"));
    if (!date.isEmpty() && !dateRe().match(date).hasMatch()) out << u"目标日期要写成 YYYY-MM-DD"_s;
    const QString expiry = jsTrim(field(form, "expiry"));
    if (!expiry.isEmpty() && !dateRe().match(expiry).hasMatch()) out << u"到期日要写成 YYYY-MM-DD"_s;
    if (field(form, "ivMode") == u"shift") need(u"IV 变化"_s, field(form, "ivShiftPct"), [](double v) { return v > -100 ? QString() : u"不能小于 −100%"_s; });
    return out;
}

QJsonObject toParams(const QJsonObject& form) {
    QJsonObject out{
        {u"center"_s, jsNumber(QJsonValue(field(form, "center")))},
        {u"width"_s, jsNumber(QJsonValue(field(form, "width")))},
        {u"target_spot"_s, jsNumber(QJsonValue(field(form, "targetSpot")))},
        {u"target_time"_s, jsTrim(field(form, "targetTime"))},
        {u"iv_mode"_s, field(form, "ivMode")},
    };
    const auto put = [&](const char* key, const char* from) {
        if (const auto v = num(field(form, from))) out.insert(QLatin1StringView(key), *v);
    };
    put("quantity", "quantity");
    put("cost", "cost");
    put("spot", "spot");
    put("iv", "iv");
    if (!field(form, "right").isEmpty()) out.insert(u"right"_s, field(form, "right"));
    if (!jsTrim(field(form, "targetDate")).isEmpty()) out.insert(u"target_date"_s, jsTrim(field(form, "targetDate")));
    if (!jsTrim(field(form, "expiry")).isEmpty()) out.insert(u"expiry"_s, jsTrim(field(form, "expiry")).remove(u'-'));
    if (field(form, "ivMode") == u"shift") out.insert(u"iv_shift_pct"_s, jsNumber(QJsonValue(field(form, "ivShiftPct"))));
    return out;
}

QString formKey(const QJsonObject& form) {
    QStringList parts;
    for (const QString& k : formKeys()) parts << jsonQuote(k) + u':' + jsonQuote(field(form, k.toLatin1().constData()));
    return u'{' + parts.join(u',') + u'}';
}

bool touched(const QJsonObject& form) {
    return !field(form, "center").isEmpty() || !field(form, "targetSpot").isEmpty() || !field(form, "targetTime").isEmpty();
}

// ---- 美东时间 ------------------------------------------------------------------------------------------------------

EtClock etClock(double nowMs) {
    static const QTimeZone et("America/New_York");
    const QDateTime t = QDateTime::fromMSecsSinceEpoch(qint64(nowMs), et);
    return {t.date().toString(u"yyyy-MM-dd"_s), t.time().hour() * 60 + t.time().minute()};
}

QString hhmm(double minutes) {
    const double m = std::max(0.0, std::min(23.0 * 60 + 59, jsRound(minutes)));
    return u"%1:%2"_s.arg(int(std::floor(m / 60)), 2, 10, QChar(u'0')).arg(int(std::fmod(m, 60)), 2, 10, QChar(u'0'));
}

QString minutesFromNow(double nowMs, double ahead) { return hhmm(std::min(16.0 * 60, etClock(nowMs).minutes + ahead)); }

QJsonArray timeChips(double nowMs) {
    return {QJsonArray{u"30 分钟后"_s, minutesFromNow(nowMs, 30)}, QJsonArray{u"1 小时后"_s, minutesFromNow(nowMs, 60)},
            QJsonArray{u"2 小时后"_s, minutesFromNow(nowMs, 120)}, QJsonArray{u"15:45"_s, u"15:45"_s}};
}

// ---- 写成指令 / 格式 ----------------------------------------------------------------------------------------------

QString instructionFor(const QJsonObject& r, const QString& todayEt) {
    const QString e = r.value("expiry"_L1).toString();
    const QString expiry = u"%1-%2-%3"_s.arg(e.left(4), e.mid(4, 2), e.mid(6, 2));
    const QString side = r.value("right"_L1) == QJsonValue(u"C"_s) ? u"看涨"_s : u"看跌"_s;
    const QString symbol = tpl(r.value("symbol"_L1));
    const QString body = u"%1蝴蝶 %2cm %3 %4张"_s.arg(plain(n(r.value("center"_L1))), plain(n(r.value("width"_L1))), side, tpl(r.value("quantity"_L1)));
    const QString cost = plain(n(r.value("cost"_L1)));
    if (expiry == todayEt) return u"%1 %2 %3"_s.arg(symbol, body, cost);
    if (expiry == nextWeekday(todayEt)) return u"%1 明天 %2 %3"_s.arg(symbol, body, cost);
    return u"买入 %1 张 %2 %3 到期的 %4/%5/%6 %7蝴蝶,权利金不超过 %8"_s.arg(tpl(r.value("quantity"_L1)), symbol, expiry, plain(n(r.value("lower"_L1))),
                                                                            plain(n(r.value("center"_L1))), plain(n(r.value("upper"_L1))), side, cost);
}

QString signedUsd(double value) {
    return u"%1$%2"_s.arg(value > 0 ? u"+"_s : value < 0 ? u"−"_s : QString(), groupedInt(value));
}

QString signedPct(double value, int digits) {
    return (value > 0 ? u"+"_s : value < 0 ? u"−"_s : QString()) + jsToFixed(std::fabs(value), digits) + u'%';
}

QString pct(double fraction, int digits) { return jsToFixed(fraction * 100, digits) + u'%'; }

const QHash<QString, QString>& paceLabel() {
    static const QHash<QString, QString> m{{u"calm"_s, u"平缓"_s}, {u"brisk"_s, u"偏急"_s}, {u"sharp"_s, u"很急"_s}};
    return m;
}
const QHash<QString, QString>& ivSourceLabel() {
    static const QHash<QString, QString> m{{u"ibkr"_s, u"IBKR 模型 IV"_s}, {u"quote"_s, u"盘口反解"_s}, {u"input"_s, u"手动填写"_s}};
    return m;
}
const QHash<QString, QString>& costSourceLabel() {
    static const QHash<QString, QString> m{{u"input"_s, u"你填的"_s}, {u"mid"_s, u"盘口中间价"_s}, {u"model"_s, u"模型价(无盘口)"_s}};
    return m;
}

QStringList statisticParts(const QString& value) {
    static const QRegularExpression re(u"^(-?)([0-9]*)(\\.([0-9]+))?\\z"_s);
    const auto m = re.match(value);
    if (!m.hasMatch() || value.isEmpty() || value == u"-") return {value};
    QString intPart = m.captured(2);
    for (qsizetype i = intPart.size() - 3; i > 0; i -= 3) intPart.insert(i, u',');
    QStringList out{m.captured(1) + intPart};
    if (m.hasCaptured(3)) out << u"."_s + m.captured(4);
    return out;
}

// ---- 盈亏曲线 ------------------------------------------------------------------------------------------------------

QJsonObject chartModel(const QJsonObject& r) {
    const QJsonArray pts = arr(r.value("curve"_L1));
    if (pts.size() < 2) return {};
    constexpr double W = 600, H = 190, padT = 12, padB = 24;
    const double xMin = n(pts.first()[u"spot"]);
    const double xMax = n(pts.last()[u"spot"]);
    double vMax = std::max(n(r.value("width"_L1)) * 0.4, n(r.value("cost"_L1)) * 1.3);
    for (const QJsonValue& p : pts) vMax = std::max(vMax, std::max({n(p[u"now"]), n(p[u"target"]), n(p[u"expiry"])}));
    vMax *= 1.06;
    const auto X = [&](double s) { return ((s - xMin) / (xMax - xMin)) * W; };
    const auto Y = [&](double v) { return padT + (1 - v / vMax) * (H - padT - padB); };
    const auto path = [&](const char* key) {
        QStringList parts;
        for (qsizetype i = 0; i < pts.size(); ++i)
            parts << u"%1%2 %3"_s.arg(i ? u"L"_s : u"M"_s, jsToFixed(X(n(pts[i][u"spot"])), 1), jsToFixed(Y(n(pts[i][QLatin1StringView(key)])), 1));
        return parts.join(u' ');
    };
    QJsonArray points;
    for (const QJsonValue& p : pts)
        points.append(QJsonObject{{u"x"_s, X(n(p[u"spot"]))}, {u"now"_s, Y(n(p[u"now"]))}, {u"target"_s, Y(n(p[u"target"]))}, {u"expiry"_s, Y(n(p[u"expiry"]))}});
    const double costY = Y(n(r.value("cost"_L1)));
    const QString target = path("target");
    const auto frac = [&](double s) { return (s - xMin) / (xMax - xMin); };
    const auto leftText = [&](double s) { return jsToFixed(frac(s) * 100, 2) + u'%'; };
    const auto inRange = [&](double s) { return s >= xMin && s <= xMax; };
    QJsonArray strikes;
    for (const char* k : {"lower", "center", "upper"}) {
        const double s = n(r.value(QLatin1StringView(k)));
        strikes.append(QJsonObject{{u"x"_s, X(s)}, {u"label"_s, tpl(r.value(QLatin1StringView(k)))}, {u"left"_s, frac(s)}, {u"leftText"_s, leftText(s)}});
    }
    const double spot = n(r.value("spot"_L1));
    const double tspot = n(r.value("target"_L1).toObject().value("spot"_L1));
    const bool near = std::fabs(X(spot) - X(tspot)) < 70;
    const QString at = r.value("target"_L1).toObject().value("at"_L1).toString().mid(11);
    return {
        {u"width"_s, W},
        {u"height"_s, H},
        {u"points"_s, points},
        {u"d"_s, QJsonObject{{u"now"_s, path("now")}, {u"target"_s, target}, {u"expiry"_s, path("expiry")},
                             {u"area"_s, u"%1 L%2 %3 L0 %3 Z"_s.arg(target, jsNumberToString(W), jsToFixed(costY, 1))}}},
        {u"costY"_s, costY},
        {u"strikeY1"_s, padT},
        {u"strikeY2"_s, H - padB + 5},
        {u"markY1"_s, 4},
        {u"markY2"_s, H - padB + 2},
        {u"strikes"_s, strikes},
        {u"spot"_s, inRange(spot) ? QJsonValue(QJsonObject{{u"x"_s, X(spot)}, {u"label"_s, u"现价 "_s + jsToFixed(spot, 1)}, {u"left"_s, frac(spot)},
                                                            {u"leftText"_s, leftText(spot)}, {u"top"_s, near ? 16 : -4}})
                                  : QJsonValue()},
        {u"target"_s, inRange(tspot) ? QJsonValue(QJsonObject{{u"x"_s, X(tspot)}, {u"label"_s, u"目标 "_s + jsNumberToString(tspot)}, {u"left"_s, frac(tspot)},
                                                                {u"leftText"_s, leftText(tspot)}})
                                       : QJsonValue()},
        {u"cost"_s, QJsonObject{{u"label"_s, u"成本 "_s + tpl(r.value("cost"_L1))}, {u"topFrac"_s, costY / H}, {u"topText"_s, jsToFixed((costY / H) * 100, 2) + u'%'}}},
        {u"legend"_s, QJsonArray{at + u" 到"_s, u"现在就到"_s, u"到期时停在那儿"_s}},
    };
}

// ---- 结果 ---------------------------------------------------------------------------------------------------------

QJsonObject resultModel(const QJsonObject& r, const QTimeZone& localZone) {
    const QString side = r.value("right"_L1) == QJsonValue(u"C"_s) ? u"看涨"_s : u"看跌"_s;
    const QJsonObject iv = r.value("iv"_L1).toObject();
    const QJsonObject target = r.value("target"_L1).toObject();
    const QJsonObject m = r.value("move"_L1).toObject();
    const QJsonObject model = iv.value("model"_L1).toObject();
    const bool ivMoved = std::fabs(n(iv.value("change_pct"_L1))) >= 0.05;
    QString ivWhy;
    if (iv.value("mode"_L1) == QJsonValue(u"auto"_s)) {
        QStringList parts;
        if (std::fabs(n(iv.value("seasonal_pct"_L1))) >= 0.05) parts << u"时段 "_s + signedPct(n(iv.value("seasonal_pct"_L1)), 0);
        if (std::fabs(n(iv.value("move_pct"_L1))) >= 0.05) parts << u"走势 "_s + signedPct(n(iv.value("move_pct"_L1)), 0);
        ivWhy = parts.join(u"、"_s);
    } else {
        ivWhy = u"你填的"_s;
    }
    const QString dir = m.value("direction"_L1).toString();
    const QString arrow = dir == u"up" ? u"涨"_s : dir == u"down" ? u"跌"_s : u"不动"_s;
    const QJsonObject be = r.value("breakeven"_L1).toObject();
    const QString beText = !present(be.value("low"_L1)) && !present(be.value("high"_L1))
                               ? (n(r.value("peak"_L1).toObject().value("value"_L1)) > n(r.value("cost"_L1)) ? u"图的范围内都在成本之上"_s : u"这个时刻怎么走都不赚"_s)
                               : u"%1 – %2"_s.arg(orDots(be.value("low"_L1)), orDots(be.value("high"_L1)));
    const double pnl = n(target.value("pnl"_L1));
    const QString at = target.value("at"_L1).toString().mid(11);

    QJsonArray tiles{QJsonObject{{u"label"_s, u"预计盈利"_s}, {u"value"_s, pnlText(target)}, {u"tone"_s, tone(pnl)}},
                     QJsonObject{{u"label"_s, u"到时蝶价(成本 %1)"_s.arg(fmtNum(r.value("cost"_L1)))}, {u"value"_s, fmtNum(target.value("value"_L1))}, {u"tone"_s, u""_s}}};
    if (r.value("target_range"_L1).isObject()) {
        const QJsonObject range = r.value("target_range"_L1).toObject();
        tiles.append(QJsonObject{{u"label"_s, u"半数情况下"_s}, {u"tip"_s, u"到时的 IV 估不准:按历史上估错的幅度,有一半的情况盈亏落在这个区间里"_s},
                                 {u"value"_s, u"%1 ~ %2"_s.arg(signedUsd(n(range[u"low"][u"pnl"])), signedUsd(n(range[u"high"][u"pnl"])))}, {u"tone"_s, u""_s}});
    }
    if (ivMoved) {
        const double flat = n(r.value("target_flat"_L1).toObject().value("pnl"_L1));
        tiles.append(QJsonObject{{u"label"_s, u"要是 IV 不变"_s}, {u"value"_s, signedUsd(flat)}, {u"tone"_s, tone(flat)}});
    }
    const double atExpiry = n(r.value("at_expiry"_L1).toObject().value("pnl"_L1));
    tiles.append(QJsonObject{{u"label"_s, u"到期时停在目标"_s}, {u"value"_s, signedUsd(atExpiry)}, {u"tone"_s, tone(atExpiry)}});
    tiles.append(QJsonObject{{u"label"_s, u"最多赚 / 最多亏"_s},
                             {u"value"_s, u"%1 / %2"_s.arg(signedUsd(n(r.value("max_profit"_L1))), signedUsd(-n(r.value("max_loss"_L1))))}, {u"tone"_s, u""_s}});

    const QString source = r.value("spot_source"_L1).toString();
    const QJsonValue sigmas = m.value("sigmas"_L1);
    const QJsonArray meta1 = compact({
        u"现价 %1%2 → %3:%4,%5"_s.arg(fmtNum(r.value("spot"_L1)), source == u"futures" ? u"(期货推算)"_s : source == u"input" ? u"(手动)"_s : QString(),
                                       tpl(target.value("spot"_L1)),
                                       dir == u"flat" ? u"不动"_s : u"%1 %2 点"_s.arg(arrow, fmtNum(std::fabs(n(m.value("points"_L1))))), duration(n(m.value("minutes"_L1)))),
        dir != u"flat" ? QJsonValue(u"走了全天波动(一个标准差 ≈ %1 点)的 %2 倍"_s.arg(fmtNum(m.value("day_sigma"_L1), 1), fmtNum(std::fabs(n(m.value("day_sigmas"_L1))))))
                       : QJsonValue(),
        !sigmas.isNull() ? QJsonValue(u"按这段时间算是 %1 个标准差(%2)"_s.arg(fmtNum(sigmas), labelOf(paceLabel(), m.value("pace"_L1)))) : QJsonValue(),
        u"本地时间 %1 · 到时离到期 %2 小时"_s.arg(localTime(n(target.value("epoch_ms"_L1)), localZone, false), fmtNum(target.value("hours_left"_L1), 1)),
    });
    const QJsonObject market = r.value("market"_L1).toObject();
    const QJsonObject ivRange = iv.value("range"_L1).toObject();
    const QJsonArray meta2 = compact({
        u"IV:%1 · 现在 %2 → 到时 %3%4"_s.arg(labelOf(ivSourceLabel(), iv.value("source"_L1)), pct(n(iv.value("now"_L1))), pct(n(iv.value("at_target"_L1))),
                                            ivMoved ? u"(%1%2)"_s.arg(signedPct(n(iv.value("change_pct"_L1)), 0), ivWhy.isEmpty() ? QString() : u":"_s + ivWhy)
                                                    : u"(不变)"_s),
        iv.value("range"_L1).isObject() ? QJsonValue(u"半数情况下 %1 ~ %2"_s.arg(pct(n(ivRange.value("low"_L1))), pct(n(ivRange.value("high"_L1))))) : QJsonValue(),
        u"成本:"_s + labelOf(costSourceLabel(), r.value("cost_source"_L1)),
        !market.value("mid"_L1).isNull()
            ? QJsonValue(u"盘口 买 %1 / 中 %2 / 卖 %3%4"_s.arg(fmtNum(market.value("bid"_L1)), fmtNum(market.value("mid"_L1)), fmtNum(market.value("ask"_L1)),
                                                             jsTruthy(r.value("anchored"_L1)) ? u" · 已锚定"_s : QString()))
            : QJsonValue(u"没有盘口"_s),
    });

    QJsonArray scenarios;
    for (const QJsonValue& sv : arr(r.value("scenarios"_L1))) {
        const QJsonObject s = sv.toObject();
        const double ch = n(s.value("iv_change_pct"_L1));
        scenarios.append(QJsonObject{{u"cells"_s, QJsonArray{std::fabs(ch) < 0.05 ? u"不变"_s : signedPct(ch, 0), pct(n(s.value("iv"_L1))), fmtNum(s.value("value"_L1))}},
                                     {u"pnl"_s, pnlText(s)}, {u"tone"_s, tone(n(s.value("pnl"_L1)))}, {u"on"_s, jsTruthy(s.value("current"_L1))}});
    }
    QJsonArray timeline;
    const QJsonArray tl = arr(r.value("timeline"_L1));
    if (tl.size() > 1) {
        for (const QJsonValue& tv : tl) {
            const QJsonObject t = tv.toObject();
            // 到期那一刻只剩内在价值,谈不上 IV
            const QString ivText = n(t.value("epoch_ms"_L1)) >= n(r.value("expiry_ms"_L1)) ? u"—"_s : pct(n(t.value("iv"_L1)));
            timeline.append(QJsonObject{{u"cells"_s, QJsonArray{tpl(t.value("at"_L1)), ivText, fmtNum(t.value("value"_L1))}},
                                        {u"pnl"_s, pnlText(t)}, {u"tone"_s, tone(n(t.value("pnl"_L1)))}, {u"on"_s, jsTruthy(t.value("is_target"_L1))}});
        }
    }
    QJsonArray legs;
    for (const QJsonValue& lv : arr(r.value("legs"_L1))) {
        const QJsonObject l = lv.toObject();
        legs.append(QJsonArray{u"%1 %2 × %3%4"_s.arg(l.value("action"_L1) == QJsonValue(u"BUY"_s) ? u"买"_s : u"卖"_s, tpl(l.value("ratio"_L1)), tpl(l.value("strike"_L1)),
                                                      tpl(l.value("right"_L1))),
                               !l.value("ask"_L1).isNull()
                                   ? u"%1 / %2"_s.arg(l.value("bid"_L1).isNull() ? u"—"_s : fmtNum(l.value("bid"_L1)), fmtNum(l.value("ask"_L1)))
                                   : u"—"_s,
                               pct(n(l.value("iv"_L1)))});
    }
    QJsonValue modelText;
    if (r.value("iv"_L1).toObject().value("model"_L1).isObject()) {
        const bool own = jsTruthy(model.value("own"_L1));
        const QString proxy = tpl(model.value("proxy"_L1));
        modelText = u"到时的 IV 是按历史数据估的:%1 共 %2 个交易日,看标的走了一段之后%3怎么变。"_s.arg(tpl(model.value("period"_L1)), tpl(model.value("days"_L1)),
                                                                                                   own ? u"同一个行权价的 IV"_s : u" %1 "_s.arg(proxy)) +
                    u"拿没参与拟合的那段数据检验,它解释得了 IV 变化的 %1%——其余是估不出来的,所以给的是区间。"_s.arg(jsNumberToString(jsRound(n(model.value("r2_out"_L1)) * 100))) +
                    (own ? u"用的是软件自己攒下来的当日到期期权 IV。"_s : u"%1 是恒定 1 天期的指数,不是这三条腿自己的 IV。"_s.arg(proxy)) +
                    u"校准于 %1。"_s.arg(tpl(model.value("version"_L1)));
    }
    const QJsonObject exb = r.value("expiry_breakeven"_L1).toObject();
    const QJsonObject peak = r.value("peak"_L1).toObject();
    return {
        {u"tone"_s, pnl > 0 ? u"ok"_s : pnl < 0 ? u"bad"_s : u"info"_s},
        {u"title"_s, u"%1 %2/%3/%4 %5蝶 × %6 · 美东 %7 到 %8"_s.arg(tpl(r.value("symbol"_L1)), tpl(r.value("lower"_L1)), tpl(r.value("center"_L1)), tpl(r.value("upper"_L1)),
                                                                      side, tpl(r.value("quantity"_L1)), at, tpl(target.value("spot"_L1)))},
        {u"tiles"_s, tiles},
        {u"meta1"_s, meta1},
        {u"meta2"_s, meta2},
        {u"spotNote"_s, jsTruthy(r.value("spot_note"_L1)) ? QJsonValue(tpl(r.value("spot_note"_L1))) : QJsonValue()},
        {u"warnings"_s, arr(r.value("warnings"_L1))},
        {u"chart"_s, chartModel(r)},
        {u"chartMeta"_s, QJsonArray{u"%1 的盈亏平衡:%2"_s.arg(at, beText), u"到期的盈亏平衡:%1 – %2"_s.arg(tpl(exb.value("low"_L1)), tpl(exb.value("high"_L1))),
                                    u"%1 最赚的位置:%2(%3)"_s.arg(at, tpl(peak.value("spot"_L1)), signedUsd(n(peak.value("pnl"_L1))))}},
        {u"scenarios"_s, scenarios},
        {u"timelineTitle"_s, u"早到晚到:标的在不同时刻走到 "_s + tpl(target.value("spot"_L1))},
        {u"timeline"_s, timeline},
        {u"legs"_s, legs},
        {u"footMeta"_s, QJsonArray{u"算于美东 %1 · %2 到期(%3)"_s.arg(tpl(r.value("now_at"_L1)), tpl(r.value("expiry_at"_L1)),
                                                                     jsTruthy(r.value("trading_class"_L1)) ? tpl(r.value("trading_class"_L1)) : tpl(r.value("symbol"_L1))),
                                   u"不计佣金"_s, u"只算不下单"_s}},
        {u"model"_s, modelText},
    };
}

// ---- 整面 ---------------------------------------------------------------------------------------------------------

QJsonObject plannerModel(const PlannerInput& in) {
    const QJsonObject plan = in.plan;
    const QJsonObject form = plan.value("form"_L1).toObject();
    const QStringList problems = formProblems(form);
    const bool isTouched = touched(form);
    const bool hasResult = plan.value("result"_L1).isObject();
    const bool stale = hasResult && plan.value("resultFor"_L1).toString() != formKey(form);
    const bool busy = jsTruthy(plan.value("busy"_L1));
    const bool autoOn = jsTruthy(plan.value("auto"_L1));
    const QJsonObject st = in.status.toObject();

    // 现价那一行(FlySpotLine)
    const QJsonObject spot = in.spot;
    const QJsonValue quote = spot.value("quote"_L1);
    const QJsonObject q = quote.toObject();
    const QJsonValue price = q.value("price"_L1);
    const bool hasPrice = quote.isObject() && price.isDouble();
    const QString src = q.value("source"_L1).toString();
    const bool live = hasPrice && (src == u"quote" || src == u"futures");
    const QString gateway = st.value("broker_provider"_L1) == QJsonValue(u"futu"_s) ? u"OpenD"_s : u"TWS"_s;
    QString why;
    if (!jsTruthy(st.value("broker_connected"_L1))) why = u"连上 %1 之后显示"_s.arg(gateway);
    else if (spot.value("failure"_L1).isString() && !spot.value("failure"_L1).toString().isEmpty()) why = spot.value("failure"_L1).toString();
    else if (quote.isObject() && !hasPrice) why = tpl(q.value("note"_L1));
    else if (!quote.isObject()) why = u"正在取现价…"_s;
    QJsonValue levels;
    if (hasPrice && live) {
        const auto [below, above] = spot::nearLevels(price.toDouble());
        const auto signedGap = [](double points) { return (points > 0 ? u"+"_s : points < 0 ? u"−"_s : QString()) + jsToFixed(std::fabs(points), 1); };
        levels = QJsonArray{QJsonObject{{u"text"_s, u"下 "_s + jsNumberToString(below)}, {u"gap"_s, signedGap(below - price.toDouble())}, {u"level"_s, below}},
                            QJsonObject{{u"text"_s, u"上 "_s + jsNumberToString(above)}, {u"gap"_s, signedGap(above - price.toDouble())}, {u"level"_s, above}}};
    }
    QJsonValue lastHit;
    if (jsTruthy(spot.value("alertOn"_L1)) && spot.value("lastHit"_L1).isObject()) {
        const QJsonObject h = spot.value("lastHit"_L1).toObject();
        lastHit = u"· %1 %2 %3"_s.arg(localTime(n(h.value("at"_L1)), in.localZone, true), h.value("direction"_L1) == QJsonValue(u"up"_s) ? u"上穿"_s : u"下破"_s,
                                      tpl(h.value("level"_L1)));
    }
    const QJsonObject spotLine{
        {u"symbol"_s, u"SPX"_s},
        {u"price"_s, hasPrice ? jsToFixed(price.toDouble(), 2) : u"—"_s},
        {u"live"_s, live},
        {u"note"_s, src == u"futures" ? QJsonValue(u"期货推算"_s) : src == u"stale" ? QJsonValue(u"不是现价"_s) : QJsonValue()},
        {u"noteWarn"_s, src == u"stale"},
        {u"tip"_s, jsTruthy(q.value("note"_L1)) ? tpl(q.value("note"_L1)) : u"和测算用的是同一个现价,每 2 秒读一次"_s},
        {u"why"_s, why},
        {u"levels"_s, levels},
        {u"alertOn"_s, jsTruthy(spot.value("alertOn"_L1))},
        {u"alertLabel"_s, u"到 25 的整数倍时提醒"_s},
        {u"lastHit"_s, lastHit},
    };

    // 事件提醒(EventWarning)
    QJsonValue warning;
    const QJsonObject list = in.events;
    if (!list.isEmpty() && jsTruthy(list.value("config"_L1).toObject().value("enabled"_L1))) {
        QJsonArray coming;
        for (const QJsonValue& ev : events::pinnedEvents(list.value("events"_L1).toArray(), in.eventsNow).events) {
            const QJsonObject e = ev.toObject();
            const QString phase = events::phaseOf(e, in.eventsNow);
            if (e.value("impact"_L1) == QJsonValue(u"high"_s) && (phase == u"upcoming" || phase == u"soon" || phase == u"live")) coming.append(e);
        }
        if (!coming.isEmpty()) {
            const QJsonObject e = coming.first().toObject();
            QStringList rest;
            for (qsizetype i = 1; i < coming.size(); ++i) rest << tpl(coming[i][u"title"]);
            warning = QJsonObject{
                {u"title"_s, u"%1 公布 %2,%3"_s.arg(events::whenText(n(e.value("at"_L1)), in.eventsNow, in.localZone.id()), tpl(e.value("title"_L1)),
                                                     events::countdownText(e, in.eventsNow))},
                {u"text"_s, u"公布前后指数常有跳空,当日到期的蝶可能直接穿出翼。"_s + (rest.isEmpty() ? QString() : u"之后还有 %1。"_s.arg(rest.join(u"、"_s)))},
            };
        }
    }

    // 记录器那一行
    QJsonValue recorder;
    if (plan.value("recorder"_L1).isObject()) {
        const QJsonObject rec = plan.value("recorder"_L1).toObject();
        QString status = jsTruthy(rec.value("samples"_L1)) ? u"已攒 %1 天、%2 笔(%3 起)"_s.arg(tpl(rec.value("days"_L1)), tpl(rec.value("samples"_L1)), tpl(rec.value("first_date"_L1)))
                                                           : u"还没有攒下样本"_s;
        if (jsTruthy(rec.value("enabled"_L1)) && jsTruthy(rec.value("idle_reason"_L1))) status += u" · 现在没在记:"_s + tpl(rec.value("idle_reason"_L1));
        if (jsTruthy(rec.value("last_error"_L1))) status += u" · 上次出错:"_s + tpl(rec.value("last_error"_L1));
        recorder = QJsonObject{{u"enabled"_s, jsTruthy(rec.value("enabled"_L1))}, {u"label"_s, u"记录当日到期期权的 IV(%1)"_s.arg(tpl(rec.value("symbol"_L1)))},
                               {u"status"_s, status},
                               {u"hint"_s, u"现在「到时的 IV」是拿波动率指数校准的,不是期权自己的 IV——过期期权的历史行情哪儿都拿不到,只能从现在起自己记。 "
                                           u"攒够 40 个交易日之后重新校准,估出来比指数那一份准,当日到期的蝶就改用它。样本里只有行情,没有账号与持仓。"_s}};
    }

    // 输出那一块
    QJsonObject output;
    const QJsonValue failure = plan.value("failure"_L1);
    if (busy && !hasResult) {
        output = {{u"kind"_s, u"working"_s}, {u"text"_s, u"正在取现价与三条腿的行情…"_s}};
    } else if (jsTruthy(failure) && !hasResult) {
        output = {{u"kind"_s, u"failure"_s}, {u"title"_s, u"算不出来"_s}, {u"text"_s, tpl(failure)}};
    } else if (hasResult) {
        output = {{u"kind"_s, u"result"_s},
                  {u"refreshFailed"_s, jsTruthy(failure) ? QJsonValue(tpl(failure)) : QJsonValue()},
                  {u"stale"_s, stale},
                  {u"result"_s, resultModel(plan.value("result"_L1).toObject(), in.localZone)}};
    } else {
        output = {{u"kind"_s, u"empty"_s}, {u"text"_s, u"填上这只蝶、预计走到哪儿、几点到,点「测算」"_s}};
    }
    const QJsonValue at = plan.value("at"_L1);
    return {
        {u"spot"_s, spotLine},
        {u"warning"_s, warning},
        {u"form"_s, form},
        {u"chips"_s, timeChips(in.eventsNow)},
        {u"moreOpen"_s, in.moreOpen},
        {u"shift"_s, form.value("ivMode"_L1) == QJsonValue(u"shift"_s)},
        {u"recorder"_s, recorder},
        {u"canRun"_s, isTouched && problems.isEmpty()},
        {u"running"_s, busy && !autoOn},
        {u"canWrite"_s, hasResult && !stale},
        {u"writeTip"_s, stale ? u"表单改过了,先重新测算"_s : u"把这只蝶写成一句指令,放进左边的输入框(不会发单)"_s},
        {u"auto"_s, autoOn},
        {u"canAuto"_s, problems.isEmpty() && isTouched},
        {u"at"_s, present(at) && hasResult ? QJsonValue(u"算于 "_s + localTime(n(at), in.localZone, true)) : QJsonValue()},
        {u"problems"_s, isTouched && !problems.isEmpty() ? QJsonValue(problems.join(u";"_s)) : QJsonValue()},
        {u"output"_s, output},
        // 入场助手:引擎 options.entry_assist 的回执原样转给 QML(字都是引擎拼好的,见 docs/features/fly-entry-assist.md);没问过是 null
        {u"assist"_s, plan.value("assist"_L1).isObject() ? plan.value("assist"_L1) : QJsonValue()},
    };
}

namespace {

void tableTexts(const QStringList& head, const QJsonArray& rows, QStringList& out) {
    out << head;
    for (const QJsonValue& rv : rows) {
        for (const QJsonValue& c : rv[u"cells"].toArray()) out << c.toString();
        out << rv[u"pnl"].toString();
    }
}

}  // namespace

QStringList plannerTexts(const QJsonObject& m) {
    QStringList out;
    const QJsonObject s = m.value("spot"_L1).toObject();
    out << s.value("symbol"_L1).toString() << s.value("price"_L1).toString();
    if (s.value("note"_L1).isString()) out << s.value("note"_L1).toString();
    if (!s.value("why"_L1).toString().isEmpty()) out << s.value("why"_L1).toString();
    for (const QJsonValue& l : s.value("levels"_L1).toArray()) out << l[u"text"].toString() << l[u"gap"].toString();
    out << s.value("alertLabel"_L1).toString();
    if (s.value("lastHit"_L1).isString()) out << s.value("lastHit"_L1).toString();
    if (m.value("warning"_L1).isObject()) out << m.value("warning"_L1)[u"title"].toString() << m.value("warning"_L1)[u"text"].toString();
    out << u"中心行权价"_s << u"翼宽(点)"_s << u"方向"_s << u"自动"_s << u"看涨"_s << u"看跌"_s << u"张数"_s << u"成本(权利金)"_s;
    out << u"预计走到(点位)"_s << u"预计几点到(美东)"_s;
    for (const QJsonValue& c : m.value("chips"_L1).toArray()) out << c.toArray().at(0).toString();
    out << u"更多:日期与到期日、手动现价与 IV、到时的 IV 怎么算"_s;
    if (m.value("moreOpen"_L1).toBool()) {
        out << u"哪一天到"_s << u"到期日"_s << u"现价"_s << u"IV(%)"_s << u"到时的 IV"_s << u"自动"_s << u"不变"_s << u"自己填"_s;
        if (m.value("shift"_L1).toBool()) out << u"IV 变化(%)"_s;
        out << u"IV 会变:标的跌,IV 升;标的涨,IV 降。「自动」用的是拿两年多历史数据校准的模型,它解释得了 IV 变化的三成左右,所以结果里除了一个数,还有「半数情况下」的区间和各档 IV 下的数。"_s
            << u"现价与 IV 都手动填了,就不取任何行情:没连券商、休市时也能算。"_s;
        if (m.value("recorder"_L1).isObject()) {
            const QJsonObject r = m.value("recorder"_L1).toObject();
            out << r.value("label"_L1).toString() << r.value("status"_L1).toString() << r.value("hint"_L1).toString();
        }
    }
    out << u"测算"_s << u"写进指令"_s << u"跟着行情刷新"_s << u"清空"_s;
    if (m.value("at"_L1).isString()) out << m.value("at"_L1).toString();
    if (m.value("problems"_L1).isString()) out << m.value("problems"_L1).toString();
    const QJsonObject o = m.value("output"_L1).toObject();
    const QString kind = o.value("kind"_L1).toString();
    if (kind == u"working" || kind == u"empty") return out << o.value("text"_L1).toString();
    if (kind == u"failure") return out << o.value("title"_L1).toString() << o.value("text"_L1).toString();
    if (o.value("refreshFailed"_L1).isString()) out << u"刚才那次刷新没成功,下面是上一次的结果"_s << o.value("refreshFailed"_L1).toString();
    if (o.value("stale"_L1).toBool()) out << u"表单改过了,下面是改之前的结果。点「测算」重算。"_s;
    const QJsonObject r = o.value("result"_L1).toObject();
    out << r.value("title"_L1).toString();
    for (const QJsonValue& t : r.value("tiles"_L1).toArray()) out << t[u"label"].toString() << statisticParts(t[u"value"].toString());
    for (const QJsonValue& x : r.value("meta1"_L1).toArray()) out << x.toString();
    for (const QJsonValue& x : r.value("meta2"_L1).toArray()) out << x.toString();
    if (r.value("spotNote"_L1).isString()) out << r.value("spotNote"_L1).toString();
    if (!r.value("warnings"_L1).toArray().isEmpty()) {
        out << u"要留意的"_s;
        for (const QJsonValue& w : r.value("warnings"_L1).toArray()) out << jsString(w);
    }
    out << u"盈亏曲线"_s;
    const QJsonObject c = r.value("chart"_L1).toObject();
    if (!c.isEmpty()) {
        for (const QJsonValue& k : c.value("strikes"_L1).toArray()) out << k[u"label"].toString();
        if (c.value("spot"_L1).isObject()) out << c.value("spot"_L1)[u"label"].toString();
        if (c.value("target"_L1).isObject()) out << c.value("target"_L1)[u"label"].toString();
        out << c.value("cost"_L1)[u"label"].toString();
        for (const QJsonValue& l : c.value("legend"_L1).toArray()) out << l.toString();
        out << u"纵轴:每份净价(点);虚线以上是赚"_s;
    }
    for (const QJsonValue& x : r.value("chartMeta"_L1).toArray()) out << x.toString();
    out << u"IV 变了会怎样"_s << u"同一个目标点位与时刻,到时的 IV 不同,这只蝶值的也不同。标出来的那一行是上面用的。"_s;
    tableTexts({u"IV 变化"_s, u"到时 IV"_s, u"蝶价"_s, u"盈亏"_s}, r.value("scenarios"_L1).toArray(), out);
    if (!r.value("timeline"_L1).toArray().isEmpty()) {
        out << r.value("timelineTitle"_L1).toString();
        tableTexts({u"到达(美东)"_s, u"那时的 IV"_s, u"蝶价"_s, u"盈亏"_s}, r.value("timeline"_L1).toArray(), out);
    }
    out << u"三条腿"_s << u"腿"_s << u"买价 / 卖价"_s << u"IV"_s;
    for (const QJsonValue& l : r.value("legs"_L1).toArray())
        for (const QJsonValue& cell : l.toArray()) out << cell.toString();
    for (const QJsonValue& x : r.value("footMeta"_L1).toArray()) out << x.toString();
    if (r.value("model"_L1).isString()) out << r.value("model"_L1).toString();
    return out;
}

// ---- 日内剧本 ----------------------------------------------------------------------------------------------------

QJsonObject playbookModel(const PlaybookInput& in) {
    const QJsonObject pb = in.playbook;
    const QJsonValue snapV = pb.value("snap"_L1);
    if (!snapV.isObject()) {
        const QJsonValue f = pb.value("failure"_L1);
        return {{u"empty"_s, f.isString() && !f.toString().isEmpty() ? f.toString() : u"正在读日内剧本…"_s}};
    }
    const QJsonObject snap = snapV.toObject();
    const QJsonObject st = in.status.toObject();
    const QString gateway = st.value("broker_provider"_L1) == QJsonValue(u"futu"_s) ? u"OpenD"_s : u"TWS"_s;
    const QString why = !jsTruthy(st.value("broker_connected"_L1)) ? u"连上 %1 之后开始"_s.arg(gateway) : jsString(snap.value("idle_reason"_L1));
    const bool hasWhy = !jsTruthy(st.value("broker_connected"_L1)) || jsTruthy(snap.value("idle_reason"_L1));
    const QString state = snap.value("state"_L1).toString();
    const bool active = state == u"B2" || state == u"B3";
    const QJsonValue price = snap.value("price"_L1);
    const auto line = [&](const QString& label, const QJsonValue& level, const QString& hint) {
        QJsonObject l{{u"label"_s, label}, {u"level"_s, playbook::fmtLevel(level)}, {u"hint"_s, hint}};
        if (!level.isNull() && !level.isUndefined() && !price.isNull() && !price.isUndefined()) l.insert(u"gap"_s, playbook::fmtGap(level, price));
        return l;
    };
    QJsonArray lines;
    QJsonValue rearm;
    if (active) {
        lines.append(line(u"触发线"_s, snap.value("trigger"_L1),
                          state == u"B2" ? u"进入时的那条线:取到新一格(每 5 分钟)时现价在它下方就失效;格子中间刺下去又回来不算"_s : u"进入时的那条线:现价收回它上方就失效"_s));
        lines.append(line(u"T1"_s, snap.value("t1"_L1), u"盘初区间的边:B2 是上沿,B3 是下沿"_s));
        lines.append(line(u"T2"_s, snap.value("t2"_L1), u"B2:T1 上方最近的正 gamma 行权价;B3:T1 下方的下一档行权价"_s));
    } else {
        const QJsonObject ls = snap.value("lines"_L1).toObject();
        lines.append(line(u"B2 触发:站上"_s, ls.value("b2"_L1),
                          u"今日区间的上沿:09:35 的锚 + 当前剩余的预期波动。锚整天不动,半宽每 5 分钟按最新的跨式重取;B2 也是每次取到新一格时判一次(那一刻现价在它之上才算),格子中间刺上去又回来不算"_s));
        lines.append(line(u"B3 触发:跌破"_s, ls.value("b3"_L1), u"昨日定价区间的下沿:每一笔现价都判"_s));
        // b2_lost != null:undefined 与 null 都不写
        const QJsonValue lost = snap.value("b2_lost"_L1);
        if (!lost.isNull() && !lost.isUndefined()) rearm = playbook::rearmText(lost);
    }
    QJsonArray bands;
    for (const QJsonValue& rv : playbook::bandRows(snap)) {
        const QJsonObject row = rv.toObject();
        const QJsonValue bv = row.value("band"_L1);
        const QJsonObject b = bv.toObject();
        const bool has = bv.isObject();
        const bool derived = row.value("derived"_L1).toBool();
        QString when = has && !derived ? u"%1 · %2"_s.arg(playbook::etTime(b.value("at"_L1)), jsString(b.value("strike"_L1))) : row.value("when"_L1).toString();
        bands.append(QJsonObject{
            {u"dim"_s, !has},
            {u"label"_s, row.value("label"_L1)},
            {u"when"_s, when},
            {u"backfill"_s, has && b.value("source"_L1) == QJsonValue(u"backfill"_s)},
            {u"anchor"_s, playbook::fmtLevel(has ? b.value("anchor"_L1) : QJsonValue(QJsonValue::Undefined))},
            {u"straddle"_s, has && !derived ? u"%1 + %2"_s.arg(jsToFixed(n(b.value("call"_L1)), 2), jsToFixed(n(b.value("put"_L1)), 2)) : u"—"_s},
            {u"em"_s, has ? u"±"_s + jsToFixed(n(b.value("em"_L1)), 2) : u"—"_s},
            {u"range"_s, has ? u"%1 – %2"_s.arg(playbook::fmtLevel(b.value("lower"_L1)), playbook::fmtLevel(b.value("upper"_L1))) : u"—"_s},
        });
    }
    QJsonValue wall;
    if (snap.value("wall"_L1).isObject()) {
        const QJsonObject w = snap.value("wall"_L1).toObject();
        const QJsonValue accel = snap.value("accel"_L1);
        const auto strikeOf = [](const QJsonValue& v) { return v.isObject() ? jsString(v.toObject().value("strike"_L1)) : u"—"_s; };
        wall = QJsonArray{
            QJsonObject{{u"text"_s, u"看涨墙 "_s + strikeOf(w.value("call_wall"_L1))}, {u"tip"_s, u"现价上方未平仓量最大的看涨行权价"_s}},
            QJsonObject{{u"text"_s, u"看跌墙 "_s + strikeOf(w.value("put_wall"_L1))}, {u"tip"_s, u"现价下方未平仓量最大的看跌行权价"_s}},
            QJsonObject{{u"text"_s, u"Gamma 翻转 "_s + (w.value("gamma_flip"_L1).isNull() ? u"—"_s : playbook::fmtLevel(w.value("gamma_flip"_L1)))},
                        {u"tip"_s, u"净 gamma 变号的价位里离现价最近的那个:越过它,正负 gamma 换边。取到的行权价范围里不变号、或推算它的那条曲线在现价处的正负和净 gamma 对不上,就不给"_s}},
            QJsonObject{{u"text"_s, u"%1 · %2"_s.arg(playbook::gexText(w), playbook::kGexAssumption)}, {u"tip"_s, u""_s}},
            QJsonObject{{u"text"_s, u"加速档 "_s + strikeOf(accel)}, {u"tip"_s, u"当前剩余区间(现价 ± 剩余预期波动)里负 gamma 最大的行权价:穿过它时走势容易加速"_s}},
            QJsonObject{{u"text"_s, u"期权墙取于美东 %1 · %2"_s.arg(playbook::etTime(w.value("at"_L1)), playbook::coverageText(w.value("coverage"_L1), w.value("oi_missing"_L1)))},
                        {u"tip"_s, u"行情线路有限:要盖住剧本的每一条线,远处的行权价只取整数档"_s}, {u"muted"_s, true}},
        };
    }
    QJsonArray notes;
    for (const QJsonValue& note : arr(snap.value("notes"_L1))) notes.append(jsString(note));
    if (jsTruthy(snap.value("last_error"_L1))) notes.append(u"上一轮出错:"_s + jsString(snap.value("last_error"_L1)));
    QJsonArray events;
    const QJsonArray evs = arr(snap.value("events"_L1));
    const QString symbol = jsString(snap.value("symbol"_L1));
    for (qsizetype i = evs.size() - 1; i >= 0; --i) {
        const QJsonObject e = evs[i].toObject();
        events.append(QJsonObject{{u"at"_s, playbook::etTime(e.value("at"_L1))}, {u"title"_s, playbook::eventTitle(symbol, e)}, {u"price"_s, playbook::fmtLevel(e.value("price"_L1))}});
    }
    return {
        {u"symbol"_s, symbol},
        {u"price"_s, playbook::fmtLevel(price)},
        {u"live"_s, !price.isNull() && !hasWhy},
        {u"state"_s, state},
        {u"stateLabel"_s, playbook::stateLabel().value(state)},
        {u"stateHint"_s, playbook::stateHint().value(state)},
        {u"since"_s, active && !snap.value("since"_L1).isNull() ? QJsonValue(u"美东 %1 起"_s.arg(playbook::etTime(snap.value("since"_L1)))) : QJsonValue()},
        {u"why"_s, hasWhy ? QJsonValue(why) : QJsonValue()},
        {u"alertOn"_s, jsTruthy(pb.value("alertOn"_L1))},
        {u"lines"_s, lines},
        {u"rearm"_s, rearm},
        {u"bands"_s, bands},
        {u"wall"_s, wall},
        {u"notes"_s, notes},
        {u"events"_s, events},
        {u"enabled"_s, jsTruthy(snap.value("enabled"_L1))},
    };
}

QStringList playbookTexts(const QJsonObject& m) {
    if (m.contains(u"empty"_s)) return {m.value("empty"_L1).toString()};
    QStringList out{m.value("symbol"_L1).toString(), m.value("price"_L1).toString(), m.value("stateLabel"_L1).toString()};
    if (m.value("since"_L1).isString()) out << m.value("since"_L1).toString();
    if (m.value("why"_L1).isString()) out << m.value("why"_L1).toString();
    out << u"过线时提醒"_s;
    for (const QJsonValue& l : m.value("lines"_L1).toArray()) {
        out << l[u"label"].toString() << l[u"level"].toString();
        if (l[u"gap"].isString()) out << l[u"gap"].toString();
    }
    if (m.value("rearm"_L1).isString()) out << m.value("rearm"_L1).toString();
    out << u"口径"_s << u"取价"_s << u"锚"_s << u"跨式(涨 + 跌)"_s << u"预期波动"_s << u"区间"_s;
    for (const QJsonValue& b : m.value("bands"_L1).toArray()) {
        out << b[u"label"].toString() << b[u"when"].toString();
        if (b[u"backfill"].toBool()) out << u"补"_s;
        out << b[u"anchor"].toString() << b[u"straddle"].toString() << b[u"em"].toString() << b[u"range"].toString();
    }
    for (const QJsonValue& w : m.value("wall"_L1).toArray()) out << w[u"text"].toString();
    for (const QJsonValue& x : m.value("notes"_L1).toArray()) out << x.toString();
    const QJsonArray events = m.value("events"_L1).toArray();
    if (events.isEmpty()) out << u"今天还没有报过事件。"_s;
    for (const QJsonValue& e : events) out << e[u"at"].toString() << e[u"title"].toString() << e[u"price"].toString();
    out << u"区间怎么算、状态怎么判、哪些还没做"_s;
    return out;
}

}  // namespace ibkr::shell::fly
