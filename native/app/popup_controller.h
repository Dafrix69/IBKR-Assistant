// 提醒小窗的窗口那一半(desktop/popup-window.js 的 PopupManager 里跟窗口有关的部分):
//   · 有新条目:没露面就挑光标所在那块屏、摆在工作区右上角、不激活地显示;已经露着就只改高度、提到最上层(不跟着光标换屏);
//   · 关光了就收起;插拔显示器、改分辨率时重摆;存的那块屏没了就重挑(不把窗留在屏幕外);
//   · 主窗口不在前台时 Dock 跳一次(已经在跳就不再调:macOS 上每调一次都是一次新的请求),主窗口回到前台就清零;
//   · 「查看」:把主窗口叫到前台、跳页。
// 列表本身在 shell::PopupQueue;小窗的样子在 shell/AlertPopup.qml。
#pragma once

#include "shell/popup_rules.h"

#include <QObject>
#include <QPointer>
#include <QQuickWindow>
#include <QRect>

namespace ibkr::app {

class PopupController : public QObject {
    Q_OBJECT
public:
    PopupController(shell::PopupQueue* queue, QObject* parent = nullptr);
    /// popup:AlertPopup.qml 的窗口;main:主窗口。主窗口的 QML 根要有 navigateTo(page, symbol)
    void attach(QQuickWindow* popup, QQuickWindow* main);
    /// 小窗里内容的高度(QML 报上来)
    Q_INVOKABLE void setContentHeight(qreal height);

private:
    void reveal();
    void place();
    void hide();
    QRect pickWorkArea() const;
    bool anchorStillThere() const;
    void flashMain(bool on);
    void openFromPopup(const QString& page, const QString& symbol);

    shell::PopupQueue* queue_;
    QPointer<QQuickWindow> popup_;
    QPointer<QQuickWindow> main_;
    qreal height_ = shell::popup::kMinHeight;
    QRect anchor_;
    bool flashing_ = false;
};

}  // namespace ibkr::app
