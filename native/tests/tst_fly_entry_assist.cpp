// engine/analysis/fly_entry_assist:翼宽对齐到 20 / 25 / 30 / 50 / 75 的档、三条「今日不开」标记各自的触发与不触发(阈值上、阈值两侧)、
// 时段提示、关掉配置、输入缺一样时的降级(SPY 链取不到就不判 put 墙那一条,原因写进 notes)。全部离线。
#include "analysis/fly_entry_assist.h"

#include "util/jsobj.h"

#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using util::OJson;
namespace js = util::js;
namespace fe = analysis::flyentry;

namespace {

fe::Input baseInput() {
    fe::Input in;
    in.etMinutes = 13 * 60 + 30;
    in.weekday = 2;  // 周二
    in.straddle = 13.2;
    in.straddleAt = 1'761'900'000'000.0;
    in.straddleStrike = 6700;
    in.priorClose = 6711.6;
    in.prevClose = 6700.0;
    in.priorDate = u"2026-10-29"_s;
    in.prevDate = u"2026-10-28"_s;
    in.spxSpot = 6705;
    in.spxPutWall = 6600;  // 离现货 105 点 = 7.95 × 跨式:远
    in.spySpot = 668;
    in.spyPutWall = 655;  // 1.95%:远
    // 取到的链够宽:SPX 到 6550(155 点 > 5.9 × 13.2 = 77.9),SPY 到 650(2.7% > 1.31%)
    in.spxWindowLow = 6550;
    in.spyWindowLow = 650;
    return in;
}

QStringList keysOf(const OJson& out) {
    QStringList k;
    for (const OJson& f : out.get(u"flags"_s)->items) k << js::str(js::prop(&f, u"key"_s));
    return k;
}
QStringList notesOf(const OJson& out) {
    QStringList k;
    for (const OJson& n : out.get(u"notes"_s)->items) k << n.s;
    return k;
}
bool anyContains(const QStringList& l, const QString& needle) {
    for (const QString& s : l)
        if (s.contains(needle)) return true;
    return false;
}

}  // namespace

class TestFlyEntryAssist : public QObject {
    Q_OBJECT
private slots:
    void widthLadderPick_data() {
        QTest::addColumn<double>("straddle");
        QTest::addColumn<double>("pick");
        QTest::addColumn<bool>("capped");
        QTest::newRow("13.2 → 26.4 → 25") << 13.2 << 25.0 << false;
        QTest::newRow("12.5 → 25 正好") << 12.5 << 25.0 << false;
        QTest::newRow("14 → 28 → 30(离 30 近)") << 14.0 << 30.0 << false;
        QTest::newRow("11 → 22 → 20") << 11.0 << 20.0 << false;
        QTest::newRow("8 → 16 → 20(最小档)") << 8.0 << 20.0 << false;
        QTest::newRow("20 → 40 一样近取大的 50") << 20.0 << 50.0 << false;
        QTest::newRow("19 → 38 → 30") << 19.0 << 30.0 << false;
        QTest::newRow("31 → 62 → 50") << 31.0 << 50.0 << false;
        QTest::newRow("32 → 64 → 75") << 32.0 << 75.0 << false;
        QTest::newRow("37.5 → 75 正好,不算盖不住") << 37.5 << 75.0 << false;
        QTest::newRow("40 → 80 超过最大档") << 40.0 << 75.0 << true;
        QTest::newRow("60 → 120 下限 90 也超过最大档") << 60.0 << 75.0 << true;
    }
    void widthLadderPick() {
        QFETCH(double, straddle);
        QFETCH(double, pick);
        QFETCH(bool, capped);
        const fe::WidthPick w = fe::pickWidth(straddle, fe::Config{});
        QCOMPARE(w.pick, pick);
        QCOMPARE(w.capped, capped);
        QCOMPARE(w.raw, 2.0 * straddle);
        QCOMPARE(w.floor, 1.5 * straddle);
        QVERIFY(w.pick >= w.floor - 1e-9 || w.capped);
    }

    /// 最近的档低于下限时再上一档(默认的 2 / 1.5 碰不到,下限抬到 1.9 倍才看得见)
    void widthStepsUpWhenBelowFloor() {
        fe::Config cfg;
        cfg.width_floor_mult = 1.9;
        const fe::WidthPick w = fe::pickWidth(19.5, cfg);  // raw 39 → 最近 30;下限 37.05 → 上到 50
        QCOMPARE(w.pick, 50.0);
        QVERIFY(!w.capped);
    }

    void widthInOutput() {
        const OJson out = fe::evaluate(fe::Config{}, baseInput());
        const OJson* w = out.get(u"width"_s);
        QVERIFY(js::isObj(w));
        QCOMPARE(js::num(js::prop(w, u"pick"_s)), 25.0);
        QCOMPARE(js::num(js::prop(w, u"straddle"_s)), 13.2);
        QCOMPARE(js::num(js::prop(w, u"raw"_s)), 26.4);
        QCOMPARE(js::num(js::prop(w, u"floor"_s)), 19.8);
        QCOMPARE(js::num(js::prop(w, u"strike"_s)), 6700.0);
        const QString text = js::str(js::prop(w, u"text"_s));
        QVERIFY2(text.contains(u"建议翼宽 25 点") && text.contains(u"2 × 跨式 13.2 = 26.4") && text.contains(u"1.5 × = 19.8"), qPrintable(text));
        QVERIFY(js::str(js::prop(w, u"basis"_s)).contains(u"57%"));
        QVERIFY(keysOf(out).isEmpty());
        QVERIFY(out.get(u"timing"_s)->type == OJson::Null);
        QVERIFY(notesOf(out).isEmpty());
        QVERIFY(js::truthy(out.get(u"enabled"_s)));
    }

    void widthCappedText() {
        fe::Input in = baseInput();
        in.straddle = 40;
        const OJson out = fe::evaluate(fe::Config{}, in);
        const OJson* w = out.get(u"width"_s);
        QVERIFY(js::truthy(js::prop(w, u"capped"_s)));
        QVERIFY(js::str(js::prop(w, u"text"_s)).contains(u"盖不住"));
    }

    void noStraddleGivesNoteNotWidth() {
        fe::Input in = baseInput();
        in.straddle.reset();
        in.straddleNote = u"日内剧本关着"_s;
        const OJson out = fe::evaluate(fe::Config{}, in);
        QVERIFY(out.get(u"width"_s)->type == OJson::Null);
        QVERIFY(anyContains(notesOf(out), u"日内剧本关着"_s));
        // 墙那一条也要跨式,所以也不判
        QVERIFY(anyContains(notesOf(out), u"没有跨式"_s));
        QVERIFY(keysOf(out).isEmpty());
    }

    // ---- 前一日大跌后的下午
    void priorDropFiresAtThresholdAfterNoon() {
        fe::Input in = baseInput();
        in.prevClose = 6800;
        in.priorClose = 6732;  // −1.00%
        in.etMinutes = 12 * 60;
        const OJson out = fe::evaluate(fe::Config{}, in);
        QCOMPARE(keysOf(out), QStringList{u"prior_drop"_s});
        const OJson& f = out.get(u"flags"_s)->items[0];
        QVERIFY2(js::str(js::prop(&f, u"title"_s)).contains(u"−1.00%"), qPrintable(js::str(js::prop(&f, u"title"_s))));
        QVERIFY(js::str(js::prop(&f, u"basis"_s)).contains(u"37–47%"));
        QVERIFY(js::str(js::prop(&f, u"basis"_s)).contains(u"2026-10-28"));
        QCOMPARE(js::num(js::path(&out, {u"inputs"_s, u"prior_change_pct"_s})), -1.0);
    }
    void priorDropNotBeforeNoon() {
        fe::Input in = baseInput();
        in.prevClose = 6800;
        in.priorClose = 6700;  // −1.47%
        in.etMinutes = 11 * 60 + 59;
        QVERIFY(keysOf(fe::evaluate(fe::Config{}, in)).isEmpty());
    }
    void priorDropNotWhenSmaller() {
        fe::Input in = baseInput();
        in.prevClose = 6800;
        in.priorClose = 6732.68;  // −0.99%
        in.etMinutes = 14 * 60;
        QVERIFY(keysOf(fe::evaluate(fe::Config{}, in)).isEmpty());
    }
    void priorDropMissingCloseIsANote() {
        fe::Input in = baseInput();
        in.prevClose.reset();
        in.priorNote = u"日线不够两根"_s;
        in.etMinutes = 14 * 60;
        const OJson out = fe::evaluate(fe::Config{}, in);
        QVERIFY(keysOf(out).isEmpty());
        QVERIFY(anyContains(notesOf(out), u"日线不够两根"_s));
        QVERIFY(js::path(&out, {u"inputs"_s, u"prior_change_pct"_s})->type == OJson::Null);
    }
    void priorDropThresholdFromConfig() {
        fe::Config cfg;
        cfg.prior_drop_pct = 0.5;
        cfg.prior_drop_after_min = 10 * 60;
        fe::Input in = baseInput();
        in.prevClose = 6800;
        in.priorClose = 6760;  // −0.59%
        in.etMinutes = 10 * 60;
        QCOMPARE(keysOf(fe::evaluate(cfg, in)), QStringList{u"prior_drop"_s});
    }

    // ---- 周四中午前
    void thursdayBeforeNoonFires() {
        fe::Input in = baseInput();
        in.weekday = 4;
        in.etMinutes = 11 * 60 + 59;
        const OJson out = fe::evaluate(fe::Config{}, in);
        QCOMPARE(keysOf(out), QStringList{u"thursday"_s});
        QVERIFY(js::str(js::prop(&out.get(u"flags"_s)->items[0], u"basis"_s)).contains(u"33%"));
    }
    void thursdayAtNoonDoesNot() {
        fe::Input in = baseInput();
        in.weekday = 4;
        in.etMinutes = 12 * 60;
        QVERIFY(keysOf(fe::evaluate(fe::Config{}, in)).isEmpty());
    }
    void wednesdayMorningDoesNot() {
        fe::Input in = baseInput();
        in.weekday = 3;
        in.etMinutes = 10 * 60;
        QVERIFY(keysOf(fe::evaluate(fe::Config{}, in)).isEmpty());
    }

    // ---- 两个 put 墙都近
    void bothPutWallsNearFires() {
        fe::Input in = baseInput();
        in.spxPutWall = 6650;  // 55 点 = 4.17 × 13.2
        in.spyPutWall = 662;   // 0.90%
        const OJson out = fe::evaluate(fe::Config{}, in);
        QCOMPARE(keysOf(out), QStringList{u"put_walls"_s});
        const QString basis = js::str(js::prop(&out.get(u"flags"_s)->items[0], u"basis"_s));
        QVERIFY2(basis.contains(u"6650") && basis.contains(u"55.0 点") && basis.contains(u"4.2 × 跨式") && basis.contains(u"662") && basis.contains(u"0.90%"), qPrintable(basis));
        QVERIFY(basis.contains(u"弱信号"));
    }
    void putWallsExactlyAtThresholdsFire() {
        fe::Input in = baseInput();
        in.straddle = 10;
        in.spxSpot = 6700;
        in.spxPutWall = 6700 - 59;  // 5.9 × 10
        in.spySpot = 700;
        in.spyPutWall = 700 - 9.17;  // 1.31%
        QCOMPARE(keysOf(fe::evaluate(fe::Config{}, in)), QStringList{u"put_walls"_s});
    }
    void onlySpxNearDoesNot() {
        fe::Input in = baseInput();
        in.spxPutWall = 6650;
        in.spyPutWall = 658;  // 1.50%
        QVERIFY(keysOf(fe::evaluate(fe::Config{}, in)).isEmpty());
    }
    void onlySpyNearDoesNot() {
        fe::Input in = baseInput();
        in.spyPutWall = 662;
        in.spxPutWall = 6600;  // 7.95 ×
        QVERIFY(keysOf(fe::evaluate(fe::Config{}, in)).isEmpty());
    }
    void spyChainMissingSkipsRuleWithNote() {
        fe::Input in = baseInput();
        in.spxPutWall = 6650;
        in.spySpot.reset();
        in.spyPutWall.reset();
        in.spyWallNote = u"SPY 的期权链取不到:需要先连券商"_s;
        const OJson out = fe::evaluate(fe::Config{}, in);
        QVERIFY(keysOf(out).isEmpty());
        QVERIFY(anyContains(notesOf(out), u"「两个 put 墙都近」这一条没判:SPY 的期权链取不到:需要先连券商"_s));
        // 翼宽建议不受影响
        QVERIFY(js::isObj(out.get(u"width"_s)));
        QVERIFY(js::path(&out, {u"inputs"_s, u"spy_put_wall"_s})->type == OJson::Null);
    }
    void spxWallMissingSkipsRule() {
        fe::Input in = baseInput();
        in.spxPutWall.reset();
        in.spyPutWall = 662;
        const OJson out = fe::evaluate(fe::Config{}, in);
        QVERIFY(keysOf(out).isEmpty());
        QVERIFY(anyContains(notesOf(out), u"SPX 当天到期的 put 墙取不到"_s));
    }
    /// 墙是取到的那段链里的最大持仓量:链没取到阈值之外(每边 15 档 = 75 点,而 5.9 × 13.2 = 77.9),近不近分不出来 → 不判、写原因
    void narrowWindowSkipsRuleWithNote() {
        fe::Input in = baseInput();
        in.spxPutWall = 6650;
        in.spyPutWall = 662;
        in.spxWindowLow = 6630;  // 75 点
        in.spxThinned = true;
        const OJson out = fe::evaluate(fe::Config{}, in);
        QVERIFY(keysOf(out).isEmpty());
        const QStringList notes = notesOf(out);
        QVERIFY2(anyContains(notes, u"SPX 的链只取到 6630(离现货 75.0 点),盖不住 5.9 × 跨式 = 77.9 点,而且是抽着取的"_s), qPrintable(notes.join(u" | "_s)));
        // SPY 那头也一样
        in.spxWindowLow = 6550;
        in.spySpot = 668;
        in.spyWindowLow = 661;  // 1.05% < 1.31%
        const OJson out2 = fe::evaluate(fe::Config{}, in);
        QVERIFY(keysOf(out2).isEmpty());
        QVERIFY(anyContains(notesOf(out2), u"SPY 的链只取到 661"_s));
        // 窗口刚好过线就判
        in.spyWindowLow = 659;  // 1.35%
        QCOMPARE(keysOf(fe::evaluate(fe::Config{}, in)), QStringList{u"put_walls"_s});
        // 没给窗口(不知道取了多宽)照判
        in.spxWindowLow.reset();
        in.spyWindowLow.reset();
        QCOMPARE(keysOf(fe::evaluate(fe::Config{}, in)), QStringList{u"put_walls"_s});
    }
    void wallAboveSpotIsNotNear() {
        fe::Input in = baseInput();
        in.spxPutWall = 6710;  // 高于现货:不是下方的墙
        in.spyPutWall = 662;
        QVERIFY(keysOf(fe::evaluate(fe::Config{}, in)).isEmpty());
    }

    // ---- 时段
    void lateEntryTiming() {
        fe::Input in = baseInput();
        in.etMinutes = 15 * 60;
        const OJson out = fe::evaluate(fe::Config{}, in);
        QVERIFY(js::isObj(out.get(u"timing"_s)));
        QVERIFY(js::str(js::path(&out, {u"timing"_s, u"title"_s})).contains(u"15:00 以后"));
        QVERIFY(js::str(js::path(&out, {u"timing"_s, u"basis"_s})).contains(u"58.3%"));
        in.etMinutes = 14 * 60 + 59;
        QVERIFY(fe::evaluate(fe::Config{}, in).get(u"timing"_s)->type == OJson::Null);
    }

    // ---- 几条一起
    void flagsStackInFixedOrder() {
        fe::Input in = baseInput();
        in.weekday = 4;
        in.etMinutes = 11 * 60;
        in.prevClose = 6800;
        in.priorClose = 6700;  // 大跌但上午:不报
        in.spxPutWall = 6650;
        in.spyPutWall = 662;
        QCOMPARE(keysOf(fe::evaluate(fe::Config{}, in)), (QStringList{u"thursday"_s, u"put_walls"_s}));
        in.etMinutes = 13 * 60;  // 下午:大跌报了、周四不报
        QCOMPARE(keysOf(fe::evaluate(fe::Config{}, in)), (QStringList{u"prior_drop"_s, u"put_walls"_s}));
    }

    void disabledGivesNothing() {
        fe::Config cfg;
        cfg.enabled = false;
        fe::Input in = baseInput();
        in.weekday = 4;
        in.etMinutes = 15 * 60 + 30;
        in.spxPutWall = 6650;
        in.spyPutWall = 662;
        in.prevClose = 6800;
        in.priorClose = 6700;
        const OJson out = fe::evaluate(cfg, in);
        QVERIFY(!js::truthy(out.get(u"enabled"_s)));
        QVERIFY(out.get(u"width"_s)->type == OJson::Null);
        QVERIFY(keysOf(out).isEmpty());
        QVERIFY(out.get(u"timing"_s)->type == OJson::Null);
        QVERIFY(notesOf(out).isEmpty());
        QCOMPARE(js::str(js::path(&out, {u"inputs"_s, u"et"_s})), u"15:30"_s);
    }
};

QTEST_GUILESS_MAIN(TestFlyEntryAssist)
#include "tst_fly_entry_assist.moc"
