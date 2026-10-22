#include "util/intel_dateparse.h"

#include <QDateTime>

#include <climits>
#include <cmath>
#include <cstdint>
#include <limits>

namespace ibkr::util {

namespace {

constexpr int kNone = INT_MAX;
constexpr int kMaxSignificantDigits = 9;
constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();
constexpr double kMaxTimeInMs = 8.64e15;
constexpr double kMaxTimeBeforeUTCInMs = kMaxTimeInMs + 864000000.0;
constexpr int64_t kSmiMax = (int64_t(1) << 30) - 1;  // 指针压缩下的 Smi(31 位)

bool between(int x, int lo, int hi) { return x >= lo && x <= hi; }
/// JS 的空白与行终结符
bool isWhiteSpaceOrLineTerminator(char16_t u) {
    return u == 0x09 || u == 0x0A || u == 0x0B || u == 0x0C || u == 0x0D || u == 0x20 || u == 0xA0 || u == 0x1680 || (u >= 0x2000 && u <= 0x200A) ||
           u == 0x2028 || u == 0x2029 || u == 0x202F || u == 0x205F || u == 0x3000 || u == 0xFEFF;
}

// ---------------------------------------------------------------- InputReader
class InputReader {
public:
    explicit InputReader(const QString& s) : buf_(s) { next(); }
    int position() const { return index_; }
    void next() {
        ch_ = index_ < buf_.size() ? buf_[index_].unicode() : 0;
        ++index_;
    }
    int readUnsignedNumeral() {
        int n = 0, i = 0;
        while (ch_ == u'0') next();  // 先跳过前导零
        while (isAsciiDigit()) {
            if (i < kMaxSignificantDigits) n = n * 10 + ch_ - u'0';
            ++i;
            next();
        }
        return n;
    }
    int readWord(uint32_t* prefix, int size) {
        int len;
        for (len = 0; isAsciiAlphaOrAbove() && !isWhiteSpaceChar(); next(), ++len)
            if (len < size) prefix[len] = ch_ | 0x20;
        for (int i = len; i < size; ++i) prefix[i] = 0;
        return len;
    }
    bool skip(char16_t c) {
        if (ch_ != c) return false;
        next();
        return true;
    }
    bool skipWhiteSpace() {
        if (!isWhiteSpaceOrLineTerminator(ch_)) return false;
        next();
        return true;
    }
    bool skipParentheses() {
        if (ch_ != u'(') return false;
        int balance = 0;
        do {
            if (ch_ == u')') --balance;
            else if (ch_ == u'(') ++balance;
            next();
        } while (balance > 0 && ch_);
        return true;
    }
    bool isEnd() const { return ch_ == 0; }
    bool isAsciiDigit() const { return ch_ >= u'0' && ch_ <= u'9'; }
    bool isAsciiAlphaOrAbove() const { return ch_ >= u'A'; }
    /// 词里的分隔只认空白,不认行终结符(V8 的 IsWhiteSpace):U+2028 / U+2029 会被读进词里
    bool isWhiteSpaceChar() const { return isWhiteSpaceOrLineTerminator(ch_) && ch_ != 0x0A && ch_ != 0x0D && ch_ != 0x2028 && ch_ != 0x2029; }

private:
    const QString& buf_;
    int index_ = 0;
    char16_t ch_ = 0;
};

// ---------------------------------------------------------------- DateToken
enum KeywordType { INVALID = 0, MONTH_NAME, TIME_ZONE_NAME, TIME_SEPARATOR, AM_PM };
enum Tag { kInvalidTokenTag = -6, kUnknownTokenTag = -5, kWhiteSpaceTag = -4, kNumberTag = -3, kSymbolTag = -2, kEndOfInputTag = -1 };

struct Token {
    int tag = kInvalidTokenTag;
    int length = 0;
    int value = 0;
    bool isInvalid() const { return tag == kInvalidTokenTag; }
    bool isNumber() const { return tag == kNumberTag; }
    bool isSymbol(char16_t c) const { return tag == kSymbolTag && value == c; }
    bool isWhiteSpace() const { return tag == kWhiteSpaceTag; }
    bool isEndOfInput() const { return tag == kEndOfInputTag; }
    bool isKeyword() const { return tag >= 0; }
    bool isKeywordType(KeywordType t) const { return tag == t; }
    bool isFixedLengthNumber(int len) const { return isNumber() && length == len; }
    bool isAsciiSign() const { return tag == kSymbolTag && (value == u'-' || value == u'+'); }
    int asciiSign() const { return 44 - value; }
    bool isKeywordZ() const { return tag == TIME_ZONE_NAME && length == 1 && value == 0; }
    static Token make(int tag, int length, int value) { return Token{tag, length, value}; }
};

struct Keyword {
    char a, b, c;
    KeywordType type;
    int value;
};
constexpr Keyword kKeywords[] = {
    {'j', 'a', 'n', MONTH_NAME, 1},      {'f', 'e', 'b', MONTH_NAME, 2},      {'m', 'a', 'r', MONTH_NAME, 3},      {'a', 'p', 'r', MONTH_NAME, 4},
    {'m', 'a', 'y', MONTH_NAME, 5},      {'j', 'u', 'n', MONTH_NAME, 6},      {'j', 'u', 'l', MONTH_NAME, 7},      {'a', 'u', 'g', MONTH_NAME, 8},
    {'s', 'e', 'p', MONTH_NAME, 9},      {'o', 'c', 't', MONTH_NAME, 10},     {'n', 'o', 'v', MONTH_NAME, 11},     {'d', 'e', 'c', MONTH_NAME, 12},
    {'a', 'm', '\0', AM_PM, 0},          {'p', 'm', '\0', AM_PM, 12},         {'u', 't', '\0', TIME_ZONE_NAME, 0}, {'u', 't', 'c', TIME_ZONE_NAME, 0},
    {'z', '\0', '\0', TIME_ZONE_NAME, 0}, {'g', 'm', 't', TIME_ZONE_NAME, 0}, {'c', 'd', 't', TIME_ZONE_NAME, -5}, {'c', 's', 't', TIME_ZONE_NAME, -6},
    {'e', 'd', 't', TIME_ZONE_NAME, -4}, {'e', 's', 't', TIME_ZONE_NAME, -5}, {'m', 'd', 't', TIME_ZONE_NAME, -6}, {'m', 's', 't', TIME_ZONE_NAME, -7},
    {'p', 'd', 't', TIME_ZONE_NAME, -7}, {'p', 's', 't', TIME_ZONE_NAME, -8}, {'t', '\0', '\0', TIME_SEPARATOR, 0},
};

Token lookupKeyword(const uint32_t* pre, int len) {
    for (const Keyword& k : kKeywords) {
        // 前三个字母对上;比关键词长的只许是月份名
        if (pre[0] == uint32_t(k.a) && pre[1] == uint32_t(k.b) && pre[2] == uint32_t(k.c) && (len <= 3 || k.type == MONTH_NAME))
            return Token::make(k.type, len, k.value);
    }
    return Token::make(INVALID, len, 0);
}

class Tokenizer {
public:
    explicit Tokenizer(InputReader& in) : in_(in), next_(scan()) {}
    Token next() {
        const Token r = next_;
        next_ = scan();
        return r;
    }
    Token peek() const { return next_; }
    bool skipSymbol(char16_t c) {
        if (!next_.isSymbol(c)) return false;
        next();
        return true;
    }

private:
    Token scan() {
        const int pre = in_.position();
        if (in_.isEnd()) return Token::make(kEndOfInputTag, 0, -1);
        if (in_.isAsciiDigit()) {
            const int n = in_.readUnsignedNumeral();
            return Token::make(kNumberTag, in_.position() - pre, n);
        }
        for (char16_t c : {u':', u'-', u'+', u'.', u')'})
            if (in_.skip(c)) return Token::make(kSymbolTag, 1, c);
        if (in_.isAsciiAlphaOrAbove() && !in_.isWhiteSpaceChar()) {
            uint32_t buffer[3] = {0, 0, 0};
            const int len = in_.readWord(buffer, 3);
            return lookupKeyword(buffer, len);
        }
        if (in_.skipWhiteSpace()) return Token::make(kWhiteSpaceTag, in_.position() - pre, 0);
        if (in_.skipParentheses()) return Token::make(kUnknownTokenTag, 0, 0);
        in_.next();
        return Token::make(kUnknownTokenTag, 0, 0);
    }
    InputReader& in_;
    Token next_;
};

// ---------------------------------------------------------------- composers
struct TimeZoneComposer {
    int sign = kNone, hour = kNone, minute = kNone;
    void set(int offsetHours) {
        sign = offsetHours < 0 ? -1 : 1;
        hour = offsetHours * sign;
        minute = 0;
    }
    void setSign(int s) { sign = s < 0 ? -1 : 1; }
    bool isExpecting(int n) const { return hour != kNone && minute == kNone && between(n, 0, 59); }
    bool isUTC() const { return hour == 0 && minute == 0; }
    bool isEmpty() const { return hour == kNone; }
    /// 秒;没有时区是 NaN;越界回 false
    bool write(double& offset) {
        if (sign == kNone) {
            offset = kNaN;
            return true;
        }
        if (hour == kNone) hour = 0;
        if (minute == kNone) minute = 0;
        const uint32_t total = uint32_t(hour) * 3600U + uint32_t(minute) * 60U;  // 同 V8:无符号算,溢出就绕回
        if (int64_t(total) > kSmiMax) return false;
        offset = sign < 0 ? -double(int(total)) : double(int(total));
        return true;
    }
};

struct TimeComposer {
    int comp[4] = {0, 0, 0, 0};
    int index = 0;
    int hourOffset = kNone;
    bool isEmpty() const { return index == 0; }
    bool isExpecting(int n) const { return (index == 1 && between(n, 0, 59)) || (index == 2 && between(n, 0, 59)) || (index == 3 && between(n, 0, 999)); }
    bool add(int n) {
        if (index >= 4) return false;
        comp[index++] = n;
        return true;
    }
    bool addFinal(int n) {
        if (!add(n)) return false;
        while (index < 4) comp[index++] = 0;
        return true;
    }
    bool write(double* out) {
        while (index < 4) comp[index++] = 0;
        int& hour = comp[0];
        if (hourOffset != kNone) {
            if (!between(hour, 0, 12)) return false;
            hour %= 12;
            hour += hourOffset;
        }
        if (!between(hour, 0, 23) || !between(comp[1], 0, 59) || !between(comp[2], 0, 59) || !between(comp[3], 0, 999)) {
            if (hour != 24 || comp[1] != 0 || comp[2] != 0 || comp[3] != 0) return false;  // 24:00 可以
        }
        for (int i = 0; i < 4; ++i) out[i] = comp[i];
        return true;
    }
};

struct DayComposer {
    int comp[3] = {0, 0, 0};
    int index = 0;
    int namedMonth = kNone;
    bool isoDate = false;
    bool isEmpty() const { return index == 0; }
    bool add(int n) {
        if (index >= 3) return false;
        comp[index++] = n;
        return true;
    }
    /// out:年、月(0 起)、日
    bool write(double* out) {
        if (index < 1) return false;
        while (index < 3) comp[index++] = 1;  // 之后 index 恒为 3(V8 原样:下面的 index == 3 / == 1 因此总是 真 / 假)
        int year = 0, month = kNone, day = kNone;
        if (namedMonth == kNone) {
            if (isoDate || (index == 3 && !between(comp[0], 1, 31))) {
                year = comp[0];
                month = comp[1];
                day = comp[2];
            } else {
                month = comp[0];
                day = comp[1];
                if (index == 3) year = comp[2];
            }
        } else {
            month = namedMonth;
            if (index == 1) {
                day = comp[0];
            } else if (!between(comp[0], 1, 31)) {
                year = comp[0];
                day = comp[1];
            } else {
                day = comp[0];
                year = comp[1];
            }
        }
        if (!isoDate) {
            if (between(year, 0, 49)) year += 2000;
            else if (between(year, 50, 99)) year += 1900;
        }
        if (int64_t(year) > kSmiMax || int64_t(year) < -kSmiMax - 1 || !between(month, 1, 12) || !between(day, 1, 31)) return false;
        out[0] = year;
        out[1] = month - 1;
        out[2] = day;
        return true;
    }
};

int readMilliseconds(const Token& t) {
    int number = t.value, length = t.length;
    if (length < 3) {
        if (length == 1) number *= 100;
        else if (length == 2) number *= 10;
    } else if (length > 3) {
        if (length > kMaxSignificantDigits) length = kMaxSignificantDigits;
        int factor = 1;
        do {
            factor *= 10;
            --length;
        } while (length > 3);
        number /= factor;
    }
    return number;
}

Token parseES5DateTime(Tokenizer& scanner, DayComposer& day, TimeComposer& time, TimeZoneComposer& tz) {
    // 日期:[('-'|'+')yy]yyyy[-MM[-DD]]
    if (scanner.peek().isAsciiSign()) {
        const Token signToken = scanner.next();
        if (!scanner.peek().isFixedLengthNumber(6)) return signToken;
        const int sign = signToken.asciiSign();
        const int year = scanner.next().value;
        if (sign < 0 && year == 0) return signToken;
        day.add(sign * year);
    } else if (scanner.peek().isFixedLengthNumber(4)) {
        day.add(scanner.next().value);
    } else {
        return scanner.next();
    }
    if (scanner.skipSymbol(u'-')) {
        if (!scanner.peek().isFixedLengthNumber(2) || !between(scanner.peek().value, 1, 12)) return scanner.next();
        day.add(scanner.next().value);
        if (scanner.skipSymbol(u'-')) {
            if (!scanner.peek().isFixedLengthNumber(2) || !between(scanner.peek().value, 1, 31)) return scanner.next();
            day.add(scanner.next().value);
        }
    }
    // 钟点:THH:mm[:ss[.sss]][Z|±hh:mm|±hhmm]
    if (!scanner.peek().isKeywordType(TIME_SEPARATOR)) {
        if (!scanner.peek().isEndOfInput()) return scanner.next();
    } else {
        scanner.next();
        if (!scanner.peek().isFixedLengthNumber(2) || !between(scanner.peek().value, 0, 24)) return Token{};
        const bool hourIs24 = scanner.peek().value == 24;
        time.add(scanner.next().value);
        if (!scanner.skipSymbol(u':')) return Token{};
        if (!scanner.peek().isFixedLengthNumber(2) || !between(scanner.peek().value, 0, 59) || (hourIs24 && scanner.peek().value > 0)) return Token{};
        time.add(scanner.next().value);
        if (scanner.skipSymbol(u':')) {
            if (!scanner.peek().isFixedLengthNumber(2) || !between(scanner.peek().value, 0, 59) || (hourIs24 && scanner.peek().value > 0)) return Token{};
            time.add(scanner.next().value);
            if (scanner.skipSymbol(u'.')) {
                if (!scanner.peek().isNumber() || (hourIs24 && scanner.peek().value > 0)) return Token{};
                time.add(readMilliseconds(scanner.next()));
            }
        }
        if (scanner.peek().isKeywordZ()) {
            scanner.next();
            tz.set(0);
        } else if (scanner.peek().isSymbol(u'+') || scanner.peek().isSymbol(u'-')) {
            tz.setSign(scanner.next().value == u'+' ? 1 : -1);
            if (scanner.peek().isFixedLengthNumber(4)) {
                const int hourmin = scanner.next().value;
                const int hour = hourmin / 100, min = hourmin % 100;
                if (!between(hour, 0, 23) || !between(min, 0, 59)) return Token{};
                tz.hour = hour;
                tz.minute = min;
            } else {
                if (!scanner.peek().isFixedLengthNumber(2) || !between(scanner.peek().value, 0, 23)) return Token{};
                tz.hour = scanner.next().value;
                if (!scanner.skipSymbol(u':')) return Token{};
                if (!scanner.peek().isFixedLengthNumber(2) || !between(scanner.peek().value, 0, 59)) return Token{};
                tz.minute = scanner.next().value;
            }
        }
        if (!scanner.peek().isEndOfInput()) return Token{};
    }
    // 只有日期按 UTC,带钟点不带时区按本机
    if (tz.isEmpty() && time.isEmpty()) tz.set(0);
    day.isoDate = true;
    return Token::make(kEndOfInputTag, 0, -1);
}

/// out:年 月 日 时 分 秒 毫秒 时区(秒)
bool parse(const QString& str, double* out) {
    InputReader in(str);
    Tokenizer scanner(in);
    TimeZoneComposer tz;
    TimeComposer time;
    DayComposer day;
    const Token unhandled = parseES5DateTime(scanner, day, time, tz);
    if (unhandled.isInvalid()) return false;
    bool hasReadNumber = !day.isEmpty();
    for (Token token = unhandled; !token.isEndOfInput(); token = scanner.next()) {
        if (token.isNumber()) {
            hasReadNumber = true;
            const int n = token.value;
            if (scanner.skipSymbol(u':')) {
                if (scanner.skipSymbol(u':')) {
                    if (!time.isEmpty()) return false;
                    time.add(n);
                    time.add(0);
                } else {
                    if (!time.add(n)) return false;
                    if (scanner.peek().isSymbol(u'.')) scanner.next();
                }
            } else if (scanner.skipSymbol(u'.') && time.isExpecting(n)) {
                time.add(n);
                if (!scanner.peek().isNumber()) return false;
                const int ms = readMilliseconds(scanner.next());
                if (ms < 0) return false;
                time.addFinal(ms);
            } else if (tz.isExpecting(n)) {
                tz.minute = n;
            } else if (time.isExpecting(n)) {
                time.addFinal(n);
                const Token peek = scanner.peek();
                if (!peek.isEndOfInput() && !peek.isWhiteSpace() && !peek.isKeywordZ() && !peek.isAsciiSign()) return false;
            } else {
                if (!day.add(n)) return false;
                scanner.skipSymbol(u'-');
            }
        } else if (token.isKeyword()) {
            if (token.tag == AM_PM && !time.isEmpty()) {
                time.hourOffset = token.value;
            } else if (token.tag == MONTH_NAME) {
                day.namedMonth = token.value;
                scanner.skipSymbol(u'-');
            } else if (token.tag == TIME_ZONE_NAME && hasReadNumber) {
                tz.set(token.value);
            } else {
                if (hasReadNumber) return false;  // 读过数之后不许有乱词
                if (scanner.peek().isNumber()) return false;
            }
        } else if (token.isAsciiSign() && (tz.isUTC() || !time.isEmpty())) {
            tz.setSign(token.asciiSign());
            int n = 0, length = 0;
            if (scanner.peek().isNumber()) {
                const Token t = scanner.next();
                length = t.length;
                n = t.value;
            }
            hasReadNumber = true;
            if (scanner.peek().isSymbol(u':')) {
                tz.hour = n;
                tz.minute = kNone;
            } else if (length == 2 || length == 1) {
                tz.hour = n;
                tz.minute = 0;
            } else if (length == 4 || length == 3) {
                tz.hour = n / 100;
                tz.minute = n % 100;
            } else {
                return false;
            }
        } else if ((token.isAsciiSign() || token.isSymbol(u')')) && hasReadNumber) {
            return false;
        }
        // 别的字符与空白不管
    }
    return day.write(out) && time.write(out + 3) && tz.write(out[7]);
}

double makeDay(double year, double month, double date) {
    if (!(year >= -1000000 && year <= 1000000 && month >= -10000000 && month <= 10000000 && std::isfinite(date))) return kNaN;
    int y = int(year), m = int(month);
    y += m / 12;
    m %= 12;
    if (m < 0) {
        m += 12;
        y -= 1;
    }
    constexpr int kYearDelta = 399999;
    constexpr int kBaseDay = 365 * (1970 + kYearDelta) + (1970 + kYearDelta) / 4 - (1970 + kYearDelta) / 100 + (1970 + kYearDelta) / 400;
    int dayFromYear = 365 * (y + kYearDelta) + (y + kYearDelta) / 4 - (y + kYearDelta) / 100 + (y + kYearDelta) / 400 - kBaseDay;
    static constexpr int common[] = {0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334};
    static constexpr int leap[] = {0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335};
    dayFromYear += ((y % 4 != 0) || (y % 100 == 0 && y % 400 != 0)) ? common[m] : leap[m];
    return double(dayFromYear - 1) + std::trunc(date);
}

double timeClip(double t) {
    if (!std::isfinite(t) || std::fabs(t) > kMaxTimeInMs) return kNaN;
    return std::trunc(t) + 0.0;
}

}  // namespace

const QTimeZone& systemZone() {
    static const QTimeZone zone = QTimeZone::systemTimeZone();
    return zone;
}

double v8DateParse(const QString& s, const QTimeZone& local) {
    double out[8];
    if (!parse(s, out)) return kNaN;
    const double day = makeDay(out[0], out[1], out[2]);
    const double time = out[3] * 3600000.0 + out[4] * 60000.0 + out[5] * 1000.0 + out[6];
    double date = std::isfinite(day) && std::isfinite(time) ? day * 86400000.0 + time : kNaN;
    if (std::isnan(out[7])) {
        if (!(date >= -kMaxTimeBeforeUTCInMs && date <= kMaxTimeBeforeUTCInMs)) return kNaN;
        // 本机墙钟 → UTC
        const qint64 ms = qint64(date);
        const QDateTime wall = QDateTime::fromMSecsSinceEpoch(ms, QTimeZone::UTC);
        const QDateTime at(wall.date(), wall.time(), local);
        date = double(at.toMSecsSinceEpoch());
    } else {
        date -= out[7] * 1000.0;
        if (!(date >= -kMaxTimeInMs && date <= kMaxTimeInMs)) return kNaN;
    }
    return timeClip(date);
}

}  // namespace ibkr::util
