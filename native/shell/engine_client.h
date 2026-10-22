// 交易引擎子进程的客户端。逐条照 desktop/rpc-client.js 搬(用例照 engine-ts/tests/desktop-engine-client.spec.ts):
//
// - 走 stdio 不走端口:stdout 只跑 JSON-RPC(一行一条),stderr 是引擎的日志(留最后 200 行)。
// - **重启是先死后生**:stop() 关 stdin(引擎答完在途请求自己退)→ drainMs 内没退就 terminate → 再过 killGraceMs 还没退就 kill;
//   旧进程真的退出之前,start() 等着——绝不能两个引擎同时活着(抢同一个 TWS client id、同时写库、同时跑盯盘)。
// - 每个处理函数都认准**自己那一个**子进程:旧引擎迟到的退出、回执、事件,不动当前引擎的状态。
// - call() 顺手拉起引擎;holdUntil() 之前不拉(主进程的重启退避靠它拦住界面的轮询)。
// - 超时不等于没发生:要了 lateReply 的调用,超时之后引擎才回话,发 lateReply 信号(发单类调用用)。
//
// Windows 上 terminate() 对控制台子进程送不到"请退出"(没有 SIGTERM),那里真正管用的是关 stdin 那一步,其次是 kill。
#pragma once

#include "shell/engine_command.h"

#include <QHash>
#include <QJsonValue>
#include <QList>
#include <QObject>
#include <QProcess>
#include <QStringList>

#include <functional>
#include <memory>

class QTimer;

namespace ibkr::shell {

struct CallOptions {
    /// 0 = 默认 120 秒;心跳这类探测给短的
    int timeoutMs = 0;
    /// 超时之后引擎才回话时发 lateReply(发单类调用:超时不等于没发出去)
    bool lateReply = false;
};

struct EngineReply {
    bool ok = false;
    QJsonValue result;
    QString error;
    /// "ENGINE_TIMEOUT";引擎回的 JSON-RPC 错误时是它的码(-32602 之类)的字符串;别的情况空
    QString code;
    /// 引擎回的那一行原文(QJsonObject 把键按字母排;要照引擎的键序摆给人看的地方从这里保序再读一遍,见 ordered_json)
    QByteArray raw;
};

struct EngineExit {
    /// 退出码;拉不起来是 -1
    int code = 0;
    /// 被信号杀掉的(Unix 上是信号号,SIGTERM = 15);正常退出是 0
    int signal = 0;
    /// stderr 最后 8 行(没有就是"退出码 N")
    QString detail;
};

struct LateReply {
    QString method;
    qint64 waitedMs = 0;
    bool ok = false;
    QJsonValue result;
    QString error;
};

struct StopOptions {
    /// 关 stdin 之后等引擎自己退的时间;-1 = 构造时给的(默认 3 秒),0 = 不等直接 terminate(心跳判死的引擎)
    int drainMs = -1;
    int killGraceMs = 5000;
    /// 应用在退出:之后 start() / call() 一律拒绝,不再拉起
    bool final = false;
};

class EngineClient : public QObject {
    Q_OBJECT
public:
    /// error 为空 = 成功
    using Done = std::function<void(const QString& error)>;
    using ReplyHandler = std::function<void(const EngineReply& reply)>;

    explicit EngineClient(EngineResolver resolver, int drainMs = 3000, QObject* parent = nullptr);
    /// 还活着的子进程同步地按 stop 的三步收掉(关 stdin → 等 → terminate → kill):退出应用时也不把在途的单拦腰打断
    ~EngineClient() override;

    void start(bool force = false, Done done = {});
    void stop(StopOptions options = {}, std::function<void()> done = {});
    /// 先等旧引擎退干净,再拉起新的(force)
    void restart(StopOptions options = {}, Done done = {});
    void call(const QString& method, const QJsonValue& params = {}, CallOptions options = {}, ReplyHandler done = {});

    /// 这个时刻(epoch 毫秒)之前不拉起引擎;reason 是被挡下的调用报的那句话(不给就报"N 秒后自动重启")
    void holdUntil(qint64 epochMs, const QString& reason = {});

    bool running() const { return child_ != nullptr; }
    qint64 pid() const;
    bool closed() const { return closed_; }
    QStringList stderrTail() const { return tail_; }

signals:
    void engineEvent(const QString& event, const QJsonValue& data);
    void logLine(const QString& line);
    /// 当前引擎意外退出(自己 stop 掉的不发)
    void exited(const ibkr::shell::EngineExit& info);
    void lateReply(const ibkr::shell::LateReply& info);

private:
    struct Child;
    struct Pending;
    struct TimedOut;

    void doStart();
    void finishStart(const QString& error);
    void wireChild(const std::shared_ptr<Child>& child);
    void onStdout(const std::shared_ptr<Child>& child);
    void onStderr(const std::shared_ptr<Child>& child);
    void handleLine(const std::shared_ptr<Child>& child, const QByteArray& line);
    void settle(const std::shared_ptr<Child>& child, int code, int signal, const QString& detail);
    /// 子进程真的没了:它要是被 stop 换下来的,叫醒等它的人;都退干净了就放行等着拉起的
    void finishStopping(const std::shared_ptr<Child>& child);
    void send(const QString& method, const QJsonValue& params, CallOptions options, ReplyHandler done);
    void log(const QString& line);
    void whenNoneStopping(std::function<void()> next);

    EngineResolver resolver_;
    int drainMs_;
    std::shared_ptr<Child> child_;
    /// 正在退出的旧引擎:它们都退干净之前不拉起新的
    QList<std::shared_ptr<Child>> stopping_;
    QList<std::function<void()>> afterStopping_;
    bool startInProgress_ = false;
    QList<Done> startWaiters_;
    QHash<int, std::shared_ptr<Pending>> pending_;
    /// 超时了、但结果要紧的调用:按先后,最多留 32 条
    QList<std::shared_ptr<TimedOut>> timedOut_;
    int nextId_ = 1;
    qint64 notBefore_ = 0;
    QString holdReason_;
    bool closed_ = false;
    QStringList tail_;
};

}  // namespace ibkr::shell

// 信号里带着走、测试的 QSignalSpy 也要取出来
Q_DECLARE_METATYPE(ibkr::shell::EngineExit)
Q_DECLARE_METATYPE(ibkr::shell::LateReply)
