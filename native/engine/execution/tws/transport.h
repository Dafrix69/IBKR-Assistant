// 收发字节的那一层。客户端(client.h)只认这个接口,所以下面三种可以互换:
//   TcpTransport        真连 TWS(QTcpSocket,在调用方的线程里收发,不另起读线程)
//   RecordingTransport  套在任何一种外面,把来回的字节按时刻录进文件(recording.h)
//   ReplayTransport     把录下来的报文按原来的先后(与时刻,或加速)放回来(recording.h)
#pragma once

#include <QByteArray>
#include <QObject>
#include <QString>
#include <QTcpSocket>

namespace ibkr::tws {

class Transport : public QObject {
    Q_OBJECT
public:
    using QObject::QObject;
    ~Transport() override = default;

    virtual void open() = 0;
    virtual void write(const QByteArray& bytes) = 0;
    /// 自己关:之后不再发任何信号(不算"对方关了")
    virtual void close() = 0;

signals:
    void opened();
    void received(const QByteArray& chunk);
    /// 连不上、对方关了、出错。只发一次;reason 是一句人话
    void closed(const QString& reason);
};

class TcpTransport : public Transport {
    Q_OBJECT
public:
    TcpTransport(QString host, quint16 port, QObject* parent = nullptr);

    void open() override;
    void write(const QByteArray& bytes) override;
    void close() override;

private:
    void finish(const QString& reason);

    QString host_;
    quint16 port_;
    QTcpSocket socket_;
    bool done_ = false;
};

}  // namespace ibkr::tws
