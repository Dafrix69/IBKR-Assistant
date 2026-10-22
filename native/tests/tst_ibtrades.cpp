// engine/analysis/ibtrades(ibtrades.ts)对着原模块现跑的答案(tests/fixtures/gen_ibtrades.mjs):逐腿成交合成蝴蝶记录,逐字符比 JSON。
#include "analysis/ibtrades.h"
#include "js_fixture.h"

#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using util::OJson;
namespace js = util::js;
namespace ib = analysis::ibtrades;

class TestIbTrades : public QObject {
    Q_OBJECT
    OJson fx_;

private slots:
    void initTestCase() { fx_ = jsfix::load(u"ibtrades.json"_s); }

    void groupKey() {
        for (const OJson& c : fx_.get(u"groupKey"_s)->items) {
            const OJson fill = dec(*c.get(u"fill"_s));
            JSFIX_EXPECT(c, [&] { return js::S(ib::groupKey(fill)); }, u"groupKey "_s + js::stringify(fill));
        }
    }

    void groups() {
        int n = 0;
        for (const OJson& c : fx_.get(u"groups"_s)->items) {
            const OJson fills = dec(*c.get(u"fills"_s)), accounts = dec(*c.get(u"accounts"_s));
            JSFIX_EXPECT(c, [&] { return js::array(ib::groupButterflies(fills.items, accounts.items)); }, u"groupButterflies #"_s + QString::number(n));
            ++n;
        }
        QVERIFY(n > 150);
    }
};

QTEST_GUILESS_MAIN(TestIbTrades)
#include "tst_ibtrades.moc"
