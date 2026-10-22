#include "util/jsobj.h"

#include "util/error.h"
#include "util/jsformat.h"
#include "util/py.h"
#include "util/v8json.h"

#include <algorithm>
#include <cmath>

using namespace Qt::StringLiterals;

namespace ibkr::util::js {

const OJson* prop(const OJson* v, const QString& key) {
    if (!v) return nullptr;
    if (v->type == OJson::Object) return v->get(key);
    if (v->type == OJson::Array) {
        if (const auto i = jsArrayIndex(key); i && *i < quint32(v->items.size())) return &v->items[qsizetype(*i)];
    }
    return nullptr;
}

OJson* propMut(OJson* v, const QString& key) {
    if (!v) return nullptr;
    if (v->type == OJson::Object) return v->get(key);
    if (v->type == OJson::Array) {
        if (const auto i = jsArrayIndex(key); i && *i < quint32(v->items.size())) return &v->items[qsizetype(*i)];
    }
    return nullptr;
}

const OJson* path(const OJson* v, std::initializer_list<QString> keys) {
    for (const QString& k : keys) v = prop(v, k);
    return v;
}

QString str(const OJson* v) {
    if (!v) return u"undefined"_s;
    switch (v->type) {
    case OJson::Null: return u"null"_s;
    case OJson::Bool: return v->b ? u"true"_s : u"false"_s;
    case OJson::Number: return jsNumberToString(v->n);
    case OJson::String: return v->s;
    case OJson::Array: {
        QStringList parts;
        for (const OJson& x : v->items) parts << (x.type == OJson::Null ? QString() : str(&x));
        return parts.join(u',');
    }
    case OJson::Object: return u"[object Object]"_s;
    }
    return {};
}

double num(const OJson* v) {
    if (!v) return std::nan("");
    switch (v->type) {
    case OJson::Null: return 0;
    case OJson::Bool: return v->b ? 1 : 0;
    case OJson::Number: return v->n;
    case OJson::String: return jsStringToNumber(v->s);
    case OJson::Array: return jsStringToNumber(str(v));
    case OJson::Object: return std::nan("");
    }
    return std::nan("");
}

bool truthy(const OJson* v) {
    if (nullish(v)) return false;
    switch (v->type) {
    case OJson::Bool: return v->b;
    case OJson::Number: return v->n != 0 && !std::isnan(v->n);
    case OJson::String: return !v->s.isEmpty();
    default: return true;
    }
}

bool pyTruthy(const OJson* v) {
    if (nullish(v)) return false;
    switch (v->type) {
    case OJson::Bool: return v->b;
    case OJson::Number: return v->n != 0;
    case OJson::String: return !v->s.isEmpty();
    case OJson::Array: return !v->items.isEmpty();
    default: return true;
    }
}

std::optional<double> finiteOrNull(const OJson* v) {
    if (nullish(v) || isBool(v)) return std::nullopt;
    const double n = num(v);
    return std::isfinite(n) ? std::optional<double>(n) : std::nullopt;
}

bool strictEqual(const OJson* a, const OJson* b) {
    if (!a || !b) return !a && !b;
    if (a->type != b->type) return false;
    switch (a->type) {
    case OJson::Null: return true;
    case OJson::Bool: return a->b == b->b;
    case OJson::Number: return a->n == b->n;
    case OJson::String: return a->s == b->s;
    default: return false;
    }
}

QString pyG(const OJson* v) {
    if (isNum(v)) return util::pyG(v->n);
    return num(v) > 0 ? u"inf"_s : u"-inf"_s;
}

QString strOr(const OJson* v, const QString& fallback) { return nullish(v) ? fallback : str(v); }

QStringList keys(const OJson* v) {
    QStringList out;
    if (!v) return out;
    if (v->type == OJson::Object) {
        for (const auto& f : v->fields) out << f.first;
    } else if (v->type == OJson::Array) {
        for (qsizetype i = 0; i < v->items.size(); ++i) out << QString::number(i);
    } else if (v->type == OJson::String) {
        for (qsizetype i = 0; i < v->s.size(); ++i) out << QString::number(i);
    }
    return out;
}

QString stringify(const OJson& v) { return stringifyOJson(v, 0); }

OJson sortKeys(const OJson& v) {
    if (v.type == OJson::Array) {
        OJson out = v;
        for (OJson& x : out.items) x = sortKeys(x);
        return out;
    }
    if (v.type == OJson::Object) {
        QStringList ks;
        for (const auto& f : v.fields) ks << f.first;
        std::sort(ks.begin(), ks.end());
        OJson out;
        out.type = OJson::Object;
        // TS 的 out[key] = …:键名是 __proto__ 时改的是原型,JSON.stringify 里就没有这一键
        for (const QString& k : ks)
            if (k != u"__proto__") out.set(k, sortKeys(*v.get(k)));
        return out;
    }
    return v;
}

std::optional<OJson> parse(const QString& text) { return parseOJson(text); }

OJson parseOrThrow(const QString& text) {
    if (const auto why = v8JsonParseError(text)) throw JsError(*why);
    // parseOJson 设了嵌套深度上限(kMaxJsonDepth),V8 没有:超过的当栈溢出报,不去解空值
    auto parsed = parseOJson(text);
    if (!parsed) throw JsError(u"Maximum call stack size exceeded"_s);
    return std::move(*parsed);
}

const OJson* propStrict(const OJson* v, const QString& key) {
    if (nullish(v)) throw JsError(u"Cannot read properties of %1 (reading '%2')"_s.arg(v ? u"null"_s : u"undefined"_s, key));
    return prop(v, key);
}

OJson add(const OJson& a, const OJson& b) {
    // ToPrimitive:数组与对象落成字符串(Array.prototype.toString / "[object Object]")
    const auto primIsString = [](const OJson& x) { return x.type == OJson::String || x.type == OJson::Array || x.type == OJson::Object; };
    if (primIsString(a) || primIsString(b)) return OJson::string(str(&a) + str(&b));
    return OJson::number(num(&a) + num(&b));
}

OJson object(std::initializer_list<std::pair<QString, OJson>> kv) {
    OJson o;
    o.type = OJson::Object;
    for (const auto& [k, v] : kv) o.set(k, v);
    return o;
}

OJson array(const QList<OJson>& items) {
    OJson o;
    o.type = OJson::Array;
    o.items = items;
    return o;
}

OJson strings(const QStringList& l) {
    QList<OJson> items;
    for (const QString& s : l) items << OJson::string(s);
    return array(items);
}

}  // namespace ibkr::util::js
