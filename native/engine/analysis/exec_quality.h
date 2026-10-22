// execQuality.ts:执行损耗——自动平仓触发那一刻的持仓现价 vs 实际成交均价。纯函数。
// 单的记录(store.getRecord 折过事件的那份)是松的 JSON,这里按 JS 的读法取值。
#pragma once

#include "util/ordered_json.h"

#include <QString>

#include <optional>
#include <vector>

namespace ibkr::analysis::execquality {

inline constexpr int kMaxExecutionRows = 50;

struct CloseTrace {
    QString at, path, symbol, state;
    std::optional<double> mark;
    std::optional<util::OJson> record;  // 找不到那张单是空
};
struct ExecutionOptions {
    QString scope;  // all / live / paper
    QString kind;   // all / stock / butterfly / option
    std::optional<double> days;
    double now = 0;
};

/// ExecutionRow 或 null
util::OJson executionRow(const CloseTrace& trace);
/// ExecutionCost
util::OJson executionCost(const std::vector<CloseTrace>& traces, const ExecutionOptions& opts);

}  // namespace ibkr::analysis::execquality
