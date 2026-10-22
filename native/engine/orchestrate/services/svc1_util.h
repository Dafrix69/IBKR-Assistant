// svc1 四个 service 共用的几个小函数(都是 JS 里一句话的事)。
#pragma once

#include "util/error.h"
#include "util/jsobj.h"
#include "util/ordered_json.h"

#include <QString>

#include <QStringList>

#include <algorithm>
#include <cmath>
#include <exception>

namespace ibkr::orchestrate::svc1 {

/// String((exc as Error).message ?? exc) 里 message 那一半:JsError 取 message,别的 std::exception 取 what(),都不是回 "undefined"
inline QString excMessage(std::exception_ptr e) {
    try {
        std::rethrow_exception(e);
    } catch (const util::JsError& j) {
        return j.message();
    } catch (const std::exception& x) {
        return QString::fromUtf8(x.what());
    } catch (...) {
        return QStringLiteral("undefined");
    }
}

/// s.slice(0, n)(按 UTF-16 码元)
inline QString slice(const QString& s, qsizetype n) { return s.left(n); }

/// v.length:数组与字符串有,null / undefined 抛 V8 的 TypeError 原话,别的得 undefined(这里当 0:`undefined > 0` 与 `!undefined` 的走向和 0 相同)
inline double lengthOf(const util::OJson* v) {
    if (!v) throw util::JsError(QStringLiteral("Cannot read properties of undefined (reading 'length')"));
    switch (v->type) {
    case util::OJson::Null:
        throw util::JsError(QStringLiteral("Cannot read properties of null (reading 'length')"));
    case util::OJson::Array:
        return double(v->items.size());
    case util::OJson::String:
        return double(v->s.size());
    default:
        return 0;
    }
}

/// typeof x === "number" && Number.isFinite(x)
inline bool finiteNum(const util::OJson* v) { return v && v->type == util::OJson::Number && std::isfinite(v->n); }

/// 键排序后的 JSON:比较"状态变没变"用,不受对象键顺序影响(anomaly.ts 的 stableJson)
inline util::OJson stableSort(const util::OJson& v) {
    using util::OJson;
    if (v.type == OJson::Array) {
        OJson o = v;
        for (OJson& x : o.items) x = stableSort(x);
        return o;
    }
    if (v.type == OJson::Object) {
        QStringList ks;
        for (const auto& f : v.fields) ks.append(f.first);
        // Object.keys(v).sort():按 UTF-16 码元比较(QString::operator< 比的是 UTF-16 码元,同 JS 默认排序)
        std::sort(ks.begin(), ks.end(), [](const QString& a, const QString& b) { return a < b; });
        OJson out = util::js::object();
        for (const QString& k : ks) out.set(k, stableSort(*v.get(k)));
        return out;
    }
    return v;
}

}  // namespace ibkr::orchestrate::svc1
