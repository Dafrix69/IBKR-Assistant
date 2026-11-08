// 下单时延模拟用的"会回话的 TWS":假在 socket 这一层(ibnext::NodeSocket),上面跑的是真的 ApiNext / IbApiNextSession /
// BrokerRouter / TradingEngine。它不对拍任何夹具,只做一件事:按一份时延表(SimProfile)像 TWS 那样回话,并记下
// 每一条请求是什么时刻发出来的——尤其是 placeOrder 的字节什么时刻落到 socket 上(那一刻起 IBKR 就认得这张单了)。
//
// 回的消息只是解码器读得懂的最小一份(字段次序照 engine/execution/tws/wire_in.cpp 的解码,服务器版本 193):
//   握手 → 版本与时刻;START_API → 账户表 + 下一个订单号;REQ_IDS → 下一个订单号;REQ_CONTRACT_DATA → 一条合约详情 + 结束;
//   REQ_MKT_DATA → 买价 / 卖价 / 成交价;PLACE_ORDER → 一条订单状态(Submitted)。别的请求收下、不回。
// 计时器全是真的 QTimer(真钟),所以量出来的毫秒包含了这份代码自己的 CPU 时间。全部离线,不开端口。
#pragma once

#include "execution/ib_api_next.h"
#include "execution/tws/codec.h"

#include <QElapsedTimer>
#include <QHash>
#include <QObject>
#include <QPointer>
#include <QTimer>
#include <QtEndian>

#include <cmath>
#include <functional>
#include <memory>

namespace ibkr::sim {

using namespace Qt::StringLiterals;
namespace ibnext = ibkr::execution::ibnext;

/// 一份 TWS 回话快慢的设定(毫秒)。缺省值是"本机 TWS、走代理到 IBKR"的量级,见 tst_order_latency 的说明
struct SimProfile {
    QString name = u"proxy"_s;
    /// 合约详情(要问 IBKR 服务器):每一条请求各自这么久
    int contractDetailsMs = 250;
    /// 下一个订单号(TWS 本机就答)
    int reqIdsMs = 3;
    /// 订阅期权行情后第一笔买卖价
    int optionFirstTickMs = 350;
    /// 订阅指数 / 股票行情后第一笔价
    int indexFirstTickMs = 150;
    /// 下单后 TWS 回 Submitted
    int orderAckMs = 40;
    /// 握手 / 报到
    int handshakeMs = 5;
    /// 历史 K 线(夜盘算基差要两段 30 根 1 分钟线);< 0 = 一直不回(农场不回话)
    int historicalMs = 600;
};

/// 一条请求的记录
struct SimRequest {
    double atMs = 0;  // 从 SimClock 起点算
    int msgId = 0;
    QStringList fields;
};

/// 所有 SimTws 共用的钟与记录(一个场景一份)
class SimWorld {
public:
    SimWorld() { clock.start(); }
    QElapsedTimer clock;
    SimProfile profile;
    QList<SimRequest> requests;
    /// 每条 placeOrder 的字节到 socket 的时刻
    QList<double> placedAtMs;
    double underlying = 6800;
    QString accounts = u"DU7654321,U1234567,U7777777"_s;
    int nextOrderId = 1000;

    double now() const { return double(clock.nsecsElapsed()) / 1e6; }
    void reset() {
        requests.clear();
        placedAtMs.clear();
        clock.restart();
    }
    /// 某种请求一共来了几条
    int count(int msgId) const {
        int n = 0;
        for (const SimRequest& r : requests) n += r.msgId == msgId;
        return n;
    }
};

/// 发出去的消息号(只认这里用到的)
namespace out {
inline constexpr int kReqMktData = 1;
inline constexpr int kCancelMktData = 2;
inline constexpr int kPlaceOrder = 3;
inline constexpr int kReqIds = 8;
inline constexpr int kReqContractData = 9;
inline constexpr int kReqHistoricalData = 20;
inline constexpr int kReqMarketDataType = 59;
inline constexpr int kStartApi = 71;
}  // namespace out

/// 同一合约每次给同一个 conId
inline int simConId(const QString& symbol, const QString& secType, const QString& expiry, const QString& strike, const QString& right) {
    const QByteArray key = (symbol + u'|' + secType + u'|' + expiry + u'|' + strike + u'|' + right).toUtf8();
    quint32 h = 2166136261u;
    for (const char c : key) h = (h ^ quint8(c)) * 16777619u;
    return int(h % 900'000'000u) + 10'000'000;
}

class SimTws : public ibnext::NodeSocket {
public:
    SimTws(SimWorld* world, Handlers handlers) : w_(world), h_(std::move(handlers)) {
        anchor_ = new QObject();
        later(w_->profile.handshakeMs, [this] {
            if (h_.connect) h_.connect();
        });
    }
    ~SimTws() override { delete anchor_; }

    void write(const QByteArray& bytes) override {
        if (destroyed_) return;
        buf_ += bytes;
        for (;;) {
            if (!handshaken_) {
                if (buf_.size() < 8) return;
                const quint32 n = qFromBigEndian<quint32>(buf_.constData() + 4);
                if (buf_.size() < 8 + qsizetype(n)) return;
                buf_.remove(0, 8 + n);
                handshaken_ = true;
                say(w_->profile.handshakeMs, {{u"193"_s, u"20261104 10:30:00 America/New_York"_s}});
                continue;
            }
            if (buf_.size() < 4) return;
            const quint32 n = qFromBigEndian<quint32>(buf_.constData());
            if (buf_.size() < 4 + qsizetype(n)) return;
            QStringList fields = QString::fromUtf8(buf_.mid(4, n)).split(QChar(u'\0'));
            if (!fields.isEmpty() && fields.last().isEmpty()) fields.removeLast();
            buf_.remove(0, 4 + n);
            onRequest(fields);
        }
    }
    void end() override {}
    void destroy() override {
        if (destroyed_) return;
        destroyed_ = true;
        auto close = h_.close;
        QTimer::singleShot(0, [close] {
            if (close) close();
        });
    }

private:
    void later(int ms, std::function<void()> fn) {
        QPointer<QObject> guard(anchor_);
        QTimer::singleShot(ms, anchor_, [guard, fn = std::move(fn)] {
            if (guard) fn();
        });
    }
    void say(int ms, const QList<QStringList>& messages) {
        QByteArray chunk;
        for (const QStringList& m : messages) chunk += tws::frame(m);
        later(ms, [this, chunk] {
            if (!destroyed_ && h_.data) h_.data(chunk);
        });
    }

    void onRequest(const QStringList& f) {
        const int id = f.value(0).toInt();
        w_->requests.append({w_->now(), id, f});
        const SimProfile& p = w_->profile;
        switch (id) {
        case out::kStartApi:
            say(p.handshakeMs, {{u"15"_s, u"1"_s, w_->accounts}, {u"9"_s, u"1"_s, QString::number(w_->nextOrderId)}});
            break;
        case out::kReqIds:
            say(p.reqIdsMs, {{u"9"_s, u"1"_s, QString::number(w_->nextOrderId)}});
            break;
        case out::kReqContractData:
            say(p.contractDetailsMs, contractReply(f));
            break;
        case out::kReqMktData:
            marketData(f);
            break;
        case out::kReqHistoricalData:
            if (p.historicalMs >= 0) say(p.historicalMs, {historicalReply(f)});
            break;
        case out::kPlaceOrder: {
            w_->placedAtMs.append(w_->now());
            const QString orderId = f.value(1);
            w_->nextOrderId = std::max(w_->nextOrderId, orderId.toInt() + 1);
            // 订单状态(sv 193):orderId, status, filled, remaining, avgFillPrice, permId, parentId, lastFillPrice, clientId, whyHeld, mktCapPrice
            say(p.orderAckMs, {{u"3"_s, orderId, u"Submitted"_s, u"0"_s, u"1"_s, u"0"_s, QString::number(900000 + orderId.toInt()), u"0"_s, u"0"_s, u"11"_s,
                                QString(), u"0"_s}});
            break;
        }
        default:
            break;
        }
    }

    /// REQ_CONTRACT_DATA:[9, 8, reqId, conId, symbol, secType, expiry, strike, right, multiplier, exchange, primaryExch, currency,
    ///                     localSymbol, tradingClass, includeExpired, secIdType, secId, issuerId]
    QList<QStringList> contractReply(const QStringList& f) {
        const QString reqId = f.value(2), symbol = f.value(4), secType = f.value(5), expiry = f.value(6);
        QString strike = f.value(7), right = f.value(8);
        const QString currency = f.value(12).isEmpty() ? u"USD"_s : f.value(12);
        const bool option = secType == u"OPT";
        if (!option) {
            strike = u"0"_s;
            right = QString();
        }
        QString tradingClass = f.value(14);
        if (tradingClass.isEmpty()) tradingClass = option && symbol == u"SPX"_s ? u"SPXW"_s : symbol;
        const QString exchange = !f.value(10).isEmpty() ? f.value(10) : secType == u"IND"_s ? u"CBOE"_s : u"SMART"_s;
        const int conId = simConId(symbol, secType, expiry, strike, right);
        const QString day = u"20261104"_s, next = u"20261105"_s;
        const QString hours = day + u":0930-"_s + day + u":1615;"_s + next + u":0930-"_s + next + u":1615"_s;
        // 合约详情(sv 193,解码见 wire_in.cpp contractData):版本字段不发(sv ≥ 164)
        QStringList m{u"10"_s, reqId, symbol, secType, option ? expiry : QString(), option ? expiry : QString(), strike, right, exchange, currency,
                      QString(), symbol, tradingClass, QString::number(conId), u"0.05"_s, option ? u"100"_s : QString(), u"LMT,MKT"_s, u"SMART,CBOE"_s,
                      u"1"_s, u"0"_s, symbol, QString(), QString(), QString(), QString(), QString(), u"America/New_York"_s, hours, hours, QString(),
                      QString(), u"0"_s, u"1"_s, symbol, u"IND"_s, u"26"_s, option ? expiry : QString(), QString(), u"1"_s, u"1"_s, u"1"_s, u"0"_s};
        return {m, {u"52"_s, u"1"_s, reqId}};
    }

    /// REQ_HISTORICAL_DATA(sv 193):[20, reqId, conId, symbol, secType, ...]。回 15:35–16:00 美东每分钟一根,
    /// 指数收 underlying、期货收 underlying + 30(基差 30)
    QStringList historicalReply(const QStringList& f) {
        const QString reqId = f.value(1), secType = f.value(4);
        const double close = secType == u"FUT"_s ? w_->underlying + 30 : w_->underlying;
        QStringList m{u"17"_s, reqId, u"20261104 15:35:00"_s, u"20261104 16:05:00"_s, u"26"_s};
        for (int minute = 35; minute <= 60; ++minute) {
            const QString t = minute == 60 ? u"16:00"_s : u"15:%1"_s.arg(minute);
            const QString px = QString::number(close, 'f', 2);
            m << u"20261104 %1:00 America/New_York"_s.arg(t) << px << px << px << px << u"-1"_s << u"-1"_s << u"0"_s;
        }
        return m;
    }

    /// REQ_MKT_DATA:[1, 11, reqId, conId, symbol, secType, expiry, strike, right, ...]
    void marketData(const QStringList& f) {
        const QString reqId = f.value(2), secType = f.value(5);
        const auto tick = [&](int type, double price) {
            return QStringList{u"1"_s, u"3"_s, reqId, QString::number(type), QString::number(price, 'f', 2), u"10"_s, u"0"_s};
        };
        if (secType == u"OPT"_s) {
            const double k = f.value(7).toDouble();
            const bool call = f.value(8).startsWith(u'C');
            const double intrinsic = std::max(0.0, call ? w_->underlying - k : k - w_->underlying);
            const double mid = std::round((intrinsic + 6.0 * std::exp(-std::abs(k - w_->underlying) / 25.0) + 0.05) * 20.0) / 20.0;
            say(w_->profile.optionFirstTickMs, {tick(1, std::max(0.05, mid - 0.05)), tick(2, mid + 0.05), tick(4, mid)});
        } else {
            // 期货比指数高 30 点(基差);股票一律 213
            const double px = secType == u"IND"_s ? w_->underlying : secType == u"FUT"_s ? w_->underlying + 30 : 213.0;
            say(w_->profile.indexFirstTickMs, {tick(1, px - 0.05), tick(2, px + 0.05), tick(4, px), tick(9, px - 10)});
        }
    }

    SimWorld* w_;
    Handlers h_;
    QObject* anchor_ = nullptr;
    QByteArray buf_;
    bool handshaken_ = false, destroyed_ = false;
};

inline ibnext::SocketFactory simSockets(SimWorld* world) {
    return [world](const QString&, double, ibnext::NodeSocket::Handlers h) -> std::shared_ptr<ibnext::NodeSocket> {
        return std::make_shared<SimTws>(world, std::move(h));
    };
}

}  // namespace ibkr::sim
