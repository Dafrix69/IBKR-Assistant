// engine/analysis/anomaly(anomaly.ts)对着原模块现跑的答案(tests/fixtures/gen_anomaly.mjs):触发条件校验、成交量与方差曲线、
// 样本追加与裁剪、窗口涨跌、状态恢复,以及 60 条整天走法(每一轮的事件、状态、指标)逐字符比 JSON。
#include "analysis/anomaly.h"
#include "js_fixture.h"

#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using jsfix::enc;
using util::OJson;
namespace js = util::js;
namespace an = analysis::anomaly;

namespace {
const OJson* undefOr(const OJson* v, OJson& holder) {
    if (jsfix::isUndefined(v)) return nullptr;
    holder = dec(*v);
    return &holder;
}
double num(const OJson* v) { return jsfix::num(v); }
std::optional<double> optNum(const OJson* v) {
    if (jsfix::isUndefined(v) || v->type == OJson::Null) return std::nullopt;
    return dec(*v).n;
}
an::Config configOf(const OJson& o) {
    an::Config c;
    const auto list = [&](const char16_t* k) {
        std::vector<double> out;
        for (const OJson& x : o.get(QString::fromUtf16(k))->items) out.push_back(x.n);
        return out;
    };
    c.rvol_tiers = list(u"rvol_tiers");
    c.burst_ratio = o.get(u"burst_ratio"_s)->n;
    c.window_min = o.get(u"window_min"_s)->n;
    c.spike_sigma = o.get(u"spike_sigma"_s)->n;
    c.spike_min_pct = o.get(u"spike_min_pct"_s)->n;
    c.spike_fixed_pct = o.get(u"spike_fixed_pct"_s)->n;
    c.day_sigma_tiers = list(u"day_sigma_tiers");
    c.day_fixed_tiers = list(u"day_fixed_tiers");
    c.cooldown_min = o.get(u"cooldown_min"_s)->n;
    c.market_adjust = o.get(u"market_adjust"_s)->b;
    return c;
}
an::Sample sampleOf(const OJson& raw) {
    const OJson o = dec(raw);
    return {o.get(u"t"_s)->n, optNum(o.get(u"volume"_s)), optNum(o.get(u"last"_s))};
}
std::vector<an::Sample> samplesOf(const OJson& a) {
    std::vector<an::Sample> out;
    for (const OJson& x : a.items) out.push_back(sampleOf(x));
    return out;
}
OJson samplesJson(const std::vector<an::Sample>& v) {
    OJson a = js::array();
    for (const auto& s : v) a.items.append(s.toJson());
    return a;
}
std::optional<an::VolumeSnapshot> snapOf(const OJson* raw) {
    if (jsfix::isUndefined(raw) || raw->type == OJson::Null) return std::nullopt;
    const OJson o = dec(*raw);
    an::VolumeSnapshot s;
    const auto g = [&](const char16_t* k) { return optNum(o.get(QString::fromUtf16(k))); };
    s.last = g(u"last");
    s.close = g(u"close");
    s.open = g(u"open");
    s.high = g(u"high");
    s.low = g(u"low");
    s.volume = g(u"volume");
    s.avg_volume = g(u"avg_volume");
    s.hist_vol = g(u"hist_vol");
    s.vol_3m = g(u"vol_3m");
    s.vol_5m = g(u"vol_5m");
    s.vol_10m = g(u"vol_10m");
    s.last_trade_at = g(u"last_trade_at");
    if (const OJson* d = o.get(u"delayed"_s)) s.delayed = d->b;
    return s;
}
}  // namespace

class TestAnomaly : public QObject {
    Q_OBJECT
    OJson fx_;

private slots:
    void initTestCase() { fx_ = jsfix::load(u"anomaly.json"_s); }

    void normalize() {
        QCOMPARE(js::stringify(an::defaultConfig().toJson()), js::stringify(fx_.get(u"configs"_s)->items[0]));
        int n = 0;
        for (const OJson& c : fx_.get(u"normalize"_s)->items) {
            OJson rh, bh;
            const OJson* raw = undefOr(c.get(u"raw"_s), rh);
            const OJson* base = undefOr(c.get(u"base"_s), bh);
            const an::Config b = base ? configOf(*base) : an::defaultConfig();
            JSFIX_EXPECT(c, [&] { return an::normalizeAnomalyConfig(raw, b).toJson(); }, u"normalize "_s + js::stringify(*c.get(u"raw"_s)));
            ++n;
        }
        QVERIFY(n > 700);
    }

    void curves() {
        QCOMPARE(an::slotFractions().size(), size_t(78));
        for (const OJson& c : fx_.get(u"cum"_s)->items) {
            const std::optional<double> s = optNum(c.get(u"s"_s));
            QCOMPARE(js::stringify(enc(js::N(an::cumVolumeFraction(num(c.get(u"m"_s)), s)))), js::stringify(*c.get(u"out"_s)));
        }
        for (const OJson& c : fx_.get(u"variance"_s)->items)
            QCOMPARE(js::stringify(enc(js::N(an::varianceShare(num(c.get(u"a"_s)), num(c.get(u"b"_s)))))), js::stringify(*c.get(u"out"_s)));
    }

    void samples() {
        for (const OJson& c : fx_.get(u"push"_s)->items) {
            const auto list = samplesOf(*c.get(u"samples"_s));
            const OJson s = dec(*c.get(u"s"_s));
            std::optional<an::Sample> sample;
            if (s.type == OJson::Object) sample = sampleOf(*c.get(u"s"_s));
            const std::optional<double> keep = optNum(c.get(u"keep"_s));
            JSFIX_EXPECT(c, [&] { return samplesJson(an::pushSample(list, sample, keep)); }, u"pushSample"_s);
        }
        for (const OJson& c : fx_.get(u"winret"_s)->items) {
            const auto list = samplesOf(*c.get(u"samples"_s));
            JSFIX_EXPECT(c, [&] {
                const auto r = an::windowReturnPct(list, num(c.get(u"nowMs"_s)), c.get(u"w"_s)->n);
                return r ? js::N(*r) : OJson::null();
            }, u"windowReturnPct"_s);
        }
    }

    void coerce() {
        for (const OJson& c : fx_.get(u"coerce"_s)->items) {
            OJson h;
            const OJson* raw = undefOr(c.get(u"raw"_s), h);
            const QString date = c.get(u"date"_s)->s;
            const bool fresh = c.get(u"fresh"_s) != nullptr;
            JSFIX_EXPECT(c, [&] { return fresh ? an::freshState(date).toJson() : an::coerceState(raw, date).toJson(); }, u"coerceState "_s + js::stringify(*c.get(u"raw"_s)));
        }
    }

    void edges() {
        const OJson& configs = *fx_.get(u"configs"_s);
        for (const OJson& s : fx_.get(u"edges"_s)->items) {
            an::EvalArgs a;
            a.symbol = u"EDGE"_s;
            a.snap = snapOf(s.get(u"snap"_s));
            a.samples = samplesOf(*s.get(u"samples"_s));
            const OJson state = dec(*s.get(u"state"_s));
            a.state = &state;
            a.nowMs = s.get(u"nowMs"_s)->n;
            a.etDate = u"2026-10-16"_s;
            a.minute = num(s.get(u"minute"_s));
            a.sessionMinutes = optNum(s.get(u"session"_s));
            a.config = configOf(configs.items[qsizetype(s.get(u"cfg"_s)->n)]);
            a.suppress = s.get(u"suppress"_s) && !jsfix::isUndefined(s.get(u"suppress"_s));
            if (const OJson* o = s.get(u"opened"_s); o && !jsfix::isUndefined(o)) a.opened = o->b;
            if (const OJson* mk = s.get(u"market"_s); mk && mk->type == OJson::Object) {
                const OJson d = dec(*mk);
                a.market = an::MarketMove{optNum(d.get(u"change_pct"_s)), optNum(d.get(u"ret_window_pct"_s))};
            }
            JSFIX_EXPECT(s, [&] { return an::evaluateAnomalies(a); }, u"edge "_s + s.get(u"name"_s)->s);
        }
    }

    void walks() {
        int steps = 0, events = 0;
        const OJson& configs = *fx_.get(u"configs"_s);
        for (const OJson& w : fx_.get(u"walks"_s)->items) {
            std::vector<an::Sample> samples;
            OJson state = OJson::null();
            const std::optional<double> session = optNum(w.get(u"session"_s));
            for (const OJson& s : w.get(u"steps"_s)->items) {
                an::EvalArgs a;
                a.symbol = s.get(u"symbol"_s)->s;
                a.snap = snapOf(s.get(u"snap"_s));
                if (const OJson* p = s.get(u"push"_s); p && p->type != OJson::Null) samples = an::pushSample(samples, sampleOf(*p));
                a.samples = samples;
                if (const OJson* so = s.get(u"state"_s)) state = dec(*so);
                a.state = &state;
                a.nowMs = s.get(u"nowMs"_s)->n;
                a.etDate = s.get(u"etDate"_s) ? s.get(u"etDate"_s)->s : u"2026-10-16"_s;
                const OJson m = dec(*s.get(u"minute"_s));
                a.minute = m.type == OJson::Number ? m.n : std::nan("");
                a.sessionMinutes = session;
                a.config = configOf(configs.items[qsizetype(w.get(u"cfg"_s)->n)]);
                a.suppress = s.get(u"suppress"_s) != nullptr;
                if (const OJson* o = s.get(u"opened"_s)) a.opened = o->b;
                if (const OJson* mk = s.get(u"market"_s); mk && mk->type == OJson::Object) {
                    const OJson d = dec(*mk);
                    a.market = an::MarketMove{optNum(d.get(u"change_pct"_s)), optNum(d.get(u"ret_window_pct"_s))};
                }
                OJson result;
                bool ok = false;
                JSFIX_EXPECT(s, [&] {
                    result = an::evaluateAnomalies(a);
                    ok = true;
                    return result;
                }, u"walk %1 第 %2 步"_s.arg(w.get(u"w"_s)->n).arg(steps));
                if (ok) {
                    state = *result.get(u"state"_s);
                    events += int(result.get(u"events"_s)->items.size());
                }
                ++steps;
            }
        }
        QVERIFY(steps > 2500);
        QVERIFY(events > 80);
    }
};

QTEST_GUILESS_MAIN(TestAnomaly)
#include "tst_anomaly.moc"
