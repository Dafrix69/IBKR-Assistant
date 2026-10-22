#include "util/pyjson.h"

#include "util/error.h"
#include "util/jsformat.h"
#include "util/jsnum.h"

#include <QJsonArray>
#include <QJsonObject>
#include <QRegularExpression>

#include <algorithm>
#include <cmath>

namespace ibkr::util {

using namespace Qt::StringLiterals;

namespace {

struct Parser {
    const QString& text;
    qsizetype i = 0;

    QChar at(qsizetype k) const { return k < text.size() ? text[k] : QChar(); }
    bool isDigit(qsizetype k) const { return k < text.size() && text[k] >= u'0' && text[k] <= u'9'; }
    void skipWs() {
        while (i < text.size() && (text[i] == u' ' || text[i] == u'\t' || text[i] == u'\n' || text[i] == u'\r')) ++i;
    }

    JVal value() {
        skipWs();
        const QChar ch = at(i);
        if (ch == u'{') return object();
        if (ch == u'[') return array();
        if (ch == u'"') {
            JVal v;
            v.kind = JVal::Str;
            v.text = string();
            return v;
        }
        if (QStringView(text).mid(i).startsWith(u"true")) {
            i += 4;
            JVal v;
            v.kind = JVal::Bool;
            v.boolean = true;
            return v;
        }
        if (QStringView(text).mid(i).startsWith(u"false")) {
            i += 5;
            JVal v;
            v.kind = JVal::Bool;
            return v;
        }
        if (QStringView(text).mid(i).startsWith(u"null")) {
            i += 4;
            return {};
        }
        const qsizetype start = i;
        if (at(i) == u'-') ++i;
        while (isDigit(i)) ++i;
        bool isFloat = false;
        if (at(i) == u'.') {
            isFloat = true;
            ++i;
            while (isDigit(i)) ++i;
        }
        if (at(i) == u'e' || at(i) == u'E') {
            isFloat = true;
            ++i;
            if (at(i) == u'+' || at(i) == u'-') ++i;
            while (isDigit(i)) ++i;
        }
        const QString raw = text.mid(start, i - start);
        if (raw.isEmpty() || raw == u"-") throw JsError(u"JSON 解析失败于位置 %1"_s.arg(start));
        JVal v;
        if (isFloat) {
            v.kind = JVal::Float;
            v.number = jsStringToNumber(raw);
        } else {
            v.kind = JVal::Int;
            v.text = raw;
        }
        return v;
    }

    QString string() {
        ++i;  // "
        QString out;
        while (i < text.size()) {
            const QChar ch = text[i];
            if (ch == u'"') {
                ++i;
                return out;
            }
            if (ch == u'\\') {
                const QChar esc = at(i + 1);
                i += 2;
                if (esc == u'u') {
                    // String.fromCharCode(parseInt(4 位, 16)):读不出是 NaN → U+0000;数按 ToUint16 截
                    const double code = jsParseInt(QStringView(text).mid(i, 4), 16);
                    out += QChar(char16_t(std::isnan(code) ? 0 : static_cast<std::uint32_t>(static_cast<std::int64_t>(code)) & 0xFFFF));
                    i += 4;
                } else if (esc == u'"') out += u'"';
                else if (esc == u'\\') out += u'\\';
                else if (esc == u'/') out += u'/';
                else if (esc == u'b') out += u'\b';
                else if (esc == u'f') out += u'\f';
                else if (esc == u'n') out += u'\n';
                else if (esc == u'r') out += u'\r';
                else if (esc == u't') out += u'\t';
                else if (!esc.isNull()) out += esc;
                else out += u"undefined"_s;  // text[i + 1] 越界时 TS 拼的是 undefined
            } else {
                out += ch;
                ++i;
            }
        }
        throw JsError(u"JSON 字符串未闭合"_s);
    }

    JVal array() {
        ++i;
        JVal v;
        v.kind = JVal::Arr;
        skipWs();
        if (at(i) == u']') {
            ++i;
            return v;
        }
        for (;;) {
            v.items.push_back(value());
            skipWs();
            if (at(i) == u',') {
                ++i;
                continue;
            }
            if (at(i) == u']') {
                ++i;
                return v;
            }
            throw JsError(u"JSON 数组解析失败于位置 %1"_s.arg(i));
        }
    }

    JVal object() {
        ++i;
        JVal v;
        v.kind = JVal::Obj;
        skipWs();
        if (at(i) == u'}') {
            ++i;
            return v;
        }
        for (;;) {
            skipWs();
            const QString key = string();
            skipWs();
            if (at(i) != u':') throw JsError(u"JSON 对象缺少冒号于位置 %1"_s.arg(i));
            ++i;
            v.entries.emplace_back(key, value());
            skipWs();
            if (at(i) == u',') {
                ++i;
                continue;
            }
            if (at(i) == u'}') {
                ++i;
                return v;
            }
            throw JsError(u"JSON 对象解析失败于位置 %1"_s.arg(i));
        }
    }
};

/// Python repr(float):整数值带 .0,其余最短表示(指数补到两位)
QString floatRepr(double v) {
    if (std::isfinite(v) && std::trunc(v) == v && std::fabs(v) < 1e16) return jsNumberToString(v) + u".0"_s;
    const QString s = jsNumberToString(v);
    static const QRegularExpression sci(u"^(-?[\\d.]+)e([+-])(\\d+)\\z"_s);
    const auto m = sci.match(s);
    if (m.hasMatch()) return m.captured(1) + u'e' + m.captured(2) + m.captured(3).rightJustified(2, u'0');
    return s;
}

QString escapeStr(const QString& s) {
    QString out = u"\""_s;
    for (const QChar ch : s) {
        const char16_t code = ch.unicode();
        if (ch == u'"') out += u"\\\""_s;
        else if (ch == u'\\') out += u"\\\\"_s;
        else if (ch == u'\n') out += u"\\n"_s;
        else if (ch == u'\r') out += u"\\r"_s;
        else if (ch == u'\t') out += u"\\t"_s;
        else if (ch == u'\b') out += u"\\b"_s;
        else if (ch == u'\f') out += u"\\f"_s;
        else if (code < 0x20) out += u"\\u"_s + QString::number(code, 16).rightJustified(4, u'0');
        else out += ch;
    }
    return out + u'"';
}

QString dumps(const JVal& v, bool sorted) {
    switch (v.kind) {
    case JVal::Null: return u"null"_s;
    case JVal::Bool: return v.boolean ? u"true"_s : u"false"_s;
    case JVal::Int: return jsNumberToString(jsStringToNumber(v.text));
    case JVal::Float: return floatRepr(v.number);
    case JVal::Str: return escapeStr(v.text);
    case JVal::Arr: {
        QStringList parts;
        for (const JVal& x : v.items) parts << dumps(x, sorted);
        return u'[' + parts.join(u", "_s) + u']';
    }
    case JVal::Obj: {
        std::vector<const std::pair<QString, JVal>*> order;
        for (const auto& e : v.entries) order.push_back(&e);
        // 按 UTF-16 码元比(同 JS 的 < 与 Python 对 BMP 内字符的序);相等的保持原来的先后
        if (sorted) std::stable_sort(order.begin(), order.end(), [](auto* a, auto* b) { return QStringView(a->first).compare(QStringView(b->first), Qt::CaseSensitive) < 0; });
        QStringList parts;
        for (const auto* e : order) parts << escapeStr(e->first) + u": "_s + dumps(e->second, sorted);
        return u'{' + parts.join(u", "_s) + u'}';
    }
    }
    return {};
}

}  // namespace

JVal parseJson(const QString& text) {
    Parser p{text};
    JVal out = p.value();
    p.skipWs();
    return out;
}

QJsonValue toPlain(const JVal& v) {
    switch (v.kind) {
    case JVal::Null: return QJsonValue::Null;
    case JVal::Bool: return v.boolean;
    case JVal::Int: return jsStringToNumber(v.text);
    case JVal::Float: return v.number;
    case JVal::Str: return v.text;
    case JVal::Arr: {
        QJsonArray out;
        for (const JVal& x : v.items) out.append(toPlain(x));
        return out;
    }
    case JVal::Obj: {
        QJsonObject out;
        for (const auto& [k, val] : v.entries) out.insert(k, toPlain(val));  // 同名键后一个盖前一个,同 JS
        return out;
    }
    }
    return {};
}

OJson toPlainOJson(const JVal& v) {
    switch (v.kind) {
    case JVal::Null: return OJson::null();
    case JVal::Bool: return OJson::boolean(v.boolean);
    case JVal::Int: return OJson::number(jsStringToNumber(v.text));
    case JVal::Float: return OJson::number(v.number);
    case JVal::Str: return OJson::string(v.text);
    case JVal::Arr: {
        OJson out;
        out.type = OJson::Array;
        for (const JVal& x : v.items) out.items.append(toPlainOJson(x));
        return out;
    }
    case JVal::Obj: {
        OJson out;
        out.type = OJson::Object;
        for (const auto& [k, val] : v.entries) out.set(k, toPlainOJson(val));  // 同名键:值换成后一个,位置留在第一次出现处,同 JS
        return out;
    }
    }
    return {};
}

QString pyDumps(const JVal& v) { return dumps(v, false); }
QString pyDumpsSorted(const JVal& v) { return dumps(v, true); }

}  // namespace ibkr::util
