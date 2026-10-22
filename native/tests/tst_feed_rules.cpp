// 日内剧本的人话(shell/playbook_format)与信息链路的界面规则(shell/intel_rules)对着原模块
// (lib/playbookFormat.ts / lib/intelRules.ts)现算的结果逐条对。本机时区那两样按 Asia/Shanghai。
#include "json_compare.h"
#include "shell/intel_rules.h"
#include "shell/playbook_format.h"

#include <QFile>
#include <QJsonDocument>
#include <QTest>

using namespace ibkr;
using namespace ibkr::shell;
using namespace Qt::StringLiterals;

namespace {

const QTimeZone kTz("Asia/Shanghai");

QJsonValue opt(const std::optional<QString>& s) { return s ? QJsonValue(*s) : QJsonValue(); }

QStringList strings(const QJsonValue& v) {
    QStringList out;
    for (const QJsonValue& s : v.toArray()) out << s.toString();
    return out;
}

QJsonValue run(const QString& fn, const QJsonArray& a) {
    const auto obj = [&](int i) { return a.at(i).toObject(); };
    const auto d = [&](int i) { return a.at(i).toDouble(); };
    if (fn == u"pb.fmtLevel") return playbook::fmtLevel(a.at(0));
    if (fn == u"pb.fmtGap") return playbook::fmtGap(a.at(0), a.at(1));
    if (fn == u"pb.etTime") return playbook::etTime(a.at(0));
    if (fn == u"pb.event") return QJsonObject{{u"tone"_s, playbook::eventTone(obj(0))}, {u"title"_s, playbook::eventTitle(u"SPX"_s, obj(0))}, {u"body"_s, playbook::eventBody(obj(0))}};
    if (fn == u"pb.bandRows") return playbook::bandRows(obj(0));
    if (fn == u"pb.gexText") return playbook::gexText(obj(0));
    if (fn == u"pb.coverageText") return playbook::coverageText(a.at(0), a.at(1));
    if (fn == u"pb.rearmText") return playbook::rearmText(a.at(0));
    if (fn == u"in.sourceLabel") return intel::sourceLabel(obj(0)[u"kind"].toString(), obj(0)[u"source"].toString());
    if (fn == u"in.relTime") return intel::relTime(d(0), d(1), kTz);
    if (fn == u"in.move") {
        if (!a.at(0).isObject()) return QJsonObject{{u"text"_s, QJsonValue()}, {u"tone"_s, intel::moveTone(QJsonValue())}};
        return QJsonObject{{u"text"_s, intel::moveText(obj(0))}, {u"tone"_s, intel::moveTone(a.at(0))}};
    }
    if (fn == u"in.filter") {
        QJsonArray ids;
        const QJsonObject f = obj(1);
        for (const QJsonValue& i : intel::filterItems(a.at(0).toArray(), strings(f[u"kinds"]), f[u"heldOnly"].toBool(), f[u"query"].toString())) ids.append(i[u"id"]);
        return ids;
    }
    if (fn == u"in.groupByDay") {
        QJsonArray out;
        for (const QJsonValue& g : intel::groupByDay(a.at(0).toArray(), d(1), kTz)) {
            QJsonArray ids;
            for (const QJsonValue& i : g[u"items"].toArray()) ids.append(i[u"id"]);
            out.append(QJsonObject{{u"label"_s, g[u"label"]}, {u"ids"_s, ids}});
        }
        return out;
    }
    if (fn == u"in.hot") return intel::hotSymbols(a.at(0).toArray(), a.at(1).toInt());
    if (fn == u"in.heldMention") return intel::isHeldMention(a.at(0)) ? QJsonValue(intel::heldMentionPopup(obj(0), d(1))) : QJsonValue();
    if (fn == u"in.lookupSymbol") return opt(intel::lookupSymbol(a.at(0).toString()));
    return QJsonValue(u"没有这个函数:"_s + fn);
}

QJsonObject fixture() {
    QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/feed-rules.json"));
    if (!f.open(QIODevice::ReadOnly)) return {};
    return QJsonDocument::fromJson(f.readAll()).object();
}

QJsonObject toJson(const QHash<QString, QString>& m) {
    QJsonObject o;
    for (auto it = m.begin(); it != m.end(); ++it) o.insert(it.key(), it.value());
    return o;
}

}  // namespace

class TestFeedRules : public QObject {
    Q_OBJECT
private slots:
    void matchesTsModule_data() {
        QTest::addColumn<QString>("fn");
        QTest::addColumn<QJsonArray>("args");
        QTest::addColumn<QJsonValue>("expected");
        const QJsonArray cases = fixture().value(u"cases"_s).toArray();
        QVERIFY(cases.size() >= 75);
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

    // 文案表与原模块是同一份
    void tablesMatch() {
        const QJsonObject f = fixture();
        QCOMPARE(test::jsonDiff(f[u"stateLabel"], toJson(playbook::stateLabel())), QString());
        QCOMPARE(test::jsonDiff(f[u"stateHint"], toJson(playbook::stateHint())), QString());
        QCOMPARE(f[u"gexAssumption"].toString(), playbook::kGexAssumption);
        QCOMPARE(f[u"gexAssumptionHint"].toString(), playbook::kGexAssumptionHint);
        QCOMPARE(test::jsonDiff(f[u"kindLabel"], toJson(intel::kindLabel())), QString());
        QCOMPARE(test::jsonDiff(f[u"kindIcon"], toJson(intel::kindIcon())), QString());
        QCOMPARE(test::jsonDiff(f[u"kindTint"], toJson(intel::kindTint())), QString());
        QCOMPARE(strings(f[u"kindOrder"]), intel::kindOrder());
    }
};

QTEST_GUILESS_MAIN(TestFeedRules)
#include "tst_feed_rules.moc"
