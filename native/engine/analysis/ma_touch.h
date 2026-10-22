// maTouch.ts:短期内反复碰同一条日均线——设置的校验、日线上的触碰与分段、底账、盘中这一轮该不该报。纯计算。
// 券商回来的日线是松的记录(OJson);底账(TouchBook)是引擎自己写的,收成结构;fired 是 {均线天数: 日期},键像数组下标,
// 按 JS 的键序排(OJson 管),所以留成 OJson。
#pragma once

#include "util/error.h"
#include "util/ordered_json.h"

#include <QString>

#include <functional>
#include <optional>
#include <vector>

namespace ibkr::analysis::ma_touch {

inline constexpr int kMaxTouchPeriods = 6;

class MaTouchError : public util::JsError {
public:
    using util::JsError::JsError;
};

/// MaTouchConfig(键序同 DEFAULT_TOUCH_CONFIG)
struct Config {
    bool enabled = true;
    std::vector<double> periods;
    double window_days = 0, min_touches = 0, band_pct = 0;
    util::OJson toJson() const;
};
const Config& defaultConfig();
/// raw 是界面 / 库里来的任意 JSON(空指针 = undefined);不合规抛 MaTouchError
Config normalizeTouchConfig(const util::OJson* raw, const Config& base = defaultConfig());

QString prevTradingDay(const QString& date, const std::function<bool(const QString&)>& isTradingDay);

struct DayBar {
    QString date;
    double high = 0, low = 0, close = 0;
};
/// bars 是数组(或 null / undefined:空指针)
std::vector<DayBar> completedBars(const util::OJson* bars, const QString& today);

struct TouchDay {
    QString date;
    double ma = 0;
    bool touched = false;
    QString side;
};
std::vector<TouchDay> touchDays(const std::vector<DayBar>& bars, double period, double bandPct);

struct Episode {
    QString start, end, side;
    util::OJson toJson() const;
};
std::vector<Episode> episodesOf(const std::vector<TouchDay>& days);

struct TouchLine {
    double period = 0, prior_sum = 0;
    std::vector<Episode> episodes;
    util::OJson toJson() const;
};
struct TouchBook {
    QString as_of;
    double window_days = 0, band_pct = 0;
    std::vector<double> periods;
    std::vector<TouchLine> lines;
    util::OJson fired = util::OJson();  // {"20": "2026-10-01", …}
    util::OJson toJson() const;
    /// 库里读回来的(引擎自己写的那个形状;缺键读成 NaN / 空串)
    static TouchBook fromJson(const util::OJson& o);
};
/// fired 是 {键: 日期};空指针 = 没给(同 `= {}`)
std::optional<TouchBook> buildTouchBook(const util::OJson* bars, const QString& today, const Config& config, const util::OJson* fired = nullptr);
bool bookUsable(const TouchBook* book, const Config& config, const QString& prevDay);

struct TouchHit {
    double period = 0;
    QString label;
    double ma = 0, count = 0;
    QString start;
    std::vector<Episode> prior;
    QString side, direction, text;
    util::OJson toJson() const;
};
struct Evaluation {
    std::vector<TouchHit> hits;
    util::OJson fired;
};
Evaluation evaluateTouches(const TouchBook& book, const Config& config, double price, std::optional<double> prevPrice, const QString& today);

}  // namespace ibkr::analysis::ma_touch
