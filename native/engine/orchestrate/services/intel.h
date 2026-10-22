// services/intel.ts 逐句搬:信息链路的编排——把消息、信号、事件、单子、想法按标的串起来,给界面一条时间线和一份标的档案。只读、不发单。
// 取价只走已经在订着的那几路(指数走 indexPrice,股票池 / 持仓 / 盯价位的走常驻流),别的标的不另订行情。
// 期望值:tests/fixtures/gen_svc_intel.mjs(原 IntelService 对着脚本驱动的假 router、真的交易库、虚拟钟现跑),tests/tst_svc_intel.cpp。
//
// 与 TS 的对应与不同:
//   · anomaly(`Pick<AnomalyService, "metricsOf">`)收成一个函数 changePctOf(代码 → 异动监控此刻算的涨跌幅,没有 / 不是数是空):TS 两处都只读
//     `hit?.metrics?.change_pct ?? null`。引擎装配时用 AnomalyService::metricsOf 实现它。
//   · feed / dossier 的入参是松的 JSON(OJson),同 TS 的 params;返回的 IntelFeed / IntelDossier 也是 OJson(键序同 TS 的对象字面量)。
//   · process.stderr.write → logStderr(execution/ib_link.h,测试接走)。
//   · Map 的先后:pricesOf 先放"没在订的"(空)再放"取到的";messageItem 只查表,不看先后,但 prices 对象的键序取决于它。
#pragma once

#include "analysis/symbol_mentions.h"
#include "orchestrate/services/events.h"
#include "orchestrate/services/market_data.h"
#include "orchestrate/services/svc_host.h"
#include "util/discord_gateway.h"

#include <QList>

#include <functional>
#include <optional>

namespace ibkr::orchestrate {

class IntelService : public SvcBase {
public:
    IntelService(SvcHost& host, MarketDataService& market, EventsService& events, std::function<std::optional<double>(const QString&)> changePctOf = {});

    std::function<double()> nowFn;

    /// 此刻的持仓(含折出来的组合行);没连券商、读失败都是空
    util::Task<QList<util::OJson>> heldRows();
    /// 认标的用的名单:指数、别名表、持仓、追踪、股票池、板块、盯价位的
    analysis::symbol_mentions::Universe universe(const QStringList& held);
    /// 频道里的每一条消息(信任与否都递);只有信任名单里的人说的才落底账
    util::Task<> record(util::DiscordMessage message, bool trusted);
    util::Task<util::OJson> feed(util::OJson params);
    util::Task<util::OJson> dossier(util::OJson params);

private:
    bool connected();
    QSet<QString> streaming(const QStringList& held);
    util::Task<contract::OrderedMap<std::optional<double>>> pricesOf(QStringList symbols, QStringList held);
    QList<util::OJson> recordFacts(double limit);
    util::Task<QList<util::OJson>> eventRows();
    QStringList eventSymbols(const util::OJson& event, const analysis::symbol_mentions::Universe& universe);
    util::Task<std::optional<util::OJson>> quoteFor(QString symbol, QStringList held);

    MarketDataService& market_;
    EventsService& events_;
    std::function<std::optional<double>(const QString&)> changePctOf_;
    struct HeldCache {
        double at = 0;
        QList<util::OJson> rows;
    };
    std::optional<HeldCache> heldCache_;
};

}  // namespace ibkr::orchestrate
