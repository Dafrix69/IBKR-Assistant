// BrokerLinkService(services/brokerLink.ts)对着原模块现跑的答案:真的 BrokerRouter + 脚本驱动的假会话 + 虚拟钟 + 真的交易库,
// 宿主 / 引擎 / 通知器 / stderr / 会话上每一次调用的日志、各步结果、库里变了的表,逐项精确比较。夹具:fixtures/svc_brokerlink.json(gen_svc_brokerlink.mjs)。
#include "orchestrate/services/broker_link.h"
#include "svc_world.h"

#include <QTest>

using namespace svcw;

namespace {

Svc buildLink(World& w, Host& host, const OJson&, Runner& runner) {
    auto svc = std::make_shared<BrokerLinkService>(host);
    svc->makeRouterHook = [&host, &runner, &w] {
        auto router = std::make_shared<BrokerRouter>(host.settings(), runner.makeFactory(host.settings()));
        router->sleepHook = [&w](int ms) { return w.sleep(ms); };
        return router;
    };
    Svc s;
    s.methods[u"connect"_s] = [svc](OJson a) -> Task<OJson> {
        std::optional<QStringList> names;
        if (const OJson* n = a.get(u"names"_s)) {
            QStringList l;
            for (const OJson& x : n->items) l.append(x.s);
            names = l;
        }
        const BrokerConnectResult r = co_await svc->connect(names);
        co_return r.toJson();
    };
    s.methods[u"disconnect"_s] = [svc](const OJson&) -> Task<OJson> {
        co_await svc->disconnect();
        co_return js::Null();
    };
    s.methods[u"retryOnce"_s] = [svc](const OJson&) -> Task<OJson> {
        co_await svc->retryOnce();
        co_return js::Null();
    };
    s.methods[u"external"_s] = [&host, &runner, &w](OJson a) -> Task<OJson> {
        auto router = std::make_shared<BrokerRouter>(host.settings(), runner.makeFactory(host.settings()));
        router->sleepHook = [&w](int ms) { return w.sleep(ms); };
        host.setBroker(router);
        co_await router->connect(str(a, u"name"_s));
        co_return js::Null();
    };
    s.gets[u"router"_s] = [&host](const OJson&) { return host.broker() ? js::S(u"router"_s) : js::Null(); };
    s.gets[u"connected"_s] = [&host](const OJson&) { return host.broker() ? js::strings(host.broker()->connectedNames()) : js::array(); };
    s.ops[u"start"_s] = [svc](const OJson&, OJson&) { svc->start(); };
    s.ops[u"stop"_s] = [svc](const OJson&, OJson&) { svc->stop(); };
    s.ops[u"forget"_s] = [svc](const OJson&, OJson&) { svc->forget(); };
    s.ops[u"router"_s] = [&host](const OJson&, OJson&) { host.setBroker(nullptr); };
    s.stop = [svc] { svc->stop(); };
    return s;
}

}  // namespace

class TstSvcBrokerLink : public QObject {
    Q_OBJECT
private slots:
    void scenarios() {
        const OJson fx = jsfix::load(u"svc_brokerlink.json"_s);
        const OJson& base = *fx.get(u"base"_s);
        QStringList failures;
        int n = 0;
        for (const OJson& sc : fx.get(u"scenarios"_s)->items) {
            const QString what = sc.get(u"name"_s)->s;
            if (qEnvironmentVariableIsSet("SVC_TRACE")) fprintf(stderr, "scenario %s\n", qPrintable(what));
            const OJson script = jsfix::dec(*sc.get(u"script"_s));
            Runner runner(script, base, buildLink);
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

QTEST_GUILESS_MAIN(TstSvcBrokerLink)
#include "tst_svc_brokerlink.moc"
