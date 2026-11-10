// 财报止盈(C++ 先有,不对着 TS 夹具比;期望值由这里独立写出):
// 纯函数的已知答案(窗口怎么排、夜盘怎么认、拿哪个价判),以及接进引擎之后的整条链——
// 假券商给财报日历、日线、买卖价,看它什么时候上膛、按哪个价判、盘后与夜盘发出去的单长什么样、发出去之后追不追。
#include "js_fixture.h"

#include "analysis/earnings_tp.h"
#include "domain/positions.h"
#include "orchestrate/engine.h"
#include "util/js_runtime.h"
#include "util/jsobj.h"

#include <QElapsedTimer>
#include <QTemporaryDir>
#include <QTest>
#include <QTimeZone>

#include <cmath>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
using ibkr::util::Task;
namespace js = ibkr::util::js;
namespace orch = ibkr::orchestrate;
namespace etp = ibkr::analysis::etp;

namespace {

double et(int y, int m, int d, int h, int mi, int s = 0) {
    return double(QDateTime(QDate(y, m, d), QTime(h, mi, s), QTimeZone("America/New_York")).toMSecsSinceEpoch());
}

etp::Calendar weekdays(QStringList holidays = {}, QStringList early = {}) {
    etp::Calendar c;
    c.tradingDay = [holidays](const QString& d) { return QDate::fromString(d, Qt::ISODate).dayOfWeek() <= 5 && !holidays.contains(d); };
    c.earlyClose = [early](const QString& d) { return early.contains(d); };
    return c;
}

OJson stockRow(double qty, double last) {
    const OJson c = js::object({{u"secType"_s, js::S(u"STK"_s)}, {u"symbol"_s, js::S(u"NVDA"_s)}, {u"exchange"_s, js::S(u"SMART"_s)}, {u"currency"_s, js::S(u"USD"_s)}});
    return js::object({{u"key"_s, js::S(ibkr::domain::makeKey(u"模拟"_s, u"NVDA"_s, u"STK"_s))},
                       {u"account"_s, js::S(u"模拟"_s)},
                       {u"symbol"_s, js::S(u"NVDA"_s)},
                       {u"sec_type"_s, js::S(u"STK"_s)},
                       {u"leg"_s, js::S(QString())},
                       {u"quantity"_s, js::N(qty)},
                       {u"avg_cost"_s, js::N(90)},
                       {u"multiplier"_s, js::N(1)},
                       {u"currency"_s, js::S(u"USD"_s)},
                       {u"market_price"_s, js::N(last)},
                       {u"market_value"_s, js::Null()},
                       {u"unrealized_pnl"_s, js::Null()},
                       {u"contract"_s, c}});
}

/// 假券商:一只正股持仓;财报日历、日线、买卖价都由测试摆
class StockRouter final : public orch::EngineRouter {
public:
    double qty = 100;
    double last = 104;  // 持仓行里的"现价"(盘后可能是几分钟前的一笔):财报止盈不该拿它判
    std::optional<double> bid, ask;
    bool closed = false, hosted = false;
    QString earningsDate = u"2026-08-13"_s, earningsTiming = u"AFTER MARKET"_s, earningsStatus = u"CONFIRMED"_s;
    bool earningsFail = false;
    double refClose = 100;
    int earningsCalls = 0, barCalls = 0;
    QList<bool> bookVenues;  // 每次读买卖价要的是不是夜盘
    struct Sent {
        QString kind;
        OJson order;  // place:整张 ApprovedOrder.order;modify:改单项
    };
    QList<Sent> orders;

    Task<QList<OJson>> positions() override {
        if (closed) co_return QList<OJson>{};
        co_return QList<OJson>{stockRow(qty, last)};
    }
    Task<std::optional<double>> indexPrice(const QString&) override { co_return std::nullopt; }
    Task<std::vector<ibkr::execution::LegQuote>> legQuotes(OJson, ibkr::contract::AccountConfig) override { co_return std::vector<ibkr::execution::LegQuote>{}; }
    Task<ibkr::execution::PlacementResult> place(QString recordId, ibkr::parsing::validator::ApprovedOrder approved, std::optional<double>) override {
        orders << Sent{u"place"_s, approved.order};
        ibkr::execution::PlacementResult r;
        r.record_id = recordId;
        r.order_id = 901;
        r.status = u"Submitted"_s;
        co_return r;
    }
    Task<int> cancelAllOpen() override { co_return 0; }
    Task<QList<OJson>> listHostedOpenWith(std::optional<QString>) override { co_return QList<OJson>{}; }
    bool supportsHostedClose() const override { return hosted; }
    Task<ibkr::execution::HostedPlacement> placeHosted(ibkr::contract::AccountConfig, OJson, OJson item, QString, QString) override {
        orders << Sent{u"hosted"_s, item};
        ibkr::execution::HostedPlacement p;
        p.order_id = 902;
        p.status = u"Submitted"_s;
        co_return p;
    }
    Task<bool> modifyHosted(qint64, OJson item) override {
        orders << Sent{u"modify"_s, item};
        co_return true;
    }
    Task<bool> cancelHosted(qint64) override { co_return true; }
    bool hasListOpenOrdersDetailed() const override { return false; }
    Task<QList<OJson>> listOpenOrdersDetailed() override { co_return QList<OJson>{}; }
    bool hasConnectedNames() const override { return false; }
    QStringList connectedNames() override { return {}; }
    int sessionCount() override { return 0; }
    ibkr::execution::SessionList sessions() override { return {}; }

    // ---- 财报止盈的三路
    bool hasEarningsData() const override { return true; }
    Task<OJson> earnings(QString) override {
        ++earningsCalls;
        if (earningsFail) throw ibkr::util::JsError(u"WSH 没有权限"_s);
        co_return js::array({js::object({{u"event_type"_s, js::S(u"wshe_ed"_s)},
                                         {u"data"_s, js::object({{u"earnings_date"_s, js::S(earningsDate)},
                                                                 {u"time_of_day"_s, js::S(earningsTiming)},
                                                                 {u"wshe_earnings_date_status"_s, js::S(earningsStatus)},
                                                                 {u"quarter"_s, js::S(u"Q2"_s)}})}})});
    }
    Task<QList<OJson>> dailyBars(QString, QString start, QString) override {
        ++barCalls;
        co_return QList<OJson>{js::object({{u"date"_s, js::S(start)}, {u"close"_s, js::N(refClose)}})};
    }
    Task<OJson> stockBook(QString, bool overnight) override {
        bookVenues << overnight;
        if (!bid && !ask) co_return OJson::null();
        co_return js::object({{u"bid"_s, bid ? js::N(*bid) : js::Null()}, {u"ask"_s, ask ? js::N(*ask) : js::Null()}, {u"last"_s, js::N(last)}});
    }
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

/// 手填好窗口的那一份 targets.earnings_tp:2026-08-13(周四)盘后发,基准 08-13 收盘,反应日 08-14
OJson plannedTp(double pct, std::optional<double> refClose) {
    return js::object({{u"pct"_s, js::N(pct)}, {u"manual"_s, js::B(true)}, {u"date"_s, js::S(u"2026-08-13"_s)}, {u"timing"_s, js::S(etp::kAfter)},
                       {u"ref_date"_s, js::S(u"2026-08-13"_s)}, {u"react_date"_s, js::S(u"2026-08-14"_s)},
                       {u"start_ms"_s, js::N(et(2026, 8, 13, 16, 0))}, {u"end_ms"_s, js::N(et(2026, 8, 14, 16, 0))},
                       {u"ref_close"_s, refClose ? js::N(*refClose) : js::Null()}});
}

struct Rig {
    QTemporaryDir dir;
    std::shared_ptr<StockRouter> router = std::make_shared<StockRouter>();
    std::shared_ptr<ibkr::domain::TradeStore> store;
    std::unique_ptr<orch::TradingEngine> engine;
    QString trackId;
    double clockMs = 0;

    Rig(const OJson& earningsTp, double startAt, const OJson& autoExtra = js::object(), const OJson& moreTargets = js::object(), double qty = 100) {
        clockMs = startAt;
        router->qty = qty;
        ibkr::util::setDateNowForTests([this] { return clockMs; });
        const OJson fx = jsfix::load(u"engine_core.json"_s);
        OJson base = jsfix::dec(*fx.get(u"base"_s));
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
        OJson autoClose = js::object({{u"enabled"_s, js::B(true)}, {u"order_type"_s, js::S(u"MKT"_s)}, {u"slippage_pct"_s, js::N(0.3)}});
        for (const auto& [k, v] : autoExtra.fields) autoClose.set(k, v);
        OJson targets = js::object({{u"earnings_tp"_s, earningsTp}});
        for (const auto& [k, v] : moreTargets.fields) targets.set(k, v);
        const OJson row = stockRow(qty, 104);
        const OJson track = store->addTrack(js::object({{u"account"_s, js::S(u"模拟"_s)},
                                                        {u"symbol"_s, js::S(u"NVDA"_s)},
                                                        {u"sec_type"_s, js::S(u"STK"_s)},
                                                        {u"leg"_s, js::S(QString())},
                                                        {u"contract"_s, *row.get(u"contract"_s)},
                                                        {u"targets"_s, targets},
                                                        {u"auto_close"_s, autoClose},
                                                        {u"peak"_s, js::N(104)}}));
        trackId = js::str(js::prop(&track, u"id"_s));
    }
    ~Rig() {
        engine.reset();
        ibkr::util::setDateNowForTests({});
    }
    OJson tick(double at) {
        clockMs = at;
        wait(engine->trackerTickOnce(ibkr::domain::etNowFromEpoch(clockMs), false));
        const OJson* poll = engine->trackerLoop.get(u"poll"_s);
        const OJson* rows = js::prop(poll, u"rows"_s);
        return js::isArr(rows) && !rows->items.isEmpty() ? rows->items.first() : js::object();
    }
    OJson stored() {
        const auto t = store->getTrack(trackId);
        return *js::prop(js::prop(&*t, u"targets"_s), u"earnings_tp"_s);
    }
    QString firedState() {
        const auto t = store->getTrack(trackId);
        return js::strOr(js::prop(&*t, u"fired_state"_s), QString());
    }
    int count(const QString& kind) const {
        int n = 0;
        for (const auto& o : router->orders) n += o.kind == kind;
        return n;
    }
};

QString phaseOf(const OJson& row) { return js::str(js::prop(js::prop(&row, u"earnings_tp"_s), u"phase"_s)); }
QString reasonOf(const OJson& row) { return js::str(js::prop(js::prop(&row, u"earnings_tp"_s), u"reason"_s)); }

}  // namespace

class TstEarningsTp : public QObject {
    Q_OBJECT
private slots:
    void initTestCase() { qputenv("DAFRI_PROMPT_DIR", (QStringLiteral(IBKR_FIXTURES_DIR) + u"/../../../prompts"_s).toUtf8()); }

    // ---------------------------------------------------------------- 纯函数
    void windowAfterMarket() {
        const auto p = etp::planWindow(u"2026-08-13"_s, etp::kAfter, weekdays());
        QVERIFY(p.window);
        QCOMPARE(p.window->refDate, u"2026-08-13"_s);
        QCOMPARE(p.window->reactDate, u"2026-08-14"_s);
        QCOMPARE(p.window->startMs, et(2026, 8, 13, 16, 0));
        QCOMPARE(p.window->endMs, et(2026, 8, 14, 16, 0));
    }
    void windowBeforeMarketSkipsWeekendAndHoliday() {
        // 周一盘前发:基准是上周五;上周五休市就再往前
        auto p = etp::planWindow(u"2026-08-17"_s, etp::kBefore, weekdays());
        QVERIFY(p.window);
        QCOMPARE(p.window->refDate, u"2026-08-14"_s);
        QCOMPARE(p.window->reactDate, u"2026-08-17"_s);
        QCOMPARE(p.window->startMs, et(2026, 8, 14, 16, 0));
        QCOMPARE(p.window->endMs, et(2026, 8, 17, 16, 0));
        p = etp::planWindow(u"2026-08-17"_s, etp::kBefore, weekdays({u"2026-08-14"_s}));
        QCOMPARE(p.window->refDate, u"2026-08-13"_s);
        // 周五盘后发:反应日是下周一
        p = etp::planWindow(u"2026-08-14"_s, etp::kAfter, weekdays());
        QCOMPARE(p.window->reactDate, u"2026-08-17"_s);
    }
    void windowEarlyCloseAndRejects() {
        // 基准日提前收盘:13:00 就开窗
        const auto p = etp::planWindow(u"2026-11-27"_s, etp::kAfter, weekdays({}, {u"2026-11-27"_s}));
        QCOMPARE(p.window->startMs, et(2026, 11, 27, 13, 0));
        QVERIFY(!etp::planWindow(u"2026-08-15"_s, etp::kAfter, weekdays()).window);    // 周六
        QVERIFY(!etp::planWindow(u"2026-08-13"_s, u"DURING MARKET"_s, weekdays()).window);
        QVERIFY(!etp::planWindow(u"2026-08-13"_s, QString(), weekdays()).window);
        QVERIFY(!etp::planWindow(u"0813"_s, etp::kAfter, weekdays()).window);
        QVERIFY(!etp::planWindow(u"2026-08-13"_s, etp::kAfter, weekdays({u"2026-08-13"_s})).window);
    }
    void overnightSession() {
        const auto cal = weekdays({u"2026-08-14"_s});
        const auto at = [&](const QString& base, const QString& d, double h) { return etp::stockSession(base, d, h * 3600, cal); };
        QCOMPARE(at(u"盘后"_s, u"2026-08-12"_s, 17), u"盘后"_s);           // 不是休市的原样
        QCOMPARE(at(u"休市"_s, u"2026-08-12"_s, 20), etp::kOvernight);     // 周三 20:00:归周四
        QCOMPARE(at(u"休市"_s, u"2026-08-13"_s, 3.5), etp::kOvernight);    // 周四 03:30
        QCOMPARE(at(u"休市"_s, u"2026-08-13"_s, 3.9), u"休市"_s);          // 03:50–04:00 两头不靠
        QCOMPARE(at(u"休市"_s, u"2026-08-13"_s, 21), u"休市"_s);           // 周四晚:归周五,周五休市
        QCOMPARE(at(u"休市"_s, u"2026-08-15"_s, 1), u"休市"_s);            // 周六凌晨
        QCOMPARE(at(u"休市"_s, u"2026-08-16"_s, 20.5), etp::kOvernight);   // 周日晚:归周一
        QCOMPARE(at(u"休市"_s, u"2026-08-14"_s, 21), u"休市"_s);           // 周五晚:归周六
    }
    void pricesKnownAnswers() {
        QCOMPARE(*etp::targetPrice(true, 100, 8), 108.0);
        QCOMPARE(*etp::targetPrice(false, 100, 8), 92.0);
        QVERIFY(!etp::targetPrice(true, 0, 8));
        QVERIFY(!etp::targetPrice(false, 100, 100));
        QCOMPARE(*etp::executable(true, 107.9, 108.4), 107.9);   // 多头要卖:看买价
        QCOMPARE(*etp::executable(false, 107.9, 108.4), 108.4);  // 空头要买回:看卖价
        QVERIFY(!etp::executable(true, std::nullopt, 108.4));
        QVERIFY(!etp::executable(true, 108.5, 108.4));  // 倒挂
        QVERIFY(!etp::executable(true, 0, 108.4));
        QVERIFY(etp::reached(true, 108, 108));
        QVERIFY(!etp::reached(true, 108, 107.99));
        QVERIFY(etp::reached(false, 92, 91.5));
        QVERIFY(etp::pctIssue(0));
        QVERIFY(etp::pctIssue(501));
        QVERIFY(!etp::pctIssue(8));
    }

    // ---------------------------------------------------------------- 接进引擎
    /// 没填财报日:照日历排窗口 → 收盘后取基准收盘价 → 盘后按买价判 → 发盘外限价单 → 追价
    void afterHoursEndToEnd() {
        Rig rig(js::object({{u"pct"_s, js::N(8)}, {u"manual"_s, js::B(false)}}), et(2026, 8, 13, 15, 0));
        rig.router->bid = 109;  // 窗口没开:再高也不判
        rig.router->ask = 109.2;
        OJson row = rig.tick(et(2026, 8, 13, 15, 0));
        QCOMPARE(phaseOf(row), u"waiting"_s);
        QCOMPARE(js::str(rig.stored().get(u"ref_date"_s)), u"2026-08-13"_s);
        QCOMPARE(js::num(rig.stored().get(u"end_ms"_s)), et(2026, 8, 14, 16, 0));
        QCOMPARE(rig.router->earningsCalls, 1);
        QVERIFY(rig.router->orders.isEmpty());
        QVERIFY(rig.router->bookVenues.isEmpty());

        // 刚收盘:收盘竞价那一笔还没进日线,先不取
        row = rig.tick(et(2026, 8, 13, 16, 0, 30));
        QCOMPARE(phaseOf(row), u"armed"_s);
        QCOMPARE(rig.router->barCalls, 0);
        rig.tick(et(2026, 8, 13, 16, 1, 30));
        QCOMPARE(rig.router->barCalls, 1);
        rig.router->bid = 105;
        rig.router->ask = 105.3;
        rig.router->last = 109;  // 持仓行里的最新成交价过线了,买价没到:不算
        row = rig.tick(et(2026, 8, 13, 16, 1, 31));
        QCOMPARE(js::num(rig.stored().get(u"ref_close"_s)), 100.0);
        QCOMPARE(js::num(js::prop(js::prop(&row, u"earnings_tp"_s), u"target"_s)), 108.0);
        QCOMPARE(js::str(row.get(u"state"_s)), u"holding"_s);
        QVERIFY(rig.router->orders.isEmpty());
        QCOMPARE(rig.router->bookVenues.last(), false);

        // 买价到了
        rig.router->bid = 108.5;
        rig.router->ask = 108.9;
        row = rig.tick(et(2026, 8, 13, 16, 5));
        QCOMPARE(rig.count(u"place"_s), 1);
        const OJson sent = rig.router->orders.first().order;
        const OJson* order = sent.get(u"order"_s);
        QCOMPARE(js::str(order->get(u"action"_s)), u"SELL"_s);
        QCOMPARE(js::str(order->get(u"orderType"_s)), u"LMT"_s);  // 设的是市价,盘后一律限价
        QCOMPARE(js::truthy(order->get(u"outsideRth"_s)), true);
        QCOMPARE(js::num(order->get(u"totalQuantity"_s)), 100.0);
        QCOMPARE(js::str(sent.get(u"contract"_s)->get(u"exchange"_s)), u"SMART"_s);
        const double first = js::num(order->get(u"lmtPrice"_s));
        QVERIFY2(first <= 108.5 && first >= 108.5 * 0.997 - 0.011, qPrintable(QString::number(first)));  // 买价让 0.3%
        QCOMPARE(rig.firedState(), u"sweep:take_profit"_s);

        // 没成交、买价退了:改同一张单往下追,不另发
        rig.router->bid = 107.9;
        rig.router->ask = 108.3;
        row = rig.tick(et(2026, 8, 13, 16, 5, 1));
        QCOMPARE(rig.count(u"place"_s), 1);
        QCOMPARE(rig.count(u"modify"_s), 1);
        const double second = js::num(rig.router->orders.last().order.get(u"lmt_price"_s));
        QVERIFY2(second < first && second >= 107.9 * 0.997 - 0.011, qPrintable(QString::number(second)));
        QCOMPARE(js::truthy(row.get(u"sweeping"_s)), true);
    }

    /// 夜盘到价:读夜盘那个交易所的买卖价,单送 OVERNIGHT
    void overnightRoutesToOvernightVenue() {
        Rig rig(plannedTp(8, 100), et(2026, 8, 13, 21, 0));
        rig.router->bid = 109;
        rig.router->ask = 109.4;
        // 08-13 是周四,21:00 归周五的夜盘
        const OJson row = rig.tick(et(2026, 8, 13, 21, 0));
        QCOMPARE(rig.router->bookVenues.last(), true);
        QCOMPARE(rig.count(u"place"_s), 1);
        const OJson sent = rig.router->orders.first().order;
        QCOMPARE(js::str(sent.get(u"contract"_s)->get(u"exchange"_s)), etp::kOvernightExchange);
        QCOMPARE(js::str(sent.get(u"order"_s)->get(u"orderType"_s)), u"LMT"_s);
        QCOMPARE(js::truthy(sent.get(u"order"_s)->get(u"outsideRth"_s)), true);
        QCOMPARE(js::str(sent.get(u"order"_s)->get(u"tif"_s)), u"DAY"_s);
        QCOMPARE(rig.firedState(), u"sweep:take_profit"_s);
        Q_UNUSED(row);
    }

    /// 别的止盈(固定止盈价)夜盘不发:只有财报止盈进夜盘
    void plainTakeProfitStaysOutOfOvernight() {
        Rig rig(plannedTp(50, 100), et(2026, 8, 13, 21, 0), js::object(), js::object({{u"take_profit"_s, js::N(103)}}));
        rig.router->bid = 109;
        rig.router->ask = 109.4;
        const OJson row = rig.tick(et(2026, 8, 13, 21, 0));  // 持仓现价 104 ≥ 103:固定止盈到了,但正股日历是休市
        QCOMPARE(rig.count(u"place"_s), 0);
        QVERIFY(js::isArr(row.get(u"blocked"_s)));
    }

    /// 托管到券商的追踪:夜盘不判,盘前到价改成追价(在同一组里)
    void hostedSkipsOvernight() {
        Rig rig(plannedTp(8, 100), et(2026, 8, 13, 21, 0), js::object({{u"host_at_broker"_s, js::B(true)}}), js::object({{u"stop_loss"_s, js::N(80)}}));
        rig.router->hosted = true;
        rig.router->bid = 109;
        rig.router->ask = 109.4;
        OJson row = rig.tick(et(2026, 8, 13, 21, 0));
        QVERIFY(reasonOf(row).contains(u"托管"_s));
        QCOMPARE(rig.count(u"place"_s), 0);
        QVERIFY(rig.firedState().isEmpty());
        row = rig.tick(et(2026, 8, 14, 4, 30));
        QCOMPARE(rig.firedState(), u"sweep:take_profit"_s);
        QCOMPARE(rig.count(u"place"_s), 0);  // 不另发组外的单
    }

    /// 买卖价缺一边不判;过了反应日收盘作废,之后买价再高也不发
    void noBookNoJudgeThenLapse() {
        Rig rig(plannedTp(8, 100), et(2026, 8, 13, 17, 0));
        rig.router->bid = 109;  // 只有买价、没有卖价
        OJson row = rig.tick(et(2026, 8, 13, 17, 0));
        QCOMPARE(js::str(row.get(u"state"_s)), u"holding"_s);
        QVERIFY(reasonOf(row).contains(u"拿不到买卖价"_s));
        rig.router->ask = 109.4;
        rig.router->bid = 107.99;  // 差一分
        row = rig.tick(et(2026, 8, 14, 15, 59));
        QCOMPARE(js::str(row.get(u"state"_s)), u"holding"_s);
        rig.router->bid = 120;
        rig.router->ask = 120.2;
        row = rig.tick(et(2026, 8, 14, 16, 0));
        QCOMPARE(phaseOf(row), u"lapsed"_s);
        QCOMPARE(js::truthy(rig.stored().get(u"lapsed"_s)), true);
        rig.tick(et(2026, 8, 14, 16, 30));
        QVERIFY(rig.router->orders.isEmpty());
    }

    /// 空头:比财报前收盘跌 8% 买回,看卖价
    void shortUsesAsk() {
        Rig rig(plannedTp(8, 100), et(2026, 8, 13, 17, 0), js::object(), js::object(), -100);
        rig.router->bid = 91;
        rig.router->ask = 92.5;  // 买价到了 92 以下,卖价没到
        rig.tick(et(2026, 8, 13, 17, 0));
        QVERIFY(rig.router->orders.isEmpty());
        rig.router->ask = 91.8;
        rig.tick(et(2026, 8, 13, 17, 0, 1));
        QCOMPARE(rig.count(u"place"_s), 1);
        const OJson* order = rig.router->orders.first().order.get(u"order"_s);
        QCOMPARE(js::str(order->get(u"action"_s)), u"BUY"_s);
        const double limit = js::num(order->get(u"lmtPrice"_s));
        QVERIFY2(limit >= 91.8 && limit <= 91.8 * 1.003 + 0.011, qPrintable(QString::number(limit)));
    }

    /// 日期没确认 / 日历读不到:不上膛、照实说、隔一阵再查;确认之后自己排上
    void unconfirmedThenConfirmed() {
        Rig rig(js::object({{u"pct"_s, js::N(8)}, {u"manual"_s, js::B(false)}}), et(2026, 8, 12, 10, 0));
        rig.router->earningsStatus = u"UNCONFIRMED"_s;
        OJson row = rig.tick(et(2026, 8, 12, 10, 0));
        QCOMPARE(phaseOf(row), u"unresolved"_s);
        QVERIFY(rig.stored().get(u"start_ms"_s) == nullptr);
        rig.tick(et(2026, 8, 12, 10, 0, 1));
        QCOMPARE(rig.router->earningsCalls, 1);  // 不是每秒都问
        rig.router->earningsStatus = u"CONFIRMED"_s;
        row = rig.tick(et(2026, 8, 12, 16, 30));
        QCOMPARE(rig.router->earningsCalls, 2);
        QCOMPARE(phaseOf(row), u"waiting"_s);
        QCOMPARE(js::num(rig.stored().get(u"start_ms"_s)), et(2026, 8, 13, 16, 0));
    }
    void calendarFailureIsReported() {
        Rig rig(js::object({{u"pct"_s, js::N(8)}, {u"manual"_s, js::B(false)}}), et(2026, 8, 12, 10, 0));
        rig.router->earningsFail = true;
        const OJson row = rig.tick(et(2026, 8, 12, 10, 0));
        QCOMPARE(phaseOf(row), u"unresolved"_s);
        QVERIFY(reasonOf(row).contains(u"WSH 没有权限"_s));
        QVERIFY(rig.router->orders.isEmpty());
    }

    /// 常规时段也判(反应日开盘之后);设的是市价就发市价
    void regularSessionOnReactionDay() {
        Rig rig(plannedTp(8, 100), et(2026, 8, 14, 9, 45));
        rig.router->bid = 108.2;
        rig.router->ask = 108.3;
        rig.tick(et(2026, 8, 14, 9, 45));
        QCOMPARE(rig.count(u"place"_s), 1);
        const OJson* order = rig.router->orders.first().order.get(u"order"_s);
        QCOMPARE(js::str(order->get(u"orderType"_s)), u"MKT"_s);
        QCOMPARE(js::truthy(order->get(u"outsideRth"_s)), false);
        QCOMPARE(rig.firedState(), u"take_profit"_s);
    }
};

QTEST_GUILESS_MAIN(TstEarningsTp)
#include "tst_earnings_tp.moc"
