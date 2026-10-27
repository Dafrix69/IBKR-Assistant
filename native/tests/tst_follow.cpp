// engine/parsing/follow(follow.ts)对着原模块现跑的答案(tests/fixtures/gen_follow.mjs),逐字比。
#include "js_fixture.h"
#include "parsing/follow.h"

#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using util::OJson;
namespace js = util::js;
namespace fo = parsing::follow;

namespace {
QString fromHex(const QString& h) {
    const QByteArray b = QByteArray::fromHex(h.toLatin1());
    return QString(reinterpret_cast<const QChar*>(b.constData()), b.size() / 2);
}
QString toHex(const QString& s) { return QString::fromLatin1(QByteArray(reinterpret_cast<const char*>(s.utf16()), s.size() * 2).toHex()); }
contract::FollowConfig cfgOf(const OJson& o) {
    contract::FollowConfig c;
    c.enabled = o.get(u"enabled"_s)->b;
    c.channel_id = o.get(u"channel_id"_s)->s;
    for (const OJson& a : o.get(u"author_ids"_s)->items) c.author_ids << a.s;
    c.max_age_seconds = o.get(u"max_age_seconds"_s)->n;
    c.max_orders_per_day = o.get(u"max_orders_per_day"_s)->n;
    c.max_risk_usd = o.get(u"max_risk_usd"_s)->n;
    c.local_inbox = o.get(u"local_inbox"_s)->b;
    return c;
}
OJson optS(const std::optional<QString>& s) { return s ? js::S(*s) : OJson::null(); }
}  // namespace

class TestFollow : public QObject {
    Q_OBJECT
    OJson fx_;
    std::vector<contract::FollowConfig> cfgs_;

private slots:
    void cleanupTestCase() { jsfix::rewrite(u"follow.json"_s, fx_); }
    void initTestCase() {
        fx_ = jsfix::load(u"follow.json"_s);
        for (const OJson& c : fx_.get(u"cfgs"_s)->items) cfgs_.push_back(cfgOf(c));
    }

    void textsAndTriage() {
        for (const OJson& c : fx_.get(u"texts"_s)->items) {
            const QString t = fromHex(c.get(u"t"_s)->s);
            const QString o = fo::orderText(t);
            QCOMPARE(toHex(o), c.get(u"order"_s)->s);
            JSFIX_SAME(*c.get(u"why"_s), optS(fo::whyUnparsed(o)), u"whyUnparsed"_s);
        }
        for (const OJson& c : fx_.get(u"triage"_s)->items) {
            const OJson& m = *c.get(u"msg"_s);
            const fo::FollowMessage msg{m.get(u"channel_id"_s)->s, m.get(u"author_id"_s)->s, fromHex(m.get(u"content"_s)->s), m.get(u"sentAtMs"_s)->n};
            const fo::Triage t = fo::triage(cfgs_[size_t(c.get(u"c"_s)->n)], msg, c.get(u"nowMs"_s)->n);
            OJson got = js::object({{u"kind"_s, js::S(t.kind)}});
            if (t.kind == u"stale") got.set(u"detail"_s, js::S(t.detail));
            JSFIX_SAME(*c.get(u"out"_s), got, u"triage"_s);
        }
    }

    void decisions() {
        for (const OJson& c : fx_.get(u"decide"_s)->items) {
            const OJson& g = *c.get(u"g"_s);
            fo::FollowGates gates;
            if (g.get(u"breaker"_s)->type == OJson::String) gates.breaker = g.get(u"breaker"_s)->s;
            gates.connected = g.get(u"connected"_s)->b;
            const fo::Decision d = fo::decide(cfgs_[size_t(c.get(u"c"_s)->n)], dec(*c.get(u"p"_s)), gates, c.get(u"sent"_s)->n);
            JSFIX_SAME(*c.get(u"out"_s), d.toJson(),
                       u"decide "_s + js::stringify(*c.get(u"p"_s)).left(200));
        }
        for (const OJson& c : fx_.get(u"center"_s)->items) {
            const auto p = fo::relativeCenterProblem(dec(*c.get(u"p"_s)), jsfix::num(c.get(u"spot"_s)));
            JSFIX_SAME(*c.get(u"out"_s), p ? js::object({{u"summary"_s, js::S(p->summary)}, {u"detail"_s, js::S(p->detail)}}) : OJson::null(), u"relativeCenterProblem"_s);
        }
        for (const OJson& c : fx_.get(u"worst"_s)->items) {
            if (const OJson* credit = c.get(u"credit"_s)) {
                QCOMPARE(fo::creditWorstCaseUsd(c.get(u"q"_s)->n, c.get(u"c"_s)->n, c.get(u"w"_s)->n), credit->n);
                continue;
            }
            const OJson* pr = c.get(u"pr"_s);
            QCOMPARE(fo::worstCaseUsd(c.get(u"q"_s)->n, pr->type == OJson::Null ? std::nullopt : std::optional(pr->n), c.get(u"w"_s)->n), c.get(u"out"_s)->n);
        }
    }

    void outcomesAndQuotes() {
        for (const OJson& c : fx_.get(u"outcomes"_s)->items) {
            const fo::OutcomeResult r = fo::outcomeOf(*c.get(u"r"_s));
            JSFIX_SAME(*c.get(u"out"_s), js::object({{u"outcome"_s, js::S(r.outcome)}, {u"detail"_s, js::S(r.detail)}, {u"record_ids"_s, js::strings(r.record_ids)}}), u"outcomeOf"_s);
        }
        for (const OJson& c : fx_.get(u"leader"_s)->items) {
            const auto l = fo::leaderPrice(dec(*c.get(u"contract"_s)), dec(*c.get(u"order"_s)));
            JSFIX_SAME(*c.get(u"out"_s), l ? js::object({{u"side"_s, js::S(l->side)}, {u"price"_s, js::N(l->price)}}) : OJson::null(), u"leaderPrice"_s);
        }
        for (const OJson& c : fx_.get(u"quotes"_s)->items)
            JSFIX_SAME(*c.get(u"out"_s),
                       fo::followQuote({c.get(u"side"_s)->s, 2.5}, jsfix::num(c.get(u"mid"_s)), jsfix::num(c.get(u"nat"_s)), jsfix::num(c.get(u"lag"_s)),
                                       c.get(u"side"_s)->s == u"credit"),
                       u"followQuote"_s);
        for (const OJson& c : fx_.get(u"params"_s)->items) JSFIX_SAME(*c.get(u"out"_s), fo::flyTrackParams(c.get(u"key"_s)->s, c.get(u"ex"_s)->s), u"flyTrackParams"_s);
    }

    void pending() {
        for (const OJson& c : fx_.get(u"pending"_s)->items) {
            const OJson raw = dec(*c.get(u"raw"_s));
            OJson got = js::array();
            for (const fo::PendingTrack& t : fo::pendingTracksOf(&raw)) got.items.append(t.toJson());
            JSFIX_SAME(*c.get(u"out"_s), got, u"pendingTracksOf"_s);
        }
        for (const OJson& c : fx_.get(u"verdicts"_s)->items) {
            const QString leg = c.get(u"leg"_s)->s;
            const double at = c.get(u"at"_s)->n;
            if (const OJson* last = c.get(u"last"_s)) {
                QCOMPARE(fo::pendingLastDay(leg, at), last->s);
                continue;
            }
            const OJson& f = *c.get(u"facts"_s);
            fo::PendingFacts facts;
            facts.nowMs = f.get(u"nowMs"_s)->n;
            facts.filled = f.get(u"filled"_s)->b;
            facts.final_ = f.get(u"final"_s)->b;
            if (f.get(u"held"_s)->type == OJson::Bool) facts.held = f.get(u"held"_s)->b;
            facts.track = f.get(u"track"_s)->s;
            facts.misses = f.get(u"misses"_s)->n;
            QCOMPARE(fo::pendingVerdict(leg, at, facts), c.get(u"out"_s)->s);
        }
        for (const OJson& c : fx_.get(u"remainders"_s)->items) {
            const OJson& f = *c.get(u"rf"_s);
            const OJson settled = dec(*c.get(u"settled"_s));
            const OJson* sraw = c.get(u"settled"_s);
            const std::optional<double> s = sraw->type == OJson::Number ? std::optional(settled.n) : std::nullopt;
            QCOMPARE(fo::remainderVerdict(c.get(u"leg"_s)->s, c.get(u"at"_s)->n, s, f.get(u"nowMs"_s)->n, f.get(u"final"_s)->b, f.get(u"fills"_s)->n, f.get(u"track"_s)->s),
                     c.get(u"out"_s)->s);
        }
        for (const OJson& c : fx_.get(u"exits"_s)->items) {
            const OJson track = dec(*c.get(u"track"_s));
            JSFIX_EXPECT(c, [&] { return js::S(fo::trackExitsText(track, c.get(u"nowMs"_s)->n)); }, u"trackExitsText"_s);
        }
    }
};

QTEST_GUILESS_MAIN(TestFollow)
#include "tst_follow.moc"
