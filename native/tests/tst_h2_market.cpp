// market 的 handler(handlers2 簇)对着 TS 原类现跑的答案:回执、每一次 service / router / 解析器替身调用的方法与参数、库里变了的表。
// 夹具:fixtures/h2_market.json(gen_h2_market.mjs);世界:h2_world.h / h2_world.mjs。
#include "h2_world.h"
#include "domain/terrain_log.h"

using namespace Qt::StringLiterals;

class TstH2Market : public QObject {
    Q_OBJECT
private slots:
    void terrainOffline() {
        using namespace svcw;
        const auto fixture = jsfix::load(u"h2_market.json"_s);
        const auto script = *js::parse(R"({"steps":[
            {"op":"call","id":"list","m":"options.terrain","a":{}},
            {"op":"call","id":"day","m":"options.terrain","a":{"date":"2026-10-22"}},
            {"op":"call","id":"bad","m":"options.terrain","a":{"date":"../private"}}
        ]})");
        Runner runner(script, *fixture.get(u"base"_s), h2w::buildH2);
        ibkr::domain::TerrainLog log(runner.dir.path()+u"/terrain"_s);
        const double at = QDateTime::fromString(u"2026-10-22T14:00:00Z"_s, Qt::ISODate).toMSecsSinceEpoch();
        log.record(at,at,nullptr);
        const auto result = runner.run();
        const auto& steps = result.get(u"steps"_s)->items;
        const auto reply = [&](int i) { return steps[i].get(u"done"_s)->items[0].get(u"result"_s); };
        QCOMPARE(reply(0)->get(u"ok"_s)->get(u"dates"_s)->items.size(),1);
        QCOMPARE(reply(1)->get(u"ok"_s)->get(u"records"_s)->items.size(),1);
        QCOMPARE(reply(2)->get(u"code"_s)->n,-32602.0);
    }
    void scenarios() {
        if (!QFile::exists(QStringLiteral(IBKR_FIXTURES_DIR "/h2_market.json"))) QSKIP("夹具 h2_market.json 还没生成(gen_h2_market.mjs)");
        const QStringList failures = h2w::replayFixture(u"h2_market.json"_s);
        QVERIFY2(failures.isEmpty(), qPrintable(failures.join(u"\n"_s)));
    }
};

QTEST_GUILESS_MAIN(TstH2Market)
#include "tst_h2_market.moc"
