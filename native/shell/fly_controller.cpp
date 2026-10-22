#include "shell/fly_controller.h"

#include "shell/events_store.h"
#include "shell/feed_stores.h"
#include "shell/fly_rules.h"
#include "shell/fly_store.h"
#include "shell/jsvalue.h"
#include "shell/spot_store.h"
#include "shell/status_store.h"
#include "shell/trade_composer.h"

#include <QDateTime>

namespace ibkr::shell {

using namespace Qt::StringLiterals;

FlyController::FlyController(FlyStore* fly, SpotStore* spot, StatusStore* status, EventsStore* events, PlaybookStore* playbook, TradeComposer* composer, QObject* parent)
    : QObject(parent), fly_(fly), spot_(spot), status_(status), events_(events), playbookStore_(playbook), composer_(composer) {
    now = [] { return double(QDateTime::currentMSecsSinceEpoch()); };
    connect(fly_, &FlyStore::changed, this, &FlyController::rebuildPlanner);
    if (spot_) connect(spot_, &SpotStore::changed, this, &FlyController::rebuildPlanner);
    if (events_) connect(events_, &EventsStore::changed, this, &FlyController::rebuildPlanner);
    if (status_)
        connect(status_, &StatusStore::statusChanged, this, [this] {
            rebuildPlanner();
            rebuildPlaybook();
        });
    if (playbookStore_) connect(playbookStore_, &PlaybookStore::changed, this, &FlyController::rebuildPlaybook);
    connect(fly_, &FlyStore::recorderDone, this, [this](const QString& problem) {
        if (!problem.isEmpty() && status_) status_->showError(u"没改成:"_s + problem);
    });
    if (playbookStore_)
        connect(playbookStore_, &PlaybookStore::enabledDone, this, [this](const QString& problem) {
            if (!problem.isEmpty() && status_) status_->showError(u"没改成:"_s + problem);
        });
    rebuildPlanner();
    rebuildPlaybook();
}

void FlyController::rebuildPlanner() {
    fly::PlannerInput in;
    in.plan = fly_->plan();
    if (spot_)
        in.spot = {{u"quote"_s, spot_->quote()}, {u"failure"_s, spot_->failure().isEmpty() ? QJsonValue() : QJsonValue(spot_->failure())},
                   {u"alertOn"_s, spot_->alertOn()}, {u"lastHit"_s, spot_->lastHit()}};
    in.status = status_ && !status_->status().isEmpty() ? QJsonValue(status_->status()) : QJsonValue();
    if (events_) {
        in.events = events_->list();
        in.eventsNow = events_->nowMs();
    }
    in.localZone = localZone;
    planner_ = fly::plannerModel(in);
    // 时刻快捷钮按此刻的美东时间算(plannerModel 拿的是事件那一拍的时钟,这里换成真的此刻)
    planner_.insert(u"chips"_s, fly::timeChips(now()));
    emit plannerChanged();
}

void FlyController::rebuildPlaybook() {
    fly::PlaybookInput in;
    if (playbookStore_)
        in.playbook = {{u"snap"_s, playbookStore_->snap()}, {u"failure"_s, playbookStore_->failure().isEmpty() ? QJsonValue() : QJsonValue(playbookStore_->failure())},
                       {u"alertOn"_s, playbookStore_->alertOn()}};
    in.status = status_ && !status_->status().isEmpty() ? QJsonValue(status_->status()) : QJsonValue();
    playbook_ = fly::playbookModel(in);
    emit playbookChanged();
}

void FlyController::setPlannerVisible(bool on) {
    fly_->setVisible(on);
    if (spot_) spot_->setVisible(on);
    if (on) fly_->loadRecorder();
}

void FlyController::setPlaybookVisible(bool on) {
    if (playbookStore_) playbookStore_->setVisible(on);
}

void FlyController::patch(const QJsonObject& part) { fly_->patch(part); }

void FlyController::pickLevel(double level) { fly_->patch({{u"center"_s, jsNumberToString(level)}}); }

void FlyController::pickTime(const QString& hhmm) { fly_->patch({{u"targetTime"_s, hhmm}, {u"targetDate"_s, u""_s}}); }

void FlyController::pickChip(int index) {
    const QJsonArray chips = fly::timeChips(now());
    if (index >= 0 && index < chips.size()) pickTime(chips.at(index).toArray().at(1).toString());
}

void FlyController::writeInstruction() {
    const QJsonValue result = fly_->plan().value(u"result"_s);
    if (!result.isObject()) return;
    if (composer_) composer_->appendInstruction(fly::instructionFor(result.toObject(), fly::etClock(now()).date));
    if (status_) status_->showInfo(u"已写进左边的指令框。先点「解析并校验」核对,再决定发不发。"_s);
}

void FlyController::toggleRecorder(bool on) { fly_->setRecorder(on); }

void FlyController::setSpotAlert(bool on) {
    if (spot_) spot_->setAlert(on);
}

void FlyController::setPlaybookAlert(bool on) {
    if (playbookStore_) playbookStore_->setAlert(on);
}

void FlyController::setPlaybookEnabled(bool on) {
    if (playbookStore_) playbookStore_->setEnabled(on);
}

}  // namespace ibkr::shell
