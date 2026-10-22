// engine/analysis/intel_items(intelItems.ts)对着原模块现跑的答案(tests/fixtures/gen_intel_items.mjs):消息、信号、事件、单子、想法
// 各自折成的一条,和按标的 / 种类 / 持仓 / 时刻筛、去重、排序、截断的合并,逐字符比 JSON。本机时区按 Asia/Shanghai。
#include "analysis/intel_items.h"
#include "js_fixture.h"

#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using util::OJson;
namespace js = util::js;
namespace ii = analysis::intel_items;

namespace {
const QTimeZone& shanghai() {
    static const QTimeZone tz(QByteArrayLiteral("Asia/Shanghai"));
    return tz;
}
QSet<QString> setOf(const OJson* a) {
    QSet<QString> out;
    for (const OJson& s : a->items) out.insert(s.s);
    return out;
}
QStringList listOf(const OJson* a) {
    QStringList out;
    for (const OJson& s : a->items) out << s.s;
    return out;
}
/// 夹具里的条目:数组里那一格 undefined 写成了占位串,读回成 null(合并只是原样转手,JSON 里两样都写成 null)
OJson decItem(const OJson& v) { return dec(jsfix::stripUndefined(v)); }
OJson optS(const std::optional<QString>& s) { return s ? js::S(*s) : js::S(u"__undefined__"_s); }
}  // namespace

class TestIntelItems : public QObject {
    Q_OBJECT
    OJson fx_;

private slots:
    void initTestCase() { fx_ = jsfix::load(u"intel-items.json"_s); }

    void labels() {
        for (const OJson& c : fx_.get(u"labels"_s)->get(u"outcome"_s)->items) QCOMPARE(js::stringify(optS(ii::outcomeLabel(c.get(u"k"_s)->s))), js::stringify(*c.get(u"out"_s)));
        for (const OJson& c : fx_.get(u"labels"_s)->get(u"signal"_s)->items) QCOMPARE(js::stringify(optS(ii::signalLabel(c.get(u"k"_s)->s))), js::stringify(*c.get(u"out"_s)));
    }

    void messages() {
        for (const OJson& c : fx_.get(u"messages"_s)->items) {
            const OJson row = dec(*c.get(u"row"_s));
            const OJson* verdict = c.get(u"verdict"_s);
            const OJson* instr = c.get(u"instruction"_s);
            const std::optional<QString> instruction = instr->type == OJson::String ? std::optional(instr->s) : std::nullopt;
            JSFIX_EXPECT(c, [&] { return ii::messageItem(row, verdict, setOf(c.get(u"held"_s)), *c.get(u"now"_s), instruction, shanghai()); }, js::stringify(row));
        }
    }

    void signalsEventsRecordsIdeas() {
        for (const OJson& c : fx_.get(u"signals"_s)->items) {
            const OJson e = dec(*c.get(u"e"_s));
            JSFIX_EXPECT(c, [&] { return ii::signalItem(e, setOf(c.get(u"held"_s)), shanghai()); }, js::stringify(e));
        }
        for (const OJson& c : fx_.get(u"events"_s)->items) {
            const OJson ev = dec(*c.get(u"ev"_s));
            JSFIX_EXPECT(c, [&] { return ii::eventItem(ev, listOf(c.get(u"symbols"_s)), setOf(c.get(u"held"_s)), c.get(u"nowMs"_s)->n); }, js::stringify(ev));
        }
        for (const OJson& c : fx_.get(u"records"_s)->items) {
            const OJson r = dec(*c.get(u"rec"_s));
            JSFIX_EXPECT(c, [&] { return ii::recordItem(r, setOf(c.get(u"held"_s)), shanghai()); }, js::stringify(r));
        }
        for (const OJson& c : fx_.get(u"ideas"_s)->items) {
            const OJson& idea = *c.get(u"idea"_s);
            JSFIX_EXPECT(c, [&] { return ii::ideaItem(idea, listOf(c.get(u"symbols"_s)), setOf(c.get(u"held"_s)), shanghai()); }, js::stringify(idea));
        }
    }

    void merge() {
        for (const OJson& c : fx_.get(u"merges"_s)->items) {
            QList<QList<OJson>> groups;
            for (const OJson& g : c.get(u"groups"_s)->items) groups << decItem(g).items;
            const OJson f = dec(*c.get(u"filter"_s));
            ii::FeedFilter filter;
            if (const OJson* s = f.get(u"symbol"_s); s && s->type == OJson::String) filter.symbol = s->s;
            if (const OJson* k = f.get(u"kinds"_s); k && k->type == OJson::Array) filter.kinds = listOf(k);
            if (const OJson* h = f.get(u"heldOnly"_s)) filter.heldOnly = h->b;
            if (const OJson* s = f.get(u"since"_s); s && s->type == OJson::Number) filter.since = s->n;
            filter.limit = f.get(u"limit"_s)->n;
            JSFIX_EXPECT(c, [&] { return js::array(ii::mergeItems(groups, filter)); }, js::stringify(f));
        }
    }
};

QTEST_GUILESS_MAIN(TestIntelItems)
#include "tst_intel_items.moc"
