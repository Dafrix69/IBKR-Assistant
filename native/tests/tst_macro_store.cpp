// 顶栏宏观行情带的取值(shell/macro_store,照 store/macro.ts + shell/MacroStrip.tsx):对着假引擎。
// 每格写什么(格式化、涨跌方向、读的是哪条行情)、迷你走势只收新读数、连没连券商决定多久读一次、入参的 force。
#include "shell/bridge.h"
#include "shell/confirm_grants.h"
#include "shell/consent.h"
#include "shell/macro_store.h"
#include "shell/status_store.h"
#include "shell_harness.h"

#include <QJsonArray>
#include <QTemporaryDir>

using namespace ibkr;
using namespace ibkr::test;
using namespace Qt::StringLiterals;

namespace {

QJsonObject obj(const char* t) { return QJsonDocument::fromJson(t).object(); }

struct Rig {
    QTemporaryDir dir;
    QString resultsPath = dir.filePath(u"results.json"_s);
    shell::EngineClient engine;
    QStringList logs;
    struct Yes : shell::Prompter {
        void ask(const shell::ConfirmBox&, std::function<void(bool)> d) override { d(true); }
    } yes;
    shell::ConsentStore consent{dir.path()};
    shell::Bridge bridge{&engine, &yes, &consent};
    shell::StatusStore status{&engine, 60'000};
    shell::MacroStore macro{&bridge, &status};
    double clock = 1'000'000;

    explicit Rig(bool connected)
        : engine(fakeEngine({{u"FAKE_STATUS"_s, connected ? u"{\"broker_connected\":true}"_s : u"{\"broker_connected\":false}"_s},
                             {u"FAKE_LOG_PARAMS"_s, u"1"_s},
                             {u"FAKE_RESULTS_FILE"_s, resultsPath}}),
                 40) {
        QObject::connect(&engine, &shell::EngineClient::logLine, [this](const QString& l) { logs.append(l); });
        macro.now = [this] { return clock; };
    }
    ~Rig() {
        shell::StopOptions o;
        o.drainMs = 0;
        stopSync(engine, o);
    }
    void board(const QJsonArray& rows) {
        QFile f(resultsPath);
        QVERIFY(f.open(QIODevice::WriteOnly));
        f.write(QJsonDocument(QJsonObject{{u"macro.board"_s, QJsonObject{{u"rows"_s, rows}, {u"at"_s, 1}, {u"live_count"_s, 1}}}}).toJson());
    }
    int calls() const { return int(logs.filter(u"[fake] macro.board"_s).size()); }
    QJsonObject cell(int i) const { return macro.rows().at(i).toObject(); }
};

QJsonArray rows(double spx) {
    QJsonObject first = obj(R"({"key":"^GSPC","label":"标普500","fmt":"price","change_pct":-0.3,"instrument":"SPX","source":"tws"})");
    first.insert(u"last"_s, spx);
    return QJsonArray{
        first,
        obj(R"({"key":"^TNX","label":"美债10Y","fmt":"pct","last":4.1,"change_pct":0.41,"instrument":"TNX","source":"tws"})"),
        obj(R"({"key":"^VIX","label":"VIX","fmt":"plain","last":14.6,"change_pct":0,"instrument":"Cboe","source":"public"})"),
        obj(R"({"key":"BTC-USD","label":"比特币","fmt":"price","last":113480.456,"change_pct":1.24,"instrument":null,"source":"public","stale":true})"),
        obj(R"({"key":"BZ=F","label":"布油","fmt":"price","last":null,"change_pct":null,"instrument":null,"source":"public"})"),
    };
}

}  // namespace

class TestMacroStore : public QObject {
    Q_OBJECT
private slots:
    void formatsEachCell() {
        Rig rig(true);
        rig.board(rows(7667.84));
        rig.macro.load();
        QTRY_COMPARE(rig.macro.rows().size(), 5);
        QVERIFY(!rig.macro.hidden());
        QCOMPARE(rig.cell(0)[u"value"].toString(), u"7,667.84"_s);
        QCOMPARE(rig.cell(0)[u"chg"].toString(), u"0.3%"_s);
        QCOMPARE(rig.cell(0)[u"dir"].toString(), u"down"_s);
        QVERIFY(rig.cell(0)[u"live"].toBool());
        QCOMPARE(rig.cell(0)[u"tip"].toString(), u"TWS 实时流式,读的是标的本身(SPX)"_s);
        QCOMPARE(rig.cell(1)[u"value"].toString(), u"4.10%"_s);
        QVERIFY(rig.cell(1)[u"tip"].toString().contains(u"除以 10"_s));
        QCOMPARE(rig.cell(2)[u"value"].toString(), u"14.60"_s);
        QCOMPARE(rig.cell(2)[u"dir"].toString(), u"flat"_s);
        QCOMPARE(rig.cell(2)[u"chg"].toString(), u"0%"_s);
        QVERIFY(rig.cell(2)[u"tip"].toString().startsWith(u"Yahoo 取不到"_s));
        QCOMPARE(rig.cell(3)[u"value"].toString(), u"113,480.46"_s);
        QVERIFY(rig.cell(3)[u"stale"].toBool());
        QVERIFY(rig.cell(3)[u"tip"].toString().startsWith(u"公开数据源"_s));
        QCOMPARE(rig.cell(4)[u"value"].toString(), u"—"_s);
        QCOMPARE(rig.cell(4)[u"dir"].toString(), QString());
        QCOMPARE(rig.cell(4)[u"inst"].toString(), QString());
        // 不给 force 时入参是空的(JS 的 { force: undefined } 序列化出来就是 {})
        QVERIFY2(rig.logs.contains(u"[fake] macro.board {}"_s), qPrintable(rig.logs.join(u'\n')));
        rig.macro.load(true);
        QTRY_VERIFY(rig.logs.contains(u"[fake] macro.board {\"force\":true}"_s));
    }

    void hiddenWhenNothingHasAValue() {
        Rig rig(true);
        rig.board(QJsonArray{obj(R"({"key":"BZ=F","label":"布油","fmt":"price","last":null,"change_pct":null,"source":"public"})")});
        rig.macro.load();
        QTRY_COMPARE(rig.macro.rows().size(), 1);
        QVERIFY(rig.macro.hidden());
    }

    // 走势:只收和上一个不一样的新读数,旧值不收,满 3 个才给
    void trailCollectsDistinctFreshReadings() {
        Rig rig(true);
        for (double v : {100.0, 100.0, 101.0}) {
            rig.board(rows(v));
            const int before = rig.calls();
            rig.macro.load();
            QTRY_COMPARE(rig.calls(), before + 1);
            QTRY_VERIFY(rig.cell(0)[u"value"].toString() == formatTwo(v));
        }
        QCOMPARE(rig.cell(0)[u"trail"].toArray().size(), 0);  // 100、101 只有两个
        rig.board(rows(99.5));
        rig.macro.load();
        QTRY_COMPARE(rig.cell(0)[u"trail"].toArray().size(), 3);
        QCOMPARE(rig.cell(0)[u"trail"].toArray().last().toDouble(), 99.5);
        QCOMPARE(rig.cell(0)[u"tint"].toString(), u"down"_s);
        QCOMPARE(rig.cell(3)[u"trail"].toArray().size(), 0);  // 比特币那格一直是旧值
    }

    // 连着券商 2 秒一读,没连一分钟一读
    void cadenceFollowsTheBrokerConnection() {
        for (const bool connected : {true, false}) {
            Rig rig(connected);
            rig.board(rows(7000));
            rig.status.refresh();
            QTRY_COMPARE(rig.status.engineOk(), 1);
            rig.macro.load();
            QTRY_COMPARE(rig.calls(), 1);
            QTRY_COMPARE(rig.macro.rows().size(), 5);
            rig.clock += 1'999;
            rig.macro.tick();
            QTest::qWait(150);
            QCOMPARE(rig.calls(), 1);
            rig.clock += 1;
            rig.macro.tick();
            if (connected) {
                QTRY_COMPARE(rig.calls(), 2);
            } else {
                QTest::qWait(150);
                QCOMPARE(rig.calls(), 1);
                rig.clock += 58'000;
                rig.macro.tick();
                QTRY_COMPARE(rig.calls(), 2);
            }
        }
    }

private:
    static QString formatTwo(double v) { return shell::formatEnUs(v, 2); }
};

QTEST_GUILESS_MAIN(TestMacroStore)
#include "tst_macro_store.moc"
