// 蝶的止盈 / 回撤秒级出手(C++ 先有,TS 版没有,所以不对着 TS 夹具比;期望值由这里独立写出):
// 推送提前醒(orchestrate/fast_exit)与快速下跌时按跌速多让(analysis::momentumLead)。
// 三层:纯函数的已知答案;推送 → 该不该醒;合成的"一直往下跌"的行情里整条链跑到成交(假券商只在限价不高于**单子到达时**的立刻成交价才成交)。
// 对照组是同一份代码关掉这两样(chase_lead = 0、不提前醒)——那就是改之前的行为。
#include "js_fixture.h"

#include "analysis/tracker_rules.h"
#include "domain/positions.h"
#include "orchestrate/engine.h"
#include "util/js_runtime.h"
#include "util/jsobj.h"

#include <QElapsedTimer>
#include <QTemporaryDir>
#include <QTest>

#include <cmath>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
using ibkr::util::Task;
namespace js = ibkr::util::js;
namespace orch = ibkr::orchestrate;
namespace tk = ibkr::orchestrate::tracker;
namespace an = ibkr::analysis;

namespace {

// 2026-08-14 10:32 美东(盘中)
constexpr double kNoon = 1786717920000.0;
const double kStrikes[3] = {7600, 7615, 7630};

double r2(double x) { return std::round(x * 100) / 100; }

/// 一只多头看跌蝶的盘口,全由"立刻卖得掉的价"N 决定:中心腿 2.00 / 2.05,高翼 1.00 / 1.10,低翼 (N + 3.10) / (N + 3.20)。
/// 立刻卖得掉 = 低翼买 − 2 × 中心卖 + 高翼买 = N;中间价 = N + 0.15
std::array<std::pair<double, double>, 3> books(double n) { return {{{r2(n + 3.1), r2(n + 3.2)}, {2.0, 2.05}, {1.0, 1.1}}}; }

OJson legContract(int i) {
    return js::object({{u"secType"_s, js::S(u"OPT"_s)}, {u"symbol"_s, js::S(u"SPX"_s)}, {u"lastTradeDateOrContractMonth"_s, js::S(u"20260901"_s)},
                       {u"strike"_s, js::N(kStrikes[i])}, {u"right"_s, js::S(u"P"_s)}, {u"multiplier"_s, js::S(u"100"_s)}});
}

OJson legRow(int i, double qty, double cost, std::pair<double, double> book) {
    const OJson c = legContract(i);
    const QString ident = ibkr::domain::legOf(&c);
    return js::object({{u"key"_s, js::S(ibkr::domain::makeKey(u"模拟"_s, u"SPX"_s, u"OPT"_s, ident))},
                       {u"account"_s, js::S(u"模拟"_s)},
                       {u"symbol"_s, js::S(u"SPX"_s)},
                       {u"sec_type"_s, js::S(u"OPT"_s)},
                       {u"leg"_s, js::S(ident)},
                       {u"label"_s, js::S(ibkr::domain::positionLabel(u"SPX"_s, u"OPT"_s, &c))},
                       {u"quantity"_s, js::N(qty)},
                       {u"avg_cost"_s, js::N(cost)},
                       {u"multiplier"_s, js::N(100)},
                       {u"currency"_s, js::S(u"USD"_s)},
                       {u"market_price"_s, js::N(std::round((book.first + book.second) / 2 * 1e4) / 1e4)},
                       {u"market_value"_s, js::Null()},
                       {u"unrealized_pnl"_s, js::Null()},
                       {u"contract"_s, c}});
}

/// 假券商:行情按 market(t) 走;单子(下单、改价)在 latencyMs 之后到达,到达时限价不高于那一刻的 N 才成交、按 N 成交
class MarketRouter final : public orch::EngineRouter {
public:
    std::function<double(double)> market;
    double latencyMs = 300;
    double now = kNoon;
    bool closed = false;
    struct Sent {
        double at, limit;
        QString kind;
    };
    QList<Sent> orders;
    struct Pending {
        double arrive, limit;
    };
    QList<Pending> pending;
    std::optional<double> liveLimit;
    struct Fill {
        double at, price, limit;
    };
    std::optional<Fill> fill;
    std::function<void()> listener;
    /// place() 被调用那一刻(QElapsedTimer::nsecsElapsed 的读数,配合 stopwatch)
    QElapsedTimer* stopwatch = nullptr;
    qint64 placedAtNs = -1;
    /// optionQuotesNow 读的价可以和持仓那一行不一样(模拟"读完持仓才到的推送");空 = 同一个
    std::optional<double> cacheN;
    bool hosted = false;
    std::function<void(OJson&)> quotePatch;
    QList<qint64> modifiedIds;

    double n() const { return market(now - kNoon); }
    QList<OJson> rows() const {
        if (closed) return {};
        const auto b = books(n());
        // 每组成本 400 − 2 × 200 + 300 = 300(D = 3.00)
        return {legRow(0, 1, 400, b[0]), legRow(1, -2, 200, b[1]), legRow(2, 1, 300, b[2])};
    }
    OJson bookFor(const QList<OJson>& legRows, double nn) const {
        const auto b = books(nn);
        OJson out = js::object();
        for (const OJson& r : legRows) {
            const double strike = js::num(js::prop(js::prop(&r, u"contract"_s), u"strike"_s));
            for (int i = 0; i < 3; ++i)
                if (kStrikes[i] == strike) out.set(js::str(js::prop(&r, u"key"_s)), js::object({{u"bid"_s, js::N(b[i].first)}, {u"ask"_s, js::N(b[i].second)}}));
        }
        for (auto& [key, q] : out.fields) {
            (void)key;
            q.set(u"market_data_type"_s, js::N(1));
            q.set(u"bid_at"_s, js::N(now));
            q.set(u"ask_at"_s, js::N(now));
        }
        if (quotePatch) quotePatch(out);
        return out;
    }
    /// 到了的单子生效;生效的那张限价不高于此刻 N 就成交(卖出按 N,价格改善归自己)。回成交的单号
    std::optional<qint64> deliver() {
        QList<Pending> keep;
        for (const Pending& p : pending) {
            if (p.arrive <= now) liveLimit = p.limit;
            else keep << p;
        }
        pending = keep;
        if (closed || !liveLimit || *liveLimit > n() + 1e-9) return std::nullopt;
        fill = Fill{now - kNoon, n(), *liveLimit};
        closed = true;
        return 901;
    }

    // ---- EngineRouter
    Task<QList<OJson>> positions() override { co_return rows(); }
    Task<std::optional<double>> indexPrice(const QString&) override { co_return std::nullopt; }
    Task<std::vector<ibkr::execution::LegQuote>> legQuotes(OJson, ibkr::contract::AccountConfig) override { co_return std::vector<ibkr::execution::LegQuote>{}; }
    Task<ibkr::execution::PlacementResult> place(QString recordId, ibkr::parsing::validator::ApprovedOrder approved, std::optional<double>) override {
        const double limit = js::num(js::prop(js::prop(&approved.order, u"order"_s), u"lmtPrice"_s));
        orders << Sent{now, limit, u"place"_s};
        if (stopwatch && placedAtNs < 0) placedAtNs = stopwatch->nsecsElapsed();
        pending << Pending{now + latencyMs, limit};
        ibkr::execution::PlacementResult r;
        r.record_id = recordId;
        r.order_id = 901;
        r.status = u"Submitted"_s;
        r.limit_price = limit;
        co_return r;
    }
    Task<int> cancelAllOpen() override { co_return 0; }
    Task<QList<OJson>> listHostedOpenWith(std::optional<QString>) override { co_return QList<OJson>{}; }
    bool hasOptionQuotes() const override { return true; }
    Task<OJson> optionQuotes(QList<OJson> legRows) override { co_return bookFor(legRows, n()); }
    bool hasOptionQuotesNow() const override { return true; }
    OJson optionQuotesNow(const QList<OJson>& legRows) override { return bookFor(legRows, cacheN ? *cacheN : n()); }
    std::function<void()> onOptionTick(std::function<void()> l) override {
        listener = std::move(l);
        return [this]() { listener = {}; };
    }
    // ---- HostedRouter
    bool supportsHostedClose() const override { return hosted; }
    Task<ibkr::execution::HostedPlacement> placeHosted(ibkr::contract::AccountConfig, OJson, OJson item, QString, QString) override {
        orders << Sent{now, js::num(item.get(u"lmt_price"_s)), u"hosted"_s};
        ibkr::execution::HostedPlacement p;
        p.order_id = 901;
        p.status = u"Submitted"_s;
        co_return p;
    }
    Task<bool> modifyHosted(qint64 id, OJson item) override {
        modifiedIds << id;
        const double limit = js::num(js::prop(&item, u"lmt_price"_s));
        orders << Sent{now, limit, u"modify"_s};
        pending << Pending{now + latencyMs, limit};
        co_return !closed;
    }
    Task<bool> cancelHosted(qint64) override { co_return true; }
    // ---- ReconcileRouter / WakeRouter / AccountGuardRouter
    bool hasListOpenOrdersDetailed() const override { return false; }
    Task<QList<OJson>> listOpenOrdersDetailed() override { co_return QList<OJson>{}; }
    bool hasConnectedNames() const override { return false; }
    QStringList connectedNames() override { return {}; }
    int sessionCount() override { return 0; }
    ibkr::execution::SessionList sessions() override { return {}; }
};

template <class T>
T wait(Task<T> t) {
    QElapsedTimer clock;
    clock.start();
    while (!t.done() && clock.elapsed() < 5000) QCoreApplication::processEvents(QEventLoop::AllEvents, 5);
    if (!t.done()) qFatal("协程没跑完");
    return t.result();
}
inline void wait(Task<> t) {
    QElapsedTimer clock;
    clock.start();
    while (!t.done() && clock.elapsed() < 5000) QCoreApplication::processEvents(QEventLoop::AllEvents, 5);
    if (!t.done()) qFatal("协程没跑完");
    t.result();
}

ibkr::domain::EtNow etAt(double ms) { return ibkr::domain::etNowFromEpoch(ms); }

/// 一台引擎 + 假券商 + 一条利润回撤 30% 的蝶追踪(峰值 8.00、成本 3.00:线 = 3 + 5 × 0.7 = 6.50,中间价口径)
struct Rig {
    QTemporaryDir dir;
    std::shared_ptr<MarketRouter> router = std::make_shared<MarketRouter>();
    std::shared_ptr<ibkr::domain::TradeStore> store;
    std::unique_ptr<orch::TradingEngine> engine;
    QString trackId;
    double clockMs = kNoon;

    Rig(std::function<double(double)> market, double latencyMs, const OJson& autoExtra) {
        router->market = std::move(market);
        router->latencyMs = latencyMs;
        ibkr::util::setDateNowForTests([this] { return clockMs; });
        const OJson fx = jsfix::load(u"engine_core.json"_s);
        OJson base = jsfix::dec(*fx.get(u"base"_s));
        OJson policies = base.get(u"policies"_s) ? *base.get(u"policies"_s) : js::object();
        policies.set(u"auto_execute"_s, js::B(true));
        base.set(u"policies"_s, policies);
        base.set(u"storage"_s, js::object({{u"db_path"_s, js::S(dir.path() + u"/fx.db"_s)}}));
        orch::EngineArgs a;
        a.settings = ibkr::domain::fromDict(base);
        store = std::make_shared<ibkr::domain::TradeStore>(a.settings.db_path);
        a.store = store;
        a.router = router;
        a.notifier = std::make_shared<ibkr::util::Notifier>(false, std::vector<ibkr::util::Notifier::Sink>{});
        engine = std::make_unique<orch::TradingEngine>(std::move(a));
        engine->setTimerHook([](int ms, std::function<void()> fn) { QTimer::singleShot(ms, std::move(fn)); });
        engine->awakeClock = [this] { return clockMs; };
        QList<OJson> legs = router->rows();
        OJson fly;
        for (const OJson& r : ibkr::domain::withCombos(legs))
            if (js::str(js::prop(&r, u"sec_type"_s)) == u"BAG") fly = r;
        OJson autoClose = js::object({{u"enabled"_s, js::B(true)}, {u"order_type"_s, js::S(u"LMT"_s)}, {u"slippage_pct"_s, js::N(0.3)}});
        for (const auto& [k, v] : autoExtra.fields) autoClose.set(k, v);
        const OJson track = store->addTrack(js::object({{u"account"_s, js::S(u"模拟"_s)},
                                                                      {u"symbol"_s, js::S(u"SPX"_s)},
                                                                      {u"sec_type"_s, js::S(u"BAG"_s)},
                                                                      {u"leg"_s, *js::prop(&fly, u"leg"_s)},
                                                                      {u"contract"_s, *js::prop(&fly, u"contract"_s)},
                                                                      {u"targets"_s, js::object({{u"profit_drawdown_pct"_s, js::N(30)}})},
                                                                      {u"auto_close"_s, autoClose},
                                                                      {u"peak"_s, js::N(8.0)}}));
        trackId = js::str(js::prop(&track, u"id"_s));
    }
    ~Rig() {
        engine.reset();
        ibkr::util::setDateNowForTests({});
    }
    void at(double t) {
        clockMs = kNoon + t;
        router->now = clockMs;
    }
    void tick(bool early) {
        wait(engine->trackerTickOnce(etAt(clockMs), early));
        if (qEnvironmentVariableIsSet("FAST_TRACE")) std::fprintf(stderr, "t=%.0f %s\n", clockMs - kNoon, qPrintable(js::stringify(*engine->trackerLoop.get(u"poll"_s)).left(900)));
    }
    std::optional<double> peak() {
        const auto t = engine->storePort().getTrack(trackId);
        return js::finiteOrNull(js::prop(&*t, u"peak"_s));
    }
};

}  // namespace

class TstFlyFastExit : public QObject {
    Q_OBJECT
private slots:
    void initTestCase() { qputenv("DAFRI_PROMPT_DIR", (QStringLiteral(IBKR_FIXTURES_DIR) + u"/../../../prompts"_s).toUtf8()); }

    void rapidMoveKnownAnswers() {
        const QList<an::NaturalObs> falling{{0, 10}, {250, 11}, {500, 9.9}};
        const auto hit = an::rapidExitMove(falling, true, 1000, 10, 500);
        QVERIFY(hit);
        QCOMPARE(js::num(hit->get(u"from"_s)), 11.0);
        QVERIFY(!an::rapidExitMove(falling, true, 250, 11, 500));
        QVERIFY(!an::rapidExitMove(falling, true, 250, 10, 1000)); // 过期
        QVERIFY(!an::rapidExitMove({{500, 10}, {500, 8}}, true, 1000, 1, 500)); // 缓存不算两笔
        QVERIFY(an::rapidExitMove({{0, 10}, {500, 11}}, false, 1000, 10, 500));
        QVERIFY(!an::rapidExitMove({{0, 0}, {500, 1}}, false, 1000, 1, 500));
        const OJson reason = js::S(u"sweep:rapid_exit"_s);
        QVERIFY(an::isStopReason(&reason));
        const auto profile = an::chaseProfile(js::object({{u"stop_chase_grace"_s, js::N(0)}, {u"stop_chase_max_pct"_s, js::N(3)}}), &reason);
        QCOMPARE(profile.grace, 0.0);
        QCOMPARE(profile.maxPct, 3.0);
    }

    void rapidTriggersBeforeDrawdownAndOnlyOnce() {
        double n = 7;
        Rig rig([&](double) { return n; }, 10000, rapidSettings());
        rig.at(0); rig.tick(false);
        QVERIFY(rig.router->orders.isEmpty());
        n = 6.6; // 中间价 6.75,未触及原利润回撤线 6.50
        rig.at(500); rig.tick(true);
        QCOMPARE(rig.router->orders.size(), 1);
        QCOMPARE(js::str(rig.store->getTrack(rig.trackId)->get(u"fired_state"_s)), u"sweep:rapid_exit"_s);
        rig.at(1500); rig.tick(false);
        int places = 0;
        for (const auto& o : rig.router->orders) if (o.kind == u"place") ++places;
        QCOMPARE(places, 1);
    }

    void rapidPushWakesEngine() {
        double n = 7;
        Rig rig([&](double) { return n; }, 10000, rapidSettings());
        rig.engine->startTrackerLoop(60000);
        QTRY_VERIFY(js::num(rig.engine->trackerLoop.get(u"ticks"_s)) >= 1);
        n = 6.6; rig.at(500);
        rig.router->listener();
        QTRY_VERIFY_WITH_TIMEOUT(!rig.router->orders.isEmpty(), 3000);
        QCOMPARE(js::str(rig.store->getTrack(rig.trackId)->get(u"fired_state"_s)), u"sweep:rapid_exit"_s);
        rig.engine->stopTrackerLoop();
    }

    void rapidBadQuotesDoNotFire() {
        for (int kind = 0; kind < 6; ++kind) {
            double n = 7;
            Rig rig([&](double) { return n; }, 10000, rapidSettings());
            rig.at(0); rig.tick(false);
            n = 6.6; rig.at(500);
            rig.router->quotePatch = [kind](OJson& book) {
                OJson& q = book.fields.first().second;
                if (kind == 0) q.remove(u"bid_at"_s);
                if (kind == 1) q.set(u"market_data_type"_s, js::N(3));
                if (kind == 2) q.set(u"market_data_type"_s, js::N(2));
                if (kind == 3) q.set(u"ask_at"_s, js::N(kNoon + 9999));
                if (kind == 4) q.set(u"bid_at"_s, js::N(kNoon - 2000));
                if (kind == 5) q.set(u"bid"_s, js::N(100));
            };
            rig.tick(true);
            QVERIFY(rig.router->orders.isEmpty());
            rig.router->quotePatch = {};
            rig.at(600); rig.tick(true);
            QVERIFY(rig.router->orders.isEmpty()); // 恢复后重新积累,不跨坏报价比较
        }
    }

    void rapidWaitsForAsynchronousLegs() {
        double n = 7;
        Rig rig([&](double) { return n; }, 10000, rapidSettings());
        rig.at(0); rig.tick(false);
        n = 6.6; rig.at(500);
        rig.router->quotePatch = [](OJson& b) { b.fields.first().second.set(u"bid_at"_s, js::N(kNoon)); };
        rig.tick(true);
        QVERIFY(rig.router->orders.isEmpty());
        rig.router->quotePatch = {};
        rig.at(550); rig.tick(true);
        QCOMPARE(rig.router->orders.size(), 1); // 腿到齐才判,保留窗口内完整旧样本
    }

    void rapidResetAndAuthorization() {
        for (bool reset : {false, true}) {
            double n = 7;
            Rig rig([&](double) { return n; }, 10000, rapidSettings());
            rig.at(0); rig.tick(false);
            if (reset) rig.engine->fastExit().resetRapid();
            else rig.engine->killswitch().engage(u"x"_s);
            n = 6.6; rig.at(500); rig.tick(true);
            QVERIFY(rig.router->orders.isEmpty());
            QVERIFY(!js::truthy(rig.store->getTrack(rig.trackId)->get(u"fired_at"_s)));
        }
    }

    void rapidRejectsOverlappingSnapshots() {
        double n = 7;
        Rig rig([&](double) { return n; }, 10000, rapidSettings());
        rig.at(500);
        rig.router->quotePatch = [](OJson& b) { b.fields.first().second.set(u"bid_at"_s, js::N(kNoon + 400)); };
        rig.tick(false);
        n = 6.6; rig.at(600);
        rig.router->quotePatch = [](OJson& b) { b.fields.first().second.set(u"bid_at"_s, js::N(kNoon + 450)); };
        rig.tick(true); // 150ms 跨度虽合格,仍与旧快照重叠,不能作为一份全新的报价
        QVERIFY(rig.router->orders.isEmpty());
        rig.router->quotePatch = {};
        rig.at(650); rig.tick(true);
        QCOMPARE(rig.router->orders.size(), 1);
    }

    void rapidReusesHostedOrder() {
        double n = 7;
        OJson settings = rapidSettings();
        settings.set(u"host_at_broker"_s, js::B(true));
        Rig rig([&](double) { return n; }, 10000, settings);
        rig.router->hosted = true;
        rig.store->updateTrack(rig.trackId, js::object({{u"targets"_s, js::object({{u"take_profit"_s, js::N(10)}})}}));
        rig.at(0); rig.tick(false);
        QCOMPARE(rig.router->orders.size(), 1);
        QCOMPARE(rig.router->orders.first().kind, u"hosted"_s);
        n = 6.6; rig.at(500); rig.tick(true);
        QCOMPARE(js::str(rig.store->getTrack(rig.trackId)->get(u"fired_state"_s)), u"sweep:rapid_exit"_s);
        QCOMPARE(rig.router->orders.size(), 2);
        QCOMPARE(rig.router->orders.last().kind, u"modify"_s);
        QCOMPARE(rig.router->modifiedIds.last(), qint64(901));
    }

    // ---------------------------------------------------------------- 纯函数
    void momentumLeadKnownAnswers() {
        const auto obs = [](std::initializer_list<std::pair<double, double>> l) {
            QList<an::NaturalObs> out;
            for (const auto& [a, n] : l) out << an::NaturalObs{a, n};
            return out;
        };
        // 一秒前 6.00、此刻 5.50,窗口 1 秒:倍数 1 → 0.50,倍数 2 → 1.00
        QCOMPARE(an::momentumLead(obs({{0, 6.0}, {400, 5.8}, {1000, 5.5}}), true, 1000, 1, 1000), 0.5);
        QCOMPARE(an::momentumLead(obs({{0, 6.0}, {400, 5.8}, {1000, 5.5}}), true, 1000, 2, 1000), 1.0);
        // 窗口取「一个间隔之前或更早的最后一笔」:now = 1400 → 基准是 400 那笔 5.8
        QCOMPARE(an::momentumLead(obs({{0, 6.0}, {400, 5.8}, {1400, 5.5}}), true, 1000, 1, 1400), 0.3);
        // 历史不够一个间隔:拿最早那一笔(只会算少)
        QCOMPARE(an::momentumLead(obs({{0, 6.0}, {300, 5.9}}), true, 1000, 1, 300), 0.1);
        // 没在往不利方向走 → 0;空头不利是往上
        QCOMPARE(an::momentumLead(obs({{0, 5.5}, {1000, 6.0}}), true, 1000, 1, 1000), 0.0);
        QCOMPARE(an::momentumLead(obs({{0, 5.5}, {1000, 6.0}}), false, 1000, 1, 1000), 0.5);
        // 倍数 0、只有一笔、窗口非正 → 0
        QCOMPARE(an::momentumLead(obs({{0, 6.0}, {1000, 5.5}}), true, 1000, 0, 1000), 0.0);
        QCOMPARE(an::momentumLead(obs({{0, 6.0}}), true, 1000, 1, 1000), 0.0);
        QCOMPARE(an::momentumLead(obs({{0, 6.0}, {1000, 5.5}}), true, 0, 1, 1000), 0.0);
        // 改价间隔:没填 1 秒,填了按它
        QCOMPARE(an::chaseIntervalMs(js::object()), 1000.0);
        QCOMPARE(an::chaseIntervalMs(js::object({{u"chase_interval_s"_s, js::N(0.25)}})), 250.0);
    }

    void chaseLimitWithLead() {
        tk::Position fly;
        fly.symbol = u"SPX"_s;
        fly.sec_type = u"BAG"_s;
        fly.quantity = 1;
        fly.multiplier = 100;
        const OJson autoClose = tk::makeAutoClose(js::object({{u"chase_max_pct"_s, js::N(10)}}));
        const OJson reason = js::S(u"take_profit"_s);
        // lead = 0 与不传一样(改之前的行为)
        for (double rounds : {0.0, 1.0, 2.0, 3.0, 5.0, 40.0})
            QCOMPARE(tk::chaseLimit(fly, 6.0, std::nullopt, rounds, autoClose, &reason, 0), tk::chaseLimit(fly, 6.0, std::nullopt, rounds, autoClose, &reason));
        // 0.12 → 3 跳(0.05 一跳),往多让的一侧取
        QCOMPARE(tk::chaseLimit(fly, 6.0, std::nullopt, 0, autoClose, &reason, 0.12), 5.85);
        // 多让的加越等越让的,仍不超过上限(10% 的 6.00 = 0.60 = 12 跳)
        QCOMPARE(tk::chaseLimit(fly, 6.0, std::nullopt, 0, autoClose, &reason, 5), 5.4);
        QCOMPARE(tk::chaseLimit(fly, 6.0, std::nullopt, 6, autoClose, &reason, 0.5), 5.4);
        QCOMPARE(tk::chaseFloor(fly, 6.0, autoClose, &reason), 5.4);
        // makeAutoClose:没填不带这两个键(和 TS 版的样子一样),填了原样带
        const OJson made = tk::makeAutoClose(js::object());
        QVERIFY(!made.get(u"chase_lead"_s) && !made.get(u"chase_interval_s"_s));
        const OJson given = tk::makeAutoClose(js::object({{u"chase_lead"_s, js::N(0)}, {u"chase_interval_s"_s, js::Null()}}));
        QCOMPARE(js::num(given.get(u"chase_lead"_s)), 0.0);
        QVERIFY(given.get(u"chase_interval_s"_s) && js::nullish(given.get(u"chase_interval_s"_s)));
    }

    // ---------------------------------------------------------------- 合成行情
    // 立刻卖得掉的价从 7.00 起每秒跌 0.50(中间价从 7.15 起);中间价 1.3 秒时穿过 6.50 的回撤线
    static double falling(double t) { return r2(7.0 - 0.5 * (t / 1000)); }

    void baselineFallsBehind() {
        // 对照组(改之前:不多让、只按节拍):2 秒那一拍才触发,之后每次改价到达时价已经更低,7.3 秒才成交在 3.35
        Rig rig(falling, 300, js::object({{u"chase_lead"_s, js::N(0)}}));
        runLoop(rig, false);
        QVERIFY(!rig.router->orders.isEmpty());
        QCOMPARE(rig.router->orders.first().at, kNoon + 2000);
        QVERIFY(rig.router->fill);
        QCOMPARE(rig.router->fill->at, 7300.0);
        QCOMPARE(rig.router->fill->price, 3.35);
    }

    void pushWakeAndLeadCatchUp() {
        // 新行为(推送提前醒 + 按跌速多让 1 倍):1.5 秒那笔推送就醒,首单让到 5.70,1.8 秒到达时成交在 6.10
        Rig rig(falling, 300, js::object());
        runLoop(rig, true);
        QVERIFY(!rig.router->orders.isEmpty());
        QCOMPARE(rig.router->orders.first().at, kNoon + 1500);
        // 立刻成交价 6.25,上一秒跌了 0.50 → 多让 10 跳 = 5.75,再让 slippage 0.3% → 5.7328 → 朝成交方向取到 0.05:5.70
        QCOMPARE(rig.router->orders.first().limit, 5.7);
        QVERIFY(rig.router->fill);
        QCOMPARE(rig.router->fill->at, 1800.0);
        QCOMPARE(rig.router->fill->price, 6.1);
        QCOMPARE(rig.router->orders.size(), 1);
        // 审计里记着这一单是推送叫醒的那一轮发的
    }

    void wakeOnlyStillLags() {
        // 只提前醒、不多让:触发早半秒,但单子照样追不上,成交仍晚
        Rig rig(falling, 300, js::object({{u"chase_lead"_s, js::N(0)}}));
        runLoop(rig, true);
        QCOMPARE(rig.router->orders.first().at, kNoon + 1500);
        QVERIFY(rig.router->fill);
        QVERIFY(rig.router->fill->at > 3000);
        QVERIFY(rig.router->fill->price < 5.0);
    }

    void leadIsCapped() {
        // 跌得再快也不超过 chase_max_pct(这里 5%):每次挂出的价不低于「立刻成交价 × 95% 再往下一跳」再让 slippage
        const auto crash = [](double t) { return std::max(0.5, r2(7.0 - 2.0 * (t / 1000))); };
        Rig rig(crash, 300, js::object({{u"chase_max_pct"_s, js::N(5)}}));
        runLoop(rig, true, 4000);
        QVERIFY(!rig.router->orders.isEmpty());
        for (const auto& o : rig.router->orders) {
            const double n = crash(o.at - kNoon);
            QVERIFY2(o.limit >= std::floor((n * 0.95 - 0.05) * 0.997 * 20) / 20 - 1e-9, qPrintable(u"%1 < cap at n=%2"_s.arg(o.limit).arg(n)));
        }
    }

    void steadyMarketNoLead() {
        // 盘口一直不动,中间价 6.40 已经在回撤线 6.50 之下:第一拍就触发,首单和改之前一样(6.25 × 0.997 = 6.231 → 6.20)
        Rig rig([](double) { return 6.25; }, 300, js::object());
        runLoop(rig, true, 1000);
        QVERIFY(!rig.router->orders.isEmpty());
        QCOMPARE(rig.router->orders.first().at, kNoon);
        QCOMPARE(rig.router->orders.first().limit, 6.2);
    }

    // ---------------------------------------------------------------- 推送 → 该不该醒
    void pushWakesOnceOnCross() {
        double n = 7.0;
        Rig rig([&n](double) { return n; }, 300, js::object());
        int wakes = 0;
        rig.engine->fastExit().attach();
        rig.at(0);
        rig.tick(false);
        orch::FastExit& fe = rig.engine->fastExit();
        // 引擎的 wakeTracker 在节拍器没开时不管,看它有没有让一轮提前醒,用 earlyWake 计数:改走引擎跑一轮
        n = 6.6;  // 中间价 6.75,还在 6.50 之上
        fe.check(rig.clockMs);
        QVERIFY(rig.router->orders.isEmpty());
        wakes = countWakes(rig, 6.3);  // 中间价 6.45,穿过
        QCOMPARE(wakes, 1);
        QVERIFY(rig.router->orders.isEmpty());  // 推送这一路只叫醒,不发单
    }

    void midRoundPushNotLost() {
        // 这一轮读持仓之后才穿线(之后再没推送):排完当场对缓存再问一次,这一轮里就叫醒
        Rig rig([](double) { return 7.0; }, 300, js::object());
        rig.at(0);
        rig.tick(false);
        rig.engine->startTrackerLoop(60000);  // 节拍设成一分钟,等不到下一拍
        QTRY_VERIFY(js::num(rig.engine->trackerLoop.get(u"ticks"_s)) >= 2);  // 上面手动那一轮 + 节拍器自己的第一轮
        rig.router->cacheN = 6.25;  // 缓存里已经穿线,持仓那一行还是 7.00;之后不再有推送
        rig.tick(false);            // 这一轮按持仓判不触发;排完当场对缓存再问一次 → 叫醒
        QVERIFY(rig.router->orders.isEmpty());
        rig.router->market = [](double) { return 6.25; };  // 提前醒的那一轮读到的持仓也到了
        QTRY_VERIFY_WITH_TIMEOUT(!rig.router->orders.isEmpty(), 3000);
        rig.engine->stopTrackerLoop();
    }

    void earlyRoundDoesNotPushPeak() {
        double n = 7.0;
        Rig rig([&n](double) { return n; }, 300, js::object());
        rig.at(0);
        rig.tick(false);
        n = 9.0;  // 中间价 9.15,高过库里的峰值 8.00
        rig.at(300);
        rig.tick(true);
        QCOMPARE(*rig.peak(), 8.0);
        rig.at(1000);
        rig.tick(false);
        QCOMPARE(*rig.peak(), 9.15);
    }

    void chaseIntervalAndRounds() {
        // 间隔 0.25 秒:提前醒的那一轮改了价,轮数不变;0.1 秒后又提前醒一轮,不够间隔,不改价
        double n = 6.25;
        Rig rig([&n](double) { return n; }, 10000, js::object({{u"chase_interval_s"_s, js::N(0.25)}, {u"chase_max_pct"_s, js::N(1)}, {u"chase_lead"_s, js::N(0)}}));
        rig.at(0);
        rig.tick(false);
        QCOMPARE(rig.router->orders.size(), 1);
        n = 5.8;
        rig.at(400);
        rig.tick(true);
        QCOMPARE(rig.router->orders.size(), 2);
        QCOMPARE(rig.router->orders.last().kind, u"modify"_s);
        const OJson snap = rig.engine->closeChaseSnapshot();
        QCOMPARE(js::num(js::prop(js::prop(&snap, rig.trackId), u"rounds"_s)), 1.0);
        n = 5.6;
        rig.at(500);
        rig.tick(true);
        QCOMPARE(rig.router->orders.size(), 2);
    }

    void realLoopWakeLatency() {
        // 节拍设成一分钟(等不到下一拍),穿线的推送一到就发单;量出来的耗时打印出来(假券商,不含 TWS 往返)
        double n = 7.0;
        Rig rig([&n](double) { return n; }, 0, js::object());
        rig.engine->startTrackerLoop(60000);
        QTRY_VERIFY(js::num(rig.engine->trackerLoop.get(u"ticks"_s)) >= 1);
        QVERIFY(rig.router->listener);
        n = 6.25;
        QElapsedTimer t;
        t.start();
        rig.router->stopwatch = &t;
        rig.router->listener();
        QTRY_VERIFY_WITH_TIMEOUT(!rig.router->orders.isEmpty(), 3000);
        const qint64 us = rig.router->placedAtNs / 1000;
        std::fprintf(stderr, "[fast-exit] 推送 → placeOrder:%.1f ms(假券商)\n", us / 1000.0);
        QVERIFY(us < 250'000);
        rig.engine->stopTrackerLoop();
    }

private:
    static OJson rapidSettings() {
        return js::object({{u"rapid_exit_window_s"_s, js::N(1)}, {u"rapid_exit_pct"_s, js::N(5)}});
    }
    /// 推送那一路判一次;回它叫醒了几次(把引擎的 wake 换成计数:节拍器没开时引擎的 wakeTracker 什么也不做)
    static int countWakes(Rig& rig, double nAfter) {
        int wakes = 0;
        orch::FastExit fe([&rig]() -> orch::EngineRouter* { return rig.router.get(); }, [&wakes]() { ++wakes; });
        const OJson* poll = rig.engine->trackerLoop.get(u"poll"_s);
        QList<OJson> positions = rig.router->rows();
        OJson posMap = js::object();
        for (const OJson& p : ibkr::domain::withCombos(positions)) posMap.set(js::str(js::prop(&p, u"key"_s)), p);
        fe.arm(js::prop(poll, u"rows"_s)->items, posMap, [](const QString&) { return std::nullopt; }, etAt(rig.clockMs), [](const QString&) { return false; });
        const auto old = rig.router->market;
        rig.router->market = [nAfter](double) { return nAfter; };
        fe.check(rig.clockMs);
        fe.check(rig.clockMs);  // 同一轮里再来推送不连着叫
        rig.router->market = old;
        return wakes;
    }

    /// 虚拟时钟走一遍(见上面的 run):fast 时每 250 ms 一笔推送,叫醒了就当场跑一轮提前醒的
    static void runLoop(Rig& rig, bool fast, double untilMs = 12000) {
        int wakes = 0;
        orch::FastExit fe([&rig]() -> orch::EngineRouter* { return rig.router.get(); }, [&wakes]() { ++wakes; });
        for (double t = 0; t <= untilMs; t += 50) {
            rig.at(t);
            if (const auto filled = rig.router->deliver()) {
                rig.engine->closeChaseOnStatus(js::object({{u"order"_s, js::object({{u"orderId"_s, js::N(double(*filled))}})},
                                                            {u"orderStatus"_s, js::object({{u"status"_s, js::S(u"Filled"_s)}})}}));
                break;
            }
            if (std::fmod(t, 1000) == 0) {
                rig.tick(false);
                rearm(rig, fe);
            } else if (fast && std::fmod(t, 250) == 0) {
                const int before = wakes;
                fe.check(rig.clockMs);
                // 引擎自己那一份也记下这一笔立刻成交价(首单多让要的观察)
                rig.engine->fastExit().check(rig.clockMs);
                if (wakes > before) {
                    rig.tick(true);
                    rearm(rig, fe);
                }
            }
        }
    }
    static void rearm(Rig& rig, orch::FastExit& fe) {
        const OJson* poll = rig.engine->trackerLoop.get(u"poll"_s);
        OJson posMap = js::object();
        for (const OJson& p : ibkr::domain::withCombos(rig.router->rows())) posMap.set(js::str(js::prop(&p, u"key"_s)), p);
        const QString tid = rig.trackId;
        orch::TradingEngine* e = rig.engine.get();
        fe.arm(js::isArr(js::prop(poll, u"rows"_s)) ? js::prop(poll, u"rows"_s)->items : QList<OJson>{}, posMap, [](const QString&) { return std::nullopt; },
               etAt(rig.clockMs), [e](const QString& id) {
                   const OJson snap = e->closeChaseSnapshot();
                   return snap.get(id) != nullptr;
               });
        (void)tid;
    }
};

QTEST_GUILESS_MAIN(TstFlyFastExit)
#include "tst_fly_fast_exit.moc"
