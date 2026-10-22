// 交易指令页的接线(shell/trade_controller)对着真的桥与假引擎:
//   · 模型跟着状态 / 大模型目录 / 输入 / 勾选走;占位账号在状态里的账户变了时重问;
//   · 结果里每张票据按内容取一次 ideas.similar_trades(同一张单留在新结果里不重取;换了单旧回包作废);
//   · ⌘⇧↩ 和「发送」按钮同一个口径:发不出去时只说一句,不弹框、不发;
//   · 勾选账户按可用账户的次序存。
#include "shell/bridge.h"
#include "shell/consent.h"
#include "shell/llm_store.h"
#include "shell/status_store.h"
#include "shell/trade_composer.h"
#include "shell/trade_controller.h"
#include "shell_harness.h"

#include <QJsonArray>
#include <QSignalSpy>
#include <QTemporaryDir>

using namespace ibkr;
using namespace ibkr::test;
using namespace Qt::StringLiterals;

namespace {

QJsonObject obj(const char* t) { return QJsonDocument::fromJson(t).object(); }

class Prompter : public shell::Prompter {
public:
    void ask(const shell::ConfirmBox& box, std::function<void(bool)> done) override {
        boxes.append(box);
        done(answer);
    }
    QList<shell::ConfirmBox> boxes;
    bool answer = true;
};

const char* kStatus = R"({"broker_connected":true,"auto_execute":true,"allow_live_trading":false,"broker_provider":"ibkr","breaker":{"engaged":false},
  "accounts":[{"alias":"模拟","is_paper":true,"default":true,"account_masked":"DU***1","connection":"paper"},{"alias":"主账户","is_paper":false,"account_masked":"U***2","connection":"live"}],
  "limits":{"max_order_notional":5000,"max_option_contracts":5}})";

struct Rig {
    QTemporaryDir dir;
    QString resultsPath = dir.filePath(u"results.json"_s);
    shell::EngineClient engine;
    QStringList logs;
    Prompter prompter;
    shell::ConsentStore consent{dir.path()};
    shell::Bridge bridge{&engine, &prompter, &consent};
    shell::StatusStore status{&engine, 60'000};
    shell::LlmStore llm{&bridge, &status};
    shell::TradeComposer composer{&bridge, &status, QString()};
    shell::TradeController controller{&bridge, &status, &llm, &composer};
    QJsonObject results;
    QStringList placeholders;
    int placeholderAsks = 0;

    Rig() : engine(fakeEngine({{u"FAKE_STATUS"_s, QString::fromUtf8(kStatus)}, {u"FAKE_LOG_PARAMS"_s, u"1"_s}, {u"FAKE_RESULTS_FILE"_s, resultsPath}}), 40) {
        QObject::connect(&engine, &shell::EngineClient::logLine, [this](const QString& l) { logs.append(l); });
        QString error;
        if (!consent.accept(QLatin1StringView(shell::kTermsVersion), u"test"_s, 1'000, &error)) qFatal("%s", qPrintable(error));
        set(u"llm.catalog"_s, obj(R"({"providers":[],"current":{"provider":"anthropic","model":"x"},"key_configured":{"anthropic":true}})"));
        set(u"instruction.submit"_s, obj(R"({"submitted":[],"queued":[],"validated_only":[
            {"intent_summary":"买入 1 组 SPX 蝴蝶","account":"模拟","ticket":{"sec_type":"BAG","symbol":"SPX","action":"BUY","quantity":1,"order_type":"LMT","limit_price":1.8,"expiry":"20260821","combo_strategy":"BUTTERFLY",
              "legs":[{"action":"BUY","ratio":1,"strike":7600,"right":"P"},{"action":"SELL","ratio":2,"strike":7615,"right":"P"},{"action":"BUY","ratio":1,"strike":7630,"right":"P"}]}},
            {"intent_summary":"买入 100 股 AAPL","account":"模拟","ticket":{"sec_type":"STK","symbol":"AAPL","action":"BUY","quantity":100,"order_type":"LMT","limit_price":316}}],
            "rejections":[],"warnings":[]})"));
        set(u"ideas.similar_trades"_s, obj(R"({"kind":"combo","symbol":"SPX","basis":["同标的"],"count":2,"win":1,"loss":1,"flat":0,"open":0,"unknown":0,"exits":[],"matches":[],"lessons":[]})"));
        controller.placeholders = [this] {
            ++placeholderAsks;
            return placeholders;
        };
        status.refresh();
        llm.load();
        QTRY_VERIFY(status.status().contains(u"accounts"_s));
        QTRY_VERIFY(llm.catalog().isObject());
    }
    ~Rig() {
        shell::StopOptions o;
        o.drainMs = 0;
        stopSync(engine, o);
    }
    void set(const QString& method, const QJsonObject& result) {
        results.insert(method, result);
        QFile f(resultsPath);
        QVERIFY(f.open(QIODevice::WriteOnly));
        f.write(QJsonDocument(results).toJson());
    }
    QList<QJsonObject> received(const QString& method) const {
        QList<QJsonObject> out;
        for (const QString& l : logs.filter(u"[fake] "_s + method + u' '))
            out << QJsonDocument::fromJson(l.mid(QStringLiteral("[fake] ").size() + method.size() + 1).toUtf8()).object();
        return out;
    }
    QStringList texts() const { return QString::fromUtf8(QJsonDocument(controller.model()).toJson(QJsonDocument::Compact)).split(u'"'); }
};

}  // namespace

class TestTradeController : public QObject {
    Q_OBJECT
private slots:
    void modelFollowsTheStores() {
        Rig rig;
        const QJsonObject m = rig.controller.model();
        QCOMPARE(m[u"limits"].toString(), u"单笔 ≤ 5,000.00 USD · 期权 ≤ 5 张"_s);
        QVERIFY(m[u"readiness"].isNull());  // Key 配了、连着、自动执行开着、没有占位账号
        QCOMPARE(m[u"picked"].toArray(), (QJsonArray{u"模拟"_s}));
        QCOMPARE(m[u"send"][u"label"].toString(), u"发送到IBKR"_s);
        QVERIFY(m[u"send"][u"canExecute"].toBool());
        QCOMPARE(m[u"picker"][u"accounts"].toArray().size(), 2);
        // 占位账号:启动问一次;状态里的账户没变就不再问
        QCOMPARE(rig.placeholderAsks, 1);
        rig.status.refresh();
        QTRY_VERIFY(rig.status.status().contains(u"accounts"_s));
        QTest::qWait(50);
        QCOMPARE(rig.placeholderAsks, 1);
        rig.placeholders = {u"模拟"_s};
        rig.set(u"system.status"_s, obj(R"({"accounts":[{"alias":"模拟","is_paper":true,"default":true}]})"));
        rig.status.refresh();
        QTRY_COMPARE(rig.placeholderAsks, 2);
        QCOMPARE(rig.controller.model()[u"readiness"][u"title"].toString(), u"还差 1 步才能开始"_s);
    }

    void togglePickKeepsUsableOrder() {
        Rig rig;
        rig.controller.togglePick(u"主账户"_s, true);
        QCOMPARE(rig.controller.model()[u"picked"].toArray(), (QJsonArray{u"模拟"_s, u"主账户"_s}));
        QVERIFY(rig.controller.model()[u"liveGate"].isString());
        rig.controller.togglePick(u"模拟"_s, false);
        QCOMPARE(rig.controller.model()[u"picked"].toArray(), (QJsonArray{u"主账户"_s}));
        rig.controller.togglePick(u"主账户"_s, false);
        QCOMPARE(rig.controller.model()[u"picker"][u"hint"].toString(), u"未勾选账户,无法发单"_s);
    }

    // 解析后每张票据取一次历史相似交易;再解析一次同样的单不重取
    void similarTradesFetchedPerTicket() {
        Rig rig;
        rig.composer.setText(u"1.8 挂15蝴蝶 15CM"_s);
        rig.controller.submit(false);
        QTRY_COMPARE(rig.received(u"ideas.similar_trades"_s).size(), 2);
        const QJsonObject q = rig.received(u"ideas.similar_trades"_s).at(0);
        QCOMPARE(q[u"symbol"].toString(), u"SPX"_s);
        QVERIFY(q.contains(u"legs"_s) && q[u"limit_price"].toDouble() == 1.8);
        QTRY_VERIFY(rig.controller.model()[u"result"][u"cards"][0][u"similar"][u"kind"] == u"list"_s);
        QCOMPARE(rig.controller.model()[u"result"][u"cards"][0][u"similar"][u"head"][u"strong"].toString(), u"历史相似 2 笔"_s);
        rig.controller.submit(false);
        QTRY_VERIFY(rig.composer.busy().isEmpty());
        QTest::qWait(100);
        QCOMPARE(rig.received(u"ideas.similar_trades"_s).size(), 2);
        // 清空结果:下一次解析重取
        rig.composer.clearResult();
        rig.controller.submit(false);
        QTRY_COMPARE(rig.received(u"ideas.similar_trades"_s).size(), 4);
    }

    // 快捷键发送:发不出去时只说一句(不弹框、不发);发得出去时同按钮
    void hotkeyObeysTheButtonGate() {
        Rig rig;
        rig.set(u"system.status"_s, obj(R"({"auto_execute":false})"));
        rig.status.refresh();
        QTRY_VERIFY(!rig.controller.model()[u"send"][u"canExecute"].toBool());
        rig.composer.setText(u"买 1 股 AAPL"_s);
        rig.controller.hotkey(true);
        QCOMPARE(rig.status.banner(), u"现在发不出去:自动执行未打开"_s);
        QTest::qWait(100);
        QCOMPARE(rig.prompter.boxes.size(), 0);
        QCOMPARE(rig.received(u"instruction.submit"_s).size(), 0);
        rig.controller.hotkey(false);
        QTRY_COMPARE(rig.received(u"instruction.submit"_s).size(), 1);
        QCOMPARE(rig.received(u"instruction.submit"_s).at(0)[u"execute"].toBool(), false);
    }

    void insertSnippetUpdatesTheText() {
        Rig rig;
        rig.composer.setText(u"abc"_s);
        const QJsonObject r = rig.controller.insertSnippet(3, 3, u",理由:"_s);
        QCOMPARE(rig.composer.text(), u"abc,理由:"_s);
        QCOMPARE(r[u"caret"].toInt(), 7);
        rig.controller.focus();
        QCOMPARE(rig.composer.pane(), u"fly"_s);
    }
};

QTEST_GUILESS_MAIN(TestTradeController)
#include "tst_trade_controller.moc"
