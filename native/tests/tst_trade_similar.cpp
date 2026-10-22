// engine/analysis/trade_similar(tradeSimilar.ts)对着原模块现跑的答案(tests/fixtures/gen_trade_similar.mjs):历史的可比要素、
// 票据口径、打分、按出场方式的胜负与前 8 笔,以及几个小件,逐字符比 JSON。
#include "analysis/trade_similar.h"
#include "js_fixture.h"

#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using jsfix::enc;
using util::OJson;
namespace js = util::js;
namespace ts = analysis::trade_similar;

namespace {
QHash<QString, double> mapOf(const OJson& o) {
    QHash<QString, double> out;
    for (const auto& [k, v] : o.fields) out.insert(k, v.n);
    return out;
}
OJson entriesJson(const QList<ts::HistoryEntry>& l) {
    OJson a = js::array();
    for (const auto& e : l) a.items << e.toJson();
    return a;
}
OJson optS(const std::optional<QString>& v) { return v ? js::S(*v) : OJson::string(u"__undefined__"_s); }
OJson optN(const std::optional<double>& v) { return v ? js::N(*v) : OJson::null(); }
}  // namespace

class TestTradeSimilar : public QObject {
    Q_OBJECT
    OJson fx_;

private slots:
    void initTestCase() { fx_ = jsfix::load(u"trade_similar.json"_s); }

    void small() {
        for (const OJson& c : fx_.get(u"small"_s)->items) {
            const QString f = c.get(u"f"_s)->s;
            const OJson a = dec(*c.get(u"a"_s));
            const QString what = f + u' ' + js::stringify(*c.get(u"a"_s));
            if (f == u"rangeBucket") QCOMPARE(ts::rangeBucket(a.n), c.get(u"out"_s)->s);
            else if (f == u"bucketOfDays") QCOMPARE(ts::bucketOfDays(a.n), c.get(u"out"_s)->s);
            else if (f == u"dteBucket") QVERIFY2(js::stringify(optS(ts::dteBucket(a.items[0].s, a.items[1].s))) == js::stringify(*c.get(u"out"_s)), qPrintable(what));
            else if (f == u"slotOf") JSFIX_EXPECT(c, [&] { return js::S(ts::slotOf(a.n)); }, what);
            else if (f == u"positionExit") QCOMPARE(ts::positionExit(a), c.get(u"out"_s)->s);
        }
        for (const OJson& c : fx_.get(u"ranges"_s)->items) {
            const OJson bars = dec(*c.get(u"bars"_s));
            const OJson* lb = c.get(u"lookback"_s);
            const double lookback = jsfix::isUndefined(lb) ? ts::kRangeLookback : jsfix::num(lb);
            JSFIX_EXPECT(c, [&] { return optN(ts::rangePosition(bars.items, c.get(u"before"_s)->s, c.get(u"price"_s)->n, lookback)); }, u"rangePosition"_s);
        }
        for (const OJson& c : fx_.get(u"prices"_s)->items) {
            const OJson bars = dec(*c.get(u"bars"_s));
            JSFIX_EXPECT(c, [&] { return optN(ts::priceAt(bars.items, c.get(u"ms"_s)->n)); }, u"priceAt"_s);
        }
    }

    void entriesAndSimilar() {
        QList<QList<ts::HistoryEntry>> hists;
        int n = 0;
        for (const OJson& c : fx_.get(u"entries"_s)->items) {
            const OJson records = dec(*c.get(u"records"_s)), pos = dec(*c.get(u"posRows"_s)), opt = dec(*c.get(u"optRows"_s)), facts = dec(*c.get(u"facts"_s));
            const auto under = mapOf(*c.get(u"under"_s)), rpos = mapOf(*c.get(u"rpos"_s));
            const QString what = u" #"_s + QString::number(n++);
            JSFIX_EXPECT(*c.get(u"be"_s), [&] { return entriesJson(ts::butterflyEntries(records.items, facts.items, under)); }, u"butterflyEntries"_s + what);
            JSFIX_EXPECT(*c.get(u"pe"_s), [&] { return entriesJson(ts::positionEntries(pos.items, facts.items, under)); }, u"positionEntries"_s + what);
            JSFIX_EXPECT(*c.get(u"oe"_s), [&] { return entriesJson(ts::optionEntries(opt.items, facts.items)); }, u"optionEntries"_s + what);
            JSFIX_EXPECT(*c.get(u"se"_s), [&] { return entriesJson(ts::stockEntries(facts.items, rpos)); }, u"stockEntries"_s + what);
            QList<ts::HistoryEntry> h;
            for (const char16_t* k : {u"be", u"pe", u"oe", u"se"})
                for (const OJson& e : dec(*c.get(QString::fromUtf16(k))->get(u"out"_s)).items) h << ts::HistoryEntry::fromJson(e);
            hists << h;
        }
        n = 0;
        for (const OJson& c : fx_.get(u"similar"_s)->items) {
            const OJson ticket = dec(*c.get(u"ticket"_s));
            const OJson ctxJ = dec(*c.get(u"ctx"_s));
            ts::SimilarContext ctx;
            if (const OJson* s = ctxJ.get(u"spot"_s); !js::nullish(s)) ctx.spot = s->n;
            if (const OJson* r = ctxJ.get(u"rangePos"_s); !js::nullish(r)) ctx.rangePos = r->n;
            QSet<QString> peers;
            for (const OJson& p : c.get(u"peers"_s)->items) peers.insert(p.s);
            const QString what = u"findSimilar #"_s + QString::number(n++) + u' ' + js::stringify(ticket);
            QCOMPARE(ts::ticketKind(ticket), c.get(u"kind"_s)->s);
            JSFIX_EXPECT(c, [&] { return ts::findSimilar(ticket, hists[qsizetype(c.get(u"hist"_s)->n)], c.get(u"now"_s)->n, peers, ctx); }, what);
        }
        QVERIFY(n > 250);
    }
};

QTEST_GUILESS_MAIN(TestTradeSimilar)
#include "tst_trade_similar.moc"
