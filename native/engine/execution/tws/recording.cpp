#include "execution/tws/recording.h"

#include "util/awake_clock.h"

#include <QDateTime>
#include <QJsonDocument>

#include <algorithm>
#include <limits>

namespace ibkr::tws {

namespace {

struct KindName {
    Record::Kind kind;
    const char16_t* name;
};
constexpr KindName kKinds[] = {
    {Record::Kind::Open, u"open"},     {Record::Kind::Opened, u"opened"}, {Record::Kind::Out, u"out"},
    {Record::Kind::In, u"in"},         {Record::Kind::Close, u"close"},   {Record::Kind::Closed, u"closed"},
};

std::optional<Record::Kind> kindFromName(const QString& name) {
    for (const KindName& k : kKinds)
        if (name == QStringView(k.name)) return k.kind;
    return std::nullopt;
}

}  // namespace

QString kindName(Record::Kind kind) {
    for (const KindName& k : kKinds)
        if (k.kind == kind) return QString::fromUtf16(k.name);
    return {};
}

namespace {

/// 一行一行地喂;第一行是头。出错时 error 里写哪一行、什么不对
class RecordingParser {
public:
    bool feed(QByteArrayView raw, int lineNo, QString* error) {
        const QByteArrayView line = raw.trimmed();
        if (line.isEmpty()) return true;
        QJsonParseError parseError{};
        const QJsonDocument doc = QJsonDocument::fromJson(line.toByteArray(), &parseError);
        if (!doc.isObject()) {
            if (error) *error = QStringLiteral("第 %1 行不是 JSON 对象:%2").arg(lineNo).arg(parseError.errorString());
            return false;
        }
        const QJsonObject o = doc.object();
        if (!haveHeader_) {
            if (o.value(u"format").toString() != QLatin1StringView(kRecordingFormat) || o.value(u"version").toInt() != kRecordingVersion) {
                if (error) *error = QStringLiteral("第 1 行不是录像的头(要 format = %1、version = %2)").arg(QLatin1StringView(kRecordingFormat)).arg(kRecordingVersion);
                return false;
            }
            rec_.header = o;
            haveHeader_ = true;
            return true;
        }
        const auto kind = kindFromName(o.value(u"kind").toString());
        if (!kind) {
            if (error) *error = QStringLiteral("第 %1 行的 kind 认不出:%2").arg(lineNo).arg(o.value(u"kind").toString());
            return false;
        }
        Record r;
        r.kind = *kind;
        r.tUs = o.value(u"t_us").toInteger();
        r.wallMs = o.value(u"wall_ms").toInteger();
        r.bytes = QByteArray::fromBase64(o.value(u"b64").toString().toLatin1());
        r.reason = o.value(u"reason").toString();
        rec_.records.append(std::move(r));
        return true;
    }

    std::optional<Recording> finish(QString* error) {
        if (!haveHeader_) {
            if (error) *error = QStringLiteral("文件是空的");
            return std::nullopt;
        }
        return std::move(rec_);
    }

private:
    Recording rec_;
    bool haveHeader_ = false;
};

}  // namespace

std::optional<Recording> parseRecording(const QByteArray& text, QString* error) {
    RecordingParser parser;
    int lineNo = 0;
    for (qsizetype at = 0; at <= text.size();) {
        qsizetype nl = text.indexOf('\n', at);
        if (nl < 0) nl = text.size();
        if (!parser.feed(QByteArrayView(text).sliced(at, nl - at), ++lineNo, error)) return std::nullopt;
        at = nl + 1;
    }
    return parser.finish(error);
}

std::optional<Recording> readRecording(const QString& path, QString* error) {
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) {
        if (error) *error = QStringLiteral("打不开 %1:%2").arg(path, file.errorString());
        return std::nullopt;
    }
    RecordingParser parser;
    int lineNo = 0;
    while (!file.atEnd()) {
        if (!parser.feed(file.readLine(), ++lineNo, error)) return std::nullopt;
    }
    return parser.finish(error);
}

RecordingWriter::RecordingWriter() : RecordingWriter(util::awakeMicros) {}

RecordingWriter::RecordingWriter(Clock awakeMicros) : clock_(std::move(awakeMicros)) {}

bool RecordingWriter::open(const QString& path, QJsonObject header, QString* error) {
    file_.setFileName(path);
    if (!file_.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
        if (error) *error = QStringLiteral("写不了 %1:%2").arg(path, file_.errorString());
        return false;
    }
    header.insert(u"format", QLatin1StringView(kRecordingFormat));
    header.insert(u"version", kRecordingVersion);
    // 带上本地的 UTC 偏移(+08:00),和 pmset 的日志对时用
    const QDateTime now = QDateTime::currentDateTime();
    header.insert(u"started_at", now.toOffsetFromUtc(now.offsetFromUtc()).toString(Qt::ISODateWithMs));
    file_.write(QJsonDocument(header).toJson(QJsonDocument::Compact) + '\n');
    file_.flush();
    startUs_ = clock_();
    return true;
}

void RecordingWriter::write(Record::Kind kind, const QByteArray& bytes, const QString& reason) {
    if (!file_.isOpen()) return;
    QJsonObject o;
    o.insert(u"t_us", clock_() - startUs_);
    o.insert(u"wall_ms", QDateTime::currentMSecsSinceEpoch());
    o.insert(u"kind", kindName(kind));
    if (kind == Record::Kind::In || kind == Record::Kind::Out) o.insert(u"b64", QString::fromLatin1(bytes.toBase64()));
    if (!reason.isEmpty()) o.insert(u"reason", reason);
    // 一行一冲:进程半路崩了,录到的那一截也还在
    file_.write(QJsonDocument(o).toJson(QJsonDocument::Compact) + '\n');
    file_.flush();
}

void RecordingWriter::close() { file_.close(); }

RecordingTransport::RecordingTransport(Transport* inner, RecordingWriter* writer, QObject* parent)
    : Transport(parent), inner_(inner), writer_(writer) {
    connect(inner_, &Transport::opened, this, [this] {
        writer_->write(Record::Kind::Opened);
        emit opened();
    });
    connect(inner_, &Transport::received, this, [this](const QByteArray& chunk) {
        writer_->write(Record::Kind::In, chunk);
        emit received(chunk);
    });
    connect(inner_, &Transport::closed, this, [this](const QString& reason) {
        writer_->write(Record::Kind::Closed, {}, reason);
        emit closed(reason);
    });
}

void RecordingTransport::open() {
    writer_->write(Record::Kind::Open);
    inner_->open();
}

void RecordingTransport::write(const QByteArray& bytes) {
    writer_->write(Record::Kind::Out, bytes);
    inner_->write(bytes);
}

void RecordingTransport::close() {
    writer_->write(Record::Kind::Close);
    inner_->close();
}

ReplayTransport::ReplayTransport(Recording recording, double speed, QObject* parent)
    : Transport(parent), recording_(std::move(recording)), speed_(speed) {
    timer_.setSingleShot(true);
    timer_.setTimerType(Qt::PreciseTimer);
    connect(&timer_, &QTimer::timeout, this, &ReplayTransport::step);
}

void ReplayTransport::open() {
    state_ = State::Running;
    cursor_ = 0;
    written_.clear();
    waited_ = false;
    mismatches_ = 0;
    lastUs_ = recording_.records.isEmpty() ? 0 : recording_.records.first().tUs;
    schedule(0);
}

void ReplayTransport::write(const QByteArray& bytes) {
    if (state_ == State::Ended) {
        // 录像放完了(录的那一趟到这里就没再写过),客户端还在写
        reportMismatch(recording_.records.size(), {}, bytes);
        return;
    }
    if (state_ != State::Running) return;
    written_ += bytes;
    // 不在这里接着放:客户端此刻多半正在处理上一块回话,等它返回再说
    if (!timer_.isActive()) schedule(0);
}

void ReplayTransport::close() {
    timer_.stop();
    const bool wasRunning = state_ == State::Running;
    state_ = State::Closed;
    if (!wasRunning) return;
    settleOnClose();
    emit finished();
}

void ReplayTransport::schedule(qint64 delayUs) {
    timer_.start(static_cast<int>(std::clamp<qint64>(delayUs / 1000, 0, std::numeric_limits<int>::max())));
}

void ReplayTransport::reportMismatch(qsizetype recordIndex, const QByteArray& expected, const QByteArray& actual) {
    if (mismatches_++ == 0) emit mismatch(static_cast<int>(recordIndex), expected, actual);
}

void ReplayTransport::settleOnClose() {
    // 录的那一趟在客户端关之前写过的,这一趟也得写过;这一趟写的,录像里也得有。
    // 之后 TWS 又送来的(读到的那几行)跳过:客户端已经关了,不看了
    for (qsizetype i = cursor_; i < recording_.records.size(); ++i) {
        const Record& r = std::as_const(recording_.records)[i];
        if (r.kind == Record::Kind::Close) break;
        if (r.kind != Record::Kind::Out) continue;
        if (!written_.startsWith(r.bytes)) return reportMismatch(i, r.bytes, written_);
        written_.remove(0, r.bytes.size());
    }
    if (!written_.isEmpty()) reportMismatch(recording_.records.size(), {}, written_);
}

void ReplayTransport::end() {
    if (!written_.isEmpty()) reportMismatch(recording_.records.size(), {}, written_);
    state_ = State::Ended;
    emit finished();
}

void ReplayTransport::step() {
    while (state_ == State::Running && cursor_ < recording_.records.size()) {
        const Record& r = std::as_const(recording_.records)[cursor_];
        if (r.kind == Record::Kind::Open || r.kind == Record::Kind::Close) {
            // 客户端自己的动作,只是记录
            lastUs_ = r.tUs;
            ++cursor_;
            continue;
        }
        if (r.kind == Record::Kind::Out) {
            if (written_.startsWith(r.bytes)) {
                written_.remove(0, r.bytes.size());
                lastUs_ = r.tUs;
                ++cursor_;
                continue;
            }
            if (r.bytes.startsWith(written_)) return;  // 还没写够,等下一次 write
            reportMismatch(cursor_, r.bytes, written_);
            state_ = State::Closed;
            emit closed(QStringLiteral("回放:第 %1 条录像是写出去的,客户端写的不一样").arg(cursor_ + 1));
            emit finished();
            return;
        }
        // 读到的、连上、被断:按录下来的间隔等(第一次走到这里时开始等,等完再来)
        const qint64 due = static_cast<qint64>(static_cast<double>(r.tUs - lastUs_) * speed_);
        if (due > 0 && !waited_) {
            waited_ = true;
            schedule(due);
            return;
        }
        waited_ = false;
        lastUs_ = r.tUs;
        ++cursor_;
        if (r.kind == Record::Kind::Opened) emit opened();
        else if (r.kind == Record::Kind::In) emit received(r.bytes);
        else emit closed(r.reason.isEmpty() ? QStringLiteral("录像里 TWS 关了连接") : r.reason);
    }
    if (state_ == State::Running && cursor_ >= recording_.records.size()) end();
}

}  // namespace ibkr::tws
