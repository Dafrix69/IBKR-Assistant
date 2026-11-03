// flyexit 的实验参数(zone_stop_sigma_k、b_keep_band、trail_capture_*、trail_arm_capture):没有 TS 原版,期望值按下面每条路径手算。
// 没给时行为不变这一半,由 tst_flyexit 与各处黄金基线一字不改地通过来钉;这里只钉"给了之后改了什么、只改了那一处"。
// 每条路径每一分钟都给真实蝶价(没有模型价),EM 用默认的 36。
#include "analysis/fly_exit_sweep_spec.h"
#include "analysis/flyexit.h"
#include "util/jsobj.h"

#include <QTest>

#include <functional>

using namespace ibkr;
using namespace Qt::StringLiterals;
using util::OJson;
namespace js = util::js;
namespace fx = analysis::flyexit;

namespace {
constexpr double kK = 7700, kW = 20;

OJson profile(double debit, double qty) {
    return js::object({{u"action"_s, js::S(u"BUY"_s)}, {u"right"_s, js::S(u"C"_s)}, {u"lower"_s, js::N(kK - kW)}, {u"center"_s, js::N(kK)},
                       {u"upper"_s, js::N(kK + kW)}, {u"width"_s, js::N(kW)}, {u"debit"_s, js::N(debit)}, {u"qty"_s, js::N(qty)},
                       {u"multiplier"_s, js::N(100)}});
}
QString stamp(int minute) { return u"2026-03-02 %1:%2"_s.arg(minute / 60, 2, 10, QChar(u'0')).arg(minute % 60, 2, 10, QChar(u'0')); }
int hm(int h, int m) { return h * 60 + m; }

struct Path {
    OJson spx = js::array(), fly = js::array();
};
/// 10:00 到 16:00 每分钟一根;spot / fly 按分钟给值
Path path(const std::function<double(int)>& spot, const std::function<double(int)>& fly) {
    Path p;
    for (int m = hm(10, 0); m <= hm(16, 0); ++m) {
        p.spx.items.append(js::object({{u"time"_s, js::S(stamp(m))}, {u"close"_s, js::N(spot(m))}}));
        p.fly.items.append(js::object({{u"time"_s, js::S(stamp(m))}, {u"close"_s, js::N(fly(m))}}));
    }
    return p;
}
OJson run(const OJson& prof, const Path& p, const OJson& raw) {
    const OJson params = fx::paramsFrom(&raw);
    return fx::simulate(prof, stamp(hm(10, 0)), p.spx, p.fly, params, nullptr);
}
/// 第一笔规则以 prefix 开头的出手;没有是 null
const OJson* firstEvent(const OJson& sim, const QString& prefix) {
    for (const OJson& e : sim.get(u"events"_s)->items)
        if (e.get(u"rule"_s)->s.startsWith(prefix)) return &e;
    return nullptr;
}
QString timeOf(const OJson* e) { return e ? e->get(u"time"_s)->s.mid(11, 5) : u"—"_s; }
}  // namespace

class TestFlyexitExperimental : public QObject {
    Q_OBJECT
private slots:
    void paramsOnlyWhenGiven() {
        const OJson none = fx::paramsFrom(nullptr);
        for (const QString& k : fx::experimentalKeys()) QVERIFY2(!none.get(k), qPrintable(k));
        const OJson raw = js::object({{u"zone_stop_sigma_k"_s, js::N(1.5)}, {u"b_keep_band"_s, js::N(0)}, {u"trail_arm_capture"_s, OJson::null()}});
        const OJson p = fx::paramsFrom(&raw);
        QCOMPARE(p.get(u"zone_stop_sigma_k"_s)->n, 1.5);
        QVERIFY(!p.get(u"b_keep_band"_s));        // 0 不是正数,同别的参数一样不收
        QVERIFY(!p.get(u"trail_arm_capture"_s));  // null 当没给
    }

    void sweepGridAcceptsThem() {
        const OJson grid = js::object({{u"zone_stop_sigma_k"_s, js::array({js::N(1), js::N(2)})}});
        const auto sets = analysis::sweep::replaySets(&grid);
        QCOMPARE(sets.size(), 3);  // 参照组 + 两个取值
        QCOMPARE(analysis::sweep::replayLabel(sets[1]), u"zone_stop_sigma_k=1"_s);
    }

    // 标的 10:30–10:35 跑到 K+18(> 0.8W = 16),之后回到中心;蝶价一直是 D,碰不到价格止损与回撤
    void zoneStopSigma() {
        const Path p = path([](int m) { return m >= hm(10, 30) && m <= hm(10, 35) ? kK + 18 : kK; }, [](int) { return 4.0; });
        const OJson prof = profile(4, 1);
        const OJson ref = run(prof, p, js::object());
        QCOMPARE(timeOf(firstEvent(ref, u"止损:|S−K|"_s)), u"10:30"_s);
        // 10:30 的 σ_剩余 ≈ 36 × √剩余方差 ≈ 30 多点:k = 1 时线是 20,σ 在线之上,位置止损不生效
        const double sigma = fx::sigmaRemaining(36, hm(10, 30));
        QVERIFY2(sigma > kW && sigma < 2 * kW, qPrintable(QString::number(sigma)));
        const OJson k1 = run(prof, p, js::object({{u"zone_stop_sigma_k"_s, js::N(1)}}));
        QVERIFY(!firstEvent(k1, u"止损"_s));
        // k = 2 时线是 40,σ 在线之下,照旧止损
        const OJson k2 = run(prof, p, js::object({{u"zone_stop_sigma_k"_s, js::N(2)}}));
        QCOMPARE(timeOf(firstEvent(k2, u"止损:|S−K|"_s)), u"10:30"_s);
    }

    // 3 张;14:00 起标的在 K+2(0.1W),14:30 起到 K+6(0.3W,还在 0.45W 之内)
    void bKeepBand() {
        const Path p = path([](int m) { return m < hm(14, 30) ? kK + 2 : kK + 6; }, [](int) { return 4.0; });
        const OJson prof = profile(4, 3);
        const OJson ref = run(prof, p, js::object());
        const OJson* refTrim = firstEvent(ref, u"进入 14:00 过渡"_s);
        QCOMPARE(timeOf(refTrim), u"14:00"_s);
        QCOMPARE(refTrim->get(u"qty"_s)->n, 2.0);
        const OJson band = run(prof, p, js::object({{u"b_keep_band"_s, js::N(0.2)}}));
        const OJson* trim = firstEvent(band, u"进入 14:00 过渡"_s);
        QCOMPARE(timeOf(trim), u"14:30"_s);  // 出了 0.2W 那一带才压
        QCOMPARE(trim->get(u"qty"_s)->n, 2.0);
        // 一直在带里:到 B 结束都不压
        const Path stay = path([](int) { return kK + 2; }, [](int) { return 4.0; });
        QVERIFY(!firstEvent(run(prof, stay, js::object({{u"b_keep_band"_s, js::N(0.2)}})), u"进入 14:00 过渡"_s));
    }

    // D = 8、W = 20:10:10 蝶价 14(激活,浮盈高水位 6 = 0.75D,兑现占比 6 / 12 = 0.5),10:20 回到 12.5(回吐 1.5 = 25%)
    void trailCapture() {
        const Path p = path([](int) { return kK; }, [](int m) { return m < hm(10, 10) ? 8.0 : m < hm(10, 20) ? 14.0 : 12.5; });
        const OJson prof = profile(8, 1);
        // 按 D 分级:6 < 1×D,让 40%,1.5 不够
        const OJson ref = run(prof, p, js::object());
        const OJson* refTrail = firstEvent(ref, u"回撤追踪"_s);
        QVERIFY(timeOf(refTrail) != u"10:20"_s);
        QCOMPARE(fx::trailPct(6, 8, kW, hm(10, 20), fx::paramsFrom(nullptr)), 0.4);
        // 按兑现占比:0.5 ≥ 0.4,让 20%,1.5 ≥ 1.2,清
        const OJson raw = js::object({{u"trail_capture_tight_at"_s, js::N(0.4)}});
        QCOMPARE(fx::trailPct(6, 8, kW, hm(10, 20), fx::paramsFrom(&raw)), 0.2);
        QCOMPARE(timeOf(firstEvent(run(prof, p, raw), u"回撤追踪"_s)), u"10:20"_s);
        // 没给 capture 键时,带翼宽的重载与原来的一样
        QCOMPARE(fx::trailStop(6, 8, kW, hm(10, 20), fx::paramsFrom(nullptr)), fx::trailStop(6, 8, hm(10, 20), fx::paramsFrom(nullptr)));
    }

    // D = 2、W = 20:10:10 蝶价 3(≥ 1.3D,激活,高水位 1),10:20 回到 2.4(回吐 0.6 = 60%)
    void trailArmCapture() {
        const Path p = path([](int) { return kK; }, [](int m) { return m < hm(10, 10) ? 2.0 : m < hm(10, 20) ? 3.0 : 2.4; });
        const OJson prof = profile(2, 1);
        QCOMPARE(timeOf(firstEvent(run(prof, p, js::object()), u"回撤追踪"_s)), u"10:20"_s);
        // 按兑现占比激活:要浮盈 ≥ 0.2 × 18 = 3.6,蝶价到不了 5.6,不激活
        const OJson capped = run(prof, p, js::object({{u"trail_arm_capture"_s, js::N(0.2)}}));
        QVERIFY(!firstEvent(capped, u"回撤追踪"_s));
        // 贵的蝶反过来更早激活:D = 8 时 1.3D = 10.4 到不了;0.1 × 12 = 1.2 → 蝶价 9.2 就激活。9.6 → 8.9 回吐 0.7 / 1.6 = 44% ≥ 40%
        const Path q = path([](int) { return kK; }, [](int m) { return m < hm(10, 10) ? 8.0 : m < hm(10, 20) ? 9.6 : 8.9; });
        const OJson prof8 = profile(8, 1);
        QVERIFY(timeOf(firstEvent(run(prof8, q, js::object()), u"回撤追踪"_s)) != u"10:20"_s);
        QCOMPARE(timeOf(firstEvent(run(prof8, q, js::object({{u"trail_arm_capture"_s, js::N(0.1)}})), u"回撤追踪"_s)), u"10:20"_s);
    }
};

QTEST_GUILESS_MAIN(TestFlyexitExperimental)
#include "tst_flyexit_experimental.moc"
