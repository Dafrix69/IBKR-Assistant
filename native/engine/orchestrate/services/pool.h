// services/pool.ts 逐句搬:股票池——一只股身上的两个开关(盯价位 / 盯异动),以及把旧库并成一个池子的一次性迁移。
// 板块成分股 = 股票池,一只股只登记一次;alert_watches 有这一行 ⟺「盯价位」开,quality_stocks 有这一行 ⟺「盯异动」开。
// 期望值:tests/fixtures/gen_svc_pool.mjs(原 PoolService 对着真的交易库现跑,AlertsService / AnomalyService 换成只记录 forget 的替身),tests/tst_svc_pool.cpp。
//
// 与 TS 的对应与不同:
//   · TS 构造时收 AlertsService / AnomalyService 两个对象,只用它们的两个静态常量(MAX_WATCH、ORIGIN_TRACKER、MAX_QUALITY)与 forget(symbol)。
//     这里收成 PoolPorts:三个常量(引擎装配时从 svc1 簇的 AlertsService / AnomalyService 取)与两个 forget 函数。
//   · 行(监控、异动、板块)是 JS 对象(OJson);`String(w["symbol"])` 一律按 JS 的 String() 读。
//   · process.stderr.write → logStderr(迁移失败那一行)。
#pragma once

#include "orchestrate/services/svc_host.h"

#include <QStringList>

#include <functional>
#include <optional>

namespace ibkr::orchestrate {

struct PoolPorts {
    int maxWatch = 30;                        // AlertsService.MAX_WATCH
    QString originTracker = QStringLiteral("tracker");  // AlertsService.ORIGIN_TRACKER
    int maxQuality = 30;                      // AnomalyService.MAX_QUALITY
    std::function<void(const QString&)> forgetAlert;    // alerts.forget(symbol)
    std::function<void(const QString&)> forgetAnomaly;  // anomaly.forget(symbol)
};

struct PoolWatchPatch {
    std::optional<bool> price, anomaly;
};

class PoolService : public SvcBase {
public:
    /// 新股进池子时的默认:两个开关都开
    static constexpr bool kDefaultPrice = true, kDefaultAnomaly = true;
    /// 新建价位提醒的整数关口步长:0 = 自动
    static constexpr double kDefaultWatchStep = 0;
    static inline const QString kPoolMigratedPref = QStringLiteral("pool.migrated_v1");
    /// 孤儿股(有开关却不在任何板块)并进这个板块
    static inline const QString kPoolDefaultSector = QStringLiteral("自选");

    PoolService(SvcHost& host, PoolPorts ports) : SvcBase(host), ports_(std::move(ports)) {}

    /// 开 / 关一只股身上的价位与异动。只动传进来的那个;已经是那个状态就当没事(幂等)。返回 {symbol, price_on, anomaly_on, skipped}
    util::OJson setWatch(const QString& symbol, const PoolWatchPatch& patch, const QString& note = {});
    /// 保证这只股在池子里:不在任何板块就并进「自选」。返回并入的板块名,本来就在回空
    std::optional<QString> ensureInPool(const QString& symbol, const QString& company = {});
    /// 移出池子之后的连带清理
    QStringList dropWatches(const QStringList& symbols);
    /// 一次性迁移(标记存在 app_prefs 的 pool.migrated_v1)
    void ensureMigrated();

private:
    PoolPorts ports_;
    bool poolMigrated_ = false;
};

}  // namespace ibkr::orchestrate
