// 递给蝶式出场参数扫描(analysis::sweep::runSweep)的判定函数:就是实盘追踪用的 orchestrate::tracker 那几个纯函数。
// analysis 层不许 import 编排层,所以由调用方递进去;测试与命令行工具 fly-exit-sweep 递的都是这一份。
#pragma once

#include "analysis/fly_exit_sweep_spec.h"
#include "orchestrate/tracker.h"

namespace ibkr::orchestrate {

/// TS 里 `import * as tracker` 整个模块递进去;这里是同一批纯函数
class SweepTrackerRules : public analysis::sweep::TrackerRules {
public:
    QString stateHolding() const override { return tracker::kStateHolding; }
    std::any makePosition(const util::OJson& raw) const override { return tracker::makePosition(raw); }
    util::OJson makeTargets(const util::OJson& raw) const override { return tracker::makeTargets(raw); }
    std::optional<std::any> structureOf(const QString& secType, const util::OJson& contract) const override {
        auto s = tracker::structureOf(secType, &contract);
        if (!s) return std::nullopt;
        return std::any(*s);
    }
    QString legPriceKey(double strike, const QString& right) const override { return tracker::legPriceKey(strike, right); }
    std::optional<double> naturalClosePrice(const std::any& position, const std::any& structure, const util::OJson& book) const override {
        return tracker::naturalClosePrice(std::any_cast<const tracker::Position&>(position), std::any_cast<const tracker::TargetStructure&>(structure), book);
    }
    double closeTick(const std::any& position) const override { return tracker::closeTick(std::any_cast<const tracker::Position&>(position)); }
    void validate(const std::any& position, const util::OJson& targets, std::optional<double> price) const override {
        tracker::validate(std::any_cast<const tracker::Position&>(position), targets, price);
    }
    util::OJson evaluate(const std::any& position, const util::OJson& targets, std::optional<double> price, std::optional<double> peak, std::optional<double> minute,
                         const EvalOpts& opts) const override {
        tracker::EvaluateOpts o;
        o.hasStopPrice = opts.hasStopPrice;
        o.stopPrice = opts.stopPrice;
        return tracker::evaluate(std::any_cast<const tracker::Position&>(position), targets, price, peak, minute, o);
    }
};

}  // namespace ibkr::orchestrate
