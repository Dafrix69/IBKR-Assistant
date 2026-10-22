// engine/analysis/stockreview(stockreview.ts)对着原模块现跑的答案(tests/fixtures/gen_stockreview.mjs):成交切成持仓段、
// 按交易日的图窗口、每一段的复盘与规则化结论,逐字符比 JSON。
#include "analysis/stockreview.h"
#include "js_fixture.h"

#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using util::OJson;
namespace js = util::js;
namespace sr = analysis::stockreview;

class TestStockReview : public QObject {
    Q_OBJECT
    OJson fx_;

private slots:
    void initTestCase() { fx_ = jsfix::load(u"stockreview.json"_s); }

    void windows() {
        for (const OJson& c : fx_.get(u"windows"_s)->items) {
            const OJson bars = dec(*c.get(u"bars"_s));
            for (const OJson& w : c.get(u"cases"_s)->items) {
                const auto [lo, hi] = sr::stockWindow(bars.items, qsizetype(w.get(u"a"_s)->n), qsizetype(w.get(u"b"_s)->n));
                QCOMPARE(double(lo), w.get(u"out"_s)->items[0].n);
                QCOMPARE(double(hi), w.get(u"out"_s)->items[1].n);
            }
        }
    }

    void groups() {
        int n = 0;
        for (const OJson& c : fx_.get(u"groups"_s)->items) {
            const OJson fills = dec(*c.get(u"fills"_s)), accounts = dec(*c.get(u"accounts"_s));
            const OJson* hRaw = c.get(u"holdings"_s);
            const OJson holdings = dec(*hRaw);
            const OJson* h = jsfix::isUndefined(hRaw) || holdings.type == OJson::Null ? nullptr : &holdings;
            JSFIX_EXPECT(c, [&] { return js::array(sr::groupStockTrips(fills.items, accounts.items, h)); }, u"groupStockTrips #"_s + QString::number(n));
            ++n;
        }
        QVERIFY(n > 140);
    }

    void reviews() {
        int n = 0;
        for (const OJson& c : fx_.get(u"reviews"_s)->items) {
            const OJson trip = dec(*c.get(u"trip"_s)), bars = dec(*c.get(u"bars"_s));
            JSFIX_EXPECT(c, [&] { return sr::reviewStock(trip, bars.items, c.get(u"tf"_s)->s, c.get(u"now"_s)->n); },
                         u"reviewStock #"_s + QString::number(n) + u' ' + js::str(c.get(u"name"_s)));
            ++n;
        }
        QVERIFY(n > 140);
    }
};

QTEST_GUILESS_MAIN(TestStockReview)
#include "tst_stockreview.moc"
