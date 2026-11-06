// engine/domain/positions(positions.ts + combos.ts + marketdata.ts)对着原模块(tests/fixtures/gen_positions.mjs):
// 行权价写法、腿身份、名字、key;613 组持仓上的 withCombos(组合识别、虚拟行的每个字段与键序)与 groupLegs;K 线周期表。
#include "domain/positions.h"
#include "util/jsobj.h"

#include <QFile>
#include <optional>
#include <QTest>

using namespace ibkr;
using util::OJson;
namespace js = ibkr::util::js;
using namespace Qt::StringLiterals;

class TestPositions : public QObject {
    Q_OBJECT
    OJson fx;
    static const OJson* undefOr(const OJson* v) { return v->type == OJson::String && v->s == u"__undefined__" ? nullptr : v; }

private slots:
    // 一腿有现价、一腿只有标记价(休市边上常见):净标记价两腿都算上,不能因为缺一腿退回前一日的昨收
    void comboMarkUsesQuoteWhereLegHasOne() {
        const auto leg = [](const QString& key, double qty, double cost, std::optional<double> price, std::optional<double> mark, double close) {
            OJson r = js::object({{u"key"_s, js::S(key)}, {u"quantity"_s, js::N(qty)}, {u"avg_cost"_s, js::N(cost)}, {u"multiplier"_s, js::N(100)},
                                  {u"market_price"_s, price ? js::N(*price) : js::Null()}, {u"close_price"_s, js::N(close)}});
            if (mark) r.set(u"mark_price"_s, js::N(*mark));
            return r;
        };
        const OJson combo = js::object({{u"account"_s, js::S(u"main"_s)}, {u"symbol"_s, js::S(u"SPX"_s)}, {u"kind"_s, js::S(u"vertical"_s)}, {u"quantity"_s, js::N(1)},
                                        {u"legs"_s, js::array({js::S(u"a"_s), js::S(u"b"_s)})}});
        const OJson row = domain::comboRow(combo, {leg(u"a"_s, 1, 586.63, std::nullopt, 8.58, 83.6), leg(u"b"_s, -1, 518.37, 7.6, std::nullopt, 79.5)});
        QVERIFY(js::nullish(row.get(u"market_price"_s)));
        QCOMPARE(row.get(u"mark_price"_s)->n, 0.98);
        QCOMPARE(row.get(u"close_price"_s)->n, 4.1);
    }
    void initTestCase() {
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR) + u"/positions.json"_s);
        QVERIFY(f.open(QIODevice::ReadOnly));
        fx = *util::parseOJson(QString::fromUtf8(f.readAll()));
    }

    void identity() {
        const OJson negZero = OJson::number(-0.0);
        for (const OJson& c : fx.get(u"fmt"_s)->items) {
            const OJson* s = c.get(u"s"_s);
            QCOMPARE(domain::fmtStrike(s->type == OJson::String && s->s == u"__neg0__" ? &negZero : undefOr(s)), c.get(u"out"_s)->s);
        }
        for (const OJson& c : fx.get(u"legs"_s)->items) {
            const OJson* ct = undefOr(c.get(u"c"_s));
            QCOMPARE(domain::legOf(ct), c.get(u"legOf"_s)->s);
            const QList<std::pair<QString, QString>> args{{u"SPX"_s, u"OPT"_s}, {u"SPX"_s, u"STK"_s}, {QString(), u"OPT"_s}, {u"  "_s, u"FOP"_s}};
            for (qsizetype i = 0; i < args.size(); ++i) QCOMPARE(domain::positionLabel(args[i].first, args[i].second, ct), c.get(u"labels"_s)->items[i].s);
        }
        const QStringList keys{domain::makeKey(u"a"_s, u"b"_s, u"c"_s, QString()), domain::makeKey(u"a"_s, u"b"_s, u"OPT"_s, u"20261016|7800|C"_s),
                               domain::makeKey(QString(), QString(), QString(), QString())};
        QCOMPARE(js::stringify(js::strings(keys)), js::stringify(*fx.get(u"keys"_s)));
    }

    void combos() {
        int n = 0;
        for (const OJson& c : fx.get(u"combos"_s)->items) {
            const QList<OJson> rows = c.get(u"rows"_s)->items;
            const QString got = js::stringify(js::array(domain::withCombos(rows)));
            const QString want = js::stringify(*c.get(u"out"_s));
            if (got != want) qWarning().noquote() << "持仓:" << js::stringify(*c.get(u"rows"_s)).left(1500) << "\nC++:" << got.right(2500) << "\nTS :" << want.right(2500);
            QCOMPARE(got, want);
            QCOMPARE(js::stringify(js::array(domain::groupLegs(rows))), js::stringify(*c.get(u"groups"_s)));
            ++n;
        }
        QCOMPARE(n, 619);
    }

    // ---- 搜索切分:相邻切切不全时,整个桶能切成认得出的结构才换
    static OJson optLeg(const QString& key, double strike, const QString& right, double qty) {
        return js::object({{u"key"_s, js::S(key)}, {u"account"_s, js::S(u"U1"_s)}, {u"symbol"_s, js::S(u"QQQ"_s)}, {u"sec_type"_s, js::S(u"OPT"_s)},
                           {u"quantity"_s, js::N(qty)}, {u"avg_cost"_s, js::N(100)}, {u"market_price"_s, js::N(1)}, {u"multiplier"_s, js::N(100)},
                           {u"currency"_s, js::S(u"USD"_s)}, {u"market_value"_s, js::N(qty * 100)}, {u"unrealized_pnl"_s, js::N(0)},
                           {u"contract"_s, js::object({{u"secType"_s, js::S(u"OPT"_s)}, {u"symbol"_s, js::S(u"QQQ"_s)},
                                                       {u"lastTradeDateOrContractMonth"_s, js::S(u"20261107"_s)}, {u"strike"_s, js::N(strike)},
                                                       {u"right"_s, js::S(right)}})}});
    }
    /// 每个组合:kind + 腿 key(按 groupLegs 给的顺序)
    static QStringList shapes(const QList<OJson>& rows) {
        QStringList out;
        for (const OJson& c : domain::groupLegs(rows)) {
            QStringList keys;
            for (const OJson& k : c.get(u"legs"_s)->items) keys << k.s;
            out << c.get(u"kind"_s)->s + u':' + keys.join(u',');
        }
        return out;
    }
    static QStringList bagKeys(const QList<OJson>& rows) {
        QStringList out;
        for (const OJson& r : domain::withCombos(rows))
            if (r.get(u"sec_type"_s)->s == u"BAG") out << r.get(u"key"_s)->s;
        return out;
    }

    // 两只交错的看涨蝶(同一到期):660/670/680 与 664/674/684,各 +1/−2/+1。按行权价相邻切,前三条 660/664/670 不是蝶,
    // 整桶会成一个 6 腿自定义组合;搜索把它切回两只蝶
    void interleavedFliesSplitIntoTwo() {
        const QList<OJson> rows{optLeg(u"c660"_s, 660, u"C"_s, 1),  optLeg(u"c664"_s, 664, u"C"_s, 1),  optLeg(u"c670"_s, 670, u"C"_s, -2),
                                optLeg(u"c674"_s, 674, u"C"_s, -2), optLeg(u"c680"_s, 680, u"C"_s, 1),  optLeg(u"c684"_s, 684, u"C"_s, 1)};
        QCOMPARE(shapes(rows), (QStringList{u"butterfly:c660,c670,c680"_s, u"butterfly:c664,c674,c684"_s}));
        const QList<OJson> combos = domain::groupLegs(rows);
        QCOMPARE(combos[0].get(u"label"_s)->s, u"买入看涨蝴蝶 660/670/680"_s);
        QCOMPARE(combos[0].get(u"quantity"_s)->n, 1.0);
        QCOMPARE(combos[1].get(u"label"_s)->s, u"买入看涨蝴蝶 664/674/684"_s);
        QCOMPARE(bagKeys(rows), (QStringList{u"U1|QQQ|BAG|20261107|+1x660C,-2x670C,+1x680C"_s, u"U1|QQQ|BAG|20261107|+1x664C,-2x674C,+1x684C"_s}));
        // 腿的输入顺序不影响结果(groupLegs 先按行权价排)
        const QList<OJson> shuffled{rows[5], rows[2], rows[0], rows[4], rows[3], rows[1]};
        QCOMPARE(shapes(shuffled), shapes(rows));
    }

    // 份数不同的两只交错蝶,和一只蝶夹着一组看跌价差(看涨看跌混在一个桶里):照样切开,每个结构用自己的份数
    void interleavedShapesKeepOwnQuantity() {
        const QList<OJson> flies{optLeg(u"a"_s, 660, u"C"_s, 2),  optLeg(u"b"_s, 664, u"C"_s, 1), optLeg(u"c"_s, 670, u"C"_s, -4),
                                 optLeg(u"d"_s, 674, u"C"_s, -2), optLeg(u"e"_s, 680, u"C"_s, 2), optLeg(u"f"_s, 684, u"C"_s, 1)};
        QCOMPARE(shapes(flies), (QStringList{u"butterfly:a,c,e"_s, u"butterfly:b,d,f"_s}));
        const QList<OJson> combos = domain::groupLegs(flies);
        QCOMPARE(combos[0].get(u"quantity"_s)->n, 2.0);
        QCOMPARE(combos[1].get(u"quantity"_s)->n, 1.0);

        const QList<OJson> mixed{optLeg(u"c660"_s, 660, u"C"_s, 1), optLeg(u"p665"_s, 665, u"P"_s, -1), optLeg(u"c670"_s, 670, u"C"_s, -2),
                                 optLeg(u"p675"_s, 675, u"P"_s, 1), optLeg(u"c680"_s, 680, u"C"_s, 1)};
        QCOMPARE(shapes(mixed), (QStringList{u"butterfly:c660,c670,c680"_s, u"vertical:p665,p675"_s}));
    }

    // 切不全就照旧整桶一个自定义组合(key 不变),哪怕里面切得出一部分结构:
    // 断翼蝶 660/670/685 加一条 700C,660/700 与 685/700 各能凑成价差,但剩下的腿凑不成;交错两蝶再多一条单腿也一样
    void noFullPartitionStaysOneCustom() {
        const QList<OJson> broken{optLeg(u"a"_s, 660, u"C"_s, 1), optLeg(u"b"_s, 670, u"C"_s, -2), optLeg(u"c"_s, 685, u"C"_s, 1),
                                  optLeg(u"d"_s, 700, u"C"_s, -1)};
        QCOMPARE(shapes(broken), (QStringList{u"custom:a,b,c,d"_s}));
        QCOMPARE(bagKeys(broken), (QStringList{u"U1|QQQ|BAG|20261107|+1x660C,-2x670C,+1x685C,-1x700C"_s}));

        const QList<OJson> withNaked{optLeg(u"c660"_s, 660, u"C"_s, 1),  optLeg(u"c664"_s, 664, u"C"_s, 1), optLeg(u"c670"_s, 670, u"C"_s, -2),
                                     optLeg(u"c674"_s, 674, u"C"_s, -2), optLeg(u"c680"_s, 680, u"C"_s, 1), optLeg(u"c684"_s, 684, u"C"_s, 1),
                                     optLeg(u"p650"_s, 650, u"P"_s, -1)};
        QCOMPARE(shapes(withNaked), (QStringList{u"custom:p650,c660,c664,c670,c674,c680,c684"_s}));
    }

    // 相邻切已经切全的,搜索不插手:两只并排的蝶照旧
    void adjacentSplitUnchanged() {
        const QList<OJson> rows{optLeg(u"a"_s, 660, u"C"_s, 1), optLeg(u"b"_s, 670, u"C"_s, -2), optLeg(u"c"_s, 680, u"C"_s, 1),
                                optLeg(u"d"_s, 690, u"C"_s, 1), optLeg(u"e"_s, 700, u"C"_s, -2), optLeg(u"f"_s, 710, u"C"_s, 1)};
        QCOMPARE(shapes(rows), (QStringList{u"butterfly:a,b,c"_s, u"butterfly:d,e,f"_s}));
    }

    void marketdata() {
        QCOMPARE(js::stringify(domain::timeframes()), js::stringify(*fx.get(u"timeframes"_s)));
        QCOMPARE(double(domain::kMinBars), fx.get(u"minBars"_s)->n);
        QCOMPARE(domain::kDelayedFeedMaxMs, fx.get(u"delayedMax"_s)->n);
    }
};

QTEST_GUILESS_MAIN(TestPositions)
#include "tst_positions.moc"
