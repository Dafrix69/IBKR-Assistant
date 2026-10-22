// engine/analysis/fills_csv、option_trades_csv、option_positions_csv(fillsCsv.ts / optionTradesCsv.ts / optionPositionsCsv.ts)
// 对着原模块现跑的答案(tests/fixtures/gen_csv_imports.mjs):导出文本 → 行、跳过的原因与条数,逐字符比 JSON。
#include "analysis/fills_csv.h"
#include "analysis/option_positions_csv.h"
#include "analysis/option_trades_csv.h"
#include "js_fixture.h"

#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using util::OJson;
namespace js = util::js;

class TestCsvImports : public QObject {
    Q_OBJECT
    OJson fx_;

private slots:
    void initTestCase() { fx_ = jsfix::load(u"csv_imports.json"_s); }

    void parseCsv() {
        for (const OJson& c : fx_.get(u"parseCsv"_s)->items) {
            OJson got = js::array();
            for (const QStringList& r : analysis::option_trades_csv::parseCsv(c.get(u"t"_s)->s)) got.items << js::strings(r);
            JSFIX_SAME(*c.get(u"out"_s), got, u"parseCsv "_s + js::stringify(*c.get(u"t"_s)));
        }
    }

    void fills() {
        int n = 0;
        for (const OJson& c : fx_.get(u"fills"_s)->items) {
            JSFIX_EXPECT(c, [&] { return analysis::fills_csv::parseFillsCsv(c.get(u"text"_s)->s, c.get(u"acct"_s)->s); }, u"fills #"_s + QString::number(n++));
        }
        QVERIFY(n > 60);
    }

    void trades() {
        int n = 0;
        for (const OJson& c : fx_.get(u"trades"_s)->items) {
            JSFIX_EXPECT(c, [&] { return analysis::option_trades_csv::parseOptionTradesCsv(c.get(u"text"_s)->s, c.get(u"acct"_s)->s, c.get(u"src"_s)->s); },
                         u"trades #"_s + QString::number(n++));
        }
        QVERIFY(n > 60);
    }

    void positions() {
        int n = 0;
        for (const OJson& c : fx_.get(u"positions"_s)->items) {
            JSFIX_EXPECT(c, [&] { return analysis::option_positions_csv::parseOptionPositionsCsv(c.get(u"text"_s)->s, c.get(u"acct"_s)->s, c.get(u"src"_s)->s); },
                         u"positions #"_s + QString::number(n++));
        }
        QVERIFY(n > 60);
    }
};

QTEST_GUILESS_MAIN(TestCsvImports)
#include "tst_csv_imports.moc"
