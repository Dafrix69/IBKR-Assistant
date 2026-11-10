// handlers1 簇·追踪域:rpc/handlers/tracker.ts 的 C++ 版对拍(钱路径)。期望值由原 handler 现跑(fixtures/gen_handlers1_tracker*.mjs),脚本与世界见 handlers1_world.h。
#include "handlers1_world.h"

#include <QTest>

using namespace Qt::StringLiterals;

class TestH1Tracker : public QObject {
    Q_OBJECT

private slots:
    void rapidExitValidation() {
        using namespace h1w;
        const OJson source = *fixture(u"handlers1_tracker_opt.json"_s).get(u"scenarios"_s)->items.first().get(u"script"_s);
        for (int variant = 0; variant < 12; ++variant) {
            OJson script = source;
            script.get(u"router"_s)->set(u"optionQuotes"_s, js::B(variant != 6));
            OJson& args = *script.get(u"steps"_s)->items[0].get(u"a"_s);
            args.set(u"rapid_exit_window_s"_s, js::S(u"1"_s));
            args.set(u"rapid_exit_pct"_s, js::S(u"5"_s));
            if (variant == 1) args.remove(u"rapid_exit_pct"_s);
            if (variant == 2) args.set(u"rapid_exit_pct"_s, js::N(0));
            if (variant == 3) args.set(u"rapid_exit_window_s"_s, js::N(0.1));
            if (variant == 4) args.set(u"rapid_exit_pct"_s, js::N(101));
            if (variant == 5) args.set(u"rapid_exit_pct"_s, js::S(u"abc"_s));
            if (variant == 10 || variant == 11) args.set(u"stop_loss"_s, js::S(QString())); // 只设急跌也可建
            if (variant >= 7 && variant != 10) {
                OJson patch = js::object({{u"rapid_exit_pct"_s, variant == 9 ? js::N(8) : js::Null()}});
                if (variant == 7 || variant == 11) patch.set(u"rapid_exit_window_s"_s, js::Null());
                script.get(u"steps"_s)->items.append(js::object({{u"op"_s, js::S(u"call"_s)}, {u"id"_s, js::S(u"b"_s)},
                    {u"m"_s, js::S(u"tracker.update"_s)}, {u"a"_s, js::object({{u"id"_s, js::S(u"00000000-0000-4000-8000-000000000001"_s)},
                    {u"auto_close"_s, patch}})}}));
            }
            Runner runner(script);
            const OJson result = runner.run();
            const auto& response = *result.get(u"steps"_s)->items.last().get(u"done"_s)->items[0].get(u"result"_s);
            const bool success = variant == 0 || variant == 7 || variant == 9 || variant == 10;
            QVERIFY2(bool(response.get(success ? u"result"_s : u"error"_s)), qPrintable(u"variant %1: %2"_s.arg(variant).arg(js::stringify(response))));
            if (variant == 9) QCOMPARE(js::num(js::path(&response, {u"result"_s, u"track"_s, u"auto_close"_s, u"rapid_exit_window_s"_s})), 1.0);
        }
    }
    /// 财报止盈的入参(C++ 先有):只给正股;涨幅范围;手填的财报日当场排窗口,排不出当场拒
    void earningsTpValidation() {
        using namespace h1w;
        OJson stock;
        for (const auto& sc : fixture(u"handlers1_tracker.json"_s).get(u"scenarios"_s)->items)
            if (sc.get(u"name"_s)->s.contains(u"止损 \"95\"")) stock = *sc.get(u"script"_s);
        QVERIFY(stock.get(u"steps"_s));  // 这一场的钟是 2026-09-11(周五)美东 12:00
        const OJson option = *fixture(u"handlers1_tracker_opt.json"_s).get(u"scenarios"_s)->items.first().get(u"script"_s);
        for (int variant = 0; variant < 9; ++variant) {
            OJson script = variant == 8 ? option : stock;
            OJson& args = *script.get(u"steps"_s)->items[0].get(u"a"_s);
            args.set(u"earnings_tp_pct"_s, js::S(u"8"_s));
            if (variant == 1 || variant == 4 || variant == 5 || variant == 7) args.set(u"earnings_timing"_s, js::S(u"after"_s));
            if (variant == 1) args.set(u"earnings_date"_s, js::S(u"2026-09-14"_s));
            if (variant == 2) args.set(u"earnings_date"_s, js::S(u"2026-09-14"_s));  // 没给时段
            if (variant == 3) args.set(u"earnings_tp_pct"_s, js::S(u"0"_s));
            if (variant == 4) args.set(u"earnings_date"_s, js::S(u"2026-09-12"_s));  // 周六
            if (variant == 5) args.set(u"earnings_date"_s, js::S(u"2026-09-09"_s));  // 反应日 09-10 已经收盘
            if (variant == 6) args.set(u"stop_loss"_s, js::S(QString()));           // 只设财报止盈也可建
            if (variant == 7) {
                args.set(u"earnings_date"_s, js::S(u"2026-09-14"_s));
                args.remove(u"earnings_tp_pct"_s);  // 填了日期没填涨幅
            }
            Runner runner(script);
            const OJson result = runner.run();
            const auto& response = *result.get(u"steps"_s)->items.last().get(u"done"_s)->items[0].get(u"result"_s);
            const bool success = variant == 0 || variant == 1 || variant == 6;
            QVERIFY2(bool(response.get(success ? u"result"_s : u"error"_s)), qPrintable(u"variant %1: %2"_s.arg(variant).arg(js::stringify(response))));
            if (!success) continue;
            const OJson* e = js::path(&response, {u"result"_s, u"track"_s, u"targets"_s, u"earnings_tp"_s});
            QVERIFY(e);
            QCOMPARE(js::num(e->get(u"pct"_s)), 8.0);
            QCOMPARE(js::truthy(e->get(u"manual"_s)), variant == 1);
            if (variant == 1) {
                QCOMPARE(js::str(e->get(u"timing"_s)), u"AFTER MARKET"_s);
                QCOMPARE(js::str(e->get(u"ref_date"_s)), u"2026-09-14"_s);
                QCOMPARE(js::str(e->get(u"react_date"_s)), u"2026-09-15"_s);
                QCOMPARE(js::num(e->get(u"start_ms"_s)), 1789416000000.0);  // 2026-09-14 16:00 美东(夏令时)
            } else {
                QVERIFY(!e->get(u"start_ms"_s));  // 没填日期:窗口留给引擎照财报日历排
            }
        }
    }
    void brokerSpotValidation() {
        using namespace h1w;
        OJson original;
        for (const auto& s : fixture(u"handlers1_tracker_opt.json"_s).get(u"scenarios"_s)->items)
            if (s.get(u"name"_s)->s.contains(u"两条线都在保护侧")) original = *s.get(u"script"_s);
        QVERIFY(original.get(u"steps"_s));
        for (int variant = 0; variant < 10; ++variant) {
            OJson script = original;
            auto& args = *script.get(u"steps"_s)->items[0].get(u"a"_s);
            args.set(u"auto_close"_s, js::B(true));
            args.set(u"host_at_broker"_s, js::B(true));
            args.set(u"spot_stop_at_broker"_s, js::B(true));
            if (variant == 1) args.set(u"spot_stop_confirm_s"_s, js::S(u"5"_s));
            if (variant == 2) args.set(u"order_type"_s, js::S(u"LMT"_s));
            if (variant == 3) args.set(u"host_at_broker"_s, js::B(false));
            if (variant == 4) args.set(u"spot_stop_at_broker"_s, js::S(u"false"_s));
            if (variant == 5) {
                args.set(u"order_type"_s, js::S(u"LMT"_s));
                args.set(u"spot_stop_limit"_s, js::S(u"10"_s));
            }
            if (variant == 6) args.set(u"order_type"_s, js::S(u"STP"_s));
            if (variant == 7) script.get(u"router"_s)->set(u"spotInfo"_s, js::object({
                {u"SPX"_s, js::object({{u"source"_s, js::S(u"futures"_s)}})}}));
            if (variant >= 8) {
                OJson patch = js::object({{u"order_type"_s, js::S(u"LMT"_s)}});
                if (variant == 9) patch.set(u"spot_stop_limit"_s, js::N(10));
                script.get(u"steps"_s)->items.append(js::object({{u"op"_s, js::S(u"call"_s)}, {u"id"_s, js::S(u"b"_s)},
                    {u"m"_s, js::S(u"tracker.update"_s)}, {u"a"_s, js::object({{u"id"_s, js::S(u"00000000-0000-4000-8000-000000000001"_s)},
                    {u"auto_close"_s, patch}})}}));
            }
            Runner runner(script);
            const auto result = runner.run();
            const auto& response = *result.get(u"steps"_s)->items.last().get(u"done"_s)->items[0].get(u"result"_s);
            if (variant == 0 || variant == 5 || variant == 9) {
                QVERIFY2(response.get(u"result"_s), qPrintable(js::stringify(response)));
                QVERIFY(js::path(&response, {u"result"_s, u"track"_s, u"auto_close"_s, u"spot_stop_at_broker"_s})->b);
            } else {
                QVERIFY2(response.get(u"error"_s), qPrintable(u"variant %1: %2"_s.arg(variant).arg(js::stringify(response))));
            }
        }
    }
    void initTestCase() { qputenv("DAFRI_PROMPT_DIR", QByteArray(IBKR_PROMPTS_DIR)); }

    H1_SCENARIOS(tracker, u"handlers1_tracker.json"_s)
    H1_SCENARIOS(trackerOpt, u"handlers1_tracker_opt.json"_s)
    H1_SCENARIOS(trackerOps, u"handlers1_tracker_ops.json"_s)
};

QTEST_GUILESS_MAIN(TestH1Tracker)
#include "tst_h1_tracker.moc"
