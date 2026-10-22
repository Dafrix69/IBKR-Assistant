// 连上 TWS、读一次全部持仓、关掉(只读)。阶段 0 拿它证明线协议客户端在真机上通了;回放器也拿它当"剧本"——
// 同样的剧本放在录像上,写出去的字节必须和录的时候一模一样。
//
// 和 ibExecHistory.ts 同一个规矩:要么给出完整的一批,要么明说没要到,不许给半批。
// 持仓消息字段不够(malformed)、TWS 断了、超时,都算没要到。
#pragma once

#include "execution/tws/client.h"

#include <QList>
#include <QTimer>

namespace ibkr::tws {

struct PositionsResult {
    int serverVersion = 0;
    QString connectionTime;
    /// 逗号分隔的账户表(原样,含真实账号:给人看之前先遮)
    QString managedAccounts;
    QList<Position> positions;
    /// TWS 这一趟发来的报错与通告(2104 数据农场连上了之类),按到达的先后
    QList<ErrorMessage> notices;
};

class PositionsSnapshot : public QObject {
    Q_OBJECT
public:
    PositionsSnapshot(Transport* transport, Client::Options options, int timeoutMs, QObject* parent = nullptr);

    void start();

signals:
    void done(const ibkr::tws::PositionsResult& result);
    void failed(const QString& reason);

private:
    void finishOk();
    void fail(const QString& reason);

    Client client_;
    QTimer timeout_;
    PositionsResult result_;
    bool finished_ = false;
};

}  // namespace ibkr::tws
