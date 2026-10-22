// engine/analysis/fly_plan(flyPlan.ts)对着原模块现跑的答案(tests/fixtures/gen_fly_plan_engine.mjs):planSchedule 300 组、planFly 近 400 组
// (整份结果:各腿、盘口、IV 的来源与走法、情景、曲线、时间线、每一句提示),逐字比;外加时段乘数、走势乘数、同一交易时段的判定。
#include "analysis/fly_plan.h"
#include "js_fixture.h"
#include "util/tz.h"

#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using jsfix::enc;
using util::OJson;
namespace js = util::js;
namespace fp = analysis::flyplan;

namespace {
double num(const OJson* v) { return jsfix::num(v); }
std::optional<double> optNum(const OJson* v) {
    if (jsfix::isUndefined(v) || v->type == OJson::Null) return std::nullopt;
    const OJson d = dec(*v);
    return d.type == OJson::Number ? std::optional(d.n) : std::nullopt;
}
std::optional<QString> optStr(const OJson* v) {
    if (jsfix::isUndefined(v)) return std::nullopt;
    return v->s;
}
}  // namespace

class TestFlyPlanEngine : public QObject {
    Q_OBJECT
    OJson fx_;
    QStringList holidays_, early_;
    std::vector<analysis::FlyIvModel> models_;

    fp::PlanCalendar calendar() const {
        const QStringList holidays = holidays_, early = early_;
        return {[holidays](const QString& d) {
                    const double wd = util::weekdayOfDate(d);  // 周一 = 0 … 周日 = 6
                    return wd != 5 && wd != 6 && !holidays.contains(d);
                },
                [early](const QString& d) { return early.contains(d); }};
    }

private slots:
    void initTestCase() {
        fx_ = jsfix::load(u"fly-plan-engine.json"_s);
        for (const OJson& h : fx_.get(u"calendar"_s)->get(u"holidays"_s)->items) holidays_ << h.s;
        for (const OJson& h : fx_.get(u"calendar"_s)->get(u"early"_s)->items) early_ << h.s;
        for (const OJson& m : fx_.get(u"models"_s)->items) models_.push_back(analysis::FlyIvModel::fromJson(m));
        // 第一份是随软件带的那一份:读出来要和引擎里的常量一样
        QCOMPARE(js::stringify(models_[0].toJson()), js::stringify(analysis::flyIvModelJson()));
    }

    void pieces() {
        for (const OJson& c : fx_.get(u"keys"_s)->items) QCOMPARE(fp::markKey(num(c.get(u"k"_s))), c.get(u"out"_s)->s);
        for (const OJson& c : fx_.get(u"session"_s)->items) QCOMPARE(fp::sameSession(num(c.get(u"now"_s)), num(c.get(u"exp"_s))), c.get(u"out"_s)->b);
        for (const OJson& c : fx_.get(u"seasonal"_s)->items)
            JSFIX_SAME(*c.get(u"out"_s),
                       js::N(fp::seasonalFactor(models_[size_t(num(c.get(u"m"_s)))], num(c.get(u"now"_s)), num(c.get(u"at"_s)), num(c.get(u"exp"_s)))),
                       u"seasonalFactor"_s);
        for (const OJson& c : fx_.get(u"response"_s)->items)
            JSFIX_SAME(*c.get(u"out"_s),
                       js::N(fp::ivResponse(models_[size_t(num(c.get(u"m"_s)))], num(c.get(u"u"_s)), num(c.get(u"dte"_s)), c.get(u"same"_s)->b)),
                       u"ivResponse"_s);
    }

    void schedules() {
        const fp::PlanCalendar cal = calendar();
        for (const OJson& c : fx_.get(u"schedules"_s)->items) {
            const OJson& a = *c.get(u"args"_s);
            fp::ScheduleArgs args{a.get(u"symbol"_s)->s, a.get(u"tradingClass"_s)->s, a.get(u"targetTime"_s)->s, optStr(a.get(u"targetDate"_s)),
                                  optStr(a.get(u"expiry"_s)), num(a.get(u"nowMs"_s))};
            JSFIX_EXPECT(c, [&] {
                const fp::PlanSchedule s = fp::planSchedule(args, cal);
                OJson tl = js::array();
                for (double t : s.timelineMs) tl.items.append(js::N(t));
                return js::object({{u"targetDate"_s, js::S(s.targetDate)}, {u"targetMs"_s, js::N(s.targetMs)}, {u"expiry"_s, js::S(s.expiry)},
                                   {u"expiryMs"_s, js::N(s.expiryMs)}, {u"timelineMs"_s, tl}, {u"warnings"_s, js::strings(s.warnings)}});
            }, u"planSchedule "_s + js::stringify(a));
        }
    }

    void plans() {
        int ok = 0;
        for (const OJson& c : fx_.get(u"plans"_s)->items) {
            const OJson in = dec(*c.get(u"input"_s));
            fp::FlyPlanInput input;
            input.symbol = in.get(u"symbol"_s)->s;
            input.expiry = in.get(u"expiry"_s)->s;
            input.tradingClass = in.get(u"tradingClass"_s)->s;
            input.right = in.get(u"right"_s)->s;
            input.center = in.get(u"center"_s)->n;
            input.width = in.get(u"width"_s)->n;
            input.quantity = in.get(u"quantity"_s)->n;
            input.multiplier = in.get(u"multiplier"_s)->n;
            input.spot = in.get(u"spot"_s)->n;
            input.spotSource = in.get(u"spotSource"_s)->s;
            input.spotNote = in.get(u"spotNote"_s)->s;
            input.nowMs = in.get(u"nowMs"_s)->n;
            input.expiryMs = in.get(u"expiryMs"_s)->n;
            input.targetMs = in.get(u"targetMs"_s)->n;
            input.targetSpot = in.get(u"targetSpot"_s)->n;
            for (const auto& [k, m] : in.get(u"marks"_s)->fields) {
                // LegMark 的三格:数(含 NaN)照给;null 是 null
                fp::LegMark mark;
                const auto field = [&](const QString& f) -> std::optional<double> {
                    const OJson* v = m.get(f);
                    return v && v->type == OJson::Number ? std::optional(v->n) : std::nullopt;
                };
                mark.bid = field(u"bid"_s);
                mark.ask = field(u"ask"_s);
                mark.iv = field(u"iv"_s);
                input.marks[k] = mark;
            }
            input.cost = optNum(in.get(u"cost"_s));
            input.ivInput = optNum(in.get(u"ivInput"_s));
            input.ivMode = in.get(u"ivMode"_s)->s;
            input.ivShiftPct = optNum(in.get(u"ivShiftPct"_s));
            for (const OJson& t : in.get(u"timelineMs"_s)->items) input.timelineMs.push_back(t.n);
            if (const OJson* w = in.get(u"warnings"_s)) {
                QStringList l;
                for (const OJson& x : w->items) l << x.s;
                input.warnings = l;
            }
            if (const int m = int(num(c.get(u"m"_s))); m > 0) input.model = models_[size_t(m)];
            JSFIX_EXPECT(c, [&] { return fp::planFly(input); }, u"planFly #%1"_s.arg(ok));
            ++ok;
        }
        QVERIFY(ok > 300);
    }
};

QTEST_GUILESS_MAIN(TestFlyPlanEngine)
#include "tst_fly_plan_engine.moc"
