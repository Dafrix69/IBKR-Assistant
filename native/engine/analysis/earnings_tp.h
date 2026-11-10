// 财报止盈的纯计算:财报日 + 发布时段 → 生效窗口与基准日;正股此刻在哪个时段(含夜盘);涨幅 → 止盈价;拿什么价判。
// 只算不取数、不发单。口径见 docs/features/earnings-tp.md。
#pragma once

#include "util/ordered_json.h"

#include <QString>

#include <functional>
#include <optional>

namespace ibkr::analysis::etp {

inline const QString kAfter = QStringLiteral("AFTER MARKET");
inline const QString kBefore = QStringLiteral("BEFORE MARKET");
inline const QString kOvernight = QStringLiteral("夜盘");
/// IBKR 夜盘的交易所代码(和 K 线那一路同一个)
inline const QString kOvernightExchange = QStringLiteral("OVERNIGHT");

/// 交易日历:哪天开市、哪天提前收盘(日期是美东 YYYY-MM-DD)
struct Calendar {
    std::function<bool(const QString&)> tradingDay;
    std::function<bool(const QString&)> earlyClose;
};

struct Window {
    QString date, timing;      // 财报日、发布时段(kAfter / kBefore)
    QString refDate, reactDate;  // 基准日(取它的收盘价)、反应日(财报后第一个常规时段)
    double startMs = 0, endMs = 0;  // 基准日收盘 → 反应日收盘
};
struct Planned {
    std::optional<Window> window;
    QString issue;  // 排不出窗口的原因(window 为空时)
};
/// 盘后发:基准日 = 财报日,反应日 = 下一个交易日;盘前发:基准日 = 上一个交易日,反应日 = 财报日。
/// 时段不是这两种、日期不合法、财报日不是交易日的排不出
Planned planWindow(const QString& date, const QString& timing, const Calendar& cal);

/// 正股此刻的时段:base 是正股日历给的(盘前 / 盘中 / 盘后 / 休市);休市里美东 20:00–03:50、所属交易日开市的那一段是夜盘
QString stockSession(const QString& base, const QString& etDate, double etSeconds, const Calendar& cal);

/// 多头:基准收盘 × (1 + pct%);空头:× (1 − pct%)。入参不是正数回空
std::optional<double> targetPrice(bool isLong, double refClose, double pct);
/// 拿来判的价 = 此刻立刻能成交的价:多头(要卖)看买价,空头(要买回)看卖价。买卖价缺一、不是正数、倒挂的回空
std::optional<double> executable(bool isLong, std::optional<double> bid, std::optional<double> ask);
bool reached(bool isLong, double target, double exec);
/// 涨幅百分比的范围(只挡手误):0 < pct ≤ 500
std::optional<QString> pctIssue(double pct);
/// 界面与日志里的时段说法:盘后 / 盘前
QString timingLabel(const QString& timing);

}  // namespace ibkr::analysis::etp
