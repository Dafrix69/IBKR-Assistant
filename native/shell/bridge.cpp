#include "shell/bridge.h"

#include "shell/jsvalue.h"
#include "shell/rpc_policy.h"

namespace ibkr::shell {

using namespace Qt::StringLiterals;

namespace {

EngineReply failure(const QString& message) {
    EngineReply r;
    r.error = message;
    return r;
}

}  // namespace

Bridge::Bridge(EngineClient* engine, Prompter* prompter, ConsentStore* consent, QObject* parent)
    : QObject(parent), engine_(engine), prompter_(prompter), consent_(consent) {
    // 发单类调用超时之后,引擎才回话:补报这次操作到底执行了没有(main.js 的 late-reply)
    connect(engine_, &EngineClient::lateReply, this, [this](const LateReply& late) {
        if (!outcomeUnknownRpc().contains(late.method)) return;
        emit lateOutcome(outcomeLabel(late.method), late.ok, late.error, late.waitedMs);
    });
}

void Bridge::rpc(const QString& method, const QJsonValue& params, RpcDone done) {
    if (!allowedRpc().contains(method)) return done(failure(u"方法不在白名单中:%1"_s.arg(method)));
    const QJsonObject p = params.toObject();
    if (sensitiveRpc().contains(method) && p.value(u"__confirmed") != QJsonValue(true)) {
        return done(failure(u"敏感操作缺少界面确认标记,已拒绝"_s));
    }
    QJsonObject clean = p;
    clean.remove(u"__confirmed"_s);
    // 没同意现行条款之前,钱路径一律不放行
    const QString blocked = ConsentStore::blockedWithoutConsent(method, clean);
    if (!blocked.isEmpty() && !consent_->state().accepted) return done(failure(blocked));

    if (method == u"data.export") {
        // 引擎会把整本交易记录写到给它的路径上。路径只认用户刚在保存对话框里选的那一个,用一次作废
        if (pickedExportPath_.isEmpty() || clean.value(u"path") != QJsonValue(pickedExportPath_)) {
            return done(failure(u"导出路径必须是刚在保存对话框里选的那一个,请重新点「导出」"_s));
        }
        pickedExportPath_.clear();
    }
    forward(method, clean, done);
}

void Bridge::forward(const QString& method, const QJsonObject& clean, RpcDone done) {
    if (!outcomeUnknownRpc().contains(method)) return engine_->call(method, clean, {}, done);
    CallOptions options;
    options.lateReply = true;
    options.timeoutMs = outcomeTimeoutMs;
    engine_->call(method, clean, options, [done](const EngineReply& reply) {
        if (!reply.ok && reply.code == u"ENGINE_TIMEOUT") {
            EngineReply unknown = reply;
            unknown.error = u"结果未知:引擎 2 分钟内没有回话,这次操作可能已经执行(订单可能已经发出)。"
                            u"请先到「订单看板」和券商端核对,不要直接重发;引擎回话后这里会再通知一次。"_s;
            return done(unknown);
        }
        done(reply);
    });
}

void Bridge::rpc(QObject* context, const QString& method, const QJsonValue& params, RpcDone done) {
    rpc(method, params, [ctx = QPointer<QObject>(context), done = std::move(done)](const EngineReply& r) {
        if (ctx) done(r);
    });
}

void Bridge::confirm(QObject* context, const QJsonObject& options, ConfirmDone done) {
    confirm(options, [ctx = QPointer<QObject>(context), done = std::move(done)](bool ok, const QString& error) {
        if (ctx) done(ok, error);
    });
}

void Bridge::confirm(const QJsonObject& options, ConfirmDone done) {
    // 带用途的(发单、平仓、放宽限额……)不再弹框
    const QJsonValue purpose = options.value(u"purpose");
    if (!purpose.isUndefined() && !purpose.isNull()) return done(true, {});
    const QJsonValue label = options.value(u"confirmLabel");
    const QJsonValue title = options.value(u"title");
    const QJsonValue message = options.value(u"message");
    const QJsonValue detail = options.value(u"detail");
    ConfirmBox box;
    box.title = jsTruthy(title) ? jsString(title) : u"确认"_s;
    box.message = jsTruthy(message) ? jsString(message) : QString();
    box.detail = jsTruthy(detail) ? jsString(detail) : QString();
    box.confirmLabel = (jsTruthy(label) ? jsString(label) : u"确认"_s).left(40);
    prompter_->ask(box, [done](bool ok) { done(ok, {}); });
}

}  // namespace ibkr::shell
