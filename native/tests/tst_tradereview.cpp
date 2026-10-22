// engine/analysis/tradereview(tradereview.ts)对着原模块现跑的答案(tests/fixtures/gen_tradereview.mjs):结构识别、到期内在价值与盈亏区间、
// 时间解析、开仓 ↔ 平仓配对、整段复盘(平仓 / 到期 / 持仓中、抽稀)与 marketOpportunity 的就地改写,逐字符比 JSON。
#include "analysis/tradereview.h"
#include "js_fixture.h"

#include <QTest>
#include <QTimeZone>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using jsfix::enc;
using util::OJson;
namespace js = util::js;
namespace tr = analysis::tradereview;

namespace {
/// 夹具里 "__undefined__" → 空指针
const OJson* undefOr(const OJson* v, OJson& holder) {
    if (jsfix::isUndefined(v)) return nullptr;
    holder = dec(*v);
    return &holder;
}
OJson optN(const std::optional<double>& v) { return v ? js::N(*v) : OJson::null(); }
OJson optI(const std::optional<qsizetype>& v) { return v ? js::N(double(*v)) : OJson::null(); }
}  // namespace

class TestTradeReview : public QObject {
    Q_OBJECT
    OJson fx_;

private slots:
    void initTestCase() { fx_ = jsfix::load(u"tradereview.json"_s); }

    void fmtExpiry() {
        for (const OJson& c : fx_.get(u"fmtExpiry"_s)->items) {
            OJson h;
            QCOMPARE(tr::fmtExpiry(undefOr(c.get(u"raw"_s), h)), c.get(u"out"_s)->s);
        }
    }

    void profiles() {
        int n = 0;
        for (const OJson& c : fx_.get(u"profiles"_s)->items) {
            OJson h;
            const OJson* rec = undefOr(c.get(u"record"_s), h);
            JSFIX_EXPECT(c, [&] { return tr::butterflyProfile(rec); }, u"profile "_s + js::stringify(*c.get(u"record"_s)).left(300));
            ++n;
        }
        QVERIFY(n > 250);
        for (const OJson& c : fx_.get(u"payoff"_s)->items) {
            const OJson p = dec(*c.get(u"profile"_s));
            OJson pay = js::array(), pnl = js::array();
            for (const OJson& s : c.get(u"s"_s)->items) {
                pay.items << js::N(tr::payoffPerUnit(p, s.n));
                pnl.items << optN(tr::pnlAt(p, s.n));
            }
            JSFIX_SAME(*c.get(u"payoff"_s), pay, u"payoff "_s + js::stringify(p));
            JSFIX_SAME(*c.get(u"pnl"_s), pnl, u"pnlAt "_s + js::stringify(p));
            JSFIX_SAME(*c.get(u"zone"_s), tr::zone(p), u"zone "_s + js::stringify(p));
            QVERIFY(tr::sameButterfly(p, p));
        }
    }

    void times() {
        for (const OJson& c : fx_.get(u"parseWhen"_s)->items) {
            OJson h;
            const OJson* v = undefOr(c.get(u"v"_s), h);
            const QString what = u"parseWhen "_s + js::stringify(*c.get(u"v"_s));
            JSFIX_EXPECT(c, [&] { return optN(tr::parseWhen(v)); }, what);
            if (const OJson* key = c.get(u"key"_s)) {
                const double ms = dec(*c.get(u"out"_s)).n;
                JSFIX_EXPECT(*key, [&] { return js::S(tr::etKey(ms, false)); }, what);
                JSFIX_EXPECT(*c.get(u"day"_s), [&] { return js::S(tr::etKey(ms, true)); }, what);
            }
        }
        // 不带时区的 ISO 按本机时区读:只在生成夹具的那个时区下比
        if (QString::fromUtf8(QTimeZone::systemTimeZoneId()) == fx_.get(u"tz"_s)->s) {
            for (const OJson& c : fx_.get(u"localParse"_s)->items) {
                const OJson v = *c.get(u"v"_s);
                JSFIX_EXPECT(c, [&] { return optN(tr::parseWhen(&v)); }, u"local "_s + v.s);
            }
        }
        // V8 的旧式写法与负年份:util::jsDateParse 换成 V8 读法之后与 TS 一致
        for (const OJson& c : fx_.get(u"legacyParse"_s)->items) {
            const OJson v = *c.get(u"v"_s);
            QVERIFY2(c.get(u"out"_s)->type == OJson::Number, qPrintable(v.s));
            const auto got = tr::parseWhen(&v);
            QVERIFY2(got && *got == c.get(u"out"_s)->n, qPrintable(u"legacy "_s + v.s));
        }
        for (const OJson& c : fx_.get(u"etKey"_s)->items) {
            const double ms = dec(*c.get(u"ms"_s)).n;
            if (!c.get(u"key"_s)) {
                JSFIX_EXPECT(c, [&] { return js::S(tr::etKey(ms, false)); }, u"etKey"_s);
                continue;
            }
            QCOMPARE(tr::etKey(ms, false), c.get(u"key"_s)->s);
            QCOMPARE(tr::etKey(ms, true), c.get(u"day"_s)->s);
        }
    }

    void pairing() {
        for (const OJson& c : fx_.get(u"entryOf"_s)->items) {
            OJson h;
            const OJson* rec = undefOr(c.get(u"record"_s), h);
            JSFIX_EXPECT(c, [&] {
                const tr::Entry e = tr::entryOf(rec);
                return js::object({{u"time"_s, js::N(e.time)}, {u"estimated"_s, js::B(e.estimated)}});
            }, u"entryOf "_s + js::stringify(*c.get(u"record"_s)));
        }
        for (const OJson& c : fx_.get(u"findExit"_s)->items) {
            const OJson p = dec(*c.get(u"profile"_s)), others = dec(*c.get(u"others"_s));
            OJson h;
            const OJson* ex = undefOr(c.get(u"exclude"_s), h);
            JSFIX_EXPECT(c, [&] { return tr::findExit(p, c.get(u"t"_s)->n, others.items, ex); }, u"findExit"_s);
        }
        for (const OJson& c : fx_.get(u"pairs"_s)->items) {
            const OJson trades = dec(*c.get(u"trades"_s));
            JSFIX_EXPECT(c, [&] { return tr::pairButterflies(trades.items); }, u"pairs "_s + js::stringify(trades).left(200));
        }
    }

    void barsMisc() {
        for (const OJson& c : fx_.get(u"barsMisc"_s)->items) {
            const OJson bars = dec(*c.get(u"bars"_s));
            const double when = c.get(u"when"_s)->n;
            const QString what = js::stringify(bars);
            JSFIX_EXPECT(*c.get(u"isDaily"_s), [&] { return js::B(tr::isDaily(bars.items)); }, u"isDaily "_s + what);
            JSFIX_EXPECT(*c.get(u"idx"_s), [&] { return optI(tr::indexAt(bars.items, when, false)); }, u"indexAt "_s + what);
            JSFIX_EXPECT(*c.get(u"idxD"_s), [&] { return optI(tr::indexAt(bars.items, when, true)); }, u"indexAt daily "_s + what);
            if (!bars.items.isEmpty()) JSFIX_EXPECT(*c.get(u"barTime"_s), [&] { return js::S(tr::barTime(&bars.items[0])); }, u"barTime "_s + what);
        }
        for (const OJson& c : fx_.get(u"timeframes"_s)->items) {
            if (const OJson* tf = c.get(u"tf"_s)) {
                QCOMPARE(tr::barSeconds(tf->s, false), c.get(u"s"_s)->n);
                QCOMPARE(tr::barSeconds(tf->s, true), c.get(u"d"_s)->n);
            } else {
                QCOMPARE(tr::pickTimeframe(0, jsfix::num(c.get(u"age"_s)) * 86400000), c.get(u"pick"_s)->s);
            }
        }
    }

    void reviews() {
        int n = 0;
        for (const OJson& c : fx_.get(u"reviews"_s)->items) {
            const OJson rec = dec(*c.get(u"record"_s)), others = dec(*c.get(u"others"_s)), bars = dec(*c.get(u"bars"_s));
            const double now = jsfix::num(c.get(u"now"_s));
            JSFIX_EXPECT(c, [&] { return tr::review(&rec, others.items, bars.items, c.get(u"tf"_s)->s, now); }, u"review "_s + c.get(u"name"_s)->s);
            ++n;
        }
        QVERIFY(n > 100);
    }

    void market() {
        for (const OJson& c : fx_.get(u"market"_s)->items) {
            const OJson input = dec(*c.get(u"result"_s)), fly = dec(*c.get(u"fly"_s));
            OJson result = input;
            const QString what = u"marketOpportunity "_s + c.get(u"name"_s)->s + u' ' + js::str(c.get(u"tweak"_s));
            JSFIX_EXPECT(c, [&] {
                tr::marketOpportunity(result, fly.items, c.get(u"entryBar"_s)->s);
                OJson o = js::object();
                for (const QString k : {u"stats"_s, u"findings"_s})
                    if (const OJson* v = result.get(k)) o.set(k, *v);
                return o;
            }, what);
            // 别的键一个不动;stats / findings 缺的仍旧缺
            for (const auto& [k, v] : input.fields)
                if (k != u"stats" && k != u"findings") QCOMPARE(js::stringify(*result.get(k)), js::stringify(v));
            QCOMPARE(result.fields.size(), input.fields.size());
        }
    }
};

QTEST_GUILESS_MAIN(TestTradeReview)
#include "tst_tradereview.moc"
