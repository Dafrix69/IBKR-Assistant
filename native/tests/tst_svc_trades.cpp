// StockTripsService / TradeHistoryService / SimilarContextService(services/{stockTrips,tradeHistory,similarContext}.ts)对着原模块现跑的答案:
// 脚本驱动的假 router + 真的交易库(成交、导入的期权、入场标的价)+ 虚拟钟。夹具:fixtures/svc_trades.json(gen_svc_trades.mjs)。
#include "orchestrate/services/similar_context.h"
#include "orchestrate/services/stock_trips.h"
#include "orchestrate/services/trade_history.h"
#include "svc_world.h"

#include <QTest>

using namespace svcw;

namespace {

OJson pairsJson(const ibkr::contract::OrderedMap<double>& m) {
    OJson out = js::array();
    for (const QString& k : m.keys()) out.items.append(js::array({js::S(k), js::N(m.value(k))}));
    return out;
}

Svc buildTrades(World&, Host& host, const OJson& script, Runner&) {
    auto market = std::make_shared<MarketDataService>(host);
    auto stock = std::make_shared<StockTripsService>(host);
    auto hist = std::make_shared<TradeHistoryService>(host, *market, *stock);
    auto sim = std::make_shared<SimilarContextService>(host, *market);
    sim->backfillGapMs = int(num(script, u"backfillGapMs"_s, 8000));
    const OJson shared = script.get(u"shared"_s) ? *script.get(u"shared"_s) : js::object();
    const auto deref = [shared](const OJson* v) -> QList<OJson> {
        if (!v) return {};
        if (v->type == OJson::Object && v->get(u"$ref"_s)) return shared.get(v->get(u"$ref"_s)->s)->items;
        return v->items;
    };
    Svc s;
    s.methods[u"trips"_s] = [stock](const OJson&) -> Task<OJson> { co_return js::array(co_await stock->trips()); };
    s.methods[u"load"_s] = [hist](OJson a) -> Task<OJson> {
        QStringList symbols;
        if (const OJson* v = a.get(u"symbols"_s))
            for (const OJson& x : v->items) symbols.append(x.s);
        const TradeHistory r = co_await hist->load(symbols);
        if (flag(a, u"full"_s)) co_return js::object({{u"facts"_s, js::array(r.facts)}, {u"butterflies"_s, js::array(r.butterflies)}, {u"options"_s, js::array(r.options)}, {u"positions"_s, js::array(r.positions)}});
        OJson ids = js::array();
        for (const OJson& b : r.butterflies) ids.items.append(js::copyOrNull(js::prop(&b, u"id"_s)));
        co_return js::object({{u"facts"_s, js::array(r.facts)}, {u"butterflies"_s, ids}, {u"options"_s, js::N(r.options.size())}, {u"positions"_s, js::N(r.positions.size())}});
    };
    s.methods[u"ledger"_s] = [hist](const OJson&) -> Task<OJson> {
        const auto l = co_await hist->ledger();
        OJson trades = js::array();
        for (const auto& t : l.trades) trades.items.append(ibkr::analysis::performance::toJson(t));
        co_return js::object({{u"trades"_s, trades},
                              {u"excluded"_s, js::object({{u"open"_s, js::N(l.excluded.open)}, {u"unknown"_s, js::N(l.excluded.unknown)}, {u"no_cost"_s, js::N(l.excluded.no_cost)}})}});
    };
    s.methods[u"spot"_s] = [sim](OJson a) -> Task<OJson> { co_return js::NOrNull(co_await sim->spot(str(a, u"symbol"_s))); };
    s.methods[u"fly"_s] = [sim, deref](OJson a) -> Task<OJson> {
        co_return pairsJson(co_await sim->flyEntryUnderlyings(deref(a.get(u"butterflies"_s)), deref(a.get(u"positions"_s)), str(a, u"symbol"_s)));
    };
    s.methods[u"ranges"_s] = [sim, deref](OJson a) -> Task<OJson> {
        const auto r = co_await sim->stockRanges(str(a, u"symbol"_s), deref(a.get(u"facts"_s)));
        co_return js::object({{u"query"_s, js::NOrNull(r.query)}, {u"byId"_s, pairsJson(r.byId)}});
    };
    s.methods[u"idle"_s] = [sim](const OJson&) -> Task<OJson> {
        co_await sim->idle();
        co_return js::Null();
    };
    s.ops[u"gap"_s] = [sim](const OJson& step, OJson&) { sim->backfillGapMs = int(num(step, u"ms"_s)); };
    s.stop = [market, stock, hist, sim] {};  // 让四个 service 活到脚本跑完
    return s;
}

}  // namespace

class TstSvcTrades : public QObject {
    Q_OBJECT
private slots:
    void scenarios() {
        const OJson fx = jsfix::load(u"svc_trades.json"_s);
        const OJson& base = *fx.get(u"base"_s);
        const OJson shared = jsfix::dec(*fx.get(u"shared"_s));
        QStringList failures;
        int n = 0;
        for (const OJson& sc : fx.get(u"scenarios"_s)->items) {
            const QString what = sc.get(u"name"_s)->s;
            if (qEnvironmentVariableIsSet("SVC_TRACE")) fprintf(stderr, "scenario %s\n", qPrintable(what));
            OJson script = jsfix::dec(*sc.get(u"script"_s));
            script.set(u"shared"_s, shared);
            Runner runner(script, base, buildTrades);
            const OJson got = runner.run();
            if (qEnvironmentVariableIsSet("SVC_DUMP") && what == qEnvironmentVariable("SVC_DUMP")) {
                QFile f(QDir::tempPath() + u"/svc_got.json"_s);
                if (f.open(QIODevice::WriteOnly)) f.write(js::stringify(jsfix::enc(got)).toUtf8());
            }
            if (!jsfix::same(*sc.get(u"expected"_s), got, what)) failures.append(what);
            ++n;
        }
        QVERIFY2(failures.isEmpty(), qPrintable(failures.join(u"\n"_s)));
        QVERIFY(n > 0);
    }
};

QTEST_GUILESS_MAIN(TstSvcTrades)
#include "tst_svc_trades.moc"
