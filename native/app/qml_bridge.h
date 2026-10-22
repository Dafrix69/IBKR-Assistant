// QML 那一层到 shell::Bridge 的转接:把 JS 的值换成 JSON、回话再换回 JS 值。只转,不判断——放不放行全在 Bridge。
//
//   bridge.call("system.status", {}, function (ok, result, error, code) { … })
//   bridge.ask({ purpose: "instruction.submit", binding: { text, accounts } }, function (confirmed, error) { … })
#pragma once

#include "shell/bridge.h"

#include <QJSValue>
#include <QObject>

class QJSEngine;

namespace ibkr::app {

class QmlBridge : public QObject {
    Q_OBJECT
public:
    QmlBridge(shell::Bridge* bridge, QJSEngine* js, QObject* parent = nullptr);

    Q_INVOKABLE void call(const QString& method, const QJSValue& params, const QJSValue& callback);
    Q_INVOKABLE void ask(const QJSValue& options, const QJSValue& callback);

private:
    shell::Bridge* bridge_;
    QJSEngine* js_;
};

}  // namespace ibkr::app
