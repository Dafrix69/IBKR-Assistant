// tracker.ts:持仓追踪的纯计算——标的目标价 → 预计止盈位、追价平仓的限价、盈亏、设置校验、触发判断、平仓单与托管单。只算不发单。
// 三件事定死:方向决定上下;乘数只乘一次(IBKR 的 avgCost 对期权含乘数,成本侧不再乘、市值侧要乘);跟踪止损跟"最有利价"且峰值必须持久化。
// Targets / AutoClose / 结论是 JS 对象(OJson,键序同 TS);持仓是 TS 的 Position(数都由券商给)。
#pragma once

#include "util/error.h"
#include "util/ordered_json.h"

#include <QSet>
#include <QString>
#include <QStringList>

#include <optional>
#include <vector>

namespace ibkr::orchestrate::tracker {

inline const QString kStateHolding = QStringLiteral("holding");
inline const QString kStateTakeProfit = QStringLiteral("take_profit");
inline const QString kStateStopLoss = QStringLiteral("stop_loss");
inline const QString kStateProfitTrail = QStringLiteral("profit_trail");
inline const QString kStateManual = QStringLiteral("manual");
inline const QString kSweepPrefix = QStringLiteral("sweep:");
inline constexpr int kChaseWarnRounds = 30;

class TrackerError : public util::JsError {
public:
    using util::JsError::JsError;
};

struct Position {
    QString account, symbol, sec_type = QStringLiteral("STK");
    double quantity = 0, avg_cost = 0, multiplier = 1;
    QString currency = QStringLiteral("USD");
    std::optional<double> market_price, market_value, unrealized_pnl;
    QString leg;
};
/// makePosition(raw):没给的取默认(同 TS 的 ??)
Position makePosition(const util::OJson& raw);
bool isLong(const Position& p);
QString positionKey(const Position& p);
QString trackKey(const util::OJson& track);

util::OJson makeTargets(const util::OJson& raw);
bool targetsEmpty(const util::OJson& t);

// ---- 结构
std::optional<util::OJson> flyProfileOf(const util::OJson* contract);
struct StructureLeg {
    double strike = 0;
    QString right;
    double ratio = 0;
};
struct TargetStructure {
    QString kind;  // stock / option / combo
    std::vector<StructureLeg> legs;
    std::optional<util::OJson> fly;
    QString label;
};
std::optional<TargetStructure> structureOf(const QString& secType, const util::OJson* contract);
QString legPriceKey(double strike, const QString& right);
std::optional<util::OJson> smileSigmas(const std::vector<StructureLeg>& legs, double spot, const util::OJson& legPrices);

struct SpotTargetArgs {
    double spotTarget = 0;
    std::optional<double> spot, markPrice, minute, em;
    const util::OJson* legPrices = nullptr;
    QString spotNote;
    const util::OJson* legIvs = nullptr;
    std::optional<double> expiryMs, nowMs;
};
/// SpotTarget(键序同 TS)
util::OJson spotTarget(const TargetStructure& structure, const Position& position, const SpotTargetArgs& args);
util::OJson validateSpotTarget(const Position& position, const util::OJson* contract, const SpotTargetArgs& args);
QString fillsNowMessage(const Position& position, const TargetStructure& structure, const util::OJson& st, std::optional<double> markPrice);

std::optional<double> naturalClosePrice(const Position& position, const TargetStructure& structure, const util::OJson& book);
double chaseMaxSteps(const Position& position, double natural, const util::OJson& autoClose, const util::OJson* reason = nullptr);
/// lead:按跌速多让的那一截(点,analysis::momentumLead);0 = 不多让(和没有这一项时一样)
double chaseLimit(const Position& position, double natural, std::optional<double> prev, double rounds, const util::OJson& autoClose,
                  const util::OJson* reason = nullptr, double lead = 0);
double chaseFloor(const Position& position, double natural, const util::OJson& autoClose, const util::OJson* reason = nullptr);
std::optional<QString> sweepReason(const util::OJson& track);

// ---- 盈亏
double costBasis(const Position& p);
std::optional<double> marketValue(const Position& p, std::optional<double> price);
util::OJson unrealized(const Position& p, std::optional<double> price);

// ---- 校验与触发
void validate(const Position& position, const util::OJson& targets, std::optional<double> price, bool hasAdditionalExit = false);
std::optional<double> advancePeak(const Position& position, std::optional<double> price, std::optional<double> peak);
std::optional<double> trailStopPrice(const Position& position, std::optional<double> peak, const util::OJson* trailPct);
struct EvaluateOpts {
    bool hasStopPrice = false;
    std::optional<double> stopPrice;
    bool hasPeakPrice = false;
    std::optional<double> peakPrice;
};
util::OJson evaluate(const Position& position, const util::OJson& targets, std::optional<double> price, std::optional<double> peak = std::nullopt,
                     std::optional<double> minute = std::nullopt, const EvaluateOpts& opts = {});
util::OJson withSpotTriggers(const util::OJson& result, const QString& symbol, const util::OJson& targets, const util::OJson* target, const util::OJson* stop);
/// covered 是空 = 说不清,按读得到处理
std::optional<QString> unreachableReason(const std::optional<QSet<QString>>& covered, const util::OJson* account);
QString closeSide(const Position& p);

// ---- 自动平仓
extern const QString kBlockDisabled, kBlockBreaker, kBlockMarket, kBlockAlready, kBlockQty;
extern const QStringList kExtendedSessions;
util::OJson makeAutoClose(const util::OJson& raw);
struct CloseGateArgs {
    const util::OJson* autoClose = nullptr;
    const Position* position = nullptr;
    bool breakerEngaged = false;
    QString marketStatus;
    bool outsideRth = false, alreadyFired = false;
};
QStringList closeBlockers(const CloseGateArgs& args);
double closeQty(const Position& position, const util::OJson& autoClose);
std::optional<double> closeLimitPrice(const Position& position, std::optional<double> price, const util::OJson* slippagePct);
util::OJson closeContract(const util::OJson& contract);
util::OJson closeBagContract(const util::OJson& contract);
std::optional<QString> closeContractIssue(const util::OJson* row);
double closeTick(const Position& position, std::optional<double> price = std::nullopt);
util::OJson buildCloseOrder(const Position& position, const util::OJson& autoClose, std::optional<double> price, const QString& state,
                            const util::OJson& contract, const QString& marketStatus = QStringLiteral("盘中"));

// ---- 券商托管
inline const QString kHostedKindTp = QStringLiteral("tp");
inline const QString kHostedKindSl = QStringLiteral("sl");
inline const QString kHostedKindTrail = QStringLiteral("trail");
inline const QString kHostedKindPtrail = QStringLiteral("ptrail");
inline const QString kHostedKindSpot = QStringLiteral("spot");
QString hostedLabel(const QString& kind);
std::optional<double> profitTrailStopPrice(const Position& position, std::optional<double> peak, std::optional<double> drawdownPct,
                                           std::optional<double> floor = std::nullopt);
/// HostedOrderPlan 的数组
util::OJson hostedPlan(const Position& position, const util::OJson& targets, const util::OJson& autoClose, std::optional<double> peak);
bool hostedNeedsUpdate(const util::OJson& current, const util::OJson& desired);

}  // namespace ibkr::orchestrate::tracker
