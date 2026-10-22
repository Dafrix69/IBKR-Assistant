// 引擎的生与死:照 desktop/main.js 的 wireEngine / startEngineWatchdog / drivePending 搬。
//
// - 退出码 78(配置读不进来)/ 74(交易库打不开):重启一万次也是同一个错。停下自动重启(holdUntil 到永远),说清楚原因。
// - 别的意外退出:引擎一停,追踪止盈止损就没人盯了——而崩的时候往往没人在场。按退避直接拉起:
//   min(60 秒, 3 秒 × 2^n),引擎上一次跑满 5 分钟就把 n 清零。我们自己停的(退出应用、手动重启)与被 SIGTERM 的不拉。
// - 心跳:每 10 秒问一次 system.status(8 秒超时)。30 秒没回话说一次,180 秒没回话强制重启(不排空,它已经不回话了)。
// - 排队中的条件单要有人按时去问一声才会触发:心跳问到连着券商、有排队的单(或是富途)就顺手 pending.poll 一次。
//   Electron 版里界面还有一个 10 秒一次的轮询,Qt 版没有,这一处就是唯一的入口。
#pragma once

#include "shell/engine_client.h"

#include <QJsonObject>
#include <QObject>
#include <QTimer>

namespace ibkr::shell {

/// 几个时长(毫秒)。默认值同 main.js;测试里改短
struct SupervisorTiming {
    int restartBaseMs = 3000;
    int restartMaxMs = 60'000;
    /// 引擎跑满这么久,重启计数清零
    int resetAfterMs = 5 * 60 * 1000;
    int watchdogEveryMs = 10'000;
    int watchdogTimeoutMs = 8000;
    int warnAfterMs = 30'000;
    int killAfterMs = 180'000;
    int pendingPollTimeoutMs = 60'000;
};

class EngineSupervisor : public QObject {
    Q_OBJECT
public:
    EngineSupervisor(EngineClient* engine, SupervisorTiming timing = {}, QObject* parent = nullptr);

    /// 拉起引擎、开心跳
    void start();
    /// 应用在退出:之后的退出不再拉起,心跳停
    void prepareQuit();
    /// 用户在对话框里修好了(恢复了配置 / 交易库、或者自己改好了):越过"别再拉起"的那道闸,马上再拉一次
    /// (main.js 的 engineStartedAt = Date.now(); engine.start({ force: true }))
    void startAgain();
    /// 别处刚重启过引擎(改账户、恢复交易库):重启计数从现在起算(main.js 的 markEngineStarted)
    void noteStarted();

    int restarts() const { return restarts_; }

signals:
    /// 配置 / 交易库的错,不会自动重启。kind 是 "config" / "store",message 是给人看的那一句
    void fatal(const QString& kind, const QString& message);
    /// 引擎意外退出了;restartInMs < 0 表示不会自动拉起
    void engineExited(const ibkr::shell::EngineExit& info, int restartInMs);
    void unresponsive(int silentSeconds);
    void recovered();
    void forcedRestart(int silentSeconds);
    void statusSeen(const QJsonObject& status);

private:
    void onExit(const EngineExit& info);
    void watchdogTick();
    void drivePending(const QJsonObject& status);
    void scheduleRestart(int delayMs);

    EngineClient* engine_;
    SupervisorTiming timing_;
    QTimer watchdog_;
    bool quitting_ = false;
    int restarts_ = 0;
    qint64 startedAt_ = 0;
    qint64 silentSince_ = 0;
    bool warned_ = false;
    bool watchdogInFlight_ = false;
    bool pendingBusy_ = false;
};

}  // namespace ibkr::shell
