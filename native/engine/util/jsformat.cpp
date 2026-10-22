#include "util/jsformat.h"

#include "util/jsnum.h"

#include <QLocale>

#include <cmath>
#include <cstdint>
#include <limits>
#include <vector>

namespace ibkr::util {

using namespace Qt::StringLiterals;

namespace {

/// 非负大整数,每格 10^9,低位在前
struct BigUint {
    std::vector<std::uint32_t> limbs;
    explicit BigUint(std::uint64_t v) {
        do {
            limbs.push_back(static_cast<std::uint32_t>(v % 1000000000u));
            v /= 1000000000u;
        } while (v);
    }
    void mul(std::uint32_t k) {
        std::uint64_t carry = 0;
        for (std::uint32_t& l : limbs) {
            const std::uint64_t t = std::uint64_t(l) * k + carry;
            l = static_cast<std::uint32_t>(t % 1000000000u);
            carry = t / 1000000000u;
        }
        while (carry) {
            limbs.push_back(static_cast<std::uint32_t>(carry % 1000000000u));
            carry /= 1000000000u;
        }
    }
    QString toString() const {
        QString out = QString::number(limbs.back());
        for (auto it = limbs.rbegin() + 1; it != limbs.rend(); ++it) out += QString::number(*it).rightJustified(9, u'0');
        return out;
    }
};

/// 一串十进制数字(只有 0–9)加一,进位;返回是否多出了一位
bool incrementDigits(QString& digits) {
    for (qsizetype i = digits.size() - 1; i >= 0; --i) {
        if (digits[i] != u'9') {
            digits[i] = QChar(digits[i].unicode() + 1);
            return false;
        }
        digits[i] = u'0';
    }
    digits.prepend(u'1');
    return true;
}

}  // namespace

ExactDecimal exactDecimal(double x) {
    ExactDecimal out;
    out.negative = std::signbit(x);
    const double a = std::fabs(x);
    if (a == 0) {
        out.integer = u"0"_s;
        return out;
    }
    int e = 0;
    const double f = std::frexp(a, &e);  // a = f × 2^e,f ∈ [0.5, 1)
    auto mant = static_cast<std::uint64_t>(std::ldexp(f, 53));
    int e2 = e - 53;
    while (mant % 2 == 0 && e2 < 0) {  // 约掉 2 的因子,少展开几位
        mant /= 2;
        ++e2;
    }
    BigUint n(mant);
    if (e2 >= 0) {
        for (int i = 0; i < e2; ++i) n.mul(2);
        out.integer = n.toString();
        return out;
    }
    const int k = -e2;  // a = mant / 2^k = mant × 5^k / 10^k
    int left = k;
    while (left >= 13) {  // 5^13 < 2^32
        n.mul(1220703125u);
        left -= 13;
    }
    for (int i = 0; i < left; ++i) n.mul(5);
    QString digits = n.toString();
    if (digits.size() <= k) digits = QString(k - digits.size() + 1, u'0') + digits;
    out.integer = digits.left(digits.size() - k);
    out.fraction = digits.mid(digits.size() - k);
    while (out.fraction.endsWith(u'0')) out.fraction.chop(1);
    qsizetype lead = 0;
    while (lead < out.integer.size() - 1 && out.integer[lead] == u'0') ++lead;
    out.integer = out.integer.mid(lead);
    return out;
}

QString jsNumberToString(double x) {
    if (std::isnan(x)) return u"NaN"_s;
    if (std::isinf(x)) return x > 0 ? u"Infinity"_s : u"-Infinity"_s;
    if (x == 0) return u"0"_s;  // -0 也是 "0"
    const bool negative = x < 0;
    // 最短的、读得回同一个数的那串数字与指数(double-conversion 的 SHORTEST:位数最少,几种一样少时取离 x 最近的)
    const QString e = QString::number(std::fabs(x), 'e', QLocale::FloatingPointShortest);
    const qsizetype ePos = e.indexOf(u'e');
    QString digits = e.left(ePos);
    digits.remove(u'.');
    const int exponent = e.mid(ePos + 1).toInt();
    const int k = static_cast<int>(digits.size());
    const int n = exponent + 1;  // 小数点在第 n 位数字之后
    QString out;
    if (k <= n && n <= 21) out = digits + QString(n - k, u'0');
    else if (0 < n && n <= 21) out = digits.left(n) + u'.' + digits.mid(n);
    else if (-6 < n && n <= 0) out = u"0."_s + QString(-n, u'0') + digits;
    else {
        const int shown = n - 1;
        out = digits.left(1) + (k > 1 ? u"."_s + digits.mid(1) : QString()) + u'e' + (shown >= 0 ? u"+"_s : u"-"_s) + QString::number(std::abs(shown));
    }
    return negative ? u'-' + out : out;
}

QString jsToFixed(double x, int digits) {
    if (!std::isfinite(x) || std::fabs(x) >= 1e21) return jsNumberToString(x);
    const ExactDecimal d = exactDecimal(x);
    QString integer = d.integer;
    QString frac = d.fraction;
    if (frac.size() <= digits) {
        frac += QString(digits - frac.size(), u'0');
    } else {
        // 第 digits 位之后:≥ 一半(第一位 ≥ 5)就进一——正好一半时规范取大的那个 n
        const bool up = frac[digits] >= u'5';
        frac.truncate(digits);
        if (up) {
            QString all = integer + frac;
            const bool grew = incrementDigits(all);
            integer = all.left(integer.size() + (grew ? 1 : 0));
            frac = all.mid(integer.size());
        }
    }
    const QString body = digits > 0 ? integer + u'.' + frac : integer;
    return x < 0 ? u'-' + body : body;  // -0 不算小于 0
}

QString jsToExponential(double x, int digits) {
    if (!std::isfinite(x)) return jsNumberToString(x);
    QString sig;
    int e = 0;
    if (x == 0) {
        sig = QString(digits + 1, u'0');
    } else {
        const ExactDecimal d = exactDecimal(x);
        QString all = d.integer + d.fraction;
        e = static_cast<int>(d.integer.size()) - 1;
        // 去掉前导 0(纯小数时),指数跟着往下走
        qsizetype lead = 0;
        while (lead < all.size() - 1 && all[lead] == u'0') ++lead;
        all = all.mid(lead);
        e -= static_cast<int>(lead);
        if (all.size() <= digits + 1) {
            sig = all + QString(digits + 1 - all.size(), u'0');
        } else {
            const bool up = all[digits + 1] >= u'5';
            sig = all.left(digits + 1);
            if (up && incrementDigits(sig)) {
                sig.chop(1);
                ++e;
            }
        }
    }
    QString out = sig.left(1);
    if (digits > 0) out += u'.' + sig.mid(1);
    out += u'e' + (e >= 0 ? u"+"_s : u"-"_s) + QString::number(std::abs(e));
    return x < 0 ? u'-' + out : out;
}

QString jsToExponentialShortest(double x) {
    if (!std::isfinite(x)) return jsNumberToString(x);
    if (x == 0) return u"0e+0"_s;
    const QString e = QString::number(std::fabs(x), 'e', QLocale::FloatingPointShortest);
    const qsizetype ePos = e.indexOf(u'e');
    const QString mantissa = e.left(ePos);
    const int exponent = e.mid(ePos + 1).toInt();
    const QString out = mantissa + u'e' + (exponent >= 0 ? u"+"_s : u"-"_s) + QString::number(std::abs(exponent));
    return x < 0 ? u'-' + out : out;
}

double jsRound(double x) {
    // 离它最近的整数,正好一半往 +∞ 走;不能写成 floor(x + 0.5)——0.49999999999999994 加 0.5 会舍入成 1
    if (!std::isfinite(x)) return x;
    const double f = std::floor(x);
    const double r = x - f >= 0.5 ? f + 1 : f;
    return r == 0 && std::signbit(x) ? -0.0 : r;
}

double jsStringToNumber(QStringView raw) {
    qsizetype a = 0, b = raw.size();
    while (a < b && isJsWhitespace(raw[a])) ++a;
    while (b > a && isJsWhitespace(raw[b - 1])) --b;
    const QStringView s = raw.mid(a, b - a);
    if (s.isEmpty()) return 0.0;
    if (s == u"Infinity" || s == u"+Infinity") return std::numeric_limits<double>::infinity();
    if (s == u"-Infinity") return -std::numeric_limits<double>::infinity();
    if (s.size() > 2 && s[0] == u'0') {
        const QChar p = s[1].toLower();
        const int radix = p == u'x' ? 16 : p == u'o' ? 8 : p == u'b' ? 2 : 0;
        if (radix != 0) {
            double value = 0;
            for (qsizetype i = 2; i < s.size(); ++i) {
                const char16_t u = s[i].unicode();
                const int d = u >= u'0' && u <= u'9' ? u - u'0' : u >= u'a' && u <= u'z' ? u - u'a' + 10 : u >= u'A' && u <= u'Z' ? u - u'A' + 10 : -1;
                if (d < 0 || d >= radix) return std::numeric_limits<double>::quiet_NaN();
                value = value * radix + d;
            }
            return value;
        }
    }
    // 十进制:[+-]?(数字[.数字*] | .数字)([eE][+-]?数字)?,整串
    qsizetype i = 0;
    if (s[i] == u'+' || s[i] == u'-') ++i;
    qsizetype intDigits = 0, fracDigits = 0;
    while (i < s.size() && s[i] >= u'0' && s[i] <= u'9') { ++i; ++intDigits; }
    if (i < s.size() && s[i] == u'.') {
        ++i;
        while (i < s.size() && s[i] >= u'0' && s[i] <= u'9') { ++i; ++fracDigits; }
    }
    if (intDigits + fracDigits == 0) return std::numeric_limits<double>::quiet_NaN();
    if (i < s.size() && (s[i] == u'e' || s[i] == u'E')) {
        ++i;
        if (i < s.size() && (s[i] == u'+' || s[i] == u'-')) ++i;
        qsizetype expDigits = 0;
        while (i < s.size() && s[i] >= u'0' && s[i] <= u'9') { ++i; ++expDigits; }
        if (expDigits == 0) return std::numeric_limits<double>::quiet_NaN();
    }
    if (i != s.size()) return std::numeric_limits<double>::quiet_NaN();
    return jsParseFloat(s);
}

}  // namespace ibkr::util
