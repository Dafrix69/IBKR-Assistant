// 界面到引擎的那座桥(shell/bridge):照 desktop/main.js 的 rpc 与 confirm 通道,先后一步不差。
// 对着假引擎(fake_engine)跑:引擎那头收到了什么(FAKE_LOG_PARAMS 打出来的入参)才是真的放没放行。
// 另外直接读 main.js / consent.js / bridge.ts:白名单、敏感表、条款版本、确认用途,C++ 抄的和那几份对不上就红。
#include "shell/bridge.h"
#include "shell/rpc_policy.h"
#include "shell_harness.h"

#include <QFile>
#include <QJsonArray>
#include <QRegularExpression>
#include <QTemporaryDir>

using namespace ibkr;
using namespace ibkr::test;
using namespace Qt::StringLiterals;

namespace {

/// 假的确认框:记下框上的字,按预设回答(默认点"确认")
class FakePrompter : public shell::Prompter {
public:
    void ask(const shell::ConfirmBox& box, std::function<void(bool)> done) override {
        boxes.append(box);
        if (hold) {
            *hold = std::move(done);  // 框先不关:测试自己决定什么时候点
            return;
        }
        done(answer);
    }
    QList<shell::ConfirmBox> boxes;
    bool answer = true;
    std::function<void(bool)>* hold = nullptr;
};

const char* kSettings = R"({"policies":{"auto_execute":false,"allow_live_trading":false},
  "limits":{"max_order_notional":5000,"max_option_contracts":5,"max_mkt_shares":200,"max_spread_slippage":0.1,"min_confidence":0.9,"duplicate_window_minutes":10,"max_orders_per_input":5},
  "follow":{"enabled":false,"channel_id":"","author_ids":[],"accounts":[],"max_age_seconds":30,"max_orders_per_day":3,"max_risk_usd":300}})";
const char* kStatus = R"({"accounts":[{"alias":"模拟","is_paper":true,"default":true},{"alias":"主账户","is_paper":false,"default":false}]})";

struct Rig {
    explicit Rig(bool consented = true, QHash<QString, QString> extra = {})
        : engine(fakeEngine(env(std::move(extra))), 40), consent(dir.path()), bridge(&engine, &prompter, &consent) {
        QObject::connect(&engine, &shell::EngineClient::logLine, [this](const QString& l) { logs.append(l); });
        if (consented) {
            QString error;
            if (!consent.accept(QLatin1StringView(shell::kTermsVersion), u"test"_s, 1'000, &error)) qFatal("%s", qPrintable(error));
        }
    }
    ~Rig() {
        shell::StopOptions o;
        o.drainMs = 0;
        o.killGraceMs = 200;
        stopSync(engine, o);
    }
    static QHash<QString, QString> env(QHash<QString, QString> extra) {
        extra.insert(u"FAKE_SETTINGS"_s, QString::fromUtf8(kSettings).simplified());
        extra.insert(u"FAKE_STATUS"_s, QString::fromUtf8(kStatus));
        extra.insert(u"FAKE_LOG_PARAMS"_s, u"1"_s);
        return extra;
    }
    shell::EngineReply rpc(const QString& method, const QJsonValue& params) {
        std::optional<shell::EngineReply> got;
        bridge.rpc(method, params, [&got](const shell::EngineReply& r) { got = r; });
        if (!QTest::qWaitFor([&] { return got.has_value(); }, 15000)) return shell::EngineReply{false, {}, u"测试自己等超时了"_s, {}, {}};
        return *got;
    }
    std::pair<bool, QString> confirm(const QJsonObject& options) {
        std::optional<std::pair<bool, QString>> got;
        bridge.confirm(options, [&got](bool ok, const QString& e) { got = std::make_pair(ok, e); });
        if (!QTest::qWaitFor([&] { return got.has_value(); }, 8000)) return {false, u"测试自己等超时了"_s};
        return *got;
    }
    /// 引擎收到过几次这个方法
    int reached(const QString& method) const {
        return static_cast<int>(std::count_if(logs.begin(), logs.end(), [&method](const QString& l) { return l.startsWith(u"[fake] "_s + method + u' '); }));
    }
    QString lastParams(const QString& method) const {
        for (qsizetype i = logs.size() - 1; i >= 0; --i)
            if (logs[i].startsWith(u"[fake] "_s + method + u' ')) return logs[i].mid(8 + method.size());
        return {};
    }

    QTemporaryDir dir;
    FakePrompter prompter;
    shell::EngineClient engine;
    shell::ConsentStore consent;
    shell::Bridge bridge;
    QStringList logs;
};

QJsonObject obj(const char* text) { return QJsonDocument::fromJson(text).object(); }

}  // namespace

class TestBridge : public QObject {
    Q_OBJECT
private slots:
    // 带 context 的那一路:context 没了,迟到的回包(包括引擎停下时回绝的在途调用)一律不回
    void contextGoneDropsTheReply() {
        Rig rig(true, {{u"FAKE_DELAY_METHODS"_s, u"alerts.list=200"_s}});
        int called = 0;
        auto* store = new QObject;
        rig.bridge.rpc(store, u"alerts.list"_s, QJsonObject{}, [&called](const shell::EngineReply&) { ++called; });
        auto* kept = new QObject;
        rig.bridge.rpc(kept, u"alerts.list"_s, QJsonObject{}, [&called](const shell::EngineReply&) { called += 10; });
        delete store;
        QTRY_COMPARE(called, 10);
        QTest::qWait(100);
        QCOMPARE(called, 10);
        // 引擎停下时回绝在途的:context 已经没了的同样不回
        rig.bridge.rpc(kept, u"alerts.list"_s, QJsonObject{}, [&called](const shell::EngineReply& r) { called += r.ok ? 100 : 1000; });
        delete kept;
        shell::StopOptions o;
        o.drainMs = 0;
        stopSync(rig.engine, o);
        QCOMPARE(called, 10);
    }

    // 确认框带 context 的那一路同理:框还开着时 context 没了,点完也不回
    void contextGoneDropsTheConfirm() {
        Rig rig;
        std::function<void(bool)> answer;
        rig.prompter.hold = &answer;
        int called = 0;
        auto* store = new QObject;
        rig.bridge.confirm(store, QJsonObject{{u"title"_s, u"t"_s}, {u"message"_s, u"m"_s}}, [&called](bool, const QString&) { ++called; });
        QVERIFY(answer);
        delete store;
        answer(true);
        QCOMPARE(called, 0);
    }
    void rpcTablesNotEmpty() {
        QVERIFY(shell::allowedRpc().size() > 90);
        QVERIFY(shell::sensitiveRpc().size() > 0);
        QVERIFY(shell::outcomeUnknownRpc().size() > 0);
    }

    // ---- rpc 的每一道 ----
    void notAllowlistedNeverReachesTheEngine() {
        Rig r;
        const auto reply = r.rpc(u"shell.exec"_s, QJsonObject{});
        QCOMPARE(reply.error, u"方法不在白名单中:shell.exec"_s);
        QTest::qWait(50);
        QCOMPARE(r.reached(u"shell.exec"_s), 0);
    }

    void sensitiveNeedsTheMarkAndTheMarkIsStripped() {
        Rig r;
        QCOMPARE(r.rpc(u"tracker.update"_s, obj(R"({"id":"t1"})")).error, u"敏感操作缺少界面确认标记,已拒绝"_s);
        const auto ok = r.rpc(u"tracker.update"_s, obj(R"({"id":"t1","__confirmed":true})"));
        QVERIFY2(ok.ok, qPrintable(ok.error));
        // 引擎收到的入参里没有 __confirmed
        QCOMPARE(r.lastParams(u"tracker.update"_s), u"{\"id\":\"t1\"}"_s);
    }

    void moneyPathsNeedConsent() {
        Rig r(/*consented=*/false);
        const auto blocked = r.rpc(u"instruction.submit"_s, obj(R"({"text":"买 AAPL 1 股","execute":true,"accounts":["模拟"],"__confirmed":true})"));
        QVERIFY2(blocked.error.startsWith(u"还没有同意《风险揭示与使用条款》"_s), qPrintable(blocked.error));
        // 只解析不发单不挡
        QVERIFY(r.rpc(u"instruction.submit"_s, obj(R"({"text":"买 AAPL 1 股","execute":false,"accounts":["模拟"],"__confirmed":true})")).ok);
        QVERIFY(!r.rpc(u"instruction.submit"_s, obj(R"({"text":"买 AAPL 1 股","execute":true,"accounts":["模拟"],"__confirmed":true})")).ok);
        QString error;
        QVERIFY(r.consent.accept(QLatin1StringView(shell::kTermsVersion), u"test"_s, 2'000, &error));
        const auto sent = r.rpc(u"instruction.submit"_s, obj(R"({"text":"买 AAPL 1 股","execute":true,"accounts":["模拟"],"__confirmed":true})"));
        QVERIFY2(sent.ok, qPrintable(sent.error));
    }

    // 带用途的确认(发单、立即平仓、放宽限额、打开跟单……)不弹框、直接回确认;发单不再要凭据
    void purposedConfirmDoesNotAsk() {
        Rig r;
        for (const char* purpose : {"instruction.submit", "tracker.close_now", "tracker.add", "broker.select", "limits.loosen", "gate.follow", "anything"}) {
            const auto [ok, error] = r.confirm(QJsonObject{{u"purpose"_s, QString::fromLatin1(purpose)}, {u"binding"_s, QJsonObject{}}, {u"title"_s, u"t"_s}});
            QVERIFY(ok);
            QVERIFY(error.isEmpty());
        }
        QVERIFY(r.prompter.boxes.isEmpty());
        const auto sent = r.rpc(u"instruction.submit"_s, obj(R"({"text":"买 AAPL 1 股","execute":true,"accounts":["模拟","主账户"],"__confirmed":true})"));
        QVERIFY2(sent.ok, qPrintable(sent.error));
        QCOMPARE(r.reached(u"instruction.submit"_s), 1);
        QVERIFY(r.rpc(u"tracker.close_now"_s, obj(R"({"id":"t1","__confirmed":true})")).ok);
        QVERIFY(r.rpc(u"settings.patch"_s, obj(R"({"patch":{"limits":{"max_order_notional":50000}},"__confirmed":true})")).ok);
        QCOMPARE(r.reached(u"settings.get"_s), 0);  // 放宽限额不再先读一次设置
    }

    // 不带用途的确认照旧弹框:标题、正文、按钮由页面给
    void plainConfirmStillAsks() {
        Rig r;
        r.prompter.answer = false;
        const auto [ok, error] = r.confirm(obj(R"({"message":"真的要删掉这条想法吗?","confirmLabel":"删掉"})"));
        QVERIFY(!ok);
        QVERIFY(error.isEmpty());
        QCOMPARE(r.prompter.boxes.last().title, u"确认"_s);
        QCOMPARE(r.prompter.boxes.last().message, u"真的要删掉这条想法吗?"_s);
        QCOMPARE(r.prompter.boxes.last().confirmLabel, u"删掉"_s);
    }

    void exportPathMustBeThePickedOne() {
        Rig r;
        QCOMPARE(r.rpc(u"data.export"_s, obj(R"({"path":"/tmp/x.json"})")).error, u"导出路径必须是刚在保存对话框里选的那一个,请重新点「导出」"_s);
        r.bridge.setPickedExportPath(u"/tmp/picked.json"_s);
        QVERIFY(!r.rpc(u"data.export"_s, obj(R"({"path":"/tmp/other.json"})")).ok);
        QVERIFY(r.rpc(u"data.export"_s, obj(R"({"path":"/tmp/picked.json"})")).ok);
        QVERIFY(!r.rpc(u"data.export"_s, obj(R"({"path":"/tmp/picked.json"})")).ok);  // 用一次作废
    }

    void timeoutOnAMoneyCallIsUnknownNotFailed() {
        // 会发单的调用超时:报「结果未知」(不是失败,别让人顺手重发);引擎迟到的回执补报一次
        Rig r(true, {{u"FAKE_DELAY_METHODS"_s, u"tracker.update=400"_s}});
        r.bridge.outcomeTimeoutMs = 100;
        QSignalSpy late(&r.bridge, &shell::Bridge::lateOutcome);
        const auto reply = r.rpc(u"tracker.update"_s, obj(R"({"id":"t1","__confirmed":true})"));
        QVERIFY2(reply.error.startsWith(u"结果未知:引擎 2 分钟内没有回话"_s), qPrintable(reply.error));
        QTRY_COMPARE(late.size(), 1);
        QCOMPARE(late[0][0].toString(), u"修改追踪"_s);
        QVERIFY(late[0][1].toBool());
    }

    void consentRecordIsSharedAndVersioned() {
        QTemporaryDir dir;
        shell::ConsentStore store(dir.path());
        QVERIFY(!store.state().accepted);
        QString error;
        QVERIFY(!store.accept(u"2020-01-01"_s, u"x"_s, 1, &error));
        QVERIFY2(error.startsWith(u"条款版本对不上"_s), qPrintable(error));
        const auto state = store.accept(QLatin1StringView(shell::kTermsVersion), u"0.6.0"_s, 1791500000000, &error);
        QVERIFY(state && state->accepted);
        QCOMPARE(state->acceptedAt, u"2026-10-08T22:53:20.000Z"_s);
        // 文件的样子同 consent.js 写的:{ accepted: [{ version, at, app_version }] }
        QFile f(store.path());
        QVERIFY(f.open(QIODevice::ReadOnly));
        const QJsonObject saved = QJsonDocument::fromJson(f.readAll()).object();
        QCOMPARE(saved.value(u"accepted").toArray().first().toObject().value(u"app_version").toString(), u"0.6.0"_s);
    }
};

QTEST_GUILESS_MAIN(TestBridge)
#include "tst_bridge.moc"
