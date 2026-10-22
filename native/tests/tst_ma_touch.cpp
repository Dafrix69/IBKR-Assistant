// engine/analysis/ma_touch(maTouch.ts)对着原模块现跑的答案(tests/fixtures/gen_ma_touch.mjs):设置校验的每一句原话、前一个交易日、
// 日线挑拣、每天的触碰与分段、底账、底账能不能用、盘中这一轮的判定,逐字符比 JSON。
#include "analysis/ma_touch.h"
#include "js_fixture.h"
#include "util/jsformat.h"

#include <QDate>
#include <QSet>
#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using jsfix::enc;
using util::OJson;
namespace js = util::js;
namespace mt = analysis::ma_touch;

namespace {
const OJson* undefOr(const OJson* v, OJson& holder) {
    if (jsfix::isUndefined(v)) return nullptr;
    holder = dec(*v);
    return &holder;
}
mt::Config configOf(const OJson& o) {
    mt::Config c;
    c.enabled = o.get(u"enabled"_s)->b;
    for (const OJson& p : o.get(u"periods"_s)->items) c.periods.push_back(p.n);
    c.window_days = o.get(u"window_days"_s)->n;
    c.min_touches = o.get(u"min_touches"_s)->n;
    c.band_pct = o.get(u"band_pct"_s)->n;
    return c;
}
std::vector<mt::DayBar> barsOf(const OJson& a) {
    std::vector<mt::DayBar> out;
    for (const OJson& b : a.items) out.push_back({b.get(u"date"_s)->s, b.get(u"high"_s)->n, b.get(u"low"_s)->n, b.get(u"close"_s)->n});
    return out;
}
OJson barsJson(const std::vector<mt::DayBar>& v) {
    OJson a = js::array();
    for (const auto& b : v) a.items.append(js::object({{u"date"_s, js::S(b.date)}, {u"high"_s, js::N(b.high)}, {u"low"_s, js::N(b.low)}, {u"close"_s, js::N(b.close)}}));
    return a;
}
OJson daysJson(const std::vector<mt::TouchDay>& v) {
    OJson a = js::array();
    for (const auto& d : v)
        a.items.append(js::object({{u"date"_s, js::S(d.date)}, {u"ma"_s, js::N(d.ma)}, {u"touched"_s, js::B(d.touched)}, {u"side"_s, js::S(d.side)}}));
    return a;
}
bool weekday(const QString& d) {
    const QDate q = QDate::fromString(d, u"yyyy-MM-dd"_s);
    return q.dayOfWeek() < 6;
}
std::function<bool(const QString&)> calendar(const QString& name) {
    static const QSet<QString> holidays{u"2026-01-01"_s, u"2026-01-19"_s, u"2026-02-16"_s, u"2026-04-03"_s, u"2026-05-25"_s,
                                        u"2026-07-03"_s, u"2026-09-07"_s, u"2026-11-26"_s, u"2026-12-25"_s};
    if (name == u"weekday") return weekday;
    if (name == u"nyse") return [](const QString& d) { return weekday(d) && !holidays.contains(d); };
    if (name == u"never") return [](const QString&) { return false; };
    if (name == u"always") return [](const QString&) { return true; };
    if (name == u"odd") return [](const QString& d) { return int(util::jsStringToNumber(d.mid(8, 2))) % 2 == 1; };
    qFatal("没有日历 %s", qPrintable(name));
}
}  // namespace

class TestMaTouch : public QObject {
    Q_OBJECT
    OJson fx_;
    std::vector<mt::Config> configs_;

private slots:
    void initTestCase() {
        fx_ = jsfix::load(u"ma-touch.json"_s);
        for (const OJson& c : fx_.get(u"configs"_s)->items) configs_.push_back(configOf(c));
        QCOMPARE(js::stringify(mt::defaultConfig().toJson()), js::stringify(fx_.get(u"configs"_s)->items[0]));
    }

    void normalize() {
        int n = 0;
        for (const OJson& c : fx_.get(u"normalize"_s)->items) {
            OJson rh, bh;
            const OJson* raw = undefOr(c.get(u"raw"_s), rh);
            const OJson* base = undefOr(c.get(u"base"_s), bh);
            const mt::Config b = base ? configOf(*base) : mt::defaultConfig();
            JSFIX_EXPECT(c, [&] { return mt::normalizeTouchConfig(raw, b).toJson(); }, u"normalize "_s + js::stringify(*c.get(u"raw"_s)));
            ++n;
        }
        QVERIFY(n > 700);
    }

    void prevDay() {
        for (const OJson& c : fx_.get(u"prevDay"_s)->items) {
            const QString date = c.get(u"date"_s)->s;
            JSFIX_EXPECT(c, [&] { return js::S(mt::prevTradingDay(date, calendar(c.get(u"cal"_s)->s))); }, u"prevTradingDay "_s + date);
        }
    }

    void completed() {
        for (const OJson& c : fx_.get(u"completed"_s)->items) {
            OJson h;
            const OJson* bars = undefOr(c.get(u"bars"_s), h);
            JSFIX_EXPECT(c, [&] { return barsJson(mt::completedBars(bars, c.get(u"today"_s)->s)); }, u"completedBars"_s);
        }
    }

    void daysAndEpisodes() {
        for (const OJson& c : fx_.get(u"days"_s)->items) {
            const auto bars = barsOf(*c.get(u"bars"_s));
            const auto days = mt::touchDays(bars, c.get(u"period"_s)->n, c.get(u"band"_s)->n);
            JSFIX_SAME(*c.get(u"days"_s), daysJson(days), u"touchDays"_s);
            OJson eps = js::array();
            for (const auto& e : mt::episodesOf(days)) eps.items.append(e.toJson());
            JSFIX_SAME(*c.get(u"episodes"_s), eps, u"episodesOf"_s);
        }
    }

    void books() {
        for (const OJson& c : fx_.get(u"books"_s)->items) {
            OJson bh, fh;
            const OJson* bars = undefOr(c.get(u"bars"_s), bh);
            const OJson* fired = undefOr(c.get(u"fired"_s), fh);
            const mt::Config& cfg = configs_[size_t(c.get(u"cfg"_s)->n)];
            JSFIX_EXPECT(c, [&] {
                const auto b = mt::buildTouchBook(bars, c.get(u"today"_s)->s, cfg, fired);
                return b ? b->toJson() : OJson::null();
            }, u"buildTouchBook"_s);
        }
    }

    void usable() {
        for (const OJson& c : fx_.get(u"usable"_s)->items) {
            const OJson* b = c.get(u"book"_s);
            std::optional<mt::TouchBook> book;
            if (b->type != OJson::Null) book = mt::TouchBook::fromJson(dec(*b));
            const bool got = mt::bookUsable(book ? &*book : nullptr, configs_[size_t(c.get(u"cfg"_s)->n)], c.get(u"prevDay"_s)->s);
            QCOMPARE(got, c.get(u"out"_s)->b);
        }
    }

    void evaluate() {
        int hits = 0;
        for (const OJson& c : fx_.get(u"evals"_s)->items) {
            const mt::TouchBook book = mt::TouchBook::fromJson(dec(*c.get(u"book"_s)));
            const double price = jsfix::num(c.get(u"price"_s));
            const OJson prev = dec(*c.get(u"prevPrice"_s));
            const std::optional<double> prevPrice = prev.type == OJson::Null ? std::nullopt : std::optional(prev.n);
            const auto r = mt::evaluateTouches(book, configs_[size_t(c.get(u"cfg"_s)->n)], price, prevPrice, c.get(u"today"_s)->s);
            OJson hs = js::array();
            for (const auto& h : r.hits) hs.items.append(h.toJson());
            hits += int(r.hits.size());
            JSFIX_SAME(*c.get(u"out"_s), js::object({{u"hits"_s, hs}, {u"fired"_s, r.fired}}), u"evaluateTouches "_s + js::stringify(*c.get(u"price"_s)));
        }
        QVERIFY(hits >= 30);
    }
};

QTEST_GUILESS_MAIN(TestMaTouch)
#include "tst_ma_touch.moc"
