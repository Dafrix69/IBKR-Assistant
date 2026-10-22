// engine/analysis/alerts(alerts.ts)对着原模块现跑的答案(tests/fixtures/gen_alerts.mjs):黄金基线 alerts.json 的场景按原输入重算,
// 加上随机的步长、关口、写坏的期权墙与日线、合并截断、取价接续、穿越状态机的长走法(含老库的状态)、换关口,逐字符比 JSON。
#include "analysis/alerts.h"
#include "js_fixture.h"

#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using jsfix::enc;
using util::OJson;
namespace js = util::js;
namespace al = analysis::alerts;

namespace {
double num(const OJson* v) { return jsfix::num(v); }
const OJson* undefOr(const OJson* v, OJson& holder) {
    if (jsfix::isUndefined(v)) return nullptr;
    holder = dec(*v);
    return &holder;
}
double numOr(const OJson* v, double fallback) { return jsfix::isUndefined(v) ? fallback : num(v); }
std::optional<double> optNum(const OJson* v) {
    if (jsfix::isUndefined(v) || v->type == OJson::Null) return std::nullopt;
    return num(v);
}
std::optional<QString> optStr(const OJson* v) {
    if (jsfix::isUndefined(v) || v->type == OJson::Null) return std::nullopt;
    return v->s;
}
OJson levelsJson(const std::vector<al::AlertLevel>& v) {
    OJson a = js::array();
    for (const auto& l : v) a.items.append(l.toJson());
    return a;
}
std::vector<al::AlertLevel> levelsOf(const OJson& a) {
    std::vector<al::AlertLevel> out;
    for (const OJson& l : a.items) out.push_back(al::AlertLevel::fromJson(dec(l)));
    return out;
}
OJson numbers(const std::vector<double>& v) {
    OJson a = js::array();
    for (double x : v) a.items.append(js::N(x));
    return a;
}
std::optional<al::PriceSample> sampleOf(const OJson* v) {
    if (jsfix::isUndefined(v) || v->type == OJson::Null) return std::nullopt;
    const OJson o = dec(*v);
    al::PriceSample s;
    s.at = num(o.get(u"at"_s));
    s.price = num(o.get(u"price"_s));
    s.session = o.get(u"session"_s)->s;
    s.tradedAt = optNum(o.get(u"tradedAt"_s));
    if (const OJson* st = o.get(u"settled"_s)) s.settled = st->b;
    return s;
}
}  // namespace

class TestAlerts : public QObject {
    Q_OBJECT
    OJson fx_;
    QList<OJson> histories_;

private slots:
    void initTestCase() {
        fx_ = jsfix::load(u"alerts.json"_s);
        for (const OJson& h : fx_.get(u"histories"_s)->items) histories_ << dec(h);
    }

    void stepsAndRounds() {
        for (const OJson& c : fx_.get(u"autoStep"_s)->items)
            QCOMPARE(js::stringify(enc(js::N(al::autoStep(num(c.get(u"spot"_s)), num(c.get(u"band"_s)))))), js::stringify(*c.get(u"out"_s)));
        for (const OJson& c : fx_.get(u"round"_s)->items)
            QCOMPARE(js::stringify(enc(numbers(al::roundLevels(num(c.get(u"spot"_s)), num(c.get(u"step"_s)))))), js::stringify(*c.get(u"out"_s)));
    }

    void trend() {
        for (const OJson& c : fx_.get(u"trend"_s)->items) {
            const OJson& bars = histories_[qsizetype(c.get(u"bars"_s)->n)];
            const double spot = num(c.get(u"spot"_s));
            std::vector<double> periods = al::defaultMaPeriods();
            if (const OJson* p = c.get(u"periods"_s); !jsfix::isUndefined(p)) {
                periods.clear();
                for (const OJson& x : p->items) periods.push_back(num(&x));
            }
            const double window = numOr(c.get(u"window"_s), al::kExtremeWindow);
            const auto today = optStr(c.get(u"today"_s));
            JSFIX_EXPECT(c, [&] {
                return js::object({{u"levels"_s, levelsJson(al::trendLevels(&bars, spot, periods, window, today))},
                                   {u"snapshot"_s, al::trendSnapshot(&bars, spot, periods, window, today)}});
            }, u"trend "_s + js::stringify(*c.get(u"spot"_s)));
        }
    }

    void build() {
        int n = 0;
        for (const OJson& c : fx_.get(u"build"_s)->items) {
            OJson wh;
            const OJson* wall = undefOr(c.get(u"wall"_s), wh);
            const OJson* hi = c.get(u"history"_s);
            const OJson* history = jsfix::isUndefined(hi) || hi->type == OJson::Null ? nullptr : &histories_[qsizetype(hi->n)];
            const double spot = num(c.get(u"spot"_s));
            JSFIX_EXPECT(c, [&] {
                const auto ls = al::buildLevels(spot, wall, numOr(c.get(u"step"_s), al::kAutoStep), numOr(c.get(u"merge"_s), al::kDefaultMergePct),
                                                numOr(c.get(u"max"_s), al::kMaxLevels), history, optStr(c.get(u"today"_s)));
                return js::object({{u"levels"_s, levelsJson(ls)}, {u"describe"_s, js::strings(al::describe(ls, spot))}});
            }, u"build "_s + js::stringify(*c.get(u"spot"_s)));
            ++n;
        }
        QVERIFY(n > 150);
        for (const OJson& c : fx_.get(u"describe"_s)->items)
            QCOMPARE(js::stringify(js::strings(al::describe(levelsOf(*c.get(u"levels"_s)), num(c.get(u"spot"_s))))), js::stringify(*c.get(u"out"_s)));
    }

    void keys() {
        for (const OJson& c : fx_.get(u"keys"_s)->items) {
            const al::AlertLevel l = al::AlertLevel::fromJson(dec(*c.get(u"level"_s)));
            QCOMPARE(al::levelKey(l), c.get(u"key"_s)->s);
            QCOMPARE(js::stringify(enc(js::N(al::levelPriceAt(l, num(c.get(u"price"_s)))))), js::stringify(*c.get(u"at"_s)));
        }
    }

    void link() {
        for (const OJson& c : fx_.get(u"link"_s)->items) {
            const auto prev = sampleOf(c.get(u"prev"_s));
            const auto quote = *sampleOf(c.get(u"quote"_s));
            const double gap = numOr(c.get(u"gap"_s), al::kDefaultCooldown);
            const auto r = al::linkSample(prev, quote, gap);
            JSFIX_SAME(*c.get(u"out"_s), js::object({{u"sample"_s, r.sample.toJson()}, {u"prevPrice"_s, js::NOrNull(r.prevPrice)}}), u"linkSample"_s);
        }
    }

    void walks() {
        int steps = 0, events = 0;
        for (const OJson& w : fx_.get(u"walks"_s)->items) {
            const auto levels = levelsOf(*w.get(u"levels"_s));
            OJson states = dec(*w.get(u"states"_s));
            const double band = numOr(w.get(u"band"_s), al::kDefaultBandPct), cooldown = numOr(w.get(u"cooldown"_s), al::kDefaultCooldown);
            const QString confirm = jsfix::isUndefined(w.get(u"confirm"_s)) ? u"immediate"_s : w.get(u"confirm"_s)->s;
            const QString name = w.get(u"name"_s)->s;
            for (const OJson& s : w.get(u"steps"_s)->items) {
                const auto prev = optNum(s.get(u"prev"_s));
                const double price = num(s.get(u"price"_s)), at = s.get(u"at"_s)->n;
                OJson next;
                bool ok = false;
                JSFIX_EXPECT(s, [&] {
                    const auto res = al::evaluate(levels, states, prev, price, at, band, cooldown, confirm);
                    events += int(res.first.size());
                    next = res.second;
                    ok = true;
                    return js::array({js::array(res.first), res.second});
                }, u"%1 第 %2 步"_s.arg(name).arg(steps));
                if (ok) states = next;
                ++steps;
            }
        }
        QVERIFY(steps > 3000);
        QVERIFY(events > 200);
    }

    void reround() {
        for (const OJson& c : fx_.get(u"reround"_s)->items) {
            const auto levels = levelsOf(*c.get(u"levels"_s));
            JSFIX_EXPECT(c, [&] {
                const auto r = al::reroundLevels(levels, num(c.get(u"price"_s)), num(c.get(u"step"_s)), numOr(c.get(u"merge"_s), al::kDefaultMergePct));
                return r ? levelsJson(*r) : OJson::null();
            }, u"reround "_s + js::stringify(*c.get(u"price"_s)));
        }
    }
};

QTEST_GUILESS_MAIN(TestAlerts)
#include "tst_alerts.moc"
