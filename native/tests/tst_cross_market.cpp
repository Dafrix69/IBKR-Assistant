// engine/analysis/cross_market(crossMarket.ts)对着原模块现跑的答案(tests/fixtures/gen_cross_market.mjs):下一次开盘、美股交易日的开盘、
// 三周里每 20 分钟与两次夏令时切换附近的时间窗、一千五百次随机报价下的判定(事件的每个字),逐字符比 JSON。
#include "analysis/cross_market.h"
#include "js_fixture.h"

#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using util::OJson;
namespace js = util::js;
namespace cm = analysis::cross_market;

class TestCrossMarket : public QObject {
    Q_OBJECT
    OJson fx_;

private slots:
    void initTestCase() { fx_ = jsfix::load(u"cross-market.json"_s); }

    void tables() {
        QCOMPARE(js::stringify(cm::crossMarketsJson()), js::stringify(*fx_.get(u"markets"_s)));
        QCOMPARE(js::stringify(js::strings(cm::crossSymbols())), js::stringify(*fx_.get(u"symbols"_s)));
        QCOMPARE(cm::kCrossLingerMin, fx_.get(u"linger"_s)->n);
    }

    void opens() {
        for (const OJson& c : fx_.get(u"next"_s)->items) {
            const double now = dec(*c.get(u"now"_s)).n;
            JSFIX_EXPECT(c, [&] { return js::N(cm::nextOpen(now, c.get(u"offset"_s)->s, c.get(u"open"_s)->s, c.get(u"grace"_s)->n)); },
                         u"nextOpen %1 %2 %3"_s.arg(now, 0, 'f', 0).arg(c.get(u"offset"_s)->s, c.get(u"open"_s)->s));
        }
        for (const OJson& c : fx_.get(u"session"_s)->items) QCOMPARE(cm::usSessionStart(c.get(u"t"_s)->n), c.get(u"out"_s)->n);
    }

    void windows() {
        for (const OJson& c : fx_.get(u"windows"_s)->items) {
            const auto w = cm::crossWindow(c.get(u"now"_s)->n);
            JSFIX_SAME(*c.get(u"out"_s), w ? w->toJson() : OJson::null(), u"crossWindow %1"_s.arg(c.get(u"now"_s)->n, 0, 'f', 0));
        }
    }

    void evaluate() {
        for (const OJson& c : fx_.get(u"evals"_s)->items) {
            const OJson* raw = c.get(u"usPct"_s);
            const OJson us = dec(*raw);
            const std::optional<double> usPct = jsfix::isUndefined(raw) || us.type == OJson::Null ? std::nullopt : std::optional(us.n);
            const OJson quotes = dec(*c.get(u"quotes"_s));
            const cm::Cfg cfg{c.get(u"cfg"_s)->get(u"pct"_s)->n, c.get(u"cfg"_s)->get(u"lag_pct"_s)->n};
            JSFIX_EXPECT(c, [&] { return cm::evaluateCrossMarket(usPct, quotes, c.get(u"now"_s)->n, cfg); }, js::stringify(*c.get(u"quotes"_s)));
        }
    }
};

QTEST_GUILESS_MAIN(TestCrossMarket)
#include "tst_cross_market.moc"
