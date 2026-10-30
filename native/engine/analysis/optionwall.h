// optionwall.ts(对应 Python optionwall.py):期权墙——持仓量墙 / 成交量墙 / GEX / gamma 翻转位 / 最大痛点,与给人看的说明。纯计算。
// 链上的行是券商回包的原样(OJson):toRows 照 TS 的读法整理(right 先大写再取首字、strike 要是有限的正数、未平仓量没等到 ≠ 0 张)。
// gamma 现价处优先用券商的模型 gamma,标的挪到别处只能 BS 重算(r = 0、无股息,T 有一小时的下限)。
#pragma once

#include "util/error.h"
#include "util/ordered_json.h"

#include <QList>
#include <QString>

#include <optional>
#include <vector>

namespace ibkr::analysis::optionwall {

inline constexpr double kMultiplier = 100.0;
inline constexpr int kMinStrikes = 5;

class OptionWallError : public util::JsError {
public:
    using util::JsError::JsError;
};

struct OptionRow {
    double strike = 0;
    QString right;  // C / P
    double oi = 0;
    bool oiMissing = false;
    double volume = 0;
    std::optional<double> gamma, iv;
    util::OJson toJson() const;
};
/// raw 里不是对象的项同 TS 抛 TypeError("Cannot read properties of null (reading 'right')")
std::vector<OptionRow> toRows(const QList<util::OJson>& raw);

double bsGamma(double spot, double strike, double t, double sigma);
/// nowEpochMs 空 = Date.now()
double yearsToExpiry(const QString& expiry, std::optional<double> nowEpochMs = std::nullopt, const QString& symbol = {}, const QString& tradingClass = {});

struct Gex {
    double net = 0, gross = 0, rows = 0;
};
Gex gexAt(const std::vector<OptionRow>& rows, double spot, double t, double multiplier = kMultiplier);
Gex bsGexAt(const std::vector<OptionRow>& rows, double at, double t, double multiplier = kMultiplier);
bool gexSignConflict(const std::vector<OptionRow>& rows, double spot, double t, double multiplier = kMultiplier);
std::optional<double> gammaFlip(const std::vector<OptionRow>& rows, const std::vector<double>& strikes, double spot, double t, double multiplier = kMultiplier);

/// 按 GEX(gamma × OI × 乘数 × S² × 1%,gamma 取法同 gexAt)称出来的三道位,不分现价上下:
/// { call_gex_wall: { strike, gex, distance_pct } | null(看涨 GEX 最大的行权价), put_gex_wall(看跌 GEX 最大,gex 记正),
///   max_gamma(净 GEX 绝对值最大的行权价,gex 带正负号) }。一样大的取离现价近的;称不出分量(全是 0)的那一道是 null。
util::OJson gexWalls(const std::vector<OptionRow>& rows, double spot, double t, double multiplier = kMultiplier);

/// OptionWallCore(键序同 TS)
util::OJson analyze(const QList<util::OJson>& raw, double spot, const QString& expiry = {}, const QString& symbol = {}, double multiplier = kMultiplier,
                    std::optional<double> nowEpochMs = std::nullopt, const QString& tradingClass = {});
/// result 是 analyze 的结果(松的记录,按 TS 的读法取)
util::OJson levelsForPa(const util::OJson& result);

}  // namespace ibkr::analysis::optionwall
