#include "orchestrate/services/playbook_service.h"

#include "domain/terrain_log.h"
#include "execution/held_streams.h"
#include "execution/ib_bars.h"
#include "execution/ib_contracts.h"
#include "orchestrate/services/svc1_util.h"
#include "util/error.h"
#include "util/jsformat.h"
#include "util/jsobj.h"
#include "util/tz.h"

#include <QFileInfo>

#include <cmath>
#include <limits>

namespace ibkr::orchestrate {

using namespace Qt::StringLiterals;
using util::OJson;
using util::Task;
namespace js = util::js;
namespace pb = analysis::playbook;
using svc1::excMessage;

namespace {

/// path.join(path.dirname(p), "playbook")
QString playbookDirOf(const QString& dbPath) {
    QString p = dbPath;
    while (p.size() > 1 && p.endsWith(u'/')) p.chop(1);
    const qsizetype slash = p.lastIndexOf(u'/');
    QString dir;
    if (slash < 0) {
        dir = u"."_s;
    } else if (slash == 0) {
        dir = u"/"_s;
    } else {
        dir = p.left(slash);
        while (dir.size() > 1 && dir.endsWith(u'/')) dir.chop(1);
    }
    if (dir == u".") return u"playbook"_s;
    return dir.endsWith(u'/') ? dir + u"playbook"_s : dir + u"/playbook"_s;
}

OJson optN(const std::optional<double>& v) { return v ? js::N(*v) : js::Null(); }

OJson anchorJson(const pb::Anchor& a) { return js::object({{u"at"_s, js::N(a.at)}, {u"price"_s, js::N(a.price)}, {u"source"_s, js::S(a.source)}}); }

OJson machineMarkJson(double at, const pb::Machine& m) {
    return js::object({{u"at"_s, js::N(at)}, {u"state"_s, js::S(m.state)}, {u"trigger"_s, optN(m.trigger)}, {u"since"_s, optN(m.since)}, {u"lost"_s, optN(m.lost)}});
}

OJson bandRecord(const QString& kind, const pb::Band& band) { return js::object({{u"kind"_s, js::S(kind)}, {u"band"_s, band.toJson()}}); }

/// 对象当 Record 用:fired[key] = at(有就改值、没有加在最后)
void setFired(pb::Machine& m, const QString& key, double at) {
    for (auto& [k, v] : m.fired) {
        if (k == key) {
            v = at;
            return;
        }
    }
    m.fired.push_back({key, at});
}

void setNote(OJson& notes, const QString& kind, const QString& text) { notes.set(kind, js::S(text)); }
void delNote(OJson& notes, const QString& kind) { notes.remove(kind); }

/// 日志里一份合约的样子不归这里管(假会话自己记);这里只要 conId 的真假:`!contract.conId`
bool noConId(const execution::IbContract& c) { return !c.conId || *c.conId == 0; }

std::optional<double> finitePositive(double x) { return std::isfinite(x) && x > 0 ? std::optional<double>(x) : std::nullopt; }

/// 美东某一天某一分钟整的时刻(epoch 毫秒)
double minuteEpoch(const QString& date, double minute) {
    const QStringList parts = date.split(u'-');
    const auto at = [&](int i) { return util::jsStringToNumber(parts.value(i)); };
    util::WallParts w;
    w.year = at(0);
    w.month = at(1);
    w.day = at(2);
    w.hour = std::floor(minute / 60);
    w.minute = std::fmod(minute, 60);
    w.second = 0;
    return util::wallToEpoch(w, QString::fromUtf16(util::kET));
}

pb::Event eventOf(const OJson& e) {
    pb::Event out;
    out.at = js::num(js::prop(&e, u"at"_s));
    out.kind = js::strOr(js::prop(&e, u"kind"_s), QString());
    out.state = js::strOr(js::prop(&e, u"state"_s), QString());
    out.level = js::num(js::prop(&e, u"level"_s));
    out.price = js::num(js::prop(&e, u"price"_s));
    return out;
}

std::vector<pb::WallStrike> strikesOf(const std::optional<OJson>& wall) {
    std::vector<pb::WallStrike> out;
    if (!wall) return out;
    const OJson* strikes = wall->get(u"strikes"_s);
    if (!js::isArr(strikes)) return out;
    for (const OJson& s : strikes->items) out.push_back({js::num(js::prop(&s, u"strike"_s)), js::num(js::prop(&s, u"net_gex"_s))});
    return out;
}

}  // namespace

// ---------------------------------------------------------------- 底账目录
QString PlaybookService::logDir() const { return playbookDirOf(settings().db_path); }

// ---- 开关 ----------------------------------------------------------------
bool PlaybookService::enabled() {
    try {
        const OJson raw = store().getPref(kPref);
        if (raw.type == OJson::Null) return true;
        // raw.enabled !== false
        if (raw.type == OJson::Object) {
            const OJson* e = raw.get(u"enabled"_s);
            return !(e && e->type == OJson::Bool && !e->b);
        }
        return true;
    } catch (...) {
        return true;  // 库打不开时别的地方会报;这里不因为它把循环弄挂
    }
}

OJson PlaybookService::setEnabled(bool on) {
    const OJson value = js::object({{u"enabled"_s, js::B(on)}});
    store().setPref(kPref, &value);
    if (!on) idleReason_ = u"已关闭"_s;
    return snapshot();
}

// ---- 循环 ----------------------------------------------------------------
void PlaybookService::schedule(int gen, int tickMs, int delay) {
    timer_ = rt().setTimeout(delay, [this, gen, tickMs] { loop(gen, tickMs); });
}

Task<> PlaybookService::loop(int gen, int tickMs) {
    try {
        co_await tickOnce();
    } catch (...) {
    }
    if (gen != gen_ || !running_) co_return;
    schedule(gen, tickMs, tickMs);
}

void PlaybookService::start(int tickMs) {
    if (running_) return;
    const int gen = ++gen_;
    running_ = true;
    schedule(gen, tickMs, tickMs);
}

void PlaybookService::stop() {
    gen_ += 1;
    running_ = false;
    if (timer_ != 0) rt().clearTimeout(timer_);
    timer_ = 0;
}

Task<OJson> PlaybookService::runAfter(Task<> prev, std::optional<double> nowMs) {
    co_await prev;
    co_return co_await tickInner(nowMs ? *nowMs : domain::nowEt().epochMs);
}

Task<OJson> PlaybookService::tickOnce(std::optional<double> nowMs) {
    const Task<> prev = chain_;
    util::Deferred<> mine;
    chain_ = mine.task();
    Task<OJson> run = runAfter(prev, nowMs);
    // 落定回调排在等待者(这一轮的调用方)之后:同 JS 里 run.catch(...) 比 await run 的后续多一跳
    run.onDone([mine]() mutable { mine.resolve(); });
    return run;
}

OJson PlaybookService::idle(const QString& reason) {
    idleReason_ = reason;
    return js::array();
}

double PlaybookService::closeMin(const QString& date) const { return settings().early_close_days.contains(date) ? 13 * 60 : 16 * 60; }

std::optional<QString> PlaybookService::nextTradingDay(const QString& date) const {
    double ordinal = util::dateOrdinal(date);
    for (int i = 0; i < 14; i += 1) {
        ordinal += 1;
        const QString d = util::ordinalToDate(ordinal);
        if (settings().isTradingDay(d)) return d;
    }
    return std::nullopt;
}

std::optional<QString> PlaybookService::prevTradingDay(const QString& date) const {
    double ordinal = util::dateOrdinal(date);
    for (int i = 0; i < 14; i += 1) {
        ordinal -= 1;
        const QString d = util::ordinalToDate(ordinal);
        if (settings().isTradingDay(d)) return d;
    }
    return std::nullopt;
}

/// 这一天的状态:内存里是它就用;不是(新的一天、引擎重启过)从底账里捡回来
std::shared_ptr<PlaybookService::Day> PlaybookService::dayFor(const QString& date) {
    if (day_ && day_->date == date) return day_;
    auto day = std::make_shared<Day>();
    day->date = date;
    day->notes = js::object();
    std::optional<pb::MachineMark> mark;
    for (const OJson& record : dayLog().read(date)) {
        const QString kind = js::str(record.get(u"kind"_s));
        if (kind == u"event") {
            day->events.push_back(*record.get(u"event"_s));
        } else if (kind == u"anchor") {
            const OJson* a = record.get(u"anchor"_s);
            day->anchor = pb::Anchor{js::num(js::prop(a, u"at"_s)), js::num(js::prop(a, u"price"_s)), js::strOr(js::prop(a, u"source"_s), QString())};
        } else if (kind == u"machine") {
            const OJson* m = record.get(u"machine"_s);
            const auto n = [&](const QString& k) -> std::optional<double> {
                const OJson* v = js::prop(m, k);
                return js::nullish(v) ? std::nullopt : std::optional<double>(js::num(v));
            };
            mark = pb::MachineMark{js::num(js::prop(m, u"at"_s)), js::strOr(js::prop(m, u"state"_s), QString()), n(u"trigger"_s), n(u"since"_s), n(u"lost"_s)};
        } else if (kind == u"prior") {
            day->prior = BandRec{pb::Band::fromJson(*record.get(u"band"_s)), *record.get(u"band"_s)};
        } else if (kind == u"open") {
            day->open = BandRec{pb::Band::fromJson(*record.get(u"band"_s)), *record.get(u"band"_s)};
        } else {
            day->current = BandRec{pb::Band::fromJson(*record.get(u"band"_s)), *record.get(u"band"_s)};
        }
    }
    // 没有单独记锚的底账(加这一种记录之前写的):盘初那一条区间的锚就是它
    if (!day->anchor && day->open) day->anchor = pb::Anchor{day->open->b.at, day->open->b.anchor, day->open->b.source};
    // 重启之后接着判:状态以落盘的那一条为准
    std::vector<pb::Event> events;
    for (const OJson& e : day->events) events.push_back(eventOf(e));
    const pb::Restored restored = pb::restoreMachine(mark, events);
    day->machine.state = restored.state;
    day->machine.trigger = restored.trigger;
    day->machine.since = restored.since;
    day->machine.lost = restored.lost;
    for (const pb::Event& e : events) setFired(day->machine, pb::quietKey(e.kind, e.state, e.level), e.at);
    if (qsizetype(day->events.size()) > kMaxEvents) day->events.erase(day->events.begin(), day->events.end() - kMaxEvents);
    day_ = day;
    price_.reset();
    priceAt_.reset();
    return day;
}

/// todayBand(day.anchor, day.current):结构体算数,输出用 {...current, anchor, lower, upper, source} 的原样
std::optional<PlaybookService::BandRec> PlaybookService::todayRec(const Day& day) const {
    const std::optional<pb::Band> current = day.current ? std::optional<pb::Band>(day.current->b) : std::nullopt;
    const std::optional<pb::Band> b = pb::todayBand(day.anchor, current);
    if (!b) return std::nullopt;
    OJson raw = day.current->raw;
    raw.set(u"anchor"_s, js::N(b->anchor));
    raw.set(u"lower"_s, js::N(b->lower));
    raw.set(u"upper"_s, js::N(b->upper));
    raw.set(u"source"_s, js::S(b->source));
    return BandRec{*b, raw};
}

Task<OJson> PlaybookService::tickInner(double nowMs) {
    try {
        if (!enabled()) co_return idle(u"已关闭"_s);
        const Broker router = routerPort();
        if (!router || !router->hasSessions()) co_return idle(u"没连券商"_s);
        if (settings().broker.provider != u"ibkr") co_return idle(u"期权行情只从 IBKR 取"_s);
        const QString symbol = kSymbol;
        if (settings().indexConfig(symbol) == nullptr) co_return idle(u"配置里没有 %1 这个指数"_s.arg(symbol));
        const domain::EtNow et = domain::etNowFromEpoch(nowMs);
        if (!settings().isTradingDay(et.date)) co_return idle(u"今天不是交易日"_s);
        const Broker broker = router;
        const double closeMinute = closeMin(et.date);

        const double afterClose = et.minutes - closeMinute;
        if (afterClose >= kPriorDelayMin && afterClose < kPriorDelayMin + kPriorWindowMin) {
            co_await capturePrior(broker, et);
            co_return idle(u"不在常规交易时段"_s);
        }
        if (settings().marketStatus(et) != domain::kStatusOpen) co_return idle(u"不在常规交易时段"_s);

        const std::shared_ptr<Day> day = dayFor(et.date);
        if (!day->prior) co_await backfillPrior(broker, day, nowMs);

        // 开盘起就读现价(09:35 之前只读不用)
        const std::optional<double> spot = co_await broker->indexPrice(symbol);
        const std::optional<OJson> info = broker->spotInfo(symbol);
        if (et.minutes < kOpenMin) co_return idle(u"等 09:35 的盘初定价"_s);
        const OJson* source = info ? info->get(u"source"_s) : nullptr;
        if (!spot || !(*spot > 0) || !(js::isStr(source) && source->s == u"index")) co_return idle(u"拿不到现价"_s);
        // 券商那一层分不出「今天的成交」和「垫底的昨收」。手上有昨收时,一分不差的那个价不当现价用
        if (day->prior && *spot == day->prior->b.anchor) co_return idle(u"现价和昨收一分不差:分不清是不是还没跳的昨收,等下一笔"_s);
        price_ = *spot;
        priceAt_ = nowMs;

        // et.seconds 是当日的秒数:离 09:35:00 过了多久
        const bool onTime = (et.seconds - kOpenMin * 60) * 1000 <= kLiveAnchorMs;
        // 那根分钟线走完了才去要:09:35:59 之前它还在走
        const bool barDone = et.minutes > kOpenMin;
        if (!day->anchor) {
            if (onTime) setAnchor(*day, pb::Anchor{nowMs, *spot, u"live"_s});
            else if (barDone) co_await backfillAnchor(broker, day, nowMs);
        }
        if (!day->open && !onTime && barDone) co_await backfillOpen(broker, day, nowMs);

        const double slot = std::floor(et.minutes / kFrameMin);
        bool frame = false;
        if ((!day->frameSlot || *day->frameSlot != slot) && due(*day, u"current"_s, nowMs, kRetryMs)) {
            const BandOrReason band = co_await liveBand(broker, QString(et.date).remove(u'-'), *spot, nowMs, u"盘中"_s);
            if (const QString* reason = std::get_if<QString>(&band)) {
                setNote(day->notes, u"current"_s, u"当前区间没取到:%1"_s.arg(*reason));
            } else {
                const pb::Band& b = std::get<pb::Band>(band);
                frame = true;
                day->frameSlot = slot;
                day->current = BandRec{b, b.toJson()};
                delNote(day->notes, u"current"_s);
                dayLog().append(day->date, bandRecord(u"frame"_s, b));
                // 盘初区间只认 09:35 那一刻当场读到的这一份(锚也是这一笔现价);迟了的由分钟线补
                if (!day->open && onTime && day->anchor && day->anchor->price == b.anchor) {
                    day->open = BandRec{b, b.toJson()};
                    delNote(day->notes, u"open"_s);
                    dayLog().append(day->date, bandRecord(u"open"_s, b));
                }
                co_await refreshWall(day, nowMs, *spot);
            }
        }

        const pb::Machine before = day->machine;
        const std::optional<BandRec> today = todayRec(*day);
        pb::MachineInput input;
        input.at = nowMs;
        input.price = *spot;
        if (day->prior) input.b3 = day->prior->b.lower;
        if (today) input.b2 = today->b.upper;
        input.frame = frame;
        if (day->accel) input.accelStrike = day->accel->strike;
        auto [next, events] = pb::stepMachine(before, input);
        day->machine = next;
        if (next.state != before.state || next.trigger != before.trigger || next.lost != before.lost) {
            dayLog().append(day->date, js::object({{u"kind"_s, js::S(u"machine"_s)}, {u"machine"_s, machineMarkJson(nowMs, next)}}));
        }
        OJson eventsJson = js::array();
        if (!events.empty()) {
            for (const pb::Event& event : events) {
                dayLog().append(day->date, js::object({{u"kind"_s, js::S(u"event"_s)}, {u"event"_s, event.toJson()}}));
                eventsJson.items.append(event.toJson());
                day->events.push_back(event.toJson());
            }
            if (qsizetype(day->events.size()) > kMaxEvents) day->events.erase(day->events.begin(), day->events.end() - kMaxEvents);
            emitEvent(u"playbook"_s, js::object({{u"events"_s, eventsJson}, {u"snapshot"_s, snapshot()}}));
        }
        idleReason_ = QString();
        lastError_ = QString();
        co_return eventsJson;
    } catch (...) {
        lastError_ = excMessage(std::current_exception()).left(200);
        co_return idle(u"上一轮出错了"_s);
    }
}

void PlaybookService::setAnchor(Day& day, const pb::Anchor& anchor) {
    day.anchor = anchor;
    delNote(day.notes, u"anchor"_s);
    dayLog().append(day.date, js::object({{u"kind"_s, js::S(u"anchor"_s)}, {u"anchor"_s, anchorJson(anchor)}}));
}

/// 这一样现在该不该试:上次试过之后要隔够久
bool PlaybookService::due(Day& day, const QString& kind, double nowMs, double gapMs) {
    const auto it = day.triedAt.find(kind);
    const double last = it == day.triedAt.end() ? -std::numeric_limits<double>::infinity() : it->second;
    if (nowMs - last < gapMs) return false;
    day.triedAt[kind] = nowMs;
    return true;
}

// ---- 当场读盘口 ------------------------------------------------------------
/// 平值跨式此刻的中间价 → 一条区间。取不到给一句原因
Task<PlaybookService::BandOrReason> PlaybookService::liveBand(Broker broker, QString expiry, double anchor, double nowMs, QString status) {
    const QString symbol = kSymbol;
    const contract::IndexConfig* cfg = settings().indexConfig(symbol);
    const QString tradingClass = cfg ? cfg->daily_trading_class : QString();
    const double strike = pb::atmStrike(anchor);
    const std::shared_ptr<execution::IbSession> session = broker->marketSession();
    const QStringList managed = session->managedAccounts();
    bool every = true;
    for (const QString& id : managed) every = every && id.startsWith(u'D');
    const bool delayedOk = managed.size() > 0 && every;
    std::vector<execution::OptionLegSpec> legs;
    for (const QString& right : {u"C"_s, u"P"_s}) legs.push_back({symbol, expiry, strike, right, u"SMART"_s, tradingClass});
    const std::vector<execution::OptionMark> got = co_await marks_.read(session, legs, delayedOk, execution::silenceLimitMs(status));
    QString refused;
    for (const execution::OptionMark& m : got) {
        if (m.error && !m.error->isEmpty() && !m.ask) {
            refused = *m.error;
            break;
        }
    }
    if (!refused.isEmpty()) co_return BandOrReason(u"行情订阅被拒:%1"_s.arg(refused));
    const std::optional<double> call = got.size() > 0 ? pb::legMid(got[0].bid, got[0].ask) : std::nullopt;
    const std::optional<double> put = got.size() > 1 ? pb::legMid(got[1].bid, got[1].ask) : std::nullopt;
    if (!call || !put) co_return BandOrReason(u"%1 的跨式没有完整的买卖价"_s.arg(util::jsNumberToString(strike)));
    const std::optional<pb::Band> band = pb::makeBand({nowMs, anchor, strike, expiry, *call, *put, u"live"_s});
    if (!band) co_return BandOrReason(u"%1 的跨式报价不是正数"_s.arg(util::jsNumberToString(strike)));
    co_return BandOrReason(*band);
}

/// 收盘后十分钟:取下一个交易日到期的平值跨式,记成那一天的昨日口径
Task<> PlaybookService::capturePrior(Broker broker, domain::EtNow et) {
    const std::optional<QString> next = nextTradingDay(et.date);
    if (!next) co_return;
    const domain::PlaybookLog log = dayLog();
    for (const OJson& r : log.read(*next))
        if (js::str(r.get(u"kind"_s)) == u"prior") co_return;
    const std::shared_ptr<Day> today = dayFor(et.date);
    if (!due(*today, u"prior"_s, et.epochMs, kRetryMs)) co_return;
    const std::optional<double> close = co_await closeOf(broker, et.date);
    if (!close) co_return;
    const BandOrReason band = co_await liveBand(broker, QString(*next).remove(u'-'), *close, et.epochMs, u"盘后"_s);
    if (std::holds_alternative<QString>(band)) co_return;
    log.append(*next, bandRecord(u"prior"_s, std::get<pb::Band>(band)));
    if (log.read(*next).size() == 1) log.prune();
}

/// 某个交易日的官方收盘价(日线那一根);那一根还没有就是空
Task<std::optional<double>> PlaybookService::closeOf(Broker broker, QString date) {
    const QList<OJson> bars = co_await broker->historicalBars(kSymbol, date, date);
    const OJson* found = nullptr;
    for (const OJson& b : bars) {
        const OJson* d = js::prop(&b, u"date"_s);
        if (js::isStr(d) && d->s == date) {
            found = &b;
            break;
        }
    }
    const double close = js::num(found ? js::prop(found, u"close"_s) : nullptr);
    co_return finitePositive(close);
}

// ---- 没赶上的补 ------------------------------------------------------------
Task<> PlaybookService::backfillPrior(Broker broker, std::shared_ptr<Day> day, double nowMs) {
    if (!due(*day, u"prior"_s, nowMs, kBackfillRetryMs)) co_return;
    const std::optional<QString> prev = prevTradingDay(day->date);
    if (!prev) co_return;
    const double minute = closeMin(*prev) + kPriorDelayMin;
    const QString stamp = u"%1 %2:%3"_s.arg(*prev, util::pad2(std::floor(minute / 60)), util::pad2(std::fmod(minute, 60)));
    std::exception_ptr failure;
    try {
        const std::optional<double> close = co_await closeOf(broker, *prev);
        if (!close) {
            setNote(day->notes, u"prior"_s, u"昨日区间补不了:拿不到 %1 的收盘价"_s.arg(*prev));
            co_return;
        }
        const std::optional<pb::Band> band = co_await historicBand(broker, QString(day->date).remove(u'-'), *close, *prev, minute);
        if (!band) {
            setNote(day->notes, u"prior"_s, u"昨日区间补不了:%1 那一分钟没有今天到期的平值跨式的历史价"_s.arg(stamp));
            co_return;
        }
        day->prior = BandRec{*band, band->toJson()};
        delNote(day->notes, u"prior"_s);
        dayLog().append(day->date, bandRecord(u"prior"_s, *band));
    } catch (...) {
        failure = std::current_exception();
    }
    if (failure) setNote(day->notes, u"prior"_s, u"昨日区间补不了:%1"_s.arg(excMessage(failure).left(120)));
}

/// 没赶上 09:35 那一刻:锚取指数 09:35 那根分钟线的开盘价(只要指数,不要期权)
Task<> PlaybookService::backfillAnchor(Broker broker, std::shared_ptr<Day> day, double nowMs) {
    if (!due(*day, u"anchor"_s, nowMs, kBackfillRetryMs)) co_return;
    const double minute = kOpenMin;
    std::exception_ptr failure;
    try {
        const contract::IndexConfig* cfg = settings().indexConfig(kSymbol);
        const execution::IbContract index = execution::indexContract(kSymbol, cfg ? cfg->exchange : u"CBOE"_s);
        const std::optional<double> price = co_await minuteOpen(broker->marketSession(), index, day->date, minute, u"TRADES"_s, true);
        if (!price) {
            setNote(day->notes, u"anchor"_s, u"今日区间的锚补不了:09:35 那一分钟没有指数的历史价"_s);
            co_return;
        }
        setAnchor(*day, pb::Anchor{minuteEpoch(day->date, minute), *price, u"backfill"_s});
    } catch (...) {
        failure = std::current_exception();
    }
    if (failure) setNote(day->notes, u"anchor"_s, u"今日区间的锚补不了:%1"_s.arg(excMessage(failure).left(120)));
}

/// 盘初那一条区间没当场取到:围着 09:35 的锚,拿平值跨式 09:35 那根分钟线的中间价补。锚还没有就先不补(缺的原因在锚那一条上)
Task<> PlaybookService::backfillOpen(Broker broker, std::shared_ptr<Day> day, double nowMs) {
    if (!day->anchor || !due(*day, u"open"_s, nowMs, kBackfillRetryMs)) co_return;
    std::exception_ptr failure;
    try {
        const std::optional<pb::Band> band = co_await historicBand(broker, QString(day->date).remove(u'-'), day->anchor->price, day->date, kOpenMin);
        if (!band) {
            setNote(day->notes, u"open"_s, u"盘初区间补不了:09:35 那一分钟没有平值跨式的历史价"_s);
            co_return;
        }
        day->open = BandRec{*band, band->toJson()};
        delNote(day->notes, u"open"_s);
        dayLog().append(day->date, bandRecord(u"open"_s, *band));
    } catch (...) {
        failure = std::current_exception();
    }
    if (failure) setNote(day->notes, u"open"_s, u"盘初区间补不了:%1"_s.arg(excMessage(failure).left(120)));
}

/// 某一天某一分钟的平值跨式(分钟线的中间价)→ 一条区间
Task<std::optional<pb::Band>> PlaybookService::historicBand(Broker broker, QString expiry, double anchor, QString date, double minute) {
    const QString symbol = kSymbol;
    const contract::IndexConfig* cfg = settings().indexConfig(symbol);
    const QString tradingClass = cfg ? cfg->daily_trading_class : QString();
    const double strike = pb::atmStrike(anchor);
    const std::shared_ptr<execution::IbSession> session = broker->marketSession();
    std::vector<double> mids;
    for (const QString& right : {u"C"_s, u"P"_s}) {
        const execution::IbContract contract = execution::optionContract(symbol, expiry, strike, right, u"SMART"_s, u"USD"_s, u"100"_s, tradingClass);
        const std::optional<double> mid = co_await minuteOpen(session, contract, date, minute, u"MIDPOINT"_s, false);
        if (!mid) co_return std::nullopt;
        mids.push_back(*mid);
    }
    co_return pb::makeBand({minuteEpoch(date, minute), anchor, strike, expiry, mids.size() > 0 ? mids[0] : 0, mids.size() > 1 ? mids[1] : 0, u"backfill"_s});
}

/// 一张合约在某一天某一分钟那根分钟线的开盘价;那一根没有就是空
Task<std::optional<double>> PlaybookService::minuteOpen(std::shared_ptr<execution::IbSession> session, execution::IbContract contract, QString date,
                                                        double minute, QString whatToShow, bool useRTH) {
    if (noConId(contract)) co_await session->qualifyContracts({&contract}, 12'000);
    if (noConId(contract)) co_return std::nullopt;
    const double end = minute + 10;
    execution::HistoricalRequest req;
    req.endDateTime = util::ibEndUtc(date, std::floor(end / 60), std::fmod(end, 60));
    req.durationStr = u"1800 S"_s;
    req.barSizeSetting = u"1 min"_s;
    req.whatToShow = whatToShow;
    req.useRTH = useRTH;
    const std::vector<execution::RawBar> bars = co_await session->historicalData(contract, req);
    const QString want = u"%1 %2:%3"_s.arg(date, util::pad2(std::floor(minute / 60)), util::pad2(std::fmod(minute, 60)));
    double open = std::numeric_limits<double>::quiet_NaN();
    for (const execution::RawBar& b : bars) {
        if (execution::barTimestamp(b.date) == want) {
            open = b.open;
            break;
        }
    }
    co_return finitePositive(open);
}

// ---- 期权墙 ----------------------------------------------------------------
/// 换了当前区间就顺手换一份期权墙(取不到留着上一份,原因写进 notes)。窗口要盖住剧本画出来的每一条线
Task<> PlaybookService::refreshWall(std::shared_ptr<Day> day, double nowMs, double spot) {
    std::exception_ptr failure;
    std::optional<OJson> terrain;
    const double terrainRequestedAt = domain::nowMs();
    try {
        const std::optional<BandRec> today = todayRec(*day);
        const std::optional<double> span = pb::wallSpan(spot, {day->prior ? std::optional<double>(day->prior->b.lower) : std::nullopt,
                                                                day->open ? std::optional<double>(day->open->b.lower) : std::nullopt,
                                                                day->open ? std::optional<double>(day->open->b.upper) : std::nullopt,
                                                                day->current ? std::optional<double>(day->current->b.lower) : std::nullopt,
                                                                day->current ? std::optional<double>(day->current->b.upper) : std::nullopt,
                                                                today ? std::optional<double>(today->b.upper) : std::nullopt});
        // 剧本看的是「今天到期」的那条链:日到期类。月度合约记的日期那一天两条链都列着它,不指定就会挑到月度那条
        const contract::IndexConfig* cfg = settings().indexConfig(kSymbol);
        const QString daily = cfg ? cfg->daily_trading_class : QString();
        const OJson wall = co_await market_.wallFor(kSymbol, QString(day->date).remove(u'-'), kWallWidth, span, daily);
        if (wall.type == OJson::Null) throw util::JsError(u"Cannot read properties of null (reading 'expiry')"_s);
        terrain = wall;
        const auto f = [&](const QString& k) { return js::copyOrNull(wall.get(k)); };
        day->wall = js::object({{u"at"_s, js::N(nowMs)},
                                {u"expiry"_s, f(u"expiry"_s)},
                                {u"call_wall"_s, f(u"call_wall"_s)},
                                {u"put_wall"_s, f(u"put_wall"_s)},
                                {u"gamma_flip"_s, f(u"gamma_flip"_s)},
                                {u"net_gex"_s, f(u"net_gex"_s)},
                                {u"net_gex_ratio"_s, f(u"net_gex_ratio"_s)},
                                {u"regime"_s, f(u"regime"_s)},
                                {u"strikes"_s, f(u"strikes"_s)},
                                {u"coverage"_s, f(u"coverage"_s)},
                                {u"oi_missing"_s, f(u"oi_missing"_s)},
                                {u"warnings"_s, f(u"warnings"_s)}});
        delNote(day->notes, u"wall"_s);
    } catch (...) {
        failure = std::current_exception();
    }
    try {
        domain::TerrainLog log(QFileInfo(settings().db_path).absolutePath() + u"/terrain"_s);
        log.record(terrainRequestedAt, domain::nowMs(), terrain ? &*terrain : nullptr);
        delNote(day->notes, u"terrain"_s);
    } catch (...) {
        setNote(day->notes, u"terrain"_s, u"地形记录失败:本轮没有可回放记录"_s);
    }
    if (failure) setNote(day->notes, u"wall"_s, u"期权墙没取到:%1"_s.arg(excMessage(failure).left(120)));
    day->accel = pb::accelerator(strikesOf(day->wall), day->current ? std::optional<pb::Band>(day->current->b) : std::nullopt);
}

// ---- 状态 ----------------------------------------------------------------
OJson PlaybookService::snapshot() {
    const QString date = domain::nowEt().date;
    std::shared_ptr<Day> day;
    try {
        day = dayFor(date);
    } catch (...) {
        lastError_ = excMessage(std::current_exception()).left(200);
    }
    const bool isEnabled = enabled();
    const pb::Machine machine = day ? day->machine : pb::Machine{};
    const std::optional<BandRec> today = day ? todayRec(*day) : std::nullopt;
    const auto bandJson = [](const std::optional<BandRec>& r) { return r ? r->raw : js::Null(); };
    const std::optional<pb::Band> open = day && day->open ? std::optional<pb::Band>(day->open->b) : std::nullopt;
    const auto [t1, t2] = pb::targets(machine.state, machine.trigger, open, strikesOf(day ? day->wall : std::nullopt));
    OJson events = js::array();
    if (day) events.items = QList<OJson>(day->events.begin(), day->events.end());
    OJson notes = js::array();
    if (day)
        for (const auto& f : day->notes.fields) notes.items.append(f.second);
    return js::object({{u"symbol"_s, js::S(kSymbol)},
                       {u"date"_s, js::S(date)},
                       {u"enabled"_s, js::B(isEnabled)},
                       {u"running"_s, js::B(running_)},
                       {u"price"_s, optN(price_)},
                       {u"price_at"_s, optN(priceAt_)},
                       {u"bands"_s, js::object({{u"prior"_s, bandJson(day ? day->prior : std::nullopt)},
                                                {u"open"_s, bandJson(day ? day->open : std::nullopt)},
                                                {u"current"_s, bandJson(day ? day->current : std::nullopt)},
                                                {u"day"_s, bandJson(today)}})},
                       {u"state"_s, js::S(machine.state)},
                       {u"trigger"_s, optN(machine.trigger)},
                       {u"since"_s, optN(machine.since)},
                       {u"lines"_s, js::object({{u"b2"_s, today ? js::N(today->b.upper) : js::Null()},
                                                {u"b3"_s, day && day->prior ? js::N(day->prior->b.lower) : js::Null()}})},
                       {u"b2_lost"_s, optN(machine.lost)},
                       {u"t1"_s, optN(t1)},
                       {u"t2"_s, optN(t2)},
                       {u"accel"_s, day && day->accel ? js::object({{u"strike"_s, js::N(day->accel->strike)}, {u"net_gex"_s, js::N(day->accel->netGex)}}) : js::Null()},
                       {u"wall"_s, day && day->wall ? *day->wall : js::Null()},
                       {u"events"_s, events},
                       {u"notes"_s, notes},
                       {u"idle_reason"_s, js::S(isEnabled ? idleReason_ : u"已关闭"_s)},
                       {u"last_error"_s, js::S(lastError_)},
                       {u"frame_seconds"_s, js::N(kFrameMin * 60)}});
}

}  // namespace ibkr::orchestrate
