// engine/analysis/market(market.ts)对着原模块现跑的答案(tests/fixtures/gen_market_symbols.mjs):四份配置上 800 多句的标的抽取
// (带不带兜底的 SPX、extra),以及按标的拉现价的快照(缓存、抛错、0 / NaN、Object.prototype 上的名字、像下标的代码),逐字符比。
#include "analysis/market.h"
#include "js_fixture.h"

#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using jsfix::enc;
using util::OJson;
namespace js = util::js;
namespace mk = analysis::market;

class TestMarketSymbols : public QObject {
    Q_OBJECT
    OJson fx_;
    std::vector<domain::Settings> settings_;

private slots:
    void initTestCase() {
        fx_ = jsfix::load(u"market-symbols.json"_s);
        for (const OJson& c : fx_.get(u"configs"_s)->items) settings_.push_back(domain::fromDict(c));
    }

    void extract() {
        int n = 0;
        for (const OJson& c : fx_.get(u"cases"_s)->items) {
            const QString text = c.get(u"text"_s)->s;
            const domain::Settings& s = settings_[size_t(c.get(u"s"_s)->n)];
            std::optional<QStringList> extra;
            if (const OJson* e = c.get(u"extra"_s); e->type == OJson::Array) {
                QStringList l;
                for (const OJson& x : e->items) l << x.s;
                extra = l;
            }
            QCOMPARE(js::stringify(js::strings(mk::extractSymbols(text, s, extra))), js::stringify(*c.get(u"default"_s)));
            QCOMPARE(js::stringify(js::strings(mk::extractSymbols(text, s, extra, false))), js::stringify(*c.get(u"no_default"_s)));
            ++n;
        }
        QVERIFY(n > 800);
    }

    void snapshot() {
        const OJson& prices = *fx_.get(u"prices"_s);
        const auto lookup = [&](const QString& s) -> std::optional<double> {
            const OJson* v = prices.get(s);
            if (!v || v->type == OJson::Null) return std::nullopt;
            if (v->type == OJson::String && v->s == u"__throw__") throw util::JsError(u"boom"_s);
            return dec(*v).n;
        };
        for (const OJson& c : fx_.get(u"snapshots"_s)->items) {
            QStringList symbols;
            for (const OJson& x : c.get(u"symbols"_s)->items) symbols << x.s;
            OJson holder;
            const OJson* cached = jsfix::isUndefined(c.get(u"cached"_s)) ? nullptr : &(holder = dec(*c.get(u"cached"_s)));
            JSFIX_SAME(*c.get(u"out"_s), mk::buildSnapshot(symbols, lookup, cached), u"buildSnapshot "_s + js::stringify(*c.get(u"symbols"_s)));
        }
    }
};

QTEST_GUILESS_MAIN(TestMarketSymbols)
#include "tst_market_symbols.moc"
