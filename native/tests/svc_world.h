// svc2 簇对拍用的"世界"的 C++ 一半:对应 tests/fixtures/svc_world.mjs(约定与脚本格式见那里的开头)。
// 虚拟钟与计时器(接到 SvcRuntime)、真的交易库(临时文件)、记录一切的假宿主 / 假引擎 / 假通知器、脚本驱动的假 IbSession 与会话工厂(给真的
// BrokerRouter 用),以及按脚本逐步跑一个 service、产出与 JS 一样形状的 {log, steps} 的 Runner。改这个文件就要同时改 svc_world.mjs。
//
// 与 JS 的差别(一一对应的处理):
//   · JS 的 async 函数返回的 Promise,调用方的后续永远晚一个微任务;Task 完成时同步续跑。假会话的每个 async 方法在返回结果前 co_await tick(),
//     tick 在"当前同步段结束"(每个计时器回调之后、每一步之后的 drain)才放行——调用方看到结果的时机和 JS 一样晚一拍。
//   · 带 delay 的结果(sleep)醒来之后也 co_await tick() 再返回,同理。
//   · 计时器同刻按排入先后;setInterval 在回调跑完之后、没被清掉才排下一次(同 JS 的 world.stepOne)。
#pragma once

#include "contract/ordered_map.h"
#include "domain/config.h"
#include "domain/store.h"
#include "execution/broker.h"
#include "execution/ib_link.h"
#include "js_fixture.h"
#include "analysis/macro.h"
#include "execution/option_marks.h"
#include "orchestrate/services/svc1_ports.h"
#include "util/jsformat.h"
#include "orchestrate/services/svc_host.h"
#include "orchestrate/services/svc_util.h"
#include "util/js_runtime.h"
#include "util/jsobj.h"

#include <QDir>
#include <QFileInfo>
#include <QHash>
#include <QMap>
#include <QTemporaryDir>
#include <QTest>

#include <functional>
#include <map>
#include <memory>
#include <unordered_map>

namespace svcw {

using ibkr::util::OJson;
using ibkr::util::Task;
namespace js = ibkr::util::js;
using namespace Qt::StringLiterals;
using namespace ibkr::execution;
using namespace ibkr::orchestrate;

inline QString str(const OJson& o, const QString& k, const QString& d = {}) {
    const OJson* v = o.get(k);
    return (v && v->type == OJson::String) ? v->s : d;
}
inline double num(const OJson& o, const QString& k, double d = 0) {
    const OJson* v = o.get(k);
    return (v && v->type == OJson::Number) ? v->n : d;
}
inline bool flag(const OJson& o, const QString& k, bool d = false) {
    const OJson* v = o.get(k);
    return (v && v->type == OJson::Bool) ? v->b : d;
}

/// xorshift32,同 broker_world.mjs 的 rng
class Rng {
public:
    explicit Rng(quint32 seed) : x_(seed ? seed : 1) {}
    double next() {
        x_ ^= x_ << 13;
        x_ ^= x_ >> 17;
        x_ ^= x_ << 5;
        return double(x_) / 4294967296.0;
    }

private:
    quint32 x_;
};

class World : public SvcRuntime {
public:
    struct Timer {
        int id = 0;
        double at = 0;
        qint64 seq = 0;
        std::function<void()> fn;
        double every = 0;
        bool dead = false;
    };

    explicit World(const OJson& script) : script_(script), rng_(quint32(num(script, u"seed"_s, 1))) {
        T = num(script, u"start"_s);
        startT_ = T;
        perfBase_ = num(script, u"perfBase"_s, 1'000'000);
        sync();
        ibkr::util::setDateNowForTests([this] { return T; });
        ibkr::util::setRandomUUIDForTests([this] { return QString(u"00000000-0000-4000-8000-%1"_s.arg(++uuidN, 12, 10, QLatin1Char('0'))); });
        setLogSinkForTests([this](const QString& line) { rec(QString(), u"stderr"_s, js::array({js::S(line)})); });
    }
    ~World() override {
        ibkr::util::setDateNowForTests({});
        ibkr::util::setRandomUUIDForTests({});
        ibkr::domain::setClock(std::nullopt);
        setLogSinkForTests({});
    }
    World(const World&) = delete;
    World& operator=(const World&) = delete;

    double T = 0;
    qint64 uuidN = 0;
    bool trackEngine = false;
    OJson log = js::array();
    QStringList sessionOrder;
    QHash<QString, std::shared_ptr<class FakeSession>> sessions;
    QHash<QString, int> factoryIdx;

    /// domain::nowEt() 读的是 domain 的钟,不是 util::dateNow:每次 T 变都对一遍
    void sync() { ibkr::domain::setClock(T); }

    void rec(const QString& session, const QString& method, OJson args) {
        OJson e = js::object();
        e.set(u"t"_s, js::N(T));
        e.set(u"s"_s, session.isNull() ? js::Null() : js::S(session));
        e.set(u"m"_s, js::S(method));
        e.set(u"a"_s, std::move(args));
        log.items.append(std::move(e));
    }

    // ---- SvcRuntime
    double perfMs() override { return T - startT_ + perfBase_; }
    int setTimeout(int ms, std::function<void()> fn) override { return addTimer(std::move(fn), ms, 0); }
    void clearTimeout(int id) override { clearTimer(id); }
    int setInterval(int ms, std::function<void()> fn) override { return addTimer(std::move(fn), ms, ms < 1 ? 1 : ms); }
    void clearInterval(int id) override { clearTimer(id); }
    double random() override { return rng_.next(); }

    int addTimer(std::function<void()> fn, double ms, double every) {
        auto t = std::make_shared<Timer>();
        const double delay = (ms < 1 || std::isnan(ms)) ? 1 : ms;
        t->id = nextId_++;
        t->at = T + delay;
        t->seq = counter_++;
        t->fn = std::move(fn);
        t->every = every;
        timers_.push_back(t);
        byId_[t->id] = t;
        return t->id;
    }
    void clearTimer(int id) {
        const auto it = byId_.find(id);
        if (it == byId_.end()) return;
        it->second->dead = true;
        for (auto i = timers_.begin(); i != timers_.end(); ++i) {
            if (*i == it->second) {
                timers_.erase(i);
                break;
            }
        }
        byId_.erase(it);
    }
    Task<> sleep(double delay) {
        ibkr::util::Deferred<> d;
        addTimer([d]() mutable { d.resolve(); }, delay, 0);
        return d.task();
    }

    // ---- 微任务边界
    Task<> tick() {
        ibkr::util::Deferred<> d;
        pending_.push_back(d);
        return d.task();
    }
    void drain() {
        while (!pending_.empty()) {
            auto batch = std::move(pending_);
            pending_.clear();
            for (auto& d : batch) d.resolve();
        }
    }

    /// 最早的一个计时器(同刻按先后)到点:钟走到那一刻,触发,排空。没有计时器回 false
    bool stepOne(double limit = INFINITY) {
        std::shared_ptr<Timer> best;
        for (const auto& e : timers_) {
            if (!best || e->at < best->at || (e->at == best->at && e->seq < best->seq)) best = e;
        }
        if (!best || best->at > limit) return false;
        for (auto it = timers_.begin(); it != timers_.end(); ++it) {
            if (*it == best) {
                timers_.erase(it);
                break;
            }
        }
        T = std::fmax(T, best->at);
        sync();
        best->fn();
        if (best->every > 0 && !best->dead) {
            best->at = T + best->every;
            best->seq = counter_++;
            timers_.push_back(best);
        } else {
            byId_.erase(best->id);
        }
        drain();
        return true;
    }
    void advance(double ms) {
        const double end = T + ms;
        while (stepOne(end)) {
        }
        T = end;
        sync();
    }

private:
    OJson script_;
    Rng rng_;
    double startT_ = 0, perfBase_ = 0;
    int nextId_ = 1;
    qint64 counter_ = 0;
    std::vector<std::shared_ptr<Timer>> timers_;
    std::unordered_map<int, std::shared_ptr<Timer>> byId_;
    std::vector<ibkr::util::Deferred<>> pending_;
};

/// 按调用先后各取一个结果,用完重复最后一个
inline const OJson& pickResult(const OJson& cfg, QHash<QString, int>& counters, const QString& key, const OJson& dflt) {
    const OJson* list = cfg.get(key);
    const OJson& l = (list && list->type == OJson::Array && !list->items.isEmpty()) ? *list : dflt;
    const int i = counters.value(key, 0);
    counters.insert(key, i + 1);
    return l.items[qMin<qsizetype>(i, l.items.size() - 1)];
}

class FakeSession : public IbSession {
public:
    FakeSession(World* w, const OJson& cfg) : w_(w), cfg_(cfg) {
        name = str(cfg, u"name"_s);
        connected = flag(cfg, u"connected"_s, true);
        if (const OJson* caps = cfg.get(u"caps"_s)) {
            for (const OJson& c : caps->items) {
                if (c.s == u"SetBaselineMarketDataType") caps_.insert(Cap::SetBaselineMarketDataType);
                else if (c.s == u"Executions") caps_.insert(Cap::Executions);
                else if (c.s == u"ExecutionHistory") caps_.insert(Cap::ExecutionHistory);
                else if (c.s == u"OnLink") caps_.insert(Cap::OnLink);
                else qFatal("脚本里不认识的 caps %s", qPrintable(c.s));
            }
        }
    }

    QString name;
    bool connected = true;
    bool closed = false;  // 显式断开之后真会话不再报通断
    std::vector<std::function<void(bool)>> linkCbs;
    QHash<QString, int> counters;

    OJson& cfg() { return cfg_; }

    bool has(Cap c) const override { return caps_.contains(c); }
    bool isConnected() override { return connected; }
    Task<> disconnect() override {
        w_->rec(name, u"disconnect"_s, js::array());
        connected = false;
        closed = true;
        const double d = num(cfg_, u"disconnectDelay"_s);
        if (d > 0) co_await w_->sleep(d);
        if (flag(cfg_, u"throwDisconnect"_s)) throw ibkr::util::JsError(u"disconnect boom"_s);
    }
    QStringList managedAccounts() override {
        QStringList out;
        if (const OJson* a = cfg_.get(u"accounts"_s))
            for (const OJson& x : a->items) out.append(x.s);
        return out;
    }
    void onConnectivity(std::function<void(int)>) override { w_->rec(name, u"onConnectivity"_s, js::array()); }
    void onLink(std::function<void(bool)> cb) override {
        w_->rec(name, u"onLink"_s, js::array());
        linkCbs.push_back(std::move(cb));
    }
    void setBaselineMarketDataType(int t) override { w_->rec(name, u"setBaselineMarketDataType"_s, js::array({js::N(t)})); }
    void reqMarketDataType(int t) override { w_->rec(name, u"reqMarketDataType"_s, js::array({js::N(t)})); }
    std::shared_ptr<TickerHandle> subscribeTicker(const IbContract& c, const QString& g) override {
        w_->rec(name, u"subscribeTicker"_s, js::array({js::S(c.secType), js::S(c.symbol), js::S(c.exchange), js::S(g)}));
        struct H : TickerHandle {
            TickerData read() override { return {}; }
        };
        return std::make_shared<H>();
    }
    void cancelTicker(const IbContract&, const std::optional<QString>&) override {}
    Task<> settle(int) override { co_await w_->tick(); }
    Task<> qualifyContracts(std::vector<IbContract*> cs, int) override {
        OJson l = js::array();
        for (const IbContract* c : cs) l.items.append(js::array({js::S(c->secType), js::S(c->symbol), js::S(c->exchange)}));
        w_->rec(name, u"qualifyContracts"_s, js::array({l}));
        co_await w_->tick();
    }
    Task<std::vector<RawBar>> historicalData(IbContract, HistoricalRequest) override { throw ibkr::util::JsError(u"svc_world: historicalData 未脚本"_s); }
    Task<std::vector<OptChainParam>> secDefOptParams(QString, QString, int) override { throw ibkr::util::JsError(u"svc_world: secDefOptParams 未脚本"_s); }
    Task<Depth> mktDepth(IbContract, int, int) override { throw ibkr::util::JsError(u"svc_world: mktDepth 未脚本"_s); }
    Task<TradeLike> placeOrder(IbContract, OrderIntent) override { throw ibkr::util::JsError(u"svc_world: placeOrder 未脚本"_s); }
    Task<std::vector<OpenTrade>> openTrades() override { throw ibkr::util::JsError(u"svc_world: openTrades 未脚本"_s); }
    Task<> cancelOrder(int) override { throw ibkr::util::JsError(u"svc_world: cancelOrder 未脚本"_s); }
    Task<std::vector<PortfolioItemLike>> portfolio() override {
        co_await w_->tick();
        co_return std::vector<PortfolioItemLike>{};
    }
    Task<std::vector<PositionItemLike>> positions() override {
        w_->rec(name, u"positions"_s, js::array());
        const OJson dflt = js::array({js::object({{u"rows"_s, js::array()}})});
        const OJson r = pickResult(cfg_, counters, u"positions"_s, dflt);
        if (flag(r, u"hang"_s)) co_await ibkr::util::Deferred<>().task();
        if (num(r, u"delay"_s) > 0) co_await w_->sleep(num(r, u"delay"_s));
        co_await w_->tick();
        if (const OJson* e = r.get(u"error"_s)) throw ibkr::util::JsError(e->s);
        std::vector<PositionItemLike> out;
        for (const OJson& row : r.get(u"rows"_s)->items) {
            PositionItemLike p;
            p.contract = row.get(u"contract"_s) ? *row.get(u"contract"_s) : js::object();
            p.position = js::num(row.get(u"position"_s));
            p.avgCost = num(row, u"avgCost"_s);
            if (const OJson* a = row.get(u"account"_s); a && a->type == OJson::String) p.account = a->s;
            out.push_back(std::move(p));
        }
        co_return out;
    }
    Task<std::vector<ExecutionRow>> executions() override {
        w_->rec(name, u"executions"_s, js::array());
        const OJson dflt = js::array({js::object({{u"rows"_s, js::array()}})});
        const OJson r = pickResult(cfg_, counters, u"executions"_s, dflt);
        if (flag(r, u"hang"_s)) co_await ibkr::util::Deferred<>().task();
        if (num(r, u"delay"_s) > 0) co_await w_->sleep(num(r, u"delay"_s));
        co_await w_->tick();
        if (const OJson* e = r.get(u"error"_s)) throw ibkr::util::JsError(e->s);
        co_return rowsOf(*r.get(u"rows"_s));
    }
    Task<std::optional<std::vector<ExecutionRow>>> executionHistory(int days) override {
        w_->rec(name, u"executionHistory"_s, js::array({js::N(days)}));
        const OJson dflt = js::array({js::object({{u"rows"_s, js::array()}})});
        const OJson r = pickResult(cfg_, counters, u"history"_s, dflt);
        if (flag(r, u"hang"_s)) co_await ibkr::util::Deferred<>().task();
        if (num(r, u"delay"_s) > 0) co_await w_->sleep(num(r, u"delay"_s));
        co_await w_->tick();
        if (const OJson* e = r.get(u"error"_s)) throw ibkr::util::JsError(e->s);
        const OJson* rows = r.get(u"rows"_s);
        if (rows->type == OJson::Null) co_return std::nullopt;
        co_return rowsOf(*rows);
    }

private:
    static std::vector<ExecutionRow> rowsOf(const OJson& rows) {
        std::vector<ExecutionRow> out;
        for (const OJson& d : rows.items) out.push_back(ExecutionRow{d.get(u"contract"_s) ? *d.get(u"contract"_s) : js::object(), d.get(u"execution"_s) ? *d.get(u"execution"_s) : js::object()});
        return out;
    }
    World* w_;
    OJson cfg_;
    QSet<Cap> caps_;
};

/// 脚本驱动的假 router(RouterPort 那一面;对应 svc_world.mjs 的 ScriptedRouter,脚本格式见那里)
class ScriptedRouter : public RouterPort {
public:
    ScriptedRouter(World* w, const OJson& cfg) : w_(w), cfg_(cfg) { n = int(num(cfg, u"sessions"_s, 1)); }

    int n = 1;
    OJson& cfg() { return cfg_; }
    void resetCounter(const QString& key) { counters_.remove(key); }

    bool hasSessions() override { return n > 0; }
    bool upstreamOk() override {
        w_->rec(u"router"_s, u"upstreamOk"_s, js::array());
        return flag(cfg_, u"upstreamOk"_s, true);
    }
    std::optional<OJson> spotInfo(const QString& symbol) override {
        w_->rec(u"router"_s, u"spotInfo"_s, js::array({js::S(symbol)}));
        const OJson* all = cfg_.get(u"spotInfo"_s);
        const OJson* v = all ? all->get(symbol) : nullptr;
        if (!v || v->type == OJson::Null) return std::nullopt;
        return *v;
    }
    std::shared_ptr<IbSession> marketSession() override {
        w_->rec(u"router"_s, u"marketSession"_s, js::array());
        const OJson* m = cfg_.get(u"marketSession"_s);
        if (m && m->get(u"error"_s)) throw BrokerError(m->get(u"error"_s)->s);
        QStringList accounts;
        if (m && m->get(u"accounts"_s))
            for (const OJson& a : m->get(u"accounts"_s)->items) accounts.append(a.s);
        OJson sc = js::object({{u"name"_s, js::S(u"market"_s)}, {u"accounts"_s, js::strings(accounts)}});
        return std::make_shared<FakeSession>(w_, sc);
    }
    Task<QList<OJson>> positions() override {
        const OJson r = co_await ask(u"positions"_s, QString(), js::array());
        co_return r.get(u"value"_s)->items;
    }
    Task<OJson> streamQuotes(QStringList symbols) override {
        const OJson r = co_await ask(u"streamQuotes"_s, symbols.join(u','), js::array({js::strings(symbols)}));
        co_return *r.get(u"value"_s);
    }
    Task<OJson> stockQuotes(QStringList symbols) override {
        const OJson r = co_await ask(u"stockQuotes"_s, symbols.join(u','), js::array({js::strings(symbols)}));
        co_return *r.get(u"value"_s);
    }
    Task<std::optional<double>> indexPrice(QString symbol) override {
        const OJson r = co_await ask(u"indexPrice"_s, symbol, js::array({js::S(symbol)}));
        const OJson* v = r.get(u"value"_s);
        if (v->type == OJson::Null) co_return std::nullopt;
        co_return v->n;
    }
    Task<OJson> optionChain(QString symbol, std::optional<QString> expiry, double width, std::optional<double> span, QString preferClass) override {
        const OJson r = co_await ask(u"optionChain"_s, symbol,
                                     js::array({js::S(symbol), expiry ? js::S(*expiry) : js::Null(), js::N(width), js::NOrNull(span), js::S(preferClass)}));
        co_return *r.get(u"value"_s);
    }
    Task<QList<OJson>> historicalBars(QString symbol, QString start, QString end) override {
        const OJson r = co_await ask(u"historicalBars"_s, symbol, js::array({js::S(symbol), js::S(start), js::S(end)}));
        co_return r.get(u"value"_s)->items;
    }
    Task<TaggedBars> intradayBars(QString symbol, QString timeframe, bool rth, std::optional<QString> endDay, bool indexProxy) override {
        const OJson r = co_await ask(u"intradayBars"_s, symbol + u'|' + timeframe,
                                     js::array({js::S(symbol), js::S(timeframe), js::B(rth), endDay ? js::S(*endDay) : js::Null(), js::B(indexProxy)}));
        const OJson& v = *r.get(u"value"_s);
        TaggedBars out;
        for (const OJson& b : v.get(u"bars"_s)->items) {
            SessionBar sb;
            sb.time = str(b, u"time"_s);
            sb.open = num(b, u"open"_s);
            sb.high = num(b, u"high"_s);
            sb.low = num(b, u"low"_s);
            sb.close = num(b, u"close"_s);
            sb.volume = num(b, u"volume"_s);
            out.bars.push_back(sb);
        }
        if (const OJson* f = v.get(u"feed"_s)) out.feed = f->s == u"live" ? BarsFeed::Live : f->s == u"delayed" ? BarsFeed::Delayed : BarsFeed::Unknown;
        co_return out;
    }

private:
    Task<OJson> ask(const QString& name, const QString& argKey, OJson args) {
        w_->rec(u"router"_s, name, std::move(args));
        const OJson* results = cfg_.get(u"results"_s);
        const OJson empty = js::object();
        const OJson& res = results ? *results : empty;
        const QString key = res.get(name + u':' + argKey) ? name + u':' + argKey : name;
        const OJson dflt = js::array({js::object({{u"unscripted"_s, js::B(true)}})});
        const OJson r = pickResult(res, counters_, key, dflt);
        if (flag(r, u"unscripted"_s)) throw ibkr::util::JsError(u"svc_world: %1 未脚本"_s.arg(name));
        if (flag(r, u"hang"_s)) co_await ibkr::util::Deferred<>().task();
        if (num(r, u"delay"_s) > 0) co_await w_->sleep(num(r, u"delay"_s));
        co_await w_->tick();
        if (const OJson* e = r.get(u"error"_s)) {
            if (str(r, u"kind"_s) == u"plain") throw ibkr::util::JsError(e->s);
            throw BrokerError(e->s);
        }
        co_return r;
    }
    World* w_;
    OJson cfg_;
    QHash<QString, int> counters_;
};

/// 脚本驱动的假盘口读取(对应 svc_world.mjs 的 makeMarks)
class ScriptedMarks : public MarksPort {
public:
    ScriptedMarks(World* w, const OJson& script) : w_(w), script_(script) {}
    Task<std::vector<ibkr::execution::OptionMark>> read(std::shared_ptr<IbSession> session, std::vector<ibkr::execution::OptionLegSpec> legs, bool delayedOk, double silentLimitMs) override {
        OJson legsJson = js::array();
        for (const auto& l : legs)
            legsJson.items.append(js::object({{u"symbol"_s, js::S(l.symbol)}, {u"expiry"_s, js::S(l.expiry)}, {u"strike"_s, js::N(l.strike)}, {u"right"_s, js::S(l.right)},
                                              {u"exchange"_s, js::S(l.exchange)}, {u"tradingClass"_s, js::S(l.tradingClass)}}));
        w_->rec(u"marks"_s, u"read"_s, js::array({js::strings(session->managedAccounts()), legsJson, js::B(delayedOk), js::N(silentLimitMs)}));
        const OJson dflt = js::array({js::object()});
        const OJson r = pickResult(script_, counters_, u"marks"_s, dflt);
        if (flag(r, u"hang"_s)) co_await ibkr::util::Deferred<>().task();
        if (num(r, u"delay"_s) > 0) co_await w_->sleep(num(r, u"delay"_s));
        co_await w_->tick();
        if (const OJson* e = r.get(u"error"_s)) {
            if (str(r, u"kind"_s) == u"plain") throw ibkr::util::JsError(e->s);
            throw ibkr::execution::OptionMarksError(e->s);
        }
        std::vector<ibkr::execution::OptionMark> out;
        for (const auto& l : legs) {
            const OJson* byLeg = r.get(u"byLeg"_s);
            const OJson* q = byLeg ? byLeg->get(ibkr::util::jsNumberToString(l.strike) + l.right) : nullptr;
            if (!q) q = r.get(u"dflt"_s);
            ibkr::execution::OptionMark m;
            m.strike = l.strike;
            m.right = l.right;
            if (q) {
                for (auto [name, dst] : {std::pair{u"bid"_s, &m.bid}, std::pair{u"ask"_s, &m.ask}, std::pair{u"iv"_s, &m.iv}}) {
                    const OJson* v = q->get(name);
                    if (v && v->type == OJson::Number) *dst = v->n;
                }
                if (const OJson* e = q->get(u"error"_s)) m.error = e->s;
            }
            out.push_back(m);
        }
        co_return out;
    }

private:
    World* w_;
    OJson script_;
    QHash<QString, int> counters_;
};

class RecordingNotifier : public NotifierPort {
public:
    explicit RecordingNotifier(World* w) : w_(w) {}
    void notify(const QString& title, const QString& body, const QString& subtitle) override {
        OJson a = js::array({js::S(title), js::S(body)});
        if (!subtitle.isEmpty()) a.items.append(js::S(subtitle));
        w_->rec(u"notifier"_s, u"notify"_s, a);
    }
    void warning(const QString& message) override { w_->rec(u"notifier"_s, u"warning"_s, js::array({js::S(message)})); }

private:
    World* w_;
};

class RecordingEngine : public SvcEngine {
public:
    RecordingEngine(World* w, ibkr::domain::TradeStore* store, int listeners) : w_(w), store_(store), notifier_(w), listeners_(listeners) {}
    ibkr::domain::TradeStore& store() override { return *store_; }
    NotifierPort& notifier() override { return notifier_; }
    void reconcileSoon() override { w_->rec(u"engine"_s, u"reconcileSoon"_s, js::array()); }
    int attachListeners() override {
        w_->rec(u"engine"_s, u"attachListeners"_s, js::array());
        return listeners_;
    }

private:
    World* w_;
    ibkr::domain::TradeStore* store_;
    RecordingNotifier notifier_;
    int listeners_;
};

/// 宿主:settings / router 可换,engine 是库 + 记录通知的假引擎
class Host : public BrokerLinkHost {
public:
    Host(World* w, ibkr::domain::Settings settings, ibkr::domain::TradeStore* store, int listeners)
        : w_(w), settings_(std::move(settings)), engine_(w, store, listeners) {}

    const ibkr::domain::Settings& settings() const override { return settings_; }
    void setSettings(ibkr::domain::Settings s) { settings_ = std::move(s); }
    std::shared_ptr<Router> router() const override { return nullptr; }
    TradingEngine& engine() override { qFatal("svc2 的 service 只用 svcEngine()"); }
    void emitEvent(const QString& event, const OJson& payload) override { w_->rec(u"host"_s, u"emit"_s, js::array({js::S(event), payload})); }
    std::shared_ptr<BrokerRouter> broker() const override { return router_; }
    void setBroker(std::shared_ptr<BrokerRouter> r) override { router_ = std::move(r); }
    void dropEngine() override { w_->rec(u"host"_s, u"dropEngine"_s, js::array()); }
    SvcEngine& svcEngine() override {
        if (w_->trackEngine) w_->rec(u"host"_s, u"engine"_s, js::array());
        return engine_;
    }
    SvcRuntime& runtime() override { return *w_; }
    std::shared_ptr<RouterPort> routerPort() const override { return port_; }
    void setPort(std::shared_ptr<RouterPort> p) { port_ = std::move(p); }

private:
    World* w_;
    ibkr::domain::Settings settings_;
    std::shared_ptr<BrokerRouter> router_;
    std::shared_ptr<RouterPort> port_;
    RecordingEngine engine_;
};

/// 脚本里 {op:"store", m, a} 在库上调的方法(JS 一半是 store[m](...a),m 可以带点:"imports.rememberOptionPositions")。这里列出用到的那些
inline OJson defaultStoreOp(ibkr::domain::TradeStore& store, const QString& m, const OJson& a) {
    const auto at = [&a](int i) -> const OJson& { return a.items[i]; };
    const auto rowsOf = [](const OJson& v) { return QList<OJson>(v.items); };
    if (m == u"rememberFills") return js::N(store.rememberFills(rowsOf(at(0))));
    if (m == u"audit") {
        const OJson* detail = a.items.size() > 2 ? &a.items[2] : nullptr;
        store.audit(at(0).s, at(1).s, detail);
        return js::Null();
    }
    if (m == u"setPref") {
        store.setPref(at(0).s, &at(1));
        return js::Null();
    }
    if (m == u"getPref") return store.getPref(at(0).s);
    if (m == u"$updateWatch" || m == u"$updateQualityStock") {
        const QString symbol = at(0).items[0].s;
        const OJson fields = at(0).items[1];
        const bool watch = m == u"$updateWatch";
        for (const OJson& r : watch ? store.listWatches() : store.listQualityStocks())
            if (str(r, u"symbol"_s) == symbol) return js::B(watch ? store.updateWatch(str(r, u"id"_s), fields) : store.updateQualityStock(str(r, u"id"_s), fields));
        qFatal("svc_world: 没有这只 %s", qPrintable(symbol));
    }
    if (m == u"messages.add") return js::B(store.messages().add(at(0)));
    if (m == u"signals.log") {
        store.signalLog().log(rowsOf(at(0)));
        return js::Null();
    }
    if (m == u"follow.add") return js::B(store.follow().add(at(0)));
    if (m == u"addWatch") return store.addWatch(at(0).s, at(1).n, a.items.size() > 2 ? a.items[2].s : QString());
    if (m == u"addQualityStock") return store.addQualityStock(at(0).s, a.items.size() > 1 ? &a.items[1] : nullptr);
    if (m == u"addTrack") return store.addTrack(at(0));
    if (m == u"addSector") return store.addSector(at(0).s);
    if (m == u"setSectorStocks") return js::B(store.setSectorStocks(at(0).s, at(1)));
    if (m == u"addIdea") {
        std::optional<QStringList> syms;
        if (a.items.size() > 1 && a.items[1].type == OJson::Array) {
            QStringList l;
            for (const OJson& x : a.items[1].items) l.append(x.s);
            syms = l;
        }
        return store.addIdea(at(0).s, syms);
    }
    if (m == u"createRecord") {
        OJson rec = at(0);
        return js::S(store.createRecord(rec));
    }
    if (m == u"appendEvent") {
        store.appendEvent(at(0).s, at(1).s, at(2));
        return js::Null();
    }
    if (m == u"imports.rememberOptionTrades") return js::N(store.imports().rememberOptionTrades(rowsOf(at(0))));
    if (m == u"imports.rememberOptionPositions") return js::N(store.imports().rememberOptionPositions(rowsOf(at(0))));
    if (m == u"imports.rememberEntryUnderlying") {
        store.imports().rememberEntryUnderlying(at(0).s, at(1).s, at(2).s, at(3).n, at(4).s);
        return js::Null();
    }
    if (m == u"imports.entryUnderlyings") {
        QStringList ids;
        for (const OJson& x : at(0).items) ids.append(x.s);
        OJson out = js::array();
        for (const auto& [k, v] : store.imports().entryUnderlyings(ids)) out.items.append(js::array({js::S(k), js::N(v)}));
        return out;
    }
    qFatal("svc_world: 脚本里不认识的库方法 %s", qPrintable(m));
}

/// 一个 service 在脚本里被怎么驱动
struct Svc {
    std::map<QString, std::function<Task<OJson>(OJson a)>> methods;
    std::map<QString, std::function<void(const OJson& step, OJson& rec)>> ops;
    std::map<QString, std::function<OJson(const OJson& a)>> gets;
    /// store 步:脚本里 {op:"store", m, a} 在库上调的方法
    std::function<OJson(const QString& m, const OJson& a)> storeOp;
    std::function<void()> stop;
};

inline OJson errInfo(const std::exception_ptr& e) {
    OJson o = js::object();
    o.set(u"error"_s, js::S(errMessage(e)));
    QString cls = u"Error"_s;
    try {
        std::rethrow_exception(e);
    } catch (const BrokerError&) {
        cls = u"BrokerError"_s;
    } catch (const ibkr::util::RpcError& r) {
        cls = u"RpcError"_s;
        o.set(u"cls"_s, js::S(cls));
        o.set(u"code"_s, js::N(r.code()));
        return o;
    } catch (...) {
    }
    o.set(u"cls"_s, js::S(cls));
    return o;
}

class Runner {
public:
    using Build = std::function<Svc(World&, Host&, const OJson& script, Runner& runner)>;

    Runner(const OJson& script, const OJson& base, Build build) : world(script), script_(script), base_(base), build_(std::move(build)) {
        dump_ = script.get(u"dump"_s) ? [&] {
            QStringList l;
            for (const OJson& x : script.get(u"dump"_s)->items) l.append(x.s);
            return l;
        }() : QStringList{u"audit_log"_s, u"broker_fills"_s, u"app_prefs"_s};
        if (const OJson* ss = script.get(u"sessions"_s)) {
            for (const OJson& cfg : ss->items) {
                auto s = std::make_shared<FakeSession>(&world, cfg);
                world.sessionOrder.append(s->name);
                world.sessions.insert(s->name, s);
            }
        }
    }

    World world;
    QTemporaryDir dir;

    ibkr::domain::Settings makeSettings(const OJson& patch = OJson()) {
        OJson raw = ibkr::domain::deepMerge(base_, script_.get(u"settings"_s) ? *script_.get(u"settings"_s) : js::object());
        if (patch.type == OJson::Object) raw = ibkr::domain::deepMerge(raw, patch);
        raw.set(u"storage"_s, js::object({{u"db_path"_s, js::S(dir.path() + u"/trades.db"_s)}}));
        return ibkr::domain::fromDict(raw);
    }

    /// 给真的 BrokerRouter 用的会话工厂
    IbSessionFactory makeFactory(const ibkr::domain::Settings& settings) {
        QHash<int, QString> portToConn;
        for (const QString& c : settings.connections.keys()) portToConn.insert(static_cast<int>(settings.connections.find(c)->port), c);
        return [this, portToConn](SessionConfig cfg) {
            ibkr::util::Deferred<std::shared_ptr<IbSession>> d;
            const QString conn = portToConn.value(cfg.port);
            world.rec(QString(), u"factory"_s,
                      js::array({js::object({{u"host"_s, js::S(cfg.host)}, {u"port"_s, js::N(cfg.port)}, {u"clientId"_s, js::N(cfg.clientId)}, {u"readonly"_s, js::B(cfg.readonly)}})}));
            const OJson* fac = script_.get(u"factory"_s);
            const OJson* list = fac ? fac->get(conn) : nullptr;
            const int i = world.factoryIdx.value(conn, 0);
            world.factoryIdx.insert(conn, i + 1);
            if (!list || i >= list->items.size()) {
                world.tick().onDone([d]() mutable { d.reject(ibkr::util::JsError(u"connect ECONNREFUSED"_s)); });
                return d.task();
            }
            const OJson& item = list->items[i];
            if (item.type == OJson::Object) {
                const QString message = str(item, u"error"_s);
                const double delay = num(item, u"delay"_s);
                if (delay > 0) world.sleep(delay).onDone([this, d, message]() mutable { world.tick().onDone([d, message]() mutable { d.reject(ibkr::util::JsError(message)); }); });
                else world.tick().onDone([d, message]() mutable { d.reject(ibkr::util::JsError(message)); });
            } else {
                auto s = world.sessions.value(item.s);
                if (!s) qFatal("脚本写错:没有会话 %s", qPrintable(item.s));
                s->connected = true;
                s->closed = false;
                world.tick().onDone([d, s]() mutable { d.resolve(std::shared_ptr<IbSession>(s)); });
            }
            return d.task();
        };
    }

    /// 脚本驱动的取数器(对应 svc_world.mjs 的 makeFetcher)
    ibkr::analysis::macro::Fetcher makeFetcher() {
        auto counters = std::make_shared<QHash<QString, int>>();
        return [this, counters](const QString& url, double timeoutMs) { return fetchOnce(url, timeoutMs, counters); };
    }

    QMap<QString, QString> dumpFiles(const QStringList& dirs) {
        QMap<QString, QString> out;
        for (const QString& d : dirs) {
            QDir qd(dir.path() + u'/' + d);
            if (!qd.exists()) continue;
            for (const QString& f : qd.entryList(QDir::Files, QDir::Name)) {
                QFile file(qd.filePath(f));
                if (file.open(QIODevice::ReadOnly)) out.insert(d + u'/' + f, QString::fromUtf8(file.readAll()));
            }
        }
        return out;
    }

    OJson dumpTables(ibkr::domain::TradeStore& store) {
        OJson out = js::object();
        for (const QString& t : dump_) {
            auto st = store.db().prepare(u"SELECT * FROM \"%1\" ORDER BY rowid"_s.arg(t));
            OJson rows = js::array();
            for (const auto& row : st.allRows()) {
                OJson r = js::array();
                for (const auto& c : row.cells) {
                    if (const auto* blob = std::get_if<QByteArray>(&c)) r.items.append(js::object({{u"blob"_s, js::S(QString::fromLatin1(blob->toHex()))}}));
                    else r.items.append(ibkr::util::sqlite::cellJson(c));
                }
                rows.items.append(std::move(r));
            }
            out.set(t, std::move(rows));
        }
        return out;
    }

    OJson run() {
        const bool track = flag(script_, u"trackEngine"_s);
        world.trackEngine = false;
        ibkr::domain::Settings settings = makeSettings();
        ibkr::domain::TradeStore store(settings.db_path);
        Host host(&world, std::move(settings), &store, int(num(script_, u"listeners"_s, 1)));
        host_ = &host;
        Svc svc = build_(world, host, script_, *this);
        world.trackEngine = track;  // 建 service 时不记引擎访问(TS 的 build 也不记:trackEngine 在 World 构造后才由脚本打开)
        struct Started {
            Task<OJson> task;
            bool reported = false;
        };
        std::map<QString, Started> started;
        OJson steps = js::array();
        OJson prev = dumpTables(store);
        QStringList fileDirs;
        if (const OJson* fd = script_.get(u"files"_s))
            for (const OJson& x : fd->items) fileDirs.append(x.s);
        QMap<QString, QString> prevFiles = dumpFiles(fileDirs);
        for (const OJson& step : script_.get(u"steps"_s)->items) {
            const QString op = str(step, u"op"_s);
            OJson rec = js::object();
            rec.set(u"op"_s, js::S(op));
            if (op == u"advance") {
                world.advance(num(step, u"ms"_s));
            } else if (op == u"sess") {
                auto s = world.sessions.value(str(step, u"session"_s));
                const OJson set = *step.get(u"set"_s);
                for (const auto& [k, v] : set.fields) {
                    s->cfg().set(k, v);
                    s->counters.remove(k);
                    if (k == u"connected") s->connected = v.b;
                }
            } else if (op == u"emitLink") {
                auto s = world.sessions.value(str(step, u"session"_s));
                if (!s->closed) {
                    const auto cbs = s->linkCbs;
                    for (const auto& cb : cbs) cb(flag(step, u"up"_s));
                }
            } else if (op == u"settings") {
                host.setSettings(makeSettings(*step.get(u"patch"_s)));
            } else if (op == u"port") {
                if (str(step, u"v"_s) == u"make") {
                    scripted_ = std::make_shared<ScriptedRouter>(&world, script_.get(u"router"_s) ? *script_.get(u"router"_s) : js::object());
                    host.setPort(scripted_);
                } else {
                    scripted_.reset();
                    host.setPort(nullptr);
                }
            } else if (op == u"portSet") {
                if (scripted_)
                    for (const auto& [k, v] : step.get(u"set"_s)->fields) {
                    if (k == u"results") {
                        if (!scripted_->cfg().get(u"results"_s)) scripted_->cfg().set(u"results"_s, js::object());
                        OJson* res = scripted_->cfg().get(u"results"_s);
                        for (const auto& [rk, rv] : v.fields) {
                            res->set(rk, rv);
                            scripted_->resetCounter(rk);
                        }
                    } else if (k == u"sessions") {
                        scripted_->n = int(v.n);
                    } else {
                        scripted_->cfg().set(k, v);
                    }
                }
            } else if (op == u"file") {
                const QString path = dir.path() + u'/' + str(step, u"path"_s);
                QDir().mkpath(QFileInfo(path).path());
                QFile f(path);
                if (f.open(QIODevice::WriteOnly | QIODevice::Truncate)) f.write(str(step, u"content"_s).toUtf8());
            } else if (op == u"store") {
                OJson v;
                try {
                    const OJson args = step.get(u"a"_s) ? *step.get(u"a"_s) : js::array();
                    v = svc.storeOp ? svc.storeOp(str(step, u"m"_s), args) : defaultStoreOp(store, str(step, u"m"_s), args);
                } catch (...) {
                    v = errInfo(std::current_exception());
                }
                rec.set(u"value"_s, v);
            } else if (op == u"call") {
                const QString m = str(step, u"m"_s);
                const auto it = svc.methods.find(m);
                if (it == svc.methods.end()) qFatal("脚本里不认识的方法 %s", qPrintable(m));
                started.emplace(str(step, u"id"_s), Started{it->second(step.get(u"a"_s) ? *step.get(u"a"_s) : js::object()), false});
            } else if (op == u"get") {
                const auto it = svc.gets.find(str(step, u"what"_s));
                if (it == svc.gets.end()) qFatal("脚本里不认识的读取 %s", qPrintable(str(step, u"what"_s)));
                rec.set(u"value"_s, it->second(step.get(u"a"_s) ? *step.get(u"a"_s) : js::object()));
            } else {
                const auto it = svc.ops.find(op);
                if (it == svc.ops.end()) qFatal("脚本里不认识的步 %s", qPrintable(op));
                it->second(step, rec);
            }
            world.drain();
            OJson done = js::array();
            for (auto& [id, st] : started) {  // std::map 按 key 排序 = JS 的 sort 比较 a[0] < b[0]
                if (st.task.done() && !st.reported) {
                    st.reported = true;
                    OJson r = js::object();
                    r.set(u"id"_s, js::S(id));
                    if (st.task.error()) {
                        r.set(u"result"_s, errInfo(st.task.error()));
                    } else {
                        r.set(u"result"_s, js::object({{u"ok"_s, st.task.result()}}));
                    }
                    done.items.append(std::move(r));
                }
            }
            if (!done.items.isEmpty()) rec.set(u"done"_s, done);
            const OJson now = dumpTables(store);
            OJson changed = js::object();
            for (const QString& t : dump_) {
                if (js::stringify(*now.get(t)) != js::stringify(*prev.get(t))) changed.set(t, *now.get(t));
            }
            if (!changed.fields.isEmpty()) rec.set(u"store"_s, changed);
            prev = now;
            const QMap<QString, QString> nowFiles = dumpFiles(fileDirs);
            OJson changedFiles = js::object();
            for (auto it = nowFiles.cbegin(); it != nowFiles.cend(); ++it)
                if (prevFiles.value(it.key(), QString()) != it.value() || !prevFiles.contains(it.key())) changedFiles.set(it.key(), js::S(it.value()));
            if (!changedFiles.fields.isEmpty()) rec.set(u"files"_s, changedFiles);
            prevFiles = nowFiles;
            rec.set(u"T"_s, js::N(world.T));
            steps.items.append(std::move(rec));
        }
        if (svc.stop) svc.stop();
        host_ = nullptr;
        // 临时目录的随机名不进对拍
        OJson logOut = world.log;
        if (flag(script_, u"sortLog"_s)) {
            std::stable_sort(logOut.items.begin(), logOut.items.end(), [](const OJson& a, const OJson& b) {
                const double ta = num(a, u"t"_s), tb = num(b, u"t"_s);
                if (ta != tb) return ta < tb;
                return js::stringify(a) < js::stringify(b);
            });
        }
        QString text = js::stringify(js::object({{u"log"_s, logOut}, {u"steps"_s, steps}}));
        text.replace(js::stringify(js::S(dir.path())).mid(1).chopped(1), u"<DIR>"_s);
        return *js::parse(text);
    }

    Host* host_ = nullptr;

private:
    Task<OJson> fetchOnce(QString url, double timeoutMs, std::shared_ptr<QHash<QString, int>> counters) {
        world.rec(u"fetch"_s, u"get"_s, js::array({js::S(url), js::N(timeoutMs)}));
        const QString key = url.contains(u"faireconomy") ? u"feed"_s : url.contains(u"cboe") ? u"cboe"_s : url.contains(u"yahoo") ? u"yahoo"_s : u"other"_s;
        const OJson* fetch = script_.get(u"fetch"_s);
        const OJson empty = js::object();
        const OJson dflt = js::array({js::object({{u"error"_s, js::S(u"no route to host"_s)}})});
        const OJson r = pickResult(fetch ? *fetch : empty, *counters, key, dflt);
        if (flag(r, u"hang"_s)) co_await ibkr::util::Deferred<>().task();
        if (num(r, u"delay"_s) > 0) co_await world.sleep(num(r, u"delay"_s));
        co_await world.tick();
        if (const OJson* e = r.get(u"error"_s)) throw ibkr::util::JsError(e->s);
        const OJson* v = r.get(u"value"_s);
        co_return v ? *v : js::Null();
    }

    std::shared_ptr<ScriptedRouter> scripted_;
    OJson script_, base_;
    Build build_;
    QStringList dump_;
};

}  // namespace svcw
