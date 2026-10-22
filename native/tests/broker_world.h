// broker 簇对拍用的"世界"的 C++ 一半:脚本驱动的假 IbSession、虚拟的钟、按时刻排的计时器、假的会话工厂,以及跑一份脚本的 Runner。
// 与 tests/fixtures/broker_world.mjs 一句对一句——脚本格式与约定在那个文件的开头写着;改任何一边都要同时改另一边。
// 夹具里每个场景带着脚本与期望({log, steps, basisFile}),Runner 读同一份脚本、把日志与结果按同样的形状交回去。
#pragma once

#include "domain/config.h"
#include "execution/broker.h"
#include "execution/ib_link.h"
#include "execution/ib_session.h"
#include "execution/ib_types.h"
#include "execution/qualify_gate.h"
#include "js_fixture.h"
#include "util/js_runtime.h"
#include "util/jsobj.h"
#include "util/task.h"

#include <QDir>
#include <QFile>
#include <QHash>
#include <QTemporaryDir>

#include <cmath>
#include <functional>
#include <memory>
#include <vector>

namespace bw {

using ibkr::util::OJson;
using namespace ibkr::execution;
namespace js = ibkr::util::js;
using ibkr::util::Task;
using Qt::StringLiterals::operator""_s;

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
inline std::optional<double> optNumber(const OJson* v) { return !v || v->type == OJson::Null ? std::nullopt : std::optional<double>(v->n); }

/// 合约在日志里的样子:只留有值的键,键序固定(+ includeExpired / comboLegs)
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
    if (c.includeExpired) o.set(u"includeExpired"_s, js::B(true));
    if (c.hasComboLegs) {
        OJson legs = js::array();
        for (const ComboLeg& l : c.comboLegs) {
            legs.items.append(js::object({{u"conId"_s, js::N(l.conId)}, {u"ratio"_s, js::N(l.ratio)}, {u"action"_s, js::S(l.action)}, {u"exchange"_s, js::S(l.exchange)}}));
        }
        o.set(u"comboLegs"_s, legs);
    }
    return o;
}

/// 夹具里的合约(同 normContract 的样子)→ IbContract
inline IbContract contractFrom(const OJson& j) {
    IbContract c;
    c.secType = str(j, u"secType"_s);
    c.symbol = str(j, u"symbol"_s);
    c.exchange = str(j, u"exchange"_s);
    c.currency = str(j, u"currency"_s);
    if (const OJson* v = j.get(u"lastTradeDateOrContractMonth"_s); v && v->type == OJson::String) c.lastTradeDateOrContractMonth = v->s;
    if (const OJson* v = j.get(u"strike"_s); v && v->type == OJson::Number) c.strike = v->n;
    if (const OJson* v = j.get(u"right"_s); v && v->type == OJson::String) c.right = v->s;
    if (const OJson* v = j.get(u"multiplier"_s); v && v->type == OJson::String) c.multiplier = v->s;
    if (const OJson* v = j.get(u"tradingClass"_s); v && v->type == OJson::String) c.tradingClass = v->s;
    if (const OJson* v = j.get(u"conId"_s); v && v->type == OJson::Number) c.conId = static_cast<int>(v->n);
    c.includeExpired = flag(j, u"includeExpired"_s);
    if (const OJson* v = j.get(u"comboLegs"_s)) {
        c.hasComboLegs = true;
        for (const OJson& l : v->items) c.comboLegs.push_back({static_cast<int>(num(l, u"conId"_s)), num(l, u"ratio"_s), str(l, u"action"_s), str(l, u"exchange"_s)});
    }
    return c;
}

/// 订单意图在日志里的样子:固定键序,没有值的不写(价格三格写 null)
inline OJson canonOrder(const OrderIntent& o) {
    OJson j = js::object();
    j.set(u"orderType"_s, js::S(o.orderType));
    j.set(u"action"_s, js::S(o.action));
    j.set(u"totalQuantity"_s, js::N(o.totalQuantity));
    j.set(u"lmtPrice"_s, js::NOrNull(o.lmtPrice));
    j.set(u"auxPrice"_s, js::NOrNull(o.auxPrice));
    j.set(u"trailingPercent"_s, js::NOrNull(o.trailingPercent));
    j.set(u"tif"_s, js::S(o.tif));
    j.set(u"outsideRth"_s, js::B(o.outsideRth));
    j.set(u"account"_s, js::S(o.account));
    j.set(u"transmit"_s, js::B(o.transmit));
    if (o.orderRef) j.set(u"orderRef"_s, js::S(*o.orderRef));
    if (!o.conditions.empty()) {
        OJson cs = js::array();
        for (const OJson& c : o.conditions) {
            OJson co = js::object();
            for (const QString& k : {u"type"_s, u"conId"_s, u"exchange"_s, u"isMore"_s, u"price"_s}) {
                if (const OJson* v = c.get(k)) co.set(k, *v);
            }
            cs.items.append(co);
        }
        j.set(u"conditions"_s, cs);
    }
    if (o.conditionsCancelOrder) j.set(u"conditionsCancelOrder"_s, js::B(*o.conditionsCancelOrder));
    if (!o.ocaGroup.isEmpty()) j.set(u"ocaGroup"_s, js::S(o.ocaGroup));
    if (o.ocaType) j.set(u"ocaType"_s, js::N(*o.ocaType));
    if (o.trailStopPrice) j.set(u"trailStopPrice"_s, js::N(*o.trailStopPrice));
    if (o.orderId) j.set(u"orderId"_s, js::N(*o.orderId));
    return j;
}

inline bool hasErr(const TickerData& d) { return d.error && !d.error->isEmpty(); }

inline void mergePatch(TickerData& d, const OJson& patchRaw) {
    const OJson patch = jsfix::dec(patchRaw);
    const auto setOpt = [](std::optional<double>& slot, const OJson& v) { slot = v.type == OJson::Null ? std::nullopt : std::optional<double>(v.n); };
    for (const auto& [k, v] : patch.fields) {
        if (k == u"bid") d.bid = v.n;
        else if (k == u"ask") d.ask = v.n;
        else if (k == u"last") setOpt(d.last, v);
        else if (k == u"close") setOpt(d.close, v);
        else if (k == u"bidSize") setOpt(d.bidSize, v);
        else if (k == u"askSize") setOpt(d.askSize, v);
        else if (k == u"marketPrice") setOpt(d.marketPrice, v);
        else if (k == u"open") setOpt(d.open, v);
        else if (k == u"high") setOpt(d.high, v);
        else if (k == u"low") setOpt(d.low, v);
        else if (k == u"volume") setOpt(d.volume, v);
        else if (k == u"avgVolume") setOpt(d.avgVolume, v);
        else if (k == u"histVol") setOpt(d.histVol, v);
        else if (k == u"vol3m") setOpt(d.vol3m, v);
        else if (k == u"vol5m") setOpt(d.vol5m, v);
        else if (k == u"vol10m") setOpt(d.vol10m, v);
        else if (k == u"lastTradeAt") setOpt(d.lastTradeAt, v);
        else if (k == u"callOpenInterest") setOpt(d.callOpenInterest, v);
        else if (k == u"putOpenInterest") setOpt(d.putOpenInterest, v);
        else if (k == u"callVolume") setOpt(d.callVolume, v);
        else if (k == u"putVolume") setOpt(d.putVolume, v);
        else if (k == u"quotedAt") setOpt(d.quotedAt, v);
        else if (k == u"requestedAt") setOpt(d.requestedAt, v);
        else if (k == u"delayed") d.delayed = v.b;
        else if (k == u"error") d.error = v.type == OJson::Null ? std::nullopt : std::optional<QString>(v.s);
        else if (k == u"iv") {
            if (v.type == OJson::Null) d.modelGreeks = std::nullopt;
            else {
                ModelGreeks g;
                if (d.modelGreeks) g.gamma = d.modelGreeks->gamma;
                g.impliedVol = v.n;
                d.modelGreeks = g;
            }
        } else if (k == u"gamma") {
            if (v.type == OJson::Null) d.modelGreeks = std::nullopt;
            else {
                ModelGreeks g;
                if (d.modelGreeks) g.impliedVol = d.modelGreeks->impliedVol;
                g.gamma = v.n;
                d.modelGreeks = g;
            }
        } else qFatal("脚本里不认识的盘口字段 %s", qPrintable(k));
    }
}

class FakeSession;

class World {
public:
    struct Timer {
        double at = 0;
        qint64 seq = 0;
        std::function<void()> fn;
    };

    explicit World(const OJson& scenario) {
        T = num(scenario, u"start"_s);
        sync();
        ibkr::util::setDateNowForTests([this] { return T; });
        setLogSinkForTests([this](const QString& line) { rec(QString(), u"stderr"_s, js::array({js::S(line)})); });
    }
    ~World() {
        ibkr::util::setDateNowForTests({});
        ibkr::domain::setClock(std::nullopt);
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

    std::shared_ptr<Timer> schedule(double delay, std::function<void()> fn) {
        auto t = std::make_shared<Timer>();
        t->at = T + delay;
        t->seq = counter++;
        t->fn = std::move(fn);
        timers.push_back(t);
        return t;
    }
    Task<> sleep(double delay) {
        ibkr::util::Deferred<> d;
        schedule(delay, [d]() mutable { d.resolve(); });
        return d.task();
    }

    /// 最早的一个计时器(同刻按先后)到点:钟走到那一刻,触发(醒来的协程一直跑到下一个阻塞点)。没有计时器回 false
    bool stepOne(double limit = INFINITY) {
        std::shared_ptr<Timer> best;
        for (const auto& e : timers) {
            if (!best || e->at < best->at || (e->at == best->at && e->seq < best->seq)) best = e;
        }
        if (!best || best->at > limit) return false;
        for (auto it = timers.begin(); it != timers.end(); ++it) {
            if (*it == best) {
                timers.erase(it);
                break;
            }
        }
        T = std::fmax(T, best->at);
        sync();
        best->fn();
        return true;
    }
    void advance(double ms) {
        const double end = T + ms;
        while (stepOne(end)) {
        }
        T = end;
        sync();
    }
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
                if (c.s == u"ContractHours") caps_.insert(Cap::ContractHours);
                else if (c.s == u"SetBaselineMarketDataType") caps_.insert(Cap::SetBaselineMarketDataType);
                else if (c.s == u"QuoteDelayed") caps_.insert(Cap::QuoteDelayed);
                else if (c.s == u"OpenTradesDetailed") caps_.insert(Cap::OpenTradesDetailed);
                else if (c.s == u"Executions") caps_.insert(Cap::Executions);
                else if (c.s == u"OnLink") caps_.insert(Cap::OnLink);
                else if (c.s == u"OnError") caps_.insert(Cap::OnError);
                else qFatal("脚本里不认识的 caps %s", qPrintable(c.s));
            }
        }
    }

    QString name;
    bool connected = true;
    std::vector<std::function<void(int)>> connCbs;
    std::vector<std::function<void(bool)>> linkCbs;
    std::vector<std::pair<int, std::function<void(int, int, const QString&)>>> errCbs;
    QHash<QString, std::shared_ptr<Entry>> streams;

    OJson& cfg() { return cfg_; }

    void applyPatch(const QString& key, const OJson& patch) {
        auto it = streams.find(key);
        if (it == streams.end()) return;
        const std::shared_ptr<Entry> entry = it.value();
        mergePatch(entry->data, patch);
        if (hasErr(entry->data)) streams.remove(key);
    }

    bool has(Cap c) const override { return caps_.contains(c); }
    bool isConnected() override {
        w_->rec(name, u"isConnected"_s, js::array());
        return connected;
    }
    Task<> disconnect() override {
        w_->rec(name, u"disconnect"_s, js::array());
        connected = false;
        const double d = num(cfg_, u"disconnectDelay"_s);
        if (d > 0) co_await w_->sleep(d);
        if (flag(cfg_, u"throwDisconnect"_s)) throw ibkr::util::JsError(u"disconnect boom"_s);
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
    ListenerToken onError(std::function<void(int, int, const QString&)> cb) override {
        w_->rec(name, u"onError"_s, js::array());
        const int token = ++tokenSeq_;
        errCbs.emplace_back(token, std::move(cb));
        return token;
    }
    void offError(ListenerToken token) override {
        w_->rec(name, u"offError"_s, js::array());
        for (auto it = errCbs.begin(); it != errCbs.end(); ++it) {
            if (it->first == token) {
                errCbs.erase(it);
                break;
            }
        }
    }
    void reqMarketDataType(int type) override {
        w_->rec(name, u"reqMarketDataType"_s, js::array({js::N(type)}));
        if (const OJson* l = cfg_.get(u"throwMdType"_s)) {
            for (const OJson& x : l->items) {
                if (x.n == type) throw ibkr::util::JsError(u"mdtype boom"_s);
            }
        }
    }
    void setBaselineMarketDataType(int type) override {
        w_->rec(name, u"setBaselineMarketDataType"_s, js::array({js::N(type)}));
        if (flag(cfg_, u"throwBaseline"_s)) throw ibkr::util::JsError(u"baseline boom"_s);
    }
    std::optional<bool> quoteDelayed(const IbContract& c) override {
        w_->rec(name, u"quoteDelayed"_s, js::array({normContract(c)}));
        if (const OJson* m = cfg_.get(u"delayed"_s)) {
            if (const OJson* v = m->get(tickerKey(c)); v && v->type == OJson::Bool) return v->b;
        }
        return std::nullopt;
    }

    /// 按调用先后各取一个结果,用完重复最后一个
    OJson pick(const QString& key, const OJson& dflt) {
        const OJson* list = cfg_.get(key);
        if (!list || list->items.isEmpty()) {
            const int i = counters_.value(key, 0);
            counters_.insert(key, i + 1);
            return dflt;
        }
        const int i = counters_.value(key, 0);
        counters_.insert(key, i + 1);
        return list->items[std::min<qsizetype>(i, list->items.size() - 1)];
    }

    Task<> qualifyContracts(std::vector<IbContract*> contracts, int timeoutMs) override {
        const OJson out = pick(u"qualify"_s, js::object({{u"kind"_s, js::S(u"ok"_s)}}));
        OJson cs = js::array();
        for (const IbContract* c : contracts) cs.items.append(normContract(*c));
        w_->rec(name, u"qualifyContracts"_s, js::array({cs, js::N(timeoutMs)}));
        const double delay = num(out, u"delay"_s);
        if (delay > 0) co_await w_->sleep(delay);
        const QString kind = str(out, u"kind"_s);
        w_->rec(name, u"qualifyDone"_s, js::array({js::S(kind)}));
        if (kind == u"hang") co_await ibkr::util::Deferred<>().task();
        if (kind == u"ok") {
            const OJson* ids = out.get(u"conIds"_s);
            const OJson* unknown = cfg_.get(u"unknown"_s);
            for (size_t i = 0; i < contracts.size(); ++i) {
                bool skip = false;
                if (unknown) {
                    for (const OJson& u : unknown->items) {
                        if (u.s == contracts[i]->symbol) skip = true;
                    }
                }
                if (skip) continue;
                if (ids && static_cast<qsizetype>(i) < ids->items.size()) {
                    const OJson& v = ids->items[static_cast<qsizetype>(i)];
                    if (v.type != OJson::Null) contracts[i]->conId = static_cast<int>(v.n);
                } else {
                    contracts[i]->conId = nextConId_++;
                }
                if (const OJson* rw = cfg_.get(u"rewrite"_s)) {
                    if (const OJson* x = rw->get(u"exchange"_s)) contracts[i]->exchange = x->s;
                    if (const OJson* x = rw->get(u"tradingClass"_s)) contracts[i]->tradingClass = x->s;
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
            if (!hasErr(entry->data)) streams.insert(key, entry);
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
        co_await w_->sleep(ms);
        settleCount_ += 1;
        if (const OJson* l = cfg_.get(u"errorOnSettle"_s)) {
            for (const OJson& e : l->items) {
                if (static_cast<int>(num(e, u"n"_s)) == settleCount_) {
                    const auto cbs = errCbs;
                    for (const auto& cb : cbs) cb.second(7, static_cast<int>(num(e, u"code"_s)), str(e, u"msg"_s));
                }
            }
        }
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
                const int i = counters_.value(u"hist:"_s + k, 0);
                counters_.insert(u"hist:"_s + k, i + 1);
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
            r.volume = optNumber(b.get(u"volume"_s));
            bars.push_back(r);
        }
        co_return bars;
    }

    Task<std::vector<OptChainParam>> secDefOptParams(QString symbol, QString secType, int conId) override {
        w_->rec(name, u"secDefOptParams"_s, js::array({js::S(symbol), js::S(secType), js::N(conId)}));
        const OJson r = pick(u"secDef"_s, js::object({{u"params"_s, js::array()}}));
        const double delay = num(r, u"delay"_s);
        if (delay > 0) co_await w_->sleep(delay);
        if (const OJson* e = r.get(u"error"_s)) throw ibkr::util::JsError(e->s);
        std::vector<OptChainParam> out;
        for (const OJson& praw : r.get(u"params"_s)->items) {
            const OJson p = jsfix::dec(praw);
            OptChainParam c;
            c.exchange = str(p, u"exchange"_s);
            c.tradingClass = str(p, u"tradingClass"_s);
            if (const OJson* e = p.get(u"expirations"_s)) {
                for (const OJson& x : e->items) c.expirations.append(x.s);
            }
            if (const OJson* s = p.get(u"strikes"_s)) {
                for (const OJson& x : s->items) c.strikes.push_back(x.n);
            }
            out.push_back(c);
        }
        co_return out;
    }

    Task<Depth> mktDepth(IbContract contract, int rows, int waitMs) override {
        w_->rec(name, u"mktDepth"_s, js::array({normContract(contract), js::N(rows), js::N(waitMs)}));
        const OJson r = pick(u"depth"_s, js::object({{u"bids"_s, js::array()}, {u"asks"_s, js::array()}}));
        if (const OJson* e = r.get(u"error"_s)) throw ibkr::util::JsError(e->s);
        Depth d;
        const auto side = [&](const char16_t* k, std::vector<DepthRow>& to) {
            if (const OJson* v = r.get(QString::fromUtf16(k))) {
                for (const OJson& x : v->items) to.push_back({num(x, u"price"_s), num(x, u"size"_s)});
            }
        };
        side(u"bids", d.bids);
        side(u"asks", d.asks);
        co_return d;
    }

    Task<TradeLike> placeOrder(IbContract contract, OrderIntent order) override {
        w_->rec(name, u"placeOrder"_s, js::array({normContract(contract), canonOrder(order)}));
        const OJson r = pick(u"place"_s, js::object());
        if (flag(r, u"hang"_s)) co_await ibkr::util::Deferred<>().task();
        const double delay = num(r, u"delay"_s);
        if (delay > 0) co_await w_->sleep(delay);
        if (flag(r, u"linkDown"_s)) throw LinkDownError();
        if (const OJson* e = r.get(u"error"_s)) throw ibkr::util::JsError(e->s);
        TradeLike t;
        if (!r.get(u"orderId"_s)) {
            nextOrderId_ += 1;
            t.orderId = nextOrderId_;
            t.permId = 9000 + nextOrderId_;
            t.status = u"Submitted"_s;
            co_return t;
        }
        if (const OJson* v = r.get(u"orderId"_s); v && v->type == OJson::Number) t.orderId = static_cast<int>(v->n);
        if (const OJson* v = r.get(u"permId"_s); v && v->type == OJson::Number) t.permId = static_cast<int>(v->n);
        t.status = str(r, u"status"_s);
        co_return t;
    }

    Task<> cancelOrder(int orderId) override {
        w_->rec(name, u"cancelOrder"_s, js::array({js::N(orderId)}));
        const OJson r = pick(u"cancel"_s, js::object());
        if (flag(r, u"linkDown"_s)) throw LinkDownError();  // 同步抛,同 ibSession.ts
        if (const OJson* e = r.get(u"error"_s)) throw ibkr::util::JsError(e->s);
        return Task<>::resolved();
    }

    Task<std::vector<OpenTrade>> openTrades() override {
        w_->rec(name, u"openTrades"_s, js::array());
        std::vector<OpenTrade> out;
        if (const OJson* l = cfg_.get(u"openTrades"_s)) {
            for (const OJson& o : l->items) {
                OpenTrade t;
                const int id = static_cast<int>(num(o, u"orderId"_s));
                const bool throws = flag(o, u"throws"_s);
                t.orderId = id;
                t.cancel = [this, id, throws] {
                    w_->rec(name, u"tradeCancel"_s, js::array({js::N(id)}));
                    if (throws) throw ibkr::util::JsError(u"trade cancel boom"_s);
                };
                out.push_back(t);
            }
        }
        co_return out;
    }

    Task<std::vector<OpenTradeDetail>> openTradesDetailed() override {
        w_->rec(name, u"openTradesDetailed"_s, js::array());
        std::vector<OpenTradeDetail> out;
        if (const OJson* l = cfg_.get(u"detailed"_s)) {
            for (const OJson& raw : l->items) {
                const OJson d = jsfix::dec(raw);
                OpenTradeDetail t;
                t.orderId = optInt(d.get(u"orderId"_s));
                t.permId = optInt(d.get(u"permId"_s));
                t.orderRef = str(d, u"orderRef"_s);
                t.account = str(d, u"account"_s);
                t.action = str(d, u"action"_s);
                t.orderType = str(d, u"orderType"_s);
                t.totalQuantity = num(d, u"totalQuantity"_s);
                t.lmtPrice = optNumber(d.get(u"lmtPrice"_s));
                t.auxPrice = optNumber(d.get(u"auxPrice"_s));
                t.trailingPercent = optNumber(d.get(u"trailingPercent"_s));
                t.status = str(d, u"status"_s);
                if (const OJson* c = d.get(u"contract"_s)) t.contract = contractFrom(*c);
                t.ocaGroup = str(d, u"ocaGroup"_s);
                t.ocaType = optInt(d.get(u"ocaType"_s));
                t.tif = str(d, u"tif"_s);
                t.outsideRth = flag(d, u"outsideRth"_s);
                out.push_back(t);
            }
        }
        co_return out;
    }

    Task<std::vector<PortfolioItemLike>> portfolio() override {
        const OJson r = listResult(u"portfolio"_s);
        const double delay = num(r, u"delay"_s);
        if (flag(r, u"hang"_s)) co_await ibkr::util::Deferred<>().task();
        if (delay > 0) co_await w_->sleep(delay);
        if (const OJson* e = r.get(u"error"_s)) throw ibkr::util::JsError(e->s);
        std::vector<PortfolioItemLike> out;
        for (const OJson& raw : r.get(u"items"_s)->items) {
            const OJson d = jsfix::dec(raw);
            PortfolioItemLike p;
            if (const OJson* c = d.get(u"contract"_s)) p.contract = *c;
            p.position = num(d, u"position"_s);
            p.averageCost = num(d, u"averageCost"_s);
            p.marketPrice = num(d, u"marketPrice"_s);
            p.marketValue = num(d, u"marketValue"_s);
            p.unrealizedPnL = num(d, u"unrealizedPnL"_s);
            if (const OJson* a = d.get(u"account"_s); a && a->type == OJson::String) p.account = a->s;
            out.push_back(p);
        }
        co_return out;
    }

    Task<std::vector<PositionItemLike>> positions() override {
        const OJson r = listResult(u"positions"_s);
        const double delay = num(r, u"delay"_s);
        if (flag(r, u"hang"_s)) co_await ibkr::util::Deferred<>().task();
        if (delay > 0) co_await w_->sleep(delay);
        if (const OJson* e = r.get(u"error"_s)) throw ibkr::util::JsError(e->s);
        std::vector<PositionItemLike> out;
        for (const OJson& raw : r.get(u"items"_s)->items) {
            const OJson d = jsfix::dec(raw);
            PositionItemLike p;
            if (const OJson* c = d.get(u"contract"_s)) p.contract = *c;
            p.position = num(d, u"position"_s);
            p.avgCost = num(d, u"avgCost"_s);
            if (const OJson* a = d.get(u"account"_s); a && a->type == OJson::String) p.account = a->s;
            out.push_back(p);
        }
        co_return out;
    }

    Task<std::vector<ExecutionRow>> executions() override {
        w_->rec(name, u"executions"_s, js::array());
        const OJson r = pick(u"executions"_s, js::object({{u"rows"_s, js::array()}}));
        const double delay = num(r, u"delay"_s);
        if (delay > 0) co_await w_->sleep(delay);
        if (const OJson* e = r.get(u"error"_s)) throw ibkr::util::JsError(e->s);
        std::vector<ExecutionRow> out;
        for (const OJson& raw : r.get(u"rows"_s)->items) {
            const OJson d = jsfix::dec(raw);
            ExecutionRow e;
            if (const OJson* c = d.get(u"contract"_s)) e.contract = *c;
            if (const OJson* x = d.get(u"execution"_s)) e.execution = *x;
            out.push_back(e);
        }
        co_return out;
    }

    Task<std::optional<std::array<QString, 3>>> contractHours(IbContract contract, int timeoutMs) override {
        w_->rec(name, u"contractHours"_s, js::array({normContract(contract), js::N(timeoutMs)}));
        const OJson r = pick(u"hours"_s, js::object({{u"ok"_s, js::Null()}}));
        if (flag(r, u"hang"_s)) co_await ibkr::util::Deferred<>().task();
        const double delay = num(r, u"delay"_s);
        if (delay > 0) co_await w_->sleep(delay);
        if (const OJson* e = r.get(u"error"_s)) throw ibkr::util::JsError(e->s);
        const OJson* ok = r.get(u"ok"_s);
        if (!ok || ok->type == OJson::Null) co_return std::nullopt;
        co_return std::array<QString, 3>{ok->items[0].s, ok->items[1].s, ok->items[2].s};
    }

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
    static std::optional<int> optInt(const OJson* v) { return !v || v->type == OJson::Null ? std::nullopt : std::optional<int>(static_cast<int>(v->n)); }
    OJson listResult(const QString& key) {
        w_->rec(name, key, js::array());
        return pick(key, js::object({{u"items"_s, js::array()}}));
    }

    World* w_;
    OJson cfg_;
    QSet<Cap> caps_;
    QHash<QString, int> counters_;
    int settleCount_ = 0;
    int nextConId_ = 700000;
    int nextOrderId_ = 100;
    int tokenSeq_ = 0;
};

/// String(exc.message ?? exc)
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
inline QString errClass(const std::exception_ptr& e) {
    try {
        std::rethrow_exception(e);
    } catch (const LinkDownError&) {
        return u"LinkDownError"_s;
    } catch (const BrokerError&) {
        return u"BrokerError"_s;
    } catch (...) {
        return u"Error"_s;
    }
}

/// 把一条 JSON 的脚本(夹具里的 script)放一遍,交回 {log, steps, basisFile}——与 broker_world.mjs 的 runScenario 对应
class Runner {
public:
    Runner(const OJson& script, const OJson& base);
    OJson run();

    World world;
    std::unique_ptr<BrokerRouter> router;

private:
    Task<OJson> invoke(QString method, OJson args);
    OJson outcome(const Task<OJson>& t, bool isVoid) const;
    OJson getValue(const OJson& step);
    QString basisPath() const { return dir_.path() + u"/index_basis.json"_s; }
    ibkr::contract::AccountConfig accountOf(const QString& alias) const { return *router->settings.accountByAlias(alias); }
    ibkr::parsing::validator::ApprovedOrder approvedOf(const OJson& a) const;

    OJson script_;
    QTemporaryDir dir_;
    QHash<int, QString> portToConn_;
    QHash<QString, int> factoryIdx_;
};

inline OJson deepMerge(const OJson& base, const OJson& patch) {
    if (patch.type != OJson::Object) return patch;
    OJson out = base;
    for (const auto& [k, v] : patch.fields) {
        const OJson* b = base.get(k);
        if (v.type == OJson::Object && b && b->type == OJson::Object) out.set(k, deepMerge(*b, v));
        else out.set(k, v);
    }
    return out;
}

}  // namespace bw
