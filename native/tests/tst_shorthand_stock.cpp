// 速记语法 v10,全部离线:手动下单页的正股限价单(「213买入be20股」)不经大模型。
// 一个买 / 卖、一个代码、「N股」、一个价,整句被覆盖才接;多一样、少一样、带条件或期权词都交回大模型。跟单路径不接。
// 产出过一遍校验器,确认能放行。
#include "domain/config.h"
#include "parsing/shorthand.h"
#include "parsing/validator.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"

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
    const OJson snap = js::object({{u"SPX"_s, js::N(7845)}, {u"BE"_s, js::N(210)}});
    return sh::tryParseShorthand(text, snap, domain::etNowFromEpoch(kNowMs), nullptr, manual);
}
const OJson& order0(const OJson& p) { return p.get(u"orders"_s)->items.at(0); }
QString ord(const OJson& p, const QString& k) { return js::stringify(*order0(p).get(u"order"_s)->get(k)); }
QString con(const OJson& p, const QString& k) { return js::str(order0(p).get(u"contract"_s)->get(k)); }
QString line(const OJson& p) {
    return ord(p, u"action"_s) + u' ' + ord(p, u"totalQuantity"_s) + u' ' + con(p, u"symbol"_s) + u" @" + ord(p, u"lmtPrice"_s);
}
}  // namespace

class TestShorthandStock : public QObject {
    Q_OBJECT
private slots:
    void accepted_data() {
        QTest::addColumn<QString>("text");
        QTest::addColumn<QString>("want");
        QTest::newRow("价在前") << u"213买入be20股"_s << u"\"BUY\" 20 BE @213"_s;
        QTest::newRow("价在后") << u"买入BE 20股 213"_s << u"\"BUY\" 20 BE @213"_s;
        QTest::newRow("限价") << u"卖出 BE 20 股 限价215.5"_s << u"\"SELL\" 20 BE @215.5"_s;
        QTest::newRow("@") << u"买20股BE @213"_s << u"\"BUY\" 20 BE @213"_s;
        QTest::newRow("以…块") << u"以213块买入20股be"_s << u"\"BUY\" 20 BE @213"_s;
        QTest::newRow("刀") << u"BE 卖 100股 220刀"_s << u"\"SELL\" 100 BE @220"_s;
        QTest::newRow("全角") << u"２１３买入ＢＥ２０股"_s << u"\"BUY\" 20 BE @213"_s;
        QTest::newRow("一个字母") << u"买入 F 100股 12.5"_s << u"\"BUY\" 100 F @12.5"_s;
        QTest::newRow("理由") << u"213买入be20股 理由:回踩支撑"_s << u"\"BUY\" 20 BE @213"_s;
    }
    void accepted() {
        QFETCH(QString, text);
        QFETCH(QString, want);
        const OJson p = parse(text);
        QVERIFY2(p.type == OJson::Object, "速记没接住");
        QCOMPARE(line(p), want);
        QCOMPARE(con(p, u"secType"_s), u"STK"_s);
        QCOMPARE(ord(p, u"orderType"_s), u"\"LMT\""_s);
        QCOMPARE(ord(p, u"price_mode"_s), u"\"EXPLICIT\""_s);
        QCOMPARE(ord(p, u"tif"_s), u"\"DAY\""_s);
        QVERIFY(js::stringify(*order0(p).get(u"warnings"_s)).contains(u"shorthand-v11"_s));
        OJson o = order0(p);
        o.set(u"account"_s, js::S(u"模拟"_s));
        const domain::Settings s = settings();
        val::Validator v(s, domain::etNowFromEpoch(kNowMs));
        const QList<val::Issue> issues = v.validateOne(o).first;
        for (const val::Issue& i : issues) qWarning("%s: %s", qPrintable(i.code), qPrintable(i.message));
        QVERIFY(issues.isEmpty());
    }
    void details() {
        const OJson p = parse(u"213买入be20股 理由:回踩支撑"_s);
        QCOMPARE(js::str(order0(p).get(u"reason"_s)), u"回踩支撑"_s);
        QCOMPARE(js::str(order0(p).get(u"intent_summary"_s)), u"限价 213 美元买入 20 股 BE"_s);
        QVERIFY(js::stringify(*order0(p).get(u"warnings"_s)).contains(u"小写 'be' 已按大写 ticker BE 理解"_s));
        const OJson g = parse(u"BE 买 20股 213 GTC 盘前"_s);
        QCOMPARE(ord(g, u"tif"_s), u"\"GTC\""_s);
        QCOMPARE(ord(g, u"outsideRth"_s), u"true"_s);
    }
    void leftToTheModel_data() {
        QTest::addColumn<QString>("text");
        QTest::newRow("没写价") << u"买入BE 20股"_s;
        QTest::newRow("市价") << u"市价买入BE 20股"_s;
        QTest::newRow("没写股") << u"213买入be 20"_s;
        QTest::newRow("两个价") << u"买入BE 20股 213 215"_s;
        QTest::newRow("两个代码") << u"买入BE NVDA 20股 213"_s;
        QTest::newRow("买又卖") << u"买入BE 20股 213 卖出"_s;
        QTest::newRow("没写买卖") << u"BE 20股 213"_s;
        QTest::newRow("条件") << u"BE跌到200时买入20股 200"_s;
        QTest::newRow("止损") << u"213买入be20股 止损200"_s;
        QTest::newRow("期权") << u"买入 BE 213 call 20股"_s;
        QTest::newRow("中文数量") << u"213买入be二十股"_s;
        QTest::newRow("指数") << u"买入 SPX 1股 7800"_s;
        QTest::newRow("做空") << u"做空 BE 20股 213"_s;
        QTest::newRow("多余的字") << u"帮我213买入be20股"_s;
        QTest::newRow("零股价") << u"买入BE 20股 0"_s;
    }
    void leftToTheModel() {
        QFETCH(QString, text);
        QCOMPARE(parse(text).type, OJson::Null);
    }
    void followPathUnchanged() { QCOMPARE(parse(u"213买入be20股"_s, false).type, OJson::Null); }
    void optionGrammarsStillWin() {
        // 蝴蝶 / 价差照旧走原来的语法
        const OJson fly = parse(u"7850蝴蝶 20cm 2.5"_s);
        QVERIFY(fly.type == OJson::Object);
        QCOMPARE(con(fly, u"secType"_s), u"BAG"_s);
    }
};

QTEST_GUILESS_MAIN(TestShorthandStock)
#include "tst_shorthand_stock.moc"
