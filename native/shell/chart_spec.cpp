#include "shell/chart_spec.h"

#include "shell/jsvalue.h"

#include "util/jsmath.h"

#include <QDate>
#include <QDateTime>
#include <QJsonArray>
#include <QSet>
#include <QTimeZone>
#include <QRegularExpression>

#include <algorithm>
#include <cmath>
#include <limits>

namespace ibkr::shell::chart {

using namespace Qt::StringLiterals;

namespace {

bool finite(std::optional<double> v) { return v && std::isfinite(*v); }

/// JS 的 a || b(数):0 与 NaN 当假
double orElse(double a, double b) { return a == 0 || std::isnan(a) ? b : a; }

}  // namespace

// ---------------------------------------------------------------- JSON
namespace {
std::optional<double> num(const QJsonValue& v) {
    if (v.isDouble()) return v.toDouble();
    return std::nullopt;
}
std::optional<QString> str(const QJsonValue& v) {
    if (v.isString()) return v.toString();
    return std::nullopt;
}
QList<double> dash(const QJsonValue& v) {
    QList<double> out;
    for (const QJsonValue& x : v.toArray()) out << x.toDouble();
    return out;
}
}  // namespace

Spec specFromJson(const QJsonObject& o) {
    Spec s;
    s.ariaLabel = o.value("ariaLabel"_L1).toString();
    s.viewKey = str(o.value("viewKey"_L1));
    if (o.value("times"_L1).isArray()) {
        QStringList t;
        for (const QJsonValue& x : o.value("times"_L1).toArray()) t << jsString(x);
        s.times = t;
    }
    for (const QJsonValue& bv : o.value("bars"_L1).toArray()) {
        const QJsonObject b = bv.toObject();
        Bar bar;
        bar.time = jsString(b.value("time"_L1));
        bar.open = jsNumber(b.value("open"_L1));
        bar.high = jsNumber(b.value("high"_L1));
        bar.low = jsNumber(b.value("low"_L1));
        bar.close = jsNumber(b.value("close"_L1));
        bar.volume = num(b.value("volume"_L1));
        s.bars << bar;
    }
    for (const QJsonValue& lv : o.value("lines"_L1).toArray()) {
        const QJsonObject l = lv.toObject();
        Line line;
        if (l.value("values"_L1).isArray()) {
            QList<std::optional<double>> vs;
            for (const QJsonValue& x : l.value("values"_L1).toArray()) vs << num(x);
            line.values = vs;
        } else if (l.value("points"_L1).isArray()) {
            QList<QPair<QString, std::optional<double>>> ps;
            for (const QJsonValue& x : l.value("points"_L1).toArray()) ps.append({jsString(x[u"time"]), num(x[u"value"])});
            line.points = ps;
        }
        line.color = l.value("color"_L1).toString();
        line.width = l.value("width"_L1).toDouble();
        line.dash = dash(l.value("dash"_L1));
        line.alpha = num(l.value("alpha"_L1));
        line.step = l.value("step"_L1).toBool();
        line.label = l.value("label"_L1).toString();
        s.lines << line;
    }
    for (const QJsonValue& hv : o.value("hlines"_L1).toArray()) {
        const QJsonObject h = hv.toObject();
        HLine line;
        line.price = jsNumber(h.value("price"_L1));
        line.color = h.value("color"_L1).toString();
        line.dash = dash(h.value("dash"_L1));
        line.alpha = num(h.value("alpha"_L1));
        line.width = num(h.value("width"_L1));
        line.label = h.value("label"_L1).toString();
        line.tag = h.value("tag"_L1) != QJsonValue(false);
        line.fit = h.value("fit"_L1) != QJsonValue(false);
        s.hlines << line;
    }
    for (const QJsonValue& bv : o.value("bands"_L1).toArray()) {
        const QJsonObject b = bv.toObject();
        Band band;
        band.v = b.value("v"_L1).toBool();
        band.from = str(b.value("from"_L1));
        band.to = str(b.value("to"_L1));
        band.top = num(b.value("top"_L1));
        band.bottom = num(b.value("bottom"_L1));
        band.color = b.value("color"_L1).toString();
        band.fill = num(b.value("fill"_L1));
        band.stroke = num(b.value("stroke"_L1));
        band.dash = dash(b.value("dash"_L1));
        band.label = b.value("label"_L1).toString();
        band.fit = b.value("fit"_L1).toBool();
        s.bands << band;
    }
    for (const QJsonValue& vv : o.value("vlines"_L1).toArray()) {
        const QJsonObject v = vv.toObject();
        VLine line;
        line.time = jsString(v.value("time"_L1));
        line.color = v.value("color"_L1).toString();
        if (v.value("dash"_L1).isArray()) line.dash = dash(v.value("dash"_L1));
        line.label = v.value("label"_L1).toString();
        s.vlines << line;
    }
    for (const QJsonValue& mv : o.value("markers"_L1).toArray()) {
        const QJsonObject m = mv.toObject();
        Marker mk;
        mk.time = jsString(m.value("time"_L1));
        mk.price = jsNumber(m.value("price"_L1));
        if (m.value("shape"_L1).isString()) mk.shape = m.value("shape"_L1).toString();
        mk.color = m.value("color"_L1).toString();
        mk.label = m.value("label"_L1).toString();
        if (m.value("labelPos"_L1).isString()) mk.labelPos = m.value("labelPos"_L1).toString();
        mk.labelColor = m.value("labelColor"_L1).toString();
        mk.labelAlpha = num(m.value("labelAlpha"_L1));
        mk.fit = m.value("fit"_L1) != QJsonValue(false);
        s.markers << mk;
    }
    s.last = num(o.value("last"_L1));
    for (const QJsonValue& lv : o.value("legend"_L1).toArray()) s.legend.append({lv[0].toString(), lv[1].toString(), lv[2].toString()});
    if (o.value("volume"_L1).isBool()) s.volume = o.value("volume"_L1).toBool();
    s.yMin = num(o.value("yMin"_L1));
    if (o.value("decimals"_L1).isDouble()) s.decimals = o.value("decimals"_L1).toInt();
    s.padPct = num(o.value("padPct"_L1));
    return s;
}

// ---------------------------------------------------------------- 格式

double niceStep(double span, double target) {
    const double raw = span / std::max(1.0, target);
    const double mag = std::pow(10.0, std::floor(ibkr::util::jsmath::log10(raw)));
    for (double m : {1.0, 2.0, 2.5, 5.0, 10.0})
        if (raw <= m * mag) return m * mag;
    return 10 * mag;
}

int decimalsFor(double step) {
    if (!(step > 0) || step >= 1) return 2;
    return int(std::min(4.0, std::max(2.0, -std::floor(ibkr::util::jsmath::log10(step)))));
}

QString fmtPrice(double p, int dec) { return jsToFixed(p, dec); }

QString fmtVol(std::optional<double> v) {
    if (!v) return u"—"_s;
    if (*v >= 1e8) return jsToFixed(*v / 1e8, 2) + u"亿"_s;
    if (*v >= 1e4) return jsToFixed(*v / 1e4, 1) + u"万"_s;
    return jsNumberToString(jsRound(*v));
}

QString timeLabel(const QString& t, bool withDate) {
    const QString hm = t.size() >= 16 ? t.mid(11, 5) : QString();
    const QString md = t.size() >= 10 ? t.mid(5, 5) : t;
    if (hm.isEmpty()) return md;
    return withDate ? md + u' ' + hm : hm;
}

std::optional<qint64> wallClockSeconds(const QString& t) {
    static const QRegularExpression re(uR"(^([0-9]{4})-?([0-9]{2})-?([0-9]{2})(?:[ T]([0-9]{2}):([0-9]{2})(?::([0-9]{2}))?)?)"_s);
    const auto m = re.match(jsTrim(t));
    if (!m.hasMatch()) return std::nullopt;
    // Date.UTC(y, m - 1, d, h, mi, s):月、日、时分秒越界都往前滚;0–99 年按 1900 年代
    int year = m.captured(1).toInt();
    if (year >= 0 && year <= 99) year += 1900;
    const int months = m.captured(2).toInt() - 1;
    const int y2 = year + int(std::floor(months / 12.0));
    const int mo = ((months % 12) + 12) % 12;
    const QDate first(y2, mo + 1, 1);
    const qint64 days = first.toJulianDay() - QDate(1970, 1, 1).toJulianDay() + (m.captured(3).toInt() - 1);
    const qint64 secs = qint64(m.captured(4).toInt()) * 3600 + qint64(m.captured(5).toInt()) * 60 + m.captured(6).toInt();
    return days * 86400 + secs;
}

// ---------------------------------------------------------------- 归一化

Normalized normalize(const Spec& spec) {
    QStringList raw;
    if (spec.times) {
        raw = *spec.times;
    } else {
        for (const Bar& b : spec.bars) raw << b.time;
    }
    struct P {
        QString t;
        std::optional<qint64> s;
    };
    QList<P> parsed;
    for (const QString& t : raw) parsed.append({t, wallClockSeconds(t)});
    bool realTime = !parsed.isEmpty() && std::all_of(parsed.begin(), parsed.end(), [](const P& p) { return p.s.has_value(); });
    QList<P> uniq;
    QSet<QString> seen;
    for (const P& p : parsed) {
        if (seen.contains(p.t)) continue;
        seen.insert(p.t);
        uniq << p;
    }
    if (realTime) std::stable_sort(uniq.begin(), uniq.end(), [](const P& a, const P& b) { return *a.s < *b.s; });
    Normalized n;
    for (const P& p : uniq) n.times << p.t;
    for (qsizetype i = 0; i < uniq.size(); ++i) n.stamps << (realTime ? *uniq[i].s : 86400 * (i + 1));
    // 解析后撞车:退回按下标
    if (realTime)
        for (qsizetype i = 1; i < n.stamps.size(); ++i)
            if (n.stamps[i] <= n.stamps[i - 1]) {
                for (qsizetype k = 0; k < n.stamps.size(); ++k) n.stamps[k] = 86400 * (k + 1);
                realTime = false;
                break;
            }
    n.realTime = realTime;
    for (qsizetype i = 0; i < n.times.size(); ++i) n.idx.insert(n.times[i], int(i));
    n.intraday = std::any_of(n.times.begin(), n.times.end(), [](const QString& t) { return t.size() >= 16; });

    n.barAt = QList<std::optional<Bar>>(n.times.size());
    for (const Bar& b : spec.bars) {
        const auto it = n.idx.constFind(b.time);
        if (it != n.idx.cend() && std::isfinite(b.open) && std::isfinite(b.high) && std::isfinite(b.low) && std::isfinite(b.close)) n.barAt[*it] = b;
    }
    for (const Line& ln : spec.lines) {
        QList<std::optional<double>> values(n.times.size());
        if (ln.values) {
            // values 与调用方给的 times 对齐;去过重的按原下标取
            for (qsizetype k = 0; k < raw.size(); ++k) {
                const auto it = n.idx.constFind(raw[k]);
                const std::optional<double> v = k < ln.values->size() ? ln.values->at(k) : std::nullopt;
                if (it != n.idx.cend() && finite(v)) values[*it] = v;
            }
        } else if (ln.points) {
            for (const auto& [time, v] : *ln.points) {
                const auto it = n.idx.constFind(time);
                if (it != n.idx.cend() && finite(v)) values[*it] = v;
            }
        }
        n.lineValues << values;
    }
    n.lastIdx = int(n.times.size()) - 1;
    for (int i = int(n.times.size()) - 1; i >= 0; --i) {
        bool any = n.barAt[i].has_value();
        for (const auto& vs : n.lineValues) any = any || vs[i].has_value();
        if (any) {
            n.lastIdx = i;
            break;
        }
    }
    return n;
}

// ---------------------------------------------------------------- 引擎里的那几样

double headerPx(const Spec& spec) { return 8 + ((spec.header ? 1 : 0) + 1) * 17; }

bool hasVolume(const Spec& spec, const Normalized& norm) {
    if (spec.volume == false) return false;
    return std::any_of(norm.barAt.begin(), norm.barAt.end(), [](const std::optional<Bar>& b) { return b && b->volume.value_or(0) > 0; });
}

std::optional<QPair<double, double>> priceRange(const Spec& spec, const Normalized& norm, int a, int b) {
    double lo = std::numeric_limits<double>::infinity(), hi = -std::numeric_limits<double>::infinity();
    const auto take = [&](std::optional<double> v) {
        if (v && std::isfinite(*v)) {
            lo = std::min(lo, *v);
            hi = std::max(hi, *v);
        }
    };
    for (int i = a; i <= b; ++i) {
        if (i >= 0 && i < norm.barAt.size() && norm.barAt[i]) {
            take(norm.barAt[i]->low);
            take(norm.barAt[i]->high);
        }
        for (const auto& vs : norm.lineValues)
            if (i >= 0 && i < vs.size()) take(vs[i]);
    }
    for (const HLine& h : spec.hlines)
        if (h.fit) take(h.price);
    for (const Marker& m : spec.markers) {
        const auto it = norm.idx.constFind(m.time);
        if (m.fit && it != norm.idx.cend() && *it >= a && *it <= b) take(m.price);
    }
    for (const Band& bd : spec.bands)
        if (bd.fit) {
            take(bd.top);
            take(bd.bottom);
        }
    take(spec.last);
    if (!std::isfinite(lo)) return std::nullopt;
    const double pad = orElse(orElse((hi - lo) * spec.padPct.value_or(0.05), std::abs(hi) * 0.001), 1);
    lo -= pad;
    hi += pad;
    if (spec.yMin) lo = std::max(*spec.yMin, lo);
    return QPair<double, double>{lo, hi};
}

double volumeCap(const Normalized& norm) {
    QList<double> vols;
    for (const auto& b : norm.barAt) {
        const double v = b && b->volume ? *b->volume : 0;
        if (v > 0) vols << v;
    }
    if (vols.isEmpty()) return 0;
    std::sort(vols.begin(), vols.end());
    const double cap = vols[std::min<qsizetype>(vols.size() - 1, qsizetype(std::floor(0.95 * double(vols.size() - 1))))];
    return orElse(cap, vols.last());
}

int decimals(const Spec& spec, const Normalized& norm, double containerHeight) {
    if (spec.decimals) return *spec.decimals;
    const int n = int(norm.times.size());
    const auto full = n >= 2 ? priceRange(spec, norm, 0, n - 1) : std::nullopt;
    if (!full) return 2;
    const double paneGuess = std::max(60.0, orElse(containerHeight, 300) - 22 - (hasVolume(spec, norm) ? 56 : 0) - headerPx(spec));
    return decimalsFor(niceStep(full->second - full->first, std::max(3.0, std::floor(paneGuess / 46))));
}

QString colorOr(const QString& color) { return color.isEmpty() ? u"label2"_s : color; }

Parts defaultReadout(const Spec& spec, const Normalized& norm, int i, int dec) {
    if (i < 0 || i >= norm.times.size()) return {};
    if (const auto& b = norm.barAt[i]) {
        std::optional<Bar> prev;
        for (int k = i - 1; k >= 0; --k)
            if (norm.barAt[k]) {
                prev = norm.barAt[k];
                break;
            }
        std::optional<double> chg;
        if (prev) chg = (b->close - prev->close) / prev->close * 100;
        Parts p{{timeLabel(norm.times[i], true), u"label2"_s},
                {u"开 "_s + fmtPrice(b->open, dec), u"label"_s},
                {u"高 "_s + fmtPrice(b->high, dec), u"label"_s},
                {u"低 "_s + fmtPrice(b->low, dec), u"label"_s},
                {u"收 "_s + fmtPrice(b->close, dec), b->close >= b->open ? u"up"_s : u"down"_s}};
        p << (b->volume ? QPair<QString, QString>{u"量 "_s + fmtVol(b->volume), u"label2"_s} : QPair<QString, QString>{QString(), QString()});
        p << QPair<QString, QString>{chg ? (*chg >= 0 ? u"+"_s : QString()) + jsToFixed(*chg, 2) + u"%"_s : QString(),
                                     !chg ? u"label2"_s : *chg >= 0 ? u"up"_s : u"down"_s};
        return p;
    }
    // 没有蜡烛的时刻:各条有名字、有值的折线
    Parts p{{timeLabel(norm.times[i], true), u"label2"_s}};
    for (qsizetype l = 0; l < norm.lineValues.size() && l < spec.lines.size(); ++l) {
        const auto v = norm.lineValues[l][i];
        if (v && !spec.lines[l].label.isEmpty()) p.append({spec.lines[l].label + u' ' + fmtPrice(*v, dec), colorOr(spec.lines[l].color)});
    }
    return p;
}

QString tickMarkLabel(const Normalized& norm, qint64 stamp, int type) {
    if (!norm.realTime) {
        const qsizetype i = norm.stamps.indexOf(stamp);
        return i < 0 ? QString() : timeLabel(norm.times[i]);
    }
    const QDateTime d = QDateTime::fromSecsSinceEpoch(stamp, QTimeZone::UTC);
    const auto pad2 = [](int v) { return u"%1"_s.arg(v, 2, 10, QChar(u'0')); };
    switch (type) {
        case 0: return QString::number(d.date().year());
        case 1: return u"%1月"_s.arg(d.date().month());
        case 2: return pad2(d.date().month()) + u'-' + pad2(d.date().day());
        case 4: return pad2(d.time().hour()) + u':' + pad2(d.time().minute()) + u':' + pad2(d.time().second());
        default: return pad2(d.time().hour()) + u':' + pad2(d.time().minute());
    }
}

QString crosshairTime(const Normalized& norm, qint64 stamp) {
    const qsizetype i = norm.stamps.indexOf(stamp);
    return i < 0 ? QString() : timeLabel(norm.times[i], true);
}

QString viewKeyOf(const Spec& spec, const Normalized& norm) {
    if (spec.viewKey) return *spec.viewKey;
    return spec.ariaLabel + u'|' + (norm.times.isEmpty() ? QString() : norm.times.first());
}

ViewDecision keepViewport(const Normalized& prevNorm, const QString& prevKey, std::optional<ViewRange> prevRange, const Normalized& norm,
                          const QString& key) {
    const int pn = int(prevNorm.times.size());
    const int n = int(norm.times.size());
    const bool zoomed = prevRange && pn > 1 && (prevRange->from > 0.5 || prevRange->to < pn - 1.5);
    if (!zoomed || key != prevKey) return {};
    const double width = prevRange->to - prevRange->from;
    if (prevRange->to >= pn - 1.5) {
        // 贴着最右边看的:新 K 线进来继续贴着最右边
        const double to = n - 1 + (prevRange->to - (pn - 1));
        return {false, {to - width, to}};
    }
    // 停在中间看的:按左沿那根的时间找回位置
    const int at0 = int(std::max(0.0, std::min(double(pn - 1), jsRound(prevRange->from))));
    const auto it = norm.idx.constFind(prevNorm.times[at0]);
    if (it == norm.idx.cend()) return {};
    const double shift = *it - jsRound(prevRange->from);
    return {false, {prevRange->from + shift, prevRange->to + shift}};
}

// ---------------------------------------------------------------- 避让

QList<Tag> layoutTags(QList<Tag> tags, double minY, double maxY, double h) {
    std::stable_sort(tags.begin(), tags.end(), [](const Tag& a, const Tag& b) { return a.y < b.y; });
    for (Tag& t : tags) t.ly = std::min(maxY - h / 2, std::max(minY + h / 2, t.y));
    for (int pass = 0; pass < 8; ++pass) {
        bool moved = false;
        for (qsizetype i = 1; i < tags.size(); ++i) {
            Tag& a = tags[i - 1];
            Tag& b = tags[i];
            const double overlap = a.ly + h - b.ly;
            if (overlap > 0) {
                moved = true;
                if (a.pinned && !b.pinned) b.ly += overlap;
                else if (b.pinned && !a.pinned) a.ly -= overlap;
                else {
                    a.ly -= overlap / 2;
                    b.ly += overlap / 2;
                }
            }
        }
        for (Tag& t : tags)
            if (!t.pinned) t.ly = std::min(maxY - h / 2, std::max(minY + h / 2, t.ly));
        if (!moved) break;
    }
    return tags;
}

Rect placeLabel(QList<Rect>& placed, Rect rect, int dir) {
    for (int k = 0; k < 6; ++k) {
        const bool hit = std::any_of(placed.begin(), placed.end(), [&](const Rect& r) {
            return rect.x < r.x + r.w && rect.x + rect.w > r.x && rect.y < r.y + r.h && rect.y + rect.h > r.y;
        });
        if (!hit) break;
        rect.y += dir * (rect.h + 1);
    }
    placed << rect;
    return rect;
}

}  // namespace ibkr::shell::chart
