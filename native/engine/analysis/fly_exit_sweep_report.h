// flyExitSweepReport.ts:蝶式出场参数扫描的报告——把结果与统计写成给人读的几段话(纯函数,回一行一行的文字)。
// 规矩只有一条:每一个口径都写在数字旁边。"比现行参数好"这句话只在 verdictOf 给出 better 时才出现。
// 数字进字符串走 JS 的写法(util/jsformat:toFixed、String(number)、Math.round),不用 QString::number。
#pragma once

#include "analysis/fly_exit_sweep_stats.h"

#include <QStringList>

namespace ibkr::analysis::sweep {

QStringList formatReport(const SweepResult& result, const Summary& summary);

}  // namespace ibkr::analysis::sweep
