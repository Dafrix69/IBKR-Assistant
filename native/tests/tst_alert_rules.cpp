// 提醒的口径(shell/alert_rules)与持仓追踪的价位(shell/track_levels)对着原模块(alertRules.ts / trackLevels.ts)现算的结果逐条对:
// 一批提醒响什么音、弹窗收了几条、窗口量比算不算放量、用户的线旁边是什么价位、弹窗末尾那一句追踪说明。
#include "json_compare.h"
#include "shell/alert_rules.h"
#include "shell/track_levels.h"

#include <QFile>
#include <QJsonDocument>
#include <QTest>

using namespace ibkr;
using namespace ibkr::shell;
using namespace Qt::StringLiterals;

namespace {

QJsonValue opt(const std::optional<QString>& s) { return s ? QJsonValue(*s) : QJsonValue(); }

QJsonValue run(const QString& fn, const QJsonArray& a) {
    const auto& names = levels::sourceShort();
    const auto d = [&](int i) { return a.at(i).toDouble(); };
    if (fn == u"toneDirection") {
        const QString t = alerts::toneDirection(a.at(0));
        return t.isEmpty() ? QJsonValue() : QJsonValue(t);
    }
    if (fn == u"popupCounts") {
        const auto c = alerts::popupCounts(a.at(0), a.at(1));
        return QJsonObject{{u"accepted"_s, c.accepted}, {u"dropped"_s, c.dropped}};
    }
    if (fn == u"burstVerdict") return alerts::burstVerdict(a.at(0), a.at(1));
    if (fn == u"ownLines") return levels::ownLines(a.at(0).toString(), a.at(1).toObject(), a.at(2).toObject());
    if (fn == u"nearestLevels") return levels::nearestLevels(a.at(0).toArray(), d(1));
    if (fn == u"levelSummary") return levels::levelSummary(a.at(0).toArray(), d(1), names);
    if (fn == u"pickSides") return levels::pickSides(a.at(0).toArray(), d(1), a.at(2).toString(), a.at(3).toBool(), a.at(4).toBool());
    if (fn == u"lineContext") return opt(levels::lineContext(a.at(0).toObject(), a.at(1).toArray(), d(2), names));
    if (fn == u"fmtLevel") return levels::fmtLevel(d(0));
    if (fn == u"fmtGap") return levels::fmtGap(d(0));
    if (fn == u"trackContext") return opt(levels::trackContext(a.at(0).toString(), a.at(1).toArray(), a.at(2).toObject()));
    return QJsonValue(u"没有这个函数:"_s + fn);
}

QJsonObject fixture() {
    QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/alert-rules.json"));
    if (!f.open(QIODevice::ReadOnly)) return {};
    return QJsonDocument::fromJson(f.readAll()).object();
}

}  // namespace

class TestAlertRules : public QObject {
    Q_OBJECT
private slots:
    void matchesTsModule_data() {
        QTest::addColumn<QString>("fn");
        QTest::addColumn<QJsonArray>("args");
        QTest::addColumn<QJsonValue>("expected");
        const QJsonArray cases = fixture().value(u"cases"_s).toArray();
        QVERIFY(cases.size() >= 100);
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

    // 常量与短名表和原模块是同一份
    void constantsMatch() {
        const QJsonObject f = fixture();
        QCOMPARE(f.value(u"blockShareHeavy"_s).toDouble(), alerts::kBlockShareHeavy);
        QCOMPARE(f.value(u"nearPct"_s).toDouble(), levels::kNearPct);
        const QJsonObject s = f.value(u"short"_s).toObject();
        QCOMPARE(qsizetype(s.size()), levels::sourceShort().size());
        for (auto it = s.begin(); it != s.end(); ++it) QCOMPARE(levels::sourceShort().value(it.key()), it.value().toString());
    }
};

QTEST_GUILESS_MAIN(TestAlertRules)
#include "tst_alert_rules.moc"
