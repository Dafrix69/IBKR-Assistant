// engine/analysis/fly_exit_sweep_stats(flyExitSweepStats.ts)对着原模块现跑的答案(fly-exit-sweep-stats.json):
// mulberry32 的前 N 个数、degenerateProb、exactLower、analyse(多种矩阵与选项,含每一句报错)、verdictOf、summarise。逐字比 JSON。
#include "analysis/fly_exit_sweep_stats.h"
#include "sweep_json.h"

#include <QTest>

using namespace sweepfix;

class TestFlyExitSweepStats : public QObject {
    Q_OBJECT
    OJson fx_;

private slots:
    void initTestCase() { fx_ = jsfix::load(u"fly-exit-sweep-stats.json"_s); }

    void seededRandomMatchesMulberry32() {
        for (const OJson& c : fx_.get(u"random"_s)->items) {
            const OJson seed = jsfix::dec(*c.get(u"seed"_s));
            const auto next = seededRandom(seed.type == OJson::Number ? seed.n : std::nan(""));
            OJson got = js::array();
            for (int i = 0; i < 24; ++i) got.items.append(js::N(next()));
            JSFIX_SAME(*c.get(u"out"_s), got, u"seededRandom "_s + js::stringify(*c.get(u"seed"_s)));
        }
        const auto next = seededRandom(7);
        OJson got = js::array();
        for (int i = 0; i < 3000; ++i) got.items.append(js::N(next()));
        JSFIX_SAME(*fx_.get(u"randomLong"_s), got, u"seededRandom(7) 3000 个"_s);
    }
    void degenerateProbabilities() {
        for (const OJson& c : fx_.get(u"degenerate"_s)->items) {
            const std::vector<double> xs = numsOf(&(const OJson&)jsfix::dec(*c.get(u"xs"_s)));
            JSFIX_EXPECT(c, [&] { return js::N(degenerateProb(xs)); }, u"degenerateProb "_s + js::stringify(*c.get(u"xs"_s)).left(80));
        }
    }
    void typedArraySortOrder() {
        for (const OJson& c : fx_.get(u"typedSort"_s)->items) {
            std::vector<double> xs = numsOf(&(const OJson&)jsfix::dec(*c.get(u"xs"_s)));
            sortLikeFloat64Array(xs);
            JSFIX_SAME(*c.get(u"out"_s), numArray(xs), u"Float64Array.sort "_s + js::stringify(*c.get(u"xs"_s)).left(80));
        }
    }
    void exactLowerBounds() {
        for (const OJson& c : fx_.get(u"exact"_s)->items) {
            const OJson args = jsfix::dec(*c.get(u"args"_s));
            const std::vector<double> d = numsOf(&args.items[0]);
            JSFIX_EXPECT(c, [&] {
                const auto r = exactLower(d, args.items[1].n, args.items[2].n, args.items[3].n);
                return r ? js::object({{u"lower"_s, js::N(r->lower)}, {u"unseen"_s, js::N(r->unseen)}, {u"seen"_s, js::N(r->seen)}}) : OJson::null();
            }, u"exactLower"_s);
        }
    }
    void analyses() {
        for (const OJson& c : fx_.get(u"analyse"_s)->items) {
            const OJson m = jsfix::dec(*c.get(u"matrix"_s)), opts = jsfix::dec(*c.get(u"opts"_s));
            const auto matrix = matrixOf(&m);
            const BootOptions boot = bootFromJson(opts);
            const size_t ref = size_t(c.get(u"ref"_s)->n);
            JSFIX_EXPECT(c, [&] { return analysisJson(analyse(matrix, ref, boot)); }, u"analyse "_s + js::stringify(*c.get(u"opts"_s)));
        }
    }
    void verdicts() {
        for (const OJson& c : fx_.get(u"verdict"_s)->items) {
            const Analysis a = analysisFromJson(jsfix::dec(*c.get(u"analysis"_s)));
            std::vector<VerdictCheck> checks;
            for (const OJson& k : jsfix::dec(*c.get(u"checks"_s)).items) checks.push_back({k.get(u"name"_s)->s, numsOf(k.get(u"diffs"_s))});
            JSFIX_EXPECT(c, [&] { return verdictJson(verdictOf(a, checks)); }, u"verdictOf "_s + c.get(u"name"_s)->s);
        }
    }
    void summaries() {
        for (const OJson& c : fx_.get(u"summarise"_s)->items) {
            const SweepResult r = resultFromJson(jsfix::dec(*c.get(u"result"_s)));
            const BootOptions boot = bootFromJson(jsfix::dec(*c.get(u"opts"_s)));
            const QString objective = c.get(u"objective"_s)->s;
            JSFIX_EXPECT(c, [&] { return summaryJson(summarise(r, objective, boot)); }, u"summarise "_s + c.get(u"name"_s)->s + u" "_s + objective);
        }
    }
};

QTEST_GUILESS_MAIN(TestFlyExitSweepStats)
#include "tst_fly_exit_sweep_stats.moc"
