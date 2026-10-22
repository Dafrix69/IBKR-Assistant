// engine/execution/held_streams(heldStreams.ts)对着原模块现跑的答案(tests/fixtures/gen_held_streams.mjs):
// 持仓常驻行情订阅的账。每个场景是一份脚本(假会话、盘口事件、各步),期望是会话上每一次调用与日志行、各步结果、每步之后账里的样子。
#include "execsupport_world.h"
#include "execution/held_streams.h"

#include <QMap>
#include <QSet>
#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
namespace ex = execution;
using execw::FakeSession;
using execw::World;
using util::OJson;
using util::Task;
namespace js = util::js;

namespace {

/// qualifies 回调的脚本状态(协程拿 shared_ptr,不抓局部变量的引用)
struct QCtx {
    World* world = nullptr;
    OJson list;
    qsizetype qIdx = 0;
};

Task<ex::QualifyKnown> qualifyImpl(std::shared_ptr<QCtx> ctx, ex::IbContract& contract) {
    const OJson o = ctx->list.items[std::min<qsizetype>(ctx->qIdx, ctx->list.items.size() - 1)];
    const qsizetype idx = ctx->qIdx;
    ctx->qIdx += 1;
    ctx->world->rec(QString(), u"qualifies"_s, js::array({execw::normContract(contract)}));
    const double delay = execw::num(o, u"delay"_s);
    if (delay > 0) co_await ctx->world->sleep(delay);
    if (const OJson* t = o.get(u"throw"_s)) throw util::JsError(t->s);
    const OJson* v = o.get(u"v"_s);
    if (v->type == OJson::Bool) {
        if (v->b) contract.conId = 880000 + static_cast<int>(idx);
        co_return v->b ? ex::QualifyKnown::Yes : ex::QualifyKnown::No;
    }
    co_return ex::QualifyKnown::Stalled;
}

OJson snap(const ex::HeldStreams& h) {
    OJson entries = js::array();
    for (const QString& key : h.keys()) {
        const ex::HeldStream& e = *h.find(key);
        OJson o = js::object();
        o.set(u"handle"_s, e.handle ? js::N(std::static_pointer_cast<FakeSession::Handle>(e.handle)->id) : js::Null());
        o.set(u"contract"_s, e.contract ? execw::normContract(*e.contract) : js::Null());
        o.set(u"session"_s, e.session ? js::S(std::static_pointer_cast<FakeSession>(e.session)->name) : js::Null());
        entries.items.append(js::array({js::S(key), o}));
    }
    return js::object({{u"keys"_s, js::strings(h.keys())}, {u"entries"_s, entries}});
}

OJson knownJson(bool b) { return js::B(b); }

}  // namespace

class TstHeldStreams : public QObject {
    Q_OBJECT
private slots:
    void pure() {
        const OJson fx = jsfix::load(u"held_streams.json"_s);
        const OJson& p = *fx.get(u"pure"_s);
        for (const OJson& c : p.get(u"limit"_s)->items) QCOMPARE(ex::silenceLimitMs(c.items[0].s), c.items[1].n);
        for (const OJson& c : p.get(u"silence"_s)->items) {
            const OJson t = jsfix::dec(*c.get(u"t"_s));
            ex::TickerData d;
            if (const OJson* v = t.get(u"quotedAt"_s); v && v->type == OJson::Number) d.quotedAt = v->n;
            if (const OJson* v = t.get(u"requestedAt"_s); v && v->type == OJson::Number) d.requestedAt = v->n;
            const auto got = ex::quoteSilenceMs(d, jsfix::dec(*c.get(u"now"_s)).n);
            JSFIX_SAME(*c.get(u"out"_s), got ? js::N(*got) : js::Null(), u"quoteSilenceMs"_s);
        }
    }

    void scenarios() {
        const OJson fixture = jsfix::load(u"held_streams.json"_s);
        int n = 0;
        for (const OJson& sc : fixture.get(u"scenarios"_s)->items) {
            const QString name = sc.get(u"name"_s)->s;
            const OJson script = jsfix::dec(*sc.get(u"script"_s));
            World world(script);
            QMap<QString, std::shared_ptr<ex::HeldStreams>> held;
            if (const OJson* h = script.get(u"held"_s)) {
                for (const auto& [hn, variant] : h->fields) {
                    held.insert(hn, std::make_shared<ex::HeldStreams>(variant.type == OJson::Null ? std::nullopt : std::optional<QString>(variant.s)));
                }
            } else {
                held.insert(u"main"_s, std::make_shared<ex::HeldStreams>());
            }
            QMap<QString, std::shared_ptr<ex::TickerHandle>> handles;
            auto ctx = std::make_shared<QCtx>();
            ctx->world = &world;
            if (const OJson* q = script.get(u"qualifies"_s)) ctx->list = *q;
            else ctx->list = js::array({js::object({{u"v"_s, js::B(true)}})});
            OJson steps = js::array();
            QMap<QString, Task<bool>> started;
            QSet<QString> reported;
            for (const OJson& step : script.get(u"steps"_s)->items) {
                OJson rec = js::object();
                const QString op = execw::str(step, u"op"_s);
                rec.set(u"op"_s, js::S(op));
                if (const OJson* id = step.get(u"id"_s)) rec.set(u"id"_s, *id);
                if (!world.commonStep(step)) {
                    const std::shared_ptr<ex::HeldStreams> hs = held.value(execw::str(step, u"hs"_s, u"main"_s));
                    std::shared_ptr<ex::IbSession> session;
                    if (const OJson* s = step.get(u"session"_s); s && s->type == OJson::String) session = world.session(s->s);
                    const QString key = execw::str(step, u"key"_s);
                    if (op == u"usable") {
                        std::optional<double> now;
                        if (const OJson* v = step.get(u"now"_s)) now = v->n;
                        rec.set(u"result"_s, js::B(hs->usable(session, key, execw::num(step, u"limit"_s), now)));
                    } else if (op == u"subscribe") {
                        hs->subscribe(session, key, execw::contractFrom(*step.get(u"contract"_s)));
                    } else if (op == u"ensure") {
                        const ex::IbContract target = execw::contractFrom(*step.get(u"contract"_s));
                        Task<bool> t = hs->ensure(
                            session, key,
                            [&world, key, target] {
                                world.rec(QString(), u"target"_s, js::array({js::S(key)}));
                                return target;
                            },
                            [ctx](ex::IbContract& c) { return qualifyImpl(ctx, c); }, execw::num(step, u"limit"_s));
                        if (execw::flag(step, u"start"_s)) {
                            started.insert(step.get(u"id"_s)->s, t);
                        } else {
                            execw::runToDone(world, t);
                            rec.set(u"result"_s, execw::outcome(t, knownJson));
                        }
                    } else if (op == u"sub") {
                        handles.insert(execw::str(step, u"as"_s), session->subscribeTicker(execw::contractFrom(*step.get(u"contract"_s)), execw::str(step, u"generic"_s)));
                    } else if (op == u"setRaw") {
                        ex::HeldStream e;
                        if (const OJson* h = step.get(u"handle"_s); h && h->type == OJson::String) e.handle = handles.value(h->s);
                        if (const OJson* c = step.get(u"contract"_s); c && c->type == OJson::Object) e.contract = execw::contractFrom(*c);
                        e.session = session;
                        hs->set(key, e);
                    } else if (op == u"delete") {
                        hs->erase(key);
                    } else if (op == u"clear") {
                        hs->clear();
                    } else if (op == u"size") {
                        rec.set(u"result"_s, js::N(static_cast<double>(hs->size())));
                    } else if (op == u"release") {
                        QStringList keep;
                        for (const OJson& k : step.get(u"keep"_s)->items) keep.append(k.s);
                        const OJson shared = step.get(u"shared"_s) ? *step.get(u"shared"_s) : js::object();
                        const int released = hs->release(keep, [&](const QString& k) {
                            std::vector<std::shared_ptr<ex::TickerHandle>> out;
                            if (const OJson* l = shared.get(k)) {
                                for (const OJson& nm : l->items) out.push_back(nm.type == OJson::Null ? nullptr : handles.value(nm.s));
                            }
                            return out;
                        });
                        rec.set(u"result"_s, js::N(released));
                    } else {
                        QFAIL(qPrintable(u"不认识的步 "_s + op));
                    }
                }
                OJson done = js::array();
                for (auto it = started.cbegin(); it != started.cend(); ++it) {
                    if (it.value().done() && !reported.contains(it.key())) {
                        reported.insert(it.key());
                        done.items.append(js::object({{u"id"_s, js::S(it.key())}, {u"result"_s, execw::outcome(it.value(), knownJson)}}));
                    }
                }
                if (!done.items.isEmpty()) rec.set(u"done"_s, done);
                OJson state = js::object();
                for (auto it = held.cbegin(); it != held.cend(); ++it) state.set(it.key(), snap(*it.value()));
                rec.set(u"state"_s, state);
                rec.set(u"T"_s, js::N(world.T));
                steps.items.append(rec);
            }
            OJson got = js::object({{u"log"_s, world.log}, {u"steps"_s, steps}});
            JSFIX_SAME(*sc.get(u"expected"_s), got, name);
            ++n;
        }
        QVERIFY(n >= 90);
    }
};

QTEST_GUILESS_MAIN(TstHeldStreams)
#include "tst_held_streams.moc"
