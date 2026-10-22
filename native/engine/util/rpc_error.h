// 带错误码的失败(engine-ts/src/rpcError.ts):码与文案原样进 JSON-RPC 回执的 error 字段,界面按码分流
// (-32602 参数不对、-3200x 业务上拒了、-32000 没料到的异常)。放在最底层:handler 与编排都要抛它。
#pragma once

#include "util/error.h"

#include <exception>

namespace ibkr::util {

class RpcError : public JsError {
public:
    RpcError(int code, const QString& message) : JsError(message), code_(code) {}
    int code() const { return code_; }

private:
    int code_;
};

/// 给人看的失败原因:RpcError 的文案原样给,其余异常截到 200 个 UTF-16 码元
inline QString errText(std::exception_ptr e) {
    try {
        std::rethrow_exception(e);
    } catch (const RpcError& r) {
        return r.message();
    } catch (const JsError& j) {
        return j.message().left(200);
    } catch (const std::exception& x) {
        return QString::fromUtf8(x.what()).left(200);
    } catch (...) {
        return QStringLiteral("undefined");
    }
}

}  // namespace ibkr::util
