// engine-ts/src/rpc/contractMethods.ts:从 contract/ 登记的方法——入参先过 schema,handler 拿到的就是契约里写的那个形状。
//
//   addContractMethod(server, u"quality.add"_s, [](const OJson& p) { … return result; });
//
// 结构不合是调用方写错了(界面与引擎的版本对不上、手写请求漏了字段),回 -32602「<方法> 的参数不对:<第一处问题>」,
// 与用户填错的领域错分开说(领域错由各 handler 自己报)。
//
#pragma once

#include "transport/rpc_server.h"
#include "util/ordered_json.h"

#include <functional>

namespace ibkr::rpc {

using ContractHandler = std::function<util::OJson(const util::OJson& params)>;
/// 协程 handler 的入参按值给:schema 解出来的是临时对象,引用到第一个 co_await 之后就悬空了
using ContractAsyncHandler = std::function<util::Task<util::OJson>(util::OJson params)>;

/// PARAMS_SCHEMAS[name].safeParse(raw);不过就抛 util::RpcError(-32602, `${name} 的参数不对:${describeIssue}`)。raw 为空 = undefined
util::OJson parseContractParams(const QString& name, const util::OJson* raw);

/// contractMethods({[name]: handler}) 的一项:name 必须在契约登记表里(不在是编程错误,抛 JsError)。
/// RpcServer 把那一行 JSON 读成 OJson 直接给这里,schema 解出来的键序同 TS(shape 的次序,record 里是来稿的次序)
void addContractMethod(RpcServer& server, const QString& name, ContractHandler handler);
/// 同上,handler 是协程(TS 里返回 Promise 的)
void addContractMethodAsync(RpcServer& server, const QString& name, ContractAsyncHandler handler);

}  // namespace ibkr::rpc
