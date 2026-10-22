// FillSyncService(services/fillSync.ts)对着原模块现跑的答案:真的 BrokerRouter + 脚本驱动的假会话 + 虚拟钟 + 真的交易库,
// 会话上每一次调用的日志、各步结果、每步之后库里变了的表,逐项精确比较。夹具:fixtures/svc_fillsync.json(gen_svc_fillsync.mjs)。
#include "orchestrate/services/fill_sync.h"
#include "svc_world.h"

#include <QTest>

using namespace svcw;

namespace {

Svc buildFillSync(World& w, Host& host, const OJson&, Runner& runner) {
    auto svc = std::make_shared<FillSyncService>(host);
    Svc s;
    const auto nowOf = [](const OJson& a) -> std::optional<double> {
        const OJson* v = a.get(u"now"_s);
        return v ? std::optional<double>(js::num(v)) : std::nullopt;
    };
    const auto orNull = [](const std::optional<double>& v) { return v ? js::N(*v) : js::Null(); };
    s.methods[u"connect"_s] = [&host](OJson a) -> Task<OJson> {
        co_await host.broker()->connect(str(a, u"name"_s));
        co_return js::Null();
    };
    s.methods[u"tickOnce"_s] = [svc, nowOf, orNull](OJson a) -> Task<OJson> { co_return orNull(co_await svc->tickOnce(nowOf(a))); };
    s.methods[u"sync"_s] = [svc, nowOf, orNull](OJson a) -> Task<OJson> { co_return orNull(co_await svc->sync(nowOf(a), flag(a, u"deep"_s))); };
    s.gets[u"available"_s] = [svc](const OJson&) { return js::B(svc->available()); };
    s.ops[u"router"_s] = [&host, &runner, &w](const OJson& step, OJson&) {
        if (str(step, u"v"_s) == u"make") {
            auto router = std::make_shared<BrokerRouter>(host.settings(), runner.makeFactory(host.settings()));
            router->sleepHook = [&w](int ms) { return w.sleep(ms); };
            host.setBroker(router);
        } else {
            host.setBroker(nullptr);
        }
    };
    s.ops[u"start"_s] = [svc](const OJson& step, OJson&) { svc->start(int(num(step, u"tickMs"_s))); };
    s.ops[u"stop"_s] = [svc](const OJson&, OJson&) { svc->stop(); };
    s.stop = [svc] { svc->stop(); };
    return s;
}

}  // namespace

class TstSvcFillSync : public QObject {
    Q_OBJECT
private slots:
    void scenarios() {
        const OJson fx = jsfix::load(u"svc_fillsync.json"_s);
        const OJson& base = *fx.get(u"base"_s);
        QStringList failures;
        int n = 0;
        for (const OJson& sc : fx.get(u"scenarios"_s)->items) {
            const QString what = sc.get(u"name"_s)->s;
            if (qEnvironmentVariableIsSet("SVC_TRACE")) fprintf(stderr, "scenario %s\n", qPrintable(what));
            const OJson script = jsfix::dec(*sc.get(u"script"_s));
            Runner runner(script, base, buildFillSync);
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

QTEST_GUILESS_MAIN(TstSvcFillSync)
#include "tst_svc_fillsync.moc"
