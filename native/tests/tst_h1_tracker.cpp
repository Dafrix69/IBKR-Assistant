// handlers1 簇·追踪域:rpc/handlers/tracker.ts 的 C++ 版对拍(钱路径)。期望值由原 handler 现跑(fixtures/gen_handlers1_tracker*.mjs),脚本与世界见 handlers1_world.h。
#include "handlers1_world.h"

#include <QTest>

using namespace Qt::StringLiterals;

class TestH1Tracker : public QObject {
    Q_OBJECT

private slots:
    void initTestCase() { qputenv("DAFRI_PROMPT_DIR", QByteArray(IBKR_PROMPTS_DIR)); }

    H1_SCENARIOS(tracker, u"handlers1_tracker.json"_s)
    H1_SCENARIOS(trackerOpt, u"handlers1_tracker_opt.json"_s)
    H1_SCENARIOS(trackerOps, u"handlers1_tracker_ops.json"_s)
};

QTEST_GUILESS_MAIN(TestH1Tracker)
#include "tst_h1_tracker.moc"
