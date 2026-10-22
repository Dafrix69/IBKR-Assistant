// engine/orchestrate/services/anomaly_service 对着原模块(engine-ts/src/services/anomaly.ts,连同真的 alerts.ts)在 tests/fixtures/gen_svc_anomaly.mjs 的场景上:
// 每个场景是一份脚本(假宿主按脚本答、钟是虚拟的),两边都把宿主上被调用的每一次(行情、通知、事件、计时器、stderr)与每步的结果、
// 最后整个库的样子记下来,逐字比。场景含手写的(照 quality-rpc.spec 的每个分支)与种子固定的随机交错。
#include "orchestrate/services/anomaly_service.h"
#include "svc1_world.h"

#include <QTest>

using namespace sw;
using orch::AlertsService;
using orch::AnomalyService;

namespace {

/// 状态 noStream:router 没有 streamQuotes 这条路(TS 里 delete r.streamQuotes):立刻回空、不记日志
class AnoRouter : public FakeRouter {
public:
    using FakeRouter::FakeRouter;
    Task<OJson> streamQuotes(QStringList symbols) override {
        if (flag(state, u"noStream"_s)) return Task<OJson>::resolved(js::object());
        return FakeRouter::streamQuotes(std::move(symbols));
    }
};

/// 状态 bare:router 没有 SUPPORTS_VOLUME_QUOTES(不实现 Svc1Router);其余转给里面那个
class BareRouter : public orch::RouterPort {
public:
    explicit BareRouter(std::shared_ptr<AnoRouter> inner) : inner_(std::move(inner)) {}
    bool hasSessions() override { return inner_->hasSessions(); }
    Task<QList<OJson>> positions() override { qFatal("anomaly 不用 positions"); }
    Task<OJson> streamQuotes(QStringList s) override { return inner_->streamQuotes(std::move(s)); }
    Task<OJson> stockQuotes(QStringList) override { qFatal("anomaly 不用 stockQuotes"); }
    Task<std::optional<double>> indexPrice(QString) override { qFatal("anomaly 不用 indexPrice"); }
    std::optional<OJson> spotInfo(const QString&) override { qFatal("anomaly 不用 spotInfo"); }
    bool upstreamOk() override { return true; }
    std::shared_ptr<ibkr::execution::IbSession> marketSession() override { qFatal("anomaly 不取会话"); }
    Task<OJson> optionChain(QString, std::optional<QString>, double, std::optional<double>, QString) override { qFatal("anomaly 不用 optionChain"); }
    Task<QList<OJson>> historicalBars(QString, QString, QString) override { qFatal("anomaly 不用 historicalBars"); }
    Task<ibkr::execution::TaggedBars> intradayBars(QString, QString, bool, std::optional<QString>, bool) override { qFatal("anomaly 不用 intradayBars"); }

private:
    std::shared_ptr<AnoRouter> inner_;
};

class Runner {
public:
    Runner(const OJson& script, const OJson& base)
        : base_(base),
          world(script),
          settings_(makeSettings(base_, world)),
          store(world.dir.path() + u"/t.db"_s),
          host(world, settings_),
          engine(world, store),
          market(world),
          alerts(host, market),
          svc(host, alerts) {
        routerState = script.get(u"router"_s) ? *script.get(u"router"_s) : js::object();
        host.setEngine(&engine);
        rebuild();
    }
    ~Runner() { svc.stop(); }

    void rebuild() {
        router = std::make_shared<AnoRouter>(world, routerState);
        if (flag(routerState, u"bare"_s)) wrapped = std::make_shared<BareRouter>(router);
        else wrapped = router;
        host.setRouter(flag(routerState, u"on"_s, true) ? wrapped : nullptr);
    }

    Task<OJson> call(QString m, OJson a) {
        const auto strAt = [&](int i) { return js::str(&a.items[i]); };
        if (m == u"tickOnce") {
            std::optional<double> now;
            if (!a.items.isEmpty() && a.items[0].type == OJson::Number) now = a.items[0].n;
            co_return co_await svc.tickOnce(now);
        }
        if (m == u"start") {
            if (!a.items.isEmpty() && a.items[0].type == OJson::Number) svc.start(a.items[0].n);
            else svc.start();
            co_return js::Null();
        }
        if (m == u"stop") {
            svc.stop();
            co_return js::Null();
        }
        if (m == u"monitor") co_return svc.monitor();
        if (m == u"metricsOf") {
            const auto r = svc.metricsOf(strAt(0));
            co_return r ? r->toJson() : js::Null();
        }
        if (m == u"forget") {
            svc.forget(strAt(0));
            co_return js::Null();
        }
        if (m == u"config") co_return svc.config().toJson();
        qFatal("不认识的方法 %s", qPrintable(m));
    }

    OJson run(const OJson& script) {
        Ctx c{world, store, [this](const QString& m, const OJson& a) { return call(m, a); }, [this](const OJson& patch) { host.setSettings(makeSettings(base_, world, &patch)); }};
        c.shape = [](const QString&, const OJson& v) { return v; };
        c.routerState = &routerState;
        c.rebuildRouter = [this] { rebuild(); };
        return runSteps(c, script);
    }

    OJson base_;
    World world;
    ibkr::domain::Settings settings_;
    ibkr::domain::TradeStore store;
    Host host;
    BaseEngine engine;
    FakeMarket market;
    AlertsService alerts;
    AnomalyService svc;
    OJson routerState;
    std::shared_ptr<AnoRouter> router;
    std::shared_ptr<orch::RouterPort> wrapped;
};

}  // namespace

class TstSvcAnomaly : public QObject {
    Q_OBJECT
private slots:
    void initTestCase() { fixture_ = jsfix::load(u"svc_anomaly.json"_s); }
    void scenarios_data() {
        QTest::addColumn<int>("index");
        const OJson& list = *fixture_.get(u"scenarios"_s);
        const QByteArray only = qgetenv("ONLY");
        for (qsizetype i = 0; i < list.items.size(); ++i) {
            const QString name = str(list.items[i], u"name"_s);
            if (!only.isEmpty() && !name.contains(QString::fromUtf8(only))) continue;
            QTest::newRow(qPrintable(name)) << int(i);
        }
    }
    void scenarios() {
        QFETCH(int, index);
        const OJson& sc = fixture_.get(u"scenarios"_s)->items[index];
        const OJson script = jsfix::dec(*sc.get(u"script"_s));
        const OJson base = *fixture_.get(u"base"_s);
        Runner r(script, base);
        const OJson steps = r.run(script);
        const OJson db = dumpDb(r.world.dir.path() + u"/t.db"_s);
        QVERIFY(compareScenario(str(sc, u"name"_s), *sc.get(u"expected"_s), r.world, steps, db));
    }

private:
    OJson fixture_;
};

QTEST_MAIN(TstSvcAnomaly)
#include "tst_svc_anomaly.moc"
