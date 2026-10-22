// research.ts:标的情报采集——想法里的相对时间解析成价格锚点、日线算量价摘要、拼成给模型看的中文块。纯计算。
// 日线是松的记录(OJson 数组,按 Number() 读 open / high / low / close);摘要与锚点是 OJson,键序同 TS。
#pragma once

#include "util/ordered_json.h"

#include <QString>

#include <optional>

namespace ibkr::analysis::research {

/// 解析不出是 null
util::OJson resolveAnchor(const QString& text, const util::OJson& bars, const QString& todayIso);
util::OJson symbolBrief(const util::OJson& bars);
/// symbol 为空 = null;brief 为空指针 = null
QString briefText(const std::optional<QString>& symbol, const util::OJson* brief);

}  // namespace ibkr::analysis::research
