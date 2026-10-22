#include "shell/order_stores.h"

#include "shell/bridge.h"

#include <QPointer>

namespace ibkr::shell {

using namespace Qt::StringLiterals;

ListStore::ListStore(Bridge* bridge, QString method, QJsonObject params, QString field, QObject* parent)
    : QObject(parent), bridge_(bridge), method_(std::move(method)), params_(std::move(params)), field_(std::move(field)) {}

void ListStore::load(std::function<void()> done) {
    if (inFlight_) {
        if (done) done();
        return;
    }
    inFlight_ = true;
    QPointer<ListStore> self(this);
    bridge_->rpc(this, method_, params_, [self, done](const EngineReply& r) {
        if (!self) return;
        self->inFlight_ = false;
        if (r.ok) {
            const QJsonValue list = r.result.toObject().value(self->field_);
            self->items_ = list.isArray() ? list.toArray() : QJsonArray{};
            self->error_.clear();
        } else {
            self->error_ = r.error;
        }
        emit self->changed();
        if (done) done();
    });
}

void ListStore::onEngineEvent(const QString& event) {
    if (event == u"pending") load();
}

RecordsStore::RecordsStore(Bridge* bridge, QObject* parent) : ListStore(bridge, u"records.list"_s, {{u"limit"_s, 60}}, u"records"_s, parent) {}

PendingStore::PendingStore(Bridge* bridge, QObject* parent) : ListStore(bridge, u"pending.list"_s, {}, u"pending"_s, parent) {}

}  // namespace ibkr::shell
