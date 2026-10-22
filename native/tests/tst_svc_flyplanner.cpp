// FlyPlannerService(services/flyPlanner.ts)对着原模块现跑的答案:脚本驱动的假 router 与假盘口读取 + 虚拟钟。
// 夹具:fixtures/svc_flyplanner.json(gen_svc_flyplanner.mjs)。
#include "orchestrate/services/fly_planner.h"
#include "svc_world.h"

#include <QTest>

using namespace svcw;

namespace {

Svc buildFly(World& w, Host& host, const OJson& script, Runner&) {
    auto svc = std::make_shared<FlyPlannerService>(host);
    svc->marks = std::make_shared<ScriptedMarks>(&w, script);
    World* world = &w;
    if (flag(script, u"recordMarks"_s)) svc->onMarks = [world](const OJson& s) { world->rec(u"onMarks"_s, u"call"_s, js::array({s})); };
    Svc s;
    s.methods[u"planFor"_s] = [svc](OJson a) -> Task<OJson> { co_return co_await svc->planFor(*a.get(u"params"_s)); };
    s.methods[u"spotFor"_s] = [svc](OJson a) -> Task<OJson> { co_return co_await svc->spotFor(str(a, u"symbol"_s)); };
    s.stop = [svc] {};
    return s;
}

}  // namespace

class TstSvcFlyPlanner : public QObject {
    Q_OBJECT
private slots:
    void scenarios() {
        const OJson fx = jsfix::load(u"svc_flyplanner.json"_s);
        const OJson& base = *fx.get(u"base"_s);
        QStringList failures;
        int n = 0;
        for (const OJson& sc : fx.get(u"scenarios"_s)->items) {
            const QString what = sc.get(u"name"_s)->s;
            if (qEnvironmentVariableIsSet("SVC_TRACE")) fprintf(stderr, "scenario %s\n", qPrintable(what));
            const OJson script = jsfix::dec(*sc.get(u"script"_s));
            Runner runner(script, base, buildFly);
            const OJson got = runner.run();
            if (qEnvironmentVariableIsSet("SVC_DUMP") && what == qEnvironmentVariable("SVC_DUMP")) {
                QFile f(QDir::tempPath() + u"/svc_got.json"_s);
                if (f.open(QIODevice::WriteOnly)) f.write(js::stringify(jsfix::enc(got)).toUtf8());
            }
            if (!jsfix::same(*sc.get(u"expected"_s), got, what)) failures.append(what);
            ++n;
        }
        QVERIFY2(failures.isEmpty(), qPrintable(failures.join(u"\n"_s)));
        QVERIFY(n > 0);
    }
};

QTEST_GUILESS_MAIN(TstSvcFlyPlanner)
#include "tst_svc_flyplanner.moc"
