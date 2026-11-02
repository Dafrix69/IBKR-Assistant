// 铁蝶下单路径,全部离线:本地速记「7750铁蝶 25cm 2张 -19.5」→ 与大模型同形的四腿 IRON_CONDOR 贷方 payload →
// 校验(放行 / 拒绝的几种腿形)→ 券商那一层的订单构造(BAG 一律 BUY、带符号净价为负、LMT 与 STP LMT 都能构造)→
// 持仓行合成成 iron_butterfly 并给出平仓合约。真机 whatIf(4 腿组合单 IBKR 接哪些订单类型)不在这里,待用户核对。
#include "domain/config.h"
#include "domain/positions.h"
#include "execution/broker.h"
#include "orchestrate/tracker.h"
#include "parsing/shorthand.h"
#include "parsing/validator.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/py.h"

#include <QDateTime>
#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using util::OJson;
namespace js = util::js;
namespace sh = parsing::shorthand;
namespace val = parsing::validator;

namespace {
// 2026-10-28(周三)美东 10:00:常规时段,当日到期
const double kNowMs = QDateTime::fromString(u"2026-10-28T14:00:00Z"_s, Qt::ISODate).toMSecsSinceEpoch();

domain::Settings settings() {
    OJson raw = *js::parse(QStringLiteral(
        R"({"prompt_version":"v1.8.0","llm":{"model":"claude-opus-5","effort":"high","temperature":null},
            "limits":{"max_order_notional":50000,"max_option_contracts":10,"max_mkt_shares":200,"min_confidence":0.9,"max_spread_slippage":0.1,
                      "max_orders_per_input":5,"duplicate_window_minutes":10,"duplicate_qty_tolerance":0.2},
            "policies":{"require_trigger_price_verification":true,"trigger_min_gap_bps":5,"closed_market_policy":"allow"},
            "connections":{"paper":{"host":"127.0.0.1","port":7497,"client_id":11}},
            "accounts":[{"alias":"模拟","account_id":"DU1","is_paper":true,"connection":"paper","default":true}],
            "storage":{"db_path":"/tmp/x/trades.db"}})"));
    return domain::fromDict(raw);
}

OJson parse(const QString& text, double spot = 7640) {
    const domain::EtNow moment = domain::etNowFromEpoch(kNowMs);
    const OJson snap = js::object({{u"SPX"_s, js::N(spot)}});
    return sh::tryParseShorthand(text, snap, moment);
}

OJson firstOrder(const OJson& parsed) {
    if (parsed.type != OJson::Object) return OJson::null();
    OJson o = parsed.get(u"orders"_s)->items.at(0);
    o.set(u"account"_s, js::S(u"模拟"_s));  // 引擎在校验前把 DEFAULT 换成默认账户
    return o;
}

QList<val::Issue> validate(OJson order) {
    const domain::Settings s = settings();
    val::Validator v(s, domain::etNowFromEpoch(kNowMs));
    return v.validateOne(order).first;
}

QString legText(const OJson& leg) {
    return js::str(js::prop(&leg, u"action"_s)) + u' ' + util::pyG(js::num(js::prop(&leg, u"strike"_s))) + js::str(js::prop(&leg, u"right"_s)) + u" x"_s +
           util::pyG(js::num(js::prop(&leg, u"ratio"_s)));
}

OJson optionRow(double strike, const QString& right, double qty, double avgCost) {
    const OJson contract = js::object({{u"secType"_s, js::S(u"OPT"_s)},
                                       {u"symbol"_s, js::S(u"SPX"_s)},
                                       {u"lastTradeDateOrContractMonth"_s, js::S(u"20261028"_s)},
                                       {u"strike"_s, js::N(strike)},
                                       {u"right"_s, js::S(right)},
                                       {u"multiplier"_s, js::S(u"100"_s)},
                                       {u"tradingClass"_s, js::S(u"SPXW"_s)}});
    return js::object({{u"key"_s, js::S(domain::makeKey(u"模拟"_s, u"SPX"_s, u"OPT"_s, domain::legOf(&contract)))},
                       {u"account"_s, js::S(u"模拟"_s)},
                       {u"symbol"_s, js::S(u"SPX"_s)},
                       {u"sec_type"_s, js::S(u"OPT"_s)},
                       {u"quantity"_s, js::N(qty)},
                       {u"avg_cost"_s, js::N(avgCost)},
                       {u"market_price"_s, js::Null()},
                       {u"market_value"_s, js::Null()},
                       {u"unrealized_pnl"_s, js::Null()},
                       {u"contract"_s, contract}});
}
}  // namespace

class TestIronFly : public QObject {
    Q_OBJECT
private slots:
    // ---- 本地速记
    void parsesPlannerSentence() {
        const OJson parsed = parse(u"SPX 7650铁蝶 25cm 2张 -19.5"_s);
        QVERIFY2(parsed.type == OJson::Object, "速记没接住");
        QCOMPARE(parsed.get(u"rejections"_s)->items.size(), qsizetype(0));
        const OJson& o = parsed.get(u"orders"_s)->items.at(0);
        const OJson* c = o.get(u"contract"_s);
        QCOMPARE(js::str(c->get(u"combo_strategy"_s)), u"IRON_CONDOR"_s);
        QCOMPARE(js::str(c->get(u"secType"_s)), u"BAG"_s);
        QStringList legs;
        for (const OJson& l : c->get(u"legs"_s)->items) legs << legText(l);
        QCOMPARE(legs, (QStringList{u"BUY 7625P x1"_s, u"SELL 7650P x1"_s, u"SELL 7650C x1"_s, u"BUY 7675C x1"_s}));
        for (const OJson& l : c->get(u"legs"_s)->items) {
            QCOMPARE(js::str(l.get(u"lastTradeDateOrContractMonth"_s)), u"20261028"_s);
            QCOMPARE(js::str(l.get(u"tradingClass"_s)), u"SPXW"_s);
        }
        const OJson* order = o.get(u"order"_s);
        QCOMPARE(js::str(order->get(u"action"_s)), u"SELL"_s);
        QCOMPARE(js::str(order->get(u"orderType"_s)), u"LMT"_s);
        QCOMPARE(js::str(order->get(u"price_mode"_s)), u"EXPLICIT"_s);
        QCOMPARE(js::num(order->get(u"lmtPrice"_s)), 19.5);
        QCOMPARE(js::num(order->get(u"totalQuantity"_s)), 2.0);
        QVERIFY(js::str(o.get(u"intent_summary"_s)).contains(u"7625/7650/7675 铁蝶"));
        QVERIFY(js::str(o.get(u"intent_summary"_s)).contains(u"不低于 19.5"));
        bool grammar = false;
        for (const OJson& w : o.get(u"warnings"_s)->items) grammar = grammar || w.s.contains(sh::kGrammarVersion);
        QVERIFY(grammar);
    }
    void parsesWithoutPriceAsAutoMid() {
        const OJson parsed = parse(u"50铁蝶 25cm"_s);
        QVERIFY2(parsed.type == OJson::Object, "速记没接住");
        const OJson& o = parsed.get(u"orders"_s)->items.at(0);
        const OJson* order = o.get(u"order"_s);
        QCOMPARE(js::str(order->get(u"price_mode"_s)), u"AUTO_MID"_s);
        QVERIFY(order->get(u"lmtPrice"_s)->type == OJson::Null);
        QCOMPARE(js::num(order->get(u"totalQuantity"_s)), 1.0);
        const OJson& mid = o.get(u"contract"_s)->get(u"legs"_s)->items.at(1);
        QCOMPARE(js::num(mid.get(u"strike"_s)), 7650.0);  // 现价 7640 的百位 + 50
    }
    void bareNumberIsCreditWithWarning() {
        const OJson parsed = parse(u"7650铁蝶 25cm 18"_s);
        QVERIFY2(parsed.type == OJson::Object, "速记没接住");
        const OJson& o = parsed.get(u"orders"_s)->items.at(0);
        QCOMPARE(js::num(o.get(u"order"_s)->get(u"lmtPrice"_s)), 18.0);
        bool warned = false;
        for (const OJson& w : o.get(u"warnings"_s)->items) warned = warned || w.s.contains(u"按收到的净权利金");
        QVERIFY(warned);
    }
    void creditAtOrAboveWingGoesToLlm() {
        QVERIFY(parse(u"7650铁蝶 25cm -25"_s).type == OJson::Null);
        QVERIFY(parse(u"7650铁蝶 25cm -30"_s).type == OJson::Null);
    }
    void sideWordsOrBuyGoToLlm() {
        // 铁蝶没有看涨 / 看跌;本系统也只卖不买
        QVERIFY(parse(u"7650铁蝶 25cm 看涨 -19.5"_s).type == OJson::Null);
        QVERIFY(parse(u"买 7650铁蝶 25cm -19.5"_s).type == OJson::Null);
        QVERIFY(parse(u"7650铁蝶 25cm put -19.5"_s).type == OJson::Null);
    }
    void butterflyGrammarUnchanged() {
        const OJson parsed = parse(u"SPX 7650蝴蝶 25cm 看涨 2张 5.5"_s);
        QVERIFY2(parsed.type == OJson::Object, "蝴蝶速记没接住");
        const OJson& o = parsed.get(u"orders"_s)->items.at(0);
        QCOMPARE(js::str(o.get(u"contract"_s)->get(u"combo_strategy"_s)), u"BUTTERFLY"_s);
        QCOMPARE(js::str(o.get(u"order"_s)->get(u"action"_s)), u"BUY"_s);
        QCOMPARE(o.get(u"contract"_s)->get(u"legs"_s)->items.size(), qsizetype(3));
    }
    void looksLikeShorthand() {
        QVERIFY(sh::looksLikeShorthand(u"7650铁蝶 25cm -19.5"_s));
        QCOMPARE(sh::shorthandSymbols(u"7650铁蝶 25cm -19.5"_s), QStringList{u"SPX"_s});
    }

    // ---- 校验
    void validatorAcceptsIronFly() {
        const QList<val::Issue> issues = validate(firstOrder(parse(u"SPX 7650铁蝶 25cm 2张 -19.5"_s)));
        QStringList msgs;
        for (const val::Issue& i : issues) msgs << i.code + u": "_s + i.message;
        QVERIFY2(issues.isEmpty(), qPrintable(msgs.join(u"\n"_s)));
    }
    void validatorAcceptsAutoMidIronFly() {
        QVERIFY(validate(firstOrder(parse(u"7650铁蝶 25cm"_s))).isEmpty());
    }
    void validatorRejectsBuyingIronFly() {
        OJson o = firstOrder(parse(u"SPX 7650铁蝶 25cm -19.5"_s));
        js::propMut(&o, u"order"_s)->set(u"action"_s, js::S(u"BUY"_s));
        const QList<val::Issue> issues = validate(o);
        QVERIFY(!issues.isEmpty());
        QVERIFY2(issues.first().message.contains(u"仅支持卖出"), qPrintable(issues.first().message));
    }
    void validatorRejectsUnequalWings() {
        OJson o = firstOrder(parse(u"SPX 7650铁蝶 25cm -19.5"_s));
        js::propMut(js::propMut(&o, u"contract"_s), u"legs"_s)->items[3].set(u"strike"_s, js::N(7680));
        bool found = false;
        for (const val::Issue& i : validate(o)) found = found || i.message.contains(u"两翼必须等距");
        QVERIFY(found);
    }
    void validatorRejectsCreditAtWing() {
        OJson o = firstOrder(parse(u"SPX 7650铁蝶 25cm -19.5"_s));
        js::propMut(&o, u"order"_s)->set(u"lmtPrice"_s, js::N(25));
        bool found = false;
        for (const val::Issue& i : validate(o)) found = found || i.message.contains(u"不低于翼宽");
        QVERIFY(found);
    }
    void validatorRejectsWrongInnerSides() {
        // 内侧买、外侧卖(反向铁蝶):腿方向不对
        OJson o = firstOrder(parse(u"SPX 7650铁蝶 25cm -19.5"_s));
        OJson* legs = js::propMut(js::propMut(&o, u"contract"_s), u"legs"_s);
        legs->items[0].set(u"action"_s, js::S(u"SELL"_s));
        legs->items[1].set(u"action"_s, js::S(u"BUY"_s));
        bool found = false;
        for (const val::Issue& i : validate(o)) found = found || i.message.contains(u"Put 侧腿方向不对");
        QVERIFY(found);
    }
    void ironCondorStillAccepted() {
        OJson o = firstOrder(parse(u"SPX 7650铁蝶 25cm -10"_s));
        OJson* legs = js::propMut(js::propMut(&o, u"contract"_s), u"legs"_s);
        legs->items[1].set(u"strike"_s, js::N(7640));  // put 侧 7625/7640,call 侧 7650/7675
        legs->items[0].set(u"strike"_s, js::N(7615));
        QVERIFY(validate(o).isEmpty());
    }
    void riskWidthAndNotional() {
        const OJson o = firstOrder(parse(u"SPX 7650铁蝶 25cm 2张 -19.5"_s));
        QCOMPARE(val::riskWidth(*o.get(u"contract"_s)), 25.0);
        QCOMPARE(execution::strikeWidth(*o.get(u"contract"_s)).value_or(0), 25.0);
        // 贷方最大亏损 = (翼宽 − 权利金) × 100 × 张数 = 5.5 × 100 × 2:和同成本的买入蝶一样
        const domain::Settings s = settings();
        val::Validator v(s, domain::etNowFromEpoch(kNowMs));
        OJson copy = o;
        const auto [issues, approved] = v.validateOne(copy);
        QVERIFY(issues.isEmpty() && approved);
        QCOMPARE(approved->notional, 1100.0);
    }

    // ---- 券商那一层的订单构造(不连 TWS)
    void orderIntentIsBuyWithNegativeNet() {
        const OJson o = firstOrder(parse(u"SPX 7650铁蝶 25cm 2张 -19.5"_s));
        const OJson* spec = o.get(u"order"_s);
        const auto signedLimit = execution::bagSignedLimit(js::str(spec->get(u"action"_s)), js::num(spec->get(u"lmtPrice"_s)));
        QVERIFY(signedLimit);
        QCOMPARE(*signedLimit, -19.5);
        const execution::OrderIntent intent = execution::buildOrderIntent(*spec, u"DU1"_s, signedLimit, QString(u"BUY"_s));
        QCOMPARE(intent.action, u"BUY"_s);  // BAG 一律以 BUY 提交,方向在净价的符号里
        QCOMPARE(intent.orderType, u"LMT"_s);
        QCOMPARE(intent.lmtPrice.value_or(0), -19.5);
        QCOMPARE(intent.totalQuantity, 2.0);
        QCOMPARE(intent.tif, u"DAY"_s);
    }
    void autoMidUsesCreditSide() {
        // 四条腿的净中间价是负的(收权利金),滑点让出一点后仍为负;贷方不用翼宽夹
        const double limit = execution::autoMidLimit(-19.5, u"SELL"_s, 0.1, 25.0);
        QVERIFY(limit < 0);
        QVERIFY(limit >= -19.5 && limit <= -19.3);
        QVERIFY_THROWS_EXCEPTION(execution::BrokerError, execution::autoMidLimit(19.5, u"SELL"_s, 0.1, 25.0));
    }
    void stopLimitIntentBuilds() {
        // 3 腿蝶在真机上接 STP LMT、拒 STP / TRAIL;4 腿铁蝶没测过。这里只保证两种能构造出来,真机 whatIf 待用户核对
        OJson spec = *firstOrder(parse(u"SPX 7650铁蝶 25cm -19.5"_s)).get(u"order"_s);
        spec.set(u"orderType"_s, js::S(u"STP LMT"_s));
        spec.set(u"auxPrice"_s, js::N(-12));
        const execution::OrderIntent intent = execution::buildOrderIntent(spec, u"DU1"_s, -11.5, QString(u"BUY"_s));
        QCOMPARE(intent.orderType, u"STP LMT"_s);
        QCOMPARE(intent.lmtPrice.value_or(0), -11.5);
        QCOMPARE(intent.auxPrice.value_or(0), -12.0);
    }

    // ---- 成交之后:四条腿合成一条空头 iron_butterfly 行,平仓合约按铁鹰口径
    void positionsCombineIntoIronButterfly() {
        // 卖出铁蝶成交:+1 7625P、−1 7650P、−1 7650C、+1 7675C
        const QList<OJson> rows{optionRow(7625, u"P"_s, 1, 150), optionRow(7650, u"P"_s, -1, 1100), optionRow(7650, u"C"_s, -1, 1000), optionRow(7675, u"C"_s, 1, 100)};
        const auto shape = domain::shapeOf(rows);
        QVERIFY(shape);
        QCOMPARE(shape->first, u"iron_butterfly"_s);
        QCOMPARE(shape->second, 1.0);
        const QList<OJson> all = domain::withCombos(rows);
        const OJson* combo = nullptr;
        for (const OJson& r : all)
            if (js::str(r.get(u"sec_type"_s)) == u"BAG") combo = &r;
        QVERIFY(combo);
        QCOMPARE(js::str(combo->get(u"net_side"_s)), u"credit"_s);
        QVERIFY(js::num(combo->get(u"quantity"_s)) < 0);  // 空头组合
        QCOMPARE(js::str(js::path(combo, {u"contract"_s, u"combo_strategy"_s})), u"IRON_CONDOR"_s);
        QCOMPARE(js::path(combo, {u"contract"_s, u"legs"_s})->items.size(), qsizetype(4));
        QVERIFY(js::str(combo->get(u"label"_s)).contains(u"铁蝶"));
        // 追踪 / 快速离场 / 急跌保护 / 分批止盈都按 isLong 定方向:贷方铁蝶是空头,价跌是赚
        QVERIFY(!orchestrate::tracker::isLong(orchestrate::tracker::makePosition(*combo)));
    }
};

QTEST_GUILESS_MAIN(TestIronFly)
#include "tst_iron_fly.moc"
