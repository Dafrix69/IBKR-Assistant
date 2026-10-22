#include "orchestrate/services/trade_history.h"

#include "analysis/ibtrades.h"
#include "analysis/trade_outcomes.h"
#include "analysis/tradereview.h"
#include "util/js_runtime.h"
#include "util/jsobj.h"

#include <QHash>
#include <QSet>

#include <cmath>
#include <memory>

namespace ibkr::orchestrate {

using namespace Qt::StringLiterals;
using util::OJson;
using util::Task;
namespace js = util::js;
namespace to = analysis::trade_outcomes;
namespace pf = analysis::performance;

/// 读库、去过重之后的原料
struct TradeHistoryService::Gathered {
    QList<OJson> butterflies, trips, positions, options;
    QSet<QString> covered;
    to::IsPaper isPaper;
    to::SettleClose settleClose;
    double now = 0;
};

Task<TradeHistory> TradeHistoryService::load(QStringList symbols) {
    const Gathered g = co_await gather(symbols);
    const QList<OJson> optionFacts = to::optionFacts(g.options, g.isPaper, g.covered);
    QList<OJson> extra = optionFacts;
    extra.append(to::positionFacts(g.positions, g.isPaper));
    TradeHistory out;
    out.facts = to::collectFacts(g.butterflies, g.trips, g.settleClose, g.now, symbols, extra);
    out.butterflies = g.butterflies;
    out.options = g.options;
    out.positions = g.positions;
    co_return out;
}

Task<pf::Ledger> TradeHistoryService::ledger() {
    const Gathered g = co_await gather({});
    pf::LedgerInputs in;
    in.butterflies = g.butterflies;
    in.trips = g.trips;
    in.positions = g.positions;
    for (const OJson& s : store().plannedStops()) {
        pf::PlannedStop p;
        p.at = js::str(js::prop(&s, u"at"_s));
        if (const OJson* a = js::prop(&s, u"account"_s); !js::nullish(a)) p.account = js::str(a);
        p.symbol = js::str(js::prop(&s, u"symbol"_s));
        if (const OJson* t = js::prop(&s, u"sec_type"_s); !js::nullish(t)) p.sec_type = js::str(t);
        p.stop = js::num(js::prop(&s, u"stop"_s));
        in.stops.push_back(p);
    }
    for (const OJson& r : g.options) {
        if (!g.covered.contains(js::str(js::prop(&r, u"account_id"_s)) + u'|' + js::str(js::prop(&r, u"date_et"_s)))) in.options.append(r);
    }
    in.settleClose = g.settleClose;
    in.isPaper = g.isPaper;
    in.now = g.now;
    co_return pf::buildLedger(in);
}

/// 两条路共用的那一段:读库、去重、到期结算要的收盘价。symbols 只管去取哪些标的的日线
Task<TradeHistoryService::Gathered> TradeHistoryService::gather(QStringList symbols) {
    QList<OJson> accounts;
    QSet<QString> paper;
    for (const auto& a : settings().accounts) {
        accounts.append(js::object({{u"alias"_s, js::S(a.alias)}, {u"account_id"_s, js::S(a.account_id)}, {u"is_paper"_s, js::B(a.is_paper)}}));
        if (a.is_paper) paper.insert(a.account_id);
    }
    const QList<OJson> fills = store().listFills();
    auto& imports = store().imports();
    const QList<OJson> positions = imports.listOptionPositions();
    const QStringList byPositionsList = to::positionDays(positions);
    const QSet<QString> byPositions(byPositionsList.begin(), byPositionsList.end());
    // Flex 仓位覆盖的那几天,券商成交合成的蝴蝶让给仓位(同一笔,仓位的了结方式更准)
    QList<OJson> butterflies;
    for (const OJson& r : analysis::ibtrades::groupButterflies(fills, accounts)) {
        const std::optional<double> when = analysis::tradereview::parseWhen(js::prop(&r, u"created_at"_s));
        const OJson* acct = js::prop(&r, u"account"_s);
        const OJson* idv = js::prop(js::nullish(acct) ? nullptr : acct, u"account_id"_s);
        const QString id = js::nullish(idv) ? QString() : js::str(idv);
        if (!when || !byPositions.contains(id + u'|' + analysis::tradereview::etKey(*when, true))) butterflies.append(r);
    }
    const QList<OJson> trips = co_await stockTrips_.trips();  // 连着券商时按当前持仓反推期初仓位,同交易分析页
    const double now = util::dateNow();

    QSet<QString> want;
    for (const QString& s : symbols) want.insert(s.toUpper());
    auto closes = std::make_shared<QHash<QString, double>>();
    QStringList symbolsNeeded;
    for (const OJson& n : to::settlementsNeeded(butterflies, now)) {
        const QString sym = js::str(js::prop(&n, u"symbol"_s));
        if (!want.isEmpty() && !want.contains(sym)) continue;
        if (!symbolsNeeded.contains(sym)) symbolsNeeded.append(sym);
    }
    for (const QString& symbol : symbolsNeeded) {
        try {
            for (const OJson& bar : co_await market_.dailyHistory(symbol)) {
                const double close = js::num(js::prop(&bar, u"close"_s));
                if (std::isfinite(close)) {
                    const OJson* d = js::prop(&bar, u"date"_s);
                    closes->insert(symbol + u'|' + (js::nullish(d) ? QString() : js::str(d)), close);
                }
            }
        } catch (...) {
            // 没连券商 / 取不到日线:这些到期的蝴蝶记成「结果不明」,原因写在每一笔的 note 里
        }
    }
    // 导入的期权(按结构整理的导出,没有行权价):同一账户同一天库里已有完整期权成交的,以完整的为准
    Gathered g;
    g.butterflies = butterflies;
    g.trips = trips;
    g.positions = positions;
    g.now = now;
    g.options = imports.listOptionTrades();
    for (const QString& d : to::optionDaysCovered(fills)) g.covered.insert(d);
    for (const QString& d : byPositions) g.covered.insert(d);
    g.isPaper = [paper](const QString& id) { return paper.contains(id); };
    g.settleClose = [closes](const QString& s, const QString& d) -> std::optional<double> {
        const auto it = closes->constFind(s + u'|' + d);
        return it == closes->cend() ? std::nullopt : std::optional<double>(it.value());
    };
    co_return g;
}

}  // namespace ibkr::orchestrate
