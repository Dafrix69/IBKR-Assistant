// engine/analysis/research(research.ts)对着原模块现跑的答案(tests/fixtures/gen_research.mjs):黄金基线的锚点、摘要与文字块,
// 合成的说法 × 今天 × 日线上的锚点、各种长短日线的摘要、各种 brief 拼出来的文字块,逐字符比。
#include "analysis/research.h"
#include "js_fixture.h"

#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using jsfix::enc;
using util::OJson;
namespace js = util::js;
namespace rs = analysis::research;

class TestResearch : public QObject {
    Q_OBJECT
    OJson fx_;
    QList<OJson> sets_;

private slots:
    void initTestCase() {
        fx_ = jsfix::load(u"research.json"_s);
        for (const OJson& s : fx_.get(u"sets"_s)->items) sets_ << dec(s);
    }

    void golden() {
        const OJson& g = *fx_.get(u"golden"_s);
        const OJson& bars = *g.get(u"bars"_s);
        const QString today = g.get(u"today"_s)->s;
        for (const OJson& c : g.get(u"anchors"_s)->items)
            JSFIX_EXPECT(c, [&] { return rs::resolveAnchor(c.get(u"text"_s)->s, bars, today); }, c.get(u"text"_s)->s);
        const OJson brief = rs::symbolBrief(bars);
        JSFIX_SAME(*g.get(u"brief"_s), brief, u"brief"_s);
        const OJson& t = *g.get(u"texts"_s);
        QCOMPARE(rs::briefText(u"AAPL"_s, &brief), t.get(u"brief"_s)->s);
        QCOMPARE(rs::briefText(std::nullopt, nullptr), t.get(u"none"_s)->s);
        QCOMPARE(rs::briefText(u"AAPL"_s, nullptr), t.get(u"noData"_s)->s);
        const OJson err = js::object({{u"error"_s, js::S(u"timeout"_s)}});
        QCOMPARE(rs::briefText(u"AAPL"_s, &err), t.get(u"err"_s)->s);
        OJson withAnchor = brief;
        withAnchor.set(u"anchor"_s, rs::resolveAnchor(g.get(u"anchors"_s)->items[0].get(u"text"_s)->s, bars, today));
        QCOMPARE(rs::briefText(u"AAPL"_s, &withAnchor), t.get(u"anchor"_s)->s);
        OJson one = js::array({bars.items[0]});
        JSFIX_SAME(*t.get(u"short"_s), rs::symbolBrief(one), u"short"_s);
    }

    void anchors() {
        const OJson& gbars = *fx_.get(u"golden"_s)->get(u"bars"_s);
        int n = 0;
        for (const OJson& c : fx_.get(u"anchors"_s)->items) {
            const int set = int(c.get(u"set"_s)->n);
            const OJson& bars = set < 0 ? gbars : sets_[set];
            JSFIX_EXPECT(c, [&] { return rs::resolveAnchor(c.get(u"text"_s)->s, bars, c.get(u"today"_s)->s); },
                         u"anchor "_s + c.get(u"text"_s)->s + u" @ "_s + c.get(u"today"_s)->s);
            if (c.get(u"out"_s) && c.get(u"out"_s)->isObject()) ++n;
        }
        QVERIFY(n > 150);
    }

    void briefs() {
        for (const OJson& c : fx_.get(u"briefs"_s)->items)
            JSFIX_EXPECT(c, [&] { return rs::symbolBrief(sets_[int(c.get(u"set"_s)->n)]); }, u"brief "_s + QString::number(c.get(u"set"_s)->n));
    }

    void texts() {
        for (const OJson& c : fx_.get(u"texts"_s)->items) {
            const OJson* sym = c.get(u"symbol"_s);
            const std::optional<QString> symbol = sym->type == OJson::Null ? std::nullopt : std::optional(sym->s);
            const OJson* raw = c.get(u"brief"_s);
            const OJson brief = dec(*raw);
            const OJson* bp = jsfix::isUndefined(raw) || raw->type == OJson::Null ? nullptr : &brief;
            QCOMPARE(rs::briefText(symbol, bp), c.get(u"out"_s)->s);
        }
    }
};

QTEST_GUILESS_MAIN(TestResearch)
#include "tst_research.moc"
