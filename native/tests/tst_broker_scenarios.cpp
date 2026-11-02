// BrokerRouter(broker.ts)对着原模块现跑的答案:脚本驱动的假会话,会话上每一次调用的日志、各步结果、基差文件的最终内容逐项精确比较。
// 夹具:fixtures/broker_router.json(命名场景,gen_broker_router.mjs)与 broker_fuzz_*.json(种子固定的随机脚本,gen_broker_fuzz.mjs)。
#include "broker_runner.h"

#include <QDir>
#include <QSet>
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

    // 休市只有昨收:券商标记价只进 mark_price,market_price 必须还是 null(追踪拿它判止损);有现价的行不写标记价
    void marksStayOutOfMarketPrice() {
        using namespace ibkr;
        const auto fx = jsfix::load(u"broker_router.json"_s);
        const auto script = *util::parseOJson(R"({"start":1791815400000,"factory":{"paper":["P"]},"sessions":[{
            "name":"P","connected":true,"accounts":["DU7654321"],"caps":[],
            "initial":{"OPT|SPX|20261102|7650|C|SPXW":{"close":83.6},"OPT|SPX|20261102|7655|C|SPXW":{"bid":7.4,"ask":7.8,"close":79.5}},
            "portfolio":[{"items":[]}],
            "positions":[{"items":[
              {"contract":{"symbol":"SPX","secType":"OPT","lastTradeDateOrContractMonth":"20261102","strike":7650,"right":"C","multiplier":"100","tradingClass":"SPXW"},"position":1,"avgCost":586.63,"account":"DU7654321"},
              {"contract":{"symbol":"SPX","secType":"OPT","lastTradeDateOrContractMonth":"20261102","strike":7655,"right":"C","multiplier":"100","tradingClass":"SPXW"},"position":-1,"avgCost":518.37,"account":"DU7654321"}]}],
            "marks":[
              {"contract":{"symbol":"SPX","secType":"OPT","lastTradeDateOrContractMonth":"20261102","strike":7650,"right":"C","multiplier":100,"tradingClass":"SPXW"},"position":1,"marketPrice":8.58,"account":"DU7654321"},
              {"contract":{"symbol":"SPX","secType":"OPT","lastTradeDateOrContractMonth":"20261102","strike":7655,"right":"C","multiplier":100,"tradingClass":"SPXW"},"position":-1,"marketPrice":7.59,"account":"DU7654321"}]
            }],"steps":[{"op":"call","m":"connect","a":{"name":"paper"}},{"op":"call","m":"positions"}]})");
        bw::Runner runner(script, *fx.get(u"base"_s));
        const auto result = runner.run();
        const QString text = util::js::stringify(result);
        QVERIFY2(text.contains(u"\"mark_price\":8.58"_s), qPrintable(text.right(1500)));
        QVERIFY2(!text.contains(u"\"market_price\":8.58"_s), qPrintable(text.right(1500)));
        QVERIFY2(text.contains(u"\"market_price\":7.6"_s), qPrintable(text.right(1500)));  // 有盘口的腿用中间价
        QVERIFY2(!text.contains(u"\"mark_price\":7.59"_s), qPrintable(text.right(1500)));
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
    // 四腿铁蝶(IRON_CONDOR、内侧同价)的组合单构造:四条腿各自认领 conId、方向按腿、比例 1;BAG 以 BUY 提交、净价为负(贷方)、LMT。
    // 只到假会话的 placeOrder 为止——IBKR 对 4 腿组合接哪些订单类型没在真机上试过,待用户 whatIf 核对
    void ironFlyComboOrder() {
        using namespace ibkr;
        namespace js = util::js;
        const auto fx = jsfix::load(u"broker_router.json"_s);
        auto script = *util::parseOJson(R"({"start":1791815400000,"factory":{"paper":["P"]},
            "sessions":[{"name":"P","connected":true,"accounts":["DU7654321"],"caps":["ContractHours","SetBaselineMarketDataType","OpenTradesDetailed","Executions","OnLink","OnError","QuoteDelayed"]}],"steps":[]})");
        const auto approved = *util::parseOJson(R"({"order":{"intent_summary":"卖出(贷方)2 张 7625/7650/7675 铁蝶","contract":{"secType":"BAG","symbol":"SPX","exchange":"SMART","currency":"USD",
            "lastTradeDateOrContractMonth":null,"strike":null,"right":null,"multiplier":"100","tradingClass":null,"combo_strategy":"IRON_CONDOR","legs":[
            {"action":"BUY","ratio":1,"lastTradeDateOrContractMonth":"20261016","strike":7625,"right":"P","tradingClass":"SPXW","multiplier":"100"},
            {"action":"SELL","ratio":1,"lastTradeDateOrContractMonth":"20261016","strike":7650,"right":"P","tradingClass":"SPXW","multiplier":"100"},
            {"action":"SELL","ratio":1,"lastTradeDateOrContractMonth":"20261016","strike":7650,"right":"C","tradingClass":"SPXW","multiplier":"100"},
            {"action":"BUY","ratio":1,"lastTradeDateOrContractMonth":"20261016","strike":7675,"right":"C","tradingClass":"SPXW","multiplier":"100"}]},
            "order":{"action":"SELL","orderType":"LMT","totalQuantity":2,"price_mode":"EXPLICIT","lmtPrice":19.5,"auxPrice":null,"trailingPercent":null,"tif":"DAY","outsideRth":false},
            "trigger":null},"account":"模拟","notional":1100,"signature":"sig","warnings":[]})");
        const auto call = [](const QString& m, const OJson& a) { return js::object({{u"op"_s, js::S(u"call"_s)}, {u"m"_s, js::S(m)}, {u"a"_s, a}}); };
        script.set(u"steps"_s, js::array({call(u"connect"_s, js::object({{u"name"_s, js::S(u"paper"_s)}})),
                                          call(u"place"_s, js::object({{u"recordId"_s, js::S(u"if1"_s)}, {u"approved"_s, approved}}))}));
        bw::Runner runner(script, *fx.get(u"base"_s));
        const auto result = runner.run();
        int placed = 0;
        for (const auto& e : result.get(u"log"_s)->items) {
            if (e.get(u"m"_s)->s != u"placeOrder") continue;
            ++placed;
            const OJson& contract = e.get(u"a"_s)->items[0];
            const OJson& order = e.get(u"a"_s)->items[1];
            QCOMPARE(contract.get(u"secType"_s)->s, u"BAG"_s);
            const QList<OJson>& legs = contract.get(u"comboLegs"_s)->items;
            QCOMPARE(legs.size(), qsizetype(4));
            QStringList actions;
            QSet<int> conIds;
            for (const OJson& l : legs) {
                actions << l.get(u"action"_s)->s;
                QCOMPARE(l.get(u"ratio"_s)->n, 1.0);
                QCOMPARE(l.get(u"exchange"_s)->s, u"SMART"_s);
                conIds.insert(int(l.get(u"conId"_s)->n));
            }
            QCOMPARE(actions, (QStringList{u"BUY"_s, u"SELL"_s, u"SELL"_s, u"BUY"_s}));
            QCOMPARE(conIds.size(), 4);  // 同一行权价上的 put 与 call 是两张不同的合约
            QCOMPARE(order.get(u"action"_s)->s, u"BUY"_s);
            QCOMPARE(order.get(u"orderType"_s)->s, u"LMT"_s);
            QCOMPARE(order.get(u"lmtPrice"_s)->n, -19.5);
            QCOMPARE(order.get(u"totalQuantity"_s)->n, 2.0);
            QCOMPARE(order.get(u"orderRef"_s)->s, u"if1"_s);
        }
        QCOMPARE(placed, 1);
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
