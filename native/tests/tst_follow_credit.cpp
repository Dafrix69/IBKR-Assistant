// 跟进来的贷方价差成交后建追踪:消息里的标的止损句、止盈价、待建记录的往返,以及空头组合持仓行的 key 和下单时记下的腿身份对得上。
#include "domain/config.h"
#include "domain/positions.h"
#include "orchestrate/closing.h"
#include "parsing/follow.h"
#include "parsing/shorthand.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"

#include <QDateTime>

#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using util::OJson;
namespace js = util::js;
namespace fo = parsing::follow;

namespace {
OJson optionRow(const QString& account, double strike, const QString& right, double qty, double avgCost) {
    const OJson contract = js::object({{u"secType"_s, js::S(u"OPT"_s)},
                                       {u"symbol"_s, js::S(u"SPX"_s)},
                                       {u"lastTradeDateOrContractMonth"_s, js::S(u"20261028"_s)},
                                       {u"strike"_s, js::N(strike)},
                                       {u"right"_s, js::S(right)},
                                       {u"multiplier"_s, js::S(u"100"_s)},
                                       {u"tradingClass"_s, js::S(u"SPXW"_s)}});
    const QString leg = domain::legOf(&contract);
    return js::object({{u"key"_s, js::S(domain::makeKey(account, u"SPX"_s, u"OPT"_s, leg))},
                       {u"account"_s, js::S(account)},
                       {u"symbol"_s, js::S(u"SPX"_s)},
                       {u"sec_type"_s, js::S(u"OPT"_s)},
                       {u"leg"_s, js::S(leg)},
                       {u"quantity"_s, js::N(qty)},
                       {u"avg_cost"_s, js::N(avgCost)},
                       {u"multiplier"_s, js::N(100)},
                       {u"currency"_s, js::S(u"USD"_s)},
                       {u"market_price"_s, js::N(1)},
                       {u"contract"_s, contract}});
}
}  // namespace

class TestFollowCredit : public QObject {
    Q_OBJECT
private slots:
    void stopClauseOnlyOnSpreads() {
        const auto c = fo::takeStopClause(u"7840 7845 bear call 至少-2 站稳60止损"_s);
        QCOMPARE(c.text, u"7840 7845 bear call 至少-2"_s);
        QCOMPARE(c.level.value_or(QString()), u"60"_s);
        const auto d = fo::takeStopClause(u"7700 7695 bull put -2 跌破 7650 止损"_s);
        QCOMPARE(d.text, u"7700 7695 bull put -2"_s);
        QCOMPARE(d.level.value_or(QString()), u"7650"_s);
        // 蝴蝶的止损句不摘:那一类仍然只提醒、不发
        const auto fly = fo::takeStopClause(u"7650 蝴蝶 30CM 3.4试下 站稳00止损"_s);
        QCOMPARE(fly.text, u"7650 蝴蝶 30CM 3.4试下 站稳00止损"_s);
        QVERIFY(!fly.level);
        const auto none = fo::takeStopClause(u"7765 7760 bull put -2"_s);
        QCOMPARE(none.text, u"7765 7760 bull put -2"_s);
        QVERIFY(!none.level);
    }

    void stopLevelLandsOnTheSpreadsSide() {
        // 尾数:bull put 取现价下方最近的、bear call 取上方最近的
        auto s = fo::resolveSpreadStop(u"00"_s, true, 7630);
        QCOMPARE(s.below.value_or(0), 7600.0);
        QVERIFY(!s.above);
        s = fo::resolveSpreadStop(u"00"_s, false, 7685);
        QCOMPARE(s.above.value_or(0), 7700.0);
        s = fo::resolveSpreadStop(u"60"_s, false, 7740);
        QCOMPARE(s.above.value_or(0), 7760.0);
        s = fo::resolveSpreadStop(u"60.5"_s, false, 7740);  // 带小数的尾数也是尾数
        QCOMPARE(s.above.value_or(0), 7760.5);
        s = fo::resolveSpreadStop(u"60"_s, false, 7760);  // 正好压在现价上:上一档离了 100 点,不猜
        QVERIFY(!s.above && s.note.contains(u"50"_s));
        // 绝对价位:在错的一侧不设,说为什么
        s = fo::resolveSpreadStop(u"7700"_s, true, 7685);
        QVERIFY(!s.below && !s.above);
        QVERIFY(s.note.contains(u"下方"_s));
        s = fo::resolveSpreadStop(u"7650"_s, true, 7685);
        QCOMPARE(s.below.value_or(0), 7650.0);
        s = fo::resolveSpreadStop(u"00"_s, true, std::nullopt);
        QVERIFY(!s.below && s.note.contains(u"现价"_s));
    }

    void takeProfitAndParams() {
        QCOMPARE(fo::creditTakeProfit(2.5).value_or(0), 1.0);
        QCOMPARE(fo::creditTakeProfit(2.13).value_or(0), 0.85);
        QVERIFY(!fo::creditTakeProfit(0));
        // 止损:亏到权利金的 50%,即买回价到收的 1.5 倍
        QCOMPARE(fo::creditStopLoss(2.0).value_or(0), 3.0);
        QCOMPARE(fo::creditStopLoss(2.14).value_or(0), 3.21);
        QVERIFY(!fo::creditStopLoss(0));
        QVERIFY(!fo::creditStopLoss(-1));
        const OJson p = fo::creditTrackParams(u"k"_s, u"15:30"_s, 1.0, std::nullopt, 7600.0, std::nullopt);
        QCOMPARE(js::str(p.get(u"take_profit"_s)), u"1"_s);
        QCOMPARE(js::str(p.get(u"stop_loss"_s)), QString());
        QCOMPARE(js::str(p.get(u"spot_stop_below"_s)), u"7600"_s);
        QCOMPARE(js::str(p.get(u"spot_stop_above"_s)), QString());
        QCOMPARE(js::str(p.get(u"exit_at"_s)), u"15:30"_s);
        QVERIFY(p.get(u"auto_close"_s)->b);
        QVERIFY(!p.get(u"profit_drawdown_preset"_s));  // 蝶式预设不套在价差上
        const OJson q = fo::creditTrackParams(u"k"_s, QString(), 1.0, 3.0, std::nullopt, std::nullopt);
        QCOMPARE(js::str(q.get(u"stop_loss"_s)), u"3"_s);
        QCOMPARE(js::str(q.get(u"spot_stop_below"_s)), QString());
    }

    void pendingRoundTrip() {
        fo::PendingTrack t;
        t.record_id = u"r"_s;
        t.message_id = u"m"_s;
        t.account = u"模拟"_s;
        t.symbol = u"SPX"_s;
        t.leg = u"20261028|+1x7600P,-1x7605P"_s;
        t.at_ms = 1;
        t.side = u"credit"_s;
        t.stop_below = 7550;
        OJson arr = js::array();
        arr.items.append(t.toJson());
        // 旧记录没有 side / 止损线:照样读得出,当买入的蝴蝶
        OJson old = t.toJson();
        old.remove(u"side"_s);
        old.remove(u"stop_below"_s);
        arr.items.append(old);
        const auto back = fo::pendingTracksOf(&arr);
        QCOMPARE(back.size(), size_t(2));
        QCOMPARE(back[0].side, u"credit"_s);
        QCOMPARE(back[0].stop_below.value_or(0), 7550.0);
        QVERIFY(!back[0].stop_above);
        QVERIFY(back[1].side.isEmpty());
        QVERIFY(!back[1].stop_below);
    }

    // 成交之后按 key 找持仓:速记解析出来的 bull put 记下的腿身份,要和券商报来的两条腿合成的空头组合行一致
    void shortVerticalRowMatchesTheOrdersLeg() {
        const domain::EtNow moment = domain::etNowFromEpoch(QDateTime::fromString(u"2026-10-28T14:00:00Z"_s, Qt::ISODate).toMSecsSinceEpoch());
        const OJson snap = js::object({{u"SPX"_s, js::N(7640)}});
        const OJson parsed = parsing::shorthand::tryParseShorthand(u"7605 7600 bull put -2"_s, snap, moment);
        QVERIFY2(parsed.type == OJson::Object, "速记没接住");
        const OJson& order = parsed.get(u"orders"_s)->items.at(0);
        const QString leg = orchestrate::orderLegId(order);
        // 卖 7605P、买 7600P,收 2.1:IBKR 的 avg_cost 含乘数
        const QList<OJson> rows{optionRow(u"模拟"_s, 7600, u"P"_s, 1, 150), optionRow(u"模拟"_s, 7605, u"P"_s, -1, 360)};
        const QList<OJson> all = domain::withCombos(rows);
        const OJson* combo = nullptr;
        for (const OJson& r : all)
            if (js::str(r.get(u"sec_type"_s)) == u"BAG") combo = &r;
        QVERIFY(combo);
        QCOMPARE(js::str(combo->get(u"key"_s)), domain::makeKey(u"模拟"_s, u"SPX"_s, u"BAG"_s, leg));
        QVERIFY(js::num(combo->get(u"quantity"_s)) < 0);  // 空头组合:数量是负的
        QCOMPARE(js::num(combo->get(u"avg_cost"_s)) / js::num(combo->get(u"multiplier"_s)), 2.1);
    }
};

QTEST_GUILESS_MAIN(TestFollowCredit)
#include "tst_follow_credit.moc"
