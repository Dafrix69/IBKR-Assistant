#include "shell/feed_stores.h"

#include "shell/alert_rules.h"
#include "shell/alerter.h"
#include "shell/bridge.h"
#include "shell/event_rules.h"
#include "shell/intel_rules.h"
#include "shell/jsvalue.h"
#include "shell/playbook_format.h"
#include "shell/status_store.h"

#include <QDateTime>
#include <QJsonDocument>
#include <QRegularExpression>
#include <QSet>
#include <QSettings>

#include <algorithm>
#include <cmath>

using namespace Qt::StringLiterals;

namespace ibkr::shell {

namespace {
double wallClock() { return double(QDateTime::currentMSecsSinceEpoch()); }
/// a ?? null
QJsonValue orNull(const QJsonValue& v) { return v.isUndefined() || v.isNull() ? QJsonValue(QJsonValue::Null) : v; }
}  // namespace

// ================================================================ 日内剧本

PlaybookStore::PlaybookStore(Bridge* bridge, Alerter* alerter, QString settingsPath, QObject* parent)
    : QObject(parent), now(wallClock), bridge_(bridge), alerter_(alerter), settingsPath_(std::move(settingsPath)) {
    if (!settingsPath_.isEmpty()) alertOn_ = QSettings(settingsPath_, QSettings::IniFormat).value(u"playbook/alert"_s, true).toBool();
    timer_.setInterval(1'000);
    connect(&timer_, &QTimer::timeout, this, &PlaybookStore::tick);
}

void PlaybookStore::start() {
    if (started_) return;
    started_ = true;
    timer_.start();
}

void PlaybookStore::announce(const QString& symbol, const QJsonObject& event) {
    if (!alerter_) return;
    const QString tone = playbook::eventTone(event);
    const QJsonObject item{
        {u"id"_s, u"playbook:%1:%2:%3:%4"_s.arg(jsString(event.value("kind"_L1)), jsString(event.value("state"_L1)), jsString(event.value("level"_L1)), jsString(event.value("at"_L1)))},
        {u"kind"_s, u"level"_s},
        {u"symbol"_s, symbol},
        {u"title"_s, playbook::eventTitle(symbol, event)},
        {u"body"_s, playbook::eventBody(event)},
        {u"tone"_s, tone},
        {u"at"_s, event.value("at"_L1)},
        {u"page"_s, u"trade"_s},
    };
    alerter_->popupOrNotify(item, tone);
}

void PlaybookStore::load() {
    if (inFlight_) return;
    inFlight_ = true;
    bridge_->rpc(this, u"options.playbook"_s, QJsonObject{}, [this](const EngineReply& r) {
        inFlight_ = false;
        last_ = now();
        if (r.ok) {
            snap_ = r.result;
            failure_.clear();
        } else {
            failure_ = r.error;
        }
        emit changed();
    });
}

void PlaybookStore::tick() {
    if (visible_ && now() - last_ >= kRefreshMs) load();
}

void PlaybookStore::setVisible(bool on) {
    visible_ = on;
    if (on) load();
}

void PlaybookStore::setAlert(bool on) {
    alertOn_ = on;
    if (!settingsPath_.isEmpty()) QSettings(settingsPath_, QSettings::IniFormat).setValue(u"playbook/alert"_s, on);
    emit changed();
}

void PlaybookStore::setEnabled(bool on) {
    bridge_->rpc(this, u"options.playbook_set"_s, QJsonObject{{u"enabled"_s, on}}, [this](const EngineReply& r) {
        if (!r.ok) return emit enabledDone(r.error);
        snap_ = r.result;
        failure_.clear();
        emit changed();
        emit enabledDone(QString());
    });
}

void PlaybookStore::onEngineEvent(const QString& event, const QJsonValue& data) {
    if (event != u"playbook" || !jsTruthy(data)) return;
    const QJsonValue snapshot = data[u"snapshot"];
    if (jsTruthy(snapshot)) {
        snap_ = snapshot;
        failure_.clear();
        emit changed();
    }
    if (!alertOn_) return;
    const QJsonValue sym = snapshot[u"symbol"];
    const QString symbol = sym.isUndefined() || sym.isNull() ? u"SPX"_s : jsString(sym);
    for (const QJsonValue& e : data[u"events"].toArray()) announce(symbol, e.toObject());
}

// ================================================================ 优质股追踪与异动

namespace {

bool isEvent(const QJsonValue& e) { return e.isObject() && e[u"id"].isString() && e[u"title"].isString(); }

double atOf(const QJsonValue& e) {
    const double n = jsNumber(e[u"at"]);
    return std::isnan(n) ? 0 : n;
}

/// 合并进通知流:按 id 去重、新的在前、封顶 50
QJsonArray mergeFeed(const QJsonArray& current, const QJsonArray& incoming) {
    QSet<QString> seen;
    QList<QJsonValue> out;
    for (const QJsonArray* list : {&incoming, &current}) {
        for (const QJsonValue& e : *list) {
            if (!isEvent(e) || seen.contains(e[u"id"].toString())) continue;
            seen.insert(e[u"id"].toString());
            out.append(e);
        }
    }
    std::stable_sort(out.begin(), out.end(), [](const QJsonValue& a, const QJsonValue& b) { return atOf(b) < atOf(a); });
    QJsonArray result;
    for (qsizetype i = 0; i < out.size() && i < QualityStore::kFeedMax; ++i) result.append(out[i]);
    return result;
}

/// 行回执里可能不带指标(新加的那只还没跑过一轮),补齐成列表里的形状
QJsonObject normalizeStock(QJsonObject stock) {
    if (!stock.value("events"_L1).isArray()) stock.insert(u"events"_s, QJsonArray());
    stock.insert(u"metrics"_s, orNull(stock.value("metrics"_L1)));
    stock.insert(u"metrics_at"_s, orNull(stock.value("metrics_at"_L1)));
    return stock;
}

}  // namespace

QualityStore::QualityStore(Bridge* bridge, StatusStore* status, Alerter* alerter, QObject* parent)
    : QObject(parent), now(wallClock), bridge_(bridge), status_(status), alerter_(alerter) {}

QJsonObject QualityStore::snap() const {
    return {{u"stocks"_s, stocks_}, {u"config"_s, config_}, {u"monitor"_s, monitor_}, {u"feed"_s, feed_}, {u"unread"_s, unread_},
            {u"loaded"_s, loaded_}, {u"max"_s, max_}, {u"error"_s, error_}, {u"loadedAt"_s, loadedAt_}};
}

void QualityStore::start() {
    if (started_) return;
    started_ = true;
    load();
}

void QualityStore::showError(const QString& text) {
    if (status_) status_->showError(text);
}
void QualityStore::showInfo(const QString& text) {
    if (status_) status_->showInfo(text);
}

void QualityStore::load(std::function<void()> then) {
    if (then) waiting_.append(std::move(then));
    if (inFlight_) return;
    inFlight_ = true;
    const int gen = generation_;
    bridge_->rpc(this, u"quality.list"_s, QJsonObject{}, [this, gen](const EngineReply& r) {
        bool stale = false;
        if (r.ok) {
            const QJsonObject res = r.result.toObject();
            QJsonArray stocks;
            for (const QJsonValue& s : res.value("stocks"_L1).toArray()) stocks.append(normalizeStock(s.toObject()));
            stale = gen != generation_;
            monitor_ = jsTruthy(res.value("monitor"_L1)) ? res.value("monitor"_L1) : QJsonValue(QJsonValue::Null);
            const double max = jsNumber(res.value("max"_L1));
            max_ = max > 0 ? int(max) : kMax;
            loaded_ = true;
            error_.clear();
            loadedAt_ = now();
            if (!stale) {
                stocks_ = stocks;
                if (jsTruthy(res.value("config"_L1))) config_ = res.value("config"_L1);
            }
            if (!seeded_) {
                seeded_ = true;
                // 启动时把各股落库的事件汇成通知流的初值:重启之后"今天报过什么"还在
                QJsonArray events;
                for (const QJsonValue& s : stocks)
                    for (const QJsonValue& e : s[u"events"].toArray()) events.append(e);
                feed_ = mergeFeed(feed_, events);
            }
            lastLoadError_.clear();
        } else {
            // 页面每 5 秒拉一次:同一个错只说一遍,别一直往上顶横幅
            if (r.error != lastLoadError_) showError(u"读取优质股列表失败:"_s + r.error);
            lastLoadError_ = r.error;
            // 只记原因,不动 monitor——最后一次读到的那份还得拿来显示"上次什么时候跳的"
            error_ = r.error;
            loaded_ = true;
        }
        emit changed();
        inFlight_ = false;
        const auto waiting = std::exchange(waiting_, {});
        for (const auto& f : waiting) f();
        if (stale) load();
    });
}

void QualityStore::add(const QString& symbol, const QString& note) {
    const QString s = jsTrim(symbol).toUpper();
    if (s.isEmpty()) {
        showInfo(u"先填一个标的代码"_s);
        return emit added(false);
    }
    bridge_->rpc(this, u"quality.add"_s, QJsonObject{{u"symbol"_s, s}, {u"note"_s, jsTrim(note).left(60)}}, [this, s](const EngineReply& r) {
        if (!r.ok) {
            showError(u"加入追踪失败:"_s + r.error);
            return emit added(false);
        }
        generation_ += 1;
        const QJsonObject stock = r.result[u"stock"].toObject();
        const auto done = [this, s, stock] {
            const QString shown = jsTruthy(stock.value("symbol"_L1)) ? jsString(stock.value("symbol"_L1)) : s;
            showInfo(u"已加入优质股追踪:%1。盘中每 5 秒检测一轮,放量、急涨急跌会弹窗提醒。"_s.arg(shown));
            emit added(true);
        };
        if (!jsTruthy(stock.value("id"_L1))) return load(done);
        QJsonArray next;
        for (const QJsonValue& x : stocks_)
            if (x[u"id"] != stock.value("id"_L1)) next.append(x);
        next.append(normalizeStock(stock));
        stocks_ = next;
        emit changed();
        done();
    });
}

void QualityStore::remove(const QString& id, const QString& symbol) {
    const QJsonObject box{{u"title"_s, u"不再追踪"_s}, {u"message"_s, u"不再追踪 %1?"_s.arg(symbol)},
                          {u"detail"_s, u"它的异动记录会一起删掉;占着的那条行情线路会在下一轮释放。"_s}, {u"confirmLabel"_s, u"移除"_s}};
    bridge_->confirm(this, box, [this, id](bool ok, const QString&) {
        if (!ok) return;
        bridge_->rpc(this, u"quality.remove"_s, QJsonObject{{u"id"_s, id}}, [this, id](const EngineReply& r) {
            if (!r.ok) {
                showError(u"移除失败:"_s + r.error);
                return load();  // 以引擎为准
            }
            generation_ += 1;
            QJsonArray next;
            for (const QJsonValue& x : stocks_)
                if (x[u"id"] != QJsonValue(id)) next.append(x);
            stocks_ = next;
            emit changed();
        });
    });
}

void QualityStore::toggle(const QString& id, bool enabled, std::function<void()> done) {
    const QJsonArray before = stocks_;
    generation_ += 1;
    QJsonArray next;
    for (const QJsonValue& x : stocks_) {
        QJsonObject o = x.toObject();
        if (o.value("id"_L1) == QJsonValue(id)) o.insert(u"enabled"_s, enabled ? 1 : 0);
        next.append(o);
    }
    stocks_ = next;
    emit changed();
    bridge_->rpc(this, u"quality.update"_s, QJsonObject{{u"id"_s, id}, {u"enabled"_s, enabled}}, [this, before, enabled, done](const EngineReply& r) {
        // 成不成都要告诉等着的人(开关上的转圈)
        struct Finally {
            std::function<void()> f;
            ~Finally() { if (f) f(); }
        } finally{done};
        if (!r.ok) {
            stocks_ = before;
            emit changed();
            return showError(u"%1失败:%2"_s.arg(enabled ? u"启用"_s : u"停用"_s, r.error));
        }
        generation_ += 1;
        const QJsonObject stock = r.result[u"stock"].toObject();
        if (!jsTruthy(stock.value("id"_L1))) return;
        QJsonArray merged;
        for (const QJsonValue& x : stocks_) {
            if (x[u"id"] != stock.value("id"_L1)) {
                merged.append(x);
                continue;
            }
            QJsonObject o = x.toObject();
            const QJsonObject n = normalizeStock(stock);
            for (auto it = n.begin(); it != n.end(); ++it) o.insert(it.key(), it.value());
            const QJsonValue metrics = stock.value("metrics"_L1);
            const QJsonValue metricsAt = stock.value("metrics_at"_L1);
            o.insert(u"metrics"_s, metrics.isUndefined() || metrics.isNull() ? x[u"metrics"] : metrics);
            o.insert(u"metrics_at"_s, metricsAt.isUndefined() || metricsAt.isNull() ? x[u"metrics_at"] : metricsAt);
            merged.append(o);
        }
        stocks_ = merged;
        emit changed();
    });
}

void QualityStore::saveConfig(const QJsonObject& partial) {
    if (!config_.isObject()) return emit configSaved(false);
    QJsonObject next = config_.toObject();
    for (auto it = partial.begin(); it != partial.end(); ++it) next.insert(it.key(), it.value());
    generation_ += 1;
    bridge_->rpc(this, u"quality.set_config"_s, QJsonObject{{u"config"_s, next}}, [this, next](const EngineReply& r) {
        if (!r.ok) {
            // 存不上就重读——界面上已经改掉的数要退回引擎真正在用的那份,不能让人以为改成了
            showError(u"触发条件没存上:"_s + r.error);
            return load([this] { emit configSaved(false); });
        }
        generation_ += 1;
        const QJsonValue c = r.result[u"config"];
        config_ = jsTruthy(c) ? c : QJsonValue(next);
        emit changed();
        emit configSaved(true);
    });
}

void QualityStore::markSeen() {
    if (!unread_) return;
    unread_ = 0;
    emit changed();
}

void QualityStore::onAnomaly(const QJsonValue& data) {
    QSet<QString> known;
    for (const QJsonValue& e : feed_) known.insert(e[u"id"].toString());
    QJsonArray fresh;
    for (const QJsonValue& e : data[u"events"].toArray())
        if (isEvent(e) && !known.contains(e[u"id"].toString())) fresh.append(e);
    if (fresh.isEmpty()) return;
    // 人就在这一页、窗口也在前台,等于已经看见了;窗口在后台(正在 TWS 里)就还算没看。
    // 照 React 版问的是 'quality':它的当前页只会是侧栏项(sectors),所以这里实际总是"没看见"(页面自己会清零),见 qt-rewrite.md
    const bool looking = seeing && seeing(u"quality"_s);
    feed_ = mergeFeed(feed_, fresh);
    if (!looking) unread_ += int(fresh.size());
    emit changed();
    if (alerter_) {
        // 订单看板底下那条通知流也记一笔:回头翻"刚才报了什么"不用专门切到这一页
        for (const QJsonValue& e : fresh) alerter_->pushFeed(e[u"title"].toString(), e[u"text"].toString() + u'\n' + events::tradingDisciplineReminder());
        QJsonArray items;
        for (const QJsonValue& e : fresh) {
            const QString dir = e[u"direction"].toString();
            const double at = jsNumber(e[u"at"]);
            QJsonObject item{{u"id"_s, e[u"id"]}, {u"kind"_s, u"anomaly"_s}, {u"symbol"_s, e[u"symbol"]}, {u"title"_s, e[u"title"]},
                             {u"tone"_s, dir == u"up" ? u"up"_s : dir == u"down" ? u"down"_s : u"info"_s},
                             {u"at"_s, at > 0 ? at * 1000 : now()}, {u"page"_s, u"quality"_s}};
            item.insert(u"body"_s, e[u"text"].toString() + u'\n' + events::tradingDisciplineReminder());
            items.append(item);
        }
        // 放量(rvol / burst)一律中性的两声:它们的 direction 是引擎顺手带的涨跌方向,只给圆点和色块用
        const int dropped = alerter_->announceBatch(items, alerts::toneDirection(fresh));
        if (dropped > 0) {
            // 一批超过弹窗单次上限时它只收前几条,剩下的尾巴同样不能丢
            QJsonArray rest;
            for (qsizetype i = std::max<qsizetype>(0, fresh.size() - dropped); i < fresh.size(); ++i) rest.append(fresh[i]);
            QString title, body;
            if (rest.size() == 1) {
                title = rest[0][u"title"].toString();
                body = rest[0][u"text"].toString();
            } else {
                QStringList symbols, titles;
                for (const QJsonValue& e : rest) {
                    if (!symbols.contains(jsString(e[u"symbol"]))) symbols << jsString(e[u"symbol"]);
                    titles << e[u"title"].toString();
                }
                title = u"%1 条异动:%2"_s.arg(rest.size()).arg(symbols.join(u"、"_s));
                body = titles.join(u";"_s);
            }
            if (!alerter_->systemNotify(title, body + u'\n' + events::tradingDisciplineReminder())) qWarning("系统通知失败");
        }
    }
    load();  // 各股的"最近异动"与指标跟上
}

void QualityStore::onEngineEvent(const QString& event, const QJsonValue& data) {
    if (event == u"anomaly") onAnomaly(data);
    // 引擎重启之后以库里那份为准(阈值、启用状态都可能在别处改过)
    else if (event == u"ready") load();
}

// ================================================================ 信息链路

IntelStore::IntelStore(Bridge* bridge, Alerter* alerter, QString settingsPath, QObject* parent)
    : QObject(parent), now(wallClock), bridge_(bridge), alerter_(alerter), settingsPath_(std::move(settingsPath)) {
    if (!settingsPath_.isEmpty()) {
        const QJsonArray raw = QJsonDocument::fromJson(QSettings(settingsPath_, QSettings::IniFormat).value(u"intel/recent"_s, u"[]"_s).toString().toUtf8()).array();
        for (const QJsonValue& v : raw)
            if (v.isString() && recent_.size() < 8) recent_ << v.toString();
    }
    feedTimer_.setInterval(kFeedRefreshMs);
    connect(&feedTimer_, &QTimer::timeout, this, &IntelStore::loadFeed);
    dossierTimer_.setInterval(kDossierRefreshMs);
    connect(&dossierTimer_, &QTimer::timeout, this, [this] {
        if (dossier_.isObject() && !dossier_[u"loading"].toBool()) fetchDossier(dossier_[u"symbol"].toString());
    });
    refetch_.setSingleShot(true);
    connect(&refetch_, &QTimer::timeout, this, [this] {
        loadFeed();
        if (dossier_.isObject()) fetchDossier(dossier_[u"symbol"].toString());
    });
}

QJsonObject IntelStore::state() const {
    return {{u"feed"_s, feed_}, {u"feedError"_s, feedError_}, {u"loading"_s, loading_}, {u"kinds"_s, QJsonArray::fromStringList(kinds_)},
            {u"heldOnly"_s, heldOnly_}, {u"unread"_s, unread_}, {u"dossier"_s, dossier_}, {u"lookupOpen"_s, lookupOpen_},
            {u"recent"_s, QJsonArray::fromStringList(recent_)}};
}

void IntelStore::start() {
    if (started_) return;
    started_ = true;
    loadFeed();
    feedTimer_.start();
    dossierTimer_.start();
}

void IntelStore::loadFeed() {
    if (feedBusy_) return;
    feedBusy_ = true;
    loading_ = true;
    emit changed();
    QJsonObject spec{{u"limit"_s, 300}};
    if (!kinds_.isEmpty()) spec.insert(u"kinds"_s, QJsonArray::fromStringList(kinds_));
    if (heldOnly_) spec.insert(u"held_only"_s, true);
    bridge_->rpc(this, u"intel.feed"_s, spec, [this](const EngineReply& r) {
        if (r.ok) {
            feed_ = r.result;
            feedError_ = QJsonValue::Null;
            // 没连上券商时拉到的时间线没有持仓、也没有此刻的价:5 秒后再拉,最多两分钟(连上之后清零)
            if (jsTruthy(r.result[u"connected"])) {
                unconnectedRetries_ = 0;
            } else if (unconnectedRetries_ < kUnconnectedRetries) {
                unconnectedRetries_ += 1;
                QTimer::singleShot(retryMs, this, &IntelStore::loadFeed);
            }
        } else {
            feedError_ = r.error;
        }
        feedBusy_ = false;
        loading_ = false;
        emit changed();
    });
}

void IntelStore::setKinds(const QStringList& kinds) {
    kinds_ = kinds;
    emit changed();
    loadFeed();
}

void IntelStore::setHeldOnly(bool on) {
    heldOnly_ = on;
    emit changed();
    loadFeed();
}

void IntelStore::markSeen() {
    if (!unread_) return;
    unread_ = 0;
    emit changed();
}

void IntelStore::fetchDossier(const QString& symbol) {
    const int seq = ++dossierSeq_;
    if (!dossier_.isObject() || dossier_[u"symbol"].toString() != symbol) return;
    QJsonObject cur = dossier_.toObject();
    cur.insert(u"loading"_s, true);
    dossier_ = cur;
    emit changed();
    bridge_->rpc(this, u"intel.dossier"_s, QJsonObject{{u"symbol"_s, symbol}}, [this, seq, symbol](const EngineReply& r) {
        if (seq != dossierSeq_ || dossier_[u"symbol"].toString() != symbol) return;
        dossier_ = QJsonObject{{u"symbol"_s, symbol}, {u"data"_s, r.ok ? r.result : orNull(dossier_[u"data"])},
                               {u"error"_s, r.ok ? QJsonValue(QJsonValue::Null) : QJsonValue(r.error)}, {u"loading"_s, false}};
        emit changed();
    });
}

void IntelStore::openDossier(const QString& raw) {
    static const QRegularExpression dollar(u"^\\$"_s);
    const QString symbol = jsTrim(raw).remove(dollar).toUpper();
    if (symbol.isEmpty()) return;
    QStringList recent{symbol};
    for (const QString& s : recent_)
        if (s != symbol && recent.size() < 8) recent << s;
    recent_ = recent;
    if (!settingsPath_.isEmpty())
        QSettings(settingsPath_, QSettings::IniFormat).setValue(u"intel/recent"_s, QString::fromUtf8(QJsonDocument(QJsonArray::fromStringList(recent_)).toJson(QJsonDocument::Compact)));
    dossier_ = QJsonObject{{u"symbol"_s, symbol}, {u"data"_s, QJsonValue::Null}, {u"error"_s, QJsonValue::Null}, {u"loading"_s, true}};
    lookupOpen_ = false;
    emit changed();
    fetchDossier(symbol);
}

void IntelStore::refreshDossier() {
    if (dossier_.isObject()) fetchDossier(dossier_[u"symbol"].toString());
}

void IntelStore::closeDossier() {
    dossierSeq_ += 1;
    dossier_ = QJsonValue::Null;
    emit changed();
}

void IntelStore::setLookupOpen(bool open) {
    lookupOpen_ = open;
    emit changed();
}

void IntelStore::onHeldMention(const QJsonValue& data) {
    if (!intel::isHeldMention(data)) return;
    const QJsonObject item = intel::heldMentionPopup(data.toObject(), now());
    if (!(seeing && seeing(u"intel"_s))) {
        unread_ += 1;
        emit changed();
    }
    if (!alerter_) return;
    alerter_->pushFeed(item.value("title"_L1).toString(), item.value("body"_L1).toString());
    alerter_->popupOrNotify(item, QString());
}

void IntelStore::scheduleRefetch() {
    if (refetch_.isActive()) return;
    refetch_.start(refetchMs);
}

void IntelStore::onEngineEvent(const QString& event, const QJsonValue& data) {
    if (event == u"intel") {
        if (data[u"kind"] == u"held_mention"_s) onHeldMention(data);
        scheduleRefetch();
    } else if (event == u"alerts" || event == u"anomaly" || event == u"tracker" || event == u"ready" || event == u"broker_link") {
        scheduleRefetch();  // broker_link:断线重连之后持仓与此刻的价跟着换
    }
}

}  // namespace ibkr::shell
