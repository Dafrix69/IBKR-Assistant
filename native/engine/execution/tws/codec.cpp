#include "execution/tws/codec.h"

#include "util/jsvalue.h"

#include "util/jsnum.h"

#include <QJsonDocument>
#include <QJsonValue>
#include <QtEndian>

#include <cmath>
#include <limits>

namespace ibkr::tws {

namespace {

/// 这一版起报错文字里的非 ASCII 字写成 \uXXXX
constexpr int kVerEncodeMsgAscii7 = 153;
/// 这一版起报错消息末尾多一格详细的拒单原因
constexpr int kVerAdvancedOrderReject = 166;

constexpr double kMaxDouble = std::numeric_limits<double>::max();
constexpr double kInf = std::numeric_limits<double>::infinity();

QByteArray be32(quint32 value) {
    QByteArray out(4, '\0');
    qToBigEndian(value, out.data());
    return out;
}

/// 按位置读字段,读法逐个照 @stoqey/ib 的 readStr / readInt / readDouble / readDecimal。
/// 读过了头不抛:记一笔 underrun,这一条整个不采用(库在这时也什么都不发)。
class Reader {
public:
    explicit Reader(const QStringList& fields) : fields_(fields) {}

    QString str() {
        if (at_ >= fields_.size()) {
            underrun = true;
            return {};
        }
        return fields_[at_++];
    }
    /// 空串是 0,其余按 parseInt(token, 10)
    double integer() {
        const QString token = str();
        return token.isEmpty() ? 0.0 : util::jsParseInt(token);
    }
    /// 空串是 0;MAX_VALUE 是"没有"(TWS 用它表示不适用)
    std::optional<double> real() {
        const QString token = str();
        if (token.isEmpty()) return 0.0;
        const double value = util::jsParseFloat(token);
        if (value == kMaxDouble) return std::nullopt;
        return value;
    }
    /// 空串、MAX_VALUE、+Infinity 都是"没有";千分位的逗号去掉再读
    std::optional<double> decimal() {
        QString token = str();
        if (token.isEmpty()) return std::nullopt;
        const double value = util::jsParseFloat(token.remove(u','));
        if (value == kMaxDouble || value == kInf) return std::nullopt;
        return value;
    }
    bool remaining() const { return at_ < fields_.size(); }

    bool underrun = false;

private:
    const QStringList& fields_;
    qsizetype at_ = 0;
};

ErrorMessage decodeError(Reader& r, int serverVersion) {
    ErrorMessage e;
    const double version = r.integer();
    if (version < 2) {
        e.message = r.str();
        e.code = kUnknownIdCode;
        return e;
    }
    e.reqId = r.integer();
    e.code = r.integer();
    e.message = r.str();
    if (serverVersion >= kVerEncodeMsgAscii7) e.message = decodeUnicodeEscapes(e.message);
    if (serverVersion >= kVerAdvancedOrderReject) {
        const QString json = r.str();
        if (!json.isEmpty()) {
            const QJsonDocument doc = QJsonDocument::fromJson(decodeUnicodeEscapes(json).toUtf8());
            if (doc.isObject()) e.advancedOrderReject = doc.object();
        }
    }
    e.info = e.reqId == static_cast<double>(kNoValidId);
    return e;
}

Position decodePosition(Reader& r) {
    Position p;
    const double version = r.integer();
    p.account = r.str();
    Contract& c = p.contract;
    c.conId = r.integer();
    c.symbol = r.str();
    c.secType = r.str();
    c.lastTradeDateOrContractMonth = r.str();
    c.strike = r.real();
    const QString right = r.str();
    if (right == u"C" || right == u"P") c.right = right;
    c.multiplier = r.real();
    c.exchange = r.str();
    c.currency = r.str();
    c.localSymbol = r.str();
    if (version >= 2) c.tradingClass = r.str();
    p.pos = r.decimal();
    p.avgCost = 0.0;
    if (version >= 3) p.avgCost = r.real();
    return p;
}

QJsonValue jsonNumber(double value) {
    return std::isfinite(value) ? QJsonValue(value) : QJsonValue(QJsonValue::Null);
}

}  // namespace

QByteArray handshake(int minVersion, int maxVersion) {
    QByteArray versions = "v" + QByteArray::number(minVersion);
    if (minVersion < maxVersion) versions += ".." + QByteArray::number(maxVersion);
    return QByteArray("API", 3) + '\0' + be32(static_cast<quint32>(versions.size())) + versions;
}

QByteArray frame(const QStringList& fields) {
    QByteArray payload;
    for (const QString& field : fields) {
        payload += field.toUtf8();
        payload += '\0';
    }
    return be32(static_cast<quint32>(payload.size())) + payload;
}

QByteArray startApi(int clientId) {
    return frame({QString::number(out::kStartApi), QStringLiteral("2"), QString::number(clientId), QString()});
}

QByteArray reqPositions() { return frame({QString::number(out::kReqPositions), QStringLiteral("1")}); }

QByteArray cancelPositions() { return frame({QString::number(out::kCancelPositions), QStringLiteral("1")}); }

QByteArray reqCurrentTime() { return frame({QString::number(out::kReqCurrentTime), QStringLiteral("1")}); }

SplitResult splitFrames(QByteArrayView buffer) {
    SplitResult result;
    qsizetype at = 0;
    while (buffer.size() - at >= 4) {
        const quint32 size = qFromBigEndian<quint32>(buffer.data() + at);
        if (size > kFrameMax) {
            result.badSize = size;
            return result;
        }
        if (buffer.size() - at - 4 < static_cast<qsizetype>(size)) break;
        QStringList fields = util::nodeUtf8(buffer.sliced(at + 4, size).toByteArray()).split(QChar(u'\0'));
        if (!fields.isEmpty() && fields.last().isEmpty()) fields.removeLast();
        result.frames.append(fields);
        at += 4 + static_cast<qsizetype>(size);
    }
    result.consumed = at;
    return result;
}

ServerVersion decodeServerVersion(const QStringList& fields) {
    ServerVersion v;
    v.version = util::jsParseInt(fields.value(0));
    v.connectionTime = fields.value(1);
    return v;
}

Message decode(const QStringList& fields, int serverVersion) {
    Message m;
    Reader r(fields);
    m.id = r.integer();
    if (m.id == in::kErrMsg) {
        m.body = decodeError(r, serverVersion);
    } else if (m.id == in::kPosition) {
        m.body = decodePosition(r);
    } else if (m.id == in::kPositionEnd) {
        r.integer();  // 版本
        m.body = PositionEnd{};
    } else if (m.id == in::kNextValidId) {
        r.integer();  // 版本
        m.body = NextValidId{r.integer()};
    } else if (m.id == in::kManagedAccts) {
        r.integer();  // 版本
        m.body = ManagedAccounts{r.str()};
    } else if (m.id == in::kCurrentTime) {
        r.integer();  // 版本
        m.body = CurrentTime{r.integer()};
    } else {
        m.unknown = true;
    }
    if (r.underrun) {
        m.underrun = true;
        m.body = std::monostate{};
    } else {
        m.leftover = r.remaining();
    }
    return m;
}

QString decodeUnicodeEscapes(QString text) {
    for (;;) {
        const qsizetype at = text.indexOf(u"\\u");
        if (at == -1 || text.size() - at < 6) break;
        // 读不出的十六进制换成 U+0000,和 String.fromCharCode(NaN) 一样;负数与超范围的照 ToUint16 取低 16 位
        const double hex = util::jsParseInt(QStringView(text).sliced(at + 2, 4), 16);
        const auto unit = std::isnan(hex) ? char16_t{0} : static_cast<char16_t>(static_cast<qint64>(hex) & 0xFFFF);
        text.replace(at, 6, QChar(unit));
    }
    return text;
}

QJsonObject contractToJson(const Contract& c) {
    QJsonObject o;
    o.insert(u"conId", jsonNumber(c.conId));
    o.insert(u"symbol", c.symbol);
    o.insert(u"secType", c.secType);
    o.insert(u"lastTradeDateOrContractMonth", c.lastTradeDateOrContractMonth);
    if (c.strike) o.insert(u"strike", jsonNumber(*c.strike));
    if (c.right) o.insert(u"right", *c.right);
    if (c.multiplier) o.insert(u"multiplier", jsonNumber(*c.multiplier));
    o.insert(u"exchange", c.exchange);
    o.insert(u"currency", c.currency);
    o.insert(u"localSymbol", c.localSymbol);
    if (c.tradingClass) o.insert(u"tradingClass", *c.tradingClass);
    return o;
}

}  // namespace ibkr::tws
