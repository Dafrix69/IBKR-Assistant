// 按了 Esc(React 版页面在 window 上挂的 keydown):只看不拦。
// 不用 QML 的 Shortcut:它在按键送到焦点项之前就把 Esc 吃掉,抽屉、对话框(Keys.onEscapePressed)就收不到了。
// 原版一下 Esc 两边都收:AntD 的抽屉在自己身上处理,页面在 window 上也听得到。
#pragma once

#include <QEvent>
#include <QKeyEvent>
#include <QObject>

namespace ibkr::app {

class EscapeWatcher : public QObject {
    Q_OBJECT
public:
    using QObject::QObject;
    /// 只听这一个窗口(主窗口;原版的 keydown 挂在主窗口上,提醒小窗、原生确认框里按的 Esc 不算)
    void setWindow(QObject* window) { window_ = window; }

signals:
    void pressed();

protected:
    bool eventFilter(QObject* watched, QEvent* event) override {
        // 同一次按键会沿着窗口、焦点项一路送好几次:只认送到窗口的那一次
        if (event->type() == QEvent::KeyPress && watched->isWindowType() && (!window_ || watched == window_) &&
            static_cast<QKeyEvent*>(event)->key() == Qt::Key_Escape &&
            !static_cast<QKeyEvent*>(event)->isAutoRepeat())
            emit pressed();
        return false;
    }

private:
    QObject* window_ = nullptr;
};

}  // namespace ibkr::app
