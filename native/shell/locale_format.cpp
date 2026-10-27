#include "shell/locale_format.h"

#include "shell/jsvalue.h"

#include <cmath>

namespace ibkr::shell {

using namespace Qt::StringLiterals;

QString formatEnUs(double n, int maxFractionDigits) {
    if (std::isnan(n)) return u"NaN"_s;
    if (std::isinf(n)) return n < 0 ? u"-∞"_s : u"∞"_s;
    // 从最短的那串十进制数字起四舍五入(同 ICU):1.005 是 1.01,不是二进制展开的 1.00
    QString s = jsNumberToString(std::fabs(n));
    if (s.contains(u'e')) s = QString::number(std::fabs(n), 'f', 20);
    QString intPart = s.section(u'.', 0, 0);
    QString frac = s.section(u'.', 1);
    if (frac.size() > maxFractionDigits) {
        const bool up = frac[maxFractionDigits].unicode() >= u'5';
        frac = frac.left(maxFractionDigits);
        if (up) {
            // 进位:从末位往前
            QString digits = intPart + frac;
            qsizetype i = digits.size() - 1;
            while (i >= 0) {
                if (digits[i] == u'9') {
                    digits[i] = u'0';
                    --i;
                } else {
                    digits[i] = QChar(digits[i].unicode() + 1);
                    break;
                }
            }
            if (i < 0) digits.prepend(u'1');
            intPart = digits.left(digits.size() - frac.size());
            frac = digits.right(frac.size());
        }
    }
    while (frac.endsWith(u'0')) frac.chop(1);
    QString grouped;
    for (qsizetype i = 0; i < intPart.size(); ++i) {
        if (i > 0 && (intPart.size() - i) % 3 == 0) grouped += u',';
        grouped += intPart[i];
    }
    // 负数舍到 0 也带负号(ICU 的写法:-0.004 → "-0",-0 也是 "-0")
    return (std::signbit(n) ? u"-"_s : QString()) + grouped + (frac.isEmpty() ? QString() : u'.' + frac);
}

}  // namespace ibkr::shell
