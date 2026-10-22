// engine/analysis/fly_model(flyCalibration.ts + flyIvModel.ts + ivPricing.ts)对着原模块现跑的答案(tests/fixtures/gen_fly_model.mjs):
// 校准出来的整份模型、自己攒的样本估出来的那一份、到期时刻、各腿的 σ 与行情,逐字符比 JSON(数值是 JS 的最短写法,等于逐位比)。
#include "analysis/fly_model.h"
#include "js_fixture.h"
#include "util/error.h"
#include "util/jsformat.h"
#include "util/jsobj.h"
#include "util/ordered_json.h"

#include <QFile>
#include <QTest>

#include <cmath>
#include <limits>

using namespace ibkr;
using namespace Qt::StringLiterals;
using util::OJson;
namespace js = util::js;
namespace an = analysis;

using jsfix::dec;
using jsfix::enc;

namespace {
double num(const OJson* v) { return jsfix::num(v); }
std::vector<double> nums(const OJson* v) {
    std::vector<double> out;
    for (const OJson& x : v->items) out.push_back(dec(x).n);
    return out;
}
OJson numsJson(const std::vector<double>& v) {
    OJson o = js::array();
    for (double x : v) o.items.append(js::N(x));
    return o;
}
OJson optNums(const std::optional<std::vector<double>>& v) { return v ? numsJson(*v) : OJson::null(); }
std::vector<an::Bar> bars(const OJson* list) {
    std::vector<an::Bar> out;
    for (const OJson& b : list->items) out.push_back({num(&b.items[0]), num(&b.items[1]), num(&b.items[2])});
    return out;
}
an::Response response(const OJson& o) { return {num(o.get(u"a"_s)), num(o.get(u"b"_s)), num(o.get(u"c"_s))}; }
OJson responseJson(const an::Response& r) { return js::object({{u"a"_s, js::N(r.a)}, {u"b"_s, js::N(r.b)}, {u"c"_s, js::N(r.c)}}); }
OJson ownFitJson(const an::OwnFit& f) { return f.toJson(); }
}  // namespace

class TestFlyModel : public QObject {
    Q_OBJECT
    OJson fx;

private slots:
    void initTestCase() {
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR) + u"/fly-model.json"_s);
        QVERIFY(f.open(QIODevice::ReadOnly));
        QString error;
        const auto parsed = util::parseOJson(QString::fromUtf8(f.readAll()), &error);
        QVERIFY2(parsed, qPrintable(error));
        fx = *parsed;
    }

    void model() {
        // 常量逐字一致;读进结构再写出来也一样(结构没漏字段、键序没变)
        QCOMPARE(js::stringify(an::flyIvModelJson()), js::stringify(*fx.get(u"model"_s)));
        QCOMPARE(js::stringify(an::flyIvModel().toJson()), js::stringify(*fx.get(u"model"_s)));
    }

    void sessionsAndGrid() {
        for (const OJson& c : fx.get(u"sessions"_s)->items) {
            OJson got = js::array();
            for (const auto& [date, day] : an::sessions(bars(c.get(u"bars"_s)))) {
                OJson list = js::array();
                for (const an::MinuteBar& b : day)
                    list.items.append(js::object({{u"sec"_s, js::N(b.sec)}, {u"open"_s, js::N(b.open)}, {u"close"_s, js::N(b.close)}, {u"minute"_s, js::N(b.minute)}}));
                got.items.append(js::array({js::S(date), list}));
            }
            QCOMPARE(js::stringify(enc(got)), js::stringify(*c.get(u"out"_s)));
        }
        for (const OJson& c : fx.get(u"grid"_s)->items) {
            const OJson* d = c.get(u"day"_s);
            std::vector<an::MinuteBar> day;
            const bool undef = d->type == OJson::String;
            if (!undef)
                for (const OJson& b : d->items) {
                    an::MinuteBar mb;
                    mb.sec = num(&b.items[0]);
                    mb.open = num(&b.items[1]);
                    mb.close = num(&b.items[2]);
                    mb.minute = num(&b.items[3]);
                    day.push_back(mb);
                }
            const auto got = an::gridOf(undef ? nullptr : &day, num(c.get(u"step"_s)));
            QCOMPARE(js::stringify(enc(optNums(got))), js::stringify(*c.get(u"out"_s)));
        }
    }

    void sharesAndWeights() {
        for (const OJson& c : fx.get(u"shares"_s)->items) {
            std::vector<an::ScaledDay> days;
            for (const OJson& d : c.get(u"days"_s)->items)
                days.push_back({d.get(u"date"_s)->s, nums(d.get(u"minutes"_s)), nums(d.get(u"grid"_s)), num(d.get(u"level"_s))});
            JSFIX_EXPECT(c, [&] { return numsJson(an::varianceShares(days, int(num(c.get(u"buckets"_s))), num(c.get(u"width"_s)))); }, u"varianceShares"_s);
        }
        for (const OJson& c : fx.get(u"halfHour"_s)->items)
            JSFIX_EXPECT(c, [&] { return numsJson(an::halfHourWeights(nums(c.get(u"hourly"_s)), nums(c.get(u"fine"_s)))); }, u"halfHourWeights"_s);
        for (const OJson& c : fx.get(u"remaining"_s)->items)
            JSFIX_EXPECT(c, [&] { return js::N(an::remainingShare(nums(c.get(u"w"_s)), num(c.get(u"m"_s)))); }, u"remainingShare"_s);
    }

    void responseFit() {
        for (const OJson& c : fx.get(u"predict"_s)->items)
            JSFIX_EXPECT(c, [&] { return js::N(an::predict(response(*c.get(u"beta"_s)), num(c.get(u"u"_s)))); }, u"predict"_s);
        std::vector<std::vector<an::ResponseRow>> fitRows;
        for (const OJson& c : fx.get(u"fit"_s)->items) {
            std::vector<an::ResponseRow> rows;
            for (const OJson& r : c.get(u"rows"_s)->items) rows.push_back({u"x"_s, num(&r.items[0]), num(&r.items[1]), num(&r.items[2])});
            fitRows.push_back(rows);
            JSFIX_EXPECT(c, [&] { return responseJson(an::fitResponse(rows)); }, u"fitResponse"_s);
        }
        for (const OJson& c : fx.get(u"r2"_s)->items) {
            const int i = int(num(c.get(u"rows"_s)));
            const std::vector<an::ResponseRow> rows = i < 0 ? std::vector<an::ResponseRow>{} : fitRows[size_t(i)];
            const OJson* beta = c.get(u"beta"_s);
            const std::optional<an::Response> b = beta->type == OJson::Null ? std::nullopt : std::optional(response(*beta));
            JSFIX_EXPECT(c, [&] { return js::N(an::rSquared(rows, b)); }, u"rSquared"_s);
        }
        for (const OJson& c : fx.get(u"residSd"_s)->items) {
            const OJson& m = *c.get(u"model"_s);
            const an::ResidMove move{num(m.get(u"resid_move"_s)->get(u"base"_s)), num(m.get(u"resid_move"_s)->get(u"slope"_s))};
            JSFIX_EXPECT(c, [&] { return js::N(an::residualSd(num(m.get(u"resid_k"_s)), move, num(c.get(u"share"_s)), num(c.get(u"u"_s)))); }, u"residualSd"_s);
        }
    }

    void calibrate() {
        for (const OJson& c : fx.get(u"calibrate"_s)->items) {
            const OJson in = dec(*c.get(u"input"_s));
            an::CalibrationInput input;
            input.priceHourly = bars(in.get(u"priceHourly"_s));
            input.priceFine = bars(in.get(u"priceFine"_s));
            input.ivHourly = bars(in.get(u"ivHourly"_s));
            if (const OJson* l = in.get(u"ivLongHourly"_s)) input.ivLongHourly = bars(l);
            if (const OJson* d = in.get(u"ivLongDays"_s)) input.ivLongDays = d->n;
            if (const OJson* t = in.get(u"trainShare"_s)) input.trainShare = t->n;
            if (const OJson* s = in.get(u"fineShares"_s)) input.fineShares = nums(s);
            input.source = in.get(u"source"_s)->s;
            input.proxy = in.get(u"proxy"_s)->s;
            input.version = in.get(u"version"_s)->s;
            JSFIX_EXPECT(c, [&] { return an::calibrate(input).toJson(); }, u"calibrate "_s + c.get(u"name"_s)->s);
        }
    }

    void own() {
        const an::FlyIvModel& model = an::flyIvModel();
        for (const OJson& c : fx.get(u"own"_s)->items) {
            std::vector<an::OwnSample> samples;
            for (const OJson& s : c.get(u"samples"_s)->items) {
                an::OwnSample o;
                o.t = num(&s.items[0]);
                o.spot = num(&s.items[1]);
                o.expiry = s.items[2].s;
                for (const OJson& l : s.items[3].items) {
                    an::OwnLeg leg;
                    leg.strike = num(&l.items[0]);
                    leg.right = l.items[1].s;
                    if (l.items[2].type == OJson::Number) leg.iv = l.items[2].n;
                    o.legs.push_back(leg);
                }
                samples.push_back(o);
            }
            std::optional<an::OwnFit> fit;
            JSFIX_EXPECT(c, [&] {
                fit = an::fitFromSamples(samples, model.variance_weights, model.response);
                return ownFitJson(*fit);
            }, u"fitFromSamples "_s + c.get(u"name"_s)->s);
            if (fit) QCOMPARE(an::ownIsBetter(*fit), c.get(u"better"_s)->b);
        }
        for (const OJson& c : fx.get(u"ownDrift"_s)->items) {
            if (const OJson* b = c.get(u"better"_s)) {
                an::OwnFit f;
                f.r2_out = num(&b->items[0]);
                f.r2_out_index = num(&b->items[1]);
                QCOMPARE(an::ownIsBetter(f), c.get(u"out"_s)->b);
                continue;
            }
            JSFIX_EXPECT(c, [&] { return js::N(an::ownDriftAt(nums(c.get(u"d"_s)), num(c.get(u"m"_s)))); }, u"ownDriftAt"_s);
        }
    }

    void expiry() {
        for (const OJson& c : fx.get(u"expiry"_s)->items) {
            const auto got = an::expiryEpochMs(c.get(u"s"_s)->s, c.get(u"e"_s)->s, c.get(u"tc"_s)->s, c.get(u"early"_s)->b);
            QVERIFY2(js::stringify(js::NOrNull(got)) == js::stringify(*c.get(u"out"_s)),
                     qPrintable(u"%1 / %2 / %3 / %4:TS %5,C++ %6"_s.arg(c.get(u"s"_s)->s, c.get(u"e"_s)->s, c.get(u"tc"_s)->s)
                                    .arg(c.get(u"early"_s)->b)
                                    .arg(js::stringify(*c.get(u"out"_s)), js::stringify(js::NOrNull(got)))));
        }
    }

    void legSigmasAndInputs() {
        const auto keyOf = [](const an::PricedLeg& l) { return util::jsNumberToString(l.strike) + l.right; };
        for (const OJson& c : fx.get(u"sigmas"_s)->items) {
            std::vector<an::PricedLeg> legs;
            for (const OJson& l : c.get(u"legs"_s)->items) legs.push_back({num(l.get(u"strike"_s)), l.get(u"right"_s)->s});
            const OJson* e = c.get(u"expiryMs"_s);
            const std::optional<double> expiryMs = e->type == OJson::Null ? std::nullopt : std::optional(e->n);
            JSFIX_EXPECT(c, [&] { return an::ibkrLegSigmas(legs, num(c.get(u"spot"_s)), dec(*c.get(u"legIvs"_s)), expiryMs, num(c.get(u"nowMs"_s)), keyOf); },
                   u"ibkrLegSigmas"_s);
        }
        const auto early = [](const QString& d) { return d == u"2026-11-27" || d == u"2026-12-24"; };
        for (const OJson& c : fx.get(u"legInputs"_s)->items) {
            const OJson raw = dec(*c.get(u"raw"_s)), positions = dec(*c.get(u"positions"_s));
            const bool withEarly = c.get(u"early"_s)->b;
            JSFIX_EXPECT(c, [&] { return withEarly ? an::legInputsOf(raw, positions, keyOf, early) : an::legInputsOf(raw, positions, keyOf); },
                   u"legInputsOf "_s + js::stringify(raw));
        }
    }
};

QTEST_GUILESS_MAIN(TestFlyModel)
#include "tst_fly_model.moc"
