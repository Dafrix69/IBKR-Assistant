// TWS 客户端:握手、报到、收消息、发那几句只读的请求。只会说 codec.h 里有的那几句——发不了单。
//
// 收发都在调用方的线程里(事件循环),不另起读线程。认 V100 分帧;握手谈下来的版本不在 [min, max] 里就断。
// 消息分三种处理:认识的发对应的信号;不认识的整条跳过(skipped);字段不够的不采用、报 malformed——
// 用它的人自己决定这算不算失败(一次性读持仓的那一个就算:不许给半批)。
#pragma once

#include "execution/tws/codec.h"
#include "execution/tws/transport.h"

#include <QObject>

namespace ibkr::tws {

class Client : public QObject {
    Q_OBJECT
public:
    struct Options {
        int clientId = 0;
        int minVersion = kMinVersion;
        int maxVersion = kMainMaxVersion;
    };

    Client(Transport* transport, Options options, QObject* parent = nullptr);

    void start();
    /// 自己关:之后不再发任何信号
    void stop();

    /// TWS 认了这条连接(下一个订单号到了),可以发请求了
    bool isReady() const { return ready_; }
    int serverVersion() const { return serverVersion_; }
    const Options& options() const { return options_; }

    void requestPositions();
    void cancelPositions();
    void requestCurrentTime();

signals:
    void handshaken(int serverVersion, const QString& connectionTime);
    void ready(double nextValidId);
    void managedAccounts(const QString& accounts);
    void position(const ibkr::tws::Position& position);
    void positionEnd();
    void currentTime(double epochSeconds);
    void errorMessage(const ibkr::tws::ErrorMessage& error);
    void skipped(double messageId);
    void malformed(double messageId, int fieldCount);
    /// 这条连接没法再用了(连不上、握手认不出、版本不对、长度不对、对方关了)。只发一次
    void failed(const QString& reason);

private:
    void onReceived(const QByteArray& chunk);
    void onFrame(const QStringList& fields);
    void fail(const QString& reason);

    Transport* transport_;
    Options options_;
    QByteArray pending_;
    int serverVersion_ = 0;
    bool ready_ = false;
    bool done_ = false;
};

}  // namespace ibkr::tws
