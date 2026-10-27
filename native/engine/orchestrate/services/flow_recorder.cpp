#include "orchestrate/services/flow_recorder.h"

#include "domain/config.h"
#include "execution/broker.h"
#include "execution/ib_contracts.h"
#include "orchestrate/services/svc_util.h"
#include "util/js_runtime.h"
#include "util/jsformat.h"
#include "util/jsobj.h"
#include "util/tz.h"

#include <QDate>
#include <QFileInfo>
#include <QSet>

#include <algorithm>
#include <cmath>

namespace ibkr::orchestrate {

using namespace Qt::StringLiterals;
using util::OJson;
using util::Task;
namespace js = util::js;

namespace {
std::optional<double> finiteOr(double v) { return std::isfinite(v) ? std::optional<double>(v) : std::nullopt; }
std::optional<double> finiteOr(const std::optional<double>& v) { return v && std::isfinite(*v) ? v : std::nullopt; }
OJson nOrNull(const std::optional<double>& v) { return v ? js::N(*v) : js::Null(); }
QString etDate(double ms) { return util::dateStrAt(ms, QString::fromUtf16(util::kET)); }
QString compact(QString date) { return date.replace(u"-"_s, QString()); }

OJson contractRec(const QString& kind, double t, const FlowStreamState& s) {
    return js::object({{u"kind"_s, js::S(kind)}, {u"t"_s, js::N(t)}, {u"expiry"_s, js::S(s.expiry)}, {u"k"_s, js::N(s.strike)}, {u"r"_s, js::S(s.right)}});
}
}  // namespace

QList<OJson> observeFlow(FlowStreamState& s, const execution::TickerData& t, double nowMs) {
    QList<OJson> out;
    const analysis::optionflow::Quote now{finiteOr(t.bid), finiteOr(t.ask)};
    const std::optional<double> volume = finiteOr(t.volume), lastAt = finiteOr(t.lastTradeAt);
    if (volume) {
        if (!s.volume || *volume < *s.volume) {
            // 第一次见到(订上时的当天累计)或者往回跳(TWS 改正):记成底,不算成交
            OJson r = contractRec(u"vol"_s, nowMs, s);
            r.set(u"volume"_s, js::N(*volume));
            out << r;
        } else if (*volume > *s.volume) {
            OJson r = contractRec(u"print"_s, nowMs, s);
            r.set(u"dv"_s, js::N(*volume - *s.volume));
            r.set(u"last"_s, nOrNull(finiteOr(t.last)));
            r.set(u"lt"_s, nOrNull(lastAt));
            r.set(u"plt"_s, nOrNull(s.lastAt));
            r.set(u"pb"_s, nOrNull(s.quote.bid));
            r.set(u"pa"_s, nOrNull(s.quote.ask));
            r.set(u"b"_s, nOrNull(now.bid));
            r.set(u"a"_s, nOrNull(now.ask));
            r.set(u"bs"_s, nOrNull(finiteOr(t.bidSize)));
            r.set(u"as"_s, nOrNull(finiteOr(t.askSize)));
            r.set(u"mdt"_s, nOrNull(finiteOr(t.marketDataType)));
            out << r;
        }
        s.volume = volume;
    }
    // 盘口只在有数时挪:这一次没带盘口不等于盘口没了
    if (now.bid) s.quote.bid = now.bid;
    if (now.ask) s.quote.ask = now.ask;
    if (lastAt) s.lastAt = lastAt;
    return out;
}

FlowRecorderService::FlowRecorderService(SvcHost& host) : SvcBase(host) {}

FlowRecorderService::~FlowRecorderService() {
    *alive_ = false;
    stop();
}

domain::OptionFlowLog FlowRecorderService::tbtLog() const { return domain::OptionFlowLog(QFileInfo(settings().db_path).path() + u"/option-flow-tbt"_s); }

domain::OptionFlowLog FlowRecorderService::log() const { return domain::OptionFlowLog(QFileInfo(settings().db_path).path() + u"/option-flow"_s); }

// ---- 开关 ----------------------------------------------------------------
bool FlowRecorderService::enabled() {
    try {
        const OJson raw = store().getPref(kPref);
        if (raw.type == OJson::Null) return true;
        const OJson* e = js::prop(&raw, u"enabled"_s);
        return !(e && e->type == OJson::Bool && !e->b);
    } catch (...) {
        return true;
    }
}

OJson FlowRecorderService::setEnabled(bool on) {
    const OJson v = js::object({{u"enabled"_s, js::B(on)}});
    store().setPref(kPref, &v);
    if (!on) teardown(u"已关闭"_s, util::dateNow());
    return status();
}

// ---- 循环 ----------------------------------------------------------------
void FlowRecorderService::start(int tickMs) {
    if (running_) return;
    const int gen = ++gen_;
    running_ = true;
    timer_ = rt().setTimeout(tickMs, [this, alive = std::weak_ptr<bool>(alive_), tickMs, gen] {
        if (alive.expired()) return;
        util::detach(loop(tickMs, gen));
    });
}

Task<> FlowRecorderService::loop(int tickMs, int gen) {
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

void FlowRecorderService::stop() {
    gen_ += 1;
    running_ = false;
    if (timer_ != 0) rt().clearTimeout(timer_);
    timer_ = 0;
    teardown(u"已停"_s, util::dateNow());
}

Task<> FlowRecorderService::tickOnce(std::optional<double> nowArg) {
    if (busy_) co_return;  // 上一轮还在等合约确认 / 持仓量:这一秒跳过
    busy_ = true;
    const std::weak_ptr<bool> alive = alive_;
    const double nowMs = nowArg ? *nowArg : domain::nowEt().epochMs;
    try {
        co_await tickInner(nowMs);
    } catch (...) {
        if (!alive.expired()) {
            lastError_ = sliceUnits(errMessage(std::current_exception()), 200);
            idle(u"上一轮出错了"_s);
        }
    }
    if (!alive.expired()) {
        busy_ = false;
        try {
            flush();
        } catch (...) {
            lastError_ = sliceUnits(errMessage(std::current_exception()), 200);
        }
    }
}

Task<> FlowRecorderService::tickInner(double nowMs) {
    const std::weak_ptr<bool> alive = alive_;
    if (!enabled()) co_return teardown(u"已关闭"_s, nowMs);
    const auto router = routerPort();
    if (!router || !router->hasSessions()) co_return teardown(u"没连券商"_s, nowMs);
    if (settings().broker.provider != u"ibkr") co_return teardown(u"期权行情只从 IBKR 取"_s, nowMs);
    if (settings().marketStatus(domain::etNowFromEpoch(nowMs)) != u"盘中") co_return teardown(u"不在常规交易时段"_s, nowMs);
    const auto session = router->marketSession();
    if (session_ && session != session_) teardown(u"换了会话,重订"_s, nowMs);
    const QString date = etDate(nowMs);
    if (!date_.isEmpty() && date_ != date) teardown(u"换日,重订"_s, nowMs);

    if (watches_.isEmpty()) {
        // 订不上(没现价、合约确认不了、TWS 没回话)隔一分钟再试,不每秒去敲 TWS
        if (nowMs - lastSetupAt_ < kRetryMs) co_return;
        lastSetupAt_ = nowMs;
        co_await setup(date, nowMs);
        if (alive.expired()) co_return;
    } else {
        onPush();  // 推送回调之外每秒也读一遍:回调漏了、或者会话不给回调
        if (nowMs - lastRoveAt_ >= kRoveEveryMs) co_await rove(nowMs);
        if (alive.expired()) co_return;
        if (nowMs - lastVolAt_ >= kVolEveryMs) writeVolumes(nowMs);
        // 自己那批流带着 101:持仓量一天来一次,来了记一笔
        for (Watch& w : watches_) {
            if (w.state.oiDone) continue;
            const execution::TickerData t = w.handle->read();
            const std::optional<double> oi = finiteOr(w.state.right == u"C" ? t.callOpenInterest : t.putOpenInterest);
            if (!oi) continue;
            OJson r = contractRec(u"oi"_s, nowMs, w.state);
            r.set(u"oi"_s, js::N(*oi));
            pending_ << r;
            w.state.oiDone = true;
        }
    }
    if (oiTryDate_ != date) {
        oiTryDate_ = date;
        oiTries_ = 0;
    }
    if (oiDate_ != date && domain::etNowFromEpoch(nowMs).minutes >= kOiAfterMinutes && oiTries_ < 3 && nowMs - lastOiTryAt_ >= 5 * 60'000)
        co_await snapshotYesterdayOi(date, nowMs);
}

Task<> FlowRecorderService::setup(const QString& date, double nowMs) {
    const std::weak_ptr<bool> alive = alive_;
    const auto router = routerPort();
    const auto* cfg = settings().indexConfig(kSymbol);
    if (!cfg) co_return idle(u"配置里没有 %1 这个指数"_s.arg(kSymbol));
    const std::optional<double> spot = co_await router->indexPrice(kSymbol);
    if (alive.expired()) co_return;
    const auto info = router->spotInfo(kSymbol);
    const OJson* src = info ? js::prop(&*info, u"source"_s) : nullptr;
    if ((js::isStr(src) && src->s == u"index_stale") || !spot || !(*spot > 0)) co_return idle(u"拿不到现价"_s);

    // 下一个交易日到期:当日到期的合约第二天就没有持仓量可对照
    QDate d = QDate::fromString(date, Qt::ISODate);
    QString expiryDate;
    for (int i = 1; i <= 10 && expiryDate.isEmpty(); ++i) {
        const QString s = d.addDays(i).toString(Qt::ISODate);
        if (settings().isTradingDay(s)) expiryDate = s;
    }
    if (expiryDate.isEmpty()) co_return idle(u"十天里找不到下一个交易日"_s);
    date_ = date;
    expiry_ = compact(expiryDate);
    tradingClass_ = cfg->daily_trading_class;
    anchor_ = std::round(*spot / kStrikeStep) * kStrikeStep;
    session_ = router->marketSession();
    std::vector<double> strikes;
    for (double k = anchor_ - kHalfBand; k <= anchor_ + kHalfBand + 1e-9; k += kStrikeStep) strikes.push_back(k);
    const int got = co_await subscribe(strikes, nowMs, *spot);
    if (alive.expired()) co_return;
    if (!session_) co_return;  // 等的时候被撤了:原因已经写好
    if (got == 0) {
        teardown(u"%1 %2 这批合约一个都确认不了"_s.arg(tradingClass_, expiry_), nowMs);
        co_return;
    }
    // 推送回调:会话给就挂上,不给就退到定时轮询
    if (const auto broker = sh_.broker()) {
        detach_ = broker->onOptionTick([this, alive] {
            if (alive.expired()) return;
            onPush();
        });
    }
    if (!detach_) poll_ = rt().setInterval(kPollMs, [this, alive] {
        if (alive.expired()) return;
        onPush();
    });
    startTruth(*spot);
    lastVolAt_ = nowMs;  // 订上时的累计量由第一次读数记(observeFlow 的底)
    lastRoveAt_ = nowMs;
    idleReason_.clear();
    lastError_.clear();
}

Task<int> FlowRecorderService::subscribe(std::vector<double> strikes, double nowMs, double spot) {
    const std::weak_ptr<bool> alive = alive_;
    const auto* cfg = settings().indexConfig(kSymbol);
    QSet<QString> have;
    for (const Watch& w : watches_) have.insert(util::jsNumberToString(w.state.strike) + w.state.right);
    std::vector<execution::IbContract> contracts;
    for (const double k : strikes) {
        for (const QString& right : {u"C"_s, u"P"_s}) {
            if (k <= 0 || have.contains(util::jsNumberToString(k) + right)) continue;
            if (watches_.size() + qsizetype(contracts.size()) >= kMaxContracts) break;
            contracts.push_back(execution::optionContract(kSymbol, expiry_, k, right, cfg ? cfg->exchange : u"SMART"_s, u"USD"_s, u"100"_s, tradingClass_));
        }
    }
    const auto session = session_;
    if (contracts.empty() || !session) co_return 0;
    std::vector<execution::IbContract*> ptrs;
    for (auto& c : contracts) ptrs.push_back(&c);
    co_await session->qualifyContracts(ptrs, kQualifyTimeoutMs);
    // 等确认的这段时间里被关掉、断线或换了会话:这批不订了
    if (alive.expired() || session_ != session) co_return 0;
    OJson list = js::array();
    int n = 0;
    for (const auto& c : contracts) {
        if (!c.conId || *c.conId == 0) continue;
        Watch w{c, session->subscribeTicker(c, kTicks), {}};
        w.state.expiry = expiry_;
        w.state.strike = c.strike.value_or(0);
        w.state.right = c.right.value_or(QString());
        list.items.append(js::array({js::N(w.state.strike), js::S(w.state.right)}));
        watches_ << w;
        ++n;
    }
    if (n > 0) {
        pending_ << js::object({{u"kind"_s, js::S(u"sub"_s)},
                                {u"t"_s, js::N(nowMs)},
                                {u"expiry"_s, js::S(expiry_)},
                                {u"trading_class"_s, js::S(tradingClass_)},
                                {u"anchor"_s, js::N(anchor_)},
                                {u"spot"_s, js::N(spot)},
                                {u"rule"_s, js::S(analysis::optionflow::kRuleVersion)},
                                {u"contracts"_s, list}});
        pendingDate_ = etDate(nowMs);
    }
    co_return n;
}

Task<> FlowRecorderService::rove(double nowMs) {
    const std::weak_ptr<bool> alive = alive_;
    lastRoveAt_ = nowMs;
    if (watches_.size() >= kMaxContracts) co_return;
    const std::optional<double> spot = co_await routerPort()->indexPrice(kSymbol);
    if (alive.expired() || !spot || !(*spot > 0) || std::fabs(*spot - anchor_) < kRovePoints || watches_.isEmpty()) co_return;
    const double atm = std::round(*spot / kStrikeStep) * kStrikeStep;
    std::vector<double> strikes;
    // 离现价近的先订:线路不够时留下的是平值附近
    strikes.push_back(atm);
    for (double off = kStrikeStep; off <= kRoveHalf + 1e-9; off += kStrikeStep) {
        strikes.push_back(atm - off);
        strikes.push_back(atm + off);
    }
    co_await subscribe(strikes, nowMs, *spot);
}

Task<> FlowRecorderService::snapshotYesterdayOi(const QString& date, double nowMs) {
    const std::weak_ptr<bool> alive = alive_;
    oiTries_ += 1;
    lastOiTryAt_ = nowMs;
    const domain::OptionFlowLog store = log();
    QString prev;
    for (const QString& d : store.dates())
        if (d < date) prev = d;
    const QString today = compact(date);
    std::vector<execution::IbContract> contracts;
    QSet<QString> seen;
    const auto* cfg = settings().indexConfig(kSymbol);
    if (!prev.isEmpty()) {
        for (const OJson& r : store.read(prev)) {
            if (js::str(js::prop(&r, u"kind"_s)) != u"sub" || js::str(js::prop(&r, u"expiry"_s)) != today) continue;
            const QString tc = js::str(js::prop(&r, u"trading_class"_s));
            for (const OJson& c : js::prop(&r, u"contracts"_s)->items) {
                if (c.items.size() != 2) continue;
                const double k = js::num(&c.items[0]);
                const QString right = c.items[1].s;
                if (seen.contains(util::jsNumberToString(k) + right)) continue;
                seen.insert(util::jsNumberToString(k) + right);
                contracts.push_back(execution::optionContract(kSymbol, today, k, right, cfg ? cfg->exchange : u"SMART"_s, u"USD"_s, u"100"_s, tc));
            }
        }
    }
    if (contracts.empty()) {
        oiDate_ = date;  // 前一天没记今天到期的那批:没有可对照的
        co_return;
    }
    const auto session = routerPort()->marketSession();
    std::vector<execution::IbContract*> ptrs;
    for (auto& c : contracts) ptrs.push_back(&c);
    co_await session->qualifyContracts(ptrs, kQualifyTimeoutMs);
    if (alive.expired()) co_return;
    std::vector<std::pair<execution::IbContract, std::shared_ptr<execution::TickerHandle>>> subs;
    for (const auto& c : contracts)
        if (c.conId && *c.conId != 0) subs.emplace_back(c, session->subscribeTicker(c, kTicks));
    std::exception_ptr failure;
    try {
        co_await session->settle(kOiSettleMs);
    } catch (...) {
        failure = std::current_exception();
    }
    if (alive.expired()) co_return;
    int got = 0;
    const double t = util::dateNow();
    for (const auto& [c, h] : subs) {
        const execution::TickerData d = h->read();
        const QString right = c.right.value_or(QString());
        const std::optional<double> oi = finiteOr(right == u"C" ? d.callOpenInterest : d.putOpenInterest);
        try {
            session->cancelTicker(c, kTicks);
        } catch (...) {
        }
        if (!oi) continue;
        FlowStreamState s{today, c.strike.value_or(0), right, {}, {}, {}, false};
        OJson r = contractRec(u"oi"_s, t, s);
        r.set(u"oi"_s, js::N(*oi));
        pending_ << r;
        ++got;
    }
    if (got > 0) {
        oiDate_ = date;
        if (pendingDate_.isEmpty()) pendingDate_ = date;
    }
    if (failure) std::rethrow_exception(failure);
}

void FlowRecorderService::startTruth(double spot) {
    if (!session_) return;
    std::vector<const Watch*> near;
    for (const Watch& w : watches_) near.push_back(&w);
    // 离现价最近的先;一样近的 C 在 P 前
    std::stable_sort(near.begin(), near.end(), [spot](const Watch* a, const Watch* b) {
        const double da = std::fabs(a->state.strike - spot), db = std::fabs(b->state.strike - spot);
        if (da != db) return da < db;
        return a->state.right < b->state.right;
    });
    OJson list = js::array();
    const std::weak_ptr<bool> alive = alive_;
    for (size_t i = 0; i < near.size() && i < size_t(kTruthContracts); ++i) {
        const FlowStreamState s = near[i]->state;
        list.items.append(js::array({js::N(s.strike), js::S(s.right)}));
        // 这张合约的两条撤销函数:任一条被拒,另一条也撤
        auto pair = std::make_shared<QList<std::function<void()>>>();
        auto dropped = std::make_shared<bool>(false);
        for (const QString& type : {u"BidAsk"_s, u"AllLast"_s}) {
            auto onTick = [this, alive, s, dropped](const execution::TickByTick& tk) {
                if (alive.expired() || *dropped) return;
                OJson r = contractRec(u"tbt"_s, util::dateNow(), s);
                r.set(u"type"_s, js::S(tk.kind));
                r.set(u"time"_s, js::N(tk.time));
                if (tk.kind == u"last") {
                    r.set(u"price"_s, nOrNull(tk.price));
                    r.set(u"size"_s, nOrNull(tk.size));
                    r.set(u"exch"_s, js::S(tk.exchange));
                    r.set(u"cond"_s, js::S(tk.special));
                    if (tk.unreported) r.set(u"unrep"_s, js::B(true));
                    if (tk.pastLimit) r.set(u"plim"_s, js::B(true));
                } else {
                    r.set(u"bid"_s, nOrNull(tk.bid));
                    r.set(u"ask"_s, nOrNull(tk.ask));
                    r.set(u"bs"_s, nOrNull(tk.bidSize));
                    r.set(u"as"_s, nOrNull(tk.askSize));
                }
                pendingTbt_ << r;
                truthTicks_ += 1;
            };
            auto onError = [this, alive, s, type, pair, dropped](const QString& error) {
                if (alive.expired()) return;
                OJson r = contractRec(u"tbt_err"_s, util::dateNow(), s);
                r.set(u"type"_s, js::S(type));
                r.set(u"error"_s, js::S(sliceUnits(error, 300)));
                pendingTbt_ << r;
                truthErrors_ += 1;
                if (*dropped) return;
                *dropped = true;
                // 回调里撤:撤的是另一条(被拒的那条库已经自己撤了),拷一份再叫
                const auto cancels = *pair;
                for (const auto& cancel : cancels) {
                    try {
                        cancel();
                    } catch (...) {
                    }
                }
            };
            auto cancel = session_->tickByTick(near[i]->contract, type, onTick, onError);
            if (cancel) {
                pair->append(cancel);
                truthCancels_ << cancel;
            }
        }
    }
    truthContracts_ = list;
}

void FlowRecorderService::onPush() {
    if (watches_.isEmpty()) return;
    const double now = util::dateNow();
    for (Watch& w : watches_) {
        const QList<OJson> rows = observeFlow(w.state, w.handle->read(), now);
        for (const OJson& r : rows) {
            if (js::str(js::prop(&r, u"kind"_s)) == u"print") {
                prints_ += 1;
                lastPrintAt_ = now;
            }
        }
        pending_ << rows;
    }
    if (!pending_.isEmpty() && pendingDate_.isEmpty()) pendingDate_ = etDate(now);
}

void FlowRecorderService::writeVolumes(double nowMs) {
    lastVolAt_ = nowMs;
    for (const Watch& w : watches_) {
        if (!w.state.volume) continue;
        OJson r = contractRec(u"vol"_s, nowMs, w.state);
        r.set(u"volume"_s, js::N(*w.state.volume));
        pending_ << r;
    }
    if (!pending_.isEmpty() && pendingDate_.isEmpty()) pendingDate_ = etDate(nowMs);
}

void FlowRecorderService::flush() {
    if (!pendingTbt_.isEmpty()) {
        const QList<OJson> ticks = std::exchange(pendingTbt_, {});
        const QString day = etDate(util::dateNow());
        const domain::OptionFlowLog tbt = tbtLog();
        tbt.appendAll(day, ticks);
        if (day != tbtPrunedFor_) {
            tbtPrunedFor_ = day;
            tbt.prune(kTruthKeepDays);
        }
    }
    if (pending_.isEmpty()) return;
    const QList<OJson> rows = std::exchange(pending_, {});
    const QString date = std::exchange(pendingDate_, QString());
    const QString day = date.isEmpty() ? etDate(util::dateNow()) : date;
    const domain::OptionFlowLog store = log();
    store.appendAll(day, rows);
    // 这个进程里这一天第一次落盘:顺手把太老的清掉
    if (day != prunedFor_) {
        prunedFor_ = day;
        store.prune();
    }
}

void FlowRecorderService::teardown(const QString& reason, double nowMs) {
    if (!watches_.isEmpty()) {
        onPush();
        writeVolumes(nowMs);  // 收盘那一刻的累计量:覆盖率的分母
    }
    if (detach_) detach_();
    detach_ = {};
    for (const auto& cancel : std::exchange(truthCancels_, {})) {
        try {
            cancel();
        } catch (...) {
        }
    }
    truthContracts_ = OJson::null();
    if (poll_ != 0) rt().clearInterval(poll_);
    poll_ = 0;
    for (const Watch& w : watches_) {
        try {
            if (session_) session_->cancelTicker(w.contract, kTicks);  // 只撤自己这一条(带 101 的那一份)
        } catch (...) {
        }
    }
    watches_.clear();
    session_.reset();
    date_.clear();
    try {
        flush();
    } catch (...) {
        lastError_ = sliceUnits(errMessage(std::current_exception()), 200);
    }
    idleReason_ = reason;
}

OJson FlowRecorderService::status() {
    const bool en = enabled();
    OJson contracts = js::array();
    for (const Watch& w : watches_) contracts.items.append(js::array({js::N(w.state.strike), js::S(w.state.right)}));
    return js::object({{u"enabled"_s, js::B(en)},
                       {u"running"_s, js::B(running_)},
                       {u"symbol"_s, js::S(kSymbol)},
                       {u"rule"_s, js::S(analysis::optionflow::kRuleVersion)},
                       {u"dir"_s, js::S(log().dir())},
                       {u"expiry"_s, expiry_.isEmpty() || watches_.isEmpty() ? js::Null() : js::S(expiry_)},
                       {u"anchor"_s, watches_.isEmpty() ? js::Null() : js::N(anchor_)},
                       {u"contracts"_s, contracts},
                       {u"prints"_s, js::N(prints_)},
                       {u"truth_contracts"_s, truthContracts_},
                       {u"truth_ticks"_s, js::N(truthTicks_)},
                       {u"truth_errors"_s, js::N(truthErrors_)},
                       {u"last_print_at"_s, lastPrintAt_ ? js::S(isoMsZ(*lastPrintAt_)) : js::Null()},
                       {u"idle_reason"_s, js::S(en ? idleReason_ : u"已关闭"_s)},
                       {u"last_error"_s, js::S(lastError_)}});
}

}  // namespace ibkr::orchestrate
