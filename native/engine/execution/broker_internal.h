// broker*.cpp 共用的几个小工具(不进 broker.h:不是接口)。
#pragma once

#include "util/error.h"
#include "util/jsobj.h"
#include "util/ordered_json.h"

#include <QString>

#include <cmath>
#include <exception>
#include <optional>

namespace ibkr::execution::detail {

/// String(exc.message ?? exc):JsError 取 message,别的 std::exception 取 what()
inline QString messageOf(const std::exception_ptr& e) {
    try {
        std::rethrow_exception(e);
    } catch (const util::JsError& x) {
        return x.message();
    } catch (const std::exception& x) {
        return QString::fromStdString(x.what());
    } catch (...) {
        return {};
    }
}

inline const util::OJson* prop(const util::OJson& o, const QString& key) { return util::js::prop(&o, key); }
inline const util::OJson* prop(const util::OJson* o, const QString& key) { return util::js::prop(o, key); }
/// `x ?? null` 之后当数:null / undefined 空;别的 Number()
inline std::optional<double> optNum(const util::OJson* v) {
    if (util::js::nullish(v)) return std::nullopt;
    return util::js::num(v);
}
/// `Number(x ?? 0) || 0`
inline double numOr0(const util::OJson* v) {
    const double n = util::js::nullish(v) ? 0 : util::js::num(v);
    return std::isnan(n) || n == 0 ? 0 : n;
}
/// `Math.trunc(Number(x ?? d)) || null`
inline std::optional<double> truncOrNull(const util::OJson* v, double d) {
    const double n = std::trunc(util::js::nullish(v) ? d : util::js::num(v));
    return std::isnan(n) || n == 0 ? std::nullopt : std::optional<double>(n);
}
inline util::OJson numOrNull(const std::optional<double>& v) { return v ? util::OJson::number(*v) : util::OJson::null(); }
/// `String(x ?? fallback)`
inline QString strOr(const util::OJson* v, const QString& fallback = {}) { return util::js::strOr(v, fallback); }
/// `String(x ?? "") || fallback`
inline QString strOrDefault(const util::OJson* v, const QString& fallback) {
    const QString s = util::js::strOr(v, QString());
    return s.isEmpty() ? fallback : s;
}

}  // namespace ibkr::execution::detail
