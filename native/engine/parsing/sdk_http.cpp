#include "parsing/sdk_http.h"

#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsnum.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"

#include <QDateTime>
#include <QRegularExpression>
#include <QSslSocket>
#include <QTcpSocket>

#include <cctype>
#include <cmath>

using namespace Qt::StringLiterals;

namespace ibkr::parsing::sdk {

using util::OJson;
namespace js = util::js;

namespace {

Hooks& hooksRef() {
    static Hooks h;
    return h;
}

// 两个 SDK 的版本(请求头里带着;对拍夹具里记着)
const QString kAnthropicUserAgent = u"Anthropic/JS 0.128.0"_s;
const QString kOpenAIUserAgent = u"OpenAI/JS 7.23.0"_s;
// openai 7.23 在 undici 等头超时(UND_ERR_HEADERS_TIMEOUT)时换的那句话
const QString kUndiciHeadersTimeoutMessage =
    u"Request timed out. Node.js fetch timed out waiting for response headers; configure a matching undici fetch and fetchOptions.dispatcher with an Agent whose headersTimeout is at least the SDK timeout."_s;

double nowMs() {
    if (hooksRef().nowMs) return hooksRef().nowMs();
    return double(QDateTime::currentMSecsSinceEpoch());
}

double random01() {
    if (hooksRef().random) return hooksRef().random();
    return double(std::rand()) / (double(RAND_MAX) + 1.0);
}

util::Task<> sleepFor(double ms) {
    if (hooksRef().sleep) return hooksRef().sleep(ms);
    return util::sleepMs(nodeTimerMs(ms));
}

/// JSON.parse 成功就是值,失败是空(SDK 的 safeJSON)
std::optional<OJson> safeJSON(const QString& text) {
    return js::parse(text);
}

}  // namespace

void setHooks(Hooks h) { hooksRef() = std::move(h); }
const Hooks& hooks() { return hooksRef(); }

int nodeTimerMs(double ms) {
    if (!(ms >= 1 && ms <= 2147483647.0)) return 1;
    return int(std::floor(ms));
}

// ================================================================ Headers
void Headers::set(const QString& name, const QString& value) {
    attempts_.append({name, value});
    const QString key = name.toLower();
    for (auto& [k, v] : items_) {
        if (k == key) {
            v = value;
            return;
        }
    }
    items_.append({key, value});
}

void Headers::remove(const QString& name) {
    const QString key = name.toLower();
    items_.removeIf([&](const QPair<QString, QString>& p) { return p.first == key; });
}

std::optional<QString> Headers::get(const QString& name) const {
    const QString key = name.toLower();
    for (const auto& [k, v] : items_)
        if (k == key) return v;
    return std::nullopt;
}

// ================================================================ Exchange
QString fetchText(const QByteArray& bytes) {
    QString s = util::nodeUtf8(bytes);
    if (s.startsWith(QChar(0xFEFF))) s.remove(0, 1);
    return s;
}

namespace {

bool isTokenChar(char16_t c) {
    return (c >= u'0' && c <= u'9') || (c >= u'a' && c <= u'z') || (c >= u'A' && c <= u'Z') || QStringLiteral("!#$%&'*+-.^_`|~").contains(QChar(c));
}
bool isTokenBytes(const QByteArray& s) {
    if (s.isEmpty()) return false;
    for (const char c : s)
        if (!isTokenChar(char16_t(uchar(c)))) return false;
    return true;
}
/// llhttp 的头值字符:制表符、可见 ASCII、0x80 以上;别的控制符(含 NUL、DEL)当场拒
bool isHeaderValueByte(uchar c) { return c == '\t' || (c >= 0x20 && c <= 0x7e) || c >= 0x80; }
bool isOws(char c) { return c == ' ' || c == '\t'; }
QByteArray trimOws(QByteArray s) {
    while (!s.isEmpty() && isOws(s.front())) s.remove(0, 1);
    while (!s.isEmpty() && isOws(s.back())) s.chop(1);
    return s;
}
/// 第一个前面不是 CR 的 LF;没有是 -1
qsizetype loneLf(const QByteArray& s) {
    for (qsizetype i = 0; i < s.size(); ++i)
        if (s[i] == '\n' && (i == 0 || s[i - 1] != '\r')) return i;
    return -1;
}
bool allDigits(const QByteArray& s) {
    if (s.isEmpty()) return false;
    for (const char c : s)
        if (c < '0' || c > '9') return false;
    return true;
}

}  // namespace

QByteArray requestBytes(const QByteArray& method, const util::whatwg::Url& url, const Headers& headers, const QByteArray& body) {
    QByteArray req = method + ' ' + url.requestTarget().toLatin1() + " HTTP/1.1\r\n";
    // 调用方自己给了 host 就用它(undici 同);别的由 URL 定
    if (!headers.get(u"host"_s)) req += "host: " + url.host().toLatin1() + "\r\n";
    for (const auto& [k, v] : headers.items()) {
        // 自己给的 content-length / transfer-encoding / connection 不发:正文长度与连接方式由这里定(TS 里它们会让请求卡到超时)
        if (k == u"content-length" || k == u"transfer-encoding" || k == u"connection") continue;
        req += k.toLatin1() + ": " + v.toLatin1() + "\r\n";
    }
    return req + "content-length: " + QByteArray::number(body.size()) + "\r\nconnection: close\r\n\r\n" + body;
}

bool Exchange::peerAllowed(bool plainHttp, const QHostAddress& peer) { return !plainHttp || peer.isLoopback(); }

std::shared_ptr<Exchange> Exchange::start(const QByteArray& method, const util::whatwg::Url& url, const Headers& headers, const QByteArray& body) {
    // 最后一个引用放掉的时候:计时器停掉、套接字断开并摘掉信号(之后的 timeout / readyRead 里还会 shared_from_this(),引用已经没了就是 bad_weak_ptr),
    // 对象本身交给事件循环删(信号 / 计时器的处理函数里可能正放掉最后一个引用)
    std::shared_ptr<Exchange> ex(new Exchange, [](Exchange* e) {
        e->deadline_.stop();
        e->undiciHeaders_.stop();
        e->undiciBody_.stop();
        if (e->socket_) {
            disconnect(e->socket_, nullptr, e, nullptr);
            e->socket_->abort();
        }
        e->deleteLater();
    });
    Exchange* raw = ex.get();
    for (QTimer* t : {&raw->deadline_, &raw->undiciHeaders_, &raw->undiciBody_}) t->setSingleShot(true);
    connect(&raw->deadline_, &QTimer::timeout, raw, [raw] { raw->failWith(Fail::Deadline); });
    connect(&raw->undiciHeaders_, &QTimer::timeout, raw, [raw] {
        if (!raw->headersDone_) raw->failWith(Fail::UndiciHeaders);
    });
    connect(&raw->undiciBody_, &QTimer::timeout, raw, [raw] { raw->failWith(Fail::UndiciBody); });

    const bool tls = url.scheme == u"https";
    // 只认 http / https;明文 http 只许回环——判的是 URL 解析器给出的、真要拨的那个主机
    const bool refused = !url.isHttp() || url.hostname.isEmpty() || (!tls && !util::whatwg::isLoopbackHostname(url.hostname)) || (tls && !QSslSocket::supportsSsl());
    if (refused) {
        raw->settleHeaders(Fail::Network);
        raw->settleBody(Fail::Network);
        return ex;
    }
    // 保险:头名 / 头值 / 目标里要是还有 CR LF NUL,不发(上游的校验已经拦过,这是最后一道,防注入第二个头)
    const auto hasLineBreak = [](const QString& x) { return x.contains(u'\r') || x.contains(u'\n') || x.contains(QChar(0)); };
    bool clean = !hasLineBreak(url.requestTarget()) && !hasLineBreak(url.host());
    for (const auto& [k, v] : headers.items()) clean = clean && !hasLineBreak(k) && !hasLineBreak(v);
    if (!clean) {
        raw->settleHeaders(Fail::Network);
        raw->settleBody(Fail::Network);
        return ex;
    }
    raw->plainHttp_ = !tls;
    raw->request_ = requestBytes(method, url, headers, body);

    QTcpSocket* socket = tls ? new QSslSocket(raw) : new QTcpSocket(raw);
    raw->socket_ = socket;
    connect(socket, &QAbstractSocket::readyRead, raw, [raw] { raw->onReadyRead(); });
    connect(socket, &QAbstractSocket::disconnected, raw, [raw] { raw->onDisconnected(); });
    connect(socket, &QAbstractSocket::errorOccurred, raw, [raw] { raw->onSocketError(); });
    if (hooksRef().dialObserver) hooksRef().dialObserver(url.dialHost(), url.dialPort());
    if (tls) {
        auto* ssl = static_cast<QSslSocket*>(socket);
        connect(ssl, &QSslSocket::encrypted, raw, [raw] { raw->onConnected(); });
        ssl->connectToHostEncrypted(url.dialHost(), quint16(url.dialPort()));
    } else {
        connect(socket, &QAbstractSocket::connected, raw, [raw] { raw->onConnected(); });
        socket->connectToHost(url.dialHost(), quint16(url.dialPort()));
    }
    raw->undiciHeaders_.start(nodeTimerMs(hooksRef().undiciHeadersTimeoutMs));
    return ex;
}

Exchange::~Exchange() {
    if (socket_) {
        disconnect(socket_, nullptr, this, nullptr);
        socket_->abort();
    }
}

util::Task<Exchange::Fail> Exchange::headers() { return headersD_.task(); }
util::Task<std::pair<Exchange::Fail, QByteArray>> Exchange::body() { return bodyD_.task(); }

std::optional<QString> Exchange::header(const QString& name) const {
    const QByteArray key = name.toLatin1().toLower();
    QStringList values;
    for (const auto& [k, v] : responseHeaders_)
        if (k.toLower() == key) values << QString::fromLatin1(v);
    if (values.isEmpty()) return std::nullopt;
    return values.join(u", "_s);
}

void Exchange::startDeadline(double ms) { deadline_.start(nodeTimerMs(ms)); }
void Exchange::stopDeadline() { deadline_.stop(); }

void Exchange::cancel() {
    deadline_.stop();
    failWith(Fail::Network);
}

void Exchange::onConnected() {
    if (!socket_ || abortReason_ != Fail::None) return;
    // 连上之后再核对一次:明文 http 的对端必须真是回环地址(防的是名字解析把 localhost 之类指到别处)
    QHostAddress peer = socket_->peerAddress();
    if (hooksRef().peerAddressFilter) peer = hooksRef().peerAddressFilter(peer);
    if (!peerAllowed(plainHttp_, peer)) {
        failWith(Fail::Network);
        return;
    }
    socket_->write(request_);
}

void Exchange::onReadyRead() {
    if (!socket_ || abortReason_ != Fail::None) return;
    const auto self = shared_from_this();
    in_ += socket_->readAll();
    pump();
}

void Exchange::onDisconnected() {
    if (abortReason_ != Fail::None) return;
    const auto self = shared_from_this();
    if (socket_) in_ += socket_->readAll();
    pump();
    if (abortReason_ != Fail::None || bodyD_.settled()) return;
    if (!headersDone_) {
        failWith(Fail::Network);  // 一个头都没收全就断了:fetch failed
        return;
    }
    if (framing_ == Framing::UntilClose) settleBody(Fail::None);
    else failWith(Fail::Truncated);  // 正文没收全就断了:terminated
}

void Exchange::onSocketError() {
    if (abortReason_ != Fail::None || !socket_) return;
    if (socket_->error() == QAbstractSocket::RemoteHostClosedError) return;  // 交给 onDisconnected(读到关的正文靠它收尾)
    const auto self = shared_from_this();
    failWith(headersDone_ ? Fail::Truncated : Fail::Network);
}

/// 状态行与头照 llhttp 的严格程度读(undici 默认就是严格的):行尾只认 CRLF、头名必须是 token 且冒号紧跟、不认折行、
/// 值里不许控制符、Content-Length 只认纯数字且只许一个、Transfer-Encoding 与 Content-Length 不许同时出现、分块的每一块后面必须是 CRLF。
/// 头没收完就出错的:Network(fetch failed);头收完之后正文出错的:Truncated(terminated)
void Exchange::pump() {
    while (!headersDone_) {
        if (headersD_.settled()) return;
        if (const qsizetype lone = loneLf(in_); lone >= 0 && (in_.indexOf("\r\n") < 0 || lone < in_.indexOf("\r\n"))) {  // 没有 CR 的 LF
            failWith(Fail::Network);
            return;
        }
        const qsizetype crlf = in_.indexOf("\r\n");
        if (crlf < 0) {
            // 还没收到整行:行里已经有落单的 CR(后面跟的不是 LF)也是错
            const qsizetype cr = in_.indexOf('\r');
            if (cr >= 0 && cr + 1 < in_.size()) failWith(Fail::Network);
            return;
        }
        const QByteArray line = in_.left(crlf);
        in_.remove(0, crlf + 2);
        if (line.contains('\r') || line.contains('\n')) {
            failWith(Fail::Network);
            return;
        }
        if (!sawStatus_ && line.isEmpty()) continue;  // 状态行之前的空行:llhttp 跳过
        if (!sawStatus_) {
            // HTTP/版本 SP 三位状态码 [SP 原因]
            static const QRegularExpression statusLine(u"^HTTP/(?:0\\.9|1\\.0|1\\.1|2\\.0) ([0-9]{3})(?: (.*))?$"_s, QRegularExpression::DotMatchesEverythingOption);
            const auto m = statusLine.match(QString::fromLatin1(line));
            if (!m.hasMatch()) {
                failWith(Fail::Network);
                return;
            }
            for (const char c : line)
                if (!isHeaderValueByte(uchar(c))) {
                    failWith(Fail::Network);
                    return;
                }
            status_ = m.captured(1).toInt();
            if (status_ < 100) {
                failWith(Fail::Network);
                return;
            }
            sawStatus_ = true;
            responseHeaders_.clear();
            continue;
        }
        if (!line.isEmpty()) {
            if (isOws(line.front())) {  // 折行
                failWith(Fail::Network);
                return;
            }
            const qsizetype colon = line.indexOf(':');
            const QByteArray name = colon < 0 ? QByteArray() : line.left(colon);
            if (colon < 0 || !isTokenBytes(name)) {
                failWith(Fail::Network);
                return;
            }
            // Content-Length 的值只认前后的空格,制表符不认(undici 实测:`content-length:\t7` 是连接错);别的头两头的空格与制表符都去掉
            QByteArray value = line.mid(colon + 1);
            if (name.toLower() == "content-length") {
                while (!value.isEmpty() && value.front() == ' ') value.remove(0, 1);
                while (!value.isEmpty() && value.back() == ' ') value.chop(1);
            } else {
                value = trimOws(value);
            }
            for (const char c : value)
                if (!isHeaderValueByte(uchar(c))) {
                    failWith(Fail::Network);
                    return;
                }
            responseHeaders_.append({name, value});
            continue;
        }
        // 空行:一份回话的头收完了
        if (status_ >= 100 && status_ < 200) {
            if (status_ == 100 || status_ == 101) {  // 没要过 Expect / Upgrade:undici 当连接错
                failWith(Fail::Network);
                return;
            }
            sawStatus_ = false;  // 103 Early Hints 之类:跳过,等真的那一个
            continue;
        }
        int contentLengths = 0;
        QByteArray clValue;
        bool hasTe = false;
        QByteArray teLast;
        for (const auto& [k, v] : responseHeaders_) {
            const QByteArray lk = k.toLower();
            if (lk == "content-length") {
                ++contentLengths;
                clValue = v;
            } else if (lk == "transfer-encoding") {
                hasTe = true;
                const QList<QByteArray> parts = v.split(',');
                if (!parts.isEmpty()) teLast = trimOws(parts.last()).toLower();
            }
        }
        if (contentLengths > 1 || (contentLengths == 1 && hasTe)) {
            failWith(Fail::Network);
            return;
        }
        bool clOk = true;
        qint64 cl = 0;
        if (contentLengths == 1) {
            bool conv = false;
            cl = allDigits(clValue) ? clValue.toLongLong(&conv) : 0;
            clOk = conv;
        }
        if (!clOk) {
            failWith(Fail::Network);
            return;
        }
        headersDone_ = true;
        if (status_ == 204 || status_ == 304) {
            framing_ = Framing::None;
        } else if (hasTe && teLast == "chunked") {
            framing_ = Framing::Chunked;
            remaining_ = -1;
        } else if (contentLengths == 1) {
            framing_ = Framing::Length;
            remaining_ = cl;
        } else {
            framing_ = Framing::UntilClose;
        }
        undiciHeaders_.stop();
        undiciBody_.start(nodeTimerMs(hooksRef().undiciBodyTimeoutMs));
        settleHeaders(Fail::None);
        if (abortReason_ != Fail::None) return;  // 等头的人当场撂下了
        if (framing_ == Framing::None || (framing_ == Framing::Length && remaining_ <= 0)) {
            settleBody(Fail::None);
            return;
        }
    }
    if (bodyD_.settled() || in_.isEmpty()) return;
    undiciBody_.start(nodeTimerMs(hooksRef().undiciBodyTimeoutMs));
    switch (framing_) {
    case Framing::Length: {
        const qint64 take = std::min<qint64>(remaining_, in_.size());
        body_ += in_.left(take);
        in_.remove(0, take);
        remaining_ -= take;
        if (remaining_ <= 0) settleBody(Fail::None);
        return;
    }
    case Framing::UntilClose:
        body_ += in_;
        in_.clear();
        return;
    case Framing::Chunked:
        for (;;) {
            if (remaining_ == -2) {  // 一块之后必须是 CRLF
                if (in_.size() < 2) {
                    if (!in_.isEmpty() && in_[0] != '\r') failWith(Fail::Truncated);
                    return;
                }
                if (in_[0] != '\r' || in_[1] != '\n') {
                    failWith(Fail::Truncated);
                    return;
                }
                in_.remove(0, 2);
                remaining_ = -1;
            }
            if (remaining_ == -1) {
                const qsizetype nl = in_.indexOf("\r\n");
                if (const qsizetype lone = loneLf(in_); lone >= 0 && (nl < 0 || lone < nl)) {
                    failWith(Fail::Truncated);
                    return;
                }
                if (nl < 0) return;
                const QByteArray line = in_.left(nl);
                in_.remove(0, nl + 2);
                if (chunkTrailer_) {
                    if (line.isEmpty()) {
                        settleBody(Fail::None);
                        return;
                    }
                    const qsizetype colon = line.indexOf(':');
                    bool valid = colon > 0 && isTokenBytes(line.left(colon)) && !isOws(line.front());
                    for (const char c : line.mid(colon + 1)) valid = valid && isHeaderValueByte(uchar(c));
                    if (!valid) {
                        failWith(Fail::Truncated);
                        return;
                    }
                    continue;  // 尾部的头,不要
                }
                const QByteArray sizeToken = line.left(line.indexOf(';') < 0 ? line.size() : line.indexOf(';'));
                bool ok = !sizeToken.isEmpty();
                for (const char c : sizeToken) ok = ok && std::isxdigit(uchar(c)) != 0;
                qint64 size = 0;
                if (ok) {
                    bool conv = false;
                    size = sizeToken.toLongLong(&conv, 16);
                    ok = conv && size >= 0;
                }
                if (!ok) {
                    failWith(Fail::Truncated);
                    return;
                }
                if (size == 0) {
                    chunkTrailer_ = true;
                    continue;
                }
                remaining_ = size;
            }
            if (in_.isEmpty()) return;
            const qint64 take = std::min<qint64>(remaining_, in_.size());
            body_ += in_.left(take);
            in_.remove(0, take);
            remaining_ -= take;
            if (remaining_ > 0) return;
            remaining_ = -2;
        }
    case Framing::None:
        return;
    }
}

void Exchange::failWith(Fail why) {
    const auto self = shared_from_this();
    deadline_.stop();
    undiciHeaders_.stop();
    undiciBody_.stop();
    if (abortReason_ == Fail::None) abortReason_ = why;
    if (socket_) {
        disconnect(socket_, nullptr, this, nullptr);
        socket_->abort();
    }
    settleHeaders(abortReason_);
    settleBody(abortReason_);
}

void Exchange::settleHeaders(Fail why) {
    if (headersD_.settled()) return;
    headersDone_ = why == Fail::None;
    headersD_.resolve(why);
}

void Exchange::settleBody(Fail why) {
    if (bodyD_.settled()) return;
    deadline_.stop();
    undiciBody_.stop();
    if (why == Fail::None && socket_) {
        disconnect(socket_, nullptr, this, nullptr);
        socket_->abort();  // 正文收全了:这条连接不再用(发的是 connection: close)
    }
    bodyD_.resolve(std::pair<Fail, QByteArray>{why, why == Fail::None ? body_ : QByteArray()});
}

util::whatwg::Url joinUrl(const QString& baseURL, const QString& path) {
    const QString joined = baseURL + (baseURL.endsWith(u'/') && path.startsWith(u'/') ? path.mid(1) : path);
    auto url = util::whatwg::parse(joined);
    if (!url) throw NamedError(u"TypeError"_s, u"Invalid URL"_s);
    // buildURL:地址里自带的查询并进 query、再整个 stringify 回去(路径跟着进了查询)
    if (url->isHttp() && url->query) {
        const auto record = util::whatwg::searchParamsRecord(*url->query);
        if (!record.isEmpty()) util::whatwg::setSearch(*url, util::whatwg::stringifyQuery(record));
    }
    return *url;
}

namespace {
QString jsTrimHttpWhitespace(const QString& s) {
    qsizetype b = 0, e = s.size();
    const auto ws = [](QChar c) { return c == u'\t' || c == u'\n' || c == u'\r' || c == u' '; };
    while (b < e && ws(s[b])) ++b;
    while (e > b && ws(s[e - 1])) --e;
    return s.mid(b, e - b);
}
bool isTokenName(const QString& n) {
    if (n.isEmpty()) return false;
    for (const QChar c : n) {
        const char16_t u = c.unicode();
        if (!((u >= u'0' && u <= u'9') || (u >= u'a' && u <= u'z') || (u >= u'A' && u <= u'Z') || QStringLiteral("!#$%&'*+-.^_`|~").contains(c))) return false;
    }
    return true;
}
std::optional<QString> byteStringError(const QString& s) {
    for (qsizetype i = 0; i < s.size(); ++i)
        if (s[i].unicode() > 255)
            return u"Cannot convert argument to a ByteString because the character at index %1 has a value of %2 which is greater than 255."_s.arg(i).arg(int(s[i].unicode()));
    return std::nullopt;
}
}  // namespace

void validateHeaderAttempts(Flavor flavor, const Headers& headers) {
    QSet<QString> seen;
    for (const auto& [name, value] : headers.attempts()) {
        const QString lower = name.toLower();
        if (flavor == Flavor::OpenAI) {
            if (!isTokenName(name)) throw NamedError(u"TypeError"_s, u"Header name must be a valid HTTP token [\""_s + name + u"\"]"_s);
        } else {
            if (const auto e = byteStringError(name)) throw NamedError(u"TypeError"_s, *e);
            if (!isTokenName(name))
                throw NamedError(u"TypeError"_s, u"Headers."_s + (seen.contains(lower) ? u"append"_s : u"delete"_s) + u": \""_s + name + u"\" is an invalid header name."_s);
        }
        seen.insert(lower);
        if (const auto e = byteStringError(value)) throw NamedError(u"TypeError"_s, *e);
        const QString trimmed = jsTrimHttpWhitespace(value);
        if (trimmed.contains(QChar(0)) || trimmed.contains(u'\r') || trimmed.contains(u'\n'))
            throw NamedError(u"TypeError"_s, u"Headers.append: \""_s + value + u"\" is an invalid header value."_s);
    }
}

Headers finalizeHeaders(Flavor flavor, const Headers& headers) {
    validateHeaderAttempts(flavor, headers);
    Headers out;
    for (const auto& [k, v] : headers.items()) out.set(k, jsTrimHttpWhitespace(v));
    if (flavor == Flavor::Anthropic && out.get(u"x-api-key"_s).value_or(QString()).isEmpty() && out.get(u"authorization"_s).value_or(QString()).isEmpty())
        throw NamedError(u"Error"_s, u"Could not resolve authentication method. Expected one of apiKey, authToken, credentials, config, or profile to be set. Or for one of the \"X-Api-Key\" or \"Authorization\" headers to be explicitly omitted"_s);
    return out;
}

// ================================================================ 环境变量
std::optional<QString> readEnv(const char* name) {
    if (!qEnvironmentVariableIsSet(name)) return std::nullopt;
    const QString v = util::jsTrim(qEnvironmentVariable(name));
    if (v.isEmpty()) return std::nullopt;
    return v;
}

QList<QPair<QString, QString>> parseCustomHeaders(const QString& text) {
    QList<QPair<QString, QString>> out;
    for (const QString& line : text.split(u'\n')) {
        const qsizetype colon = line.indexOf(u':');
        if (colon >= 0) {
            const QString k = util::jsTrim(line.left(colon));
            const QString v = util::jsTrim(line.mid(colon + 1));
            // 对象字面量的赋值:同名的后写的覆盖、位置留在第一次
            bool found = false;
            for (auto& p : out)
                if (p.first == k) {
                    p.second = v;
                    found = true;
                }
            if (!found) out.append({k, v});
        }
    }
    return out;
}

// ================================================================ 错误
QString statusErrorName(int status) {
    switch (status) {
    case 400: return u"BadRequestError"_s;
    case 401: return u"AuthenticationError"_s;
    case 403: return u"PermissionDeniedError"_s;
    case 404: return u"NotFoundError"_s;
    case 409: return u"ConflictError"_s;
    case 422: return u"UnprocessableEntityError"_s;
    case 429: return u"RateLimitError"_s;
    default: break;
    }
    return status >= 500 ? u"InternalServerError"_s : u"APIError"_s;
}

QString makeMessage(std::optional<int> status, const OJson* error, const std::optional<QString>& message) {
    std::optional<QString> msg;
    const OJson* m = js::prop(error, u"message"_s);
    if (js::truthy(m)) msg = m->type == OJson::String ? m->s : js::stringify(*m);
    else if (js::truthy(error)) msg = js::stringify(*error);
    else msg = message;
    const bool hasMsg = msg && !msg->isEmpty();
    const bool hasStatus = status && *status != 0;
    if (hasStatus && hasMsg) return QString::number(*status) + u' ' + *msg;
    if (hasStatus) return QString::number(*status) + u" status code (no body)"_s;
    if (hasMsg) return *msg;
    return u"(no status code or body)"_s;
}

namespace {

SdkError makeStatusError(Flavor flavor, int status, const std::optional<OJson>& errJSON, const QString& errText) {
    const bool jsonTruthy = errJSON && js::truthy(&*errJSON);
    const std::optional<QString> errMessage = jsonTruthy ? std::nullopt : std::optional<QString>(errText);
    std::optional<OJson> error;
    if (flavor == Flavor::Anthropic) {
        error = errJSON;
    } else if (errJSON) {
        // makeStatusError 的规整:是对象(数组也算)且没有 error 键 → 包成 {error: …};然后取 .error
        if (jsonTruthy && js::isObjectLike(&*errJSON) && js::nullish(js::prop(&*errJSON, u"error"_s))) error = errJSON;
        else if (const OJson* inner = js::prop(&*errJSON, u"error"_s)) error = *inner;
    }
    const QString message = makeMessage(status, error ? &*error : nullptr, errMessage);
    return SdkError(statusErrorName(status), message, status, error);
}

bool shouldRetry(const Exchange& ex) {
    const auto h = ex.header(u"x-should-retry"_s);
    if (h == u"true"_s) return true;
    if (h == u"false"_s) return false;
    const int s = ex.status();
    return s == 408 || s == 409 || s == 429 || s >= 500;
}

/// retryRequest 的那一觉:先看 retry-after-ms、再看 retry-after(秒数或日期),不像话的退回默认退避
util::Task<> retrySleep(Flavor flavor, int maxRetries, int retriesRemaining, std::optional<QString> retryAfterMs, std::optional<QString> retryAfter) {
    const bool anth = flavor == Flavor::Anthropic;
    std::optional<double> t;
    if (retryAfterMs && !retryAfterMs->isEmpty()) {
        const double v = util::jsParseFloat(*retryAfterMs);
        if (!std::isnan(v)) t = v;
    }
    const bool consider = anth ? (!t || *t == 0) : !t;  // Anthropic 写的是 !timeoutMillis:0 也算没有
    if (retryAfter && !retryAfter->isEmpty() && consider) {
        const double secs = util::jsParseFloat(*retryAfter);
        if (!std::isnan(secs)) t = secs * 1000;
        else t = util::jsDateParse(*retryAfter) - nowMs();
    }
    bool useDefault;
    if (anth) useDefault = !t || !(*t > 0 && *t <= 2147483647.0);
    else useDefault = !t || !std::isfinite(*t) || *t < 0 || *t > 60 * 1000;
    if (useDefault) {
        const double numRetries = maxRetries - retriesRemaining;
        const double sleepSeconds = std::min(0.5 * util::jsmath::pow(2, numRetries), 8.0);
        const double jitter = 1 - random01() * 0.25;
        t = sleepSeconds * jitter * 1000;
    }
    co_await sleepFor(*t);
}

/// 一次请求要发的头,按 SDK 里 buildHeaders 的先后次序加(attempts 里的先后就是出错时「第一个坏的」的先后):
/// 先是认证(两边都是在拼数组之前就 await 了 authHeaders),再是固定的头、调用方的默认头(*_CUSTOM_HEADERS 与 User-Agent)、最后是正文的 content-type
Headers requestHeaders(const ClientOptions& o, int retryCount, std::optional<double> requestTimeoutMs) {
    Headers h;
    if (o.flavor == Flavor::Anthropic) {
        h.set(u"X-Api-Key"_s, o.apiKey);
        if (o.authToken) h.set(u"Authorization"_s, u"Bearer "_s + *o.authToken);
        h.set(u"Accept"_s, u"application/json"_s);
        h.set(u"User-Agent"_s, kAnthropicUserAgent);
        h.set(u"X-Stainless-Retry-Count"_s, QString::number(retryCount));
        // 看的是这一次请求的 timeout(messages.create 总给);OpenAI 那边 client.post 不给,于是不带这个头
        if (requestTimeoutMs && *requestTimeoutMs != 0 && !std::isnan(*requestTimeoutMs))
            h.set(u"X-Stainless-Timeout"_s, util::jsNumberToString(std::trunc(*requestTimeoutMs / 1000)));
        h.set(u"anthropic-version"_s, u"2023-06-01"_s);
    } else {
        h.set(u"Authorization"_s, u"Bearer "_s + o.apiKey);
        h.set(u"Accept"_s, u"application/json"_s);
        h.set(u"User-Agent"_s, kOpenAIUserAgent);
        h.set(u"X-Stainless-Retry-Count"_s, QString::number(retryCount));
        if (o.organization) h.set(u"OpenAI-Organization"_s, *o.organization);
        if (o.project) h.set(u"OpenAI-Project"_s, *o.project);
    }
    for (const auto& [k, v] : o.defaultHeaders.attempts()) h.set(k, v);
    h.set(u"content-type"_s, u"application/json"_s);
    return h;
}

/// undici 写头的时候的最后一道:值里只许制表符、可见 ASCII、0x80–0xFF,别的(DEL、其余控制符)它拒,fetch 以「连接错」收场(会重试)
bool headerBytesWritable(const Headers& h) {
    for (const auto& [k, v] : h.items())
        for (const QChar c : v) {
            const char16_t u = c.unicode();
            if (!(u == u'\t' || (u >= 0x20 && u <= 0x7e) || (u >= 0x80 && u <= 0xff))) return false;
        }
    return true;
}

/// defaultParseResponse(成功的回包):204 是 null;JSON 类型按 JSON 读(读坏了抛 SyntaxError),别的类型给原文
Body parseSuccess(Flavor flavor, const Exchange& ex, const QByteArray& bytes) {
    if (ex.status() == 204) return OJson::null();
    const auto contentType = ex.header(u"content-type"_s);
    std::optional<QString> mediaType;
    if (contentType) {
        mediaType = util::jsTrim(contentType->split(u';').first());
        if (flavor == Flavor::OpenAI) mediaType = mediaType->toLower();
    }
    const bool isJSON = mediaType && (mediaType->contains(u"application/json"_s) || mediaType->endsWith(u"+json"_s));
    if (isJSON) {
        if (ex.header(u"content-length"_s) == u"0"_s) return std::nullopt;
        const QString text = fetchText(bytes);
        if (flavor == Flavor::OpenAI && text.isEmpty()) return std::nullopt;
        try {
            return js::parseOrThrow(text);
        } catch (const util::JsError& e) {
            throw NamedError(u"SyntaxError"_s, e.message());
        }
    }
    return OJson::string(fetchText(bytes));
}

[[noreturn]] void throwTerminated() { throw NamedError(u"TypeError"_s, u"terminated"_s); }

/// 一次 client.post 的全过程(SDK 的 makeRequest + retryRequest + parseResponseWithTimeout)
util::Task<Body> postImpl(std::shared_ptr<const ClientOptions> o, QString path, OJson body, std::optional<double> requestTimeoutMs) {
    using Fail = Exchange::Fail;
    const bool anth = o->flavor == Flavor::Anthropic;
    const int maxRetries = o->maxRetries;
    int retriesRemaining = maxRetries;
    const QByteArray payload = util::toNodeUtf8(js::stringify(body));
    for (;;) {
        // buildRequest 的先后:先拼地址(Invalid URL),再查这一次的 timeout,再拼头(TypeError / 认证);这三样出错都不重试
        const util::whatwg::Url url = joinUrl(o->baseURL, path);
        if (requestTimeoutMs) {  // validatePositiveInteger('timeout', …):只有显式给了这一次的 timeout 才查
            const double t = *requestTimeoutMs;
            if (!(std::isfinite(t) && std::trunc(t) == t)) throw NamedError(u"AnthropicError"_s, u"timeout must be an integer"_s);
            if (t < 0) throw NamedError(u"AnthropicError"_s, u"timeout must be a positive integer"_s);
        }
        const double timeout = requestTimeoutMs.value_or(o->timeoutMs);
        const Headers headers = finalizeHeaders(o->flavor, requestHeaders(*o, maxRetries - retriesRemaining, requestTimeoutMs));
        const double startTime = double(QDateTime::currentMSecsSinceEpoch());
        // fetch 在发出第一个字节之前就会拒的:地址带用户名 / 密码(Request cannot be constructed from a URL that includes credentials)、
        // 不是 http(s)、头值里有写不出去的字符——都按"连不上"收场并重试;这里同样一个字节不发(Exchange 里另有明文只连回环的闸)
        const bool sendable = url.isHttp() && !url.hasCredentials() && headerBytesWritable(headers);
        // 测试用的出网闸(只放本机)只管真要拨出去的 https;明文 http 非回环的由 Exchange 里的闸拦(那也是 TS 里会去连的地址,测试里不许连)
        if (sendable && url.scheme == u"https" && hooksRef().allowUrl && !hooksRef().allowUrl(url)) throw NamedError(u"Error"_s, u"出网闸拒绝了 "_s + url.host());
        const std::shared_ptr<Exchange> ex = Exchange::start("POST", sendable ? url : util::whatwg::Url{}, headers, payload);
        if (hooksRef().timerArmed) hooksRef().timerArmed(timeout);
        ex->startDeadline(timeout);
        const Fail head = co_await ex->headers();
        if (head != Fail::None) {
            ex->cancel();
            if (retriesRemaining) {
                co_await retrySleep(o->flavor, maxRetries, retriesRemaining, std::nullopt, std::nullopt);
                --retriesRemaining;
                continue;
            }
            if (head == Fail::Deadline || head == Fail::UndiciHeaders) {
                if (!anth && head == Fail::UndiciHeaders) throw SdkError(u"APIConnectionTimeoutError"_s, kUndiciHeadersTimeoutMessage);
                throw SdkError(u"APIConnectionTimeoutError"_s, u"Request timed out."_s);
            }
            throw SdkError(u"APIConnectionError"_s, u"Connection error."_s);
        }
        ex->stopDeadline();  // 两边的 fetch 计时器都只管到头;OpenAI 正文的那只下面另起
        if (!ex->ok()) {
            const bool retry = shouldRetry(*ex);
            if (retriesRemaining && retry) {
                const auto ms = ex->header(u"retry-after-ms"_s), ra = ex->header(u"retry-after"_s);
                ex->cancel();
                co_await retrySleep(o->flavor, maxRetries, retriesRemaining, ms, ra);
                --retriesRemaining;
                continue;
            }
            // 重定向不跟(TS 的 fetch 会跟 301 / 302 / 303 / 307 / 308,并把头——含 Key——带到新地址):凭证不许转给别的地址,
            // 所以这里失败得明白一点,让人知道是被拦下了、去哪改地址
            if (const int st = ex->status(); st == 301 || st == 302 || st == 303 || st == 307 || st == 308) {
                const QString loc = ex->header(u"location"_s).value_or(QString()).left(200);
                ex->cancel();
                throw SdkError(u"APIError"_s, QString::number(st) + u" 端点要求重定向"_s + (loc.isEmpty() ? QString() : u"(Location: "_s + loc + u")"_s) +
                                                  u",出于安全不跟随:带凭证的请求不会被转到别的地址。请把 base_url 改成最终地址"_s,
                               st);
            }
            const auto [fail, bytes] = co_await ex->body();
            const QString errText = fail == Fail::None ? fetchText(bytes) : u"terminated"_s;  // text().catch(err => err.message)
            throw makeStatusError(o->flavor, ex->status(), safeJSON(errText), errText);
        }
        if (anth) {
            const auto [fail, bytes] = co_await ex->body();
            if (fail != Fail::None) throwTerminated();
            co_return parseSuccess(o->flavor, *ex, bytes);
        }
        // OpenAI:204 与 content-length: 0 不挂计时器;别的正文要在 startTime + timeout 之前读完,读不完按超时重试
        if (ex->status() == 204 || ex->header(u"content-length"_s) == u"0"_s) {
            const auto [fail, bytes] = co_await ex->body();
            if (fail != Fail::None) throwTerminated();
            co_return parseSuccess(o->flavor, *ex, bytes);
        }
        const double remaining = std::max(0.0, startTime + timeout - double(QDateTime::currentMSecsSinceEpoch()));
        ex->startDeadline(remaining);
        const auto [fail, bytes] = co_await ex->body();
        if (fail == Fail::Deadline) {
            if (!retriesRemaining) throw SdkError(u"APIConnectionTimeoutError"_s, u"Request timed out."_s);
            co_await retrySleep(o->flavor, maxRetries, retriesRemaining, std::nullopt, std::nullopt);
            --retriesRemaining;
            continue;
        }
        if (fail != Fail::None) throwTerminated();
        co_return parseSuccess(o->flavor, *ex, bytes);
    }
}

}  // namespace

Client::Client(ClientOptions options) : options_(std::make_shared<const ClientOptions>(std::move(options))) {}

util::Task<Body> Client::post(QString path, OJson body, std::optional<double> requestTimeoutMs) const {
    return postImpl(options_, std::move(path), std::move(body), requestTimeoutMs);
}

}  // namespace ibkr::parsing::sdk
