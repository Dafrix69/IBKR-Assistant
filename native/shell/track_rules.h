// 持仓追踪页的纯逻辑(逐条搬):数与时间的写法(lib/format.ts)、标的止损的三句话(lib/spotStopFormat.ts)、
// 出场细则——表单 → tracker.add 载荷里的那几个键、界面这头查出的毛病、确认框里的话、卡片上的摘要(lib/trackExitForm.ts)、
// 追踪状态的叫法(lib/labels.ts 的 TRACK_STATE_LABEL)、一条腿怎么写(lib/TrackCard.tsx 的 legLabel)。
// 期望值由 node 跑原模块现算(tests/fixtures/gen_track_rules.mjs)。
//
// exitSpec 进钱路径:数照界面的老规矩给字符串,'' = 不设;原模块里是 undefined 的键一个都不带(tracker.add 的 schema 是 .strict(),
// 多一个 null 都会被当场拒)。
#pragma once

#include <QHash>
#include <QJsonArray>
#include <QJsonObject>
#include <QString>
#include <QStringList>

#include <optional>

namespace ibkr::shell::track {

/// 表单里的一个数:数照收;null / 不给 / 空串 = 不设;数字串照数读;别的(读不成数)记进 invalid 并当没有
std::optional<double> formNumber(const QJsonValue& v, const QString& key, QStringList* invalid);

// ---------------------------------------------------------------- 数与时间
/// 定点小数,不带千分位;不是有限的数是「—」(Number() 的读法:null 是 0,undefined 与读不出的是 —)
QString fmtNum(const QJsonValue& value, int digits = 2);
/// 千分位、两位小数;null / undefined / 读不出的是「—」
QString fmtMoney(const QJsonValue& value);
/// 'YYYYMMDD' → 'YYYY-MM-DD';别的照原样(去掉首尾空白),空的是空
std::optional<QString> fmtExpiry(const QJsonValue& value);

// ---------------------------------------------------------------- 标的止损
QString spotStopSummary(std::optional<double> below, std::optional<double> above);
/// row:引擎每一轮给的那一份(契约里的 SpotStop):{ below, above, spot, spot_note?, reason?, pending? }
QString spotStopLine(const QString& symbol, const QJsonObject& row);
QString spotStopConfirmLine(const QString& symbol, std::optional<double> below, std::optional<double> above);

// ---------------------------------------------------------------- 出场细则
inline constexpr int kMaxTiers = 4;

struct TierField {
    std::optional<double> price;
    std::optional<double> fraction;
};

struct ExitFields {
    /// 美东 "HH:MM";空串 = 不设
    QString exitAt;
    std::optional<double> stopConfirm;
    QString stopBasis = QStringLiteral("mid");
    std::optional<double> chaseGrace;
    std::optional<double> chaseStep;
    std::optional<double> chaseMax;
    /// 快速下跌时的追价:按跌速多让的倍数、改价的最短间隔(秒);空 = 默认(1 倍、1 秒)。管所有触发的追价
    std::optional<double> chaseLead;
    std::optional<double> chaseInterval;
    std::optional<double> rapidWindow;
    std::optional<double> rapidPct;
    bool peakConfirm = false;
    QList<TierField> tiers;
    /// fromJson 时既不是空、也读不成数的那几项(键名)。React 版的输入框只交数或 null,这里不该有;有了就是界面的毛病,
    /// 绝不能当成"没填"——那会让一道保护悄悄没设上(startTrack 见到它就不往下走)
    QStringList invalid;
    /// 表单那一份 JSON(同 React 版 ExitFields 的键):数,或 null / 不给 = 不设;数字串照数读
    static ExitFields fromJson(const QJsonObject& o);
};

struct ProblemOpts {
    bool hosted = false;
    bool hasSpotStop = false;
    bool stock = false;
    bool hasStockStop = false;
};

/// 表单 → tracker.add 载荷里的那几个键(exit_at、spot_stop_confirm_s、take_profit_tiers、stop_basis、stop_chase_*、peak_confirm、chase_lead、chase_interval_s)
QJsonObject exitSpec(const ExitFields& f, bool derivative);
QStringList exitProblems(const ExitFields& f, const ProblemOpts& opts);
/// 确认框里的那几行(带换行);一样都没设是空串
QString exitConfirmLines(const ExitFields& f, bool derivative);
/// 分批止盈一档的状态
QString tierLabel(const QJsonObject& tier, int index);
/// 到点平仓的那一刻:美东「月-日 时:分」
QString exitMoment(double ms);
/// 卡片摘要里的几项;没设的不出现
QStringList exitSummary(const QJsonObject& targets, const QJsonObject& autoClose, bool stock = false);

// ---------------------------------------------------------------- 叫法
const QHash<QString, QString>& trackStateLabel();
/// 一条腿怎么写:组合写它的 label、期权写行权价 + C/P + 到期日、别的只写代码
QString legLabel(const QString& symbol, const QString& secType, const QJsonObject& contract);

}  // namespace ibkr::shell::track
