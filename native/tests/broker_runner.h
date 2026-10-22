// broker_world.h 里 Runner 的实现(放在头文件里:tst_broker_router 与 tst_broker_fuzz 两个测试共用)。对应 broker_world.mjs 的 runScenario。
#pragma once

#include "broker_world.h"
#include "execution/ib_contracts.h"
#include "util/jsformat.h"

namespace bw {

inline OJson spansJson(const std::vector<TimeSpan>& spans) {
    OJson a = js::array();
    for (const auto& s : spans) a.items.append(js::object({{u"from"_s, js::S(s.from)}, {u"to"_s, js::S(s.to)}}));
    return a;
}
inline OJson taggedJson(const TaggedBars& t) {
    OJson bars = js::array();
    for (const SessionBar& b : t.bars) {
        bars.items.append(js::object({{u"time"_s, js::S(b.time)}, {u"open"_s, js::N(b.open)}, {u"high"_s, js::N(b.high)}, {u"low"_s, js::N(b.low)},
                                      {u"close"_s, js::N(b.close)}, {u"volume"_s, js::N(b.volume)}}));
    }
    OJson o = js::object({{u"bars"_s, bars}});
    if (t.feed) o.set(u"feed"_s, js::S(*t.feed == BarsFeed::Live ? u"live"_s : *t.feed == BarsFeed::Delayed ? u"delayed"_s : u"unknown"_s));
    if (t.proxy) {
        o.set(u"proxy"_s, js::object({{u"futures"_s, js::S(t.proxy->futures)}, {u"derived"_s, js::N(t.proxy->derived)}, {u"note"_s, js::S(t.proxy->note)},
                                      {u"spans"_s, spansJson(t.proxy->spans)}}));
    }
    return o;
}

inline Runner::Runner(const OJson& script, const OJson& base) : world(script), script_(script) {
    OJson raw = base;
    if (const OJson* s = script.get(u"settings"_s)) raw = deepMerge(base, *s);
    raw.set(u"storage"_s, js::object({{u"db_path"_s, js::S(dir_.path() + u"/trades.db"_s)}}));
    ibkr::domain::Settings settings = ibkr::domain::fromDict(raw);
    for (const QString& c : settings.connections.keys()) portToConn_.insert(static_cast<int>(settings.connections.find(c)->port), c);
    if (const OJson* ss = script.get(u"sessions"_s)) {
        for (const OJson& cfg : ss->items) {
            auto s = std::make_shared<FakeSession>(&world, cfg);
            world.sessionOrder.append(s->name);
            world.sessions.insert(s->name, s);
        }
    }
    if (const OJson* es = script.get(u"events"_s)) {
        for (const OJson& e : es->items) {
            const QString sn = str(e, u"session"_s), key = str(e, u"key"_s);
            const OJson patch = *e.get(u"patch"_s);
            world.schedule(num(script, u"start"_s) + num(e, u"at"_s) - world.T, [this, sn, key, patch] {
                if (auto s = world.sessions.value(sn)) s->applyPatch(key, patch);
            });
        }
    }
    IbSessionFactory factory = [this](SessionConfig cfg) {
        ibkr::util::Deferred<std::shared_ptr<IbSession>> d;
        const QString conn = portToConn_.value(cfg.port);
        world.rec(QString(), u"factory"_s,
                  js::array({js::object({{u"host"_s, js::S(cfg.host)}, {u"port"_s, js::N(cfg.port)}, {u"clientId"_s, js::N(cfg.clientId)}, {u"readonly"_s, js::B(cfg.readonly)}})}));
        const OJson* fac = script_.get(u"factory"_s);
        const OJson* list = fac ? fac->get(conn) : nullptr;
        const int i = factoryIdx_.value(conn, 0);
        factoryIdx_.insert(conn, i + 1);
        if (!list || i >= list->items.size()) {
            d.reject(ibkr::util::JsError(u"connect ECONNREFUSED"_s));
            return d.task();
        }
        const OJson& item = list->items[i];
        if (item.type == OJson::Object) {
            const QString message = str(item, u"error"_s);
            const double delay = num(item, u"delay"_s);
            if (delay > 0) world.sleep(delay).onDone([d, message]() mutable { d.reject(ibkr::util::JsError(message)); });
            else d.reject(ibkr::util::JsError(message));
        } else {
            auto s = world.sessions.value(item.s);
            if (!s) qFatal("脚本写错:没有会话 %s", qPrintable(item.s));
            s->connected = true;
            d.resolve(std::shared_ptr<IbSession>(s));
        }
        return d.task();
    };
    router = std::make_unique<BrokerRouter>(std::move(settings), std::move(factory));
    router->sleepHook = [this](int ms) { return world.sleep(ms); };
}

inline ibkr::parsing::validator::ApprovedOrder Runner::approvedOf(const OJson& a) const {
    ibkr::parsing::validator::ApprovedOrder out;
    out.order = *a.get(u"order"_s);
    out.account = accountOf(str(a, u"account"_s));
    out.notional = num(a, u"notional"_s);
    out.signature = str(a, u"signature"_s);
    return out;
}

inline OJson Runner::outcome(const Task<OJson>& t, bool isVoid) const {
    if (t.error()) return js::object({{u"error"_s, js::S(errMessage(t.error()))}, {u"cls"_s, js::S(errClass(t.error()))}});
    if (isVoid) return js::object();
    return js::object({{u"ok"_s, t.result()}});
}

namespace detail {
inline OJson arrayOf(const QList<OJson>& rows) { return js::array(rows); }
inline OJson hoursJson(const std::optional<std::array<QString, 3>>& h) {
    if (!h) return js::Null();
    return js::array({js::S((*h)[0]), js::S((*h)[1]), js::S((*h)[2])});
}
inline OJson placementJson(const PlacementResult& r) {
    return js::object({{u"record_id"_s, js::S(r.record_id)},
                       {u"order_id"_s, r.order_id ? js::N(*r.order_id) : js::Null()},
                       {u"perm_id"_s, r.perm_id ? js::N(*r.perm_id) : js::Null()},
                       {u"status"_s, js::S(r.status)},
                       {u"limit_price"_s, js::NOrNull(r.limit_price)},
                       {u"detail"_s, js::object({{u"account"_s, js::S(r.detailAccount)}})}});
}
}  // namespace detail

inline Task<OJson> Runner::invoke(QString m, OJson a) {
    BrokerRouter& r = *router;
    const auto sessionName = [](const std::shared_ptr<IbSession>& s) { return s ? js::S(std::static_pointer_cast<FakeSession>(s)->name) : js::Null(); };
    const auto strs = [&](const char16_t* k) {
        QStringList l;
        if (const OJson* v = a.get(QString::fromUtf16(k))) {
            for (const OJson& x : v->items) l.append(x.s);
        }
        return l;
    };
    const auto s = [&](const char16_t* k, const QString& d = {}) { return str(a, QString::fromUtf16(k), d); };
    const auto optS = [&](const char16_t* k) -> std::optional<QString> {
        const OJson* v = a.get(QString::fromUtf16(k));
        return v && v->type == OJson::String ? std::optional<QString>(v->s) : std::nullopt;
    };
    if (m == u"connect") co_return sessionName(co_await r.connect(s(u"name")));
    if (m == u"forAccount") co_return sessionName(co_await r.forAccount(accountOf(s(u"account"))));
    if (m == u"qualify") co_return normContract(co_await r.qualify(*a.get(u"contract"_s), accountOf(s(u"account"))));
    if (m == u"qualifyOrRaise") {
        IbContract c = contractFrom(*a.get(u"contract"_s));
        co_await r.qualifyOrRaise(world.sessions.value(s(u"session")), &c, flag(a, u"wait"_s));
        co_return normContract(c);
    }
    if (m == u"legQuotes") {
        const auto qs = co_await r.legQuotes(*a.get(u"contract"_s), accountOf(s(u"account")));
        OJson out = js::array();
        for (const LegQuote& q : qs) out.items.append(js::object({{u"action"_s, js::S(q.action)}, {u"ratio"_s, js::N(q.ratio)}, {u"bid"_s, js::N(q.bid)}, {u"ask"_s, js::N(q.ask)}}));
        co_return out;
    }
    if (m == u"indexPrice") co_return js::NOrNull(co_await r.indexPrice(s(u"symbol")));
    if (m == u"stockQuotes") co_return co_await r.stockQuotes(strs(u"symbols"));
    if (m == u"historicalBars") co_return detail::arrayOf(co_await r.historicalBars(s(u"symbol"), s(u"start"), s(u"end")));
    if (m == u"streamQuotes") co_return co_await r.streamQuotes(strs(u"symbols"));
    if (m == u"volumeQuotes") co_return co_await r.volumeQuotes(strs(u"symbols"));
    if (m == u"releaseVolumeStreams") co_return js::N(r.releaseVolumeStreams(strs(u"keep")));
    if (m == u"intradayBars") {
        const std::optional<QString> endDay = optS(u"endDay");
        co_return taggedJson(co_await r.intradayBars(s(u"symbol"), s(u"timeframe"), flag(a, u"rth"_s), endDay, flag(a, u"indexProxy"_s)));
    }
    if (m == u"optionExpiries") co_return co_await r.optionExpiries(s(u"symbol"));
    if (m == u"optionChain") {
        const OJson* w = a.get(u"width"_s);
        const OJson* sp = a.get(u"span"_s);
        co_return co_await r.optionChain(s(u"symbol"), optS(u"expiry"), w && w->type != OJson::Null ? w->n : 10, optNumber(sp), s(u"preferClass"));
    }
    if (m == u"orderBook") co_return co_await r.orderBook(s(u"symbol"), a.get(u"rows"_s) ? static_cast<int>(num(a, u"rows"_s)) : 10);
    if (m == u"comboBars") co_return detail::arrayOf(co_await r.comboBars(s(u"symbol"), *a.get(u"legs"_s), s(u"day"), s(u"barSize", u"1 min"_s)));
    if (m == u"positions") co_return detail::arrayOf(co_await r.positions());
    if (m == u"optionQuotes") co_return co_await r.optionQuotes(a.get(u"rows"_s)->items);
    if (m == u"executions") co_return detail::arrayOf(co_await r.executions());
    if (m == u"contractHours") co_return detail::hoursJson(co_await r.contractHours(*a.get(u"row"_s), accountOf(s(u"account"))));
    if (m == u"place") {
        const OJson* lo = a.get(u"limitOverride"_s);
        co_return detail::placementJson(co_await r.place(s(u"recordId"), approvedOf(*a.get(u"approved"_s)), lo && lo->type == OJson::Number ? std::optional<double>(lo->n) : std::nullopt));
    }
    if (m == u"cancelAllOpen") co_return js::N(co_await r.cancelAllOpen());
    if (m == u"placeHosted") {
        const HostedPlacement h = co_await r.placeHosted(accountOf(s(u"account")), *a.get(u"contract"_s), *a.get(u"item"_s), s(u"oca"), s(u"ref"));
        co_return js::object({{u"order_id"_s, h.order_id ? js::N(*h.order_id) : js::Null()}, {u"perm_id"_s, h.perm_id ? js::N(*h.perm_id) : js::Null()}, {u"status"_s, js::S(h.status)}});
    }
    if (m == u"modifyHosted") co_return js::B(co_await r.modifyHosted(static_cast<int>(num(a, u"orderId"_s)), *a.get(u"item"_s)));
    if (m == u"cancelHosted") co_return js::B(co_await r.cancelHosted(static_cast<int>(num(a, u"orderId"_s))));
    if (m == u"listHostedOpen") co_return detail::arrayOf(co_await r.listHostedOpen(a.get(u"prefix"_s) ? s(u"prefix") : u"trk:"_s));
    if (m == u"listOpenOrdersDetailed") co_return detail::arrayOf(co_await r.listOpenOrdersDetailed());
    if (m == u"disconnectAll") {
        co_await r.disconnectAll();
        co_return js::Null();
    }
    qFatal("不认识的方法 %s", qPrintable(m));
}

inline OJson Runner::getValue(const OJson& g) {
    BrokerRouter& r = *router;
    const QString what = str(g, u"what"_s);
    const auto names = [](const std::vector<std::shared_ptr<IbSession>>& v) {
        OJson o = js::array();
        for (const auto& x : v) o.items.append(js::S(std::static_pointer_cast<FakeSession>(x)->name));
        return o;
    };
    if (what == u"upstreamOk") return js::B(r.upstreamOk());
    if (what == u"sessions") return names(r.sessions());
    if (what == u"connectedNames") return js::strings(r.connectedNames());
    if (what == u"coveredAccounts") return js::strings(r.coveredAccounts());
    if (what == u"coveredAccountIds") return js::strings(r.coveredAccountIds());
    if (what == u"spotInfo") {
        const auto v = r.spotInfo(str(g, u"symbol"_s));
        return v ? *v : js::Null();
    }
    if (what == u"cachedContractHours") return detail::hoursJson(r.cachedContractHours(str(g, u"symbol"_s), str(g, u"expiry"_s)));
    if (what == u"quoteCapability") {
        const auto v = r.quoteCapability(str(g, u"symbol"_s));
        return v ? js::S(*v) : js::Null();
    }
    if (what == u"connections") return js::strings(r.connections().keys());
    if (what == u"marketSession") {
        try {
            return js::S(std::static_pointer_cast<FakeSession>(r.marketSession())->name);
        } catch (const ibkr::util::JsError& e) {
            return js::object({{u"error"_s, js::S(e.message())}});
        }
    }
    qFatal("不认识的 get %s", qPrintable(what));
}

inline OJson Runner::run() {
    OJson steps = js::array();
    struct Started {
        Task<OJson> t;
        bool isVoid = false;
    };
    QMap<QString, Started> started;
    QSet<QString> reported;
    const QString basis = basisPath();
    if (const OJson* f = script_.get(u"basisFile"_s)) {
        QFile out(basis);
        (void)out.open(QIODevice::WriteOnly);
        out.write(f->s.toUtf8());
    }
    const auto runToDone = [this](const Task<OJson>& t) {
        for (;;) {
            if (t.done()) return true;
            if (!world.stepOne()) return t.done();
        }
    };
    for (const OJson& step : script_.get(u"steps"_s)->items) {
        const QString op = str(step, u"op"_s);
        OJson rec = js::object({{u"op"_s, js::S(op)}});
        if (const OJson* id = step.get(u"id"_s)) rec.set(u"id"_s, *id);
        if (op == u"call") {
            const QString m = str(step, u"m"_s);
            rec.set(u"m"_s, js::S(m));
            const bool isVoid = m == u"disconnectAll";
            const OJson* args = step.get(u"a"_s);
            Task<OJson> t = invoke(m, jsfix::dec(args ? *args : js::object()));
            if (flag(step, u"start"_s)) {
                started.insert(str(step, u"id"_s), {t, isVoid});
            } else {
                rec.set(u"result"_s, runToDone(t) ? outcome(t, isVoid) : js::object({{u"pending"_s, js::B(true)}}));
            }
        } else if (op == u"await") {
            const QString id = str(step, u"id"_s);
            const Started st = started.value(id);
            rec.set(u"result"_s, runToDone(st.t) ? outcome(st.t, st.isVoid) : js::object({{u"pending"_s, js::B(true)}}));
            reported.insert(id);
        } else if (op == u"advance") {
            world.advance(num(step, u"ms"_s));
        } else if (op == u"sess") {
            auto s = world.sessions.value(str(step, u"session"_s));
            const OJson set = jsfix::dec(*step.get(u"set"_s));
            for (const auto& [k, v] : set.fields) s->cfg().set(k, v);
            if (const OJson* c = step.get(u"set"_s)->get(u"connected"_s)) s->connected = c->b;
        } else if (op == u"patch") {
            if (auto s = world.sessions.value(str(step, u"session"_s))) s->applyPatch(str(step, u"key"_s), *step.get(u"patch"_s));
        } else if (op == u"emitConnectivity") {
            const auto cbs = world.sessions.value(str(step, u"session"_s))->connCbs;
            for (const auto& cb : cbs) cb(static_cast<int>(num(step, u"code"_s)));
        } else if (op == u"emitLink") {
            const auto cbs = world.sessions.value(str(step, u"session"_s))->linkCbs;
            for (const auto& cb : cbs) cb(flag(step, u"up"_s));
        } else if (op == u"hooks") {
            if (flag(step, u"link"_s)) router->linkHook = [this](const QString& name, bool up) { world.rec(QString(), u"linkHook"_s, js::array({js::S(name), js::B(up)})); };
            else router->linkHook = nullptr;
            if (flag(step, u"session"_s)) {
                const bool throws = flag(step, u"sessionThrows"_s);
                router->sessionHook = [this, throws](const std::shared_ptr<IbSession>& s) {
                    world.rec(QString(), u"sessionHook"_s, js::array({js::S(std::static_pointer_cast<FakeSession>(s)->name)}));
                    if (throws) throw ibkr::util::JsError(u"hook boom"_s);
                };
            } else {
                router->sessionHook = nullptr;
            }
        } else if (op == u"warm") {
            router->warmIndexFutures();
        } else if (op == u"file") {
            QFile out(basis);
            (void)out.open(QIODevice::WriteOnly | QIODevice::Truncate);
            out.write(str(step, u"content"_s).toUtf8());
        } else if (op == u"readFile") {
            QFile in(basis);
            rec.set(u"file"_s, in.exists() && in.open(QIODevice::ReadOnly) ? js::S(QString::fromUtf8(in.readAll())) : js::Null());
        } else if (op == u"get") {
            rec.set(u"value"_s, getValue(step));
        } else if (op == u"drainBg") {
        } else {
            qFatal("不认识的步 %s", qPrintable(op));
        }
        OJson done = js::array();
        for (auto it = started.begin(); it != started.end(); ++it) {
            if (it.value().t.done() && !reported.contains(it.key())) {
                reported.insert(it.key());
                done.items.append(js::object({{u"id"_s, js::S(it.key())}, {u"result"_s, outcome(it.value().t, it.value().isVoid)}}));
            }
        }
        if (!done.items.isEmpty()) rec.set(u"done"_s, done);
        rec.set(u"T"_s, js::N(world.T));
        steps.items.append(rec);
    }
    OJson fin = js::Null();
    if (QFile in(basis); in.exists() && in.open(QIODevice::ReadOnly)) fin = js::S(QString::fromUtf8(in.readAll()));
    return js::object({{u"log"_s, world.log}, {u"steps"_s, steps}, {u"basisFile"_s, fin}});
}

}  // namespace bw
