#include "transport/contract_methods.h"

#include "contract/registry.h"
#include "util/error.h"
#include "util/rpc_error.h"

using namespace Qt::StringLiterals;

namespace ibkr::rpc {

util::OJson parseContractParams(const QString& name, const util::OJson* raw) {
    const contract::zod::SafeParse parsed = contract::parseParams(name, raw);
    // 结构不合是调用方写错了(界面与引擎的版本对不上、手写请求漏了字段),和用户填错的领域错分开说
    if (!parsed.success) throw util::RpcError(-32602, u"%1 的参数不对:%2"_s.arg(name, contract::describeIssue(parsed.issues)));
    return parsed.data.value_or(util::OJson());
}

void addContractMethod(RpcServer& server, const QString& name, ContractHandler handler) {
    if (!contract::findMethod(name)) throw util::JsError(u"契约里没有这个方法:%1"_s.arg(name));
    // params 是 RpcServer 从那一行 JSON 里读出来的 OJson(键序、-0、1e999 都和 TS 的 JSON.parse 一样);schema 解出来的对象键序是 TS 对象的键序
    server.addOJson(name, [name, handler = std::move(handler)](const util::OJson& params) { return handler(parseContractParams(name, &params)); });
}

void addContractMethodAsync(RpcServer& server, const QString& name, ContractAsyncHandler handler) {
    if (!contract::findMethod(name)) throw util::JsError(u"契约里没有这个方法:%1"_s.arg(name));
    server.addAsync(name, [name, handler = std::move(handler)](const util::OJson& params) -> util::Task<util::OJson> {
        // schema 先过;没过是一个已经失败的 Task(TS 的 table[name] 是同步函数,抛的错落进 async call() 一样是 rejected)
        try {
            return handler(parseContractParams(name, &params));
        } catch (...) {
            util::Deferred<util::OJson> failed;
            failed.reject(std::current_exception());
            return failed.task();
        }
    });
}

}  // namespace ibkr::rpc
