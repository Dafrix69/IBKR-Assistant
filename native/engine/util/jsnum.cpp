#include "util/jsnum.h"

#include <QByteArray>
#include <QLocale>

#include <cmath>
#include <limits>

namespace ibkr::util {

namespace {

constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();
constexpr double kInf = std::numeric_limits<double>::infinity();

qsizetype skipWhitespace(QStringView s) {
    qsizetype i = 0;
    while (i < s.size() && isJsWhitespace(s[i])) ++i;
    return i;
}

int digitValue(QChar c, int radix) {
    const char16_t u = c.unicode();
    int v = -1;
    if (u >= u'0' && u <= u'9') v = u - u'0';
    else if (u >= u'a' && u <= u'z') v = u - u'a' + 10;
    else if (u >= u'A' && u <= u'Z') v = u - u'A' + 10;
    return v < radix ? v : -1;
}

bool isDigit(QChar c) { return c.unicode() >= u'0' && c.unicode() <= u'9'; }

}  // namespace

bool isJsWhitespace(QChar c) {
    switch (c.unicode()) {
    case u'\t': case u'\n': case 0x0B: case 0x0C: case u'\r': case u' ':
    case 0x00A0: case 0xFEFF: case 0x2028: case 0x2029:
        return true;
    default:
        // 其余的 Zs 类(各种宽度的空格);U+0085 是 Cc,不算
        return c.category() == QChar::Separator_Space;
    }
}

double jsParseInt(QStringView s, int radix) {
    qsizetype i = skipWhitespace(s);
    double sign = 1.0;
    if (i < s.size() && (s[i] == u'+' || s[i] == u'-')) {
        if (s[i] == u'-') sign = -1.0;
        ++i;
    }
    if (radix == 16 && i + 1 < s.size() && s[i] == u'0' && (s[i + 1] == u'x' || s[i + 1] == u'X')) i += 2;
    const qsizetype digitsStart = i;
    while (i < s.size() && digitValue(s[i], radix) >= 0) ++i;
    if (i == digitsStart) return kNaN;
    if (radix == 10) {
        // 十进制按整串换成最近的 double(和 JS 一样正确舍入),不逐位乘加:超过 2^53 时逐位乘加会差最后一位
        bool ok = false;
        const double value = QLocale::c().toDouble(s.sliced(digitsStart, i - digitsStart), &ok);
        return sign * (ok ? value : kInf);
    }
    double value = 0.0;
    for (qsizetype k = digitsStart; k < i; ++k) value = value * radix + digitValue(s[k], radix);
    return sign * value;
}

double jsParseFloat(QStringView s) {
    qsizetype i = skipWhitespace(s);
    const qsizetype start = i;
    if (i < s.size() && (s[i] == u'+' || s[i] == u'-')) ++i;
    const bool negative = i > start && s[start] == u'-';
    if (s.sliced(i).startsWith(u"Infinity")) return negative ? -kInf : kInf;

    const qsizetype intStart = i;
    while (i < s.size() && isDigit(s[i])) ++i;
    bool digits = i > intStart;
    if (i < s.size() && s[i] == u'.') {
        const qsizetype fracStart = ++i;
        while (i < s.size() && isDigit(s[i])) ++i;
        digits = digits || i > fracStart;
    }
    if (!digits) return kNaN;
    // 指数只在后面真有数字时才算进去:"1e" "1e+" 都读成 1
    if (i < s.size() && (s[i] == u'e' || s[i] == u'E')) {
        qsizetype j = i + 1;
        if (j < s.size() && (s[j] == u'+' || s[j] == u'-')) ++j;
        const qsizetype expStart = j;
        while (j < s.size() && isDigit(s[j])) ++j;
        if (j > expStart) i = j;
    }
    const QStringView literal = s.sliced(start, i - start);
    bool ok = false;
    const double value = QLocale::c().toDouble(literal, &ok);
    if (ok) return value;
    // 语法是对的却没读成,只剩溢出与下溢两种:看指数的正负
    const qsizetype e = literal.indexOf(u'e', 0, Qt::CaseInsensitive);
    const bool tiny = e >= 0 && e + 1 < literal.size() && literal[e + 1] == u'-';
    if (tiny) return negative ? -0.0 : 0.0;
    return negative ? -kInf : kInf;
}

}  // namespace ibkr::util
