#include "shell/popup_rules.h"

#include "shell/jsvalue.h"
#include "util/jsnum.h"

#include <QDateTime>
#include <QRegularExpression>
#include <QSet>

#include <algorithm>
#include <cmath>

using namespace Qt::StringLiterals;

namespace ibkr::shell::popup {

namespace {

bool invisible(char32_t c) {
    return (c >= 0x200B && c <= 0x200F) || c == 0x2028 || c == 0x2029 || (c >= 0x202A && c <= 0x202E) || (c >= 0x2060 && c <= 0x2069) || c == 0xFEFF;
}
bool control(char32_t c) { return c <= 0x1F || (c >= 0x7F && c <= 0x9F); }

/// 按码点截断:按 UTF-16 截可能劈开一个 emoji
QString clip(const QString& text, int max) {
    const QList<uint> cps = text.toUcs4();
    if (cps.size() <= max) return text;
    QString out = QString::fromUcs4(reinterpret_cast<const char32_t*>(cps.constData()), max);
    // trimEnd
    qsizetype e = out.size();
    while (e > 0 && util::isJsWhitespace(out.at(e - 1))) --e;
    return out.left(e);
}

QString cleanText(const QJsonValue& value, int max) {
    if (!value.isString() && !value.isDouble()) return {};
    const QString source = jsString(value);
    QString text;
    bool inSpace = false;
    for (char32_t c : source.toUcs4()) {
        if (invisible(c)) continue;
        if (control(c)) c = u' ';
        // /\s+/g → 一个空格(JS 的 \s)
        if (c <= 0xFFFF && util::isJsWhitespace(QChar(char16_t(c)))) {
            if (!inSpace) text += u' ';
            inSpace = true;
            continue;
        }
        inSpace = false;
        text += QString::fromUcs4(&c, 1);
    }
    return clip(jsTrim(text), max);
}

QString cleanSymbol(const QJsonValue& value) {
    if (!value.isString()) return {};
    static const QRegularExpression bad(uR"([^A-Z0-9.-])"_s);
    return value.toString().toUpper().remove(bad).left(16);
}

QJsonValue sanitizeItem(const QJsonValue& raw, double now) {
    if (!raw.isObject()) return QJsonValue();
    const QJsonObject o = raw.toObject();
    const QString id = cleanId(o.value("id"_L1));
    if (id.isEmpty()) return QJsonValue();  // 没有 id 就没法逐条关,整条不要
    static const QSet<QString> kinds{u"anomaly"_s, u"level"_s, u"event"_s};
    static const QSet<QString> tones{u"up"_s, u"down"_s, u"info"_s};
    static const QSet<QString> pages{u"quality"_s, u"sectors"_s, u"trade"_s, u"intel"_s, u"tracker"_s};
    const QString symbol = cleanSymbol(o.value("symbol"_L1));
    const QString title = cleanText(o.value("title"_L1), 80);
    const QJsonValue kind = o.value("kind"_L1), tone = o.value("tone"_L1), page = o.value("page"_L1), at = o.value("at"_L1);
    return QJsonObject{
        {u"id"_s, id},
        {u"kind"_s, kind.isString() && kinds.contains(kind.toString()) ? kind.toString() : u"anomaly"_s},
        {u"symbol"_s, symbol},
        {u"title"_s, title.isEmpty() ? symbol : title},
        {u"body"_s, cleanText(o.value("body"_L1), 240)},
        {u"tone"_s, tone.isString() && tones.contains(tone.toString()) ? tone.toString() : u"info"_s},
        {u"at"_s, at.isDouble() && std::isfinite(at.toDouble()) ? at.toDouble() : now},
        {u"page"_s, page.isString() && pages.contains(page.toString()) ? QJsonValue(page.toString()) : QJsonValue()},
    };
}

}  // namespace

QString cleanId(const QJsonValue& value) {
    if (!value.isString() && !value.isDouble()) return {};
    static const QRegularExpression bad(uR"([^A-Za-z0-9_:.\-|+])"_s);
    return jsString(value).remove(bad).left(100);
}

Sanitized sanitizePayload(const QJsonValue& payload, double now) {
    const QJsonObject src = payload.toObject();  // 不是对象就是空的
    const QJsonArray all = src.value("items"_L1).isArray() ? src.value("items"_L1).toArray() : QJsonArray();
    Sanitized out;
    const qsizetype take = std::min<qsizetype>(all.size(), kMaxIncoming);
    for (qsizetype i = 0; i < take; ++i) {
        const QJsonValue item = sanitizeItem(all.at(i), now);
        if (item.isObject()) out.items.append(item);
    }
    const QJsonValue updown = src.value("updown"_L1);
    out.updown = updown == u"red-up"_s || updown == u"green-up"_s ? updown.toString() : u"green-up"_s;
    out.dropped = int(all.size() - take);
    return out;
}

QRect bounds(const QRectF& area, double contentHeight) {
    const int maxHeight = std::max(kMinHeight, int(std::floor(area.height() * kMaxHeightRatio)));
    const int wanted = std::isfinite(contentHeight) ? int(std::ceil(contentHeight)) : kMinHeight;
    return QRect(int(jsRound(area.x() + area.width() - kWidth - kMargin)), int(jsRound(area.y() + kMargin)), kWidth,
                 std::min(std::max(wanted, kMinHeight), maxHeight));
}

}  // namespace ibkr::shell::popup

namespace ibkr::shell {

PopupQueue::PopupQueue(QObject* parent) : QObject(parent), now([] { return double(QDateTime::currentMSecsSinceEpoch()); }) {}

PopupQueue::Counts PopupQueue::push(const QJsonValue& payload) {
    const popup::Sanitized clean = popup::sanitizePayload(payload, now());
    updown_ = clean.updown;
    if (clean.items.isEmpty()) return {0, clean.dropped};
    // 这一批里同 id 的后一条算数;再接上原来那些(去掉这一批里有的)
    QList<QJsonObject> batch;
    for (const QJsonValue& v : clean.items) {
        const QString id = v.toObject().value("id"_L1).toString();
        batch.removeIf([&id](const QJsonObject& o) { return o.value("id"_L1).toString() == id; });
        batch.append(v.toObject());
    }
    QSet<QString> ids;
    for (const QJsonObject& o : batch) ids.insert(o.value("id"_L1).toString());
    QList<QJsonObject> merged = batch;
    for (const QJsonValue& v : items_)
        if (!ids.contains(v.toObject().value("id"_L1).toString())) merged.append(v.toObject());
    // 稳定排序:同一秒的几条保持"这一批在前、批内原顺序"
    std::stable_sort(merged.begin(), merged.end(), [](const QJsonObject& a, const QJsonObject& b) {
        return a.value("at"_L1).toDouble() > b.value("at"_L1).toDouble();
    });
    QJsonArray next;
    for (qsizetype i = 0; i < merged.size() && i < popup::kMaxItems; ++i) next.append(merged.at(i));
    items_ = next;
    emit changed();
    emit arrived();
    return {int(clean.items.size()), clean.dropped};
}

bool PopupQueue::dismiss(const QString& id) {
    const QString key = popup::cleanId(id);
    QJsonArray next;
    for (const QJsonValue& v : items_)
        if (v.toObject().value("id"_L1).toString() != key) next.append(v);
    if (next.size() == items_.size()) return false;
    items_ = next;
    emit changed();
    return true;
}

void PopupQueue::clear() {
    if (items_.isEmpty()) return;
    items_ = QJsonArray();
    emit changed();
}

bool PopupQueue::open(const QString& id) {
    const QString key = popup::cleanId(id);
    for (const QJsonValue& v : items_) {
        const QJsonObject o = v.toObject();
        if (o.value("id"_L1).toString() != key) continue;
        const QString page = o.value("page"_L1).isString() ? o.value("page"_L1).toString() : u"quality"_s;
        emit navigateRequested(page, o.value("symbol"_L1).toString());
        dismiss(key);
        return true;
    }
    return false;
}

}  // namespace ibkr::shell
