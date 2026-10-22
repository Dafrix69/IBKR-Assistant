// transport/context(rpc/context.ts)与 orchestrate/host(services/host.ts)对着 TS 现跑的答案(tools/gen_rpc_server.mjs 的 misc):
// needConnection / gatewayName(三种券商:ibkr、futu、不认识的与空串)、HandlerBase.accounts()、追踪锁的先后(成败都往下接)、installMethods 的重复登记。
#include "js_fixture.h"
#include "domain/config.h"
#include "contract/kit.h"
#include "orchestrate/host.h"
#include "transport/context.h"
#include "util/jsobj.h"

#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <QTemporaryDir>
#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using util::OJson;
namespace js = util::js;

namespace {

struct Fake : rpc::RpcContext {
    domain::Settings s;
    std::shared_ptr<orchestrate::Router> r;
    QList<QPair<QString, OJson>> events;
    rpc::SerialLock lock;
    const domain::Settings& settings() const override { return s; }
    std::shared_ptr<orchestrate::Router> router() const override { return r; }
    orchestrate::TradingEngine& engine() override { qFatal("没有引擎"); }
    void emitEvent(const QString& event, const OJson& payload) override { events.append({event, payload}); }
    void setSettings(domain::Settings v) override { s = std::move(v); }
    void setRouter(std::shared_ptr<orchestrate::Router> v) override { r = std::move(v); }
    orchestrate::TradingEngine* engineBuilt() const override { return nullptr; }
    std::shared_ptr<rpc::Parser> parserFactory(const contract::LLMConfig&) override { return nullptr; }
    void reload() override {}
    void dropEngine() override {}
    rpc::SerialLock& trackerLock() override { return lock; }
};

struct Probe : rpc::HandlerBase {
    explicit Probe(rpc::RpcContext& c) : HandlerBase(c) {}
    rpc::MethodTable methods() override { return {}; }
    OJson view() const { return accounts(); }
    util::RpcError need(int code, const QString& what) const { return needConnection(code, what); }
    QString gw() const { return gateway(); }
};

struct Named : rpc::HandlerBase {
    Named(rpc::RpcContext& c, QStringList names) : HandlerBase(c), names_(std::move(names)) {}
    rpc::MethodTable methods() override {
        rpc::MethodTable t;
        for (const QString& n : names_) t.push_back({n, rpc::syncHandler([n](const OJson&) { return js::S(n); })});
        return t;
    }
    QStringList names_;
};

domain::Settings baseSettings(QTemporaryDir& dir) {
    QFile in(QStringLiteral(IBKR_CONTRACT_DIR "/../../baseline/rpc/base_config.json"));
    if (!in.open(QIODevice::ReadOnly)) qFatal("读不了 base_config.json");
    QJsonObject config = QJsonDocument::fromJson(in.readAll()).object();
    config.insert(u"storage"_s, QJsonObject{{u"db_path"_s, dir.filePath(u"t.db"_s)}});
    const QString path = dir.filePath(u"settings.json"_s);
    QFile out(path);
    if (!out.open(QIODevice::WriteOnly)) qFatal("写不了配置");
    out.write(QJsonDocument(config).toJson());
    out.close();
    return domain::loadSettings(path);
}

}  // namespace

class TestRpcContext : public QObject {
    Q_OBJECT
private slots:
    void gatewayNamesAndAccountsMatchTs() {
        const OJson fx = jsfix::load(u"rpc-server.json"_s);
        QTemporaryDir dir;
        Fake ctx;
        ctx.s = baseSettings(dir);
        Probe probe(ctx);
        for (const OJson& c : fx.get(u"misc"_s)->get(u"gateway"_s)->items) {
            const QString provider = c.get(u"provider"_s)->s;
            ctx.s.broker.provider = provider;
            const QString what = u"provider=%1"_s.arg(provider);
            QCOMPARE(orchestrate::gatewayName(ctx.s), c.get(u"gateway"_s)->s);
            QCOMPARE(probe.gw(), c.get(u"base"_s)->s);
            const util::RpcError e = orchestrate::needConnection(ctx.s, int(c.get(u"code"_s)->n), u"下单"_s);
            QCOMPARE(e.code(), int(c.get(u"code"_s)->n));
            QCOMPARE(e.message(), c.get(u"message"_s)->s);
            const util::RpcError b = probe.need(int(c.get(u"baseCode"_s)->n), u"「读持仓」"_s);
            QCOMPARE(b.code(), int(c.get(u"baseCode"_s)->n));
            QCOMPARE(b.message(), c.get(u"baseMessage"_s)->s);
            QCOMPARE(c.get(u"cls"_s)->s, u"RpcError"_s);
            JSFIX_SAME(*c.get(u"accounts"_s), probe.view(), what);
        }
    }

    void trackerLockRunsOneAtATimeAndSurvivesFailures() {
        const OJson fx = jsfix::load(u"rpc-server.json"_s);
        const OJson* want = fx.get(u"misc"_s)->get(u"lock"_s);
        rpc::SerialLock lock;
        QStringList log;
        const auto job = [&](const QString& name, int ms, int value, bool fails) {
            return [&log, name, ms, value, fails]() -> util::Task<int> {
                log << name + u" start"_s;
                if (ms) co_await util::sleepMs(ms);
                if (fails) throw util::JsError(name + u" fail"_s);
                if (ms) log << name + u" end"_s;
                co_return value;
            };
        };
        QList<util::Task<int>> tasks;
        tasks << lock.run<int>(job(u"a"_s, 40, 1, false));
        tasks << lock.run<int>(job(u"b"_s, 0, 2, true));
        tasks << lock.run<int>(job(u"c"_s, 10, 3, false));
        tasks << lock.run<int>([&log]() -> util::Task<int> {
            log << u"d sync"_s;
            co_return 4;
        });
        tasks << lock.run<int>([&log]() -> util::Task<int> {
            log << u"e throws synchronously"_s;
            throw util::JsError(u"e fail"_s);
        });
        tasks << lock.run<int>([&log]() -> util::Task<int> {
            log << u"f start"_s;
            co_return 6;
        });
        QTRY_VERIFY(tasks.last().done());
        QStringList wantLog;
        for (const OJson& l : want->get(u"log"_s)->items) wantLog << l.s;
        // 这里的 b / e 的 fail 之前的"start"也是 TS 里的 log:b 在 TS 里先记 b start 再抛
        QCOMPARE(log, wantLog);
        const auto& results = want->get(u"results"_s)->items;
        QCOMPARE(results.size(), tasks.size());
        for (qsizetype i = 0; i < tasks.size(); ++i) {
            QVERIFY(tasks[i].done());
            if (const OJson* ok = results[i].get(u"ok"_s)) {
                QCOMPARE(tasks[i].result(), int(ok->n));
            } else {
                try {
                    tasks[i].result();
                    QFAIL("该抛");
                } catch (const util::JsError& e) {
                    QCOMPARE(e.message(), results[i].get(u"error"_s)->s);
                }
            }
        }
        // void 版本同样往下接
        QStringList order;
        auto v1 = lock.runVoid([&order]() -> util::Task<void> {
            co_await util::sleepMs(20);
            order << u"v1"_s;
        });
        auto v2 = lock.runVoid([&order]() -> util::Task<void> {
            order << u"v2"_s;
            throw util::JsError(u"x"_s);
            co_return;
        });
        auto v3 = lock.runVoid([&order]() -> util::Task<void> {
            order << u"v3"_s;
            co_return;
        });
        QTRY_VERIFY(v3.done());
        QCOMPARE(order, (QStringList{u"v1"_s, u"v2"_s, u"v3"_s}));
        QVERIFY(v2.error());
        QVERIFY(!v1.error());
    }

    /// syncHandler:返回值包成已完成的 Task,抛的错包成已失败的 Task
    void syncHandlerWrapsResultsAndErrors() {
        const auto ok = rpc::syncHandler([](const OJson& p) { return js::object({{u"echo"_s, p}}); });
        const util::Task<OJson> a = ok(js::N(1));
        QVERIFY(a.done());
        QVERIFY(!a.error());
        QCOMPARE(js::stringify(a.result()), u"{\"echo\":1}"_s);
        const auto bad = rpc::syncHandler([](const OJson&) -> OJson { throw util::RpcError(-32010, u"拒"_s); });
        const util::Task<OJson> b = bad(OJson());
        QVERIFY(b.done());
        QVERIFY(b.error());
        try {
            b.result();
            QFAIL("该抛");
        } catch (const util::RpcError& e) {
            QCOMPARE(e.code(), -32010);
        }
    }

    /// kit 的几个小转换在「没给这个键」时的结果(zod 的 transform 入参是 undefined):passThrough 回 undefined(键不出现)、truthy 回 false、noParams 回 {}
    void kitTransformsSeeUndefined() {
        namespace z = util::zod;
        const auto shape = [](z::SchemaPtr s) { return z::object({{u"k"_s, std::move(s)}}); };
        const auto parseWith = [&](z::SchemaPtr s, const QString& text) {
            const auto raw = util::parseOJson(text);
            return z::safeParse(*shape(std::move(s)), &*raw);
        };
        const auto pass = parseWith(contract::passThrough(), u"{}"_s);
        QVERIFY(pass.success);
        QCOMPARE(js::stringify(*pass.data), u"{}"_s);
        QCOMPARE(js::stringify(*parseWith(contract::passThrough(), u"{\"k\":[1,null]}"_s).data), u"{\"k\":[1,null]}"_s);
        QCOMPARE(js::stringify(*parseWith(contract::truthyOf(), u"{}"_s).data), u"{\"k\":false}"_s);
        QCOMPARE(js::stringify(*parseWith(contract::truthyOf(), u"{\"k\":\"x\"}"_s).data), u"{\"k\":true}"_s);
        QCOMPARE(js::stringify(*parseWith(contract::noParams(), u"{}"_s).data), u"{\"k\":{}}"_s);
        // requiredButReportedByHandler:没给 / null 是空串,给了数字是 -32602 那一类的 issue
        QCOMPARE(js::stringify(*parseWith(contract::requiredButReportedByHandler(), u"{}"_s).data), u"{\"k\":\"\"}"_s);
        QCOMPARE(js::stringify(*parseWith(contract::requiredButReportedByHandler(), u"{\"k\":null}"_s).data), u"{\"k\":\"\"}"_s);
        QVERIFY(!parseWith(contract::requiredButReportedByHandler(), u"{\"k\":5}"_s).success);
    }

    void installMethodsRejectsDuplicates() {
        QTemporaryDir dir;
        Fake ctx;
        ctx.s = baseSettings(dir);
        rpc::RpcServer server([](const QByteArray&) {});
        Named a(ctx, {u"x.a"_s, u"x.b"_s}), b(ctx, {u"y.a"_s}), dup(ctx, {u"x.b"_s});
        rpc::installMethods(server, {&a, &b});
        QCOMPARE(server.methodNames(), (QStringList{u"x.a"_s, u"x.b"_s, u"y.a"_s}));
        try {
            rpc::installMethods(server, {&dup});
            QFAIL("该抛");
        } catch (const util::JsError& e) {
            QCOMPARE(e.message(), u"RPC 方法重复登记:x.b"_s);
        }
    }

    void serviceBaseReadsTheHostEveryTime() {
        // service 不存 settings 的拷贝:宿主换了配置,下一次读到的就是新的
        struct Svc : orchestrate::ServiceBase {
            explicit Svc(orchestrate::ServiceHost& h) : ServiceBase(h) {}
            QString provider() const { return settings().broker.provider; }
            util::RpcError need() const { return needConnection(-32009, u"取数"_s); }
            void ping() { emitEvent(u"ping"_s, js::object()); }
        };
        QTemporaryDir dir;
        Fake ctx;
        ctx.s = baseSettings(dir);
        Svc svc(ctx);
        QCOMPARE(svc.provider(), u"ibkr"_s);
        domain::Settings next = ctx.s;
        next.broker.provider = u"futu"_s;
        ctx.setSettings(next);
        QCOMPARE(svc.provider(), u"futu"_s);
        QCOMPARE(svc.need().message(), u"取数需要富途 OpenD:请先在「富途 OpenD」面板连接引擎。"_s);
        svc.ping();
        QCOMPARE(ctx.events.size(), 1);
        QCOMPARE(ctx.events[0].first, u"ping"_s);
    }
};

QTEST_GUILESS_MAIN(TestRpcContext)
#include "tst_rpc_context.moc"
