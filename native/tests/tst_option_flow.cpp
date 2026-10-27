// 期权主动成交:报价规则分类(quote-rule-v1)、组合单配对、按合约加总、次日持仓量对照、记盘那一路的读数比对。
// 期望值全是手算的合成数据,口径写在每个用例旁边;没有原版可对照(这是新功能)。
#include "analysis/option_flow.h"
#include "domain/option_flow_log.h"
#include "orchestrate/services/flow_recorder.h"
#include "util/jsobj.h"

#include <QTemporaryDir>
#include <QTest>

#include <cmath>

using namespace Qt::StringLiterals;
using namespace ibkr;
namespace of = analysis::optionflow;
namespace js = util::js;

namespace {
of::Print print(double t, double k, const QString& r, double dv, double last, std::optional<double> pb, std::optional<double> pa,
                std::optional<double> b = std::nullopt, std::optional<double> a = std::nullopt) {
    of::Print p;
    p.t = t;
    p.expiry = u"20261028"_s;
    p.strike = k;
    p.right = r;
    p.dv = dv;
    p.last = last;
    p.prev = {pb, pa};
    p.now = {b, a};
    return p;
}
}  // namespace

class TestOptionFlow : public QObject {
    Q_OBJECT
private slots:
    void quoteRule() {
        // 盘口 2.00 / 2.20,中间价 2.10
        const auto at = [](double last) { return of::classify(print(0, 6800, u"C"_s, 1, last, 2.0, 2.2)); };
        QCOMPARE(at(2.20).rule, u"at_ask"_s);
        QCOMPARE(at(2.25).side, of::Side::Buy);  // 穿过卖价也是买方主动
        QCOMPARE(at(2.00).rule, u"at_bid"_s);
        QCOMPARE(at(1.95).side, of::Side::Sell);
        QCOMPARE(at(2.15).rule, u"above_mid"_s);
        QCOMPARE(at(2.05).rule, u"below_mid"_s);
        QCOMPARE(at(2.10).rule, u"mid"_s);
        QCOMPARE(at(2.10).side, of::Side::Unknown);
        QCOMPARE(at(2.20).quote, u"prev"_s);
    }
    void prevQuoteWins() {
        // 成交把卖价吃掉之后盘口上移到 2.20 / 2.40:按之后那口算是卖方主动,按之前那口(对的)是买方主动
        const auto v = of::classify(print(0, 6800, u"C"_s, 3, 2.20, 2.0, 2.2, 2.2, 2.4));
        QCOMPARE(v.side, of::Side::Buy);
        QCOMPARE(v.quote, u"prev"_s);
        // 之前那口不可用才退到之后那口
        const auto f = of::classify(print(0, 6800, u"C"_s, 3, 2.20, std::nullopt, std::nullopt, 2.2, 2.4));
        QCOMPARE(f.side, of::Side::Sell);
        QCOMPARE(f.quote, u"now"_s);
    }
    void refusesToGuess() {
        QCOMPARE(of::classify(print(0, 6800, u"C"_s, 0, 2.1, 2.0, 2.2)).rule, u"no_volume"_s);
        auto noLast = print(0, 6800, u"C"_s, 1, 2.1, 2.0, 2.2);
        noLast.last.reset();
        QCOMPARE(of::classify(noLast).rule, u"no_last"_s);
        QCOMPARE(of::classify(print(0, 6800, u"C"_s, 1, 2.1, std::nullopt, std::nullopt)).rule, u"no_quote"_s);
        QCOMPARE(of::classify(print(0, 6800, u"C"_s, 1, 2.1, 2.3, 2.2)).rule, u"no_quote"_s);  // 交叉盘
        QCOMPARE(of::classify(print(0, 6800, u"C"_s, 1, 2.1, 2.1, 2.1)).rule, u"locked"_s);
        auto delayed = print(0, 6800, u"C"_s, 1, 2.2, 2.0, 2.2);
        delayed.marketDataType = 3;
        QCOMPARE(of::classify(delayed).rule, u"delayed"_s);
        // 成交量涨了但成交时刻没往前走:手里的价是上一笔的
        auto stale = print(0, 6800, u"C"_s, 1, 2.2, 2.0, 2.2);
        stale.lastAt = 100;
        stale.prevLastAt = 100;
        QCOMPARE(of::classify(stale).rule, u"stale_last"_s);
        stale.lastAt = 101;
        QCOMPARE(of::classify(stale).rule, u"at_ask"_s);
        // 买价 0(没人出价)照样能分
        QCOMPARE(of::classify(print(0, 6800, u"C"_s, 1, 0.05, 0.0, 0.05)).rule, u"at_ask"_s);
    }
    void spreadPairs() {
        // 6800C 与 6810C 在 100 毫秒里各成交 5 张:像一张垂直价差,两条都标;300 毫秒外的同量不算;同一合约的两笔不算
        std::vector<of::Print> ps{print(1000, 6800, u"C"_s, 5, 2.2, 2.0, 2.2), print(1100, 6810, u"C"_s, 5, 1.0, 0.9, 1.0),
                                  print(1400, 6820, u"C"_s, 5, 0.5, 0.4, 0.5), print(1450, 6820, u"C"_s, 5, 0.5, 0.4, 0.5),
                                  print(2000, 6790, u"P"_s, 2, 3.0, 2.8, 3.0)};
        const auto flags = of::spreadLike(ps);
        QCOMPARE(flags, (std::vector<bool>{true, true, false, false, false}));
        // 次序打乱结果跟着行走
        std::vector<of::Print> rev(ps.rbegin(), ps.rend());
        QCOMPARE(of::spreadLike(rev), (std::vector<bool>{false, false, false, true, true}));
    }
    void aggregateByContract() {
        std::vector<of::Print> ps{print(1000, 6800, u"C"_s, 5, 2.2, 2.0, 2.2), print(1100, 6810, u"C"_s, 5, 1.0, 0.9, 1.0),  // 组合单
                                  print(5000, 6800, u"C"_s, 3, 2.2, 2.0, 2.2),                                          // 买 3
                                  print(9000, 6800, u"C"_s, 2, 2.0, 2.0, 2.2),                                          // 卖 2
                                  print(13000, 6800, u"C"_s, 1, 2.1, 2.0, 2.2),                                         // 中间价,分不出
                                  print(17000, 6790, u"P"_s, 4, 3.0, 2.8, 3.0)};
        const auto f = of::aggregate(ps);
        QCOMPARE(f.size(), size_t(3));
        QCOMPARE(f[0].strike, 6790.0);
        QCOMPARE(f[0].buy, 4.0);
        QCOMPARE(f[1].strike, 6800.0);
        QCOMPARE(f[1].buy, 3.0);
        QCOMPARE(f[1].sell, 2.0);
        QCOMPARE(f[1].unknown, 1.0);
        QCOMPARE(f[1].spread, 5.0);
        QCOMPARE(f[1].net(), 1.0);
        QCOMPARE(f[1].seen(), 11.0);
        QCOMPARE(f[2].spread, 5.0);
        QCOMPARE(f[2].buy + f[2].sell, 0.0);
    }
    void observeStream() {
        orchestrate::FlowStreamState s{u"20261028"_s, 6800, u"C"_s, {}, {}, {}, false};
        execution::TickerData t;
        t.bid = 2.0;
        t.ask = 2.2;
        t.volume = 100;
        t.last = 2.1;
        t.lastTradeAt = 50;
        // 第一次见到:只记底
        auto rows = orchestrate::observeFlow(s, t, 1000);
        QCOMPARE(rows.size(), 1);
        QCOMPARE(js::str(rows[0].get(u"kind"_s)), u"vol"_s);
        QCOMPARE(rows[0].get(u"volume"_s)->n, 100.0);
        // 只有盘口变化:不记
        t.bid = 2.05;
        QCOMPARE(orchestrate::observeFlow(s, t, 1100).size(), 0);
        // 成交 4 张,价 2.2,之后盘口上移:之前那口是 2.05 / 2.2
        t.volume = 104;
        t.last = 2.2;
        t.lastTradeAt = 51;
        t.bid = 2.2;
        t.ask = 2.4;
        rows = orchestrate::observeFlow(s, t, 1200);
        QCOMPARE(rows.size(), 1);
        const util::OJson& p = rows[0];
        QCOMPARE(js::str(p.get(u"kind"_s)), u"print"_s);
        QCOMPARE(p.get(u"dv"_s)->n, 4.0);
        QCOMPARE(p.get(u"pb"_s)->n, 2.05);
        QCOMPARE(p.get(u"pa"_s)->n, 2.2);
        QCOMPARE(p.get(u"b"_s)->n, 2.2);
        QCOMPARE(p.get(u"plt"_s)->n, 50.0);
        QCOMPARE(p.get(u"lt"_s)->n, 51.0);
        const auto parsed = of::printFrom(p);
        QVERIFY(parsed);
        QCOMPARE(of::classify(*parsed).rule, u"at_ask"_s);
        // 这一次没带盘口(NaN):沿用上一口,不清掉
        t.bid = std::nan("");
        QCOMPARE(orchestrate::observeFlow(s, t, 1300).size(), 0);
        QCOMPARE(*s.quote.bid, 2.2);
        // 累计量往回跳(TWS 改正):记成新的底,不算成交
        t.volume = 90;
        rows = orchestrate::observeFlow(s, t, 1400);
        QCOMPARE(rows.size(), 1);
        QCOMPARE(js::str(rows[0].get(u"kind"_s)), u"vol"_s);
        t.volume = 91;
        QCOMPARE(orchestrate::observeFlow(s, t, 1500)[0].get(u"dv"_s)->n, 1.0);
    }
    void oiCheckAndLog() {
        QTemporaryDir dir;
        domain::OptionFlowLog log(dir.path());
        const auto rec = [](const QString& json) { return *js::parse(json); };
        // 6800C:早上持仓 1000,成交 3 买 1 卖、累计量 10(只看到 4 张,覆盖 0.4);次日持仓 1006 → ΔOI 6,开仓占 0.6
        // 6800P:有累计量没有成交;次日没有持仓量 → ΔOI 空
        log.appendAll(u"2026-10-27"_s, {rec(uR"({"kind":"sub","t":1,"expiry":"20261028","trading_class":"SPXW","anchor":6800,"spot":6801,"contracts":[[6800,"C"],[6800,"P"]]})"_s),
                                        rec(uR"({"kind":"oi","t":2,"expiry":"20261028","k":6800,"r":"C","oi":1000})"_s),
                                        rec(uR"({"kind":"vol","t":3,"expiry":"20261028","k":6800,"r":"C","volume":2})"_s),
                                        rec(uR"({"kind":"print","t":10000,"expiry":"20261028","k":6800,"r":"C","dv":3,"last":2.2,"pb":2.0,"pa":2.2,"b":2.1,"a":2.3})"_s),
                                        rec(uR"({"kind":"print","t":20000,"expiry":"20261028","k":6800,"r":"C","dv":1,"last":2.0,"pb":2.0,"pa":2.2,"b":2.0,"a":2.2})"_s),
                                        rec(uR"({"kind":"vol","t":30000,"expiry":"20261028","k":6800,"r":"C","volume":10})"_s),
                                        rec(uR"({"kind":"vol","t":30000,"expiry":"20261028","k":6800,"r":"P","volume":7})"_s)});
        { QFile f(log.fileOf(u"2026-10-27"_s)); QVERIFY(f.open(QIODevice::Append)); f.write("{broken\n{\"kind\":\"print\",\"t\":1}\n"); }
        log.appendAll(u"2026-10-28"_s, {rec(uR"({"kind":"oi","t":5,"expiry":"20261028","k":6800,"r":"C","oi":1006})"_s)});
        const auto day = log.read(u"2026-10-27"_s);
        QCOMPARE(day.size(), 7);  // 坏的两行跳过
        const util::OJson out = of::oiCheck(day, log.read(u"2026-10-28"_s));
        const auto& rows = out.get(u"rows"_s)->items;
        QCOMPARE(rows.size(), 2);
        const util::OJson& c = rows[0];
        QCOMPARE(js::str(c.get(u"right"_s)), u"C"_s);
        QCOMPARE(c.get(u"buy"_s)->n, 3.0);
        QCOMPARE(c.get(u"sell"_s)->n, 1.0);
        QCOMPARE(c.get(u"coverage"_s)->n, 0.4);
        QCOMPARE(c.get(u"d_oi"_s)->n, 6.0);
        QCOMPARE(c.get(u"open_share"_s)->n, 0.6);
        QCOMPARE(rows[1].get(u"d_oi"_s)->type, util::OJson::Null);
        const util::OJson* totals = out.get(u"totals"_s);
        QCOMPARE(totals->get(u"day_volume"_s)->n, 17.0);
        QCOMPARE(totals->get(u"coverage"_s)->n, 4.0 / 17.0);
        QCOMPARE(totals->get(u"open_share"_s)->n, 0.6);
        QCOMPARE(totals->get(u"buy_share_of_classified"_s)->n, 0.75);
        QCOMPARE(js::str(out.get(u"rule"_s)), of::kRuleVersion);
    }
    void accuracyAgainstTickByTick() {
        const auto rec = [](const QString& json) { return *js::parse(json); };
        const QString c = uR"("expiry":"20261028","k":6800,"r":"C")"_s;
        const auto tbt = [&](const QString& rest) { return rec(u"{\"kind\":\"tbt\","_s + c + u","_s + rest + u"}"_s); };
        const auto prt = [&](const QString& rest) { return rec(u"{\"kind\":\"print\","_s + c + u","_s + rest + u"}"_s); };
        // 逐笔:盘口 2.0/2.2;1100 买 3 → 记盘 1150 一行 3 张按卖价成交(买):对
        // 2000 卖 2、2050 买 1 → 记盘 2100 一行 3 张、最后一笔价 2.2(买):卖的 2 张分错,这一行买卖混在一起
        // 5000 未报告 4 张:不进矩阵;6000 在中间价 2 张(真值分不出)、7100 卖 1 张(盘口已是 2.1/2.3):都没有 2 秒内的记盘行
        const QList<util::OJson> ticks{tbt(uR"("t":1000,"type":"bidask","time":1,"bid":2.0,"ask":2.2)"_s),
                                       tbt(uR"("t":1100,"type":"last","time":1,"price":2.2,"size":3,"cond":"")"_s),
                                       tbt(uR"("t":2000,"type":"last","time":2,"price":2.0,"size":2,"cond":"")"_s),
                                       tbt(uR"("t":2050,"type":"last","time":2,"price":2.2,"size":1,"cond":"")"_s),
                                       tbt(uR"("t":5000,"type":"last","time":5,"price":2.2,"size":4,"unrep":true)"_s),
                                       tbt(uR"("t":6000,"type":"last","time":6,"price":2.1,"size":2,"cond":"T")"_s),
                                       tbt(uR"("t":7000,"type":"bidask","time":7,"bid":2.1,"ask":2.3)"_s),
                                       tbt(uR"("t":7100,"type":"last","time":7,"price":2.1,"size":1,"cond":"")"_s)};
        const QList<util::OJson> flow{prt(uR"("t":1150,"dv":3,"last":2.2,"pb":2.0,"pa":2.2)"_s), prt(uR"("t":2100,"dv":3,"last":2.2,"pb":2.0,"pa":2.2)"_s),
                                      prt(uR"("t":9500,"dv":1,"last":2.1,"pb":2.1,"pa":2.3)"_s)};
        const auto truth = of::truthFrom(ticks);
        QCOMPARE(truth.size(), size_t(6));
        QCOMPARE(*truth[5].nbbo.bid, 2.1);
        QCOMPARE(of::classifyTruth(truth[1]).side, of::Side::Sell);
        const util::OJson out = of::accuracy(flow, ticks);
        const util::OJson* m = out.get(u"matrix"_s);
        QCOMPARE(m->get(u"buy"_s)->get(u"buy"_s)->n, 4.0);
        QCOMPARE(m->get(u"sell"_s)->get(u"buy"_s)->n, 2.0);
        QCOMPARE(m->get(u"sell"_s)->get(u"unmatched"_s)->n, 1.0);
        QCOMPARE(m->get(u"unknown"_s)->get(u"unmatched"_s)->n, 2.0);
        QCOMPARE(out.get(u"accuracy"_s)->n, 4.0 / 6.0);
        QCOMPARE(out.get(u"classified_share"_s)->n, 6.0 / 7.0);
        QCOMPARE(out.get(u"match_share"_s)->n, 6.0 / 9.0);
        QCOMPARE(out.get(u"unreported"_s)->n, 4.0);
        QCOMPARE(out.get(u"mixed_prints"_s)->n, 1.0);
        QCOMPARE(out.get(u"matched_prints"_s)->n, 2.0);
        QCOMPARE(out.get(u"by_special"_s)->get(u"T"_s)->n, 2.0);
        const util::OJson* vc = out.get(u"volume_check"_s);
        QCOMPARE(vc->get(u"matched_trade_size"_s)->n, 6.0);
        QCOMPARE(vc->get(u"matched_print_dv"_s)->n, 6.0);
        QCOMPARE(vc->get(u"truth_size_incl_unreported"_s)->n, 13.0);
        QCOMPARE(vc->get(u"print_dv_same_contracts"_s)->n, 7.0);
        const util::OJson& net = out.get(u"nets"_s)->items[0];
        QCOMPARE(net.get(u"truth_net"_s)->n, 1.0);
        QCOMPARE(net.get(u"rec_net"_s)->n, 6.0);
        // 记盘那边被当成组合单的:进 spread 列,不算分错
        QList<util::OJson> withSpread = flow;
        withSpread << rec(uR"({"kind":"print","expiry":"20261028","k":6810,"r":"C","t":1160,"dv":3,"last":1.0,"pb":0.9,"pa":1.0})"_s);
        const util::OJson sp = of::accuracy(withSpread, ticks);
        QCOMPARE(sp.get(u"matrix"_s)->get(u"buy"_s)->get(u"spread"_s)->n, 3.0);
        QCOMPARE(sp.get(u"accuracy"_s)->n, 1.0 / 3.0);
    }
};

QTEST_GUILESS_MAIN(TestOptionFlow)
#include "tst_option_flow.moc"
