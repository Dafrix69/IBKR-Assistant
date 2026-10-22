#include "shell/trade_controller.h"

#include "shell/keyed_list_model.h"

#include "shell/bridge.h"
#include "shell/llm_store.h"
#include "shell/status_store.h"
#include "shell/trade_composer.h"
#include "shell/trade_rules.h"

#include <QJsonArray>
#include <QJsonDocument>
#include <QPointer>
#include <QSet>

namespace ibkr::shell {

using namespace Qt::StringLiterals;

TradeController::TradeController(Bridge* bridge, StatusStore* status, LlmStore* llm, TradeComposer* composer, QObject* parent)
    : QObject(parent), bridge_(bridge), status_(status), llm_(llm), composer_(composer), cards_(new KeyedListModel(u"key"_s, this)) {
    connect(composer_, &TradeComposer::changed, this, [this] {
        if (composer_->payload() != lastPayload_) {
            lastPayload_ = composer_->payload();
            fetchSimilar();
        }
        rebuild();
    });
    connect(composer_, &TradeComposer::pickedChanged, this, &TradeController::rebuild);
    if (llm_) connect(llm_, &LlmStore::changed, this, &TradeController::rebuild);
    if (status_)
        connect(status_, &StatusStore::statusChanged, this, [this] {
            // 账户还是示例里的占位账号:状态里的账户变了就重问(React 版 useEffect([status?.accounts]))
            const QString sig = QString::fromUtf8(QJsonDocument(status_->status().value("accounts"_L1).toArray()).toJson(QJsonDocument::Compact));
            if (sig != accountsSig_) {
                accountsSig_ = sig;
                refreshPlaceholders();
            }
            rebuild();
        });
    rebuild();
}

void TradeController::refreshPlaceholders() {
    placeholders_ = placeholders ? placeholders() : QStringList{};
    rebuild();
}

void TradeController::rebuild() {
    trade::PageInput in;
    in.status = status_ && !status_->status().isEmpty() ? QJsonValue(status_->status()) : QJsonValue();
    in.llm = llm_ ? llm_->catalog() : QJsonValue();
    in.placeholders = placeholders_;
    in.savedPicked = composer_->savedPicked();
    in.composer = composer_->snapshot();
    in.similar = similar_;
    model_ = trade::tradePageModel(in);
    // 结果卡片:键 = 第几张 + 哪一种 + 哪张票据(同一份结果里内容变了只换数据)
    const QJsonObject result = model_.value("result"_L1).toObject();
    QJsonArray cards;
    if (result.value("kind"_L1) == QJsonValue(u"cards"_s)) {
        const QJsonArray list = result.value("cards"_L1).toArray();
        for (qsizetype i = 0; i < list.size(); ++i) {
            QJsonObject c = list[i].toObject();
            c.insert(u"key"_s, u"%1:%2:%3"_s.arg(i).arg(c.value("kind"_L1).toString(), c.value("similarKey"_L1).toString()));
            cards.append(c);
        }
    }
    cards_->setItems(cards);
    const QJsonArray steps = model_.value("readiness"_L1).toObject().value("steps"_L1).toArray();
    const QJsonArray accounts = model_.value("picker"_L1).toObject().value("accounts"_L1).toArray();
    const QJsonArray chips = model_.value("chips"_L1).toArray();
    const QJsonArray primerItems = model_.value("primer"_L1).toObject().value("items"_L1).toArray();
    if (steps != steps_ || accounts != accounts_ || chips != chips_ || primerItems != primerItems_) {
        steps_ = steps;
        accounts_ = accounts;
        chips_ = chips;
        primerItems_ = primerItems;
        emit listsChanged();
    }
    emit modelChanged();
}

QObject* TradeController::cards() const { return cards_; }

void TradeController::fetchSimilar() {
    // 结果里每张票据一份;已经取过(同一张单还在新结果里)的留着,不在了的丢掉
    QJsonObject next;
    QList<QJsonObject> toFetch;
    if (composer_->payload().isObject()) {
        for (const QJsonValue& card : trade::resultCards(composer_->payload().toObject())) {
            const QString key = card[u"similarKey"].toString();
            if (key.isEmpty() || next.contains(key)) continue;
            if (similar_.contains(key)) {
                next.insert(key, similar_.value(key));
            } else {
                next.insert(key, QJsonObject{});
                toFetch << card[u"ticketRaw"].toObject();
            }
        }
    }
    similar_ = next;
    QPointer<TradeController> self(this);
    for (const QJsonObject& t : toFetch) {
        const QString key = trade::similarKey(t);
        bridge_->rpc(this, u"ideas.similar_trades"_s, trade::similarQuery(t), [self, key](const EngineReply& r) {
            if (!self || !self->similar_.contains(key)) return;  // 换了单:这一份作废(同 React 版的 alive)
            self->similar_.insert(key, r.ok ? QJsonObject{{u"res"_s, r.result}} : QJsonObject{{u"err"_s, r.error}});
            self->rebuild();
        });
    }
}

void TradeController::submit(bool execute) {
    composer_->submit(execute, model_.value("picked"_L1).toVariant().toStringList());
}

void TradeController::hotkey(bool execute) {
    const QJsonObject send = model_.value("send"_L1).toObject();
    // 快捷键和按钮同一个口径:按钮此刻是灰的(发不出去),快捷键也不该发起一次注定被拦的发送
    if (execute && !send.value("canExecute"_L1).toBool()) {
        if (status_) status_->showError(u"现在发不出去:"_s + send.value("blockers"_L1).toString());
        return;
    }
    submit(execute);
}

void TradeController::togglePick(const QString& alias, bool on) {
    QSet<QString> next;
    for (const QJsonValue& v : model_.value("picked"_L1).toArray()) next.insert(v.toString());
    if (on) next.insert(alias);
    else next.remove(alias);
    QStringList ordered;
    for (const QJsonValue& a : model_.value("usable"_L1).toArray())
        if (next.contains(a[u"alias"].toString())) ordered << a[u"alias"].toString();
    composer_->savePicked(ordered);
}

QJsonObject TradeController::insertSnippet(int start, int end, const QString& snippet) {
    const trade::Inserted r = trade::insertSnippet(composer_->text(), start, end, snippet);
    composer_->setText(r.text);
    return {{u"text"_s, r.text}, {u"caret"_s, r.caret}};
}

void TradeController::focus() { composer_->setPane(u"fly"_s); }

}  // namespace ibkr::shell
