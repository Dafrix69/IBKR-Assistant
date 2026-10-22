// flyExitSweepSpec.ts:蝶式出场参数扫描"比的是什么、拿什么比"——记下来的盘口 → 蝶价、实盘预设的参数怎么换成追踪的 Targets、
// 参数网格、入场人群与成交口径、结果的形状。纯数据与换算,不跑任何规则。
//
// 与 TS 的对应与差别(逐句搬,不顺手改):
//   · 类型是结构体;"从 JSON 来的值"(网格文件、点名的参数组、回放网格、--entries 的内容)仍收 OJson,类型检查与报错话同 TS
//     (liveSets 里每组参数先当 JS 对象留着,checkLive 过了才落成 LiveParams);
//   · TrackerRules<P, S> 的 P / S 是不透明的 std::any:分析层不许 import 编排层(tracker),所以由调用方递进来——
//     测试递的是 orchestrate::tracker 的那几个函数(TS 里递的是 `import * as tracker` 整个模块);
//   · TS 原样:replaySets 里 `key in REPLAY_DEFAULTS` 对 "constructor" "toString" 这类 Object.prototype 上的名字也是真,
//     这里只认 DEFAULTS 自己的键(没有人会这样写网格);CLOCK_KEYS 用 flyexit.h 的 isClockKey。
#pragma once

#include "util/error.h"
#include "util/ordered_json.h"

#include <QHash>
#include <QString>
#include <QStringList>

#include <any>
#include <functional>
#include <optional>
#include <vector>

namespace ibkr::analysis::sweep {

/// TS 的 `class SweepError extends Error`
class SweepError : public util::JsError {
public:
    using util::JsError::JsError;
};

// ---------------------------------------------------------------- 样本与盘口
/// 记下来的一条腿(ivSamples.IvSampleLeg 的子集);bid / ask 是空 = null
struct QuoteLeg {
    double strike = 0;
    QString right;
    std::optional<double> bid, ask;
};
/// 记下来的一笔(ivSamples.IvSample 的子集);by / expiry / symbol 没有这个键 = 空
struct QuoteSample {
    double t = 0, spot = 0;
    std::optional<QString> by, expiry, symbol;
    std::vector<QuoteLeg> legs;
};

/// 一只多头蝶:买 中心 − 翼宽、卖两张中心、买 中心 + 翼宽,同为看涨或看跌。right 是 "C" / "P"
struct FlySpec {
    double center = 0, wing = 0;
    QString right;
};
struct SignedLeg {
    double strike = 0;
    QString right;
    double ratio = 0;
};
std::vector<SignedLeg> flyLegs(const FlySpec& fly);
/// 每组几张合约(佣金按张收)
double contractsPerFly();

struct FlyQuote {
    /// 三条腿这一笔都在不在样本里
    bool listed = false;
    std::optional<double> mid, open, close_raw;
};

QString legKey(double strike, const QString& right);
using Book = QHash<QString, QuoteLeg>;
Book bookOf(const QuoteSample& sample);
FlyQuote quoteFrom(const Book& book, const FlySpec& fly);
FlyQuote flyQuote(const QuoteSample& sample, const FlySpec& fly);
/// 到期时这只蝶值多少:标的在两翼之间是一顶帐篷,之外是 0
double flyIntrinsic(const FlySpec& fly, double spot);
/// 入场价:中间价 + share ×(立刻买得到的价 − 中间价),朝多付的一侧取到组合的跳动上
double entryDebit(double mid, double open, double share, double tick);

// ---------------------------------------------------------------- 实盘预设的参数
struct LiveParams {
    double arm_usd = 0, tighten_usd = 0;
    double loose_pct = 0, mid_pct = 0, tight_pct = 0;
    double tight_at = 0;
    QString late_after;
    double late_factor = 0;
    double floor = 0;
    std::optional<double> stop_mult;
    std::optional<QString> exit_at;
};
/// 现在实盘用的那一组:全部从 flyexit 读出来
LiveParams liveReference();
/// 一组参数 + 这只蝶每组的开仓成本 → Targets 上那几项(键序同 TS:profit_drawdown_tiers, _late, _arm, _floor, stop_loss, exit_at, exit_at_ms)
util::OJson liveTargets(const LiveParams& p, double unitCostUsd, double debit, double entryMs);
double unitCost(double debit, double multiplier, const std::optional<double>& commission);

/// 参照组 + 网格的全部组合 + 另外点名的几组,去掉重复的。grid 是 --grid 文件里 live 那一节(OJson 对象,没有给就是空指针),
/// extra 是 sets 里的每一项。第一组永远是参照组。
std::vector<LiveParams> liveSets(const LiveParams& reference, const util::OJson* grid, const QList<util::OJson>& extra = {});
/// {arm_usd, tighten_usd, loose_pct, mid_pct, tight_pct, tight_at, late_after, late_factor, floor, stop_mult, exit_at}
util::OJson liveRow(const LiveParams& p);
QString liveLabel(const LiveParams& p, const LiveParams& reference);

// ---------------------------------------------------------------- 回放策略的参数
/// {键: 数 | 串}(键序同 TS 的展开写法)
using ReplayOverride = util::OJson;
/// flyexit.DEFAULTS 上的键各给几个取值(grid 是 {键: [取值…]} 的对象,没有是空指针)→ 全部组合。第一组是空的。
QList<ReplayOverride> replaySets(const util::OJson* grid);
QString replayLabel(const ReplayOverride& o);

// ---------------------------------------------------------------- 配置
struct Population {
    QString by = QStringLiteral("loop");  // loop / plan / all
    std::optional<QString> entry_from, entry_to;
    std::optional<std::vector<double>> wings;
    std::optional<std::vector<QString>> rights;
    std::optional<double> debit_min, debit_max, dist_min, dist_max;
};
struct RealEntry {
    double t = 0, center = 0, wing = 0;
    QString right;
    std::optional<double> quantity, debit;
};
/// 入场时刻的两种写法 → 毫秒;认不出是空
std::optional<double> parseEntryTime(const QString& text);
/// --entries 文件的内容 → 真实入场(raw 是 JSON 值;不对当场抛 SweepError)
std::vector<RealEntry> entriesFrom(const util::OJson& raw);
struct GridFile {
    util::OJson live, replay;
    QList<util::OJson> sets;
};
/// --grid 文件的内容
GridFile gridFileFrom(const util::OJson& raw);

struct FillModel {
    double entry_spread_share = 1;
    std::optional<double> commission;
    QString terminal = QStringLiteral("natural");  // natural / settle
    double settle_within_min = 6;
    QString stop_basis = QStringLiteral("mid");  // mid / natural
    double qty = 1, multiplier = 100;
};

struct ReplayConfig {
    /// em = "auto" 时每天从记下来的平值跨式取;不是 auto 就用 em 这个数
    bool emAuto = true;
    double em = 0;
    std::vector<ReplayOverride> sets;
};
struct SweepConfig {
    std::optional<QString> symbol;
    Population population;
    std::optional<std::vector<RealEntry>> entries;
    FillModel fill;
    std::vector<LiveParams> live;
    std::optional<ReplayConfig> replay;
    double stride = 1;
};

/// tracker.ts 里要用的那几个纯函数(P = 持仓,S = 结构,都是不透明的)。判定用的就是实盘那一份。
class TrackerRules {
public:
    virtual ~TrackerRules() = default;
    struct EvalOpts {
        bool hasStopPrice = false;  // opts.stopPrice 给了(值可以是 null)
        std::optional<double> stopPrice;
    };
    virtual QString stateHolding() const = 0;
    virtual std::any makePosition(const util::OJson& raw) const = 0;
    virtual util::OJson makeTargets(const util::OJson& raw) const = 0;
    /// 认不出结构回空
    virtual std::optional<std::any> structureOf(const QString& secType, const util::OJson& contract) const = 0;
    virtual QString legPriceKey(double strike, const QString& right) const = 0;
    virtual std::optional<double> naturalClosePrice(const std::any& position, const std::any& structure, const util::OJson& book) const = 0;
    virtual double closeTick(const std::any& position) const = 0;
    /// 建追踪时的那道校验:说不通就抛 util::JsError
    virtual void validate(const std::any& position, const util::OJson& targets, std::optional<double> price) const = 0;
    virtual util::OJson evaluate(const std::any& position, const util::OJson& targets, std::optional<double> price, std::optional<double> peak,
                                 std::optional<double> minute, const EvalOpts& opts) const = 0;
};

// ---------------------------------------------------------------- 结果
struct Matrix {
    std::vector<std::vector<double>> r, usd;
};
struct Spread {
    double min = 0, median = 0, max = 0;
};
struct FamilyResult {
    QString family;  // live / replay
    QStringList labels;
    std::vector<util::OJson> params;
    QStringList days;
    std::vector<double> scenarios;
    Matrix main, alt_terminal, coarse;
    /// 每组各种出场方式的情景数({方式: 数},键序同 JS 对象)
    std::vector<util::OJson> kinds;
    std::vector<double> stop_refused;
};
struct LossCap {
    double usd = 0, r = 0, wing = 0, debit_floor = 0;
};
struct ReplayResult {
    FamilyResult family;
    std::optional<Spread> em;
    double days_without_em = 0;
};
struct SweepData {
    double days = 0;
    std::optional<QString> first, last;
    double samples = 0, used = 0, not_same_day = 0, other_symbol = 0;
};
struct SweepResult {
    SweepData data;
    std::optional<QString> symbol;
    Population population;
    FillModel fill;
    double stride = 1;
    bool from_entries = false;
    double scenarios = 0;
    util::OJson skipped, filtered;  // {原因: 数}
    double no_decision_missing = 0, no_decision_total = 0;
    std::optional<Spread> debit;
    util::OJson wings;  // {翼宽: 几只}
    double short_days = 0;
    std::optional<LossCap> loss_cap;
    FamilyResult live;
    std::optional<ReplayResult> replay;
};

}  // namespace ibkr::analysis::sweep
