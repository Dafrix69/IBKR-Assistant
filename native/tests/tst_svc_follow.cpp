// engine/orchestrate/services/follow_service 对着原模块(engine-ts/src/services/follow.ts)在 tests/fixtures/gen_svc_follow.mjs 的场景上:
// 假宿主按脚本答(引擎的速记 / 发单、行情流、建追踪通道、凭证库、三种来源),两边把宿主上被调用的每一次、每步的结果、最后整个库的样子记下来,逐字比。
// 世界的约定见 svc1_world.h / fixtures/svc1_follow_world.mjs。
#include "orchestrate/services/follow_service.h"
#include "svc1_world.h"

#include "util/jsformat.h"

#include <QFile>
#include <QTest>

using namespace sw;
using namespace ibkr::orchestrate;
using ibkr::util::DiscordMessage;

namespace {

DiscordMessage msgOf(const OJson& m) {
    DiscordMessage out;
    out.id = js::str(m.get(u"id"_s));
    out.channel_id = js::str(m.get(u"channel_id"_s));
    out.author_id = js::str(m.get(u"author_id"_s));
    out.author_name = js::str(m.get(u"author_name"_s));
    out.content = js::str(m.get(u"content"_s));
    out.sentAtMs = js::num(m.get(u"sentAtMs"_s));
    return out;
}

class ManagedSession : public ibkr::execution::IbSession {
public:
    ManagedSession(World& w, const OJson& state) : w_(w), state_(state) {}
    bool isConnected() override { return true; }
    Task<> disconnect() override { qFatal("不该调"); }
    QStringList managedAccounts() override {
        w_.rec(u"session.managedAccounts"_s, js::array());
        QStringList out;
        if (const OJson* m = state_.get(u"managed"_s)) {
            for (const OJson& x : m->items) out.append(js::str(&x));
        } else {
            out.append(u"DU7654321"_s);
        }
        return out;
    }
    Task<> qualifyContracts(std::vector<ibkr::execution::IbContract*>, int) override { qFatal("不该调"); }
    void reqMarketDataType(int) override {}
    std::shared_ptr<ibkr::execution::TickerHandle> subscribeTicker(const ibkr::execution::IbContract&, const QString&) override { qFatal("不该调"); }
    void cancelTicker(const ibkr::execution::IbContract&, const std::optional<QString>&) override {}
    Task<> settle(int) override { qFatal("不该调"); }
    Task<std::vector<ibkr::execution::RawBar>> historicalData(ibkr::execution::IbContract, ibkr::execution::HistoricalRequest) override { qFatal("不该调"); }
    Task<std::vector<ibkr::execution::OptChainParam>> secDefOptParams(QString, QString, int) override { qFatal("不该调"); }
    Task<ibkr::execution::Depth> mktDepth(ibkr::execution::IbContract, int, int) override { qFatal("不该调"); }
    Task<ibkr::execution::TradeLike> placeOrder(ibkr::execution::IbContract, ibkr::execution::OrderIntent) override { qFatal("不该调"); }
    Task<std::vector<ibkr::execution::OpenTrade>> openTrades() override { qFatal("不该调"); }
    Task<> cancelOrder(int) override { qFatal("不该调"); }
    Task<std::vector<ibkr::execution::PortfolioItemLike>> portfolio() override { qFatal("不该调"); }
    Task<std::vector<ibkr::execution::PositionItemLike>> positions() override { qFatal("不该调"); }
    void onConnectivity(std::function<void(int)>) override {}

private:
    World& w_;
    const OJson& state_;
};

class FakeMarks : public MarksPort {
public:
    FakeMarks(World& w, const OJson& book) : w_(w), book_(book) {}
    Task<std::vector<ibkr::execution::OptionMark>> read(std::shared_ptr<ibkr::execution::IbSession>, std::vector<ibkr::execution::OptionLegSpec> legs, bool delayedOk,
                                                         double silentLimitMs) override {
        OJson specs = js::array();
        for (const auto& l : legs) {
            specs.items.append(js::object({{u"symbol"_s, js::S(l.symbol)}, {u"expiry"_s, js::S(l.expiry)}, {u"strike"_s, js::N(l.strike)}, {u"right"_s, js::S(l.right)},
                                           {u"exchange"_s, js::S(l.exchange)}, {u"tradingClass"_s, js::S(l.tradingClass)}}));
        }
        w_.rec(u"marks.read"_s, js::array({specs, js::B(delayedOk), js::N(silentLimitMs)}));
        OJson entry = w_.next(u"marks.read"_s, OJson());
        if (entry.type == OJson::Null) {
            OJson marks = js::array();
            for (const auto& l : legs) {
                const OJson* b = book_.get(jsNumberKey(l.strike));
                const OJson* bid = b ? b->get(u"bid"_s) : nullptr;
                const OJson* ask = b ? b->get(u"ask"_s) : nullptr;
                marks.items.append(js::object({{u"strike"_s, js::N(l.strike)}, {u"right"_s, js::S(l.right)}, {u"bid"_s, js::copyOrNull(bid)}, {u"ask"_s, js::copyOrNull(ask)},
                                               {u"iv"_s, js::Null()}, {u"error"_s, js::Null()}}));
            }
            entry = js::object({{u"ok"_s, marks}});
        }
        return w_.answer<std::vector<ibkr::execution::OptionMark>>(entry, [](const OJson& ok) {
            std::vector<ibkr::execution::OptionMark> out;
            for (const OJson& m : ok.items) {
                ibkr::execution::OptionMark mk;
                mk.strike = js::num(m.get(u"strike"_s));
                mk.right = js::str(m.get(u"right"_s));
                if (js::isNum(m.get(u"bid"_s))) mk.bid = m.get(u"bid"_s)->n;
                if (js::isNum(m.get(u"ask"_s))) mk.ask = m.get(u"ask"_s)->n;
                out.push_back(mk);
            }
            return out;
        });
    }

private:
    static QString jsNumberKey(double v) { return QString::number(v, 'f', 0); }
    World& w_;
    const OJson& book_;
};

/// 假引擎:速记 / 发单 / 腿身份 / 账户都按脚本答(同 svc1_follow_world.mjs 的 svc1 与 engine)
class FollowEngine : public BaseEngine {
public:
    FollowEngine(World& w, ibkr::domain::TradeStore& s, Ctx*& ctx, OJson& breaker) : BaseEngine(w, s), ctx_(ctx), breaker_(breaker) {}
    BreakerView breaker() override {
        return {flag(breaker_, u"engaged"_s), js::strOr(breaker_.get(u"reason"_s), QString())};
    }
    void notify(const QString& title, const QString& body, const QString& subtitle, bool) override { BaseEngine::notify(title, body, subtitle, true); }

    Task<OJson> tryLocalShorthand(QString text, PriceSnap& snap, ibkr::domain::EtNow at, ibkr::parsing::shorthand::ShorthandMeta& meta) override {
        w_.rec(u"engine.tryLocalShorthand"_s, js::array({js::S(text), js::N(at.epochMs)}));
        const OJson dflt = js::object({{u"ok"_s, js::object({{u"payload"_s, js::Null()}, {u"snap"_s, js::object()}, {u"meta"_s, js::Null()}})}});
        const OJson entry = w_.has(u"engine.tryLocalShorthand|"_s + text) ? w_.next(u"engine.tryLocalShorthand|"_s + text, OJson()) : w_.next(u"engine.tryLocalShorthand|*"_s, dflt);
        PriceSnap* snapP = &snap;
        auto* metaP = &meta;
        return w_.answer<OJson>(entry, [snapP, metaP](const OJson& ok) {
            if (const OJson* s = ok.get(u"snap"_s)) {
                for (const auto& [k, v] : s->fields) snapP->set(k, v);
            }
            if (const OJson* m = ok.get(u"meta"_s); m && m->type == OJson::Object) {
                metaP->relativeCenter = flag(*m, u"relativeCenter"_s);
                metaP->set = true;
            }
            const OJson* p = ok.get(u"payload"_s);
            return p ? *p : OJson();
        });
    }

    Task<OJson> handleInstruction(QString text, QString channel, ibkr::domain::EtNow at, PriceSnap snap, QStringList accounts, bool dryRun, InstructionScope scope) override {
        w_.rec(u"engine.handleInstruction"_s, js::array({js::S(text), js::S(channel), js::N(at.epochMs), snap, js::strings(accounts), js::B(dryRun), js::B(scope.localOnly)}));
        const OJson entry = w_.has(u"engine.handleInstruction|"_s + text) ? w_.next(u"engine.handleInstruction|"_s + text, OJson())
                                                                          : w_.next(u"engine.handleInstruction|*"_s, js::object({{u"ok"_s, js::object()}}));
        const OJson ok = co_await w_.answer<OJson>(entry, [](const OJson& v) { return v; });
        if (flag(ok, u"parse"_s)) {
            // 跟单那一趟里被当场拒;手动指令不受影响
            if (scope.localOnly) throw FollowLocalOnlyError();
            w_.rec(u"model.parse"_s, js::array({js::S(text)}));
        }
        if (const OJson* raw = ok.get(u"raw"_s)) co_return *raw;
        const auto make = [&](const OJson* items) {
            OJson out = js::array();
            if (!items) return out;
            for (const OJson& it : items->items) {
                OJson record = *it.get(u"record"_s);
                const QString id = store_.createRecord(record);
                if (const OJson* as = it.get(u"as"_s); as && as->type == OJson::String) ctx_->aliases.insert(as->s, js::S(id));
                if (const OJson* evs = it.get(u"events"_s)) {
                    for (const OJson& ev : evs->items) store_.appendEvent(id, js::str(&ev.items[0]), ev.items[1]);
                }
                out.items.append(js::object({{u"account"_s, js::copyOrNull(it.get(u"account"_s))}, {u"record_id"_s, js::S(id)}, {u"intent_summary"_s, js::copyOrNull(it.get(u"intent_summary"_s))}}));
            }
            return out;
        };
        const OJson submitted = make(ok.get(u"submitted"_s)), queued = make(ok.get(u"queued"_s)), validated = make(ok.get(u"validated_only"_s));
        OJson rejections = js::array();
        if (const OJson* rs = ok.get(u"rejections"_s)) {
            for (const OJson& r : rs->items) {
                OJson o = js::object({{u"code"_s, r.get(u"code"_s) ? *r.get(u"code"_s) : js::S(u"REJECTED"_s)}, {u"message"_s, js::copyOrNull(r.get(u"message"_s))}});
                if (const OJson* rec = r.get(u"record"_s)) {
                    OJson record = *rec;
                    const QString id = store_.createRecord(record);
                    if (const OJson* as = r.get(u"as"_s); as && as->type == OJson::String) ctx_->aliases.insert(as->s, js::S(id));
                    o.set(u"record_id"_s, js::S(id));
                }
                rejections.items.append(o);
            }
        }
        OJson result = js::object({{u"submitted"_s, submitted}, {u"queued"_s, queued}, {u"validated_only"_s, validated}, {u"rejections"_s, rejections},
                                   {u"warnings"_s, ok.get(u"warnings"_s) ? *ok.get(u"warnings"_s) : js::array()}});
        if (!flag(ok, u"noLlmKey"_s)) {
            const OJson* llm = ok.get(u"llm"_s);
            result.set(u"llm"_s, llm ? *llm : js::Null());
        }
        result.set(u"executed"_s, js::B(!dryRun));
        co_return result;
    }

    QStringList resolveFanoutAccounts(const ibkr::domain::Settings&, const QStringList& names) override {
        w_.rec(u"engine.resolveFanoutAccounts"_s, js::array({js::strings(names)}));
        const OJson e = w_.next(u"engine.resolveFanout"_s, js::object({{u"ok"_s, js::array({js::S(u"模拟"_s)})}}));
        if (const OJson* err = e.get(u"err"_s)) std::rethrow_exception(makeError(*err));
        QStringList out;
        for (const OJson& x : e.get(u"ok"_s)->items) out.append(js::str(&x));
        return out;
    }

    QString orderLegId(const OJson& contract) override {
        w_.rec(u"engine.orderLegId"_s, js::array({contract}));
        QStringList strikes;
        if (const OJson* legs = contract.get(u"legs"_s)) {
            for (const OJson& l : legs->items) strikes.append(ibkr::util::jsNumberToString(js::num(l.get(u"strike"_s))));
        }
        const QString key = u"engine.orderLegId|"_s + js::str(contract.get(u"symbol"_s)) + u":"_s + strikes.join(u","_s);
        const OJson e = w_.has(key) ? w_.next(key, OJson()) : w_.next(u"engine.orderLegId|*"_s, js::object({{u"err"_s, js::object({{u"kind"_s, js::S(u"plain"_s)}, {u"message"_s, js::S(u"没有脚本化的 orderLegId"_s)}})}}));
        if (const OJson* err = e.get(u"err"_s)) std::rethrow_exception(makeError(*err));
        return js::str(e.get(u"ok"_s));
    }

private:
    Ctx*& ctx_;
    OJson& breaker_;
};

// ---- 假来源:状态归 SourceState 所有、永不释放(TS 里被丢掉的 Gateway / 收件 / 读程序对象还在,脚本里的步照样能碰它们的 hooks)
struct SourceState {
    struct G { ibkr::util::GatewayHooks hooks; std::optional<QString> bot; bool guildsSeen = false; QSet<QString> channels; int index = -1; };
    struct I { InboxHooks hooks; QString path; bool watching = false; std::optional<QString> lastAt; double received = 0; std::optional<QString> error; int index = -1; };
    struct R { std::function<void(const ibkr::domain::ReaderStatus&)> onStatus; QString program, channel, out; ibkr::domain::ReaderStatus view{u"starting"_s, std::nullopt, std::nullopt}; int index = -1; };
    std::vector<std::shared_ptr<G>> gateways;
    std::vector<std::shared_ptr<I>> inboxes;
    std::vector<std::shared_ptr<R>> readers;
};

class FGateway : public GatewayLike {
public:
    FGateway(World& w, std::shared_ptr<SourceState::G> g) : w_(w), g_(std::move(g)) {}
    void start() override { w_.rec(u"gateway.start"_s, js::array({js::N(g_->index)})); }
    void stop() override { w_.rec(u"gateway.stop"_s, js::array({js::N(g_->index)})); }
    std::optional<QString> bot() const override { return g_->bot; }
    bool guildsSeen() const override { return g_->guildsSeen; }
    bool hasChannel(const QString& id) const override { return g_->channels.contains(id); }

private:
    World& w_;
    std::shared_ptr<SourceState::G> g_;
};
class FInbox : public InboxLike {
public:
    FInbox(World& w, std::shared_ptr<SourceState::I> i) : w_(w), i_(std::move(i)) {}
    QString path() const override { return i_->path; }
    bool watching() const override { return i_->watching; }
    std::optional<QString> lastAt() const override { return i_->lastAt; }
    double received() const override { return i_->received; }
    std::optional<QString> error() const override { return i_->error; }
    void start() override { i_->watching = true; w_.rec(u"inbox.start"_s, js::array({js::N(i_->index)})); }
    void stop() override { i_->watching = false; w_.rec(u"inbox.stop"_s, js::array({js::N(i_->index)})); }
    void poll() override { w_.rec(u"inbox.poll"_s, js::array({js::N(i_->index)})); }

private:
    World& w_;
    std::shared_ptr<SourceState::I> i_;
};
class FReader : public ReaderLike {
public:
    FReader(World& w, std::shared_ptr<SourceState::R> r) : w_(w), r_(std::move(r)) {}
    QString program() const override { return r_->program; }
    QString channel() const override { return r_->channel; }
    QString out() const override { return r_->out; }
    ibkr::domain::ReaderStatus view() const override { return r_->view; }
    void start() override { w_.rec(u"reader.start"_s, js::array({js::N(r_->index)})); }
    void stop() override { w_.rec(u"reader.stop"_s, js::array({js::N(r_->index)})); }

private:
    World& w_;
    std::shared_ptr<SourceState::R> r_;
};

class Runner {
public:
    Runner(const OJson& script, const OJson& base)
        : base_(base),
          world(script),
          settings_(makeSettings(base_, world)),
          store(world.dir.path() + u"/t.db"_s),
          host(world, settings_),
          engine(world, store, ctxP, breaker),
          marks(world, book) {
        routerState = script.get(u"router"_s) ? *script.get(u"router"_s) : js::object();
        breaker = script.get(u"breaker"_s) ? *script.get(u"breaker"_s) : js::object();
        book = script.get(u"book"_s) ? *script.get(u"book"_s) : js::object();
        readerProgram = script.get(u"readerProgram"_s) && script.get(u"readerProgram"_s)->type == OJson::String ? std::optional<QString>(script.get(u"readerProgram"_s)->s) : std::nullopt;
        if (const OJson* v = script.get(u"vault"_s)) {
            for (const auto& [k, x] : v->fields) vault.insert(k, js::str(&x));
        }
        host.setEngine(&engine);
        session = std::make_shared<ManagedSession>(world, routerState);
        rebuild();
        makeService();
        if (!flag(script, u"unwired"_s)) attach();
    }

    void rebuild() {
        router = std::make_shared<FakeRouter>(world, routerState);
        router->session = session;
        host.setRouter(flag(routerState, u"on"_s, true) ? router : nullptr);
    }
    void attach() {
        FollowWiring w;
        w.marks = &marks;
        w.addTrack = [this](OJson params) -> Task<OJson> {
            tracksAdded += 1;
            world.rec(u"addTrack"_s, js::array({params}));
            OJson e = world.next(u"follow.addTrack"_s, OJson());
            if (e.type == OJson::Null) {
                e = js::object({{u"ok"_s, js::object({{u"track"_s, js::object({{u"id"_s, js::S(u"t%1"_s.arg(tracksAdded))}, {u"targets"_s, js::object()}, {u"auto_close"_s, js::object({{u"enabled"_s, js::B(true)}})}})}})}});
            }
            return world.answer<OJson>(e, [](const OJson& v) { return v; });
        };
        service->attach(w);
    }
    void makeService() {
        // 换掉的旧服务还留着(TS 里它被闭包抓着不会消失):它没走完的协程还要接着跑
        if (service) retired.push_back(std::move(service));
        service = std::make_unique<FollowService>(host);
        service->onSeen = [this](const DiscordMessage& m, bool trusted) { world.rec(u"onSeen"_s, js::array({js::S(m.id), js::B(trusted)})); };
        auto& src = service->sources;
        src.readerProgram = [this] { return readerProgram; };
        src.gateway = [this](const QString& token, ibkr::util::GatewayHooks hooks) -> std::unique_ptr<GatewayLike> {
            auto st = std::make_shared<SourceState::G>();
            st->hooks = std::move(hooks);
            st->index = int(sources.gateways.size());
            sources.gateways.push_back(st);
            world.rec(u"gateway.new"_s, js::array({js::N(st->index), js::S(token)}));
            return std::make_unique<FGateway>(world, st);
        };
        src.inbox = [this](const QString& path, InboxHooks hooks) -> std::unique_ptr<InboxLike> {
            auto st = std::make_shared<SourceState::I>();
            st->hooks = std::move(hooks);
            st->path = path;
            st->index = int(sources.inboxes.size());
            sources.inboxes.push_back(st);
            world.rec(u"inbox.new"_s, js::array({js::N(st->index), js::S(path)}));
            return std::make_unique<FInbox>(world, st);
        };
        src.reader = [this](const QString& program, const QString& channel, const QString& out, std::function<void(const ibkr::domain::ReaderStatus&)> onStatus) -> std::unique_ptr<ReaderLike> {
            auto st = std::make_shared<SourceState::R>();
            st->onStatus = std::move(onStatus);
            st->program = program;
            st->channel = channel;
            st->out = out;
            st->index = int(sources.readers.size());
            sources.readers.push_back(st);
            world.rec(u"reader.new"_s, js::array({js::N(st->index), js::S(program), js::S(channel), js::S(out)}));
            return std::make_unique<FReader>(world, st);
        };
        src.secretExists = [this](QString s, QString a) { return secret(u"exists"_s, s, a, {}); };
        src.readSecret = [this](QString s, QString a) { return secretRead(s, a); };
        src.writeSecret = [this](QString s, QString a, QString v) { return secretWrite(s, a, v); };
    }

    Task<bool> secret(const QString& kind, QString service_, QString account, QString) {
        world.rec(u"secret."_s + kind, js::array({js::S(service_), js::S(account)}));
        const OJson e = world.next(u"secret."_s + kind, js::object());
        Deferred<bool> d;
        const QString key = service_ + u"/"_s + account;
        world.schedule(num(e, u"delay"_s), [this, d, e, key]() mutable {
            if (const OJson* err = e.get(u"err"_s)) d.reject(makeError(*err));
            else d.resolve(vault.contains(key));
        });
        return d.task();
    }
    Task<std::optional<QString>> secretRead(QString service_, QString account) {
        world.rec(u"secret.read"_s, js::array({js::S(service_), js::S(account)}));
        const OJson e = world.next(u"secret.read"_s, js::object());
        Deferred<std::optional<QString>> d;
        const QString key = service_ + u"/"_s + account;
        world.schedule(num(e, u"delay"_s), [this, d, e, key]() mutable {
            if (const OJson* err = e.get(u"err"_s)) d.reject(makeError(*err));
            else d.resolve(vault.contains(key) ? std::optional<QString>(vault.value(key)) : std::nullopt);
        });
        return d.task();
    }
    Task<> secretWrite(QString service_, QString account, QString value) {
        world.rec(u"secret.write"_s, js::array({js::S(service_), js::S(account), js::S(value)}));
        const OJson e = world.next(u"secret.write"_s, js::object());
        Deferred<> d;
        world.schedule(num(e, u"delay"_s), [this, d, e, service_, account, value]() mutable {
            if (const OJson* err = e.get(u"err"_s)) {
                d.reject(makeError(*err));
                return;
            }
            vault.insert(service_ + u"/"_s + account, value);
            d.resolve();
        });
        return d.task();
    }

    Task<OJson> call(QString m, OJson a) {
        if (m == u"start") {
            service->start();
            co_return js::Null();
        }
        if (m == u"stop") {
            service->stop();
            co_return js::Null();
        }
        if (m == u"sync") {
            co_await service->sync(!a.items.isEmpty() && a.items[0].type == OJson::Bool && a.items[0].b);
            co_return js::Null();
        }
        if (m == u"pollInbox") {
            co_await service->pollInbox();
            co_return js::Null();
        }
        if (m == u"settled") {
            co_await service->settled();
            co_return js::Null();
        }
        if (m == u"setToken") {
            co_await service->setToken(js::str(&a.items[0]));
            co_return js::Null();
        }
        if (m == u"onMessage") {
            co_await service->onMessage(msgOf(a.items[0]));
            co_return js::Null();
        }
        if (m == u"status") co_return co_await service->status();
        if (m == u"trackTick") {
            co_await service->trackTick();
            co_return js::Null();
        }
        qFatal("不认识的方法 %s", qPrintable(m));
    }

    OJson run(const OJson& script) {
        Ctx c{world, store, [this](const QString& m, const OJson& a) { return call(m, a); }, [this](const OJson& patch) { host.setSettings(makeSettings(base_, world, &patch)); }};
        ctxP = &c;
        c.shape = [](const QString&, const OJson& v) { return v; };
        c.routerState = &routerState;
        c.rebuildRouter = [this] { rebuild(); };
        c.extraOps[u"attach"_s] = [this](const OJson&, OJson&) { attach(); };
        c.extraOps[u"newService"_s] = [this](const OJson& s, OJson&) {
            (void)s;
            makeService();
            if (!flag(world.script(), u"unwired"_s)) attach();
        };
        c.extraOps[u"gw"_s] = [this](const OJson& step, OJson&) {
            const int i = int(num(step, u"i"_s));
            if (size_t(i) >= sources.gateways.size()) return;
            auto* g = sources.gateways[i].get();
            const QString ev = str(step, u"ev"_s);
            if (ev == u"phase") {
                const QString p = str(step, u"phase"_s);
                const OJson* er = step.get(u"error"_s);
                std::optional<QString> error = (er && er->type == OJson::String) ? std::optional<QString>(er->s) : std::nullopt;
                const auto phase = p == u"ready" ? ibkr::util::GatewayPhase::Ready : p == u"failed" ? ibkr::util::GatewayPhase::Failed
                                   : p == u"stopped" ? ibkr::util::GatewayPhase::Stopped : ibkr::util::GatewayPhase::Connecting;
                g->hooks.onPhase(phase, error);
            } else if (ev == u"message") {
                g->hooks.onMessage(msgOf(jsfix::dec(*step.get(u"msg"_s))));
            } else if (ev == u"set") {
                if (const OJson* b = step.get(u"bot"_s)) g->bot = b->type == OJson::String ? std::optional<QString>(b->s) : std::nullopt;
                if (const OJson* b = step.get(u"guildsSeen"_s)) g->guildsSeen = b->b;
                if (const OJson* cs = step.get(u"channels"_s)) {
                    g->channels.clear();
                    for (const OJson& x : cs->items) g->channels.insert(js::str(&x));
                }
            }
            world.advance(0);
        };
        c.extraOps[u"inbox"_s] = [this](const OJson& step, OJson&) {
            const int i = int(num(step, u"i"_s));
            if (size_t(i) >= sources.inboxes.size()) return;
            auto* g = sources.inboxes[i].get();
            const QString ev = str(step, u"ev"_s);
            if (ev == u"message") {
                g->received += 1;
                if (const OJson* la = step.get(u"lastAt"_s); la && la->type == OJson::String) g->lastAt = la->s;
                g->hooks.onMessage(msgOf(jsfix::dec(*step.get(u"msg"_s))));
            } else if (ev == u"error") {
                g->hooks.onError(str(step, u"error"_s));
            } else if (ev == u"set") {
                if (const OJson* la = step.get(u"lastAt"_s)) g->lastAt = la->type == OJson::String ? std::optional<QString>(la->s) : std::nullopt;
                if (const OJson* r = step.get(u"received"_s)) g->received = r->n;
                if (const OJson* er = step.get(u"error"_s)) g->error = er->type == OJson::String ? std::optional<QString>(er->s) : std::nullopt;
            }
            world.advance(0);
        };
        c.extraOps[u"reader"_s] = [this](const OJson& step, OJson&) {
            const int i = int(num(step, u"i"_s));
            if (size_t(i) >= sources.readers.size()) return;
            auto* g = sources.readers[i].get();
            const OJson* t = step.get(u"title"_s);
            const OJson* er = step.get(u"error"_s);
            g->view = {str(step, u"state"_s), (t && t->type == OJson::String) ? std::optional<QString>(t->s) : std::nullopt,
                       (er && er->type == OJson::String) ? std::optional<QString>(er->s) : std::nullopt};
            g->onStatus(g->view);
            world.advance(0);
        };
        c.extraOps[u"breaker"_s] = [this](const OJson& step, OJson&) {
            for (const auto& [k, v] : step.get(u"set"_s)->fields) breaker.set(k, v);
        };
        c.extraOps[u"readerProgram"_s] = [this](const OJson& step, OJson&) {
            const OJson* v = step.get(u"value"_s);
            readerProgram = (v && v->type == OJson::String) ? std::optional<QString>(v->s) : std::nullopt;
        };
        const OJson steps = runSteps(c, script);
        service->stop();
        world.advance(0);
        ctxP = nullptr;
        return steps;
    }

    OJson base_;
    World world;
    ibkr::domain::Settings settings_;
    ibkr::domain::TradeStore store;
    Host host;
    Ctx* ctxP = nullptr;
    OJson breaker, book, routerState;
    FollowEngine engine;
    FakeMarks marks;
    std::shared_ptr<ManagedSession> session;
    std::shared_ptr<FakeRouter> router;
    std::unique_ptr<FollowService> service;
    std::vector<std::unique_ptr<FollowService>> retired;
    SourceState sources;
    QHash<QString, QString> vault;
    std::optional<QString> readerProgram;
    int tracksAdded = 0;
};

}  // namespace

// ---- 发单之后出错的断言(C++ 独有的行为)
int countLog(const OJson& log, const QString& method, const QString& textPart = {}) {
    int n = 0;
    for (const OJson& e : log.items) {
        if (str(e, u"m"_s) != method) continue;
        if (textPart.isEmpty() || js::stringify(*e.get(u"a"_s)).contains(textPart)) ++n;
    }
    return n;
}
QString tableText(const OJson& db, const QString& table) { return db.get(table) ? js::stringify(*db.get(table)) : QString(); }

QString checkPostSubmit(const QString& name, const OJson& log, const OJson& db) {
    const QString follow = tableText(db, u"follow_log"_s), audit = tableText(db, u"audit_log"_s);
    if (follow.contains(u"发单过程出错"_s)) return u"单子被记成了「发单过程出错」"_s;
    if (name != u"engine_returns_no_llm_key" && follow.contains(u"\"rejected\""_s)) return u"单子被记成了 rejected"_s;
    if (name == u"pending_save_fails_when_registering") {
        if (!follow.contains(u"\"sent\""_s)) return u"没有记成已跟单"_s;
        return countLog(log, u"stderr"_s, u"登记待建的追踪出错"_s) == 1 ? QString() : u"登记追踪出错没有落警告"_s;
    }
    if (!audit.contains(u"follow_post_submit_error"_s)) return u"没有审计 follow_post_submit_error"_s;
    if (countLog(log, u"stderr"_s, u"发单之后的步骤出错"_s) < 1) return u"没有 stderr 警告"_s;
    if (name == u"post_submit_llm_key_missing" || name == u"engine_returns_no_llm_key") {
        if (name == u"post_submit_llm_key_missing" && !follow.contains(u"\"sent\""_s)) return u"没有记成已跟单"_s;
        return countLog(log, u"notify"_s, u"已跟单"_s) == (name == u"post_submit_llm_key_missing" ? 1 : 0) ? QString() : u"通知不对"_s;
    }
    if (name == u"post_submit_outcome_throws") {
        if (!follow.contains(u"\"sent\""_s)) return u"outcomeOf 抛了,没有退成已跟单"_s;
        if (!follow.contains(u"rec-x"_s)) return u"退成已跟单时没有带上 submitted 的记录号"_s;
        return countLog(log, u"notify"_s, u"已跟单"_s) == 1 ? QString() : u"通知不对"_s;
    }
    if (name == u"post_submit_retry_with_audit_also_failing") {
        if (!follow.contains(u"\"sent\""_s)) return u"补写没成"_s;
        return countLog(log, u"notify"_s, u"已跟单"_s) == 1 ? QString() : u"补写时审计出错不该拦住通知"_s;
    }
    if (name == u"post_submit_log_row_retried_once") {
        if (!follow.contains(u"\"sent\""_s)) return u"日志行第一次写失败后没有补写成已跟单"_s;
        if (countLog(log, u"notify"_s, u"已跟单"_s) != 1) return u"补写之后没有发通知"_s;
        return countLog(log, u"engine.handleInstruction"_s) == 1 ? QString() : u"发了不止一次"_s;
    }
    if (name == u"post_submit_audit_throws_in_finish") {
        if (!follow.contains(u"\"sent\""_s)) return u"日志行已落却没有已跟单"_s;
        if (countLog(log, u"notify"_s, u"已跟单"_s) != 1) return u"警告之后没有接着发通知"_s;
        return countLog(log, u"engine.handleInstruction"_s) == 1 ? QString() : u"发了不止一次"_s;
    }
    if (name == u"post_submit_follow_add_throws" || name == u"process_error_is_logged") {
        if (!follow.isEmpty()) return u"日志写不了,不该有日志行"_s;
        if (name == u"post_submit_follow_add_throws" && countLog(log, u"engine.handleInstruction"_s) != 1) return u"同一条消息被处理了两遍(去重没记)"_s;
    }
    return {};
}

class TstSvcFollow : public QObject {
    Q_OBJECT
private slots:
    void initTestCase() { fixture_ = jsfix::load(u"svc_follow.json"_s); }
    void cleanupTestCase() { jsfix::rewrite(u"svc_follow.json"_s, fixture_); }
    void scenarios_data() {
        QTest::addColumn<int>("index");
        const OJson& list = *fixture_.get(u"scenarios"_s);
        const QByteArray only = qgetenv("ONLY");
        for (qsizetype i = 0; i < list.items.size(); ++i) {
            const QString name = str(list.items[i], u"name"_s);
            if (!only.isEmpty() && !name.contains(QString::fromUtf8(only))) continue;
            QTest::newRow(qPrintable(name)) << int(i);
        }
    }
    void scenarios() {
        QFETCH(int, index);
        const OJson& sc = fixture_.get(u"scenarios"_s)->items[index];
        const OJson script = jsfix::dec(*sc.get(u"script"_s));
        const OJson base = *fixture_.get(u"base"_s);
        auto r = std::make_unique<Runner>(script, base);
        const OJson steps = r->run(script);
        const OJson db = dumpDb(r->world.dir.path() + u"/t.db"_s);
        const QString name = str(sc, u"name"_s);
        if (flag(sc, u"divergent"_s)) {
            // 发单之后出错:C++ 有意与 TS 不同(follow_service.h 头注释),不对拍,直接断言新的行为
            const QString problem = checkPostSubmit(name, r->world.log, db);
            QVERIFY2(problem.isEmpty(), qPrintable(name + u": "_s + problem));
            return;
        }
        QVERIFY(compareScenario(name, *sc.get(u"expected"_s), r->world, steps, db));
        if (name == u"pending_save_fails_when_registering") {
            const QString problem = checkPostSubmit(name, r->world.log, db);  // 登记追踪那一步出错:下场照记已跟单(TS 也是这样,quietly)
            QVERIFY2(problem.isEmpty(), qPrintable(problem));
        }
    }

    /// 常数钉死(同 TS):建追踪最多试 10 次(钱路径边上),界面「最近看到」留 30 条,已处理表 2000,核对节拍 3 秒
    void constantsArePinned() {
        QCOMPARE(FollowService::kTrackAddAttempts, 10);
        QCOMPARE(FollowService::kSeenMax, 30);
        QCOMPARE(FollowService::kHandledMax, 2000);
        QCOMPARE(FollowService::kTrackPollMs, 3000);
    }

    /// 默认的收件适配器(真的 domain::FollowInbox):文件里追加一行,读出来的消息各字段对得上
    void realInboxAdapterDeliversFields() {
        const OJson base = *fixture_.get(u"base"_s);
        Runner r(js::object({{u"start"_s, js::N(0)}, {u"steps"_s, js::array()}}), base);
        FollowService fresh(r.host);
        const QString path = r.world.dir.path() + u"/follow-inbox.jsonl"_s;
        { QFile f(path); QVERIFY(f.open(QIODevice::WriteOnly)); }
        std::optional<DiscordMessage> got;
        QString error;
        auto inbox = fresh.sources.inbox(path, {[&](const DiscordMessage& m) { got = m; }, [&](const QString& e) { error = e; }});
        QCOMPARE(inbox->path(), path);
        inbox->start();
        QVERIFY(inbox->watching());
        {
            QFile f(path);
            QVERIFY(f.open(QIODevice::Append));
            f.write("{\"v\":1,\"key\":\"k1\",\"seen_at\":\"2026-08-14T14:31:59.000Z\",\"channel\":\"c\",\"author\":\"老王\",\"time_label\":\"22:31\",\"content\":\"1.8 挂15蝴蝶 15CM\"}\n");
        }
        inbox->poll();
        QVERIFY(got.has_value());
        QCOMPARE(got->id, u"local:k1"_s);
        QCOMPARE(got->channel_id, u"local"_s);
        QCOMPARE(got->author_id, u"local:老王"_s);
        QCOMPARE(got->author_name, u"老王"_s);
        QCOMPARE(got->content, u"1.8 挂15蝴蝶 15CM"_s);
        QCOMPARE(got->sentAtMs, double(Date_UTC_20260814_143159));
        QCOMPARE(inbox->received(), 1.0);
        QVERIFY(inbox->lastAt().has_value());
        inbox->stop();
        QVERIFY(!inbox->watching());
    }

    /// 收件文件里原有的消息:没有在盯文件(服务没 start)也列进 status.seen,标 history,不判定、不发单;这次看见过的同一条只列一次
    void statusListsInboxFileAsHistory() {
        const OJson base = *fixture_.get(u"base"_s);
        const OJson script = js::object({{u"start"_s, js::N(double(Date_UTC_20260814_143159) + 60000)},
                                         {u"settings"_s, *js::parse(u"{\"follow\":{\"author_ids\":[\"local:老王\"],\"local_inbox\":true}}"_s)},
                                         {u"steps"_s, *js::parse(u"[{\"op\":\"call\",\"m\":\"status\",\"a\":[]}]"_s)}});
        Runner r(script, base);
        {
            QFile f(r.world.dir.path() + u"/follow-inbox.jsonl"_s);
            QVERIFY(f.open(QIODevice::WriteOnly));
            f.write("{\"v\":1,\"key\":\"k1\",\"seen_at\":\"2026-08-14T14:30:00.000Z\",\"author\":\"老王\",\"content\":\"早一条\"}\n"
                    "认不出的一行\n"
                    "{\"v\":1,\"key\":\"k2\",\"seen_at\":\"2026-08-14T14:31:59.000Z\",\"author\":\"路人\",\"content\":\"晚一条\"}\n"
                    "{\"v\":1,\"key\":\"k3\",\"seen_at\":\"2026-08-14T14:32:00.000Z\"");  // 正写到一半
        }
        const OJson steps = r.run(script);
        const OJson status = jsfix::dec(*steps.items[0].get(u"result"_s)->get(u"ok"_s));
        const OJson& seen = *status.get(u"seen"_s);
        QCOMPARE(seen.items.size(), 2);
        QCOMPARE(js::str(seen.items[0].get(u"text"_s)), u"晚一条"_s);
        QCOMPARE(js::str(seen.items[0].get(u"author_id"_s)), u"local:路人"_s);
        QCOMPARE(js::str(seen.items[0].get(u"source"_s)), u"local"_s);
        QVERIFY(!js::truthy(seen.items[0].get(u"trusted"_s)));
        QVERIFY(js::truthy(seen.items[0].get(u"history"_s)));
        QCOMPARE(js::str(seen.items[1].get(u"text"_s)), u"早一条"_s);
        QVERIFY(js::truthy(seen.items[1].get(u"trusted"_s)));
        // 只列出来:没有一条拿去判定、发单
        QVERIFY(status.get(u"recent"_s)->items.isEmpty());
        for (const OJson& e : r.world.log.items) QVERIFY(js::str(e.get(u"m"_s)) != u"engine.handleInstruction"_s);

        // 这次看见过的同一条(本地收件读进来的)不重复,也不再标 history
        DiscordMessage live;
        live.id = u"local:k2"_s;
        live.channel_id = u"local"_s;
        live.author_id = u"local:路人"_s;
        live.author_name = u"路人"_s;
        live.content = u"晚一条"_s;
        live.sentAtMs = double(Date_UTC_20260814_143159);
        const OJson again = r.run(js::object({{u"steps"_s, *js::parse(u"[{\"op\":\"call\",\"m\":\"onMessage\",\"a\":[%1]},{\"op\":\"call\",\"m\":\"status\",\"a\":[]}]"_s
                                                                            .arg(js::stringify(js::object({{u"id"_s, js::S(live.id)}, {u"channel_id"_s, js::S(live.channel_id)},
                                                                                                           {u"author_id"_s, js::S(live.author_id)}, {u"author_name"_s, js::S(live.author_name)},
                                                                                                           {u"content"_s, js::S(live.content)}, {u"sentAtMs"_s, js::N(live.sentAtMs)}}))))}}));
        const OJson seen2 = *jsfix::dec(*again.items[1].get(u"result"_s)->get(u"ok"_s)).get(u"seen"_s);
        QCOMPARE(seen2.items.size(), 2);
        QCOMPARE(js::str(seen2.items[0].get(u"text"_s)), u"晚一条"_s);
        QVERIFY(!js::truthy(seen2.items[0].get(u"history"_s)));
        QVERIFY(js::truthy(seen2.items[1].get(u"history"_s)));
    }

private:
    static constexpr qint64 Date_UTC_20260814_143159 = 1786717919000LL;
    OJson fixture_;
};

QTEST_MAIN(TstSvcFollow)
#include "tst_svc_follow.moc"
