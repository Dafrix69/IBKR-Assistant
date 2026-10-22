#include "shell/shell_actions.h"

#include "shell/topbar_state.h"

#include <QJsonArray>

namespace ibkr::shell {

using namespace Qt::StringLiterals;

ShellActions::ShellActions(Bridge* bridge, StatusStore* store, QObject* parent) : QObject(parent), bridge_(bridge), store_(store) {}

void ShellActions::setBusy(bool v) {
    if (busy_ == v) return;
    busy_ = v;
    emit busyChanged();
}

void ShellActions::toggleBrokerConnection() {
    if (busy_) return;
    const QJsonObject status = store_->status();
    const QString gateway = gatewayName(status);
    setBusy(true);
    const auto finish = [this] {
        // 不管成败都刷新状态,界面上的圆点才跟实际一致
        store_->refresh();
        setBusy(false);
    };
    if (status.value(u"broker_connected").toBool()) {
        bridge_->rpc(this, u"broker.disconnect"_s, QJsonObject{}, [this, gateway, finish](const EngineReply& r) {
            if (r.ok) emit notify(u"已断开 %1 连接"_s.arg(gateway), {});
            else store_->showBanner(u"连接失败:%1"_s.arg(r.error));
            finish();
        });
        return;
    }
    bridge_->rpc(this, u"broker.connect"_s, QJsonObject{{u"connections"_s, QJsonValue()}, {u"__confirmed"_s, true}}, [this, finish](const EngineReply& r) {
        if (!r.ok) {
            store_->showBanner(u"连接失败:%1"_s.arg(r.error));
            return finish();
        }
        const QJsonObject result = r.result.toObject();
        const QJsonObject failed = result.value(u"failed").toObject();
        QStringList connected;
        for (const QJsonValue& v : result.value(u"connected").toArray()) connected.append(v.toString());
        // 连上了至少一条:没连上的那几条(常见的是模拟盘 TWS 没开)引擎在后台每 30 秒自动重试,不弹红条,只在通知里带一句。
        // 一条都没连上才是真出了问题,那时照旧弹红条说清原因
        if (!connected.isEmpty()) {
            const QString pending = failed.isEmpty() ? QString() : u";%1 未连上,后台自动重试"_s.arg(failed.keys().join(u"、"_s));
            emit notify(u"已连接"_s, connected.join(u"、"_s) + pending);
        } else if (!failed.isEmpty()) {
            QStringList parts;
            for (auto it = failed.begin(); it != failed.end(); ++it) parts.append(u"%1(%2)"_s.arg(it.key(), it.value().toString()));
            store_->showBanner(u"连接失败:%1"_s.arg(parts.join(u";"_s)));
        }
        finish();
    });
}

void ShellActions::toggleBreaker() {
    if (busy_) return;
    const bool engaged = store_->status().value(u"breaker").toObject().value(u"engaged").toBool();
    setBusy(true);
    const auto finish = [this] {
        store_->refresh();
        setBusy(false);
    };
    if (engaged) {
        bridge_->rpc(this, u"breaker.resume"_s, QJsonObject{}, [this, finish](const EngineReply& r) {
            if (r.ok) emit notify(u"已解除熔断"_s, {});
            else store_->showBanner(u"操作失败:%1"_s.arg(r.error));
            finish();
        });
        return;
    }
    bridge_->rpc(this, u"breaker.halt"_s, QJsonObject{{u"reason"_s, u"用户在界面上按下暂停"_s}}, [this, finish](const EngineReply& r) {
        if (!r.ok) {
            store_->showBanner(u"操作失败:%1"_s.arg(r.error));
            return finish();
        }
        const QJsonObject result = r.result.toObject();
        emit notify(u"已熔断"_s, u"撤销未成交单 %1 笔"_s.arg(result.value(u"cancelled").toInt(0)));
        // 闸合上了,但撤单那一步没做成(券商没回应):挂单可能还在券商那边。人以为"熔断 = 挂单都撤了",其实得自己去 TWS 里看
        const QString warning = result.value(u"warning").toString();
        if (!warning.isEmpty()) store_->showBanner(u"已熔断,但撤单没有确认:%1"_s.arg(warning));
        finish();
    });
}

void ShellActions::haltFromMenu(const QString& reason, bool unseen) {
    bridge_->rpc(this, u"breaker.halt"_s, QJsonObject{{u"reason"_s, reason}}, [this, unseen](const EngineReply& r) {
        if (r.ok) {
            store_->refresh();  // 同 main.js 补发的 breaker 事件:状态一回来,顶栏与「已熔断」那条横幅就跟着变
            if (unseen) emit systemNotice(u"已暂停全部自动执行"_s, u"熔断已生效。恢复要回到应用里操作。"_s);
        } else {
            store_->showBanner(r.error);
            if (unseen) emit systemNotice(u"熔断没有生效"_s, r.error);
        }
    });
}

}  // namespace ibkr::shell
