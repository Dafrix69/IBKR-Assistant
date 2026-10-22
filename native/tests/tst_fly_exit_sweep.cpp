// engine/analysis/fly_exit_sweep(flyExitSweep.ts)对着原模块现跑的答案(fly-exit-sweep-run.json):
// 一批现造的"记下来的天"上的整份 SweepResult(网格 / 真实入场 / 缺报价 / 成交口径 / 了结 / 到点与止损 / 回放 / 人群限定 / 配置报错)与 onDay 的进度回调,逐字比。
// 判定函数是 orchestrate::tracker 的那几个纯函数(TS 那边递的是 dist 里的 tracker.js)。
#include "sweep_json.h"

#include <QTest>

using namespace sweepfix;

class TestFlyExitSweep : public QObject {
    Q_OBJECT
    OJson fx_;

private slots:
    void initTestCase() { fx_ = jsfix::load(u"fly-exit-sweep-run.json"_s); }

    void runs() {
        const TrackerAdapter rules;
        int ok = 0, errors = 0;
        for (const OJson& c : fx_.get(u"runs"_s)->items) {
            const QString name = c.get(u"name"_s)->s;
            std::vector<QuoteSample> samples;
            for (const OJson& s : c.get(u"samples"_s)->items) samples.push_back(sampleFromJson(jsfix::dec(s)));
            const SweepConfig cfg = configFromJson(jsfix::dec(*c.get(u"cfg"_s)));
            OJson progress = js::array();
            const auto onDay = [&](const QString& date, double done, double total) { progress.items.append(js::array({js::S(date), js::N(done), js::N(total)})); };
            const bool expectError = c.get(u"error"_s) != nullptr;
            JSFIX_EXPECT(c, [&] { return resultJson(runSweep(samples, cfg, rules, onDay)); }, name);
            if (expectError) {
                ++errors;
                continue;
            }
            ++ok;
            JSFIX_SAME(*c.get(u"progress"_s), progress, name + u" 的进度回调"_s);
        }
        QVERIFY2(ok > 100 && errors > 10, "夹具里的正常情景与报错情景都要有");
    }
    /// 不给 onDay 也一样(默认的空回调)
    void noProgressCallback() {
        const TrackerAdapter rules;
        const OJson& c = fx_.get(u"runs"_s)->items[0];
        std::vector<QuoteSample> samples;
        for (const OJson& s : c.get(u"samples"_s)->items) samples.push_back(sampleFromJson(jsfix::dec(s)));
        const SweepConfig cfg = configFromJson(jsfix::dec(*c.get(u"cfg"_s)));
        JSFIX_EXPECT(c, [&] { return resultJson(runSweep(samples, cfg, rules)); }, u"无回调"_s);
    }
};

QTEST_GUILESS_MAIN(TestFlyExitSweep)
#include "tst_fly_exit_sweep.moc"
