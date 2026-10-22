// engine/util/task(引擎的 async / await)在动手搬任何异步模块之前先过的几条:
//   · 异常穿得过 co_await(TS 的 try { await … } catch 一行对一行);
//   · 立刻开始跑(async 函数第一次 await 之前是同步的);
//   · 同一个 Task 被好几个调用方等(secrets.ts 的 pendingReads),都拿到同一个结果;
//   · 拥有协程的对象在它挂起时被删:不再接着跑,不碰已经释放的内存(这条在 ASan 下跑才有意义);
//   · withDeadline:慢的那件事超时了调用方拿到超时的错,那件事之后照样跑完、写下结果,不崩、不重复接着跑。
#include "util/error.h"
#include "util/task.h"

#include <QProcess>
#include <QTest>

using namespace ibkr::util;
using namespace Qt::StringLiterals;

namespace {

Task<int> throwsAfterSleep() {
    co_await sleepMs(10);
    throw JsError(u"券商没回话"_s);
    co_return 0;
}

Task<QString> catches(bool* reached) {
    try {
        co_await throwsAfterSleep();
        co_return u"不该到这里"_s;
    } catch (const JsError& e) {
        *reached = true;
        co_return u"接住了:"_s + e.message();
    }
}

struct Owner : QObject {
    int* steps;
    explicit Owner(int* s) : steps(s) {}
    Task<> run() {
        ++*steps;
        co_await sleepMs(30, this);
        ++*steps;  // 对象没了就不该走到这里
    }
};

Task<QString> slowRead(QProcess* p, QString* landed) {
    Deferred<QString> d;
    QObject::connect(p, &QProcess::finished, p, [d]() mutable { d.resolve(u"明文"_s); });
    p->start(u"/bin/sleep"_s, {u"0.3"_s});
    const QString v = co_await d.task();
    *landed = v;  // 超时之后才到:照样写下
    co_return v;
}

}  // namespace

class TestTask : public QObject {
    Q_OBJECT
private slots:
    void exceptionCrossesAwait() {
        bool reached = false;
        Task<QString> t = catches(&reached);
        QVERIFY(!t.done());
        QTRY_VERIFY(t.done());
        QVERIFY(reached);
        QCOMPARE(t.result(), u"接住了:券商没回话"_s);
    }

    void startsEagerly() {
        int n = 0;
        auto f = [](int* n) -> Task<> {
            *n = 1;
            co_await sleepMs(5);
            *n = 2;
        };
        Task<> t = f(&n);
        QCOMPARE(n, 1);  // 第一次 await 之前已经跑了
        QTRY_COMPARE(n, 2);
        QVERIFY(t.done());
    }

    void manyAwaitersShareOneResult() {
        Deferred<int> d;
        Task<int> shared = d.task();
        auto waiter = [](Task<int> t, int* out) -> Task<> { *out = co_await t; };
        int a = 0, b = 0;
        Task<> ta = waiter(shared, &a), tb = waiter(shared, &b);
        QVERIFY(!ta.done() && !tb.done());
        d.resolve(42);
        d.resolve(7);  // 第二次不算
        QCOMPARE(a, 42);
        QCOMPARE(b, 42);
        // 已经完成的 Task 再等:当场拿到
        int c = 0;
        Task<> tc = waiter(shared, &c);
        QCOMPARE(c, 42);
        QVERIFY(tc.done());
    }

    void ownerDeletedWhileSuspended() {
        int steps = 0;
        auto* owner = new Owner(&steps);
        Task<> t = owner->run();
        QCOMPARE(steps, 1);
        delete owner;  // 定时器随 context 一起没了:协程不再接着跑
        QTest::qWait(80);
        QCOMPARE(steps, 1);
        QVERIFY(!t.done());
    }

    void deadlineDoesNotCancelTheWork() {
        QProcess p;
        QString landed;
        Task<QString> work = slowRead(&p, &landed);
        Task<QString> limited = withDeadline(work, 50, [] { return JsError(u"系统凭证库 0 秒没有交出凭证"_s); });
        QTRY_VERIFY(limited.done());
        try {
            limited.result();
            QFAIL("应当超时");
        } catch (const JsError& e) {
            QCOMPARE(e.message(), u"系统凭证库 0 秒没有交出凭证"_s);
        }
        QVERIFY(landed.isEmpty());
        QTRY_VERIFY_WITH_TIMEOUT(work.done(), 3000);
        QCOMPARE(landed, u"明文"_s);
        QCOMPARE(work.result(), u"明文"_s);
        QVERIFY(limited.error());  // 迟到的结果不会把已经超时的那个改成成功
    }

    void deadlineMetInTime() {
        Deferred<int> d;
        Task<int> limited = withDeadline(d.task(), 200, [] { return JsError(u"超时"_s); });
        QTimer::singleShot(10, [d]() mutable { d.resolve(5); });
        QTRY_VERIFY(limited.done());
        QCOMPARE(limited.result(), 5);
        QTest::qWait(250);  // 定时器停了,不会再 reject
        QCOMPARE(limited.result(), 5);
    }
};

QTEST_GUILESS_MAIN(TestTask)
#include "tst_task.moc"
