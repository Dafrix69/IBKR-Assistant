// 盯盘停摆认定(WakeGuard)、出场状态(TrackExits)、账户风控输入(AccountGuard)对着原 TS 模块现跑的答案(fixtures/engine_guards.json,gen_engine_guards.mjs)。
#include "engine_world.h"
#include "orchestrate/account_guard.h"
#include "orchestrate/exits.h"
#include "orchestrate/wake_guard.h"

#include <QTest>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
using ibkr::util::Task;
namespace js = ibkr::util::js;
namespace orch = ibkr::orchestrate;
namespace wk = ibkr::orchestrate::wake;
namespace tk = ibkr::orchestrate::tracker;

namespace {

OJson liveJson(const wk::LiveTracks& l) { return js::object({{u"total"_s, js::N(l.total)}, {u"hosted"_s, js::N(l.hosted)}, {u"symbols"_s, js::strings(l.symbols)}}); }
OJson gapJson(const wk::WakeGap& g) {
    return js::object({{u"kind"_s, js::S(wk::gapKindName(g.kind))}, {u"from"_s, js::N(g.from)}, {u"to"_s, js::N(g.to)}, {u"stopped_ms"_s, js::N(g.stopped_ms)}, {u"asleep_ms"_s, js::N(g.asleep_ms)}});
}
OJson episodeJson(const wk::WakeEpisode& e) {
    return js::object({{u"kind"_s, js::S(wk::gapKindName(e.kind))}, {u"from"_s, js::N(e.from)}, {u"to"_s, js::N(e.to)}, {u"stopped_ms"_s, js::N(e.stopped_ms)}, {u"asleep_ms"_s, js::N(e.asleep_ms)},
                       {u"gaps"_s, js::N(e.gaps)}, {u"awake_ms"_s, js::N(e.awake_ms)}, {u"live"_s, liveJson(e.live)}});
}
OJson stepJson(const wk::WakeStep& s) {
    return js::object({{u"gap"_s, s.gap ? gapJson(*s.gap) : OJson::null()},
                       {u"hold"_s, js::S(s.hold)},
                       {u"released"_s, s.released ? js::object({{u"waited_ms"_s, js::N(s.released->waited_ms)}, {u"steady"_s, js::B(s.released->steady)}}) : OJson::null()},
                       {u"episode"_s, s.episode ? episodeJson(*s.episode) : OJson::null()}});
}

struct AuditSink final : orch::EngineStore {
    OJson* calls = nullptr;
    QList<OJson> workingList, tripsList;
    bool tripsThrow = false;
    QList<OJson> listTracks() override { return {}; }
    std::optional<OJson> getTrack(const QString&) override { return std::nullopt; }
    bool updateTrack(const QString&, const OJson&) override { return false; }
    void audit(const QString& actor, const QString& action, const OJson* detail) override {
        calls->items.append(js::array({js::S(u"audit"_s), js::S(actor), js::S(action), detail ? ew::jn(*detail) : OJson::null()}));
    }
    QString createRecord(OJson&) override { return {}; }
    void markSubmitIntent(const QString&) override {}
    void appendEvent(const QString&, const QString&, const OJson&) override {}
    void setFinalStatus(const QString&, const QString&, const std::optional<QString>&) override {}
    std::optional<OJson> getRecord(const QString&) override { return std::nullopt; }
    QList<OJson> listWorkingRecords(double, double) override { return {}; }
    QList<OJson> fillsByOrderRef(const QString&) override { return {}; }
    double rememberFills(const QList<OJson>&) override { return 0; }
    QList<OJson> workingOrders(double since, double now) override {
        calls->items.append(js::array({js::S(u"workingOrders"_s), js::N(since), js::N(now)}));
        return workingList;
    }
    QList<OJson> dailyLossTrips(double since, double now) override {
        calls->items.append(js::array({js::S(u"dailyLossTrips"_s), js::N(since), js::N(now)}));
        if (tripsThrow) throw ibkr::util::JsError(u"库坏了"_s);
        return tripsList;
    }
};

struct WakeRouterFake final : wk::WakeRouter {
    bool names = false;
    QStringList list;
    int count = 0;
    bool hasConnectedNames() const override { return names; }
    QStringList connectedNames() override { return list; }
    int sessionCount() override { return count; }
};

struct StubSession final : ibkr::execution::IbSession {
    bool connected = true, capPnl = false, capEquity = false;
    QStringList accounts;
    OJson pnl, equity;
    bool has(ibkr::execution::Cap c) const override {
        return (c == ibkr::execution::Cap::AccountPnl && capPnl) || (c == ibkr::execution::Cap::NetLiquidation && capEquity);
    }
    bool isConnected() override { return connected; }
    Task<> disconnect() override { co_return; }
    QStringList managedAccounts() override { return accounts; }
    Task<> qualifyContracts(std::vector<ibkr::execution::IbContract*>, int) override { co_return; }
    void reqMarketDataType(int) override {}
    std::shared_ptr<ibkr::execution::TickerHandle> subscribeTicker(const ibkr::execution::IbContract&, const QString&) override { return nullptr; }
    void cancelTicker(const ibkr::execution::IbContract&, const std::optional<QString>&) override {}
    Task<> settle(int) override { co_return; }
    Task<std::vector<ibkr::execution::RawBar>> historicalData(ibkr::execution::IbContract, ibkr::execution::HistoricalRequest) override { co_return std::vector<ibkr::execution::RawBar>{}; }
    Task<std::vector<ibkr::execution::OptChainParam>> secDefOptParams(QString, QString, int) override { co_return std::vector<ibkr::execution::OptChainParam>{}; }
    Task<ibkr::execution::Depth> mktDepth(ibkr::execution::IbContract, int, int) override { co_return ibkr::execution::Depth{}; }
    Task<ibkr::execution::TradeLike> placeOrder(ibkr::execution::IbContract, ibkr::execution::OrderIntent) override { co_return ibkr::execution::TradeLike{}; }
    Task<std::vector<ibkr::execution::OpenTrade>> openTrades() override { co_return std::vector<ibkr::execution::OpenTrade>{}; }
    Task<> cancelOrder(int) override { co_return; }
    Task<std::vector<ibkr::execution::PortfolioItemLike>> portfolio() override { co_return std::vector<ibkr::execution::PortfolioItemLike>{}; }
    Task<std::vector<ibkr::execution::PositionItemLike>> positions() override { co_return std::vector<ibkr::execution::PositionItemLike>{}; }
    std::optional<ibkr::execution::AccountPnl> accountPnl(const QString& id) override {
        const OJson* v = pnl.get(id);
        if (js::nullish(v)) return std::nullopt;
        ibkr::execution::AccountPnl p;
        p.daily = js::num(js::prop(v, u"daily"_s));
        p.currency = js::str(js::prop(v, u"currency"_s));
        p.atMs = js::num(js::prop(v, u"atMs"_s));
        return p;
    }
    std::optional<ibkr::execution::NetLiquidation> netLiquidation(const QString& id) override {
        const OJson* v = equity.get(id);
        if (js::nullish(v)) return std::nullopt;
        return ibkr::execution::NetLiquidation{js::num(js::prop(v, u"amount"_s)), js::str(js::prop(v, u"currency"_s))};
    }
    void onConnectivity(std::function<void(int)>) override {}
};

struct AccountRouterFake final : orch::AccountGuardRouter {
    QString kind;
    bool rowsThrow = false;
    QList<OJson> rows;
    ibkr::execution::SessionList list;
    OJson* calls = nullptr;
    Task<QList<OJson>> positions() override {
        calls->items.append(js::array({js::S(u"positions"_s)}));
        if (kind == u"throw" || rowsThrow) throw ibkr::util::JsError(u"读不到"_s);
        co_return rows;
    }
    ibkr::execution::SessionList sessions() override { return list; }
    QString broker() const override { return kind == u"futu" ? u"futu"_s : u"ibkr"_s; }
};

struct GuardHost final : orch::AccountGuardHost {
    ibkr::domain::Settings s;
    AccountRouterFake* r = nullptr;
    AuditSink* st = nullptr;
    const ibkr::domain::Settings& settings() const override { return s; }
    orch::AccountGuardRouter* router() override { return r; }
    orch::EngineStore& store() override { return *st; }
};

OJson pauseJson(const ibkr::util::ProtectionPause& p) { return js::object({{u"rule"_s, js::S(p.rule)}, {u"reason"_s, js::S(p.reason)}, {u"untilMs"_s, js::N(p.untilMs)}}); }
OJson stateJson(const ibkr::util::ProtectionState& s) {
    OJson cd = js::object(), ap = js::object();
    for (const QString& k : s.cooldowns.keys()) cd.set(k, pauseJson(*s.cooldowns.find(k)));
    for (const QString& k : s.accountPauses.keys()) ap.set(k, pauseJson(*s.accountPauses.find(k)));
    return js::object({{u"pause"_s, s.pause ? pauseJson(*s.pause) : OJson::null()}, {u"cooldowns"_s, cd}, {u"accountPauses"_s, ap}});
}

OJson probeOrder(const QString& account, int idx) {
    const OJson opt = js::object({{u"secType"_s, js::S(u"OPT"_s)}, {u"symbol"_s, js::S(u"SPX"_s)}, {u"lastTradeDateOrContractMonth"_s, js::S(u"20261016"_s)}, {u"strike"_s, js::N(7725)}, {u"right"_s, js::S(u"C"_s)}});
    const auto leg = [](double strike, const QString& action, double ratio) {
        return js::object({{u"lastTradeDateOrContractMonth"_s, js::S(u"20261016"_s)}, {u"strike"_s, js::N(strike)}, {u"right"_s, js::S(u"C"_s)}, {u"action"_s, js::S(action)}, {u"ratio"_s, js::N(ratio)}});
    };
    (void)account;
    if (idx == 0) return js::object({{u"contract"_s, opt}, {u"order"_s, js::object({{u"action"_s, js::S(u"SELL"_s)}, {u"totalQuantity"_s, js::N(1)}})}});
    if (idx == 1) return js::object({{u"contract"_s, opt}, {u"order"_s, js::object({{u"action"_s, js::S(u"SELL"_s)}, {u"totalQuantity"_s, js::N(5)}})}});
    return js::object({{u"contract"_s, js::object({{u"secType"_s, js::S(u"BAG"_s)}, {u"symbol"_s, js::S(u"SPX"_s)}, {u"legs"_s, js::array({leg(7725, u"SELL"_s, 1), leg(7750, u"BUY"_s, 2)})}})},
                       {u"order"_s, js::object({{u"action"_s, js::S(u"BUY"_s)}, {u"totalQuantity"_s, js::N(1)}})}});
}

QString recSub(const QString& s, const std::map<QString, QString>& recs) {
    QString out = s;
    static const QRegularExpression re(QStringLiteral("\\$\\{rec:([^}]+)\\}"));
    for (;;) {
        const auto m = re.match(out);
        if (!m.hasMatch()) break;
        const auto it = recs.find(m.captured(1));
        out.replace(m.capturedStart(), m.capturedLength(), it == recs.end() ? u"none"_s : it->second);
    }
    return out;
}
OJson subRec(const OJson& x, const std::map<QString, QString>& recs) {
    if (x.type == OJson::String) return js::S(recSub(x.s, recs));
    if (x.type == OJson::Array) {
        OJson o = js::array();
        for (const OJson& v : x.items) o.items.append(subRec(v, recs));
        return o;
    }
    if (x.type == OJson::Object) {
        OJson o = js::object();
        for (const auto& [k, v] : x.fields) o.set(k, subRec(v, recs));
        return o;
    }
    return x;
}

}  // namespace

class TstEngineGuards : public QObject {
    Q_OBJECT
private slots:
    void wakeSequences() {
        const OJson fx = jsfix::load(u"engine_guards.json"_s);
        int n = 0;
        for (const OJson& c0 : fx.get(u"wake"_s)->items) {
            const OJson samples = jsfix::dec(*c0.get(u"samples"_s));
            const OJson& expected = *c0.get(u"expected"_s);
            wk::WakeGuard wg;
            for (qsizetype i = 0; i < samples.items.size(); ++i) {
                const OJson& s = samples.items[i];
                if (ew::flag(s, u"pause"_s)) wg.pause();
                wk::WakeSample sample;
                sample.wall = ew::num(s, u"wall"_s);
                sample.mono = ew::num(s, u"mono"_s);
                sample.link = ew::str(s, u"link"_s);
                const OJson& live = *s.get(u"live"_s);
                sample.live.total = ew::num(live, u"total"_s);
                sample.live.hosted = ew::num(live, u"hosted"_s);
                for (const OJson& sym : live.get(u"symbols"_s)->items) sample.live.symbols << sym.s;
                const wk::WakeStep step = wg.step(sample);
                OJson audits = js::array(), notes = js::array(), logs = js::array();
                OJson calls = js::array();
                AuditSink store;
                store.calls = &calls;
                ibkr::util::Notifier notifier(false, {[&](const QString& t, const QString& sub, const QString& b) { notes.items.append(js::array({js::S(t), js::S(b), js::S(sub)})); }});
                wk::reportWake(step, store, notifier, [&](const QString& line) { logs.items.append(js::S(line)); });
                for (const OJson& a : calls.items) audits.items.append(js::array({a.items[1], a.items[2], a.items[3]}));
                OJson texts = js::object({{u"gap"_s, step.gap ? js::S(wk::gapLogLine(*step.gap)) : OJson::null()},
                                          {u"released"_s, step.released ? js::S(wk::releasedLogLine(*step.released)) : OJson::null()},
                                          {u"episode"_s, step.episode ? js::S(wk::episodeLogLine(*step.episode)) : OJson::null()},
                                          {u"audit"_s, step.episode ? wk::episodeAudit(*step.episode) : OJson::null()},
                                          {u"notice"_s, OJson::null()}});
                if (step.episode) {
                    if (const auto notice = wk::episodeNotice(*step.episode)) texts.set(u"notice"_s, js::object({{u"title"_s, js::S(notice->title)}, {u"body"_s, js::S(notice->body)}}));
                }
                const OJson got = js::object({{u"step"_s, stepJson(step)}, {u"texts"_s, texts}, {u"logs"_s, logs}, {u"audits"_s, audits}, {u"notes"_s, notes}});
                JSFIX_SAME(expected.items[i], got, u"wake #%1 步 %2"_s.arg(n).arg(i));
            }
            ++n;
        }
        QVERIFY(n > 20);
    }
    void wakePure() {
        const OJson fx = jsfix::load(u"engine_guards.json"_s);
        for (const OJson& c0 : fx.get(u"texts"_s)->items) {
            const OJson c = jsfix::dec(c0);
            const QString f = ew::str(c, u"f"_s);
            const OJson& a = *c.get(u"a"_s);
            QString got;
            if (f == u"duration") got = wk::durationText(a.items[0].n);
            else if (f == u"span") got = wk::spanText(a.items[0].n, a.items[1].n, a.items[2].b);
            else got = wk::holdReason();
            QCOMPARE(got, ew::str(c, u"expected"_s));
        }
        for (const OJson& c0 : fx.get(u"awake"_s)->items) {
            const OJson c = jsfix::dec(c0);
            std::vector<wk::CpuTimes> cpus;
            for (const OJson& t : c.get(u"cpus"_s)->items)
                cpus.push_back({ew::num(t, u"user"_s), ew::num(t, u"nice"_s), ew::num(t, u"sys"_s), ew::num(t, u"idle"_s), ew::num(t, u"irq"_s)});
            QCOMPARE(wk::awakeClockMs(cpus, ew::str(c, u"platform"_s), [] { return 4242.5; }), ew::num(c, u"expected"_s));
        }
        for (const OJson& c0 : fx.get(u"live"_s)->items) {
            const OJson c = jsfix::dec(c0);
            if (ew::str(c, u"f"_s) == u"link") {
                const QString caps = ew::str(c, u"caps"_s);
                WakeRouterFake r;
                r.names = caps == u"names" || caps == u"emptynames";
                for (const OJson& n : c.get(u"names"_s)->items) r.list << n.s;
                r.count = static_cast<int>(ew::num(c, u"count"_s));
                QCOMPARE(wk::linkOf(caps == u"null" ? nullptr : &r), ew::str(c, u"expected"_s));
            } else {
                QStringList chasing;
                for (const OJson& x : c.get(u"chasing"_s)->items) chasing << x.s;
                const wk::LiveTracks l = wk::liveTracksOf(c.get(u"tracks"_s)->items, [&](const QString& id) { return chasing.contains(id); });
                JSFIX_SAME(*c0.get(u"expected"_s), liveJson(l), u"liveTracks"_s);
            }
        }
    }
    void exits() {
        const OJson fx = jsfix::load(u"engine_guards.json"_s);
        const OJson base = jsfix::dec(*fx.get(u"base"_s));
        int n = 0;
        for (const OJson& c0 : fx.get(u"exits"_s)->items) {
            const OJson ops = jsfix::dec(*c0.get(u"ops"_s));
            double T = 1789142400000;
            int uuidN = 0;
            ibkr::util::setDateNowForTests([&] { return T; });
            ibkr::util::setRandomUUIDForTests([&] { return u"00000000-0000-4000-8000-%1"_s.arg(++uuidN, 12, 10, QChar(u'0')); });
            QTemporaryDir dir;
            ibkr::domain::TradeStore real(dir.path() + u"/e.db"_s);
            auto port = orch::makeStorePort(real);
            OJson notes = js::array();
            ibkr::util::Notifier notifier(false, {[&](const QString& t, const QString& sub, const QString& b) { notes.items.append(js::array({js::S(t), js::S(sub), js::S(b)})); }});
            struct H final : orch::ExitsHost {
                orch::EngineStore* s;
                ibkr::util::Notifier* n;
                orch::EngineStore& store() override { return *s; }
                ibkr::util::Notifier& notifier() override { return *n; }
            } host;
            host.s = port.get();
            host.n = &notifier;
            orch::TrackExits ex(host);
            std::map<QString, QString> names, recs;
            const OJson& expected = *c0.get(u"expected"_s);
            for (qsizetype i = 0; i < ops.items.size(); ++i) {
                const OJson& o = ops.items[i];
                notes = js::array();
                const QString op = ew::str(o, u"op"_s);
                OJson r = OJson::null();
                const auto trackOf = [&] { return real.getTrack(names[ew::str(o, u"track"_s)]); };
                const auto posOf = [&](const OJson* p) { return tk::makePosition(*p); };
                if (op == u"track") names[ew::str(o, u"name"_s)] = js::str(js::prop(&(const OJson&)real.addTrack(subRec(*o.get(u"spec"_s), recs)), u"id"_s));
                else if (op == u"record") {
                    OJson rec = js::object({{u"signature"_s, js::S(u"x"_s)}});
                    recs[ew::str(o, u"name"_s)] = real.createRecord(rec);
                    if (o.get(u"final"_s) && o.get(u"final"_s)->type == OJson::String) real.setFinalStatus(recs[ew::str(o, u"name"_s)], ew::str(o, u"final"_s));
                } else if (op == u"upd") real.updateTrack(names[ew::str(o, u"track"_s)], subRec(*o.get(u"fields"_s), recs));
                else if (op == u"round") ex.nextRound();
                else if (op == u"peak") {
                    const OJson* pr = o.get(u"price"_s);
                    r = js::NOrNull(ex.peakMark(names[ew::str(o, u"track"_s)], posOf(o.get(u"pos"_s)), js::nullish(pr) ? std::nullopt : std::optional<double>(pr->n), ew::flag(o, u"confirm"_s)));
                } else if (op == u"confirmSpot") {
                    std::optional<OJson> row;
                    if (!ew::flag(o, u"nullRow"_s)) row = *o.get(u"row"_s);
                    const auto res = ex.confirmSpot(names[ew::str(o, u"track"_s)], tk::makeTargets(*o.get(u"targets"_s)), row, ew::num(o, u"now"_s));
                    r = res ? *res : OJson::null();
                } else if (op == u"judge") {
                    orch::TrackExits::JudgeArgs a;
                    a.track = *trackOf();
                    a.position = posOf(o.get(u"pos"_s));
                    a.targets = tk::makeTargets(*o.get(u"targets"_s));
                    a.autoClose = tk::makeAutoClose(*o.get(u"auto"_s));
                    const OJson* pr = o.get(u"price"_s);
                    if (!js::nullish(pr)) a.price = pr->n;
                    if (const OJson* nat = o.get(u"natural"_s)) a.natural = js::nullish(nat) ? std::optional<double>() : std::optional<double>(nat->n);
                    a.at = ibkr::domain::etNowFromEpoch(ew::num(o, u"at"_s));
                    if (const OJson* st = o.get(u"spotTarget"_s)) a.spotTarget = *st;
                    if (const OJson* ss = o.get(u"spotStop"_s)) a.spotStop = *ss;
                    r = ex.judge(a);
                } else if (op == u"warn") r = js::B(ex.warnBlocked(*trackOf(), ew::str(o, u"state"_s)));
                else if (op == u"tierAuto") r = ex.tierAuto(*trackOf(), tk::makeTargets(*o.get(u"targets"_s)), *o.get(u"result"_s), tk::makeAutoClose(*o.get(u"auto"_s)), posOf(o.get(u"pos"_s)));
                else if (op == u"tierNotSent") ex.tierNotSent(*trackOf());
                else if (op == u"rearm") r = js::B(ex.rearmTier(*trackOf(), posOf(o.get(u"pos"_s))));
                else if (op == u"forget") {
                    QSet<QString> alive;
                    for (const OJson& a : o.get(u"alive"_s)->items) alive.insert(names[a.s]);
                    ex.forget(alive);
                }
                const OJson got = js::object({{u"r"_s, r}, {u"notes"_s, notes}, {u"tracks"_s, js::array(real.listTracks())}});
                JSFIX_SAME(expected.items[i], got, u"exits #%1 步 %2 %3"_s.arg(n).arg(i).arg(op));
            }
            OJson audits = js::array();
            for (const OJson& row : real.db().prepare(u"SELECT actor, action, detail FROM audit_log ORDER BY seq"_s).all()) audits.items.append(row);
            JSFIX_SAME(*c0.get(u"audits"_s), audits, u"exits #%1 audits"_s.arg(n));
            ibkr::util::setDateNowForTests({});
            ibkr::util::setRandomUUIDForTests({});
            ++n;
        }
        QVERIFY(n > 10);
        Q_UNUSED(base);
    }
    void account() {
        const OJson fx = jsfix::load(u"engine_guards.json"_s);
        const OJson base = jsfix::dec(*fx.get(u"base"_s));
        const double NOW = 1789142400000;
        int n = 0;
        for (const OJson& c0 : fx.get(u"account"_s)->items) {
            const OJson c = jsfix::dec(c0);
            ibkr::util::setDateNowForTests([&] { return NOW; });
            OJson calls = js::array();
            GuardHost host;
            host.s = ibkr::domain::fromDict(ew::deepMerge(base, *c.get(u"cfgPatch"_s)));
            AuditSink store;
            store.calls = &calls;
            store.workingList = c.get(u"working"_s)->items;
            store.tripsList = c.get(u"trips"_s)->items;
            store.tripsThrow = ew::flag(c, u"tripsThrow"_s);
            host.st = &store;
            AccountRouterFake router;
            router.kind = ew::str(c, u"routerKind"_s);
            router.rows = c.get(u"rows"_s)->items;
            router.calls = &calls;
            for (const OJson& s : c.get(u"sessions"_s)->items) {
                auto sess = std::make_shared<StubSession>();
                sess->connected = ew::flag(s, u"connected"_s);
                for (const OJson& a : s.get(u"accounts"_s)->items) sess->accounts << a.s;
                sess->capPnl = ew::flag(*s.get(u"caps"_s), u"pnl"_s);
                sess->capEquity = ew::flag(*s.get(u"caps"_s), u"equity"_s);
                sess->pnl = *s.get(u"pnl"_s);
                sess->equity = *s.get(u"equity"_s);
                router.list.push_back(sess);
            }
            host.r = router.kind == u"null" ? nullptr : &router;
            orch::AccountGuard guard(host);
            const OJson& expected = *c0.get(u"expected"_s)->get(u"results"_s);
            const OJson& ops = *c.get(u"ops"_s);
            for (qsizetype i = 0; i < ops.items.size(); ++i) {
                const OJson& o = ops.items[i];
                const QString op = ew::str(o, u"op"_s);
                OJson got;
                const double nowMs = ew::num(o, u"nowMs"_s);
                if (op == u"extras") {
                    router.rowsThrow = ew::str(o, u"rowsNext"_s) == u"throw";
                    auto ex = guard.validatorExtras(o.get(u"nowMs"_s) ? std::optional<double>(nowMs) : std::nullopt).result();
                    const auto probes = [&] {
                        OJson p = js::array();
                        for (int k = 0; k < 3; ++k) {
                            const OJson po = probeOrder(u"模拟"_s, k);
                            p.items.append(js::B(ex.isReduction(po, u"模拟"_s)));
                        }
                        return p;
                    };
                    OJson p1 = OJson::null(), p2 = OJson::null();
                    if (ex.isReduction) p1 = probes();
                    if (ex.consumeReduction) ex.consumeReduction(probeOrder(u"模拟"_s, 0), u"模拟"_s);
                    if (ex.isReduction) p2 = probes();
                    got = js::object();
                    if (ex.exposure) got.set(u"exposure"_s, *ex.exposure);
                    if (ex.equity) {
                        OJson eq = js::object();
                        for (const QString& k : ex.equity->keys()) eq.set(k, js::N(*ex.equity->find(k)));
                        got.set(u"equity"_s, eq);
                    }
                    if (!ex.capNote.isEmpty()) got.set(u"capNote"_s, js::S(ex.capNote));
                    got.set(u"has"_s, js::array({js::B(bool(ex.isReduction)), js::B(bool(ex.consumeReduction))}));
                    got.set(u"probes"_s, p1);
                    got.set(u"probes2"_s, p2);
                } else if (op == u"reduceOnly") {
                    router.rowsThrow = false;
                    ibkr::parsing::validator::ApprovedOrder a;
                    a.order = probeOrder(ew::str(o, u"alias"_s), static_cast<int>(ew::num(o, u"idx"_s)));
                    a.account.alias = ew::str(o, u"alias"_s);
                    got = js::B(guard.isReduceOnly(a).result());
                } else if (op == u"dailyPnl") {
                    const auto m = guard.dailyPnl(nowMs);
                    got = OJson::null();
                    if (m) {
                        got = js::object();
                        for (const QString& k : m->keys()) got.set(k, js::N(*m->find(k)));
                    }
                } else if (op == u"protections") {
                    std::vector<ibkr::util::CloseEvent> closes;
                    for (const OJson& e : o.get(u"closes"_s)->items) closes.push_back({ew::num(e, u"atMs"_s), ew::str(e, u"symbol"_s), ew::str(e, u"state"_s), ew::str(e, u"leg"_s)});
                    std::vector<ibkr::util::PnlEvent> pnl;
                    for (const OJson& e : o.get(u"pnl"_s)->items) pnl.push_back({ew::num(e, u"atMs"_s), ew::num(e, u"pnl"_s)});
                    got = stateJson(guard.protections(host.s.protections, closes, pnl, nowMs));
                } else {
                    ibkr::util::ProtectionState st;
                    for (const auto& [k, v] : o.get(u"pauses"_s)->fields) st.accountPauses.insert(k, ibkr::util::ProtectionPause{ew::str(v, u"rule"_s), ew::str(v, u"reason"_s), ew::num(v, u"untilMs"_s)});
                    got = stateJson(guard.withLatch(st, nowMs));
                }
                JSFIX_SAME(expected.items[i], got, u"account #%1 步 %2 %3"_s.arg(n).arg(i).arg(op));
            }
            JSFIX_SAME(*c0.get(u"expected"_s)->get(u"calls"_s), calls, u"account #%1 calls"_s.arg(n));
            ibkr::util::setDateNowForTests({});
            ++n;
        }
        QVERIFY(n > 50);
    }
};

QTEST_GUILESS_MAIN(TstEngineGuards)
#include "tst_engine_guards.moc"
