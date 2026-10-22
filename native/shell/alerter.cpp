#include "shell/alerter.h"

#include "shell/alert_tone.h"
#include "shell/popup_rules.h"

#include <QDateTime>
#include <QJsonArray>
#include <QSettings>
#include <QTimer>

using namespace Qt::StringLiterals;

namespace ibkr::shell {

Alerter::Alerter(PopupQueue* popup, AlertOutputs* outputs, QString settingsPath, QObject* parent)
    : QObject(parent), now([] { return double(QDateTime::currentMSecsSinceEpoch()); }), popup_(popup), outputs_(outputs), settingsPath_(std::move(settingsPath)) {
    if (!settingsPath_.isEmpty()) {
        QSettings s(settingsPath_, QSettings::IniFormat);
        popupOn_ = s.value(u"alerts/popup"_s, true).toBool();
        soundOn_ = s.value(u"alerts/sound"_s, true).toBool();
        updown_ = s.value(u"alerts/updown"_s, u"green-up"_s).toString() == u"red-up" ? u"red-up"_s : u"green-up"_s;
    }
}

void Alerter::save() {
    if (settingsPath_.isEmpty()) return;
    QSettings s(settingsPath_, QSettings::IniFormat);
    s.setValue(u"alerts/popup"_s, popupOn_);
    s.setValue(u"alerts/sound"_s, soundOn_);
    s.setValue(u"alerts/updown"_s, updown_);
}

void Alerter::setPopupEnabled(bool on) {
    popupOn_ = on;
    save();
    emit prefsChanged();
    if (on) testPopup();
}

void Alerter::setSoundEnabled(bool on) {
    soundOn_ = on;
    save();
    emit prefsChanged();
    if (on) playTone(u"up"_s);
}

void Alerter::setUpdown(const QString& updown) {
    updown_ = updown == u"red-up" ? u"red-up"_s : u"green-up"_s;
    save();
    emit prefsChanged();
}

void Alerter::playTone(const QString& direction, bool force) {
    if (!soundOn_ && !force) return;
    if (outputs_) outputs_->playWav(tone::wav(direction));
}

void Alerter::previewTone() {
    playTone(u"down"_s, true);
    QTimer::singleShot(650, this, [this] { playTone(u"up"_s, true); });
}

void Alerter::announce(const QJsonObject& item, const QString& direction, bool toFeed) {
    playTone(direction);
    const QString title = item.value("title"_L1).toString();
    const QString body = item.value("body"_L1).toString();
    if (toFeed) emit notified(title, body);
    int dropped = 1;
    if (popupOn_ && popup_) dropped = popup_->push(QJsonObject{{u"items"_s, QJsonArray{item}}, {u"updown"_s, updown_}}).dropped;
    // 弹窗关着、或者没收下:退回系统通知,提醒不能悄无声息地没了
    if (dropped > 0) systemNotify(title, body);
}

int Alerter::announceBatch(const QJsonArray& items, const QString& direction) {
    if (items.isEmpty()) return 0;
    playTone(direction);
    if (!popupOn_ || !popup_) return int(items.size());
    return popup_->push(QJsonObject{{u"items"_s, items}, {u"updown"_s, updown_}}).dropped;
}

void Alerter::popupOrNotify(const QJsonObject& item, const QString& direction) {
    if (announceBatch(QJsonArray{item}, direction) <= 0) return;
    if (!systemNotify(item.value("title"_L1).toString(), item.value("body"_L1).toString())) qWarning("系统通知失败");
}

void Alerter::testPopup() {
    const double t = now();
    if (!popup_) return;
    popup_->push(QJsonObject{
        {u"items"_s, QJsonArray{QJsonObject{
                         {u"id"_s, u"test:%1"_s.arg(qint64(t))},
                         {u"kind"_s, u"anomaly"_s},
                         {u"symbol"_s, u"DEMO"_s},
                         {u"title"_s, u"DEMO 5分钟放量 6.3×"_s},
                         {u"body"_s, u"这是一条示例:近 5 分钟成交量是同时段常态的 6.3×,5 分钟 +1.20%。真提醒长这样,不会抢走键盘焦点。"_s},
                         {u"tone"_s, u"up"_s},
                         {u"at"_s, t},
                         {u"page"_s, u"quality"_s},
                     }}},
        {u"updown"_s, updown_},
    });
}

bool Alerter::systemNotify(const QString& title, const QString& body) {
    return outputs_ && outputs_->notify(title.left(120), body.left(300));
}

}  // namespace ibkr::shell
