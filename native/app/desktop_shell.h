// 主进程里"窗口与菜单"的那几样(main.js 的 buildMenu / macMenuTemplate / buildDockMenu / hideMainWindow / showMainWindow /
// 窗口位置记忆 / 单实例的 second-instance):
//   · 菜单栏:应用菜单(关于、设置…)、交易(熔断 ⌘⇧H、刷新 ⌘R)、编辑、窗口(⌘W 只藏、⌘0 叫回)、帮助(导出诊断、显示日志);
//     每一项都写中文(系统补进应用菜单的「隐藏」那几项由 MenuTranslator 给中文名);
//   · Dock 菜单:显示主窗口、熔断——窗口藏着的时候这是离熔断最近的地方;
//   · macOS 上关窗只是藏起来,应用留在 Dock 里(提醒的轮询、托管单的节拍都还在跑);点 Dock 图标叫回来;
//     第一次藏起来时发一条系统通知说"还在运行";
//   · 窗口的位置与大小记在 window-state.json(与 Electron 版同一份);
//   · 同一份 userData 只开一个 Qt 版:第二次打开只是把已经开着的那个叫到前台。
#pragma once

#include <QLocalServer>
#include <QMenu>
#include <QMenuBar>
#include <QObject>
#include <QPointer>
#include <QQuickWindow>
#include <QRect>
#include <QTranslator>

#include <memory>

namespace ibkr::shell {
class Alerter;
class ShellActions;
class StatusStore;
}  // namespace ibkr::shell

namespace ibkr::app {

class PowerController;

/// 系统补进 macOS 应用菜单的那几项(服务、隐藏…)的中文名;用词照 macOS 简体中文系统自己的叫法
class MenuTranslator : public QTranslator {
public:
    QString translate(const char* context, const char* source, const char* disambiguation, int n) const override;
    bool isEmpty() const override { return false; }
};

class DesktopShell : public QObject {
    Q_OBJECT
public:
    struct Deps {
        shell::ShellActions* actions = nullptr;
        shell::StatusStore* status = nullptr;
        shell::Alerter* alerter = nullptr;
        QString logPath;
        QString userDataDir;
        PowerController* power = nullptr;
    };
    explicit DesktopShell(Deps deps, QObject* parent = nullptr);
    ~DesktopShell() override;

    /// 同一份 userData 已经有一个 Qt 版开着:叫它到前台,返回 true(调用方随即退出)
    static bool handOffToRunningInstance(const QString& userDataDir);
    /// 当上"开着的那一个",以后第二次打开的都来叫我
    void listenForSecondInstances();

    /// 记下的窗口位置(不在任何一块屏上就是空的)
    QRect savedBounds(bool* maximized) const;
    void attach(QQuickWindow* main);
    /// 菜单里的跳页:先把窗口叫出来
    void navigate(const QString& page);
    void showMainWindow();
    bool quitting() const { return quitting_; }
    /// 退出前的收尾做完了(引擎停稳、合盖睡眠恢复):真的退出
    void finishQuit();
    /// 菜单「刷新状态」与「最小化」:macOS 上由全局菜单栏的快捷键接;别的平台菜单栏还没挂进窗口,Main.qml 的 Shortcut 调这两个
    Q_INVOKABLE void refreshFromMenu();
    Q_INVOKABLE void minimizeFromMenu();

signals:
    /// 菜单「刷新状态」:交易记录与条件单跟着重读
    void refreshRequested();
    /// 帮助 → 导出诊断信息…(交给界面去发起,同 main.js 的 supportFromMenu)
    void supportRequested(const QString& action);
    /// 有人要退出(⌘Q、Dock 的「退出」、关机):先收尾,收完调 finishQuit(同 main.js 的 before-quit)
    void quitRequested();

protected:
    bool eventFilter(QObject* watched, QEvent* event) override;

private:
    void buildMenus();
    void hideMainWindow();
    void saveBounds();
    void haltFromMenu(const QString& reason);
    void editAction(const char* method);

    Deps deps_;
    QPointer<QQuickWindow> main_;
    std::unique_ptr<QMenuBar> menuBar_;
    std::unique_ptr<QMenu> dockMenu_;
    std::unique_ptr<QLocalServer> server_;
    QRect normalBounds_;
    bool quitting_ = false;
    bool finalQuit_ = false;
    bool hiddenHintShown_ = false;
};

}  // namespace ibkr::app
