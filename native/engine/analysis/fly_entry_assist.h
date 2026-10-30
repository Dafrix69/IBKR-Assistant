// 蝶式入场助手:只给建议和标记,不改任何下单逻辑。纯计算,输入由 handler(options.entry_assist)凑齐。
// 规则与数字来自 research/spx-fly 分支的 research/spx_fly/reports/winrate_study.md(2022-05 至 2026-10,ATM 0DTE 蝶持到结算),
// 口径见 docs/features/fly-entry-assist.md。阈值由配置给(contract::FlyEntryAssistConfig),这里只认传进来的 Config。
#pragma once

#include "util/ordered_json.h"

#include <QString>

#include <optional>
#include <vector>

namespace ibkr::analysis::flyentry {

/// 阈值(默认值 = 研究里的数;配置里可改)
struct Config {
    bool enabled = true;
    /// 建议翼宽 = width_mult × 平值跨式;下限 = width_floor_mult × 跨式
    double width_mult = 2.0;
    double width_floor_mult = 1.5;
    /// 昨日 SPX 跌幅 ≥ 这么多(%)且此刻在 prior_drop_after_min(美东分钟)之后 → 标记
    double prior_drop_pct = 1.0;
    double prior_drop_after_min = 12 * 60;
    /// 周四且此刻在这之前 → 标记
    double thursday_before_min = 12 * 60;
    /// SPX 当天到期 put 墙离现货 ≤ 这么多倍跨式,且 SPY 当天到期 put 墙离现价 ≤ 这么多 % → 标记
    double spx_put_wall_straddle_mult = 5.9;
    double spy_put_wall_pct = 1.31;
    /// 此刻 ≥ 这个美东分钟数 → 时段提示
    double late_entry_min = 15 * 60;
};

/// handler 凑齐的输入;拿不到的留空并在 *Note 里写原因(原因会原样出现在 notes 里)
struct Input {
    double etMinutes = 0;
    /// QDate::dayOfWeek:1 = 周一 … 7 = 周日
    int weekday = 0;
    /// 当日到期的平值跨式中间价(点)= 看涨中间价 + 看跌中间价(剧本「当前剩余」那一格的 call + put)
    std::optional<double> straddle;
    std::optional<double> straddleAt;
    std::optional<double> straddleStrike;
    QString straddleNote;
    /// 昨日官方收盘与前一日收盘(日线),以及各自的日期 YYYY-MM-DD
    std::optional<double> priorClose, prevClose;
    QString priorDate, prevDate;
    QString priorNote;
    /// SPX 当天到期链:现货、put 墙行权价、取到的链最低的行权价(coverage.lower)与是不是抽着取的
    std::optional<double> spxSpot, spxPutWall, spxWindowLow;
    bool spxThinned = false;
    QString spxWallNote;
    /// SPY 当天到期链:同上
    std::optional<double> spySpot, spyPutWall, spyWindowLow;
    bool spyThinned = false;
    QString spyWallNote;
};

/// 翼宽的档:行权价每 5 点一档,研究里比过的是这几档
const std::vector<double>& widthLadder();

struct WidthPick {
    double raw = 0;    // width_mult × 跨式
    double floor = 0;  // width_floor_mult × 跨式
    double pick = 0;   // 档里离 raw 最近的(一样近取大的);低于 floor 就再上一档
    /// raw 超过最大档:pick 是最大档,但盖不住
    bool capped = false;
};
WidthPick pickWidth(double straddle, const Config& cfg);

/// 昨日相对前日的涨跌幅(%);缺一个收盘价是空
std::optional<double> priorChangePct(const Input& in);

/// FlyEntryAssist(契约 spec/contract/options.ts):
/// { enabled, width: {...} | null, flags: [{ key, title, basis }], timing: { title, basis } | null, notes: [string], inputs: {...} }
util::OJson evaluate(const Config& cfg, const Input& in);

}  // namespace ibkr::analysis::flyentry
