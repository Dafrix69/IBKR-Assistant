// engine-ts/src/contract/schema/kit.ts:写入参 schema 的小工具。对象、联合、可空转 undefined 都是 util/zod 的原件
// (issue 上带着 describeIssue 要读的 keys / expected / received / unionErrors),这里只放 kit.ts 自己的那几个函数。
// 约定(同 tests/js_fixture.h):解出来的对象里,值是 undefined 的键**不出现**(TS 里那个键在、值是 undefined;JSON.stringify 一样丢掉)。
#pragma once

#include "util/ordered_json.h"
#include "util/zod.h"

#include <QString>

#include <vector>

namespace ibkr::contract {

namespace zod = util::zod;
using ParamsSchema = zod::SchemaPtr;
using ObjectSchema = zod::ObjectSchema;

/// z.object({...}):未知的键默认丢掉;.strict() 时拒
inline std::shared_ptr<ObjectSchema> obj(std::vector<std::pair<QString, zod::SchemaPtr>> shape) { return zod::object(std::move(shape)); }

/// z.union([...])
inline zod::SchemaPtr unionOf(std::vector<zod::SchemaPtr> options) { return zod::unionOf(std::move(options)); }

/// kit.ts 的 optional(schema):schema.nullish().transform(v => v ?? undefined)
zod::SchemaPtr optional(zod::SchemaPtr schema);
/// kit.ts 的 requiredButReportedByHandler():z.string().nullish().transform(v => v ?? "")
zod::SchemaPtr requiredButReportedByHandler();
/// z.string().nullish().transform(v => v ?? ""),instruction.submit 的 text 同样写法
zod::SchemaPtr nullishDefault(zod::SchemaPtr schema, util::OJson fallback);
/// kit.ts 的 NoParamsSchema:z.unknown().transform(() => ({}))
zod::SchemaPtr noParams();
/// z.unknown().transform(v => Boolean(v))
zod::SchemaPtr truthyOf();
/// z.unknown().transform(v => v as T):原样
zod::SchemaPtr passThrough();

/// kit.ts 的 describeIssue(error):只报第一处;一个都没有是「参数不对」
QString describeIssue(const std::vector<zod::Issue>& issues);

}  // namespace ibkr::contract
