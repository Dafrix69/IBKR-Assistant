#include "shell/sectors_controller.h"

#include "shell/alerter.h"
#include "shell/alerts_store.h"
#include "shell/feed_stores.h"
#include "shell/jsvalue.h"
#include "shell/sectors_rules.h"
#include "shell/sectors_store.h"
#include "shell/status_store.h"

#include <QDateTime>
#include <QPointer>
#include <QSet>

namespace ibkr::shell {

using namespace Qt::StringLiterals;

SectorsController::SectorsController(SectorsStore* sectors, AlertsStore* alerts, QualityStore* quality, StatusStore* status, Alerter* alerter, QObject* parent)
    : QObject(parent), sectors_(sectors), alerts_(alerts), quality_(quality), status_(status), alerter_(alerter) {
    now = [] { return double(QDateTime::currentMSecsSinceEpoch()); };
    windowActive = [] { return true; };
    connect(sectors_, &SectorsStore::earningsChanged, this, &SectorsController::earningsChanged);
    connect(sectors_, &SectorsStore::changed, this, &SectorsController::rebuild);
    // 引擎那份变了(保存回执 / 别处改过 / 每 5 秒重读),且本地没有待存的改动,页面上那份就跟上
    // 只在引擎那份真换了的时候(原版的 effect 依赖是 config 本身):5 秒一轮的重读或清未读不动它,保存回执回来之前不闪回旧值
    connect(quality_, &QualityStore::changed, this, [this] {
        const QJsonValue c = quality_->snap().value("config"_L1);
        if (!condTimer_.isActive() && c != lastCondConfig_) condDraft_ = QJsonValue::Null;
        lastCondConfig_ = c;
        rebuild();
    });
    // 存不上:store 会重读,但重读回来的可能和原来一模一样——草稿得在这里退掉,框里才回到引擎真正在用的那份
    connect(quality_, &QualityStore::configSaved, this, [this](bool ok) {
        if (ok || condTimer_.isActive()) return;
        condDraft_ = QJsonValue::Null;
        rebuild();
    });
    connect(alerts_, &AlertsStore::touchConfigSaved, this, [this](bool ok) {
        if (ok || touchTimer_.isActive()) return;
        touchDraft_ = QJsonValue::Null;
        rebuild();
    });
    connect(alerts_, &AlertsStore::changed, this, [this] {
        const QJsonValue c = alerts_->snap().value("touchConfig"_L1);
        if (!touchTimer_.isActive() && c != lastTouchConfig_) touchDraft_ = QJsonValue::Null;
        lastTouchConfig_ = c;
        rebuild();
    });
    // 连上 / 断开:原版进页那一段的依赖是 connected,一变就整页重刷、两个节拍从头数
    if (status_)
        connect(status_, &StatusStore::statusChanged, this, [this] {
            const bool on = connected();
            if (on == lastConnected_) return;
            lastConnected_ = on;
            // 只重刷,不算重新挂上:原版组件没卸载,选股着、拨着的开关、改着的标签照旧,在途的回包照样落地
            if (visible_) mount();
        });
    lastConnected_ = connected();
    if (alerter_) connect(alerter_, &Alerter::prefsChanged, this, &SectorsController::rebuild);
    connect(&quotesTimer_, &QTimer::timeout, this, [this] {
        if (connected()) sectors_->refreshQuotes();
    });
    connect(&poolTimer_, &QTimer::timeout, this, [this] {
        quality_->load();
        if (windowActive()) quality_->markSeen();
    });
    connect(&tick_, &QTimer::timeout, this, &SectorsController::rebuild);
    condTimer_.setSingleShot(true);
    touchTimer_.setSingleShot(true);
    focusTimer_.setSingleShot(true);
    connect(&condTimer_, &QTimer::timeout, this, &SectorsController::flushConditions);
    connect(&touchTimer_, &QTimer::timeout, this, &SectorsController::flushTouch);
    connect(&focusTimer_, &QTimer::timeout, this, [this] {
        focusSymbol_.clear();
        rebuild();
    });
    rebuild();
}

bool SectorsController::connected() const { return status_ && jsTruthy(status_->status().value("broker_connected"_L1)); }

void SectorsController::setVisible(bool on) {
    if (on == visible_) return;
    visible_ = on;
    ++generation_;
    lastConnected_ = connected();
    if (!on) {
        quotesTimer_.stop();
        poolTimer_.stop();
        tick_.stop();
        // 离开页面时还有没存的改动:立刻存,不丢
        if (condTimer_.isActive()) {
            condTimer_.stop();
            flushConditions();
        }
        if (touchTimer_.isActive()) {
            touchTimer_.stop();
            flushTouch();
        }
        // 页面自己的状态(选股着、拨着的开关、改着的标签、指认的那一只)随卸载一起没了
        picking_.clear();
        busy_ = {};
        editingTag_.clear();
        editingSector_.clear();
        focusSymbol_.clear();
        focusTimer_.stop();
        condDraft_ = touchDraft_ = QJsonValue::Null;
        rebuild();
        return;
    }
    mount();
}

void SectorsController::mount() {
    QPointer<SectorsStore> s(sectors_);
    sectors_->load([s] {
        if (s) s->refreshQuotes();
    });
    alerts_->load();
    quality_->load();
    quality_->markSeen();
    quotesTimer_.start(quotesMs);
    poolTimer_.start(poolMs);
    tick_.start(1000);
    rebuild();
}

void SectorsController::windowFocused() {
    if (visible_) quality_->markSeen();
}

void SectorsController::refreshQuotes() { sectors_->refreshQuotes(); }

void SectorsController::createSector(const QString& name) {
    const QString n = jsTrim(name);
    if (n.isEmpty()) return;
    QPointer<SectorsController> self(this);
    sectors_->addSector(n, [self](bool ok) {
        if (self && ok) emit self->sectorCreated();
    });
}

void SectorsController::deleteSector(const QString& id, const QString& name) { sectors_->deleteSector(id, name); }

void SectorsController::pick(const QString& sectorId) {
    picking_.insert(sectorId);
    rebuild();
    const int gen = generation_;
    QPointer<SectorsController> self(this);
    sectors_->pick(sectorId, [self, gen, sectorId] {
        if (!self || gen != self->generation_) return;
        self->picking_.remove(sectorId);
        self->rebuild();
    });
}

void SectorsController::addStock(const QString& sectorId, const QString& symbol, const QString& tag) {
    const QString s = jsTrim(symbol).toUpper();
    if (s.isEmpty()) return;
    QPointer<SectorsController> self(this);
    sectors_->addStock(sectorId, s, jsTrim(tag), [self, sectorId](bool ok) {
        if (self && ok) emit self->stockAdded(sectorId);
    });
}

void SectorsController::removeStock(const QString& sectorId, const QString& symbol) { sectors_->removeStock(sectorId, symbol); }

void SectorsController::toggle(const QString& symbol, const QString& which, bool on) {
    busy_[symbol] = which;
    rebuild();
    const int gen = generation_;
    QPointer<SectorsController> self(this);
    const auto done = [self, gen, symbol] {
        if (!self || gen != self->generation_) return;
        self->busy_.remove(symbol);
        self->rebuild();
    };
    // 旧库里被停用过的那一行:拨开就是把它重新启用,别再建一行
    if (which == u"anomaly" && on) {
        for (const QJsonValue& q : quality_->snap().value("stocks"_L1).toArray()) {
            if (q[u"symbol"_s].toString() != symbol || jsTruthy(q[u"enabled"_s])) continue;
            quality_->toggle(jsString(q[u"id"_s]), true, done);
            return;
        }
    }
    sectors_->setPoolWatch(symbol, QJsonObject{{which == u"price" ? u"price"_s : u"anomaly"_s, on}}, done);
}

void SectorsController::editTag(const QString& sectorId, const QString& symbol) {
    editingTag_ = symbol;
    editingSector_ = sectorId;
    tagDone_ = false;
    rebuild();
}

void SectorsController::finishTag(const QString& sectorId, const QString& symbol, const QString& draft, bool commit) {
    if (tagDone_ || editingTag_ != symbol || editingSector_ != sectorId) return;
    tagDone_ = true;
    QString tag;
    for (const QJsonValue& s : sectors_->sectors())
        if (s[u"id"_s].toString() == sectorId)
            for (const QJsonValue& st : s[u"stocks"_s].toArray())
                if (st[u"symbol"_s].toString() == symbol) tag = jsTrim(jsTruthy(st[u"tag"_s]) ? jsString(st[u"tag"_s]) : QString());
    const QString next = jsTrim(draft);
    if (commit && next != tag) {
        // 原版先等改标签的回执,再收起输入框
        const int gen = generation_;
        QPointer<SectorsController> self(this);
        sectors_->setTag(sectorId, symbol, next, [self, gen](bool) {
            if (!self || gen != self->generation_) return;
            self->editingTag_.clear();
            self->editingSector_.clear();
            self->rebuild();
        });
        return;
    }
    editingTag_.clear();
    editingSector_.clear();
    rebuild();
}

void SectorsController::refreshWatch(const QString& id, const QString& expiry, const QVariant& step) { alerts_->refreshWatch(id, expiry, step); }

void SectorsController::setPopupEnabled(bool on) {
    if (alerter_) alerter_->setPopupEnabled(on);
}
void SectorsController::setSoundEnabled(bool on) {
    if (alerter_) alerter_->setSoundEnabled(on);
}
void SectorsController::testPopup() {
    if (alerter_) alerter_->testPopup();
}
void SectorsController::previewTone() {
    if (alerter_) alerter_->previewTone();
}

void SectorsController::patchConditions(const QJsonObject& part) {
    QJsonObject draft = (condDraft_.isObject() ? condDraft_ : quality_->snap().value("config"_L1)).toObject();
    if (draft.isEmpty()) return;
    for (auto it = part.begin(); it != part.end(); ++it) {
        draft[it.key()] = it.value();
        condDirty_[it.key()] = it.value();
    }
    condDraft_ = draft;
    condTimer_.start(saveDelayMs);
    rebuild();
}

void SectorsController::flushConditions() {
    const QJsonObject part = condDirty_;
    condDirty_ = {};
    if (!part.isEmpty()) quality_->saveConfig(part);
}

void SectorsController::patchTouch(const QJsonObject& part, bool nowFlush) {
    QJsonObject draft = (touchDraft_.isObject() ? touchDraft_ : alerts_->snap().value("touchConfig"_L1)).toObject();
    if (draft.isEmpty()) return;
    for (auto it = part.begin(); it != part.end(); ++it) {
        draft[it.key()] = it.value();
        touchDirty_[it.key()] = it.value();
    }
    touchDraft_ = draft;
    if (nowFlush) {
        touchTimer_.stop();
        flushTouch();
    } else {
        touchTimer_.start(saveDelayMs);
    }
    rebuild();
}

void SectorsController::flushTouch() {
    const QJsonObject part = touchDirty_;
    touchDirty_ = {};
    if (!part.isEmpty()) alerts_->saveTouchConfig(part);
}

void SectorsController::setCrossConfirm(bool barClose) { alerts_->saveCrossConfirm(barClose ? u"bar_close"_s : u"immediate"_s); }

void SectorsController::focus(const QString& symbol) {
    focusSymbol_ = symbol;
    rebuild();
    emit reveal(symbol);
    focusTimer_.start(focusMs);
}

QJsonObject SectorsController::levelStrip(const QJsonArray& levelList, const QVariant& spot, double width) const {
    const std::optional<double> s = spot.isValid() && !spot.isNull() ? std::optional<double>(spot.toDouble()) : std::nullopt;
    return levels::buildLevelStrip(levelList, s, width, measure);
}

QJsonObject SectorsController::earnings() const { return sectors_->earnings(); }
void SectorsController::refreshEarnings(const QString& symbol) { sectors_->refreshEarnings(symbol); }

void SectorsController::rebuild() {
    sectors::PageInput in;
    in.sectors = sectors_->sectors();
    in.quotes = sectors_->quotes();
    in.quality = quality_->snap();
    if (condDraft_.isObject()) in.quality[u"config"_s] = condDraft_;
    in.alerts = alerts_->snap();
    if (touchDraft_.isObject()) in.alerts[u"touchConfig"_s] = touchDraft_;
    in.status = status_ ? status_->status() : QJsonObject{};
    in.popupOn = alerter_ ? alerter_->popupOn() : true;
    in.soundOn = alerter_ ? alerter_->soundOn() : true;
    in.picking = picking_;
    in.busy = busy_;
    in.editingTag = editingTag_;
    in.editingSector = editingSector_;
    in.focusSymbol = focusSymbol_;
    in.nowMs = now();
    in.zone = zone;
    page_ = sectors::pageModel(in);
    // 卡片与每张卡片的行按键原地更新
    const QJsonArray cards = page_.value("sectors"_L1).toArray();
    QSet<QString> alive;
    for (const QJsonValue& c : cards) {
        const QString id = c[u"id"_s].toString();
        alive.insert(id);
        KeyedListModel*& m = rows_[id];
        if (!m) m = new KeyedListModel(u"symbol"_s, this);
        m->setItems(c[u"rows"_s].toArray());
    }
    for (auto it = rows_.begin(); it != rows_.end();) {
        if (alive.contains(it.key())) {
            ++it;
            continue;
        }
        it.value()->deleteLater();
        it = rows_.erase(it);
    }
    cards_.setItems(cards);
    emit pageChanged();
}

}  // namespace ibkr::shell
