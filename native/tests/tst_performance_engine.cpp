// engine/analysis/performance(performance.ts,绩效体检的计算)对着原模块现跑的答案(tests/fixtures/gen_performance_engine.mjs):
// 四类账本、初始止损、buildLedger,造出来的账本上的各项统计与规则用的几样,整份 performanceReport,逐字符比 JSON。
// 界面那边的 tst_performance_rules / tst_performance_controller 管的是页面怎么摆,不是这一份。
#include "analysis/performance.h"
#include "js_fixture.h"

#include <QTest>

#include <tuple>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using util::OJson;
namespace js = util::js;
namespace pf = analysis::performance;
namespace eq = analysis::execquality;

namespace {

OJson excludedJson(const pf::Excluded& e) {
    return js::object({{u"open"_s, js::N(e.open)}, {u"unknown"_s, js::N(e.unknown)}, {u"no_cost"_s, js::N(e.no_cost)}});
}
OJson tradesJson(const QList<pf::LedgerTrade>& ts) {
    OJson a = js::array();
    for (const auto& t : ts) a.items.append(pf::toJson(t));
    return a;
}
OJson idsJson(const pf::Trades& ts) {
    OJson a = js::array();
    for (const auto* t : ts) a.items.append(js::S(t->id));
    return a;
}
std::optional<QString> optStr(const OJson* v) { return !v || v->type == OJson::Null ? std::nullopt : std::optional<QString>(v->s); }

std::vector<pf::PlannedStop> stopsOf(const OJson& a) {
    std::vector<pf::PlannedStop> out;
    for (const OJson& s : a.items) out.push_back({s.get(u"at"_s)->s, optStr(s.get(u"account"_s)), s.get(u"symbol"_s)->s, optStr(s.get(u"sec_type"_s)), s.get(u"stop"_s)->n});
    return out;
}
QList<pf::LedgerTrade> ledgerOf(const OJson& a) {
    QList<pf::LedgerTrade> out;
    for (const OJson& t : a.items) out.append(pf::ledgerTradeFromJson(t));
    return out;
}
eq::CloseTrace traceOf(const OJson& t) {
    eq::CloseTrace c;
    c.at = t.get(u"at"_s)->s;
    c.path = t.get(u"path"_s)->s;
    c.symbol = t.get(u"symbol"_s)->s;
    c.state = t.get(u"state"_s)->s;
    if (const OJson* m = t.get(u"mark"_s); m && m->type == OJson::Number) c.mark = m->n;
    if (const OJson* r = t.get(u"record"_s); r && r->type != OJson::Null) c.record = *r;
    return c;
}
contract::ProtectionsConfig protectionsOf(const OJson& p) {
    contract::ProtectionsConfig c;
    const OJson& g = *p.get(u"stoploss_guard"_s);
    c.stoploss_guard = {g.get(u"enabled"_s)->b, g.get(u"lookback_minutes"_s)->n, g.get(u"trigger_count"_s)->n, g.get(u"pause_minutes"_s)->n};
    const OJson& m = *p.get(u"max_drawdown"_s);
    c.max_drawdown = {m.get(u"enabled"_s)->b, m.get(u"lookback_minutes"_s)->n, m.get(u"max_drawdown_usd"_s)->n, m.get(u"pause_minutes"_s)->n};
    const OJson& cd = *p.get(u"cooldown"_s);
    c.cooldown = {cd.get(u"enabled"_s)->b, cd.get(u"minutes"_s)->n, cd.get(u"scope"_s)->s};
    const OJson& d = *p.get(u"daily_loss"_s);
    c.daily_loss = {d.get(u"enabled"_s)->b, d.get(u"max_loss_usd"_s)->n, d.get(u"basis"_s)->s};
    return c;
}
pf::PerformanceOptions optsOf(const OJson& o) {
    pf::PerformanceOptions opts{o.get(u"scope"_s)->s, o.get(u"kind"_s)->s, std::nullopt, o.get(u"now"_s)->n};
    if (const OJson* d = o.get(u"days"_s); d && d->type == OJson::Number) opts.days = d->n;
    return opts;
}
OJson sessionJson(const std::optional<pf::Session>& s) { return s ? js::object({{u"key"_s, js::S(s->key)}, {u"label"_s, js::S(s->label)}}) : js::Null(); }
OJson daysJson(const pf::OrderedDays& d) {
    OJson a = js::array();
    for (const auto& [k, v] : d) a.items.append(js::array({js::S(k), js::N(v)}));
    return a;
}

}  // namespace

class TestPerformanceEngine : public QObject {
    Q_OBJECT
    OJson fx_;
    analysis::trade_outcomes::SettleClose settle_;
    analysis::trade_outcomes::IsPaper isPaper_ = [](const QString& id) { return id.startsWith(u"DU"_s); };
    QList<QList<pf::LedgerTrade>> ledgers_;

    const OJson& at(const char16_t* k) const { return *fx_.get(QString::fromUtf16(k)); }

private slots:
    void initTestCase() {
        fx_ = jsfix::load(u"performance_engine.json"_s);
        const OJson closes = *fx_.get(u"closes"_s);
        settle_ = [closes](const QString& symbol, const QString& date) -> std::optional<double> {
            const OJson* v = closes.get(symbol + u'|' + date);
            return v ? std::optional<double>(v->n) : std::nullopt;
        };
        for (const OJson& l : at(u"ledgers").items) ledgers_.append(ledgerOf(dec(l)));
        QVERIFY(ledgers_.size() > 40);
    }

    void butterflyLedger() {
        for (const OJson& c : at(u"fly").items) {
            const QList<OJson> recs = dec(*c.get(u"records"_s)).items;
            const double now = c.get(u"now"_s)->n;
            JSFIX_EXPECT(c, [&] {
                pf::Excluded ex;
                const auto t = pf::butterflyLedger(recs, settle_, now, ex);
                return js::object({{u"trades"_s, tradesJson(t)}, {u"excluded"_s, excludedJson(ex)}});
            }, u"butterflyLedger"_s);
        }
    }

    void plannedStopFor() {
        for (const OJson& c : at(u"stops").items) {
            const OJson trip = dec(*c.get(u"trip"_s));
            const auto stops = stopsOf(dec(*c.get(u"stops"_s)));
            JSFIX_EXPECT(c, [&] {
                const auto hit = pf::plannedStopFor(trip, stops);
                return js::object({{u"stop"_s, hit.stop ? js::N(*hit.stop) : js::Null()}, {u"late"_s, js::B(hit.late)}});
            }, u"plannedStopFor "_s + js::stringify(trip).left(120));
        }
    }

    void stockLedger() {
        for (const OJson& c : at(u"stock").items) {
            const QList<OJson> trips = dec(*c.get(u"trips"_s)).items;
            const auto stops = stopsOf(dec(*c.get(u"stops"_s)));
            JSFIX_EXPECT(c, [&] {
                pf::Excluded ex;
                const auto t = pf::stockLedger(trips, ex, stops);
                return js::object({{u"trades"_s, tradesJson(t)}, {u"excluded"_s, excludedJson(ex)}});
            }, u"stockLedger"_s);
        }
    }

    void positionAndOptionLedger() {
        for (const OJson& c : at(u"position").items) {
            const QList<OJson> rows = dec(*c.get(u"rows"_s)).items;
            JSFIX_EXPECT(c, [&] {
                pf::Excluded ex;
                const auto t = pf::positionLedger(rows, isPaper_, ex);
                return js::object({{u"trades"_s, tradesJson(t)}, {u"excluded"_s, excludedJson(ex)}});
            }, u"positionLedger"_s);
        }
        for (const OJson& c : at(u"option").items) {
            const QList<OJson> rows = dec(*c.get(u"rows"_s)).items;
            JSFIX_EXPECT(c, [&] { return tradesJson(pf::optionLedger(rows, isPaper_)); }, u"optionLedger"_s);
        }
    }

    void buildLedger() {
        for (const OJson& c : at(u"build").items) {
            pf::LedgerInputs inp;
            inp.butterflies = dec(*c.get(u"records"_s)).items;
            inp.trips = dec(*c.get(u"trips"_s)).items;
            inp.stops = stopsOf(dec(*c.get(u"stops"_s)));
            inp.positions = dec(*c.get(u"positions"_s)).items;
            inp.options = dec(*c.get(u"options"_s)).items;
            inp.settleClose = settle_;
            inp.isPaper = isPaper_;
            inp.now = c.get(u"now"_s)->n;
            JSFIX_EXPECT(c, [&] {
                const pf::Ledger l = pf::buildLedger(inp);
                return js::object({{u"trades"_s, tradesJson(l.trades)}, {u"excluded"_s, excludedJson(l.excluded)}});
            }, u"buildLedger"_s);
        }
    }

    void stats() {
        const QList<OJson>& all = at(u"stats").items;
        QCOMPARE(all.size(), ledgers_.size());
        for (qsizetype i = 0; i < all.size(); ++i) {
            const OJson& c = all[i];
            const pf::Trades t = pf::refs(ledgers_[i]);
            const QString what = u"账本 %1 "_s.arg(i);
            const pf::PerfStats s = pf::perfStats(t);
            JSFIX_SAME(*c.get(u"perfStats"_s), pf::toJson(s), what + u"perfStats"_s);
            JSFIX_SAME(*c.get(u"rStats"_s), pf::toJson(pf::rStats(t)), what + u"rStats"_s);
            JSFIX_SAME(*c.get(u"rCoverage"_s), pf::toJson(pf::rCoverage(t)), what + u"rCoverage"_s);
            JSFIX_SAME(*c.get(u"equityCurve"_s), pf::toJson(pf::equityCurve(t)), what + u"equityCurve"_s);
            const pf::PerDay pd = pf::perDay(t);
            OJson pdj = pf::toJson(pd);
            pdj.set(u"counts"_s, daysJson(pd.counts));
            pdj.set(u"pnl"_s, daysJson(pd.pnl));
            JSFIX_SAME(*c.get(u"perDay"_s), pdj, what + u"perDay"_s);
            const auto k = pf::kellyOf(s);
            JSFIX_SAME(*c.get(u"kellyOf"_s), k ? js::N(*k) : js::Null(), what + u"kellyOf"_s);
            OJson sessions = js::array();
            for (const auto* x : t) sessions.items.append(sessionJson(pf::sessionOf(x->opened_at)));
            JSFIX_SAME(*c.get(u"sessions"_s), sessions, what + u"sessionOf"_s);
            const pf::Split rv = pf::revengeSplit(t);
            JSFIX_SAME(*c.get(u"revenge"_s), js::object({{u"quick"_s, idsJson(rv.quick)}, {u"rest"_s, idsJson(rv.rest)}}), what + u"revengeSplit"_s);
            const pf::Split same = pf::sameSymbolReentry(t);
            JSFIX_SAME(*c.get(u"same"_s), js::object({{u"quick"_s, idsJson(same.quick)}, {u"rest"_s, idsJson(same.rest)}}), what + u"sameSymbolReentry"_s);
            const pf::SizeAfterLoss sz = pf::sizeAfterLoss(t);
            JSFIX_SAME(*c.get(u"sizeAfterLoss"_s),
                       js::object({{u"afterLoss"_s, js::N(sz.afterLoss)}, {u"upAfterLoss"_s, js::N(sz.upAfterLoss)}, {u"afterWin"_s, js::N(sz.afterWin)}, {u"upAfterWin"_s, js::N(sz.upAfterWin)}}),
                       what + u"sizeAfterLoss"_s);
            OJson replay = js::array();
            for (const double line : {50.0, 100.0, 250.0, 1000.0}) replay.items.append(pf::toJson(pf::dailyLossReplay(t, line)));
            JSFIX_SAME(*c.get(u"replay"_s), replay, what + u"dailyLossReplay"_s);
            OJson bursts = js::array();
            for (const auto& [a, b, d] : std::vector<std::tuple<double, double, double>>{{120, 3, 60}, {30, 2, 10}, {600, 5, 120}, {1, 1, 0}})
                bursts.items.append(js::N(pf::lossBursts(t, a, b, d)));
            JSFIX_SAME(*c.get(u"bursts"_s), bursts, what + u"lossBursts"_s);
        }
    }

    void reports() {
        int n = 0, full = 0;
        for (const OJson& c : at(u"reports").items) {
            const qsizetype li = qsizetype(c.get(u"ledger"_s)->n);
            pf::Ledger ledger;
            ledger.trades = ledgers_[li];
            const OJson& ex = *c.get(u"excluded"_s);
            ledger.excluded = {ex.get(u"open"_s)->n, ex.get(u"unknown"_s)->n, ex.get(u"no_cost"_s)->n};
            const pf::PerformanceOptions opts = optsOf(*c.get(u"opts"_s));
            pf::PerformanceExtras extras;
            std::optional<contract::ProtectionsConfig> prot;
            if (const OJson* e = c.get(u"extras"_s); e && e->type == OJson::Object) {
                const OJson x = dec(*e);
                if (const OJson* tr = x.get(u"traces"_s); tr && tr->type == OJson::Array)
                    for (const OJson& t : tr->items) extras.traces.push_back(traceOf(t));
                if (const OJson* p = x.get(u"protections"_s); p && p->type == OJson::Object) prot = protectionsOf(*p);
            }
            if (prot) extras.protections = &*prot;
            const bool keepRows = c.get(u"full"_s)->b;
            JSFIX_EXPECT(c, [&] {
                OJson r = pf::performanceReport(ledger, opts, extras);
                if (!keepRows) {
                    OJson ids = js::array();
                    for (const OJson& t : r.get(u"trades"_s)->items) ids.items.append(*t.get(u"id"_s));
                    r.set(u"trades"_s, ids);
                }
                return r;
            }, u"performanceReport 账本 %1 %2"_s.arg(li).arg(js::stringify(*c.get(u"opts"_s))));
            ++n;
            if (keepRows) ++full;
        }
        QVERIFY(n > 50);
        QCOMPARE(full, 2);
    }

    void misc() {
        const OJson& m = at(u"misc");
        for (const OJson& c : m.get(u"sqnLabel"_s)->items) {
            const OJson& v = c.items[0];
            QCOMPARE(pf::sqnLabel(v.type == OJson::Null ? std::nullopt : std::optional<double>(v.n)), c.items[1].s);
        }
        for (const OJson& c : m.get(u"sessionOf"_s)->items) {
            const OJson& v = c.items[0];
            JSFIX_SAME(c.items[1], sessionJson(pf::sessionOf(v.type == OJson::Null ? std::nullopt : std::optional<QString>(v.s))), u"sessionOf "_s + js::stringify(v));
        }
        for (const OJson& c : m.get(u"filter"_s)->items) {
            const pf::Trades t = pf::refs(ledgers_[qsizetype(c.get(u"ledger"_s)->n)]);
            JSFIX_SAME(*c.get(u"ids"_s), idsJson(pf::filterLedger(t, optsOf(*c.get(u"opts"_s)))), u"filterLedger "_s + js::stringify(*c.get(u"opts"_s)));
        }
        const OJson& k = *m.get(u"constants"_s);
        QCOMPARE(k.get(u"FLAT_USD"_s)->n, pf::kFlatUsd);
        QCOMPARE(k.get(u"MIN_GROUP"_s)->n, double(pf::kMinGroup));
        QCOMPARE(k.get(u"MIN_SAMPLE"_s)->n, double(pf::kMinSample));
        QCOMPARE(k.get(u"RECENT_WINDOW"_s)->n, double(pf::kRecentWindow));
        QCOMPARE(k.get(u"REVENGE_MINUTES"_s)->n, double(pf::kRevengeMinutes));
        QCOMPARE(k.get(u"MAX_LEDGER_ROWS"_s)->n, double(pf::kMaxLedgerRows));
        QCOMPARE(k.get(u"INITIAL_STOP_MINUTES"_s)->n, double(pf::kInitialStopMinutes));
    }
};

QTEST_GUILESS_MAIN(TestPerformanceEngine)
#include "tst_performance_engine.moc"
