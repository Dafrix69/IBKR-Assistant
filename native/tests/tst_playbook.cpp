// engine/analysis/playbook(playbook.ts + sessionEm.ts)对着原模块现跑的答案(tests/fixtures/gen_playbook.mjs):
// 状态机 41 条长走法的每一步(状态、触发线、丢掉的线、加速档、事件)与最后整台机器,区间、目标位、加速档、重启接续、折回全天 1σ。
#include "analysis/playbook.h"
#include "js_fixture.h"

#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using jsfix::enc;
using util::OJson;
namespace js = util::js;
namespace pb = analysis::playbook;

namespace {
double num(const OJson* v) { return jsfix::num(v); }
std::optional<double> optNum(const OJson* v) {
    if (!v || v->type == OJson::Null) return std::nullopt;
    return dec(*v).n;
}
OJson optN(const std::optional<double>& v) { return v ? js::N(*v) : OJson::null(); }
std::optional<pb::Band> optBand(const OJson* v) {
    if (!v || v->type == OJson::Null) return std::nullopt;
    return pb::Band::fromJson(dec(*v));
}
OJson bandJson(const std::optional<pb::Band>& b) { return b ? b->toJson() : OJson::null(); }
std::vector<pb::WallStrike> strikes(const OJson* list) {
    std::vector<pb::WallStrike> out;
    for (const OJson& s : list->items) out.push_back({num(s.get(u"strike"_s)), num(s.get(u"net_gex"_s))});
    return out;
}
OJson machineRow(const pb::Machine& m) {
    return js::array({js::S(m.state), optN(m.trigger), optN(m.since), optN(m.lost),
                      m.accel ? js::array({js::N(m.accel->strike), js::S(m.accel->side), js::B(m.accel->armed)}) : OJson::null()});
}
pb::Machine machineOf(const OJson& o) {
    pb::Machine m;
    m.state = o.get(u"state"_s)->s;
    m.trigger = optNum(o.get(u"trigger"_s));
    m.since = optNum(o.get(u"since"_s));
    m.lost = optNum(o.get(u"lost"_s));
    if (const OJson* a = o.get(u"accel"_s); a && a->type == OJson::Object)
        m.accel = pb::MachineAccel{num(a->get(u"strike"_s)), a->get(u"side"_s)->s, a->get(u"armed"_s)->b};
    for (const auto& [k, v] : o.get(u"fired"_s)->fields) m.fired.push_back({k, num(&v)});
    return m;
}
}  // namespace

class TestPlaybook : public QObject {
    Q_OBJECT
    OJson fx_;

private slots:
    void initTestCase() { fx_ = jsfix::load(u"playbook.json"_s); }

    void basics() {
        for (const OJson& c : fx_.get(u"mids"_s)->items)
            JSFIX_SAME(*c.get(u"out"_s), optN(pb::legMid(optNum(c.get(u"bid"_s)), optNum(c.get(u"ask"_s)))), u"legMid"_s);
        for (const OJson& c : fx_.get(u"atm"_s)->items)
            JSFIX_SAME(*c.get(u"out"_s), js::N(pb::atmStrike(num(c.get(u"s"_s)), num(c.get(u"step"_s)))), u"atmStrike"_s);
        for (const OJson& c : fx_.get(u"bands"_s)->items) {
            const OJson spec = dec(*c.get(u"spec"_s));
            const pb::BandSpec s{num(spec.get(u"at"_s)), num(spec.get(u"anchor"_s)), num(spec.get(u"strike"_s)), spec.get(u"expiry"_s)->s,
                                 num(spec.get(u"call"_s)), num(spec.get(u"put"_s)), spec.get(u"source"_s)->s};
            JSFIX_SAME(*c.get(u"out"_s), bandJson(pb::makeBand(s)), u"makeBand "_s + js::stringify(*c.get(u"spec"_s)));
        }
        for (const OJson& c : fx_.get(u"today"_s)->items) {
            std::optional<pb::Anchor> anchor;
            if (const OJson* a = c.get(u"anchor"_s); a->type == OJson::Object)
                anchor = pb::Anchor{num(a->get(u"at"_s)), num(a->get(u"price"_s)), a->get(u"source"_s)->s};
            JSFIX_SAME(*c.get(u"out"_s), bandJson(pb::todayBand(anchor, optBand(c.get(u"current"_s)))), u"todayBand"_s);
        }
        for (const OJson& c : fx_.get(u"spans"_s)->items) {
            // typeof level === "number":串、null、undefined 都不算
            std::vector<std::optional<double>> levels;
            for (const OJson& l : c.get(u"levels"_s)->items) {
                const OJson d = dec(l);
                levels.push_back(d.type == OJson::Number ? std::optional(d.n) : std::nullopt);
            }
            JSFIX_SAME(*c.get(u"out"_s), optN(pb::wallSpan(num(c.get(u"spot"_s)), levels)), u"wallSpan"_s);
        }
        for (const OJson& c : fx_.get(u"keys"_s)->items) {
            const OJson& e = *c.get(u"e"_s);
            QCOMPARE(pb::quietKey(e.get(u"kind"_s)->s, e.get(u"state"_s)->s, num(e.get(u"level"_s))), c.get(u"out"_s)->s);
        }
    }

    void walks() {
        int steps = 0;
        for (const OJson& w : fx_.get(u"walks"_s)->items) {
            pb::Machine m;
            if (const OJson* start = w.get(u"start"_s); start->type == OJson::Object) m = machineOf(dec(*start));
            for (const OJson& st : w.get(u"steps"_s)->items) {
                const OJson& in = st.items[0];
                pb::MachineInput input{num(&in.items[0]), num(&in.items[1]), optNum(&in.items[2]), optNum(&in.items[3]), in.items[4].b, optNum(&in.items[5])};
                const auto [next, events] = pb::stepMachine(m, input);
                JSFIX_SAME(st.items[1], machineRow(next), u"第 %1 步的状态"_s.arg(steps));
                OJson ev = js::array();
                for (const pb::Event& e : events) ev.items.append(js::array({js::N(e.at), js::S(e.kind), js::S(e.state), js::N(e.level), js::N(e.price)}));
                JSFIX_SAME(st.items[2], ev, u"第 %1 步的事件"_s.arg(steps));
                m = next;
                ++steps;
            }
            JSFIX_SAME(*w.get(u"end"_s), m.toJson(), u"走完之后的整台机器"_s);
        }
        QVERIFY(steps > 10000);
    }

    void restore() {
        for (const OJson& c : fx_.get(u"restore"_s)->items) {
            std::optional<pb::MachineMark> mark;
            if (const OJson* mk = c.get(u"mark"_s); mk->type == OJson::Object)
                mark = pb::MachineMark{num(mk->get(u"at"_s)), mk->get(u"state"_s)->s, optNum(mk->get(u"trigger"_s)), optNum(mk->get(u"since"_s)), optNum(mk->get(u"lost"_s))};
            std::vector<pb::Event> events;
            for (const OJson& e : c.get(u"events"_s)->items)
                events.push_back({num(e.get(u"at"_s)), e.get(u"kind"_s)->s, e.get(u"state"_s)->s, num(e.get(u"level"_s)), num(e.get(u"price"_s))});
            const pb::Restored r = pb::restoreMachine(mark, events);
            JSFIX_SAME(*c.get(u"out"_s), js::object({{u"state"_s, js::S(r.state)}, {u"trigger"_s, optN(r.trigger)}, {u"since"_s, optN(r.since)}, {u"lost"_s, optN(r.lost)}}),
                       u"restoreMachine"_s);
        }
    }

    void targetsAndAccel() {
        for (const OJson& c : fx_.get(u"targets"_s)->items) {
            const auto [t1, t2] = pb::targets(c.get(u"state"_s)->s, optNum(c.get(u"trigger"_s)), optBand(c.get(u"open"_s)), strikes(c.get(u"strikes"_s)));
            JSFIX_SAME(*c.get(u"out"_s), js::object({{u"t1"_s, optN(t1)}, {u"t2"_s, optN(t2)}}), u"targets"_s);
        }
        for (const OJson& c : fx_.get(u"accel"_s)->items) {
            const auto a = pb::accelerator(strikes(c.get(u"strikes"_s)), optBand(c.get(u"band"_s)));
            JSFIX_SAME(*c.get(u"out"_s), a ? js::object({{u"strike"_s, js::N(a->strike)}, {u"net_gex"_s, js::N(a->netGex)}}) : OJson::null(), u"accelerator"_s);
        }
    }

    void sessionEm() {
        for (const OJson& c : fx_.get(u"sigma"_s)->items) {
            const pb::Band band = pb::Band::fromJson(dec(*c.get(u"band"_s)));
            std::vector<double> w;
            const OJson* wj = c.get(u"weights"_s);
            const bool custom = !jsfix::isUndefined(wj);
            if (custom)
                for (const OJson& x : wj->items) w.push_back(x.n);
            JSFIX_SAME(*c.get(u"out"_s), optN(pb::sessionSigmaOf(band, custom ? &w : nullptr)), u"sessionSigmaOf "_s + js::stringify(*c.get(u"band"_s)));
        }
        for (const OJson& c : fx_.get(u"sessions"_s)->items) {
            QList<OJson> records;
            for (const OJson& r : c.get(u"records"_s)->items) records << dec(r);
            const auto s = pb::sessionEmOf(records, c.get(u"early"_s)->b);
            JSFIX_SAME(*c.get(u"out"_s), s ? js::object({{u"em"_s, js::N(s->em)}, {u"kind"_s, js::S(s->kind)}, {u"at"_s, js::S(s->at)}}) : OJson::null(),
                       u"sessionEmOf"_s);
        }
    }
};

QTEST_GUILESS_MAIN(TestPlaybook)
#include "tst_playbook.moc"
