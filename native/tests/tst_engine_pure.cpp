// engine/ 里的小模块(closing、spotStop、sessionHours、localShorthand、clock、heartbeat)对着原 TS 模块现跑的答案(fixtures/engine_pure.json,gen_engine_pure.mjs):
// 手写加种子固定的随机输入,假 router 是脚本驱动的队列,调用的先后与参数一并比。
#include "engine_world.h"
#include "orchestrate/clock.h"
#include "orchestrate/closing.h"
#include "orchestrate/hosted.h"
#include "orchestrate/heartbeat.h"
#include "orchestrate/local_shorthand.h"
#include "orchestrate/session_hours.h"
#include "orchestrate/spot_stop.h"

#include <QTest>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
using ibkr::util::Task;
namespace js = ibkr::util::js;
namespace orch = ibkr::orchestrate;

namespace {

/// 队列:用到最后一条就一直重复它
OJson pop(OJson& q) {
    if (q.type != OJson::Array || q.items.isEmpty()) return js::object();
    if (q.items.size() > 1) return q.items.takeFirst();
    return q.items.first();
}
const OJson* vOf(const OJson& b) { return b.get(u"v"_s); }
void maybeThrow(const OJson& b) {
    if (const OJson* t = b.get(u"throw"_s)) throw ibkr::util::JsError(js::str(t));
}

struct SpotFake final : orch::SpotRouter {
    OJson index, info, stream;
    bool capInfo = false, capStream = false;
    OJson calls = js::array();
    Task<std::optional<double>> indexPrice(const QString& symbol) override {
        calls.items.append(js::array({js::S(u"indexPrice"_s), js::S(symbol)}));
        const OJson b = pop(index);
        maybeThrow(b);
        const OJson* v = vOf(b);
        if (js::nullish(v)) co_return std::nullopt;
        co_return js::num(v);
    }
    bool hasSpotInfo() const override { return capInfo; }
    std::optional<OJson> spotInfo(const QString& symbol) override {
        calls.items.append(js::array({js::S(u"spotInfo"_s), js::S(symbol)}));
        const OJson b = pop(info);
        maybeThrow(b);
        const OJson* v = vOf(b);
        if (js::nullish(v)) return std::nullopt;
        return *v;
    }
    bool hasStreamQuotes() const override { return capStream; }
    Task<OJson> streamQuotes(const QStringList& symbols) override {
        calls.items.append(js::array({js::S(u"streamQuotes"_s), js::strings(symbols)}));
        const OJson b = pop(stream);
        maybeThrow(b);
        const OJson* v = vOf(b);
        co_return v ? *v : OJson::null();
    }
};

struct HoursFake final : orch::HoursRouter {
    bool capHours = false, capCached = false, throwCached = false;
    OJson cached, hoursQ;
    OJson* calls = nullptr;
    bool hasContractHours() const override { return capHours; }
    Task<std::optional<orch::ContractHours>> contractHours(const OJson& row, const ibkr::contract::AccountConfig& account) override {
        calls->items.append(js::array({js::S(u"contractHours"_s), ew::jn(row), js::S(account.alias)}));
        const OJson b = pop(hoursQ);
        maybeThrow(b);
        const OJson* v = vOf(b);
        if (js::nullish(v)) co_return std::nullopt;
        co_return orch::ContractHours{js::str(&v->items[0]), js::str(&v->items[1]), js::str(&v->items[2])};
    }
    bool hasCachedContractHours() const override { return capCached; }
    std::optional<orch::ContractHours> cachedContractHours(const QString& symbol, const QString& expiry) override {
        calls->items.append(js::array({js::S(u"cachedContractHours"_s), js::S(symbol), js::S(expiry)}));
        if (throwCached) throw ibkr::util::JsError(u"缓存坏了"_s);
        const OJson* v = cached.get(symbol + u"|"_s + expiry);
        if (js::nullish(v)) return std::nullopt;
        return orch::ContractHours{js::str(&v->items[0]), js::str(&v->items[1]), js::str(&v->items[2])};
    }
};

struct HoursHostImpl final : orch::HoursHost {
    ibkr::domain::Settings s;
    HoursFake* r = nullptr;
    const ibkr::domain::Settings& settings() const override { return s; }
    orch::HoursRouter* router() override { return r; }
};

struct AuditStore final : orch::EngineStore {
    OJson* calls = nullptr;
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
    QList<OJson> workingOrders(double, double) override { return {}; }
    QList<OJson> dailyLossTrips(double, double) override { return {}; }
};

struct ShortRouter final : orch::ShorthandRouter {
    OJson index, info;
    bool capInfo = false;
    OJson* calls = nullptr;
    Task<std::optional<double>> indexPrice(const QString& s) override {
        calls->items.append(js::array({js::S(u"indexPrice"_s), js::S(s)}));
        const OJson b = pop(index);
        maybeThrow(b);
        const OJson* v = vOf(b);
        if (js::nullish(v)) co_return std::nullopt;
        co_return js::num(v);
    }
    bool hasSpotInfo() const override { return capInfo; }
    std::optional<OJson> spotInfo(const QString& s) override {
        calls->items.append(js::array({js::S(u"spotInfo"_s), js::S(s)}));
        const OJson b = pop(info);
        const OJson* v = vOf(b);
        if (js::nullish(v)) return std::nullopt;
        return *v;
    }
};

struct ShortHost final : orch::ShorthandHost {
    ShortRouter router_;
    bool hasRouter = false;
    OJson pub;
    AuditStore store_;
    OJson* calls = nullptr;
    orch::ShorthandRouter* router() override { return hasRouter ? &router_ : nullptr; }
    Task<std::optional<double>> publicPrice(const QString& s) override {
        calls->items.append(js::array({js::S(u"public"_s), js::S(s)}));
        const OJson b = pop(pub);
        maybeThrow(b);
        const OJson* v = vOf(b);
        if (js::nullish(v)) co_return std::nullopt;
        co_return js::num(v);
    }
    orch::EngineStore& store() override { return store_; }
};

OJson outcome(const OJson& res, const OJson& calls) { return js::object({{u"res"_s, res}, {u"calls"_s, calls}}); }

}  // namespace

class TstEnginePure : public QObject {
    Q_OBJECT
private slots:
    void closing() {
        const OJson fx = jsfix::load(u"engine_pure.json"_s);
        int n = 0;
        for (const OJson& c0 : fx.get(u"closing"_s)->items) {
            const OJson c = jsfix::dec(c0);
            const OJson& order = *c.get(u"order"_s);
            const QString alias = ew::str(c, u"alias"_s);
            const QList<OJson> rows = c.get(u"rows"_s)->items;
            QList<OJson> after = rows;
            orch::applyReduction(order, alias, after);
            const OJson got = js::object({{u"reduces"_s, js::B(orch::reducesPositions(order, alias, rows))}, {u"after"_s, js::array(after)}, {u"legId"_s, js::S(orch::orderLegId(order))}});
            JSFIX_SAME(c0.get(u"expected"_s) ? *c0.get(u"expected"_s) : OJson::null(), got, u"closing #%1"_s.arg(n));
            ++n;
        }
        QVERIFY(n > 100);
    }
    void spot() {
        const OJson fx = jsfix::load(u"engine_pure.json"_s);
        int n = 0;
        for (const OJson& c0 : fx.get(u"spot"_s)->items) {
            const OJson c = jsfix::dec(c0);
            const OJson& cfg = *c.get(u"cfg"_s);
            SpotFake f;
            f.index = *cfg.get(u"index"_s);
            f.info = *cfg.get(u"info"_s);
            f.stream = *cfg.get(u"stream"_s);
            f.capInfo = ew::flag(*cfg.get(u"caps"_s), u"spotInfo"_s);
            f.capStream = ew::flag(*cfg.get(u"caps"_s), u"stream"_s);
            const QString which = ew::str(c, u"which"_s);
            const OJson& args = *c.get(u"args"_s);
            OJson res;
            try {
                if (which == u"stock") {
                    const auto v = orch::stockSpot(f, js::str(&args.items[0])).result();
                    res = js::NOrNull(v);
                } else if (which == u"under" || which == u"under0") {
                    const auto u = orch::underlyingSpot(f, js::str(&args.items[0]), which == u"under").result();
                    res = js::object({{u"spot"_s, js::NOrNull(u.spot)}, {u"note"_s, js::S(u.note)}});
                } else {
                    std::optional<OJson> target;
                    if (args.items[2].type != OJson::Null) target = args.items[2];
                    const auto v = orch::spotStopFor(f, js::str(&args.items[0]), args.items[1], target, js::truthy(&args.items[3])).result();
                    res = v ? *v : OJson::null();
                }
            } catch (const ibkr::util::JsError& e) {
                res = js::object({{u"thrown"_s, js::S(e.message())}});
            }
            JSFIX_SAME(*c0.get(u"expected"_s), outcome(res, f.calls), u"spot #%1 %2"_s.arg(n).arg(which));
            ++n;
        }
        QVERIFY(n > 300);
    }
    void hours() {
        const OJson fx = jsfix::load(u"engine_pure.json"_s);
        int n = 0;
        for (const OJson& c0 : fx.get(u"hours"_s)->items) {
            const OJson c = jsfix::dec(c0);
            OJson calls = js::array();
            HoursFake f;
            f.calls = &calls;
            f.capHours = ew::flag(*c.get(u"caps"_s), u"contractHours"_s);
            f.capCached = ew::flag(*c.get(u"caps"_s), u"cached"_s);
            f.throwCached = ew::flag(c, u"throwCached"_s);
            f.cached = *c.get(u"cached"_s);
            f.hoursQ = *c.get(u"hoursQ"_s);
            HoursHostImpl host;
            host.s = ibkr::domain::fromDict(ew::deepMerge(jsfix::dec(*fx.get(u"base"_s)), *c.get(u"settingsPatch"_s)));
            host.r = ew::flag(c, u"hasRouter"_s) ? &f : nullptr;
            const auto at = ibkr::domain::etNowFromEpoch(ew::num(c, u"now"_s));
            OJson status = js::array(), statusFor = js::array();
            for (const OJson& o : c.get(u"orders"_s)->items) {
                const auto s = orch::orderMarketStatus(host, o, at);
                status.items.append(s ? js::S(*s) : OJson::null());
            }
            const OJson autoOut = js::array(orch::autoOutsideRth(host, c.get(u"orders"_s)->items, at));
            for (const OJson& raw : c.get(u"raws"_s)->items) statusFor.items.append(js::S(orch::marketStatusFor(host, raw, at).result()));
            orch::prewarmContractHours(host, c.get(u"orders"_s)->items).result();
            const OJson got = js::object({{u"status"_s, status}, {u"auto"_s, autoOut}, {u"statusFor"_s, statusFor}, {u"calls"_s, calls}, {u"stock"_s, js::S(host.s.marketStatus(at))}});
            JSFIX_SAME(*c0.get(u"expected"_s), got, u"hours #%1"_s.arg(n));
            ++n;
        }
        QVERIFY(n > 100);
    }
    void shorthand() {
        const OJson fx = jsfix::load(u"engine_pure.json"_s);
        int n = 0;
        for (const OJson& c0 : fx.get(u"shorthand"_s)->items) {
            const OJson c = jsfix::dec(c0);
            const OJson& cfg = *c.get(u"cfg"_s);
            OJson calls = js::array();
            ShortHost host;
            host.calls = &calls;
            host.store_.calls = &calls;
            host.hasRouter = ew::flag(cfg, u"hasRouter"_s);
            host.router_.calls = &calls;
            host.router_.index = *cfg.get(u"index"_s);
            host.router_.info = *cfg.get(u"info"_s);
            host.router_.capInfo = ew::flag(cfg, u"infoCap"_s);
            host.pub = *cfg.get(u"pub"_s);
            OJson snap = *c.get(u"snap"_s);
            ibkr::parsing::shorthand::ShorthandMeta meta;
            const auto at = ibkr::domain::etNowFromEpoch(ew::num(c, u"at"_s));
            const auto res = orch::tryLocalShorthand(host, ew::str(c, u"text"_s), &snap, at, &meta).result();
            const OJson got = js::object({{u"res"_s, res ? *res : OJson::null()},
                                          {u"snap"_s, snap},
                                          {u"calls"_s, calls},
                                          {u"meta"_s, meta.set ? js::object({{u"relativeCenter"_s, js::B(meta.relativeCenter)}}) : js::object()}});
            JSFIX_SAME(*c0.get(u"expected"_s), got, u"shorthand #%1 %2"_s.arg(n).arg(ew::str(c, u"text"_s)));
            ++n;
        }
        QVERIFY(n > 100);
    }
    void clockAndHeartbeat() {
        const OJson fx = jsfix::load(u"engine_pure.json"_s);
        for (const OJson& c0 : fx.get(u"clock"_s)->items) {
            const OJson c = jsfix::dec(c0);
            const QString zone = ew::str(c, u"zone"_s);
            const double t = ew::num(c, u"t"_s);
            ibkr::util::setDateNowForTests([t] { return t; });
            const QString got = zone.isEmpty() ? orch::nowIsoSecondsEt() : orch::localIsoSeconds(t, QTimeZone(zone.toUtf8()));
            QCOMPARE(got, ew::str(c, u"expected"_s));
        }
        for (const OJson& c0 : fx.get(u"heartbeat"_s)->items) {
            const OJson c = jsfix::dec(c0);
            const double t = ew::num(c, u"t"_s);
            ibkr::util::setDateNowForTests([t] { return t; });
            if (ew::str(c, u"kind"_s) == u"beat") {
                JSFIX_SAME(*c0.get(u"expected"_s), orch::heartbeatOf(*c.get(u"state"_s)), u"beat"_s);
            } else {
                const double lag = ew::num(c, u"lag"_s);
                OJson withLag = js::object({{u"ticks"_s, js::N(3)}, {u"slow_ticks"_s, js::N(0)}, {u"max_ms"_s, js::N(20)}, {u"lag_worst_ms"_s, js::N(10)}});
                orch::LoopMeter m([lag] { return lag; });
                m.start();
                m.record(withLag, ew::num(c, u"t0"_s), 50);
                OJson noLag = js::object({{u"ticks"_s, js::N(3)}, {u"slow_ticks"_s, js::N(0)}, {u"max_ms"_s, js::N(20)}});
                orch::LoopMeter().record(noLag, ew::num(c, u"t0"_s), 50);
                OJson missing = js::object({{u"ticks"_s, js::N(1)}});
                orch::LoopMeter m3([lag] { return lag; });
                m3.start();
                m3.record(missing, ew::num(c, u"t0"_s), 50);
                OJson unstarted = js::object({{u"ticks"_s, js::N(2)}});
                orch::LoopMeter m4([lag] { return lag; });
                m4.record(unstarted, ew::num(c, u"t0"_s), 50);
                JSFIX_SAME(*c0.get(u"expected"_s), js::object({{u"withLag"_s, withLag}, {u"noLag"_s, noLag}, {u"missing"_s, missing}, {u"unstarted"_s, unstarted}}), u"meter"_s);
            }
        }
        ibkr::util::setDateNowForTests({});
    }
    void labelsAndMath() {
        const OJson fx = jsfix::load(u"engine_pure.json"_s);
        for (const OJson& c0 : fx.get(u"labels"_s)->items) {
            const OJson c = jsfix::dec(c0);
            const auto l = orch::HostedOrders::stateLabel(ew::str(c, u"state"_s));
            JSFIX_SAME(*c0.get(u"expected"_s), l ? js::S(*l) : OJson::null(), u"label"_s);
        }
        for (const OJson& c0 : fx.get(u"math"_s)->items) {
            const OJson c = jsfix::dec(c0);
            const double a = c.get(u"a"_s)->n, b = c.get(u"b"_s)->n;
            JSFIX_SAME(*c0.get(u"min"_s), js::N(orch::jsx::min(a, b)), u"min"_s);
            JSFIX_SAME(*c0.get(u"max"_s), js::N(orch::jsx::max(a, b)), u"max"_s);
        }
    }
};

QTEST_GUILESS_MAIN(TstEnginePure)
#include "tst_engine_pure.moc"
