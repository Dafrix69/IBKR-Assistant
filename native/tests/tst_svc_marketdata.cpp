// MarketDataService(services/marketData.ts)对着原模块现跑的答案:脚本驱动的假 router + 虚拟钟,router 上每一次调用的日志与各步结果逐项精确比较。
// 夹具:fixtures/svc_marketdata.json(gen_svc_marketdata.mjs)。
#include "orchestrate/services/market_data.h"
#include "svc_world.h"

#include <QTest>

using namespace svcw;

namespace {

OJson quoteJson(const std::optional<SpotQuote>& q) {
    if (!q) return js::Null();
    return js::object({{u"price"_s, js::N(q->price)}, {u"tradedAt"_s, js::NOrNull(q->tradedAt)}, {u"source"_s, js::S(q->source)}});
}
OJson barsJson(const TaggedBars& t) {
    OJson bars = js::array();
    for (const SessionBar& b : t.bars)
        bars.items.append(js::object({{u"time"_s, js::S(b.time)}, {u"open"_s, js::N(b.open)}, {u"high"_s, js::N(b.high)}, {u"low"_s, js::N(b.low)},
                                      {u"close"_s, js::N(b.close)}, {u"volume"_s, js::N(b.volume)}}));
    return bars;
}
std::optional<QString> optStr(const OJson& a, const QString& k) {
    const OJson* v = a.get(k);
    return (v && v->type == OJson::String) ? std::optional<QString>(v->s) : std::nullopt;
}

Svc buildMarket(World&, Host& host, const OJson&, Runner&) {
    auto svc = std::make_shared<MarketDataService>(host);
    Svc s;
    s.methods[u"wallFor"_s] = [svc](OJson a) -> Task<OJson> {
        std::optional<double> span;
        if (const OJson* v = a.get(u"span"_s); v && v->type == OJson::Number) span = v->n;
        co_return co_await svc->wallFor(str(a, u"symbol"_s), optStr(a, u"expiry"_s), num(a, u"width"_s, 10), span, str(a, u"preferClass"_s));
    };
    s.methods[u"dailyHistory"_s] = [svc](OJson a) -> Task<OJson> {
        const OJson* v = a.get(u"spanDays"_s);
        const QList<OJson> bars = co_await (v ? svc->dailyHistory(str(a, u"symbol"_s), v->n) : svc->dailyHistory(str(a, u"symbol"_s), double(MarketDataService::kHistSpanDays)));
        co_return js::array(bars);
    };
    s.methods[u"spotOf"_s] = [svc](OJson a) -> Task<OJson> { co_return js::NOrNull(co_await svc->spotOf(str(a, u"symbol"_s))); };
    s.methods[u"quoteOf"_s] = [svc](OJson a) -> Task<OJson> { co_return quoteJson(co_await svc->quoteOf(str(a, u"symbol"_s))); };
    s.methods[u"quotesOf"_s] = [svc](OJson a) -> Task<OJson> {
        QStringList syms;
        for (const OJson& x : a.get(u"symbols"_s)->items) syms.append(x.s);
        const QuoteMap m = co_await svc->quotesOfOrdered(syms);
        OJson out = js::array();
        for (const QString& k : m.keys()) out.items.append(js::array({js::S(k), quoteJson(m.value(k))}));
        co_return out;
    };
    s.methods[u"paBars"_s] = [svc](OJson a) -> Task<OJson> {
        const PaBars r = co_await svc->paBars(str(a, u"symbol"_s), str(a, u"timeframe"_s), flag(a, u"rth"_s), flag(a, u"force"_s), flag(a, u"indexProxy"_s));
        const OJson feed = r.feed ? js::S(*r.feed == BarsFeed::Live ? u"live"_s : *r.feed == BarsFeed::Delayed ? u"delayed"_s : u"unknown"_s) : js::Null();
        co_return js::array({barsJson(r.bars), js::B(r.cached), js::N(r.askedAt), feed});
    };
    s.gets[u"askedAt"_s] = [svc](const OJson& a) { return js::NOrNull(svc->dailyHistoryAskedAt(str(a, u"symbol"_s))); };
    return s;
}

}  // namespace

class TstSvcMarketData : public QObject {
    Q_OBJECT
private slots:
    void scenarios() {
        const OJson fx = jsfix::load(u"svc_marketdata.json"_s);
        const OJson& base = *fx.get(u"base"_s);
        QStringList failures;
        int n = 0;
        for (const OJson& sc : fx.get(u"scenarios"_s)->items) {
            const QString what = sc.get(u"name"_s)->s;
            if (qEnvironmentVariableIsSet("SVC_TRACE")) fprintf(stderr, "scenario %s\n", qPrintable(what));
            const OJson script = jsfix::dec(*sc.get(u"script"_s));
            Runner runner(script, base, buildMarket);
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

QTEST_GUILESS_MAIN(TstSvcMarketData)
#include "tst_svc_marketdata.moc"
