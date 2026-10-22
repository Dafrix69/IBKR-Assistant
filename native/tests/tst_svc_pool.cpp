// PoolService(services/pool.ts)对着原模块现跑的答案:真的交易库(板块 / 价位监控 / 异动股 / 偏好表)+ 虚拟钟,alerts / anomaly 的 forget 记在日志里。
// 夹具:fixtures/svc_pool.json(gen_svc_pool.mjs)。
#include "orchestrate/services/pool.h"
#include "svc_world.h"

#include <QTest>

using namespace svcw;

namespace {

Svc buildPool(World& w, Host& host, const OJson& script, Runner&) {
    const OJson& p = *script.get(u"ports"_s);
    PoolPorts ports;
    ports.maxWatch = int(num(p, u"maxWatch"_s));
    ports.originTracker = str(p, u"originTracker"_s);
    ports.maxQuality = int(num(p, u"maxQuality"_s));
    World* world = &w;
    ports.forgetAlert = [world](const QString& s) { world->rec(u"alerts"_s, u"forget"_s, js::array({js::S(s)})); };
    ports.forgetAnomaly = [world](const QString& s) { world->rec(u"anomaly"_s, u"forget"_s, js::array({js::S(s)})); };
    auto pool = std::make_shared<PoolService>(host, ports);
    Svc s;
    s.methods[u"setWatch"_s] = [pool](OJson a) -> Task<OJson> {
        PoolWatchPatch patch;
        const OJson& pt = *a.get(u"patch"_s);
        if (const OJson* v = pt.get(u"price"_s)) patch.price = v->b;
        if (const OJson* v = pt.get(u"anomaly"_s)) patch.anomaly = v->b;
        co_return pool->setWatch(str(a, u"symbol"_s), patch, str(a, u"note"_s));
    };
    s.methods[u"ensureInPool"_s] = [pool](OJson a) -> Task<OJson> {
        const auto r = pool->ensureInPool(str(a, u"symbol"_s), str(a, u"company"_s));
        co_return r ? js::S(*r) : js::Null();
    };
    s.methods[u"dropWatches"_s] = [pool](OJson a) -> Task<OJson> {
        QStringList syms;
        for (const OJson& x : a.get(u"symbols"_s)->items) syms.append(x.s);
        co_return js::strings(pool->dropWatches(syms));
    };
    s.methods[u"migrate"_s] = [pool](const OJson&) -> Task<OJson> {
        pool->ensureMigrated();
        co_return js::Null();
    };
    s.stop = [pool] {};
    return s;
}

}  // namespace

class TstSvcPool : public QObject {
    Q_OBJECT
private slots:
    void scenarios() {
        const OJson fx = jsfix::load(u"svc_pool.json"_s);
        const OJson& base = *fx.get(u"base"_s);
        QStringList failures;
        int n = 0;
        for (const OJson& sc : fx.get(u"scenarios"_s)->items) {
            const QString what = sc.get(u"name"_s)->s;
            if (qEnvironmentVariableIsSet("SVC_TRACE")) fprintf(stderr, "scenario %s\n", qPrintable(what));
            const OJson script = jsfix::dec(*sc.get(u"script"_s));
            Runner runner(script, base, buildPool);
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

QTEST_GUILESS_MAIN(TstSvcPool)
#include "tst_svc_pool.moc"
