// BrokerRouter(broker.ts)对着原模块现跑的答案:脚本驱动的假会话,会话上每一次调用的日志、各步结果、基差文件的最终内容逐项精确比较。
// 夹具:fixtures/broker_router.json(命名场景,gen_broker_router.mjs)与 broker_fuzz_*.json(种子固定的随机脚本,gen_broker_fuzz.mjs)。
#include "broker_runner.h"

#include <QDir>
#include <QTest>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;

class TstBrokerScenarios : public QObject {
    Q_OBJECT
private:
    static int runFile(const QString& name, QStringList* failures) {
        if (!QFile::exists(QStringLiteral(IBKR_FIXTURES_DIR) + u'/' + name)) return 0;
        const OJson fx = jsfix::load(name);
        const OJson& base = *fx.get(u"base"_s);
        int count = 0;
        for (const OJson& sc : fx.get(u"scenarios"_s)->items) {
            if (qEnvironmentVariableIsSet("BROKER_TRACE")) fprintf(stderr, "scenario %s\n", qPrintable(sc.get(u"name"_s)->s));
            const OJson script = jsfix::dec(*sc.get(u"script"_s));
            bw::Runner runner(script, base);
            const OJson got = runner.run();
            const QString what = name + u": "_s + sc.get(u"name"_s)->s;
            if (!jsfix::same(*sc.get(u"expected"_s), got, what)) failures->append(what);
            ++count;
        }
        return count;
    }

private slots:
    void underlyingConditionalOrders() {
        using namespace ibkr;
        namespace js = util::js;
        const auto fx = jsfix::load(u"broker_router.json"_s);
        auto script = *util::parseOJson(R"({"start":1791815400000,"factory":{"paper":["P"]},
            "sessions":[{"name":"P","connected":true,"accounts":["DU7654321"],"caps":["OpenTradesDetailed"]}],"steps":[]})");
        const auto contract = *util::parseOJson(R"({"secType":"OPT","symbol":"SPX","exchange":"SMART","currency":"USD","expiry":"20261218","strike":6100,"right":"C"})");
        auto item = *util::parseOJson(R"({"kind":"spot","action":"SELL","order_type":"MKT","quantity":2,
            "lmt_price":null,"aux_price":null,"trailing_percent":null,"spot_conditions":[{"price":6000,"isMore":false},{"price":6200,"isMore":true}]})");
        const auto call = [](const QString& m, const OJson& a) { return js::object({{u"op"_s, js::S(u"call"_s)}, {u"m"_s, js::S(m)}, {u"a"_s, a}}); };
        auto args = js::object({{u"account"_s, js::S(u"模拟"_s)}, {u"contract"_s, contract}, {u"item"_s, item},
            {u"oca"_s, js::S(u"same-position"_s)}, {u"ref"_s, js::S(u"trk:test:spot"_s)}});
        auto steps = js::array({call(u"connect"_s, js::object({{u"name"_s, js::S(u"paper"_s)}})), call(u"placeHosted"_s, args)});
        item.get(u"spot_conditions"_s)->items[0].set(u"price"_s, js::N(6010));
        item.set(u"quantity"_s, js::N(1));
        steps.items.append(call(u"modifyHosted"_s, js::object({{u"orderId"_s, js::N(101)}, {u"item"_s, item}})));
        // 条件丢失必须拒绝,不能降级成即时市价平仓。
        item.remove(u"spot_conditions"_s);
        args.set(u"item"_s, item);
        steps.items.append(call(u"placeHosted"_s, args));
        steps.items.append(call(u"cancelHosted"_s, js::object({{u"orderId"_s, js::N(101)}})));
        script.set(u"steps"_s, steps);
        bw::Runner runner(script, *fx.get(u"base"_s));
        const auto result = runner.run();
        QList<OJson> orders;
        bool indexQualified = false, cancelled = false;
        for (const auto& e : result.get(u"log"_s)->items) {
            if (e.get(u"m"_s)->s == u"placeOrder") orders.append(e.get(u"a"_s)->items[1]);
            if (e.get(u"m"_s)->s == u"cancelOrder") cancelled = true;
            if (e.get(u"m"_s)->s == u"qualifyContracts")
                for (const auto& c : e.get(u"a"_s)->items[0].items)
                    if (js::str(c.get(u"secType"_s)) == u"IND" && js::str(c.get(u"symbol"_s)) == u"SPX" && js::str(c.get(u"exchange"_s)) == u"CBOE") indexQualified = true;
        }
        QCOMPARE(orders.size(), 2);
        QVERIFY(indexQualified);
        QVERIFY(cancelled);
        for (const auto& order : orders) {
            QCOMPARE(order.get(u"ocaGroup"_s)->s, u"same-position"_s);
            QCOMPARE(order.get(u"ocaType"_s)->n, 1.0);
            QCOMPARE(order.get(u"orderType"_s)->s, u"MKT"_s);
            QVERIFY(!order.get(u"conditionsCancelOrder"_s)->b);
            QVERIFY(!order.get(u"conditionsIgnoreRth"_s)->b);
            QCOMPARE(order.get(u"conditions"_s)->items.size(), 2);
            for (const auto& c : order.get(u"conditions"_s)->items) {
                QCOMPARE(c.get(u"triggerMethod"_s)->n, 2.0);
                QCOMPARE(c.get(u"conjunctionConnection"_s)->s, u"o"_s);
                QVERIFY(c.get(u"conId"_s)->n > 0);
            }
        }
        QCOMPARE(orders[1].get(u"orderId"_s)->n, 101.0);
        QCOMPARE(orders[1].get(u"totalQuantity"_s)->n, 1.0);
        QCOMPARE(orders[1].get(u"conditions"_s)->items[0].get(u"price"_s)->n, 6010.0);
    }

    void adoptedConditionsSurviveQuantityChange() {
        using namespace ibkr;
        namespace js = util::js;
        const auto fx = jsfix::load(u"broker_router.json"_s);
        const auto script = *util::parseOJson(R"({"start":1791815400000,"factory":{"paper":["P"]},"sessions":[{
            "name":"P","connected":true,"accounts":["DU7654321"],"caps":["OpenTradesDetailed"],"detailed":[{
            "orderId":88,"orderRef":"trk:test:spot","account":"DU7654321","action":"SELL","orderType":"LMT","totalQuantity":3,
            "lmtPrice":1.25,"tif":"GTC","ocaGroup":"same-position","ocaType":1,"contract":{"secType":"OPT","symbol":"SPX","exchange":"SMART","currency":"USD","conId":555},
            "conditions":[{"price":6000,"isMore":false,"conId":416904,"exchange":"CBOE","triggerMethod":2,"conjunctionConnection":"o"}],
            "conditionsIgnoreRth":false,"conditionsCancelOrder":false}]}],"steps":[
            {"op":"call","m":"connect","a":{"name":"paper"}},{"op":"call","m":"listHostedOpen","a":{"prefix":"trk:"}},
            {"op":"call","m":"modifyHosted","a":{"orderId":88,"item":{"quantity":2,"action":"SELL","lmt_price":1.25,"aux_price":null,"trailing_percent":null}}}]})");
        bw::Runner runner(script, *fx.get(u"base"_s));
        const auto result = runner.run();
        int modifications = 0;
        for (const auto& e : result.get(u"log"_s)->items) {
            if (e.get(u"m"_s)->s != u"placeOrder") continue;
            ++modifications;
            const auto& order = e.get(u"a"_s)->items[1];
            QCOMPARE(order.get(u"orderId"_s)->n, 88.0);
            QCOMPARE(order.get(u"totalQuantity"_s)->n, 2.0);
            QCOMPARE(order.get(u"ocaGroup"_s)->s, u"same-position"_s);
            QCOMPARE(order.get(u"conditions"_s)->items.first().get(u"price"_s)->n, 6000.0);
            QCOMPARE(order.get(u"conditions"_s)->items.first().get(u"triggerMethod"_s)->n, 2.0);
            QVERIFY(!order.get(u"conditionsIgnoreRth"_s)->b);
        }
        QCOMPARE(modifications, 1);
    }
    void named() {
        QStringList failures;
        QVERIFY(runFile(u"broker_router.json"_s, &failures) > 0);
        QVERIFY2(failures.isEmpty(), qPrintable(failures.join(u"\n"_s)));
    }
    void fuzz() {
        QStringList failures;
        int n = 0;
        for (const QString& f : QDir(QStringLiteral(IBKR_FIXTURES_DIR)).entryList({u"broker_fuzz_*.json"_s})) n += runFile(f, &failures);
        QVERIFY2(failures.isEmpty(), qPrintable(failures.join(u"\n"_s)));
        qInfo("fuzz 场景:%d", n);
    }
};

QTEST_GUILESS_MAIN(TstBrokerScenarios)
#include "tst_broker_scenarios.moc"
