#include "shell/pa_spec.h"

#include "shell/jsvalue.h"

#include <QJsonArray>

#include <algorithm>

namespace ibkr::shell::pa {

using namespace Qt::StringLiterals;

namespace {

/// MA_STYLE:5 橙、10 蓝、20 紫,别的周期二级色
QString maColor(int p) {
    if (p == 5) return u"orange"_s;
    if (p == 10) return u"blue"_s;
    if (p == 20) return u"purple"_s;
    return u"label2"_s;
}
/// 有值才写(undefined 的键 JSON.stringify 不写)
void put(QJsonObject& o, const QString& key, const QJsonValue& v) {
    if (!v.isUndefined()) o[key] = v;
}
QJsonArray arr(const QJsonValue& v) { return v.isArray() ? v.toArray() : QJsonArray{}; }
QString orEmpty(const QJsonValue& v) { return jsTruthy(v) ? jsString(v) : QString(); }
/// Object.keys(ma).map(Number).sort((a, b) => a - b)
QList<double> periodsOf(const QJsonObject& ma) {
    QList<double> out;
    for (const QString& k : ma.keys()) out << jsNumber(QJsonValue(k));
    std::sort(out.begin(), out.end());
    return out;
}
/// 「ES 202612」→「ES」(String(futures || '期货').split(' ')[0])
QString futuresName(const QJsonValue& r) {
    const QJsonValue f = r[u"proxy"_s].isObject() ? r[u"proxy"_s][u"futures"_s] : QJsonValue();
    return (jsTruthy(f) ? jsString(f) : u"期货"_s).split(u' ').first();
}
const QJsonArray kDash{2, 2};

}  // namespace

QJsonObject specJson(const QJsonValue& r) {
    QJsonObject s;
    s[u"ariaLabel"_s] = u"%1 %2 K 线图"_s.arg(orEmpty(r[u"symbol"_s]), orEmpty(r[u"timeframe_label"_s]));
    // 换了标的、周期或盘前盘后口径,K 线就不是同一组了:视口重新铺满
    s[u"viewKey"_s] = u"%1|%2|%3"_s.arg(orEmpty(r[u"symbol"_s]), orEmpty(r[u"timeframe"_s]), jsTruthy(r[u"rth"_s]) ? u"rth"_s : u"all"_s);
    s[u"bars"_s] = jsTruthy(r[u"bars"_s]) ? r[u"bars"_s] : QJsonArray{};
    put(s, u"last"_s, r[u"last"_s]);
    const QJsonObject ma = r[u"ma"_s].toObject();
    QJsonArray lines;
    for (double p : periodsOf(ma)) {
        const QJsonValue values = ma.value(jsNumberToString(p));
        lines.append(QJsonObject{{u"values"_s, jsTruthy(values) ? values : QJsonArray{}}, {u"color"_s, maColor(int(p))}, {u"alpha"_s, 0.7},
                                 {u"label"_s, u"MA"_s + jsNumberToString(p)}});
    }
    s[u"lines"_s] = lines;
    QJsonArray hlines;
    for (const QJsonValue& l : arr(r[u"levels"_s])) {
        QJsonObject h;
        put(h, u"price"_s, l[u"price"_s]);
        h[u"color"_s] = l[u"side"_s] == u"resistance"_s ? u"down"_s : u"up"_s;
        h[u"dash"_s] = kDash;
        h[u"alpha"_s] = 0.45;
        h[u"fit"_s] = false;
        hlines.append(h);
    }
    s[u"hlines"_s] = hlines;
    QJsonArray bands;
    // 推算段铺在最底下:FVG、订单块照常画在它上面
    if (r[u"off_hours"_s] == u"proxy"_s && r[u"proxy"_s].isObject())
        for (const QJsonValue& sp : arr(r[u"proxy"_s][u"spans"_s])) {
            QJsonObject b{{u"v"_s, true}};
            put(b, u"from"_s, sp[u"from"_s]);
            put(b, u"to"_s, sp[u"to"_s]);
            b[u"color"_s] = u"label2"_s;
            b[u"fill"_s] = 0.07;
            b[u"label"_s] = futuresName(r) + u" 推算"_s;
            bands.append(b);
        }
    for (const QJsonValue& g : arr(r[u"fvgs"_s])) {
        QJsonObject b;
        put(b, u"from"_s, g[u"time"_s]);
        put(b, u"top"_s, g[u"top"_s]);
        put(b, u"bottom"_s, g[u"bottom"_s]);
        const bool bull = g[u"side"_s] == u"bull"_s;
        b[u"color"_s] = bull ? u"up"_s : u"down"_s;
        b[u"fill"_s] = 0.07;
        b[u"stroke"_s] = 0.22;
        b[u"label"_s] = bull ? u"FVG↑"_s : u"FVG↓"_s;
        bands.append(b);
    }
    if (jsTruthy(r[u"order_block"_s])) {
        const QJsonValue ob = r[u"order_block"_s];
        QJsonObject b;
        put(b, u"from"_s, ob[u"time"_s]);
        put(b, u"top"_s, ob[u"top"_s]);
        put(b, u"bottom"_s, ob[u"bottom"_s]);
        b[u"color"_s] = u"label"_s;
        b[u"fill"_s] = 0.06;
        b[u"stroke"_s] = 0.28;
        b[u"dash"_s] = kDash;
        b[u"label"_s] = u"OB"_s;
        bands.append(b);
    }
    s[u"bands"_s] = bands;
    QJsonArray vlines;
    if (jsTruthy(r[u"forming"_s])) {
        QJsonObject v;
        put(v, u"time"_s, r[u"forming"_s][u"time"_s]);
        v[u"color"_s] = u"orange"_s;
        v[u"dash"_s] = kDash;
        v[u"label"_s] = jsTruthy(r[u"forming"_s][u"waiting"_s]) ? u"未到齐"_s : u"形成中"_s;
        vlines.append(v);
    }
    s[u"vlines"_s] = vlines;
    QJsonArray markers;
    const QJsonArray swings = arr(r[u"swings"_s]);
    for (qsizetype i = std::max<qsizetype>(0, swings.size() - 8); i < swings.size(); ++i) {
        const QJsonValue sw = swings[i];
        const bool high = sw[u"kind"_s] == u"high"_s;
        QJsonObject m;
        put(m, u"time"_s, sw[u"time"_s]);
        put(m, u"price"_s, sw[u"price"_s]);
        m[u"shape"_s] = u"dot"_s;
        m[u"color"_s] = high ? u"down"_s : u"up"_s;
        m[u"label"_s] = jsTruthy(sw[u"label"_s]) ? sw[u"label"_s] : QJsonValue(QString());
        m[u"labelPos"_s] = high ? u"above"_s : u"below"_s;
        m[u"labelColor"_s] = u"label"_s;
        m[u"labelAlpha"_s] = 0.45;
        m[u"fit"_s] = false;
        markers.append(m);
    }
    s[u"markers"_s] = markers;
    QJsonArray legend{QJsonArray{u"■"_s, u"up"_s, u"阳线"_s}, QJsonArray{u"■"_s, u"down"_s, u"阴线"_s}, QJsonArray{u"╌"_s, u"up"_s, u"支撑"_s},
                      QJsonArray{u"╌"_s, u"down"_s, u"阻力"_s}, QJsonArray{u"▮"_s, u"up"_s, u"FVG"_s}, QJsonArray{u"▯"_s, u"label2"_s, u"订单块"_s},
                      QJsonArray{u"·"_s, u"blue"_s, u"现价"_s}};
    if (r[u"off_hours"_s] == u"proxy"_s) legend.append(QJsonArray{u"▮"_s, u"label2"_s, futuresName(r) + u" 推算"_s});
    s[u"legend"_s] = legend;
    return s;
}

chart::Spec spec(const QJsonValue& r) {
    chart::Spec s = chart::specFromJson(specJson(r));
    const QJsonObject ma = r[u"ma"_s].toObject();
    const QList<double> periods = periodsOf(ma);
    if (periods.isEmpty()) return s;
    // 顶部一行:每条均线在这一根(或光标那根)的值
    QList<QPair<QString, QList<std::optional<double>>>> cols;
    for (double p : periods) {
        QList<std::optional<double>> vs;
        for (const QJsonValue& v : arr(ma.value(jsNumberToString(p)))) vs << (v.isDouble() ? std::optional<double>(v.toDouble()) : std::nullopt);
        cols.append({jsNumberToString(p), vs});
    }
    s.header = [cols](int i, const chart::Helpers& h) -> std::optional<chart::Parts> {
        chart::Parts parts;
        for (const auto& [p, vs] : cols) {
            const std::optional<double> v = i >= 0 && i < vs.size() ? vs[i] : std::nullopt;
            parts.append({u"MA%1 %2"_s.arg(p, v ? h.fmt(*v) : u"—"_s), maColor(p.toInt())});
        }
        return parts;
    };
    return s;
}

}  // namespace ibkr::shell::pa
