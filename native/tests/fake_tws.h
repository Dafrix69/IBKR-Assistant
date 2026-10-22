// 假的 TWS,假在字节这一层:客户端写什么它就按 TWS 的规矩回什么(握手 → 版本与时刻;报到 → 账户表、
// 下一个订单号、数据农场通告;要持仓 → 一条条持仓 + 发完了)。全部离线,不开端口。
//
// 想让它出怪事就改字段:版本报低了、不回持仓、半路断、回一条字段不够的持仓、连着两条消息塞在一块里送……
// 回话一律下一轮事件循环再送(QTimer 0):真的 TWS 也不会在客户端的 write() 里面回话。
#pragma once

#include "execution/tws/codec.h"
#include "execution/tws/transport.h"

#include <QList>
#include <QtEndian>
#include <QStringList>
#include <QTimer>

namespace ibkr::test {

class FakeTws : public tws::Transport {
    Q_OBJECT
public:
    using tws::Transport::Transport;

    // ---- 它怎么回 ----
    QStringList versionReply{QStringLiteral("193"), QStringLiteral("20261018 10:05:01 Asia/Shanghai")};
    QString accounts = QStringLiteral("U1234567,DU7654321");
    /// 每条持仓的字段(含消息号 61 与版本)
    QList<QStringList> positions;
    /// 报到之后先送的通告
    QList<QStringList> greetingExtras{{QStringLiteral("4"), QStringLiteral("2"), QStringLiteral("-1"), QStringLiteral("2104"),
                                       QStringLiteral("Market data farm connection is OK:usfarm"), QString()}};
    bool answerPositions = true;
    /// 收到握手就回版本(关掉它,测试自己决定回什么)
    bool answerHandshake = true;
    /// 每块回话按这个字节数切开送(0 = 整块),测分帧
    int chunkBytes = 0;

    // ---- 它看见了什么 ----
    QList<QStringList> requests;
    QByteArray handshakeSeen;
    int opens = 0;
    bool closedByClient = false;

    void open() override {
        // 重连:像一个新的 TWS 连接那样从握手重来
        ++opens;
        closedByClient = false;
        handshakeSeen.clear();
        written_.clear();
        QTimer::singleShot(0, this, [this] { emit opened(); });
    }

    void write(const QByteArray& bytes) override {
        written_ += bytes;
        if (handshakeSeen.isEmpty()) {
            // 握手不带长度前缀:API\0 + 4 字节长度 + 版本串
            if (written_.size() < 8) return;
            const qsizetype size = static_cast<qsizetype>(qFromBigEndian<quint32>(written_.constData() + 4));
            if (written_.size() < 8 + size) return;
            handshakeSeen = written_.left(8 + size);
            written_.remove(0, 8 + size);
            if (answerHandshake) say({versionReply});
        }
        const tws::SplitResult cut = tws::splitFrames(written_);
        written_.remove(0, cut.consumed);
        for (const QStringList& fields : cut.frames) onRequest(fields);
    }

    void close() override { closedByClient = true; }

    /// TWS 主动送一批消息(一块送达)
    void say(const QList<QStringList>& messages) {
        QByteArray chunk;
        for (const QStringList& m : messages) chunk += tws::frame(m);
        sayRaw(chunk);
    }
    void sayRaw(const QByteArray& chunk) {
        QTimer::singleShot(0, this, [this, chunk] {
            if (closedByClient) return;
            if (chunkBytes <= 0) return emit received(chunk);
            for (qsizetype at = 0; at < chunk.size() && !closedByClient; at += chunkBytes) emit received(chunk.mid(at, chunkBytes));
        });
    }
    void hangUp(const QString& reason) {
        QTimer::singleShot(0, this, [this, reason] {
            if (!closedByClient) emit closed(reason);
        });
    }

private:
    void onRequest(const QStringList& fields) {
        requests.append(fields);
        const int id = fields.value(0).toInt();
        if (id == tws::out::kStartApi) {
            QList<QStringList> greeting{{QStringLiteral("15"), QStringLiteral("1"), accounts}, {QStringLiteral("9"), QStringLiteral("1"), QStringLiteral("1")}};
            greeting += greetingExtras;
            say(greeting);
        } else if (id == tws::out::kReqPositions && answerPositions) {
            QList<QStringList> batch = positions;
            batch.append({QStringLiteral("62"), QStringLiteral("1")});
            say(batch);
        }
    }

    QByteArray written_;
};

/// 一条期权持仓的字段(版本 3)
inline QStringList optionPosition(const QString& account, const QString& strike, const QString& qty) {
    return {QStringLiteral("61"), QStringLiteral("3"), account, QStringLiteral("920693462"), QStringLiteral("SPX"), QStringLiteral("OPT"),
            QStringLiteral("20261007"), strike, QStringLiteral("P"), QStringLiteral("100"), QString(), QStringLiteral("USD"),
            QStringLiteral("SPXW  261007P07790000"), QStringLiteral("SPXW"), qty, QStringLiteral("1234.56")};
}

}  // namespace ibkr::test
