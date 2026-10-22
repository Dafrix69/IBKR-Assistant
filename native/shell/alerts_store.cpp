#include "shell/alerts_store.h"

#include "shell/alert_rules.h"
#include "shell/alerter.h"
#include "shell/bridge.h"
#include "shell/jsvalue.h"
#include "shell/status_store.h"
#include "shell/track_levels.h"

#include <QDateTime>
#include <QScopeGuard>
#include <QStringList>

#include <cmath>

using namespace Qt::StringLiterals;

namespace ibkr::shell {

namespace {
/// 引擎给的价是个数:模板字符串里怎么写,这里就怎么写
QString priceText(const QJsonValue& v) { return jsString(v); }
}  // namespace

AlertsStore::AlertsStore(Bridge* bridge, StatusStore* status, Alerter* alerter, QObject* parent)
    : QObject(parent),
      now([] { return double(QDateTime::currentMSecsSinceEpoch()); }),
      clock([] { return QDateTime::currentDateTime().toString(u"HH:mm:ss"_s); }),
      bridge_(bridge),
      status_(status),
      alerter_(alerter),
      touchConfig_(QJsonValue::Null) {
    timer_.setInterval(kPollMs);
    connect(&timer_, &QTimer::timeout, this, &AlertsStore::poll);
}

QJsonObject AlertsStore::snap() const {
    QJsonArray busy;
    for (const QString& id : busy_) busy.append(id);
    return {{u"watches"_s, watches_}, {u"feed"_s, feed_}, {u"busy"_s, busy}, {u"lastCheck"_s, lastCheck_},
            {u"touchConfig"_s, touchConfig_}, {u"crossConfirm"_s, crossConfirm_}};
}

int AlertsStore::armed() const {
    int n = 0;
    for (const QJsonValue& w : watches_) n += w[u"levels"].toArray().isEmpty() ? 0 : 1;
    return n;
}

void AlertsStore::start() {
    if (started_) return;
    started_ = true;
    load();
    timer_.start();
}

void AlertsStore::showError(const QString& text) {
    if (status_) status_->showError(text);
}
void AlertsStore::showInfo(const QString& text) {
    if (status_) status_->showInfo(text);
}

void AlertsStore::reload(std::function<void()> then) {
    bridge_->rpc(this, u"alerts.list"_s, QJsonObject{}, [this, then](const EngineReply& r) {
        const auto finish = qScopeGuard([&then] {
            if (then) then();
        });
        if (!r.ok) return showError(u"警告列表读取失败:"_s + r.error);
        const QJsonObject res = r.result.toObject();
        watches_ = res.value("watches"_L1).toArray();
        const QJsonValue tc = res.value("touch_config"_L1);
        touchConfig_ = jsTruthy(tc) ? tc : QJsonValue(QJsonValue::Null);
        crossConfirm_ = res.value("cross_confirm"_L1) == u"bar_close"_s ? u"bar_close"_s : u"immediate"_s;
        emit changed();
    });
}

QString AlertsStore::alertTitle(const QJsonObject& event) {
    const QString symbol = jsTruthy(event.value("symbol"_L1)) ? jsString(event.value("symbol"_L1)) : QString();
    if (event.value("trigger"_L1) == u"touch"_s) return u"%1 反复碰 %2"_s.arg(symbol, jsString(event.value("label"_L1)));
    return u"%1 %2 %3"_s.arg(symbol, event.value("direction"_L1) == u"up"_s ? u"上穿"_s : u"下破"_s, priceText(event.value("price"_L1)));
}

QJsonObject AlertsStore::toPopupItem(const QJsonObject& event) const {
    const QString symbol = jsTruthy(event.value("symbol"_L1)) ? jsString(event.value("symbol"_L1)) : QString();
    const double at = jsTruthy(event.value("at"_L1)) ? event.value("at"_L1).toDouble() : std::floor(now() / 1000);
    std::optional<QString> note;
    if (trackerSnapshot) {
        const auto [tracks, rows] = trackerSnapshot();
        note = levels::trackContext(symbol, tracks, rows);
    }
    const bool touch = event.value("trigger"_L1) == u"touch"_s;
    const QString text = jsTruthy(event.value("text"_L1)) ? jsString(event.value("text"_L1)) : QString();
    const QJsonValue dir = event.value("direction"_L1);
    // 碰均线是"又回到这条线上了",不是涨跌:不着涨跌色
    const QString tone = touch ? u"info"_s : dir == u"up"_s ? u"up"_s : dir == u"down"_s ? u"down"_s : u"info"_s;
    return {
        {u"id"_s, u"%1:%2:%3:%4"_s.arg(touch ? u"touch"_s : u"level"_s, symbol, priceText(event.value("price"_L1)), jsNumberToString(at))},
        {u"kind"_s, u"level"_s},
        {u"symbol"_s, symbol},
        {u"title"_s, alertTitle(event)},
        {u"body"_s, note ? text + u" · "_s + *note : text},
        {u"tone"_s, tone},
        {u"at"_s, at * 1000},
        {u"page"_s, note ? u"tracker"_s : u"sectors"_s},
    };
}

void AlertsStore::announce(const QJsonArray& events) {
    if (events.isEmpty() || !alerter_) return;
    QJsonArray items;
    for (const QJsonValue& e : events) items.append(toPopupItem(e.toObject()));
    const int dropped = alerter_->announceBatch(items, alerts::toneDirection(events));
    if (dropped <= 0) return;
    QList<QJsonObject> rest;
    for (qsizetype i = std::max<qsizetype>(0, events.size() - dropped); i < events.size(); ++i) rest.append(events[i].toObject());
    const bool one = rest.size() == 1;
    QString title, body;
    if (one) {
        title = alertTitle(rest[0]);
        body = jsTruthy(rest[0].value("text"_L1)) ? jsString(rest[0].value("text"_L1)) : QString();
    } else {
        QStringList symbols, titles;
        for (const QJsonObject& e : rest) {
            const QString s = jsTruthy(e.value("symbol"_L1)) ? jsString(e.value("symbol"_L1)) : QString();
            if (!symbols.contains(s)) symbols << s;
            titles << alertTitle(e);
        }
        title = u"%1 条价位提醒:%2"_s.arg(rest.size()).arg(symbols.join(u"、"_s));
        body = titles.join(u";"_s);
    }
    if (!alerter_->systemNotify(title, body)) qWarning("系统通知失败");
}

void AlertsStore::prependFeed(const QJsonArray& events) {
    QJsonArray next = events;
    for (const QJsonValue& e : feed_) next.append(e);
    while (next.size() > kFeedMax) next.removeLast();
    feed_ = next;
}

void AlertsStore::poll() {
    if (polling_ || !status_ || !status_->status().value("broker_connected"_L1).toBool()) return;
    bool any = false;
    for (const QJsonValue& w : watches_) any = any || (jsTruthy(w[u"enabled"]) && !w[u"levels"].toArray().isEmpty());
    if (!any) return;
    polling_ = true;
    bridge_->rpc(this, u"alerts.poll"_s, QJsonObject{}, [this](const EngineReply& r) {
        polling_ = false;
        if (!r.ok) return void(qWarning("警告轮询失败:%s", qPrintable(r.error)));
        const QJsonArray fired = r.result.toObject().value("fired"_L1).toArray();
        announce(fired);
        if (!fired.isEmpty()) {
            prependFeed(fired);
            load();
        }
        lastCheck_ = u"上次检查 "_s + clock();
        emit changed();
    });
}

void AlertsStore::onEngineEvent(const QString& event, const QJsonValue& data) {
    if (event != u"alerts") return;
    prependFeed(data[u"events"].toArray());
    emit changed();
}

void AlertsStore::setBusy(const QString& id, bool on) {
    if (on) {
        busy_.insert(id);
    } else {
        busy_.remove(id);
    }
    emit changed();
}

void AlertsStore::createWatch(const QString& symbol, double step, const QString& origin) {
    QJsonObject params{{u"symbol"_s, symbol}, {u"step"_s, step}};
    if (!origin.isEmpty()) params.insert(u"origin"_s, origin);
    bridge_->rpc(this, u"alerts.create"_s, params, [this, symbol](const EngineReply& r) {
        if (!r.ok) {
            showError(u"盯 %1 失败:%2"_s.arg(symbol, r.error));
            return emit created(false);
        }
        const QString id = r.result[u"watch"][u"id"].toString();
        reload([this, id] {
            if (id.isEmpty()) return emit created(true);
            refresh(id, {}, QJsonValue(QJsonValue::Undefined), [this] { emit created(true); });
        });
    });
}

void AlertsStore::refresh(const QString& id, const QString& expiry, const QJsonValue& step, std::function<void()> then) {
    setBusy(id, true);
    QJsonObject params{{u"id"_s, id}, {u"expiry"_s, expiry}};
    if (!step.isUndefined() && !step.isNull()) params.insert(u"step"_s, step);
    bridge_->rpc(this, u"alerts.refresh"_s, params, [this, id, then](const EngineReply& r) {
        // 没算成时引擎什么都没写(步长也没改):重读一遍,行上显示的回到引擎真正在用的那份。
        // 横幅的先后照原样:失败先报再重读,成了先重读再报降级
        if (!r.ok) showError(u"计算期权墙失败:"_s + r.error);
        reload([this, id, then, r] {
            if (r.ok) {
                // 期权墙/日线历史失败时降级继续——降级可以,但必须说出来
                const QJsonObject res = r.result.toObject();
                if (jsTruthy(res.value("wall_error"_L1))) showInfo(u"期权墙没算出来,已降级:"_s + jsString(res.value("wall_error"_L1)));
                if (jsTruthy(res.value("history_error"_L1))) showInfo(u"均线/52周位没算出来,已降级:"_s + jsString(res.value("history_error"_L1)));
            }
            setBusy(id, false);
            if (then) then();
        });
    });
}

void AlertsStore::saveTouchConfig(const QJsonObject& partial) {
    bridge_->rpc(this, u"alerts.set_touch_config"_s, QJsonObject{{u"config"_s, partial}}, [this](const EngineReply& r) {
        if (r.ok) {
            const QJsonValue c = r.result[u"config"];
            touchConfig_ = jsTruthy(c) ? c : QJsonValue(QJsonValue::Null);
            emit changed();
            return emit touchConfigSaved(true);
        }
        // 存不上就重读——界面上已经改掉的数要退回引擎真正在用的那份,不能让人以为改成了
        showError(u"碰均线提醒的设置没存上:"_s + r.error);
        load();
        emit touchConfigSaved(false);
    });
}

void AlertsStore::saveCrossConfirm(const QString& mode) {
    crossConfirm_ = mode;
    emit changed();
    bridge_->rpc(this, u"alerts.set_touch_config"_s, QJsonObject{{u"config"_s, QJsonObject{}}, {u"cross_confirm"_s, mode}}, [this](const EngineReply& r) {
        if (r.ok) return;
        showError(u"穿越确认方式没存上:"_s + r.error);
        load();
    });
}

void AlertsStore::deleteWatch(const QString& id, const QString& symbol) {
    const QJsonObject box{{u"title"_s, u"不再盯"_s}, {u"message"_s, u"不再盯 %1?"_s.arg(symbol)},
                          {u"detail"_s, u"该标的的价位与触发记录会一起删掉。"_s}, {u"confirmLabel"_s, u"删除"_s}};
    bridge_->confirm(this, box, [this, id](bool ok, const QString&) {
        if (!ok) return;
        bridge_->rpc(this, u"alerts.delete"_s, QJsonObject{{u"id"_s, id}}, [this](const EngineReply& r) {
            if (!r.ok) return showError(u"删除失败:"_s + r.error);
            load();
        });
    });
}

}  // namespace ibkr::shell
