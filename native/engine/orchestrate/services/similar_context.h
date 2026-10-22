// services/similarContext.ts 逐句搬:下单页「历史相似交易」要的几样行情——标的现价、历史蝴蝶开仓那一刻的标的价、股票进场价在近期区间的位置。
// 全部尽力而为:取不到就不给,那一项不比,绝不让整个请求失败。历史蝴蝶开仓时的标的价取一次就存进 trade_entry_context——历史不会变;
// 一个开仓日一次 1 分钟线请求:这次请求当场补最近的 kMaxNewDays 天,剩下的交给后台按 backfillGapMs 的间隔慢慢补(IBKR 的历史数据有请求频率限制)。
// 期望值:tests/fixtures/gen_svc_trades.mjs,tests/tst_svc_trades.cpp。
//
// 与 TS 的对应与不同:
//   · `router instanceof BrokerRouter`(富途的桥没核对过):RouterPort 恒是 BrokerRouter,只剩 hasSessions() 的判断。
//   · 后台补价的 setTimeout(带 unref)→ runtime().sleep;`.finally(() => backfilling = null)` 在协程末尾清。
//   · Map<string, number> → OrderedMap(插键先后);`new Date(when).toISOString()` → UTC、带毫秒、Z 结尾。
#pragma once

#include "contract/ordered_map.h"
#include "orchestrate/services/market_data.h"
#include "orchestrate/services/svc_host.h"

#include <QList>
#include <QString>

#include <optional>

namespace ibkr::orchestrate {

class SimilarContextService : public SvcBase {
public:
    /// 一次请求当场最多补几个交易日
    static constexpr int kMaxNewDays = 3;

    SimilarContextService(SvcHost& host, MarketDataService& market) : SvcBase(host), market_(market) {}

    /// 后台补的时候两次请求之间隔多久(毫秒)
    int backfillGapMs = 8'000;

    /// 标的现价;没连券商、取不到是空
    util::Task<std::optional<double>> spot(QString symbol);
    /// 等后台补完(测试用)
    util::Task<> idle();
    /// 这个标的的历史蝴蝶开仓那一刻的标的价(id → 价)。butterflies 是券商成交合成的蝴蝶记录,positions 是 Flex 仓位(有中心的才比)
    util::Task<contract::OrderedMap<double>> flyEntryUnderlyings(QList<util::OJson> butterflies, QList<util::OJson> positions, QString symbol);

    struct StockRanges {
        std::optional<double> query;
        contract::OrderedMap<double> byId;
    };
    /// 股票:现价与每段历史持仓的进场价,各自在「那之前 RANGE_LOOKBACK 根日线」高低区间里的位置
    util::Task<StockRanges> stockRanges(QString symbol, QList<util::OJson> facts);

private:
    struct EntryTarget {
        QString id;
        double when = 0;
        QString day;
    };
    util::Task<> runBackfill(QString symbol, QStringList days, QList<EntryTarget> want);
    util::Task<> backfill(QString symbol, QStringList days, QList<EntryTarget> want);
    util::Task<> fillDay(std::shared_ptr<RouterPort> router, QString symbol, QString day, QList<EntryTarget> want, contract::OrderedMap<double>* known);

    MarketDataService& market_;
    std::optional<util::Task<>> backfilling_;
};

}  // namespace ibkr::orchestrate
