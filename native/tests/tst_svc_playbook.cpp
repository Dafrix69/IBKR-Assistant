// engine/orchestrate/services/playbook_service 对着原模块(engine-ts/src/services/playbook.ts)在 tests/fixtures/gen_svc_playbook.mjs 的场景上:
// 每个场景是一份脚本(假宿主按脚本答、钟是虚拟的),两边都把宿主上被调用的每一次(券商四样、IB 会话、盘口读取、期权墙、事件、计时器、stderr)
// 与每步的结果、写出来的底账文件、最后整个库的样子记下来,逐字比。场景含手写的(每个分支)与种子固定的随机交错。
// 环境变量:ONLY=<场景名里的子串> 只跑这些;SVC_PLAYBOOK_FIXTURE=<路径> 换一份夹具(检验"测试会咬人"用:拿改坏的副本跑,必须红)。
#include "orchestrate/services/playbook_service.h"
#include "svc1_playbook_world.h"
#include "svc1_world.h"

#include <QTest>

#include <unistd.h>

using namespace sw;
using orch::PlaybookService;

namespace {

class Runner {
public:
    Runner(const OJson& script, const OJson& fixtureBase)
        : base_(script.get(u"base"_s) ? *script.get(u"base"_s) : fixtureBase),
          world(script),
          settings_(makePbSettings(base_, world)),
          store(world.dir.path() + u"/t.db"_s),
          host(world, settings_),
          engine(world, store),
          market(world),
          marks(world),
          session(std::make_shared<PbSession>(world)) {
        routerState = script.get(u"router"_s) ? *script.get(u"router"_s) : js::object();
        host.setEngine(&engine);
        rebuild();
        spawn();
    }

    void rebuild() {
        router = std::make_shared<PbRouter>(world, routerState);
        router->session = session;
        host.setRouter(flag(routerState, u"on"_s, true) ? router : nullptr);
    }
    /// 新建一个服务;旧的留着不释放(它的计时器与在途的调用还抓着 this)
    void spawn() { svcs.push_back(std::make_unique<PlaybookService>(host, marks, market)); }
    PlaybookService& svc() { return *svcs.back(); }

    Task<OJson> call(QString m, OJson a) {
        const auto optNum = [&](int i) -> std::optional<double> {
            return i < a.items.size() && a.items[i].type == OJson::Number ? std::optional<double>(a.items[i].n) : std::nullopt;
        };
        if (m == u"tickOnce") co_return co_await svc().tickOnce(optNum(0));
        if (m == u"snapshot") co_return svc().snapshot();
        if (m == u"enabled") co_return js::B(svc().enabled());
        if (m == u"setEnabled") co_return svc().setEnabled(a.items[0].b);
        if (m == u"start") {
            if (const auto ms = optNum(0)) svc().start(int(*ms));
            else svc().start();
            co_return js::Null();
        }
        if (m == u"stop") {
            svc().stop();
            co_return js::Null();
        }
        qFatal("不认识的方法 %s", qPrintable(m));
    }

    OJson run(const OJson& script) {
        Ctx c{world, store, [this](const QString& m, const OJson& a) { return call(m, a); }, [this](const OJson& patch) { host.setSettings(makePbSettings(base_, world, &patch)); }};
        c.shape = [](const QString&, const OJson& v) { return v; };
        c.routerState = &routerState;
        c.rebuildRouter = [this] { rebuild(); };
        registerPbOps(c);
        c.extraOps[u"restart"_s] = [this](const OJson&, OJson&) {
            svc().stop();
            spawn();
        };
        return runSteps(c, script);
    }

    OJson base_;
    World world;
    ibkr::domain::Settings settings_;
    ibkr::domain::TradeStore store;
    Host host;
    BaseEngine engine;
    FakeMarket market;
    PbMarks marks;
    std::shared_ptr<PbSession> session;
    std::vector<std::unique_ptr<PlaybookService>> svcs;
    OJson routerState;
    std::shared_ptr<PbRouter> router;
};

}  // namespace

class TstSvcPlaybook : public QObject {
    Q_OBJECT
private slots:
    void initTestCase() {
        const QByteArray path = qgetenv("SVC_PLAYBOOK_FIXTURE");
        if (path.isEmpty()) {
            fixture_ = jsfix::load(u"svc_playbook.json"_s);
            return;
        }
        QFile f(QString::fromUtf8(path));
        if (!f.open(QIODevice::ReadOnly)) qFatal("读不了夹具 %s", path.constData());
        const auto parsed = ibkr::util::parseOJson(QString::fromUtf8(f.readAll()));
        if (!parsed) qFatal("夹具不是 JSON");
        fixture_ = *parsed;
    }
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
        // 目录改成只读之后 root 照样写得进去:这个场景的期望是非 root 跑出来的
        if (str(sc, u"name"_s) == u"log_write_fails_eacces" && ::geteuid() == 0) QSKIP("root 不受目录权限限制");
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

QTEST_MAIN(TstSvcPlaybook)
#include "tst_svc_playbook.moc"
