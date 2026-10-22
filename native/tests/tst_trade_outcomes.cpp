// engine/analysis/trade_outcomes(tradeOutcomes.ts)对着原模块现跑的答案(tests/fixtures/gen_trade_outcomes.mjs):蝴蝶 / 股票 / 导入期权 / Flex 仓位
// 折成的事实、覆盖的日子、collectFacts 的筛选排序、settlementsNeeded、factLine / tallyLine,逐字符比 JSON。
#include "analysis/trade_outcomes.h"
#include "js_fixture.h"

#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using util::OJson;
namespace js = util::js;
namespace to = analysis::trade_outcomes;

namespace {
QStringList strs(const OJson& a) {
    QStringList out;
    for (const OJson& x : a.items) out << x.s;
    return out;
}
}  // namespace

class TestTradeOutcomes : public QObject {
    Q_OBJECT
    OJson fx_;
    to::SettleClose settle_;
    to::IsPaper isPaper_ = [](const QString& id) { return id.startsWith(u"DU"_s); };

private slots:
    void initTestCase() {
        fx_ = jsfix::load(u"trade_outcomes.json"_s);
        const OJson closes = *fx_.get(u"closes"_s);
        settle_ = [closes](const QString& symbol, const QString& date) -> std::optional<double> {
            const OJson* v = closes.get(symbol + u'|' + date);
            return v ? std::optional<double>(v->n) : std::nullopt;
        };
    }

    void butterflies() {
        int n = 0;
        for (const OJson& c : fx_.get(u"butterflies"_s)->items) {
            const OJson recs = dec(*c.get(u"records"_s));
            JSFIX_EXPECT(c, [&] { return js::array(to::butterflyFacts(recs.items, settle_, c.get(u"now"_s)->n)); }, u"butterflyFacts #"_s + QString::number(n++));
        }
        n = 0;
        for (const OJson& c : fx_.get(u"settlements"_s)->items) {
            const OJson recs = dec(*c.get(u"records"_s));
            JSFIX_EXPECT(c, [&] { return js::array(to::settlementsNeeded(recs.items, c.get(u"now"_s)->n)); }, u"settlementsNeeded #"_s + QString::number(n++));
        }
    }

    void stocks() {
        int n = 0;
        for (const OJson& c : fx_.get(u"stocks"_s)->items) {
            const OJson trips = dec(*c.get(u"trips"_s));
            JSFIX_EXPECT(c, [&] { return js::array(to::stockFacts(trips.items)); }, u"stockFacts #"_s + QString::number(n++));
        }
    }

    void days() {
        for (const OJson& c : fx_.get(u"days"_s)->items) {
            const OJson fills = dec(*c.get(u"fills"_s));
            JSFIX_EXPECT(c, [&] { return js::strings(to::optionDaysCovered(fills.items)); }, u"optionDaysCovered"_s);
        }
        for (const OJson& c : fx_.get(u"etIso"_s)->items) JSFIX_EXPECT(c, [&] { return js::S(to::etIso(c.get(u"s"_s)->s)); }, u"etIso "_s + c.get(u"s"_s)->s);
    }

    void options() {
        for (const OJson& c : fx_.get(u"options"_s)->items) {
            const OJson rows = dec(*c.get(u"rows"_s));
            const QStringList cov = strs(*c.get(u"covered"_s));
            const QSet<QString> covered(cov.begin(), cov.end());
            JSFIX_EXPECT(c, [&] { return js::array(to::optionFacts(rows.items, isPaper_, covered)); }, u"optionFacts"_s);
        }
        for (const OJson& c : fx_.get(u"positions"_s)->items) {
            const OJson rows = dec(*c.get(u"rows"_s));
            JSFIX_EXPECT(c, [&] { return js::array(to::positionFacts(rows.items, isPaper_)); }, u"positionFacts"_s);
            QCOMPARE(to::positionDays(rows.items), strs(*c.get(u"days"_s)));
        }
    }

    void collect() {
        int n = 0;
        for (const OJson& c : fx_.get(u"collect"_s)->items) {
            const OJson recs = dec(*c.get(u"records"_s)), trips = dec(*c.get(u"trips"_s)), extra = dec(*c.get(u"extra"_s));
            JSFIX_EXPECT(c, [&] { return js::array(to::collectFacts(recs.items, trips.items, settle_, c.get(u"now"_s)->n, strs(*c.get(u"symbols"_s)), extra.items)); },
                         u"collectFacts #"_s + QString::number(n++));
        }
        for (const OJson& c : fx_.get(u"lines"_s)->items) {
            const OJson facts = dec(*c.get(u"facts"_s));
            for (qsizetype i = 0; i < facts.items.size(); ++i) QCOMPARE(to::factLine(facts.items[i]), c.get(u"lines"_s)->items[i].s);
            QCOMPARE(to::tallyLine(facts.items), c.get(u"tally"_s)->s);
        }
    }
};

QTEST_GUILESS_MAIN(TestTradeOutcomes)
#include "tst_trade_outcomes.moc"
