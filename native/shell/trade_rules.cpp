#include "shell/trade_rules.h"

#include "engine/util/jsnum.h"
#include "shell/jsvalue.h"
#include "shell/track_rules.h"

#include <QJsonDocument>
#include <QSet>

#include <algorithm>
#include <cmath>

namespace ibkr::shell::trade {

using namespace Qt::StringLiterals;

namespace {

/// 模板字符串里的 ${v}:undefined / null 照写出来(同 JS)
QString tpl(const QJsonValue& v) { return jsString(v); }

/// React 渲染一个子节点:字符串与数照写,别的(undefined / null / 布尔)什么都不画
std::optional<QString> child(const QJsonValue& v) {
    if (v.isString()) return v.toString();
    if (v.isDouble()) return jsNumberToString(v.toDouble());
    return std::nullopt;
}

bool isFiniteNumber(const QJsonValue& v) { return v.isDouble() && std::isfinite(v.toDouble()); }

/// a != null(undefined 与 null 之外都算有)
bool present(const QJsonValue& v) { return !v.isUndefined() && !v.isNull(); }

QJsonArray arrayOr(const QJsonValue& v) { return v.isArray() ? v.toArray() : QJsonArray{}; }

const QHash<QString, QString>& comboName() {
    static const QHash<QString, QString> m{{u"VERTICAL"_s, u"垂直价差"_s}, {u"BUTTERFLY"_s, u"蝴蝶"_s}, {u"IRON_CONDOR"_s, u"铁鹰"_s}};
    return m;
}
const QHash<QString, QString>& orderTypeName() {
    static const QHash<QString, QString> m{{u"MKT"_s, u"市价"_s}, {u"LMT"_s, u"限价"_s}, {u"STP"_s, u"止损"_s}, {u"STP LMT"_s, u"止损限价"_s}, {u"TRAIL"_s, u"跟踪止损"_s}};
    return m;
}

// lib/labels.ts 的两张词表(tst_trade_rules 拿它们和原文件的逐项对)
const QHash<QString, QString>& rejectCodeLabel() {
    static const QHash<QString, QString> m{
        {u"MISSING_QUANTITY"_s, u"没写数量"_s}, {u"MISSING_PRICE"_s, u"没写价格"_s}, {u"AMBIGUOUS_SYMBOL"_s, u"标的不明确"_s},
        {u"INCOMPLETE_OPTION"_s, u"期权要素不全"_s}, {u"UNCLEAR"_s, u"指令读不清"_s}, {u"LOW_CONFIDENCE"_s, u"解析把握不够"_s},
        {u"UNKNOWN_ACCOUNT"_s, u"账户别名不认识"_s}, {u"LIVE_TRADING_DISABLED"_s, u"未允许实盘下单"_s}, {u"EXCEEDS_LIMIT"_s, u"超出风控限额"_s},
        {u"BAD_SPREAD"_s, u"价差结构不对"_s}, {u"TRIGGER_MISMATCH"_s, u"触发方向不对"_s}, {u"AMBIGUOUS_TRIGGER"_s, u"触发条件有歧义"_s},
        {u"EXPIRED_CONTRACT"_s, u"合约已过期"_s}, {u"MARKET_CLOSED"_s, u"当前时段不能交易"_s}, {u"DUPLICATE_ORDER"_s, u"疑似重复下单"_s},
        {u"UNSUPPORTED"_s, u"暂不支持这种单"_s}, {u"UNPRICEABLE"_s, u"这笔单估不出价"_s}, {u"LLM_ERROR"_s, u"模型调用失败"_s},
        {u"BAD_PAYLOAD"_s, u"模型返回不合规"_s}, {u"BREAKER_ENGAGED"_s, u"已熔断"_s}, {u"IBKR_ERROR"_s, u"IBKR 报错"_s}, {u"FUTU_ERROR"_s, u"富途报错"_s},
    };
    return m;
}
const QHash<QString, QString>& rejectSourceLabel() {
    static const QHash<QString, QString> m{{u"llm"_s, u"模型拒绝"_s}, {u"validator"_s, u"校验拒绝"_s}, {u"engine"_s, u"引擎拦下"_s}, {u"broker"_s, u"券商错误"_s}};
    return m;
}

/// labels.ts 的 say:null / undefined / '' 是 null;查不到照原样
std::optional<QString> say(const QHash<QString, QString>& map, const QJsonValue& value) {
    if (value.isNull() || value.isUndefined() || value == QJsonValue(u""_s)) return std::nullopt;
    const QString key = jsString(value);
    const auto it = map.constFind(key);
    return it != map.cend() && !it->isEmpty() ? *it : key;
}

QString resultLabel(const QJsonValue& r) {
    static const QHash<QString, QString> m{{u"win"_s, u"赚"_s}, {u"loss"_s, u"亏"_s}, {u"flat"_s, u"持平"_s}, {u"open"_s, u"未了结"_s}, {u"unknown"_s, u"结果不明"_s}};
    const auto it = m.constFind(jsString(r));
    return it != m.cend() ? *it : u"undefined"_s;
}

/// lib/tradeFacts.ts 的 tradeText
QString tradeText(const QJsonObject& t) {
    const QJsonValue rp = t.value("return_pct"_L1);
    // 原版只认 === null:没给(undefined)照样写出「 undefined%」
    const QString pct = rp.isNull() ? QString() : u" %1%2%"_s.arg(jsNumber(rp) > 0 ? u"+"_s : QString(), tpl(rp));
    const QJsonValue pp = t.value("pnl_points"_L1);
    const QString pts = present(pp) ? u" %1%2 点/份"_s.arg(jsNumber(pp) > 0 ? u"+"_s : QString(), tpl(pp)) : QString();
    const QJsonValue note = t.value("note"_L1);
    return u"%1 %2%3:%4%5%6%7"_s.arg(t.value("opened_at"_L1).toString().left(10), tpl(t.value("label"_L1)),
                                    jsTruthy(t.value("paper"_L1)) ? u"(模拟)"_s : QString(), resultLabel(t.value("result"_L1)), pct, pts,
                                    jsTruthy(note) ? u"(%1)"_s.arg(tpl(note)) : QString());
}

QString tally(const QJsonObject& x) {
    QStringList parts{u"赚 %1"_s.arg(tpl(x.value("win"_L1))), u"亏 %1"_s.arg(tpl(x.value("loss"_L1)))};
    if (jsTruthy(x.value("flat"_L1))) parts << u"持平 %1"_s.arg(tpl(x.value("flat"_L1)));
    if (jsTruthy(x.value("open"_L1))) parts << u"未了结 %1"_s.arg(tpl(x.value("open"_L1)));
    if (jsTruthy(x.value("unknown"_L1))) parts << u"结果不明 %1"_s.arg(tpl(x.value("unknown"_L1)));
    return parts.join(u" · "_s);
}

QString priceText(const QJsonObject& t) {
    const QString type = t.value("order_type"_L1).toString();
    if (type == u"MKT") return u"市价"_s;
    if (t.value("price_mode"_L1) == QJsonValue(u"AUTO_MID"_s)) return u"中间价"_s;
    if (type == u"TRAIL") {
        const QJsonValue pct = t.value("trailing_percent"_L1);
        return present(pct) ? u"%1%"_s.arg(tpl(pct)) : track::fmtMoney(t.value("aux_price"_L1));
    }
    if (type == u"STP") return track::fmtMoney(t.value("aux_price"_L1));
    return track::fmtMoney(t.value("limit_price"_L1));
}

struct Frame {
    double xMin = 0, xMax = 0, wing = 0;
};

/// PayoffChart / PayoffAxis 共用的横轴范围(两处写法略有不同:图按现价的条件分两层写,刻度合成一行,结果一样)
Frame frameOf(const QList<double>& sortedStrikes, const QJsonValue& spot) {
    const double lo = sortedStrikes.first();
    const double hi = sortedStrikes.last();
    Frame f;
    f.wing = hi > lo ? (hi - lo) * 0.6 : std::max(lo * 0.06, 1.0);
    f.xMin = lo - f.wing;
    f.xMax = hi + f.wing;
    if (isFiniteNumber(spot)) {
        const double s = spot.toDouble();
        // 现价离得太远就不为它把图压扁:超出两倍翼宽的,只在边上标一个箭头
        if (s > f.xMin - f.wing * 2 && s < f.xMax + f.wing * 2) {
            f.xMin = std::min(f.xMin, s - f.wing * 0.3);
            f.xMax = std::max(f.xMax, s + f.wing * 0.3);
        }
    }
    return f;
}

double intrinsic(const QJsonArray& legs, double s) {
    double v = 0;
    for (const QJsonValue& lv : legs) {
        const QJsonObject l = lv.toObject();
        const double k = jsNumber(l.value("strike"_L1));
        const double raw = l.value("right"_L1) == QJsonValue(u"C"_s) ? std::max(0.0, s - k) : std::max(0.0, k - s);
        const double ratio = jsTruthy(l.value("ratio"_L1)) ? jsNumber(l.value("ratio"_L1)) : 1;
        v += jsNumber(l.value("sign"_L1)) * ratio * raw;
    }
    return v;
}

}  // namespace

QString tradeFactText(const QJsonObject& fact) { return tradeText(fact); }

// ---- 发单账户 ---------------------------------------------------------------------------------------------------

QStringList pickAccounts(const QJsonArray& usable, const std::optional<QStringList>& saved) {
    if (usable.isEmpty()) return {};
    QJsonObject fallback = usable.first().toObject();
    for (const QJsonValue& a : usable) {
        if (jsTruthy(a.toObject().value("default"_L1))) {
            fallback = a.toObject();
            break;
        }
    }
    const QString fallbackAlias = jsString(fallback.value("alias"_L1));
    if (usable.size() == 1 || !saved) return {fallbackAlias};
    QSet<QString> aliases;
    for (const QJsonValue& a : usable) aliases.insert(jsString(a.toObject().value("alias"_L1)));
    QStringList kept;
    for (const QString& alias : *saved)
        if (aliases.contains(alias)) kept << alias;
    return !kept.isEmpty() || saved->isEmpty() ? kept : QStringList{fallbackAlias};
}

std::optional<QStringList> readPicked(const std::optional<QString>& raw) {
    // JSON.parse(raw || 'null'):空串与没存都是 null;解析失败当没存过
    if (!raw || raw->isEmpty()) return std::nullopt;
    QJsonParseError err;
    const QJsonDocument doc = QJsonDocument::fromJson(raw->toUtf8(), &err);
    if (err.error != QJsonParseError::NoError || !doc.isArray()) return std::nullopt;
    QStringList out;
    for (const QJsonValue& v : doc.array()) out << jsString(v);
    return out;
}

QJsonArray pickableAccounts(const QJsonValue& status) {
    const QJsonObject st = status.toObject();
    if (!status.isObject() || !st.value("accounts"_L1).isArray()) return {};
    const QJsonValue p = st.value("broker_provider"_L1);
    const QString provider = jsTruthy(p) ? jsString(p) : u"ibkr"_s;
    QJsonArray out;
    for (const QJsonValue& a : st.value("accounts"_L1).toArray()) {
        const QJsonValue b = a.toObject().value("broker"_L1);
        if ((jsTruthy(b) ? jsString(b) : u"ibkr"_s) == provider) out.append(a);
    }
    return out;
}

QString gatewayName(const QJsonValue& status) {
    return status.toObject().value("broker_provider"_L1) == QJsonValue(u"futu"_s) ? u"OpenD"_s : u"TWS"_s;
}

QString brokerShortName(const QJsonValue& status) {
    return status.toObject().value("broker_provider"_L1) == QJsonValue(u"futu"_s) ? u"富途"_s : u"IBKR"_s;
}

// ---- 输入框 -----------------------------------------------------------------------------------------------------

QString appendInstruction(const QString& text, const QString& line) {
    if (jsTrim(text).isEmpty()) return line;
    qsizetype e = text.size();
    while (e > 0 && util::isJsWhitespace(text.at(e - 1))) --e;
    return text.left(e) + u'\n' + line;
}

Inserted insertSnippet(const QString& text, int start, int end, const QString& snippet) {
    const bool atTail = start == text.size();
    const QString sep = atTail && !text.isEmpty() && !text.endsWith(u'\n') && !snippet.startsWith(u',') ? u"\n"_s : QString();
    return {text.left(start) + sep + snippet + text.mid(end), int(start + sep.size() + snippet.size())};
}

QJsonArray shorthandChips() {
    // 期权速记:内容与提示词的既定偏好逐条同源,不在这里发明任何解析器不认识的规则
    return {
        QJsonArray{u"1.8 挂15蝴蝶 15CM"_s, u"1.8 挂15蝴蝶 15CM"_s},
        QJsonArray{u"7520的20cm蝴蝶"_s, u"7520的20cm蝴蝶"_s},
        QJsonArray{u"call spread"_s, u"开一张今天的 7520 7550 call spread"_s},
        QJsonArray{u"卖出铁鹰"_s, u"卖出 7200/7250/7650/7700 铁鹰"_s},
        QJsonArray{u"权利金上限"_s, u",权利金不超过 "_s},
        QJsonArray{u"补理由"_s, u",理由:"_s},
    };
}

// ---- 损益图 -----------------------------------------------------------------------------------------------------

QJsonArray payoffLegs(const QJsonObject& t) {
    const QString sec = t.value("sec_type"_L1).toString();
    const QJsonValue strike = t.value("strike"_L1);
    const QJsonValue right = t.value("right"_L1);
    if (sec == u"OPT" && present(strike) && jsTruthy(right))
        return {QJsonObject{{u"sign"_s, t.value("action"_L1) == QJsonValue(u"SELL"_s) ? -1 : 1}, {u"right"_s, right}, {u"strike"_s, strike}}};
    if (sec != u"BAG") return {};
    QJsonArray out;
    for (const QJsonValue& lv : arrayOr(t.value("legs"_L1))) {
        const QJsonObject l = lv.toObject();
        QJsonObject leg{{u"sign"_s, l.value("action"_L1) == QJsonValue(u"BUY"_s) ? 1 : -1}, {u"right"_s, l.value("right"_L1)}, {u"strike"_s, l.value("strike"_L1)}};
        if (!l.value("ratio"_L1).isUndefined()) leg.insert(u"ratio"_s, l.value("ratio"_L1));
        out.append(leg);
    }
    return out;
}

QJsonObject payoffChart(const QJsonArray& legs, const QJsonValue& premium, const QJsonValue& spot) {
    if (legs.isEmpty()) return {};
    QList<double> strikes;
    for (const QJsonValue& l : legs) strikes << jsNumber(l.toObject().value("strike"_L1));
    std::sort(strikes.begin(), strikes.end());
    const Frame f = frameOf(strikes, spot);
    const double cost = isFiniteNumber(premium) ? premium.toDouble() : 0;
    QList<double> xs{f.xMin};
    xs << strikes << f.xMax;
    std::sort(xs.begin(), xs.end());
    xs.erase(std::unique(xs.begin(), xs.end()), xs.end());
    QList<std::pair<double, double>> pts;
    double vMin = 0, vMax = 0;
    for (double s : xs) {
        const double v = intrinsic(legs, s) - cost;
        pts.append({s, v});
        vMin = std::min(vMin, v);
        vMax = std::max(vMax, v);
    }
    const double span = vMax - vMin;
    const double vSpan = span != 0 && !std::isnan(span) ? span : 1;
    constexpr double W = 600, H = 120, padT = 10, padB = 22;
    const auto X = [&](double s) { return ((s - f.xMin) / (f.xMax - f.xMin)) * W; };
    const auto Y = [&](double v) { return padT + (1 - (v - vMin) / vSpan) * (H - padT - padB); };
    const double zeroY = Y(0);
    QStringList line;
    QJsonArray points;
    for (qsizetype i = 0; i < pts.size(); ++i) {
        const double x = X(pts[i].first), y = Y(pts[i].second);
        line << u"%1%2 %3"_s.arg(i ? u"L"_s : u"M"_s, jsToFixed(x, 1), jsToFixed(y, 1));
        points.append(QJsonObject{{u"x"_s, x}, {u"y"_s, y}});
    }
    const QString d = line.join(u' ');
    QJsonArray ticks;
    for (double k : strikes) ticks.append(X(k));
    const bool spotIn = isFiniteNumber(spot) && spot.toDouble() >= f.xMin && spot.toDouble() <= f.xMax;
    // 刻度:去重后的行权价;现价在图里时多一个「现价」
    QList<double> uniq = strikes;
    uniq.erase(std::unique(uniq.begin(), uniq.end()), uniq.end());
    const Frame af = frameOf(uniq, spot);
    const auto frac = [&](double s) { return ((s - af.xMin) / (af.xMax - af.xMin)); };
    QJsonArray axis;
    for (double k : uniq)
        axis.append(QJsonObject{{u"left"_s, frac(k)}, {u"leftText"_s, jsToFixed(frac(k) * 100, 2) + u'%'}, {u"text"_s, jsNumberToString(k)}, {u"spot"_s, false}});
    const bool axisSpot = isFiniteNumber(spot) && spot.toDouble() >= af.xMin && spot.toDouble() <= af.xMax;
    if (axisSpot)
        axis.append(QJsonObject{{u"left"_s, frac(spot.toDouble())}, {u"leftText"_s, jsToFixed(frac(spot.toDouble()) * 100, 2) + u'%'},
                                {u"text"_s, u"现价 "_s + jsToFixed(spot.toDouble(), 2)}, {u"spot"_s, true}});
    return {
        {u"width"_s, W},
        {u"height"_s, H},
        {u"points"_s, points},
        {u"zeroY"_s, zeroY},
        {u"ticks"_s, ticks},
        {u"tickY1"_s, H - padB + 2},
        {u"tickY2"_s, H - padB + 7},
        {u"spotX"_s, spotIn ? QJsonValue(X(spot.toDouble())) : QJsonValue()},
        {u"spotY1"_s, 4},
        {u"spotY2"_s, H - padB + 2},
        {u"d"_s, QJsonObject{{u"line"_s, d}, {u"area"_s, u"%1 L%2 %3 L0 %3 Z"_s.arg(d, jsNumberToString(W), jsToFixed(zeroY, 1))}}},
        {u"axis"_s, axis},
    };
}

// ---- 票据与结果卡片 --------------------------------------------------------------------------------------------

bool isTicket(const QJsonValue& v) {
    return v.isObject() && v.toObject().value("symbol"_L1).isString() && v.toObject().value("action"_L1).isString();
}

QJsonObject ticketModel(const QJsonObject& t) {
    const bool buy = t.value("action"_L1) == QJsonValue(u"BUY"_s);
    const QString sec = t.value("sec_type"_L1).toString();
    const QJsonArray legs = payoffLegs(t);
    // 建仓付出的净权利金:买入付、卖出收。只有明确给了限价才画得出盈亏平衡,市价 / 中间价只画形状
    const QJsonValue lp = t.value("limit_price"_L1);
    const QJsonValue premium = present(lp) && t.value("order_type"_L1) == QJsonValue(u"LMT"_s) ? QJsonValue(buy ? jsNumber(lp) : -jsNumber(lp)) : QJsonValue();
    QString kind;
    if (sec == u"BAG") {
        const QJsonValue cs = t.value("combo_strategy"_L1);
        kind = comboName().value(jsTruthy(cs) ? jsString(cs) : QString(), u"组合"_s);
    } else if (sec == u"OPT") {
        kind = t.value("right"_L1) == QJsonValue(u"C"_s) ? u"看涨期权"_s : u"看跌期权"_s;
    } else {
        kind = u"正股"_s;
    }
    QString sub = kind;
    if (sec == u"OPT" && present(t.value("strike"_L1))) sub += u" · %1%2"_s.arg(tpl(t.value("strike"_L1)), tpl(t.value("right"_L1)));
    if (jsTruthy(t.value("expiry"_L1))) {
        const std::optional<QString> e = track::fmtExpiry(t.value("expiry"_L1));
        sub += u" · "_s + (e ? *e : u"null"_s);
    }
    const QString type = jsString(t.value("order_type"_L1));
    const QJsonValue tif = t.value("tif"_L1);
    QString typeText = orderTypeName().value(type);
    if (typeText.isEmpty()) typeText = child(t.value("order_type"_L1)).value_or(QString());
    if (jsTruthy(tif) && tif != QJsonValue(u"DAY"_s)) typeText += u" · "_s + tpl(tif);
    QJsonObject m{
        {u"badge"_s, jsString(t.value("symbol"_L1)).left(5)},
        {u"symbol"_s, t.value("symbol"_L1)},
        {u"buy"_s, buy},
        {u"sideText"_s, buy ? u"买入"_s : u"卖出"_s},
        {u"sub"_s, sub},
        {u"quantity"_s, child(t.value("quantity"_L1)).value_or(QString())},
        {u"unit"_s, sec == u"STK" ? u"股"_s : sec == u"BAG" ? u"组"_s : u"张"_s},
        {u"price"_s, priceText(t)},
        {u"typeText"_s, typeText},
    };
    const QJsonObject trig = t.value("trigger"_L1).toObject();
    m.insert(u"trigger"_s, jsTruthy(t.value("trigger"_L1))
                               ? QJsonValue(u"%1 %2 %3 时触发"_s.arg(tpl(trig.value("symbol"_L1)), tpl(trig.value("operator"_L1)), tpl(trig.value("value"_L1))))
                               : QJsonValue());
    if (legs.isEmpty()) {
        m.insert(u"legPills"_s, QJsonValue());
        m.insert(u"payoff"_s, QJsonValue());
        return m;
    }
    if (sec == u"BAG") {
        QList<QJsonObject> sorted;
        for (const QJsonValue& l : legs) sorted << l.toObject();
        std::stable_sort(sorted.begin(), sorted.end(), [](const QJsonObject& a, const QJsonObject& b) {
            return jsNumber(a.value("strike"_L1)) < jsNumber(b.value("strike"_L1));
        });
        QJsonArray pills;
        for (const QJsonObject& l : sorted) {
            const bool up = jsNumber(l.value("sign"_L1)) > 0;
            const QJsonValue ratio = l.value("ratio"_L1);
            pills.append(QJsonObject{{u"up"_s, up},
                                     {u"text"_s, u"%1%2 · %3%4"_s.arg(up ? u"+"_s : u"−"_s, jsTruthy(ratio) ? tpl(ratio) : u"1"_s, tpl(l.value("strike"_L1)), tpl(l.value("right"_L1)))}});
        }
        m.insert(u"legPills"_s, pills);
    } else {
        m.insert(u"legPills"_s, QJsonValue());
    }
    m.insert(u"payoff"_s, payoffChart(legs, premium, QJsonValue()));
    m.insert(u"footnote"_s, present(premium) ? u"到期损益(按限价计入权利金):绿色一段赚,红色一段亏"_s : u"到期损益的形状(没有明确限价,未计权利金)"_s);
    return m;
}

QJsonObject similarQuery(const QJsonObject& t) {
    const auto orNull = [&](const char* key) {
        const QJsonValue v = t.value(QLatin1StringView(key));
        return v.isUndefined() ? QJsonValue() : v;
    };
    QJsonArray legs;
    for (const QJsonValue& lv : arrayOr(t.value("legs"_L1))) {
        const QJsonObject l = lv.toObject();
        QJsonObject leg;
        // 未给的键走 IPC 时就没了(JSON 里不出现):照样不带
        for (const char* k : {"action", "ratio", "strike", "right"})
            if (!l.value(QLatin1StringView(k)).isUndefined()) leg.insert(QLatin1StringView(k), l.value(QLatin1StringView(k)));
        legs.append(leg);
    }
    QJsonObject q;
    for (const char* k : {"sec_type", "symbol", "action"})
        if (!t.value(QLatin1StringView(k)).isUndefined()) q.insert(QLatin1StringView(k), t.value(QLatin1StringView(k)));
    q.insert(u"limit_price"_s, orNull("limit_price"));
    q.insert(u"expiry"_s, orNull("expiry"));
    q.insert(u"right"_s, orNull("right"));
    q.insert(u"combo_strategy"_s, orNull("combo_strategy"));
    q.insert(u"legs"_s, legs);
    return q;
}

QString similarKey(const QJsonObject& t) {
    // 同原版的 key:票据里决定"是不是同一张单"的那几样
    const QJsonArray k{t.value("sec_type"_L1), t.value("symbol"_L1), t.value("action"_L1), t.value("limit_price"_L1), t.value("expiry"_L1),
                       t.value("combo_strategy"_L1), t.value("legs"_L1)};
    return QString::fromUtf8(QJsonDocument(k).toJson(QJsonDocument::Compact));
}

QJsonObject similarModel(const QJsonObject& state) {
    const QJsonValue err = state.value("err"_L1);
    if (jsTruthy(err)) return {{u"kind"_s, u"error"_s}, {u"hint"_s, u"历史相似交易取不到:"_s + tpl(err)}};
    if (!jsTruthy(state.value("res"_L1))) return {{u"kind"_s, u"loading"_s}, {u"hint"_s, u"正在找历史相似交易…"_s}};
    const QJsonObject res = state.value("res"_L1).toObject();
    QStringList basisParts;
    for (const QJsonValue& b : arrayOr(res.value("basis"_L1))) basisParts << (b.isNull() || b.isUndefined() ? QString() : jsString(b));
    const QString basis = basisParts.join(u" · "_s);
    const QJsonArray matches = arrayOr(res.value("matches"_L1));
    if (!jsTruthy(res.value("count"_L1)) && matches.isEmpty())
        return {{u"kind"_s, u"none"_s}, {u"hint"_s, u"历史里没有相似的交易(按 %1 比)。"_s.arg(basis)}};
    QJsonObject m{{u"kind"_s, u"list"_s},
                  {u"head"_s, QJsonObject{{u"strong"_s, u"历史相似 %1 笔"_s.arg(tpl(res.value("count"_L1)))}, {u"tally"_s, u":"_s + tally(res)},
                                          {u"basis"_s, u"(按 %1 比)"_s.arg(basis)}}}};
    const QJsonArray exits = arrayOr(res.value("exits"_L1));
    if (exits.size() > 1) {
        QStringList lines;
        for (const QJsonValue& e : exits) lines << u"%1:%2"_s.arg(tpl(e.toObject().value("exit"_L1)), tally(e.toObject()));
        m.insert(u"exits"_s, lines.join(u";"_s));
    }
    QJsonArray items;
    for (qsizetype i = 0; i < std::min<qsizetype>(matches.size(), 5); ++i) {
        const QJsonObject mt = matches[i].toObject();
        QStringList reasons;
        for (const QJsonValue& r : arrayOr(mt.value("reasons"_L1))) reasons << (r.isNull() || r.isUndefined() ? QString() : jsString(r));
        items.append(QJsonObject{{u"text"_s, tradeText(mt.value("fact"_L1).toObject())},
                                 {u"aside"_s, jsTruthy(mt.value("primary"_L1)) ? QJsonValue() : QJsonValue(u"(同板块,不算进胜负)"_s)},
                                 {u"tip"_s, reasons.join(u"、"_s)}});
    }
    m.insert(u"items"_s, items);
    QJsonArray lessons;
    for (const QJsonValue& l : arrayOr(res.value("lessons"_L1))) {
        const QString text = l.toObject().value("text"_L1).toString();
        lessons.append(text.size() > 90 ? text.left(90) + u'…' : text);
    }
    m.insert(u"lessons"_s, lessons);
    return m;
}

QJsonArray resultCards(const QJsonObject& payload) {
    QJsonArray cards;
    const std::pair<const char*, std::pair<QString, QString>> groups[] = {
        {"submitted", {u"ok"_s, u"已提交"_s}},
        {"queued", {u"info"_s, u"排队等待触发"_s}},
        {"validated_only", {u"warn"_s, u"已通过校验(未发送)"_s}},
    };
    for (const auto& [key, kl] : groups) {
        for (const QJsonValue& iv : arrayOr(payload.value(QLatin1StringView(key)))) {
            const QJsonObject item = iv.toObject();
            const QJsonValue account = item.value("account"_L1);
            QJsonArray meta{u"账户 "_s + (jsTruthy(account) ? tpl(account) : u"—"_s)};
            if (!item.value("notional"_L1).isUndefined()) meta.append(u"敞口 ≈ %1 USD"_s.arg(track::fmtMoney(item.value("notional"_L1))));
            if (jsTruthy(item.value("order_id"_L1))) meta.append(u"订单号 "_s + tpl(item.value("order_id"_L1)));
            const QJsonValue mode = item.value("mode"_L1);
            if (jsTruthy(mode)) meta.append(mode == QJsonValue(u"software_watch"_s) ? u"软件盯盘(AUTO_MID)"_s : tpl(mode));
            const QJsonValue summary = item.value("intent_summary"_L1);
            QJsonObject card{{u"kind"_s, u"order"_s}, {u"tone"_s, kl.first},
                             {u"title"_s, u"%1 · %2"_s.arg(kl.second, jsTruthy(summary) ? tpl(summary) : QString())}, {u"meta"_s, meta}};
            // 老引擎的摘要里没有 ticket:那就只剩标题那一句话
            if (isTicket(item.value("ticket"_L1))) {
                const QJsonObject t = item.value("ticket"_L1).toObject();
                card.insert(u"ticket"_s, ticketModel(t));
                card.insert(u"ticketRaw"_s, t);
                card.insert(u"similarKey"_s, similarKey(t));
            }
            cards.append(card);
        }
    }
    for (const QJsonValue& rv : arrayOr(payload.value("rejections"_L1))) {
        const QJsonObject r = rv.toObject();
        // 拒绝码翻成人话;词表里没有的照旧露英文
        const QString why = say(rejectCodeLabel(), r.value("code"_L1)).value_or(u"未说明原因"_s);
        const QString source = rejectSourceLabel().value(jsString(r.value("source"_L1)), u"拒绝"_s);
        QJsonObject card{{u"kind"_s, u"reject"_s}, {u"tone"_s, u"bad"_s}, {u"title"_s, u"%1 · %2"_s.arg(source, why)}};
        if (const auto body = child(r.value("message"_L1))) card.insert(u"body"_s, *body);
        const QJsonValue orig = r.value("original_text"_L1);
        const QJsonValue reason = jsTruthy(orig) ? orig : r.value("intent_summary"_L1);
        if (jsTruthy(reason)) card.insert(u"reason"_s, child(reason).value_or(QString()));
        cards.append(card);
    }
    const QJsonArray warnings = arrayOr(payload.value("warnings"_L1));
    if (!warnings.isEmpty()) {
        QJsonArray items;
        for (const QJsonValue& w : warnings) items.append(child(w).value_or(QString()));
        cards.append(QJsonObject{{u"kind"_s, u"warn"_s}, {u"tone"_s, u"warn"_s}, {u"title"_s, u"提示"_s}, {u"items"_s, items}});
    }
    if (jsTruthy(payload.value("llm"_L1))) {
        const QJsonObject llm = payload.value("llm"_L1).toObject();
        // 本地速记命中时不显示 token 用量——根本没调大模型
        const bool local = llm.value("model"_L1) == QJsonValue(u"local-shorthand"_s);
        QJsonArray meta;
        if (local) {
            meta = {u"语法 "_s + tpl(llm.value("model"_L1)), u"毫秒级本地解析,规则与 AI 同一套校验"_s};
        } else {
            const QJsonObject usage = llm.value("usage"_L1).toObject();
            const auto orDash = [](const QJsonValue& v) { return present(v) ? tpl(v) : u"—"_s; };
            meta = {u"模型 "_s + tpl(llm.value("model"_L1)), u"提示词 "_s + tpl(llm.value("prompt_version"_L1)),
                    u"模型 %1 ms"_s.arg(tpl(llm.value("latency_ms"_L1))),
                    u"in %1 / out %2 tokens"_s.arg(orDash(usage.value("input_tokens"_L1)), orDash(usage.value("output_tokens"_L1)))};
        }
        if (present(payload.value("__elapsedMs"_L1))) meta.append(u"全链路 %1 ms"_s.arg(tpl(payload.value("__elapsedMs"_L1))));
        cards.append(QJsonObject{{u"kind"_s, u"llm"_s}, {u"tone"_s, u""_s}, {u"title"_s, local ? u"本次解析 · 本地秒解(未经大模型)"_s : u"本次解析"_s}, {u"meta"_s, meta}});
    }
    if (cards.isEmpty()) cards.append(QJsonObject{{u"kind"_s, u"empty"_s}, {u"text"_s, u"没有解析出任何订单。"_s}});
    return cards;
}

// ---- 整页 -------------------------------------------------------------------------------------------------------

QJsonObject tradePageModel(const PageInput& in) {
    const QJsonObject st = in.status.toObject();
    const bool connected = jsTruthy(st.value("broker_connected"_L1));
    const bool engaged = jsTruthy(st.value("breaker"_L1).toObject().value("engaged"_L1));
    const QString gateway = gatewayName(in.status);
    const QString broker = brokerShortName(in.status);
    const QJsonArray usable = pickableAccounts(in.status);
    const QStringList picked = pickAccounts(usable, in.savedPicked);

    // 就绪检查表:缺哪个说哪个,并给出去哪修;必要条件都满足就收起来
    std::optional<bool> keyed;
    if (in.llm.isObject()) {
        const QJsonObject llm = in.llm.toObject();
        const QJsonValue provider = llm.value("current"_L1).toObject().value("provider"_L1);
        keyed = jsTruthy(llm.value("key_configured"_L1).toObject().value(jsString(provider)));
    }
    struct Step {
        bool done;
        QString title, todo, ok, tab, action;
        bool optional;
    };
    const QList<Step> steps{
        {keyed != false, u"配置大模型 API Key"_s, u"没有 Key 无法解析指令。Key 存于系统凭据库,不落配置文件。"_s, u"已配置"_s, u"llm"_s, u"去配置"_s, false},
        {in.placeholders.isEmpty(), u"填上你的券商账号"_s,
         u"「%1」还是示例里的占位账号:解析得了指令,但订单发不到你的账户上。"_s.arg(in.placeholders.join(u"」「"_s)), u"已配置"_s, u"accounts"_s, u"去填写"_s, false},
        {connected, u"连接"_s + gateway, u"没有券商连接只能解析,不能下单,也拿不到行情。"_s, u"已连接"_s,
         st.value("broker_provider"_L1) == QJsonValue(u"futu"_s) ? u"futu"_s : u"tws"_s, u"去连接"_s, false},
    };
    int blocking = 0;
    for (const Step& s : steps)
        if (!s.done && !s.optional) ++blocking;
    QJsonValue readiness;
    if (blocking) {
        QJsonArray list;
        for (const Step& s : steps)
            list.append(QJsonObject{{u"title"_s, s.title}, {u"done"_s, s.done}, {u"text"_s, s.done ? s.ok : s.todo}, {u"action"_s, s.done ? QString() : s.action}, {u"tab"_s, s.tab}});
        readiness = QJsonObject{{u"title"_s, u"还差 %1 步才能开始"_s.arg(blocking)}, {u"sub"_s, u"未完成项会挡住解析或下单,点右侧按钮前往。"_s}, {u"steps"_s, list}};
    }

    // 「发送」按钮只在真的会发到实盘账户时才橙字
    bool liveOn = false;
    for (const QJsonValue& av : usable) {
        const QJsonObject a = av.toObject();
        const bool live = !jsTruthy(a.value("is_paper"_L1));
        const bool on = picked.contains(jsString(a.value("alias"_L1)));
        if (live && (usable.size() < 2 || on)) liveOn = true;
    }
    QStringList blockers;
    if (!connected) blockers << u"未连接 "_s + gateway;
    if (engaged) blockers << u"已熔断"_s;

    // 发单账户:只有一个账户时没什么可选,控件隐藏
    QJsonValue picker;
    if (usable.size() >= 2) {
        QJsonArray accounts;
        for (const QJsonValue& av : usable) {
            const QJsonObject a = av.toObject();
            const QString alias = jsString(a.value("alias"_L1));
            const bool paper = jsTruthy(a.value("is_paper"_L1));
            accounts.append(QJsonObject{{u"alias"_s, alias}, {u"on"_s, picked.contains(alias)}, {u"live"_s, !paper},
                                        {u"text"_s, u"%1 · %2"_s.arg(alias, paper ? u"纸面"_s : u"实盘"_s)},
                                        {u"tip"_s, u"%1 · 连接 %2"_s.arg(tpl(a.value("account_masked"_L1)), tpl(a.value("connection"_L1)))}});
        }
        const QString hint = picked.size() > 1 ? u"每笔订单各发 %1 份,各自独立校验与记录"_s.arg(picked.size()) : picked.size() == 1 ? QString() : u"未勾选账户,无法发单"_s;
        picker = QJsonObject{{u"accounts"_s, accounts}, {u"hint"_s, hint}};
    }

    // 保护规则暂停不算发送条件:它只挡新单、不挡平仓,由引擎判
    const QJsonObject prot = st.value("protections"_L1).toObject();
    QJsonValue guard;
    QJsonValue pauses;
    if (jsTruthy(prot.value("paused"_L1))) {
        const QJsonValue reason = prot.value("reason"_L1);
        guard = u"保护规则暂停中:%1。新开仓的单会被引擎拦下(停在「仅校验未发送」,到点后可再发);对着持仓认得出是在减仓的单照发。"_s.arg(
            jsTruthy(reason) ? tpl(reason) : u"规则已触发"_s);
    } else {
        const QJsonArray accs = arrayOr(prot.value("accounts"_L1));
        if (!accs.isEmpty()) {
            QStringList reasons;
            for (const QJsonValue& a : accs) {
                const QJsonValue r = a.toObject().value("reason"_L1);
                reasons << (r.isNull() || r.isUndefined() ? QString() : jsString(r));
            }
            pauses = u"%1。发到这%2账户的新开仓单会被拦下,别的账户与平仓不受影响。"_s.arg(reasons.join(u';'), accs.size() > 1 ? u"几个"_s : u"个"_s);
        }
    }

    const QJsonObject limits = st.value("limits"_L1).toObject();
    const QString limitsText = jsTruthy(st.value("limits"_L1))
                                   ? u"单笔 ≤ %1 USD · 期权 ≤ %2 张"_s.arg(track::fmtMoney(limits.value("max_order_notional"_L1)), tpl(limits.value("max_option_contracts"_L1)))
                                   : u"—"_s;

    const QJsonObject c = in.composer;
    QJsonObject result;
    const QJsonValue payload = c.value("payload"_L1);
    if (jsTruthy(c.value("working"_L1))) {
        result = {{u"kind"_s, u"working"_s}, {u"text"_s, tpl(c.value("working"_L1))}};
    } else if (jsTruthy(c.value("failure"_L1))) {
        result = {{u"kind"_s, u"failure"_s}, {u"title"_s, u"调用失败"_s}, {u"text"_s, tpl(c.value("failure"_L1))}};
    } else if (payload.isObject()) {
        QJsonArray cards = resultCards(payload.toObject());
        for (qsizetype i = 0; i < cards.size(); ++i) {
            QJsonObject card = cards[i].toObject();
            if (card.contains(u"similarKey"_s))
                card.insert(u"similar"_s, similarModel(in.similar.value(card.value(u"similarKey"_s).toString()).toObject()));
            cards[i] = card;
        }
        result = {{u"kind"_s, u"cards"_s}, {u"cards"_s, cards}};
    } else {
        result = {{u"kind"_s, u"empty"_s}, {u"text"_s, u"还没有解析结果"_s}};
    }

    QStringList pickedOut = picked;
    return {
        {u"title"_s, u"交易指令"_s},
        {u"limits"_s, limitsText},
        {u"readiness"_s, readiness},
        {u"picked"_s, QJsonArray::fromStringList(pickedOut)},
        {u"usable"_s, usable},
        {u"send"_s, QJsonObject{{u"label"_s, u"发送到"_s + broker}, {u"warn"_s, liveOn}, {u"canExecute"_s, blockers.isEmpty()},
                                {u"blockers"_s, blockers.join(u"、"_s)},
                                {u"tip"_s, blockers.isEmpty() ? u"解析通过后直接发送给券商"_s : u"不能发送:"_s + blockers.join(u"、"_s)}}},
        {u"parseLabel"_s, u"解析并校验"_s},
        // `${MOD_KEY}${ENTER_KEY} 解析 · ${MOD_KEY}${SHIFT_KEY}${ENTER_KEY} 发送`
        {u"hotkeys"_s, in.mac ? u"⌘↩ 解析 · ⌘⇧↩ 发送"_s : u"Ctrl+Enter 解析 · Ctrl+Shift+Enter 发送"_s},
        {u"placeholder"_s, u"例:spx到7500时,开一张今天的 7520 7550 call spread。理由:突破 7500 整数关口后追动能"_s},
        {u"picker"_s, picker},
        {u"guard"_s, guard},
        {u"accountPauses"_s, pauses},
        {u"chips"_s, shorthandChips()},
        {u"primer"_s, QJsonObject{{u"summary"_s, u"速记规则、默认值与发送条件"_s},
                                  {u"items"_s, QJsonArray{
                                                   u"默认 1 张、当日到期、组合默认 SPX、蝴蝶默认买入;用到默认值时结果会带警告,发送前核对。"_s,
                                                   u"N cm = 翼宽 N 点;末尾孤立数字 = 净权利金上限;看涨 / 看跌未写时按现价推断。"_s,
                                                   u"固定行话本地秒解、不经 AI:「1.8 挂15蝴蝶 15CM」中「挂」= 当日限价,「N蝴蝶」= 现价百位 + N(现价 6907 → 6915)。"_s,
                                                   u"「蝴蝶」二字可省:「spx明天 7850 40cm 2.3」= 明日 7810/7850/7890 蝴蝶挂 2.3;带触发价、理由等附加语义仍走 AI。"_s,
                                                   u"发送条件:自动执行已打开 · 已连接 %1 · 未熔断;实盘账户还需在「设置」里允许实盘下单。"_s.arg(gateway),
                                               }}}},
        {u"pane"_s, c.value("pane"_L1).toString(u"result"_s)},
        {u"panes"_s, QJsonArray{QJsonObject{{u"label"_s, u"解析结果"_s}, {u"value"_s, u"result"_s}}, QJsonObject{{u"label"_s, u"蝴蝶测算"_s}, {u"value"_s, u"fly"_s}},
                                QJsonObject{{u"label"_s, u"日内剧本"_s}, {u"value"_s, u"playbook"_s}}}},
        {u"busy"_s, c.value("busy"_L1)},
        {u"result"_s, result},
    };
}

void ticketTexts(const QJsonObject& t, QStringList& out) {
    out << t.value("badge"_L1).toString() << jsString(t.value("symbol"_L1)) << t.value("sideText"_L1).toString() << t.value("sub"_L1).toString();
    if (!t.value("quantity"_L1).toString().isEmpty()) out << t.value("quantity"_L1).toString();
    out << t.value("unit"_L1).toString() << u"×"_s << t.value("price"_L1).toString();
    if (!t.value("typeText"_L1).toString().isEmpty()) out << t.value("typeText"_L1).toString();
    if (t.value("trigger"_L1).isString()) out << u"条件单"_s << t.value("trigger"_L1).toString();
    if (!t.value("payoff"_L1).isObject()) return;
    for (const QJsonValue& p : t.value("legPills"_L1).toArray()) out << p.toObject().value("text"_L1).toString();
    for (const QJsonValue& a : t.value("payoff"_L1).toObject().value("axis"_L1).toArray()) out << a.toObject().value("text"_L1).toString();
    out << t.value("footnote"_L1).toString();
}

namespace {

void similarTexts(const QJsonObject& s, QStringList& out) {
    if (s.value("kind"_L1) != QJsonValue(u"list"_s)) {
        out << s.value("hint"_L1).toString();
        return;
    }
    const QJsonObject head = s.value("head"_L1).toObject();
    out << head.value("strong"_L1).toString() << head.value("tally"_L1).toString() << head.value("basis"_L1).toString();
    if (s.value("exits"_L1).isString()) out << s.value("exits"_L1).toString();
    for (const QJsonValue& i : s.value("items"_L1).toArray()) {
        out << i.toObject().value("text"_L1).toString();
        if (i.toObject().value("aside"_L1).isString()) out << i.toObject().value("aside"_L1).toString();
    }
    const QJsonArray lessons = s.value("lessons"_L1).toArray();
    if (!lessons.isEmpty()) {
        out << u"相关复盘:"_s;
        for (const QJsonValue& l : lessons) out << l.toString();
    }
}

}  // namespace

QStringList pageTexts(const QJsonObject& m, const QString& composerText) {
    QStringList out{m.value("title"_L1).toString(), m.value("limits"_L1).toString()};
    if (m.value("readiness"_L1).isObject()) {
        const QJsonObject r = m.value("readiness"_L1).toObject();
        out << r.value("title"_L1).toString() << r.value("sub"_L1).toString();
        for (const QJsonValue& sv : r.value("steps"_L1).toArray()) {
            const QJsonObject s = sv.toObject();
            out << s.value("title"_L1).toString() << s.value("text"_L1).toString();
            if (!s.value("done"_L1).toBool()) out << s.value("action"_L1).toString();
        }
    }
    if (!composerText.isEmpty()) out << composerText;
    const QJsonObject send = m.value("send"_L1).toObject();
    out << m.value("parseLabel"_L1).toString() << send.value("label"_L1).toString() << m.value("hotkeys"_L1).toString();
    if (m.value("picker"_L1).isObject()) {
        const QJsonObject p = m.value("picker"_L1).toObject();
        out << u"发单账户"_s;
        for (const QJsonValue& a : p.value("accounts"_L1).toArray()) out << a.toObject().value("text"_L1).toString();
        if (!p.value("hint"_L1).toString().isEmpty()) out << p.value("hint"_L1).toString();
    }
    if (m.value("guard"_L1).isString()) out << m.value("guard"_L1).toString();
    if (m.value("accountPauses"_L1).isString()) out << m.value("accountPauses"_L1).toString();
    for (const QJsonValue& c : m.value("chips"_L1).toArray()) out << c.toArray().at(0).toString();
    out << m.value("primer"_L1).toObject().value("summary"_L1).toString();
    for (const QJsonValue& p : m.value("panes"_L1).toArray()) out << p.toObject().value("label"_L1).toString();
    if (m.value("pane"_L1) == QJsonValue(u"result"_s)) out << u"清空"_s;
    const QJsonObject r = m.value("result"_L1).toObject();
    const QString kind = r.value("kind"_L1).toString();
    if (kind == u"working" || kind == u"empty") {
        out << r.value("text"_L1).toString();
    } else if (kind == u"failure") {
        out << r.value("title"_L1).toString() << r.value("text"_L1).toString();
    } else {
        for (const QJsonValue& cv : r.value("cards"_L1).toArray()) {
            const QJsonObject card = cv.toObject();
            const QString k = card.value("kind"_L1).toString();
            if (k == u"empty") {
                out << card.value("text"_L1).toString();
                continue;
            }
            out << card.value("title"_L1).toString();
            if (card.value("ticket"_L1).isObject()) ticketTexts(card.value("ticket"_L1).toObject(), out);
            if (card.value("body"_L1).isString()) out << card.value("body"_L1).toString();
            if (card.value("reason"_L1).isString()) out << card.value("reason"_L1).toString();
            for (const QJsonValue& i : card.value("items"_L1).toArray()) out << i.toString();
            for (const QJsonValue& x : card.value("meta"_L1).toArray()) out << x.toString();
            if (card.value("similar"_L1).isObject()) similarTexts(card.value("similar"_L1).toObject(), out);
        }
    }
    return out;
}

}  // namespace ibkr::shell::trade
