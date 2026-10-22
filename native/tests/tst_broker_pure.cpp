// broker.ts 的纯函数对着原模块现跑的答案(fixtures/broker_pure.json,gen_broker_pure.mjs):种子固定的大表,逐字符比 JSON。
#include "broker_world.h"
#include "execution/broker.h"
#include "js_fixture.h"
#include "util/jsformat.h"

#include <QTest>

using namespace Qt::StringLiterals;
using jsfix::dec;
using jsfix::enc;
using ibkr::util::OJson;
namespace ex = ibkr::execution;
namespace js = ibkr::util::js;

namespace {
/// '__undefined__' → 空指针(JS 的 undefined)
const OJson* undefOr(const OJson& v) { return v.type == OJson::String && v.s == u"__undefined__" ? nullptr : &v; }
OJson nOrNull(const std::optional<double>& v) { return js::NOrNull(v); }
std::optional<double> optN(const OJson& v) { return v.type == OJson::Null ? std::nullopt : std::optional<double>(v.n); }
}  // namespace

class TstBrokerPure : public QObject {
    Q_OBJECT
    OJson fx = jsfix::load(u"broker_pure.json"_s);

private slots:
    void constants() {
        // TS 里的静态常量(别处读它们决定要不要走这条路):钉住
        QCOMPARE(ex::BrokerRouter::kBroker, u"ibkr"_s);
        QVERIFY(ex::BrokerRouter::kSupportsNativeConditions);
        QVERIFY(ex::BrokerRouter::kSupportsVolumeQuotes);
        QVERIFY(ex::BrokerRouter::kSupportsHostedClose);
        QCOMPARE(ex::BrokerRouter::kVolumeTicks, u"165,104,595"_s);
        QCOMPARE(ex::BrokerRouter::kQualifyTimeoutMs, 12000);
        QCOMPARE(ex::BrokerRouter::kQuoteWaitMs, 4000);
        QCOMPARE(ex::BrokerRouter::kChainMaxWidth, 15);
        QCOMPARE(ex::BrokerRouter::kChainWaitMs, 4000);
        QCOMPARE(ex::BrokerRouter::kVolumeRetryMs, 60000.0);
        for (const double v : {0.0}) QCOMPARE(ex::kDefaultComboTick, 0.05 + v);
    }
    void autoMid() {
        for (const OJson& c : fx.get(u"autoMidLimit"_s)->items) {
            const OJson in = dec(*c.get(u"in"_s));
            JSFIX_EXPECT(c, [&] { return js::N(ex::autoMidLimit(in.items[0].n, in.items[1].s, in.items[2].n, optN(in.items[3]), in.items[4].n)); }, u"autoMidLimit"_s);
        }
        for (const OJson& c : fx.get(u"bagSignedLimit"_s)->items) {
            const OJson in = dec(*c.get(u"in"_s));
            JSFIX_EXPECT(c, [&] { return nOrNull(ex::bagSignedLimit(in.items[0].s, optN(in.items[1]))); }, u"bagSignedLimit"_s);
        }
    }
    void clean() {
        for (const OJson& c : fx.get(u"cleanPrice"_s)->items) {
            const OJson in = dec(*c.get(u"in"_s));
            JSFIX_EXPECT(c, [&] { return nOrNull(ex::cleanPriceJs(undefOr(in))); }, u"cleanPrice"_s);
        }
        for (const OJson& c : fx.get(u"finiteQuote"_s)->items) {
            const OJson in = dec(*c.get(u"in"_s));
            JSFIX_EXPECT(c, [&] { return js::N(ex::finiteQuoteJs(undefOr(in))); }, u"finiteQuote"_s);
        }
        // typed 版与 Js 版在数上同一个答案
        for (const double v : {0.0, -0.0, 1.0, -1.0, 12.5, 1e-9, std::nan(""), HUGE_VAL, -HUGE_VAL}) {
            QCOMPARE(ex::finiteQuote(v), ex::finiteQuoteJs(&*std::make_unique<OJson>(OJson::number(v))));
            const auto a = ex::cleanPrice(v);
            const auto b = ex::cleanPriceJs(&*std::make_unique<OJson>(OJson::number(v)));
            QCOMPARE(a.has_value(), b.has_value());
        }
        QVERIFY(!ex::cleanPrice(std::nullopt).has_value());
        QCOMPARE(ex::finiteQuote(std::nullopt), 0.0);
    }
    void quoteError() {
        for (const OJson& c : fx.get(u"quoteErrorMessage"_s)->items) {
            const OJson in = dec(*c.get(u"in"_s));
            std::vector<std::pair<double, QString>> errors;
            for (const OJson& e : in.items[1].items) errors.emplace_back(e.items[0].n, e.items[1].s);
            JSFIX_EXPECT(c, [&] { return js::S(ex::quoteErrorMessage(in.items[0].s, errors)); }, u"quoteErrorMessage"_s);
        }
    }
    void widthAndCondition() {
        for (const OJson& c : fx.get(u"strikeWidth"_s)->items) {
            const OJson in = dec(*c.get(u"in"_s));
            JSFIX_EXPECT(c, [&] { return nOrNull(ex::strikeWidth(in)); }, u"strikeWidth"_s);
        }
        for (const OJson& c : fx.get(u"priceConditionSpec"_s)->items) {
            const OJson in = dec(*c.get(u"in"_s));
            JSFIX_EXPECT(c, [&] { return ex::priceConditionSpec(undefOr(in)); }, u"priceConditionSpec"_s);
        }
        for (const OJson& c : fx.get(u"shouldFire"_s)->items) {
            const OJson in = dec(*c.get(u"in"_s));
            ex::PendingTrigger p;
            p.trigger = in.items[0];
            JSFIX_EXPECT(c, [&] { return js::B(ex::shouldFire(p, in.items[1].n)); }, u"shouldFire"_s);
        }
    }
    void liquidity() {
        for (const OJson& c : fx.get(u"bookLiquidity"_s)->items) {
            const OJson in = dec(*c.get(u"in"_s));
            JSFIX_EXPECT(c, [&] { return ex::bookLiquidity(in); }, u"bookLiquidity"_s);
        }
    }
    void intent() {
        for (const OJson& c : fx.get(u"buildOrderIntent"_s)->items) {
            const OJson in = dec(*c.get(u"in"_s));
            JSFIX_EXPECT(c, [&] {
                const OJson& ov = in.items[2];
                const OJson& ao = in.items[3];
                return bw::canonOrder(ex::buildOrderIntent(in.items[0], in.items[1].s, optN(ov), ao.type == OJson::Null ? std::nullopt : std::optional<QString>(ao.s)));
            }, u"buildOrderIntent"_s);
        }
    }
    void rth() {
        QList<ibkr::domain::Settings> list;
        for (const OJson& v : fx.get(u"lastRthVariants"_s)->items) {
            OJson raw = *js::parse(QStringLiteral(R"({"prompt_version":"v1.8.0","llm":{"model":"claude-opus-5","effort":"high","temperature":null},"limits":{"max_order_notional":50000,"max_option_contracts":10,"max_mkt_shares":200,"min_confidence":0.9,"max_spread_slippage":0.1,"max_orders_per_input":5,"duplicate_window_minutes":10,"duplicate_qty_tolerance":0.2},"policies":{"auto_execute":false,"allow_live_trading":false,"require_trigger_price_verification":true,"trigger_min_gap_bps":5,"closed_market_policy":"reject_market_orders"},"connections":{"paper":{"host":"127.0.0.1","port":7497,"client_id":11}},"accounts":[{"alias":"a","account_id":"DU1","is_paper":true,"connection":"paper","default":true}],"market_holidays":["2026-09-07"],"early_close_days":["2026-11-27"],"storage":{"db_path":"/tmp/x/trades.db"}})"));
            for (const auto& [k, x] : v.fields) raw.set(k, x);
            list.append(ibkr::domain::fromDict(raw));
        }
        for (const OJson& c : fx.get(u"lastRthSession"_s)->items) {
            const OJson in = dec(*c.get(u"in"_s));
            JSFIX_EXPECT(c, [&] {
                const auto r = ex::lastRthSession(ibkr::domain::etNowFromEpoch(in.items[0].n), list[static_cast<qsizetype>(in.items[1].n)]);
                return js::array({js::S(r.first), js::N(r.second)});
            }, u"lastRthSession"_s);
        }
    }
    void basis() {
        const auto series = [](const OJson& a) {
            std::vector<ex::TimedClose> v;
            for (const OJson& x : a.items) v.push_back({x.get(u"time"_s)->s, x.get(u"close"_s)->n});
            return v;
        };
        for (const OJson& c : fx.get(u"contemporaneousBasis"_s)->items) {
            const OJson in = dec(*c.get(u"in"_s));
            JSFIX_EXPECT(c, [&] {
                const auto m = ex::contemporaneousBasis(series(in.items[0]), series(in.items[1]));
                if (!m) return js::Null();
                return js::object({{u"basis"_s, js::N(m->basis)}, {u"time"_s, js::S(m->time)}, {u"index_close"_s, js::N(m->index_close)}, {u"futures_close"_s, js::N(m->futures_close)}});
            }, u"contemporaneousBasis"_s);
        }
    }
    void fills() {
        for (const OJson& c : fx.get(u"parseIbTime"_s)->items) {
            const OJson in = dec(*c.get(u"in"_s));
            JSFIX_EXPECT(c, [&] { return nOrNull(ex::parseIbTime(undefOr(in))); }, u"parseIbTime"_s);
        }
        for (const OJson& c : fx.get(u"fillRow"_s)->items) {
            const OJson in = dec(*c.get(u"in"_s));
            const OJson empty = js::object();
            const OJson& contract = in.items[0].type == OJson::Null ? empty : in.items[0];
            const OJson& execution = in.items[1].type == OJson::Null ? empty : in.items[1];
            JSFIX_EXPECT(c, [&] {
                const auto row = ex::fillRow(contract, execution);
                return row ? *row : js::Null();
            }, u"fillRow"_s);
        }
    }
};

QTEST_GUILESS_MAIN(TstBrokerPure)
#include "tst_broker_pure.moc"
