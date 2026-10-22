#include "shell/tracker_controller.h"

#include "shell/alerts_store.h"
#include "shell/bridge.h"
#include "shell/jsvalue.h"
#include "shell/status_store.h"
#include "shell/track_actions.h"
#include "shell/track_form.h"
#include "shell/tracker_page.h"
#include "shell/tracker_store.h"

#include <QJsonArray>

using namespace Qt::StringLiterals;

namespace ibkr::shell {

namespace {
bool connectedOf(StatusStore* s) { return s && s->status().value("broker_connected"_L1).toBool(); }
QString gatewayOf(StatusStore* s) { return s && s->status().value("broker_provider"_L1) == u"futu"_s ? u"OpenD"_s : u"TWS"_s; }
}  // namespace

TrackerController::TrackerController(Bridge* bridge, StatusStore* status, TrackerStore* tracker, AlertsStore* alerts, QObject* parent)
    : QObject(parent), measure(levels::measureFixed), bridge_(bridge), status_(status), tracker_(tracker), alerts_(alerts) {
    connect(tracker_, &TrackerStore::changed, this, [this] {
        rebuild();
        QStringList ids;
        for (const QJsonValue& t : tracker_->tracks()) ids << jsString(t[u"id"]);
        const QString sig = ids.join(u'\n');
        const bool tracksChanged = sig != tracksSig_;
        tracksSig_ = sig;
        // 盯盘每秒一轮也会 changed:只在追踪列表本身变了时重找(React 版 useEffect([focus, snap.tracks]))
        if (!focusSymbol_.isEmpty() && tracksChanged) applyFocus();
    });
    if (alerts_)
        connect(alerts_, &AlertsStore::changed, this, [this] {
            ++alertsRev_;
            emit alertsTick();
            rebuild();
        });
    if (status_)
        connect(status_, &StatusStore::statusChanged, this, [this] {
            ++statusRev_;
            emit statusTick();
            rebuild();
            // 连上 / 断开、换了券商:同 React 版 useEffect([connected, refreshMs]) 重跑——整读一遍,刷新节拍跟着变
            const bool connected = connectedOf(status_);
            const QString provider = status_->status().value("broker_provider"_L1).toString();
            if (visible_ && (connected != lastConnected_ || provider != lastProvider_)) tracker_->load(true);
            lastConnected_ = connected;
            lastProvider_ = provider;
            setVisible(visible_);
        });
    connect(&refresh_, &QTimer::timeout, tracker_, &TrackerStore::refreshPositions);
    focusTimer_.setSingleShot(true);
    connect(&focusTimer_, &QTimer::timeout, this, [this] { focusSymbol_.clear(); });
    flashTimer_.setSingleShot(true);
    connect(&flashTimer_, &QTimer::timeout, this, [this] {
        flashId_.clear();
        emit flashChanged();
    });
    rebuild();
}

void TrackerController::rebuild() {
    track::PageInput in;
    in.tracker = tracker_->snap();
    in.connected = connectedOf(status_);
    in.gateway = gatewayOf(status_);
    if (alerts_) {
        const QJsonObject a = alerts_->snap();
        in.watches = a.value("watches"_L1).toArray();
        for (const QJsonValue& b : a.value("busy"_L1).toArray()) in.busy << b.toString();
    }
    in.openKey = openKey_;
    model_ = track::trackerPageModel(in);
    const QJsonArray cards = model_.value("positions"_L1).toObject().value("cards"_L1).toArray();
    positions_.setItems(cards);
    tracks_.setItems(model_.value("tracks"_L1).toObject().value("cards"_L1).toArray());
    // 组合的腿:每张组合一份模型,组合没了模型也删
    QSet<QString> seen;
    for (const QJsonValue& c : cards) {
        if (!c[u"legs"].isArray()) continue;
        const QString key = c[u"key"].toString();
        seen.insert(key);
        KeyedListModel*& m = legs_[key];
        if (!m) m = new KeyedListModel(u"key"_s, this);
        m->setItems(c[u"legs"].toArray());
    }
    for (auto it = legs_.begin(); it != legs_.end();) {
        if (seen.contains(it.key())) {
            ++it;
        } else {
            it.value()->deleteLater();
            it = legs_.erase(it);
        }
    }
    emit modelChanged();
}

void TrackerController::setVisible(bool on) {
    const bool entering = on && !visible_;
    // 离开这一页:展开着的表单收起(React 版的 openKey 是页面的 useState,卸载就没了)
    if (!on && visible_ && !openKey_.isEmpty()) {
        openKey_.clear();
        rebuild();
    }
    if (!on) focusSymbol_.clear();
    visible_ = on;
    if (entering) {
        lastConnected_ = connectedOf(status_);
        lastProvider_ = status_ ? status_->status().value("broker_provider"_L1).toString() : QString();
    }
    // 进页即刷;停留期间持仓的现价与盈亏跟着行情走:IBKR 每秒读一次(读的是引擎里常驻订阅的缓存),
    // 富途每次是真的查询,5 秒一次。只读持仓,追踪列表不用跟着每秒重取
    if (entering) tracker_->load(true);
    if (on && connectedOf(status_)) {
        const int ms = status_->status().value("broker_provider"_L1) == u"futu"_s ? 5'000 : 1'000;
        if (!refresh_.isActive() || refresh_.interval() != ms) refresh_.start(ms);
    } else {
        refresh_.stop();
    }
}

void TrackerController::reload() { tracker_->load(true); }

void TrackerController::toggleForm(const QString& key) {
    openKey_ = openKey_ == key ? QString() : key;
    rebuild();
}

QJsonObject TrackerController::findTrack(const QString& id) const {
    for (const QJsonValue& t : tracker_->tracks())
        if (jsString(t[u"id"]) == id) return t.toObject();
    return {};
}

void TrackerController::setBusy(const QString& id, const QString& what) {
    if (what.isEmpty()) {
        busy_.remove(id);
    } else {
        busy_.insert(id, what);
    }
    emit busyChanged();
}

void TrackerController::flash(const QString& id, int ms) {
    flashId_ = id;
    emit flashChanged();
    flashTimer_.start(ms);
}

QJsonObject TrackerController::saving() const {
    QJsonObject out;
    for (auto it = saving_.cbegin(); it != saving_.cend(); ++it)
        if (it.value() > 0) out.insert(it.key(), true);
    return out;
}

void TrackerController::focusSymbol(const QString& symbol) {
    focusSymbol_ = symbol;
    focusHit_ = false;
    applyFocus();
}

QObject* TrackerController::legsModel(const QString& comboKey) { return legs_.value(comboKey, nullptr); }

void TrackerController::applyFocus() {
    // pages/Tracker.tsx 的 useNavFocus('tracker'):滚到「正在追踪」,同标的的第一张卡片闪 2.2 秒
    emit reveal();
    for (const QJsonValue& t : tracker_->tracks()) {
        if (jsString(t[u"symbol"]) != focusSymbol_) continue;
        focusHit_ = true;
        flash(jsString(t[u"id"]), 2'200);
        break;
    }
    focusTimer_.start(2'200);
}

namespace {
/// 卡片按钮的依赖:经 Bridge(带 context)发,会发单的带 __confirmed(凭据由确认框发,Bridge 核销)
track::ActionDeps actionDeps(TrackerController* self, Bridge* bridge, StatusStore* status, TrackerStore* tracker, std::function<void(const QString&)> busy) {
    track::ActionDeps d;
    // 这几个 lambda 活到引擎回话为止:一律经 QPointer 拿对象(README 的规矩),页面或 store 先没了就什么都不做
    const QPointer<TrackerController> guard(self);
    const QPointer<StatusStore> st(status);
    const QPointer<TrackerStore> tk(tracker);
    d.confirm = [guard, bridge](const QJsonObject& box, std::function<void(bool)> done) {
        if (!guard) return;
        bridge->confirm(guard, box, [done](bool ok, const QString& error) {
            if (!error.isEmpty()) qWarning("确认框没弹成:%s", qPrintable(error));
            done(ok && error.isEmpty());
        });
    };
    const auto call = [guard, bridge](const QString& method, const QJsonObject& params, const track::ActionDeps::Reply& done) {
        if (!guard) return;
        bridge->rpc(guard, method, params, [done](const EngineReply& r) { done(r.result, r.ok ? QString() : r.error); });
    };
    d.update = [call](const QJsonObject& spec, const track::ActionDeps::Reply& done) {
        QJsonObject p = spec;
        p.insert(u"__confirmed"_s, true);
        call(u"tracker.update"_s, p, done);
    };
    d.closeNow = [call](const QString& id, const track::ActionDeps::Reply& done) { call(u"tracker.close_now"_s, QJsonObject{{u"id"_s, id}, {u"__confirmed"_s, true}}, done); };
    d.remove = [call](const QString& id, const track::ActionDeps::Reply& done) { call(u"tracker.delete"_s, QJsonObject{{u"id"_s, id}}, done); };
    d.reload = [tk](bool refresh, std::function<void()> done) {
        if (tk) tk->load(refresh, std::move(done));
        else done();
    };
    d.records = [tk] {
        if (tk) emit tk->recordsStale();
    };
    d.banner = [st](const QString& text, bool info) {
        if (!st) return;
        if (info) st->showInfo(text);
        else st->showError(text);
    };
    d.busy = [guard, busy](const QString& b) {
        if (guard) busy(b);
    };
    return d;
}
}  // namespace

void TrackerController::toggle(const QString& trackId) {
    const QJsonObject t = findTrack(trackId);
    if (t.isEmpty()) return;
    track::toggleTrack(t, actionDeps(this, bridge_, status_, tracker_, [this, trackId](const QString& b) { setBusy(trackId, b); }));
}

void TrackerController::closeNow(const QString& trackId) {
    const QJsonObject t = findTrack(trackId);
    if (t.isEmpty()) return;
    track::closeTrackNow(t, actionDeps(this, bridge_, status_, tracker_, [this, trackId](const QString& b) { setBusy(trackId, b); }));
}

void TrackerController::remove(const QString& trackId) {
    const QJsonObject t = findTrack(trackId);
    if (t.isEmpty()) return;
    track::removeTrack(t, actionDeps(this, bridge_, status_, tracker_, [this, trackId](const QString& b) { setBusy(trackId, b); }));
}

void TrackerController::createWatch(const QString& symbol) {
    if (alerts_) alerts_->createWatch(symbol, 0, u"tracker"_s);
}

void TrackerController::refreshWatch(const QString& watchId) {
    if (alerts_) alerts_->refreshWatch(watchId);
}

void TrackerController::startTrack(const QJsonObject& position, const QJsonObject& values) {
    const track::FormState state = track::FormState::fromJson(position, status_ && status_->status().value("auto_execute"_L1).toBool(), values);
    const QString key = position.value("key"_L1).toString();
    const QPointer<TrackerController> self(this);
    track::FormDeps d;
    d.preview = [self](const QString& k, double target, std::optional<double> chaseMax, std::function<void(const QJsonValue&, const QString&)> done) {
        if (!self) return;
        QJsonObject p{{u"key"_s, k}, {u"spot_target"_s, target}};
        if (chaseMax) p.insert(u"chase_max_pct"_s, *chaseMax);
        self->bridge_->rpc(self, u"tracker.target_preview"_s, p, [done](const EngineReply& r) { done(r.result, r.ok ? QString() : r.error); });
    };
    d.confirm = [self](const QJsonObject& box, std::function<void(bool)> done) {
        if (!self) return;
        self->bridge_->confirm(self, box, [done](bool ok, const QString& error) {
            if (!error.isEmpty()) qWarning("确认框没弹成:%s", qPrintable(error));
            done(ok && error.isEmpty());
        });
    };
    d.add = [self](const QJsonObject& spec, std::function<void(const QJsonValue&, const QString&)> done) {
        if (!self) return;
        // 凭据绑的是确认框摆出来的那一份载荷:这里只加 __confirmed(Bridge 去掉它再核对),别的键一个不动
        QJsonObject p = spec;
        p.insert(u"__confirmed"_s, true);
        self->bridge_->rpc(self, u"tracker.add"_s, p, [done](const EngineReply& r) { done(r.result, r.ok ? QString() : r.error); });
    };
    d.banner = [self](const QString& text, bool info) {
        if (!self || !self->status_) return;
        if (info) self->status_->showInfo(text);
        else self->status_->showError(text);
    };
    d.saving = [self, key](bool on) {
        if (!self) return;
        // 按张计数:A 的试算还在路上时又点了 B,A 回来收起的是 A 的转圈,不碰 B 的
        int& n = self->saving_[key];
        n = std::max(0, n + (on ? 1 : -1));
        if (!n) self->saving_.remove(key);
        emit self->busyChanged();
    };
    d.reload = [self](std::function<void()> done) {
        if (self) self->tracker_->load(true, std::move(done));
    };
    d.created = [self](const QJsonValue& id) {
        if (!self) return;
        // 建完追踪后把视线带过去:收起表单、滚到「正在追踪」,把那张新卡片闪一下
        self->openKey_.clear();
        self->rebuild();
        if (id.isString()) self->flash(id.toString());
        emit self->created(id.isString() ? id.toString() : QString());
    };
    track::startTrack(state, d);
}

int TrackerController::preview(const QString& key, double target, const QVariant& chaseMax) {
    QJsonObject p{{u"key"_s, key}, {u"spot_target"_s, target}};
    if (chaseMax.isValid() && !chaseMax.isNull()) p.insert(u"chase_max_pct"_s, QJsonValue::fromVariant(chaseMax));
    const int seq = ++previewSeq_;
    bridge_->rpc(this, u"tracker.target_preview"_s, p, [this, seq, target](const EngineReply& r) { emit previewed(seq, target, r.result, r.ok ? QString() : r.error); });
    return seq;
}

bool TrackerController::autoExecute() const { return status_ && status_->status().value("auto_execute"_L1).toBool(); }

bool TrackerController::isPaper(const QString& account) const {
    if (!status_) return false;
    const QJsonObject st = status_->status();
    // 当前券商通道下可选的账户:两家都配了别名时,只列生效券商那一家的(store/status.ts 的 pickableAccounts)
    const QString provider = jsTruthy(st.value("broker_provider"_L1)) ? jsString(st.value("broker_provider"_L1)) : u"ibkr"_s;
    for (const QJsonValue& a : st.value("accounts"_L1).toArray()) {
        const QString broker = jsTruthy(a[u"broker"]) ? jsString(a[u"broker"]) : u"ibkr"_s;
        if (broker == provider && a[u"alias"].toString() == account) return jsTruthy(a[u"is_paper"]);
    }
    return false;
}

QJsonValue TrackerController::levelPicker(const QJsonObject& position) const {
    QJsonArray watches;
    QStringList busy;
    if (alerts_) {
        const QJsonObject a = alerts_->snap();
        watches = a.value("watches"_L1).toArray();
        for (const QJsonValue& b : a.value("busy"_L1).toArray()) busy << b.toString();
    }
    return track::levelPickerModel(position, watches, busy);
}

QJsonObject TrackerController::previewOutcome(const QJsonValue& result, const QString& error) const { return track::previewOutcome(result, error); }

QJsonArray TrackerController::previewLines(const QJsonObject& position, double target, const QJsonValue& priced, const QString& error) const {
    return track::previewLines(position, target, priced, error);
}

QJsonObject TrackerController::levelStrip(const QJsonArray& levelList, const QVariant& spot, double width) const {
    const std::optional<double> s = spot.isValid() && !spot.isNull() ? std::optional<double>(spot.toDouble()) : std::nullopt;
    return levels::buildLevelStrip(levelList, s, width, measure);
}

}  // namespace ibkr::shell
