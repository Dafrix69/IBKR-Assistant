// engine/analysis/backtest(backtest.ts)对着原模块现跑的答案(tests/fixtures/gen_backtest_engine.mjs):黄金基线的 11 个场景、
// 合成日线上的整段回测(五个策略、自定义条件、股票与五种期权结构、每边成本、坏输入的话)、按 [lo, hi) 截一段结算、
// 各个指标、BS 定价与已实现波动率,逐字符比 JSON。
#include "analysis/backtest.h"
#include "js_fixture.h"

#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using jsfix::enc;
using util::OJson;
namespace js = util::js;
namespace bt = analysis::backtest;

namespace {
double num(const OJson* v) { return jsfix::num(v); }
const OJson* undefOr(const OJson* v, OJson& holder) {
    if (jsfix::isUndefined(v)) return nullptr;
    holder = dec(*v);
    return &holder;
}
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
    for (const OJson& x : raw.items) out.push_back(num(&x));
    return out;
}
OJson series(const bt::Series& s) {
    OJson o = js::array();
    for (const auto& v : s) o.items.append(v ? js::N(*v) : OJson::null());
    return o;
}
QString encS(const OJson& v) { return js::stringify(enc(v)); }
}  // namespace

class TestBacktest : public QObject {
    Q_OBJECT
    OJson fx_;
    std::vector<bt::Bars> sets_;

private slots:
    void initTestCase() {
        fx_ = jsfix::load(u"backtest_engine.json"_s);
        for (const OJson& s : fx_.get(u"barSets"_s)->items) sets_.push_back(barsOf(s));
    }

    void catalogs() {
        QCOMPARE(js::stringify(bt::strategies()), js::stringify(*fx_.get(u"strategies"_s)));
        QCOMPARE(js::stringify(bt::optionTypes()), js::stringify(*fx_.get(u"optionTypes"_s)));
    }

    void runs() {
        int n = 0, ok = 0;
        for (const OJson& c : fx_.get(u"runs"_s)->items) {
            OJson ph, rh, ih;
            const OJson* params = undefOr(c.get(u"params"_s), ph);
            const OJson* rules = undefOr(c.get(u"rules"_s), rh);
            const OJson* inst = undefOr(c.get(u"instrument"_s), ih);
            const bt::Bars& bars = sets_[size_t(c.get(u"set"_s)->n)];
            const double cost = num(c.get(u"cost"_s));
            JSFIX_EXPECT(c, [&] { return bt::runBacktest(bars, c.get(u"strategy"_s)->s, params, rules, inst, cost); }, u"run "_s + c.get(u"name"_s)->s);
            ++n;
            if (c.get(u"out"_s)) ++ok;
        }
        QVERIFY(n > 400);
        QVERIFY(ok > 200);
    }

    void segments() {
        int ok = 0;
        for (const OJson& c : fx_.get(u"segments"_s)->items) {
            const bt::Bars& bars = sets_[size_t(c.get(u"set"_s)->n)];
            const std::vector<double> held = numbers(*c.get(u"held"_s));
            bt::SegmentInput seg;
            seg.bars = &bars;
            seg.held = &held;
            seg.strategy = c.get(u"strategy"_s)->s;
            seg.params = dec(*c.get(u"params"_s));
            seg.inst = dec(*c.get(u"inst"_s));
            const auto opt = [&](const QString& k) { return jsfix::isUndefined(c.get(k)) ? std::nullopt : std::optional(num(c.get(k))); };
            seg.costPct = opt(u"cost"_s);
            seg.lo = opt(u"lo"_s);
            seg.hi = opt(u"hi"_s);
            std::vector<double> closes;
            for (const bt::Bar& b : bars) closes.push_back(b.close);
            const bt::Series vol = bt::trailingVol(closes), share = bt::trailingSessionShare(bars);
            if (c.get(u"withVol"_s)->b) {
                seg.vol = &vol;
                seg.sessionShare = &share;
            }
            JSFIX_EXPECT(c, [&] { return bt::evaluateSegment(seg); }, u"segment "_s + js::stringify(*c.get(u"inst"_s)));
            if (c.get(u"out"_s)) ++ok;
        }
        QVERIFY(ok > 50);
    }

    void indicators() {
        for (const OJson& c : fx_.get(u"indicators"_s)->items) {
            const std::vector<double> v = numbers(*c.get(u"values"_s));
            const double w = c.get(u"w"_s)->n;
            QCOMPARE(encS(series(bt::ema(v, w))), js::stringify(*c.get(u"ema"_s)));
            QCOMPARE(encS(series(bt::sma(v, w))), js::stringify(*c.get(u"sma"_s)));
            QCOMPARE(encS(series(bt::rsi(v, w))), js::stringify(*c.get(u"rsi"_s)));
            QCOMPARE(encS(series(bt::macdHist(v))), js::stringify(*c.get(u"macd"_s)));
        }
    }

    void oddSmaWindows() {
        // 窗口 0 / 负数 / 小数:越界读成 undefined → NaN,同 JS
        for (const OJson& c : fx_.get(u"indicators"_s)->items)
            QCOMPARE(encS(series(bt::sma(numbers(*c.get(u"values"_s)), c.get(u"wOdd"_s)->n))), js::stringify(*c.get(u"smaOdd"_s)));
    }

    void pricing() {
        int n = 0;
        for (const OJson& r : fx_.get(u"bs"_s)->items) {
            const double s = r.items[0].n, k = r.items[1].n, t = num(&r.items[2]), sigma = num(&r.items[3]);
            QCOMPARE(encS(js::N(bt::bsPrice(s, k, t, sigma, r.items[4].s))), js::stringify(r.items[5]));
            ++n;
        }
        QVERIFY(n == 3000);
        for (const OJson& c : fx_.get(u"misc"_s)->items) QCOMPARE(bt::strikeStep(num(c.get(u"p"_s))), c.get(u"step"_s)->n);
    }

    void vols() {
        for (const OJson& c : fx_.get(u"extraVol"_s)->items) {
            const std::vector<double> closes = numbers(*c.get(u"closes"_s));
            QCOMPARE(encS(series(bt::trailingVol(closes))), js::stringify(*c.get(u"tv"_s)));
            QCOMPARE(encS(series(bt::trailingVol(closes, 5))), js::stringify(*c.get(u"tv5"_s)));
            QCOMPARE(encS(js::N(bt::realizedVol(closes))), js::stringify(*c.get(u"rv"_s)));
        }
        for (const OJson& c : fx_.get(u"vols"_s)->items) {
            const int set = int(c.get(u"set"_s)->n);
            if (set < 0) {
                QCOMPARE(encS(js::N(bt::realizedVol({-1, -2, -3, 0, 5, 6, 7}))), js::stringify(enc(*c.get(u"rvNeg"_s))));
                QCOMPARE(encS(js::N(bt::realizedVol({0, 0, 0, 0, 0, 0, 0, 1}))), js::stringify(*c.get(u"rvZeros"_s)));
                continue;
            }
            const bt::Bars& bars = sets_[size_t(set)];
            std::vector<double> closes;
            for (const bt::Bar& b : bars) closes.push_back(b.close);
            QCOMPARE(encS(series(bt::trailingVol(closes))), js::stringify(*c.get(u"tv"_s)));
            QCOMPARE(encS(series(bt::trailingVol(closes, 5))), js::stringify(*c.get(u"tv5"_s)));
            QCOMPARE(encS(series(bt::trailingSessionShare(bars))), js::stringify(*c.get(u"ss"_s)));
            QCOMPARE(encS(series(bt::trailingSessionShare(bars, 3))), js::stringify(*c.get(u"ss3"_s)));
            QCOMPARE(encS(js::N(bt::realizedVol(closes))), js::stringify(*c.get(u"rv"_s)));
            const auto head = [&](size_t k) { return std::vector<double>(closes.begin(), closes.begin() + std::min(k, closes.size())); };
            QCOMPARE(encS(js::N(bt::realizedVol(head(7)))), js::stringify(*c.get(u"rvShort"_s)));
            QCOMPARE(encS(js::N(bt::realizedVol(head(6)))), js::stringify(*c.get(u"rv6"_s)));
            QCOMPARE(encS(js::N(bt::realizedVol(head(5)))), js::stringify(*c.get(u"rv5"_s)));
            std::vector<double> sig;
            for (size_t j = 0; j < bars.size(); ++j) sig.push_back(j % 3 ? 1 : 0);
            OJson held = js::array();
            for (double h : bt::heldAfterOpen(sig)) held.items.append(js::N(h));
            QCOMPARE(js::stringify(held), js::stringify(*c.get(u"held"_s)));
        }
    }
};

QTEST_GUILESS_MAIN(TestBacktest)
#include "tst_backtest.moc"
