// 提醒弹窗的内容清洗、摆放与列表合并(shell/popup_rules):清洗与摆放对着原模块(desktop/popup-window.js)现算的结果;
// 合并、关一条、「查看」照 desktop-popup.spec.ts 的那几条搬。
#include "json_compare.h"
#include "shell/popup_rules.h"

#include <QFile>
#include <QJsonDocument>
#include <QSignalSpy>
#include <QTest>

#include <limits>

using namespace ibkr;
using namespace ibkr::shell;
using namespace Qt::StringLiterals;

namespace {

/// 生成器里 JSON 表达不了的值:{ "__undefined": true } → 没有这个键;{ "__number": "NaN" } → NaN / ±Infinity
QJsonValue decode(const QJsonValue& v) {
    if (v.isArray()) {
        QJsonArray out;
        for (const QJsonValue& x : v.toArray()) out.append(decode(x));
        return out;
    }
    if (!v.isObject()) return v;
    const QJsonObject o = v.toObject();
    if (o.contains(u"__undefined"_s)) return QJsonValue(QJsonValue::Undefined);
    if (o.contains(u"__number"_s)) {
        const QString n = o.value(u"__number"_s).toString();
        return n == u"NaN"_s ? std::numeric_limits<double>::quiet_NaN() : n.startsWith(u'-') ? -std::numeric_limits<double>::infinity() : std::numeric_limits<double>::infinity();
    }
    QJsonObject out;
    for (auto it = o.begin(); it != o.end(); ++it) {
        const QJsonValue d = decode(it.value());
        if (!d.isUndefined()) out.insert(it.key(), d);
    }
    return out;
}

QJsonObject raw(const QString& id, double at, const QJsonObject& extra = {}) {
    QJsonObject o{{u"id"_s, id}, {u"kind"_s, u"anomaly"_s}, {u"symbol"_s, u"RKLB"_s}, {u"title"_s, u"RKLB 放量 3.1×"_s}, {u"body"_s, u"说明"_s}, {u"tone"_s, u"up"_s}, {u"at"_s, at}};
    for (auto it = extra.begin(); it != extra.end(); ++it) o.insert(it.key(), it.value());
    return o;
}

QStringList ids(const PopupQueue& q) {
    QStringList out;
    for (const QJsonValue& v : q.items()) out.append(v.toObject().value("id"_L1).toString());
    return out;
}

QJsonObject payload(const QJsonArray& items) { return QJsonObject{{u"items"_s, items}}; }

}  // namespace

class TestPopupRules : public QObject {
    Q_OBJECT
private slots:
    void matchesJsModule_data() {
        QTest::addColumn<QJsonObject>("c");
        QTest::addColumn<double>("now");
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/popup.json"));
        QVERIFY(f.open(QIODevice::ReadOnly));
        const QJsonObject doc = QJsonDocument::fromJson(f.readAll()).object();
        const QJsonObject limits = doc.value(u"limits"_s).toObject();
        QCOMPARE(limits.value(u"width"_s).toInt(), popup::kWidth);
        QCOMPARE(limits.value(u"maxItems"_s).toInt(), popup::kMaxItems);
        QCOMPARE(limits.value(u"notifyFallbackMax"_s).toInt(), popup::kNotifyFallbackMax);
        int n = 0;
        for (const QJsonValue& c : doc.value(u"cases"_s).toArray())
            QTest::newRow(qPrintable(u"%1 #%2"_s.arg(c.toObject().value(u"fn"_s).toString()).arg(n++))) << c.toObject() << doc.value(u"now"_s).toDouble();
    }
    void matchesJsModule() {
        QFETCH(QJsonObject, c);
        QFETCH(double, now);
        QJsonValue got;
        if (c.value(u"fn"_s) == u"sanitize"_s) {
            const popup::Sanitized s = popup::sanitizePayload(decode(c.value(u"input"_s)), now);
            got = QJsonObject{{u"items"_s, s.items}, {u"updown"_s, s.updown}, {u"dropped"_s, s.dropped}};
        } else {
            const QJsonObject in = c.value(u"input"_s).toObject();
            const QJsonObject a = in.value(u"area"_s).toObject();
            const QJsonValue h = in.value(u"height"_s);
            const QRect r = popup::bounds(QRectF(a[u"x"].toDouble(), a[u"y"].toDouble(), a[u"width"].toDouble(), a[u"height"].toDouble()),
                                          h.isDouble() ? h.toDouble() : std::numeric_limits<double>::quiet_NaN());
            got = QJsonObject{{u"x"_s, r.x()}, {u"y"_s, r.y()}, {u"width"_s, r.width()}, {u"height"_s, r.height()}};
        }
        const QString diff = test::jsonDiff(c.value(u"out"_s), got);
        QVERIFY2(diff.isEmpty(), qPrintable(diff));
    }

    void mergeDedupesSortsAndCaps() {
        PopupQueue q;
        QVERIFY(q.push(payload({raw(u"a"_s, 1000), raw(u"b"_s, 2000)})).shown == 2);
        QCOMPARE(ids(q), (QStringList{u"b"_s, u"a"_s}));
        q.push(payload({raw(u"a"_s, 3000, {{u"title"_s, u"RKLB 放量 5.0×"_s}})}));
        QCOMPARE(ids(q), (QStringList{u"a"_s, u"b"_s}));
        QCOMPARE(q.items().at(0).toObject()[u"title"].toString(), u"RKLB 放量 5.0×"_s);
        const auto batch = [](int from, int n) {
            QJsonArray out;
            for (int i = 0; i < n; ++i) out.append(raw(u"n%1"_s.arg(from + i), 10000 + from + i));
            return out;
        };
        q.push(payload(batch(0, 20)));
        q.push(payload(batch(20, 20)));
        QCOMPARE(q.items().size(), popup::kMaxItems);
        QCOMPARE(ids(q).first(), u"n39"_s);
        QVERIFY(!ids(q).contains(u"a"_s));
        // 一批超过 30 条:多出来的如实报成 dropped
        PopupQueue big;
        const PopupQueue::Counts c = big.push(payload(batch(0, 35)));
        QCOMPARE(c.shown, 30);
        QCOMPARE(c.dropped, 5);
        // 什么都没有:不算到达
        QSignalSpy arrived(&big, &PopupQueue::arrived);
        QCOMPARE(big.push(payload({})).shown, 0);
        QCOMPARE(arrived.size(), 0);
    }

    void dismissClearAndOpen() {
        PopupQueue q;
        QSignalSpy nav(&q, &PopupQueue::navigateRequested);
        q.push(payload({raw(u"x"_s, 2000, {{u"symbol"_s, u"rklb"_s}}), raw(u"y"_s, 1000, {{u"symbol"_s, u"SPX"_s}, {u"kind"_s, u"level"_s}, {u"page"_s, u"sectors"_s}})}));
        QVERIFY(q.open(u"x"_s));
        QCOMPARE(nav.last().at(0).toString(), u"quality"_s);  // page 缺省 quality
        QCOMPARE(nav.last().at(1).toString(), u"RKLB"_s);
        QCOMPARE(ids(q), QStringList{u"y"_s});
        QVERIFY(q.open(u"y"_s));
        QCOMPARE(nav.last().at(0).toString(), u"sectors"_s);
        QVERIFY(q.items().isEmpty());
        QVERIFY(!q.open(u"不存在"_s));
        QCOMPARE(nav.size(), 2);
        q.push(payload({raw(u"a"_s, 1), raw(u"b"_s, 2)}));
        QVERIFY(!q.dismiss(u"没有这条"_s));
        QVERIFY(q.dismiss(u"a"_s));
        q.clear();
        QVERIFY(q.items().isEmpty());
    }
};

QTEST_GUILESS_MAIN(TestPopupRules)
#include "tst_popup_rules.moc"
