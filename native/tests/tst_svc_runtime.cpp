// SvcRuntime 的真实现(QTimer)——对拍用的是虚拟钟,这里单测真的那一份:setTimeout 触发一次、clearTimeout 撤得掉(含在自己回调里撤)、
// setInterval 反复触发直到撤掉、sleep、醒着的时间只增不减、random 在 [0,1)。
#include "orchestrate/services/svc_runtime.h"

#include <QCoreApplication>
#include <QTest>

using namespace ibkr::orchestrate;

class TstSvcRuntime : public QObject {
    Q_OBJECT
private slots:
    void timeoutFiresOnce() {
        SvcRuntime& rt = qtRuntime();
        int n = 0;
        rt.setTimeout(10, [&] { ++n; });
        QTest::qWait(80);
        QCOMPARE(n, 1);
    }
    void timeoutCleared() {
        SvcRuntime& rt = qtRuntime();
        int n = 0;
        const int id = rt.setTimeout(30, [&] { ++n; });
        rt.clearTimeout(id);
        rt.clearTimeout(id);  // 再撤一次、撤没有的,都没事
        rt.clearTimeout(0);
        QTest::qWait(100);
        QCOMPARE(n, 0);
    }
    void ids() {
        SvcRuntime& rt = qtRuntime();
        const int a = rt.setTimeout(1000, [] {}), b = rt.setTimeout(1000, [] {});
        QVERIFY(a > 0 && b > 0 && a != b);
        rt.clearTimeout(a);
        rt.clearTimeout(b);
    }
    void intervalRepeatsUntilCleared() {
        SvcRuntime& rt = qtRuntime();
        int n = 0;
        int id = 0;
        id = rt.setInterval(10, [&] {
            if (++n == 3) rt.clearInterval(id);  // 在自己的回调里撤
        });
        QTest::qWait(250);
        QCOMPARE(n, 3);
    }
    void intervalClearedFromOutside() {
        SvcRuntime& rt = qtRuntime();
        int n = 0;
        const int id = rt.setInterval(10, [&] { ++n; });
        QTRY_VERIFY_WITH_TIMEOUT(n >= 2, 2000);
        rt.clearInterval(id);
        const int seen = n;
        QTest::qWait(80);
        QCOMPARE(n, seen);
    }
    void timeoutCanReschedule() {
        SvcRuntime& rt = qtRuntime();
        int n = 0;
        rt.setTimeout(5, [&] {
            ++n;
            rt.setTimeout(5, [&] { ++n; });
        });
        QTest::qWait(120);
        QCOMPARE(n, 2);
    }
    void sleepResolves() {
        SvcRuntime& rt = qtRuntime();
        auto t = rt.sleep(20);
        QVERIFY(!t.done());
        QTRY_VERIFY_WITH_TIMEOUT(t.done(), 2000);
    }
    void clocksAndRandom() {
        SvcRuntime& rt = qtRuntime();
        const double a = rt.perfMs();
        QTest::qWait(30);
        const double b = rt.perfMs();
        QVERIFY(b >= a + 20);
        bool varied = false;
        double first = rt.random();
        for (int i = 0; i < 50; ++i) {
            const double r = rt.random();
            QVERIFY(r >= 0 && r < 1);
            if (r != first) varied = true;
        }
        QVERIFY(varied);
    }
};

QTEST_MAIN(TstSvcRuntime)
#include "tst_svc_runtime.moc"
