// engine/util/secrets + keychain + notify,照 engine-ts/tests/keychain-offloop.spec.ts 的 secrets 那几条搬:
//   · 凭证库永远不回话:到点抛 KeychainTimeoutError,话说清楚去处理弹窗;等的时候事件循环照转;
//   · 同一条凭证同时只读一次(只弹一个窗),后来的接着等它;调用方放弃之后那次读不撤,下一次接着等的就是它;
//   · 查有没有存过:不解密、答案记住;写过就记成有;查不出来按没存过答、不记;读到 null 也记下"没存过";
//   · 写入等不到:说清楚点了允许会自己写完;空密钥当场拒。
// 子进程那几条:用 /bin/sh 现编的子进程(答一行 / 答不出 / 一直不答到被杀),外加真的 ibkr-engine --keychain-child 查一个不存在的条目
// (不存在的条目不会弹窗)。全部离线。
#include "util/notify.h"
#include "util/secrets.h"

#include <QElapsedTimer>
#include <QJsonArray>
#include <QJsonObject>
#include <QProcess>
#include <QTest>

using namespace ibkr::util;
using namespace Qt::StringLiterals;

namespace {

/// 会记账的假凭证库:read / write 默认永远不回话(弹窗没人点)
struct FakeKeychain : SecretBackend {
    QStringList reads, checks;
    std::function<Task<bool>(QString, QString)> onExists;
    std::function<Task<std::optional<QString>>(QString, QString)> onRead;
    std::function<Task<>(QString, QString, QString)> onWrite;
    Task<bool> exists(const QString& s, const QString& a) override {
        if (onExists) return onExists(s, a);
        checks << s + u'/' + a;
        return Task<bool>::resolved(a == u"anthropic");
    }
    Task<std::optional<QString>> read(const QString& s, const QString& a) override {
        if (onRead) return onRead(s, a);
        reads << s + u'/' + a;
        return Deferred<std::optional<QString>>().task();  // 永远不回话
    }
    Task<> write(const QString& s, const QString& a, const QString& v) override {
        if (onWrite) return onWrite(s, a, v);
        return Deferred<>().task();
    }
};

template <class T>
QString errorOf(const Task<T>& t) {
    try {
        t.result();
    } catch (const JsError& e) {
        return e.message();
    }
    return {};
}
template <class T>
bool isTimeout(const Task<T>& t) {
    try {
        t.result();
    } catch (const KeychainTimeoutError&) {
        return true;
    } catch (...) {
    }
    return false;
}

}  // namespace

class TestSecrets : public QObject {
    Q_OBJECT
private slots:
    void cleanup() { useSecretBackend(nullptr); }

    void timesOutAndLoopKeepsTurning() {
        auto kc = std::make_shared<FakeKeychain>();
        useSecretBackend(kc, {300, 8000});
        int beats = 0;
        QTimer beat;
        QObject::connect(&beat, &QTimer::timeout, [&] { ++beats; });
        beat.start(20);
        QElapsedTimer t0;
        t0.start();
        Task<std::optional<QString>> r = readSecret(u"dafri-llm-api-key"_s, u"anthropic"_s);
        QTRY_VERIFY(r.done());
        beat.stop();
        QVERIFY(isTimeout(r));
        QVERIFY(errorOf(r).contains(u"没有交出凭证(service=dafri-llm-api-key, account=anthropic)"_s));
        QVERIFY(errorOf(r).contains(u"盯盘、托管单与其它功能照常运行"_s));
        QVERIFY(t0.elapsed() >= 280);
        QVERIFY(beats >= 5);
    }

    void oneReadAtATime() {
        auto kc = std::make_shared<FakeKeychain>();
        Deferred<std::optional<QString>> answer;
        kc->onRead = [&](QString s, QString a) {
            kc->reads << s + u'/' + a;
            return answer.task();
        };
        useSecretBackend(kc, {1000, 8000});
        Task<std::optional<QString>> a = readSecret(u"svc"_s, u"acct"_s), b = readSecret(u"svc"_s, u"acct"_s);
        QCOMPARE(kc->reads.size(), 1);
        answer.resolve(std::optional<QString>(u"sk-后点的"_s));
        QTRY_VERIFY(a.done() && b.done());
        QCOMPARE(*a.result(), u"sk-后点的"_s);
        QCOMPARE(*b.result(), u"sk-后点的"_s);
        QCOMPARE(kc->reads, QStringList{u"svc/acct"_s});
    }

    void abandonedReadIsNotCancelled() {
        auto kc = std::make_shared<FakeKeychain>();
        Deferred<std::optional<QString>> answer;
        kc->onRead = [&](QString s, QString a) {
            kc->reads << s + u'/' + a;
            return answer.task();
        };
        useSecretBackend(kc, {60, 8000});
        Task<std::optional<QString>> first = readSecret(u"svc"_s, u"acct"_s);
        QTRY_VERIFY(first.done());
        QVERIFY(isTimeout(first));
        Task<std::optional<QString>> retry = readSecret(u"svc"_s, u"acct"_s);
        answer.resolve(std::optional<QString>(u"sk-x"_s));
        QTRY_VERIFY(retry.done());
        QCOMPARE(*retry.result(), u"sk-x"_s);
        QCOMPARE(kc->reads.size(), 1);
    }

    // 读失败了(超时、钥匙串锁着)不能被记住:下一次读要重新问凭证库,不然那一个错会一直重复到下次写入
    void failedReadIsAskedAgain() {
        auto kc = std::make_shared<FakeKeychain>();
        QList<Deferred<std::optional<QString>>> answers;
        kc->onRead = [&](QString s, QString a) {
            kc->reads << s + u'/' + a;
            answers.append(Deferred<std::optional<QString>>());
            return answers.last().task();
        };
        useSecretBackend(kc, {1000, 8000});
        Task<std::optional<QString>> first = readSecret(u"svc"_s, u"acct"_s);
        answers[0].reject(KeychainError(u"钥匙串锁着"_s));
        QTRY_VERIFY(first.done());
        QCOMPARE(errorOf(first), u"钥匙串锁着"_s);
        Task<std::optional<QString>> second = readSecret(u"svc"_s, u"acct"_s);
        QCOMPARE(kc->reads.size(), 2);
        answers[1].resolve(std::optional<QString>(u"sk-2"_s));
        QTRY_VERIFY(second.done());
        QCOMPARE(*second.result(), u"sk-2"_s);
    }

    // 写入一开始就忘掉记下的「没存过」:写到一半时再问有没有,得重新去问,不能答旧的
    void writeForgetsRememberedAbsence() {
        auto kc = std::make_shared<FakeKeychain>();
        int asked = 0;
        kc->onExists = [&](QString, QString) {
            ++asked;
            return Task<bool>::resolved(false);
        };
        useSecretBackend(kc, {1000, 8000});
        Task<bool> before = secretExists(u"svc"_s, u"acct"_s);
        QVERIFY(before.done() && !before.result());
        QCOMPARE(asked, 1);
        Task<> w = writeSecret(u"svc"_s, u"acct"_s, u"sk-new"_s);  // 永远写不完(弹窗没人点)
        Task<bool> during = secretExists(u"svc"_s, u"acct"_s);
        QCOMPARE(asked, 2);
        QVERIFY(during.done());
    }

    // 写入开始之后的读不能接着等写入之前那一次读:那次读拿到的是旧值
    void readAfterWriteDoesNotJoinOlderRead() {
        auto kc = std::make_shared<FakeKeychain>();
        QList<Deferred<std::optional<QString>>> answers;
        kc->onRead = [&](QString s, QString a) {
            kc->reads << s + u'/' + a;
            answers.append(Deferred<std::optional<QString>>());
            return answers.last().task();
        };
        kc->onWrite = [](QString, QString, QString) { return Task<>::resolved(); };
        useSecretBackend(kc, {1000, 8000});
        Task<std::optional<QString>> old = readSecret(u"svc"_s, u"acct"_s);
        Task<> w = writeSecret(u"svc"_s, u"acct"_s, u"sk-new"_s);
        QVERIFY(w.done());
        Task<std::optional<QString>> fresh = readSecret(u"svc"_s, u"acct"_s);
        QCOMPARE(kc->reads.size(), 2);
        answers[1].resolve(std::optional<QString>(u"sk-new"_s));
        answers[0].resolve(std::optional<QString>(u"sk-old"_s));
        QTRY_VERIFY(old.done() && fresh.done());
        QCOMPARE(*fresh.result(), u"sk-new"_s);
        QCOMPARE(*old.result(), u"sk-old"_s);
    }

    // 查有没有存过的答案晚于一次写入回来:不能盖掉写入记下的「有」
    void lateExistsDoesNotOverwriteWrite() {
        auto kc = std::make_shared<FakeKeychain>();
        Deferred<bool> answer;
        int asked = 0;
        kc->onExists = [&](QString, QString) {
            ++asked;
            return answer.task();
        };
        kc->onWrite = [](QString, QString, QString) { return Task<>::resolved(); };
        useSecretBackend(kc, {1000, 8000});
        Task<bool> stale = secretExists(u"svc"_s, u"acct"_s);
        Task<> w = writeSecret(u"svc"_s, u"acct"_s, u"sk-new"_s);
        QVERIFY(w.done());
        answer.resolve(false);
        QTRY_VERIFY(stale.done());
        QVERIFY(!stale.result());
        Task<bool> now = secretExists(u"svc"_s, u"acct"_s);
        QVERIFY(now.done() && now.result());
        QCOMPARE(asked, 1);
    }

    // 读的答案晚于一次写入回来:不能把写入记下的「有」盖成旧的「没有」
    void lateReadDoesNotOverwriteWrite() {
        auto kc = std::make_shared<FakeKeychain>();
        Deferred<std::optional<QString>> answer;
        int asked = 0;
        kc->onRead = [&](QString, QString) { return answer.task(); };
        kc->onExists = [&](QString, QString) {
            ++asked;
            return Task<bool>::resolved(false);
        };
        kc->onWrite = [](QString, QString, QString) { return Task<>::resolved(); };
        useSecretBackend(kc, {1000, 8000});
        Task<std::optional<QString>> old = readSecret(u"svc"_s, u"acct"_s);
        Task<> w = writeSecret(u"svc"_s, u"acct"_s, u"sk-new"_s);
        QVERIFY(w.done());
        answer.resolve(std::nullopt);
        QTRY_VERIFY(old.done());
        Task<bool> now = secretExists(u"svc"_s, u"acct"_s);
        QVERIFY(now.done() && now.result());
        QCOMPARE(asked, 0);
    }

    void existsIsRememberedAndNeverDecrypts() {
        auto kc = std::make_shared<FakeKeychain>();
        bool broken = true;
        kc->onExists = [&](QString s, QString a) -> Task<bool> {
            kc->checks << s + u'/' + a;
            if (broken) {
                Deferred<bool> d;
                d.reject(KeychainError(u"security 退出码 51"_s));
                return d.task();
            }
            return Task<bool>::resolved(false);
        };
        kc->onWrite = [](QString, QString, QString) { return Task<>::resolved(); };
        useSecretBackend(kc);
        Task<bool> t1 = secretExists(u"svc"_s, u"a"_s);
        QVERIFY(t1.done() && !t1.result());  // 查不出来
        broken = false;
        QVERIFY(!secretExists(u"svc"_s, u"a"_s).result());  // 上一次没记,重新查
        QVERIFY(!secretExists(u"svc"_s, u"a"_s).result());  // 这一次记住了
        QCOMPARE(kc->checks, (QStringList{u"svc/a"_s, u"svc/a"_s}));
        Task<> w = writeSecret(u"svc"_s, u"a"_s, u"sk-new"_s);
        QTRY_VERIFY(w.done());
        w.result();
        QVERIFY(secretExists(u"svc"_s, u"a"_s).result());
        QCOMPARE(kc->checks.size(), 2);
        QVERIFY(kc->reads.isEmpty());
    }

    void readNullRemembersAbsence() {
        auto kc = std::make_shared<FakeKeychain>();
        kc->onRead = [](QString, QString) { return Task<std::optional<QString>>::resolved(std::nullopt); };
        useSecretBackend(kc);
        Task<std::optional<QString>> r = readSecret(u"svc"_s, u"gone"_s);
        QTRY_VERIFY(r.done());
        QVERIFY(!r.result());
        QVERIFY(!secretExists(u"svc"_s, u"gone"_s).result());
        QVERIFY(kc->checks.isEmpty());
    }

    void writeTimesOutAndEmptyRefused() {
        useSecretBackend(std::make_shared<FakeKeychain>(), {50, 8000});
        Task<> w = writeSecret(u"svc"_s, u"a"_s, u"sk"_s);
        QTRY_VERIFY(w.done());
        QVERIFY(isTimeout(w));
        QVERIFY(QRegularExpression(u"没有写完凭证.*这次保存会自己完成"_s).match(errorOf(w)).hasMatch());
        Task<> empty = writeSecret(u"svc"_s, u"a"_s, QString());
        QVERIFY(empty.done());
        QCOMPARE(errorOf(empty), u"拒绝写入空密钥"_s);
    }

    // ---- 凭证子进程 ----
    void childRepliesAndFailures() {
        // 答一行
        auto ok = childBackend(u"/bin/sh"_s, {u"-c"_s, u"read l; echo '{\"ok\":true,\"value\":\"sk-1\",\"exists\":true}'"_s}, 5000);
        Task<std::optional<QString>> r = ok->read(u"s"_s, u"a"_s);
        QTRY_VERIFY(r.done());
        QCOMPARE(*r.result(), u"sk-1"_s);
        // 子进程说失败:原话交出去
        auto bad = childBackend(u"/bin/sh"_s, {u"-c"_s, u"read l; echo '{\"ok\":false,\"error\":\"读取系统凭证失败(service=s, account=a):锁着\"}'"_s}, 5000);
        Task<std::optional<QString>> rb = bad->read(u"s"_s, u"a"_s);
        QTRY_VERIFY(rb.done());
        QCOMPARE(errorOf(rb), u"读取系统凭证失败(service=s, account=a):锁着"_s);
        // 答不出结果
        auto silent = childBackend(u"/bin/sh"_s, {u"-c"_s, u"read l; exit 3"_s}, 5000);
        Task<> ws = silent->write(u"s"_s, u"a"_s, u"x"_s);
        QTRY_VERIFY(ws.done());
        QCOMPARE(errorOf(ws), u"凭证子进程没有给出结果(退出码 3)"_s);
        // 一直不答:到硬上限被杀
        auto stuck = childBackend(u"/bin/sh"_s, {u"-c"_s, u"read l; sleep 30"_s}, 200);
        Task<std::optional<QString>> rs = stuck->read(u"s"_s, u"a"_s);
        QTRY_VERIFY_WITH_TIMEOUT(rs.done(), 3000);
        QCOMPARE(errorOf(rs), u"凭证子进程没有给出结果就被结束了(SIGKILL)"_s);
    }

    void realChildReadsAMissingEntry() {
#if defined(Q_OS_MACOS)
        auto real = childBackend(QStringLiteral(IBKR_ENGINE_PATH));
        Task<std::optional<QString>> r = real->read(u"dafri-native-test-never-stored"_s, u"nobody"_s);
        QTRY_VERIFY_WITH_TIMEOUT(r.done(), 25000);
        QVERIFY2(!r.error(), qPrintable(errorOf(r)));
        QVERIFY(!r.result());
        Task<bool> e = real->exists(u"dafri-native-test-never-stored"_s, u"nobody"_s);
        QTRY_VERIFY_WITH_TIMEOUT(e.done(), 10000);
        QVERIFY(!e.result());
#else
        QSKIP("只在 macOS 上碰系统凭证库");
#endif
    }

    void childRequestValidation() {
        QCOMPARE(runKeychainRequest(QJsonObject{{u"op"_s, u"get"_s}}), (QJsonObject{{u"ok"_s, false}, {u"error"_s, u"凭证请求缺 service / account"_s}}));
        QCOMPARE(runKeychainRequest(QJsonObject{{u"op"_s, u"zap"_s}, {u"service"_s, u"s"_s}, {u"account"_s, u"a"_s}}),
                 (QJsonObject{{u"ok"_s, false}, {u"error"_s, u"不认识的凭证操作:zap"_s}}));
        QCOMPARE(runKeychainRequest(QJsonObject{{u"op"_s, u"set"_s}, {u"service"_s, u"s"_s}, {u"account"_s, u"a"_s}}),
                 (QJsonObject{{u"ok"_s, false}, {u"error"_s, u"拒绝写入空密钥"_s}}));
        // 不是合法 JSON 的那一行
        QProcess p;
        p.start(QStringLiteral(IBKR_ENGINE_PATH), {u"--keychain-child"_s});
        QVERIFY(p.waitForStarted());
        p.write("{oops\n");
        QVERIFY(p.waitForFinished(5000));
        QCOMPARE(p.readAllStandardOutput().trimmed(), QByteArray(R"({"error":"凭证请求不是合法 JSON","ok":false})"));
    }

    // ---- notify ----
    void notifier() {
        QStringList seen, scripts;
        Notifier n(true, {[&](const QString& t, const QString& s, const QString& b) { seen << t + u'|' + s + u'|' + b; }});
        n.runOsascript = [&](const QString& s) { scripts << s; };
        n.fill(u"SPX"_s, u"BUY"_s, 2, 1.85, u"模拟"_s);
        n.notify(u"价位"_s, u"只进通知流"_s, {}, false);
        n.notify(u"含\"引号\"与\\反斜杠"_s, u"两行\n正文"_s);
        QCOMPARE(seen.first(), u"成交回报|账户 模拟|BUY SPX 2 @ 1.8500"_s);
        QCOMPARE(n.history.size(), size_t(3));
#if defined(Q_OS_MACOS)
        QCOMPARE(scripts.size(), 2);
        QCOMPARE(scripts[1], u"display notification \"两行 正文\" with title \"含\\\"引号\\\"与\\\\反斜杠\" subtitle \" \""_s);
#endif
        n.enabled = false;
        n.breaker(u"x"_s);
        QCOMPARE(scripts.size(), 2);
        QCOMPARE(seen.last(), u"已熔断:自动执行暂停|circuit breaker|x"_s);
    }
};

QTEST_GUILESS_MAIN(TestSecrets)
#include "tst_secrets.moc"
