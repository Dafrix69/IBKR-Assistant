// services/marketData.ts 逐句搬:行情缓存——K 线、日线历史、期权墙、现价。K线 PA、扫描器、价位提醒、交易分析四处共用,缓存在这里只有一份
// (这是节流不是性能优化:IBKR 15 秒内的相同历史请求算超频,期权链一次几十条行情线路)。
// 期望值:tests/fixtures/gen_svc_marketdata.mjs(原 MarketDataService 对着脚本驱动的假 router、虚拟钟现跑),tests/tst_svc_marketdata.cpp。
//
// 与 TS 的对应与不同:
//   · router 走 RouterPort(svc_host.h);TS 的 `router.spotInfo?.()` 可选调用在 RouterPort 上是必有方法。
//   · performance.now() → runtime().perfMs()(醒着的时间,睡眠里不走,见 svc_runtime.h);K 线 / 日线 / 期权墙是 JS 对象(OJson),K 线缓存里放 TaggedBars
//     (TS 里 feed 记在数组旁边的 WeakMap 里,C++ 没有数组身份可挂,同 ib_bars.h 的处理)。
//   · `this.router!.intradayBars(...)`:router 空 → TS 抛 TypeError「Cannot read properties of null (reading 'intradayBars')」,这里抛同一句的 JsError。
//   · paBars 里 `TIMEFRAMES[timeframe]!` 只在不强制时才读 seconds;未知周期 + 不强制 → TS 抛 TypeError「Cannot read properties of undefined (reading 'seconds')」,同。
//   · TS 的 `await import(...)` 在函数头(多让一拍微任务)不搬。
#pragma once

#include "contract/ordered_map.h"
#include "execution/ib_bars.h"
#include "orchestrate/services/svc1_ports.h"
#include "orchestrate/services/svc_host.h"

#include <QHash>
#include <QList>
#include <QString>

#include <map>
#include <optional>
#include <tuple>

namespace ibkr::orchestrate {

/// 这份链取了哪一段(coverageOf):取到数的最低与最高一档、几档;抽着取的会标出来。strikes 空时 lower = +Infinity、upper = -Infinity(同 Math.min / Math.max)
util::OJson coverageOf(const QList<double>& strikes, const util::OJson* asked, const util::OJson* gridCount);
/// 抽着取的链要说出来:远处没取的档不在净 GEX、最大痛点、墙里
QStringList thinnedWarning(const util::OJson& coverage);

// SpotQuote(price / tradedAt / source)在 svc1_ports.h(svc1 簇的价位提醒与剧本也要它);MarketDataPort 也在那里,这个类实现它
using QuoteMap = contract::OrderedMap<std::optional<SpotQuote>>;

/// paBars 的结果:[K 线, 是不是缓存里的, 取回时刻(epoch 毫秒), 出自哪一档行情]
struct PaBars {
    execution::TaggedBars bars;
    bool cached = false;
    double askedAt = 0;
    std::optional<execution::BarsFeed> feed;
};

class MarketDataService : public SvcBase, public MarketDataPort {
public:
    static constexpr double kPaMinInterval = 15.0;  // IBKR 判定 15 秒内的相同历史请求为超频
    static constexpr double kWallTtlMs = 60'000;    // 期权链一次要几十条行情线路,别让界面反复拉
    static constexpr double kHistTtlMs = 600'000;   // 日线一天才多一根,反复重算不该反复打券商
    static constexpr int kHistSpanDays = 420;       // 250 个交易日 ≈ 360 个日历日,留假期余量

    explicit MarketDataService(SvcHost& host) : SvcBase(host) {}

    /// 一份期权墙。width = 现价上下各取多少档;span = 调用方要看到现价上下各多少点;preferClass = 点名要哪个交易类(只有日内剧本给)
    util::Task<util::OJson> wallFor(QString symbol, std::optional<QString> expiry, double width = 10, std::optional<double> span = std::nullopt,
                                    QString preferClass = {}) override;
    /// 拉日线历史(警报算均线 / 52 周位用),带 TTL 缓存。spanDays:往回要多少个日历日,缺省 kHistSpanDays,只能更长
    util::Task<QList<util::OJson>> dailyHistory(QString symbol, double spanDays);
    util::Task<QList<util::OJson>> dailyHistory(QString symbol) override { return dailyHistory(std::move(symbol), double(kHistSpanDays)); }
    /// 缓存里那份日线是几点取的(epoch 毫秒,发出请求的那一刻);没有缓存空
    std::optional<double> dailyHistoryAskedAt(const QString& symbol) const;
    util::Task<std::optional<double>> spotOf(QString symbol) override;
    /// 一只标的此刻的价与它的来历。指数走 indexPrice,出处从 spotInfo 读;取不到空
    util::Task<std::optional<SpotQuote>> quoteOf(QString symbol);
    /// 一批标的的现价与来历:非指数的合成一次 streamQuotes;批量抛了错就退回逐只问。取不到的给空。Map 的先后 = TS 里插入的先后
    util::Task<QuoteMap> quotesOfOrdered(QStringList symbols);
    /// MarketDataPort 的那一面(按代码查;先后不保)
    util::Task<std::map<QString, std::optional<SpotQuote>>> quotesOf(QStringList symbols) override;
    /// 带 TTL 的 K 线缓存——这是节流,不是性能优化(IBKR 超频会掐行情连接)
    util::Task<PaBars> paBars(QString symbol, QString timeframe, bool rth, bool force = false, bool indexProxy = false);

private:
    struct PaEntry {
        double at = 0;
        execution::TaggedBars bars;
        double askedAt = 0;
    };
    struct WallEntry {
        double at = 0;
        util::OJson wall;
        std::optional<double> span;
    };
    struct HistEntry {
        double at = 0;
        QList<util::OJson> bars;
        double span = 0;
        double askedAt = 0;
    };
    QHash<QString, PaEntry> paCache_;
    QHash<QString, WallEntry> wallCache_;
    QHash<QString, HistEntry> histCache_;
};

}  // namespace ibkr::orchestrate
