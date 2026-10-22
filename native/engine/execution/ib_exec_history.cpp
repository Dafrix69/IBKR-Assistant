#include "execution/ib_exec_history.h"

#include "util/error.h"
#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"

#include <QTcpSocket>
#include <QTimer>
#include <QtEndian>

#include <cmath>
#include <memory>

namespace ibkr::execution {

using namespace Qt::StringLiterals;
namespace js = util::js;

namespace {

constexpr int kOutReqExecutions = 7;
constexpr int kOutStartApi = 71;
constexpr double kInErrMsg = 4;
constexpr double kInNextValidId = 9;
constexpr double kInExecutionData = 11;
constexpr double kInManagedAccts = 15;
constexpr double kInExecutionDataEnd = 55;
/// 一条消息最长多少字节:TWS 自己的上限是 16MB,超了说明读错了位置
constexpr quint32 kFrameMax = 16 * 1024 * 1024;
/// 成交消息里这里要读到的最后一格(orderRef)的位置 + 1
constexpr qsizetype kExecutionFieldsMin = 27;

QByteArray sizePrefix(qsizetype n) {
    QByteArray size(4, '\0');
    qToBigEndian<quint32>(static_cast<quint32>(n), size.data());
    return size;
}

/// Number(fields[i]):越界是 undefined → NaN
double numberAt(const QStringList& fields, qsizetype i) {
    return i < fields.size() ? util::jsStringToNumber(fields[i]) : std::nan("");
}

/// 成交消息里的数:去掉千分位逗号再 Number(),不是有限数就是 0
double num(const QString& token) {
    const double n = util::jsStringToNumber(QString(token).replace(u',', QString()));
    return std::isfinite(n) ? n : 0;
}

}  // namespace

double historyClientId(double clientId) { return clientId + kHistoryClientOffset; }

QByteArray handshakeBytes() {
    const QByteArray versions = QByteArray("v") + QByteArray::number(kHistoryMinVersion) + ".." + QByteArray::number(kHistoryMaxVersion);
    return QByteArray("API\0", 4) + sizePrefix(versions.size()) + versions;
}

QByteArray frame(const QList<FrameField>& fields) {
    QString text;
    for (const FrameField& f : fields) {
        text += std::holds_alternative<QString>(f) ? std::get<QString>(f) : util::jsNumberToString(std::get<double>(f));
        text += QChar(u'\0');
    }
    const QByteArray payload = util::toNodeUtf8(text);
    return sizePrefix(payload.size()) + payload;
}

QByteArray startApiBytes(double clientId) { return frame({double(kOutStartApi), 2.0, clientId, QString()}); }

QByteArray executionsRequestBytes(double reqId, double days) {
    return frame({double(kOutReqExecutions), 3.0, reqId, 0.0, QString(), QString(), QString(), QString(), QString(), QString(), days, 0.0});
}

SplitFrames splitFrames(const QByteArray& buffer) {
    SplitFrames out;
    qsizetype at = 0;
    while (buffer.size() - at >= 4) {
        const quint32 size = qFromBigEndian<quint32>(buffer.constData() + at);
        if (size > kFrameMax) throw util::JsError(u"TWS 发来的消息长度不对(%1 字节)"_s.arg(size));
        if (buffer.size() - at - 4 < static_cast<qsizetype>(size)) break;
        QStringList fields = util::nodeUtf8(buffer.mid(at + 4, size)).split(QChar(u'\0'));
        // 每个字段后面都有一个 \0,切出来末尾多一个空串
        if (fields.last().isEmpty()) fields.removeLast();
        out.frames.append(fields);
        at += 4 + size;
    }
    out.rest = buffer.mid(at);
    return out;
}

std::optional<DecodedExecution> decodeExecution(const QStringList& fields) {
    if (fields.size() < kExecutionFieldsMin) return std::nullopt;
    const auto f = [&](qsizetype i) { return fields[i]; };
    const QString right = f(8);
    OJson contract = js::object();
    contract.set(u"conId"_s, js::N(num(f(3))));
    contract.set(u"symbol"_s, js::S(f(4)));
    contract.set(u"secType"_s, js::S(f(5)));
    contract.set(u"lastTradeDateOrContractMonth"_s, js::S(f(6)));
    contract.set(u"strike"_s, js::N(num(f(7))));
    // 看涨看跌只认 C / P,别的是 undefined(出 JSON 时没有这个键)
    if (right == u"C" || right == u"P") contract.set(u"right"_s, js::S(right));
    contract.set(u"multiplier"_s, js::N(num(f(9))));
    contract.set(u"exchange"_s, js::S(f(10)));
    contract.set(u"currency"_s, js::S(f(11)));
    contract.set(u"localSymbol"_s, js::S(f(12)));
    contract.set(u"tradingClass"_s, js::S(f(13)));
    OJson execution = js::object();
    execution.set(u"orderId"_s, js::N(num(f(2))));
    execution.set(u"execId"_s, js::S(f(14)));
    execution.set(u"time"_s, js::S(f(15)));
    execution.set(u"acctNumber"_s, js::S(f(16)));
    execution.set(u"exchange"_s, js::S(f(17)));
    execution.set(u"side"_s, js::S(f(18)));
    execution.set(u"shares"_s, js::N(num(f(19))));
    execution.set(u"price"_s, js::N(num(f(20))));
    execution.set(u"permId"_s, js::N(num(f(21))));
    execution.set(u"clientId"_s, js::N(num(f(22))));
    execution.set(u"liquidation"_s, js::N(num(f(23))));
    execution.set(u"cumQty"_s, js::N(num(f(24))));
    execution.set(u"avgPrice"_s, js::N(num(f(25))));
    execution.set(u"orderRef"_s, js::S(f(26)));
    return DecodedExecution{num(f(1)), ExecutionRow{contract, execution}};
}

// ---------------------------------------------------------------- 状态机

HistoryExchange::HistoryExchange(Io io, double clientId, double days, double timeoutMs, Settled settled)
    : io_(std::move(io)),
      clientId_(clientId),
      days_(util::jsmath::min(kHistoryDaysMax, util::jsmath::max(1, std::trunc(days)))),
      timeoutMs_(timeoutMs),
      settled_(std::move(settled)) {}

bool HistoryExchange::finish() {
    if (done_) return false;
    done_ = true;
    io_.clearTimer();
    return true;
}

void HistoryExchange::fail(const QString& message) {
    if (!finish()) return;
    io_.destroy();
    settled_(std::nullopt, message);
}

void HistoryExchange::succeed(bool supported) {
    if (!finish()) return;
    io_.end();
    settled_(HistoryResult{serverVersion_, supported, details_}, QString());
}

void HistoryExchange::onFrame(const QStringList& fields) {
    constexpr double reqId = 1;
    if (serverVersion_ == 0) {
        // 握手的回话:[接口版本, 连接时刻]
        serverVersion_ = std::trunc(numberAt(fields, 0));
        if (!std::isfinite(serverVersion_) || serverVersion_ < kHistoryMinVersion)
            return fail(u"TWS 握手的回话认不出:"_s + fields.join(u' ').left(80));
        if (serverVersion_ < kHistoryMaxVersion) return succeed(false);
        io_.write(startApiBytes(clientId_));
        return;
    }
    const double id = numberAt(fields, 0);
    if ((id == kInNextValidId || id == kInManagedAccts) && !asked_) {
        // TWS 认了这条连接:可以发请求了
        asked_ = true;
        io_.write(executionsRequestBytes(reqId, days_));
        return;
    }
    if (id == kInExecutionData) {
        const auto got = decodeExecution(fields);
        if (!got) return fail(u"成交消息的字段不够(%1 个),没有采用这一趟"_s.arg(fields.size()));
        if (got->reqId == reqId) details_.push_back(got->detail);
        return;
    }
    if (id == kInExecutionDataEnd) {
        if (numberAt(fields, 2) == reqId) succeed(true);
        return;
    }
    if (id == kInErrMsg) {
        // 194 版起:[4, 请求号, 错误码, 说明, 详细拒单原因, 时刻]
        const double code = numberAt(fields, 2);
        const QString text = util::jsTrim(fields.value(2) + u' ' + fields.value(3)).left(200);
        if (numberAt(fields, 1) == reqId) return fail(u"TWS 拒了往回要成交的请求:"_s + text);
        if (!(code >= 2100 && code < 2200)) notice_ = text;
    }
}

void HistoryExchange::onConnect() { io_.write(handshakeBytes()); }

void HistoryExchange::onData(const QByteArray& chunk) {
    if (done_) return;
    try {
        const SplitFrames cut = splitFrames(pending_.size() ? pending_ + chunk : chunk);
        pending_ = cut.rest;
        for (const QStringList& fields : cut.frames) {
            if (done_) return;
            onFrame(fields);
        }
    } catch (const util::JsError& exc) {
        fail(exc.message());
    }
}

void HistoryExchange::onError(const QString& message) { fail(u"往回要成交的连接出错:"_s + message); }

void HistoryExchange::onClose() { fail(u"往回要成交的连接被 TWS 关了"_s + (notice_.isEmpty() ? QString() : u":"_s + notice_)); }

void HistoryExchange::onTimeout() {
    fail(u"往回要成交等了 %1 秒没有回应"_s.arg(util::jsNumberToString(util::jsRound(timeoutMs_ / 1000))));
}

// ---------------------------------------------------------------- socket

QString nodeSocketErrorMessage(QAbstractSocket::SocketError error, const QString& host, quint16 port, const QString& peer, const QString& qtText) {
    switch (error) {
        case QAbstractSocket::ConnectionRefusedError:
            return u"connect ECONNREFUSED %1:%2"_s.arg(peer.isEmpty() ? host : peer).arg(port);
        case QAbstractSocket::HostNotFoundError:
            return u"getaddrinfo ENOTFOUND "_s + host;
        case QAbstractSocket::SocketTimeoutError:
            return u"connect ETIMEDOUT %1:%2"_s.arg(peer.isEmpty() ? host : peer).arg(port);
        default:
            return qtText;
    }
}

double nodeTimerDelay(double ms) {
    if (!(ms >= 1 && ms <= 2147483647.0)) return 1;
    return std::trunc(ms);
}

std::optional<QString> nodeBadPortMessage(double port) {
    // Node 的 validatePort:+port !== (+port >>> 0) || port > 0xFFFF
    const bool ok = std::isfinite(port) && port >= 0 && port <= 0xFFFF && std::trunc(port) == port;
    if (ok) return std::nullopt;
    return u"Port should be >= 0 and < 65536. Received type number (%1)."_s.arg(util::jsNumberToString(port));
}

TcpHistorySocket::TcpHistorySocket(const QString& host, quint16 port, QObject* parent)
    : HistorySocket(parent), socket_(new QTcpSocket(this)), host_(host), port_(port) {
    QObject::connect(socket_, &QTcpSocket::connected, this, &HistorySocket::connected);
    QObject::connect(socket_, &QTcpSocket::readyRead, this, [this] {
        if (!gone_) emit data(socket_->readAll());
    });
    QObject::connect(socket_, &QTcpSocket::errorOccurred, this, [this](QAbstractSocket::SocketError e) {
        // 对方关了不算出错(Node 那边是 end + close),等 disconnected
        if (gone_ || e == QAbstractSocket::RemoteHostClosedError) return;
        emit failed(nodeSocketErrorMessage(e, host_, port_, socket_->peerAddress().toString(), socket_->errorString()));
        emit closed();
    });
    QObject::connect(socket_, &QTcpSocket::disconnected, this, [this] {
        if (!gone_) emit closed();
    });
    // 下一拍再连:调用方先把信号接好(Node 的 net.connect 也是下一拍才有事件)
    QTimer::singleShot(0, this, [this] {
        if (!gone_) socket_->connectToHost(host_, port_);
    });
}

void TcpHistorySocket::write(const QByteArray& data) {
    if (!gone_) socket_->write(data);
}

void TcpHistorySocket::end() {
    gone_ = true;
    socket_->disconnectFromHost();
}

void TcpHistorySocket::destroy() {
    gone_ = true;
    socket_->abort();
}

namespace {

/// 一趟的家当:socket、计时器、状态机。收尾之后自己删
class HistoryRun : public QObject {
public:
    HistoryRun(HistorySocket* socket, double clientId, double days, double timeoutMs, util::Deferred<HistoryResult> d)
        : socket_(socket), deferred_(std::move(d)) {
        socket_->setParent(this);
        timer_.setSingleShot(true);
        timer_.setInterval(static_cast<int>(nodeTimerDelay(timeoutMs)));
        exchange_ = std::make_unique<HistoryExchange>(
            HistoryExchange::Io{
                [this](const QByteArray& b) { socket_->write(b); },
                [this] { socket_->end(); },
                [this] { socket_->destroy(); },
                [this] { timer_.stop(); },
            },
            clientId, days, timeoutMs,
            [this](std::optional<HistoryResult> result, const QString& error) {
                if (result) deferred_.resolve(std::move(*result));
                else deferred_.reject(util::JsError(error));
                deleteLater();
            });
        QObject::connect(&timer_, &QTimer::timeout, this, [this] { exchange_->onTimeout(); });
        QObject::connect(socket_, &HistorySocket::connected, this, [this] { exchange_->onConnect(); });
        QObject::connect(socket_, &HistorySocket::data, this, [this](const QByteArray& c) { exchange_->onData(c); });
        QObject::connect(socket_, &HistorySocket::failed, this, [this](const QString& m) { exchange_->onError(m); });
        QObject::connect(socket_, &HistorySocket::closed, this, [this] { exchange_->onClose(); });
        timer_.start();
    }

private:
    HistorySocket* socket_;
    util::Deferred<HistoryResult> deferred_;
    QTimer timer_;
    std::unique_ptr<HistoryExchange> exchange_;
};

}  // namespace

Task<HistoryResult> fetchExecutionHistory(HistoryRequest request) {
    util::Deferred<HistoryResult> d;
    HistorySocket* socket = nullptr;
    if (request.connect) {
        socket = request.connect(request.host, request.port);
    } else {
        // net.connect 当场校验端口,不合格抛 RangeError(那时计时器还没起)
        if (const auto bad = nodeBadPortMessage(request.port)) {
            d.reject(util::JsError(*bad));
            return d.task();
        }
        socket = new TcpHistorySocket(request.host, static_cast<quint16>(request.port));
    }
    new HistoryRun(socket, request.clientId, request.days, request.timeoutMs.value_or(8000), d);
    return d.task();
}

}  // namespace ibkr::execution
