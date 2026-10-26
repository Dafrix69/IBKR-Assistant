#include "shell/fly_store.h"

#include "shell/bridge.h"
#include "shell/fly_rules.h"

#include <QDateTime>
#include <QPointer>

namespace ibkr::shell {

using namespace Qt::StringLiterals;

FlyStore::FlyStore(fly::StoreDeps deps, QObject* parent) : QObject(parent), deps_(std::move(deps)) {
    plan_ = {{u"form"_s, fly::emptyForm()}, {u"busy"_s, false}, {u"result"_s, QJsonValue()}, {u"failure"_s, QJsonValue()}, {u"resultFor"_s, u""_s},
             {u"auto"_s, false}, {u"at"_s, QJsonValue()}, {u"recorder"_s, QJsonValue()}};
    timer_.setInterval(kAutoRefreshMs);
    connect(&timer_, &QTimer::timeout, this, [this] { run(true); });
}

FlyStore::FlyStore(Bridge* bridge, QObject* parent) : FlyStore(fly::StoreDeps{}, parent) { deps_ = bridgeDeps(bridge, this); }

fly::StoreDeps FlyStore::bridgeDeps(Bridge* bridge, QObject* context) {
    fly::StoreDeps d;
    d.plan = [bridge, context](const QJsonObject& params, fly::StoreDeps::Reply done) { bridge->rpc(context, u"options.fly_plan"_s, params, done); };
    d.recorder = [bridge, context](fly::StoreDeps::Reply done) { bridge->rpc(context, u"options.iv_recorder"_s, QJsonObject{}, done); };
    d.setRecorder = [bridge, context](bool enabled, fly::StoreDeps::Reply done) {
        bridge->rpc(context, u"options.iv_recorder_set"_s, QJsonObject{{u"enabled"_s, enabled}}, done);
    };
    d.entryContext = [bridge, context](fly::StoreDeps::Reply done) { bridge->rpc(context, u"options.entry_context"_s, QJsonObject{}, done); };
    d.nowMs = [] { return double(QDateTime::currentMSecsSinceEpoch()); };
    return d;
}

QJsonObject FlyStore::plan() const { return plan_; }

void FlyStore::loadEntryContext() {
    if (!deps_.entryContext || contextBusy_) return;
    const double now = deps_.nowMs ? deps_.nowMs() : QDateTime::currentMSecsSinceEpoch();
    if (contextAsked_ > 0 && now >= contextAsked_ && now-contextAsked_ < 30000) return;
    contextAsked_ = now; contextBusy_ = true;
    QPointer<FlyStore> self(this);
    deps_.entryContext([self](const EngineReply& r) {
        if (!self) return;
        self->contextBusy_ = false;
        self->entryContext_ = r.ok ? r.result.toObject() : QJsonObject{{"error",r.error}};
        emit self->entryContextChanged();
    });
}

void FlyStore::set(const QJsonObject& part) {
    const bool autoBefore = plan_.value("auto"_L1).toBool();
    for (auto it = part.begin(); it != part.end(); ++it) plan_.insert(it.key(), it.value());
    emit changed();
    // 自动刷新被 run 自己关掉时(失败、表单改坏了)计时器也要跟着停(原版 useStore.subscribe)
    if (plan_.value("auto"_L1).toBool() != autoBefore) sync();
}

void FlyStore::patch(const QJsonObject& part) {
    QJsonObject form = plan_.value("form"_L1).toObject();
    for (auto it = part.begin(); it != part.end(); ++it) form.insert(it.key(), it.value());
    set({{u"form"_s, form}});
}

void FlyStore::reset() {
    set({{u"form"_s, fly::emptyForm()}, {u"result"_s, QJsonValue()}, {u"failure"_s, QJsonValue()}, {u"resultFor"_s, u""_s}, {u"auto"_s, false}, {u"at"_s, QJsonValue()}});
}

void FlyStore::run(bool quiet) {
    if (plan_.value("busy"_L1).toBool()) return;
    const QJsonObject form = plan_.value("form"_L1).toObject();
    if (!fly::formProblems(form).isEmpty()) {
        if (quiet) set({{u"auto"_s, false}});
        return;
    }
    const QString key = fly::formKey(form);
    QJsonObject busy{{u"busy"_s, true}};
    if (!quiet) busy.insert(u"failure"_s, QJsonValue());
    set(busy);
    QPointer<FlyStore> self(this);
    deps_.plan(fly::toParams(form), [self, key, quiet](const EngineReply& r) {
        if (!self) return;
        if (r.ok) {
            self->set({{u"result"_s, r.result}, {u"resultFor"_s, key}, {u"failure"_s, QJsonValue()}, {u"at"_s, self->deps_.nowMs()}});
        } else {
            QJsonObject part{{u"failure"_s, r.error}};
            if (quiet) part.insert(u"auto"_s, false);
            else {
                part.insert(u"result"_s, QJsonValue());
                part.insert(u"resultFor"_s, u""_s);
            }
            self->set(part);
        }
        self->set({{u"busy"_s, false}});
    });
}

void FlyStore::sync() {
    const bool want = visible_ && plan_.value("auto"_L1).toBool();
    if (want && !timer_.isActive()) timer_.start(autoRefreshMs);
    else if (!want && timer_.isActive()) timer_.stop();
}

void FlyStore::setAuto(bool on) {
    set({{u"auto"_s, on}});
    sync();
    if (on) run(true);
}

void FlyStore::setVisible(bool on) {
    visible_ = on;
    sync();
}

void FlyStore::loadRecorder() {
    QPointer<FlyStore> self(this);
    deps_.recorder([self](const EngineReply& r) {
        // 引擎还没起来:面板上那一行先不显示,下次进来再问
        if (self && r.ok) self->set({{u"recorder"_s, r.result}});
    });
}

void FlyStore::setRecorder(bool enabled) {
    QPointer<FlyStore> self(this);
    deps_.setRecorder(enabled, [self](const EngineReply& r) {
        if (!self) return;
        if (r.ok) self->set({{u"recorder"_s, r.result}});
        emit self->recorderDone(r.ok ? QString() : r.error);
    });
}

}  // namespace ibkr::shell
