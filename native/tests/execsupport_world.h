// execsupport 簇对拍用的"世界"的 C++ 一半:脚本驱动的假 IbSession、虚拟的钟、按时刻排的事件表。
// 与 tests/fixtures/execsupport_world.mjs 一句对一句——脚本格式在那个文件的开头写着;改任何一边都要同时改另一边。
// 夹具里每个场景带着脚本与期望(会话上每一次调用的日志、各步的结果),这里读同一份脚本,把日志与结果按同样的形状交回去。
#pragma once

#include "execution/ib_link.h"
#include "execution/ib_session.h"
#include "execution/ib_types.h"
#include "execution/qualify_gate.h"
#include "js_fixture.h"
#include "util/js_runtime.h"
#include "util/jsobj.h"
#include "util/task.h"

#include <QHash>

#include <cmath>
#include <functional>
#include <memory>
#include <vector>

namespace execw {

using ibkr::util::OJson;
using namespace ibkr::execution;
namespace js = ibkr::util::js;
using ibkr::util::Task;
using Qt::StringLiterals::operator""_s;

inline const OJson* field(const OJson& o, const QString& k) { return o.get(k); }
inline QString str(const OJson& o, const QString& k, const QString& fallback = {}) {
    const OJson* v = o.get(k);
    return v && v->type == OJson::String ? v->s : fallback;
}
inline double num(const OJson& o, const QString& k, double fallback = 0) {
    const OJson* v = o.get(k);
    return v && v->type == OJson::Number ? v->n : fallback;
}
inline bool flag(const OJson& o, const QString& k, bool fallback = false) {
    const OJson* v = o.get(k);
    return v && v->type == OJson::Bool ? v->b : fallback;
}

/// 合约在日志里的样子:只留有值的键,键序固定
inline OJson normContract(const IbContract& c) {
    OJson o = js::object();
    o.set(u"secType"_s, js::S(c.secType));
    o.set(u"symbol"_s, js::S(c.symbol));
    o.set(u"exchange"_s, js::S(c.exchange));
    o.set(u"currency"_s, js::S(c.currency));
    if (c.lastTradeDateOrContractMonth) o.set(u"lastTradeDateOrContractMonth"_s, js::S(*c.lastTradeDateOrContractMonth));
    if (c.strike) o.set(u"strike"_s, js::N(*c.strike));
    if (c.right) o.set(u"right"_s, js::S(*c.right));
    if (c.multiplier) o.set(u"multiplier"_s, js::S(*c.multiplier));
    if (c.tradingClass) o.set(u"tradingClass"_s, js::S(*c.tradingClass));
    if (c.conId) o.set(u"conId"_s, js::N(*c.conId));
    return o;
}

/// 夹具里的合约(同 normContract 的样子)→ IbContract
inline IbContract contractFrom(const OJson& j) {
    IbContract c;
    c.secType = str(j, u"secType"_s);
    c.symbol = str(j, u"symbol"_s);
    c.exchange = str(j, u"exchange"_s);
    c.currency = str(j, u"currency"_s);
    if (const OJson* v = j.get(u"lastTradeDateOrContractMonth"_s)) c.lastTradeDateOrContractMonth = v->s;
    if (const OJson* v = j.get(u"strike"_s)) c.strike = v->n;
    if (const OJson* v = j.get(u"right"_s)) c.right = v->s;
    if (const OJson* v = j.get(u"multiplier"_s)) c.multiplier = v->s;
    if (const OJson* v = j.get(u"tradingClass"_s)) c.tradingClass = v->s;
    if (const OJson* v = j.get(u"conId"_s)) c.conId = static_cast<int>(v->n);
    return c;
}

inline void mergePatch(TickerData& d, const OJson& patchRaw) {
    const OJson patch = jsfix::dec(patchRaw);
    for (const auto& [k, v] : patch.fields) {
        if (k == u"bid") d.bid = v.n;
        else if (k == u"ask") d.ask = v.n;
        else if (k == u"last") d.last = v.type == OJson::Null ? std::nullopt : std::optional<double>(v.n);
        else if (k == u"quotedAt") d.quotedAt = v.type == OJson::Null ? std::nullopt : std::optional<double>(v.n);
        else if (k == u"requestedAt") d.requestedAt = v.type == OJson::Null ? std::nullopt : std::optional<double>(v.n);
        else if (k == u"error") d.error = v.type == OJson::Null ? std::nullopt : std::optional<QString>(v.s);
        else if (k == u"iv") {
            if (v.type == OJson::Null) d.modelGreeks = std::nullopt;
            else {
                ModelGreeks g;
                g.impliedVol = v.n;
                d.modelGreeks = g;
            }
        } else qFatal("脚本里不认识的盘口字段 %s", qPrintable(k));
    }
}

inline bool hasErr(const TickerData& d) { return d.error && !d.error->isEmpty(); }

class FakeSession;

class World {
public:
    struct Timer {
        double at = 0;
        qint64 seq = 0;
        std::function<void()> fn;
        bool resolveKind = false;
        double period = 0;
    };

    explicit World(const OJson& scenario);
    ~World() {
        ibkr::util::setDateNowForTests({});
        setLogSinkForTests({});
    }
    World(const World&) = delete;
    World& operator=(const World&) = delete;

    double T = 0;
    OJson log = js::array();
    std::vector<std::shared_ptr<Timer>> timers;
    qint64 counter = 0;
    int handleSeq = 0;
    QStringList sessionOrder;
    QHash<QString, std::shared_ptr<FakeSession>> sessions;

    std::shared_ptr<FakeSession> session(const QString& name) const { return sessions.value(name); }

    void rec(const QString& session, const QString& method, OJson args) {
        OJson e = js::object();
        e.set(u"t"_s, js::N(T));
        e.set(u"s"_s, session.isNull() ? js::Null() : js::S(session));
        e.set(u"m"_s, js::S(method));
        e.set(u"a"_s, std::move(args));
        log.items.append(std::move(e));
    }

    std::shared_ptr<Timer> schedule(double delay, std::function<void()> fn, bool resolveKind = false, double period = 0) {
        auto t = std::make_shared<Timer>();
        t->at = T + delay;
        t->seq = counter++;
        t->fn = std::move(fn);
        t->resolveKind = resolveKind;
        t->period = period;
        timers.push_back(t);
        return t;
    }
    std::shared_ptr<Timer> every(double period, std::function<void()> fn) { return schedule(period, std::move(fn), false, period); }
    void cancel(const std::shared_ptr<Timer>& t) {
        for (auto it = timers.begin(); it != timers.end(); ++it) {
            if (*it == t) {
                timers.erase(it);
                return;
            }
        }
    }
    Task<> sleep(double delay) {
        ibkr::util::Deferred<> d;
        schedule(delay, [d]() mutable { d.resolve(); }, true);
        return d.task();
    }

    void advance(double ms) {
        const double end = T + ms;
        std::vector<std::function<void()>> pending;
        for (;;) {
            std::shared_ptr<Timer> best;
            for (const auto& e : timers) {
                if (e->at > end) continue;
                if (!best || e->at < best->at || (e->at == best->at && e->seq < best->seq)) best = e;
            }
            if (!best) break;
            T = std::fmax(T, best->at);
            auto fn = best->fn;
            if (best->period > 0) {
                best->at += best->period;
                best->seq = counter++;
            } else {
                cancel(best);
            }
            if (best->resolveKind) pending.push_back(fn);
            else fn();
        }
        T = end;
        for (auto& f : pending) f();
    }

    void patchStream(const QString& sessionName, const QString& key, const OJson& patch);

    /// 各测试共用的步;不认识的回 false
    bool commonStep(const OJson& step);
};

class FakeSession : public IbSession {
public:
    struct Entry {
        TickerData data;
    };

    FakeSession(World* w, const OJson& cfg) : w_(w), cfg_(cfg) {
        name = str(cfg, u"name"_s);
        connected = flag(cfg, u"connected"_s, true);
        if (const OJson* caps = cfg.get(u"caps"_s)) {
            for (const OJson& c : caps->items) {
                if (c.s == u"AccountPnl") caps_.insert(Cap::AccountPnl);
                else if (c.s == u"NetLiquidation") caps_.insert(Cap::NetLiquidation);
                else if (c.s == u"QuoteDelayed") caps_.insert(Cap::QuoteDelayed);
                else if (c.s == u"OnLink") caps_.insert(Cap::OnLink);
                else qFatal("脚本里不认识的 caps %s", qPrintable(c.s));
            }
        }
    }

    QString name;
    bool connected = true;
    std::vector<std::function<void(int)>> connCbs;
    std::vector<std::function<void(bool)>> linkCbs;
    QHash<QString, std::shared_ptr<Entry>> streams;

    OJson& pnlCfg() {
        OJson* p = cfg_.get(u"pnl"_s);
        if (!p) {
            cfg_.set(u"pnl"_s, js::object());
            p = cfg_.get(u"pnl"_s);
        }
        return *p;
    }
    OJson& netLiqCfg() {
        OJson* p = cfg_.get(u"netLiq"_s);
        if (!p) {
            cfg_.set(u"netLiq"_s, js::object());
            p = cfg_.get(u"netLiq"_s);
        }
        return *p;
    }

    void applyPatch(const QString& key, const OJson& patch) {
        auto it = streams.find(key);
        if (it == streams.end()) return;
        const std::shared_ptr<Entry> entry = it.value();
        mergePatch(entry->data, patch);
        // 被拒的流(error 一出现)像真会话一样从缓存里摘掉;句柄仍读得到那条 error
        if (hasErr(entry->data)) streams.remove(key);
    }

    bool has(Cap c) const override { return caps_.contains(c); }
    bool isConnected() override {
        w_->rec(name, u"isConnected"_s, js::array());
        return connected;
    }
    QStringList managedAccounts() override {
        w_->rec(name, u"managedAccounts"_s, js::array());
        QStringList out;
        if (const OJson* a = cfg_.get(u"accounts"_s)) {
            for (const OJson& x : a->items) out.append(x.s);
        }
        return out;
    }
    void onConnectivity(std::function<void(int)> cb) override {
        w_->rec(name, u"onConnectivity"_s, js::array());
        connCbs.push_back(std::move(cb));
    }
    void onLink(std::function<void(bool)> cb) override {
        w_->rec(name, u"onLink"_s, js::array());
        linkCbs.push_back(std::move(cb));
    }
    void reqMarketDataType(int type) override { w_->rec(name, u"reqMarketDataType"_s, js::array({js::N(type)})); }

    std::optional<AccountPnl> accountPnl(const QString& id) override {
        w_->rec(name, u"accountPnl"_s, js::array({js::S(id)}));
        const OJson* v = pnlCfg().get(id);
        if (!v || v->type == OJson::Null) return std::nullopt;
        const OJson d = jsfix::dec(*v);
        AccountPnl p;
        if (const OJson* x = d.get(u"daily"_s); x && x->type == OJson::Number) p.daily = x->n;
        if (const OJson* x = d.get(u"unrealized"_s); x && x->type == OJson::Number) p.unrealized = x->n;
        if (const OJson* x = d.get(u"realized"_s); x && x->type == OJson::Number) p.realized = x->n;
        p.currency = str(d, u"currency"_s);
        p.atMs = num(d, u"atMs"_s);
        return p;
    }
    std::optional<NetLiquidation> netLiquidation(const QString& id) override {
        w_->rec(name, u"netLiquidation"_s, js::array({js::S(id)}));
        const OJson* v = netLiqCfg().get(id);
        if (!v || v->type == OJson::Null) return std::nullopt;
        const OJson d = jsfix::dec(*v);
        NetLiquidation n;
        n.amount = num(d, u"amount"_s);
        n.currency = str(d, u"currency"_s);
        return n;
    }
    std::optional<bool> quoteDelayed(const IbContract& c) override {
        w_->rec(name, u"quoteDelayed"_s, js::array({normContract(c)}));
        if (const OJson* m = cfg_.get(u"delayed"_s)) {
            if (const OJson* v = m->get(tickerKey(c)); v && v->type == OJson::Bool) return v->b;
        }
        return std::nullopt;
    }

    Task<> qualifyContracts(std::vector<IbContract*> contracts, int timeoutMs) override {
        OJson out = js::object({{u"kind"_s, js::S(u"ok"_s)}});
        if (const OJson* list = cfg_.get(u"qualify"_s); list && !list->items.isEmpty()) {
            out = list->items[std::min<qsizetype>(qIdx_, list->items.size() - 1)];
        }
        qIdx_ += 1;
        OJson cs = js::array();
        for (const IbContract* c : contracts) cs.items.append(normContract(*c));
        w_->rec(name, u"qualifyContracts"_s, js::array({cs, js::N(timeoutMs)}));
        const double delay = num(out, u"delay"_s);
        if (delay > 0) co_await w_->sleep(delay);
        const QString kind = str(out, u"kind"_s);
        w_->rec(name, u"qualifyDone"_s, js::array({js::S(kind)}));
        if (kind == u"ok") {
            const OJson* ids = out.get(u"conIds"_s);
            for (size_t i = 0; i < contracts.size(); ++i) {
                if (ids && static_cast<qsizetype>(i) < ids->items.size()) {
                    const OJson& v = ids->items[static_cast<qsizetype>(i)];
                    if (v.type != OJson::Null) contracts[i]->conId = static_cast<int>(v.n);  // null = 不写 conId
                } else {
                    contracts[i]->conId = 700000 + static_cast<int>(i);
                }
            }
            co_return;
        }
        if (kind == u"timeout") throw ibkr::util::JsError(u"timeout"_s);
        if (kind == u"timeoutName") throw TimeoutError(u"qualify slow"_s);
        throw ibkr::util::JsError(str(out, u"message"_s, u"qualify failed"_s));
    }

    std::shared_ptr<TickerHandle> subscribeTicker(const IbContract& contract, const QString& generic = {}) override {
        w_->rec(name, u"subscribeTicker"_s, js::array({normContract(contract), js::S(generic)}));
        const QString key = tickerKey(contract, generic);
        std::shared_ptr<Entry> entry = streams.value(key);
        if (!entry) {
            entry = std::make_shared<Entry>();
            entry->data.requestedAt = flag(cfg_, u"times"_s) ? std::optional<double>(w_->T) : std::nullopt;
            if (const OJson* init = cfg_.get(u"initial"_s)) {
                if (const OJson* patch = init->get(key)) mergePatch(entry->data, *patch);
            }
            if (!hasErr(entry->data)) streams.insert(key, entry);  // 订的那一刻就带着 error:不进缓存
        }
        return std::make_shared<Handle>(this, key, entry, ++w_->handleSeq);
    }

    void cancelTicker(const IbContract& contract, const std::optional<QString>& generic = std::nullopt) override {
        w_->rec(name, u"cancelTicker"_s, js::array({normContract(contract), js::S(generic ? *generic : u"*"_s)}));
        if (flag(cfg_, u"throwCancel"_s)) throw ibkr::util::JsError(u"cancel boom"_s);
        const QString base = tickerKey(contract);
        QStringList keys;
        if (generic) keys.append(tickerKey(contract, *generic));
        else {
            for (auto it = streams.cbegin(); it != streams.cend(); ++it) {
                if (it.key() == base || it.key().startsWith(base + u'#')) keys.append(it.key());
            }
        }
        for (const QString& k : keys) streams.remove(k);
    }

    Task<> settle(int ms) override {
        w_->rec(name, u"settle"_s, js::array({js::N(ms)}));
        w_->advance(ms);
        return Task<>::resolved();
    }

    Task<std::vector<RawBar>> historicalData(IbContract contract, HistoricalRequest opts) override {
        OJson o = js::object();
        o.set(u"endDateTime"_s, js::S(opts.endDateTime));
        o.set(u"durationStr"_s, js::S(opts.durationStr));
        o.set(u"barSizeSetting"_s, js::S(opts.barSizeSetting));
        o.set(u"whatToShow"_s, js::S(opts.whatToShow));
        o.set(u"useRTH"_s, js::B(opts.useRTH));
        w_->rec(name, u"historicalData"_s, js::array({normContract(contract), o}));
        const QString k = contract.symbol + u'|' + contract.exchange;
        OJson out = js::object({{u"error"_s, js::S(u"没有脚本:"_s + k)}});
        if (const OJson* h = cfg_.get(u"hist"_s)) {
            if (const OJson* list = h->get(k); list && !list->items.isEmpty()) {
                const int i = hIdx_.value(k, 0);
                hIdx_.insert(k, i + 1);
                out = list->items[std::min<qsizetype>(i, list->items.size() - 1)];
            }
        }
        const double delay = num(out, u"delay"_s);
        if (delay > 0) co_await w_->sleep(delay);
        if (const OJson* e = out.get(u"error"_s)) throw ibkr::util::JsError(e->s);
        std::vector<RawBar> bars;
        for (const OJson& braw : out.get(u"bars"_s)->items) {
            const OJson b = jsfix::dec(braw);
            RawBar r;
            r.date = str(b, u"date"_s);
            r.open = num(b, u"open"_s);
            r.high = num(b, u"high"_s);
            r.low = num(b, u"low"_s);
            r.close = num(b, u"close"_s);
            if (const OJson* v = b.get(u"volume"_s)) r.volume = v->n;
            bars.push_back(r);
        }
        co_return bars;
    }

    // ---- 这个簇用不到的:被调到就是测试写错了
    Task<> disconnect() override { qFatal("FakeSession::disconnect"); }
    Task<std::vector<OptChainParam>> secDefOptParams(QString, QString, int) override { qFatal("FakeSession::secDefOptParams"); }
    Task<Depth> mktDepth(IbContract, int, int) override { qFatal("FakeSession::mktDepth"); }
    Task<TradeLike> placeOrder(IbContract, OrderIntent) override { qFatal("FakeSession::placeOrder"); }
    Task<std::vector<OpenTrade>> openTrades() override { qFatal("FakeSession::openTrades"); }
    Task<> cancelOrder(int) override { qFatal("FakeSession::cancelOrder"); }
    Task<std::vector<PortfolioItemLike>> portfolio() override { qFatal("FakeSession::portfolio"); }
    Task<std::vector<PositionItemLike>> positions() override { qFatal("FakeSession::positions"); }

    class Handle : public TickerHandle {
    public:
        Handle(FakeSession* s, QString key, std::shared_ptr<Entry> e, int hid) : id(hid), s_(s), key_(std::move(key)), e_(std::move(e)) {}
        int id;
        TickerData read() override {
            if (s_->streams.value(key_) == e_ || hasErr(e_->data)) return e_->data;
            TickerData d;
            d.error = kTickerDetached;
            return d;
        }

    private:
        FakeSession* s_;
        QString key_;
        std::shared_ptr<Entry> e_;
    };

private:
    World* w_;
    OJson cfg_;
    QSet<Cap> caps_;
    qsizetype qIdx_ = 0;
    QHash<QString, int> hIdx_;
};

inline World::World(const OJson& scenario) {
    T = num(scenario, u"start"_s);
    ibkr::util::setDateNowForTests([this] { return T; });
    setLogSinkForTests([this](const QString& line) { rec(QString(), u"stderr"_s, js::array({js::S(line)})); });
    if (const OJson* ss = scenario.get(u"sessions"_s)) {
        for (const OJson& cfg : ss->items) {
            auto s = std::make_shared<FakeSession>(this, cfg);
            sessionOrder.append(s->name);
            sessions.insert(s->name, s);
        }
    }
    if (const OJson* es = scenario.get(u"events"_s)) {
        for (const OJson& e : es->items) {
            const QString sn = str(e, u"session"_s), key = str(e, u"key"_s);
            const OJson patch = *e.get(u"patch"_s);
            schedule(num(scenario, u"start"_s) + num(e, u"at"_s) - T, [this, sn, key, patch] { patchStream(sn, key, patch); });
        }
    }
}

inline void World::patchStream(const QString& sessionName, const QString& key, const OJson& patch) {
    if (auto s = sessions.value(sessionName)) s->applyPatch(key, patch);
}

inline bool World::commonStep(const OJson& step) {
    const QString op = str(step, u"op"_s);
    if (op == u"advance") advance(num(step, u"ms"_s));
    else if (op == u"connected") session(str(step, u"session"_s))->connected = flag(step, u"v"_s);
    else if (op == u"patch") patchStream(str(step, u"session"_s), str(step, u"key"_s), *step.get(u"patch"_s));
    else if (op == u"setPnl") session(str(step, u"session"_s))->pnlCfg().set(str(step, u"account"_s), *step.get(u"v"_s));
    else if (op == u"setNetLiq") session(str(step, u"session"_s))->netLiqCfg().set(str(step, u"account"_s), *step.get(u"v"_s));
    else if (op == u"emitConnectivity") {
        auto cbs = session(str(step, u"session"_s))->connCbs;
        for (auto& cb : cbs) cb(static_cast<int>(num(step, u"code"_s)));
    } else if (op == u"emitLink") {
        auto cbs = session(str(step, u"session"_s))->linkCbs;
        for (auto& cb : cbs) cb(flag(step, u"up"_s));
    } else return false;
    return true;
}


/// String(exc?.message ?? exc)
inline QString errMessage(const std::exception_ptr& e) {
    try {
        std::rethrow_exception(e);
    } catch (const ibkr::util::JsError& x) {
        return x.message();
    } catch (const std::exception& x) {
        return QString::fromStdString(x.what());
    } catch (...) {
        return {};
    }
}

/// 阻塞的步:让钟一次走一秒,直到这一路有结果(最多 70 秒;JS 那边 runToDone 是同一个循环)
template <class T>
void runToDone(World& w, const Task<T>& t) {
    for (int i = 0; i < 70; ++i) {
        if (t.done()) return;
        w.advance(1000);
    }
    if (!t.done()) qFatal("这一步卡住了:脚本写错");
}

/// {error: 话} / {ok: 值}
template <class T, class F>
OJson outcome(const Task<T>& t, F&& f) {
    if (t.error()) return js::object({{u"error"_s, js::S(errMessage(t.error()))}});
    if constexpr (std::is_void_v<T>) return js::object({{u"ok"_s, js::Null()}});
    else return js::object({{u"ok"_s, f(t.result())}});
}

}  // namespace execw
