#include "desktop_shell.h"

#include "platform.h"
#include "power_controller.h"
#include "shell/alerter.h"
#include "shell/shell_actions.h"
#include "shell/status_store.h"
#include "shell/window_state.h"

#include <QAction>
#include <QApplication>
#include <QCryptographicHash>
#include <QDir>
#include <QGuiApplication>
#include <QLocalSocket>
#include <QScreen>
#include <QTimer>

using namespace Qt::StringLiterals;

namespace ibkr::app {

namespace {

QString serverName(const QString& userDataDir) {
    // 按 userData 目录分:测试用临时目录起的那几个,不会去叫用户正开着的那一个
    return u"Datrix-qt-"_s + QString::fromLatin1(QCryptographicHash::hash(QDir(userDataDir).absolutePath().toUtf8(), QCryptographicHash::Sha1).toHex().left(16));
}

QList<QRect> workAreas() {
    QList<QRect> out;
    for (QScreen* s : QGuiApplication::screens()) out.append(s->availableGeometry());
    return out;
}

}  // namespace

QString MenuTranslator::translate(const char* context, const char* source, const char*, int) const {
    if (qstrcmp(context, "MAC_APPLICATION_MENU") != 0) return {};
    static const QHash<QByteArray, QString> words{
        {"Services", u"服务"_s},     {"Hide %1", u"隐藏 %1"_s},          {"Hide Others", u"隐藏其他"_s},
        {"Show All", u"全部显示"_s}, {"Preferences...", u"设置…"_s},     {"Quit %1", u"退出 %1"_s},
        {"About %1", u"关于 %1"_s},
    };
    return words.value(QByteArray(source));
}

DesktopShell::DesktopShell(Deps deps, QObject* parent) : QObject(parent), deps_(std::move(deps)) {
    qApp->installEventFilter(this);
    // 点 Dock 图标:窗口藏着就叫回来
    platform::onReopen([this] { showMainWindow(); });
}

DesktopShell::~DesktopShell() { qApp->removeEventFilter(this); }

bool DesktopShell::handOffToRunningInstance(const QString& userDataDir) {
    QLocalSocket socket;
    socket.connectToServer(serverName(userDataDir));
    if (!socket.waitForConnected(500)) return false;
    socket.write("show\n");
    socket.waitForBytesWritten(500);
    socket.disconnectFromServer();
    return true;
}

void DesktopShell::listenForSecondInstances() {
    server_ = std::make_unique<QLocalServer>();
    const QString name = serverName(deps_.userDataDir);
    server_->setSocketOptions(QLocalServer::UserAccessOption);
    if (!server_->listen(name)) {
        // 上一次崩了留下的套接字文件:没人在听,删掉重来
        QLocalServer::removeServer(name);
        if (!server_->listen(name)) qWarning("[shell] 单实例的本地套接字开不了(%s):第二次打开会另起一个", qPrintable(server_->errorString()));
    }
    connect(server_.get(), &QLocalServer::newConnection, this, [this] {
        while (QLocalSocket* s = server_->nextPendingConnection()) {
            connect(s, &QLocalSocket::readyRead, s, [this, s] {
                if (s->readAll().startsWith("show")) showMainWindow();  // macOS 上窗口可能是藏着的
                s->deleteLater();
            });
        }
    });
}

QRect DesktopShell::savedBounds(bool* maximized) const {
    const auto state = shell::loadWindowState(QDir(deps_.userDataDir).filePath(u"window-state.json"_s), workAreas());
    if (maximized) *maximized = state && state->maximized;
    return state ? state->bounds : QRect();
}

void DesktopShell::attach(QQuickWindow* main) {
    main_ = main;
    if (!main_) return;
    main_->installEventFilter(this);
    platform::hideTitleText(main_);
    normalBounds_ = main_->geometry();
    const auto track = [this] {
        if (main_ && main_->visibility() == QWindow::Windowed) normalBounds_ = main_->geometry();
    };
    connect(main_, &QWindow::xChanged, this, track);
    connect(main_, &QWindow::yChanged, this, track);
    connect(main_, &QWindow::widthChanged, this, track);
    connect(main_, &QWindow::heightChanged, this, track);
    connect(qApp, &QCoreApplication::aboutToQuit, this, [this] { saveBounds(); });
    buildMenus();
}

void DesktopShell::saveBounds() {
    if (!main_ || normalBounds_.isEmpty()) return;
    shell::saveWindowState(QDir(deps_.userDataDir).filePath(u"window-state.json"_s), {normalBounds_, main_->visibility() == QWindow::Maximized});
}

void DesktopShell::showMainWindow() {
    if (!main_) return;
    if (main_->visibility() == QWindow::Minimized) main_->showNormal();
    if (!main_->isVisible()) main_->show();
    platform::activateApp();
    main_->raise();
    main_->requestActivate();
}

void DesktopShell::navigate(const QString& page) {
    showMainWindow();
    if (main_) QMetaObject::invokeMethod(main_, "navigateTo", Q_ARG(QVariant, page), Q_ARG(QVariant, QString()));
}

void DesktopShell::hideMainWindow() {
    if (!main_) return;
    // 全屏的窗口直接藏,它那块全屏空间会留下一整屏黑:先退出全屏,动画走完再藏
    if (main_->visibility() == QWindow::FullScreen) {
        main_->showNormal();
        QTimer::singleShot(800, this, [this] { hideMainWindow(); });
        return;
    }
    main_->hide();
    if (!hiddenHintShown_) {
        hiddenHintShown_ = true;
        if (deps_.alerter) deps_.alerter->systemNotify(u"Datrix 仍在运行"_s, u"追踪、提醒与自动执行照常在后台工作。点 Dock 图标打开窗口,⌘Q 退出。"_s);
    }
}

bool DesktopShell::eventFilter(QObject* watched, QEvent* event) {
    // 真退出(⌘Q、Dock 的「退出」、关机):先记下来(窗口的关闭就放行),先收尾——引擎停稳、自己关掉的合盖睡眠恢复——再真的退
    if (watched == qApp && event->type() == QEvent::Quit && !finalQuit_) {
        const bool first = !quitting_;
        quitting_ = true;
        if (first) emit quitRequested();
        event->ignore();
        return true;
    }
    if (watched == main_ && event->type() == QEvent::Close) {
        saveBounds();
#if defined(Q_OS_MACOS)
        // macOS:关窗(红灯 / ⌘W)只把窗口藏起来,应用留在 Dock 里——价位提醒、事件提醒的轮询都还跑在这个进程里
        if (!quitting_ && QGuiApplication::platformName() == u"cocoa") {
            event->ignore();
            hideMainWindow();
            return true;
        }
#endif
    }
    return QObject::eventFilter(watched, event);
}

void DesktopShell::finishQuit() {
    finalQuit_ = true;
    quitting_ = true;
    saveBounds();
    QCoreApplication::quit();
}

void DesktopShell::haltFromMenu(const QString& reason) {
    if (!deps_.actions) return;
    const bool unseen = !main_ || !main_->isVisible();
    deps_.actions->haltFromMenu(reason, unseen);
}

void DesktopShell::editAction(const char* method) {
    // 编辑菜单作用在当前有焦点的输入框上(QML 的 TextInput / TextEdit 都有这几个方法)
    if (QObject* focus = QGuiApplication::focusObject()) QMetaObject::invokeMethod(focus, method);
}

void DesktopShell::refreshFromMenu() {
    if (deps_.status) deps_.status->refresh();
    emit refreshRequested();
}

void DesktopShell::minimizeFromMenu() {
    if (main_) main_->showMinimized();
}

void DesktopShell::buildMenus() {
    const bool mac = QGuiApplication::platformName() == u"cocoa";
    menuBar_ = std::make_unique<QMenuBar>(nullptr);  // 没有父窗口:macOS 上就是全局的菜单栏
    QMenuBar* bar = menuBar_.get();
    const QString name = QCoreApplication::applicationName();
    const auto add = [](QMenu* menu, const QString& text, const QKeySequence& keys, auto fn) {
        QAction* a = menu->addAction(text);
        if (!keys.isEmpty()) a->setShortcut(keys);
        QObject::connect(a, &QAction::triggered, menu, fn);
        return a;
    };

    QMenu* trade = bar->addMenu(u"交易"_s);
    if (mac) {
        // 应用菜单:带角色的这几项不管放在哪个菜单里,Qt 都会把它们挪进应用菜单(关于、设置…、退出);服务、隐藏那几项系统自己补
        add(trade, u"关于 %1"_s.arg(name), {}, [this] { navigate(u"about"_s); })->setMenuRole(QAction::AboutRole);
        add(trade, u"设置…"_s, QKeySequence(u"Ctrl+,"_s), [this] { navigate(u"settings"_s); })->setMenuRole(QAction::PreferencesRole);
        add(trade, u"退出 %1"_s.arg(name), QKeySequence(u"Ctrl+Q"_s), [] { QCoreApplication::quit(); })->setMenuRole(QAction::QuitRole);
    }
    add(trade, u"暂停全部自动执行(熔断)"_s, QKeySequence(u"Ctrl+Shift+H"_s), [this] { haltFromMenu(u"菜单/快捷键触发熔断"_s); });
    trade->addSeparator();
    // 菜单的「刷新状态」:Electron 发 menu { action: refresh },状态、交易记录、条件单都重读
    add(trade, u"刷新状态"_s, QKeySequence(u"Ctrl+R"_s), [this] { refreshFromMenu(); });
    if (deps_.power && deps_.power->lidGuardAvailable()) {
        trade->addSeparator();
        QAction* lid = add(trade, u"盯盘时合盖不睡"_s, {}, [this](bool checked) { deps_.power->setLidGuardEnabled(checked); });
        lid->setCheckable(true);
        lid->setChecked(deps_.power->lidGuardEnabled());
        connect(deps_.power, &PowerController::lidChanged, lid, [this, lid] { lid->setChecked(deps_.power->lidGuardEnabled()); });
    }

    QMenu* edit = bar->addMenu(u"编辑"_s);
    add(edit, u"撤销"_s, QKeySequence::Undo, [this] { editAction("undo"); });
    add(edit, u"重做"_s, QKeySequence::Redo, [this] { editAction("redo"); });
    edit->addSeparator();
    add(edit, u"剪切"_s, QKeySequence::Cut, [this] { editAction("cut"); });
    add(edit, u"拷贝"_s, QKeySequence::Copy, [this] { editAction("copy"); });
    add(edit, u"粘贴"_s, QKeySequence::Paste, [this] { editAction("paste"); });
    if (mac) add(edit, u"粘贴并匹配样式"_s, QKeySequence(u"Ctrl+Alt+Shift+V"_s), [this] { editAction("paste"); });
    add(edit, u"全选"_s, QKeySequence::SelectAll, [this] { editAction("selectAll"); });

    QMenu* window = bar->addMenu(u"窗口"_s);
    add(window, u"最小化"_s, QKeySequence(u"Ctrl+M"_s), [this] { minimizeFromMenu(); });
    add(window, u"缩放"_s, {}, [this] {
        if (main_) main_->visibility() == QWindow::Maximized ? main_->showNormal() : main_->showMaximized();
    });
    if (mac) {
        add(window, u"切换全屏幕"_s, QKeySequence(u"Meta+Ctrl+F"_s), [this] {
            if (main_) main_->visibility() == QWindow::FullScreen ? main_->showNormal() : main_->showFullScreen();
        });
        window->addSeparator();
        // ⌘W 只把窗口藏起来,后台照跑;⌘0 叫回来,和「信息」「音乐」的「窗口」菜单一样
        add(window, u"关闭窗口"_s, QKeySequence(u"Ctrl+W"_s), [this] { if (main_) main_->close(); });
        add(window, u"主窗口"_s, QKeySequence(u"Ctrl+0"_s), [this] { showMainWindow(); });
        window->addSeparator();
        add(window, u"前置全部窗口"_s, {}, [this] { showMainWindow(); });
    }

    QMenu* help = bar->addMenu(u"帮助"_s);
    // 出了问题时的两样东西:一份能直接发给支持的诊断信息,和日志本身
    add(help, u"导出诊断信息…"_s, {}, [this] {
        showMainWindow();
        emit supportRequested(u"export-diagnostics"_s);
    });
    add(help, mac ? u"在访达中显示日志"_s : u"打开日志所在位置"_s, {}, [this] { platform::revealFile(deps_.logPath); });

    if (mac) {
        // Dock 图标的右键菜单:窗口藏着的时候这是离熔断最近的地方
        dockMenu_ = std::make_unique<QMenu>();
        add(dockMenu_.get(), u"显示主窗口"_s, {}, [this] { showMainWindow(); });
        dockMenu_->addSeparator();
        add(dockMenu_.get(), u"暂停全部自动执行(熔断)"_s, {}, [this] { haltFromMenu(u"Dock 菜单触发熔断"_s); });
        platform::setDockMenu(dockMenu_.get());
    }
}

}  // namespace ibkr::app
