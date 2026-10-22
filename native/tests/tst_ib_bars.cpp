// engine/execution/ib_bars(ibBars.ts)对着原模块现跑的答案(tests/fixtures/gen_ib_bars.mjs):
// K 线时间归一化、各条线开没开着 / 上次收盘、两条线拼起来、指数按期货推算、取数报错的翻译(逐字符比 JSON);
// SessionBars 的场景(脚本驱动的假会话:会话上每一次调用、各步取回的 K 线与它旁边记的两笔、夜盘与期货最近一次要不到的原因)。
#include "execsupport_world.h"
#include "execution/ib_bars.h"
#include "util/jsformat.h"

#include <QMap>
#include <QSet>
#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
namespace ex = execution;
using execw::World;
using jsfix::dec;
using util::OJson;
using util::Task;
namespace js = util::js;

namespace {

OJson barJson(const ex::SessionBar& b) {
    return js::object({{u"time"_s, js::S(b.time)}, {u"open"_s, js::N(b.open)}, {u"high"_s, js::N(b.high)}, {u"low"_s, js::N(b.low)},
                       {u"close"_s, js::N(b.close)}, {u"volume"_s, js::N(b.volume)}});
}
OJson barsJson(const std::vector<ex::SessionBar>& bars) {
    OJson a = js::array();
    for (const auto& b : bars) a.items.append(barJson(b));
    return a;
}
std::vector<ex::SessionBar> barsFrom(const OJson& arr) {
    std::vector<ex::SessionBar> out;
    for (const OJson& raw : arr.items) {
        const OJson b = dec(raw);
        out.push_back({b.get(u"time"_s)->s, b.get(u"open"_s)->n, b.get(u"high"_s)->n, b.get(u"low"_s)->n, b.get(u"close"_s)->n, b.get(u"volume"_s)->n});
    }
    return out;
}
OJson spansJson(const std::vector<ex::TimeSpan>& spans) {
    OJson a = js::array();
    for (const auto& s : spans) a.items.append(js::object({{u"from"_s, js::S(s.from)}, {u"to"_s, js::S(s.to)}}));
    return a;
}
ex::SessionLeg legFrom(const QString& s) {
    if (s == u"day") return ex::SessionLeg::Day;
    if (s == u"overnight") return ex::SessionLeg::Overnight;
    if (s == u"index") return ex::SessionLeg::Index;
    return ex::SessionLeg::Proxy;
}
OJson taggedJson(const ex::TaggedBars& t) {
    OJson o = js::object({{u"bars"_s, barsJson(t.bars)}});
    if (t.feed) o.set(u"feed"_s, js::S(*t.feed == ex::BarsFeed::Live ? u"live"_s : *t.feed == ex::BarsFeed::Delayed ? u"delayed"_s : u"unknown"_s));
    if (t.proxy) {
        o.set(u"proxy"_s, js::object({{u"futures"_s, js::S(t.proxy->futures)}, {u"derived"_s, js::N(t.proxy->derived)}, {u"note"_s, js::S(t.proxy->note)},
                                      {u"spans"_s, spansJson(t.proxy->spans)}}));
    }
    return o;
}
OJson errorsJson(const contract::OrderedMap<QString>& m) {
    OJson a = js::array();
    for (const QString& k : m.keys()) a.items.append(js::array({js::S(k), js::S(*m.find(k))}));
    return a;
}
}  // namespace

class TstIbBars : public QObject {
    Q_OBJECT
private slots:
    void stamp() {
        const OJson fx = jsfix::load(u"ib_bars.json"_s);
        for (const OJson& c : fx.get(u"stamp"_s)->items) JSFIX_EXPECT(c, [&] { return js::S(ex::barTimestamp(c.get(u"s"_s)->s)); }, u"barTimestamp(%1)"_s.arg(js::stringify(*c.get(u"s"_s))));
    }

    void toBar() {
        const OJson fx = jsfix::load(u"ib_bars.json"_s);
        for (const OJson& c : fx.get(u"toBar"_s)->items) {
            JSFIX_EXPECT(c, [&] {
                const OJson b = dec(*c.get(u"bar"_s));
                ex::RawBar r;
                r.date = b.get(u"date"_s)->s;
                r.open = b.get(u"open"_s)->n;
                r.high = b.get(u"high"_s)->n;
                r.low = b.get(u"low"_s)->n;
                r.close = b.get(u"close"_s)->n;
                if (const OJson* v = b.get(u"volume"_s)) r.volume = v->n;
                return barJson(ex::toSessionBar(r));
            }, u"toSessionBar"_s);
        }
    }

    void legs() {
        const OJson fx = jsfix::load(u"ib_bars.json"_s);
        int n = 0;
        for (const OJson& leg : fx.get(u"open"_s)->items) {
            const ex::SessionLeg l = legFrom(leg.get(u"leg"_s)->s);
            for (const OJson& row : leg.get(u"rows"_s)->items) {
                const double t = row.items[0].n;
                const bool open = ex::legOpen(l, t);
                const auto closed = ex::legClosedSince(l, t);
                const OJson& want = row.items[2];
                if (open != (row.items[1].n == 1) || closed.has_value() != (want.type == OJson::Number) || (closed && *closed != want.n)) {
                    QFAIL(qPrintable(u"%1 @ %2:open=%3 closedSince=%4,期望 open=%5 closedSince=%6"_s.arg(
                        leg.get(u"leg"_s)->s, util::jsNumberToString(t), QString::number(open), closed ? util::jsNumberToString(*closed) : u"null"_s,
                        util::jsNumberToString(row.items[1].n), want.type == OJson::Number ? util::jsNumberToString(want.n) : u"null"_s)));
                }
                ++n;
            }
        }
        QVERIFY(n > 5000);
    }

    void overnight() {
        ex::IbContract t;
        t.secType = u"STK"_s;
        t.symbol = u"SPY"_s;
        t.exchange = u"SMART"_s;
        t.currency = u"USD"_s;
        t.conId = 7;
        t.lastTradeDateOrContractMonth = u"x"_s;
        const OJson want = js::object({{u"secType"_s, js::S(u"STK"_s)}, {u"symbol"_s, js::S(u"SPY"_s)}, {u"exchange"_s, js::S(u"OVERNIGHT"_s)}, {u"currency"_s, js::S(u"USD"_s)}});
        JSFIX_SAME(want, execw::normContract(ex::overnightContract(t)), u"overnightContract"_s);
    }

    void merge() {
        const OJson fx = jsfix::load(u"ib_bars.json"_s);
        for (const OJson& c : fx.get(u"merge"_s)->items) {
            JSFIX_EXPECT(c, [&] { return barsJson(ex::mergeSessionBars(barsFrom(*c.get(u"day"_s)), barsFrom(*c.get(u"night"_s)))); }, u"mergeSessionBars"_s);
        }
    }

    void proxy() {
        const OJson fx = jsfix::load(u"ib_bars.json"_s);
        for (const OJson& c : fx.get(u"proxy"_s)->items) {
            JSFIX_EXPECT(c, [&] {
                const ex::IndexProxyResult r = ex::proxyIndexBars(barsFrom(*c.get(u"index"_s)), barsFrom(*c.get(u"futures"_s)));
                OJson basis = js::Null();
                if (r.latestBasis) basis = js::object({{u"basis"_s, js::N(r.latestBasis->basis)}, {u"time"_s, js::S(r.latestBasis->time)}});
                return js::object({{u"bars"_s, barsJson(r.bars)}, {u"derived"_s, js::N(r.derived)}, {u"spans"_s, spansJson(r.spans)},
                                   {u"newestDerived"_s, js::B(r.newestDerived)}, {u"latestBasis"_s, basis}});
            }, u"proxyIndexBars"_s);
        }
    }

    void barsError() {
        const OJson fx = jsfix::load(u"ib_bars.json"_s);
        for (const OJson& c : fx.get(u"error"_s)->items) {
            JSFIX_EXPECT(c, [&] { return js::S(ex::barsError(c.get(u"sym"_s)->s, c.get(u"label"_s)->s, c.get(u"msg"_s)->s)); }, u"barsError"_s);
        }
    }

    void scenarios() {
        const OJson fixture = jsfix::load(u"ib_bars.json"_s);
        int n = 0;
        for (const OJson& sc : fixture.get(u"scenarios"_s)->items) {
            const QString name = sc.get(u"name"_s)->s;
            const OJson script = dec(*sc.get(u"script"_s));
            World world(script);
            ex::SessionBars sb;
            OJson steps = js::array();
            QMap<QString, Task<ex::TaggedBars>> started;
            QSet<QString> reported;
            for (const OJson& step : script.get(u"steps"_s)->items) {
                OJson rec = js::object();
                const QString op = execw::str(step, u"op"_s);
                rec.set(u"op"_s, js::S(op));
                if (const OJson* id = step.get(u"id"_s)) rec.set(u"id"_s, *id);
                if (!world.commonStep(step)) {
                    if (op != u"fetch") QFAIL(qPrintable(u"不认识的步 "_s + op));
                    ex::SessionBarsRequest req;
                    req.target = execw::contractFrom(*step.get(u"target"_s));
                    req.endDateTime = execw::str(step, u"endDateTime"_s);
                    req.durationStr = execw::str(step, u"durationStr"_s);
                    req.barSizeSetting = execw::str(step, u"barSizeSetting"_s);
                    req.whatToShow = execw::str(step, u"whatToShow"_s);
                    req.useRTH = execw::flag(step, u"useRTH"_s);
                    req.overnight = execw::flag(step, u"overnight"_s);
                    if (const OJson* f = step.get(u"futures"_s); f && f->type == OJson::Object) req.futures = execw::contractFrom(*f);
                    req.nowMs = execw::num(step, u"nowMs"_s);
                    Task<ex::TaggedBars> t = sb.fetch(world.session(u"A"_s), req);
                    if (execw::flag(step, u"start"_s)) {
                        started.insert(step.get(u"id"_s)->s, t);
                    } else {
                        execw::runToDone(world, t);
                        rec.set(u"result"_s, execw::outcome(t, taggedJson));
                    }
                }
                OJson done = js::array();
                for (auto it = started.cbegin(); it != started.cend(); ++it) {
                    if (it.value().done() && !reported.contains(it.key())) {
                        reported.insert(it.key());
                        done.items.append(js::object({{u"id"_s, js::S(it.key())}, {u"result"_s, execw::outcome(it.value(), taggedJson)}}));
                    }
                }
                if (!done.items.isEmpty()) rec.set(u"done"_s, done);
                rec.set(u"errors"_s, js::object({{u"overnight"_s, errorsJson(sb.overnightErrors)}, {u"proxy"_s, errorsJson(sb.proxyErrors)}}));
                rec.set(u"T"_s, js::N(world.T));
                steps.items.append(rec);
            }
            OJson got = js::object({{u"log"_s, world.log}, {u"steps"_s, steps}});
            JSFIX_SAME(*sc.get(u"expected"_s), got, name);
            ++n;
        }
        QVERIFY(n >= 60);
    }
};

QTEST_GUILESS_MAIN(TstIbBars)
#include "tst_ib_bars.moc"
