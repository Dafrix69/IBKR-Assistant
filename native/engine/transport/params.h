// engine-ts/src/rpc/params.ts:入参的小工具,各域 handler 共用的取数与校验。
// TS 的 Rec(RPC 入参)是 OJson;指针为空 = undefined。抛的是 util::RpcError(-32602),话一个字不改。
// 数值照 JS 的 Number() 读(util::js::num):数字串、布尔、数组都认,和 TS 一样宽松。
#pragma once

#include "util/ordered_json.h"
#include "util/rpc_error.h"

#include <QString>

#include <optional>

namespace ibkr::rpc {

/// SYMBOL_RE:/^[A-Z][A-Z0-9.-]{0,11}$/(JS 的 $ 只认串尾,不像 PCRE 还认串尾前的换行,所以不用正则)
bool symbolMatches(const QString& s);
/// String(params.symbol ?? "").trim().toUpperCase(),不合 SYMBOL_RE 抛「标的代码不合法:'<原值>'」
QString symbolOrRaise(const util::OJson& params);

/// 空字符串 / null / undefined → 空;其余 Number();NaN 抛「不是有效数字:'…'」。表单里的空格子是"不设",不是 0
std::optional<double> optFloat(const util::OJson* value);
/// null / undefined / "" / 0 → 空;数要有限、取整(Math.trunc);串要整串是一个整数(JS 的 \s 空白、可选正负号、ASCII 数字);其余抛「整数参数不合法:'…'」
std::optional<double> optInt(const util::OJson* value);

/// 利润回撤的起算门槛:界面填百分比,存成倍数(÷100);没填回空;0 与负数、超过 1000 抛错
std::optional<double> drawdownArmOf(const util::OJson& params);
/// 分档利润回撤:{profit_drawdown_tiers, profit_drawdown_late, profit_drawdown_arm, profit_drawdown_floor}(键序同 TS 的返回)。
/// flyUnitCostUsd 是蝶式每组的开仓成本(美元),只有 preset="fly" 时用
util::OJson drawdownTiersOf(const util::OJson& params, std::optional<double> flyUnitCostUsd = std::nullopt);
/// 到点平仓 / 标的止损的确认秒数 / 分批止盈:{exit_at, exit_at_ms, spot_stop_confirm_s, take_profit_tiers}。nowMs 是此刻的毫秒时间戳
util::OJson exitSettingsOf(const util::OJson& params, double nowMs);
/// 止损类拿哪个价判、追价节奏、峰值确认。没给的键不出现在结果里(update 是合并)
util::OJson stopSettingsOf(const util::OJson& params);

}  // namespace ibkr::rpc
