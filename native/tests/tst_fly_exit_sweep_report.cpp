// engine/analysis/fly_exit_sweep_report(flyExitSweepReport.ts)对着原模块现跑的答案(fly-exit-sweep-report.json):
// formatReport 在各种结果与结论上写出的每一行(better / fragile / unproven / not_separated / nothing_to_compare,带回放与不带,按 R 与按美元,手改的各种边角)。
// 输入的结果与统计是夹具里的 JSON(TS 现算的),不经过 C++ 的 runSweep / summarise:报告只对着它自己。
#include "sweep_json.h"

#include <QTest>

using namespace sweepfix;

class TestFlyExitSweepReport : public QObject {
    Q_OBJECT
    OJson fx_;

private slots:
    void initTestCase() { fx_ = jsfix::load(u"fly-exit-sweep-report.json"_s); }

    void reportLines() {
        for (const OJson& c : fx_.get(u"cases"_s)->items) {
            const SweepResult r = resultFromJson(jsfix::dec(*c.get(u"result"_s)));
            const Summary s = summaryFromJson(jsfix::dec(*c.get(u"summary"_s)));
            JSFIX_EXPECT(c, [&] { return js::strings(formatReport(r, s)); }, u"formatReport "_s + c.get(u"name"_s)->s);
        }
    }
};

QTEST_GUILESS_MAIN(TestFlyExitSweepReport)
#include "tst_fly_exit_sweep_report.moc"
