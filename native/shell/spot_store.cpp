#include "shell/spot_store.h"

#include "shell/alerter.h"
#include "shell/bridge.h"
#include "shell/jsvalue.h"
#include "shell/status_store.h"

#include <QDateTime>
#include <QJsonArray>
#include <QSettings>

using namespace Qt::StringLiterals;

namespace ibkr::shell {

SpotStore::SpotStore(Bridge* bridge, StatusStore* status, Alerter* alerter, QString settingsPath, QObject* parent)
    : QObject(parent),
      now([] { return double(QDateTime::currentMSecsSinceEpoch()); }),
      bridge_(bridge),
      status_(status),
      alerter_(alerter),
      settingsPath_(std::move(settingsPath)) {
    if (!settingsPath_.isEmpty()) alertOn_ = QSettings(settingsPath_, QSettings::IniFormat).value(u"spot/alert"_s, true).toBool();
    timer_.setInterval(1'000);
    connect(&timer_, &QTimer::timeout, this, &SpotStore::tick);
}

QJsonValue SpotStore::lastHit() const {
    if (!lastHit_) return QJsonValue::Null;
    const spot::Hit& h = *lastHit_;
    return QJsonObject{{u"level"_s, h.level}, {u"direction"_s, h.direction}, {u"price"_s, h.price}, {u"source"_s, h.source}, {u"at"_s, h.at}, {u"skipped"_s, h.skipped}};
}

void SpotStore::start() {
    if (started_) return;
    started_ = true;
    timer_.start();
}

void SpotStore::announce(const spot::Hit& hit) {
    if (!alerter_) return;
    const QString title = spot::levelHitTitle(kSymbol, hit);
    const QString body = spot::levelHitBody(hit);
    const QJsonObject item{
        {u"id"_s, u"spot:%1:%2:%3"_s.arg(kSymbol, jsNumberToString(hit.level), jsNumberToString(hit.at))},
        {u"kind"_s, u"level"_s},
        {u"symbol"_s, kSymbol},
        {u"title"_s, title},
        {u"body"_s, body},
        {u"tone"_s, hit.direction},
        {u"at"_s, hit.at},
        {u"page"_s, u"trade"_s},
    };
    alerter_->popupOrNotify(item, hit.direction);
}

void SpotStore::load() {
    // 引擎的读道有并发上限:上一轮没回来就不再发
    if (inFlight_) return;
    inFlight_ = true;
    bridge_->rpc(this, u"options.spot"_s, QJsonObject{{u"symbol"_s, kSymbol}}, [this](const EngineReply& r) {
        inFlight_ = false;
        last_ = now();
        if (!r.ok) {
            quote_ = QJsonValue::Null;
            failure_ = r.error;
            hasFailure_ = true;
            return emit changed();
        }
        quote_ = r.result;
        failure_.clear();
        hasFailure_ = false;
        if (alertOn_) {
            const spot::Step next = spot::stepLevelWatch(watch_, spot::Sample::fromQuote(r.result.toObject()));
            watch_ = next.state;
            if (next.hit) {
                lastHit_ = next.hit;
                announce(*next.hit);
            }
        }
        emit changed();
    });
}

void SpotStore::tick() {
    if (!status_ || !status_->status().value("broker_connected"_L1).toBool()) {
        // 断开之后不留着一个不会再动的数
        if (!quote_.isNull() || hasFailure_) {
            quote_ = QJsonValue::Null;
            failure_.clear();
            hasFailure_ = false;
            emit changed();
        }
        return;
    }
    if (!alertOn_ && !visible_) return;
    if (now() - last_ >= kRefreshMs) load();
}

void SpotStore::setVisible(bool on) {
    visible_ = on;
    if (on) tick();
}

void SpotStore::setAlert(bool on) {
    // 关掉期间走过哪儿没人看着:重新打开后的第一笔只登记
    watch_ = {};
    alertOn_ = on;
    if (!settingsPath_.isEmpty()) QSettings(settingsPath_, QSettings::IniFormat).setValue(u"spot/alert"_s, on);
    emit changed();
    if (on) tick();
}

}  // namespace ibkr::shell
