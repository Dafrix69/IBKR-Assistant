// 图表里不靠图表库的那一半(shell/chart_spec)对着原文现算的期望值(tests/fixtures/gen_chart.mjs:spec.ts / layout.ts 直接 import,
// engine.ts 闭包里的几段按原文切出来跑):13 份 spec 的归一化、五种下标区间的价格区间、量能封顶、五种图高的小数位、每一根的默认读数、
// 每个时间戳在五种刻度类型下的字与十字光标的字;刷新时视口怎么留(9 个场景);两种避让(25 + 15 组);几个格式函数。
#include "shell/chart_spec.h"

#include "shell/jsvalue.h"

#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QTest>

#include <cmath>

using namespace ibkr;
using namespace ibkr::shell;
using namespace Qt::StringLiterals;

namespace {

QJsonObject fixture() {
    static const QJsonObject j = [] {
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/chart.json"));
        if (!f.open(QIODevice::ReadOnly)) qFatal("chart.json 打不开");
        return QJsonDocument::fromJson(f.readAll()).object();
    }();
    return j;
}

/// 生成器把非有限数写成字符串
double numOf(const QJsonValue& v) {
    if (v.isString()) return v.toString() == u"NaN" ? std::nan("") : v.toString() == u"Infinity" ? INFINITY : -INFINITY;
    return v.toDouble();
}

bool near(double a, double b) { return a == b || std::abs(a - b) <= 1e-9 * std::max(1.0, std::abs(b)); }

QJsonArray partsJson(const chart::Parts& p) {
    QJsonArray out;
    for (const auto& [t, c] : p) out.append(QJsonArray{t, c});
    return out;
}

}  // namespace

class TestChartSpec : public QObject {
    Q_OBJECT
private slots:
    void specs_data() {
        QTest::addColumn<QJsonObject>("c");
        for (const QJsonValue& c : fixture()[u"specs"].toArray()) QTest::newRow(qPrintable(c[u"name"].toString())) << c.toObject();
    }
    void specs() {
        QFETCH(QJsonObject, c);
        const chart::Spec s = chart::specFromJson(c[u"spec"].toObject());
        const chart::Normalized n = chart::normalize(s);
        const QJsonObject want = c[u"norm"].toObject();

        QStringList times;
        for (const QJsonValue& t : want[u"times"].toArray()) times << t.toString();
        QCOMPARE(n.times, times);
        QCOMPARE(n.stamps.size(), want[u"stamps"].toArray().size());
        for (qsizetype i = 0; i < n.stamps.size(); ++i) QCOMPARE(double(n.stamps[i]), want[u"stamps"][i].toDouble());
        QCOMPARE(n.realTime, want[u"realTime"].toBool());
        QCOMPARE(n.intraday, want[u"intraday"].toBool());
        QCOMPARE(n.lastIdx, want[u"lastIdx"].toInt());
        for (qsizetype i = 0; i < n.barAt.size(); ++i) {
            const QJsonValue b = want[u"barAt"][i];
            QCOMPARE(n.barAt[i].has_value(), b.isObject());
            if (b.isObject()) QCOMPARE(n.barAt[i]->close, b[u"close"].toDouble());
        }
        for (qsizetype l = 0; l < n.lineValues.size(); ++l)
            for (qsizetype i = 0; i < n.lineValues[l].size(); ++i) {
                const QJsonValue v = want[u"lines"][l][u"values"][i];
                QVERIFY2(n.lineValues[l][i].has_value() == v.isDouble(), qPrintable(u"线 %1 第 %2 个"_s.arg(l).arg(i)));
                if (v.isDouble()) QCOMPARE(*n.lineValues[l][i], v.toDouble());
            }

        for (const QJsonValue& r : c[u"ranges"].toArray()) {
            const auto got = chart::priceRange(s, n, r[u"a"].toInt(), r[u"b"].toInt());
            QCOMPARE(got.has_value(), r[u"range"].isArray());
            if (got) {
                QVERIFY2(near(got->first, r[u"range"][0].toDouble()) && near(got->second, r[u"range"][1].toDouble()),
                         qPrintable(u"[%1, %2]:%3 / %4 ≠ %5 / %6"_s.arg(r[u"a"].toInt()).arg(r[u"b"].toInt()).arg(got->first).arg(got->second)
                                        .arg(r[u"range"][0].toDouble()).arg(r[u"range"][1].toDouble())));
            }
        }
        QCOMPARE(chart::hasVolume(s, n), c[u"hasVolume"].toBool());
        if (c[u"hasVolume"].toBool()) QCOMPARE(chart::volumeCap(n), c[u"cap"].toDouble());
        QCOMPARE(chart::headerPx(s), c[u"headerPx"].toDouble());
        const QJsonObject decs = c[u"decimals"].toObject();
        for (auto it = decs.begin(); it != decs.end(); ++it)
            if (it.value().isDouble()) QCOMPARE(chart::decimals(s, n, it.key().toDouble()), it.value().toInt());
        for (qsizetype i = 0; i < n.times.size(); ++i)
            QCOMPARE(partsJson(chart::defaultReadout(s, n, int(i), 2)), c[u"readouts"][i].toArray());
        for (const QJsonValue& t : c[u"ticks"].toArray()) {
            const qint64 stamp = qint64(t[u"stamp"].toDouble());
            for (int type = 0; type < 5; ++type) QCOMPARE(chart::tickMarkLabel(n, stamp, type), t[u"labels"][type].toString());
            QCOMPARE(chart::crosshairTime(n, stamp), t[u"crosshair"].toString());
        }
        QCOMPARE(chart::viewKeyOf(s, n), c[u"viewKey"].toString());
    }

    void viewport() {
        for (const QJsonValue& v : fixture()[u"viewport"].toArray()) {
            const auto norm = [](const QJsonValue& t) {
                chart::Spec s;
                QStringList ts;
                for (const QJsonValue& x : t.toArray()) ts << x.toString();
                s.times = ts;
                return chart::normalize(s);
            };
            std::optional<chart::ViewRange> prev;
            if (v[u"prevRange"].isObject()) prev = chart::ViewRange{v[u"prevRange"][u"from"].toDouble(), v[u"prevRange"][u"to"].toDouble()};
            const auto got = chart::keepViewport(norm(v[u"prevTimes"]), u"k"_s, prev, norm(v[u"times"]), v[u"sameKey"].toBool() ? u"k"_s : u"other"_s);
            const QJsonObject want = v[u"result"].toObject();
            QVERIFY2(got.reset == want[u"reset"].toBool(), qPrintable(v[u"label"].toString()));
            if (!got.reset) {
                QCOMPARE(got.range.from, want[u"range"][u"from"].toDouble());
                QCOMPARE(got.range.to, want[u"range"][u"to"].toDouble());
            }
        }
    }

    void layoutTags() {
        for (const QJsonValue& c : fixture()[u"layout"][u"tags"].toArray()) {
            QList<chart::Tag> tags;
            for (const QJsonValue& t : c[u"tags"].toArray()) tags.append({t[u"y"].toDouble(), 0, t[u"pinned"].toBool(), t[u"id"].toInt()});
            const auto got = chart::layoutTags(tags, c[u"minY"].toDouble(), c[u"maxY"].toDouble(), c[u"h"].toDouble());
            const QJsonArray want = c[u"result"].toArray();
            QCOMPARE(got.size(), want.size());
            for (qsizetype i = 0; i < got.size(); ++i) {
                QCOMPARE(got[i].id, want[i][u"id"].toInt());
                QVERIFY(near(got[i].ly, want[i][u"ly"].toDouble()));
            }
        }
        for (const QJsonValue& c : fixture()[u"layout"][u"labels"].toArray()) {
            QList<chart::Rect> placed;
            for (const QJsonValue& st : c.toArray()) {
                const QJsonObject r = st[u"rect"].toObject();
                const chart::Rect got = chart::placeLabel(placed, {r[u"x"].toDouble(), r[u"y"].toDouble(), r[u"w"].toDouble(), r[u"h"].toDouble()}, st[u"dir"].toInt());
                QVERIFY(near(got.y, st[u"placed"][u"y"].toDouble()));
            }
        }
    }

    void formats() {
        const QJsonObject f = fixture()[u"format"].toObject();
        for (const QJsonValue& x : f[u"niceStep"].toArray()) QVERIFY(near(chart::niceStep(x[0].toDouble(), x[1].toDouble()), x[2].toDouble()));
        for (const QJsonValue& x : f[u"decimalsFor"].toArray()) QCOMPARE(chart::decimalsFor(numOf(x[0])), x[1].toInt());
        for (const QJsonValue& x : f[u"fmtVol"].toArray())
            QCOMPARE(chart::fmtVol(x[0].isNull() ? std::nullopt : std::optional<double>(x[0].toDouble())), x[1].toString());
        for (const QJsonValue& x : f[u"fmtPrice"].toArray()) QCOMPARE(chart::fmtPrice(x[0].toDouble(), x[1].toInt()), x[2].toString());
        for (const QJsonValue& x : f[u"timeLabel"].toArray()) QCOMPARE(chart::timeLabel(x[0].toString(), x[1].toBool()), x[2].toString());
        for (const QJsonValue& x : f[u"wallClock"].toArray()) {
            const auto got = chart::wallClockSeconds(x[0].toString());
            QVERIFY2(got.has_value() == !x[1].isNull(), qPrintable(x[0].toString()));
            if (got) QCOMPARE(double(*got), x[1].toDouble());
        }
    }
};

QTEST_GUILESS_MAIN(TestChartSpec)
#include "tst_chart_spec.moc"
