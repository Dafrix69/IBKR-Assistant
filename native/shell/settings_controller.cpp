#include "shell/settings_controller.h"

#include "shell/bridge.h"
#include "shell/events_store.h"
#include "shell/jsvalue.h"
#include "shell/settings_rules.h"
#include "shell/status_store.h"

#include <QJsonArray>
#include <QPointer>

namespace ibkr::shell {

using namespace Qt::StringLiterals;

namespace {

/// InputNumber 的 onChange:null 是清空了,别的是数
QJsonValue numOrNull(const QVariant& v) {
    if (!v.isValid() || v.isNull()) return QJsonValue::Null;
    bool ok = false;
    const double x = v.toDouble(&ok);
    return ok ? QJsonValue(x) : QJsonValue(QJsonValue::Null);
}

const QStringList kSwitches{u"autoExecute"_s, u"allowLive"_s, u"triggerVerify"_s, u"slGuard"_s, u"ddGuard"_s, u"coolOn"_s, u"dailyOn"_s, u"rbOn"_s};

}  // namespace

SettingsController::SettingsController(Bridge* bridge, StatusStore* status, EventsStore* events, QObject* parent)
    : QObject(parent), bridge_(bridge), status_(status), events_(events) {
    eventsTimer_.setSingleShot(true);
    connect(&eventsTimer_, &QTimer::timeout, this, &SettingsController::flushEvents);
    // 重要事件的草稿跟着 store 里的口径走;正在等防抖时不动(EventsConfig 的 if (!pending.current) setDraft(config))
    if (events_)
        connect(events_, &EventsStore::changed, this, [this] {
            if (!visible_ || eventsTimer_.isActive()) return;
            const QJsonObject config = events_->config();
            const QJsonValue next = config.isEmpty() ? QJsonValue(QJsonValue::Null) : QJsonValue(config);
            if (next == eventsDraft_) return;
            eventsDraft_ = next;
            rebuild();
        });
    rebuild();
}

void SettingsController::setVisible(bool on) {
    if (on == visible_) return;
    // 离开页面:没存的口径补存(EventsConfig 卸载时的那一下)
    if (!on && eventsTimer_.isActive()) {
        eventsTimer_.stop();
        flushEvents();
    }
    visible_ = on;
    ++generation_;
    saved_ = form_ = dataInfo_ = dataBusy_ = eventsDraft_ = QJsonValue::Null;
    saving_ = checked_ = false;
    dataError_.clear();
    eventsDirty_ = {};
    if (on) {
        if (events_ && !events_->config().isEmpty()) eventsDraft_ = events_->config();
        load();
        loadBackups();
    }
    rebuild();
}

void SettingsController::onEngineEvent(const QString& event) {
    if (event == u"settings" && visible_) load();
}

void SettingsController::rebuild() {
    settings::PageInput in;
    in.saved = saved_;
    in.form = form_;
    in.saving = saving_;
    in.checked = checked_;
    in.dataInfo = dataInfo_;
    in.dataError = dataError_;
    in.dataBusy = dataBusy_;
    in.eventsDraft = eventsDraft_;
    model_ = settings::pageModel(in, zone);
    emit changed();
}

void SettingsController::load() {
    const int gen = generation_;
    QPointer<SettingsController> self(this);
    bridge_->rpc(this, u"settings.get"_s, QJsonObject{}, [self, gen](const EngineReply& r) {
        if (!self) return;
        if (!r.ok) {
            if (self->status_) self->status_->showError(u"读取设置失败:"_s + r.error);
            return;
        }
        if (gen != self->generation_) return;
        self->saved_ = r.result;
        self->form_ = settings::toForm(r.result);
        self->rebuild();
    });
}

void SettingsController::setField(const QString& key, const QVariant& value) {
    if (!form_.isObject()) return;
    QJsonObject f = form_.toObject();
    if (key.startsWith(u"rbEquity:"_s)) {
        QJsonObject eq = f[u"rbEquity"_s].toObject();
        eq[key.mid(9)] = numOrNull(value);
        f[u"rbEquity"_s] = eq;
    } else if (key == u"coolScope") {
        f[key] = value.toString() == u"position" ? u"position"_s : u"symbol"_s;
    } else if (key == u"dailyBasis") {
        f[key] = value.toString() == u"account" ? u"account"_s : u"realized"_s;
    } else if (kSwitches.contains(key)) {
        f[key] = value.toBool();
    } else if (f.contains(key)) {
        f[key] = numOrNull(value);
    } else {
        return;
    }
    form_ = f;
    rebuild();
}

void SettingsController::setAccountLimit(const QString& alias, const QString& key, const QVariant& value) {
    if (!form_.isObject()) return;
    QJsonObject f = form_.toObject();
    QJsonObject by = f[u"byAccount"_s].toObject();
    if (!by.contains(alias)) return;
    QJsonObject own = by[alias].toObject();
    if (!own.contains(key)) return;
    own[key] = numOrNull(value);
    by[alias] = own;
    f[u"byAccount"_s] = by;
    form_ = f;
    rebuild();
}

void SettingsController::setGate(const QString& key, bool on) {
    if (!form_.isObject() || (key != u"autoExecute" && key != u"allowLive")) return;
    const QString policy = key == u"autoExecute" ? u"auto_execute"_s : u"allow_live_trading"_s;
    QJsonObject f = form_.toObject();
    f[key] = on;
    form_ = f;
    rebuild();
    // 关是当场生效的,不等「保存设置」(切走页面这次修改就丢了——人以为关了,其实还开着);开照旧跟着保存走
    if (on || !jsTruthy(saved_.toObject()[u"policies"_s].toObject()[policy])) return;
    const int gen = generation_;
    QPointer<SettingsController> self(this);
    bridge_->rpc(this, u"settings.patch"_s, QJsonObject{{u"patch"_s, QJsonObject{{u"policies"_s, QJsonObject{{policy, false}}}}}, {u"__confirmed"_s, true}},
                 [self, gen, key, policy](const EngineReply& r) {
                     if (!self) return;
                     if (r.ok) {
                         if (gen == self->generation_) {
                             self->saved_ = r.result;
                             self->rebuild();
                         }
                         if (self->status_) {
                             self->status_->showInfo(policy == u"auto_execute" ? u"已关闭自动执行,当场生效。"_s : u"已关闭实盘账户下单,当场生效。"_s);
                             self->status_->refresh();
                         }
                         return;
                     }
                     if (gen == self->generation_ && self->form_.isObject()) {
                         QJsonObject back = self->form_.toObject();
                         back[key] = true;
                         self->form_ = back;
                         self->rebuild();
                     }
                     if (self->status_) self->status_->showError(u"没有关掉:"_s + r.error);
                 });
}

void SettingsController::save() {
    if (!form_.isObject()) return;
    const QJsonObject form = form_.toObject();
    checked_ = true;
    rebuild();
    const QStringList problems = settings::formProblems(form, settings::accountOrder(saved_));
    if (!problems.isEmpty()) {
        if (status_)
            status_->showError(u"还不能保存:%1%2"_s.arg(problems.first(), problems.size() > 1 ? u"(另有 %1 处)"_s.arg(problems.size() - 1) : QString()));
        return;
    }
    const QJsonObject policies = saved_.toObject()[u"policies"_s].toObject();
    const int gen = generation_;
    QPointer<SettingsController> self(this);
    // 三步依次:打开自动执行 → 允许实盘 → 放宽限额;任一步点了取消就停(前两步还把那个开关拨回去)
    const auto unset = [self, gen](const QString& key) {
        if (!self || gen != self->generation_ || !self->form_.isObject()) return;
        QJsonObject f = self->form_.toObject();
        f[key] = false;
        self->form_ = f;
        self->rebuild();
    };
    const auto send = [self, gen, form] {
        if (!self || gen != self->generation_) return;
        const QJsonObject next = settings::toPatch(form, self->saved_);
        self->bridge_->confirm(self, QJsonObject{{u"purpose"_s, u"limits.loosen"_s}, {u"binding"_s, QJsonObject{{u"limits"_s, next[u"limits"_s]}}},
                                                 {u"title"_s, u"放宽风控限额"_s}, {u"message"_s, QString()}, {u"confirmLabel"_s, u"我明白,放宽"_s}},
                               [self, gen, next](bool ok, const QString&) {
                                   if (!ok || !self || gen != self->generation_) return;
                                   self->saving_ = true;
                                   self->rebuild();
                                   self->bridge_->rpc(self, u"settings.patch"_s, QJsonObject{{u"patch"_s, next}, {u"__confirmed"_s, true}}, [self, gen](const EngineReply& r) {
                                       if (!self) return;
                                       if (r.ok) {
                                           if (self->status_) self->status_->showInfo(u"设置已保存,提示词与限额已同步更新。"_s);
                                           if (gen == self->generation_) {
                                               self->checked_ = false;
                                               self->load();
                                           }
                                           if (self->status_) self->status_->refresh();
                                       } else if (self->status_) {
                                           self->status_->showError(u"保存失败(配置未改动):"_s + r.error);
                                       }
                                       if (gen != self->generation_) return;
                                       self->saving_ = false;
                                       self->rebuild();
                                   });
                               });
    };
    const bool askLive = form[u"allowLive"_s].toBool() && !jsTruthy(policies[u"allow_live_trading"_s]);
    const auto live = [self, gen, askLive, send, unset] {
        if (!self || gen != self->generation_) return;
        if (!askLive) return send();
        self->bridge_->confirm(self, QJsonObject{{u"purpose"_s, u"gate.allow_live_trading"_s}, {u"title"_s, u"允许实盘下单"_s}, {u"message"_s, QString()},
                                                 {u"confirmLabel"_s, u"我明白,打开实盘"_s}},
                               [send, unset](bool ok, const QString&) {
                                   if (!ok) return unset(u"allowLive"_s);
                                   send();
                               });
    };
    if (form[u"autoExecute"_s].toBool() && !jsTruthy(policies[u"auto_execute"_s])) {
        bridge_->confirm(this, QJsonObject{{u"purpose"_s, u"gate.auto_execute"_s}, {u"title"_s, u"打开自动执行"_s}, {u"message"_s, QString()},
                                           {u"confirmLabel"_s, u"我明白,打开"_s}},
                         [live, unset](bool ok, const QString&) {
                             if (!ok) return unset(u"autoExecute"_s);
                             live();
                         });
        return;
    }
    live();
}

// ---- 重要事件的口径 ---------------------------------------------------------------------------------

void SettingsController::setEvent(const QString& key, const QVariant& value) {
    if (!eventsDraft_.isObject()) return;
    const QJsonObject d = eventsDraft_.toObject();
    if (key == u"enabled" || key == u"feed" || key == u"cross_market") return patchEvents(QJsonObject{{key, value.toBool()}}, true);
    const QJsonValue v = numOrNull(value);
    if (key == u"lead1" || key == u"lead2") {
        const QJsonArray leads = d[u"lead_minutes"_s].toArray();
        QJsonValue a = leads.size() > 0 ? leads.at(0) : QJsonValue(QJsonValue::Null);
        QJsonValue b = leads.size() > 1 ? leads.at(1) : QJsonValue(QJsonValue::Null);
        (key == u"lead1" ? a : b) = v;
        QJsonArray next;
        for (const QJsonValue& x : {a, b})
            if (!x.isNull()) next.append(x);
        return patchEvents(QJsonObject{{u"lead_minutes"_s, next}}, false);
    }
    if (v.isNull()) return;  // 这几格清空了不算数(原版 if (v !== null))
    if (key == u"sector_share") return patchEvents(QJsonObject{{key, v.toDouble() / 100}}, false);
    static const QStringList numbers{u"min_stars"_s, u"cross_market_pct"_s, u"cross_lag_pct"_s, u"sector_move_pct"_s, u"sector_min_stocks"_s};
    if (numbers.contains(key)) patchEvents(QJsonObject{{key, v}}, false);
}

void SettingsController::patchEvents(const QJsonObject& part, bool now) {
    QJsonObject d = eventsDraft_.toObject();
    for (auto it = part.begin(); it != part.end(); ++it) {
        d[it.key()] = it.value();
        eventsDirty_[it.key()] = it.value();
    }
    eventsDraft_ = d;
    rebuild();
    eventsTimer_.stop();
    if (now) flushEvents();
    else eventsTimer_.start(eventsDebounceMs);
}

void SettingsController::flushEvents() {
    const QJsonObject part = eventsDirty_;
    eventsDirty_ = {};
    if (!part.isEmpty()) saveEvents(part);
}

void SettingsController::saveEvents(const QJsonObject& part) {
    if (!events_) return;
    QPointer<SettingsController> self(this);
    events_->saveConfig(part, [self](const QString& problem) {
        if (self && !problem.isEmpty() && self->status_) self->status_->showError(u"没改成:"_s + problem);
    });
}

// ---- 数据与备份 ------------------------------------------------------------------------------------

void SettingsController::loadBackups() {
    const int gen = generation_;
    QPointer<SettingsController> self(this);
    bridge_->rpc(this, u"data.backups"_s, QJsonObject{}, [self, gen](const EngineReply& r) {
        if (!self || gen != self->generation_) return;
        if (r.ok) {
            self->dataInfo_ = r.result;
            self->dataError_.clear();
        } else {
            self->dataError_ = r.error;
        }
        self->rebuild();
    });
}

void SettingsController::backupNow() {
    dataBusy_ = u"backup"_s;
    rebuild();
    const int gen = generation_;
    QPointer<SettingsController> self(this);
    bridge_->rpc(this, u"data.backup"_s, QJsonObject{}, [self, gen](const EngineReply& r) {
        if (!self) return;
        if (r.ok) {
            const QJsonObject b = r.result.toObject()[u"backup"_s].toObject();
            if (self->status_) self->status_->showInfo(u"已备份:%1(%2)"_s.arg(jsString(b[u"name"_s]), settings::fmtBytes(jsNumber(b[u"bytes"_s]))));
            if (gen == self->generation_) self->loadBackups();
        } else if (self->status_) {
            self->status_->showError(r.error);
        }
        if (gen != self->generation_) return;
        self->dataBusy_ = QJsonValue::Null;
        self->rebuild();
    });
}

void SettingsController::restoreBackup(const QString& name) {
    if (!restore || dataBusy_.isString()) return;
    dataBusy_ = name;
    rebuild();
    const int gen = generation_;
    QPointer<SettingsController> self(this);
    restore(name, [self, gen](const QJsonObject& result, const QString& error) {
        if (!self) return;
        if (!error.isEmpty()) {
            if (self->status_) self->status_->showError(u"恢复没有成功:"_s + error);
        } else if (result[u"ok"_s].toBool()) {
            if (self->status_) self->status_->showInfo(u"交易库已恢复,交易引擎正在重启。请核对追踪与挂单状态。"_s);
            // 引擎重启要几秒:等它起来再读清单与状态
            QTimer::singleShot(self->restoreRefreshMs, self, [self, gen] {
                if (!self) return;
                if (gen == self->generation_) self->loadBackups();
                if (self->status_) self->status_->refresh();
            });
        }
        if (gen != self->generation_) return;
        self->dataBusy_ = QJsonValue::Null;
        self->rebuild();
    });
}

void SettingsController::reveal(const QString& kind) {
    if (!revealPath || (kind != u"config" && kind != u"backups")) return;
    QPointer<SettingsController> self(this);
    revealPath(kind, [self](const QJsonObject&, const QString& error) {
        if (self && !error.isEmpty() && self->status_) self->status_->showError(error);
    });
}

}  // namespace ibkr::shell
