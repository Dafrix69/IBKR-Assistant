#include "execution/tws/transport.h"

namespace ibkr::tws {

TcpTransport::TcpTransport(QString host, quint16 port, QObject* parent)
    : Transport(parent), host_(std::move(host)), port_(port) {
    connect(&socket_, &QTcpSocket::connected, this, &Transport::opened);
    connect(&socket_, &QTcpSocket::readyRead, this, [this] {
        if (!done_) emit received(socket_.readAll());
    });
    connect(&socket_, &QTcpSocket::errorOccurred, this, [this](QAbstractSocket::SocketError) {
        finish(QStringLiteral("连接出错:%1").arg(socket_.errorString()));
    });
    connect(&socket_, &QTcpSocket::disconnected, this, [this] { finish(QStringLiteral("TWS 关了连接")); });
}

void TcpTransport::open() {
    // 重连:上一条连接还没断干净(还在 Closing 或者对方没关)就先断掉,否则 connectToHost 什么都不做。
    // 断它时 Qt 会发 disconnected:那是上一条的事,不能当成这一条"对方关了"报出去
    done_ = true;
    if (socket_.state() != QAbstractSocket::UnconnectedState) socket_.abort();
    done_ = false;
    socket_.connectToHost(host_, port_);
}

void TcpTransport::write(const QByteArray& bytes) {
    if (!done_) socket_.write(bytes);
}

void TcpTransport::close() {
    done_ = true;
    // disconnectFromHost 会先把缓冲里还没发出去的写完(撤订阅那一句)再断;不用 abort,那会把它们丢掉
    socket_.flush();
    socket_.disconnectFromHost();
}

void TcpTransport::finish(const QString& reason) {
    if (done_) return;
    done_ = true;
    emit closed(reason);
}

}  // namespace ibkr::tws
