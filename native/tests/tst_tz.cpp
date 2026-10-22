// engine/util/tz 对着原模块(engine-ts/src/tz.ts)现算的答案(tests/fixtures/gen_tz.mjs):
// 四年的 DST 边界前后每半小时、200 个随机时刻 × 6 个时区(含不认识的那个)的墙钟;2142 个墙钟(空隙、重叠、2 月 30 日、13 月、24 点)
// 的 wallToEpoch / zonedEpoch;IBKR 成交时间的几种写法;日期串的星期 / 天数 / endDateTime;Date.UTC 的进位。
#include "util/error.h"
#include "util/tz.h"

#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QTest>

#include <cmath>
#include <limits>

using namespace ibkr::util;
using namespace Qt::StringLiterals;

namespace {
QJsonObject fixture() {
    static const QJsonObject j = [] {
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/tz.json"));
        if (!f.open(QIODevice::ReadOnly)) qFatal("tz.json 打不开");
        return QJsonDocument::fromJson(f.readAll()).object();
    }();
    return j;
}
double dec(const QJsonValue& v) { return v.isString() && v.toString() == u"NaN" ? std::numeric_limits<double>::quiet_NaN() : v.toDouble(); }
bool same(double a, double b) { return (std::isnan(a) && std::isnan(b)) || a == b; }
QJsonObject partsJson(const WallParts& p) {
    return {{u"year"_s, p.year}, {u"month"_s, p.month}, {u"day"_s, p.day}, {u"hour"_s, p.hour}, {u"minute"_s, p.minute}, {u"second"_s, p.second}};
}
WallParts partsOf(const QJsonObject& o) {
    return {o[u"year"_s].toDouble(), o[u"month"_s].toDouble(), o[u"day"_s].toDouble(), o[u"hour"_s].toDouble(), o[u"minute"_s].toDouble(), o[u"second"_s].toDouble()};
}
/// { ok } / { error }:同一个调用在 C++ 里是值还是抛 JsError
template <class F>
void expectResult(const QJsonObject& r, F f, const QString& label) {
    try {
        const QJsonValue got = f();
        if (r.contains(u"error"_s)) QFAIL(qPrintable(label + u":应当抛 "_s + r[u"error"_s].toString()));
        const QJsonValue want = r[u"ok"_s];
        if (want.isDouble() || (want.isString() && want.toString() == u"NaN")) QVERIFY2(same(got.toDouble(), dec(want)), qPrintable(label));
        else QVERIFY2(got == want, qPrintable(label + u":期望 "_s + QString::fromUtf8(QJsonDocument(QJsonArray{want}).toJson(QJsonDocument::Compact)) + u",实际 "_s + QString::fromUtf8(QJsonDocument(QJsonArray{got}).toJson(QJsonDocument::Compact))));
    } catch (const JsError& e) {
        if (!r.contains(u"error"_s)) QFAIL(qPrintable(label + u":不该抛 "_s + e.message()));
        QCOMPARE(e.message(), r[u"error"_s].toString());
    }
}
}  // namespace

class TestTz : public QObject {
    Q_OBJECT
private slots:
    void wallPartsAndStamps() {
        for (const QJsonValue& v : fixture()[u"parts"_s].toArray()) {
            const QJsonObject c = v.toObject();
            const double e = dec(c[u"e"_s]);
            const QString z = c[u"z"_s].toString();
            expectResult(c[u"r"_s].toObject(), [&] { return QJsonValue(partsJson(wallParts(e, z))); }, u"wallParts(%1, %2)"_s.arg(e, 0, 'f', 0).arg(z));
        }
        for (const QJsonValue& v : fixture()[u"stamps"_s].toArray()) {
            const QJsonObject c = v.toObject();
            const double e = dec(c[u"e"_s]);
            const QString z = c[u"z"_s].toString();
            expectResult(c[u"date"_s].toObject(), [&] { return QJsonValue(dateStrAt(e, z)); }, u"dateStrAt"_s);
            expectResult(c[u"stamp"_s].toObject(), [&] { return QJsonValue(stampAt(e, z)); }, u"stampAt"_s);
        }
    }

    void walls() {
        for (const QJsonValue& v : fixture()[u"walls"_s].toArray()) {
            const QJsonObject c = v.toObject();
            const WallParts w = partsOf(c[u"w"_s].toObject());
            const QString z = c[u"z"_s].toString();
            const QString label = u"%1-%2-%3 %4:%5 %6"_s.arg(w.year).arg(w.month).arg(w.day).arg(w.hour).arg(w.minute).arg(z);
            expectResult(c[u"toEpoch"_s].toObject(), [&] { return QJsonValue(wallToEpoch(w, z)); }, u"wallToEpoch "_s + label);
            expectResult(c[u"zoned"_s].toObject(), [&] {
                const std::optional<double> r = zonedEpoch(w, z);
                return r ? QJsonValue(*r) : QJsonValue(QJsonValue::Null);
            }, u"zonedEpoch "_s + label);
        }
    }

    void ibTimes() {
        for (const QJsonValue& v : fixture()[u"ib"_s].toArray()) {
            const QJsonObject c = v.toObject();
            const std::optional<IbWall> got = ibWallTime(c[u"s"_s].toString());
            if (c[u"r"_s].isNull()) {
                QVERIFY2(!got, qPrintable(c[u"s"_s].toString()));
                continue;
            }
            QVERIFY2(got, qPrintable(c[u"s"_s].toString()));
            QCOMPARE(QJsonValue(partsJson(got->wall)), c[u"r"_s][u"wall"_s]);
            QCOMPARE(got->tz, c[u"r"_s][u"tz"_s].toString());
        }
    }

    void dates() {
        for (const QJsonValue& v : fixture()[u"dates"_s].toArray()) {
            const QJsonObject c = v.toObject();
            const QString d = c[u"d"_s].toString();
            QVERIFY2(same(weekdayOfDate(d), dec(c[u"weekday"_s])), qPrintable(d));
            QVERIFY2(same(dateOrdinal(d), dec(c[u"ordinal"_s])), qPrintable(d));
            expectResult(c[u"endUtc"_s].toObject(), [&] { return QJsonValue(ibEndUtc(d)); }, u"ibEndUtc "_s + d);
            expectResult(c[u"endUtc2"_s].toObject(), [&] { return QJsonValue(ibEndUtc(d, 9, 30)); }, u"ibEndUtc 9:30 "_s + d);
        }
        for (const QJsonValue& v : fixture()[u"ordinals"_s].toArray()) QCOMPARE(ordinalToDate(dec(v[u"o"_s])), v[u"date"_s].toString());
        for (const QJsonValue& v : fixture()[u"ymd"_s].toArray())
            QVERIFY2(isValidYmd(v[u"y"_s].toDouble(), v[u"m"_s].toDouble(), v[u"d"_s].toDouble()) == v[u"ok"_s].toBool(), qPrintable(QString::number(v[u"y"_s].toDouble())));
        for (const QJsonValue& v : fixture()[u"iso"_s].toArray()) {
            const double e = dec(v[u"e"_s]);
            expectResult(v[u"utc"_s].toObject(), [&] { return QJsonValue(utcIso(e)); }, u"utcIso"_s);
        }
        for (const QJsonValue& v : fixture()[u"pads"_s].toArray()) QCOMPARE(pad2(dec(v[u"n"_s])), v[u"s"_s].toString());
        for (const QJsonValue& v : fixture()[u"utc"_s].toArray()) {
            const QJsonArray a = v[u"a"_s].toArray();
            const double t = dateUtc(dec(a[0]), dec(a[1]), a.size() > 2 ? dec(a[2]) : 1, a.size() > 3 ? dec(a[3]) : 0, a.size() > 4 ? dec(a[4]) : 0, a.size() > 5 ? dec(a[5]) : 0);
            QVERIFY2(same(t, dec(v[u"t"_s])), qPrintable(QString::fromUtf8(QJsonDocument(a).toJson(QJsonDocument::Compact))));
        }
    }
};

QTEST_GUILESS_MAIN(TestTz)
#include "tst_tz.moc"
