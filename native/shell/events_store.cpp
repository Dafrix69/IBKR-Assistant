#include "shell/events_store.h"

#include "shell/bridge.h"
#include "shell/jsvalue.h"
#include "shell/status_store.h"

#include <QDateTime>
#include <QTimeZone>

#include <algorithm>

using namespace Qt::StringLiterals;

namespace ibkr::shell {

namespace {

QDateTime etTime(double t) { return QDateTime::fromMSecsSinceEpoch(qint64(t), QTimeZone("America/New_York")); }

QString orDash(const QString& s) { return s.isEmpty() ? u"—"_s : s; }

/// ${x > 0 ? '+' : ''}${x}
QString signedNum(double x) { return (x > 0 ? u"+"_s : QString()) + jsNumberToString(x); }

QList<double> leadMinutes(const QJsonObject& config) {
    QList<double> out;
    for (const QJsonValue& v : config.value("lead_minutes"_L1).toArray()) out.append(v.toDouble());
    return out;
}

}  // namespace

EventsStore::EventsStore(Bridge* bridge, StatusStore* status, QObject* parent)
    : QObject(parent), now([] { return double(QDateTime::currentMSecsSinceEpoch()); }), bridge_(bridge), status_(status) {
    connect(&timer_, &QTimer::timeout, this, &EventsStore::tick);
    rebuild();
}

void EventsStore::start() {
    now_ = now();
    load();
    timer_.start(tickMs);
}

void EventsStore::onEngineEvent(const QString& event) {
    if (event == u"ready") load();
}

QJsonArray EventsStore::allEvents() const {
    QJsonArray all = list_.value("events"_L1).toArray();
    if (list_.value("cross"_L1).isObject()) all.append(list_.value("cross"_L1));
    return all;
}

void EventsStore::load(bool force) {
    if (inFlight_) return;
    inFlight_ = true;
    bridge_->rpc(this, u"events.list"_s, QJsonObject{{u"force"_s, force}}, [this](const EngineReply& r) {
        if (r.ok) {
            const QString before = list_.value("cross"_L1).toObject().value("id"_L1).toString();
            list_ = r.result.toObject();
            failure_.clear();
            // 跨市场跟跌(P0):引擎在美股盘中判出来一条新的,当场报;之后由挂顶与提前提醒接手
            const QJsonObject cross = list_.value("cross"_L1).toObject();
            const QString id = cross.value("id"_L1).toString();
            if (!cross.isEmpty() && id != before && !fired_.contains(id + u":new"_s)) {
                fired_.insert(id + u":new"_s);
                const QJsonObject detail = cross.value("cross"_L1).toObject();
                const QString direction = detail.value("direction"_L1).toString(u"down"_s);
                const double t = now();
                emit announce(QJsonObject{
                                  {u"id"_s, u"event:"_s + id},
                                  {u"kind"_s, u"event"_s},
                                  {u"symbol"_s, detail.value("markets"_L1).toArray().at(0).toObject().value("symbol"_L1).toString()},
                                  {u"title"_s, u"P0 "_s + cross.value("title"_L1).toString()},
                                  {u"body"_s, events::leadBody(cross, 0, t, tz)},
                                  {u"tone"_s, direction},
                                  {u"at"_s, t},
                                  {u"page"_s, u"trade"_s},
                              },
                              direction);
            }
        } else {
            failure_ = r.error;
        }
        inFlight_ = false;
        loadedAt_ = now();
        rebuild();
    });
}

void EventsStore::checkLeads(double t) {
    const QJsonObject config = list_.value("config"_L1).toObject();
    if (list_.isEmpty() || !config.value("enabled"_L1).toBool()) return;
    for (const events::LeadDue& due : events::leadsDue(allEvents(), t, leadMinutes(config), fired_)) {
        fired_.insert(due.key);
        emit announce(QJsonObject{
                          {u"id"_s, u"event:"_s + due.key},
                          {u"kind"_s, u"event"_s},
                          {u"symbol"_s, u"SPX"_s},
                          {u"title"_s, events::leadTitle(due.event, due.lead)},
                          {u"body"_s, events::leadBody(due.event, due.lead, t, tz)},
                          {u"tone"_s, u"info"_s},
                          {u"at"_s, t},
                          {u"page"_s, u"trade"_s},
                      },
                      due.lead > 0 ? QString() : u"down"_s);
    }
}

bool EventsStore::inSession(double t) const {
    const int hour = etTime(t).time().hour();
    return hour >= 4 && hour < 20;
}

void EventsStore::sweepSectors(double t) {
    if (sweeping_) return;
    sweeping_ = true;
    const auto withSectors = [this, t] {
        const QJsonObject cfg = list_.value("config"_L1).toObject();
        const double minStocks = cfg.value("sector_min_stocks"_L1).toDouble();
        bool any = false;
        for (const QJsonValue& s : sectors_)
            if (double(s.toObject().value("stocks"_L1).toArray().size()) >= minStocks) any = true;
        if (cfg.isEmpty() || !any) {
            sweeping_ = false;
            return;
        }
        bridge_->rpc(this, u"quality.list"_s, QJsonObject{}, [this, t](const EngineReply& r) {
            if (r.ok) finishSweep(t, r.result.toObject().value("stocks"_L1).toArray());
            else qWarning("板块联动检查失败:%s", qPrintable(r.error));
            sweeping_ = false;
        });
    };
    if (t - sectorsAt_ >= kSectorsRefreshMs) {
        bridge_->rpc(this, u"sectors.list"_s, QJsonObject{}, [this, t, withSectors](const EngineReply& r) {
            if (!r.ok) {
                qWarning("板块联动检查失败:%s", qPrintable(r.error));
                sweeping_ = false;
                return;
            }
            const QJsonValue s = r.result.toObject().value("sectors"_L1);
            sectors_ = s.isArray() ? s.toArray() : QJsonArray();
            sectorsAt_ = t;
            withSectors();
        });
    } else {
        withSectors();
    }
}

void EventsStore::finishSweep(double t, const QJsonArray& quality) {
    const QJsonObject cfg = list_.value("config"_L1).toObject();
    QList<events::StockChange> stocks;
    for (const QJsonValue& v : quality) {
        const QJsonObject s = v.toObject();
        stocks.append({s.value("symbol"_L1).toString(), s.value("metrics"_L1).toObject().value("change_pct"_L1), s.value("metrics_at"_L1)});
    }
    QList<events::SectorInput> sectors;
    for (const QJsonValue& v : sectors_) {
        QStringList symbols;
        for (const QJsonValue& x : v.toObject().value("stocks"_L1).toArray()) symbols.append(x.toObject().value("symbol"_L1).toString());
        sectors.append({v.toObject().value("name"_L1).toString(), symbols});
    }
    const double movePct = cfg.value("sector_move_pct"_L1).toDouble();
    const double minStocks = cfg.value("sector_min_stocks"_L1).toDouble();
    const auto changes = events::freshChanges(stocks, t);
    const QJsonArray found = events::sectorMoves(sectors, changes, {minStocks, cfg.value("sector_share"_L1).toDouble(), movePct});
    const bool premarket = events::isPremarket(t);
    const QString today = events::etDateOf(t);
    for (const QJsonValue& v : found) {
        const QJsonObject m = v.toObject();
        if (!premarket) continue;
        const QString sector = m.value("sector"_L1).toString();
        QStringList symbols;
        // 固定盘前中位实际使用的成分股;后续缺任意一只时不换样本作比较。
        for (const events::SectorInput& s : sectors)
            if (s.name == sector)
                for (const QString& symbol : s.symbols) {
                    const auto change = changes.constFind(symbol);
                    if (change != changes.cend() && change->has_value() && !symbols.contains(symbol)) symbols.append(symbol);
                }
        premarketRallies_.insert(today + u':' + sector, {today, sector, m.value("median"_L1).toDouble(), symbols});
    }
    checkFades(t, changes, minStocks);
    const auto same = [](const QJsonObject& a, const QJsonObject& b) {
        return a.value("sector"_L1) == b.value("sector"_L1) && a.value("direction"_L1) == b.value("direction"_L1);
    };
    QJsonArray next;
    for (const QJsonValue& v : found) {
        QJsonObject m = v.toObject();
        QJsonObject old;
        for (const QJsonValue& p : moves_)
            if (same(p.toObject(), m)) old = p.toObject();
        m.insert(u"since"_s, old.isEmpty() ? t : old.value("since"_L1).toDouble());
        m.insert(u"seenAt"_s, t);
        next.append(m);
        if (old.isEmpty()) {
            const QString direction = m.value("direction"_L1).toString();
            emit announce(QJsonObject{
                              {u"id"_s, u"sector:%1:%2:%3"_s.arg(m.value("sector"_L1).toString(), direction, jsNumberToString(t))},
                              {u"kind"_s, u"event"_s},
                              {u"symbol"_s, m.value("movers"_L1).toArray().at(0).toObject().value("symbol"_L1).toString()},
                              {u"title"_s, events::sectorMoveTitle(m, premarket)},
                              {u"body"_s, events::sectorMoveBody(m, movePct, premarket)},
                              {u"tone"_s, direction},
                              {u"at"_s, t},
                              {u"page"_s, u"sectors"_s},
                          },
                          direction);
        }
    }
    // 条件消失的还挂一会儿:人回来还看得见刚才发生了什么
    for (const QJsonValue& p : moves_) {
        bool still = false;
        for (const QJsonValue& n : next)
            if (same(n.toObject(), p.toObject())) still = true;
        if (!still && t - p.toObject().value("seenAt"_L1).toDouble() < kSectorLingerMs) next.append(p);
    }
    moves_ = next;
    rebuild();
}

void EventsStore::checkFades(double t, const QMap<QString, std::optional<double>>& changes, double minStocks) {
    const int minute = events::etMinuteOf(t);
    if (minute < events::kFadeCheckFrom) return;
    const QString today = events::etDateOf(t);
    for (auto it = premarketRallies_.begin(); it != premarketRallies_.end();) {
        const PremarketRally r = *it;
        if (r.date != today || minute >= events::kFadeCheckUntil) {
            it = premarketRallies_.erase(it);
            continue;
        }
        const std::optional<double> current = events::sectorMedian(r.symbols, changes, std::max(minStocks, double(r.symbols.size())));
        if (!current) {  // 这一轮行情不够,下一轮再看
            ++it;
            continue;
        }
        const QString key = it.key();
        it = premarketRallies_.erase(it);
        const QString verdict = events::fadeVerdict(r.median, *current);
        emit announce(QJsonObject{
                          {u"id"_s, u"fade:"_s + key},
                          {u"kind"_s, u"event"_s},
                          {u"symbol"_s, r.symbols.value(0)},
                          {u"title"_s, events::fadeTitle(r.sector, verdict)},
                          {u"body"_s, events::fadeBody(r.median, *current, verdict)},
                          {u"tone"_s, verdict == u"unknown" ? u"info"_s : verdict == u"faded" || verdict == u"still_down" ? u"down"_s : u"up"_s},
                          {u"at"_s, t},
                          {u"page"_s, u"sectors"_s},
                      },
                      QString());
    }
}

void EventsStore::checkSessionMarks(double t) {
    if (list_.isEmpty() || !list_.value("config"_L1).toObject().value("enabled"_L1).toBool()) return;
    const QString market = status_ ? status_->status().value("market_status"_L1).toString() : QString();
    for (const events::SessionMarkDue& due : events::sessionMarksDue(t, fired_, market == u"盘前" || market == u"盘中")) {
        fired_.insert(due.key);
        emit announce(QJsonObject{
                          {u"id"_s, u"event:"_s + due.key},
                          {u"kind"_s, u"event"_s},
                          {u"symbol"_s, u"SPX"_s},
                          {u"title"_s, due.mark.title},
                          {u"body"_s, events::sessionMarkBody(due.mark, t)},
                          {u"tone"_s, u"info"_s},
                          {u"at"_s, t},
                          {u"page"_s, u"trade"_s},
                      },
                      QString());
    }
}

void EventsStore::tick() {
    const double t = now();
    now_ = t;
    // 跨市场的窗口里(美股盘中到 A 股开盘后一小时)一分钟问一次:差距在盘中随时会出现;平时五分钟
    const double every = list_.value("cross_status"_L1).toObject().value("in_window"_L1).toBool() ? kSectorSweepMs : kListRefreshMs;
    if (t - loadedAt_ >= every) load();
    checkLeads(t);
    checkSessionMarks(t);
    const bool enabled = list_.value("config"_L1).toObject().value("enabled"_L1).toBool();
    const bool connected = status_ && status_->status().value("broker_connected"_L1).toBool();
    if (enabled && connected && inSession(t) && t - sweepAt_ >= kSectorSweepMs) {
        sweepAt_ = t;
        sweepSectors(t);
    }
    rebuild();
}

void EventsStore::rebuild() {
    const double t = now_ ? now_ : now();
    const QJsonObject config = list_.value("config"_L1).toObject();
    const bool enabled = list_.isEmpty() || !config.contains("enabled"_L1) ? true : config.value("enabled"_L1).toBool();
    const events::Pinned pinned = !list_.isEmpty() && enabled ? events::pinnedEvents(allEvents(), t) : events::Pinned{};

    QJsonArray moves;
    for (const QJsonValue& v : moves_) {
        const QJsonObject m = v.toObject();
        const QString direction = m.value("direction"_L1).toString();
        const double median = m.value("median"_L1).toDouble();
        QStringList movers;
        for (const QJsonValue& x : m.value("movers"_L1).toArray())
            movers.append(x.toObject().value("symbol"_L1).toString() + u' ' + signedNum(x.toObject().value("pct"_L1).toDouble()) + u'%');
        const QString count = jsNumberToString(m.value("count"_L1).toDouble());
        const QString total = jsNumberToString(m.value("total"_L1).toDouble());
        moves.append(QJsonObject{
            {u"key"_s, m.value("sector"_L1).toString() + u':' + direction},
            {u"direction"_s, direction},
            {u"title"_s, u"板块联动:%1 集体%2"_s.arg(m.value("sector"_L1).toString(), direction == u"down" ? u"下跌"_s : u"上涨"_s)},
            {u"meta"_s, u"%1/%2 只 · 中位 %3%"_s.arg(count, total, signedNum(median))},
            {u"tip"_s, u"%1 只里 %2 只同向超线,中位 %3%:%4"_s.arg(total, count, signedNum(median), movers.join(u"、"_s))},
        });
    }
    QJsonArray items;
    for (const QJsonValue& v : pinned.events) {
        const QJsonObject e = v.toObject();
        const QString phase = events::phaseOf(e, t);
        const bool cross = e.value("kind"_L1).toString() == u"cross";
        QStringList itemTitles;
        QString fact;
        for (const QJsonValue& i : e.value("items"_L1).toArray()) {
            const QJsonObject o = i.toObject();
            itemTitles.append(o.value("title"_L1).toString());
            const QString f = o.value("forecast"_L1).toString(), p = o.value("previous"_L1).toString();
            if (fact.isEmpty() && (!f.isEmpty() || !p.isEmpty())) fact = u"预期 %1 · 前值 %2"_s.arg(orDash(f), orDash(p));
        }
        const QString note = e.value("note"_L1).toString();
        const QString joined = itemTitles.join(u"、"_s);
        items.append(QJsonObject{
            {u"id"_s, e.value("id"_L1).toString()},
            {u"phase"_s, phase},
            {u"impact"_s, e.value("impact"_L1).toString()},
            {u"cross"_s, cross},
            {u"stars"_s, cross ? QString() : events::starText(e.value("stars"_L1))},
            {u"starsTip"_s, (e.value("stars"_L1).isDouble() ? jsNumberToString(e.value("stars"_L1).toDouble()) : QString()) + u" 星"_s},
            {u"title"_s, e.value("title"_L1).toString()},
            {u"titleTip"_s, !note.isEmpty() ? note : !joined.isEmpty() ? joined : e.value("title"_L1).toString()},
            {u"meta"_s, u"%1(美东 %2) · %3"_s.arg(events::whenText(e.value("at"_L1).toDouble(), t, tz), e.value("time_et"_L1).toString(),
                                                    events::countdownText(e, t))},
            {u"fact"_s, fact},
            {u"canAct"_s, phase == u"upcoming" || phase == u"soon" || cross},
        });
    }
    strip_ = QJsonObject{
        {u"hidden"_s, !enabled || (pinned.events.isEmpty() && moves_.isEmpty())},
        {u"moves"_s, moves},
        {u"items"_s, items},
        {u"more"_s, pinned.more},
    };
    emit changed();
}

QJsonObject EventsStore::all() const {
    const double t = now_ ? now_ : now();
    static const QHash<QString, QString> sourceLabel{{u"builtin"_s, u"官方日程"_s}, {u"feed"_s, u"公开日历"_s}, {u"custom"_s, u"自己记的"_s}};
    const QJsonObject feed = list_.value("feed"_L1).toObject();
    const QJsonObject config = list_.value("config"_L1).toObject();
    QString status;
    if (feed.value("error"_L1).isString() && !feed.value("error"_L1).toString().isEmpty())
        status = u"公开日历没拉到:%1;内置日程照样有。"_s.arg(feed.value("error"_L1).toString());
    else if (feed.value("at"_L1).isDouble() && feed.value("at"_L1).toDouble() != 0)
        status = u"公开日历更新于 %1(本周 %2 条)。"_s.arg(QDateTime::fromMSecsSinceEpoch(qint64(feed.value("at"_L1).toDouble())).toString(u"HH:mm:ss"_s),
                                                         jsNumberToString(feed.value("count"_L1).toDouble()));
    else if (config.value("feed"_L1).toBool())
        status = u"公开日历还没拉到。"_s;
    else
        status = u"公开日历已关,只有内置日程与自己记的。"_s;
    if (!failure_.isEmpty()) status += u" 清单没拉到:"_s + failure_;

    QJsonArray days;
    QString currentDay;
    QJsonArray current;
    const auto flush = [&] {
        if (!current.isEmpty()) days.append(QJsonObject{{u"day"_s, currentDay}, {u"events"_s, current}});
        current = QJsonArray();
    };
    // 按天分组:同一天的不一定挨着(Map 按第一次出现的顺序)
    QStringList order;
    QHash<QString, QJsonArray> byDay;
    for (const QJsonValue& v : list_.value("events"_L1).toArray()) {
        const QJsonObject e = v.toObject();
        const QString day = e.value("date_et"_L1).toString();
        if (!byDay.contains(day)) order.append(day);
        QJsonArray rowItems;
        for (const QJsonValue& i : e.value("items"_L1).toArray()) {
            const QJsonObject o = i.toObject();
            const QString f = o.value("forecast"_L1).toString(), p = o.value("previous"_L1).toString();
            rowItems.append(o.value("title"_L1).toString() + (f.isEmpty() && p.isEmpty() ? QString() : u":预期 %1,前值 %2"_s.arg(orDash(f), orDash(p))));
        }
        byDay[day].append(QJsonObject{
            {u"id"_s, e.value("id"_L1).toString()},
            {u"phase"_s, events::phaseOf(e, t)},
            {u"when"_s, events::whenText(e.value("at"_L1).toDouble(), t, tz)},
            {u"title"_s, e.value("title"_L1).toString()},
            {u"stars"_s, events::starText(e.value("stars"_L1))},
            {u"source"_s, sourceLabel.value(e.value("source"_L1).toString())},
            {u"count"_s, events::countdownText(e, t)},
            {u"items"_s, rowItems},
            {u"note"_s, e.value("note"_L1).toString()},
            {u"custom"_s, e.value("source"_L1).toString() == u"custom"},
        });
    }
    for (const QString& day : order) {
        currentDay = day;
        current = byDay.value(day);
        flush();
    }
    return QJsonObject{
        {u"status"_s, status},
        {u"enabled"_s, list_.isEmpty() || config.value("enabled"_L1).toBool(true)},
        {u"loaded"_s, !list_.isEmpty()},
        {u"days"_s, days},
    };
}

void EventsStore::addCustom(const QString& title, const QString& dateEt, const QString& timeEt, const QString& note) {
    const QJsonObject spec{{u"title"_s, title}, {u"date_et"_s, jsTrim(dateEt)}, {u"time_et"_s, jsTrim(timeEt)}, {u"note"_s, jsTrim(note)}};
    bridge_->rpc(this, u"events.add"_s, spec, [this](const EngineReply& r) {
        if (!r.ok) {
            emit customDone(r.error);
            return;
        }
        loadedAt_ = 0;
        load();
        emit customDone({});
    });
}

void EventsStore::removeCustom(const QString& id) {
    bridge_->rpc(this, u"events.remove"_s, QJsonObject{{u"id"_s, id}}, [this](const EngineReply& r) {
        if (!r.ok) {
            emit customDone(r.error);
            return;
        }
        loadedAt_ = 0;
        load();
        emit customDone({});
    });
}

void EventsStore::saveConfig(const QJsonObject& part, std::function<void(const QString&)> done) {
    bridge_->rpc(this, u"events.set_config"_s, QJsonObject{{u"config"_s, part}}, [this, done](const EngineReply& r) {
        if (!r.ok) {
            if (done) done(r.error);
            return;
        }
        if (!list_.isEmpty()) {
            list_[u"config"_s] = r.result.toObject().value("config"_L1);
            rebuild();
        }
        loadedAt_ = 0;
        load();
        if (done) done({});
    });
}

QJsonObject EventsStore::eventById(const QString& id) const {
    for (const QJsonValue& v : allEvents())
        if (v.toObject().value("id"_L1).toString() == id) return v.toObject();
    return {};
}

QString EventsStore::actionsWhen(const QString& id) const {
    const QJsonObject e = eventById(id);
    const double t = now();
    QStringList leads;
    for (double l : leadMinutes(list_.value("config"_L1).toObject())) leads.append(jsNumberToString(l));
    return u"%1(美东 %2),%3。"_s.arg(events::whenText(e.value("at"_L1).toDouble(), t, tz), e.value("time_et"_L1).toString(), events::countdownText(e, t)) +
           (leads.isEmpty() ? u"公布那一刻会弹窗提醒。"_s : u"公布前 %1 分钟会弹窗提醒,公布那一刻再提醒一次。"_s.arg(leads.join(u" / "_s)));
}

QJsonObject EventsStore::hedge(const QJsonObject& spec) const {
    const events::HedgeOut h = events::hedgeInstruction(spec);
    return QJsonObject{{u"text"_s, h.text}, {u"legs"_s, h.legs}, {u"problem"_s, h.problem}};
}

QString EventsStore::hedgeExpiry(const QString& id) const { return events::hedgeExpiryFor(eventById(id), etToday()); }

bool EventsStore::outsideRth() const {
    const QDateTime et = etTime(now());
    const int dow = et.date().dayOfWeek();
    const int minutes = et.time().hour() * 60 + et.time().minute();
    return dow == 6 || dow == 7 || minutes < 9 * 60 + 30 || minutes >= 16 * 60;
}

}  // namespace ibkr::shell
