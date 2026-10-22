// svc2 各 service 共用的小工具(TS 里是几行内联的惯用法)
#pragma once

#include "util/error.h"

#include <QString>

#include <QDateTime>
#include <QTimeZone>

#include <cmath>
#include <exception>

namespace ibkr::orchestrate {

/// String((exc as Error).message ?? exc):JsError 取 message,别的 std::exception 取 what(),都不是回空
inline QString errMessage(const std::exception_ptr& e) {
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

/// .slice(0, n):按 UTF-16 单元(JS 字符串的单位,QString 也是)
inline QString sliceUnits(const QString& s, qsizetype n) { return s.left(n); }

/// new Date(ms).toISOString():UTC、带毫秒、Z 结尾(Qt 的 ISODateWithMs 在 UTC 上写 +00:00,不一样)
inline QString isoMsZ(double ms) {
    return QDateTime::fromMSecsSinceEpoch(qint64(std::trunc(ms)), QTimeZone::utc()).toString(QStringLiteral("yyyy-MM-dd'T'HH:mm:ss.zzz'Z'"));
}

}  // namespace ibkr::orchestrate
