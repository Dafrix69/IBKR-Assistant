#include "shell/board_controller.h"

#include "shell/order_rules.h"
#include "shell/order_stores.h"
#include "shell/status_store.h"

#include <QDateTime>

namespace ibkr::shell {

using namespace Qt::StringLiterals;

BoardController::BoardController(StatusStore* status, RecordsStore* records, PendingStore* pending, QObject* parent)
    : QObject(parent), status_(status), records_(records), pending_(pending) {
    now = [] { return double(QDateTime::currentMSecsSinceEpoch()); };
    connect(records_, &ListStore::changed, this, &BoardController::rebuild);
    connect(pending_, &ListStore::changed, this, &BoardController::rebuild);
    connect(&timer_, &QTimer::timeout, this, [this] {
        pending_->load();
        records_->load();
    });
    rebuild();
}

void BoardController::setVisible(bool on) {
    visible_ = on;
    // 进页即刷,停留期间 15 秒一轮
    if (on) {
        rebuild();
        pending_->load();
        records_->load();
        timer_.start(refreshMs);
    } else {
        timer_.stop();
    }
}

void BoardController::refresh() {
    if (status_) status_->refresh();
    records_->load();
    pending_->load();
}

void BoardController::pushNotification(const QString& title, const QString& body) {
    const QString at = QDateTime::fromMSecsSinceEpoch(qint64(now()), localZone).toString(u"HH:mm:ss"_s);
    feed_.prepend(QJsonObject{{u"at"_s, at}, {u"text"_s, body.isEmpty() ? title : u"%1 · %2"_s.arg(title, body)}});
    while (feed_.size() > 60) feed_.removeLast();
    // 看板没开着就不重算:开页时(setVisible)会算一遍
    if (visible_) rebuild();
}

void BoardController::rebuild() {
    orders::BoardInput in;
    in.pending = pending_->items();
    in.pendingError = pending_->error().isEmpty() ? QJsonValue() : QJsonValue(pending_->error());
    in.records = records_->items();
    in.recordsError = records_->error().isEmpty() ? QJsonValue() : QJsonValue(records_->error());
    in.feed = feed_;
    in.nowMs = now();
    in.localZone = localZone;
    model_ = orders::boardModel(in);
    emit modelChanged();
}

}  // namespace ibkr::shell
