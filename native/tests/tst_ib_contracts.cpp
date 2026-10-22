// engine/execution/ib_contracts(ibContracts.ts)对着原模块现跑的答案(tests/fixtures/gen_ib_contracts.mjs):
// 合约构造、第三个星期五与季月、流式记号、交易类的挑法、行权价的"整"与期权链订哪几档、合约描述,逐字符比 JSON。
#include "execution/ib_contracts.h"
#include "js_fixture.h"
#include "util/jsformat.h"

#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using util::OJson;
namespace js = util::js;
namespace ex = execution;

namespace {
/// IbContract → TS 对象字面量的样子(各构造函数的键序都是这一个次序的子序列)
OJson contractJson(const ex::IbContract& c) {
    OJson o = js::object();
    o.set(u"secType"_s, js::S(c.secType));
    o.set(u"symbol"_s, js::S(c.symbol));
    o.set(u"exchange"_s, js::S(c.exchange));
    o.set(u"currency"_s, js::S(c.currency));
    if (c.lastTradeDateOrContractMonth) o.set(u"lastTradeDateOrContractMonth"_s, js::S(*c.lastTradeDateOrContractMonth));
    if (c.strike) o.set(u"strike"_s, js::N(*c.strike));
    if (c.right) o.set(u"right"_s, js::S(*c.right));
    if (c.multiplier) o.set(u"multiplier"_s, js::S(*c.multiplier));
    if (c.tradingClass) o.set(u"tradingClass"_s, js::S(*c.tradingClass));
    if (c.conId) o.set(u"conId"_s, js::N(*c.conId));
    if (c.hasComboLegs) o.set(u"comboLegs"_s, js::array());
    return o;
}
ex::IbContract contractFrom(const OJson& j) {
    ex::IbContract c;
    c.secType = j.get(u"secType"_s)->s;
    c.symbol = j.get(u"symbol"_s)->s;
    c.exchange = j.get(u"exchange"_s)->s;
    c.currency = j.get(u"currency"_s)->s;
    if (const OJson* v = j.get(u"lastTradeDateOrContractMonth"_s)) c.lastTradeDateOrContractMonth = v->s;
    if (const OJson* v = j.get(u"strike"_s)) c.strike = v->n;
    if (const OJson* v = j.get(u"right"_s)) c.right = v->s;
    if (const OJson* v = j.get(u"multiplier"_s)) c.multiplier = v->s;
    if (const OJson* v = j.get(u"tradingClass"_s)) c.tradingClass = v->s;
    if (const OJson* v = j.get(u"conId"_s)) c.conId = static_cast<int>(v->n);
    if (j.get(u"comboLegs"_s)) c.hasComboLegs = true;
    return c;
}
contract::IndexConfig indexCfg(const OJson& j) {
    contract::IndexConfig c;
    if (const OJson* v = j.get(u"futures"_s)) c.futures = v->s;
    if (const OJson* v = j.get(u"futures_exchange"_s)) c.futures_exchange = v->s;
    if (const OJson* v = j.get(u"daily_trading_class"_s)) c.daily_trading_class = v->s;
    if (const OJson* v = j.get(u"monthly_trading_class"_s)) c.monthly_trading_class = v->s;
    return c;
}
std::vector<double> nums(const OJson& a) {
    std::vector<double> out;
    for (const OJson& x : a.items) out.push_back(x.n);
    return out;
}
OJson numsJson(const std::vector<double>& v) {
    OJson o = js::array();
    for (const double x : v) o.items.append(js::N(x));
    return o;
}
QString arg(const OJson& args, int i, const QString& fallback) { return i < args.items.size() ? args.items[i].s : fallback; }
}  // namespace

class TestIbContracts : public QObject {
    Q_OBJECT
    OJson fx_;

private slots:
    void initTestCase() { fx_ = jsfix::load(u"ib_contracts.json"_s); }

    void constructors() {
        for (const OJson& c : fx_.get(u"stock"_s)->items) {
            const OJson& a = *c.get(u"args"_s);
            JSFIX_EXPECT(c, [&] { return contractJson(ex::stockContract(arg(a, 0, {}), arg(a, 1, u"SMART"_s), arg(a, 2, u"USD"_s))); }, u"stock"_s);
        }
        for (const OJson& c : fx_.get(u"index"_s)->items) {
            const OJson& a = *c.get(u"args"_s);
            JSFIX_EXPECT(c, [&] { return contractJson(ex::indexContract(arg(a, 0, {}), arg(a, 1, {}))); }, u"index"_s);
        }
        for (const OJson& c : fx_.get(u"option"_s)->items) {
            const OJson a = dec(*c.get(u"args"_s));
            JSFIX_EXPECT(c, [&] {
                return contractJson(ex::optionContract(arg(a, 0, {}), arg(a, 1, {}), a.items[2].n, arg(a, 3, {}), arg(a, 4, {}), arg(a, 5, u"USD"_s), arg(a, 6, u"100"_s), arg(a, 7, {})));
            }, u"option"_s);
        }
        for (const OJson& c : fx_.get(u"futures"_s)->items) {
            const auto cfg = indexCfg(*c.get(u"cfg"_s));
            JSFIX_EXPECT(c, [&] { return contractJson(ex::indexFuturesContract(cfg, c.get(u"d"_s)->s)); }, u"futures "_s + c.get(u"d"_s)->s);
        }
    }

    void dates() {
        for (const OJson& r : fx_.get(u"third"_s)->items)
            QCOMPARE(ex::thirdFriday(jsfix::num(&r.items[0]), jsfix::num(&r.items[1])), r.items[2].s);
        int n = 0;
        for (const OJson& c : fx_.get(u"front"_s)->items) {
            JSFIX_EXPECT(c, [&] { return js::S(ex::frontQuarterly(c.get(u"d"_s)->s)); }, u"frontQuarterly "_s + c.get(u"d"_s)->s);
            ++n;
        }
        QVERIFY(n > 4700);
    }

    void stream() {
        for (const OJson& c : fx_.get(u"crypto"_s)->items) {
            JSFIX_EXPECT(c, [&] {
                const auto s = ex::cryptoSymbol(c.get(u"s"_s)->s);
                return s ? js::S(*s) : js::Null();
            }, u"cryptoSymbol "_s + c.get(u"s"_s)->s);
        }
        for (const OJson& c : fx_.get(u"stream"_s)->items)
            JSFIX_EXPECT(c, [&] { return contractJson(ex::streamContract(c.get(u"s"_s)->s)); }, u"streamContract "_s + c.get(u"s"_s)->s);
    }

    void tradingClass() {
        std::vector<std::optional<contract::IndexConfig>> cfgs;
        for (const OJson& c : fx_.get(u"cfgs"_s)->items) cfgs.push_back(c.type == OJson::Null ? std::nullopt : std::optional(indexCfg(c)));
        int n = 0;
        for (const OJson& c : fx_.get(u"pick"_s)->items) {
            const auto& cfg = cfgs[static_cast<std::size_t>(c.get(u"cfg"_s)->n)];
            JSFIX_EXPECT(c, [&] {
                return js::S(ex::pickTradingClass(c.get(u"symbol"_s)->s, cfg ? &*cfg : nullptr, *c.get(u"byClass"_s), c.get(u"expiry"_s)->s, c.get(u"prefer"_s)->s));
            }, u"pickTradingClass "_s + js::stringify(c));
            ++n;
        }
        QVERIFY(n >= 1746);
    }

    void strikes() {
        for (const OJson& r : fx_.get(u"round"_s)->items) {
            const double k = jsfix::num(&r.items[0]);
            QCOMPARE(util::jsNumberToString(ex::strikeRoundness(k)), util::jsNumberToString(r.items[1].n));
        }
        int n = 0;
        for (const OJson& c : fx_.get(u"chain"_s)->items) {
            const std::vector<double> grid = nums(dec(*c.get(u"grid"_s)));
            const double spot = jsfix::num(c.get(u"spot"_s)), width = jsfix::num(c.get(u"width"_s));
            const OJson* spanJ = c.get(u"span"_s);
            const bool undef = jsfix::isUndefined(spanJ);
            const std::optional<double> span = undef || spanJ->type == OJson::Null ? std::nullopt : std::optional(jsfix::num(spanJ));
            JSFIX_EXPECT(c, [&] { return numsJson(undef ? ex::chainStrikes(grid, spot, width) : ex::chainStrikes(grid, spot, width, span)); },
                         u"chainStrikes "_s + js::stringify(c).left(300));
            ++n;
        }
        QVERIFY(n >= 2630);
    }

    void describe() {
        for (const OJson& c : fx_.get(u"describe"_s)->items)
            QCOMPARE(ex::describeContract(contractFrom(dec(*c.get(u"c"_s)))), c.get(u"out"_s)->s);
    }
};

QTEST_GUILESS_MAIN(TestIbContracts)
#include "tst_ib_contracts.moc"
