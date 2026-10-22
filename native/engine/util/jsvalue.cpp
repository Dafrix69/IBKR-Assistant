#include "util/jsvalue.h"

#include "util/intel_dateparse.h"

#include "util/jsformat.h"
#include "util/jsnum.h"

#include <QJsonArray>
#include <QTimeZone>
#include <QDateTime>
#include <QLocale>
#include <QRegularExpression>
#include <QStringList>

#include <cmath>
#include <limits>

namespace ibkr::util {

using namespace Qt::StringLiterals;

double jsNumber(const QJsonValue& v) {
    switch (v.type()) {
    case QJsonValue::Null: return 0.0;
    case QJsonValue::Bool: return v.toBool() ? 1.0 : 0.0;
    case QJsonValue::Double: return v.toDouble();
    case QJsonValue::String: return jsStringToNumber(v.toString());
    case QJsonValue::Array: return jsStringToNumber(jsString(v));  // Number([]) = 0、Number([5]) = 5、两个以上是 NaN
    case QJsonValue::Object:
    case QJsonValue::Undefined:
        break;
    }
    return std::numeric_limits<double>::quiet_NaN();
}


QString jsString(const QJsonValue& v) {
    switch (v.type()) {
    case QJsonValue::Undefined: return u"undefined"_s;
    case QJsonValue::Null: return u"null"_s;
    case QJsonValue::Bool: return v.toBool() ? u"true"_s : u"false"_s;
    case QJsonValue::Double: return jsNumberToString(v.toDouble());
    case QJsonValue::String: return v.toString();
    case QJsonValue::Array: {
        // [1, null, "a"] → "1,,a":null 与 undefined 是空串
        QStringList parts;
        for (const QJsonValue& item : v.toArray()) parts.append(item.isNull() || item.isUndefined() ? QString() : jsString(item));
        return parts.join(u',');
    }
    case QJsonValue::Object: return u"[object Object]"_s;
    }
    return {};
}

bool jsTruthy(const QJsonValue& v) {
    switch (v.type()) {
    case QJsonValue::Undefined:
    case QJsonValue::Null: return false;
    case QJsonValue::Bool: return v.toBool();
    case QJsonValue::Double: {
        const double d = v.toDouble();
        return d != 0 && !std::isnan(d);
    }
    case QJsonValue::String: return !v.toString().isEmpty();
    case QJsonValue::Array:
    case QJsonValue::Object: return true;
    }
    return false;
}

QString jsonQuote(const QString& s) {
    QString out;
    out.reserve(s.size() + 2);
    out += u'"';
    for (qsizetype i = 0; i < s.size(); ++i) {
        const char16_t c = s[i].unicode();
        switch (c) {
        case u'"': out += u"\\\""_s; break;
        case u'\\': out += u"\\\\"_s; break;
        case u'\b': out += u"\\b"_s; break;
        case u'\f': out += u"\\f"_s; break;
        case u'\n': out += u"\\n"_s; break;
        case u'\r': out += u"\\r"_s; break;
        case u'\t': out += u"\\t"_s; break;
        default: {
            const bool high = c >= 0xD800 && c <= 0xDBFF;
            const bool low = c >= 0xDC00 && c <= 0xDFFF;
            const bool pairedHigh = high && i + 1 < s.size() && s[i + 1].unicode() >= 0xDC00 && s[i + 1].unicode() <= 0xDFFF;
            const bool pairedLow = low && i > 0 && s[i - 1].unicode() >= 0xD800 && s[i - 1].unicode() <= 0xDBFF;
            // 控制字符与落单的代理项写成 \uXXXX(小写十六进制,同 JSON.stringify)
            if (c < 0x20 || (high && !pairedHigh) || (low && !pairedLow)) {
                out += u"\\u"_s + QString::number(c, 16).rightJustified(4, u'0');
            } else {
                out += QChar(c);
            }
        }
        }
    }
    out += u'"';
    return out;
}

QString jsTrim(const QString& s) {
    qsizetype b = 0, e = s.size();
    while (b < e && isJsWhitespace(s.at(b))) ++b;
    while (e > b && isJsWhitespace(s.at(e - 1))) --e;
    return s.mid(b, e - b);
}



double jsDateParse(const QString& s, const QTimeZone& local) {
    return v8DateParse(s, local);
}

double jsDateParse(const QString& s) {
    return v8DateParse(s);
}

QString nodeUtf8(const QByteArray& bytes) {
    // WHATWG 的 UTF-8 解码(Node 的 Buffer.toString / readFileSync 用的就是它):开头的 BOM 留着;
    // 每一段"最长的不合法前缀"换成一个 U+FFFD;末尾没写完的半个字也是一个 U+FFFD(不等下一块)
    QString out;
    out.reserve(bytes.size());
    char32_t cp = 0;
    int needed = 0, seen = 0;
    unsigned lower = 0x80, upper = 0xBF;
    const auto push = [&](char32_t c) {
        if (c >= 0x10000) {
            out += QChar(char16_t(0xD800 + ((c - 0x10000) >> 10)));
            out += QChar(char16_t(0xDC00 + ((c - 0x10000) & 0x3FF)));
        } else {
            out += QChar(char16_t(c));
        }
    };
    for (qsizetype i = 0; i < bytes.size(); ++i) {
        const unsigned b = static_cast<unsigned char>(bytes[i]);
        if (needed == 0) {
            if (b <= 0x7F) push(b);
            else if (b >= 0xC2 && b <= 0xDF) { needed = 1; cp = b & 0x1F; }
            else if (b >= 0xE0 && b <= 0xEF) {
                if (b == 0xE0) lower = 0xA0;
                if (b == 0xED) upper = 0x9F;
                needed = 2;
                cp = b & 0xF;
            } else if (b >= 0xF0 && b <= 0xF4) {
                if (b == 0xF0) lower = 0x90;
                if (b == 0xF4) upper = 0x8F;
                needed = 3;
                cp = b & 0x7;
            } else push(0xFFFD);
            continue;
        }
        if (b < lower || b > upper) {
            cp = 0;
            needed = seen = 0;
            lower = 0x80;
            upper = 0xBF;
            push(0xFFFD);
            --i;  // 这个字节重新当开头处理
            continue;
        }
        lower = 0x80;
        upper = 0xBF;
        cp = (cp << 6) | (b & 0x3F);
        if (++seen == needed) {
            push(cp);
            cp = 0;
            needed = seen = 0;
        }
    }
    if (needed != 0) push(0xFFFD);
    return out;
}

QByteArray toNodeUtf8(const QString& s) {
    bool lone = false;
    for (qsizetype i = 0; i < s.size() && !lone; ++i) {
        if (s[i].isHighSurrogate()) {
            if (i + 1 < s.size() && s[i + 1].isLowSurrogate()) ++i;
            else lone = true;
        } else if (s[i].isLowSurrogate()) {
            lone = true;
        }
    }
    if (!lone) return s.toUtf8();
    QString fixed;
    fixed.reserve(s.size());
    for (qsizetype i = 0; i < s.size(); ++i) {
        if (s[i].isHighSurrogate() && i + 1 < s.size() && s[i + 1].isLowSurrogate()) {
            fixed += s[i];
            fixed += s[++i];
        } else if (s[i].isSurrogate()) {
            fixed += QChar(0xFFFD);
        } else {
            fixed += s[i];
        }
    }
    return fixed.toUtf8();
}

}  // namespace ibkr::util

namespace ibkr::util {

QString jsNormalizeNfkc(const QString& s) {
    // Unicode 17 才给了分解的几个:ICU 77 不认,照原样留(按它们切开,两边各自归一)
    const auto isNew = [](char32_t c) { return c == 0xA7F1 || (c >= 0x16126 && c <= 0x16128); };
    bool any = false;
    for (qsizetype i = 0; i < s.size(); ++i) {
        const char32_t c = s[i].isHighSurrogate() && i + 1 < s.size() && s[i + 1].isLowSurrogate() ? QChar::surrogateToUcs4(s[i], s[i + 1]) : s[i].unicode();
        if (isNew(c)) any = true;
    }
    if (!any) return s.normalized(QString::NormalizationForm_KC);
    QString out, run;
    for (qsizetype i = 0; i < s.size(); ++i) {
        const bool pair = s[i].isHighSurrogate() && i + 1 < s.size() && s[i + 1].isLowSurrogate();
        const char32_t c = pair ? QChar::surrogateToUcs4(s[i], s[i + 1]) : s[i].unicode();
        const QString unit = pair ? s.mid(i, 2) : s.mid(i, 1);
        if (pair) ++i;
        if (isNew(c)) {
            out += run.normalized(QString::NormalizationForm_KC) + unit;
            run.clear();
        } else {
            run += unit;
        }
    }
    return out + run.normalized(QString::NormalizationForm_KC);
}

QString jsMaskLoneSurrogates(const QString& s) {
    QString out = s;
    for (qsizetype i = 0; i < out.size(); ++i) {
        if (out[i].isHighSurrogate() && i + 1 < out.size() && out[i + 1].isLowSurrogate()) {
            ++i;
            continue;
        }
        if (out[i].isSurrogate()) out[i] = QChar(0xF8FF);
    }
    return out;
}

const QString& jsSpaceClassBody() {
    static const QString body = QStringLiteral("\\t\\n\\x{0B}\\f\\r \\x{A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}");
    return body;
}

}  // namespace ibkr::util
