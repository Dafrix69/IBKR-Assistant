// engine/analysis/fly_exit_sweep_spec(flyExitSweepSpec.ts)对着原模块现跑的答案(fixtures/gen_fly_exit_sweep.mjs → fly-exit-sweep-spec.json):
// 盘口 → 蝶价、到期值、入场价、实盘参数 → Targets、网格与点名组(含每一句报错)、回放网格、真实入场与网格文件、入场时刻的写法。逐字比 JSON。
#include "analysis/fly_exit_sweep_spec.h"
#include "sweep_json.h"

#include <QTest>

using namespace sweepfix;

namespace {

OJson quoteJson(const FlyQuote& q) {
    return js::object({{u"listed"_s, js::B(q.listed)}, {u"mid"_s, nOrNull(q.mid)}, {u"open"_s, nOrNull(q.open)}, {u"close_raw"_s, nOrNull(q.close_raw)}});
}
OJson rowsJson(const std::vector<LiveParams>& v) {
    OJson a = js::array();
    for (const LiveParams& p : v) a.items.append(liveRow(p));
    return a;
}
OJson overridesJson(const QList<ReplayOverride>& v) {
    OJson a = js::array();
    for (const OJson& o : v) a.items.append(o);
    return a;
}
OJson entriesJson(const std::vector<RealEntry>& v) {
    OJson a = js::array();
    for (const RealEntry& e : v) {
        OJson o = js::object({{u"t"_s, js::N(e.t)}, {u"center"_s, js::N(e.center)}, {u"wing"_s, js::N(e.wing)}, {u"right"_s, js::S(e.right)}});
        if (e.quantity) o.set(u"quantity"_s, js::N(*e.quantity));
        if (e.debit) o.set(u"debit"_s, js::N(*e.debit));
        a.items.append(o);
    }
    return a;
}

}  // namespace

class TestFlyExitSweepSpec : public QObject {
    Q_OBJECT
    OJson fx_;

private slots:
    void initTestCase() { fx_ = jsfix::load(u"fly-exit-sweep-spec.json"_s); }

    void quotes() {
        for (const OJson& c : fx_.get(u"quote"_s)->items) {
            const QuoteSample s = sampleFromJson(jsfix::dec(*c.get(u"sample"_s)));
            const FlySpec fly = flyFromJson(*c.get(u"fly"_s));
            JSFIX_EXPECT(c, [&] { return quoteJson(flyQuote(s, fly)); }, u"flyQuote"_s);
            JSFIX_EXPECT(c, [&] { return quoteJson(quoteFrom(bookOf(s), fly)); }, u"quoteFrom"_s);
        }
    }
    void intrinsicAndDebit() {
        for (const OJson& c : fx_.get(u"intrinsic"_s)->items) {
            const FlySpec fly = flyFromJson(*c.get(u"fly"_s));
            const double spot = jsfix::dec(*c.get(u"spot"_s)).n;
            JSFIX_EXPECT(c, [&] { return js::N(flyIntrinsic(fly, spot)); }, u"flyIntrinsic"_s);
        }
        for (const OJson& c : fx_.get(u"debit"_s)->items) {
            const auto& a = c.get(u"args"_s)->items;
            JSFIX_EXPECT(c, [&] { return js::N(entryDebit(a[0].n, a[1].n, a[2].n, a[3].n)); }, u"entryDebit"_s);
        }
        QCOMPARE(contractsPerFly(), 4.0);
    }
    void legKeys() {
        for (const OJson& c : fx_.get(u"legKey"_s)->items) QCOMPARE(legKey(jsfix::dec(*c.get(u"strike"_s)).n, c.get(u"right"_s)->s), c.get(u"out"_s)->s);
    }
    void reference() { JSFIX_SAME(*fx_.get(u"reference"_s), liveRow(liveReference()), u"liveReference"_s); }
    void targets() {
        for (const OJson& c : fx_.get(u"targets"_s)->items) {
            const LiveParams p = liveFromJson(jsfix::dec(*c.get(u"p"_s)));
            const double cost = c.get(u"cost"_s)->n, debit = c.get(u"debit"_s)->n, t = jsfix::dec(*c.get(u"t"_s)).n;
            JSFIX_EXPECT(c, [&] { return liveTargets(p, cost, debit, t); }, u"liveTargets"_s);
        }
        for (const OJson& c : fx_.get(u"unitCost"_s)->items) {
            const auto& a = c.get(u"args"_s)->items;
            JSFIX_EXPECT(c, [&] { return js::N(unitCost(a[0].n, a[1].n, optNum(&a[2]))); }, u"unitCost"_s);
        }
    }
    void liveSetsAndLabels() {
        for (const OJson& c : fx_.get(u"liveSets"_s)->items) {
            const LiveParams ref = liveFromJson(jsfix::dec(*c.get(u"ref"_s)));
            const OJson grid = jsfix::dec(*c.get(u"grid"_s));
            const bool noGrid = grid.type == OJson::Null || (grid.type == OJson::String && grid.s == u"__undefined__");
            const QList<OJson> extra = jsfix::dec(*c.get(u"extra"_s)).items;
            JSFIX_EXPECT(c, [&] { return rowsJson(liveSets(ref, noGrid ? nullptr : &grid, extra)); }, u"liveSets "_s + js::stringify(*c.get(u"grid"_s)).left(120));
        }
        for (const OJson& c : fx_.get(u"labels"_s)->items) {
            const LiveParams p = liveFromJson(jsfix::dec(*c.get(u"p"_s))), ref = liveFromJson(jsfix::dec(*c.get(u"ref"_s)));
            QCOMPARE(liveLabel(p, ref), c.get(u"out"_s)->s);
        }
    }
    void replayGrids() {
        for (const OJson& c : fx_.get(u"replaySets"_s)->items) {
            const OJson grid = jsfix::dec(*c.get(u"grid"_s));
            JSFIX_EXPECT(c, [&] { return overridesJson(replaySets(grid.type == OJson::Null ? nullptr : &grid)); }, u"replaySets "_s + js::stringify(*c.get(u"grid"_s)).left(120));
        }
        for (const OJson& c : fx_.get(u"replayLabel"_s)->items) {
            const OJson o = jsfix::dec(*c.get(u"o"_s));
            JSFIX_EXPECT(c, [&] { return js::S(replayLabel(o)); }, u"replayLabel"_s);
        }
    }
    void entryTimes() {
        for (const OJson& c : fx_.get(u"entryTime"_s)->items) {
            const QString text = c.get(u"text"_s)->s;
            JSFIX_EXPECT(c, [&] { return nOrNull(parseEntryTime(text)); }, u"parseEntryTime "_s + js::stringify(js::S(text)));
        }
    }
    void entries() {
        for (const OJson& c : fx_.get(u"entries"_s)->items) {
            const OJson raw = jsfix::dec(*c.get(u"raw"_s));
            JSFIX_EXPECT(c, [&] { return entriesJson(entriesFrom(raw)); }, u"entriesFrom "_s + js::stringify(*c.get(u"raw"_s)).left(120));
        }
    }
    void gridFiles() {
        for (const OJson& c : fx_.get(u"gridFile"_s)->items) {
            const OJson raw = jsfix::dec(*c.get(u"raw"_s));
            JSFIX_EXPECT(c, [&] {
                const GridFile g = gridFileFrom(raw);
                return js::object({{u"live"_s, g.live}, {u"sets"_s, js::array(g.sets)}, {u"replay"_s, g.replay}});
            }, u"gridFileFrom "_s + js::stringify(*c.get(u"raw"_s)).left(120));
        }
    }
};

QTEST_GUILESS_MAIN(TestFlyExitSweepSpec)
#include "tst_fly_exit_sweep_spec.moc"
