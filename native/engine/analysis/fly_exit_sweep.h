// flyExitSweep.ts:蝶式出场参数的离线扫描(纯计算)——拿软件自己记下来的盘口,问"换一组出场参数,过去这些天会怎样"。
// 出场规则不是另写的一份:实盘预设走 tracker.evaluate + withTimeExit(调用方递进来的 TrackerRules),回放策略走 flyexit.simulate。
// 只出"每组参数、每一天"的结果;怎么比、信不信在 fly_exit_sweep_stats,写成话在 fly_exit_sweep_report。
//
// 与 TS 的差别:`catch {}` 只接 util::JsError(TS 是全接;规则那边抛的都是 JsError 的子类,别的异常是 bug,不吞)。
#pragma once

#include "analysis/fly_exit_sweep_spec.h"

#include <functional>

namespace ibkr::analysis::sweep {

/// onDay:每算完一天叫一次(date, done, total)
SweepResult runSweep(const std::vector<QuoteSample>& samples, const SweepConfig& cfg, const TrackerRules& rules,
                     const std::function<void(const QString&, double, double)>& onDay = {});

}  // namespace ibkr::analysis::sweep
