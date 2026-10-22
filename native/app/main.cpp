// Datrix 的 Qt Quick 界面。阶段 1:接现在的 TS 引擎(docs/briefs/qt-rewrite.md)。
//
// 接过来的 Electron 主进程职责(desktop/main.js、rpc-client.js、store/status.ts),在 native/shell/:
// 引擎的生与死(配置 / 交易库坏了不重启、别的退避重启、心跳、条件单轮询)、状态快照、单实例。页面从这里往后一页页搬。
//
//   Datrix [--engine ts|native|preview|none] [--config 配置] [--ts-engine-root engine-ts 目录] [--native-engine ibkr-engine]
//   Datrix --smoke-test     # 不拉引擎;窗口建出来、真的画完第一帧就退出(测试与 CI 用);15 秒画不出来退出码 4
//
// 配置的找法同 Electron 版开发时:--config → 环境变量 DAFRI_CONFIG → 仓库里的 config/settings.json(真配置:连 TWS、真的交易库)。
// Electron 版开着时不拉引擎(两个引擎会同时盯同一个交易库),见 shell/instance_guard.h。
#include "native_prompter.h"
#include "desktop_shell.h"
#include "support_service.h"
#include "fatal_dialogs.h"
#include "icon_provider.h"
#include "text_dump.h"
#include "platform.h"
#include "popup_controller.h"
#include "power_controller.h"
#include "qml_bridge.h"
#include "shell/bridge.h"
#include "shell/consent.h"
#include "shell/consent_model.h"
#include "shell/alerter.h"
#include "shell/alerts_store.h"
#include "shell/spot_store.h"
#include "shell/feed_stores.h"
#include "shell/update_store.h"
#include "shell/tracker_controller.h"
#include "shell/llm_store.h"
#include "shell/trade_composer.h"
#include "shell/trade_controller.h"
#include "shell/fly_controller.h"
#include "shell/fly_store.h"
#include "shell/board_controller.h"
#include "shell/records_controller.h"
#include "shell/market_controller.h"
#include "shell/ideas_controller.h"
#include "shell/backtest_controller.h"
#include "shell/review_controller.h"
#include "shell/performance_controller.h"
#include "shell/intel_controller.h"
#include "shell/access_controller.h"
#include "shell/settings_controller.h"
#include "shell/about_controller.h"
#include "shell/ordered_json.h"
#include "shell/screener_controller.h"
#include "shell/sectors_controller.h"
#include "shell/sectors_store.h"
#include "escape_watcher.h"
#include "dev_charts.h"
#include "shell/order_stores.h"
#include "shell/tracker_store.h"
#include "shell/log_file.h"
#include "shell/popup_rules.h"
#include "shell/rpc_policy.h"
#include "shell/events_store.h"
#include "shell/macro_store.h"
#include "shell/shell_actions.h"
#include "shell/engine_client.h"
#include "shell/engine_supervisor.h"
#include "shell/instance_guard.h"
#include "shell/status_store.h"

#include <QCommandLineParser>
#include <QApplication>
#include <QDir>
#include <QQmlApplicationEngine>
#include <QFile>
#include <QFileInfo>
#include <QUrl>
#include <QWindow>
#include <QPushButton>
#include <QMessageBox>
#include <QClipboard>
#include <QImage>
#include <QDesktopServices>
#include <QFileDialog>
#include <QQuickWindow>
#include <QFont>
#include <QFontMetricsF>
#include <QSettings>
#include <QStandardPaths>
#include <QTimer>

#include <cstdio>

using namespace ibkr;
using namespace Qt::StringLiterals;

namespace {

QString firstNonEmpty(std::initializer_list<QString> candidates) {
    for (const QString& c : candidates)
        if (!c.isEmpty()) return c;
    return {};
}

}  // namespace

int main(int argc, char* argv[]) {
    // 无窗口平台(截图、对比、测试)默认按 96 DPI 排字;macOS 的窗口是 72(一个逻辑点 = 一个像素)。
    // 系统字体按点数定字距(小字号字距放宽),96 DPI 下 12px 的字被当成 9pt 去取,拉丁字母和数字宽 3%,
    // 截出来的图就不是真机上的样子。没人指定时,无窗口平台也按 72 排
    if (qEnvironmentVariable("QT_QPA_PLATFORM") == u"offscreen" && !qEnvironmentVariableIsSet("QT_FONT_DPI")) qputenv("QT_FONT_DPI", "72");
    // QApplication(不是 QGuiApplication):原生的确认框要 Widgets
    QApplication app(argc, argv);
    QApplication::setApplicationName(u"Datrix"_s);
    // QML 的 Settings 要它(没有就拒绝工作);落盘的位置在下面改到 userData 里:userData/Dafri/Datrix.ini
    QApplication::setOrganizationName(u"Dafri"_s);
    // 系统补进 macOS 应用菜单的那几项(服务、隐藏…)要中文名;Homebrew 的 Qt 不带翻译包
    app::MenuTranslator menuTranslator;
    QCoreApplication::installTranslator(&menuTranslator);

    QCommandLineParser cli;
    cli.addHelpOption();
    const QCommandLineOption smokeOption(u"smoke-test"_s, u"不拉引擎,画完第一帧就退出"_s);
    const QCommandLineOption engineOption(u"engine"_s, u"拉哪个引擎:ts(默认)、native、none"_s, u"kind"_s, u"ts"_s);
    const QCommandLineOption configOption(u"config"_s, u"配置文件"_s, u"path"_s);
    const QCommandLineOption tsRootOption(u"ts-engine-root"_s, u"engine-ts 目录(含 dist/src/cli.js)"_s, u"dir"_s);
    const QCommandLineOption dumpOption(u"dump-texts"_s, u"截图时顺带把看得见的每一段字(内容、在窗口里的位置、字号字重、颜色)写成 JSON(和 React 版对排版用)"_s, u"json"_s);
    const QCommandLineOption shotOption(u"screenshot"_s, u"引擎回了状态、画好之后抓一张 PNG 就退出(对比用)"_s, u"png"_s);
    const QCommandLineOption nativeOption(u"native-engine"_s, u"C++ 引擎 ibkr-engine 的路径"_s, u"path"_s);
    const QCommandLineOption openOption(u"open"_s, u"截图前先打开:all = 重要事件的「全部」,act = 第一条事件的「应对」,popup = 提醒小窗,page:<页>[@y] = 切到那一页再滚到 y(截图对比用)"_s, u"what"_s);
    const QCommandLineOption quitAfterOption(u"quit-after"_s, u"这么多毫秒后按 ⌘Q 那条路退出(测试退出的收尾用)"_s, u"ms"_s);
    const QCommandLineOption schemeOption(u"color-scheme"_s, u"light 或 dark:不跟系统,按这个画(截图对比用)"_s, u"scheme"_s);
    cli.addOptions({smokeOption, engineOption, configOption, tsRootOption, nativeOption, shotOption, dumpOption, schemeOption, openOption, quitAfterOption});
    cli.process(app);

    const bool smoke = cli.isSet(smokeOption);
    // 自检一律不拉引擎:测试与 CI 里绝不能顺手按真配置连 TWS、开真的交易库
    // 图表样例(--open chart:<n>)只放 fixtures 里的场景:没说用哪个引擎就用预览台的,别顺手按真配置拉起交易引擎
    const bool chartFixture = cli.value(openOption).startsWith(u"chart:"_s);
    const QString engineKind = smoke ? u"none"_s : chartFixture && !cli.isSet(engineOption) ? u"preview"_s : cli.value(engineOption);
    if (engineKind != u"ts" && engineKind != u"native" && engineKind != u"none" && engineKind != u"preview") {
        std::fprintf(stderr, "--engine 只认 ts、native、preview、none(收到 %s)\n", qPrintable(engineKind));
        return 2;
    }
    const QString repo = QStringLiteral(IBKR_REPO_DIR);
    const QString configPath = firstNonEmpty({cli.value(configOption), qEnvironmentVariable("DAFRI_CONFIG"), QDir(repo).filePath(u"config/settings.json"_s)});
    const QString tsRoot = firstNonEmpty({cli.value(tsRootOption), qEnvironmentVariable("IBKR_TS_ENGINE_ROOT"), QDir(repo).filePath(u"engine-ts"_s)});
    const QString nativePath = firstNonEmpty({cli.value(nativeOption), QStringLiteral(IBKR_NATIVE_ENGINE_PATH)});

    // 第一次打开:配置还没有,从示例建一份(main.js 的 ensureConfigExists)。只在要拉真引擎时做;自检、预览不碰配置
    bool configCreated = false;
    if ((engineKind == u"ts" || engineKind == u"native") && !QFile::exists(configPath)) {
        const QString example = QDir(repo).filePath(u"config/settings.example.json"_s);
        if (QFile::exists(example)) {
            QDir().mkpath(QFileInfo(configPath).absolutePath());
            if (!QFile::copy(example, configPath)) {
                // 数据目录写不进去(权限、磁盘满):不是一个默不作声的失败
                QMessageBox::critical(nullptr, u"Datrix 无法启动"_s,
                                      u"写不进配置文件:%1\n\n请检查这个文件夹的权限与磁盘剩余空间后重试。"_s.arg(configPath));
                return 1;
            }
            configCreated = true;
        }
    }

    shell::EngineResolver resolver;
    if (engineKind == u"native") {
        resolver = [nativePath, configPath] { return shell::resolveNativeEngine(nativePath, configPath); };
    } else if (engineKind == u"preview") {
        resolver = [repo] { return shell::resolvePreviewEngine(repo); };
    } else if (engineKind == u"ts") {
        resolver = [tsRoot, configPath] { return shell::resolveTsEngine({tsRoot, configPath, {}}); };
    }

    const QString userDataDir = shell::electronUserDataDirs().first();
    // QML 的 Settings(侧栏折叠、当前页)不给 location 时用 QSettings 的默认位置——macOS 上是 ~/Library/Preferences 的 plist,
    // 不跟 IBKR_USER_DATA_DIR 走,截图与自检会读写用户那份真偏好。默认位置改成 userData 下的 ini
    QSettings::setDefaultFormat(QSettings::IniFormat);
    QSettings::setPath(QSettings::IniFormat, QSettings::UserScope, userDataDir);
    // 同一份 userData 已经开着一个 Qt 版:叫它到前台,自己退出(同 Electron 的 requestSingleInstanceLock + second-instance)。
    // 自检不查:测试与 CI 里不能去碰用户正开着的那一个
    if (!smoke && app::DesktopShell::handOffToRunningInstance(userDataDir)) {
        std::printf("已经开着一个,叫它到前台\n");
        return 0;
    }

    // 日志落盘(同 Electron 版的 electron-log):userData/logs/qt-main.log,4 MB 一份、留一份旧的,落盘前脱敏
    shell::LogFile logFile(QDir(userDataDir).filePath(u"logs/qt-main.log"_s));
    logFile.refreshRedactorFromConfig(configPath);
    shell::LogFile::installMessageHandler(&logFile);
    // 先于 logFile 析构:QApplication 比它活得久,收尾时的 qWarning 不能落到一个已经没了的对象上
    const struct Unhook { ~Unhook() { shell::LogFile::installMessageHandler(nullptr); } } unhook;
    logFile.info(u"[boot] Datrix(Qt)%1 启动,引擎 %2"_s.arg(QCoreApplication::applicationVersion(), engineKind));

    shell::EngineClient engine(resolver);
    // 引擎 stderr 也落盘:界面只留最近几行,崩溃前那几行往往在更早
    QObject::connect(&engine, &shell::EngineClient::logLine, &engine, [&logFile](const QString& line) { logFile.info(u"[engine] "_s + line); });
    // 配置可能刚改过账号:引擎每次起来(ready)按配置里现在写着的账号重建脱敏器
    QObject::connect(&engine, &shell::EngineClient::engineEvent, &engine, [&logFile, configPath](const QString& name, const QJsonValue&) {
        if (name == u"ready") logFile.refreshRedactorFromConfig(configPath);
    });
    QObject::connect(&engine, &shell::EngineClient::lateReply, &engine, [&logFile](const shell::LateReply& late) {
        if (!shell::outcomeUnknownRpc().contains(late.method)) return;  // 同 main.js:只记"结果不明"的那几种
        logFile.warn(u"[engine] 迟到的回执 %1(%2s):%3"_s.arg(late.method).arg(late.waitedMs / 1000).arg(late.ok ? u"已执行"_s : late.error));
    });
    shell::EngineSupervisor supervisor(&engine);
    shell::StatusStore store(&engine);
    QObject::connect(&supervisor, &shell::EngineSupervisor::engineExited, &store, [&store, &logFile](const shell::EngineExit& info, int restartInMs) {
        logFile.error(u"[engine] 已退出(退出码 %1):%2"_s.arg(info.code).arg(info.detail));
        if (restartInMs >= 0) logFile.warn(u"[engine] %1 秒后自动重启"_s.arg(restartInMs / 1000.0));
        if (restartInMs >= 0) store.engineExited({}, info.detail);
    });
    QObject::connect(&supervisor, &shell::EngineSupervisor::fatal, &store, [&logFile](const QString& kind, const QString& message) {
        logFile.error(u"[engine] 不再自动重启(%1):%2"_s.arg(kind, message));
    });
    QObject::connect(&supervisor, &shell::EngineSupervisor::fatal, &store, &shell::StatusStore::engineExited);
    // 页面到引擎的唯一一条路:白名单、确认标记、条款、确认凭据(shell/bridge.h)。
    // 条款同意记在 Electron 版同一个 userData 目录里:在哪一版里同意过,另一版也认
    app::NativePrompter prompter;
    shell::ConsentStore consent(shell::electronUserDataDirs().first());
    shell::Bridge bridge(&engine, &prompter, &consent);
    // 退出:不再自动拉起;还活着的引擎由 EngineClient 析构时按 关 stdin → 等 → terminate → kill 收掉(在途的单答完再退)
    QObject::connect(&app, &QCoreApplication::aboutToQuit, &supervisor, [&supervisor] { supervisor.prepareQuit(); });

    shell::ShellActions actions(&bridge, &store);
    // 顶栏下面的两条:重要事件、宏观行情带。轮询不看当前在哪一页(同 React 版 main.tsx 的 start*Loop)
    shell::EventsStore events(&bridge, &store);
    // 提醒:响一声 → 通知流 → 置顶小窗 → 小窗没收下的补系统通知(shell/alerter);小窗的窗口那一半在 app/popup_controller
    shell::PopupQueue popupQueue;
    app::platform::Outputs alertOutputs;
    shell::Alerter alerter(&popupQueue, &alertOutputs, QDir(userDataDir).filePath(u"qt-settings.ini"_s));
    app::PopupController popupController(&popupQueue);
    // 看门狗与迟到的回执(main.js 的 startEngineWatchdog / lateReply):人多半不在窗口前,发系统通知;迟到的回执另写进通知流
    QObject::connect(&supervisor, &shell::EngineSupervisor::unresponsive, &alerter, [&alerter, &logFile](int seconds) {
        logFile.warn(u"[watchdog] 引擎 %1 秒没有回应"_s.arg(seconds));
        alerter.systemNotify(u"交易引擎没有回应"_s, u"持仓追踪的止盈止损暂时停了。屏幕上若有钥匙串 / 凭据弹窗,请先处理;3 分钟仍无回应会自动重启引擎。"_s);
    });
    QObject::connect(&supervisor, &shell::EngineSupervisor::forcedRestart, &alerter, [&alerter, &logFile](int seconds) {
        logFile.error(u"[watchdog] 引擎 %1 秒没有回应,强制重启"_s.arg(seconds));
        alerter.systemNotify(u"交易引擎无响应,已强制重启"_s, u"重启后会按设置自动连回券商、恢复持仓追踪。请核对追踪与挂单状态。"_s);
    });
    QObject::connect(&supervisor, &shell::EngineSupervisor::recovered, &alerter, [&alerter, &logFile] {
        logFile.info(u"[watchdog] 引擎恢复响应"_s);
        alerter.systemNotify(u"交易引擎已恢复响应"_s, u"持仓追踪照常运行。"_s);
    });
    QObject::connect(&bridge, &shell::Bridge::lateOutcome, &alerter, [&alerter, &store](const QString& what, bool ok, const QString& error, qint64 waitedMs) {
        const qint64 seconds = qRound64(waitedMs / 1000.0);
        const QString body = ok ? u"引擎在 %1 秒后回话了:这次操作已经执行。请到「订单看板」核对,不要重复提交。"_s.arg(seconds)
                                : u"引擎在 %1 秒后回话了:这次操作没有成功(%2)。"_s.arg(seconds).arg(error.left(160));
        alerter.systemNotify(u"「%1」有结果了"_s.arg(what), body);
        emit alerter.notified(u"「%1」超时后有结果了"_s.arg(what), body);
        store.refresh();  // 同 main.js 补发的 pending 事件
    });
    // 引擎自己发的通知(成交回报、指令被拒…):写进通知流(React 版 store/notify 的 startNotifyFeed)
    QObject::connect(&engine, &shell::EngineClient::engineEvent, &alerter, [&alerter](const QString& name, const QJsonValue& data) {
        if (name != u"notification") return;
        const QJsonObject o = data.toObject();
        emit alerter.notified(o.value(u"title").toVariant().toString(), o.value(u"body").isNull() || o.value(u"body").isUndefined() ? QString() : o.value(u"body").toVariant().toString());
    });
    QObject::connect(&actions, &shell::ShellActions::systemNotice, &alerter, [&alerter](const QString& title, const QString& body) { alerter.systemNotify(title, body); });
    // 电源与合盖(app/power_controller):阻止闲置睡眠、换电源 / 睡下 / 醒来记日志、用电池又在盯盘时提醒、盯盘时合盖不睡
    app::PowerController power(&logFile, &alerter, userDataDir);
    if (!smoke) power.start();
    QObject::connect(&supervisor, &shell::EngineSupervisor::statusSeen, &power, &app::PowerController::observeStatus);
    // 菜单、Dock 菜单、关窗只藏、窗口位置、单实例(app/desktop_shell)
    app::DesktopShell desktop({&actions, &store, &alerter, logFile.path(), userDataDir, &power});
    // 退出的收尾(main.js 的 before-quit):先停引擎(等它停稳,在途的单答完),再恢复自己关掉的合盖睡眠(会弹授权框),最后真的退出
    // 「支持与数据」(app/support_service):导出 / 复制诊断、打开所在位置、账户、恢复交易库、检查更新
    app::SupportService support({
        .engine = &engine, .supervisor = &supervisor, .log = &logFile, .alerter = &alerter,
        .configPath = configPath, .userDataDir = userDataDir, .repoDir = repo,
        .noticesPath = QDir(repo).filePath(u"desktop/build/THIRD-PARTY-NOTICES.txt"_s),
        .appVersion = QCoreApplication::applicationVersion(),
        .confirm = [](const app::Confirm& c) {
            QMessageBox box(c.icon == u"error" ? QMessageBox::Critical : c.icon == u"info" ? QMessageBox::Information : QMessageBox::Warning, c.title, c.message);
            box.setInformativeText(c.detail);
            QList<QAbstractButton*> made;
            for (qsizetype i = 0; i < c.buttons.size(); ++i) made << box.addButton(c.buttons[i], i == c.cancelIndex ? QMessageBox::RejectRole : QMessageBox::AcceptRole);
            if (!made.isEmpty()) {
                box.setDefaultButton(qobject_cast<QPushButton*>(made.value(c.defaultIndex)));
                box.setEscapeButton(made.value(c.cancelIndex));
            }
            box.exec();
            const qsizetype at = made.indexOf(box.clickedButton());
            return int(at < 0 ? c.cancelIndex : at);
        },
        .pickSavePath = [](const QString& title, const QString& defaultPath, const QString& filter) { return QFileDialog::getSaveFileName(nullptr, title, defaultPath, filter); },
        .reveal = [](const QString& path) { app::platform::revealFile(path); },
        .openPath = [](const QString& path) { return QDesktopServices::openUrl(QUrl::fromLocalFile(path)) ? QString() : u"打不开:%1"_s.arg(path); },
        .copyText = [](const QString& text) { QGuiApplication::clipboard()->setText(text); },
        .openUrl = [](const QUrl& url) { QDesktopServices::openUrl(url); },
        .consentState = [&consent] {
            const shell::ConsentState c = consent.state();
            shell::OJson o;
            o.type = shell::OJson::Object;
            o.set(u"version"_s, shell::OJson::string(c.version));
            o.set(u"accepted"_s, shell::OJson::boolean(c.accepted));
            o.set(u"acceptedAt"_s, c.accepted ? shell::OJson::string(c.acceptedAt) : shell::OJson::null());
            return o;
        },
        // 只有接真引擎(ts / native)才改配置、换交易库;预览、自检、截图一律不碰
        .readOnly = engineKind != u"ts" && engineKind != u"native",
    });
    // 帮助 → 导出诊断信息…:和界面上的按钮走同一条路,结果写在横幅上(同 SupportPanel.tsx)
    QObject::connect(&desktop, &app::DesktopShell::supportRequested, &support, [&support, &store](const QString& action) {
        if (action != u"export-diagnostics") return;
        support.exportDiagnostics(app::SupportService::Done([&store](const QJsonObject& r, const QString& error) {
            if (!error.isEmpty()) store.showBanner(u"导出没有成功:"_s + error);
            else if (r.value(u"ok").toBool()) store.showInfo(u"诊断信息已导出,发出去之前建议自己先看一遍。"_s);
        }));
    });
    // 引擎因为配置 / 交易库退出:弹对应的对话框(恢复、打开所在位置、重试、退出)
    app::FatalDialogs fatalDialogs(&supervisor, &logFile, &alerter, &desktop, configPath);
    QObject::connect(&supervisor, &shell::EngineSupervisor::engineExited, &fatalDialogs, [&fatalDialogs](const shell::EngineExit& info, int) { fatalDialogs.onEngineExited(info); });
    QObject::connect(&desktop, &app::DesktopShell::quitRequested, &desktop, [&] {
        logFile.info(u"[shell] 退出:先停引擎"_s);
        supervisor.prepareQuit();
        shell::StopOptions final;
        final.final = true;
        engine.stop(final, [&] {
            power.restoreLidSleep([&] { desktop.finishQuit(); });
        });
    });
    if (!smoke) desktop.listenForSecondInstances();
    QObject::connect(&events, &shell::EventsStore::announce, &alerter, [&alerter](const QJsonObject& item, const QString& direction) { alerter.announce(item, direction); });
    shell::MacroStore macro(&bridge, &store);
    // 持仓追踪:盯盘结果与托管对账一秒读一次(判断与发单在引擎里)。比价位警告先建(后析构):它的快照要给价位提醒用
    shell::TrackerStore tracker(&bridge, &store, &alerter);
    // 价位警告 10 秒一轮,不看当前在哪一页(store/alerts.ts 的 startAlertsLoop);弹窗要说"这只在追踪里、离止损多远"
    shell::AlertsStore alerts(&bridge, &store, &alerter);
    alerts.trackerSnapshot = [&tracker] { return std::pair{tracker.tracks(), tracker.rows()}; };
    // 持仓追踪页的接线:价位条按真字体量字宽(lib/LevelStrip.tsx 量的是画布上的 10px 字:名字 500、价格等宽 600)
    shell::TrackerController trackerPage(&bridge, &store, &tracker, &alerts);
    trackerPage.measure = [](const QString& text, bool mono, int weight) {
#if defined(Q_OS_MACOS)
        QFont font(mono ? u".AppleSystemUIFontMonospaced"_s : u".AppleSystemUIFont"_s);
#else
        QFont font(mono ? u"Consolas"_s : u"Segoe UI"_s);
#endif
        font.setPixelSize(10);
        font.setWeight(QFont::Weight(weight));
        return QFontMetricsF(font).horizontalAdvance(text);
    };
    QObject::connect(&engine, &shell::EngineClient::engineEvent, &tracker, [&tracker](const QString& name, const QJsonValue& data) { tracker.onEngineEvent(name, data); });
    // 交易记录与条件单(记录页与订单看板共用一份):启动读一次,引擎报 pending 事件时重读
    shell::RecordsStore records(&bridge);
    shell::PendingStore pendingList(&bridge);
    QObject::connect(&engine, &shell::EngineClient::engineEvent, &records, [&records](const QString& name, const QJsonValue&) { records.onEngineEvent(name); });
    QObject::connect(&engine, &shell::EngineClient::engineEvent, &pendingList, [&pendingList](const QString& name, const QJsonValue&) { pendingList.onEngineEvent(name); });
    // 自动平仓 / 立即平仓之后交易记录跟着重读
    QObject::connect(&tracker, &shell::TrackerStore::recordsStale, &records, [&records] { records.load(); });
    shell::BoardController boardPage(&store, &records, &pendingList);
    // 交易记录页:同一份记录;导出的路径由系统的保存对话框定(界面递不进路径)
    shell::RecordsController recordsPage(&bridge, &records, &store, QDir(userDataDir).filePath(u"qt-settings.ini"_s));
    recordsPage.pickSavePath = [](const QString& title, const QString& defaultPath, const QString& filter) { return QFileDialog::getSaveFileName(nullptr, title, defaultPath, filter); };
    recordsPage.downloadsDir = QStandardPaths::writableLocation(QStandardPaths::DownloadLocation);
    // 行情页:K 线读盘与盘口(标的、周期、关注表记在同一份 ini)
    shell::MarketController marketPage(&bridge, &store, QDir(userDataDir).filePath(u"qt-settings.ini"_s));
    // 开发与截图对比:--open chart:<n> 把 tests/fixtures/chart_scale_cases.json 的第 n 个场景放进一张图
    app::DevCharts devCharts(QDir(repo).filePath(u"native/tests/fixtures/chart_scale_cases.json"_s));
    // Esc:同原版在 window 上听 keydown,只看不拦(抽屉、对话框照样收到)
    app::EscapeWatcher escapeWatcher;
    app.installEventFilter(&escapeWatcher);
    QObject::connect(&escapeWatcher, &app::EscapeWatcher::pressed, &recordsPage, &shell::RecordsController::close);
    QObject::connect(&desktop, &app::DesktopShell::refreshRequested, &records, [&records, &pendingList] {
        records.load();
        pendingList.load();
    });
    // 交易指令页:大模型目录(启动读一次,llm 事件重读)、输入与提交、页面接线
    shell::LlmStore llm(&bridge, &store);
    QObject::connect(&engine, &shell::EngineClient::engineEvent, &llm, [&llm](const QString& name, const QJsonValue& data) { llm.onEngineEvent(name, data); });
    shell::TradeComposer composer(&bridge, &store, QDir(userDataDir).filePath(u"qt-settings.ini"_s));
    // 想法页:「发到解析」把原文放进上面这个输入框
    shell::IdeasController ideasPage(&bridge, &store, &composer);
    composer.reloadOthers = [&records, &pendingList](std::function<void()> done) {
        auto left = std::make_shared<int>(2);
        const auto one = [left, done] {
            if (--*left == 0) done();
        };
        records.load(one);
        pendingList.load(one);
    };
    shell::TradeController tradePage(&bridge, &store, &llm, &composer);
    tradePage.placeholders = [&support, engineKind] {
        // 预览引擎碰不到配置:占位账号按预览台的 mock(accountsInfo 回空),截图对比才和 React 版同一份数据
        if (engineKind == u"preview") return QStringList{};
        QStringList out;
        for (const QJsonValue& v : support.accountsInfo().value(u"placeholders"_s).toArray()) out << v.toString();
        return out;
    };
    tradePage.refreshPlaceholders();
    // 右栏的蝴蝶测算:表单与结果在 store 里,切页回来还在
    shell::FlyStore flyStore(&bridge);
    // SPX 走到 25 的整数倍时提醒:两秒一轮,不看当前在哪一页(store/spot.ts 的 startSpotLoop)
    shell::SpotStore spot(&bridge, &store, &alerter, QDir(userDataDir).filePath(u"qt-settings.ini"_s));
    // 三路引擎推来的提醒(日内剧本、异动、情报),同样不看当前在哪一页
    shell::PlaybookStore playbook(&bridge, &alerter, QDir(userDataDir).filePath(u"qt-settings.ini"_s));
    // 交易指令页右栏两面的接线(蝴蝶测算、日内剧本)
    shell::FlyController flyPage(&flyStore, &spot, &store, &events, &playbook, &composer);
    shell::QualityStore quality(&bridge, &store, &alerter);
    shell::IntelStore intel(&bridge, &alerter, QDir(userDataDir).filePath(u"qt-settings.ini"_s));
    QObject::connect(&engine, &shell::EngineClient::engineEvent, &playbook, [&playbook](const QString& name, const QJsonValue& data) { playbook.onEngineEvent(name, data); });
    QObject::connect(&engine, &shell::EngineClient::engineEvent, &quality, [&quality](const QString& name, const QJsonValue& data) { quality.onEngineEvent(name, data); });
    QObject::connect(&engine, &shell::EngineClient::engineEvent, &intel, [&intel](const QString& name, const QJsonValue& data) { intel.onEngineEvent(name, data); });
    // 情报页、档案抽屉、⌘K 查标的:状态都在上面那份 IntelStore,这里只摆成模型(页面自己的只有关键字)
    shell::IntelController intelPage(&intel, &store);
    QObject::connect(&engine, &shell::EngineClient::engineEvent, &alerts, [&alerts](const QString& name, const QJsonValue& data) { alerts.onEngineEvent(name, data); });
    QObject::connect(&engine, &shell::EngineClient::engineEvent, &events, [&events](const QString& name, const QJsonValue&) { events.onEngineEvent(name); });
    // 条款文本:开发时读仓库里的 docs/legal/(打包后从哪儿读,打包时再定)
    shell::ConsentModel consentModel(&consent, QDir(repo).filePath(u"docs/legal"_s), QCoreApplication::applicationVersion());
    QObject::connect(&consentModel, &shell::ConsentModel::quitRequested, &app, &QCoreApplication::quit);
    // 板块页:板块与行情(store/sectors.ts)、页面接线;价位条的字宽同持仓追踪
    shell::SectorsStore sectors(&bridge, &store, &alerts, &quality);
    shell::SectorsController sectorsPage(&sectors, &alerts, &quality, &store, &alerter);
    sectorsPage.measure = trackerPage.measure;
    // 扫描页:板块读同一份 store/sectors;选中的股票池记在本机
    shell::ScreenerController screenerPage(&bridge, &sectors, &store, QDir(userDataDir).filePath(u"qt-settings.ini"_s));
    // 回测页:策略目录、跑一次、扫参数(只碰 backtest.*)
    shell::BacktestController backtestPage(&bridge, &store);
    // 交易分析页:选中、周期、EM、类型记在本机;交易记录详情里的「分析这笔交易」交给它(页面挂上再办)
    shell::ReviewController reviewPage(&bridge, &store, QDir(userDataDir).filePath(u"qt-settings.ini"_s));
    QObject::connect(&recordsPage, &shell::RecordsController::reviewRequested, &reviewPage, &shell::ReviewController::request);
    // 绩效体检页:范围、品种、天数、仓位计算器的权益与比例记在本机;按建议填入经确认框走 settings.patch
    shell::PerformanceController performancePage(&bridge, &store, QDir(userDataDir).filePath(u"qt-settings.ini"_s));
    performancePage.pickSavePath = [](const QString& title, const QString& defaultPath, const QString& filter) { return QFileDialog::getSaveFileName(nullptr, title, defaultPath, filter); };
    performancePage.downloadsDir = [] { return QStandardPaths::writableLocation(QStandardPaths::DownloadLocation); };
    // 接入页:TWS / 富途的检测与诊断、账户、大模型、Discord 跟单;子页签记在本机。账户的改动走壳(校验、确认框、写配置、重启引擎)
    shell::AccessController accessPage(&bridge, &store, &llm, &actions, QDir(userDataDir).filePath(u"qt-settings.ini"_s));
    // 预览引擎碰不到配置:用 React 预览台 mock 的那一份(三条连接、没有占位账号),截图对比才同一份数据
    accessPage.accountsInfo = [&support, engineKind] {
        if (engineKind == u"preview")
            return QJsonObject{{u"placeholders"_s, QJsonArray{}},
                               {u"connections"_s, QJsonArray{QJsonObject{{u"name"_s, u"paper"_s}, {u"broker"_s, u"ibkr"_s}, {u"port"_s, 7497}},
                                                             QJsonObject{{u"name"_s, u"live"_s}, {u"broker"_s, u"ibkr"_s}, {u"port"_s, 7496}},
                                                             QJsonObject{{u"name"_s, u"futu"_s}, {u"broker"_s, u"futu"_s}, {u"port"_s, 11111}}}}};
        return support.accountsInfo();
    };
    accessPage.changeAccount = [&support](const QJsonObject& change, std::function<void(const QJsonObject&, const QString&)> done) {
        // 键序照 React(AccountsPanel 拼的那个字面量):确认框与日志按这个次序列
        shell::OJson o = shell::OJson::fromQJson(QJsonObject{});
        o.type = shell::OJson::Object;
        for (const QString& k : {u"action"_s, u"alias"_s, u"account_id"_s, u"is_paper"_s, u"connection"_s, u"make_default"_s})
            if (change.contains(k)) o.set(k, shell::OJson::fromQJson(change.value(k)));
        support.changeAccount(o, std::move(done));
    };
    QObject::connect(&engine, &shell::EngineClient::engineEvent, &accessPage, [&accessPage](const QString& name, const QJsonValue& data) { accessPage.onEngineEvent(name, data); });
    performancePage.imageWriter = [](const QByteArray& png, const QString& path) -> QString {
        QImage image;
        if (!image.loadFromData(png, "PNG") || image.isNull()) return u"图片不合法"_s;
        if (path.isEmpty()) {
            QGuiApplication::clipboard()->setImage(image);
            return {};
        }
        return image.save(path, "PNG") ? QString() : u"写不进去:"_s + path;
    };


    // 新版本检查:启动 30 秒后问一次 GitHub,之后 12 小时一次(store/update.ts 的 startUpdateChecks)。
    // 只在接真引擎时排(预览、自检、截图碰不到任何真东西,也不去问网络);手动检查照常可用
    // 预览引擎不去问 GitHub:回 React 预览台 mock 的那一份("有新版"的样子,顶栏提示与「关于」页的下载按钮都看得到)
    shell::UpdateStore updates([&support, engineKind](bool force, shell::UpdateStore::Done done) {
            if (engineKind == u"preview") {
                return done(QJsonObject{
                                {u"current"_s, u"0.2.0"_s}, {u"latest"_s, u"0.2.1"_s}, {u"newer"_s, true},
                                {u"url"_s, u"https://github.com/Dafrix69/IBKR-Assistant/releases/tag/v0.2.1"_s},
                                {u"download"_s, QJsonObject{{u"name"_s, u"Datrix-0.2.1-mac-arm64.dmg"_s},
                                                            {u"url"_s, u"https://github.com/Dafrix69/IBKR-Assistant/releases/download/v0.2.1/Datrix-0.2.1-mac-arm64.dmg"_s},
                                                            {u"size"_s, 118000000}}},
                                {u"publishedAt"_s, u"2026-09-28T02:00:00Z"_s},
                                {u"notes"_s, u"修复\n- 追价平仓:部分成交后改价不再缩量\n- 执行对账:重连后认领在途单\n\n新增\n- 关于页:新版本检查"_s},
                                {u"checkedAt"_s, double(QDateTime::currentMSecsSinceEpoch())}},
                            {});
            }
            support.checkUpdate(force, std::move(done));
        },
        QDir(userDataDir).filePath(u"qt-settings.ini"_s));
    // 设置页:表单、闸门、保存的确认框、重要事件的口径、数据与备份(恢复交给壳)
    shell::SettingsController settingsPage(&bridge, &store, &events);
    settingsPage.revealPath = [&support](const QString& kind, std::function<void(const QJsonObject&, const QString&)> done) { support.reveal(kind, std::move(done)); };
    settingsPage.restore = [&support](const QString& name, std::function<void(const QJsonObject&, const QString&)> done) { support.restoreBackup(name, std::move(done)); };
    QObject::connect(&engine, &shell::EngineClient::engineEvent, &settingsPage, [&settingsPage](const QString& name, const QJsonValue&) { settingsPage.onEngineEvent(name); });
    // 关于页:版本信息、更新、支持、引擎日志(从启动起就收,只留最近 200 行)
    shell::AboutController aboutPage(&bridge, &store, &updates);
    // 预览引擎:版本信息用 React 预览台 mock 的那一份(同交易指令页的占位账号),截图对比才同一份数据
    aboutPage.appInfo = [&support, engineKind] {
        if (engineKind == u"preview")
            return QJsonObject{{u"version"_s, u"0.2.0"_s}, {u"electron"_s, u"40.0.0"_s}, {u"configPath"_s, u"config/settings.json"_s},
                               {u"logPath"_s, u"~/Library/Logs/Datrix/main.log"_s}, {u"enginePath"_s, u"src/ibkr_agent"_s}, {u"engineRunning"_s, true}};
        return support.appInfo();
    };
    aboutPage.restart = [&support] { support.restartEngine(); };
    aboutPage.exportDiag = [&support](shell::AboutController::Done done) { support.exportDiagnostics(std::move(done)); };
    aboutPage.copyDiag = [&support](shell::AboutController::Done done) { support.copyDiagnostics(std::move(done)); };
    aboutPage.revealPath = [&support](const QString& kind, shell::AboutController::Done done) { support.reveal(kind, std::move(done)); };
    aboutPage.terms = [&consentModel] { consentModel.showTerms(); };
    aboutPage.openUrl = [&support](const QString& url) { return support.openExternal(url); };
#if !defined(Q_OS_MACOS)
    aboutPage.mac = false;
#endif
    QObject::connect(&engine, &shell::EngineClient::logLine, &aboutPage, &shell::AboutController::appendLog);
    QQmlApplicationEngine qml;
    qml.addImageProvider(u"icon"_s, new app::IconProvider);  // 引擎接管、析构时删
    if (cli.isSet(schemeOption)) {
        // 不跟系统的深浅色(截图对比用):直接告诉主题单例;系统配色的请求在无窗口平台上没人理
        if (QObject* theme = qml.singletonInstance<QObject*>(u"Dafri.Kit"_s, u"Theme"_s)) theme->setProperty("forcedScheme", cli.value(schemeOption));
    }
    // QML 的报错(绑定里的 TypeError、找不到的属性)默认只打一行到 stderr,界面照常开着。自检与截图把它当失败
    int qmlWarnings = 0;
    QObject::connect(&qml, &QQmlApplicationEngine::warnings, &app, [&qmlWarnings](const QList<QQmlError>& list) { qmlWarnings += int(list.size()); });
    const auto exitCode = [&qmlWarnings](int ok) {
        if (qmlWarnings == 0) return ok;
        std::fprintf(stderr, "QML 报了 %d 条警告\n", qmlWarnings);
        return 6;
    };
    app::QmlBridge qmlBridge(&bridge, &qml);
    support.setJsEngine(&qml);
    const bool withEngine = engineKind != u"none";
    qml.setInitialProperties({{u"statusStore"_s, QVariant::fromValue<QObject*>(withEngine ? &store : nullptr)},
                              {u"bridge"_s, QVariant::fromValue<QObject*>(withEngine ? &qmlBridge : nullptr)},
                              {u"actions"_s, QVariant::fromValue<QObject*>(withEngine ? &actions : nullptr)},
                              {u"events"_s, QVariant::fromValue<QObject*>(withEngine ? &events : nullptr)},
                              {u"alerter"_s, QVariant::fromValue<QObject*>(&alerter)},
                              {u"popupQueue"_s, QVariant::fromValue<QObject*>(&popupQueue)},
                              {u"popupController"_s, QVariant::fromValue<QObject*>(&popupController)},
                              {u"support"_s, QVariant::fromValue<QObject*>(&support)},
                              {u"macro"_s, QVariant::fromValue<QObject*>(withEngine ? &macro : nullptr)},
                              {u"alerts"_s, QVariant::fromValue<QObject*>(withEngine ? &alerts : nullptr)},
                              {u"tracker"_s, QVariant::fromValue<QObject*>(withEngine ? &tracker : nullptr)},
                              {u"trackerPage"_s, QVariant::fromValue<QObject*>(withEngine ? &trackerPage : nullptr)},
                              {u"composer"_s, QVariant::fromValue<QObject*>(withEngine ? &composer : nullptr)},
                              {u"tradePage"_s, QVariant::fromValue<QObject*>(withEngine ? &tradePage : nullptr)},
                              {u"fly"_s, QVariant::fromValue<QObject*>(withEngine ? &flyPage : nullptr)},
                              {u"board"_s, QVariant::fromValue<QObject*>(withEngine ? &boardPage : nullptr)},
                              {u"recordsPage"_s, QVariant::fromValue<QObject*>(withEngine ? &recordsPage : nullptr)},
                              {u"marketPage"_s, QVariant::fromValue<QObject*>(withEngine ? &marketPage : nullptr)},
                              {u"ideasPage"_s, QVariant::fromValue<QObject*>(withEngine ? &ideasPage : nullptr)},
                              {u"screenerPage"_s, QVariant::fromValue<QObject*>(withEngine ? &screenerPage : nullptr)},
                              {u"backtestPage"_s, QVariant::fromValue<QObject*>(withEngine ? &backtestPage : nullptr)},
                              {u"reviewPage"_s, QVariant::fromValue<QObject*>(withEngine ? &reviewPage : nullptr)},
                              {u"performancePage"_s, QVariant::fromValue<QObject*>(withEngine ? &performancePage : nullptr)},
                              {u"intelPage"_s, QVariant::fromValue<QObject*>(withEngine ? &intelPage : nullptr)},
                              {u"accessPage"_s, QVariant::fromValue<QObject*>(withEngine ? &accessPage : nullptr)},
                              {u"desktopShell"_s, QVariant::fromValue<QObject*>(&desktop)},
                              {u"settingsPage"_s, QVariant::fromValue<QObject*>(withEngine ? &settingsPage : nullptr)},
                              {u"aboutPage"_s, QVariant::fromValue<QObject*>(withEngine ? &aboutPage : nullptr)},
                              {u"sectorsPage"_s, QVariant::fromValue<QObject*>(withEngine ? &sectorsPage : nullptr)},
                              {u"devCharts"_s, QVariant::fromValue<QObject*>(&devCharts)},
                              {u"flyStore"_s, QVariant::fromValue<QObject*>(withEngine ? &flyStore : nullptr)},
                              {u"spot"_s, QVariant::fromValue<QObject*>(withEngine ? &spot : nullptr)},
                              {u"playbook"_s, QVariant::fromValue<QObject*>(withEngine ? &playbook : nullptr)},
                              {u"quality"_s, QVariant::fromValue<QObject*>(withEngine ? &quality : nullptr)},
                              {u"intel"_s, QVariant::fromValue<QObject*>(withEngine ? &intel : nullptr)},
                              {u"updates"_s, QVariant::fromValue<QObject*>(&updates)},
                              // 自检不读不写同意记录:没有引擎就没有钱路径,也不该把同意页挡在第一帧上
                              {u"consent"_s, QVariant::fromValue<QObject*>(withEngine ? &consentModel : nullptr)},
                              {u"engineMode"_s, engineKind}});
    // 上次的窗口位置与大小(自检与截图用固定的默认大小,图才比得了)
    bool maximized = false;
    const QRect saved = smoke || cli.isSet(shotOption) ? QRect() : desktop.savedBounds(&maximized);
    QObject::connect(&qml, &QQmlApplicationEngine::objectCreationFailed, &app, [] {
        std::fprintf(stderr, "界面的 QML 加载失败\n");
        QCoreApplication::exit(2);
    }, Qt::QueuedConnection);
    qml.loadFromModule("Dafri.Shell", "Main");
    if (auto* mainWindow = qobject_cast<QQuickWindow*>(qml.rootObjects().value(0))) {
        if (!saved.isNull()) mainWindow->setGeometry(saved);
        if (maximized) mainWindow->showMaximized();
        escapeWatcher.setWindow(mainWindow);
        popupController.attach(mainWindow->findChild<QQuickWindow*>(u"alertPopup"_s), mainWindow);
        // "人就在这一页、窗口也在前台"(React 版 getTab() === page && document.hasFocus())
        // 两样都用 QPointer:qml 比这几个 store 先析构,store 晚到的回调里再问一次也不能碰到已经没了的对象
        const auto seeing = [nav = QPointer<QObject>(qml.singletonInstance<QObject*>(u"Dafri.Shell"_s, u"Nav"_s)), window = QPointer<QQuickWindow>(mainWindow)](const QString& page) {
            return nav && window && window->isActive() && nav->property("current").toString() == page;
        };
        quality.seeing = seeing;
        // 原版挂在主窗口上(document.hasFocus() / window 'focus'):确认框、提醒小窗拿到焦点不算
        sectorsPage.windowActive = [window = QPointer<QQuickWindow>(mainWindow)] { return window && window->isActive(); };
        QObject::connect(qApp, &QGuiApplication::focusWindowChanged, &sectorsPage, [&sectorsPage, &intelPage, window = QPointer<QQuickWindow>(mainWindow)](QWindow* w) {
            if (w && w == window) {
                sectorsPage.windowFocused();
                intelPage.windowFocused();
            }
        });
        intel.seeing = seeing;
        desktop.attach(mainWindow);
    }

    std::unique_ptr<QLockFile> shellLock;
    // 预览引擎碰不到任何真东西,不用查 Electron 版,也不用抢锁
    if (engineKind == u"preview") {
        supervisor.start();
        store.startPolling();
        events.start();
        macro.start();
        tracker.start();
        alerts.start();
        spot.start();
        playbook.start();
        quality.start();
        intel.start();
        llm.load();
        records.load();
        pendingList.load();
        updates.check(false);
    } else if (engineKind == u"ts" || engineKind == u"native") {
        QString blocker = shell::engineStartBlocker(shell::electronUserDataDirs(), shell::localHostName());
        if (blocker.isEmpty()) {
            const QString lockPath = QDir(shell::electronUserDataDirs().first()).filePath(u"qt-shell.lock"_s);
            shellLock = shell::lockQtShell(lockPath);
            if (!shellLock) blocker = u"另一个 Qt 版已经开着:同一份配置上只能有一个引擎。"_s;
        }
        if (blocker.isEmpty()) {
            // Electron 版把这句发给了界面,React 版没有人接(迁移时丢了);这里照原来的意思显示出来
            if (configCreated) store.showBanner(u"已从示例创建配置文件。请先到「接入 → 账户」填上你的账号,并在「设置」里核对限额。"_s);
            supervisor.start();
            store.startPolling();
            events.start();
            macro.start();
            tracker.start();
            alerts.start();
            spot.start();
            playbook.start();
            quality.start();
            intel.start();
        llm.load();
        records.load();
        pendingList.load();
            updates.start(support.appInfo().value(u"dev"_s).toBool());
        } else {
            store.showBanner(blocker);
        }
    }

    if (cli.isSet(quitAfterOption)) QTimer::singleShot(cli.value(quitAfterOption).toInt(), &app, [] { QCoreApplication::quit(); });
    if (smoke) {
        auto* window = qobject_cast<QQuickWindow*>(qml.rootObjects().value(0));
        if (window == nullptr) {
            std::fprintf(stderr, "没有建出窗口\n");
            return 3;
        }
        // 等第一帧真的画出来(场景图、着色器、图形后端都走过一遍),不是窗口对象建出来就算
        QObject::connect(window, &QQuickWindow::frameSwapped, &app, [window, exitCode] {
            std::printf("shell ok %dx%d, first frame drawn, engine none\n", window->width(), window->height());
            std::fflush(stdout);
            QCoreApplication::exit(exitCode(0));
        }, Qt::SingleShotConnection);
        QTimer::singleShot(15'000, &app, [] {
            std::fprintf(stderr, "15 秒内没画出第一帧\n");
            QCoreApplication::exit(4);
        });
    }
    if (cli.isSet(shotOption) && withEngine) {
        // 等引擎回了第一份状态,再等一帧画完,抓下来。20 秒还没回就带着现状抓(截图也是证据:它会写着"正在连引擎")
        const QString png = cli.value(shotOption);
        auto* window = qobject_cast<QQuickWindow*>(qml.rootObjects().value(0));
        if (window == nullptr) return 3;
        const QString openWhat = cli.value(openOption);
        const QString dumpPath = cli.value(dumpOption);
        auto grab = [window, png, exitCode, openWhat, dumpPath] {
            if (!openWhat.isEmpty()) QMetaObject::invokeMethod(window, "devOpen", Q_ARG(QVariant, openWhat));
            // --open popup:抓的是提醒小窗,不是主窗口
            if (openWhat == u"popup") {
                if (auto* popup = window->findChild<QQuickWindow*>(u"alertPopup"_s)) {
                    QTimer::singleShot(2500, popup, [popup, png, exitCode] {
                        const bool ok = popup->isVisible() && popup->grabWindow().save(png);
                        std::printf(ok ? "screenshot %s\n" : "screenshot failed %s\n", qPrintable(png));
                        std::fflush(stdout);
                        QCoreApplication::exit(exitCode(ok ? 0 : 5));
                    });
                    return;
                }
            }
            // --open page:…:页面的数据要等引擎回话(读持仓、追踪、盯盘结果),等一会儿、滚到位置再抓
            if (openWhat.startsWith(u"page:"_s)) {
                QTimer::singleShot(2500, window, [window, png, exitCode, dumpPath] {
                    QMetaObject::invokeMethod(window, "devScroll");
                    QTimer::singleShot(300, window, [window, png, exitCode, dumpPath] {
                        if (!dumpPath.isEmpty()) app::dumpTexts(window, dumpPath);
                        const bool ok = window->grabWindow().save(png);
                        std::printf(ok ? "screenshot %s\n" : "screenshot failed %s\n", qPrintable(png));
                        std::fflush(stdout);
                        QCoreApplication::exit(exitCode(ok ? 0 : 5));
                    });
                });
                return;
            }
            QObject::connect(window, &QQuickWindow::frameSwapped, window, [window, png, exitCode, dumpPath] {
                if (!dumpPath.isEmpty()) app::dumpTexts(window, dumpPath);
                const bool ok = window->grabWindow().save(png);
                std::printf(ok ? "screenshot %s\n" : "screenshot failed %s\n", qPrintable(png));
                std::fflush(stdout);
                QCoreApplication::exit(exitCode(ok ? 0 : 5));
            }, Qt::SingleShotConnection);
            window->update();  // 画面已经是最新的也要再画一帧,抓图才有"画完"的时机
        };
        if (store.engineOk() == 1) {
            grab();
        } else {
            QObject::connect(&store, &shell::StatusStore::engineOkChanged, &app, [&store, grab, openWhat] { if (store.engineOk() != -1) QTimer::singleShot(openWhat.isEmpty() ? 300 : 1000, grab); },
                             Qt::SingleShotConnection);
            QTimer::singleShot(20'000, &app, grab);
        }
    }
    return app.exec();
}
