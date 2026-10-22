// intel 组手写 JS 正则时用的几样(不带 u 的 JS 正则:按 UTF-16 码元走,\d \w 是 ASCII,\s 是 JS 那一组空白,/i 只折 ASCII 字母,
// `.` 不认四个行终结符)。只有头文件。
#pragma once

#include <QString>
#include <QStringView>

namespace ibkr::util::intel_text {

inline bool isLetter(QChar c) { return (c >= u'A' && c <= u'Z') || (c >= u'a' && c <= u'z'); }
inline bool isDigit(QChar c) { return c >= u'0' && c <= u'9'; }
/// \w
inline bool isWord(QChar c) { return isLetter(c) || isDigit(c) || c == u'_'; }
/// \s
inline bool isSpace(QChar c) {
    const char16_t u = c.unicode();
    return u == 0x09 || u == 0x0A || u == 0x0B || u == 0x0C || u == 0x0D || u == 0x20 || u == 0xA0 || u == 0x1680 || (u >= 0x2000 && u <= 0x200A) ||
           u == 0x2028 || u == 0x2029 || u == 0x202F || u == 0x205F || u == 0x3000 || u == 0xFEFF;
}
/// `.` 不匹配的那几个
inline bool isLineTerminator(QChar c) { return c == u'\n' || c == u'\r' || c == QChar(0x2028) || c == QChar(0x2029); }
/// /i 下的比较:只有 ASCII 字母折大小写
inline QChar fold(QChar c) { return c >= u'a' && c <= u'z' ? QChar(c.unicode() - 32) : c; }
inline bool wordAt(const QString& s, qsizetype i) { return i >= 0 && i < s.size() && isWord(s[i]); }
/// 从 i 起是不是 lit
inline bool litAt(const QString& s, qsizetype i, QStringView lit, bool caseless) {
    if (i < 0 || i + lit.size() > s.size()) return false;
    for (qsizetype k = 0; k < lit.size(); ++k) {
        const QChar a = s[i + k], b = lit[k];
        if (caseless ? fold(a) != fold(b) : a != b) return false;
    }
    return true;
}
/// /lit/i.test(s)
inline bool containsCaseless(const QString& s, QStringView lit) {
    for (qsizetype i = 0; i + lit.size() <= s.size(); ++i)
        if (litAt(s, i, lit, true)) return true;
    return false;
}
/// /\blit\b/i.test(s)(lit 首尾都是 \w)
inline bool wordCaseless(const QString& s, QStringView lit) {
    for (qsizetype i = 0; i + lit.size() <= s.size(); ++i)
        if (!wordAt(s, i - 1) && litAt(s, i, lit, true) && !wordAt(s, i + lit.size())) return true;
    return false;
}
/// /a.*b/i.test(s)
inline bool spanCaseless(const QString& s, QStringView a, QStringView b) {
    for (qsizetype i = 0; i + a.size() <= s.size(); ++i) {
        if (!litAt(s, i, a, true)) continue;
        for (qsizetype k = i + a.size(); k <= s.size(); ++k) {
            if (litAt(s, k, b, true)) return true;
            if (k < s.size() && isLineTerminator(s[k])) break;
        }
    }
    return false;
}
inline qsizetype skipSpaces(const QString& s, qsizetype i) {
    while (i < s.size() && isSpace(s[i])) ++i;
    return i;
}

}  // namespace ibkr::util::intel_text
