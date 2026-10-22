// quality 的 handler(handlers2 簇)对着 TS 原类现跑的答案:回执、每一次 service / router / 解析器替身调用的方法与参数、库里变了的表。
// 夹具:fixtures/h2_quality.json(gen_h2_quality.mjs);世界:h2_world.h / h2_world.mjs。
#include "h2_world.h"

using namespace Qt::StringLiterals;

class TstH2Quality : public QObject {
    Q_OBJECT
private slots:
    void scenarios() {
        if (!QFile::exists(QStringLiteral(IBKR_FIXTURES_DIR "/h2_quality.json"))) QSKIP("夹具 h2_quality.json 还没生成(gen_h2_quality.mjs)");
        const QStringList failures = h2w::replayFixture(u"h2_quality.json"_s);
        QVERIFY2(failures.isEmpty(), qPrintable(failures.join(u"\n"_s)));
    }
};

QTEST_GUILESS_MAIN(TstH2Quality)
#include "tst_h2_quality.moc"
