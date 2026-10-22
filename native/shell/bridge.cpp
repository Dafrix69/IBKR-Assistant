#include "shell/bridge.h"

#include "shell/jsvalue.h"
#include "shell/rpc_policy.h"

#include <QDateTime>
#include <QHash>

namespace ibkr::shell {

using namespace Qt::StringLiterals;

namespace {

EngineReply failure(const QString& message) {
    EngineReply r;
    r.error = message;
    return r;
}

QString gateText(const QString& purpose) {
    if (purpose == u"gate.auto_execute") return u"打开后,解析通过的订单会被直接发送到券商,没有人工确认环节。\n建议先在纸面账户跑够之后再打开。"_s;
    if (purpose == u"gate.allow_live_trading") return u"打开后,指向实盘账户的订单不再被拦截,会用真钱成交。"_s;
    return {};
}

/// typeof v === 'string' && v.trim()
bool nonBlankString(const QJsonValue& v) { return v.isString() && !v.toString().trimmed().isEmpty(); }

}  // namespace

Bridge::Bridge(EngineClient* engine, Prompter* prompter, ConsentStore* consent, QObject* parent)
    : QObject(parent), engine_(engine), prompter_(prompter), consent_(consent) {
    now = [] { return QDateTime::currentMSecsSinceEpoch(); };
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

    const auto proceed = [this, method, clean, done](const QJsonValue& current) {
        // 会发单 / 授权发单 / 打开闸门的:要有原生确认框发出的凭据,而且绑的就是这一次的内容
        const QList<GrantNeed> needs = requiredGrants(method, clean, current);
        if (!needs.isEmpty()) {
            const QStringList missing = grants_.consumeAll(needs, now());
            if (!missing.isEmpty()) {
                return done(failure(u"这一步要先在确认框里点确认(%1)。没有确认、确认已过期、或内容在确认之后变了,都不会放行。"_s.arg(missing.join(u"、"_s))));
            }
        }
        if (method == u"data.export") {
            // 引擎会把整本交易记录写到给它的路径上。路径只认用户刚在保存对话框里选的那一个,用一次作废
            if (pickedExportPath_.isEmpty() || clean.value(u"path") != QJsonValue(pickedExportPath_)) {
                return done(failure(u"导出路径必须是刚在保存对话框里选的那一个,请重新点「导出」"_s));
            }
            pickedExportPath_.clear();
        }
        forward(method, clean, done);
    };
    if (method != u"settings.patch") return proceed(QJsonValue(QJsonValue::Null));
    // 放宽限额 / 打开闸门 / 放宽跟单,是对着引擎**现在的**设置算的:读不到就不放行(同 main.js 的 await)
    CallOptions options;
    options.timeoutMs = 8000;
    engine_->call(u"settings.get"_s, QJsonObject{}, options, [proceed, done](const EngineReply& current) {
        if (!current.ok) return done(current);
        proceed(current.result);
    });
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
                            "请先到「订单看板」和券商端核对,不要直接重发;引擎回话后这里会再通知一次。"_s;
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
    const QJsonValue purposeValue = options.value(u"purpose");
    const bool bound = !purposeValue.isUndefined() && !purposeValue.isNull();
    const QString purpose = jsString(purposeValue);
    if (bound && purposeHeadline(purpose).isEmpty()) return done(false, u"未知的确认用途:%1"_s.arg(purpose));
    const QJsonValue label = options.value(u"confirmLabel");
    const QString confirmLabel = (jsTruthy(label) ? jsString(label) : u"确认"_s).left(40);
    const auto show = [this, done, bound, purpose, confirmLabel](ConfirmBox box, const QJsonObject& binding) {
        box.confirmLabel = confirmLabel;
        prompter_->ask(box, [this, done, bound, purpose, binding](bool ok) {
            // 凭据绑的是**摆给人看的那一份**内容,不是页面递过来的原样
            if (ok && bound) {
                try {
                    grants_.issue(purpose, binding, now());
                } catch (const GrantError& e) {
                    return done(false, e.message());
                }
            }
            done(ok, {});
        });
    };
    if (!bound) {
        const QJsonValue title = options.value(u"title");
        const QJsonValue message = options.value(u"message");
        const QJsonValue detail = options.value(u"detail");
        ConfirmBox box;
        box.title = jsTruthy(title) ? jsString(title) : u"确认"_s;
        box.message = jsTruthy(message) ? jsString(message) : QString();
        box.detail = jsTruthy(detail) ? jsString(detail) : QString();
        return show(box, {});
    }
    boundConfirmText(purpose, normalizeBinding(purpose, options.value(u"binding")), options.value(u"message"), options.value(u"detail"),
                     [done, show](std::optional<BoundBox> box, const QString& error) {
                         if (!error.isEmpty()) return done(false, error);
                         // 没有可确认的内容(比如要放宽的限额其实一项都没放宽):不弹框、不发凭据
                         if (!box) return done(true, {});
                         show(box->box, box->binding);
                     });
}

void Bridge::boundConfirmText(const QString& purpose, const QJsonObject& binding, const QJsonValue& message, const QJsonValue& detail,
                              std::function<void(std::optional<BoundBox>, const QString&)> done) {
    const QString headline = purposeHeadline(purpose);
    CallOptions settingsTimeout;
    settingsTimeout.timeoutMs = 8000;
    CallOptions statusTimeout;
    statusTimeout.timeoutMs = 5000;

    if (purpose == u"gate.follow") {
        // 只是往紧了改(少信任一个人、调小上限):不弹框、不发凭据,放行那一头也不会要(requiredGrants 是同一个判断)
        engine_->call(u"settings.get"_s, QJsonObject{}, settingsTimeout, [this, headline, binding, statusTimeout, done](const EngineReply& current) {
            if (!current.ok) return done(std::nullopt, current.error);
            QJsonObject enabled = binding;
            enabled.insert(u"enabled"_s, true);
            if (!followWidened(enabled, current.result.toObject().value(u"follow"))) return done(std::nullopt, {});
            // 框上的每一个字都对着绑定的那一份写;账户是纸面还是实盘问引擎(不答话:类别标「未知」)
            engine_->call(u"system.status"_s, QJsonObject{}, statusTimeout, [headline, binding, done](const EngineReply& status) {
                const QJsonArray accounts = status.ok ? status.result.toObject().value(u"accounts").toArray() : QJsonArray{};
                const FollowConfirmText text = followConfirmText(binding, accounts);
                BoundBox out;
                out.show = true;
                out.box.title = headline;
                out.box.message = text.live ? headline + u"(含实盘账户)"_s : headline;
                out.box.detail = text.detail;
                out.binding = binding;
                done(out, {});
            });
        });
        return;
    }
    if (purpose.startsWith(u"gate.")) {
        BoundBox out;
        out.show = true;
        out.box = {headline, headline, gateText(purpose), {}};
        out.binding = binding;
        return done(out, {});
    }
    if (purpose == u"limits.loosen") {
        // 从多少改到多少,由这里对着引擎现在的设置算:页面说"只是从 5,000 调到 6,000"不作数
        engine_->call(u"settings.get"_s, QJsonObject{}, settingsTimeout, [headline, binding, done](const EngineReply& current) {
            if (!current.ok) return done(std::nullopt, current.error);
            const QList<LoosenedLimit> loosened = loosenedLimits(binding.value(u"limits"), current.result.toObject().value(u"limits"));
            if (loosened.isEmpty()) return done(std::nullopt, {});
            const auto fmt = [](double n) { return std::isfinite(n) ? formatEnUs(n, 4) : u"—"_s; };
            QStringList lines;
            QJsonObject limits;
            for (const LoosenedLimit& l : loosened) {
                lines.append(u"%1:%2 → %3"_s.arg(l.label, fmt(l.from), fmt(l.to)));
                limits.insert(l.key, l.to);
            }
            BoundBox out;
            out.show = true;
            out.box.title = headline;
            out.box.message = headline;
            out.box.detail = lines.join(u'\n') + u"\n\n这些限额是每一笔订单都要过的闸:放宽之后,解析错了的指令能造成的损失也跟着变大。"_s;
            // 只绑真的放宽了的那几项:放行时也是这么算的(requiredGrants)
            out.binding = QJsonObject{{u"limits"_s, limits}};
            done(out, {});
        });
        return;
    }
    if (purpose == u"instruction.submit") {
        // 账户是纸面还是实盘,问引擎,不听页面的(不答话:类别标「未知」,发不发得出去由引擎的闸门说了算)
        engine_->call(u"system.status"_s, QJsonObject{}, statusTimeout, [headline, binding, message, done](const EngineReply& status) {
            QHash<QString, QString> kinds;
            if (status.ok) {
                for (const QJsonValue& a : status.result.toObject().value(u"accounts").toArray()) {
                    kinds.insert(jsString(a.toObject().value(u"alias")), jsTruthy(a.toObject().value(u"is_paper")) ? u"纸面"_s : u"实盘"_s);
                }
            }
            QStringList targets;
            bool live = false;
            const QJsonArray accounts = binding.value(u"accounts").toArray();
            for (const QJsonValue& a : accounts) {
                const QString alias = a.toString();
                const QString kind = kinds.value(alias);
                targets.append(u"%1(%2)"_s.arg(alias, kind.isEmpty() ? u"类别未知"_s : kind));
                if (kind == u"实盘") live = true;
            }
            const QString lead = (jsTruthy(message) ? jsString(message) : QString()).left(600);
            BoundBox out;
            out.show = true;
            out.box.title = headline;
            out.box.message = live ? headline + u"(含实盘账户)"_s : headline;
            out.box.detail = u"%1\n\n指令:%2\n账户:%3%4"_s.arg(lead, binding.value(u"text").toString().left(800),
                                                              targets.isEmpty() ? u"(没有勾选账户)"_s : targets.join(u"、"_s),
                                                              accounts.size() > 1 ? u"\n每笔订单各发 %1 份。"_s.arg(accounts.size()) : QString());
            out.binding = binding;
            done(out, {});
        });
        return;
    }
    QStringList lines;
    for (const QJsonValue& v : {message, detail})
        if (nonBlankString(v)) lines.append(v.toString().left(1200));
    BoundBox out;
    out.show = true;
    out.box = {headline, headline, lines.join(u"\n\n"_s), {}};
    out.binding = binding;
    done(out, {});
}

}  // namespace ibkr::shell
