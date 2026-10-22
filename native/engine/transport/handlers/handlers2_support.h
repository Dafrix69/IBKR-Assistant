// handlers2 簇各 handler 共用的几样小东西(TS 里是 contractMethods 与 HandlerBase 的几行)。
#pragma once

#include "transport/context.h"
#include "transport/contract_methods.h"
#include "transport/handlers/handlers2_ports.h"

#include "util/zod.h"

#include <QString>

#include <functional>
#include <memory>
#include <utility>
#include <vector>

namespace ibkr::rpc {

/// contractMethods({...}) 的一项:方法名 → 协程 handler(入参已过 schema)
using ContractImpl = std::vector<std::pair<QString, ContractAsyncHandler>>;

/// rpc/contractMethods.ts 的 contractMethods:返回一张方法表,每一项先把入参过 schema(不合抛 RpcError -32602「<方法> 的参数不对:…」),
/// 再交给 handler。方法名不在契约里是编程错误(抛 JsError)。schema 没过得到的是一个已经失败的 Task(TS 的同步抛错落进 async call() 一样是 rejected)
MethodTable contractTable(ContractImpl impl);

/// 同步 handler 包成协程 handler(抛的错落进失败的 Task)
ContractAsyncHandler syncImpl(std::function<util::OJson(const util::OJson&)> fn);

/// `this.router === null || !this.router.sessions().length` 为假时给 router,否则空
std::shared_ptr<HandlerRouter> liveRouter(Handlers2Ports& ports);

/// `[...s].length`:按码点数(不是 UTF-16 单元)
qsizetype codePointCount(const QString& s);

/// ZodError.message:JSON.stringify(issues, null, 2)。util::zod::Issue 只带 code / path / message / expected / received / keys,所以:
/// invalid_type、unrecognized_keys、custom 逐字一致;too_small / too_big 的 minimum / maximum / type / inclusive / exact 从 zod 固定的文案模板里还原
/// (数组 / 字符串 / 数的 min、max、gte、lte);**invalid_enum_value(options)、invalid_union、exact 长度等别的 code 缺 zod 多带的字段**——
/// 只在大模型回了不合 schema 的 JSON 时才看得见。path 里全是数字的段按数字写(数组下标)
QString zodErrorMessage(const std::vector<util::zod::Issue>& issues);

}  // namespace ibkr::rpc
