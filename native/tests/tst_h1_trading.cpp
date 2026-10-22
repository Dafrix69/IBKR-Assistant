// handlers1 簇·下单线:rpc/handlers/trading.ts 的 C++ 版对拍(钱路径)。期望值由原 handler 现跑(fixtures/gen_handlers1_trading.mjs),脚本与世界见 handlers1_world.h。
#include "handlers1_world.h"

#include <QTest>

using namespace Qt::StringLiterals;

class TestH1Trading : public QObject {
    Q_OBJECT

private slots:
    void initTestCase() { qputenv("DAFRI_PROMPT_DIR", QByteArray(IBKR_PROMPTS_DIR)); }

    H1_SCENARIOS(trading, u"handlers1_trading.json"_s)
};

QTEST_GUILESS_MAIN(TestH1Trading)
#include "tst_h1_trading.moc"
