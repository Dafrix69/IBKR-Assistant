// engine/analysis/macro(macro.ts)对着原模块现跑的答案(tests/fixtures/gen_macro.mjs):44 串操作,每一步的回包(含挂着、之后才完成的)
// 与取数器被叫的那几次(url、时限)逐字符比;另有 defaultFetcher 对回包的判断、清单、Cboe 载荷取价。
// 挂着的请求每个只有一串在等:放行时 JS 按微任务一拍一拍交替推进几串,util::Task 是一串跑到底再下一串——
// 几串同时挂着、同时放行时,取数的先后与谁先命中谁写的缓存两边会不一样(见报告),夹具里不造这种情形。
#include "analysis/macro.h"
#include "js_fixture.h"
#include "util/js_runtime.h"

#include <QHash>

#include <algorithm>
#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using jsfix::enc;
using util::OJson;
namespace js = util::js;
namespace mc = analysis::macro;

namespace {
double clockSec = 0;

/// 假的取数器:按 url 查路由表(JSON / 抛错 / 挂着等放行)
struct FakeNet {
    QHash<QString, OJson> routes;
    QHash<QString, QList<util::Deferred<OJson>>> pend;
    OJson log = js::array();
    mc::Fetcher fetcher() {
        return [this](const QString& url, double t) -> util::Task<OJson> {
            log.items.append(js::array({js::S(url), js::N(t)}));
            const auto it = routes.constFind(url);
            util::Deferred<OJson> d;
            if (it == routes.cend()) {
                d.reject(util::JsError(u"no route "_s + url));
            } else if (const OJson* th = it->get(u"throw"_s)) {
                d.reject(util::JsError(th->s));
            } else if (const OJson* p = it->get(u"pending"_s)) {
                // 挂着的路由只挡一次(之后换成 then)
                pend[p->s] << d;
                if (const OJson* then = it->get(u"then"_s)) routes.insert(url, *then);
                else routes.remove(url);
            } else {
                d.resolve(*it->get(u"json"_s));
            }
            return d.task();
        };
    }
};

template <class T>
OJson resultOf(const util::Task<T>& t);
template <>
OJson resultOf(const util::Task<OJson>& t) { return t.result(); }
template <>
OJson resultOf(const util::Task<std::optional<double>>& t) {
    const auto v = t.result();
    return v ? js::N(*v) : OJson::null();
}

/// 只排最外一层的键(Object.fromEntries(Object.keys(o).sort()…))
OJson sortTop(const OJson& v) {
    QStringList ks;
    for (const auto& f : v.fields) ks << f.first;
    ks.sort();
    OJson o = js::object();
    for (const QString& k : ks) o.set(k, *v.get(k));
    return o;
}

struct Waiting {
    int op = 0;
    std::function<bool()> done;
    std::function<OJson()> result;  // {out} 或 {error}
};
template <class T>
Waiting watch(int op, util::Task<T> t, bool sortKeys) {
    return {op, [t] { return t.done(); }, [t, sortKeys] {
                try {
                    const OJson v = resultOf(t);
                    return js::object({{u"out"_s, enc(sortKeys ? sortTop(v) : v)}});
                } catch (const util::JsError& e) {
                    return js::object({{u"error"_s, js::S(u"Error: "_s + e.message())}});
                }
            }};
}
}  // namespace

class TestMacro : public QObject {
    Q_OBJECT
    OJson fx_;

private slots:
    void initTestCase() {
        fx_ = jsfix::load(u"macro.json"_s);
        util::setDateNowForTests([] { return clockSec * 1000; });
    }
    void cleanupTestCase() { util::setDateNowForTests({}); }

    void tables() {
        OJson syms = js::array(mc::macroSymbols());
        QCOMPARE(js::stringify(syms), js::stringify(*fx_.get(u"symbols"_s)));
        QCOMPARE(js::stringify(js::strings(mc::liveTickers())), js::stringify(*fx_.get(u"live"_s)));
        for (const OJson& c : fx_.get(u"cboeLast"_s)->items) {
            OJson h;
            const OJson* p = jsfix::isUndefined(c.get(u"p"_s)) ? nullptr : &(h = dec(*c.get(u"p"_s)));
            const auto v = mc::cboeLast(p);
            QCOMPARE(js::stringify(enc(v ? js::N(*v) : OJson::null())), js::stringify(*c.get(u"out"_s)));
        }
    }

    void fetched() {
        for (const OJson& c : fx_.get(u"fetched"_s)->items) {
            JSFIX_EXPECT(c, [&] {
                return mc::fetchedBody(c.get(u"ok"_s)->b, int(c.get(u"status"_s)->n), c.get(u"statusText"_s)->s, c.get(u"body"_s)->s);
            }, u"fetchedBody "_s + c.get(u"body"_s)->s);
        }
    }

    void scenarios() {
        int steps = 0, late = 0;
        for (const OJson& sc : fx_.get(u"scenarios"_s)->items) {
            const QString name = sc.get(u"name"_s)->s;
            mc::clearMacroCache();
            FakeNet net;
            QList<Waiting> waiting;
            const OJson ops = dec(*sc.get(u"ops"_s));
            for (qsizetype i = 0; i < ops.items.size(); ++i) {
                const OJson& op = ops.items[i];
                const OJson& want = sc.get(u"steps"_s)->items[i];
                if (const OJson* now = op.get(u"now"_s)) clockSec = now->n;
                const QString kind = op.get(u"op"_s)->s;
                std::optional<Waiting> entry;
                if (kind == u"route") {
                    for (const auto& [url, r] : op.get(u"set"_s)->fields) {
                        if (r.type == OJson::Null) net.routes.remove(url);
                        else net.routes.insert(url, r);
                    }
                } else if (kind == u"resolve") {
                    const QString id = op.get(u"id"_s)->s;
                    const auto list = net.pend.take(id);
                    for (auto d : list) {
                        if (const OJson* th = op.get(u"throw"_s)) d.reject(util::JsError(th->s));
                        else d.resolve(*op.get(u"json"_s));
                    }
                } else if (kind == u"board") {
                    mc::BoardOptions o;
                    if (const OJson* t = op.get(u"timeout"_s)) o.timeout = t->n;
                    if (const OJson* f = op.get(u"force"_s)) o.force = f->b;
                    o.fetcher = net.fetcher();
                    o.now = [] { return clockSec; };
                    if (const OJson* r = op.get(u"router"_s); r && !(r->type == OJson::String && r->s == u"none")) {
                        const OJson router = *r;
                        if (router.type == OJson::String && router.s == u"throw") o.streamQuotes = [](const QStringList&) -> OJson { throw util::JsError(u"boom"_s); };
                        else if (router.type == OJson::String && router.s == u"null") o.streamQuotes = [](const QStringList&) { return OJson::null(); };
                        else o.streamQuotes = [router](const QStringList&) { return router; };
                    }
                    entry = watch(int(i), mc::macroBoard(o), false);
                } else if (kind == u"index") {
                    const OJson* t = op.get(u"timeout"_s);
                    entry = watch(int(i), mc::publicIndexPrice(op.get(u"symbol"_s)->s, t ? t->n : 4.0, net.fetcher()), false);
                } else if (kind == u"quotes") {
                    QStringList syms;
                    for (const OJson& s : op.get(u"symbols"_s)->items) syms << s.s;
                    const OJson* t = op.get(u"timeout"_s);
                    entry = watch(int(i), mc::publicQuotes(syms, t ? t->n : 4.0, net.fetcher()), true);
                }
                if (entry) waiting << *entry;
                if (kind == u"quotes")
                    std::sort(net.log.items.begin(), net.log.items.end(), [](const OJson& a, const OJson& b) { return js::stringify(a) < js::stringify(b); });
                OJson got = js::object({{u"log"_s, net.log}});
                net.log = js::array();
                OJson lateList = js::array();
                bool pending = false;
                for (qsizetype w = 0; w < waiting.size();) {
                    if (!waiting[w].done()) {
                        if (entry && waiting[w].op == entry->op) pending = true;
                        ++w;
                        continue;
                    }
                    const OJson r = waiting[w].result();
                    if (entry && waiting[w].op == entry->op) {
                        for (const auto& [k, v] : r.fields) got.set(k, v);
                    } else {
                        OJson l = js::object({{u"op"_s, js::N(waiting[w].op)}});
                        for (const auto& [k, v] : r.fields) l.set(k, v);
                        lateList.items.append(l);
                        ++late;
                    }
                    waiting.removeAt(w);
                }
                if (pending) got.set(u"pending"_s, js::B(true));
                got.set(u"late"_s, lateList);
                JSFIX_SAME(want, got, u"%1 第 %2 步(%3)"_s.arg(name).arg(i).arg(kind));
                ++steps;
            }
        }
        QVERIFY(steps > 800);
        QVERIFY(late > 50);
    }
};

QTEST_GUILESS_MAIN(TestMacro)
#include "tst_macro.moc"
