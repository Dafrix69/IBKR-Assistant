// 蝴蝶测算面板的接线(shell/fly_controller):「写进指令」把测算过的这只蝶写成一句话接进左边的输入框(不发单、不覆盖已经写的);
// 点关口填中心行权价、点时刻填到达时刻并清掉日期;模型跟着 store 变;没有结果时「写进指令」什么都不做。
#include "shell/fly_controller.h"
#include "shell/fly_store.h"
#include "shell/trade_composer.h"

#include <QFile>
#include <QJsonDocument>
#include <QSignalSpy>
#include <QTest>

using namespace ibkr;
using namespace ibkr::shell;
using namespace Qt::StringLiterals;

namespace {

QJsonObject fixture() {
    static const QJsonObject j = [] {
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/fly-plan.json"));
        if (!f.open(QIODevice::ReadOnly)) qFatal("fly-plan.json 打不开");
        return QJsonDocument::fromJson(f.readAll()).object();
    }();
    return j;
}

}  // namespace

class TestFlyController : public QObject {
    Q_OBJECT
private slots:
    void writeInstructionAppends() {
        fly::StoreDeps d;
        QJsonValue result = fixture()[u"store"].toArray().at(2)[u"result"];
        d.plan = [&](const QJsonObject&, fly::StoreDeps::Reply done) {
            EngineReply r;
            r.ok = true;
            r.result = result;
            done(r);
        };
        d.recorder = [](fly::StoreDeps::Reply) {};
        d.setRecorder = [](bool, fly::StoreDeps::Reply) {};
        d.nowMs = [] { return fixture()[u"now"].toDouble(); };
        FlyStore store(d);
        trade::ComposerDeps cd;
        TradeComposer composer(cd, QString());
        FlyController c(&store, nullptr, nullptr, nullptr, nullptr, &composer);
        c.now = [] { return fixture()[u"now"].toDouble(); };
        // 没有结果:什么都不做
        c.writeInstruction();
        QCOMPARE(composer.text(), QString());
        QSignalSpy changed(&c, &FlyController::plannerChanged);
        c.pickLevel(7750);
        c.patch({{u"targetSpot"_s, u"7745"_s}});
        c.pickTime(u"14:30"_s);
        QVERIFY(changed.size() >= 3);
        QCOMPARE(store.plan()[u"form"][u"center"].toString(), u"7750"_s);
        QCOMPARE(store.plan()[u"form"][u"targetTime"].toString(), u"14:30"_s);
        QCOMPARE(store.plan()[u"form"][u"targetDate"].toString(), QString());
        QVERIFY(c.planner()[u"canRun"].toBool());
        store.run(false);
        QVERIFY(c.planner()[u"canWrite"].toBool());
        composer.setText(u"已经写的"_s);
        c.writeInstruction();
        // 当日到期:本地速记认得的写法,接在已经写的下面一行
        QCOMPARE(composer.text(), u"已经写的\nSPX 7750蝴蝶 25cm 看涨 2张 5.5"_s);
        // 表单改过:结果过期,「写进指令」灰掉
        c.patch({{u"targetSpot"_s, u"7760"_s}});
        QVERIFY(!c.planner()[u"canWrite"].toBool());
    }
};

QTEST_GUILESS_MAIN(TestFlyController)
#include "tst_fly_controller.moc"
