// 从 TWS 收进来的消息:逐条照 @stoqey/ib 1.6.10(MIT)的 Decoder 读,发出同样的事件(名字、参数次序、对象的键与键序)。
// 期望值由 tests/fixtures/gen_ib_wire.mjs 拿那个库现算,tests/tst_ib_wire.cpp 逐条对。**不照着 IB 的 GPL 源码写。**
//
// 和库一样是带状态的:一个 Decoder 有一条字段队列,enqueueMessage 一条消息(前后各放一个边界),process 把队列里的读完。
// 读不够(underrun)、读完还剩、不认识的消息号,库都不抛,而是发一个 "error" 事件(话是库的原话);
// 读不够时已经排进去的事件照样发(如 K 线读到第三根断了,前两根照发),而且先发那条 error。
// 只有两种情况 process 会抛 WireError(库也是抛出去):报错消息里详细拒单原因那一格不是合法 JSON(SyntaxError)、
// 订单的条件数大到 JS 建不了数组(RangeError)。抛的时候这一条已经排队的事件不发,队列里剩下的字段留着,下一次 process 接着读(同库)。
//
// 这里只搬了引擎用到的消息(见 wire_in.cpp 的 processMsg);库里有解码、这里没搬的消息号,发一个 "__unported__"(参数 [消息号]),
// 整条跳过,不冒充"不认识"——那是库不会说的话。
#pragma once

#include "execution/tws/wire_common.h"

#include <QStringList>

#include <deque>
#include <optional>

namespace ibkr::tws::wire {

class Decoder {
public:
    /// serverVersion:握手谈下来的接口版本(决定哪些格存在)
    explicit Decoder(int serverVersion) : serverVersion_(serverVersion) {}

    /// 收到一条消息(握手回话之后的;分好帧的字段)
    void enqueueMessage(const QStringList& tokens);
    /// 把队列里的读完,发出的事件依次追加进 out;抛 WireError 时 out 里是抛之前已经发出去的
    void process(std::vector<Emit>& out);
    int serverVersion() const { return serverVersion_; }

    // 下面是读一格的几种读法(同库的 readStr / readInt …),给 wire_in.cpp 里的各条消息用
    QString readStr();
    double readInt();
    OJson readIntOrUndefined();
    OJson readDouble();
    OJson readDoubleOrUndefined();
    OJson readDecimal();
    bool readBool();
    /// 排一个事件(本条消息读完才发)
    void queueEvent(const QString& name, const QList<OJson>& args);

private:
    void processMsg(double msgId);
    void drainQueue();
    void emitDirect(const Emit& e);
    void decodeErrMsg();

    int serverVersion_;
    /// 空的 optional 是消息的边界
    std::deque<std::optional<QString>> queue_;
    std::vector<Emit> emitQueue_;
    std::vector<Emit>* out_ = nullptr;
};

/// 一条消息单独读(新的 Decoder):同 socket.js 收到一帧
std::vector<Emit> decode(int serverVersion, const QStringList& tokens);

/// IN_MSG_ID 的名字(库的报错话里用);不是登记过的号是 "undefined"
QString inMsgName(double msgId);

}  // namespace ibkr::tws::wire
