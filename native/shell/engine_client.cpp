#include "shell/engine_client.h"

#include <QDateTime>
#include <QJsonDocument>
#include <QJsonObject>
#include <QTimer>

#include <algorithm>
#include <cmath>
#include <utility>

namespace ibkr::shell {

using namespace Qt::StringLiterals;

namespace {

constexpr int kCallTimeoutMs = 120'000;
/// 超时之后还记着的调用(只记要求记的):引擎迟到的回执靠它认出来
constexpr qsizetype kLateKeep = 32;
constexpr qsizetype kTailKeep = 200;

qint64 nowMs() { return QDateTime::currentMSecsSinceEpoch(); }

EngineReply failure(const QString& message, const QString& code = {}) {
    EngineReply r;
    r.error = message;
    r.code = code;
    return r;
}

}  // namespace

struct EngineClient::Child {
    QProcess* process = nullptr;
    QByteArray out;
    QByteArray err;
    bool settled = false;
    QList<std::function<void()>> onFinished;
};

struct EngineClient::Pending {
    QString method;
    std::shared_ptr<Child> child;
    QTimer* timer = nullptr;
    ReplyHandler done;
};

struct EngineClient::TimedOut {
    int id = 0;
    QString method;
    std::shared_ptr<Child> child;
    qint64 at = 0;
};

EngineClient::EngineClient(EngineResolver resolver, int drainMs, QObject* parent)
    : QObject(parent), resolver_(std::move(resolver)), drainMs_(drainMs) {}

EngineClient::~EngineClient() {
    closed_ = true;
    QList<std::shared_ptr<Child>> all = stopping_;
    if (child_) all.append(child_);
    for (const auto& child : std::as_const(all)) {
        QProcess* p = child->process;
        if (p == nullptr) continue;
        p->disconnect(this);
        if (p->state() == QProcess::NotRunning) continue;
        // 同 stop 的三步,只是同步地做:关 stdin 让引擎把在途请求答完,不认 EOF 再 terminate,最后 kill
        p->closeWriteChannel();
        if (!p->waitForFinished(drainMs_)) {
            p->terminate();
            if (!p->waitForFinished(5000)) {
                p->kill();
                p->waitForFinished(1000);
            }
        }
    }
    for (const auto& pending : std::as_const(pending_)) pending->timer->stop();
}

qint64 EngineClient::pid() const { return child_ ? child_->process->processId() : 0; }

void EngineClient::holdUntil(qint64 epochMs, const QString& reason) {
    notBefore_ = epochMs;
    holdReason_ = reason;
}

void EngineClient::log(const QString& line) {
    tail_.append(line);
    while (tail_.size() > kTailKeep) tail_.removeFirst();
    emit logLine(line);
}

void EngineClient::start(bool force, Done done) {
    if (closed_) {
        if (done) done(u"应用正在退出,交易引擎已停止"_s);
        return;
    }
    if (startInProgress_) {
        if (done) startWaiters_.append(std::move(done));
        return;
    }
    if (child_) {
        // 引擎活着:不管有没有退避,照常用(退避只拦"拉起")
        if (done) done({});
        return;
    }
    if (!force && nowMs() < notBefore_) {
        if (!done) return;
        if (!holdReason_.isEmpty()) return done(holdReason_);
        const qint64 wait = std::max<qint64>(1, static_cast<qint64>(std::ceil((notBefore_ - nowMs()) / 1000.0)));
        return done(u"交易引擎已退出,%1 秒后自动重启"_s.arg(wait));
    }
    notBefore_ = 0;
    holdReason_.clear();
    startInProgress_ = true;
    if (done) startWaiters_.append(std::move(done));
    // 旧引擎还没退干净就拉新的,两个引擎会同时连 TWS(同一个 client id)、同时写库、同时跑盯盘节拍
    whenNoneStopping([this] { doStart(); });
}

void EngineClient::whenNoneStopping(std::function<void()> next) {
    if (stopping_.isEmpty()) next();
    else afterStopping_.append(std::move(next));
}

void EngineClient::finishStart(const QString& error) {
    startInProgress_ = false;
    const QList<Done> waiters = std::exchange(startWaiters_, {});
    for (const Done& w : waiters) w(error);
}

void EngineClient::doStart() {
    // 等旧引擎退出的这段时间里应用开始退出了:不再拉起(否则退出途中留下一个没人管的引擎)
    if (closed_) return finishStart(u"应用正在退出,交易引擎已停止"_s);
    if (child_) return finishStart({});
    const ResolvedEngine resolved = resolver_ ? resolver_() : ResolvedEngine{std::nullopt, u"没有配置引擎的启动方式"_s};
    if (!resolved.command) {
        finishStart(resolved.error);
        // 同 rpc-client.js:拉不起来也是一次"引擎退出",主进程据此退避重试、界面显示原因
        EngineExit info;
        info.code = -1;
        info.detail = resolved.error;
        emit exited(info);
        return;
    }
    const EngineCommand& cmd = *resolved.command;
    log(u"[engine] 启动引擎(%1):%2"_s.arg(cmd.label, cmd.workingDir));
    auto child = std::make_shared<Child>();
    child->process = new QProcess(this);
    QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
    for (auto it = cmd.env.constBegin(); it != cmd.env.constEnd(); ++it) env.insert(it.key(), it.value());
    child->process->setProcessEnvironment(env);
    child->process->setWorkingDirectory(cmd.workingDir);
    child->process->setProgram(cmd.program);
    child->process->setArguments(cmd.args);
    child_ = child;
    wireChild(child);
    child->process->start();
}

void EngineClient::wireChild(const std::shared_ptr<Child>& child) {
    QProcess* p = child->process;
    connect(p, &QProcess::started, this, [this, child] {
        if (child_ == child && startInProgress_) finishStart({});
    });
    connect(p, &QProcess::readyReadStandardOutput, this, [this, child] { onStdout(child); });
    connect(p, &QProcess::readyReadStandardError, this, [this, child] { onStderr(child); });
    connect(p, &QProcess::finished, this, [this, child](int exitCode, QProcess::ExitStatus status) {
        // 没以换行结尾的最后一行也算一行(同 Node 的 readline)
        child->out += '\n';
        child->err += '\n';
        onStdout(child);
        onStderr(child);
        const bool crashed = status == QProcess::CrashExit;
        const int code = crashed ? 0 : exitCode;
        // Unix 上被信号杀掉时 Qt 给的 exitCode 是信号号
        const int signal = crashed ? exitCode : 0;
        QString detail = tail_.mid(std::max<qsizetype>(0, tail_.size() - 8)).join(u'\n');
        if (detail.isEmpty()) detail = u"退出码 %1"_s.arg(code);
        settle(child, code, signal, detail);
        finishStopping(child);
        child->process->deleteLater();
    });
    connect(p, &QProcess::errorOccurred, this, [this, child](QProcess::ProcessError error) {
        // 只有"拉不起来"不会再有 finished;别的错误(读写失败、崩溃)后面还有 finished 来结算
        if (error != QProcess::FailedToStart) return;
        const QString detail = u"无法启动引擎:%1"_s.arg(child->process->errorString());
        settle(child, -1, 0, detail);
        if (startInProgress_) finishStart(detail);
        finishStopping(child);
        child->process->deleteLater();
    });
}

void EngineClient::finishStopping(const std::shared_ptr<Child>& child) {
    const bool wasStopping = stopping_.removeOne(child);
    const auto waiters = std::exchange(child->onFinished, {});
    for (const auto& w : waiters) w();
    if (wasStopping && stopping_.isEmpty()) {
        const auto next = std::exchange(afterStopping_, {});
        for (const auto& f : next) f();
    }
}

void EngineClient::onStdout(const std::shared_ptr<Child>& child) {
    child->out += child->process->readAllStandardOutput();
    qsizetype nl;
    while ((nl = child->out.indexOf('\n')) >= 0) {
        QByteArray line = child->out.left(nl);
        child->out.remove(0, nl + 1);
        if (line.endsWith('\r')) line.chop(1);
        if (!line.isEmpty()) handleLine(child, line);
    }
}

void EngineClient::onStderr(const std::shared_ptr<Child>& child) {
    child->err += child->process->readAllStandardError();
    qsizetype nl;
    while ((nl = child->err.indexOf('\n')) >= 0) {
        QByteArray line = child->err.left(nl);
        child->err.remove(0, nl + 1);
        if (line.endsWith('\r')) line.chop(1);
        if (!line.isEmpty()) log(QString::fromUtf8(line));
    }
}

void EngineClient::handleLine(const std::shared_ptr<Child>& child, const QByteArray& line) {
    QJsonParseError parseError{};
    const QJsonDocument doc = QJsonDocument::fromJson(line, &parseError);
    if (!doc.isObject()) {
        log(u"[非 JSON 输出] %1"_s.arg(QString::fromUtf8(line)));
        return;
    }
    const QJsonObject message = doc.object();
    if (message.value(u"method").toString() == u"event") {
        // 正在退出的旧引擎发来的事件不转给界面:界面只认当前这一个引擎
        if (child != child_) return;
        const QJsonObject params = message.value(u"params").toObject();
        emit engineEvent(params.value(u"event").toString(), params.value(u"data"));
        return;
    }
    const int id = message.value(u"id").toInt(-1);
    const std::shared_ptr<Pending> entry = pending_.take(id);
    const QJsonValue error = message.value(u"error");
    const bool ok = error.isUndefined() || error.isNull();
    const QString errorText = ok ? QString() : error.toObject().value(u"message").toString(u"引擎返回错误"_s);
    if (!entry) {
        // 超时之后才到的回执。对发单类调用,这一条就是"那张单到底发没发出去"的答案,不能丢
        for (qsizetype i = 0; i < timedOut_.size(); ++i) {
            const std::shared_ptr<TimedOut> late = timedOut_[i];
            if (late->id != id || late->child != child) continue;
            timedOut_.removeAt(i);
            LateReply info;
            info.method = late->method;
            info.waitedMs = nowMs() - late->at;
            info.ok = ok;
            if (ok) info.result = message.value(u"result");
            info.error = errorText;
            emit lateReply(info);
            break;
        }
        return;
    }
    entry->timer->stop();
    entry->timer->deleteLater();
    if (!entry->done) return;
    EngineReply reply;
    reply.ok = ok;
    reply.raw = line;
    if (ok) {
        reply.result = message.value(u"result");
    } else {
        reply.error = errorText;
        reply.code = QString::number(error.toObject().value(u"code").toInt());
    }
    entry->done(reply);
}

void EngineClient::settle(const std::shared_ptr<Child>& child, int code, int signal, const QString& detail) {
    // 退出与"拉不起来"可能先后都来:只结算一次
    if (child->settled) return;
    child->settled = true;
    // 只拒发给这个子进程的调用(先摘下来再回话:回话的人可能顺手又发新的)
    QList<std::shared_ptr<Pending>> rejected;
    for (auto it = pending_.begin(); it != pending_.end();) {
        if (it.value()->child == child) {
            rejected.append(it.value());
            it = pending_.erase(it);
        } else {
            ++it;
        }
    }
    // 它不会再回话了:超时后还等着它迟到回执的那几条也不用记了
    timedOut_.removeIf([&child](const std::shared_ptr<TimedOut>& t) { return t->child == child; });
    for (const auto& p : std::as_const(rejected)) {
        p->timer->stop();
        p->timer->deleteLater();
        if (p->done) p->done(failure(u"交易引擎已退出:%1"_s.arg(detail)));
    }
    if (child_ != child) {
        // 已经被 stop() 换下来的旧引擎:它退出是预期之内的,不动当前引擎的状态,也不通知界面
        log(u"[engine] 旧引擎进程已退出(%1)"_s.arg(signal != 0 ? u"信号 %1"_s.arg(signal) : u"退出码 %1"_s.arg(code)));
        return;
    }
    child_.reset();
    EngineExit info;
    info.code = code;
    info.signal = signal;
    info.detail = detail;
    emit exited(info);
}

void EngineClient::call(const QString& method, const QJsonValue& params, CallOptions options, ReplyHandler done) {
    // 下一轮事件循环再走(同 JS 的 async):和 restart() 同一拍发起的调用,等新引擎起来再发,不发给正在被换下的那个
    QMetaObject::invokeMethod(this, [this, method, params, options, done] {
        start(false, [this, method, params, options, done](const QString& error) {
            if (!error.isEmpty()) {
                if (done) done(failure(error));
                return;
            }
            if (!child_ && !stopping_.isEmpty() && !closed_) {
                // start() 落地到这里之间正好有人 stop / restart:等新引擎起来再发,别报"未运行"
                start(false, [this, method, params, options, done](const QString& again) {
                    if (!again.isEmpty()) {
                        if (done) done(failure(again));
                        return;
                    }
                    send(method, params, options, done);
                });
                return;
            }
            send(method, params, options, done);
        });
    }, Qt::QueuedConnection);
}

void EngineClient::send(const QString& method, const QJsonValue& params, CallOptions options, ReplyHandler done) {
    const std::shared_ptr<Child> child = child_;
    if (!child) {
        if (done) done(failure(u"交易引擎未运行"_s));
        return;
    }
    const int timeoutMs = options.timeoutMs > 0 ? options.timeoutMs : kCallTimeoutMs;
    const int id = nextId_++;
    const QJsonObject request{
        {u"jsonrpc"_s, u"2.0"_s},
        {u"id"_s, id},
        {u"method"_s, method},
        {u"params"_s, params.isUndefined() || params.isNull() ? QJsonValue(QJsonObject{}) : params},
    };
    auto entry = std::make_shared<Pending>();
    entry->method = method;
    entry->child = child;
    entry->done = std::move(done);
    entry->timer = new QTimer(this);
    entry->timer->setSingleShot(true);
    connect(entry->timer, &QTimer::timeout, this, [this, id, method, child, timeoutMs, lateReply = options.lateReply] {
        const std::shared_ptr<Pending> timedOut = pending_.take(id);
        if (!timedOut) return;
        timedOut->timer->deleteLater();
        if (lateReply) {
            timedOut_.append(std::make_shared<TimedOut>(TimedOut{id, method, child, nowMs() - timeoutMs}));
            while (timedOut_.size() > kLateKeep) timedOut_.removeFirst();
        }
        if (timedOut->done) {
            timedOut->done(failure(u"调用 %1 超时(%2s)"_s.arg(method, QString::number(timeoutMs / 1000.0, 'g', 12)), u"ENGINE_TIMEOUT"_s));
        }
    });
    pending_.insert(id, entry);
    entry->timer->start(timeoutMs);
    if (child->process->write(QJsonDocument(request).toJson(QJsonDocument::Compact) + '\n') < 0) {
        pending_.remove(id);
        entry->timer->stop();
        entry->timer->deleteLater();
        if (entry->done) entry->done(failure(u"写入引擎失败:%1"_s.arg(child->process->errorString())));
    }
}

void EngineClient::stop(StopOptions options, std::function<void()> done) {
    if (options.final) closed_ = true;
    const std::shared_ptr<Child> child = child_;
    if (!child) {
        if (!done) return;
        if (stopping_.isEmpty()) done();
        else afterStopping_.append(std::move(done));
        return;
    }
    child_.reset();
    // 正在拉起的那一个被换下来了:等着它的调用自己会再走一遍 start(会等它退干净)
    if (startInProgress_) finishStart({});
    stopping_.append(child);
    if (done) child->onFinished.append(std::move(done));
    QProcess* p = child->process;
    if (p->state() == QProcess::NotRunning) {
        // 已经结算过(退出的信号先到了):直接收尾;没结算过的,errorOccurred / finished 会来收尾
        if (child->settled) finishStopping(child);
        return;
    }
    p->closeWriteChannel();
    const int drain = options.drainMs >= 0 ? options.drainMs : drainMs_;
    const int killGraceMs = options.killGraceMs;
    const auto terminate = [this, p, killGraceMs] {
        if (p->state() == QProcess::NotRunning) return;
        p->terminate();
        QTimer::singleShot(killGraceMs, p, [this, p] {
            if (p->state() == QProcess::NotRunning) return;
            log(u"[engine] 旧引擎 terminate 后仍未退出,强制结束"_s);
            p->kill();
        });
    };
    if (drain > 0) QTimer::singleShot(drain, p, terminate);
    else terminate();
}

void EngineClient::restart(StopOptions options, Done done) {
    stop(options, [this, done] { start(true, done); });
}

}  // namespace ibkr::shell
