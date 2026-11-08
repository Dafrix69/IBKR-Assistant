// 速记语法 v11,全部离线:手动下单页价差里的价格口语(「8毛」「8毛5」「1块2」)、句中「对冲(下)…」的说明摘进 reason、
// 没写标的而默认的 SPX 离行权价太远时在本地拒绝。样本是 11 月 4 日落到大模型的真句子。
#include "domain/config.h"
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
// 2026-11-04(周三)美东 10:00:常规时段
const double kNowMs = QDateTime::fromString(u"2026-11-04T15:00:00Z"_s, Qt::ISODate).toMSecsSinceEpoch();

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

OJson parse(const QString& text, bool manual = true) {
    const OJson snap = js::object({{u"SPX"_s, js::N(7845)}, {u"SPY"_s, js::N(742)}});
    return sh::tryParseShorthand(text, snap, domain::etNowFromEpoch(kNowMs), nullptr, manual);
}

const OJson& order0(const OJson& parsed) { return parsed.get(u"orders"_s)->items.at(0); }

QString legText(const OJson& leg) {
    return js::str(js::prop(&leg, u"action"_s)) + u' ' + util::pyG(js::num(js::prop(&leg, u"strike"_s))) + js::str(js::prop(&leg, u"right"_s));
}
QStringList legsOf(const OJson& parsed) {
    QStringList out;
    for (const OJson& l : order0(parsed).get(u"contract"_s)->get(u"legs"_s)->items) out << legText(l);
    return out;
}
QString expiryOf(const OJson& parsed) {
    return js::str(order0(parsed).get(u"contract"_s)->get(u"legs"_s)->items.at(0).get(u"lastTradeDateOrContractMonth"_s));
}
QString field(const OJson& parsed, const QString& key) { return js::str(order0(parsed).get(u"order"_s)->get(key)); }

QList<val::Issue> validate(const OJson& parsed) {
    OJson o = order0(parsed);
    o.set(u"account"_s, js::S(u"模拟"_s));
    const domain::Settings s = settings();
    val::Validator v(s, domain::etNowFromEpoch(kNowMs));
    return v.validateOne(o).first;
}
bool hasError(const QList<val::Issue>& issues) {
    for (const val::Issue& i : issues) qWarning("%s: %s", qPrintable(i.code), qPrintable(i.message));
    return !issues.isEmpty();
}
QString rejectionText(const OJson& parsed) {
    if (parsed.type != OJson::Object || parsed.get(u"rejections"_s)->items.isEmpty()) return {};
    return js::str(parsed.get(u"rejections"_s)->items.at(0).get(u"message"_s));
}

double lmt(const OJson& parsed) { return js::num(order0(parsed).get(u"order"_s)->get(u"lmtPrice"_s)); }
QString reasonOf(const OJson& parsed) { return js::str(order0(parsed).get(u"reason"_s)); }
bool isOrder(const OJson& parsed) { return parsed.type == OJson::Object && rejectionText(parsed).isEmpty(); }
}  // namespace

class TestShorthandV11 : public QObject {
    Q_OBJECT
private slots:
    // ---- 11 月 4 日的真句子
    void realSampleWithSymbol() {
        const OJson p = parse(u"这周五spy的745 740 put spread对冲下选举 8毛"_s);
        QVERIFY2(isOrder(p), "速记没接住");
        QCOMPARE(js::str(order0(p).get(u"contract"_s)->get(u"symbol"_s)), u"SPY"_s);
        QCOMPARE(legsOf(p), (QStringList{u"BUY 745P"_s, u"SELL 740P"_s}));
        QCOMPARE(field(p, u"action"_s), u"BUY"_s);
        QCOMPARE(field(p, u"price_mode"_s), u"EXPLICIT"_s);
        QCOMPARE(lmt(p), 0.8);
        QCOMPARE(expiryOf(p), u"20261106"_s);
        QCOMPARE(reasonOf(p), u"对冲下选举"_s);
        QVERIFY(js::stringify(*order0(p).get(u"warnings"_s)).contains(u"shorthand-v11"_s));
        QVERIFY2(!hasError(validate(p)), "校验没过");
    }
    void realSampleWithoutSymbolIsRejectedLocally() {
        const QString msg = rejectionText(parse(u"这周五的745 740 put spread对冲下选举 8毛"_s));
        QVERIFY2(msg.contains(u"请写明标的"_s), qPrintable(msg));
        QVERIFY(msg.contains(u"745/740"_s));
        QVERIFY(msg.contains(u"SPX"_s));
        // 写了标的、离现价还是太远:不猜,照旧交给大模型
        QCOMPARE(parse(u"spx 745 740 put spread 8毛"_s).type, OJson::Null);
    }

    // ---- 价格口语
    void slangPrices() {
        QCOMPARE(lmt(parse(u"spy 周五 745 740 put spread 8毛5"_s)), 0.85);
        QCOMPARE(lmt(parse(u"spy 周五 745 740 put spread 1块2"_s)), 1.2);
        QCOMPARE(lmt(parse(u"spy 周五 745 740 put spread 1块"_s)), 1.0);
        QCOMPARE(lmt(parse(u"spy 周五 745 740 put spread 2块钱"_s)), 2.0);
        QCOMPARE(lmt(parse(u"spy 周五 745 740 put spread 1块25"_s)), 1.25);
        QCOMPARE(lmt(parse(u"7840 7850 call spread 3毛"_s)), 0.3);
    }
    void slangDoesNotEatQuantity() {
        const OJson a = parse(u"spy 周五 745 740 put spread 8毛5张"_s);
        QCOMPARE(lmt(a), 0.8);
        QCOMPARE(js::num(order0(a).get(u"order"_s)->get(u"totalQuantity"_s)), 5.0);
        const OJson b = parse(u"spy 周五 745 740 put spread 8毛 2张"_s);
        QCOMPARE(lmt(b), 0.8);
        QCOMPARE(js::num(order0(b).get(u"order"_s)->get(u"totalQuantity"_s)), 2.0);
        const OJson c = parse(u"spy 周五 745 740 put spread 1块2 3张"_s);
        QCOMPARE(lmt(c), 1.2);
        QCOMPARE(js::num(order0(c).get(u"order"_s)->get(u"totalQuantity"_s)), 3.0);
        QCOMPARE(lmt(parse(u"spy 周五 745 740 put spread 1块 2张"_s)), 1.0);
    }
    void minusSlangIsCredit() {
        const OJson p = parse(u"spy 周五 745 740 put spread -8毛"_s);
        QCOMPARE(field(p, u"action"_s), u"SELL"_s);
        QCOMPARE(legsOf(p), (QStringList{u"BUY 740P"_s, u"SELL 745P"_s}));
        QCOMPARE(lmt(p), 0.8);
        const OJson b = parse(u"7840 7845 bear call -1块2"_s);
        QCOMPARE(lmt(b), 1.2);
        QVERIFY(!hasError(validate(b)));
    }
    void slangLimits() {
        QCOMPARE(parse(u"spy 周五 745 740 put spread 八毛"_s).type, OJson::Null);   // 中文数字不认
        QCOMPARE(parse(u"spy 周五 745 740 put spread 6块"_s).type, OJson::Null);    // 付的不能 ≥ 宽度
        QCOMPARE(parse(u"spy 周五 745 740 put spread 8毛 1.2"_s).type, OJson::Null); // 两个价
        QCOMPARE(parse(u"7650蝴蝶 30cm 3块4"_s).type, OJson::Null);                 // 只在价差里认
        // 日期照旧先摘:「11月6日」不会被当成价格
        QCOMPARE(expiryOf(parse(u"11月6日 spy 745 740 put spread 8毛"_s)), u"20261106"_s);
    }

    // ---- 对冲说明
    void hedgeReasonVariants() {
        QCOMPARE(reasonOf(parse(u"spy 周五 745 740 put spread 对冲一下选举 8毛"_s)), u"对冲一下选举"_s);
        QCOMPARE(reasonOf(parse(u"对冲 spy 周五 745 740 put spread"_s)), u"对冲"_s);
        QCOMPARE(reasonOf(parse(u"spy 周五 745 740 put spread 对冲下选举 8毛 理由:怕大跌"_s)), u"对冲下选举;怕大跌"_s);
        // 蝴蝶也认(说明不影响下单)
        QCOMPARE(parse(u"7850蝴蝶 20cm 对冲下CPI前 2.5"_s).type, OJson::Null);  // 遇到字母就停,剩下「CPI前」让整句交给大模型
        QCOMPARE(reasonOf(parse(u"7850蝴蝶 20cm 对冲下非农 2.5"_s)), u"对冲下非农"_s);
    }
    void hedgeRunWithTradeWordsIsNotStripped() {
        QCOMPARE(parse(u"spy 745 740 put spread 对冲下周五 8毛"_s).type, OJson::Null);
        QCOMPARE(parse(u"spy 周五 745 740 put spread 对冲卖出 8毛"_s).type, OJson::Null);
        QCOMPARE(parse(u"spy 周五 745 740 put spread 对冲止损 8毛"_s).type, OJson::Null);
        QCOMPARE(parse(u"spy 周五 745 740 put spread 对冲两张 8毛"_s).type, OJson::Null);
        // 条件词在说明里也不摘:不然「突破」被当成说明,整句就成了立即单
        QCOMPARE(parse(u"spy 周五 745 740 put spread 对冲下突破 8毛"_s).type, OJson::Null);
        QCOMPARE(parse(u"spy 周五 745 740 put spread 对冲如果跌破 8毛"_s).type, OJson::Null);
        QCOMPARE(parse(u"spy 周五 745 740 put spread 对冲下站稳 8毛"_s).type, OJson::Null);
    }
    void followPathDoesNotStripHedge() {
        QCOMPARE(parse(u"7840 7845 bear call 对冲下选举 -1.1"_s, false).type, OJson::Null);
        QCOMPARE(reasonOf(parse(u"7840 7845 bear call 对冲下选举 -1.1"_s)), u"对冲下选举"_s);
    }
};

QTEST_GUILESS_MAIN(TestShorthandV11)
#include "tst_shorthand_v11.moc"
