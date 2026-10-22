// handlers1 簇·普通域:rpc/handlers/{connection,settings,system}.ts(轻量对拍) 的 C++ 版对拍(钱路径)。期望值由原 handler 现跑(fixtures/gen_handlers1_ordinary.mjs),脚本与世界见 handlers1_world.h。
#include "handlers1_world.h"

#include <QTest>

using namespace Qt::StringLiterals;

class TestH1Ordinary : public QObject {
    Q_OBJECT

private slots:
    void initTestCase() { qputenv("DAFRI_PROMPT_DIR", QByteArray(IBKR_PROMPTS_DIR)); }

    /// 富途不移植:scan / diagnose / launch 回 -32601(TS 的富途模块没有 C++ 版,不对拍)
    void futuUnsupported() {
        const QString text = u"{\"start\":1789142400000,\"steps\":[{\"op\":\"call\",\"id\":\"a\",\"m\":\"futu.scan\",\"a\":{}},"
                             u"{\"op\":\"call\",\"id\":\"b\",\"m\":\"futu.diagnose\",\"a\":{}},{\"op\":\"call\",\"id\":\"c\",\"m\":\"futu.launch\",\"a\":{}}]}"_s;
        h1w::Runner runner(*ibkr::util::parseOJson(text));
        const QString out = ibkr::util::js::stringify(runner.run());
        QVERIFY2(out.count(u"\"code\":-32601"_s) == 3, qPrintable(out.left(600)));
        QVERIFY(out.contains(u"富途接入不在这个版本里:futu.scan"_s));
    }

    H1_SCENARIOS(ordinary, u"handlers1_ordinary.json"_s)
};

QTEST_GUILESS_MAIN(TestH1Ordinary)
#include "tst_h1_ordinary.moc"
