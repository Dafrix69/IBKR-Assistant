// TradingEngine(engine.ts)对着原 TS 模块现跑的答案:脚本驱动的假解析器 / 假 router、真的交易库与熔断开关、虚拟钟;
// 对 router / 解析器 / 库 / 通知 / 熔断的每一次调用(方法、参数、虚拟时刻、先后)、各步结果、内部状态、整个库的最终样子逐项精确比较。
// 夹具:fixtures/engine_core.json(命名场景,gen_engine_core.mjs)与 engine_core_fuzz_*.json(种子固定的随机脚本)。
#include "engine_core_world.h"

#include "domain/day_logs.h"
#include "util/jsobj.h"

#include <QDateTime>
#include <QDir>
#include <QTemporaryDir>
#include <QTest>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;

class TstEngineCore : public QObject {
    Q_OBJECT
private:
    static int runFile(const QString& name, QStringList* failures) {
        if (!QFile::exists(QStringLiteral(IBKR_FIXTURES_DIR) + u'/' + name)) return 0;
        const OJson fx = jsfix::load(name);
        const OJson& base = *fx.get(u"base"_s);
        int count = 0;
        const QString only = qEnvironmentVariable("ENGINE_ONLY");
        for (const OJson& sc : fx.get(u"scenarios"_s)->items) {
            if (!only.isEmpty() && !sc.get(u"name"_s)->s.contains(only)) continue;
            if (qEnvironmentVariableIsSet("ENGINE_TRACE")) fprintf(stderr, "scenario %s\n", qPrintable(sc.get(u"name"_s)->s));
            const OJson script = jsfix::dec(*sc.get(u"script"_s));
            ecw::World world(script, jsfix::dec(base));
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
    void initTestCase() { qputenv("DAFRI_PROMPT_DIR", (QStringLiteral(IBKR_FIXTURES_DIR) + u"/../../../prompts"_s).toUtf8()); }
    void named() {
        QStringList failures;
        QVERIFY(runFile(u"engine_core.json"_s, &failures) > 0);
        QVERIFY2(failures.isEmpty(), qPrintable(failures.join(u"\n"_s)));
    }
    /// C++ 独有的行为(TS 没有,见 engine.h 头注释「与 TS 的有意差别」):脚本在 fixtures/engine_core_cpp.json,断言写在这里
    void cppOnly() {
        const OJson fx = jsfix::load(u"engine_core_cpp.json"_s);
        const OJson base = jsfix::dec(*fx.get(u"base"_s));
        const auto run = [&](const QString& name, OJson* result, ecw::World** keep, std::unique_ptr<ecw::World>& holder) {
            for (const OJson& sc : fx.get(u"scenarios"_s)->items) {
                if (sc.get(u"name"_s)->s != name) continue;
                holder = std::make_unique<ecw::World>(jsfix::dec(*sc.get(u"script"_s)), base);
                *result = holder->run();
                *keep = holder.get();
                return;
            }
            QFAIL(qPrintable(u"没有脚本 "_s + name));
        };
        const auto placeCount = [](const OJson& out) {
            int n = 0;
            for (const OJson& e : out.get(u"log"_s)->items)
                if (js::str(js::prop(&e, u"c"_s)) == u"router" && js::str(js::prop(&e, u"m"_s)) == u"place") ++n;
            return n;
        };
        const auto stepResult = [](const OJson& out, int i) { return *out.get(u"steps"_s)->items[i].get(u"r"_s); };
        const auto pendingCount = [](ecw::World& w) { return w.snapshot().get(u"pending"_s)->items.size(); };
        {  // ① reload:两张排队的条件单交给新引擎,到价都能发,发一次
            std::unique_ptr<ecw::World> h;
            ecw::World* w = nullptr;
            OJson out;
            run(u"cppx_reload_keeps_pending"_s, &out, &w, h);
            QCOMPARE(stepResult(out, 0).get(u"queued"_s)->items.size(), 2);
            QCOMPARE(stepResult(out, 2).items.size(), 2);
            QCOMPARE(stepResult(out, 3).items.size(), 0);
            QCOMPARE(placeCount(out), 2);
            QCOMPARE(pendingCount(*w), qsizetype(0));
        }
        {  // ② firePending 每张发出前再查熔断:第一张发单时熔断被合上,第二张留在队里;解除后能发
            std::unique_ptr<ecw::World> h;
            ecw::World* w = nullptr;
            OJson out;
            run(u"cppx_fire_rechecks_breaker"_s, &out, &w, h);
            QCOMPARE(stepResult(out, 1).items.size(), 1);
            QCOMPARE(placeCount(out), 2);  // 第一次 fire 发一张,解除熔断后的第二次 fire 再发一张
            QCOMPARE(stepResult(out, 3).items.size(), 1);
            // 第一次 fire 之后(步 1)队里还剩一张
            const OJson* snap1 = out.get(u"steps"_s)->items[1].get(u"snap"_s);
            QVERIFY(snap1);
            QCOMPARE(snap1->get(u"pending"_s)->items.size(), 1);
        }
        {  // ④ 换下来的引擎挂在会话上的回报监听,转给新引擎:成交落在新引擎的账上,旧引擎自己什么都没记
            std::unique_ptr<ecw::World> h;
            ecw::World* w = nullptr;
            OJson out;
            run(u"cppx_retired_engine_forwards_to_new"_s, &out, &w, h);
            QCOMPARE(w->retiredEngines.size(), size_t(1));
            QCOMPARE(w->engine->finalized.size(), qsizetype(1));
            QCOMPARE(w->retiredEngines[0]->finalized.size(), qsizetype(0));
            QCOMPARE(w->engine->orderIndex.size(), qsizetype(1));  // 回报账同一个 router 上接过来了
            QCOMPARE(w->snapshot().get(u"unmatched"_s)->items.size(), 0);
        }
        {  // ④b 成交、佣金、订单错误、新会话(sessionHook → wireSession)也都转给新引擎
            std::unique_ptr<ecw::World> h;
            ecw::World* w = nullptr;
            OJson out;
            run(u"cppx_retired_forwards_the_rest"_s, &out, &w, h);
            QCOMPARE(w->engine->seenFills.size(), qsizetype(1));
            QCOMPARE(w->engine->seenCommissions.size(), qsizetype(1));
            QCOMPARE(w->engine->finalized.size(), qsizetype(1));  // 201 把这张单落成终态
            QCOMPARE(w->retiredEngines[0]->seenFills.size(), qsizetype(0));
            QCOMPARE(w->retiredEngines[0]->seenCommissions.size(), qsizetype(0));
            QCOMPARE(w->retiredEngines[0]->finalized.size(), qsizetype(0));
            // 新会话挂监听时 reconcileSoon 落在新引擎上:tick 之后对账时刻 > 0,连上 s2 之后回到 0
            const OJson* snap3 = out.get(u"steps"_s)->items[3].get(u"snap"_s);
            QVERIFY(snap3 && js::num(snap3->get(u"reconcile"_s)->get(u"at"_s)) > 0);
            QCOMPARE(js::num(w->snapshot().get(u"reconcile"_s)->get(u"at"_s)), 0.0);
        }
        {  // ⑤ 换了 router(换了券商连接):旧订单号不作数,回报账不接;回报进来认不出记录,先攒着
            std::unique_ptr<ecw::World> h;
            ecw::World* w = nullptr;
            OJson out;
            run(u"cppx_ledgers_not_carried_to_new_router"_s, &out, &w, h);
            QCOMPARE(w->engine->finalized.size(), qsizetype(0));
            QCOMPARE(w->engine->orderIndex.size(), qsizetype(0));
            QCOMPARE(w->snapshot().get(u"unmatched"_s)->items.size(), 1);
        }
        {  // ③ halt:cancelAllOpen 抛了,条件单队列与托管缓存照样清,熔断合上,错误抛出来
            std::unique_ptr<ecw::World> h;
            ecw::World* w = nullptr;
            OJson out;
            run(u"cppx_halt_cancel_throws"_s, &out, &w, h);
            const OJson haltResult = stepResult(out, 3);
            QCOMPARE(js::str(js::prop(&haltResult, u"error"_s)), u"撤单炸了"_s);
            const OJson snap = w->snapshot();
            QCOMPARE(snap.get(u"pending"_s)->items.size(), 0);
            QCOMPARE(snap.get(u"hosted"_s)->get(u"hosted"_s)->fields.size(), 0);
            QVERIFY(js::truthy(snap.get(u"breaker"_s)->get(u"engaged"_s)));
            bool audited = false;
            for (const OJson& e : out.get(u"log"_s)->items)
                if (js::str(js::prop(&e, u"c"_s)) == u"store" && js::str(js::prop(&e, u"m"_s)) == u"audit" && js::stringify(*e.get(u"a"_s)).contains(u"cancel_failed"))
                    audited = true;
            QVERIFY(audited);
        }
    }
    /// SessionEmCache:一分钟内用缓存(边界:正好 60 秒就重读)、时间倒退就重读
    void sessionEmCacheTtl() {
        QTemporaryDir dir;
        ibkr::domain::Settings settings;
        settings.db_path = dir.filePath(u"trades.db"_s);
        ibkr::orchestrate::SessionEmCache cache([&]() -> const ibkr::domain::Settings& { return settings; });
        const double t0 = double(QDateTime::fromString(u"2026-09-11T13:40:00Z"_s, Qt::ISODate).toMSecsSinceEpoch());  // 美东 09:40
        const auto band = [&](double atMs, double em) {
            return js::object({{u"kind"_s, js::S(u"open"_s)},
                               {u"band"_s, js::object({{u"at"_s, js::N(atMs)}, {u"anchor"_s, js::N(7500)}, {u"strike"_s, js::N(7500)}, {u"expiry"_s, js::S(u"20260911"_s)},
                                                       {u"call"_s, js::N(20)}, {u"put"_s, js::N(20)}, {u"source"_s, js::S(u"live"_s)}, {u"em"_s, js::N(em)},
                                                       {u"lower"_s, js::N(7480)}, {u"upper"_s, js::N(7520)}})}});
        };
        const ibkr::domain::PlaybookLog log(dir.filePath(u"playbook"_s));
        log.append(u"2026-09-11"_s, band(t0 - 5 * 60'000, 20));
        const auto em1 = cache.today(ibkr::domain::etNowFromEpoch(t0));
        QVERIFY(em1);
        log.append(u"2026-09-11"_s, band(t0 - 9 * 60'000, 40));  // 更早的一条排在前面:重读才看得到
        QCOMPARE(cache.today(ibkr::domain::etNowFromEpoch(t0 + 59'999)), em1);  // 缓存
        const auto em2 = cache.today(ibkr::domain::etNowFromEpoch(t0 + 60'000));  // 正好到点:重读
        QVERIFY(em2);
        QVERIFY(*em2 != *em1);
        log.append(u"2026-09-11"_s, band(t0 - 12 * 60'000, 80));
        QCOMPARE(cache.today(ibkr::domain::etNowFromEpoch(t0 + 60'000 + 1000)), em2);  // 又缓存
        const auto em3 = cache.today(ibkr::domain::etNowFromEpoch(t0));  // 时间倒退(早于缓存那一刻):重读
        QVERIFY(em3);
        QVERIFY(*em3 != *em2);
    }
    void fuzz() {
        QStringList failures;
        int n = 0;
        for (const QString& f : QDir(QStringLiteral(IBKR_FIXTURES_DIR)).entryList({u"engine_core_fuzz_*.json"_s})) n += runFile(f, &failures);
        QVERIFY2(failures.isEmpty(), qPrintable(failures.join(u"\n"_s)));
        qInfo("fuzz 场景:%d", n);
    }
};

QTEST_GUILESS_MAIN(TstEngineCore)
#include "tst_engine_core.moc"
