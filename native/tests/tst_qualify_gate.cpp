// engine/execution/qualify_gate(qualifyGate.ts)对着原模块现跑的答案(tests/fixtures/gen_qualify_gate.mjs):
// 每个场景是一份脚本(假会话怎么答、各步做什么),期望是会话上每一次调用的日志、各步的结果、计数。
#include "execsupport_world.h"
#include "execution/qualify_gate.h"

#include <QMap>
#include <QSet>
#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
namespace ex = execution;
using execw::World;
using util::OJson;
namespace js = util::js;
using util::Task;

namespace {
struct Started {
    std::shared_ptr<std::vector<ex::IbContract>> contracts;
    Task<ex::QualifyAnswer> task;
};
OJson answerJson(ex::QualifyAnswer a) { return js::S(a == ex::QualifyAnswer::Ok ? u"ok"_s : u"stalled"_s); }
}  // namespace

class TstQualifyGate : public QObject {
    Q_OBJECT
private slots:
    void scenarios() {
        const OJson fixture = jsfix::load(u"qualify_gate.json"_s);
        int n = 0;
        for (const OJson& sc : fixture.get(u"scenarios"_s)->items) {
            const QString name = sc.get(u"name"_s)->s;
            const OJson script = jsfix::dec(*sc.get(u"script"_s));
            World world(script);
            ex::takeQualifyGateStats();
            OJson steps = js::array();
            QMap<QString, Started> started;
            QSet<QString> reported;
            for (const OJson& step : script.get(u"steps"_s)->items) {
                OJson rec = js::object();
                const QString op = execw::str(step, u"op"_s);
                rec.set(u"op"_s, js::S(op));
                if (const OJson* id = step.get(u"id"_s)) rec.set(u"id"_s, *id);
                if (!world.commonStep(step)) {
                    if (op == u"gate") {
                        auto contracts = std::make_shared<std::vector<ex::IbContract>>();
                        for (const OJson& c : step.get(u"contracts"_s)->items) contracts->push_back(execw::contractFrom(c));
                        std::vector<ex::IbContract*> ptrs;
                        for (auto& c : *contracts) ptrs.push_back(&c);
                        std::function<double()> now;
                        if (const OJson* v = step.get(u"now"_s)) now = [x = v->n] { return x; };
                        Task<ex::QualifyAnswer> t = ex::qualifyGated(world.session(execw::str(step, u"session"_s)), ptrs, static_cast<int>(execw::num(step, u"timeout"_s)),
                                                                     execw::flag(step, u"wait"_s), now);
                        if (execw::flag(step, u"start"_s)) {
                            started.insert(step.get(u"id"_s)->s, {contracts, t});
                        } else {
                            execw::runToDone(world, t);
                            rec.set(u"result"_s, execw::outcome(t, answerJson));
                        }
                        OJson cs = js::array();
                        for (const auto& c : *contracts) cs.items.append(execw::normContract(c));
                        rec.set(u"contracts"_s, cs);
                    } else if (op == u"take") {
                        const ex::QualifyGateStats s = ex::takeQualifyGateStats();
                        rec.set(u"stats"_s, js::object({{u"timeouts"_s, js::N(s.timeouts)}, {u"skipped"_s, js::N(s.skipped)}, {u"probes"_s, js::N(s.probes)}}));
                    } else {
                        QFAIL(qPrintable(u"不认识的步 "_s + op));
                    }
                }
                OJson done = js::array();
                for (auto it = started.cbegin(); it != started.cend(); ++it) {  // QMap 按键排序:同 JS 里按 id 排
                    if (it.value().task.done() && !reported.contains(it.key())) {
                        reported.insert(it.key());
                        done.items.append(js::object({{u"id"_s, js::S(it.key())}, {u"result"_s, execw::outcome(it.value().task, answerJson)}}));
                    }
                }
                if (!done.items.isEmpty()) rec.set(u"done"_s, done);
                rec.set(u"T"_s, js::N(world.T));
                steps.items.append(rec);
            }
            const ex::QualifyGateStats s = ex::takeQualifyGateStats();
            OJson got = js::object({{u"log"_s, world.log}, {u"steps"_s, steps},
                                    {u"stats"_s, js::object({{u"timeouts"_s, js::N(s.timeouts)}, {u"skipped"_s, js::N(s.skipped)}, {u"probes"_s, js::N(s.probes)}})}});
            JSFIX_SAME(*sc.get(u"expected"_s), got, name);
            ++n;
        }
        QVERIFY(n >= 100);
    }
};

QTEST_GUILESS_MAIN(TstQualifyGate)
#include "tst_qualify_gate.moc"
