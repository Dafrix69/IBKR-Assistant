// 向 TWS 要最近几天的成交(engine-ts/src/ibExecHistory.ts 逐句搬;docs/features/tradereview.md「成交从哪儿来」)。
//
// 另开一条只读、用完就关的连接,只会说三句话:握手(v100..200)、报到(START_API)、要成交(REQ_EXECUTIONS 带 lastNDays);
// 只认三种回话:成交、成交发完了、报错,别的整条丢掉。不下单、不订行情、不碰平时那条连接。
// 分三层,前两层是纯的、测试直接喂字节:
//   · 编解码(handshakeBytes / frame / splitFrames / decodeExecution);
//   · 状态机 HistoryExchange:收"连上了 / 来了字节 / 出错 / 关了 / 到点了"五种事件,决定写什么、何时收尾(TS 的 Promise 执行体);
//   · fetchExecutionHistory:把状态机接到 socket(默认 QTcpSocket)与计时器上,给一个 Task。
// 期望值:tests/fixtures/gen_ib_exec_history.mjs(原模块在假 socket 上现跑)
#pragma once

#include "execution/ib_types.h"

#include <QAbstractSocket>
#include <QByteArray>
#include <QObject>
#include <QStringList>

#include <functional>
#include <optional>
#include <variant>
#include <vector>

class QTcpSocket;

namespace ibkr::execution {

/// 握手时报给 TWS 的版本区间。上限就是"要几天"这一格出现的那一版
inline constexpr int kHistoryMinVersion = 100;
inline constexpr int kHistoryMaxVersion = 200;
/// TWS 最多往回给 7 天
inline constexpr int kHistoryDaysMax = 7;
/// 这条连接的 client id = 平时那条的 + 这个数
inline constexpr int kHistoryClientOffset = 9000;

double historyClientId(double clientId);
/// 握手:`API\0` + 4 字节长度 + `v100..200`
QByteArray handshakeBytes();
/// 一格:串原样,数按 `${n}` 写
using FrameField = std::variant<QString, double>;
/// 一条消息:4 字节长度 + 每个字段后面跟一个 \0
QByteArray frame(const QList<FrameField>& fields);
QByteArray startApiBytes(double clientId);
QByteArray executionsRequestBytes(double reqId, double days);

struct SplitFrames {
    QList<QStringList> frames;
    QByteArray rest;
};
/// 把收到的字节切成一条条消息的字段;切不满一条的留在 rest 里。长度不像话抛 JsError
SplitFrames splitFrames(const QByteArray& buffer);

struct DecodedExecution {
    double reqId = 0;
    ExecutionRow detail;
};
/// 一条成交消息(字段 0 是消息号 11)→ [请求号, 合约, 成交];字段不够回空
std::optional<DecodedExecution> decodeExecution(const QStringList& fields);

struct HistoryResult {
    /// 和 TWS 谈下来的接口版本
    double serverVersion = 0;
    /// 版本够不够给"最近几天";给不了时 details 是空的,也没有发请求
    bool supported = false;
    std::vector<ExecutionRow> details;
};

/// 状态机(TS 的 Promise 执行体):socket 的几样动作由 Io 给,结果在 settled 里交出去(只交一次)
class HistoryExchange {
public:
    struct Io {
        std::function<void(const QByteArray&)> write;
        std::function<void()> end;
        std::function<void()> destroy;
        /// 停掉超时计时器
        std::function<void()> clearTimer;
    };
    /// 结果:有值 = resolve,没值 = reject(话在 error 里)
    using Settled = std::function<void(std::optional<HistoryResult> result, const QString& error)>;

    /// days 原样给(这里夹到 1–7);timeoutMs 只用于超时那句话
    HistoryExchange(Io io, double clientId, double days, double timeoutMs, Settled settled);

    void onConnect();
    void onData(const QByteArray& chunk);
    void onError(const QString& message);
    void onClose();
    void onTimeout();
    bool done() const { return done_; }

private:
    bool finish();
    void fail(const QString& message);
    void succeed(bool supported);
    void onFrame(const QStringList& fields);

    Io io_;
    double clientId_;
    double days_;
    double timeoutMs_;
    Settled settled_;
    std::vector<ExecutionRow> details_;
    QByteArray pending_;
    double serverVersion_ = 0;
    bool asked_ = false;
    bool done_ = false;
    /// TWS 没点名哪个请求的最近一条报错(21xx 是数据农场的通告,不算)
    QString notice_;
};

/// 这里用得到的 socket 的那几样(测试塞一个假的进来)。信号对着 Node socket 的 connect / data / error / close
class HistorySocket : public QObject {
    Q_OBJECT
public:
    using QObject::QObject;
    virtual void write(const QByteArray& data) = 0;
    virtual void end() = 0;
    virtual void destroy() = 0;

signals:
    void connected();
    void data(const QByteArray& chunk);
    void failed(const QString& message);
    void closed();
};

/// 默认的那种:QTcpSocket。出错的话照 Node 的 err.message 写(connect ECONNREFUSED 127.0.0.1:7496 之类)
class TcpHistorySocket : public HistorySocket {
    Q_OBJECT
public:
    TcpHistorySocket(const QString& host, quint16 port, QObject* parent = nullptr);
    void write(const QByteArray& data) override;
    void end() override;
    void destroy() override;

private:
    QTcpSocket* socket_;
    QString host_;
    quint16 port_;
    bool gone_ = false;
};

/// Node 的 socket 错误话(只翻连不上那几种;别的用 Qt 的原话)
QString nodeSocketErrorMessage(QAbstractSocket::SocketError error, const QString& host, quint16 port, const QString& peer, const QString& qtText);
/// setTimeout 的时长:不在 [1, 2^31 − 1] 里的(含 NaN)按 1 毫秒,小数截掉
double nodeTimerDelay(double ms);
/// net.connect 对端口的校验(不合格时 Node 当场抛 RangeError):合格回空,不合格回那句话
std::optional<QString> nodeBadPortMessage(double port);

struct HistoryRequest {
    QString host;
    double port = 0;
    /// 这条连接自己的 client id(historyClientId 算出来的那个)
    double clientId = 0;
    /// 往回要几天,1–7
    double days = 1;
    /// 整趟最多等多久,默认 8 秒
    std::optional<double> timeoutMs;
    /// 怎么连(测试注入);返回的 socket 归这一趟所有
    std::function<HistorySocket*(const QString& host, double port)> connect;
};

/// 连上 TWS,要最近几天的成交,关掉。失败(连不上、被拒、超时、TWS 报错)都抛一句人话(JsError)
Task<HistoryResult> fetchExecutionHistory(HistoryRequest request);

}  // namespace ibkr::execution
