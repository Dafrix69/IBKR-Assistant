// 重要事件的判定(shell/event_rules)对着原模块(desktop/renderer-react/src/lib/eventRules.ts)现算的结果逐条对:
// 挂顶、阶段、倒计时、钟点(两个时区、夏令时换时那一周)、提前提醒、板块联动、盘前拉涨回吐、时段提醒(欧美夏令时错开的那几周)、对冲指令。
#include "json_compare.h"
#include "shell/event_rules.h"
#include "shell/jsvalue.h"

#include <QFile>
#include <QJsonDocument>
#include <QTest>

using namespace ibkr;
using namespace ibkr::shell::events;
using namespace Qt::StringLiterals;

namespace {

QJsonValue run(const QString& fn, const QJsonArray& a) {
    const auto obj = [&](int i) { return a.at(i).toObject(); };
    const auto d = [&](int i) { return a.at(i).toDouble(); };
    if (fn == u"starText") return starText(a.at(0));
    if (fn == u"phaseOf") return phaseOf(obj(0), d(1));
    if (fn == u"countdownText") return countdownText(obj(0), d(1));
    if (fn == u"whenText") return whenText(d(0), d(1), a.at(2).toString());
    if (fn == u"etDateOf") return etDateOf(d(0));
    if (fn == u"pinnedEvents") {
        const Pinned p = pinnedEvents(a.at(0).toArray(), d(1));
        QJsonArray ids;
        for (const QJsonValue& e : p.events) ids.append(e.toObject().value("id"_L1));
        return QJsonObject{{u"ids"_s, ids}, {u"more"_s, p.more}};
    }
    if (fn == u"leadsDue") {
        QList<double> leads;
        for (const QJsonValue& v : a.at(2).toArray()) leads.append(v.toDouble());
        QSet<QString> fired;
        for (const QJsonValue& v : a.at(3).toArray()) fired.insert(v.toString());
        QJsonArray out;
        for (const LeadDue& x : leadsDue(a.at(0).toArray(), d(1), leads, fired))
            out.append(QJsonObject{{u"key"_s, x.key}, {u"lead"_s, x.lead}, {u"id"_s, x.event.value("id"_L1)}});
        return out;
    }
    if (fn == u"leadTitle") return leadTitle(obj(0), d(1));
    if (fn == u"leadBody") return leadBody(obj(0), d(1), d(2), a.at(3).toString());
    if (fn == u"freshChanges") {
        QList<StockChange> stocks;
        for (const QJsonValue& v : a.at(0).toArray()) {
            const QJsonObject s = v.toObject();
            stocks.append({s.value("symbol"_L1).toString(), s.value("change_pct"_L1), s.value("at"_L1)});
        }
        QJsonObject out;
        const auto changes = freshChanges(stocks, d(1), d(2));
        for (auto it = changes.begin(); it != changes.end(); ++it) out.insert(it.key(), it->has_value() ? QJsonValue(**it) : QJsonValue());
        return out;
    }
    if (fn == u"sectorMoves") {
        QList<SectorInput> sectors;
        for (const QJsonValue& v : a.at(0).toArray()) {
            QStringList symbols;
            for (const QJsonValue& s : v.toObject().value("symbols"_L1).toArray()) symbols.append(s.toString());
            sectors.append({v.toObject().value("name"_L1).toString(), symbols});
        }
        QMap<QString, std::optional<double>> changes;
        const QJsonObject c = obj(1);
        for (auto it = c.begin(); it != c.end(); ++it) changes.insert(it.key(), it->isDouble() ? std::optional<double>(it->toDouble()) : std::nullopt);
        const QJsonObject r = obj(2);
        return sectorMoves(sectors, changes, {r.value("min_stocks"_L1).toDouble(), r.value("share"_L1).toDouble(), r.value("move_pct"_L1).toDouble()});
    }
    if (fn == u"sectorMoveTitle") return sectorMoveTitle(obj(0), a.at(1).toBool());
    if (fn == u"sectorMoveBody") return sectorMoveBody(obj(0), d(1), a.at(2).toBool());
    if (fn == u"etMinuteOf") return etMinuteOf(d(0));
    if (fn == u"isPremarket") return isPremarket(d(0));
    if (fn == u"sectorMedian") {
        QStringList symbols;
        for (const QJsonValue& v : a.at(0).toArray()) symbols.append(v.toString());
        QMap<QString, std::optional<double>> changes;
        const QJsonObject c = obj(1);
        for (auto it = c.begin(); it != c.end(); ++it) changes.insert(it.key(), it->isDouble() ? std::optional<double>(it->toDouble()) : std::nullopt);
        const auto m = sectorMedian(symbols, changes, d(2));
        return m ? QJsonValue(*m) : QJsonValue();
    }
    if (fn == u"fadeVerdict") return fadeVerdict(d(0), d(1));
    if (fn == u"fadeTitle") return fadeTitle(a.at(0).toString(), a.at(1).toString());
    if (fn == u"fadeBody") return fadeBody(d(0), d(1), a.at(2).toString());
    if (fn == u"londonNyGap") return londonNyGap(d(0));
    if (fn == u"sessionMarksDue") {
        QSet<QString> fired;
        for (const QJsonValue& v : a.at(1).toArray()) fired.insert(v.toString());
        QJsonArray out;
        for (const SessionMarkDue& x : sessionMarksDue(d(0), fired, a.at(2).toBool())) out.append(QJsonObject{{u"key"_s, x.key}, {u"id"_s, x.mark.id}});
        return out;
    }
    if (fn == u"sessionMarkBody") {
        for (const SessionMark& m : sessionMarks())
            if (m.id == a.at(0).toString()) return sessionMarkBody(m, d(1));
        return QJsonValue(u"没有这个时段:"_s + a.at(0).toString());
    }
    if (fn == u"strikeStep") return strikeStep(a.at(0).toString(), d(1));
    if (fn == u"hedgeInstruction") {
        const HedgeOut h = hedgeInstruction(obj(0));
        return QJsonObject{{u"text"_s, h.text}, {u"legs"_s, h.legs}, {u"problem"_s, h.problem.isEmpty() ? QJsonValue() : QJsonValue(h.problem)}};
    }
    if (fn == u"hedgeExpiryFor") return hedgeExpiryFor(obj(0), a.at(1).toString());
    return QJsonValue(u"没有这个函数:"_s + fn);
}

}  // namespace

class TestEventRules : public QObject {
    Q_OBJECT
private slots:
    void matchesTsModule_data() {
        QTest::addColumn<QString>("fn");
        QTest::addColumn<QJsonArray>("args");
        QTest::addColumn<QJsonValue>("expected");
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/event-rules.json"));
        QVERIFY(f.open(QIODevice::ReadOnly));
        const QJsonArray cases = QJsonDocument::fromJson(f.readAll()).object().value(u"cases"_s).toArray();
        QVERIFY(cases.size() >= 250);
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

    // toFixed 在一半上:真的一半取大的(0.25 → 0.3),看着像一半其实不到的(1.15 = 1.1499…)取小的
    void toFixedTies() {
        QCOMPARE(shell::jsToFixed(0.25, 1), u"0.3"_s);
        QCOMPARE(shell::jsToFixed(1.15, 1), u"1.1"_s);
        QCOMPARE(shell::jsToFixed(1.05, 1), u"1.1"_s);
        QCOMPARE(shell::jsToFixed(2.5, 0), u"3"_s);
        QCOMPARE(shell::jsToFixed(-0.04, 1), u"-0.0"_s);
        QCOMPARE(shell::jsToFixed(-0.0, 1), u"0.0"_s);
        // |x| ≥ 10^21:照 String(x) 写
        QCOMPARE(shell::jsToFixed(1e21, 2), u"1e+21"_s);
        QCOMPARE(shell::jsToFixed(-2.5e22, 0), u"-2.5e+22"_s);
        QCOMPARE(shell::jsToFixed(9.99e20, 0), u"999000000000000000000"_s);
    }
};

QTEST_GUILESS_MAIN(TestEventRules)
#include "tst_event_rules.moc"
