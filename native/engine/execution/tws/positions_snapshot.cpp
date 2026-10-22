#include "execution/tws/positions_snapshot.h"

namespace ibkr::tws {

PositionsSnapshot::PositionsSnapshot(Transport* transport, Client::Options options, int timeoutMs, QObject* parent)
    : QObject(parent), client_(transport, options) {
    timeout_.setSingleShot(true);
    timeout_.setInterval(timeoutMs);
    connect(&timeout_, &QTimer::timeout, this, [this] {
        fail(QStringLiteral("读持仓等了 %1 秒没有读完").arg(timeout_.interval() / 1000.0));
    });
    connect(&client_, &Client::handshaken, this, [this](int version, const QString& time) {
        result_.serverVersion = version;
        result_.connectionTime = time;
    });
    connect(&client_, &Client::managedAccounts, this, [this](const QString& accounts) { result_.managedAccounts = accounts; });
    // TWS 认了这条连接才发请求
    connect(&client_, &Client::ready, this, [this] { client_.requestPositions(); });
    connect(&client_, &Client::position, this, [this](const Position& p) { result_.positions.append(p); });
    connect(&client_, &Client::positionEnd, this, &PositionsSnapshot::finishOk);
    connect(&client_, &Client::errorMessage, this, [this](const ErrorMessage& e) { result_.notices.append(e); });
    connect(&client_, &Client::malformed, this, [this](double id, int fieldCount) {
        if (id == in::kPosition) fail(QStringLiteral("一条持仓消息的字段不够(%1 个),这一趟不采用").arg(fieldCount));
    });
    connect(&client_, &Client::failed, this, [this](const QString& reason) {
        // 断之前 TWS 多半说了为什么(326 client id 被占着之类,请求号是 -1、长得像通告),带上最近一条;
        // 21xx 是数据农场的通告(连上了、断了又好了),不算原因(同 ibExecHistory.ts)
        QString why = reason;
        for (qsizetype i = result_.notices.size() - 1; i >= 0; --i) {
            const ErrorMessage& e = result_.notices[i];
            if (e.code >= 2100 && e.code < 2200) continue;
            why += QStringLiteral(":%1 %2").arg(e.code).arg(e.message);
            break;
        }
        fail(why);
    });
}

void PositionsSnapshot::start() {
    timeout_.start();
    client_.start();
}

void PositionsSnapshot::finishOk() {
    if (finished_) return;
    finished_ = true;
    timeout_.stop();
    // 撤掉持仓订阅再关:不撤的话 TWS 会一直往这条(马上要关的)连接上推持仓的变动
    client_.cancelPositions();
    client_.stop();
    emit done(result_);
}

void PositionsSnapshot::fail(const QString& reason) {
    if (finished_) return;
    finished_ = true;
    timeout_.stop();
    client_.stop();
    emit failed(reason);
}

}  // namespace ibkr::tws
