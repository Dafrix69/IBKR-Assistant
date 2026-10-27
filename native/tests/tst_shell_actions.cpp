// 顶栏的派生(shell/topbar_state)与两个按钮的动作(shell/shell_actions)。
// 派生逐条照 Topbar.tsx;动作对着假引擎,看引擎那头收到了什么。
#include "shell/shell_actions.h"
#include "shell/topbar_state.h"
#include "shell_harness.h"

#include <QJsonArray>
#include <QTemporaryDir>

using namespace ibkr;
using namespace ibkr::test;
using namespace Qt::StringLiterals;

namespace {

QJsonObject obj(const char* t) { return QJsonDocument::fromJson(t).object(); }
QJsonObject chip(const QJsonObject& s, int ok, const char* name) { return shell::topbarState(s, ok).value(QLatin1StringView(name)).toObject(); }

const char* kBase = R"({"protocol":"1.0","now_et":"2026-10-08 09:42:11","market_status":"盘中","model":"claude-opus-5","broker_provider":"ibkr","broker_connected":true,
  "broker_upstream_ok":true,"breaker":{"engaged":false},"protections":{"paused":false,"accounts":[]},
  "accounts":[{"alias":"模拟","is_paper":true,"broker":"ibkr"},{"alias":"主账户","is_paper":false,"broker":"ibkr"},{"alias":"富途模拟","is_paper":true,"broker":"futu"}]})";

}  // namespace

class TestShellActions : public QObject {
    Q_OBJECT
private slots:
    void brokerChip() {
        QCOMPARE(chip(obj(kBase), 1, "broker")[u"text"].toString(), u"TWS 已连接"_s);
        QCOMPARE(chip(obj(kBase), 1, "broker")[u"tone"].toString(), u"ok"_s);
        // 引擎不答话:手上这份是它最后一次答话时的样子,不能再写「已连接」
        QCOMPARE(chip(obj(kBase), 0, "broker")[u"text"].toString(), u"TWS 状态未知"_s);
        QCOMPARE(chip(obj(kBase), 0, "broker")[u"tone"].toString(), u"bad"_s);
        QJsonObject down = obj(kBase);
        down[u"broker_upstream_ok"_s] = false;
        QCOMPARE(chip(down, 1, "broker")[u"text"].toString(), u"TWS 上游中断"_s);
        QCOMPARE(chip(down, 1, "broker")[u"tone"].toString(), u"warn"_s);
        QJsonObject off = obj(kBase);
        off[u"broker_connected"_s] = false;
        off[u"broker_provider"_s] = u"futu"_s;
        QCOMPARE(chip(off, 1, "broker")[u"text"].toString(), u"OpenD 未连接"_s);
        QCOMPARE(shell::topbarState(off, 1)[u"connectLabel"].toString(), u"连接 OpenD"_s);
        QCOMPARE(shell::topbarState(obj(kBase), 1)[u"connectLabel"].toString(), u"断开 TWS"_s);
    }

    // 实盘那一格已撤掉:实盘账户不再有闸门
    void noLiveChip() { QVERIFY(!shell::topbarState(obj(kBase), 1).contains(u"live"_s)); }

    void modeChip() {
        QCOMPARE(chip(obj(kBase), 1, "mode")[u"text"].toString(), u"直接发单"_s);
        QCOMPARE(chip(obj(kBase), 1, "mode")[u"tone"].toString(), u"warn"_s);
        QJsonObject s = obj(kBase);
        // 保护暂停盖过直接发单;熔断盖过保护暂停
        s[u"protections"_s] = obj(R"({"paused":true,"reason":"接连止损","accounts":[]})");
        QCOMPARE(chip(s, 1, "mode")[u"text"].toString(), u"保护暂停"_s);
        QCOMPARE(chip(s, 1, "mode")[u"tip"].toString(), u"接连止损。平仓不受影响。"_s);
        s[u"breaker"_s] = obj(R"({"engaged":true})");
        QCOMPARE(chip(s, 1, "mode")[u"text"].toString(), u"已熔断"_s);
        QCOMPARE(chip(s, 1, "mode")[u"tone"].toString(), u"bad"_s);
        QCOMPARE(shell::topbarState(s, 1)[u"breakerLabel"].toString(), u"解除熔断"_s);
        // 只停了某个账户:不占「保护暂停」那一格,写在模式后面
        QJsonObject acct = obj(kBase);
        acct[u"protections"_s] = obj(R"({"paused":false,"accounts":[{"account":"主账户","until_ms":1,"reason":"日内亏损上限"}]})");
        QCOMPARE(chip(acct, 1, "mode")[u"text"].toString(), u"直接发单 · 主账户 暂停"_s);
        QCOMPARE(chip(acct, 1, "mode")[u"tip"].toString(), u"解析、校验通过的订单直接发到券商,实盘账户也一样。日内亏损上限。平仓不受影响。"_s);
    }

    void marketAndModelChips() {
        QCOMPARE(chip(obj(kBase), 1, "market")[u"text"].toString(), u"盘中 09:42 美东"_s);
        QCOMPARE(chip(obj(kBase), 1, "market")[u"tone"].toString(), u"ok"_s);
        QCOMPARE(chip(obj(kBase), 1, "model")[u"text"].toString(), u"opus-5"_s);
        QJsonObject closed = obj(kBase);
        closed[u"market_status"_s] = u"休市"_s;
        QCOMPARE(chip(closed, 1, "market")[u"tone"].toString(), u"warn"_s);
        QCOMPARE(chip({}, -1, "market")[u"text"].toString(), u"—"_s);
        QCOMPARE(chip({}, -1, "engine")[u"tip"].toString(), u"引擎启动中"_s);
        QCOMPARE(chip({}, 0, "engine")[u"tone"].toString(), u"bad"_s);
    }

    // ---- 动作:对着假引擎 ----
    void breakerHaltAndResume() {
        QTemporaryDir dir;
        shell::EngineClient engine(fakeEngine({{u"FAKE_STATUS"_s, QString::fromUtf8(kBase)}, {u"FAKE_LOG_PARAMS"_s, u"1"_s}}), 40);
        QStringList logs;
        QObject::connect(&engine, &shell::EngineClient::logLine, [&logs](const QString& l) { logs.append(l); });
        struct Yes : shell::Prompter { void ask(const shell::ConfirmBox&, std::function<void(bool)> d) override { d(true); } } yes;
        shell::ConsentStore consent(dir.path());
        shell::Bridge bridge(&engine, &yes, &consent);
        shell::StatusStore store(&engine, 60'000);
        shell::ShellActions actions(&bridge, &store);
        QSignalSpy notified(&actions, &shell::ShellActions::notify);
        store.refresh();
        QTRY_COMPARE(store.engineOk(), 1);
        actions.toggleBreaker();  // 没熔断:halt
        QTRY_VERIFY(logs.contains(u"[fake] breaker.halt {\"reason\":\"用户在界面上按下暂停\"}"_s));
        QTRY_COMPARE(notified.size(), 1);
        QCOMPARE(notified[0][0].toString(), u"已熔断"_s);
        QCOMPARE(notified[0][1].toString(), u"撤销未成交单 0 笔"_s);
        QTRY_VERIFY(!actions.busy());
        // 连着:断开(不带确认标记,引擎也收不到它)
        actions.toggleBrokerConnection();
        QTRY_VERIFY(logs.contains(u"[fake] broker.disconnect {}"_s));
        QTRY_COMPARE(notified.size(), 2);
        QCOMPARE(notified[1][0].toString(), u"已断开 TWS 连接"_s);
        shell::StopOptions o;
        o.drainMs = 0;
        stopSync(engine, o);
    }

    void connectGoesThroughTheBridgeWithTheMark() {
        QTemporaryDir dir;
        QJsonObject status = obj(kBase);
        status[u"broker_connected"_s] = false;
        shell::EngineClient engine(fakeEngine({{u"FAKE_STATUS"_s, QString::fromUtf8(QJsonDocument(status).toJson(QJsonDocument::Compact))}, {u"FAKE_LOG_PARAMS"_s, u"1"_s}}), 40);
        QStringList logs;
        QObject::connect(&engine, &shell::EngineClient::logLine, [&logs](const QString& l) { logs.append(l); });
        struct Yes : shell::Prompter { void ask(const shell::ConfirmBox&, std::function<void(bool)> d) override { d(true); } } yes;
        shell::ConsentStore consent(dir.path());
        shell::Bridge bridge(&engine, &yes, &consent);
        shell::StatusStore store(&engine, 60'000);
        shell::ShellActions actions(&bridge, &store);
        QSignalSpy notified(&actions, &shell::ShellActions::notify);
        store.refresh();
        QTRY_COMPARE(store.engineOk(), 1);
        actions.toggleBrokerConnection();
        // 引擎收到的入参里 __confirmed 被桥摘掉了;假引擎回的是空对象:一条都没连上也没失败,不弹条也不通知
        QTRY_VERIFY(logs.contains(u"[fake] broker.connect {\"connections\":null}"_s));
        QTRY_VERIFY(!actions.busy());
        QCOMPARE(notified.size(), 0);
        shell::StopOptions o;
        o.drainMs = 0;
        stopSync(engine, o);
    }

    // 菜单 / Dock 菜单的熔断:只熔断、带上从哪儿按的;窗口藏着时回执另发系统通知,看得见时不发
    void haltFromMenuNotifiesWhenUnseen() {
        QTemporaryDir dir;
        shell::EngineClient engine(fakeEngine({{u"FAKE_STATUS"_s, QString::fromUtf8(kBase)}, {u"FAKE_LOG_PARAMS"_s, u"1"_s}}), 40);
        QStringList logs;
        QObject::connect(&engine, &shell::EngineClient::logLine, [&logs](const QString& l) { logs.append(l); });
        struct Yes : shell::Prompter { void ask(const shell::ConfirmBox&, std::function<void(bool)> d) override { d(true); } } yes;
        shell::ConsentStore consent(dir.path());
        shell::Bridge bridge(&engine, &yes, &consent);
        shell::StatusStore store(&engine, 60'000);
        shell::ShellActions actions(&bridge, &store);
        QSignalSpy notice(&actions, &shell::ShellActions::systemNotice);
        actions.haltFromMenu(u"Dock 菜单触发熔断"_s, true);
        QTRY_VERIFY(logs.contains(u"[fake] breaker.halt {\"reason\":\"Dock 菜单触发熔断\"}"_s));
        QTRY_COMPARE(notice.size(), 1);
        QCOMPARE(notice[0][0].toString(), u"已暂停全部自动执行"_s);
        actions.haltFromMenu(u"菜单/快捷键触发熔断"_s, false);
        QTRY_VERIFY(logs.contains(u"[fake] breaker.halt {\"reason\":\"菜单/快捷键触发熔断\"}"_s));
        QTest::qWait(200);
        QCOMPARE(notice.size(), 1);
        shell::StopOptions o;
        o.drainMs = 0;
        stopSync(engine, o);
    }
};

QTEST_GUILESS_MAIN(TestShellActions)
#include "tst_shell_actions.moc"
