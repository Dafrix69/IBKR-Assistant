// 「设置」与「关于」的接线(shell/settings_controller、about_controller,照 pages/Settings.tsx、About.tsx):对着假引擎与真的 Bridge。
//   · 设置:进来读设置与备份清单;晚到的回包不落地;执行闸门关是当场生效的(只送那一个 false、失败拨回去),开只改表单;
//     保存:有毛病不发、横幅说第一条;打开闸门各过一个确认框(取消拨回去、不存);放宽限额过 limits.loosen(取消不存);
//     发出去的补丁就是 toPatch 的那一份;重要事件的口径防抖存、开关当场存、离开页面补存、失败横幅;立即备份、恢复交给壳;
//   · 关于:版本信息与自检、读不到的说法;更新一节跟着 UpdateStore;引擎日志只留 200 行;支持一节的几个动作。
#include "shell/about_controller.h"
#include "shell/bridge.h"
#include "shell/consent.h"
#include "shell/engine_command.h"
#include "shell/events_store.h"
#include "shell/settings_controller.h"
#include "shell/settings_rules.h"
#include "shell/status_store.h"
#include "shell/update_store.h"
#include "shell_harness.h"

#include <QJsonArray>
#include <QTemporaryDir>

using namespace ibkr;
using namespace ibkr::test;
using namespace Qt::StringLiterals;

namespace {

QJsonObject settingsSeed(const QString& page) {
    static const QJsonObject j = [] {
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/settings.json"));
        if (!f.open(QIODevice::ReadOnly)) qFatal("settings.json 打不开");
        return QJsonDocument::fromJson(f.readAll()).object();
    }();
    for (const QJsonValue& p : j[u"settings"_s].toArray())
        if (p[u"name"_s].toString() == page) return p[u"seed"_s].toObject();
    qFatal("settings.json 里没有 %s", qPrintable(page));
}

struct Rig {
    QTemporaryDir dir;
    QString resultsPath = dir.filePath(u"results.json"_s);
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
    shell::EventsStore events{&bridge, &status};
    QJsonObject results;
    QJsonObject saved = settingsSeed(u"预览"_s)[u"settings"_s].toObject()[u"saved"_s].toObject();
    QJsonObject backups = settingsSeed(u"预览"_s)[u"data"_s].toObject()[u"info"_s].toObject();
    QJsonObject eventsCfg = settingsSeed(u"预览"_s)[u"eventscfg"_s].toObject()[u"draft"_s].toObject();

    explicit Rig(const QString& delays = {})
        : engine(fakeEngine({{u"FAKE_STATUS"_s, u"{\"broker_connected\":true}"_s}, {u"FAKE_LOG_PARAMS"_s, u"1"_s}, {u"FAKE_RESULTS_FILE"_s, resultsPath},
                             {u"FAKE_DELAY_METHODS"_s, delays}}),
                 40) {
        QObject::connect(&engine, &shell::EngineClient::logLine, [this](const QString& l) { logs.append(l); });
        QString error;
        if (!consent.accept(QLatin1StringView(shell::kTermsVersion), u"test"_s, 1'000, &error)) qFatal("%s", qPrintable(error));
        set(u"settings.get"_s, saved);
        set(u"settings.patch"_s, saved);
        set(u"data.backups"_s, backups);
        set(u"data.backup"_s, QJsonObject{{u"backup"_s, QJsonObject{{u"name"_s, u"trades-20261019-090000-manual.db"_s}, {u"bytes"_s, 1843200}}}});
        set(u"events.list"_s, QJsonObject{{u"config"_s, eventsCfg}, {u"events"_s, QJsonArray{}}});
        set(u"events.set_config"_s, QJsonObject{{u"config"_s, eventsCfg}});
        set(u"system.selftest"_s, QJsonObject{{u"prompt_version"_s, u"v1.8.0"_s}, {u"prompt_fingerprint"_s, u"a3f9c1"_s}, {u"system_prompt_chars"_s, 8421},
                                             {u"fewshot_pairs"_s, 7}, {u"accounts"_s, QJsonArray{}}});
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
    QJsonObject lastParams(const QString& method) const {
        for (qsizetype i = logs.size() - 1; i >= 0; --i)
            if (logs[i].startsWith(u"[fake] "_s + method + u' ')) return QJsonDocument::fromJson(logs[i].mid(8 + method.size()).toUtf8()).object();
        return {};
    }
};

}  // namespace

class TestSettingsController : public QObject {
    Q_OBJECT
private slots:
    void loadsAndDropsLateReplies() {
        Rig rig(u"settings.get=600"_s);
        shell::SettingsController page(&rig.bridge, &rig.status, &rig.events);
        QVERIFY(page.model()[u"loading"_s].toBool());
        page.setVisible(true);
        QTRY_COMPARE(page.model()[u"data"_s].toObject()[u"state"_s].toString(), u"ready"_s);
        QCOMPARE(page.model()[u"data"_s].toObject()[u"rows"_s].toArray().size(), 3);
        QVERIFY(page.model()[u"loading"_s].toBool());  // 设置还在路上
        QTRY_VERIFY(!page.model()[u"loading"_s].toBool());
        QCOMPARE(page.model()[u"gates"_s].toArray()[0].toObject()[u"checked"_s].toBool(), true);
        QVERIFY(!page.model()[u"dirty"_s].toBool());
        // 走开之后才回来的读设置:不落地
        page.setVisible(false);
        page.setVisible(true);
        page.setVisible(false);
        QTest::qWait(800);
        QVERIFY(page.model()[u"loading"_s].toBool());
        // 引擎报 settings:重读
        page.setVisible(true);
        QTRY_VERIFY(!page.model()[u"loading"_s].toBool());
        const int before = rig.calls(u"settings.get"_s);
        page.onEngineEvent(u"settings"_s);
        QTRY_COMPARE(rig.calls(u"settings.get"_s), before + 1);
        // 读不到:横幅
        rig.set(u"data.backups"_s, QJsonObject{{u"__error"_s, u"引擎没起来"_s}});
        page.loadBackups();
        QTRY_COMPARE(page.model()[u"data"_s].toObject()[u"state"_s].toString(), u"error"_s);
        QCOMPARE(page.model()[u"data"_s].toObject()[u"error"_s].toString(), u"引擎没起来"_s);
    }

    void saveChecksAndSendsThePatch() {
        Rig rig;
        shell::SettingsController page(&rig.bridge, &rig.status, &rig.events);
        page.setVisible(true);
        QTRY_VERIFY(!page.model()[u"loading"_s].toBool());
        // 有毛病:不问、不发,横幅说第一条,问题清单摆出来
        page.setField(u"notional"_s, QVariant());
        page.setField(u"dupe"_s, QVariant());
        page.save();
        QCOMPARE(rig.status.banner(), u"还不能保存:「单笔名义金额上限」要填一个大于 0 的数(另有 1 处)"_s);
        QCOMPARE(page.model()[u"problems"_s].toArray().size(), 2);
        QVERIFY(rig.asker.boxes.isEmpty());
        // 两个账户都有问题:横幅先说账户表里排在前面的那个(原版 Object.entries 的次序),不是按字母
        page.setField(u"notional"_s, 4000);
        page.setField(u"dupe"_s, 10);
        page.setAccountLimit(u"模拟"_s, u"notional"_s, -1);
        page.setAccountLimit(u"主账户"_s, u"notional"_s, -1);
        page.save();
        QCOMPARE(rig.status.banner(), u"还不能保存:「模拟」的单笔名义金额上限要大于 0;想用全局的就空着(另有 1 处)"_s);
        page.setAccountLimit(u"模拟"_s, u"notional"_s, QVariant());
        page.setAccountLimit(u"主账户"_s, u"notional"_s, 2000);
        // 放宽单笔金额(5000 → 8000)也不弹框:发出去的就是 toPatch 那一份
        page.setField(u"notional"_s, 8000);
        page.setField(u"slGuard"_s, true);
        page.setField(u"coolScope"_s, u"position"_s);
        page.setAccountLimit(u"主账户"_s, u"notional"_s, QVariant());
        QJsonObject form = shell::settings::toForm(rig.saved);
        form[u"notional"_s] = 8000;
        form[u"slGuard"_s] = true;
        form[u"coolScope"_s] = u"position"_s;
        QJsonObject by = form[u"byAccount"_s].toObject();
        QJsonObject main = by[u"主账户"_s].toObject();
        main[u"notional"_s] = QJsonValue::Null;
        by[u"主账户"_s] = main;
        form[u"byAccount"_s] = by;
        page.save();
        QTRY_COMPARE(rig.calls(u"settings.patch"_s), 1);
        const QJsonObject sent = rig.lastParams(u"settings.patch"_s);
        QCOMPARE(sent[u"patch"_s].toObject(), shell::settings::toPatch(form, rig.saved));
        QVERIFY(!sent.contains(u"__confirmed"_s));
        QCOMPARE(sent[u"patch"_s][u"limits"_s][u"by_account"_s][u"主账户"_s][u"max_order_notional"_s], QJsonValue(QJsonValue::Null));
        QTRY_COMPARE(rig.status.banner(), u"设置已保存,提示词与限额已同步更新。"_s);
        QVERIFY(rig.status.bannerInfo());
        QVERIFY(rig.asker.boxes.isEmpty());
        QTRY_VERIFY(!page.model()[u"saving"_s].toBool());
        QCOMPARE(page.model()[u"problems"_s].toArray().size(), 0);
        // 保存失败:配置未改动
        rig.set(u"settings.patch"_s, QJsonObject{{u"__error"_s, u"写不进去"_s}});
        page.setField(u"triggerVerify"_s, false);
        page.save();
        QTRY_COMPARE(rig.status.banner(), u"保存失败(配置未改动):写不进去"_s);
        QTRY_VERIFY(!page.model()[u"saving"_s].toBool());
    }

    void eventsDebounceAndFlushOnLeave() {
        Rig rig;
        rig.events.load();
        QTRY_VERIFY(!rig.events.config().isEmpty());
        shell::SettingsController page(&rig.bridge, &rig.status, &rig.events);
        page.eventsDebounceMs = 120;
        page.setVisible(true);
        QVERIFY(page.model()[u"events"_s].isArray());
        // 数字框:防抖合并成一次
        page.setEvent(u"min_stars"_s, 3);
        page.setEvent(u"sector_share"_s, 70);
        page.setEvent(u"lead2"_s, QVariant());
        QTest::qWait(60);
        QCOMPARE(rig.calls(u"events.set_config"_s), 0);
        QTRY_COMPARE(rig.calls(u"events.set_config"_s), 1);
        QCOMPARE(rig.lastParams(u"events.set_config"_s)[u"config"_s].toObject(),
                 (QJsonObject{{u"min_stars"_s, 3}, {u"sector_share"_s, 0.7}, {u"lead_minutes"_s, QJsonArray{60}}}));
        // 清空了的那几格不算数
        page.setEvent(u"cross_lag_pct"_s, QVariant());
        QTest::qWait(250);
        QCOMPARE(rig.calls(u"events.set_config"_s), 1);
        // 开关当场存
        page.setEvent(u"feed"_s, false);
        QTRY_COMPARE(rig.calls(u"events.set_config"_s), 2);
        QCOMPARE(rig.lastParams(u"events.set_config"_s)[u"config"_s].toObject(), (QJsonObject{{u"feed"_s, false}}));
        // 离开页面:没存的补存
        page.setEvent(u"sector_min_stocks"_s, 5);
        page.setVisible(false);
        QTRY_COMPARE(rig.calls(u"events.set_config"_s), 3);
        QCOMPARE(rig.lastParams(u"events.set_config"_s)[u"config"_s].toObject(), (QJsonObject{{u"sector_min_stocks"_s, 5}}));
        // 失败:横幅
        page.setVisible(true);
        rig.set(u"events.set_config"_s, QJsonObject{{u"__error"_s, u"最低星级要在 1 到 5 之间"_s}});
        page.setEvent(u"enabled"_s, false);
        QTRY_COMPARE(rig.status.banner(), u"没改成:最低星级要在 1 到 5 之间"_s);
    }

    void backups() {
        Rig rig;
        shell::SettingsController page(&rig.bridge, &rig.status, &rig.events);
        page.restoreRefreshMs = 50;
        QStringList restored, revealed;
        bool ok = true;
        page.restore = [&](const QString& name, std::function<void(const QJsonObject&, const QString&)> done) {
            restored << name;
            ok ? done(QJsonObject{{u"ok"_s, true}}, {}) : done({}, u"库文件被占用"_s);
        };
        page.revealPath = [&](const QString& kind, std::function<void(const QJsonObject&, const QString&)> done) {
            revealed << kind;
            done({}, {});
        };
        page.setVisible(true);
        QTRY_COMPARE(page.model()[u"data"_s].toObject()[u"state"_s].toString(), u"ready"_s);
        page.backupNow();
        QVERIFY(page.model()[u"data"_s].toObject()[u"backupLoading"_s].toBool());
        QTRY_COMPARE(rig.status.banner(), u"已备份:trades-20261019-090000-manual.db(1.8 MB)"_s);
        QTRY_VERIFY(!page.model()[u"data"_s].toObject()[u"backupLoading"_s].toBool());
        const int lists = rig.calls(u"data.backups"_s);
        page.restoreBackup(u"trades-20260927-010500-daily.db"_s);
        QCOMPARE(restored, QStringList{u"trades-20260927-010500-daily.db"_s});
        QCOMPARE(rig.status.banner(), u"交易库已恢复,交易引擎正在重启。请核对追踪与挂单状态。"_s);
        QTRY_COMPARE(rig.calls(u"data.backups"_s), lists + 1);
        ok = false;
        page.restoreBackup(u"trades-20260927-010500-daily.db"_s);
        QCOMPARE(rig.status.banner(), u"恢复没有成功:库文件被占用"_s);
        page.reveal(u"backups"_s);
        page.reveal(u"logs"_s);  // 这一页只开配置与备份
        QCOMPARE(revealed, QStringList{u"backups"_s});
    }
};

class TestAboutController : public QObject {
    Q_OBJECT
private slots:
    void loadsUpdatesLogsAndSupport() {
        Rig rig;
        QTemporaryDir dir;
        QList<bool> asked;
        shell::UpdateStore updates([&](bool force, shell::UpdateStore::Done done) {
            asked << force;
            done(QJsonObject{{u"current"_s, u"0.5.2"_s}, {u"latest"_s, u"0.5.3"_s}, {u"newer"_s, true}, {u"url"_s, u"https://x/r"_s}, {u"download"_s, QJsonValue::Null},
                             {u"publishedAt"_s, QJsonValue::Null}, {u"notes"_s, u"n"_s}, {u"checkedAt"_s, 1}},
                 {});
        }, dir.filePath(u"qt-settings.ini"_s));
        shell::AboutController page(&rig.bridge, &rig.status, &updates);
        int restarts = 0, terms = 0;
        QStringList revealed, opened;
        page.appInfo = [] { return QJsonObject{{u"version"_s, u"0.5.2"_s}, {u"qt"_s, u"6.12.0"_s}, {u"configPath"_s, u"c"_s}}; };
        page.restart = [&] { ++restarts; };
        page.restartRefreshMs = 50;
        page.exportDiag = [](shell::AboutController::Done done) { done(QJsonObject{{u"ok"_s, true}}, {}); };
        page.copyDiag = [](shell::AboutController::Done done) { done({}, u"剪贴板不可用"_s); };
        page.revealPath = [&](const QString& kind, shell::AboutController::Done done) { revealed << kind; done({}, {}); };
        page.terms = [&] { ++terms; };
        page.openUrl = [&](const QString& url) { opened << url; return true; };
        for (int i = 0; i < 205; ++i) page.appendLog(u"line %1"_s.arg(i));
        page.setVisible(true);
        QVERIFY(page.model()[u"loading"_s].toBool());
        QTRY_VERIFY(!page.model()[u"loading"_s].toBool());
        const QJsonArray rows = page.model()[u"rows"_s].toArray();
        QCOMPARE(rows[0].toObject()[u"value"_s].toString(), u"0.5.2"_s);
        QCOMPARE(rows[1].toObject()[u"label"_s].toString(), u"Qt"_s);
        QVERIFY(page.model()[u"log"_s].toString().startsWith(u"line 5\n"_s));
        QCOMPARE(page.model()[u"log"_s].toString().count(u'\n'), 199);
        // 更新
        QCOMPARE(page.model()[u"update"_s][u"sub"_s].toString(), u"还没检查过"_s);
        page.checkUpdate();
        QCOMPARE(asked, QList<bool>{true});
        QCOMPARE(page.model()[u"update"_s][u"sub"_s].toString(), u"有新版本 0.5.3"_s);
        QCOMPARE(page.model()[u"update"_s][u"buttons"_s].toArray()[0][u"text"_s].toString(), u"去发布页下载"_s);
        page.dismissUpdate(u"0.5.3"_s);
        QCOMPARE(page.model()[u"update"_s][u"buttons"_s].toArray().size(), 2);  // 「忽略这一版」没了
        page.setAutoUpdate(false);
        QCOMPARE(page.model()[u"update"_s][u"auto"_s].toBool(), false);
        // 支持
        page.exportDiagnostics();
        QCOMPARE(rig.status.banner(), u"诊断信息已导出,发出去之前建议自己先看一遍。"_s);
        QVERIFY(!page.model()[u"supportBusy"_s].toBool());
        page.copyDiagnostics();
        QCOMPARE(rig.status.banner(), u"剪贴板不可用"_s);
        page.reveal(u"notices"_s);
        page.reveal(u"backups"_s);  // 这一页不开备份目录
        QCOMPARE(revealed, QStringList{u"notices"_s});
        page.showTerms();
        QCOMPARE(terms, 1);
        page.openLink(u"https://www.tradingview.com/"_s);
        QCOMPARE(opened, QStringList{u"https://www.tradingview.com/"_s});
        // 重启:交给壳,过一会儿重读自检
        const int before = rig.calls(u"system.selftest"_s);
        page.restartEngine();
        QCOMPARE(restarts, 1);
        QTRY_COMPARE(rig.calls(u"system.selftest"_s), before + 1);
        // 自检读不到
        page.setVisible(false);
        rig.set(u"system.selftest"_s, QJsonObject{{u"__error"_s, u"引擎没起来"_s}});
        page.setVisible(true);
        QTRY_COMPARE(page.model()[u"error"_s].toString(), u"读取失败:引擎没起来"_s);
    }
};

int main(int argc, char** argv) {
    QCoreApplication app(argc, argv);
    int status = 0;
    {
        TestSettingsController t;
        status |= QTest::qExec(&t, argc, argv);
    }
    {
        TestAboutController t;
        status |= QTest::qExec(&t, argc, argv);
    }
    return status;
}
#include "tst_settings_controller.moc"
