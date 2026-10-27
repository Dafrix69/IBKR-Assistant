// 期权主动成交(只读、纯计算):记盘那一路(orchestrate/services/flow_recorder)落下的原始观测,在这里按报价规则分成买方主动 / 卖方主动 / 分不出。
// 口径(quote-rule-v1):成交价对"这笔成交之前"的那一口盘口——≥ 卖价算买方主动、≤ 买价算卖方主动,夹在中间按离中间价哪边近,正好在中间价分不出。
// 之前那口盘口不可用才退到成交之后那一口。分不出就是分不出:没盘口、锁盘 / 交叉盘、延迟行情、成交价没更新(LAST_TIMESTAMP 没往前走)一律 unknown,不猜。
// 期权行情是 IBKR 合并过的推送(不是逐笔):两次推送之间的几笔成交并成一个成交量增量,只拿最后一笔的价来分——这是这个口径最大的误差来源,
// 要拿逐笔(tick-by-tick)对照才能量出来,见 docs/features/option-flow.md。
// 多腿成交(价差、蝴蝶)拆开看方向是错的:同一个时间窗里两张不同合约的成交量增量一样,就标成"像组合单",不进买卖两边。
#pragma once

#include "util/ordered_json.h"

#include <QList>
#include <QString>

#include <optional>
#include <vector>

namespace ibkr::analysis::optionflow {

inline const QString kRuleVersion = QStringLiteral("quote-rule-v1");
/// 两张不同合约的同量成交落在这么近的时间里,当作同一张组合单的两条腿。IBKR 期权推送大约 250 毫秒合并一次,取这个数是照推送节拍定的,不是拟合出来的
inline constexpr double kSpreadWindowMs = 250;

struct Quote {
    std::optional<double> bid, ask;
};

/// 一次推送里看到的一个成交量增量(记盘文件里 kind = "print" 的一行)
struct Print {
    double t = 0;  // 本机收到这次推送的时刻(毫秒)
    QString expiry;
    double strike = 0;
    QString right;  // C / P
    double dv = 0;  // 这次比上次多出来的累计成交量(张)
    std::optional<double> last;
    std::optional<double> lastAt, prevLastAt;  // LAST_TIMESTAMP 原值:只比先后,不换算
    Quote prev, now;
    std::optional<double> marketDataType;  // 1 实时 / 2 冻结 / 3 延迟 / 4 延迟冻结
};

enum class Side { Buy, Sell, Unknown };
QString sideName(Side side);

struct Verdict {
    Side side = Side::Unknown;
    /// at_ask / at_bid / above_mid / below_mid / mid / no_volume / no_last / stale_last / delayed / no_quote / locked
    QString rule;
    /// 用的是哪一口盘口:prev / now;没用上盘口是空
    QString quote;
};

/// 买价 ≥ 0、卖价 > 0、卖价 > 买价
bool usableQuote(const Quote& q);
Verdict classify(const Print& p);

/// 每一笔像不像组合单的一条腿:别的合约在 windowMs 以内有同样成交量增量的那一笔
std::vector<bool> spreadLike(const std::vector<Print>& prints, double windowMs = kSpreadWindowMs);

struct ContractFlow {
    QString expiry;
    double strike = 0;
    QString right;
    double buy = 0, sell = 0, unknown = 0, spread = 0;  // 张
    double seen() const { return buy + sell + unknown + spread; }
    double net() const { return buy - sell; }
};
/// 按合约加总;像组合单的只进 spread,不进买卖。次序:到期日、行权价、C 在 P 前
std::vector<ContractFlow> aggregate(const std::vector<Print>& prints, double windowMs = kSpreadWindowMs);

/// 次日持仓量的对照(一张合约一行)。持仓量变化只说开仓多还是平仓多,说不出谁买谁卖:这里只量"看到了多少成交"与"开仓占多少",不检验方向
struct OiCheckRow {
    ContractFlow flow;
    std::optional<double> dayVolume;      // 当天最后一次看到的累计成交量
    std::optional<double> oiBefore, oiAfter;
    std::optional<double> coverage() const;  // 记盘看到的张数 / 当天累计成交量
    std::optional<double> dOi() const;
    std::optional<double> openShare() const;  // |ΔOI| / 当天累计成交量
};

/// 底账里 kind = "print" 的一行 → Print;别的行、形状不对回空
std::optional<Print> printFrom(const util::OJson& record);

/// 次日持仓量对照:day 是记盘那天的底账,next 是下一个交易日的(那天开盘后记下的 oi 行就是 day 收盘后的持仓量)。
/// oiBefore 取 day 里这张合约最早的一笔 oi,oiAfter 取 next 里最早的一笔;dayVolume 取 day 里最后一笔 vol。
/// 回 {rule, rows:[...], totals:{...}, note};day 里出现过的合约(成交、累计量、持仓量任一)都有一行
util::OJson oiCheck(const QList<util::OJson>& day, const QList<util::OJson>& next, double windowMs = kSpreadWindowMs);

// ---- 逐笔对照 ------------------------------------------------------------
// 少数几张合约同时订了逐笔(AllLast + BidAsk):每一笔成交和它到达那一刻的盘口都在,按同一条报价规则分出来的就是"真值"
// (它自己也只是报价规则,不是交易所告诉你的主动方;但它没有合并推送这一层误差)。拿真值去对记盘那一行的结论,量的就是合并推送带来的误差。

/// 一笔逐笔成交,带它到达之前最近的那口逐笔盘口
struct TruthTrade {
    double t = 0;  // 本机收到的时刻(毫秒)
    QString expiry;
    double strike = 0;
    QString right;
    double size = 0, price = 0;
    Quote nbbo;
    bool unreported = false;
    QString special;
};
/// 逐笔底账(kind = "tbt" 的行,照文件次序)→ 成交;盘口按合约各自往前带
std::vector<TruthTrade> truthFrom(const QList<util::OJson>& tbtRecords);
Verdict classifyTruth(const TruthTrade& trade);

inline constexpr double kMatchLagMs = 2'000;
/// 对照:每笔真值成交配到同一张合约、收到时刻不早于它、且晚不过 maxLagMs 的第一行记盘;按张数加权的混淆矩阵与准确率。
/// 未报告(unreported)的成交不进矩阵(它们不进累计成交量),另计张数。
/// 回 {rule, contracts, matrix:{truth_side:{rec_side:张}}, accuracy, classified_share, match_share, unreported, by_special, mixed_prints,
///    volume_check:{matched_trade_size, matched_print_dv, truth_size_incl_unreported, print_dv_same_contracts}, nets:[...]}
util::OJson accuracy(const QList<util::OJson>& flowRecords, const QList<util::OJson>& tbtRecords, double maxLagMs = kMatchLagMs,
                     double windowMs = kSpreadWindowMs);

}  // namespace ibkr::analysis::optionflow
