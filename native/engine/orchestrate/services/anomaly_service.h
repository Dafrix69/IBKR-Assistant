// services/anomaly.ts 逐句搬:优质股异动监控的 5 秒一轮循环——读量能流 → 逐只判(analysis/anomaly 的纯规则)→ 状态落库 → 有事件就推给界面;
// 连同大盘参照(marketMove)、「今天开出来没有」(dayOpenOf)、心跳(monitor)、内存里的样本与指标。每轮开头先让 AlertsService 捎带算价位 / 碰均线的底账。
// 期望值:tests/fixtures/gen_svc_anomaly.mjs(原 TS 服务 + 原 TS AlertsService 现跑,假宿主按脚本答、每一次调用都记下来)。
//
// 与 TS 的对应与不同:
//   · 量能流的读法(Svc1Router:supportsVolumeQuotes / volumeQuotes / releaseVolumeStreams)与大盘参照的 streamQuotes(RouterPort)见 svc1_ports.h。
//     TS 里 `typeof router.streamQuotes` 缺的那种 router(`source.streamQuotes?.()`)在 C++ 不存在:RouterPort 一定有 streamQuotes,
//     "没有这条路"与"这条路给了空 / 没有 MARKET_REF 这个键"走同一个分支(quote 为 undefined)。SUPPORTS_VOLUME_QUOTES 缺 = dynamic_cast 到 Svc1Router 失败 = 当"不支持"。
//   · 量价快照(volumeQuotes 回的 JSON)按 TS 的 typeof 逐项读:只有 number 算数(NaN / Infinity 照样带进去,下游 positive / finiteNum 去挡),
//     别的类型一律当没有;delayed 只认布尔 true 参与时钟拨回,而「延迟」标记那一处(`result.metrics.delayed || snap.delayed`)用 JS 的真值。
//   · `quotes[symbol]` 为 JSON null 时 TS 在 `snap.error` 上抛 TypeError("Cannot read properties of null (reading 'error')"),被每只股自己的 try 接住记进 last_error;
//     这里用 js::propStrict 抛同一句。基本类型(数、串)的快照当 {}。
//   · 一轮 tickOnce 排成一队(anomalyChain):TS 是 `chain.then(() => tickInner(nowMs ?? nowEt().epochMs))`,缺省时刻在**前一轮落定之后**才取——这里同样(runAfter 先 co_await 前一轮再取)。
//     下一轮挂在 run.onDone 上(waiters 先于 callbacks 唤醒),对应 JS 里"调用方的 await 先续、链上的下一轮要再让一拍才起"。
//   · JS 对 `.then` / 已完成 Promise 的 await 要让一个微任务,util::Task 不让:一次 tickOnce() 调用在前一轮已完成时,C++ 当场跑到第一个真正的挂起点,
//     TS 要等到下一次排空微任务。只有"启动之后、下一步是改库 / 改设置 / 改 router 的同步步骤"才看得出来,对拍脚本里 start:true 的 tickOnce 后面一律跟 advance / await(见生成器)。
//     循环里 `await this.tickOnce().catch(...)` 的几跳同理:不会产生可观察的日志次序差别(那几跳之间没有任何记录)。
//   · `timer.unref?.()` 无对应(QTimer 不挂住进程)。setTimeout 的延迟取整数毫秒(SvcRuntime::setTimeout 是 int):脚本里的节拍都是整数。
//   · 引擎 / 库每次用到都现取(TS 在一轮开头取一次 store 用到底;引擎中途重建时 TS 写的是旧库、这里写新库——测试里引擎不换,看不出;不把引用跨 co_await 存着)。
//   · 协程是成员函数,参数一律传值:AnomalyService 必须活得比所有未完成的调用长(同 TS 闭包抓着 this),循环的计时器回调里抓的是 this。
//   · TS 原样:releaseVolumeStreams 在"没有启用的股"那一支没有 try(抛了就落到最外层 catch,后面的清理都不做,skipped 还是空串);
//     「不在交易时段」那一支只清样本不清指标、不重置 delayed;`stock["events"]` 不是数组 / null 时 TS 的展开会抛,这里不建模(库里写进去的永远是数组)。
#pragma once

#include "analysis/anomaly.h"
#include "orchestrate/services/alerts_service.h"
#include "orchestrate/services/svc1_ports.h"

#include <QString>

#include <map>
#include <optional>
#include <vector>

namespace ibkr::orchestrate {

class AnomalyService : public Svc1Base {
public:
    AnomalyService(Svc1Host& host, AlertsService& alerts) : Svc1Base(host), alerts_(alerts) {}

    static constexpr int kMaxQuality = 30;
    /// 异动监控一轮的节拍。量能流是常驻的,一轮只是读内存里的最新值
    static constexpr double kAnomalyTickMs = 5000;
    /// 开盘前这么多分钟就把量能流订上
    static constexpr double kAnomalyWarmupMinutes = 10;
    /// 收盘后再留这么多分钟
    static constexpr double kAnomalyTailMinutes = 20;
    /// 延迟行情比实时晚这么多分钟
    static constexpr double kDelayedShiftMinutes = 15;
    /// 最后一笔成交超过这么久没动:行情冻住了,本轮不判
    static constexpr double kQuoteStaleMs = 15 * 60'000;
    static inline const QString kQualityConfigPref = QStringLiteral("quality.config");
    /// 大盘参照:标普 500 指数(和顶栏宏观带同一个键)
    static inline const QString kMarketRef = QStringLiteral("IND:SPX@CBOE");

    /// QualityMetricsHit:最近一轮的指标(metrics 空 = null);取不到行情时记原因
    struct MetricsHit {
        std::optional<util::OJson> metrics;
        QString at;
        std::optional<QString> error;
        util::OJson toJson() const;
    };

    void start(double intervalMs = kAnomalyTickMs);
    void stop();
    /// 一轮异动监控(排在队里);nowMs 空 = 前一轮落定之后的 nowEt().epochMs。回 {events, evaluated, skipped, levels, touch}
    util::Task<util::OJson> tickOnce(std::optional<double> nowMs = std::nullopt);
    /// 当前生效的触发条件。存坏了按默认
    analysis::anomaly::Config config();
    /// QualityMonitor(键序同 TS)
    util::OJson monitor();
    std::optional<MetricsHit> metricsOf(const QString& symbol) const;
    void forget(const QString& symbol);

private:
    struct DayOpen {
        QString date;
        bool watchedBefore = false;
        std::optional<double> staleOpen, firstLast;
        bool opened = false;
        std::optional<double> open;
    };
    struct MarketRef {
        QString date;
        std::optional<double> first, last, tickedAt, changedAt;
    };
    /// 循环的心跳
    struct LoopState {
        bool running = false;
        double interval_ms = kAnomalyTickMs;
        double ticks = 0;
        std::optional<QString> last_at;
        std::optional<double> last_ms;
        QString last_error;
        bool delayed = false;
        std::optional<bool> market_ref;
    };

    util::Task<std::optional<analysis::anomaly::MarketMove>> marketMove(std::shared_ptr<RouterPort> router, double nowMs, double windowMin, QString etDate, double minute,
                                                                         double openMs);
    struct DayOpenResult {
        bool opened = false;
        std::optional<double> open;
    };
    DayOpenResult dayOpenOf(const QString& symbol, const analysis::anomaly::VolumeSnapshot& snap, const QString& etDate, double minute, double openMs);
    util::Task<util::OJson> runAfter(util::Task<> prev, std::optional<double> nowMs);
    util::Task<util::OJson> tickInner(double nowMs);
    util::Task<> tickBody(double nowMs, std::shared_ptr<util::OJson> out);
    util::Task<> loop(int gen, double intervalMs);
    void schedule(int gen, double intervalMs, double delay);
    std::optional<util::OJson> storedAnomalyState(const util::OJson* raw, const QString& etDate);
    QList<util::OJson> enabledStocks();
    void dropMarket();

    AlertsService& alerts_;
    std::optional<int> timer_;
    int gen_ = 0;
    util::Task<> chain_ = util::Task<>::resolved();
    LoopState loop_;
    std::map<QString, std::vector<analysis::anomaly::Sample>> qualitySamples_;
    std::map<QString, MetricsHit> qualityMetrics_;
    std::vector<analysis::anomaly::Sample> marketSamples_;
    std::optional<MarketRef> marketRef_;
    std::map<QString, DayOpen> dayOpens_;
};

}  // namespace ibkr::orchestrate
