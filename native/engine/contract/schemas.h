// engine-ts/src/contract/schema/*.ts 与 schema/index.ts 的 PARAMS_SCHEMAS:每个契约方法的入参 schema(只管结构)。
// 一份份照 TS 搬,字段的先后、optional / nullish / strict / union 的套法都不改——解出来的对象键序、拒绝的 issue 与先后,
// 都由 tests/fixtures/gen_contract.mjs 对着真的 TS schema 现跑出来的期望逐条比。
//
// 钱路径方法(tracker.add / update / delete / target_preview / close_now、instruction.submit)的顶层与里面每一层对象都是 strict:
// 不认识的键当场拒。还有几个会动配置的方法顶层也是 strict(follow.set_token、keychain.set、llm.patch、settings.patch、
// futu.set_password、options 里新的几个)。
//
// TS 原样:SENSITIVE_METHODS 里的 broker.connect / broker.select / futu.launch / futu.unlock / tws.launch 的 schema **不是** strict
// (TS 没写;strict 与否不是"敏感"的充要条件,registry 里两个标志各管各的)。
#pragma once

#include "contract/kit.h"

#include <QString>

#include <vector>

namespace ibkr::contract {

struct NamedSchema {
    QString method;
    ParamsSchema schema;
};

/// PARAMS_SCHEMAS 的全部条目,次序同 schema/index.ts 里的写法(别名一样共用同一个 schema 对象:pa.comment = pa.analyze)
const std::vector<NamedSchema>& paramsSchemas();

}  // namespace ibkr::contract
