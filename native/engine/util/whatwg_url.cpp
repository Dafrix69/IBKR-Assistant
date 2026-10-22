#include "util/whatwg_url.h"

#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/ordered_json.h"

#include <QList>
#include <QRegularExpression>
#include <QStringList>
#include <QUrl>

#include <algorithm>
#include <array>
#include <cmath>

using namespace Qt::StringLiterals;

namespace ibkr::util::whatwg {

namespace {

// ---------------------------------------------------------------- 码点与编码
bool isAsciiDigit(char32_t c) { return c >= '0' && c <= '9'; }
bool isAsciiHex(char32_t c) { return isAsciiDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'); }
int hexValue(char32_t c) { return isAsciiDigit(c) ? int(c - '0') : (c >= 'a' && c <= 'f') ? int(c - 'a' + 10) : int(c - 'A' + 10); }
bool isAsciiAlpha(char32_t c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }

/// UTF-16 → 码点;落单的代理项是 U+FFFD(WHATWG 的 USVString 转换)
QList<char32_t> codePoints(QStringView s) {
    QList<char32_t> out;
    for (qsizetype i = 0; i < s.size(); ++i) {
        const char16_t u = s[i].unicode();
        if (QChar::isHighSurrogate(u) && i + 1 < s.size() && QChar::isLowSurrogate(s[i + 1].unicode())) {
            out.append(QChar::surrogateToUcs4(u, s[i + 1].unicode()));
            ++i;
        } else if (QChar::isSurrogate(u)) {
            out.append(0xFFFD);
        } else {
            out.append(u);
        }
    }
    return out;
}

QByteArray utf8Of(char32_t cp) {
    QByteArray b;
    if (cp < 0x80) b.append(char(cp));
    else if (cp < 0x800) {
        b.append(char(0xC0 | (cp >> 6)));
        b.append(char(0x80 | (cp & 0x3F)));
    } else if (cp < 0x10000) {
        b.append(char(0xE0 | (cp >> 12)));
        b.append(char(0x80 | ((cp >> 6) & 0x3F)));
        b.append(char(0x80 | (cp & 0x3F)));
    } else {
        b.append(char(0xF0 | (cp >> 18)));
        b.append(char(0x80 | ((cp >> 12) & 0x3F)));
        b.append(char(0x80 | ((cp >> 6) & 0x3F)));
        b.append(char(0x80 | (cp & 0x3F)));
    }
    return b;
}

// 百分号编码集合(URL 标准的名字)
bool inC0Control(char32_t c) { return c <= 0x1F || c > 0x7E; }
bool inFragmentSet(char32_t c) { return inC0Control(c) || c == ' ' || c == '"' || c == '<' || c == '>' || c == '`'; }
bool inQuerySet(char32_t c) { return inC0Control(c) || c == ' ' || c == '"' || c == '#' || c == '<' || c == '>'; }
bool inSpecialQuerySet(char32_t c) { return inQuerySet(c) || c == '\''; }
bool inPathSet(char32_t c) { return inQuerySet(c) || c == '?' || c == '^' || c == '`' || c == '{' || c == '}'; }
bool inUserinfoSet(char32_t c) { return inPathSet(c) || c == '/' || c == ':' || c == ';' || c == '=' || c == '@' || (c >= '[' && c <= ']') || c == '|'; }

template <class Set>
QString percentEncode(QStringView s, Set inSet) {
    QString out;
    for (const char32_t cp : codePoints(s)) {
        if (cp < 0x80 && !inSet(cp)) {
            out.append(QChar(char16_t(cp)));
            continue;
        }
        for (const char b : utf8Of(cp)) out.append(u'%' + QString::number(uchar(b), 16).rightJustified(2, u'0').toUpper());
    }
    return out;
}

/// 百分号解码成字节,再按 WHATWG 的 UTF-8 解码(不合法的字节换成 U+FFFD;开头的 BOM 留着)
QString percentDecodeUtf8(QStringView s) {
    const QByteArray raw = s.toUtf8();
    QByteArray bytes;
    for (qsizetype i = 0; i < raw.size(); ++i) {
        if (raw[i] == '%' && i + 2 < raw.size() && isAsciiHex(uchar(raw[i + 1])) && isAsciiHex(uchar(raw[i + 2]))) {
            bytes.append(char(hexValue(uchar(raw[i + 1])) * 16 + hexValue(uchar(raw[i + 2]))));
            i += 2;
        } else {
            bytes.append(raw[i]);
        }
    }
    return util::nodeUtf8(bytes);
}

// ---------------------------------------------------------------- 主机
bool forbiddenHostCodePoint(char32_t c) {
    switch (c) {
    case 0: case '\t': case '\n': case '\r': case ' ': case '#': case '/': case ':': case '<': case '>': case '?': case '@': case '[': case '\\':
    case ']': case '^': case '|':
        return true;
    default:
        return false;
    }
}
bool forbiddenDomainCodePoint(char32_t c) { return forbiddenHostCodePoint(c) || c <= 0x1F || c == '%' || c == 0x7F; }

/// WHATWG 的 IPv4 数字:0x 开头十六进制、0 开头八进制;空串失败。值可能很大(用 double,够比较大小)
std::optional<double> ipv4Number(QString s) {
    if (s.isEmpty()) return std::nullopt;
    int radix = 10;
    if (s.size() >= 2 && (s.startsWith(u"0x"_s) || s.startsWith(u"0X"_s))) {
        s = s.mid(2);
        radix = 16;
    } else if (s.size() >= 2 && s[0] == u'0') {
        s = s.mid(1);
        radix = 8;
    }
    if (s.isEmpty()) return 0.0;
    double n = 0;
    for (QChar ch : s) {
        const char32_t c = ch.unicode();
        int d;
        if (isAsciiDigit(c)) d = int(c - '0');
        else if (radix == 16 && isAsciiHex(c)) d = hexValue(c);
        else return std::nullopt;
        if (d >= radix) return std::nullopt;
        n = n * radix + d;
    }
    return n;
}

bool endsInNumber(const QString& host) {
    QStringList parts = host.split(u'.');
    if (parts.last().isEmpty()) {
        if (parts.size() == 1) return false;
        parts.removeLast();
    }
    const QString last = parts.last();
    if (!last.isEmpty()) {
        bool digits = true;
        for (QChar c : last)
            if (!isAsciiDigit(c.unicode())) digits = false;
        if (digits) return true;
    }
    return ipv4Number(last).has_value();
}

std::optional<QString> parseIpv4(const QString& host) {
    QStringList parts = host.split(u'.');
    if (parts.last().isEmpty() && parts.size() > 1) parts.removeLast();
    if (parts.size() > 4) return std::nullopt;
    QList<double> nums;
    for (const QString& p : parts) {
        const auto n = ipv4Number(p);
        if (!n) return std::nullopt;
        nums << *n;
    }
    for (qsizetype i = 0; i + 1 < nums.size(); ++i)
        if (nums[i] > 255) return std::nullopt;
    if (nums.last() >= std::pow(256.0, double(5 - nums.size()))) return std::nullopt;
    double ipv4 = nums.last();
    for (qsizetype i = 0; i + 1 < nums.size(); ++i) ipv4 += nums[i] * std::pow(256.0, double(3 - i));
    const auto v = quint32(ipv4);
    return u"%1.%2.%3.%4"_s.arg(v >> 24).arg((v >> 16) & 255).arg((v >> 8) & 255).arg(v & 255);
}

/// IPv6 解析(标准的算法逐步搬)与序列化(压缩第一段最长的零)
std::optional<QString> parseIpv6(const QString& input) {
    std::array<quint32, 8> address{};
    int pieceIndex = 0;
    int compress = -1;
    qsizetype p = 0;
    const auto c = [&]() -> int { return p < input.size() ? int(input[p].unicode()) : -1; };
    const auto at = [&](qsizetype i) -> int { return i < input.size() ? int(input[i].unicode()) : -1; };
    if (c() == ':') {
        if (at(p + 1) != ':') return std::nullopt;
        p += 2;
        ++pieceIndex;
        compress = pieceIndex;
    }
    while (c() != -1) {
        if (pieceIndex == 8) return std::nullopt;
        if (c() == ':') {
            if (compress != -1) return std::nullopt;
            ++p;
            ++pieceIndex;
            compress = pieceIndex;
            continue;
        }
        quint32 value = 0;
        int length = 0;
        while (length < 4 && c() != -1 && isAsciiHex(char32_t(c()))) {
            value = value * 0x10 + quint32(hexValue(char32_t(c())));
            ++p;
            ++length;
        }
        if (c() == '.') {
            if (length == 0) return std::nullopt;
            p -= length;
            if (pieceIndex > 6) return std::nullopt;
            int numbersSeen = 0;
            while (c() != -1) {
                int ipv4Piece = -1;
                if (numbersSeen > 0) {
                    if (c() == '.' && numbersSeen < 4) ++p;
                    else return std::nullopt;
                }
                if (c() == -1 || !isAsciiDigit(char32_t(c()))) return std::nullopt;
                while (c() != -1 && isAsciiDigit(char32_t(c()))) {
                    const int number = c() - '0';
                    if (ipv4Piece == -1) ipv4Piece = number;
                    else if (ipv4Piece == 0) return std::nullopt;
                    else ipv4Piece = ipv4Piece * 10 + number;
                    if (ipv4Piece > 255) return std::nullopt;
                    ++p;
                }
                address[size_t(pieceIndex)] = address[size_t(pieceIndex)] * 0x100 + quint32(ipv4Piece);
                ++numbersSeen;
                if (numbersSeen == 2 || numbersSeen == 4) ++pieceIndex;
            }
            if (numbersSeen != 4) return std::nullopt;
            break;
        } else if (c() == ':') {
            ++p;
            if (c() == -1) return std::nullopt;
        } else if (c() != -1) {
            return std::nullopt;
        }
        address[size_t(pieceIndex)] = value;
        ++pieceIndex;
    }
    if (compress != -1) {
        int swaps = pieceIndex - compress;
        pieceIndex = 7;
        while (pieceIndex != 0 && swaps > 0) {
            std::swap(address[size_t(pieceIndex)], address[size_t(compress + swaps - 1)]);
            --pieceIndex;
            --swaps;
        }
    } else if (pieceIndex != 8) {
        return std::nullopt;
    }
    // 序列化:找第一段最长的零(长度 > 1)压成 ::
    int bestStart = -1, bestLen = 0;
    for (int i = 0; i < 8;) {
        if (address[size_t(i)] != 0) {
            ++i;
            continue;
        }
        int j = i;
        while (j < 8 && address[size_t(j)] == 0) ++j;
        if (j - i > bestLen) {
            bestStart = i;
            bestLen = j - i;
        }
        i = j;
    }
    if (bestLen < 2) bestStart = -1;
    QString out;
    bool ignore0 = false;
    for (int i = 0; i < 8; ++i) {
        if (ignore0 && address[size_t(i)] == 0) continue;
        ignore0 = false;
        if (bestStart == i) {
            out += i == 0 ? u"::"_s : u":"_s;
            ignore0 = true;
            continue;
        }
        out += QString::number(address[size_t(i)], 16);
        if (i != 7) out += u':';
    }
    return out;
}

/// 主机解析(特殊协议):方括号里是 IPv6;别的按域名(百分号解码、IDNA、禁用码点、末段是数就按 IPv4)
std::optional<QString> parseHost(const QString& input) {
    if (input.startsWith(u'[')) {
        if (!input.endsWith(u']')) return std::nullopt;
        const auto v6 = parseIpv6(input.mid(1, input.size() - 2));
        if (!v6) return std::nullopt;
        return u'[' + *v6 + u']';
    }
    const QString domain = percentDecodeUtf8(input);
    bool ascii = true;
    for (QChar c : domain)
        if (c.unicode() >= 128) ascii = false;
    QString asciiDomain;
    if (ascii) {
        asciiDomain = domain.toLower();
        // xn-- 开头的标签必须是解得开的 punycode(UTS46 的校验):解不开就失败
        for (const QString& label : asciiDomain.split(u'.')) {
            if (!label.startsWith(u"xn--"_s)) continue;
            const QString decoded = QUrl::fromAce(label.toLatin1(), QUrl::IgnoreIDNWhitelist);
            if (decoded.isEmpty() || decoded == label || QString::fromLatin1(QUrl::toAce(decoded, QUrl::IgnoreIDNWhitelist)) != label) return std::nullopt;
        }
    } else {
        asciiDomain = QString::fromLatin1(QUrl::toAce(domain, QUrl::IgnoreIDNWhitelist));
        if (asciiDomain.isEmpty()) return std::nullopt;
    }
    if (asciiDomain.isEmpty()) return std::nullopt;
    for (const char32_t cp : codePoints(asciiDomain))
        if (forbiddenDomainCodePoint(cp)) return std::nullopt;
    if (endsInNumber(asciiDomain)) return parseIpv4(asciiDomain);
    return asciiDomain;
}

bool isSingleDot(const QString& s) { return s == u"." || s.compare(u"%2e"_s, Qt::CaseInsensitive) == 0; }
bool isDoubleDot(const QString& s) {
    return s == u".." || s.compare(u".%2e"_s, Qt::CaseInsensitive) == 0 || s.compare(u"%2e."_s, Qt::CaseInsensitive) == 0 ||
           s.compare(u"%2e%2e"_s, Qt::CaseInsensitive) == 0;
}

}  // namespace

QString Url::href() const {
    QString out = scheme + u"://"_s;
    if (hasCredentials()) {
        out += username;
        if (!password.isEmpty()) out += u':' + password;
        out += u'@';
    }
    out += host() + path;
    if (query) out += u'?' + *query;
    if (fragment) out += u'#' + *fragment;
    return out;
}

QString Url::dialHost() const {
    if (hostname.startsWith(u'[') && hostname.endsWith(u']')) return hostname.mid(1, hostname.size() - 2);
    return hostname;
}

int Url::dialPort() const { return port.isEmpty() ? (scheme == u"https" ? 443 : 80) : port.toInt(); }

std::optional<Url> parse(QString input) {
    // 去掉首尾的 C0 控制符与空格,删掉所有 tab / 换行
    while (!input.isEmpty() && input.front().unicode() <= 0x20) input.remove(0, 1);
    while (!input.isEmpty() && input.back().unicode() <= 0x20) input.chop(1);
    input.remove(u'\t').remove(u'\n').remove(u'\r');
    qsizetype i = 0;
    if (input.isEmpty() || !(input[0].unicode() < 128 && isAsciiAlpha(input[0].unicode()))) return std::nullopt;
    while (i < input.size() && input[i].unicode() < 128 &&
           (isAsciiAlpha(input[i].unicode()) || isAsciiDigit(input[i].unicode()) || input[i] == u'+' || input[i] == u'-' || input[i] == u'.'))
        ++i;
    if (i >= input.size() || input[i] != u':') return std::nullopt;
    Url out;
    out.scheme = input.left(i).toLower();
    if (!out.isHttp()) return out;
    ++i;
    while (i < input.size() && (input[i] == u'/' || input[i] == u'\\')) ++i;
    qsizetype end = i;
    while (end < input.size() && input[end] != u'/' && input[end] != u'\\' && input[end] != u'?' && input[end] != u'#') ++end;
    QString authority = input.mid(i, end - i);
    QString rest = input.mid(end);

    // 凭证:最后一个 @ 之前的都是 userinfo(里面更早的 @ 编成 %40);@ 之后没有主机就失败
    if (const qsizetype at = authority.lastIndexOf(u'@'); at >= 0) {
        const QString userinfo = authority.left(at);
        authority = authority.mid(at + 1);
        if (authority.isEmpty()) return std::nullopt;
        const qsizetype colon = userinfo.indexOf(u':');
        out.username = percentEncode(colon < 0 ? userinfo : userinfo.left(colon), inUserinfoSet);
        out.password = colon < 0 ? QString() : percentEncode(userinfo.mid(colon + 1), inUserinfoSet);
    }
    QString host, port;
    if (authority.startsWith(u'[')) {
        const qsizetype close = authority.indexOf(u']');
        if (close < 0) return std::nullopt;
        host = authority.left(close + 1);
        const QString after = authority.mid(close + 1);
        if (!after.isEmpty()) {
            if (after[0] != u':') return std::nullopt;
            port = after.mid(1);
        }
    } else if (const qsizetype colon = authority.indexOf(u':'); colon >= 0) {
        host = authority.left(colon);
        port = authority.mid(colon + 1);
    } else {
        host = authority;
    }
    if (host.isEmpty()) return std::nullopt;
    if (!port.isEmpty()) {
        double v = 0;
        for (QChar c : port) {
            if (!isAsciiDigit(c.unicode())) return std::nullopt;
            v = v * 10 + (c.unicode() - u'0');
            if (v > 65535) return std::nullopt;
        }
        const int def = out.scheme == u"http" ? 80 : 443;
        out.port = int(v) == def ? QString() : QString::number(int(v));
    }
    const auto hostname = parseHost(host);
    if (!hostname) return std::nullopt;
    out.hostname = *hostname;

    // 片段、查询、路径
    if (const qsizetype hash = rest.indexOf(u'#'); hash >= 0) {
        out.fragment = percentEncode(rest.mid(hash + 1), inFragmentSet);
        rest.truncate(hash);
    }
    if (const qsizetype q = rest.indexOf(u'?'); q >= 0) {
        out.query = percentEncode(rest.mid(q + 1), inSpecialQuerySet);
        rest.truncate(q);
    }
    if (!rest.isEmpty()) rest.remove(0, 1);  // 路径开头的那个 / 或 \(path start state 吃掉它)
    QStringList segments;
    const QStringList raw = rest.split(QRegularExpression(u"[/\\\\]"_s));
    for (qsizetype k = 0; k < raw.size(); ++k) {
        const bool last = k == raw.size() - 1;
        const QString buffer = percentEncode(raw[k], inPathSet);
        if (isDoubleDot(buffer)) {
            if (!segments.isEmpty()) segments.removeLast();
            if (last) segments.append(QString());
        } else if (isSingleDot(buffer)) {
            if (last) segments.append(QString());
        } else {
            segments.append(buffer);
        }
    }
    out.path = u'/' + segments.join(u'/');
    return out;
}

void setSearch(Url& url, const QString& value) {
    QString v = value;
    if (v.startsWith(u'?')) v.remove(0, 1);
    v.remove(u'\t').remove(u'\n').remove(u'\r');
    if (v.isEmpty()) url.query.reset();
    else url.query = percentEncode(v, inSpecialQuerySet);
}

QList<QPair<QString, QString>> searchParamsRecord(const QString& query) {
    QList<QPair<QString, QString>> entries;
    for (const QString& seq : query.split(u'&')) {
        if (seq.isEmpty()) continue;
        const qsizetype eq = seq.indexOf(u'=');
        QString name = eq < 0 ? seq : seq.left(eq);
        QString value = eq < 0 ? QString() : seq.mid(eq + 1);
        name.replace(u'+', u' ');
        value.replace(u'+', u' ');
        const QString n = percentDecodeUtf8(name), v = percentDecodeUtf8(value);
        bool found = false;
        for (auto& e : entries)
            if (e.first == n) {
                e.second = v;
                found = true;
            }
        if (!found) entries.append({n, v});
    }
    // JS 对象的键序:像数组下标的键在前(数值升序),其余照出现的先后
    QList<QPair<QString, QString>> indexKeys, others;
    for (const auto& e : entries) (util::jsArrayIndex(e.first) ? indexKeys : others).append(e);
    std::stable_sort(indexKeys.begin(), indexKeys.end(), [](const auto& a, const auto& b) { return *util::jsArrayIndex(a.first) < *util::jsArrayIndex(b.first); });
    return indexKeys + others;
}

QString stringifyQuery(const QList<QPair<QString, QString>>& record) {
    const auto encode = [](const QString& s) {
        QString out;
        for (const char32_t cp : codePoints(s)) {
            if (cp == '-' || cp == '.' || cp == '_' || cp == '~' || isAsciiDigit(cp) || isAsciiAlpha(cp)) {
                out.append(QChar(char16_t(cp)));
                continue;
            }
            // qs 对落单的代理项按 3 字节写(这里取 WHATWG 的 U+FFFD,URL 解析器给不出落单的代理项)
            for (const char b : utf8Of(cp)) out.append(u'%' + QString::number(uchar(b), 16).rightJustified(2, u'0').toUpper());
        }
        return out;
    };
    QStringList parts;
    for (const auto& [k, v] : record) parts << encode(k) + u'=' + encode(v);
    return parts.join(u'&');
}

bool isLoopbackHostname(const QString& hostname) {
    if (hostname == u"localhost" || hostname == u"[::1]") return true;
    const QStringList p = hostname.split(u'.');
    if (p.size() != 4 || p[0] != u"127") return false;
    for (const QString& s : p) {
        bool ok = false;
        const int v = s.toInt(&ok);
        if (!ok || v < 0 || v > 255 || s != QString::number(v)) return false;
    }
    return true;
}

}  // namespace ibkr::util::whatwg
