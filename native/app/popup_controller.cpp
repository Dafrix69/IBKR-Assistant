#include "popup_controller.h"

#include "platform.h"

#include <QCursor>
#include <QGuiApplication>
#include <QScreen>
#include <QTimer>

namespace ibkr::app {

PopupController::PopupController(shell::PopupQueue* queue, QObject* parent) : QObject(parent), queue_(queue) {
    connect(queue_, &shell::PopupQueue::arrived, this, [this] {
        // 等 QML 按新列表排好、报上高度再露面,免得先闪一个高度不对的窗
        QTimer::singleShot(0, this, &PopupController::reveal);
    });
    connect(queue_, &shell::PopupQueue::changed, this, [this] {
        if (queue_->items().isEmpty()) hide();
    });
    connect(queue_, &shell::PopupQueue::navigateRequested, this, &PopupController::openFromPopup);
    const auto watch = [this](QScreen* s) {
        connect(s, &QScreen::availableGeometryChanged, this, [this] { if (popup_ && popup_->isVisible()) place(); });
    };
    for (QScreen* s : QGuiApplication::screens()) watch(s);
    connect(qApp, &QGuiApplication::screenAdded, this, [this, watch](QScreen* s) {
        watch(s);
        if (popup_ && popup_->isVisible()) place();
    });
    connect(qApp, &QGuiApplication::screenRemoved, this, [this] { if (popup_ && popup_->isVisible()) place(); });
}

void PopupController::attach(QQuickWindow* popup, QQuickWindow* main) {
    popup_ = popup;
    main_ = main;
    // 用户把主窗口点到前台,系统自己会停掉 Dock 的跳:标记跟着清零,之后切走再来的提醒还能跳
    if (main_) connect(main_, &QWindow::activeChanged, this, [this] { if (main_ && main_->isActive()) flashing_ = false; });
}

void PopupController::setContentHeight(qreal height) {
    if (!(height > 0)) return;
    height_ = std::min(std::ceil(height), 10000.0);
    if (popup_ && popup_->isVisible()) place();
}

void PopupController::reveal() {
    if (!popup_ || queue_->items().isEmpty()) return;
    if (!popup_->isVisible()) {
        anchor_ = QRect();  // 每次从头露面都重挑一块屏
        place();
        // 绝不 requestActivate:焦点被抢走,正在 TWS 里敲的数量就打进别处了
        popup_->show();
        // 每次露面都设一遍:Qt 每次 show 可能按窗口标志重设层级与 collectionBehavior,只设第一次的话第二次起就压不过 TWS 的对话框
        platform::makeFloatingPanel(popup_);
    } else {
        place();
        popup_->raise();  // 别的置顶窗口可能压在它上面;raise 只调层级,不激活
    }
    flashMain(true);
}

void PopupController::place() {
    if (!popup_) return;
    // 存的那块屏可能已经被拔了 / 改了分辨率:再按它摆就摆到屏幕外面去了
    if (!anchor_.isNull() && !anchorStillThere()) anchor_ = QRect();
    if (anchor_.isNull()) anchor_ = pickWorkArea();
    if (anchor_.isNull()) return;
    popup_->setGeometry(shell::popup::bounds(QRectF(anchor_), height_));
}

void PopupController::hide() {
    if (popup_) popup_->hide();
    anchor_ = QRect();
    flashMain(false);  // 提醒都关掉了,Dock 也别再跳
}

QRect PopupController::pickWorkArea() const {
    // 光标所在的那块屏:用户正看着的地方,多屏时比主屏更可能被看见
    QScreen* screen = QGuiApplication::screenAt(QCursor::pos());
    if (!screen) screen = QGuiApplication::primaryScreen();
    return screen ? screen->availableGeometry() : QRect();
}

bool PopupController::anchorStillThere() const {
    const QList<QScreen*> screens = QGuiApplication::screens();
    if (screens.isEmpty()) return true;  // 取不到显示器列表就当它还在,别为了保险乱挪窗
    for (QScreen* s : screens)
        if (s->availableGeometry() == anchor_) return true;
    return false;
}

void PopupController::flashMain(bool on) {
    if (!main_) {
        flashing_ = false;
        return;
    }
    if (!on) {
        if (flashing_) platform::requestAttention(main_, false);
        flashing_ = false;
    } else if (main_->isActive()) {
        flashing_ = false;  // 人就在主窗口前,不用叫他
    } else if (!flashing_) {
        platform::requestAttention(main_, true);
        flashing_ = true;
    }
}

void PopupController::openFromPopup(const QString& page, const QString& symbol) {
    if (!main_) return;
    if (main_->visibility() == QWindow::Minimized) main_->showNormal();
    if (!main_->isVisible()) main_->show();
    platform::activateApp();
    main_->raise();
    main_->requestActivate();
    QMetaObject::invokeMethod(main_, "navigateTo", Q_ARG(QVariant, page), Q_ARG(QVariant, symbol));
}

}  // namespace ibkr::app
