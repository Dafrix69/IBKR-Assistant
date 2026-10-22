// TWS 线协议(wire_out / wire_in)共用的几样:事件的样子、JS 的报错类名、拼对象时的 undefined 占位。
// 照的是 TS 引擎在用的 @stoqey/ib 1.6.10(MIT),期望值由 tests/fixtures/gen_ib_wire.mjs 拿那个库现算。
#pragma once

#include "util/error.h"
#include "util/ordered_json.h"

#include <QString>

#include <vector>

namespace ibkr::tws::wire {

using util::OJson;

/// 库发出的一个事件:名字同 @stoqey/ib 的 EventName("tickPrice"、"openOrder"、"error"、"info"……),
/// args 是参数表(JS 数组)。库里是 undefined 的参数在这里是 null;对象里 undefined 的键不写(同 JSON.stringify)。
/// "error" 的参数是 Controller 那一层的样子:[话(串), code, reqId ?? -1, advancedOrderReject];"info" 是 [话, code]。
struct Emit {
    QString name;
    OJson args;
};

/// JS 抛出来的错(TypeError / SyntaxError / RangeError):话同 V8 原文,类名另记
class WireError : public util::JsError {
public:
    WireError(QString name, const QString& message) : util::JsError(message), name_(std::move(name)) {}
    const QString& name() const { return name_; }

private:
    QString name_;
};

namespace detail {

/// 拼对象途中的 undefined:键的位置要按第一次赋值算(后面再赋成数时位置不动),所以先占住,出事件前再去掉
inline const QString& undefinedMark() {
    static const QString mark = QStringLiteral("\u0000﷐undefined");
    return mark;
}
inline OJson undef() { return OJson::string(undefinedMark()); }
inline bool isUndef(const OJson& v) { return v.type == OJson::String && v.s == undefinedMark(); }
/// 去掉占位:对象里的键删掉,数组里的那一格成 null
inline OJson finalize(const OJson& v) {
    if (v.type == OJson::Array) {
        OJson o;
        o.type = OJson::Array;
        for (const OJson& x : v.items) o.items.append(isUndef(x) ? OJson::null() : finalize(x));
        return o;
    }
    if (v.type == OJson::Object) {
        OJson o;
        o.type = OJson::Object;
        for (const auto& [k, x] : v.fields)
            if (!isUndef(x)) o.fields.append({k, finalize(x)});
        return o;
    }
    return v;
}

}  // namespace detail

}  // namespace ibkr::tws::wire
