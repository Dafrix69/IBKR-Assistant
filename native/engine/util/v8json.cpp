#include "util/v8json.h"

using namespace Qt::StringLiterals;

namespace ibkr::util {

namespace {

enum class Tok { Eos, Whitespace, String, Number, Literal, LBrace, RBrace, LBrack, RBrack, Colon, Comma, Illegal };

Tok tokenOf(char16_t c) {
    switch (c) {
    case u' ': case u'\t': case u'\n': case u'\r': return Tok::Whitespace;
    case u'"': return Tok::String;
    case u'-': case u'0': case u'1': case u'2': case u'3': case u'4': case u'5': case u'6': case u'7': case u'8': case u'9': return Tok::Number;
    case u't': case u'f': case u'n': return Tok::Literal;
    case u'{': return Tok::LBrace;
    case u'}': return Tok::RBrace;
    case u'[': return Tok::LBrack;
    case u']': return Tok::RBrack;
    case u':': return Tok::Colon;
    case u',': return Tok::Comma;
    default: return Tok::Illegal;
    }
}

struct Fail {
    QString message;
};

class Scanner {
public:
    explicit Scanner(const QString& t) : s_(t) {}

    void run() {
        value();
        skipWs();
        if (!atEnd()) throw Fail{u"Unexpected non-whitespace character after JSON"_s + where()};
    }

private:
    static constexpr int kMaxContext = 10;
    static constexpr int kMinLengthForContext = kMaxContext * 2 + 1;

    const QString& s_;
    qsizetype i_ = 0;

    bool atEnd() const { return i_ >= s_.size(); }
    char16_t cur() const { return s_[i_].unicode(); }
    Tok peek() const { return atEnd() ? Tok::Eos : tokenOf(cur()); }
    void skipWs() {
        while (!atEnd() && tokenOf(cur()) == Tok::Whitespace) ++i_;
    }

    QString where() const {
        // 行列:只认 \r 与 \n,\r\n 算一个
        int line = 1;
        qsizetype lastBreak = 0, c = 0;
        for (; c < i_; ++c) {
            if (s_[c] == u'\r' && c < i_ - 1 && s_[c + 1] == u'\n') ++c;
            if (s_[c] == u'\r' || s_[c] == u'\n') {
                ++line;
                lastBreak = c + 1;
            }
        }
        return u" at position %1 (line %2 column %3)"_s.arg(i_).arg(line).arg(1 + c - lastBreak);
    }

    /// 带话的错:话 + 位置
    [[noreturn]] void report(const QString& what) const { throw Fail{what + u" in JSON"_s + where()}; }

    /// 没有给话的错:按此处的记号定
    [[noreturn]] void unexpected(Tok t) const {
        switch (t) {
        case Tok::Eos: throw Fail{u"Unexpected end of JSON input"_s};
        case Tok::Number: throw Fail{u"Unexpected number in JSON"_s + where()};
        case Tok::String: throw Fail{u"Unexpected string in JSON"_s + where()};
        default: break;
        }
        if (s_ == u"NaN" || s_ == u"Infinity" || s_ == u"undefined" || s_ == u"[object Object]") throw Fail{u"\"%1\" is not valid JSON"_s.arg(s_)};
        const QString ch(s_[i_]);
        const qsizetype len = s_.size();
        if (len < kMinLengthForContext) throw Fail{u"Unexpected token '%1', \"%2\" is not valid JSON"_s.arg(ch, s_)};
        if (i_ < kMaxContext) throw Fail{u"Unexpected token '%1', \"%2\"... is not valid JSON"_s.arg(ch, s_.left(i_ + kMaxContext))};
        if (i_ < len - kMaxContext) throw Fail{u"Unexpected token '%1', ...\"%2\"... is not valid JSON"_s.arg(ch, s_.mid(i_ - kMaxContext, 2 * kMaxContext))};
        throw Fail{u"Unexpected token '%1', ...\"%2\" is not valid JSON"_s.arg(ch, s_.mid(i_ - kMaxContext))};
    }

    void expect(Tok t, const QString& what) {
        skipWs();
        if (peek() != t) report(what);
    }

    void value() {
        skipWs();
        switch (peek()) {
        case Tok::String: string(); return;
        case Tok::Number: number(); return;
        case Tok::Literal: literal(); return;
        case Tok::LBrace: object(); return;
        case Tok::LBrack: array(); return;
        default: unexpected(peek());
        }
    }

    void literal() {
        const QString word = cur() == u't' ? u"true"_s : cur() == u'f' ? u"false"_s : u"null"_s;
        ++i_;
        for (qsizetype k = 1; k < word.size(); ++k) {
            if (atEnd()) unexpected(Tok::Eos);
            if (cur() != word[k].unicode()) unexpected(tokenOf(cur()));
            ++i_;
        }
    }

    static bool digit(char16_t c) { return c >= u'0' && c <= u'9'; }
    static bool hex(char16_t c) { return digit(c) || (c >= u'a' && c <= u'f') || (c >= u'A' && c <= u'F'); }

    void number() {
        if (cur() == u'-') {
            ++i_;
            if (atEnd() || !digit(cur())) report(u"No number after minus sign"_s);
        }
        if (cur() == u'0') {
            ++i_;
            if (!atEnd() && digit(cur())) unexpected(Tok::Number);
        } else {
            while (!atEnd() && digit(cur())) ++i_;
        }
        if (!atEnd() && cur() == u'.') {
            ++i_;
            if (atEnd() || !digit(cur())) report(u"Unterminated fractional number"_s);
            while (!atEnd() && digit(cur())) ++i_;
        }
        if (!atEnd() && (cur() == u'e' || cur() == u'E')) {
            ++i_;
            if (!atEnd() && (cur() == u'+' || cur() == u'-')) ++i_;
            if (atEnd() || !digit(cur())) report(u"Exponent part is missing a number"_s);
            while (!atEnd() && digit(cur())) ++i_;
        }
    }

    void string() {
        ++i_;  // 开头的引号
        for (;;) {
            if (atEnd()) report(u"Unterminated string"_s);
            const char16_t c = cur();
            if (c == u'"') {
                ++i_;
                return;
            }
            if (c < 0x20) report(u"Bad control character in string literal"_s);
            if (c != u'\\') {
                ++i_;
                continue;
            }
            ++i_;
            if (atEnd()) unexpected(Tok::Eos);
            switch (cur()) {
            case u'"': case u'\\': case u'/': case u'b': case u'f': case u'n': case u'r': case u't': ++i_; break;
            case u'u':
                ++i_;
                for (int k = 0; k < 4; ++k) {
                    if (atEnd() || !hex(cur())) report(u"Bad Unicode escape"_s);
                    ++i_;
                }
                break;
            default:
                // 反斜杠后面是 Latin-1 以外的字:V8 不说"转义不对",按非法记号报
                if (cur() > 0xFF) unexpected(Tok::Illegal);
                report(u"Bad escaped character"_s);
            }
        }
    }

    void object() {
        ++i_;
        skipWs();
        if (peek() == Tok::RBrace) {
            ++i_;
            return;
        }
        expect(Tok::String, u"Expected property name or '}'"_s);
        for (;;) {
            string();
            expect(Tok::Colon, u"Expected ':' after property name"_s);
            ++i_;
            value();
            skipWs();
            if (peek() == Tok::Comma) {
                ++i_;
                expect(Tok::String, u"Expected double-quoted property name"_s);
                continue;
            }
            expect(Tok::RBrace, u"Expected ',' or '}' after property value"_s);
            ++i_;
            return;
        }
    }

    void array() {
        ++i_;
        skipWs();
        if (peek() == Tok::RBrack) {
            ++i_;
            return;
        }
        for (;;) {
            value();
            skipWs();
            if (peek() == Tok::Comma) {
                ++i_;
                continue;
            }
            expect(Tok::RBrack, u"Expected ',' or ']' after array element"_s);
            ++i_;
            return;
        }
    }
};

}  // namespace

std::optional<QString> v8JsonParseError(const QString& text) {
    try {
        Scanner(text).run();
    } catch (const Fail& f) {
        return f.message;
    }
    return std::nullopt;
}

}  // namespace ibkr::util
