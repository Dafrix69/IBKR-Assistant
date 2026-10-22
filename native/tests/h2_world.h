// handlers2 簇对拍用的"世界"的 C++ 一半:对应 tests/fixtures/h2_world.mjs(脚本格式与日志约定见那里的开头)。
// 底座是 svc_world.h 的 Runner(虚拟钟、临时库、id 序列、通用的步、errInfo);这里加的是 handlers2 的窄接口(transport/handlers/handlers2_ports.h)
// 的脚本替身:每一次调用记一条 {s: 替身名, m, a},回话取自脚本的 ports["<替身>.<方法>"](按调用先后各取一个,用完重复最后一个)。
// 改这个文件就要同时改 h2_world.mjs。
//
// 用法(每个域的测试文件):
//   Runner runner(script, base, h2w::buildH2);  const OJson got = runner.run();  JSFIX 比 expected
#pragma once

#include "analysis/econ_calendar.h"
#include "svc_world.h"
#include "orchestrate/services/svc_util.h"
#include "transport/handlers/handlers2.h"
#include "transport/handlers/handlers2_ports.h"
#include "util/keychain.h"

namespace h2w {

using namespace svcw;

inline QStringList stringsOfJson(const svcw::OJson& v) {
    QStringList out;
    for (const svcw::OJson& x : v.items) out.append(x.s);
    return out;
}
using ibkr::rpc::HandlerBase;
using ibkr::rpc::Handlers2Ports;
using ibkr::rpc::HandlerRouter;

/// 按 r.kind 抛脚本里写的那种错(plain 缺省 | broker | rpc | events_config | keychain)
[[noreturn]] inline void throwScripted(const OJson& r) {
    const QString msg = str(r, u"error"_s);
    const QString kind = str(r, u"kind"_s, u"plain"_s);
    if (kind == u"broker") throw BrokerError(msg);
    if (kind == u"rpc") throw ibkr::util::RpcError(int(num(r, u"code"_s)), msg);
    if (kind == u"events_config") throw ibkr::analysis::econ_calendar::EventsConfigError(msg);
    if (kind == u"keychain") throw ibkr::util::KeychainError(msg);
    throw ibkr::util::JsError(msg);
}

/// 脚本里 {op:"store"} 步与 effects 在库上做的事:svc_world.h 的 defaultStoreOp 之外再认几个(JS 一边是 store[m](...a) 通吃,这里一个一个列)。
/// 缺的方法在这里追加(只用 Edit 追加,别整份重写;不要改 svc_world.h)
inline OJson h2StoreOp(ibkr::domain::TradeStore& store, const QString& m, const OJson& a) {
    const auto at = [&a](int i) -> const OJson& { return a.items[i]; };
    const auto opt = [&a](int i) -> const OJson* { return a.items.size() > i ? &a.items[i] : nullptr; };
    if (m == u"deleteSector") return js::B(store.deleteSector(at(0).s));
    if (m == u"deleteWatch") return js::B(store.deleteWatch(at(0).s));
    if (m == u"deleteQualityStock") return js::B(store.deleteQualityStock(at(0).s));
    if (m == u"updateWatch") return js::B(store.updateWatch(at(0).s, at(1)));
    if (m == u"updateQualityStock") return js::B(store.updateQualityStock(at(0).s, at(1)));
    if (m == u"setIdeaStatus") return js::B(store.setIdeaStatus(at(0).s, at(1).s));
    if (m == u"setIdeaSymbols") return js::B(store.setIdeaSymbols(at(0).s, stringsOfJson(at(1))));
    if (m == u"setIdeaAnalysis") return js::B(store.setIdeaAnalysis(at(0).s, at(1)));
    if (m == u"addIdeaDigest") {
        const OJson* focus = opt(3);
        const OJson* trades = opt(4);
        return store.addIdeaDigest(at(0).s, stringsOfJson(at(1)), at(2), focus && focus->type != OJson::Null ? focus : nullptr, trades && trades->type != OJson::Null ? trades : nullptr);
    }
    return defaultStoreOp(store, m, a);
}

/// 脚本里 ports 一节的回话:记日志、取下一个结果、抛或回。结果里可以带 effects: [{m, a}]——替身被调用时在库上做的事
/// (真 service 会改库,例如 pool.setWatch 开一个开关就是往 quality_stocks 加一行;替身不会,脚本用它演出来)
/// 日志要过一道文本往返(Runner::run 末尾),NaN / ±Infinity 会变 null,看不出是 null 还是 NaN:参数里的非有限数先换成占位串(h2_world.mjs 的 tagNonFinite 同)
inline OJson tagNonFinite(OJson v) {
    if (v.type == OJson::Number && !std::isfinite(v.n)) return js::S(std::isnan(v.n) ? u"__NaN__arg"_s : v.n > 0 ? u"__Inf__arg"_s : u"__-Inf__arg"_s);
    for (OJson& x : v.items) x = tagNonFinite(std::move(x));
    for (auto& f : v.fields) f.second = tagNonFinite(std::move(f.second));
    return v;
}

class Answers {
public:
    Answers(World* w, const OJson& script, std::function<ibkr::domain::TradeStore&()> store) : w_(w), script_(script), store_(std::move(store)) {}
    /// whole 非空时把整个脚本结果(value / error / callLlm …)也交出去(ideaSemantic.rank 的 callLlm 开关要读)
    OJson ask(const QString& port, const QString& method, OJson args, OJson* whole = nullptr) {
        w_->rec(port, method, tagNonFinite(std::move(args)));
        const OJson* ports = script_.get(u"ports"_s);
        const OJson empty = js::object();
        const OJson dflt = js::array({js::object({{u"value"_s, js::Null()}})});
        const OJson& r = pickResult(ports ? *ports : empty, counters_, port + u'.' + method, dflt);
        if (whole) *whole = r;
        if (const OJson* effects = r.get(u"effects"_s))
            for (const OJson& e : effects->items) h2StoreOp(store_(), str(e, u"m"_s), e.get(u"a"_s) ? *e.get(u"a"_s) : js::array());
        if (r.get(u"error"_s)) throwScripted(r);
        const OJson* v = r.get(u"value"_s);
        return v ? *v : js::Null();
    }

private:
    World* w_;
    OJson script_;
    std::function<ibkr::domain::TradeStore&()> store_;
    QHash<QString, int> counters_;
};

inline QStringList stringsOf(const OJson& v) {
    QStringList out;
    for (const OJson& x : v.items) out.append(x.s);
    return out;
}
inline QList<OJson> listOf(const OJson& v) { return QList<OJson>(v.items); }
inline std::optional<double> optNum(const OJson& v) {
    if (v.type == OJson::Number) return v.n;
    return std::nullopt;
}
inline std::optional<QString> optStr(const OJson& v) {
    if (v.type == OJson::String) return v.s;
    return std::nullopt;
}
inline ibkr::contract::OrderedMap<double> numMapOf(const OJson& v) {
    ibkr::contract::OrderedMap<double> m;
    for (const auto& [k, x] : v.fields) m.insert(k, x.n);
    return m;
}

/// 已完成的 Task(同步的替身:JS 那边的 async 函数,调用方的后续晚一拍——用 World::tick() 对齐)
template <class T>
Task<T> later(World* w, std::function<T()> fn) {
    co_await w->tick();
    co_return fn();
}

// ---------------------------------------------------------------- router
class H2Router : public HandlerRouter {
public:
    H2Router(World* w, const OJson& cfg) : w_(w), cfg_(cfg) { n = int(num(cfg, u"sessions"_s, 1)); }
    int n = 1;
    OJson& cfg() { return cfg_; }
    void resetCounter(const QString& key) { counters_.remove(key); }

    bool hasSessions() override { return n > 0; }
    Task<QList<OJson>> historicalBars(QString symbol, QString start, QString end) override {
        const OJson v = co_await ask(u"historicalBars"_s, symbol, js::array({js::S(symbol), js::S(start), js::S(end)}));
        co_return listOf(v);
    }
    Task<OJson> stockQuotes(QStringList symbols) override { return ask(u"stockQuotes"_s, symbols.join(u','), js::array({js::strings(symbols)})); }
    Task<OJson> streamQuotes(QStringList symbols) override { return ask(u"streamQuotes"_s, symbols.join(u','), js::array({js::strings(symbols)})); }
    Task<OJson> orderBook(QString symbol) override { return ask(u"orderBook"_s, symbol, js::array({js::S(symbol)})); }
    bool hasComboBars() override { return !flag(cfg_, u"noCombo"_s); }
    Task<QList<OJson>> comboBars(QString symbol, OJson legs, QString day) override {
        const OJson v = co_await ask(u"comboBars"_s, symbol, js::array({js::S(symbol), legs, js::S(day)}));
        co_return listOf(v);
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
        if (flag(r, u"unscripted"_s)) throw ibkr::util::JsError(u"h2_world: router.%1 未脚本"_s.arg(name));
        co_await w_->tick();
        if (r.get(u"error"_s)) throwScripted(r);
        const OJson* v = r.get(u"value"_s);
        co_return v ? *v : js::Null();
    }
    World* w_;
    OJson cfg_;
    QHash<QString, int> counters_;
};

// ---------------------------------------------------------------- 解析器
class H2Parser : public ibkr::parsing::providers::Parser {
public:
    H2Parser(World* w, const OJson& script, std::function<ibkr::domain::TradeStore&()> store) : w_(w), script_(script), store_(std::move(store)) {}
    QString provider() const override { return u"h2"_s; }
    const ibkr::contract::LLMConfig& config() const override { return cfg_; }
    Task<ibkr::parsing::providers::LLMResponse> parse(ibkr::parsing::prompts::PromptBundle, QString) override {
        throw ibkr::util::JsError(u"h2_world: parse 未实现"_s);
    }
    Task<OJson> completeJson(QString system, QString user, OJson schema) override {
        w_->rec(u"llm"_s, u"completeJson"_s, js::array({js::S(system), js::S(user), schema}));
        const OJson dflt = js::array({js::object({{u"error"_s, js::S(u"h2_world: llm 未脚本"_s)}})});
        const OJson r = pickResult(script_, counters_, u"llm"_s, dflt);
        if (const OJson* effects = r.get(u"effects"_s))  // 同 ports 的 effects:模型"思考"的这几秒里库被别处改了(例:板块被删)
            for (const OJson& e : effects->items) h2StoreOp(store_(), str(e, u"m"_s), e.get(u"a"_s) ? *e.get(u"a"_s) : js::array());
        co_await w_->tick();
        if (r.get(u"error"_s)) throwScripted(r);
        const OJson* v = r.get(u"value"_s);
        co_return v ? *v : js::Null();
    }
    Task<ibkr::parsing::providers::TestProbe> test(std::optional<QString>) override { throw ibkr::util::JsError(u"h2_world: test 未实现"_s); }

private:
    World* w_;
    OJson script_;
    std::function<ibkr::domain::TradeStore&()> store_;
    QHash<QString, int> counters_;
    ibkr::contract::LLMConfig cfg_;
};

// ---------------------------------------------------------------- 各 service 的替身
using namespace ibkr::rpc;
namespace orch = ibkr::orchestrate;

class PoolStub : public PoolOps {
public:
    explicit PoolStub(Answers* a) : a_(a) {}
    void ensureMigrated() override { a_->ask(u"pool"_s, u"ensureMigrated"_s, js::array()); }
    OJson setWatch(const QString& symbol, const orch::PoolWatchPatch& patch, const QString& note) override {
        OJson p = js::object();
        if (patch.price) p.set(u"price"_s, js::B(*patch.price));
        if (patch.anomaly) p.set(u"anomaly"_s, js::B(*patch.anomaly));
        return a_->ask(u"pool"_s, u"setWatch"_s, js::array({js::S(symbol), p, js::S(note)}));
    }
    std::optional<QString> ensureInPool(const QString& symbol, const QString& company) override {
        return optStr(a_->ask(u"pool"_s, u"ensureInPool"_s, js::array({js::S(symbol), js::S(company)})));
    }
    QStringList dropWatches(const QStringList& symbols) override { return stringsOf(a_->ask(u"pool"_s, u"dropWatches"_s, js::array({js::strings(symbols)}))); }

private:
    Answers* a_;
};

class AlertsStub : public AlertsOps {
public:
    AlertsStub(World* w, Answers* a) : w_(w), a_(a) {}
    std::optional<QString> levelsStatusOf(const QString& symbol) override { return optStr(a_->ask(u"alerts"_s, u"levelsStatusOf"_s, js::array({js::S(symbol)}))); }
    QString crossConfirm() override { return a_->ask(u"alerts"_s, u"crossConfirm"_s, js::array()).s; }
    Task<QList<OJson>> listWatches() override {
        const OJson v = a_->ask(u"alerts"_s, u"listWatches"_s, js::array());
        return later<QList<OJson>>(w_, [v] { return listOf(v); });
    }
    ibkr::analysis::ma_touch::Config touchConfig() override {
        const OJson v = a_->ask(u"alerts"_s, u"touchConfig"_s, js::array());
        return ibkr::analysis::ma_touch::normalizeTouchConfig(&v);
    }
    void touchConfigChanged() override { a_->ask(u"alerts"_s, u"touchConfigChanged"_s, js::array()); }
    Task<OJson> refresh(OJson params) override {
        const OJson v = a_->ask(u"alerts"_s, u"refresh"_s, js::array({params}));
        return later<OJson>(w_, [v] { return v; });
    }
    Task<OJson> poll() override {
        const OJson v = a_->ask(u"alerts"_s, u"poll"_s, js::array());
        return later<OJson>(w_, [v] { return v; });
    }

private:
    World* w_;
    Answers* a_;
};

class AnomalyStub : public AnomalyOps {
public:
    explicit AnomalyStub(Answers* a) : a_(a) {}
    ibkr::analysis::anomaly::Config config() override {
        const OJson v = a_->ask(u"anomaly"_s, u"config"_s, js::array());
        return ibkr::analysis::anomaly::normalizeAnomalyConfig(&v);
    }
    OJson monitor() override { return a_->ask(u"anomaly"_s, u"monitor"_s, js::array()); }
    std::optional<OJson> metricsOf(const QString& symbol) override {
        const OJson v = a_->ask(u"anomaly"_s, u"metricsOf"_s, js::array({js::S(symbol)}));
        if (v.type == OJson::Null) return std::nullopt;
        return v;
    }
    void forget(const QString& symbol) override { a_->ask(u"anomaly"_s, u"forget"_s, js::array({js::S(symbol)})); }

private:
    Answers* a_;
};

class EventsStub : public EventsOps {
public:
    EventsStub(World* w, Answers* a) : w_(w), a_(a) {}
    Task<OJson> list(bool force) override {
        const OJson v = a_->ask(u"events"_s, u"list"_s, js::array({js::B(force)}));
        return later<OJson>(w_, [v] { return v; });
    }
    OJson setConfig(const OJson& config) override { return a_->ask(u"events"_s, u"setConfig"_s, js::array({config})); }
    OJson add(const OJson& params) override { return a_->ask(u"events"_s, u"add"_s, js::array({params})); }
    bool remove(const QString& id) override { return a_->ask(u"events"_s, u"remove"_s, js::array({js::S(id)})).b; }

private:
    World* w_;
    Answers* a_;
};

class IntelStub : public IntelOps {
public:
    IntelStub(World* w, Answers* a) : w_(w), a_(a) {}
    Task<OJson> feed(OJson params) override {
        const OJson v = a_->ask(u"intel"_s, u"feed"_s, js::array({params}));
        return later<OJson>(w_, [v] { return v; });
    }
    Task<OJson> dossier(OJson params) override {
        const OJson v = a_->ask(u"intel"_s, u"dossier"_s, js::array({params}));
        return later<OJson>(w_, [v] { return v; });
    }

private:
    World* w_;
    Answers* a_;
};

class FollowStub : public FollowOps {
public:
    FollowStub(World* w, Answers* a) : w_(w), a_(a) {}
    Task<OJson> status() override {
        const OJson v = a_->ask(u"follow"_s, u"status"_s, js::array());
        return later<OJson>(w_, [v] { return v; });
    }
    Task<> setToken(QString token) override {
        a_->ask(u"follow"_s, u"setToken"_s, js::array({js::S(token)}));
        co_await w_->tick();
    }
    Task<> sync(bool restart) override {
        a_->ask(u"follow"_s, u"sync"_s, js::array({js::B(restart)}));
        co_await w_->tick();
    }

private:
    World* w_;
    Answers* a_;
};

class MarketStub : public MarketOps {
public:
    MarketStub(World* w, Answers* a) : w_(w), a_(a) {}
    Task<OJson> wallFor(QString symbol, std::optional<QString> expiry, double width) override {
        const OJson v = a_->ask(u"market"_s, u"wallFor"_s, js::array({js::S(symbol), expiry ? js::S(*expiry) : js::Null(), js::N(width)}));
        return later<OJson>(w_, [v] { return v; });
    }
    Task<QList<OJson>> dailyHistory(QString symbol, double spanDays) override {
        const OJson v = a_->ask(u"market"_s, u"dailyHistory"_s, js::array({js::S(symbol), js::N(spanDays)}));
        return later<QList<OJson>>(w_, [v] { return listOf(v); });
    }
    std::optional<double> dailyHistoryAskedAt(const QString& symbol) override {
        return optNum(a_->ask(u"market"_s, u"dailyHistoryAskedAt"_s, js::array({js::S(symbol)})));
    }
    /// 值:{bars:[{time,open,high,low,close,volume}], cached, askedAt, feed: "live"|"delayed"|"unknown"|null, proxy: {futures,derived,note,spans:[{from,to}]}|null}
    Task<orch::PaBars> paBars(QString symbol, QString timeframe, bool rth, bool force, bool indexProxy) override {
        const OJson v = a_->ask(u"market"_s, u"paBars"_s, js::array({js::S(symbol), js::S(timeframe), js::B(rth), js::B(force), js::B(indexProxy)}));
        return later<orch::PaBars>(w_, [v] { return parsePaBars(v); });
    }

    /// 公开源的取数器:每次调用记 {s:"fetch", m:"get", a:[url]},回话取自 ports["fetch.get"];值是对象且带 __http: [状态码, 状态文字, 正文] 时走 fetchedBody(TS defaultFetcher 的回包判断)
    ibkr::analysis::macro::Fetcher macroFetcher() override {
        return [this](const QString& url, double) { return fetchGet(url); };
    }
    Task<OJson> fetchGet(QString url) {
        const OJson v = a_->ask(u"fetch"_s, u"get"_s, js::array({js::S(url)}));
        co_await w_->tick();
        if (const OJson* h = v.type == OJson::Object ? v.get(u"__http"_s) : nullptr) {
            const int status = int(h->items[0].n);
            co_return ibkr::analysis::macro::fetchedBody(status >= 200 && status < 300, status, h->items[1].s, h->items[2].s);
        }
        co_return v;
    }

    static orch::PaBars parsePaBars(const OJson& v) {
        orch::PaBars out;
        for (const OJson& b : v.get(u"bars"_s)->items) {
            ibkr::execution::SessionBar sb;
            sb.time = str(b, u"time"_s);
            sb.open = num(b, u"open"_s);
            sb.high = num(b, u"high"_s);
            sb.low = num(b, u"low"_s);
            sb.close = num(b, u"close"_s);
            sb.volume = num(b, u"volume"_s);
            out.bars.bars.push_back(sb);
        }
        out.cached = flag(v, u"cached"_s);
        out.askedAt = num(v, u"askedAt"_s);
        if (const OJson* f = v.get(u"feed"_s); f && f->type == OJson::String) {
            out.feed = f->s == u"live" ? ibkr::execution::BarsFeed::Live : f->s == u"delayed" ? ibkr::execution::BarsFeed::Delayed : ibkr::execution::BarsFeed::Unknown;
            out.bars.feed = out.feed;
        }
        if (const OJson* p = v.get(u"proxy"_s); p && p->type == OJson::Object) {
            ibkr::execution::PaProxy px;
            px.futures = str(*p, u"futures"_s);
            px.derived = num(*p, u"derived"_s);
            px.note = str(*p, u"note"_s);
            if (const OJson* spans = p->get(u"spans"_s))
                for (const OJson& s : spans->items) px.spans.push_back({str(s, u"from"_s), str(s, u"to"_s)});
            out.bars.proxy = px;
        }
        return out;
    }

private:
    World* w_;
    Answers* a_;
};

class TradeHistoryStub : public TradeHistoryOps {
public:
    TradeHistoryStub(World* w, Answers* a) : w_(w), a_(a) {}
    /// 值:{facts, butterflies, options, positions}(都是对象数组)
    Task<orch::TradeHistory> load(QStringList symbols) override {
        const OJson v = a_->ask(u"tradeHistory"_s, u"load"_s, js::array({js::strings(symbols)}));
        return later<orch::TradeHistory>(w_, [v] {
            orch::TradeHistory h;
            h.facts = listOf(*v.get(u"facts"_s));
            h.butterflies = listOf(*v.get(u"butterflies"_s));
            h.options = listOf(*v.get(u"options"_s));
            h.positions = listOf(*v.get(u"positions"_s));
            return h;
        });
    }
    /// 值:{trades:[LedgerTrade 的 JSON(键写全,缺值写 null)], excluded:{open, unknown, no_cost}}——JS 侧原样当 Ledger 用,这里转成 analysis::performance::Ledger
    Task<ibkr::analysis::performance::Ledger> ledger() override {
        const OJson v = a_->ask(u"tradeHistory"_s, u"ledger"_s, js::array());
        return later<ibkr::analysis::performance::Ledger>(w_, [v] {
            ibkr::analysis::performance::Ledger l;
            for (const OJson& t : v.get(u"trades"_s)->items) l.trades.append(ibkr::analysis::performance::ledgerTradeFromJson(t));
            const OJson& ex = *v.get(u"excluded"_s);
            l.excluded = {num(ex, u"open"_s), num(ex, u"unknown"_s), num(ex, u"no_cost"_s)};
            return l;
        });
    }

private:
    World* w_;
    Answers* a_;
};

class SimilarContextStub : public SimilarContextOps {
public:
    SimilarContextStub(World* w, Answers* a) : w_(w), a_(a) {}
    Task<std::optional<double>> spot(QString symbol) override {
        const OJson v = a_->ask(u"similarContext"_s, u"spot"_s, js::array({js::S(symbol)}));
        return later<std::optional<double>>(w_, [v] { return optNum(v); });
    }
    Task<ibkr::contract::OrderedMap<double>> flyEntryUnderlyings(QList<OJson> butterflies, QList<OJson> positions, QString symbol) override {
        const OJson v = a_->ask(u"similarContext"_s, u"flyEntryUnderlyings"_s, js::array({js::array(butterflies), js::array(positions), js::S(symbol)}));
        return later<ibkr::contract::OrderedMap<double>>(w_, [v] { return numMapOf(v); });
    }
    Task<orch::SimilarContextService::StockRanges> stockRanges(QString symbol, QList<OJson> facts) override {
        const OJson v = a_->ask(u"similarContext"_s, u"stockRanges"_s, js::array({js::S(symbol), js::array(facts)}));
        return later<orch::SimilarContextService::StockRanges>(w_, [v] {
            orch::SimilarContextService::StockRanges r;
            r.query = optNum(*v.get(u"query"_s));
            r.byId = numMapOf(*v.get(u"byId"_s));
            return r;
        });
    }

private:
    World* w_;
    Answers* a_;
};

class StockTripsStub : public StockTripsOps {
public:
    StockTripsStub(World* w, Answers* a) : w_(w), a_(a) {}
    Task<QList<OJson>> trips() override {
        const OJson v = a_->ask(u"stockTrips"_s, u"trips"_s, js::array());
        return later<QList<OJson>>(w_, [v] { return listOf(v); });
    }

private:
    World* w_;
    Answers* a_;
};

class FillSyncStub : public FillSyncOps {
public:
    FillSyncStub(World* w, Answers* a) : w_(w), a_(a) {}
    Task<std::optional<double>> sync(std::optional<double> nowMs, bool deep) override {
        const OJson v = a_->ask(u"fillSync"_s, u"sync"_s, js::array({js::NOrNull(nowMs), js::B(deep)}));
        return later<std::optional<double>>(w_, [v] { return optNum(v); });
    }
    bool available() override { return a_->ask(u"fillSync"_s, u"available"_s, js::array()).b; }

private:
    World* w_;
    Answers* a_;
};

class IdeaSemanticStub : public IdeaSemanticOps {
public:
    IdeaSemanticStub(World* w, Answers* a) : w_(w), a_(a) {}
    /// 值:null(= 不可用)| {id: 分数}。结果里可以带 callLlm: {system, user, schema}:替身就去调传进来的 llmJson 闭包(这一问记在 llm 日志里),
    /// 再记一条 {s:"ideaSemantic", m:"llmResult", a:[{value} | {error}]},然后照常回 value(测 handler 里闭包的接线)
    Task<std::optional<orch::RankMap>> rank(QString query, QList<OJson> pool, orch::LlmJson llm) override {
        OJson whole;
        const OJson v = a_->ask(u"ideaSemantic"_s, u"rank"_s, js::array({js::S(query), js::array(pool)}), &whole);
        if (const OJson* call = whole.get(u"callLlm"_s)) {
            OJson outcome;
            try {
                const OJson out = co_await llm(str(*call, u"system"_s), str(*call, u"user"_s), call->get(u"schema"_s) ? *call->get(u"schema"_s) : js::Null());
                outcome = js::object({{u"value"_s, out}});
            } catch (...) {
                outcome = js::object({{u"error"_s, js::S(ibkr::orchestrate::errMessage(std::current_exception()))}});
            }
            w_->rec(u"ideaSemantic"_s, u"llmResult"_s, js::array({outcome}));
        }
        co_await w_->tick();
        if (v.type == OJson::Null) co_return std::nullopt;
        co_return numMapOf(v);
    }

private:
    World* w_;
    Answers* a_;
};

class FlyPlannerStub : public FlyPlannerOps {
public:
    FlyPlannerStub(World* w, Answers* a) : w_(w), a_(a) {}
    Task<OJson> planFor(OJson params) override {
        const OJson v = a_->ask(u"flyPlanner"_s, u"planFor"_s, js::array({params}));
        return later<OJson>(w_, [v] { return v; });
    }
    Task<OJson> spotFor(QString symbol) override {
        const OJson v = a_->ask(u"flyPlanner"_s, u"spotFor"_s, js::array({js::S(symbol)}));
        return later<OJson>(w_, [v] { return v; });
    }

private:
    World* w_;
    Answers* a_;
};

class IvRecorderStub : public IvRecorderOps {
public:
    explicit IvRecorderStub(Answers* a) : a_(a) {}
    OJson status() override { return a_->ask(u"ivRecorder"_s, u"status"_s, js::array()); }
    OJson setEnabled(bool on) override { return a_->ask(u"ivRecorder"_s, u"setEnabled"_s, js::array({js::B(on)})); }

private:
    Answers* a_;
};

class PlaybookStub : public PlaybookOps {
public:
    explicit PlaybookStub(Answers* a) : a_(a) {}
    OJson snapshot() override { return a_->ask(u"playbook"_s, u"snapshot"_s, js::array()); }
    OJson setEnabled(bool on) override { return a_->ask(u"playbook"_s, u"setEnabled"_s, js::array({js::B(on)})); }

private:
    Answers* a_;
};

// ---------------------------------------------------------------- 装起来
/// 假的 RpcContext:settings 与 emit 转给 Host,其余不会被这些 handler 碰
class H2Context : public ibkr::rpc::RpcContext {
public:
    explicit H2Context(Host* host) : host_(host) {}
    const ibkr::domain::Settings& settings() const override { return host_->settings(); }
    std::shared_ptr<ibkr::orchestrate::Router> router() const override { return nullptr; }
    ibkr::orchestrate::TradingEngine& engine() override { qFatal("h2_world: handler 不该碰 ctx.engine()"); }
    void emitEvent(const QString& event, const OJson& payload) override { host_->emitEvent(event, payload); }
    void setSettings(ibkr::domain::Settings s) override { host_->setSettings(std::move(s)); }
    void setRouter(std::shared_ptr<ibkr::orchestrate::Router>) override {}
    ibkr::orchestrate::TradingEngine* engineBuilt() const override { return nullptr; }
    std::shared_ptr<ibkr::rpc::Parser> parserFactory(const ibkr::contract::LLMConfig&) override { return nullptr; }
    void reload() override {}
    void dropEngine() override {}
    ibkr::rpc::SerialLock& trackerLock() override { return lock_; }

private:
    Host* host_;
    ibkr::rpc::SerialLock lock_;
};

/// 一场脚本里所有的替身与它们的状态
struct H2State : Handlers2Ports {
    H2State(World& w, Host& host, const OJson& script)
        : world(&w), host_(&host), answers(&w, script, [&host]() -> ibkr::domain::TradeStore& { return host.svcEngine().store(); }), context(&host), parser_(std::make_shared<H2Parser>(&w, script, [&host]() -> ibkr::domain::TradeStore& { return host.svcEngine().store(); })), pool_(&answers), alerts_(&w, &answers),
          anomaly_(&answers), events_(&w, &answers), intel_(&w, &answers), follow_(&w, &answers), market_(&w, &answers), tradeHistory_(&w, &answers),
          similar_(&w, &answers), stockTrips_(&w, &answers), fillSync_(&w, &answers), ideaSemantic_(&w, &answers), flyPlanner_(&w, &answers), ivRecorder_(&answers),
          playbook_(&answers) {}

    World* world;
    Host* host_;
    Answers answers;
    H2Context context;
    std::shared_ptr<H2Router> h2router;

    ibkr::domain::TradeStore& store() override { return host_->svcEngine().store(); }
    std::shared_ptr<HandlerRouter> router() override { return h2router; }
    std::shared_ptr<ibkr::parsing::providers::Parser> parser(const ibkr::contract::LLMConfig&) override { return parser_; }
    PoolOps& pool() override { return pool_; }
    AlertsOps& alerts() override { return alerts_; }
    AnomalyOps& anomaly() override { return anomaly_; }
    EventsOps& events() override { return events_; }
    IntelOps& intel() override { return intel_; }
    FollowOps& follow() override { return follow_; }
    MarketOps& market() override { return market_; }
    TradeHistoryOps& tradeHistory() override { return tradeHistory_; }
    SimilarContextOps& similarContext() override { return similar_; }
    StockTripsOps& stockTrips() override { return stockTrips_; }
    FillSyncOps& fillSync() override { return fillSync_; }
    IdeaSemanticOps& ideaSemantic() override { return ideaSemantic_; }
    FlyPlannerOps& flyPlanner() override { return flyPlanner_; }
    IvRecorderOps& ivRecorder() override { return ivRecorder_; }
    PlaybookOps& playbook() override { return playbook_; }

    std::vector<std::unique_ptr<HandlerBase>> handlers;

private:
    std::shared_ptr<H2Parser> parser_;
    PoolStub pool_;
    AlertsStub alerts_;
    AnomalyStub anomaly_;
    EventsStub events_;
    IntelStub intel_;
    FollowStub follow_;
    MarketStub market_;
    TradeHistoryStub tradeHistory_;
    SimilarContextStub similar_;
    StockTripsStub stockTrips_;
    FillSyncStub fillSync_;
    IdeaSemanticStub ideaSemantic_;
    FlyPlannerStub flyPlanner_;
    IvRecorderStub ivRecorder_;
    PlaybookStub playbook_;
};

/// Runner::Build:把十一个域的 handler 装在脚本替身上,按 RPC 方法名交给脚本的 call 步
inline Svc buildH2(World& w, Host& host, const OJson& script, Runner&) {
    ibkr::analysis::macro::clearMacroCache();  // 宏观行情带的缓存是进程里的一份:每个场景从空开始(h2_world.mjs 的 build 同)
    auto state = std::make_shared<H2State>(w, host, script);
    state->handlers = ibkr::rpc::makeHandlers2(state->context, *state);
    Svc s;
    s.storeOp = [state](const QString& m, const OJson& a) { return h2StoreOp(state->store(), m, a); };
    for (auto& h : state->handlers) {
        for (auto& [name, fn] : h->methods()) {
            auto call = fn;
            s.methods[name] = [state, call](OJson a) -> Task<OJson> { return call(a); };
        }
    }
    const OJson cfg = script.get(u"h2router"_s) ? *script.get(u"h2router"_s) : js::object();
    s.ops[u"h2router"_s] = [state, cfg](const OJson& step, OJson&) {
        state->h2router = str(step, u"v"_s) == u"make" ? std::make_shared<H2Router>(state->world, cfg) : nullptr;
    };
    s.ops[u"h2routerSet"_s] = [state](const OJson& step, OJson&) {
        auto r = state->h2router;
        if (!r) return;
        for (const auto& [k, v] : step.get(u"set"_s)->fields) {
            if (k == u"results") {
                if (!r->cfg().get(u"results"_s)) r->cfg().set(u"results"_s, js::object());
                OJson* res = r->cfg().get(u"results"_s);
                for (const auto& [rk, rv] : v.fields) {
                    res->set(rk, rv);
                    r->resetCounter(rk);
                }
            } else if (k == u"sessions") {
                r->n = int(v.n);
            } else {
                r->cfg().set(k, v);
            }
        }
    };
    s.stop = [state] {};
    return s;
}

/// 每个域的测试共用的循环:读夹具,逐场景跑,不一样的列出来
inline QStringList replayFixture(const QString& fixtureName) {
    // 解析器要读的 schema 资产(engine-ts/baseline/llm/*.json):IBKR_CONTRACT_DIR = <repo>/engine-ts/src/contract
    ibkr::parsing::providers::setSchemaAssetDir(QStringLiteral(IBKR_CONTRACT_DIR "/../../baseline/llm"));
    const OJson fx = jsfix::load(fixtureName);
    const OJson& base = *fx.get(u"base"_s);
    QStringList failures;
    for (const OJson& sc : fx.get(u"scenarios"_s)->items) {
        const QString what = sc.get(u"name"_s)->s;
        const OJson script = jsfix::dec(*sc.get(u"script"_s));
        Runner runner(script, base, buildH2);
        const OJson got = runner.run();
        if (qEnvironmentVariableIsSet("H2_DUMP") && what == qEnvironmentVariable("H2_DUMP")) {
            QFile f(QDir::tempPath() + u"/h2_got.json"_s);
            if (f.open(QIODevice::WriteOnly)) f.write(js::stringify(jsfix::enc(got)).toUtf8());
        }
        if (!jsfix::same(*sc.get(u"expected"_s), got, what)) failures.append(what);
    }
    return failures;
}

}  // namespace h2w
