#include "util/ordered_json.h"

#include "util/jsformat.h"
#include "util/jsvalue.h"

#include <QJsonArray>
#include <QJsonObject>

#include <QHash>

#include <algorithm>
#include <cmath>

using namespace Qt::StringLiterals;

namespace ibkr::util {

const OJson* OJson::get(const QString& key) const {
    for (const auto& [k, v] : fields)
        if (k == key) return &v;
    return nullptr;
}

OJson* OJson::get(const QString& key) {
    for (auto& [k, v] : fields)
        if (k == key) return &v;
    return nullptr;
}

std::optional<quint32> jsArrayIndex(const QString& key) {
    // 规范的数组下标:"0",或不以 0 开头的十进制,值 < 2^32 − 1
    if (key.isEmpty() || key.size() > 10 || (key.size() > 1 && key[0] == u'0')) return std::nullopt;
    quint64 n = 0;
    for (QChar c : key) {
        if (c < u'0' || c > u'9') return std::nullopt;
        n = n * 10 + (c.unicode() - u'0');
    }
    if (n >= 4294967295ULL) return std::nullopt;
    return quint32(n);
}

void OJson::set(const QString& key, const OJson& value) {
    if (OJson* v = get(key)) {
        *v = value;
        return;
    }
    // JS 对象的键序:像数组下标的键按数值排在最前,其余按加进来的先后(JSON.parse、Object.keys、JSON.stringify 都是这个次序)
    if (const auto idx = jsArrayIndex(key)) {
        qsizetype at = 0;
        while (at < fields.size()) {
            const auto other = jsArrayIndex(fields[at].first);
            if (!other || *other > *idx) break;
            ++at;
        }
        fields.insert(at, {key, value});
        return;
    }
    fields.append({key, value});
}

void OJson::remove(const QString& key) {
    fields.removeIf([&key](const QPair<QString, OJson>& f) { return f.first == key; });
}

QJsonValue OJson::toQJson() const {
    switch (type) {
    case Null: return QJsonValue();
    case Bool: return b;
    case Number: return n;
    case String: return s;
    case Array: {
        QJsonArray a;
        for (const OJson& x : items) a.append(x.toQJson());
        return a;
    }
    case Object: {
        QJsonObject o;
        for (const auto& [k, v] : fields) o.insert(k, v.toQJson());
        return o;
    }
    }
    return {};
}

QJsonValue OJson::toQJsonKeyed() const {
    if (type == Array) {
        QJsonArray a;
        for (const OJson& x : items) a.append(x.toQJsonKeyed());
        return a;
    }
    if (type != Object) return toQJson();
    QJsonObject o;
    QJsonArray keys;
    for (const auto& [k, v] : fields) {
        o.insert(k, v.toQJsonKeyed());
        if (!keys.contains(k)) keys.append(k);
    }
    if (keys.size() > 1) o.insert(u"__keys"_s, keys);
    return o;
}

OJson OJson::fromQJson(const QJsonValue& v) {
    OJson o;
    if (v.isBool()) return boolean(v.toBool());
    if (v.isDouble()) return number(v.toDouble());
    if (v.isString()) return string(v.toString());
    if (v.isArray()) {
        o.type = Array;
        for (const QJsonValue& x : v.toArray()) o.items.append(fromQJson(x));
    } else if (v.isObject()) {
        o.type = Object;
        const QJsonObject obj = v.toObject();
        for (auto it = obj.begin(); it != obj.end(); ++it) o.set(it.key(), fromQJson(it.value()));
    }
    return o;
}

namespace {

/// OJson::set 逐个加键的结果,一次排好:像数组下标的键("0"、"7"、"10")按数值排在最前,其余按第一次出现的先后(键已去重)
QList<QPair<QString, OJson>> orderedLikeJs(QList<QPair<QString, OJson>>&& entries) {
    QList<std::pair<quint32, qsizetype>> indexed;
    for (qsizetype i = 0; i < entries.size(); ++i)
        if (const auto idx = jsArrayIndex(entries[i].first)) indexed.append({*idx, i});
    if (indexed.isEmpty()) return std::move(entries);
    std::sort(indexed.begin(), indexed.end());  // 键不重复,数值互不相同
    QList<QPair<QString, OJson>> out;
    out.reserve(entries.size());
    QList<bool> taken(entries.size(), false);
    for (const auto& [n, i] : indexed) {
        out.append(std::move(entries[i]));
        taken[i] = true;
    }
    for (qsizetype i = 0; i < entries.size(); ++i)
        if (!taken[i]) out.append(std::move(entries[i]));
    return out;
}

class Parser {
public:
    explicit Parser(const QString& t) : t_(t) {}
    std::optional<OJson> run(QString* error) {
        skip();
        auto v = value();
        if (v) {
            skip();
            if (i_ != t_.size()) v.reset(), fail(u"多出来的内容"_s);
        }
        if (!v && error) *error = u"第 %1 个字符附近:%2"_s.arg(i_ + 1).arg(err_);
        return v;
    }

private:
    void fail(const QString& why) { if (err_.isEmpty()) err_ = why; }
    // JSON 认的空白只有这四个(JSON.parse 同)
    void skip() { while (i_ < t_.size() && (t_[i_] == u' ' || t_[i_] == u'\t' || t_[i_] == u'\n' || t_[i_] == u'\r')) ++i_; }
    bool eat(QStringView word) {
        if (QStringView(t_).mid(i_).startsWith(word)) { i_ += word.size(); return true; }
        return false;
    }
    std::optional<OJson> value() {
        if (i_ >= t_.size()) return fail(u"内容不完整"_s), std::nullopt;
        const QChar c = t_[i_];
        if (c == u'{') return object();
        if (c == u'[') return array();
        if (c == u'"') { auto s = str(); if (!s) return std::nullopt; return OJson::string(*s); }
        if (eat(u"true")) return OJson::boolean(true);
        if (eat(u"false")) return OJson::boolean(false);
        if (eat(u"null")) return OJson::null();
        if (c == u'-' || c.isDigit()) return number();
        return fail(u"认不出的字符「%1」"_s.arg(c)), std::nullopt;
    }
    std::optional<OJson> number() {
        const qsizetype start = i_;
        if (t_[i_] == u'-') ++i_;
        const auto digits = [this] { qsizetype n = 0; while (i_ < t_.size() && t_[i_] >= u'0' && t_[i_] <= u'9') ++i_, ++n; return n; };
        if (i_ < t_.size() && t_[i_] == u'0') ++i_;
        else if (digits() == 0) return fail(u"数字写得不对"_s), std::nullopt;
        if (i_ < t_.size() && t_[i_] == u'.') { ++i_; if (digits() == 0) return fail(u"数字写得不对"_s), std::nullopt; }
        if (i_ < t_.size() && (t_[i_] == u'e' || t_[i_] == u'E')) {
            ++i_;
            if (i_ < t_.size() && (t_[i_] == u'+' || t_[i_] == u'-')) ++i_;
            if (digits() == 0) return fail(u"数字写得不对"_s), std::nullopt;
        }
        bool ok = false;
        double v = QStringView(t_).mid(start, i_ - start).toDouble(&ok);
        if (!ok) {
            // 文法上已经查过是个合法的数,toDouble 说失败只有一种原因:超出 double 的范围。
            // 上溢(1e999):JSON.parse 给 ±Infinity;下溢(1e-400):给 ±0(符号留着)。Qt 失败时给的就是这两个值,这里不靠它,按值分开写明
            const bool negative = t_[start] == u'-';
            v = std::isinf(v) ? (negative ? -INFINITY : INFINITY) : (negative ? -0.0 : 0.0);
        }
        return OJson::number(v);
    }
    std::optional<QString> str() {
        ++i_;
        QString out;
        while (i_ < t_.size()) {
            const QChar c = t_[i_++];
            if (c == u'"') return out;
            if (c.unicode() < 0x20) return fail(u"字符串里有控制字符"_s), std::nullopt;
            if (c != u'\\') { out += c; continue; }
            if (i_ >= t_.size()) break;
            const QChar e = t_[i_++];
            switch (e.unicode()) {
            case '"': out += u'"'; break;
            case '\\': out += u'\\'; break;
            case '/': out += u'/'; break;
            case 'b': out += u'\b'; break;
            case 'f': out += u'\f'; break;
            case 'n': out += u'\n'; break;
            case 'r': out += u'\r'; break;
            case 't': out += u'\t'; break;
            case 'u': {
                // 逐位查:QString::toUInt 会放过首尾空白与正负号("00e\r"),JSON.parse 不放
                bool ok = i_ + 4 <= t_.size();
                for (qsizetype k = 0; ok && k < 4; ++k) {
                    const char16_t h = t_[i_ + k].unicode();
                    ok = (h >= u'0' && h <= u'9') || (h >= u'a' && h <= u'f') || (h >= u'A' && h <= u'F');
                }
                if (!ok) return fail(u"\\u 后面不是四位十六进制"_s), std::nullopt;
                const uint code = QStringView(t_).mid(i_, 4).toUInt(nullptr, 16);
                out += QChar(char16_t(code));
                i_ += 4;
                break;
            }
            default: return fail(u"认不出的转义"_s), std::nullopt;
            }
        }
        return fail(u"字符串没有收尾"_s), std::nullopt;
    }
    /// 进一层数组 / 对象;太深就记一笔失败(出口处 leave() 配对)
    bool enter() {
        if (++depth_ > kMaxJsonDepth) return fail(u"嵌套太深"_s), false;
        return true;
    }
    void leave() { --depth_; }
    std::optional<OJson> array() {
        if (!enter()) return std::nullopt;
        struct Leave { Parser* p; ~Leave() { p->leave(); } } leaveGuard{this};
        ++i_;
        OJson o;
        o.type = OJson::Array;
        skip();
        if (i_ < t_.size() && t_[i_] == u']') { ++i_; return o; }
        for (;;) {
            skip();
            auto v = value();
            if (!v) return std::nullopt;
            o.items.append(std::move(*v));
            skip();
            if (i_ < t_.size() && t_[i_] == u',') { ++i_; continue; }
            if (i_ < t_.size() && t_[i_] == u']') { ++i_; return o; }
            return fail(u"数组里少了逗号或 ]"_s), std::nullopt;
        }
    }
    std::optional<OJson> object() {
        if (!enter()) return std::nullopt;
        struct Leave { Parser* p; ~Leave() { p->leave(); } } leaveGuard{this};
        ++i_;
        OJson o;
        o.type = OJson::Object;
        skip();
        if (i_ < t_.size() && t_[i_] == u'}') { ++i_; return o; }
        QList<QPair<QString, OJson>> entries;  // 按第一次出现的先后
        QHash<QString, qsizetype> where;
        for (;;) {
            skip();
            if (i_ >= t_.size() || t_[i_] != u'"') return fail(u"键要用双引号"_s), std::nullopt;
            auto key = str();
            if (!key) return std::nullopt;
            skip();
            if (i_ >= t_.size() || t_[i_] != u':') return fail(u"键后面少了冒号"_s), std::nullopt;
            ++i_;
            skip();
            auto v = value();
            if (!v) return std::nullopt;
            // 重复的键:值取后一个、位置留在第一次出现处(同 JSON.parse)。哈希找位置,不像 OJson::set 那样线性扫(几万个不同的键会二次方地慢)
            if (const auto hit = where.constFind(*key); hit != where.constEnd()) {
                entries[*hit].second = std::move(*v);
            } else {
                where.insert(*key, entries.size());
                entries.append({std::move(*key), std::move(*v)});
            }
            skip();
            if (i_ < t_.size() && t_[i_] == u',') { ++i_; continue; }
            if (i_ < t_.size() && t_[i_] == u'}') { ++i_; o.fields = orderedLikeJs(std::move(entries)); return o; }
            return fail(u"对象里少了逗号或 }"_s), std::nullopt;
        }
    }

    const QString& t_;
    qsizetype i_ = 0;
    int depth_ = 0;
    QString err_;
};

void write(QString& out, const OJson& v, int indent, int depth) {
    const QString pad = QString(indent * (depth + 1), u' ');
    const QString close = QString(indent * depth, u' ');
    switch (v.type) {
    case OJson::Null: out += u"null"_s; return;
    case OJson::Bool: out += v.b ? u"true"_s : u"false"_s; return;
    case OJson::Number: out += std::isfinite(v.n) ? jsNumberToString(v.n) : u"null"_s; return;
    case OJson::String: out += jsonQuote(v.s); return;
    case OJson::Array:
        if (v.items.isEmpty()) { out += u"[]"_s; return; }
        out += u'[';
        for (qsizetype i = 0; i < v.items.size(); ++i) {
            if (i) out += u',';
            if (indent) out += u'\n' + pad;
            write(out, v.items[i], indent, depth + 1);
        }
        if (indent) out += u'\n' + close;
        out += u']';
        return;
    case OJson::Object:
        if (v.fields.isEmpty()) { out += u"{}"_s; return; }
        out += u'{';
        for (qsizetype i = 0; i < v.fields.size(); ++i) {
            if (i) out += u',';
            if (indent) out += u'\n' + pad;
            out += jsonQuote(v.fields[i].first) + (indent ? u": "_s : u":"_s);
            write(out, v.fields[i].second, indent, depth + 1);
        }
        if (indent) out += u'\n' + close;
        out += u'}';
        return;
    }
}

}  // namespace

std::optional<OJson> parseOJson(const QString& text, QString* error) { return Parser(text).run(error); }

QString stringifyOJson(const OJson& value, int indent) {
    QString out;
    write(out, value, indent, 0);
    return out;
}

}  // namespace ibkr::util
