#include "execution/tws/client.h"

#include <cmath>

namespace ibkr::tws {

Client::Client(Transport* transport, Options options, QObject* parent)
    : QObject(parent), transport_(transport), options_(options) {
    connect(transport_, &Transport::opened, this, [this] {
        if (!done_) transport_->write(handshake(options_.minVersion, options_.maxVersion));
    });
    connect(transport_, &Transport::received, this, &Client::onReceived);
    connect(transport_, &Transport::closed, this, [this](const QString& reason) { fail(reason); });
}

void Client::start() {
    // 每一次连都从握手重新来:上一条连接谈下来的版本、"已认"、没切完的半条消息都不能带过来
    done_ = false;
    ready_ = false;
    serverVersion_ = 0;
    pending_.clear();
    transport_->open();
}

void Client::stop() {
    if (done_) return;
    done_ = true;
    transport_->close();
}

void Client::requestPositions() {
    if (ready_ && !done_) transport_->write(reqPositions());
}

void Client::cancelPositions() {
    if (ready_ && !done_) transport_->write(tws::cancelPositions());
}

void Client::requestCurrentTime() {
    if (ready_ && !done_) transport_->write(reqCurrentTime());
}

void Client::onReceived(const QByteArray& chunk) {
    if (done_) return;
    pending_ += chunk;
    const SplitResult cut = splitFrames(pending_);
    if (cut.badSize) return fail(QStringLiteral("TWS 发来的消息长度不对(%1 字节)").arg(*cut.badSize));
    // 一条都没切出来(大消息还在路上)时不动缓冲,不拷
    if (cut.consumed > 0) pending_.remove(0, cut.consumed);
    for (const QStringList& fields : std::as_const(cut.frames)) {
        if (done_) return;
        onFrame(fields);
    }
}

void Client::onFrame(const QStringList& fields) {
    if (serverVersion_ == 0) {
        // 握手的回话:[接口版本, 连接时刻]
        const ServerVersion v = decodeServerVersion(fields);
        if (!std::isfinite(v.version) || v.version < options_.minVersion || v.version > options_.maxVersion) {
            return fail(QStringLiteral("TWS 握手的回话认不出或版本不在 %1..%2 里:%3")
                            .arg(options_.minVersion).arg(options_.maxVersion).arg(fields.join(u' ').left(80)));
        }
        serverVersion_ = static_cast<int>(v.version);
        emit handshaken(serverVersion_, v.connectionTime);
        transport_->write(startApi(options_.clientId));
        return;
    }
    const Message m = decode(fields, serverVersion_);
    if (m.unknown) return emit skipped(m.id);
    if (m.underrun) return emit malformed(m.id, static_cast<int>(fields.size()));
    if (const auto* p = std::get_if<Position>(&m.body)) return emit position(*p);
    if (std::holds_alternative<PositionEnd>(m.body)) return emit positionEnd();
    if (const auto* e = std::get_if<ErrorMessage>(&m.body)) return emit errorMessage(*e);
    if (const auto* a = std::get_if<ManagedAccounts>(&m.body)) return emit managedAccounts(a->accounts);
    if (const auto* t = std::get_if<CurrentTime>(&m.body)) return emit currentTime(t->epochSeconds);
    if (const auto* n = std::get_if<NextValidId>(&m.body)) {
        const bool first = !ready_;
        ready_ = true;
        if (first) emit ready(n->orderId);
    }
}

void Client::fail(const QString& reason) {
    if (done_) return;
    done_ = true;
    transport_->close();
    emit failed(reason);
}

}  // namespace ibkr::tws
