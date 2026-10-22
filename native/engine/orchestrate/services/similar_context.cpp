#include "orchestrate/services/similar_context.h"

#include "analysis/trade_similar.h"
#include "analysis/tradereview.h"
#include "domain/config.h"
#include "execution/broker_pricing.h"
#include "orchestrate/services/svc_util.h"
#include "util/jsobj.h"

#include <QDateTime>
#include <QTimeZone>

#include <algorithm>
#include <cmath>

namespace ibkr::orchestrate {

using namespace Qt::StringLiterals;
using util::OJson;
using util::Task;
namespace js = util::js;
namespace tr = analysis::tradereview;
namespace sim = analysis::trade_similar;

Task<std::optional<double>> SimilarContextService::spot(QString symbol) { co_return co_await market_.spotOf(std::move(symbol)); }

Task<> SimilarContextService::idle() {
    while (backfilling_) {
        Task<> t = *backfilling_;  // 副本:等的时候 backfilling_ 会被清掉
        co_await t;
    }
}

Task<contract::OrderedMap<double>> SimilarContextService::flyEntryUnderlyings(QList<OJson> butterflies, QList<OJson> positions, QString symbol) {
    QList<EntryTarget> want;
    for (const OJson& record : butterflies) {
        const OJson profile = tr::butterflyProfile(&record);
        if (profile.type == OJson::Null || js::str(js::prop(&profile, u"symbol"_s)).toUpper() != symbol) continue;
        try {
            const double when = tr::entryOf(&record).time;
            const OJson* idv = js::prop(&record, u"id"_s);  // String(record["id"] ?? "")
            want.append({js::nullish(idv) ? QString() : js::str(idv), when, tr::etKey(when, true)});
        } catch (const tr::ReviewError&) {
        }
    }
    for (const OJson& p : positions) {
        const OJson* center = js::prop(&p, u"center"_s);
        if (js::str(js::prop(&p, u"symbol"_s)) != symbol || (center && center->type == OJson::Null)) continue;  // 只有带中心的(蝴蝶一类)才比中心离现价
        const std::optional<double> when = tr::parseWhen(js::prop(&p, u"open_et"_s));
        if (when) want.append({js::str(js::prop(&p, u"id"_s)), *when, js::str(js::prop(&p, u"open_et"_s)).left(10)});
    }
    QStringList ids;
    for (const auto& w : want) ids.append(w.id);
    contract::OrderedMap<double> known;
    for (const auto& [id, price] : store().imports().entryUnderlyings(ids)) known.insert(id, price);
    const auto router = routerPort();
    if (!router || !router->hasSessions()) co_return known;

    // 新的优先:最近的交易最有参考价值
    QStringList missingDays;
    for (const auto& w : want)
        if (!known.contains(w.id) && !missingDays.contains(w.day)) missingDays.append(w.day);
    std::sort(missingDays.begin(), missingDays.end());
    std::reverse(missingDays.begin(), missingDays.end());
    for (int i = 0; i < qMin<qsizetype>(kMaxNewDays, missingDays.size()); ++i) co_await fillDay(router, symbol, missingDays[i], want, &known);
    const QStringList rest = missingDays.mid(kMaxNewDays);
    if (!rest.isEmpty() && !backfilling_) {
        Task<> t = runBackfill(symbol, rest, want);
        if (!t.done()) backfilling_ = t;
    }
    co_return known;
}

/// backfill(...).finally(() => backfilling = null)
Task<> SimilarContextService::runBackfill(QString symbol, QStringList days, QList<EntryTarget> want) {
    std::exception_ptr failure;
    try {
        co_await backfill(symbol, days, want);
    } catch (...) {
        failure = std::current_exception();
    }
    backfilling_.reset();
    if (failure) std::rethrow_exception(failure);
}

/// 后台一天一天补;券商换了或断了就停,下次打开卡片再接着补。错误一律吞掉(这是锦上添花)
Task<> SimilarContextService::backfill(QString symbol, QStringList days, QList<EntryTarget> want) {
    for (const QString& day : days) {
        co_await rt().sleep(backfillGapMs);
        const auto router = routerPort();
        if (!router || !router->hasSessions()) co_return;
        try {
            QStringList ids;
            for (const auto& w : want)
                if (w.day == day) ids.append(w.id);
            contract::OrderedMap<double> known;
            for (const auto& [id, price] : store().imports().entryUnderlyings(ids)) known.insert(id, price);
            co_await fillDay(router, symbol, day, want, &known);
        } catch (...) {
            co_return;
        }
    }
}

/// 取某一天的 1 分钟线,把那天开仓、还没存的几笔补上。取不到就算了,下次再试
Task<> SimilarContextService::fillDay(std::shared_ptr<RouterPort> router, QString symbol, QString day, QList<EntryTarget> want, contract::OrderedMap<double>* known) {
    QList<EntryTarget> todo;
    for (const auto& w : want)
        if (w.day == day && !known->contains(w.id)) todo.append(w);
    if (todo.isEmpty()) co_return;
    QList<OJson> bars;
    try {
        const execution::TaggedBars got = co_await router->intradayBars(symbol, u"1m"_s, true, day, false);
        for (const auto& b : got.bars) {
            if (!b.time.startsWith(day)) continue;
            bars.append(js::object({{u"time"_s, js::S(b.time)}, {u"open"_s, js::N(b.open)}, {u"high"_s, js::N(b.high)}, {u"low"_s, js::N(b.low)},
                                    {u"close"_s, js::N(b.close)}, {u"volume"_s, js::N(b.volume)}}));
        }
    } catch (...) {
        co_return;
    }
    for (const auto& w : todo) {
        const std::optional<double> price = sim::priceAt(bars, w.when);
        if (!price) continue;
        const QString at = isoMsZ(w.when);
        store().imports().rememberEntryUnderlying(w.id, symbol, at, *price, u"ibkr 1m RTH"_s);
        known->insert(w.id, *price);
    }
}

Task<SimilarContextService::StockRanges> SimilarContextService::stockRanges(QString symbol, QList<OJson> facts) {
    StockRanges out;
    QList<OJson> bars;
    try {
        bars = co_await market_.dailyHistory(symbol);
    } catch (...) {
        co_return out;
    }
    for (const OJson& f : facts) {
        const OJson* entry = js::prop(&f, u"entry_price"_s);
        if (js::str(js::prop(&f, u"kind"_s)) != u"stock" || js::str(js::prop(&f, u"symbol"_s)).toUpper() != symbol || (entry && entry->type == OJson::Null)) continue;
        const std::optional<double> when = tr::parseWhen(js::prop(&f, u"opened_at"_s));
        if (!when) continue;
        const std::optional<double> pos = sim::rangePosition(bars, tr::etKey(*when, true), js::num(entry));
        if (pos) out.byId.insert(js::str(js::prop(&f, u"id"_s)), *pos);
    }
    const std::optional<double> spot = co_await market_.spotOf(symbol);
    if (spot) out.query = sim::rangePosition(bars, domain::nowEt().date, *spot);
    co_return out;
}

}  // namespace ibkr::orchestrate
