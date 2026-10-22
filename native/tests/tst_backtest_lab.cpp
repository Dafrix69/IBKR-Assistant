// engine/analysis/backtest_lab(backtestLab.ts)对着原模块现跑的答案(tests/fixtures/gen_backtest_lab.mjs):参数扫描的完整回执
// (一到几只标的、股票与期权、两种挑法、滚动前推、坏的网格与比例),组合、对齐、Spearman 与置换 p 值、网格校验,逐字符比 JSON。
#include "analysis/backtest_lab.h"
#include "js_fixture.h"

#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using jsfix::enc;
using util::OJson;
namespace js = util::js;
namespace bt = analysis::backtest;
namespace lab = analysis::backtest_lab;

namespace {
bt::Bars barsOf(const OJson& raw) {
    bt::Bars out;
    for (const OJson& b : raw.items) {
        const OJson d = dec(b);
        out.push_back({d.get(u"date"_s)->s, d.get(u"open"_s)->n, d.get(u"high"_s)->n, d.get(u"low"_s)->n, d.get(u"close"_s)->n});
    }
    return out;
}
std::vector<double> numbers(const OJson& raw) {
    std::vector<double> out;
    for (const OJson& x : raw.items) out.push_back(jsfix::num(&x));
    return out;
}
OJson optN(const std::optional<double>& v) { return v ? js::N(*v) : OJson::null(); }
}  // namespace

class TestBacktestLab : public QObject {
    Q_OBJECT
    OJson fx_;
    std::vector<bt::Bars> sets_;

private slots:
    void initTestCase() {
        fx_ = jsfix::load(u"backtest_lab.json"_s);
        for (const OJson& s : fx_.get(u"barSets"_s)->items) sets_.push_back(barsOf(s));
    }

    void sweeps() {
        int ok = 0;
        for (const OJson& c : fx_.get(u"sweeps"_s)->items) {
            lab::SweepInput in;
            const OJson& syms = *c.get(u"symbols"_s);
            const OJson& sets = *c.get(u"sets"_s);
            for (qsizetype k = 0; k < sets.items.size(); ++k) in.series.push_back({syms.items[k].s, sets_[size_t(sets.items[k].n)]});
            in.strategy = c.get(u"strategy"_s)->s;
            in.grid = dec(*c.get(u"grid"_s));
            in.instrument = *c.get(u"instrument"_s);
            in.costPct = c.get(u"costPct"_s)->n;
            in.splitPct = jsfix::num(c.get(u"splitPct"_s));
            in.folds = c.get(u"folds"_s)->n;
            in.objective = c.get(u"objective"_s)->s;
            JSFIX_EXPECT(c, [&] { return lab::runSweep(in); }, u"sweep "_s + in.strategy + u' ' + js::stringify(*c.get(u"grid"_s)));
            if (c.get(u"out"_s)) ++ok;
        }
        QVERIFY(ok > 80);
    }

    void combosAndAlign() {
        for (const OJson& c : fx_.get(u"combos"_s)->items) QCOMPARE(js::stringify(js::array(lab::gridCombos(*c.get(u"grid"_s)))), js::stringify(*c.get(u"out"_s)));
        for (const OJson& c : fx_.get(u"align"_s)->items) {
            std::vector<lab::SymbolBars> in;
            const OJson& sets = *c.get(u"sets"_s);
            for (qsizetype k = 0; k < sets.items.size(); ++k) in.push_back({u"A"_s + QString::number(k), sets_[size_t(sets.items[k].n)]});
            OJson got = js::array();
            for (const lab::SymbolBars& s : lab::alignSeries(in)) {
                OJson dates = js::array();
                for (const bt::Bar& b : s.bars) dates.items.append(js::S(b.date));
                got.items.append(js::object({{u"symbol"_s, js::S(s.symbol)}, {u"dates"_s, dates}}));
            }
            QCOMPARE(js::stringify(got), js::stringify(*c.get(u"out"_s)));
        }
    }

    void spearman() {
        for (const OJson& c : fx_.get(u"spearman"_s)->items) {
            const std::vector<double> a = numbers(*c.get(u"a"_s)), b = numbers(*c.get(u"b"_s));
            QCOMPARE(js::stringify(enc(optN(lab::spearman(a, b)))), js::stringify(*c.get(u"r"_s)));
            QCOMPARE(js::stringify(enc(optN(lab::spearmanP(a, b, int(c.get(u"draws"_s)->n))))), js::stringify(*c.get(u"p"_s)));
            if (!jsfix::isUndefined(c.get(u"pDefault"_s))) QCOMPARE(js::stringify(enc(optN(lab::spearmanP(a, b)))), js::stringify(*c.get(u"pDefault"_s)));
        }
    }

    void checks() {
        for (const OJson& c : fx_.get(u"checks"_s)->items) {
            JSFIX_EXPECT(c, [&] { lab::checkGrid(c.get(u"strategy"_s)->s, *c.get(u"grid"_s), c.get(u"symbols"_s)->n); return OJson::null(); },
                         u"checkGrid "_s + c.get(u"strategy"_s)->s);
        }
    }
};

QTEST_GUILESS_MAIN(TestBacktestLab)
#include "tst_backtest_lab.moc"
