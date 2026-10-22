// engine/orchestrate/services/alerts_service 对着原模块(engine-ts/src/services/alerts.ts)在 tests/fixtures/gen_svc_alerts.mjs 的场景上:
// 每个场景是一份脚本(假宿主按脚本答、钟是虚拟的),两边都把宿主上被调用的每一次(行情、通知、事件、计时器、stderr)与每步的结果、
// 最后整个库的样子记下来,逐字比。场景含手写的(每个分支)与种子固定的随机交错。
#include "orchestrate/services/alerts_service.h"
#include "svc1_world.h"

#include <QTest>

using namespace sw;
using orch::AlertsService;

namespace {

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
          svc(host, market) {
        routerState = script.get(u"router"_s) ? *script.get(u"router"_s) : js::object();
        host.setEngine(&engine);
        rebuild();
    }

    void rebuild() {
        router = std::make_shared<FakeRouter>(world, routerState);
        host.setRouter(flag(routerState, u"on"_s, true) ? router : nullptr);
    }

    Task<OJson> call(QString m, OJson a) {
        const auto numAt = [&](int i) { return a.items[i].n; };
        const auto strAt = [&](int i) { return js::str(&a.items[i]); };
        if (m == u"refresh") {
            std::optional<double> now;
            if (a.items.size() > 1 && a.items[1].type == OJson::Number) now = a.items[1].n;
            co_return co_await svc.refresh(a.items[0], now);
        }
        if (m == u"tickLevels") {
            const auto r = co_await svc.tickLevels(numAt(0), a.items[1].b);
            co_return r ? js::S(*r) : js::Null();
        }
        if (m == u"tickTouch") {
            const auto r = co_await svc.tickTouch(numAt(0), a.items[1].b);
            co_return r ? js::S(*r) : js::Null();
        }
        if (m == u"levelsStatusOf") {
            const auto r = svc.levelsStatusOf(strAt(0));
            co_return r ? js::S(*r) : js::Null();
        }
        if (m == u"crossConfirm") co_return js::S(svc.crossConfirm());
        if (m == u"listWatches") co_return js::array(co_await svc.listWatches());
        if (m == u"touchConfig") co_return svc.touchConfig().toJson();
        if (m == u"touchConfigChanged") {
            svc.touchConfigChanged();
            co_return js::Null();
        }
        if (m == u"poll") co_return co_await svc.poll();
        if (m == u"forget") {
            svc.forget(strAt(0));
            co_return js::Null();
        }
        if (m == u"adoptForTrack") {
            const auto r = svc.adoptForTrack(strAt(0));
            co_return r ? js::S(*r) : js::Null();
        }
        if (m == u"adoptTracked") {
            QStringList l;
            for (const OJson& x : a.items[0].items) l.append(js::str(&x));
            co_return js::strings(svc.adoptTracked(l));
        }
        if (m == u"releaseForTrack") {
            QSet<QString> set;
            for (const OJson& x : a.items[0].items) set.insert(js::str(&x));
            co_return js::strings(svc.releaseForTrack(set));
        }
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
    AlertsService svc;
    OJson routerState;
    std::shared_ptr<FakeRouter> router;
};

}  // namespace

class TstSvcAlerts : public QObject {
    Q_OBJECT
private slots:
    void initTestCase() { fixture_ = jsfix::load(u"svc_alerts.json"_s); }
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

QTEST_MAIN(TstSvcAlerts)
#include "tst_svc_alerts.moc"
