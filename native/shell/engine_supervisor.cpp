#include "shell/engine_supervisor.h"

#include "shell/fatal_line.h"
#include "util/exit_codes.h"

#include <QDateTime>

#include <algorithm>
#include <limits>

namespace ibkr::shell {

using namespace Qt::StringLiterals;

namespace {

qint64 nowMs() { return QDateTime::currentMSecsSinceEpoch(); }
constexpr qint64 kForever = std::numeric_limits<qint64>::max();
constexpr int kSigterm = 15;

}  // namespace

EngineSupervisor::EngineSupervisor(EngineClient* engine, SupervisorTiming timing, QObject* parent)
    : QObject(parent), engine_(engine), timing_(timing) {
    connect(engine_, &EngineClient::exited, this, &EngineSupervisor::onExit);
    watchdog_.setInterval(timing_.watchdogEveryMs);
    connect(&watchdog_, &QTimer::timeout, this, &EngineSupervisor::watchdogTick);
}

void EngineSupervisor::start() {
    startedAt_ = nowMs();
    // 拉不起来会以 exited 呈现(EngineClient 发),这里不用管回话
    engine_->start();
    watchdog_.start();
}

void EngineSupervisor::startAgain() {
    if (quitting_) return;
    startedAt_ = nowMs();
    engine_->start(true);
}

void EngineSupervisor::noteStarted() { startedAt_ = nowMs(); }

void EngineSupervisor::prepareQuit() {
    quitting_ = true;
    watchdog_.stop();
}

void EngineSupervisor::onExit(const EngineExit& info) {
    if (quitting_) return;
    // 配置读不进来(引擎用专门的退出码说的):重启一万次也是同一个错。停下自动重启,问用户怎么办
    if (info.code == util::kExitConfig) {
        const auto line = configFatalLine(info.detail);
        engine_->holdUntil(kForever, u"交易引擎没有启动:配置文件有问题,请按弹出的提示处理"_s);
        emit engineExited(info, -1);
        emit fatal(u"config"_s, line ? line->message : u"配置文件读不进来"_s);
        return;
    }
    // 交易库打不开:同样不是重启能解决的
    if (info.code == util::kExitStore) {
        const auto line = storeFatalLine(info.detail);
        engine_->holdUntil(kForever, u"交易引擎没有启动:交易库打不开,请按弹出的提示处理"_s);
        emit engineExited(info, -1);
        emit fatal(u"store"_s, line ? line->message : u"交易库打不开"_s);
        return;
    }
    // 被 SIGTERM 的(系统关机、有人手动结束)不拉;我们自己停的根本不会到这里(EngineClient 不发)
    if (info.signal == kSigterm) {
        emit engineExited(info, -1);
        return;
    }
    if (nowMs() - startedAt_ > timing_.resetAfterMs) restarts_ = 0;
    const qint64 delay = std::min<qint64>(timing_.restartMaxMs, static_cast<qint64>(timing_.restartBaseMs) << std::min(restarts_, 20));
    restarts_ += 1;
    emit engineExited(info, static_cast<int>(delay));
    scheduleRestart(static_cast<int>(delay));
}

void EngineSupervisor::scheduleRestart(int delayMs) {
    // 退避期间界面的轮询不许顺手把引擎拉起来,否则这个退避形同虚设
    engine_->holdUntil(nowMs() + delayMs);
    QTimer::singleShot(delayMs, this, [this] {
        if (quitting_ || engine_->running()) return;
        startedAt_ = nowMs();
        engine_->start(true);
    });
}

void EngineSupervisor::watchdogTick() {
    if (quitting_ || !engine_->running() || watchdogInFlight_) return;
    watchdogInFlight_ = true;
    const qint64 sentAt = nowMs();
    CallOptions options;
    options.timeoutMs = timing_.watchdogTimeoutMs;
    engine_->call(u"system.status"_s, QJsonObject{}, options, [this, sentAt](const EngineReply& reply) {
        watchdogInFlight_ = false;
        if (reply.ok) {
            if (warned_) emit recovered();
            silentSince_ = 0;
            warned_ = false;
            const QJsonObject status = reply.result.toObject();
            drivePending(status);
            emit statusSeen(status);
            return;
        }
        // 这一问期间引擎退出了:自动拉起那条路会处理,不算"不回话"
        if (!engine_->running()) {
            silentSince_ = 0;
            return;
        }
        if (silentSince_ == 0) silentSince_ = sentAt;
        const qint64 silent = nowMs() - silentSince_;
        if (silent >= timing_.killAfterMs) {
            silentSince_ = 0;
            warned_ = false;
            startedAt_ = nowMs();
            emit forcedRestart(static_cast<int>(silent / 1000));
            // 它已经不回话了,等它"答完在途请求"没有意义:不排空,直接结束
            StopOptions stop;
            stop.drainMs = 0;
            engine_->restart(stop);
        } else if (silent >= timing_.warnAfterMs && !warned_) {
            warned_ = true;
            emit unresponsive(static_cast<int>(silent / 1000));
        }
    });
}

void EngineSupervisor::drivePending(const QJsonObject& status) {
    if (pendingBusy_ || quitting_ || !status.value(u"broker_connected").toBool()) return;
    // 没有排队的单就不问(富途的条件单引擎这边看不见个数,照问)
    if (status.value(u"pending_count").toDouble() == 0 && status.value(u"broker_provider").toString() != u"futu") return;
    pendingBusy_ = true;
    CallOptions options;
    options.timeoutMs = timing_.pendingPollTimeoutMs;
    engine_->call(u"pending.poll"_s, QJsonObject{}, options, [this](const EngineReply&) { pendingBusy_ = false; });
}

}  // namespace ibkr::shell
