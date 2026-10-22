#include "domain/follow_reader.h"

#include "util/error.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"

#include <QDir>
#include <QFileInfo>
#include <QPointer>
#include <QProcess>
#include <QRegularExpression>
#include <QSet>
#include <QTimer>

#include <cmath>
#include <cstdio>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;

namespace ibkr::domain {

namespace {
constexpr int kUntrustedRetryMs = 5'000;
constexpr int kRetryMinMs = 1'000;
constexpr int kRetryMaxMs = 60'000;
const QSet<QString> kReported{u"reading"_s, u"waiting"_s, u"no_list"_s, u"no_discord"_s, u"untrusted"_s};

QString defaultPlatform() {
#if defined(Q_OS_MACOS)
    return u"darwin"_s;
#elif defined(Q_OS_WIN)
    return u"win32"_s;
#else
    return u"linux"_s;
#endif
}
}  // namespace

std::optional<QString> readerProgram(const QProcessEnvironment& env, const QString& platform) {
    if ((platform.isEmpty() ? defaultPlatform() : platform) != u"darwin") return std::nullopt;
    const QString program = util::jsTrim(env.value(kReaderEnv));
    if (program.isEmpty() || !QDir::isAbsolutePath(program)) return std::nullopt;
    return QFileInfo(program).isFile() ? std::optional<QString>(program) : std::nullopt;
}

QStringList readerArgs(const QString& channel, const QString& out, bool askPermission) {
    QStringList a{u"--channel"_s, channel, u"--out"_s, out, u"--supervised"_s};
    if (askPermission) a << u"--ask-permission"_s;
    return a;
}

std::optional<std::pair<QString, std::optional<QString>>> parseReaderLine(const QString& line) {
    const auto raw = js::parse(line);
    if (!raw || raw->type != OJson::Object) return std::nullopt;
    const OJson* state = raw->get(u"state"_s);
    if (!state || state->type != OJson::String || !kReported.contains(state->s)) return std::nullopt;
    const OJson* t = raw->get(u"title"_s);
    std::optional<QString> title;
    if (t && t->type == OJson::String && !t->s.isEmpty()) {
        static const QRegularExpression re(u"[\\r\\n]+"_s);
        title = QString(t->s).replace(re, u" "_s).left(200);
    }
    return std::pair{state->s, title};
}

FollowReader::FollowReader(QString program_, QString channel_, QString out_, std::function<void(const ReaderStatus&)> onStatus, Spawn spawn, Schedule schedule)
    : program(std::move(program_)), channel(std::move(channel_)), out(std::move(out_)), onStatus_(std::move(onStatus)),
      spawn_(spawn ? std::move(spawn) : Spawn(spawnReaderProcess)), schedule_(std::move(schedule)) {
    if (!schedule_)
        schedule_ = [](int ms, std::function<void()> fn) -> std::function<void()> {
            auto* t = new QTimer;
            t->setSingleShot(true);
            QObject::connect(t, &QTimer::timeout, t, [t, fn = std::move(fn)] {
                t->deleteLater();
                fn();
            });
            t->start(ms);
            QPointer<QTimer> guard(t);
            return [guard] {
                if (guard) {
                    guard->stop();
                    guard->deleteLater();
                }
            };
        };
}

FollowReader::~FollowReader() {
    *alive_ = false;
    stop();
}

void FollowReader::start() {
    if (running_) return;
    running_ = true;
    launch();
}

void FollowReader::stop() {
    running_ = false;
    if (cancelTimer_) cancelTimer_();
    cancelTimer_ = nullptr;
    auto old = std::move(child_);
    child_.reset();
    if (old) old->kill();
}

void FollowReader::launch() {
    cancelTimer_ = nullptr;
    if (!running_) return;
    std::shared_ptr<ReaderChild> child;
    try {
        child = spawn_(program, readerArgs(channel, out, !asked_));
    } catch (const util::JsError& e) {
        gone(nullptr, std::nullopt, e.message());
        return;
    }
    asked_ = true;
    child_ = child;
    const ReaderChild* raw = child.get();
    auto buffered = std::make_shared<QString>();
    std::weak_ptr<bool> alive = alive_;
    child->onStdout = [this, raw, buffered, alive](const QByteArray& chunk) {
        if (alive.expired() || child_.get() != raw) return;
        *buffered += QString::fromUtf8(chunk);
        QStringList lines = buffered->split(u'\n');
        *buffered = lines.takeLast();
        for (const QString& line : lines) {
            const auto parsed = parseReaderLine(util::jsTrim(line));
            if (!parsed) continue;
            if (parsed->first == u"reading") delayMs_ = kRetryMinMs;
            set({parsed->first, parsed->second, std::nullopt});
            if (alive.expired()) return;  // onStatus 里把这个读窗口对象删了
        }
    };
    // 它往 stderr 写的只有固定的几句(写不进收件文件、参数不对),没有消息原文
    child->onStderr = [this, raw, alive](const QByteArray& chunk) {
        if (alive.expired() || child_.get() != raw) return;
        const QByteArray line = (u"[follow] 读窗口:"_s + util::jsTrim(QString::fromUtf8(chunk)).left(300) + u'\n').toUtf8();
        std::fwrite(line.constData(), 1, size_t(line.size()), stderr);
    };
    child->onError = [this, raw, alive](const QString& msg) {
        if (!alive.expired()) gone(raw, std::nullopt, msg);
    };
    child->onExit = [this, raw, alive](std::optional<int> code) {
        if (!alive.expired()) gone(raw, code, std::nullopt);
    };
}

void FollowReader::gone(const ReaderChild* child, std::optional<int> code, const std::optional<QString>& error) {
    if (child) {
        if (child_.get() != child) return;  // 同一个进程的 error 与 exit 可能都来,只认头一个
        child_.reset();
    }
    if (!running_) return;
    const std::weak_ptr<bool> alive = alive_;
    if (code && *code == kExitUntrusted) {
        set({u"untrusted"_s, std::nullopt, std::nullopt});
        if (alive.expired()) return;  // onStatus 里把这个读窗口对象删了
        retryIn(kUntrustedRetryMs);
        return;
    }
    const int delay = delayMs_;
    delayMs_ = std::min(delay * 2, kRetryMaxMs);
    const QString why = error ? u"起不来(%1)"_s.arg(*error) : u"退出了(退出码 %1)"_s.arg(code ? QString::number(*code) : u"无"_s);
    set({u"failed"_s, std::nullopt, u"读窗口的程序%1,%2 秒后重新启动"_s.arg(why).arg(qint64(std::round(delay / 1000.0)))});
    if (alive.expired()) return;
    retryIn(delay);
}

void FollowReader::retryIn(int ms) {
    std::weak_ptr<bool> alive = alive_;
    cancelTimer_ = schedule_(ms, [this, alive] {
        if (!alive.expired()) launch();
    });
}

void FollowReader::set(const ReaderStatus& next) {
    if (status_ == next) return;
    status_ = next;
    if (onStatus_) onStatus_(next);
}

namespace {
class ProcessChild : public ReaderChild {
public:
    explicit ProcessChild(QProcess* p) : p_(p) {}
    ~ProcessChild() override {
        if (p_) {
            p_->disconnect();
            p_->kill();
            p_->deleteLater();
        }
    }
    void kill() override {
        if (p_) p_->kill();
    }
    QPointer<QProcess> p_;
};
}  // namespace

std::shared_ptr<ReaderChild> spawnReaderProcess(const QString& program, const QStringList& args) {
    auto* p = new QProcess;
    auto child = std::make_shared<ProcessChild>(p);
    std::weak_ptr<ProcessChild> weak = child;
    QObject::connect(p, &QProcess::readyReadStandardOutput, p, [p, weak] {
        if (auto c = weak.lock(); c && c->onStdout) c->onStdout(p->readAllStandardOutput());
    });
    QObject::connect(p, &QProcess::readyReadStandardError, p, [p, weak] {
        if (auto c = weak.lock(); c && c->onStderr) c->onStderr(p->readAllStandardError());
    });
    QObject::connect(p, &QProcess::finished, p, [weak](int code, QProcess::ExitStatus st) {
        if (auto c = weak.lock(); c && c->onExit) c->onExit(st == QProcess::NormalExit ? std::optional<int>(code) : std::nullopt);
    });
    QObject::connect(p, &QProcess::errorOccurred, p, [weak, p](QProcess::ProcessError e) {
        if (e != QProcess::FailedToStart) return;  // 跑起来之后的崩溃由 finished 报
        if (auto c = weak.lock(); c && c->onError) c->onError(p->errorString());
    });
    p->start(program, args, QIODevice::ReadWrite);  // 标准输入留着不写
    return child;
}

}  // namespace ibkr::domain
