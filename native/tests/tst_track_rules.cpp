// 持仓追踪页的纯逻辑(shell/track_rules)对着原模块(lib/format.ts、spotStopFormat.ts、trackExitForm.ts、labels.ts、TrackCard.tsx 的 legLabel)
// 现算的结果逐条对。exitSpec 进钱路径:键的集合也比(原模块里是 undefined 的键,这里一个都不能有)。
#include "json_compare.h"
#include "shell/track_rules.h"

#include <QFile>
#include <QJsonDocument>
#include <QTest>

using namespace ibkr;
using namespace ibkr::shell;
using namespace Qt::StringLiterals;

namespace {

const QString kUndefined = u"__undefined__"_s;

/// 生成器把 undefined 写成 '__undefined__'
QJsonValue arg(const QJsonArray& a, int i) {
    const QJsonValue v = a.at(i);
    return v == kUndefined ? QJsonValue(QJsonValue::Undefined) : v;
}

std::optional<double> optNum(const QJsonValue& v) { return v.isDouble() ? std::optional<double>(v.toDouble()) : std::nullopt; }

QJsonValue run(const QString& fn, const QJsonArray& a) {
    const auto obj = [&](int i) { return a.at(i).toObject(); };
    if (fn == u"fmtNum") return track::fmtNum(arg(a, 0), a.at(1).toInt());
    if (fn == u"fmtMoney") return track::fmtMoney(arg(a, 0));
    if (fn == u"fmtExpiry") {
        const auto e = track::fmtExpiry(arg(a, 0));
        return e ? QJsonValue(*e) : QJsonValue();
    }
    if (fn == u"spotStopSummary") return track::spotStopSummary(optNum(a.at(0)), optNum(a.at(1)));
    if (fn == u"spotStopConfirmLine") return track::spotStopConfirmLine(u"SPX"_s, optNum(a.at(0)), optNum(a.at(1)));
    if (fn == u"spotStopLine") return track::spotStopLine(u"SPX"_s, obj(0));
    if (fn == u"exitSpec") return track::exitSpec(track::ExitFields::fromJson(obj(0)), a.at(1).toBool());
    if (fn == u"exitConfirmLines") return track::exitConfirmLines(track::ExitFields::fromJson(obj(0)), a.at(1).toBool());
    if (fn == u"exitProblems") {
        const QJsonObject o = obj(1);
        const track::ProblemOpts opts{o[u"hosted"].toBool(), o[u"hasSpotStop"].toBool(), o[u"stock"].toBool(), o[u"hasStockStop"].toBool()};
        return QJsonArray::fromStringList(track::exitProblems(track::ExitFields::fromJson(obj(0)), opts));
    }
    if (fn == u"tierLabel") return track::tierLabel(obj(0), a.at(1).toInt());
    if (fn == u"exitMoment") return track::exitMoment(a.at(0).toDouble());
    if (fn == u"exitSummary") return QJsonArray::fromStringList(track::exitSummary(obj(0), obj(1), a.at(2).toBool()));
    if (fn == u"legLabel") return track::legLabel(a.at(0).toString(), a.at(1).toString(), obj(2));
    return QJsonValue(u"没有这个函数:"_s + fn);
}

QJsonObject fixture() {
    QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/track-rules.json"));
    if (!f.open(QIODevice::ReadOnly)) return {};
    return QJsonDocument::fromJson(f.readAll()).object();
}

}  // namespace

class TestTrackRules : public QObject {
    Q_OBJECT
private slots:
    void rapidExitFields() {
        const auto fields = track::ExitFields::fromJson(QJsonObject{{u"rapidWindow"_s, 1.0}, {u"rapidPct"_s, 5.0}});
        const auto spec = track::exitSpec(fields, true);
        QCOMPARE(spec.value(u"rapid_exit_window_s"_s).toString(), u"1"_s);
        QCOMPARE(spec.value(u"rapid_exit_pct"_s).toString(), u"5"_s);
        QVERIFY(track::exitConfirmLines(fields, true).contains(u"亏损时也生效"_s));
        QVERIFY(track::exitProblems(fields, {}).isEmpty());
        auto half = fields;
        half.rapidPct.reset();
        QVERIFY(!track::exitProblems(half, {}).isEmpty());
        half = fields;
        half.rapidWindow = 0.1;
        QVERIFY(!track::exitProblems(half, {}).isEmpty());
        QVERIFY(!track::exitSpec(fields, false).contains(u"rapid_exit_pct"_s));
        track::ProblemOpts stock;
        stock.stock = true;
        QVERIFY(!track::exitProblems(fields, stock).isEmpty());
    }
    void matchesTsModule_data() {
        QTest::addColumn<QString>("fn");
        QTest::addColumn<QJsonArray>("args");
        QTest::addColumn<QJsonValue>("expected");
        const QJsonArray cases = fixture().value(u"cases"_s).toArray();
        QVERIFY(cases.size() >= 120);
        int n = 0;
        for (const QJsonValue& c : cases) {
            const QJsonObject o = c.toObject();
            const QString fn = o.value(u"fn"_s).toString();
            QTest::newRow(qPrintable(u"%1 #%2"_s.arg(fn).arg(n++))) << fn << o.value(u"args"_s).toArray() << o.value(u"out"_s);
        }
    }
    void matchesTsModule() {
        QFETCH(QString, fn);
        QFETCH(QJsonArray, args);
        QFETCH(QJsonValue, expected);
        const QString diff = test::jsonDiff(expected, run(fn, args));
        QVERIFY2(diff.isEmpty(), qPrintable(diff + u"\n入参 "_s + QString::fromUtf8(QJsonDocument(args).toJson(QJsonDocument::Compact))));
    }

    void tablesMatch() {
        const QJsonObject f = fixture();
        QCOMPARE(f[u"maxTiers"].toInt(), track::kMaxTiers);
        QJsonObject labels;
        for (auto it = track::trackStateLabel().begin(); it != track::trackStateLabel().end(); ++it) labels.insert(it.key(), it.value());
        QCOMPARE(test::jsonDiff(f[u"trackStateLabel"], labels), QString());
        // 空表单与原模块的 emptyExitFields 一样
        const track::ExitFields empty;
        const track::ExitFields fromFixture = track::ExitFields::fromJson(f[u"emptyExitFields"].toObject());
        QCOMPARE(empty.stopBasis, fromFixture.stopBasis);
        QCOMPARE(empty.exitAt, fromFixture.exitAt);
        QVERIFY(!fromFixture.stopConfirm && !fromFixture.chaseGrace && !fromFixture.peakConfirm && fromFixture.tiers.isEmpty());
    }
};

QTEST_GUILESS_MAIN(TestTrackRules)
#include "tst_track_rules.moc"
