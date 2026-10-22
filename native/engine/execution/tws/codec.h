// TWS 线协议的编解码:纯函数,不碰 socket。测试直接喂字节(tests/tst_codec.cpp)。
//
// 只认 V100 起的分帧(每条消息前面 4 字节长度,每个字段后面一个 \0),不认更老的。版本区间由调用方给:
// 平时那条连接报 v100..193(和 TS 引擎的 ibSession.ts 一样,各条消息的字段次序就是 TS 版此刻用的那一版),
// 往回要成交的那条报到 200(ibExecHistory.ts)。201 起 TWS 改用 protobuf,这里不会。
//
// 字段次序对着 MIT 的移植版核(TS 引擎在用的 @stoqey/ib 1.6.10,以及 ibExecHistory.ts 的手写客户端),
// 期望值由 tests/fixtures/gen_stoqey_v193.mjs 拿那个库现算。**不照着 IB 的 GPL 源码写**,那份源码也不进仓库。
//
// 这里只有握手、报到、持仓、当前时刻与报错几样:不会拼订单,发不了单。
#pragma once

#include <QByteArray>
#include <QJsonObject>
#include <QList>
#include <QString>
#include <QStringList>

#include <optional>
#include <variant>

namespace ibkr::tws {

/// 握手报的版本下限(V100 分帧从这一版起)
inline constexpr int kMinVersion = 100;
/// 平时那条连接报的上限(同 @stoqey/ib 1.6.10 的 MAX_SUPPORTED_SERVER_VERSION)
inline constexpr int kMainMaxVersion = 193;
/// 一条消息最长多少字节:TWS 自己的上限是 16MB,超了说明读错了位置
inline constexpr quint32 kFrameMax = 16 * 1024 * 1024;

/// 发出去的消息号
namespace out {
inline constexpr int kReqCurrentTime = 49;
inline constexpr int kReqPositions = 61;
inline constexpr int kCancelPositions = 64;
inline constexpr int kStartApi = 71;
}  // namespace out

/// 收进来的消息号
namespace in {
inline constexpr int kErrMsg = 4;
inline constexpr int kNextValidId = 9;
inline constexpr int kManagedAccts = 15;
inline constexpr int kCurrentTime = 49;
inline constexpr int kPosition = 61;
inline constexpr int kPositionEnd = 62;
}  // namespace in

/// 报错消息里"不是报给哪个请求的"那个请求号(TWS 的通告,如数据农场连上了)
inline constexpr qint64 kNoValidId = -1;
/// 老格式(版本 1)的报错没有错误码,库给的是这个
inline constexpr qint64 kUnknownIdCode = 505;

// ---- 发出去的字节 ----

/// 握手:`API\0` + 4 字节长度 + `v{min}..{max}`(min == max 时只写一个数)。
QByteArray handshake(int minVersion, int maxVersion);
/// 一条消息:4 字节长度 + 每个字段后面一个 \0。
QByteArray frame(const QStringList& fields);
/// 报到:START_API,版本 2,client id,可选能力(空串)。
QByteArray startApi(int clientId);
QByteArray reqPositions();
QByteArray cancelPositions();
QByteArray reqCurrentTime();

// ---- 分帧 ----

struct SplitResult {
    QList<QStringList> frames;
    /// 切走了多少字节;剩下的(切不满一条的尾巴)留在调用方的缓冲里,等下一批字节来了接上。
    /// 只报个数、不拷尾巴:一条几 MB 的消息分几十块到,每块都拷一遍尾巴就是平方级的拷贝
    qsizetype consumed = 0;
    /// 长度不像话(> kFrameMax):后面的字节没法再信,整条连接该断
    std::optional<quint32> badSize;
};

/// 把收到的字节切成一条条消息的字段。每个字段后面都有一个 \0,所以切出来末尾多一个空串,去掉。
SplitResult splitFrames(QByteArrayView buffer);

// ---- 收进来的消息 ----

/// 握手的回话:[接口版本, 连接时刻]。版本读不出是 NaN。
struct ServerVersion {
    double version = 0;
    QString connectionTime;
};
ServerVersion decodeServerVersion(const QStringList& fields);

// 下面这些结构是"线上的样子":数一律是 double,和 TS 引擎拿到的 JS 数一模一样(含 NaN);
// 库里是 undefined 的这里是空的 optional(出 JSON 时不写这个键),NaN / ±Infinity 出 JSON 时是 null。
// 引擎往上用的时候再换成自己的类型(conId 成整数之类),不在解码这一层做。

/// 一张合约,字段与读法照 @stoqey/ib 的 Contract。
struct Contract {
    double conId = 0;
    QString symbol;
    QString secType;
    QString lastTradeDateOrContractMonth;
    std::optional<double> strike;
    /// 只认 "C" / "P",别的(包括空串、"CALL")都是空的
    std::optional<QString> right;
    std::optional<double> multiplier;
    QString exchange;
    QString currency;
    QString localSymbol;
    /// 版本 2 起才有
    std::optional<QString> tradingClass;
};

struct Position {
    QString account;
    Contract contract;
    /// 持仓数量:空串、MAX_VALUE、+Infinity 都是"没有"
    std::optional<double> pos;
    /// 版本 3 起才有,之前是 0;MAX_VALUE 是"没有"
    std::optional<double> avgCost;
};

struct PositionEnd {};

struct NextValidId {
    double orderId = 0;
};

struct ManagedAccounts {
    /// 逗号分隔的账户表,原样
    QString accounts;
};

struct CurrentTime {
    double epochSeconds = 0;
};

/// 一条报错。`info` 为真的是 TWS 的通告(请求号 -1,如 2104 数据农场连上了),不是哪个请求失败了。
struct ErrorMessage {
    bool info = false;
    /// 老格式(版本 1)没有请求号
    std::optional<double> reqId;
    double code = 0;
    /// \uXXXX 已经还原成字
    QString message;
    /// 详细的拒单原因(版本 166 起有这一格,是一段 JSON);空串或解析不了时是空的
    std::optional<QJsonObject> advancedOrderReject;
};

using Body = std::variant<std::monostate, ManagedAccounts, NextValidId, CurrentTime, ErrorMessage, Position, PositionEnd>;

struct Message {
    /// 消息号;读不出是 NaN,当成不认识的
    double id = 0;
    Body body;
    /// 字段不够,这一条没采用(库在这时也什么都不发)
    bool underrun = false;
    /// 读完了还剩字段:更新的版本往末尾加了格。前面读到的照样采用
    bool leftover = false;
    /// 不认识的消息号,整条跳过
    bool unknown = false;
};

/// 一条消息(握手回话之后的)→ 读出来的东西。serverVersion 是握手谈下来的版本,决定哪些格存在。
Message decode(const QStringList& fields, int serverVersion);

/// 报错文字里的 \uXXXX 还原成字(同 @stoqey/ib 的 decodeUnicodeEscapedString:从头找、一次换一个,换出来的字还可能拼成下一个)。
QString decodeUnicodeEscapes(QString text);

/// 和 TS 引擎经 @stoqey/ib 看到的一样的 JSON 形状(对拍与诊断工具用):
/// 没有的键不写,NaN 与 ±Infinity 写成 null。
QJsonObject contractToJson(const Contract& contract);

}  // namespace ibkr::tws
