// engine/orchestrate/tracker(tracker.ts)对着原模块现跑的答案(tests/fixtures/gen_tracker.mjs):标的目标价的五档波动率来源、立刻能成交的价与追价、
// 盈亏、设置校验、触发判断、平仓单、托管单,整份结论逐字比 JSON。
#include "js_fixture.h"
#include "orchestrate/tracker.h"

#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using util::OJson;
namespace js = util::js;
namespace tk = orchestrate::tracker;

namespace {
double num(const OJson* v) { return jsfix::num(v); }
std::optional<double> opt(const OJson* v) {
    if (jsfix::isUndefined(v) || v->type == OJson::Null) return std::nullopt;
    const OJson d = dec(*v);
    if (d.type != OJson::Number) return std::nullopt;
    return d.n;
}
OJson optN(const std::optional<double>& v) { return v ? js::N(*v) : OJson::null(); }
OJson structureJson(const std::optional<tk::TargetStructure>& s) {
    if (!s) return OJson::null();
    OJson legs = js::array();
    for (const auto& l : s->legs) legs.items.append(js::object({{u"strike"_s, js::N(l.strike)}, {u"right"_s, js::S(l.right)}, {u"ratio"_s, js::N(l.ratio)}}));
    return js::object({{u"kind"_s, js::S(s->kind)}, {u"legs"_s, legs}, {u"fly"_s, s->fly ? *s->fly : OJson::null()}, {u"label"_s, js::S(s->label)}});
}
}  // namespace

class TestTracker : public QObject {
    Q_OBJECT
    OJson fx_;
    std::vector<tk::Position> positions_;
    OJson contracts_;

    const tk::Position& P(const OJson* idx) { return positions_[size_t(idx->n)]; }
    const OJson* C(const OJson* name) { return contracts_.get(name->s); }

private slots:
    void initTestCase() {
        fx_ = jsfix::load(u"tracker.json"_s);
        for (const OJson& p : fx_.get(u"positions"_s)->items) positions_.push_back(tk::makePosition(dec(*p.get(u"p"_s))));
        contracts_ = *fx_.get(u"contracts"_s);
    }

    void basics() {
        for (const OJson& c : fx_.get(u"keys"_s)->items) QCOMPARE(tk::trackKey(*c.get(u"t"_s)), c.get(u"out"_s)->s);
        for (const OJson& c : fx_.get(u"targets"_s)->items) {
            const OJson raw = dec(*c.get(u"raw"_s));
            const OJson t = tk::makeTargets(raw);
            JSFIX_SAME(*c.get(u"out"_s), t, u"makeTargets"_s);
            QCOMPARE(tk::targetsEmpty(t), c.get(u"empty"_s)->b);
            QCOMPARE(tk::targetsEmpty(raw), c.get(u"emptyRaw"_s)->b);
        }
        for (const OJson& c : fx_.get(u"profiles"_s)->items) {
            const QString name = c.get(u"c"_s)->s;
            OJson holder;
            const OJson* contract = nullptr;
            if (name == u"__legs3str") holder = js::object({{u"secType"_s, js::S(u"BAG"_s)}, {u"legs"_s, js::S(u"abc"_s)}}), contract = &holder;
            else if (name == u"__nullLeg") holder = js::object({{u"secType"_s, js::S(u"BAG"_s)}, {u"legs"_s, js::array({OJson::null(), js::N(1), js::N(2)})}}), contract = &holder;
            else if (name != u"__null") contract = C(c.get(u"c"_s));
            JSFIX_EXPECT(*c.get(u"profile"_s), [&] { const auto p = tk::flyProfileOf(contract); return p ? *p : OJson::null(); }, u"flyProfileOf "_s + name);
            OJson sholder;
            const OJson* scontract = contract;
            if (name == u"__legs3str") sholder = js::object({{u"legs"_s, js::S(u"abc"_s)}}), scontract = &sholder;
            if (name == u"__nullLeg") sholder = js::object({{u"legs"_s, js::array({OJson::null()})}}), scontract = &sholder;
            JSFIX_EXPECT(*c.get(u"structure"_s), [&] { return structureJson(tk::structureOf(c.get(u"sec"_s)->s, scontract)); }, u"structureOf "_s + name);
        }
        for (const OJson& c : fx_.get(u"sweep"_s)->items) {
            const auto r = tk::sweepReason(*c.get(u"t"_s));
            JSFIX_SAME(*c.get(u"out"_s), r ? js::S(*r) : OJson::null(), u"sweepReason"_s);
        }
    }

    void spotTargets() {
        int n = 0;
        for (const OJson& c : fx_.get(u"spot"_s)->items) {
            const tk::Position& p = P(c.get(u"p"_s));
            const OJson* contract = C(c.get(u"c"_s));
            const auto st = tk::structureOf(p.sec_type, contract);
            QVERIFY(st);
            const OJson a = dec(*c.get(u"args"_s));
            tk::SpotTargetArgs args;
            args.spotTarget = num(a.get(u"spotTarget"_s));
            args.spot = opt(a.get(u"spot"_s));
            if (const OJson* s = a.get(u"spot"_s); s && s->type == OJson::Number) args.spot = s->n;  // NaN 也照传(TS 的 finiteOrNull 当场滤)
            args.markPrice = opt(a.get(u"markPrice"_s));
            if (const OJson* s = a.get(u"markPrice"_s); s && s->type == OJson::Number) args.markPrice = s->n;
            args.minute = opt(a.get(u"minute"_s));
            if (const OJson* s = a.get(u"em"_s); s && s->type == OJson::Number) args.em = s->n;
            const OJson* lp = a.get(u"legPrices"_s);
            args.legPrices = lp;
            const OJson* li = a.get(u"legIvs"_s);
            args.legIvs = li && li->type != OJson::Null ? li : nullptr;
            if (const OJson* s = a.get(u"spotNote"_s)) args.spotNote = s->s;
            args.expiryMs = opt(a.get(u"expiryMs"_s));
            args.nowMs = opt(a.get(u"nowMs"_s));
            JSFIX_EXPECT(c, [&] { return tk::spotTarget(*st, p, args); }, u"spotTarget #%1"_s.arg(n));
            JSFIX_EXPECT(*c.get(u"validate"_s), [&] { return tk::validateSpotTarget(p, contract, args); }, u"validateSpotTarget #%1"_s.arg(n));
            ++n;
        }
    }

    void naturalAndChase() {
        for (const OJson& c : fx_.get(u"natural"_s)->items) {
            const tk::Position& p = P(c.get(u"p"_s));
            const auto st = tk::structureOf(p.sec_type, C(c.get(u"c"_s)));
            JSFIX_SAME(*c.get(u"out"_s), optN(tk::naturalClosePrice(p, *st, dec(*c.get(u"book"_s)))), u"naturalClosePrice"_s);
        }
        for (const OJson& c : fx_.get(u"chase"_s)->items) {
            const tk::Position& p = P(c.get(u"p"_s));
            const double nat = c.get(u"nat"_s)->n;
            const OJson& autoClose = *c.get(u"auto"_s);
            const OJson reason = dec(*c.get(u"reason"_s));
            const OJson* r = jsfix::isUndefined(c.get(u"reason"_s)) ? nullptr : &reason;
            QCOMPARE(tk::chaseMaxSteps(p, nat, autoClose, r), c.get(u"max"_s)->n);
            QCOMPARE(js::stringify(js::N(tk::chaseFloor(p, nat, autoClose, r))), js::stringify(*c.get(u"floor"_s)));
            for (const OJson& row : c.get(u"rows"_s)->items) {
                const std::optional<double> prev = row.items[1].type == OJson::Null ? std::nullopt : std::optional(row.items[1].n);
                QCOMPARE(js::stringify(js::N(tk::chaseLimit(p, nat, prev, row.items[0].n, autoClose, r))), js::stringify(row.items[2]));
            }
        }
    }

    void pnlValidateEvaluate() {
        for (const OJson& c : fx_.get(u"pnl"_s)->items) {
            const tk::Position& p = P(c.get(u"p"_s));
            const OJson pr = dec(*c.get(u"price"_s));
            const std::optional<double> price = pr.type == OJson::Number ? std::optional(pr.n) : std::nullopt;
            JSFIX_SAME(*c.get(u"out"_s), tk::unrealized(p, price), u"unrealized"_s);
            JSFIX_SAME(*c.get(u"mv"_s), optN(tk::marketValue(p, price)), u"marketValue"_s);
        }
        for (const OJson& c : fx_.get(u"validate"_s)->items) {
            const tk::Position& p = P(c.get(u"p"_s));
            const OJson t = dec(*c.get(u"t"_s)), pr = dec(*c.get(u"price"_s));
            const std::optional<double> price = pr.type == OJson::Number ? std::optional(pr.n) : std::nullopt;
            JSFIX_EXPECT(c, [&] { tk::validate(p, t, price); return js::S(u"ok"_s); }, u"validate "_s + js::stringify(t));
        }
        int n = 0;
        for (const OJson& c : fx_.get(u"evaluate"_s)->items) {
            const tk::Position& p = P(c.get(u"p"_s));
            const OJson t = dec(*c.get(u"t"_s)), pr = dec(*c.get(u"price"_s)), pk = dec(*c.get(u"peak"_s)), o = dec(*c.get(u"opts"_s));
            const auto asOpt = [](const OJson* v) -> std::optional<double> { return v && v->type == OJson::Number ? std::optional(v->n) : std::nullopt; };
            tk::EvaluateOpts opts;
            // 'stopPrice' in opts 与 opts.stopPrice === undefined 不是一回事:夹具里两样都记着
            opts.hasStopPrice = c.get(u"hasStop"_s)->b && o.get(u"stopPrice"_s);
            opts.stopPrice = asOpt(o.get(u"stopPrice"_s));
            opts.hasPeakPrice = c.get(u"hasPeak"_s)->b && o.get(u"peakPrice"_s);
            opts.peakPrice = asOpt(o.get(u"peakPrice"_s));
            const OJson* minute = c.get(u"minute"_s);
            JSFIX_EXPECT(c, [&] { return tk::evaluate(p, t, asOpt(&pr), asOpt(&pk), minute->type == OJson::Number ? std::optional(minute->n) : std::nullopt, opts); },
                         u"evaluate #%1"_s.arg(n));
            ++n;
        }
        for (const OJson& c : fx_.get(u"triggers"_s)->items) {
            const OJson r = dec(*c.get(u"r"_s)), t = dec(*c.get(u"t"_s));
            const OJson* target = c.get(u"target"_s);
            const OJson* stop = c.get(u"stop"_s);
            JSFIX_SAME(*c.get(u"out"_s), tk::withSpotTriggers(r, u"SPX"_s, t, target->type == OJson::Null ? nullptr : target, stop->type == OJson::Null ? nullptr : stop),
                       u"withSpotTriggers"_s);
        }
        for (const OJson& c : fx_.get(u"unreachable"_s)->items) {
            std::optional<QSet<QString>> cov;
            if (c.get(u"cov"_s)->type == OJson::Array) {
                QSet<QString> s;
                for (const OJson& x : c.get(u"cov"_s)->items) s.insert(x.s);
                cov = s;
            }
            const auto r = tk::unreachableReason(cov, c.get(u"acct"_s));
            JSFIX_SAME(*c.get(u"out"_s), r ? js::S(*r) : OJson::null(), u"unreachableReason"_s);
        }
    }

    void closing() {
        for (const OJson& c : fx_.get(u"autos"_s)->items) JSFIX_SAME(*c.get(u"out"_s), tk::makeAutoClose(dec(*c.get(u"raw"_s))), u"makeAutoClose"_s);
        for (const OJson& c : fx_.get(u"blockers"_s)->items) {
            const OJson& a = *c.get(u"args"_s);
            tk::CloseGateArgs g;
            g.autoClose = a.get(u"auto"_s);
            g.position = &P(c.get(u"p"_s));
            g.accountIsPaper = a.get(u"accountIsPaper"_s)->b;
            g.autoExecute = a.get(u"autoExecute"_s)->b;
            g.allowLiveTrading = a.get(u"allowLiveTrading"_s)->b;
            g.breakerEngaged = a.get(u"breakerEngaged"_s)->b;
            g.marketStatus = a.get(u"marketStatus"_s)->s;
            g.outsideRth = a.get(u"outsideRth"_s)->b;
            g.alreadyFired = a.get(u"alreadyFired"_s)->b;
            JSFIX_SAME(*c.get(u"out"_s), js::strings(tk::closeBlockers(g)), u"closeBlockers"_s);
        }
        for (const OJson& c : fx_.get(u"qty"_s)->items)
            JSFIX_EXPECT(c, [&] { return js::N(tk::closeQty(P(c.get(u"p"_s)), *c.get(u"auto"_s))); }, u"closeQty"_s);
        for (const OJson& c : fx_.get(u"limit"_s)->items) {
            const OJson* pr = c.get(u"price"_s);
            const auto price = pr->type == OJson::Number ? std::optional(pr->n) : std::nullopt;
            JSFIX_SAME(*c.get(u"out"_s), optN(tk::closeLimitPrice(P(c.get(u"p"_s)), price, c.get(u"slip"_s))), u"closeLimitPrice"_s);
        }
        for (const OJson& c : fx_.get(u"close"_s)->items) {
            const OJson contract = c.get(u"c"_s)->s == u"__extra" ? dec(*c.get(u"raw"_s)) : *C(c.get(u"c"_s));
            JSFIX_EXPECT(c, [&] { return tk::closeContract(contract); }, u"closeContract "_s + js::stringify(contract));
        }
        for (const OJson& c : fx_.get(u"closeIssue"_s)->items) {
            const OJson row = dec(*c.get(u"row"_s));
            const auto r = tk::closeContractIssue(&row);
            JSFIX_SAME(*c.get(u"out"_s), r ? js::S(*r) : OJson::null(), u"closeContractIssue "_s + js::stringify(row));
        }
        int n = 0;
        for (const OJson& c : fx_.get(u"orders"_s)->items) {
            const OJson* pr = c.get(u"price"_s);
            const auto price = pr->type == OJson::Number ? std::optional(pr->n) : std::nullopt;
            JSFIX_EXPECT(c, [&] { return tk::buildCloseOrder(P(c.get(u"p"_s)), *c.get(u"auto"_s), price, c.get(u"state"_s)->s, *C(c.get(u"c"_s)), c.get(u"ms"_s)->s); },
                         u"buildCloseOrder #%1"_s.arg(n));
            ++n;
        }
    }

    void hosted() {
        for (const OJson& c : fx_.get(u"ptrail"_s)->items) {
            const auto o = [](const OJson* v) { return v->type == OJson::Number ? std::optional(v->n) : std::nullopt; };
            JSFIX_SAME(*c.get(u"out"_s), optN(tk::profitTrailStopPrice(P(c.get(u"p"_s)), o(c.get(u"peak"_s)), o(c.get(u"dd"_s)), o(c.get(u"fl"_s)))), u"profitTrailStopPrice"_s);
        }
        for (const OJson& c : fx_.get(u"hosted"_s)->items) {
            const OJson* pk = c.get(u"peak"_s);
            JSFIX_EXPECT(c, [&] { return tk::hostedPlan(P(c.get(u"p"_s)), *c.get(u"t"_s), *c.get(u"auto"_s), pk->type == OJson::Number ? std::optional(pk->n) : std::nullopt); },
                         u"hostedPlan"_s);
        }
        for (const OJson& c : fx_.get(u"needs"_s)->items) QCOMPARE(tk::hostedNeedsUpdate(dec(*c.get(u"a"_s)), dec(*c.get(u"b"_s))), c.get(u"out"_s)->b);
    }
};

QTEST_GUILESS_MAIN(TestTracker)
#include "tst_tracker.moc"
