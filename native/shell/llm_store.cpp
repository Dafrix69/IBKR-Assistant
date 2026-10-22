#include "shell/llm_store.h"

#include "shell/bridge.h"
#include "shell/status_store.h"

#include <QPointer>

namespace ibkr::shell {

using namespace Qt::StringLiterals;

LlmStore::LlmStore(Bridge* bridge, StatusStore* status, QObject* parent) : QObject(parent), bridge_(bridge), status_(status) {}

void LlmStore::load() {
    QPointer<StatusStore> st(status_);
    bridge_->rpc(this, u"llm.catalog"_s, QJsonObject{}, [this, st](const EngineReply& r) {
        if (!r.ok) {
            if (st) st->showError(u"读取模型配置失败:"_s + r.error);
            return;
        }
        catalog_ = r.result;
        emit changed();
    });
}

void LlmStore::onEngineEvent(const QString& event, const QJsonValue&) {
    if (event == u"llm") load();
}

}  // namespace ibkr::shell
