// engine/analysis/exec_quality(execQuality.ts)对着原模块现跑的答案(tests/fixtures/gen_exec_quality.mjs),逐字比 JSON。
#include "analysis/exec_quality.h"
#include "js_fixture.h"

#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using util::OJson;
namespace js = util::js;
namespace eq = analysis::execquality;

namespace {
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
}  // namespace

class TestExecQuality : public QObject {
    Q_OBJECT
    OJson fx_;

private slots:
    void initTestCase() { fx_ = jsfix::load(u"exec-quality.json"_s); }

    void rows() {
        for (const OJson& c : fx_.get(u"rows"_s)->items) {
            const eq::CloseTrace t = traceOf(dec(*c.get(u"trace"_s)));
            JSFIX_EXPECT(c, [&] { return eq::executionRow(t); }, u"executionRow "_s + js::stringify(*c.get(u"trace"_s)));
        }
    }

    void costs() {
        for (const OJson& c : fx_.get(u"costs"_s)->items) {
            std::vector<eq::CloseTrace> traces;
            for (const OJson& t : dec(*c.get(u"traces"_s)).items) traces.push_back(traceOf(t));
            const OJson& o = *c.get(u"opts"_s);
            eq::ExecutionOptions opts{o.get(u"scope"_s)->s, o.get(u"kind"_s)->s, std::nullopt, o.get(u"now"_s)->n};
            if (o.get(u"days"_s)->type == OJson::Number) opts.days = o.get(u"days"_s)->n;
            JSFIX_EXPECT(c, [&] { return eq::executionCost(traces, opts); }, u"executionCost"_s);
        }
    }
};

QTEST_GUILESS_MAIN(TestExecQuality)
#include "tst_exec_quality.moc"
