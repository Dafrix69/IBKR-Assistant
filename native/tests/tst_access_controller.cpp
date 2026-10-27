// 「接入」的接线(shell/access_controller,照 pages/Access.tsx 与五节):对着假引擎。
//   · 子页签记在本机;一次只挂一节:进来读、换走清掉、晚到的回包不落地;
//   · TWS:检测程序与端口、读券商目录;「检测连接」的入参与读着 / 失败;启动程序带 __confirmed、发通知、过一会儿重新检测、失败横幅带「启动失败:」;
//   · 富途:换券商不弹框,直接发;交易密码只往 futu.set_password 送、存完清掉;解锁的几种说法;
//   · 账户:改动交给壳,成了清掉表单、横幅、过一会儿刷新;取消不说话;失败横幅;
//   · 大模型:按目录与供应商重填表单(同一份目录再来不冲掉没存的);数字框不合规先说;测试带一把还没存的 key;保存与存 key 的入参;
//   · 跟单:读状态、引擎报 follow 时重读但不动表单;关是当场生效的;有毛病不发;打开着保存要过确认框(gate.follow)。
#include "shell/access_controller.h"
#include "shell/access_rules.h"
#include "shell/bridge.h"
#include "shell/consent.h"
#include "shell/engine_command.h"
#include "shell/llm_store.h"
#include "shell/shell_actions.h"
#include "shell/status_store.h"
#include "shell/ordered_json.h"
#include "shell_harness.h"

#include <QJsonArray>
#include <QSettings>
#include <QSignalSpy>
#include <QTemporaryDir>

using namespace ibkr;
using namespace ibkr::test;
using namespace Qt::StringLiterals;

namespace {

QJsonObject seedOf(const QString& page, const QString& ns, const QString& key) {
    static const QJsonObject j = [] {
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/access.json"));
        if (!f.open(QIODevice::ReadOnly)) qFatal("access.json 打不开");
        return QJsonDocument::fromJson(f.readAll()).object();
    }();
    for (const QJsonValue& p : j[u"pages"_s].toArray())
        if (p[u"name"_s].toString() == page) return p[u"seed"_s][ns][key].toObject();
    qFatal("access.json 里没有 %s", qPrintable(page));
}

struct Rig {
    QTemporaryDir dir;
    QString resultsPath = dir.filePath(u"results.json"_s);
    QString ini = dir.filePath(u"qt-settings.ini"_s);
    shell::EngineClient engine;
    QStringList logs;
    struct Asker : shell::Prompter {
        bool answer = true;
        QList<shell::ConfirmBox> boxes;
        void ask(const shell::ConfirmBox& b, std::function<void(bool)> d) override {
            boxes << b;
            d(answer);
        }
    } asker;
    shell::ConsentStore consent{dir.path()};
    shell::Bridge bridge{&engine, &asker, &consent};
    shell::StatusStore status{&engine, 60'000};
    shell::LlmStore llm{&bridge, &status};
    shell::ShellActions actions{&bridge, &status};
    QJsonObject results;

    explicit Rig(const QString& delays = {})
        : engine(fakeEngine({{u"FAKE_STATUS"_s, u"{\"broker_connected\":true,\"auto_execute\":true,\"accounts\":[{\"alias\":\"模拟\",\"account_masked\":\"DU***321\",\"is_paper\":true,\"connection\":\"paper\",\"default\":true},{\"alias\":\"主账户\",\"account_masked\":\"U1***567\",\"is_paper\":false,\"connection\":\"live\",\"default\":false}]}"_s},
                             {u"FAKE_LOG_PARAMS"_s, u"1"_s}, {u"FAKE_RESULTS_FILE"_s, resultsPath}, {u"FAKE_DELAY_METHODS"_s, delays}}),
                 40) {
        QObject::connect(&engine, &shell::EngineClient::logLine, [this](const QString& l) { logs.append(l); });
        QString error;
        if (!consent.accept(QLatin1StringView(shell::kTermsVersion), u"test"_s, 1'000, &error)) qFatal("%s", qPrintable(error));
        set(u"tws.scan"_s, seedOf(u"TWS:检测到了、当前是 IBKR"_s, u"tws"_s, u"scan"_s));
        set(u"broker.catalog"_s, seedOf(u"富途:都读到了"_s, u"futu"_s, u"catalog"_s));
        set(u"futu.scan"_s, seedOf(u"富途:都读到了"_s, u"futu"_s, u"scan"_s));
        set(u"tws.diagnose"_s, QJsonObject{{u"results"_s, QJsonArray{}}});
        set(u"tws.launch"_s, QJsonObject{{u"ok"_s, true}});
        set(u"broker.select"_s, QJsonObject{{u"ok"_s, true}});
        set(u"futu.set_password"_s, QJsonObject{{u"ok"_s, true}});
        set(u"futu.unlock"_s, QJsonObject{{u"unlocked"_s, QJsonArray{u"opend"_s}}, {u"failed"_s, QJsonObject{}}});
        set(u"llm.catalog"_s, QJsonDocument::fromJson(R"J({"providers":[{"key":"anthropic","label":"Anthropic(Claude)","default_model":"claude-opus-5","models":["claude-opus-5","claude-sonnet-5"],"supports_effort":true,"supports_temperature":false,"needs_base_url":false,"default_base_url":"","docs":"d"},{"key":"openai_compatible","label":"OpenAI 兼容端点","default_model":"","models":["deepseek-chat"],"supports_effort":false,"supports_temperature":true,"needs_base_url":true,"default_base_url":"https://api.deepseek.com/v1","docs":"x"}],"current":{"provider":"anthropic","model":"claude-opus-5","base_url":"","effort":"high","temperature":null,"max_tokens":8000,"timeout_s":60},"key_configured":{"anthropic":true}})J").object());
        set(u"llm.test"_s, QJsonObject{{u"ok"_s, true}, {u"model"_s, u"claude-opus-5"_s}, {u"latency_ms"_s, 500}, {u"structured_mode"_s, u"json_schema"_s}});
        set(u"llm.patch"_s, QJsonObject{{u"ok"_s, true}});
        set(u"keychain.set"_s, QJsonObject{{u"ok"_s, true}});
        set(u"follow.status"_s, seedOf(u"跟单:默认"_s, u"follow"_s, u"status"_s));
        set(u"follow.set_token"_s, seedOf(u"跟单:默认"_s, u"follow"_s, u"status"_s));
        set(u"settings.get"_s, QJsonObject{{u"follow"_s, seedOf(u"跟单:默认"_s, u"follow"_s, u"status"_s)[u"config"_s]}});
        set(u"settings.patch"_s, QJsonObject{{u"ok"_s, true}});
        status.refresh();
        QTRY_VERIFY(status.status()[u"broker_connected"_s].toBool());
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
        f.write(QJsonDocument(results).toJson(QJsonDocument::Compact));
    }
    int calls(const QString& method) const { return int(logs.filter(u"[fake] "_s + method + u' ').size()); }
    QStringList params(const QString& method) const {
        QStringList out;
        for (const QString& l : logs)
            if (l.startsWith(u"[fake] "_s + method + u' ')) out << l.mid(8 + method.size());
        return out;
    }
};

}  // namespace

class TestAccessController : public QObject {
    Q_OBJECT
private slots:
    void twsMountDiagnoseLaunch() {
        Rig rig(u"tws.diagnose=120"_s);
        shell::AccessController page(&rig.bridge, &rig.status, &rig.llm, &rig.actions, rig.ini);
        page.relaunchScanMs = 60;
        QSignalSpy notified(&page, &shell::AccessController::notify);
        QCOMPARE(page.sub(), u"tws"_s);
        page.setVisible(true);
        QVERIFY(page.model()[u"apps"_s][u"loading"_s].toBool());
        QTRY_VERIFY(page.model()[u"apps"_s][u"cards"_s].isArray());
        QTRY_COMPARE(page.model()[u"notices"_s].toArray().size(), 2);  // 读回券商目录:当前是 IBKR
        // 检测连接:不带连接;读着;回来是空的结果
        page.diagnose();
        QCOMPARE(page.model()[u"diag"_s][u"working"_s].toString(), u"正在握手…(首次连接 TWS 会弹确认框,点 Yes)"_s);
        QTRY_VERIFY(page.model()[u"diag"_s][u"cards"_s].isArray());
        QCOMPARE(rig.params(u"tws.diagnose"_s).first(), u"{}"_s);
        rig.set(u"tws.diagnose"_s, QJsonObject{{u"__error"_s, u"超时"_s}});
        page.diagnose();
        QTRY_COMPARE(page.model()[u"diag"_s][u"empty"_s].toString(), u"诊断失败:超时"_s);
        // 启动程序:带 __confirmed(Bridge 去掉它再发)、通知、过一会儿重新检测
        const int scans = rig.calls(u"tws.scan"_s);
        page.launch(u"gateway"_s, u"IB Gateway"_s);
        QTRY_COMPARE(notified.size(), 1);
        QCOMPARE(notified.at(0).at(0).toString(), u"已启动 IB Gateway"_s);
        QCOMPARE(rig.params(u"tws.launch"_s).first(), u"{\"app\":\"gateway\"}"_s);
        QTRY_COMPARE(rig.calls(u"tws.scan"_s), scans + 1);
        rig.set(u"tws.launch"_s, QJsonObject{{u"__error"_s, u"找不到程序"_s}});
        page.launch(u"tws"_s, u"Trader Workstation"_s);
        QTRY_COMPARE(rig.status.banner(), u"启动失败:找不到程序"_s);
    }

    void subtabsPersistAndUnmount() {
        Rig rig(u"tws.scan=200"_s);
        {
            shell::AccessController page(&rig.bridge, &rig.status, &rig.llm, &rig.actions, rig.ini);
            page.setVisible(true);
            page.setSub(u"futu"_s);  // tws.scan 还在路上:那一节已经卸载,回来不落地
            QTRY_VERIFY(page.model()[u"providers"_s][u"cards"_s].isArray());
            QTRY_VERIFY(page.model()[u"apps"_s][u"cards"_s].isArray());
            QTest::qWait(300);
            QCOMPARE(page.model()[u"apps"_s][u"cards"_s].toArray().size(), 1);  // 富途的那一张,不是 TWS 的
            QCOMPARE(QSettings(rig.ini, QSettings::IniFormat).value(u"access/subtab"_s).toString(), u"futu"_s);
        }
        shell::AccessController again(&rig.bridge, &rig.status, &rig.llm, &rig.actions, rig.ini);
        QCOMPARE(again.sub(), u"futu"_s);
    }

    void futuSwitchPasswordUnlock() {
        Rig rig;
        shell::AccessController page(&rig.bridge, &rig.status, &rig.llm, &rig.actions, rig.ini);
        page.setSub(u"futu"_s);
        page.setVisible(true);
        QTRY_VERIFY(page.model()[u"providers"_s][u"cards"_s].isArray());
        // 换券商:不弹框,直接发
        page.switchBroker(u"futu"_s, u"富途证券(OpenD)"_s);
        QTRY_COMPARE(rig.calls(u"broker.select"_s), 1);
        QCOMPARE(rig.asker.boxes.size(), 0);
        QCOMPARE(rig.params(u"broker.select"_s).first(), u"{\"provider\":\"futu\"}"_s);
        QTRY_COMPARE(rig.status.banner(), u"已切到 富途证券(OpenD)。请在下面点「连接 / 断开交易引擎」重新连接。"_s);
        // 交易密码:空着不发;存完清掉、横幅
        page.saveFutuPassword();
        QTest::qWait(50);
        QCOMPARE(rig.calls(u"futu.set_password"_s), 0);
        page.setFutuPassword(u"pw"_s);
        page.setFutuMd5(true);
        page.saveFutuPassword();
        QVERIFY(page.model()[u"saving"_s].toBool());
        QTRY_COMPARE(rig.calls(u"futu.set_password"_s), 1);
        QTRY_VERIFY(!page.model()[u"saving"_s].toBool());
        QCOMPARE(page.model()[u"password"_s].toString(), QString());
        QCOMPARE(rig.status.banner(), u"交易密码已写入 Keychain(只存 md5)。"_s);
        // 解锁:成了一句;有失败的也说
        page.unlockFutu();
        QTRY_COMPARE(rig.status.banner(), u"已解锁:opend"_s);
        rig.set(u"futu.unlock"_s, QJsonObject{{u"unlocked"_s, QJsonArray{}}, {u"failed"_s, QJsonObject{{u"opend"_s, u"密码不对"_s}}}});
        page.unlockFutu();
        QTRY_COMPARE(rig.status.banner(), u"解锁失败:opend(密码不对)"_s);
    }

    void accountsGoThroughTheShell() {
        Rig rig;
        shell::AccessController page(&rig.bridge, &rig.status, &rig.llm, &rig.actions, rig.ini);
        page.accountsRefreshMs = 50;
        QList<QJsonObject> changes;
        QString nextError;
        QJsonObject nextResult{{u"ok"_s, true}};
        int infos = 0;
        page.accountsInfo = [&] { ++infos; return QJsonObject{{u"placeholders"_s, QJsonArray{}}, {u"connections"_s, QJsonArray{QJsonObject{{u"name"_s, u"paper"_s}, {u"broker"_s, u"ibkr"_s}, {u"port"_s, 7497}}}}}; };
        page.changeAccount = [&](const QJsonObject& c, auto done) { changes << c; done(nextResult, nextError); };
        page.setSub(u"accounts"_s);
        page.setVisible(true);
        QCOMPARE(infos, 1);
        QCOMPARE(page.model()[u"rows"_s].toArray().size(), 2);
        page.openDraft(QString());
        QCOMPARE(page.model()[u"draft"_s][u"connection"_s].toString(), u"paper"_s);
        QVERIFY(!page.model()[u"draft"_s][u"makeDefault"_s].toBool());  // 已经有账户:新加的不默认
        page.setDraft(u"alias"_s, u" 新 "_s);
        page.setDraft(u"accountId"_s, u" DU999 "_s);
        page.saveDraft();
        QCOMPARE(changes.size(), 1);
        QCOMPARE(changes[0], (QJsonObject{{u"action"_s, u"upsert"_s}, {u"alias"_s, u"新"_s}, {u"account_id"_s, u"DU999"_s}, {u"is_paper"_s, true},
                                          {u"connection"_s, u"paper"_s}, {u"make_default"_s, false}}));
        QVERIFY(!page.model()[u"draft"_s].isObject());
        QCOMPARE(rig.status.banner(), u"账户已保存,交易引擎正在重启。"_s);
        QTRY_COMPARE(infos, 2);
        // 修改:带着原来的类别与连接;取消了不说话、表单留着
        page.openDraft(u"主账户"_s);
        QVERIFY(!page.model()[u"draft"_s][u"paper"_s].toBool());
        rig.status.hideBanner();
        nextResult = QJsonObject{{u"ok"_s, false}, {u"canceled"_s, true}};
        page.removeAccount(u"主账户"_s);
        QCOMPARE(changes.last(), (QJsonObject{{u"action"_s, u"remove"_s}, {u"alias"_s, u"主账户"_s}}));
        QVERIFY(page.model()[u"draft"_s].isObject());
        QCOMPARE(rig.status.banner(), QString());
        nextError = u"写不进配置文件"_s;
        page.saveDraft();
        QCOMPARE(rig.status.banner(), u"写不进配置文件"_s);
        QVERIFY(!page.model()[u"busy"_s].toBool());
    }

    void llmSeedsTestsAndSaves() {
        Rig rig;
        shell::AccessController page(&rig.bridge, &rig.status, &rig.llm, &rig.actions, rig.ini);
        page.setSub(u"llm"_s);
        page.setVisible(true);
        QTRY_COMPARE(page.model()[u"provider"_s].toString(), u"anthropic"_s);
        QCOMPARE(page.model()[u"model"_s].toString(), u"claude-opus-5"_s);
        QCOMPARE(page.model()[u"maxTokens"_s].toDouble(), 8000.0);
        // 改了还没存的模型名:同一份目录再读一次不冲掉
        page.setLlm(u"customModel"_s, u"my-model"_s);
        rig.llm.load();
        QTRY_COMPARE(rig.calls(u"llm.catalog"_s), 2);
        QTest::qWait(60);
        QCOMPARE(page.model()[u"customModel"_s].toString(), u"my-model"_s);
        // 换供应商:按那一家的默认值重填
        page.setLlm(u"provider"_s, u"openai_compatible"_s);
        QCOMPARE(page.model()[u"model"_s].toString(), u"deepseek-chat"_s);
        QCOMPARE(page.model()[u"baseUrl"_s].toString(), u"https://api.deepseek.com/v1"_s);
        page.setLlm(u"provider"_s, u"anthropic"_s);
        // 数字框不合规:先说,不发
        page.setLlm(u"maxTokens"_s, 500);
        page.testLlm();
        QCOMPARE(rig.status.banner(), u"max_tokens 至少 1000,先把它填上"_s);
        QVERIFY(rig.status.bannerInfo());
        page.setLlm(u"maxTokens"_s, 9000);
        page.setLlm(u"apiKey"_s, u" sk-new "_s);
        page.testLlm();
        QTRY_VERIFY(!page.model()[u"testing"_s].toBool());
        QCOMPARE(rig.params(u"llm.test"_s).first(),
                 u"{\"api_key\":\"sk-new\",\"llm\":{\"effort\":\"high\",\"max_tokens\":9000,\"model\":\"claude-opus-5\",\"provider\":\"anthropic\",\"timeout_s\":60}}"_s);
        QCOMPARE(page.model()[u"test"_s][u"card"_s][u"tone"_s].toString(), u"ok"_s);
        page.saveLlm();
        QTRY_COMPARE(rig.calls(u"llm.patch"_s), 1);
        QCOMPARE(rig.params(u"llm.patch"_s).first(), u"{\"llm\":{\"effort\":\"high\",\"max_tokens\":9000,\"model\":\"claude-opus-5\",\"provider\":\"anthropic\",\"timeout_s\":60}}"_s);
        QTRY_COMPARE(rig.status.banner(), u"模型配置已保存,提示词与解析引擎已重建。"_s);
        page.saveLlmKey();
        QTRY_COMPARE(rig.calls(u"keychain.set"_s), 1);
        QCOMPARE(rig.params(u"keychain.set"_s).first(), u"{\"provider\":\"anthropic\",\"secret\":\"sk-new\"}"_s);
        QTRY_COMPARE(page.model()[u"apiKey"_s].toString(), QString());
    }

    void followLoadsClosesAndSaves() {
        Rig rig;
        shell::AccessController page(&rig.bridge, &rig.status, &rig.llm, &rig.actions, rig.ini);
        page.setSub(u"follow"_s);
        page.setVisible(true);
        QVERIFY(page.model()[u"loading"_s].toBool());
        QTRY_VERIFY(page.model()[u"link"_s].isObject());
        // 引擎报 follow:重读,填到一半的表单不动
        page.setFollow(u"perDay"_s, 7);
        page.onEngineEvent(u"follow"_s, QJsonObject{});
        QTRY_COMPARE(rig.calls(u"follow.status"_s), 2);
        QTest::qWait(60);
        QCOMPARE(page.model()[u"perDay"_s].toDouble(), 7.0);
        QVERIFY(page.model()[u"dirty"_s].toBool());
        // 关:当场 settings.patch,只带 enabled = false
        page.setFollowEnabled(false);
        QTRY_COMPARE(rig.calls(u"settings.patch"_s), 1);
        QCOMPARE(rig.params(u"settings.patch"_s).first(), u"{\"patch\":{\"follow\":{\"enabled\":false}}}"_s);
        QTRY_COMPARE(rig.status.banner(), u"已关闭自动跟单,当场生效。频道照常在听,只观察、不发单。"_s);
        // 有毛病:不发,说第一处与另有几处
        page.setFollow(u"maxAge"_s, QVariant());
        page.setFollow(u"trackExitAt"_s, u"99"_s);
        page.saveFollow();
        QCOMPARE(rig.status.banner(), u"还不能保存:到点平仓的钟点要写成美东时间的 HH:MM(如 15:45),或者空着(另有 1 处)"_s);
        QCOMPARE(page.model()[u"problems"_s].toArray().size(), 2);
        QCOMPARE(rig.calls(u"settings.patch"_s), 1);
        // 开着保存:不弹框,带着整份
        page.setFollow(u"maxAge"_s, 30);
        page.setFollow(u"trackExitAt"_s, u"15:45"_s);
        page.setFollowEnabled(true);
        page.saveFollow();
        QTRY_COMPARE(rig.calls(u"settings.patch"_s), 2);
        QCOMPARE(rig.asker.boxes.size(), 0);
        QVERIFY(rig.params(u"settings.patch"_s).last().contains(u"\"max_orders_per_day\":7"_s));
        QTRY_COMPARE(rig.status.banner(), u"已保存:自动跟单开着。"_s);
        // token:空着不发;存完清掉
        page.setFollowToken(u" tok "_s);
        page.saveFollowToken();
        QTRY_COMPARE(rig.calls(u"follow.set_token"_s), 1);
        QCOMPARE(rig.params(u"follow.set_token"_s).first(), u"{\"token\":\"tok\"}"_s);
        QTRY_COMPARE(page.model()[u"token"_s].toString(), QString());
        // 信任:从「手动添加」框加,框清掉;形状不对的加不进去
        page.setNewAuthor(u"local:新人"_s);
        QVERIFY(page.model()[u"canAdd"_s].toBool());
        page.addAuthor(QString());
        QCOMPARE(page.model()[u"newAuthor"_s].toString(), QString());
        QCOMPARE(page.model()[u"authors"_s].toArray().last()[u"id"_s].toString(), u"local:新人"_s);
        page.removeAuthor(u"local:新人"_s);
        page.setNewAuthor(u"12"_s);
        QVERIFY(!page.model()[u"canAdd"_s].toBool());
        // 账户勾选:次序跟着选项
        page.toggleFollowAccount(u"主账户"_s, true);
        page.toggleFollowAccount(u"模拟"_s, true);
        QCOMPARE(page.model()[u"accounts"_s][0][u"checked"_s].toBool(), true);
    }
};

QTEST_GUILESS_MAIN(TestAccessController)
#include "tst_access_controller.moc"
