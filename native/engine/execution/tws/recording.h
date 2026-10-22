// TWS 报文的录制与回放。
//
// 录:把一条连接上来回的字节原样按时刻记下来——每一次 socket 读到的那一块记一行(块的边界也留着,
// 分帧器要能吃半条消息),每一次写记一行。回放:按原来的先后把读到的那几块放回去,
// 原速(按录下来的间隔)或者不等;客户端写出去的字节逐块对着录下来的比,差一个字节就报。
//
// 文件是 JSON Lines(.twsrec),第一行是头,之后一行一条:
//   {"format":"ibkr-tws-recording","version":1,"started_at":"…","host":"127.0.0.1","port":7497,"client_id":9700,…}
//   {"t_us":1234,"wall_ms":1791500000123,"kind":"in","b64":"…"}
// t_us 是醒着的时间(util/awake_clock.h:睡眠里不走),wall_ms 是墙钟:两个都记,墙钟走了而 t_us 没走的那一段
// 就是电脑在睡,对得上 pmset 的日志;原速回放也按 t_us 等,合盖一夜不会让回放干等一夜。
//
// 录下来的报文含真实账号:只在本机看,不进仓库(.gitignore 挡着 *.twsrec)。测试用的是合成的。
#pragma once

#include "execution/tws/transport.h"

#include <QFile>
#include <QJsonObject>
#include <QList>
#include <QTimer>

#include <functional>

namespace ibkr::tws {

inline constexpr auto kRecordingFormat = "ibkr-tws-recording";
inline constexpr int kRecordingVersion = 1;

struct Record {
    enum class Kind { Open, Opened, Out, In, Close, Closed };
    qint64 tUs = 0;
    qint64 wallMs = 0;
    Kind kind = Kind::In;
    QByteArray bytes;
    /// closed 那一行:为什么断的
    QString reason;
};

struct Recording {
    QJsonObject header;
    QList<Record> records;
};

/// 读一份录像。格式不对返回空、error 里写原因(哪一行、什么不对)。
/// 一行一行地读(录一整天的文件可以很大):不整个读进内存再切,内存里只留解出来的记录。
std::optional<Recording> readRecording(const QString& path, QString* error);
std::optional<Recording> parseRecording(const QByteArray& text, QString* error);

QString kindName(Record::Kind kind);

class RecordingWriter {
public:
    /// 醒着的时间(微秒);测试换成假的
    using Clock = std::function<qint64()>;
    RecordingWriter();
    explicit RecordingWriter(Clock awakeMicros);

    /// 建文件、写头。header 里 format / version / started_at 由这里补
    bool open(const QString& path, QJsonObject header, QString* error);
    void write(Record::Kind kind, const QByteArray& bytes = {}, const QString& reason = {});
    void close();

private:
    QFile file_;
    Clock clock_;
    qint64 startUs_ = 0;
};

/// 套在任何一种 Transport 外面:来回的字节照常转,同时记进文件。
class RecordingTransport : public Transport {
    Q_OBJECT
public:
    RecordingTransport(Transport* inner, RecordingWriter* writer, QObject* parent = nullptr);

    void open() override;
    void write(const QByteArray& bytes) override;
    void close() override;

private:
    Transport* inner_;
    RecordingWriter* writer_;
};

/// 把一份录像当成 TWS 放回来。
///
/// 先后照录像:一块"读到的"要等它前面录下来的"写出去的"都被客户端写过了才放——客户端慢了不会收到还没问的回话。
/// speed = 1 按录下来的间隔等,0 不等(测试用),2 是两倍速。客户端写出去的字节接起来对着录下来的比,
/// 三种都算对不上、发 mismatch(只发第一次):写的和录的不一样;客户端自己关的时候,录像里关之前该写的没写完、
/// 或者多写了录像里没有的;录像放完了客户端还在写。录像放完或客户端关了发 finished。
class ReplayTransport : public Transport {
    Q_OBJECT
public:
    ReplayTransport(Recording recording, double speed, QObject* parent = nullptr);

    void open() override;
    void write(const QByteArray& bytes) override;
    void close() override;

    int mismatches() const { return mismatches_; }

signals:
    void mismatch(int recordIndex, const QByteArray& expected, const QByteArray& actual);
    void finished();

private:
    enum class State { Idle, Running, Ended, Closed };

    void step();
    void schedule(qint64 delayUs);
    /// 客户端关了:核对它关之前写的与录像里关之前录的是不是一样
    void settleOnClose();
    void reportMismatch(qsizetype recordIndex, const QByteArray& expected, const QByteArray& actual);
    void end();

    Recording recording_;
    double speed_;
    State state_ = State::Idle;
    qsizetype cursor_ = 0;
    /// 客户端写出来、还没对上录像的字节
    QByteArray written_;
    qint64 lastUs_ = 0;
    QTimer timer_;
    /// 游标那一条的间隔已经等过了
    bool waited_ = false;
    int mismatches_ = 0;
};

}  // namespace ibkr::tws
