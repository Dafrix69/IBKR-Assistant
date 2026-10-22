// engine/analysis/open_risk(openRisk.ts)对着原模块现跑的答案(tests/fixtures/gen_open_risk.mjs):手搭的结构与随机持仓的最坏亏损、
// 张数与说明,worstCaseAtExpiry 的随机腿,逐字符比 JSON。
#include "analysis/open_risk.h"
#include "js_fixture.h"

#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using util::OJson;
namespace js = util::js;
namespace orisk = analysis::open_risk;

class TestOpenRisk : public QObject {
    Q_OBJECT
    OJson fx_;

private slots:
    void initTestCase() { fx_ = jsfix::load(u"open-risk.json"_s); }

    void risk() {
        for (const OJson& c : fx_.get(u"cases"_s)->items) {
            const QList<OJson> rows = dec(jsfix::stripUndefined(*c.get(u"rows"_s))).items;
            JSFIX_EXPECT(c, [&] { return orisk::openRisk(rows); }, js::stringify(*c.get(u"rows"_s)).left(400));
        }
    }

    void worst() {
        for (const OJson& c : fx_.get(u"worst"_s)->items) {
            std::vector<orisk::Leg> legs;
            for (const OJson& l : c.get(u"legs"_s)->items)
                legs.push_back({l.get(u"qty"_s)->n, l.get(u"mult"_s)->n, l.get(u"strike"_s)->n, l.get(u"call"_s)->b, l.get(u"cost"_s)->n});
            const auto w = orisk::worstCaseAtExpiry(legs);
            JSFIX_SAME(*c.get(u"out"_s), js::object({{u"usd"_s, js::N(w.usd)}, {u"unbounded"_s, js::N(w.unbounded)}}), js::stringify(*c.get(u"legs"_s)));
        }
        for (const OJson& c : fx_.get(u"keys"_s)->items)
            QCOMPARE(orisk::contractsKey(c.get(u"a"_s)->s, c.get(u"s"_s)->s, c.get(u"e"_s)->s), c.get(u"out"_s)->s);
    }
};

QTEST_GUILESS_MAIN(TestOpenRisk)
#include "tst_open_risk.moc"
