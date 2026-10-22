#include "shell/level_strip.h"

#include "shell/jsvalue.h"
#include "shell/track_levels.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <memory>

using namespace Qt::StringLiterals;

namespace ibkr::shell::levels {

namespace {

constexpr double kCorePct = 12;
constexpr double kZoneW = 0.13;
constexpr double kFont = 10;
constexpr double kLaneH = 15;
constexpr int kMaxLanes = 2;

QString n(double v) { return jsNumberToString(v); }

QString fmtLevelPrice(double price) {
    if (!std::isfinite(price)) return u"—"_s;
    return std::floor(price) == price ? n(price) : jsToFixed(price, 2);
}

struct Item {
    double price = 0;
    QJsonObject level;
    bool spot = false;
    QString kind, name, text;
    double w = 0, x = 0, lx = 0;
    int lane = 0;
    bool above = true;
    QString tip;
};
using ItemPtr = std::shared_ptr<Item>;

/// 同一层里按 x 推开:保持左右次序,相邻中心距不小于两者半宽之和 + 间隙;右端溢出就整体往回推
void spread(QList<ItemPtr> items, double width, double gap) {
    std::stable_sort(items.begin(), items.end(), [](const ItemPtr& a, const ItemPtr& b) { return a->x < b->x; });
    for (const ItemPtr& it : items) it->lx = std::min(std::max(it->x, it->w / 2), width - it->w / 2);
    for (qsizetype i = 1; i < items.size(); ++i) {
        const Item& prev = *items[i - 1];
        Item& cur = *items[i];
        cur.lx = std::max(cur.lx, prev.lx + prev.w / 2 + cur.w / 2 + gap);
    }
    if (items.isEmpty()) return;
    Item& last = *items.last();
    if (last.lx + last.w / 2 > width) {
        last.lx = width - last.w / 2;
        for (qsizetype i = items.size() - 2; i >= 0; --i) {
            const Item& next = *items[i + 1];
            Item& cur = *items[i];
            cur.lx = std::min(cur.lx, next.lx - next.w / 2 - cur.w / 2 - gap);
        }
    }
}

/// 一侧的标签分层:按 x 顺序,放得下就进第一层,否则第二层;两层都放不下就挤进右端更靠左的那层
QList<QList<ItemPtr>> lanes(QList<ItemPtr> items, double gap) {
    std::stable_sort(items.begin(), items.end(), [](const ItemPtr& a, const ItemPtr& b) { return a->x < b->x; });
    QList<QList<ItemPtr>> out;
    const auto rightEdge = [](const QList<ItemPtr>& lane) {
        return lane.isEmpty() ? -std::numeric_limits<double>::infinity() : lane.last()->x + lane.last()->w / 2;
    };
    for (const ItemPtr& it : items) {
        bool placed = false;
        for (int lane = 0; lane < kMaxLanes; ++lane) {
            while (out.size() <= lane) out.append(QList<ItemPtr>());
            const QList<ItemPtr>& l = out[lane];
            if (l.isEmpty() || it->x - it->w / 2 >= l.last()->x + l.last()->w / 2 + gap) {
                out[lane].append(it);
                it->lane = lane;
                placed = true;
                break;
            }
        }
        if (!placed) {
            int best = 0;
            for (int lane = 1; lane < kMaxLanes; ++lane)
                if (rightEdge(out[lane]) < rightEdge(out[best])) best = lane;
            out[best].append(it);
            it->lane = best;
        }
    }
    QList<QList<ItemPtr>> filled;
    for (const auto& l : out)
        if (!l.isEmpty()) filled.append(l);
    return filled;
}

QJsonObject el(const QString& tag, const QJsonObject& attrs, const QJsonArray& children = {}, const QString& text = QString()) {
    QJsonObject o{{u"tag"_s, tag}, {u"attrs"_s, attrs}, {u"children"_s, children}};
    if (!text.isEmpty()) o.insert(u"text"_s, text);
    return o;
}

}  // namespace

double measureFixed(const QString& text, bool, int) {
    // 按码位数(生成器那边是 [...text]):BMP 以外的字(emoji)算一个
    double w = 0;
    for (const char32_t cp : text.toUcs4()) w += (cp < 128 ? 0.6 : 1) * kFont;
    return w;
}

QJsonObject buildLevelStrip(const QJsonArray& levelList, std::optional<double> spot, double width, const Measure& measure) {
    struct Pt {
        double price;
        QJsonObject level;
        bool spot;
    };
    QList<Pt> pts;
    for (const QJsonValue& v : levelList) {
        const double p = jsNumber(v[u"price"]);
        if (std::isfinite(p)) pts.append({p, v.toObject(), false});
    }
    const std::optional<double> spotNum = spot && std::isfinite(*spot) ? spot : std::nullopt;
    if (spotNum) pts.append({*spotNum, {}, true});
    if (pts.isEmpty()) return {};

    const double margin = 10;
    // 横轴的价格 → x:核心区线性,两端压缩区各自线性
    double minP = pts.first().price, maxP = pts.first().price;
    for (const Pt& p : pts) {
        minP = std::min(minP, p.price);
        maxP = std::max(maxP, p.price);
    }
    const double inner = width - margin * 2;
    const double center = spotNum ? *spotNum : (minP + maxP) / 2;
    const double radius = center * (kCorePct / 100);
    double coreLo = center, coreHi = center;
    for (const Pt& p : pts) {
        if (std::fabs(p.price - center) > radius) continue;
        coreLo = std::min(coreLo, p.price);
        coreHi = std::max(coreHi, p.price);
    }
    // JS 的 a || b || 1:0 与 NaN 都往下落
    const auto falsy = [](double x) { return x == 0 || std::isnan(x); };
    double pad = (coreHi - coreLo) * 0.06;
    if (falsy(pad)) pad = center * 0.004;
    if (falsy(pad)) pad = 1;
    coreLo -= pad;
    coreHi += pad;
    const bool hasLeft = minP < coreLo;
    const bool hasRight = maxP > coreHi;
    const double zoneW = inner * kZoneW;
    const double leftW = hasLeft ? zoneW : 0;
    const double rightW = hasRight ? zoneW : 0;
    const double coreW = inner - leftW - rightW;
    const double coreX0 = margin + leftW;
    const auto nz = [](double v) { return v == 0 || std::isnan(v) ? 1.0 : v; };
    const auto xOf = [&](double price) {
        if (price >= coreLo && price <= coreHi) return coreX0 + ((price - coreLo) / (coreHi - coreLo)) * coreW;
        // 压缩区:最远的价位贴在轴的两端,离核心区留 15% 的空当画断口
        if (price < coreLo) return margin + ((price - minP) / nz(coreLo - minP)) * leftW * 0.85;
        return coreX0 + coreW + rightW * 0.15 + ((price - coreHi) / nz(maxP - coreHi)) * rightW * 0.85;
    };
    QList<double> breaks;
    if (hasLeft) breaks << coreX0 - 4;
    if (hasRight) breaks << coreX0 + coreW + 4;

    const double gap = 6;
    QList<ItemPtr> items;
    for (const Pt& pt : pts) {
        auto it = std::make_shared<Item>();
        it->price = pt.price;
        it->level = pt.level;
        it->spot = pt.spot;
        // 持仓追踪里自己设的线:另一种颜色,摆在它所在的那一侧
        const bool own = !pt.spot && isOwnLine(pt.level);
        const QString lk = pt.level.value("kind"_L1).toString();
        it->kind = pt.spot ? u"spot"_s : own ? u"own"_s : lk == u"resistance" ? u"resistance"_s : lk == u"support" ? u"support"_s : u"neutral"_s;
        const QString source = pt.level.value("source"_L1).toString();
        const QString label = pt.level.value("label"_L1).toString();
        if (pt.spot) it->name = u"现价"_s;
        else if (own) it->name = label.isEmpty() ? u"我的线"_s : label;
        else {
            it->name = sourceShort().value(source);
            if (it->name.isEmpty()) it->name = sourceLabel().value(source);
            if (it->name.isEmpty()) it->name = u"价位"_s;
        }
        it->text = fmtLevelPrice(pt.price);
        it->w = measure(it->name, false, 500) + 3 + measure(it->text, true, 600) + 6;
        it->x = xOf(pt.price);
        it->above = !(it->kind == u"support" || it->kind == u"spot" || (own && spotNum && pt.price < *spotNum));
        QString gapText;
        if (spotNum && !pt.spot) {
            const double g = (pt.price / *spotNum - 1) * 100;
            gapText = u" · 距现价 %1%2%"_s.arg(g > 0 ? u"+"_s : QString(), jsToFixed(g, 2));
        }
        it->tip = (pt.spot ? u"现价"_s : label.isEmpty() ? it->name : label) + u' ' + it->text + gapText;
        items.append(it);
    }
    QList<ItemPtr> aboveItems, belowItems;
    for (const ItemPtr& it : items) (it->above ? aboveItems : belowItems).append(it);
    const QList<QList<ItemPtr>> lanesAbove = lanes(aboveItems, gap);
    const QList<QList<ItemPtr>> lanesBelow = lanes(belowItems, gap);
    for (const auto& lane : lanesAbove) spread(lane, width, gap);
    for (const auto& lane : lanesBelow) spread(lane, width, gap);

    const double tick = 5;
    const double axisY = 4 + double(lanesAbove.size()) * kLaneH + tick + 4;
    const double height = axisY + tick + 4 + double(lanesBelow.size()) * kLaneH + 4;
    QJsonArray children;
    children.append(el(u"line"_s, {{u"class"_s, u"lstrip-axis"_s}, {u"x1"_s, n(margin - 6)}, {u"x2"_s, n(width - margin + 6)}, {u"y1"_s, n(axisY)}, {u"y2"_s, n(axisY)}}));
    for (double bx : breaks)
        children.append(el(u"path"_s, {{u"class"_s, u"lstrip-break"_s}, {u"d"_s, u"M%1 %2 l3 -10 M%3 %2 l3 -10"_s.arg(n(bx - 3), n(axisY + 5), n(bx + 1))}}));
    const auto labelY = [&](const Item& it) { return it.above ? axisY - tick - 4 - it.lane * kLaneH : axisY + tick + 4 + kFont + it.lane * kLaneH; };
    // 引线先画,压在刻度和文字下面
    for (const ItemPtr& it : items) {
        const double ly = labelY(*it);
        const double anchorY = it->above ? ly + 2 : ly - kFont;
        const double tipY = it->above ? axisY - tick : axisY + tick;
        if (std::fabs(it->lx - it->x) > 1 || it->lane > 0) {
            children.append(el(u"path"_s, {{u"class"_s, u"lstrip-lead "_s + it->kind},
                                           {u"d"_s, u"M%1 %2 L%1 %3 L%4 %5"_s.arg(n(it->x), n(tipY), n(tipY + (it->above ? -3 : 3)), n(it->lx), n(anchorY))}}));
        }
    }
    for (const ItemPtr& it : items) {
        if (it->kind == u"spot") {
            children.append(el(u"circle"_s, {{u"class"_s, u"lstrip-spot"_s}, {u"cx"_s, n(it->x)}, {u"cy"_s, n(axisY)}, {u"r"_s, u"4"_s}}));
        } else {
            children.append(el(u"line"_s, {{u"class"_s, u"lstrip-tick "_s + it->kind}, {u"x1"_s, n(it->x)}, {u"x2"_s, n(it->x)},
                                           {u"y1"_s, n(it->above ? axisY - tick : axisY)}, {u"y2"_s, n(it->above ? axisY : axisY + tick)}}));
        }
    }
    for (const ItemPtr& it : items) {
        const QJsonArray parts{el(u"tspan"_s, {{u"class"_s, u"lstrip-name"_s}}, {}, it->name), el(u"tspan"_s, {{u"class"_s, u"lstrip-price"_s}, {u"dx"_s, u"3"_s}}, {}, it->text),
                               el(u"title"_s, {}, {}, it->tip)};
        children.append(el(u"text"_s, {{u"class"_s, u"lstrip-text "_s + it->kind}, {u"x"_s, n(it->lx)}, {u"y"_s, n(labelY(*it))}, {u"text-anchor"_s, u"middle"_s}}, parts));
    }
    return el(u"svg"_s, {{u"class"_s, u"lstrip-svg"_s}, {u"width"_s, n(width)}, {u"height"_s, n(height)}, {u"viewBox"_s, u"0 0 %1 %2"_s.arg(n(width), n(height))}}, children);
}

}  // namespace ibkr::shell::levels
