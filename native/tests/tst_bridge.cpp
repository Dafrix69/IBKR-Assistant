// 界面到引擎的那座桥(shell/bridge):照 desktop/main.js 的 rpc 与 confirm 通道,先后一步不差。
// 对着假引擎(fake_engine)跑:引擎那头收到了什么(FAKE_LOG_PARAMS 打出来的入参)才是真的放没放行。
// 另外直接读 main.js / consent.js / bridge.ts:白名单、敏感表、条款版本、确认用途,C++ 抄的和那几份对不上就红。
#include "shell/bridge.h"
#include "shell/rpc_policy.h"
#include "shell_harness.h"

#include <QFile>
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
        // 条款挡在凭据前面:没同意时不白烧凭据;同意之后那张凭据照样用得上
        QVERIFY(r.confirm(obj(R"({"purpose":"instruction.submit","binding":{"text":"买 AAPL 1 股","accounts":["模拟"]}})")).first);
        QVERIFY(!r.rpc(u"instruction.submit"_s, obj(R"({"text":"买 AAPL 1 股","execute":true,"accounts":["模拟"],"__confirmed":true})")).ok);
        QString error;
        QVERIFY(r.consent.accept(QLatin1StringView(shell::kTermsVersion), u"test"_s, 2'000, &error));
        const auto sent = r.rpc(u"instruction.submit"_s, obj(R"({"text":"买 AAPL 1 股","execute":true,"accounts":["模拟"],"__confirmed":true})"));
        QVERIFY2(sent.ok, qPrintable(sent.error));
    }

    void submitNeedsAGrantForExactlyThisContent() {
        Rig r;
        const QJsonObject submit = obj(R"({"text":"买 AAPL 1 股","execute":true,"accounts":["模拟","主账户"],"__confirmed":true})");
        const auto noGrant = r.rpc(u"instruction.submit"_s, submit);
        QCOMPARE(noGrant.error, u"这一步要先在确认框里点确认(发送真实订单)。没有确认、确认已过期、或内容在确认之后变了,都不会放行。"_s);
        QCOMPARE(r.reached(u"instruction.submit"_s), 0);
        // 确认的是另一句话:不放行
        QVERIFY(r.confirm(obj(R"({"purpose":"instruction.submit","binding":{"text":"买 TSLA 1000 股","accounts":["模拟","主账户"]}})")).first);
        QVERIFY(!r.rpc(u"instruction.submit"_s, submit).ok);
        // 确认的就是这一句:放行一次,用过作废
        QVERIFY(r.confirm(obj(R"({"purpose":"instruction.submit","message":"按下方指令发单","binding":{"text":"买 AAPL 1 股","accounts":["模拟","主账户"]}})")).first);
        const auto sent = r.rpc(u"instruction.submit"_s, submit);
        QVERIFY2(sent.ok, qPrintable(sent.error));
        QCOMPARE(r.reached(u"instruction.submit"_s), 1);
        QVERIFY(!r.rpc(u"instruction.submit"_s, submit).ok);
        QCOMPARE(r.reached(u"instruction.submit"_s), 1);
        // 框上的字由桥写:标题按用途,账户类别问引擎(主账户是实盘)
        const shell::ConfirmBox& box = r.prompter.boxes.last();
        QCOMPARE(box.title, u"发送真实订单"_s);
        QCOMPARE(box.message, u"发送真实订单(含实盘账户)"_s);
        QCOMPARE(box.detail, u"按下方指令发单\n\n指令:买 AAPL 1 股\n账户:模拟(纸面)、主账户(实盘)\n每笔订单各发 2 份。"_s);
        QCOMPARE(box.confirmLabel, u"确认"_s);
    }

    void declinedConfirmIssuesNothing() {
        Rig r;
        r.prompter.answer = false;
        const auto [ok, error] = r.confirm(obj(R"({"purpose":"tracker.close_now","binding":{"id":"t1"},"confirmLabel":"立即平仓"})"));
        QVERIFY(!ok);
        QVERIFY(error.isEmpty());
        QCOMPARE(r.prompter.boxes.last().confirmLabel, u"立即平仓"_s);
        QVERIFY(!r.rpc(u"tracker.close_now"_s, obj(R"({"id":"t1","__confirmed":true})")).ok);
    }

    void grantsExpireAfterAMinute() {
        Rig r;
        qint64 t = 10'000'000;
        r.bridge.now = [&t] { return t; };
        QVERIFY(r.confirm(obj(R"({"purpose":"tracker.close_now","binding":{"id":"t1"}})")).first);
        t += shell::kGrantTtlMs + 1;
        QVERIFY(!r.rpc(u"tracker.close_now"_s, obj(R"({"id":"t1","__confirmed":true})")).ok);
    }

    void unknownPurposeIsRefused() {
        Rig r;
        const auto [ok, error] = r.confirm(obj(R"({"purpose":"anything.goes","binding":{}})"));
        QVERIFY(!ok);
        QCOMPARE(error, u"未知的确认用途:anything.goes"_s);
        QVERIFY(r.prompter.boxes.isEmpty());  // 连框都不弹
    }

    void unboundConfirmGivesNoGrant() {
        Rig r;
        const auto [ok, error] = r.confirm(obj(R"({"message":"真的要删掉这条想法吗?"})"));
        QVERIFY(ok);
        QCOMPARE(r.prompter.boxes.last().title, u"确认"_s);
        QCOMPARE(r.prompter.boxes.last().message, u"真的要删掉这条想法吗?"_s);
        // 没有用途:不发凭据,发单照样过不去
        QVERIFY(!r.rpc(u"tracker.close_now"_s, obj(R"({"id":"t1","__confirmed":true})")).ok);
    }

    void gatesAndLimitsAreJudgedAgainstTheEngineSettings() {
        Rig r;
        // 打开自动执行:从关到开要凭据,框上的话由桥写
        const QJsonObject open = obj(R"({"patch":{"policies":{"auto_execute":true}},"__confirmed":true})");
        QVERIFY(r.rpc(u"settings.patch"_s, open).error.contains(u"打开自动执行"_s));
        QVERIFY(r.confirm(obj(R"({"purpose":"gate.auto_execute"})")).first);
        QVERIFY(r.prompter.boxes.last().detail.startsWith(u"打开后,解析通过的订单会被直接发送到券商"_s));
        QVERIFY(r.rpc(u"settings.patch"_s, open).ok);
        // 放宽限额:从多少改到多少对着引擎的设置算,框上写明;只放宽了的那几项才绑进凭据
        const QJsonObject loosen = obj(R"({"patch":{"limits":{"max_order_notional":50000,"min_confidence":0.95}},"__confirmed":true})");
        QVERIFY(r.rpc(u"settings.patch"_s, loosen).error.contains(u"放宽风控限额"_s));
        QVERIFY(r.confirm(obj(R"({"purpose":"limits.loosen","binding":{"limits":{"max_order_notional":50000,"min_confidence":0.95}}})")).first);
        QCOMPARE(r.prompter.boxes.last().detail, u"单笔名义金额上限(USD):5,000 → 50,000\n\n这些限额是每一笔订单都要过的闸:放宽之后,解析错了的指令能造成的损失也跟着变大。"_s);
        QVERIFY(r.rpc(u"settings.patch"_s, loosen).ok);
        // 只是收紧:不弹框、不发凭据,放行那一头也不要
        const qsizetype boxes = r.prompter.boxes.size();
        QVERIFY(r.confirm(obj(R"({"purpose":"limits.loosen","binding":{"limits":{"max_order_notional":10}}})")).first);
        QCOMPARE(r.prompter.boxes.size(), boxes);
        QVERIFY(r.rpc(u"settings.patch"_s, obj(R"({"patch":{"limits":{"max_order_notional":10}},"__confirmed":true})")).ok);
    }

    // 别的用途(立即平仓、新建追踪):标题行按用途写,正文 = 页面给的 message 与 detail,各截 1200 字、空一行连起来(main.js 的 lines)
    void plainBoxJoinsMessageAndDetail() {
        Rig r;
        const QString detail = QString(1300, u'x');
        const QJsonObject options{{u"purpose"_s, u"tracker.close_now"_s}, {u"binding"_s, QJsonObject{{u"id"_s, u"t1"_s}}}, {u"title"_s, u"页面的标题"_s},
                                  {u"message"_s, u"现在平掉 SPX?"_s}, {u"detail"_s, detail}, {u"confirmLabel"_s, u"平仓"_s}};
        QVERIFY(r.confirm(options).first);
        const shell::ConfirmBox& box = r.prompter.boxes.last();
        QCOMPARE(box.title, u"立即平仓"_s);
        QCOMPARE(box.message, u"立即平仓"_s);
        QCOMPARE(box.detail, u"现在平掉 SPX?\n\n"_s + detail.left(1200));
        QCOMPARE(box.confirmLabel, u"平仓"_s);
        // 空白的那一段不进正文
        QVERIFY(r.confirm(QJsonObject{{u"purpose"_s, u"tracker.close_now"_s}, {u"binding"_s, QJsonObject{{u"id"_s, u"t1"_s}}}, {u"message"_s, u"  "_s}, {u"detail"_s, u"只有这一段"_s}}).first);
        QCOMPARE(r.prompter.boxes.last().detail, u"只有这一段"_s);
    }

    void followConfirmOnlyWhenWidening() {
        Rig r;
        const char* follow = R"({"enabled":true,"channel_id":"1100000000000000001","author_ids":["220000000000000002"],"accounts":["主账户"],
            "max_age_seconds":30,"max_orders_per_day":3,"max_risk_usd":300})";
        QJsonObject options{{u"purpose"_s, u"gate.follow"_s}, {u"binding"_s, obj(follow)}};
        QVERIFY(r.confirm(options).first);
        QCOMPARE(r.prompter.boxes.last().message, u"打开 Discord 自动跟单(含实盘账户)"_s);
        QVERIFY(r.prompter.boxes.last().detail.contains(u"发到账户:主账户(实盘)"_s));
        const auto saved = r.rpc(u"settings.patch"_s, QJsonObject{{u"patch"_s, QJsonObject{{u"follow"_s, obj(follow)}}}, {u"__confirmed"_s, true}});
        QVERIFY2(saved.ok, qPrintable(saved.error));
    }

    void settingsReadFailureBlocksThePatch() {
        // 读不到引擎现在的设置:不放行(要不要确认是对着它算的)
        Rig r(true, {{u"FAKE_DELAY_METHODS"_s, u"settings.get=20000"_s}});
        const auto reply = r.rpc(u"settings.patch"_s, obj(R"({"patch":{"policies":{"auto_execute":true}},"__confirmed":true})"));
        QVERIFY2(reply.error.contains(u"settings.get 超时"_s), qPrintable(reply.error));
        QCOMPARE(r.reached(u"settings.patch"_s), 0);
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
