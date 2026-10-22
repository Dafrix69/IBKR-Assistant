// engine/analysis/idea_retrieval(ideaRetrieval.ts)对着原模块现跑的答案(tests/fixtures/gen_idea_retrieval.mjs):打分与标签、混合检索的合并、
// 按时间分层抽样、知识总结的取数、关键词 / 标的 / 焦点 / 日界的整理与报错,逐字符比 JSON。本机时区按 Asia/Shanghai。
#include "analysis/idea_retrieval.h"
#include "js_fixture.h"

#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using util::OJson;
namespace js = util::js;
namespace ir = analysis::idea_retrieval;

namespace {
const QTimeZone& shanghai() {
    static const QTimeZone tz(QByteArrayLiteral("Asia/Shanghai"));
    return tz;
}
const OJson* undefOr(const OJson* v, OJson& holder) {
    if (jsfix::isUndefined(v)) return nullptr;
    holder = dec(*v);
    return &holder;
}
}  // namespace

class TestIdeaRetrieval : public QObject {
    Q_OBJECT
    OJson fx_;

private slots:
    void initTestCase() { fx_ = jsfix::load(u"idea-retrieval.json"_s); }

    void scores() {
        const OJson& p = *fx_.get(u"digestPick"_s);
        QCOMPARE(ir::kDigestPick.total, p.get(u"total"_s)->n);
        QCOMPARE(ir::kDigestPick.recent, p.get(u"recent"_s)->n);
        QCOMPARE(ir::kDigestPick.buckets, p.get(u"buckets"_s)->n);
        for (const OJson& c : fx_.get(u"scores"_s)->items) {
            QCOMPARE(ir::scoreCandidate(*c.get(u"c"_s)), c.get(u"score"_s)->n);
            QCOMPARE(js::stringify(js::strings(ir::matchTags(*c.get(u"c"_s)))), js::stringify(*c.get(u"tags"_s)));
        }
    }

    void merge() {
        for (const OJson& c : fx_.get(u"merge"_s)->items) {
            QSet<QString> sem;
            for (const OJson& s : c.get(u"semantic"_s)->items) sem.insert(s.s);
            const double limit = dec(*c.get(u"limit"_s)).n;
            JSFIX_EXPECT(c, [&] { return js::array(ir::mergeSemantic(c.get(u"candidates"_s)->items, c.get(u"pool"_s)->items, sem, limit, shanghai())); }, u"merge"_s);
        }
    }

    void stratify() {
        for (const OJson& c : fx_.get(u"strat"_s)->items) {
            const double budget = c.get(u"budget"_s)->n, buckets = dec(*c.get(u"buckets"_s)).n;
            JSFIX_EXPECT(c, [&] { return js::array(ir::stratify(c.get(u"candidates"_s)->items, budget, buckets, shanghai())); },
                         u"stratify %1 %2"_s.arg(budget).arg(buckets));
        }
    }

    void digest() {
        for (const OJson& c : fx_.get(u"digest"_s)->items) {
            const OJson* o = c.get(u"opts"_s);
            ir::PickOptions opts = ir::kDigestPick;
            if (!jsfix::isUndefined(o)) {
                const OJson d = dec(*o);
                opts = {d.get(u"total"_s)->n, d.get(u"recent"_s)->n, d.get(u"buckets"_s)->n};
            }
            JSFIX_EXPECT(c, [&] { return js::array(ir::pickForDigest(c.get(u"matches"_s)->items, c.get(u"recentPool"_s)->items, opts, shanghai())); },
                         js::stringify(*o));
        }
    }

    void text() {
        for (const OJson& c : fx_.get(u"terms"_s)->items) {
            OJson h;
            QCOMPARE(js::stringify(js::strings(ir::splitTerms(undefOr(c.get(u"q"_s), h)))), js::stringify(*c.get(u"out"_s)));
        }
        for (const OJson& c : fx_.get(u"symbols"_s)->items) {
            OJson h;
            QCOMPARE(js::stringify(js::strings(ir::parseSymbols(undefOr(c.get(u"s"_s), h)))), js::stringify(*c.get(u"out"_s)));
        }
        for (const OJson& c : fx_.get(u"focus"_s)->items) {
            OJson h;
            QCOMPARE(js::stringify(ir::normalizeFocus(undefOr(c.get(u"f"_s), h))), js::stringify(*c.get(u"out"_s)));
        }
        for (const OJson& c : fx_.get(u"days"_s)->items) {
            OJson h;
            const OJson* raw = undefOr(c.get(u"d"_s), h);
            JSFIX_EXPECT(c, [&] { const auto d = ir::dayBound(raw, c.get(u"name"_s)->s); return d ? js::S(*d) : OJson::null(); }, js::stringify(*c.get(u"d"_s)));
        }
    }
};

QTEST_GUILESS_MAIN(TestIdeaRetrieval)
#include "tst_idea_retrieval.moc"
