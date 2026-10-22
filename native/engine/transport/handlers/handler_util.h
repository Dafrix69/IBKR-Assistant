// handlers1 簇共用的小东西:契约方法表的装配(TS 的 contractMethods({...}))、几个 JS 取值的写法。
#pragma once

#include "contract/registry.h"
#include "transport/context.h"
#include "transport/contract_methods.h"
#include "util/error.h"
#include "util/jsformat.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/ordered_json.h"
#include "util/rpc_error.h"
#include "util/task.h"

#include <QString>

#include <cmath>
#include <functional>
#include <optional>

namespace ibkr::rpc {

/// contractMethods({[name]: handler}) 的 C++ 样子:登记时核对名字在契约里(不在是编程错误,抛 JsError),调用时入参先过 schema(没过回
/// -32602「<方法> 的参数不对:…」),handler 拿到的是 schema 解出来的那个对象。handler 同步抛的错落进返回的 Task(同 TS 的 async call())。
class ContractTable {
public:
    using Sync = std::function<util::OJson(const util::OJson& params)>;
    using Async = std::function<util::Task<util::OJson>(util::OJson params)>;
    /// 要看原始入参里有没有某个键的方法(TS 的 `"k" in params`:zod 对 `k: null` 解出来的是「键在、值 undefined」,OJson 里 undefined 的键不出现,
    /// 所以键在不在只能问原始入参)
    using AsyncRaw = std::function<util::Task<util::OJson>(util::OJson params, util::OJson raw)>;

    void sync(const QString& name, Sync fn) {
        require(name);
        table_.emplace_back(name, [name, fn = std::move(fn)](const util::OJson& raw) -> util::Task<util::OJson> {
            try {
                return util::Task<util::OJson>::resolved(fn(parseContractParams(name, &raw)));
            } catch (...) {
                return failed(std::current_exception());
            }
        });
    }
    void async(const QString& name, Async fn) {
        require(name);
        table_.emplace_back(name, [name, fn = std::move(fn)](const util::OJson& raw) -> util::Task<util::OJson> {
            try {
                return fn(parseContractParams(name, &raw));
            } catch (...) {
                return failed(std::current_exception());
            }
        });
    }
    void asyncRaw(const QString& name, AsyncRaw fn) {
        require(name);
        table_.emplace_back(name, [name, fn = std::move(fn)](const util::OJson& raw) -> util::Task<util::OJson> {
            try {
                return fn(parseContractParams(name, &raw), raw);
            } catch (...) {
                return failed(std::current_exception());
            }
        });
    }
    MethodTable take() { return std::move(table_); }

private:
    static void require(const QString& name) {
        if (!contract::findMethod(name)) throw util::JsError(QStringLiteral("契约里没有这个方法:%1").arg(name));
    }
    static util::Task<util::OJson> failed(std::exception_ptr e) {
        util::Deferred<util::OJson> d;
        d.reject(std::move(e));
        return d.task();
    }
    MethodTable table_;
};

namespace hu {

namespace js = util::js;

/// String(v ?? "")
inline QString strOr(const util::OJson* v) { return js::strOr(v, QString()); }

/// `Number(v ?? fallback) || fallback`
inline double numOrDefault(const util::OJson* v, double fallback) {
    const double x = js::nullish(v) ? fallback : js::num(v);
    return (x == 0 || std::isnan(x)) ? fallback : x;
}

/// 价格这类"数或 null"的参数:null / undefined 是空;别的按 Number()
inline std::optional<double> optNumber(const util::OJson* v) {
    if (js::nullish(v)) return std::nullopt;
    return js::num(v);
}

/// 数的模板字符串写法 `${x}`
inline QString numText(double x) { return util::jsNumberToString(x); }

/// Array.prototype.join(sep):null / undefined 是空串,别的 String()
inline QString joinJs(const util::OJson& items, const QString& sep) {
    QStringList parts;
    for (const util::OJson& x : items.items) parts.append(x.type == util::OJson::Null ? QString() : js::str(&x));
    return parts.join(sep);
}

/// 把一个 Task 的错换成 RpcError 用的 try 块太啰嗦时用:拿异常指针里的话
inline QString messageOf(const std::exception_ptr& e) {
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

}  // namespace hu

}  // namespace ibkr::rpc
