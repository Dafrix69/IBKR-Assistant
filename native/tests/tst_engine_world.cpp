// 托管单(HostedOrders)+ 回报落库(IbCallbacks)+ 执行对账(Reconciler)+ 出场状态(TrackExits)对着原 TS 模块现跑的答案:
// 脚本驱动的假 router、真的交易库与熔断开关、虚拟钟;对 router / 库 / 通知 / 熔断 / 宿主的每一次调用(方法、参数、虚拟时刻、先后)、各步结果、
// 内部状态、整个库的最终样子逐项精确比较。夹具:fixtures/engine_world.json(命名场景,gen_engine_world.mjs)与 engine_fuzz_*.json(种子固定的随机脚本)。
#include "engine_world.h"
#include "orchestrate/broker_ports.h"  // 只为让适配类过一遍编译

#include "util/jsobj.h"

#include <QDir>
#include <QTest>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;

static_assert(std::is_abstract_v<ibkr::orchestrate::BrokerRouterPorts> == false, "BrokerRouterPorts 没有接全");

class TstEngineWorld : public QObject {
    Q_OBJECT
private:
    static int runFile(const QString& name, QStringList* failures) {
        if (!QFile::exists(QStringLiteral(IBKR_FIXTURES_DIR) + u'/' + name)) return 0;
        const OJson fx = jsfix::load(name);
        const OJson& base = *fx.get(u"base"_s);
        int count = 0;
        for (const OJson& sc : fx.get(u"scenarios"_s)->items) {
            if (qEnvironmentVariableIsSet("ENGINE_TRACE")) fprintf(stderr, "scenario %s\n", qPrintable(sc.get(u"name"_s)->s));
            const OJson script = jsfix::dec(*sc.get(u"script"_s));
            ew::World world(script, jsfix::dec(base));
            const OJson got = world.run();
            const QString what = name + u": "_s + sc.get(u"name"_s)->s;
            if (qEnvironmentVariableIsSet("ENGINE_DUMP")) {  // 排错用:把两边的结果写成文件比
                QFile f(qEnvironmentVariable("ENGINE_DUMP") + u'/' + sc.get(u"name"_s)->s + u".cpp.json"_s);
                if (f.open(QIODevice::WriteOnly)) f.write(js::stringify(jsfix::enc(got)).toUtf8());
                QFile g(qEnvironmentVariable("ENGINE_DUMP") + u'/' + sc.get(u"name"_s)->s + u".ts.json"_s);
                if (g.open(QIODevice::WriteOnly)) g.write(js::stringify(*sc.get(u"expected"_s)).toUtf8());
            }
            if (!jsfix::same(*sc.get(u"expected"_s), got, what)) failures->append(what);
            ++count;
        }
        return count;
    }

private slots:
    void named() {
        QStringList failures;
        QVERIFY(runFile(u"engine_world.json"_s, &failures) > 0);
        QVERIFY2(failures.isEmpty(), qPrintable(failures.join(u"\n"_s)));
    }
    void fuzz() {
        QStringList failures;
        int n = 0;
        for (const QString& f : QDir(QStringLiteral(IBKR_FIXTURES_DIR)).entryList({u"engine_fuzz_*.json"_s})) n += runFile(f, &failures);
        QVERIFY2(failures.isEmpty(), qPrintable(failures.join(u"\n"_s)));
        qInfo("fuzz 场景:%d", n);
    }
};

QTEST_GUILESS_MAIN(TstEngineWorld)
#include "tst_engine_world.moc"
