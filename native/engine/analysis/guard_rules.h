// 交易纪律守护(guard)的纯规则:意图怎么验、仓位怎么限、默认止损怎么算、开仓单放不放。见 docs/features/guard.md。
// 不碰券商、不碰库:净值、前几日的极值、在用的意图都由调用方给。
#pragma once

#include "contract/settings.h"
#include "util/ordered_json.h"

#include <QString>

#include <optional>

namespace ibkr::analysis::guard {

/// 一份意图验下来的结果:ok 时 intent 是要落库的那一份(带算出来的字段),否则 error 是给人看的一句话
struct IntentVerdict {
    bool ok = false;
    util::OJson intent;
    QString error;
    QStringList notes;  // 通过了但要说一声的(数量减半)
};

/// 股票意图。line 是收件文件里的一行(已解析成对象);account 已经认好;nav = 这个账户的净值(美元,> 0)。
/// 算 max_loss_usd = |入场 − 止损| × 数量、max_loss_pct_nav = 它占净值的百分比;止损距离超过 wide_stop_pct 时数量先减半再比;
/// 超过 max_loss_pct_nav 就拒,并给出这个止损下最多能买多少股
IntentVerdict checkStockIntent(const util::OJson& line, const QString& account, double nav, const contract::GuardConfig& cfg);

/// 期权组合意图:不拦开仓,出场交给持仓追踪。结构(从里面认出行权价与看涨 / 看跌,或另给 strikes / right)、到期日、成本(借方,> 0)、
/// 出场规则:止盈倍数、止损倍数、到期日几点平(必填),标的止损线(可选)。规则可以写数(take_profit_x 2.5),也可以写一句话
/// (「中间价 >= 成本 × 2.5」「到期日 15:00 ET」「标的收盘 < 647」),认不出就拒
IntentVerdict checkOptionIntent(const util::OJson& line, const QString& account);

/// 出场规则认出来的数
struct ExitRules {
    std::optional<double> take_profit_x, stop_loss_x, level_below, level_above;
    QString time_stop_et;  // "HH:MM",空 = 没有
    QString error;         // 非空 = 认不出
};
ExitRules parseExitRules(const util::OJson& rules);

/// 从结构那一句里认行权价(「660/670/680」)与方向(call / put / C / P / 看涨 / 看跌);认不出 strikes 为空
struct Structure {
    QList<double> strikes;
    QString right;  // "C" / "P" / 空
};
Structure parseStructure(const QString& text);

/// 持仓里的一行组合(withCombos 的 BAG 行)是不是这份期权意图说的那一只:同账户、同标的、同到期日、行权价集合相同(方向给了就也要相同)
bool comboMatches(const util::OJson& comboRow, const util::OJson& intent);

/// 股票的止损底线:意图的止损价,打开跟踪时按 R 往有利方向抬(1R → 成本价,2R → 成本 + 1R),只升不降。
/// prevFloor = 上一次的底线(没有就是意图止损价)。多头"抬"是往上,空头是往下
double stockFloor(bool isLong, double cost, double intentStop, double price, bool trail, std::optional<double> prevFloor);
/// a 是不是不比 b 松(多头:a ≥ b;空头:a ≤ b)
inline bool atLeastAsTight(bool isLong, double a, double b) { return isLong ? a >= b - 1e-9 : a <= b + 1e-9; }

/// 默认止损(手动开仓没补录意图时用,只是兜底)。
/// 多头:入场价 × (1 − pct) 与前几日最低价取较高者(更近的那条);空头:入场价 × (1 + pct) 与前几日最高价取较低者。
/// 极值拿不到就只用比例。按分取整,朝离现价远的方向取(多头向下、空头向上),不会因为取整变得更近
double defaultStop(bool isLong, double entry, std::optional<double> extreme, double pct);

/// 前 days 个交易日(严格早于 today,YYYY-MM-DD)的最低价(isLong)或最高价;不够一根就没有
std::optional<double> priorExtreme(const QList<util::OJson>& bars, const QString& today, int days, bool isLong);

/// 程序发的股票开仓单放不放:intent = 这个账户这只股票在用的意图(没有就是空)。返回拒的原因
std::optional<QString> gateOpenOrder(const std::optional<util::OJson>& intent, const QString& symbol, const QString& action, double qty);

/// 解析出来的那张单({contract: {symbol}, order: {action, totalQuantity}})的代码
QString orderSymbol(const util::OJson& order);
/// 同 gateOpenOrder,方向与数量从那张单上取
std::optional<QString> gateOrder(const std::optional<util::OJson>& intent, const util::OJson& order);

}  // namespace ibkr::analysis::guard
