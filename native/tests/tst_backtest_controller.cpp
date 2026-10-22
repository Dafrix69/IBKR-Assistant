// 回测页的接线(shell/backtest_controller,照 pages/Backtest.tsx、lib/RuleBuilder.tsx、lib/SweepPanel.tsx):对着假引擎。
//   · 进页读策略目录,没选过就选第一个;参数照引擎的键序摆(RSI:period、buy_below、sell_above);换策略带出默认参数,自定义不动;
//   · 区间默认近一年,起止是 UTC 的日期(同 toISOString);
//   · 跑一次:标的空着提示、不发;载荷照原版拼;跑着点不动;失败清掉上一次的结果;净值曲线跟着结果换;
//   · 条件搭建器:一句话生成(空的不发,报错前缀不重复);下拉换算子、数字清空去键、运算、删、加;
//   · 扫参数:没填标的不发;载荷;结果 10 行一页,新结果短了页码夹回来;
//   · 切走清空,晚到的回包不落地。
#include "shell/backtest_controller.h"
#include "shell/bridge.h"
#include "shell/chart_source.h"
#include "shell/consent.h"
#include "shell/engine_command.h"
#include "shell/status_store.h"
#include "shell_harness.h"

#include <QJsonArray>
#include <QTemporaryDir>

using namespace ibkr;
using namespace ibkr::test;
using namespace Qt::StringLiterals;

namespace {

QJsonObject obj(const char* t) { return QJsonDocument::fromJson(t).object(); }

// 引擎的目录(键序照 backtest.ts 的 STRATEGIES:RSI 的参数是 period、buy_below、sell_above)
const char* kStrategies = R"J({"strategies":[{"key":"buy_hold","label":"买入持有","desc":"第一天买入,一直持有到区间结束。是所有策略的基准。","params":{},"param_labels":{}},
{"key":"sma_cross","label":"均线交叉","desc":"快线上穿慢线持有,下穿空仓。","params":{"fast":10,"slow":50},"param_labels":{"fast":"快线周期(日)","slow":"慢线周期(日)"}},
{"key":"rsi","label":"RSI 超卖买入","desc":"RSI 跌破买入线建仓,升破卖出线离场。","params":{"period":14,"buy_below":30,"sell_above":70},"param_labels":{"period":"RSI 周期(日)","buy_below":"跌破这个值买入","sell_above":"升破这个值卖出"}},
{"key":"custom","label":"自定义(多条件)","desc":"自己搭条件。","params":{},"param_labels":{}}]})J";
const char* kResult = R"J({"strategy":"sma_cross","params":{"fast":10,"slow":50},"bars":3,"start":"2025-06-02","end":"2025-06-04","symbol":"NVDA","total_return_pct":1.5,"buy_hold_return_pct":1,
  "excess_return_pct":0.5,"annualized_pct":3,"max_drawdown_pct":-2,"volatility_pct":10,"sharpe":1.1,"sortino":1.2,"trades":1,"closed_trades":1,"win_rate_pct":100,"avg_win_pct":1.5,
  "avg_loss_pct":null,"payoff_ratio":null,"profit_factor":null,"expectancy_pct":1.5,"exposure_pct":50,"instrument":{"type":"stock"},
  "trade_list":[{"entry_date":"2025-06-02","exit_date":"2025-06-04","entry_price":100,"exit_price":101.5,"return_pct":1.5}],
  "curve":[{"date":"2025-06-02","equity":1,"bench":1},{"date":"2025-06-03","equity":1.01,"bench":1.005},{"date":"2025-06-04","equity":1.015,"bench":1.01}],"notes":["n"]})J";

QJsonObject sweepWith(int rows) {
    QJsonArray list;
    for (int i = 0; i < rows; ++i)
        list.append(QJsonObject{{u"params"_s, QJsonObject{{u"fast"_s, 5 + i}, {u"slow"_s, 50}}}, {u"is"_s, QJsonObject{{u"return_pct"_s, 1}}},
                                {u"oos"_s, QJsonObject{{u"return_pct"_s, 2}, {u"bench_return_pct"_s, 3}, {u"excess_return_pct"_s, -1}, {u"max_drawdown_pct"_s, -4}}}, {u"oos_rank"_s, i + 1}});
    return {{u"symbols"_s, QJsonArray{u"NVDA"_s}}, {u"start"_s, u"2025-06-02"_s}, {u"end"_s, u"2026-08-21"_s}, {u"split_date"_s, u"2026-04-10"_s}, {u"combos"_s, rows},
            {u"skipped"_s, QJsonArray{}}, {u"rows"_s, list}, {u"best"_s, list.isEmpty() ? QJsonValue() : list.first()}, {u"notes"_s, QJsonArray{}}};
}

struct Rig {
    QTemporaryDir dir;
    QString resultsPath = dir.filePath(u"results.json"_s);
    shell::EngineClient engine;
    QStringList logs;
    struct Yes : shell::Prompter {
        void ask(const shell::ConfirmBox&, std::function<void(bool)> d) override { d(true); }
    } yes;
    shell::ConsentStore consent{dir.path()};
    shell::Bridge bridge{&engine, &yes, &consent};
    shell::StatusStore status{&engine, 60'000};
    QJsonObject results;

    explicit Rig(const QString& delays = {})
        : engine(fakeEngine({{u"FAKE_LOG_PARAMS"_s, u"1"_s}, {u"FAKE_RESULTS_FILE"_s, resultsPath}, {u"FAKE_DELAY_METHODS"_s, delays}}), 40) {
        QObject::connect(&engine, &shell::EngineClient::logLine, [this](const QString& l) { logs.append(l); });
        // 原文照发:键序不经 QJsonObject
        set(u"backtest.strategies"_s, QJsonObject{{u"__raw"_s, QString::fromUtf8(kStrategies)}});
        set(u"backtest.run"_s, obj(kResult));
        set(u"backtest.sweep"_s, sweepWith(23));
    }
    ~Rig() {
        shell::StopOptions o;
        o.drainMs = 0;
        stopSync(engine, o);
    }
    void set(const QString& method, const QJsonValue& result) {
        results.insert(method, result);
        QFile f(resultsPath);
        QVERIFY(f.open(QIODevice::WriteOnly));
        f.write(QJsonDocument(results).toJson());
    }
    int calls(const QString& method) const { return int(logs.filter(u"[fake] "_s + method + u' ').size()); }
    QStringList params(const QString& method) const {
        QStringList out;
        for (const QString& l : logs)
            if (l.startsWith(u"[fake] "_s + method + u' ')) out << l.mid(8 + method.size());
        return out;
    }
};

QStringList paramKeys(const QJsonObject& page) {
    QStringList out;
    for (const QJsonValue& p : page[u"params"_s].toArray()) out << p[u"key"_s].toString();
    return out;
}

// 2026-09-08 00:30 北京时间 = 2026-09-07 16:30 UTC:起止按 UTC 的日期
constexpr double kNow = 1788798600000.0;

}  // namespace

class TestBacktestController : public QObject {
    Q_OBJECT
private slots:
    void strategiesAndDefaults() {
        Rig rig;
        shell::BacktestController page(&rig.bridge, &rig.status);
        page.now = [] { return kNow; };
        page.setVisible(true);
        QCOMPARE(page.page()[u"start"_s].toString(), u"2025-09-07"_s);
        QCOMPARE(page.page()[u"end"_s].toString(), u"2026-09-07"_s);
        QTRY_COMPARE(page.page()[u"strategy"_s].toString(), u"buy_hold"_s);
        QCOMPARE(page.page()[u"strategyOptions"_s].toArray().size(), 4);
        page.setStrategy(u"rsi"_s);
        // 键序照引擎:不是字母序
        QCOMPARE(paramKeys(page.page()), (QStringList{u"period"_s, u"buy_below"_s, u"sell_above"_s}));
        QCOMPARE(page.page()[u"params"_s][1][u"value"_s].toDouble(), 30.0);
        QCOMPARE(page.page()[u"sweep"_s][u"gridRows"_s][0][u"key"_s].toString(), u"period"_s);
        page.setParam(u"buy_below"_s, QVariant());
        QVERIFY(page.page()[u"params"_s][1][u"value"_s].isNull());
        // 自定义:参数不动、搭建器出来
        page.setStrategy(u"custom"_s);
        QVERIFY(page.page()[u"builder"_s].isObject());
        QCOMPARE(page.page()[u"flow"_s][u"entry"_s].toString(), u"RSI(14) < 30"_s);
        page.setStrategy(u"sma_cross"_s);
        QCOMPARE(paramKeys(page.page()), (QStringList{u"fast"_s, u"slow"_s}));
    }

    // 换到自定义时参数不动:原版跑一次照样把上一个策略留下的参数带上(引擎按自定义不看它们)
    void customKeepsPreviousParams() {
        Rig rig;
        shell::BacktestController page(&rig.bridge, &rig.status);
        page.setVisible(true);
        QTRY_COMPARE(page.page()[u"strategy"_s].toString(), u"buy_hold"_s);
        page.setStrategy(u"sma_cross"_s);
        page.setStrategy(u"custom"_s);
        page.setSymbol(u"NVDA"_s);
        page.run();
        QTRY_COMPARE(rig.calls(u"backtest.run"_s), 1);
        QVERIFY2(rig.params(u"backtest.run"_s).first().contains(u"\"params\":{\"fast\":10,\"slow\":50}"_s), qPrintable(rig.params(u"backtest.run"_s).first()));
    }

    void runValidatesSendsAndFails() {
        Rig rig(u"backtest.run=120"_s);
        shell::BacktestController page(&rig.bridge, &rig.status);
        page.now = [] { return kNow; };
        page.setVisible(true);
        QTRY_COMPARE(page.page()[u"strategy"_s].toString(), u"buy_hold"_s);
        page.setStrategy(u"rsi"_s);
        page.setSymbol(u"   "_s);
        page.run();
        QCOMPARE(rig.status.banner(), u"请填写标的与起止日期"_s);
        QTest::qWait(60);
        QCOMPARE(rig.calls(u"backtest.run"_s), 0);
        page.setSymbol(u" nvda "_s);
        page.setParam(u"sell_above"_s, QVariant());
        page.setCost(0.1);
        page.setInstType(u"call"_s);
        page.setInst(u"dte"_s, QVariant());
        page.run();
        page.run();  // 跑着点不动
        QVERIFY(page.page()[u"running"_s].toBool());
        QTRY_VERIFY(!page.page()[u"running"_s].toBool());
        QCOMPARE(rig.calls(u"backtest.run"_s), 1);
        QCOMPARE(rig.params(u"backtest.run"_s).first(),
                 u"{\"cost_pct\":0.1,\"end\":\"2026-09-07\",\"instrument\":{\"dte\":30,\"offset_pct\":0,\"risk_pct\":10,\"type\":\"call\",\"width_pct\":2},"
                 "\"params\":{\"buy_below\":30,\"period\":14},\"start\":\"2025-09-07\",\"strategy\":\"rsi\",\"symbol\":\"NVDA\"}"_s);
        QVERIFY(page.page()[u"result"_s].isObject());
        QCOMPARE(qobject_cast<shell::ChartSource*>(page.chart())->spec().lines.size(), 2);
        // 失败:上一次的结果清掉,图也清掉
        rig.set(u"backtest.run"_s, QJsonObject{{u"__error"_s, u"拉不到日线"_s}});
        page.run();
        QTRY_COMPARE(page.page()[u"failure"_s].toString(), u"拉不到日线"_s);
        QVERIFY(page.page()[u"result"_s].isNull());
        QCOMPARE(qobject_cast<shell::ChartSource*>(page.chart())->spec().lines.size(), 0);
        // 再跑一次:失败那一句先清掉
        rig.set(u"backtest.run"_s, obj(kResult));
        page.run();
        QVERIFY(page.page()[u"failure"_s].toString().isEmpty());
        QTRY_VERIFY(page.page()[u"result"_s].isObject());
    }

    void ruleBuilder() {
        Rig rig;
        rig.set(u"backtest.parse_rules"_s, obj(R"({"rules":{"entry":[{"left":{"kind":"indicator","name":"close","period":null},"op":"cross_up","right":{"kind":"indicator","name":"sma","period":200}}],"exit":[]}})"));
        shell::BacktestController page(&rig.bridge, &rig.status);
        page.setVisible(true);
        QTRY_COMPARE(page.page()[u"strategy"_s].toString(), u"buy_hold"_s);
        page.setStrategy(u"custom"_s);
        page.setRuleText(u"   "_s);
        page.generateRules();
        QTest::qWait(60);
        QCOMPARE(rig.calls(u"backtest.parse_rules"_s), 0);
        page.setRuleText(u" 站上 200 日均线买入 "_s);
        page.generateRules();
        QCOMPARE(page.page()[u"builder"_s][u"button"_s].toString(), u"生成中…"_s);
        QTRY_COMPARE(page.page()[u"flow"_s][u"entry"_s].toString(), u"收盘价 上穿 SMA均线(200)"_s);
        QCOMPARE(rig.params(u"backtest.parse_rules"_s).first(), u"{\"text\":\"站上 200 日均线买入\"}"_s);
        QVERIFY(page.page()[u"flow"_s][u"exit"_s].isNull());
        // 报错:已经带着前缀的不再加
        rig.set(u"backtest.parse_rules"_s, QJsonObject{{u"__error"_s, u"条件生成失败:模型没回"_s}});
        page.generateRules();
        QTRY_COMPARE(rig.status.banner(), u"条件生成失败:模型没回"_s);
        rig.set(u"backtest.parse_rules"_s, QJsonObject{{u"__error"_s, u"没配大模型"_s}});
        page.generateRules();
        QTRY_COMPARE(rig.status.banner(), u"条件生成失败:没配大模型"_s);
        // 手搭:加一条、换算子、清空数字、换运算、删
        page.addCondition(u"exit"_s);
        QCOMPARE(page.page()[u"flow"_s][u"exit"_s].toString(), u"收盘价 > SMA均线(50)"_s);
        page.pickOperand(u"exit"_s, 0, u"right"_s, u"const"_s);
        QCOMPARE(page.page()[u"flow"_s][u"exit"_s].toString(), u"收盘价 > undefined"_s);  // 原版就这么写
        page.setOperandNumber(u"exit"_s, 0, u"right"_s, 120.5);
        page.setOp(u"exit"_s, 0, u"<="_s);
        QCOMPARE(page.page()[u"flow"_s][u"exit"_s].toString(), u"收盘价 ≤ 120.5"_s);
        page.pickOperand(u"exit"_s, 0, u"left"_s, u"rsi"_s);
        QCOMPARE(page.page()[u"flow"_s][u"exit"_s].toString(), u"RSI(20) ≤ 120.5"_s);
        page.setOperandNumber(u"exit"_s, 0, u"left"_s, QVariant());
        QCOMPARE(page.page()[u"flow"_s][u"exit"_s].toString(), u"RSI ≤ 120.5"_s);
        // 跑一次带上条件:清空了的周期那个键不出现(原版是 undefined)
        page.setSymbol(u"NVDA"_s);
        page.run();
        QTRY_COMPARE(rig.calls(u"backtest.run"_s), 1);
        const QString sent = rig.params(u"backtest.run"_s).first();
        QVERIFY2(sent.contains(u"\"rules\":{\"entry\":[{\"left\":{\"kind\":\"indicator\",\"name\":\"close\",\"period\":null}"_s), qPrintable(sent));
        QVERIFY2(sent.contains(u"\"exit\":[{\"left\":{\"kind\":\"indicator\",\"name\":\"rsi\"},\"op\":\"<=\",\"right\":{\"kind\":\"const\",\"value\":120.5}}]"_s), qPrintable(sent));
        QTRY_VERIFY(!page.page()[u"running"_s].toBool());
        page.removeCondition(u"exit"_s, 0);
        QVERIFY(page.page()[u"flow"_s][u"exit"_s].isNull());
    }

    void sweep() {
        Rig rig(u"backtest.sweep=80"_s);
        shell::BacktestController page(&rig.bridge, &rig.status);
        page.now = [] { return kNow; };
        page.setVisible(true);
        QTRY_COMPARE(page.page()[u"strategy"_s].toString(), u"buy_hold"_s);
        QVERIFY(!page.page()[u"sweep"_s][u"sweepable"_s].toBool());
        page.setStrategy(u"sma_cross"_s);
        page.runSweep();  // 没填标的:不发
        QTest::qWait(60);
        QCOMPARE(rig.calls(u"backtest.sweep"_s), 0);
        page.setSymbol(u"nvda"_s);
        page.setSweepExtra(u"msft"_s);
        page.setSweepGrid(u"slow"_s, u"40 60"_s);
        page.setSweepFolds(QVariant());
        page.setSweepObjective(u"calmar"_s);
        page.runSweep();
        page.runSweep();
        QVERIFY(page.page()[u"sweep"_s][u"running"_s].toBool());
        QTRY_VERIFY(page.page()[u"sweep"_s][u"result"_s].isObject());
        QCOMPARE(rig.calls(u"backtest.sweep"_s), 1);
        QCOMPARE(rig.params(u"backtest.sweep"_s).first(),
                 u"{\"end\":\"2026-09-07\",\"folds\":0,\"grid\":{\"fast\":[5,10,15],\"slow\":[40,60]},\"instrument\":{\"type\":\"stock\"},\"objective\":\"calmar\","
                 "\"split_pct\":70,\"start\":\"2025-09-07\",\"strategy\":\"sma_cross\",\"symbols\":[\"NVDA\",\"MSFT\"]}"_s);
        // 翻页;新结果短了,页码夹回来
        page.setSweepPage(3);
        QCOMPARE(page.page()[u"sweep"_s][u"result"_s][u"page"_s].toInt(), 3);
        QCOMPARE(page.page()[u"sweep"_s][u"result"_s][u"rows"_s].toArray().size(), 3);
        rig.set(u"backtest.sweep"_s, sweepWith(12));
        page.runSweep();
        QTRY_VERIFY(!page.page()[u"sweep"_s][u"running"_s].toBool());
        QCOMPARE(page.page()[u"sweep"_s][u"result"_s][u"page"_s].toInt(), 2);
        // 记着的还是第 3 页:再来一份长的,回到第 3 页
        rig.set(u"backtest.sweep"_s, sweepWith(23));
        page.runSweep();
        QTRY_VERIFY(!page.page()[u"sweep"_s][u"running"_s].toBool());
        QCOMPARE(page.page()[u"sweep"_s][u"result"_s][u"page"_s].toInt(), 3);
        rig.set(u"backtest.sweep"_s, QJsonObject{{u"__error"_s, u"标的太多"_s}});
        page.runSweep();
        QTRY_COMPARE(page.page()[u"sweep"_s][u"failure"_s].toString(), u"标的太多"_s);
        QVERIFY(!page.page()[u"sweep"_s][u"result"_s].isObject());
    }

    void hideResetsAndDropsLateReplies() {
        Rig rig(u"backtest.run=200,backtest.sweep=200,backtest.parse_rules=200"_s);
        rig.set(u"backtest.parse_rules"_s, obj(R"({"rules":{"entry":[{"left":{"kind":"indicator","name":"close","period":null},"op":">","right":{"kind":"const","value":1}}],"exit":[]}})"));
        shell::BacktestController page(&rig.bridge, &rig.status);
        page.setVisible(true);
        QTRY_COMPARE(page.page()[u"strategy"_s].toString(), u"buy_hold"_s);
        page.setStrategy(u"custom"_s);
        page.setRuleText(u"收盘价大于 1"_s);
        page.generateRules();
        page.setStrategy(u"sma_cross"_s);
        page.setSymbol(u"NVDA"_s);
        page.run();
        page.runSweep();
        QTRY_COMPARE(rig.calls(u"backtest.sweep"_s), 1);
        QTRY_COMPARE(rig.calls(u"backtest.parse_rules"_s), 1);
        page.setVisible(false);
        QVERIFY(page.page()[u"symbol"_s].toString().isEmpty());
        page.setVisible(true);
        QTRY_COMPARE(rig.calls(u"backtest.strategies"_s), 2);
        QTest::qWait(350);
        QVERIFY(page.page()[u"result"_s].isNull());
        QVERIFY(!page.page()[u"running"_s].toBool());
        QCOMPARE(page.page()[u"strategy"_s].toString(), u"buy_hold"_s);
        // 换到能扫的策略看:切走前那一次扫的结果没落地;一句话生成的条件也没顶上默认的那组
        page.setStrategy(u"sma_cross"_s);
        QVERIFY(!page.page()[u"sweep"_s].toObject().contains(u"result"_s));
        QVERIFY(!page.page()[u"sweep"_s][u"running"_s].toBool());
        page.setStrategy(u"custom"_s);
        QCOMPARE(page.page()[u"flow"_s][u"entry"_s].toString(), u"RSI(14) < 30"_s);
        QCOMPARE(page.page()[u"builder"_s][u"button"_s].toString(), u"AI 生成条件"_s);
    }
};

QTEST_GUILESS_MAIN(TestBacktestController)
#include "tst_backtest_controller.moc"
