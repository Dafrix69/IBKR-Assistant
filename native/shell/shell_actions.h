// 顶栏两个按钮背后的动作:连接 / 断开券商、熔断 / 解除熔断。照 store/broker.ts。
// 走的是 Bridge(白名单、确认标记……):broker.connect 是敏感方法,带 __confirmed;halt / resume 不是。
#pragma once

#include "shell/bridge.h"
#include "shell/status_store.h"

#include <QObject>

namespace ibkr::shell {

class ShellActions : public QObject {
    Q_OBJECT
    Q_PROPERTY(bool busy READ busy NOTIFY busyChanged)
public:
    ShellActions(Bridge* bridge, StatusStore* store, QObject* parent = nullptr);

    bool busy() const { return busy_; }
    /// 状态上是连着就断开,没连就连;done 在状态刷新之后回
    Q_INVOKABLE void toggleBrokerConnection();
    Q_INVOKABLE void toggleBreaker();
    /// 菜单 / Dock 菜单 / ⌘⇧H 的熔断(main.js 的 haltFromMenu):只熔断、不解除。窗口藏着时(unseen)界面上那条回执没人看得见,
    /// 结果另发一条系统通知(systemNotice)
    Q_INVOKABLE void haltFromMenu(const QString& reason, bool unseen);

signals:
    void busyChanged();
    /// 给通知条(pushNotification)
    void notify(const QString& title, const QString& body);
    /// 要发系统通知的一条(窗口藏着时的熔断回执)
    void systemNotice(const QString& title, const QString& body);

private:
    void setBusy(bool v);

    Bridge* bridge_;
    StatusStore* store_;
    bool busy_ = false;
};

}  // namespace ibkr::shell
