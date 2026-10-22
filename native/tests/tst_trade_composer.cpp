// 交易指令页的提交(shell/trade_composer),两层:
//   · 对着原 store/trade.ts 真跑出来的步骤逐步比(tests/fixtures/gen_trade_page.mjs 的 actions):确认框上写什么、调了什么、
//     每一步之后 store 里的输入框 / 结果是什么样(含 __elapsedMs 的取整);
//   · 端到端:真的 Bridge(白名单、条款同意、确认框凭据)对着假引擎。发送 = 先确认框、点了确认才发 instruction.submit,
//     引擎收到的就是 { text, execute, accounts }(没有 __confirmed、没有多的键);点取消一个请求都不发;只解析不弹框;
//     确认框上写着发到哪些账户、各是纸面还是实盘(问引擎,不听页面的)。
#include "shell/bridge.h"
#include "shell/consent.h"
#include "shell/status_store.h"
#include "shell/trade_composer.h"
#include "shell_harness.h"

#include <QJsonArray>
#include <QSettings>
#include <QSignalSpy>
#include <QTemporaryDir>

using namespace ibkr;
using namespace ibkr::test;
using namespace Qt::StringLiterals;

namespace {

QJsonObject fixture() {
    static const QJsonObject j = [] {
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/trade-page.json"));
        if (!f.open(QIODevice::ReadOnly)) qFatal("trade-page.json 打不开");
        return QJsonDocument::fromJson(f.readAll()).object();
    }();
    return j;
}

QStringList strings(const QJsonValue& v) {
    QStringList out;
    for (const QJsonValue& x : v.toArray()) out << x.toString();
    return out;
}

/// 记录调用的假依赖:名字与入参照生成器的流水写
struct Fake {
    QJsonArray calls;
    QList<bool> confirms;
    QJsonValue result;
    QList<double> clock;
    /// 不为空时提交先挂着,由测试放行
    std::function<void()> release;
    bool hold = false;

    shell::trade::ComposerDeps deps() {
        shell::trade::ComposerDeps d;
        d.confirm = [this](const QJsonObject& options, std::function<void(bool)> done) {
            calls.append(QJsonObject{{u"call"_s, u"confirm"_s}, {u"args"_s, QJsonArray{options}}});
            done(confirms.isEmpty() ? false : confirms.takeFirst());
        };
        d.submit = [this](const QString& text, bool execute, const QStringList& accounts, shell::trade::ComposerDeps::Reply done) {
            calls.append(QJsonObject{{u"call"_s, u"submit"_s}, {u"args"_s, QJsonArray{text, execute, QJsonArray::fromStringList(accounts)}}});
            const auto answer = [this, done] {
                shell::EngineReply r;
                if (result.isString() && result.toString().startsWith(u"throw:"_s)) {
                    r.error = result.toString().mid(6);
                } else {
                    r.ok = true;
                    r.result = result;
                }
                done(r);
            };
            if (hold) release = answer;
            else answer();
        };
        d.reload = [this](std::function<void()> done) {
            // React 版:Promise.all([refreshStatus(), loadRecords(), loadPending()])
            calls.append(QJsonObject{{u"call"_s, u"status"_s}, {u"args"_s, QJsonArray{}}});
            calls.append(QJsonObject{{u"call"_s, u"listRecords"_s}, {u"args"_s, QJsonArray{60}}});
            calls.append(QJsonObject{{u"call"_s, u"listPending"_s}, {u"args"_s, QJsonArray{}}});
            done();
        };
        d.banner = [this](const QString& text, bool info) { calls.append(QJsonObject{{u"call"_s, u"banner"_s}, {u"message"_s, text}, {u"info"_s, info}}); };
        d.brokerShortName = [] { return u"IBKR"_s; };
        d.nowMs = [this] { return clock.isEmpty() ? 0.0 : clock.takeFirst(); };
        return d;
    }
};

class Prompter : public shell::Prompter {
public:
    void ask(const shell::ConfirmBox& box, std::function<void(bool)> done) override {
        boxes.append(box);
        done(answer);
    }
    QList<shell::ConfirmBox> boxes;
    bool answer = true;
};

struct Rig {
    QTemporaryDir dir;
    QString resultsPath = dir.filePath(u"results.json"_s);
    shell::EngineClient engine;
    QStringList logs;
    Prompter prompter;
    shell::ConsentStore consent{dir.path()};
    shell::Bridge bridge{&engine, &prompter, &consent};
    shell::StatusStore status{&engine, 60'000};
    std::unique_ptr<shell::TradeComposer> composer;

    Rig()
        : engine(fakeEngine({{u"FAKE_STATUS"_s,
                              uR"({"broker_connected":true,"auto_execute":true,"broker_provider":"ibkr","accounts":[{"alias":"模拟","is_paper":true},{"alias":"主账户","is_paper":false}]})"_s},
                             {u"FAKE_LOG_PARAMS"_s, u"1"_s}, {u"FAKE_RESULTS_FILE"_s, resultsPath}}),
                 40) {
        QObject::connect(&engine, &shell::EngineClient::logLine, [this](const QString& l) { logs.append(l); });
        QString error;
        if (!consent.accept(QLatin1StringView(shell::kTermsVersion), u"test"_s, 1'000, &error)) qFatal("%s", qPrintable(error));
        QFile f(resultsPath);
        if (!f.open(QIODevice::WriteOnly)) qFatal("写不了 results.json");
        f.write(R"({"instruction.submit":{"submitted":[],"queued":[],"validated_only":[],"rejections":[],"warnings":[]}})");
        f.close();
        composer = std::make_unique<shell::TradeComposer>(&bridge, &status, QString());
        status.refresh();
        QTRY_VERIFY(status.status().contains(u"broker_connected"_s));
    }
    ~Rig() {
        composer.reset();
        shell::StopOptions o;
        o.drainMs = 0;
        stopSync(engine, o);
    }
    QList<QJsonObject> received(const QString& method) const {
        QList<QJsonObject> out;
        for (const QString& l : logs.filter(u"[fake] "_s + method + u' '))
            out << QJsonDocument::fromJson(l.mid(QStringLiteral("[fake] ").size() + method.size() + 1).toUtf8()).object();
        return out;
    }
};

}  // namespace

class TestTradeComposer : public QObject {
    Q_OBJECT
private slots:
    void matchesTsStore_data() {
        QTest::addColumn<QJsonObject>("c");
        const QJsonArray actions = fixture()[u"actions"].toArray();
        QVERIFY(actions.size() >= 10);
        for (const QJsonValue& c : actions)
            if (c[u"states"].isArray()) QTest::newRow(qPrintable(c[u"name"].toString())) << c.toObject();
    }
    void matchesTsStore() {
        QFETCH(QJsonObject, c);
        Fake fake;
        for (const QJsonValue& v : c[u"confirms"].toArray()) fake.confirms << v.toBool();
        fake.result = c[u"result"];
        shell::TradeComposer composer(fake.deps(), QString());
        composer.setDraft(QString());
        composer.setText(c[u"text"].toString());
        composer.setPane(c[u"pane"].toString());
        composer.clearResult();
        QCOMPARE(composer.snapshot(), c[u"before"].toObject());
        // 生成器里 performance.now 的两次读数
        for (const QJsonValue& t : c[u"ticks"].toArray()) fake.clock << t.toDouble();
        QJsonArray states;
        QObject::connect(&composer, &shell::TradeComposer::changed, [&] { states.append(composer.snapshot()); });
        composer.submit(c[u"execute"].toBool(), strings(c[u"accounts"]));
        QCOMPARE(fake.calls, c[u"calls"].toArray());
        QCOMPARE(states, c[u"states"].toArray());
        QCOMPARE(composer.snapshot(), c[u"after"].toObject());
        // 引擎的 schema(.strict())对原版发出去的那一份说的话:这里发的和它逐字一样
        if (c[u"params"].isObject()) QCOMPARE(c[u"schema"].toString(), u"ok"_s);
    }

    // 正在解析时又按了发送:第二下什么都不做(不弹框、不发)
    void secondPressWhileBusy() {
        QJsonObject c;
        for (const QJsonValue& a : fixture()[u"actions"].toArray())
            if (a[u"name"] == u"正在解析时又按了发送"_s) c = a.toObject();
        QVERIFY(!c.isEmpty());
        Fake fake;
        fake.hold = true;
        fake.result = fixture()[u"actions"].toArray().at(0)[u"result"];
        fake.clock = {0, 7};
        shell::TradeComposer composer(fake.deps(), QString());
        composer.setDraft(c[u"text"].toString());
        composer.submit(false, {u"模拟"_s});
        QCOMPARE(composer.snapshot(), c[u"during"].toObject());
        composer.submit(true, {u"模拟"_s});
        QCOMPARE(fake.calls.size(), c[u"callsDuring"].toInt());
        fake.release();
        QJsonArray sent;
        for (const QJsonValue& x : fake.calls)
            if (x[u"call"] == u"confirm"_s || x[u"call"] == u"submit"_s) sent.append(x);
        QCOMPARE(sent, c[u"calls"].toArray());
        QCOMPARE(composer.snapshot(), c[u"after"].toObject());
    }

    void appendAndDraft() {
        Fake fake;
        shell::TradeComposer composer(fake.deps(), QString());
        for (const QJsonValue& a : fixture()[u"appends"].toArray()) {
            composer.setDraft(a[u"text"].toString());
            composer.appendInstruction(a[u"line"].toString());
            QCOMPARE(composer.text(), a[u"result"].toString());
        }
    }

    // 勾选记在 qt-settings.ini 的 trade/accounts:只在启动时读一次,存坏了当没存过
    void pickedPersists() {
        QTemporaryDir dir;
        const QString ini = dir.filePath(u"qt-settings.ini"_s);
        Fake fake;
        const QJsonArray usable{QJsonObject{{u"alias"_s, u"模拟"_s}, {u"default"_s, true}}, QJsonObject{{u"alias"_s, u"主账户"_s}}};
        {
            shell::TradeComposer a(fake.deps(), ini);
            QCOMPARE(a.savedPicked(), std::nullopt);
            QCOMPARE(a.selectedAccounts(usable), QStringList{u"模拟"_s});
            QSignalSpy spy(&a, &shell::TradeComposer::pickedChanged);
            a.savePicked({u"主账户"_s});
            QCOMPARE(spy.size(), 1);
            QCOMPARE(a.selectedAccounts(usable), QStringList{u"主账户"_s});
        }
        shell::TradeComposer b(fake.deps(), ini);
        QCOMPARE(b.selectedAccounts(usable), QStringList{u"主账户"_s});
        QSettings(ini, QSettings::IniFormat).setValue(u"trade/accounts"_s, u"not json"_s);
        shell::TradeComposer c(fake.deps(), ini);
        QCOMPARE(c.savedPicked(), std::nullopt);
    }

    // ---- 端到端:真的桥 ----
    void executeGoesThroughTheGrant() {
        Rig rig;
        rig.composer->setText(u"  买 1 股 AAPL 限价 200 "_s);
        rig.composer->submit(true, {u"模拟"_s, u"主账户"_s});
        QTRY_COMPARE(rig.received(u"instruction.submit"_s).size(), 1);
        QCOMPARE(rig.received(u"instruction.submit"_s).at(0),
                 (QJsonObject{{u"text"_s, u"买 1 股 AAPL 限价 200"_s}, {u"execute"_s, true}, {u"accounts"_s, QJsonArray{u"模拟"_s, u"主账户"_s}}}));
        QCOMPARE(rig.prompter.boxes.size(), 1);
        const shell::ConfirmBox& box = rig.prompter.boxes.at(0);
        QCOMPARE(box.title, u"发送真实订单"_s);
        QCOMPARE(box.message, u"发送真实订单(含实盘账户)"_s);
        QCOMPARE(box.confirmLabel, u"我确认,发送"_s);
        QVERIFY2(box.detail.contains(u"账户:模拟(纸面)、主账户(实盘)"_s), qPrintable(box.detail));
        QVERIFY2(box.detail.contains(u"指令:买 1 股 AAPL 限价 200"_s), qPrintable(box.detail));
        QVERIFY2(box.detail.contains(u"这条指令解析后会直接发送到IBKR,没有二次确认环节。"_s), qPrintable(box.detail));
        QTRY_VERIFY(rig.composer->busy().isEmpty());
        QVERIFY(rig.composer->payload().isObject());
        QVERIFY(rig.composer->payload()[u"__elapsedMs"].isDouble());
    }

    void cancelSendsNothing() {
        Rig rig;
        rig.prompter.answer = false;
        rig.composer->setText(u"买 1 股 AAPL"_s);
        rig.composer->submit(true, {u"模拟"_s});
        QTRY_COMPARE(rig.prompter.boxes.size(), 1);
        QTest::qWait(150);
        QCOMPARE(rig.received(u"instruction.submit"_s).size(), 0);
        QVERIFY(rig.composer->busy().isEmpty());
        QCOMPARE(rig.composer->payload(), QJsonValue());
    }

    void parseNeedsNoConfirm() {
        Rig rig;
        rig.composer->setText(u"买 1 股 AAPL"_s);
        rig.composer->submit(false, {u"模拟"_s});
        QTRY_COMPARE(rig.received(u"instruction.submit"_s).size(), 1);
        QCOMPARE(rig.received(u"instruction.submit"_s).at(0)[u"execute"].toBool(), false);
        QCOMPARE(rig.prompter.boxes.size(), 0);
        QTRY_VERIFY(rig.composer->payload().isObject());
    }

};

QTEST_GUILESS_MAIN(TestTradeComposer)
#include "tst_trade_composer.moc"
