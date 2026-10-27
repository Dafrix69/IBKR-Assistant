#include "shell/macro_store.h"

#include "shell/bridge.h"
#include "shell/jsvalue.h"
#include "shell/locale_format.h"
#include "shell/status_store.h"

#include <QDateTime>
#include <QJsonObject>

#include <cmath>

using namespace Qt::StringLiterals;

namespace ibkr::shell {

namespace {

QString fmtValue(const QJsonObject& row) {
    const QJsonValue last = row.value("last"_L1);
    if (!last.isDouble()) return u"—"_s;
    const double v = last.toDouble();
    const QString fmt = row.value("fmt"_L1).toString();
    if (fmt == u"pct") return jsToFixed(v, 2) + u'%';
    if (fmt == u"plain") return jsToFixed(v, 2);
    return formatEnUs(v, 2);
}

/// 这一格读的是哪条行情(MacroStrip.tsx 的 title)
QString tipOf(const QJsonObject& row) {
    const QString instrument = row.value("instrument"_L1).toString();
    if (row.value("source"_L1).toString() == u"tws") {
        if (instrument == u"PAXOS") return u"TWS 实时流式,读的是 IBKR/PAXOS 的比特币现货,就是币价本身"_s;
        if (row.value("key"_L1).toString() == u"^TNX") return u"TWS 实时流式,读的是 Cboe 的 TNX 指数本身;它按 10 倍报价,这里显示除以 10 之后的收益率"_s;
        return u"TWS 实时流式,读的是标的本身(%1)"_s.arg(instrument);
    }
    if (instrument == u"Cboe") return u"Yahoo 取不到,改读 Cboe 官方的延迟行情(15 分钟),读的同样是指数本身"_s;
    return u"公开数据源(Yahoo),分钟级:没连 TWS、或 TWS 这一格没有报价时走这条"_s;
}

}  // namespace

MacroStore::MacroStore(Bridge* bridge, StatusStore* status, QObject* parent)
    : QObject(parent), now([] { return double(QDateTime::currentMSecsSinceEpoch()); }), bridge_(bridge), status_(status) {
    connect(&timer_, &QTimer::timeout, this, &MacroStore::tick);
}

void MacroStore::start() {
    load();
    timer_.start(tickMs);
}

void MacroStore::tick() {
    const bool connected = status_ && status_->status().value("broker_connected"_L1).toBool();
    const double every = connected ? 2'000 : 60'000;
    if (now() - last_ >= every) load();
}

void MacroStore::load(bool force) {
    // 引擎那边是串行的:上一轮没回来就再发,只会排队并把别的读一起拖慢
    if (inFlight_) return;
    inFlight_ = true;
    bridge_->rpc(this, u"macro.board"_s, force ? QJsonObject{{u"force"_s, true}} : QJsonObject{}, [this](const EngineReply& r) {
        if (r.ok) apply(r.result.toObject().value("rows"_L1).toArray());
        else qWarning("宏观行情读取失败:%s", qPrintable(r.error));
        inFlight_ = false;
        last_ = now();
    });
}

void MacroStore::apply(const QJsonArray& raw) {
    QJsonArray view;
    bool any = false;
    for (const QJsonValue& v : raw) {
        const QJsonObject row = v.toObject();
        const QString key = row.value("key"_L1).toString();
        const QJsonValue last = row.value("last"_L1);
        const bool stale = row.value("stale"_L1).toBool();
        if (last.isDouble()) any = true;
        // 走势只收新读数:旧值、和上一个一样的不收
        if (last.isDouble() && std::isfinite(last.toDouble()) && !stale) {
            QList<double>& trail = trails_[key];
            if (trail.isEmpty() || trail.last() != last.toDouble()) {
                trail.append(last.toDouble());
                if (trail.size() > kTrailMax) trail.remove(0, trail.size() - kTrailMax);
            }
        }
        const QJsonValue chg = row.value("change_pct"_L1);
        const QString dir = !chg.isDouble() ? QString() : chg.toDouble() > 0 ? u"up"_s : chg.toDouble() < 0 ? u"down"_s : u"flat"_s;
        QJsonArray trail;
        if (trails_.value(key).size() >= 3)
            for (double x : trails_.value(key)) trail.append(x);
        view.append(QJsonObject{
            {u"key"_s, key},
            {u"label"_s, row.value("label"_L1).toString()},
            {u"inst"_s, row.value("instrument"_L1).toString()},
            {u"stale"_s, stale},
            {u"value"_s, fmtValue(row)},
            {u"live"_s, row.value("source"_L1).toString() == u"tws"},
            {u"dir"_s, dir},
            {u"chg"_s, chg.isDouble() ? jsNumberToString(std::fabs(chg.toDouble())) + u'%' : QString()},
            {u"tip"_s, tipOf(row)},
            {u"trail"_s, trail},
            {u"tint"_s, dir == u"down" ? u"down"_s : dir == u"up" ? u"up"_s : u"gray"_s},
        });
    }
    view_ = view;
    hidden_ = !any;
    emit changed();
}

}  // namespace ibkr::shell
