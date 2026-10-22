#include "shell/about_controller.h"

#include "shell/bridge.h"
#include "shell/settings_rules.h"
#include "shell/status_store.h"
#include "shell/update_store.h"

#include <QPointer>
#include <QTimer>

namespace ibkr::shell {

using namespace Qt::StringLiterals;

AboutController::AboutController(Bridge* bridge, StatusStore* status, UpdateStore* update, QObject* parent)
    : QObject(parent), bridge_(bridge), status_(status), update_(update) {
    if (update_) connect(update_, &UpdateStore::changed, this, [this] { if (visible_) rebuild(); });
    rebuild();
}

void AboutController::setVisible(bool on) {
    if (on == visible_) return;
    visible_ = on;
    ++generation_;
    info_ = QJsonValue::Null;
    error_.clear();
    supportBusy_ = false;
    if (on) load();
    rebuild();
}

void AboutController::rebuild() {
    settings::AboutInput in;
    in.info = info_;
    in.error = error_;
    QJsonObject u{{u"info"_s, QJsonValue::Null}, {u"checking"_s, false}, {u"error"_s, QJsonValue::Null}, {u"auto"_s, true}, {u"dismissed"_s, QString()}};
    if (update_)
        u = QJsonObject{{u"info"_s, update_->info().isObject() ? update_->info() : QJsonValue(QJsonValue::Null)},
                        {u"checking"_s, update_->checking()},
                        {u"error"_s, update_->error().isEmpty() ? QJsonValue(QJsonValue::Null) : QJsonValue(update_->error())},
                        {u"auto"_s, update_->autoCheck()},
                        {u"dismissed"_s, update_->dismissed()}};
    in.update = u;
    in.log = log_.join(u'\n');
    in.supportBusy = supportBusy_;
    in.mac = mac;
    in.zone = zone;
    model_ = settings::aboutModel(in);
    emit changed();
}

void AboutController::load() {
    const int gen = generation_;
    QPointer<AboutController> self(this);
    bridge_->rpc(this, u"system.selftest"_s, QJsonObject{}, [self, gen](const EngineReply& r) {
        if (!self || gen != self->generation_) return;
        if (r.ok) {
            self->info_ = QJsonObject{{u"app"_s, self->appInfo ? self->appInfo() : QJsonObject{}}, {u"self"_s, r.result}};
            self->error_.clear();
        } else {
            self->error_ = u"读取失败:"_s + r.error;
        }
        self->rebuild();
    });
}

void AboutController::appendLog(const QString& line) {
    log_.append(line);
    while (log_.size() > 200) log_.removeFirst();
    if (visible_) rebuild();
}

void AboutController::restartEngine() {
    if (!restart) return;
    restart();
    const int gen = generation_;
    QPointer<AboutController> self(this);
    QTimer::singleShot(restartRefreshMs, this, [self, gen] {
        if (!self) return;
        if (self->status_) self->status_->refresh();
        if (gen == self->generation_ && self->visible_) self->load();
    });
}

void AboutController::exportDiagnostics() {
    if (!exportDiag) return;
    supportBusy_ = true;
    rebuild();
    const int gen = generation_;
    QPointer<AboutController> self(this);
    exportDiag([self, gen](const QJsonObject& result, const QString& error) {
        if (!self) return;
        if (!error.isEmpty()) {
            if (self->status_) self->status_->showError(u"导出没有成功:"_s + error);
        } else if (result[u"ok"_s].toBool() && self->status_) {
            self->status_->showInfo(u"诊断信息已导出,发出去之前建议自己先看一遍。"_s);
        }
        if (gen != self->generation_) return;
        self->supportBusy_ = false;
        self->rebuild();
    });
}

void AboutController::copyDiagnostics() {
    if (!copyDiag) return;
    QPointer<AboutController> self(this);
    copyDiag([self](const QJsonObject&, const QString& error) {
        if (!self || !self->status_) return;
        if (error.isEmpty()) self->status_->showInfo(u"已拷贝:版本、系统、引擎与券商连接状态。"_s);
        else self->status_->showError(error);
    });
}

void AboutController::reveal(const QString& kind) {
    if (!revealPath || (kind != u"logs" && kind != u"config" && kind != u"notices")) return;
    QPointer<AboutController> self(this);
    revealPath(kind, [self](const QJsonObject&, const QString& error) {
        if (self && !error.isEmpty() && self->status_) self->status_->showError(error);
    });
}

void AboutController::showTerms() {
    if (terms) terms();
}

void AboutController::openLink(const QString& url) {
    if (openUrl) openUrl(url);
}

void AboutController::checkUpdate() {
    if (update_) update_->check(true);
}

void AboutController::dismissUpdate(const QString& version) {
    if (update_) update_->dismiss(version);
}

void AboutController::setAutoUpdate(bool on) {
    if (update_) update_->setAuto(on);
}

}  // namespace ibkr::shell
