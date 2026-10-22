#include "qml_bridge.h"

#include <QJSEngine>
#include <QJsonDocument>
#include <QPointer>

namespace ibkr::app {

namespace {

QJsonValue toJson(const QJSValue& v) {
    if (v.isUndefined() || v.isNull()) return QJsonValue(QJsonValue::Null);
    return QJsonValue::fromVariant(v.toVariant(QJSValue::ConvertJSObjects));
}

}  // namespace

QmlBridge::QmlBridge(shell::Bridge* bridge, QJSEngine* js, QObject* parent) : QObject(parent), bridge_(bridge), js_(js) {}

void QmlBridge::call(const QString& method, const QJSValue& params, const QJSValue& callback) {
    QPointer<QmlBridge> self(this);
    bridge_->rpc(method, toJson(params), [self, callback](const shell::EngineReply& reply) mutable {
        if (!self || !callback.isCallable()) return;
        callback.call({QJSValue(reply.ok), self->js_->toScriptValue(reply.result.toVariant()), QJSValue(reply.error), QJSValue(reply.code)});
    });
}

void QmlBridge::ask(const QJSValue& options, const QJSValue& callback) {
    QPointer<QmlBridge> self(this);
    bridge_->confirm(toJson(options).toObject(), [self, callback](bool confirmed, const QString& error) mutable {
        if (!self || !callback.isCallable()) return;
        callback.call({QJSValue(confirmed), QJSValue(error)});
    });
}

}  // namespace ibkr::app
