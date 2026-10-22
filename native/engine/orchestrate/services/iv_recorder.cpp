#include "orchestrate/services/iv_recorder.h"

#include "domain/config.h"
#include "execution/held_streams.h"
#include "orchestrate/services/svc_util.h"
#include "util/jsformat.h"
#include "util/jsobj.h"
#include "util/tz.h"

#include <QDir>
#include <QFileInfo>

#include <algorithm>
#include <cmath>

namespace ibkr::orchestrate {

using namespace Qt::StringLiterals;
using util::OJson;
using util::Task;
namespace js = util::js;

IvRecorderService::IvRecorderService(SvcHost& host, std::shared_ptr<MarksPort> marks) : SvcBase(host), marks_(std::move(marks)) {}

IvRecorderService::~IvRecorderService() {
    *alive_ = false;
    stop();
}

domain::IvSampleStore IvRecorderService::store2() {
    return domain::IvSampleStore(QFileInfo(settings().db_path).path() + u"/fly-iv"_s);
}

// ---- 开关 ----------------------------------------------------------------
bool IvRecorderService::enabled() {
    try {
        const OJson raw = store().getPref(kPref);
        if (raw.type == OJson::Null) return true;
        const OJson* e = js::prop(&raw, u"enabled"_s);
        return !(e && e->type == OJson::Bool && !e->b);
    } catch (...) {
        return true;  // 库打不开时别的地方会报;这里不因为它把循环弄挂
    }
}

OJson IvRecorderService::setEnabled(bool on) {
    const OJson v = js::object({{u"enabled"_s, js::B(on)}});
    store().setPref(kPref, &v);
    if (!on) idleReason_ = u"已关闭"_s;
    return status();
}

// ---- 循环 ----------------------------------------------------------------
void IvRecorderService::start(int tickMs) {
    if (running_) return;
    const int gen = ++gen_;
    running_ = true;
    timer_ = rt().setTimeout(tickMs, [this, alive = std::weak_ptr<bool>(alive_), tickMs, gen] {
        if (alive.expired()) return;
        util::detach(loop(tickMs, gen));
    });
}

Task<> IvRecorderService::loop(int tickMs, int gen) {
    const std::weak_ptr<bool> alive = alive_;
    try {
        co_await tickOnce();
    } catch (...) {
    }
    if (alive.expired() || gen != gen_ || !running_) co_return;
    timer_ = rt().setTimeout(tickMs, [this, alive, tickMs, gen] {
        if (alive.expired()) return;
        util::detach(loop(tickMs, gen));
    });
}

void IvRecorderService::stop() {
    gen_ += 1;
    running_ = false;
    if (timer_ != 0) rt().clearTimeout(timer_);
    timer_ = 0;
}

Task<OJson> IvRecorderService::tickOnce(std::optional<double> nowArg) {
    // run = chain.then(() => tickInner(nowMs ?? nowEt().epochMs)); chain = run.catch(() => undefined)
    const Task<> previous = chain_;
    util::Deferred<> mine;
    chain_ = mine.task();
    co_await previous;
    OJson result;
    std::exception_ptr failure;
    try {
        result = co_await tickInner(nowArg ? *nowArg : domain::nowEt().epochMs);
    } catch (...) {
        failure = std::current_exception();
    }
    mine.resolve();
    if (failure) std::rethrow_exception(failure);
    co_return result;
}

OJson IvRecorderService::idle(const QString& reason) {
    idleReason_ = reason;
    return OJson::null();
}

Task<OJson> IvRecorderService::tickInner(double nowMs) {
    try {
        if (!enabled()) co_return idle(u"已关闭"_s);
        const auto router = routerPort();
        if (!router || !router->hasSessions()) co_return idle(u"没连券商"_s);
        if (settings().broker.provider != u"ibkr") co_return idle(u"期权行情只从 IBKR 取"_s);
        if (settings().marketStatus(domain::etNowFromEpoch(nowMs)) != u"盘中") co_return idle(u"不在常规交易时段"_s);
        if (nowMs - lastLoopAt_ < kIntervalMs) co_return OJson::null();  // 还没到下一笔的时候,原因不变

        const QString symbol = kSymbol;
        const auto* cfg = settings().indexConfig(symbol);
        if (!cfg) co_return idle(u"配置里没有 %1 这个指数"_s.arg(symbol));
        const std::optional<double> spot = co_await router->indexPrice(symbol);
        const auto info = router->spotInfo(symbol);
        const OJson* srcP = info ? js::prop(&*info, u"source"_s) : nullptr;
        if ((js::isStr(srcP) && srcP->s == u"index_stale") || !spot || !(*spot > 0)) co_return idle(u"拿不到现价"_s);

        const QString date = util::dateStrAt(nowMs, QString::fromUtf16(util::kET));
        const double anchor = anchorFor(date, *spot);
        const QList<Leg> legs = legsFor(anchor, *spot);
        const auto session = router->marketSession();
        const QStringList managed = session->managedAccounts();
        bool delayedOk = !managed.isEmpty();
        for (const QString& id : managed)
            if (!id.startsWith(u'D')) delayedOk = false;
        QString expiry = date;
        expiry.replace(u"-"_s, QString());
        std::vector<execution::OptionLegSpec> specs;
        for (const Leg& l : legs) specs.push_back({symbol, expiry, l.strike, l.right, u"SMART"_s, cfg->daily_trading_class});
        // 只在常规时段记;五分钟一笔、流闲一分钟就撤,多半是新订的,这条只防测算那边一直热着的
        const auto got = co_await marks_->read(session, specs, delayedOk, execution::silenceLimitMs(u"盘中"_s));
        OJson legsJson = js::array();
        for (size_t i = 0; i < got.size(); ++i)
            legsJson.items.append(js::object({{u"strike"_s, js::N(got[i].strike)}, {u"right"_s, js::S(legs[qsizetype(i)].right)}, {u"bid"_s, js::NOrNull(got[i].bid)},
                                              {u"ask"_s, js::NOrNull(got[i].ask)}, {u"iv"_s, js::NOrNull(got[i].iv)}}));
        const OJson sample = js::object({{u"t"_s, js::N(nowMs)},
                                         {u"symbol"_s, js::S(symbol)},
                                         {u"expiry"_s, js::S(expiry)},
                                         {u"trading_class"_s, js::S(cfg->daily_trading_class)},
                                         {u"spot"_s, js::N(*spot)},
                                         {u"spot_source"_s, js::S(js::isStr(srcP) && srcP->s == u"futures" ? u"futures"_s : u"quote"_s)},
                                         {u"by"_s, js::S(u"loop"_s)},
                                         {u"anchor"_s, js::N(anchor)},
                                         {u"legs"_s, legsJson}});
        // 到了该记的时候就算记过一轮:行情一条都没来也不紧接着重试,免得每三十秒订一遍
        lastLoopAt_ = nowMs;
        // 一条盘口都没有就不记,哪怕有模型 IV:合盖睡着、只在维护唤醒里跑的那几笔只有模型 IV,进了校准就是假数据
        bool anyAsk = false, anyIv = false;
        for (const OJson& l : legsJson.items) {
            if (js::prop(&l, u"ask"_s)->type != OJson::Null) anyAsk = true;
            if (js::prop(&l, u"iv"_s)->type != OJson::Null) anyIv = true;
        }
        if (!anyAsk) {
            std::optional<QString> why;
            for (const auto& m : got)
                if (m.error && !m.error->isEmpty()) {
                    why = *m.error;
                    break;
                }
            co_return idle(why ? u"行情订阅被拒:%1"_s.arg(*why) : anyIv ? u"这一轮只有模型 IV、没有盘口,不记"_s : u"这一轮一条行情都没来"_s);
        }
        write(sample);
        lastError_.clear();
        co_return sample;
    } catch (...) {
        lastError_ = sliceUnits(errMessage(std::current_exception()), 200);
        lastLoopAt_ = nowMs;
        co_return idle(u"上一轮出错了"_s);
    }
}

void IvRecorderService::write(const OJson& sample) {
    const auto s = store2();
    s.append(sample);
    lastAt_ = js::num(js::prop(&sample, u"t"_s));
    idleReason_.clear();
    // 新的一天的第一笔:顺手把太老的清掉
    if (s.read(util::dateStrAt(*lastAt_, QString::fromUtf16(util::kET))).size() == 1) s.prune();
}

double IvRecorderService::anchorFor(const QString& date, double spot) {
    if (anchor_ && anchor_->date == date) return anchor_->strike;
    std::optional<double> seen;
    for (const OJson& s : store2().read(date)) {
        const OJson* a = js::prop(&s, u"anchor"_s);
        if (js::str(js::prop(&s, u"by"_s)) == u"loop" && js::isNum(a)) {
            seen = a->n;
            break;
        }
    }
    const double step = kStrikeStep;
    anchor_ = Anchor{date, seen ? *seen : util::jsRound(spot / step) * step};
    return anchor_->strike;
}

QList<IvRecorderService::Leg> IvRecorderService::legsFor(double anchor, double spot) {
    QList<Leg> legs;
    QSet<QString> seen;
    const auto add = [&](double strike, const QString& right) {
        const QString key = util::jsNumberToString(strike) + right;
        if (strike > 0 && !seen.contains(key)) {
            seen.insert(key);
            legs.append({strike, right});
        }
    };
    for (double offset : kOffsets) {
        if (offset <= 0) add(anchor + offset, u"P"_s);
        if (offset >= 0) add(anchor + offset, u"C"_s);
    }
    if (std::fabs(spot - anchor) >= kRovePoints) {
        const double step = kStrikeStep, atm = util::jsRound(spot / step) * step;
        add(atm, u"P"_s);
        add(atm, u"C"_s);
    }
    return legs;
}

bool IvRecorderService::recordPlan(const OJson& sample) {
    try {
        if (!enabled()) return false;
        const double t = js::num(js::prop(&sample, u"t"_s));
        QString today = util::dateStrAt(t, QString::fromUtf16(util::kET));
        today.replace(u"-"_s, QString());
        if (js::str(js::prop(&sample, u"expiry"_s)) != today) return false;
        bool anyIv = false;
        QStringList keyParts;
        for (const OJson& l : js::prop(&sample, u"legs"_s)->items) {
            if (js::prop(&l, u"iv"_s)->type != OJson::Null) anyIv = true;
            keyParts.append(js::str(js::prop(&l, u"strike"_s)) + js::str(js::prop(&l, u"right"_s)));
        }
        if (!anyIv) return false;
        const QString key = js::str(js::prop(&sample, u"symbol"_s)) + u'|' + keyParts.join(u',');
        if (t - lastPlanAt_.value(key, 0) < kPlanGapMs) return false;
        lastPlanAt_.insert(key, t);
        OJson withBy = sample;
        withBy.set(u"by"_s, js::S(u"plan"_s));
        write(withBy);
        return true;
    } catch (...) {
        lastError_ = sliceUnits(errMessage(std::current_exception()), 200);
        return false;
    }
}

OJson IvRecorderService::status() {
    const auto s = store2();
    double days = 0, samples = 0;
    std::optional<QString> first, last;
    try {
        for (const QString& day : s.dates()) {
            const double bytes = double(QFileInfo(s.fileOf(day)).size());
            const auto hit = counted_.constFind(day);
            const double count = (hit != counted_.cend() && hit->bytes == bytes) ? hit->samples : double(s.read(day).size());
            counted_.insert(day, Counted{bytes, count});
            if (count == 0) continue;
            days += 1;
            samples += count;
            if (!first) first = day;
            last = day;
        }
    } catch (...) {
        lastError_ = sliceUnits(errMessage(std::current_exception()), 200);
    }
    const bool en = enabled();
    return js::object({{u"enabled"_s, js::B(en)},
                       {u"running"_s, js::B(running_)},
                       {u"symbol"_s, js::S(kSymbol)},
                       {u"interval_seconds"_s, js::N(kIntervalMs / 1000)},
                       {u"dir"_s, js::S(s.dir())},
                       {u"days"_s, js::N(days)},
                       {u"samples"_s, js::N(samples)},
                       {u"first_date"_s, first ? js::S(*first) : js::Null()},
                       {u"last_date"_s, last ? js::S(*last) : js::Null()},
                       {u"last_at"_s, lastAt_ ? js::S(isoMsZ(*lastAt_)) : js::Null()},
                       {u"idle_reason"_s, js::S(en ? idleReason_ : u"已关闭"_s)},
                       {u"last_error"_s, js::S(lastError_)}});
}

}  // namespace ibkr::orchestrate
