// 速记语法 v9,全部离线:手动下单页的「put / call spread」(价格带负号 = 贷方,否则 = 借方)与写明的到期日
// (「这周五」「下周一」「11月6日」)。跟单路径(manual = false)对只写 put / call spread 的句子照旧不接。
// 产出过一遍校验器,确认借方垂直价差的腿方向与价格口径能放行。
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
}  // namespace

class TestShorthandV9 : public QObject {
    Q_OBJECT
private slots:
    void putSpreadWithoutMinusIsDebit() {
        const OJson p = parse(u"spy这周五的745 740 put spread"_s);
        QVERIFY2(p.type == OJson::Object && rejectionText(p).isEmpty(), "速记没接住");
        QCOMPARE(legsOf(p), (QStringList{u"BUY 745P"_s, u"SELL 740P"_s}));
        QCOMPARE(field(p, u"action"_s), u"BUY"_s);
        QCOMPARE(field(p, u"price_mode"_s), u"AUTO_MID"_s);
        QCOMPARE(expiryOf(p), u"20261106"_s);
        QCOMPARE(js::str(order0(p).get(u"contract"_s)->get(u"symbol"_s)), u"SPY"_s);
        QVERIFY(!order0(p).get(u"contract"_s)->get(u"legs"_s)->items.at(0).get(u"tradingClass"_s));
        QVERIFY(js::str(order0(p).get(u"intent_summary"_s)).contains(u"借方"));
        QVERIFY2(!hasError(validate(p)), "借方 put spread 校验没过");
    }
    void debitWithPositivePrice() {
        const OJson p = parse(u"spy 周五 745 740 put spread 1.5"_s);
        QCOMPARE(legsOf(p), (QStringList{u"BUY 745P"_s, u"SELL 740P"_s}));
        QCOMPARE(field(p, u"price_mode"_s), u"EXPLICIT"_s);
        QCOMPARE(js::num(order0(p).get(u"order"_s)->get(u"lmtPrice"_s)), 1.5);
        QVERIFY(!hasError(validate(p)));
        QCOMPARE(parse(u"spy 周五 745 740 put spread 6"_s).type, OJson::Null);  // 付的不能 ≥ 宽度
    }
    void callSpreadDebitBuysLow() {
        const OJson p = parse(u"7840 7850 call spread"_s);
        QCOMPARE(legsOf(p), (QStringList{u"BUY 7840C"_s, u"SELL 7850C"_s}));
        QCOMPARE(field(p, u"action"_s), u"BUY"_s);
        QCOMPARE(expiryOf(p), u"20261104"_s);
        QCOMPARE(js::str(order0(p).get(u"contract"_s)->get(u"legs"_s)->items.at(0).get(u"tradingClass"_s)), u"SPXW"_s);
        QVERIFY(!hasError(validate(p)));
    }
    void minusPriceIsCredit() {
        const OJson p = parse(u"spy 周五 745 740 put spread -1.2"_s);
        QCOMPARE(legsOf(p), (QStringList{u"BUY 740P"_s, u"SELL 745P"_s}));
        QCOMPARE(field(p, u"action"_s), u"SELL"_s);
        QCOMPARE(js::num(order0(p).get(u"order"_s)->get(u"lmtPrice"_s)), 1.2);
        QVERIFY(!hasError(validate(p)));
    }
    void sellWordStillGoesToModel() { QCOMPARE(parse(u"卖 spy 周五 745 740 put spread"_s).type, OJson::Null); }
    void followPathUnchanged() {
        QCOMPARE(parse(u"spy这周五的745 740 put spread"_s, false).type, OJson::Null);
        QVERIFY(!sh::looksLikeShorthand(u"745 740 put spread"_s));
        QVERIFY(sh::looksLikeShorthand(u"745 740 put spread"_s, true));
        QCOMPARE(sh::shorthandSymbols(u"put spread 745 740 spy"_s, true), QStringList{u"SPY"_s});
    }

    // ---- 写明的到期日(三种语法共用)
    void weekdaysAndDates() {
        QCOMPARE(expiryOf(parse(u"7840 7845 bear call 本周五"_s)), u"20261106"_s);
        QCOMPARE(expiryOf(parse(u"7840 7845 bear call 下周一"_s)), u"20261109"_s);
        QCOMPARE(expiryOf(parse(u"7840 7845 bear call 周三"_s)), u"20261104"_s);
        QCOMPARE(expiryOf(parse(u"11月6日 7840 7845 bear call"_s)), u"20261106"_s);
        QCOMPARE(expiryOf(parse(u"7850蝴蝶 20cm 周五到期 2.5"_s)), u"20261106"_s);
        QCOMPARE(expiryOf(parse(u"7850铁蝶 25cm 下周五 -19.5"_s)), u"20261113"_s);
        // 跟单路径也认写明的日期(那不是猜)
        QCOMPARE(expiryOf(parse(u"7840 7845 bear call 周五 -1.1"_s, false)), u"20261106"_s);
    }
    void pastOrWeekendDatesAreRejected() {
        QVERIFY(rejectionText(parse(u"7840 7845 bear call 周一"_s)).contains(u"已经过了"));
        QVERIFY(rejectionText(parse(u"11月3日 7840 7845 bear call"_s)).contains(u"已经过了"));
        QVERIFY(rejectionText(parse(u"11月7日 7840 7845 bear call"_s)).contains(u"不是交易日"));
        QVERIFY(rejectionText(parse(u"2月30日 7840 7845 bear call"_s)).contains(u"不是一个有效日期"));
    }
    void twoExpiriesGoToModel() { QCOMPARE(parse(u"明天 周五 7840 7845 bear call"_s).type, OJson::Null); }
};

QTEST_GUILESS_MAIN(TestShorthandV9)
#include "tst_shorthand_v9.moc"
