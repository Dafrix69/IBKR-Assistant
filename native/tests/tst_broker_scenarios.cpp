// BrokerRouter(broker.ts)对着原模块现跑的答案:脚本驱动的假会话,会话上每一次调用的日志、各步结果、基差文件的最终内容逐项精确比较。
// 夹具:fixtures/broker_router.json(命名场景,gen_broker_router.mjs)与 broker_fuzz_*.json(种子固定的随机脚本,gen_broker_fuzz.mjs)。
#include "broker_runner.h"

#include <QDir>
#include <QTest>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;

class TstBrokerScenarios : public QObject {
    Q_OBJECT
private:
    static int runFile(const QString& name, QStringList* failures) {
        if (!QFile::exists(QStringLiteral(IBKR_FIXTURES_DIR) + u'/' + name)) return 0;
        const OJson fx = jsfix::load(name);
        const OJson& base = *fx.get(u"base"_s);
        int count = 0;
        for (const OJson& sc : fx.get(u"scenarios"_s)->items) {
            if (qEnvironmentVariableIsSet("BROKER_TRACE")) fprintf(stderr, "scenario %s\n", qPrintable(sc.get(u"name"_s)->s));
            const OJson script = jsfix::dec(*sc.get(u"script"_s));
            bw::Runner runner(script, base);
            const OJson got = runner.run();
            const QString what = name + u": "_s + sc.get(u"name"_s)->s;
            if (!jsfix::same(*sc.get(u"expected"_s), got, what)) failures->append(what);
            ++count;
        }
        return count;
    }

private slots:
    void named() {
        QStringList failures;
        QVERIFY(runFile(u"broker_router.json"_s, &failures) > 0);
        QVERIFY2(failures.isEmpty(), qPrintable(failures.join(u"\n"_s)));
    }
    void fuzz() {
        QStringList failures;
        int n = 0;
        for (const QString& f : QDir(QStringLiteral(IBKR_FIXTURES_DIR)).entryList({u"broker_fuzz_*.json"_s})) n += runFile(f, &failures);
        QVERIFY2(failures.isEmpty(), qPrintable(failures.join(u"\n"_s)));
        qInfo("fuzz 场景:%d", n);
    }
};

QTEST_GUILESS_MAIN(TstBrokerScenarios)
#include "tst_broker_scenarios.moc"
