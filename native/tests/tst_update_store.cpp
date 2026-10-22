// 新版本检查的节拍与顶栏提示(shell/update_store,照 store/update.ts):启动后一会儿问一次、之后按间隔;开发态不自动问;
// 关掉就停;手动问不叠加,而且叠上的那一次不打断定时;忽略按版本号;两个偏好记在本机。
#include "shell/update_store.h"

#include <QSignalSpy>
#include <QTemporaryDir>
#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;

namespace {

struct Fake {
    QList<bool> asked;
    QList<shell::UpdateStore::Done> pending;
    QJsonObject info{{u"newer"_s, true}, {u"latest"_s, u"0.5.3"_s}};
    bool answerAtOnce = true;
    QString error;
    shell::UpdateStore::Check fn() {
        return [this](bool force, shell::UpdateStore::Done done) {
            asked.append(force);
            if (answerAtOnce) done(info, error);
            else pending.append(done);
        };
    }
};

}  // namespace

class TestUpdateStore : public QObject {
    Q_OBJECT
private slots:
    void firstCheckThenInterval() {
        Fake f;
        shell::UpdateStore u(f.fn(), QString());
        u.firstDelayMs = 40;
        u.intervalMs = 120;
        u.start(false);
        QCOMPARE(f.asked.size(), 0);
        QTRY_COMPARE(f.asked.size(), 1);
        QCOMPARE(f.asked.at(0), false);
        QCOMPARE(u.badge()[u"latest"].toString(), u"0.5.3"_s);
        QTest::qWait(60);
        QCOMPARE(f.asked.size(), 1);
        QTRY_COMPARE(f.asked.size(), 2);
    }

    void devDoesNotAutoCheck() {
        Fake f;
        shell::UpdateStore u(f.fn(), QString());
        u.firstDelayMs = 20;
        u.start(true);
        QTest::qWait(100);
        QCOMPARE(f.asked.size(), 0);
        u.checkNow(true);  // 手动照常
        QCOMPARE(f.asked, QList<bool>{true});
    }

    void turningOffStops() {
        Fake f;
        shell::UpdateStore u(f.fn(), QString());
        u.firstDelayMs = 40;
        u.start(false);
        u.setAuto(false);
        QTest::qWait(120);
        QCOMPARE(f.asked.size(), 0);
        u.setAuto(true);
        QTRY_COMPARE(f.asked.size(), 1);
    }

    // 定时到点时正好有一次手动在问:不叠加,但下一次照排
    void overlapKeepsTheSchedule() {
        Fake f;
        f.answerAtOnce = false;
        shell::UpdateStore u(f.fn(), QString());
        u.firstDelayMs = 30;
        u.intervalMs = 60;
        u.start(false);
        u.checkNow(true);
        QVERIFY(u.checking());
        QTest::qWait(80);  // 定时的那一次撞上了
        QCOMPARE(f.asked.size(), 1);
        f.pending.takeFirst()(f.info, QString());
        QVERIFY(!u.checking());
        QTRY_COMPARE(f.asked.size(), 2);
    }

    // 回包挂在 SupportService 的网络请求上,可能比这个 store 活得久:store 没了之后回来的不能碰它(ASan 编法下会报 use-after-free)
    void replyAfterStoreIsGoneIsDropped() {
        Fake f;
        f.answerAtOnce = false;
        bool thenCalled = false;
        {
            shell::UpdateStore u(f.fn(), QString());
            u.check(false, [&thenCalled] { thenCalled = true; });
        }
        QCOMPARE(f.pending.size(), 1);
        f.pending.takeFirst()(f.info, QString());
        QVERIFY(!thenCalled);
    }

    void errorIsKeptQuietly() {
        Fake f;
        f.error = u"网络不通"_s;
        shell::UpdateStore u(f.fn(), QString());
        u.checkNow(false);
        QCOMPARE(u.error(), u"网络不通"_s);
        QVERIFY(u.info().isNull());
        QVERIFY(u.badge().isNull());
        f.error.clear();
        u.checkNow(false);
        QCOMPARE(u.error(), QString());
    }

    void dismissIsPerVersionAndPersists() {
        QTemporaryDir dir;
        const QString ini = dir.filePath(u"prefs.ini"_s);
        Fake f;
        {
            shell::UpdateStore u(f.fn(), ini);
            u.checkNow(false);
            u.dismiss(u"0.5.3"_s);
            QVERIFY(u.badge().isNull());
            u.setAuto(false);
        }
        shell::UpdateStore u(f.fn(), ini);
        QVERIFY(!u.autoCheck());
        QCOMPARE(u.dismissed(), u"0.5.3"_s);
        f.info[u"latest"] = u"0.5.4"_s;
        u.checkNow(false);
        QCOMPARE(u.badge()[u"latest"].toString(), u"0.5.4"_s);
        f.info[u"newer"] = false;
        u.checkNow(false);
        QVERIFY(u.badge().isNull());
    }
};

QTEST_GUILESS_MAIN(TestUpdateStore)
#include "tst_update_store.moc"
