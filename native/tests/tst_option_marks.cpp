// engine/execution/option_marks(optionMarks.ts)对着原模块现跑的答案(tests/fixtures/gen_option_marks.mjs):
// 几条期权腿的盘口与模型 IV。每个场景是一份脚本(假会话、盘口事件、各步),期望是会话上每一次调用、setInterval / clearInterval、
// 各步结果与流的条数。setInterval 换成世界里的假钟。
#include "execsupport_world.h"
#include "execution/option_marks.h"

#include <QMap>
#include <QSet>
#include <QTest>

#include <map>

using namespace ibkr;
using namespace Qt::StringLiterals;
namespace ex = execution;
using execw::World;
using util::OJson;
using util::Task;
namespace js = util::js;

namespace {

OJson marksJson(const std::vector<ex::OptionMark>& marks) {
    OJson a = js::array();
    for (const auto& m : marks) {
        a.items.append(js::object({{u"strike"_s, js::N(m.strike)}, {u"right"_s, js::S(m.right)}, {u"bid"_s, js::NOrNull(m.bid)}, {u"ask"_s, js::NOrNull(m.ask)},
                                   {u"iv"_s, js::NOrNull(m.iv)}, {u"error"_s, m.error ? js::S(*m.error) : js::Null()}}));
    }
    return a;
}

struct TimerMap {
    std::map<quint64, std::shared_ptr<World::Timer>> m;
    quint64 next = 1;
};

}  // namespace

class TstOptionMarks : public QObject {
    Q_OBJECT
private slots:
    void scenarios() {
        const OJson fixture = jsfix::load(u"option_marks.json"_s);
        int n = 0;
        for (const OJson& sc : fixture.get(u"scenarios"_s)->items) {
            const QString name = sc.get(u"name"_s)->s;
            const OJson script = jsfix::dec(*sc.get(u"script"_s));
            World world(script);
            auto tm = std::make_shared<TimerMap>();
            ex::IntervalTimers timers;
            timers.start = [&world, tm](int ms, std::function<void()> fn) {
                world.rec(QString(), u"setInterval"_s, js::array({js::N(ms)}));
                const quint64 id = tm->next++;
                tm->m[id] = world.every(ms, std::move(fn));
                return id;
            };
            timers.stop = [&world, tm](quint64 id) {
                world.rec(QString(), u"clearInterval"_s, js::array());
                world.cancel(tm->m[id]);
                tm->m.erase(id);
            };
            ex::OptionMarkStreams streams(timers);
            OJson steps = js::array();
            QMap<QString, Task<std::vector<ex::OptionMark>>> started;
            QSet<QString> reported;
            for (const OJson& step : script.get(u"steps"_s)->items) {
                OJson rec = js::object();
                const QString op = execw::str(step, u"op"_s);
                rec.set(u"op"_s, js::S(op));
                if (const OJson* id = step.get(u"id"_s)) rec.set(u"id"_s, *id);
                if (!world.commonStep(step)) {
                    if (op == u"read") {
                        std::vector<ex::OptionLegSpec> legs;
                        for (const OJson& l : step.get(u"legs"_s)->items) {
                            ex::OptionLegSpec s;
                            s.symbol = execw::str(l, u"symbol"_s);
                            s.expiry = execw::str(l, u"expiry"_s);
                            s.strike = execw::num(l, u"strike"_s);
                            s.right = execw::str(l, u"right"_s);
                            s.exchange = execw::str(l, u"exchange"_s);
                            s.tradingClass = execw::str(l, u"tradingClass"_s);
                            legs.push_back(s);
                        }
                        Task<std::vector<ex::OptionMark>> t = streams.read(world.session(execw::str(step, u"session"_s)), legs, execw::flag(step, u"delayedOk"_s), execw::num(step, u"limit"_s));
                        if (execw::flag(step, u"start"_s)) {
                            started.insert(step.get(u"id"_s)->s, t);
                        } else {
                            execw::runToDone(world, t);
                            rec.set(u"result"_s, execw::outcome(t, marksJson));
                        }
                    } else if (op == u"close") {
                        streams.close();
                    } else {
                        QFAIL(qPrintable(u"不认识的步 "_s + op));
                    }
                }
                OJson done = js::array();
                for (auto it = started.cbegin(); it != started.cend(); ++it) {
                    if (it.value().done() && !reported.contains(it.key())) {
                        reported.insert(it.key());
                        done.items.append(js::object({{u"id"_s, js::S(it.key())}, {u"result"_s, execw::outcome(it.value(), marksJson)}}));
                    }
                }
                if (!done.items.isEmpty()) rec.set(u"done"_s, done);
                rec.set(u"size"_s, js::N(static_cast<double>(streams.size())));
                rec.set(u"T"_s, js::N(world.T));
                steps.items.append(rec);
            }
            OJson got = js::object({{u"log"_s, world.log}, {u"steps"_s, steps}});
            streams.close();
            JSFIX_SAME(*sc.get(u"expected"_s), got, name);
            ++n;
        }
        QVERIFY(n >= 80);
    }
};

QTEST_GUILESS_MAIN(TstOptionMarks)
#include "tst_option_marks.moc"
