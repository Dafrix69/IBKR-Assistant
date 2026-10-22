// V8 的 JSON.parse 报错原话(逐条照 V8 的 json-parser 搬:记号表、每一处 Expect 的话、位置与行列、
// Unexpected token 的三种上下文截取、"NaN" / "Infinity" / "undefined" / "[object Object]" 那条特例)。
// TS 引擎把它原样给人看(配置读坏了:「配置文件不是合法的 JSON(多半是手改时少了逗号或引号):Unexpected token ...」),
// 所以这边也要一字不差。只管"报什么",不建值——合法的文本交给 parseOJson。期望值:tests/fixtures/gen_v8json.mjs(node 现跑)。
#pragma once

#include <QString>

#include <optional>

namespace ibkr::util {

/// JSON.parse(text) 会抛的 SyntaxError 的 message;文本合法回空
std::optional<QString> v8JsonParseError(const QString& text);

}  // namespace ibkr::util
