#include "shell/update_store.h"

#include "shell/jsvalue.h"

#include <QPointer>
#include <QSettings>

using namespace Qt::StringLiterals;

namespace ibkr::shell {

UpdateStore::UpdateStore(Check ask, QString settingsPath, QObject* parent)
    : QObject(parent), check_(std::move(ask)), settingsPath_(std::move(settingsPath)) {
    if (!settingsPath_.isEmpty()) {
        QSettings s(settingsPath_, QSettings::IniFormat);
        auto_ = s.value(u"update/auto"_s, true).toBool();
        dismissed_ = s.value(u"update/dismissed"_s).toString();
    }
    timer_.setSingleShot(true);
    connect(&timer_, &QTimer::timeout, this, [this] {
        if (!auto_) return;
        check(false, [this] { schedule(intervalMs); });
    });
}

QJsonValue UpdateStore::badge() const {
    const QJsonValue latest = info_[u"latest"];
    if (jsTruthy(info_[u"newer"]) && jsTruthy(latest) && latest.toString() != dismissed_) return info_;
    return QJsonValue::Null;
}

void UpdateStore::start(bool dev) {
    if (started_) return;
    started_ = true;
    if (dev) return;
    if (auto_) schedule(firstDelayMs);
}

void UpdateStore::check(bool force, std::function<void()> then) {
    // 正在问的那一次不叠加;then 照样调(React 版跳过时也是一个已了结的 Promise,定时那一路的 finally 照样排下一次)
    if (checking_) {
        if (then) then();
        return;
    }
    checking_ = true;
    emit changed();
    // 回包挂在别人(SupportService 的网络请求)身上,可能比这个 store 活得久:不在了就不回
    check_(force, [self = QPointer<UpdateStore>(this), then](const QJsonObject& info, const QString& error) {
        if (!self) return;
        UpdateStore* me = self;
        me->apply(info, error);
        if (then) then();
    });
}

void UpdateStore::apply(const QJsonObject& info, const QString& error) {
    if (error.isEmpty()) {
        info_ = info;
        error_.clear();
    } else {
        error_ = error;
    }
    checking_ = false;
    emit changed();
}

void UpdateStore::schedule(int delay) {
    timer_.start(delay);
}

void UpdateStore::setAuto(bool on) {
    auto_ = on;
    if (!settingsPath_.isEmpty()) QSettings(settingsPath_, QSettings::IniFormat).setValue(u"update/auto"_s, on);
    emit changed();
    if (on) schedule(firstDelayMs);
    else timer_.stop();
}

void UpdateStore::dismiss(const QString& version) {
    dismissed_ = version;
    if (!settingsPath_.isEmpty()) QSettings(settingsPath_, QSettings::IniFormat).setValue(u"update/dismissed"_s, version);
    emit changed();
}

}  // namespace ibkr::shell
