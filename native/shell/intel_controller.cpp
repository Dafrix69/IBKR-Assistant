#include "shell/intel_controller.h"

#include "shell/feed_stores.h"
#include "shell/intel_page_rules.h"
#include "shell/status_store.h"

#include <QDateTime>

namespace ibkr::shell {

using namespace Qt::StringLiterals;

IntelController::IntelController(IntelStore* store, StatusStore* status, QObject* parent) : QObject(parent), store_(store), status_(status) {
    now = [] { return double(QDateTime::currentMSecsSinceEpoch()); };
    connect(store_, &IntelStore::changed, this, &IntelController::rebuild);
    if (status_) connect(status_, &StatusStore::statusChanged, this, &IntelController::rebuild);
    rebuild();
}

bool IntelController::lookupOpen() const { return store_->state()[u"lookupOpen"_s].toBool(); }

void IntelController::setVisible(bool on) {
    if (on == visible_) return;
    visible_ = on;
    query_.clear();
    if (on) {
        // 进页即刷;人在这一页就算看过了"持仓的票被提到"
        store_->loadFeed();
        store_->markSeen();
    }
    pageBuilt_ = false;  // 开、关这一下都要按新的关键字重摆一次
    rebuild();
}

void IntelController::windowFocused() {
    if (visible_) store_->markSeen();
}

void IntelController::setQuery(const QString& query) {
    if (query == query_) return;
    query_ = query;
    rebuild();
}

void IntelController::setKind(const QString& kind) { store_->setKinds(kind == u"all" || kind.isEmpty() ? QStringList{} : QStringList{kind}); }
void IntelController::setHeldOnly(bool on) { store_->setHeldOnly(on); }
void IntelController::reload() { store_->loadFeed(); }
void IntelController::openDossier(const QString& symbol) { store_->openDossier(symbol); }
void IntelController::closeDossier() { store_->closeDossier(); }
void IntelController::refreshDossier() { store_->refreshDossier(); }
void IntelController::setLookupOpen(bool open) { store_->setLookupOpen(open); }

QJsonObject IntelController::lookup(const QString& text) const { return intel::lookupModel(store_->state(), text); }

void IntelController::rebuild() {
    const QJsonObject state = store_->state();
    const bool connected = status_ ? status_->status()[u"broker_connected"_s].toBool() : true;
    // 页面模型(几百条时间线、每条认标的、算相对时间)只在页面开着、或券商连接真的变了时重摆;状态每几秒刷一次,全站常驻不该跟着重算
    if (visible_ || !pageBuilt_ || connected != lastConnected_) {
        page_ = intel::pageModel(state, query_, connected, now(), zone);
        lastConnected_ = connected;
        pageBuilt_ = true;
        emit pageChanged();
    }
    ++revision_;
    dossier_ = state[u"dossier"_s].isObject() ? intel::dossierModel(state[u"dossier"_s].toObject(), zone) : QJsonObject{};
    emit dossierChanged();
}

}  // namespace ibkr::shell
