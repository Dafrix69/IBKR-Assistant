#include "util/secrets.h"

#include "util/jsformat.h"

#include <QCoreApplication>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QProcess>
#include <QSocketNotifier>
#include <QTimer>

#include <atomic>
#include <cmath>
#include <csignal>
#include <cstdio>
#include <thread>

#if !defined(Q_OS_WIN)
#include <unistd.h>
#endif

namespace ibkr::util {

using namespace Qt::StringLiterals;

namespace {

struct Store {
    std::shared_ptr<SecretBackend> backend;
    SecretLimits limits;
    QHash<QString, bool> known;
    QHash<QString, int> writes;
    QHash<QString, Task<std::optional<QString>>> pendingReads;
};
Store& store() {
    static Store s;
    return s;
}
QString keyOf(const QString& service, const QString& account) { return service + QChar(0) + account; }
int writesOf(const QString& key) { return store().writes.value(key, 0); }
SecretBackend& current() {
    if (!store().backend) store().backend = childBackend();
    return *store().backend;
}

QString timeoutMessage(const QString& what, const QString& service, const QString& account) {
    const QString seconds = jsNumberToString(jsRound(store().limits.timeoutMs / 1000.0));
#if defined(Q_OS_MACOS)
    const QString hint = u"macOS 多半正在弹窗,问是否允许本软件使用这条钥匙串项目(没有正式签名的版本,每换一个新安装包都会问一次):"
                         u"请在弹窗里输入这台 Mac 的登录密码,点「始终允许」,再重试这一步。"_s;
#else
    const QString hint = u"请稍后重试这一步。"_s;
#endif
    return u"系统凭证库 %1 秒没有%2凭证(service=%3, account=%4)。%5盯盘、托管单与其它功能照常运行。"_s.arg(seconds, what, service, account, hint);
}

void logLine(const QString& s) { std::fprintf(stderr, "%s\n", qPrintable(s)); }

}  // namespace

void useSecretBackend(std::shared_ptr<SecretBackend> next, SecretLimits limits) {
    Store& s = store();
    s.backend = std::move(next);
    s.limits = limits;
    s.known.clear();
    s.writes.clear();
    s.pendingReads.clear();
}

Task<bool> secretExists(QString service, QString account) {
    const QString key = keyOf(service, account);
    if (auto it = store().known.constFind(key); it != store().known.cend()) co_return it.value();
    const int before = writesOf(key);
    try {
        const bool exists = co_await withDeadline(current().exists(service, account), store().limits.existsTimeoutMs,
                                                  [service, account] { return KeychainTimeoutError(u"查询系统凭证库超时(service=%1, account=%2)"_s.arg(service, account)); });
        if (writesOf(key) == before) store().known.insert(key, exists);
        co_return exists;
    } catch (const std::exception& e) {
        const auto* js = dynamic_cast<const JsError*>(&e);
        logLine(u"[keychain] 查不出 %1/%2 有没有存过,先按没存过显示:%3"_s.arg(service, account, js ? js->message() : QString::fromUtf8(e.what())));
        co_return false;
    }
}

namespace {
Task<std::optional<QString>> readAndRemember(QString service, QString account, QString key, int before) {
    const std::optional<QString> value = co_await current().read(service, account);
    if (writesOf(key) == before) store().known.insert(key, value.has_value());
    co_return value;
}
}  // namespace

Task<std::optional<QString>> readSecret(QString service, QString account) {
    const QString key = keyOf(service, account);
    auto it = store().pendingReads.find(key);
    Task<std::optional<QString>> pending;
    if (it == store().pendingReads.end()) {
        const int before = writesOf(key);
        Task<std::optional<QString>> started = readAndRemember(service, account, key, before);
        if (!started.done()) {
            store().pendingReads.insert(key, started);
            started.onDone([key, started] {
                auto cur = store().pendingReads.find(key);
                if (cur != store().pendingReads.end() && cur.value() == started) store().pendingReads.erase(cur);
            });
        }
        pending = started;
    } else {
        pending = it.value();
    }
    co_return co_await withDeadline(pending, store().limits.timeoutMs,
                                    [service, account] { return KeychainTimeoutError(timeoutMessage(u"交出"_s, service, account)); });
}

Task<> writeSecret(QString service, QString account, QString secret) {
    if (secret.isEmpty()) throw KeychainError(u"拒绝写入空密钥"_s);
    const QString key = keyOf(service, account);
    store().writes.insert(key, writesOf(key) + 1);
    store().known.remove(key);
    store().pendingReads.remove(key);
    co_await withDeadline(current().write(service, account, secret), store().limits.timeoutMs, [service, account] {
        return KeychainTimeoutError(timeoutMessage(u"写完"_s, service, account) + u"在弹窗里点了允许之后,这次保存会自己完成;没看到弹窗就再保存一次。"_s);
    });
    store().writes.insert(key, writesOf(key) + 1);
    store().known.insert(key, true);
}

// ---------------------------------------------------------------- 真的后端
namespace {

/// 起一个凭证子进程做一次请求;子进程的 stdin 一直开着,引擎退出管道就断、子进程跟着结束
Task<QJsonObject> callKeychainChild(QString program, QStringList args, int hardCapMs, QJsonObject request) {
    Deferred<QJsonObject> d;
    auto* p = new QProcess;
    p->setProcessChannelMode(QProcess::SeparateChannels);
    QObject::connect(p, &QProcess::readyReadStandardError, p, [p] { std::fputs(p->readAllStandardError().constData(), stderr); });
    auto* cap = new QTimer(p);
    cap->setSingleShot(true);
    QObject::connect(cap, &QTimer::timeout, p, [p] { p->kill(); });
    QObject::connect(p, &QProcess::errorOccurred, p, [p, d](QProcess::ProcessError e) mutable {
        if (e == QProcess::FailedToStart) {
            d.reject(KeychainError(u"起不来凭证子进程:%1"_s.arg(p->errorString())));
            p->deleteLater();
        }
    });
    QObject::connect(p, &QProcess::finished, p, [p, d](int code, QProcess::ExitStatus status) mutable {
        const QList<QByteArray> lines = p->readAllStandardOutput().trimmed().split('\n');
        const QJsonObject reply = QJsonDocument::fromJson(lines.isEmpty() ? QByteArray() : lines.last()).object();
        if (reply.value(u"ok").isBool()) d.resolve(reply);
        else d.reject(KeychainError(status == QProcess::NormalExit ? u"凭证子进程没有给出结果(退出码 %1)"_s.arg(code) : u"凭证子进程没有给出结果就被结束了(SIGKILL)"_s));
        p->deleteLater();
    });
    p->start(program.isEmpty() ? QCoreApplication::applicationFilePath() : program, args);
    cap->start(hardCapMs);
    p->write(QJsonDocument(request).toJson(QJsonDocument::Compact) + '\n');
    co_return co_await d.task();
}

class ChildBackend : public SecretBackend {
public:
    ChildBackend(QString program, QStringList args, int hardCapMs) : program_(std::move(program)), args_(std::move(args)), hardCapMs_(hardCapMs) {}

    Task<bool> exists(const QString& service, const QString& account) override { return existsImpl(service, account); }
    Task<std::optional<QString>> read(const QString& service, const QString& account) override { return readImpl(service, account); }
    Task<> write(const QString& service, const QString& account, const QString& secret) override { return writeImpl(service, account, secret); }

private:
    Task<QJsonObject> ask(QJsonObject request) {
        const QJsonObject reply = co_await callKeychainChild(program_, args_, hardCapMs_, request);
        if (!reply.value(u"ok").toBool()) throw KeychainError(reply.value(u"error").toString());
        co_return reply;
    }
    Task<bool> existsImpl(QString service, QString account) {
        if (!keychainSupported()) co_return false;  // 没有系统凭证库就是没存过
#if defined(Q_OS_MACOS)
        co_return co_await securityHasItem(service, account);
#else
        const QJsonObject r = co_await ask({{u"op"_s, u"has"_s}, {u"service"_s, service}, {u"account"_s, account}});
        co_return r.value(u"exists").toBool();
#endif
    }
    Task<std::optional<QString>> readImpl(QString service, QString account) {
        requireKeychainSupported();
        const QJsonObject r = co_await ask({{u"op"_s, u"get"_s}, {u"service"_s, service}, {u"account"_s, account}});
        co_return r.value(u"value").isString() ? std::optional<QString>(r.value(u"value").toString()) : std::nullopt;
    }
    Task<> writeImpl(QString service, QString account, QString secret) {
        requireKeychainSupported();
        co_await ask({{u"op"_s, u"set"_s}, {u"service"_s, service}, {u"account"_s, account}, {u"secret"_s, secret}});
    }
    /// macOS:不带 -w / -g 的 security find-generic-password 只读属性、不解密;0 = 有,44 = 没有
    Task<bool> securityHasItem(QString service, QString account) {
        Deferred<bool> d;
        auto* p = new QProcess;
        auto* timer = new QTimer(p);
        timer->setSingleShot(true);
        QObject::connect(timer, &QTimer::timeout, p, [p] { p->kill(); });
        QObject::connect(p, &QProcess::finished, p, [p, d, service, account](int code, QProcess::ExitStatus status) mutable {
            if (status == QProcess::NormalExit && code == 0) d.resolve(true);
            else if (status == QProcess::NormalExit && code == 44) d.resolve(false);
            else d.reject(KeychainError(u"查询钥匙串失败(service=%1, account=%2):Command failed: /usr/bin/security find-generic-password -s %1 -a %2"_s.arg(service, account)));
            p->deleteLater();
        });
        QObject::connect(p, &QProcess::errorOccurred, p, [p, d](QProcess::ProcessError e) mutable {
            if (e == QProcess::FailedToStart) {
                d.reject(KeychainError(u"查询钥匙串失败:%1"_s.arg(p->errorString())));
                p->deleteLater();
            }
        });
        p->start(u"/usr/bin/security"_s, {u"find-generic-password"_s, u"-s"_s, service, u"-a"_s, account});
        timer->start(store().limits.existsTimeoutMs);
        co_return co_await d.task();
    }

    QString program_;
    QStringList args_;
    int hardCapMs_;
};

}  // namespace

std::shared_ptr<SecretBackend> childBackend(const QString& program, const QStringList& args, int hardCapMs) {
    return std::make_shared<ChildBackend>(program, args, hardCapMs);
}

int runKeychainChild() {
    // 读一行请求
    std::string line;
    int ch;
    while ((ch = std::fgetc(stdin)) != EOF && ch != '\n') line.push_back(char(ch));
    if (ch == EOF && line.empty()) return 0;
    QJsonParseError err;
    const QJsonDocument doc = QJsonDocument::fromJson(("[" + QByteArray::fromStdString(line) + "]"), &err);
    std::atomic<bool> answered{false};
    const auto reply = [&answered](const QJsonObject& r) {
        if (answered.exchange(true)) return;
        const QByteArray out = QJsonDocument(r).toJson(QJsonDocument::Compact) + '\n';
        std::fwrite(out.constData(), 1, size_t(out.size()), stdout);
        std::fflush(stdout);
        std::_Exit(0);
    };
    if (err.error != QJsonParseError::NoError || doc.array().size() != 1) {
        reply({{u"ok"_s, false}, {u"error"_s, u"凭证请求不是合法 JSON"_s}});
        return 0;
    }
    // 在另一个线程里做(可能停在系统弹窗前);这个线程盯着 stdin:引擎没了(或不要这个结果了)就不等,连同弹窗一起结束
    std::thread worker([req = doc.array().at(0), &reply] { reply(runKeychainRequest(req)); });
    worker.detach();
    while (std::fgetc(stdin) != EOF) {
    }
    if (!answered.load()) std::_Exit(137);  // 同 TS 的 SIGKILL 自己
    for (;;) std::this_thread::sleep_for(std::chrono::seconds(1));  // reply 正在写:它会 _Exit
}

}  // namespace ibkr::util
