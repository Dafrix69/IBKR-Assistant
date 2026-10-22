// 「回测」(shell/backtest_rules)对着原版现算的期望值(tests/fixtures/gen_backtest.mjs,本机时区 Asia/Shanghai):
//   · 22 个页面场景:整页的字、流程图的卡片、按钮(读着 / 点不动)、卡片的状态色、着色的数、数字瓦片的着色、输入框里的字(数字框按步长的小数位)、分页;
//   · 净值曲线(原文 useMemo 切出来跑):JSON 那一份逐字段比;
//   · 拼载荷:跑一次与扫参数的入参(参数只带有数的、自定义带条件、成本 0 不带、网格解析)。
// 读期望值用保序的 JSON(参数的次序同 Object.keys:RSI 是 period、buy_below、sell_above,QJsonObject 会排成字母序)。
#include "shell/backtest_rules.h"
#include "shell/ordered_json.h"

#include <QFile>
#include <QJsonDocument>
#include <QRegularExpression>
#include <QTest>

using namespace ibkr;
using namespace ibkr::shell;
using namespace Qt::StringLiterals;

namespace {

QJsonObject fixture() {
    static const QJsonObject j = [] {
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/backtest.json"));
        if (!f.open(QIODevice::ReadOnly)) qFatal("backtest.json 打不开");
        const auto o = parseOJson(QString::fromUtf8(f.readAll()));
        if (!o) qFatal("backtest.json 读不出");
        return o->toQJsonKeyed().toObject();
    }();
    return j;
}

/// 去掉读进来时加的 "__keys"(和原版那一份逐字段比时用)
QJsonValue plain(const QJsonValue& v) {
    if (v.isArray()) {
        QJsonArray a;
        for (const QJsonValue& x : v.toArray()) a.append(plain(x));
        return a;
    }
    if (!v.isObject()) return v;
    QJsonObject o;
    const QJsonObject in = v.toObject();
    for (auto it = in.begin(); it != in.end(); ++it)
        if (it.key() != u"__keys") o.insert(it.key(), plain(it.value()));
    return o;
}

QStringList normalize(const QStringList& in) {
    QStringList out;
    static const QRegularExpression ws(u"\\s+"_s);
    for (const QString& s : in) {
        const QString t = QString(s).replace(ws, u" "_s).trimmed();
        if (!t.isEmpty()) out << t;
    }
    return out;
}

void compareTexts(const QStringList& got, const QStringList& expected) {
    for (qsizetype i = 0; i < std::max(got.size(), expected.size()); ++i) {
        if (got.value(i) != expected.value(i))
            QFAIL(qPrintable(u"第 %1 段:期望「%2」,实际「%3」\n前后:%4"_s.arg(i).arg(expected.value(i), got.value(i), expected.mid(std::max<qsizetype>(0, i - 3), 6).join(u" | "_s))));
    }
}

backtest::PageInput inputOf(const QJsonObject& seed) {
    backtest::PageInput in;
    in.strategies = seed[u"strategies"_s].toArray();
    in.symbol = seed[u"symbol"_s].toString();
    in.start = seed[u"start"_s].toString();
    in.end = seed[u"end"_s].toString();
    in.strategyKey = seed[u"strategyKey"_s].toString();
    in.params = seed[u"params"_s].toObject();
    if (seed[u"rules"_s].isObject()) in.rules = seed[u"rules"_s].toObject();
    if (seed.contains(u"instType"_s)) in.instType = seed[u"instType"_s].toString();
    if (seed[u"inst"_s].isObject()) in.inst = seed[u"inst"_s].toObject();
    if (seed.contains(u"cost"_s)) in.cost = seed[u"cost"_s];
    in.result = seed.contains(u"result"_s) ? seed[u"result"_s] : QJsonValue(QJsonValue::Null);
    in.running = seed[u"running"_s].toBool();
    in.failure = seed[u"failure"_s].toString();
    in.ruleText = seed[u"ruleText"_s].toString();
    in.generating = seed[u"generating"_s].toBool();
    in.swExtra = seed[u"swExtra"_s].toString();
    in.swGrid = seed[u"swGrid"_s].toObject();
    if (seed.contains(u"swSplit"_s)) in.swSplit = seed[u"swSplit"_s];
    if (seed.contains(u"swFolds"_s)) in.swFolds = seed[u"swFolds"_s];
    if (seed.contains(u"swObjective"_s)) in.swObjective = seed[u"swObjective"_s].toString();
    in.swResult = seed.contains(u"swResult"_s) ? seed[u"swResult"_s] : QJsonValue(QJsonValue::Null);
    in.swRunning = seed[u"swRunning"_s].toBool();
    in.swFailure = seed[u"swFailure"_s].toString();
    return in;
}

/// rc-input-number 显示的字:值本身的小数位与步长的小数位取大的那个(同 kit/InputNumber.qml)
QString numberText(const QJsonValue& v, double step) {
    if (v.isNull() || v.isUndefined()) return QString();
    const auto decimals = [](const QString& s) { const qsizetype d = s.indexOf(u'.'); return d < 0 ? 0 : int(s.size() - d - 1); };
    const double x = v.toDouble();
    return QString::number(x, 'f', std::max(decimals(QString::number(x, 'g', 15)), decimals(QString::number(step, 'g', 15))));
}

/// 页面上有字(值或占位)的输入框,按文档次序:{ value, placeholder }
QList<std::pair<QString, QString>> inputsOf(const QJsonObject& page) {
    QList<std::pair<QString, QString>> out{{page[u"symbol"_s].toString(), u"如 NVDA、SPX"_s}, {page[u"start"_s].toString(), u"开始日期"_s}, {page[u"end"_s].toString(), u"结束日期"_s}};
    if (page[u"builder"_s].isObject()) {
        out.append({page[u"builder"_s][u"text"_s].toString(), u"用文字描述,如:RSI跌破30且收盘价高于200日均线时买入,RSI回到70卖出"_s});
        for (const QJsonValue& s : page[u"builder"_s][u"sections"_s].toArray())
            for (const QJsonValue& c : s[u"conds"_s].toArray())
                for (const char* side : {"left", "right"}) {
                    const QJsonValue o = c[QLatin1StringView(side)];
                    if (o[u"needsNum"_s].toBool()) out.append({numberText(o[u"num"_s], 1), o[u"placeholder"_s].toString()});
                }
    }
    for (const QJsonValue& p : page[u"params"_s].toArray()) out.append({numberText(p[u"value"_s], 1), QString()});
    for (const QJsonValue& r : page[u"instRows"_s].toArray()) out.append({numberText(r[u"value"_s], r[u"step"_s].toDouble()), QString()});
    out.append({numberText(page[u"cost"_s][u"value"_s], 0.05), QString()});
    const QJsonObject sw = page[u"sweep"_s].toObject();
    if (sw[u"sweepable"_s].toBool()) {
        out.append({sw[u"extra"_s].toString(), u"如 MSFT, AMZN"_s});
        for (const QJsonValue& g : sw[u"gridRows"_s].toArray()) out.append({g[u"value"_s].toString(), QString()});
        out.append({numberText(sw[u"split"_s], 5), QString()});
        out.append({numberText(sw[u"folds"_s], 1), QString()});
    }
    QList<std::pair<QString, QString>> kept;
    for (const auto& p : out)
        if (!p.first.isEmpty() || !p.second.isEmpty()) kept << p;
    return kept;
}

}  // namespace

class TestBacktestRules : public QObject {
    Q_OBJECT
private slots:
    void pages_data() {
        QTest::addColumn<QJsonObject>("c");
        for (const QJsonValue& p : fixture()[u"pages"_s].toArray()) QTest::newRow(qPrintable(p[u"name"_s].toString())) << p.toObject();
    }
    void pages() {
        QFETCH(QJsonObject, c);
        const QJsonObject page = backtest::pageModel(inputOf(c[u"seed"_s].toObject()));
        QStringList expected;
        for (const QJsonValue& t : c[u"texts"_s].toArray()) expected << t.toString();
        compareTexts(normalize(backtest::pageTexts(page)), expected);

        // 流程图的卡片
        QJsonArray flow;
        if (page[u"flow"_s].isObject()) {
            const QJsonObject f = page[u"flow"_s].toObject();
            const auto card = [](const char* kind, const QString& title, const QJsonValue& body) {
                return QJsonObject{{u"kind"_s, QString::fromLatin1(kind)}, {u"title"_s, title}, {u"body"_s, body}};
            };
            flow = QJsonArray{card("start", u"开始"_s, u"每根日线收盘评估"_s), card("cond", u"持仓是否为空?"_s, u"持有数量 = 0?"_s),
                              card("cond", u"入场条件是否满足?"_s, f[u"entry"_s].toString().isEmpty() ? QJsonValue(QJsonValue::Null) : f[u"entry"_s]),
                              card("action", u"开仓"_s, f[u"buy"_s])};
            if (f[u"exit"_s].isString()) flow << card("cond", u"出场条件是否满足?"_s, f[u"exit"_s]) << card("action", u"平仓"_s, f[u"sell"_s]);
            else flow << card("action", u"继续持有"_s, f[u"hold"_s]);
        }
        QCOMPARE(flow, plain(c[u"flow"_s]).toArray());

        // 按钮:读着 / 点不动(分页的上一页 / 下一页是两个没字的按钮)
        QJsonArray buttons;
        const auto button = [](const QString& text, bool loading, bool disabled) { return QJsonObject{{u"text"_s, text}, {u"loading"_s, loading}, {u"disabled"_s, disabled}}; };
        if (page[u"builder"_s].isObject()) {
            const QJsonObject b = page[u"builder"_s].toObject();
            buttons << button(b[u"button"_s].toString(), b[u"generating"_s].toBool(), false);
            for (const QJsonValue& s : b[u"sections"_s].toArray()) {
                for (qsizetype i = 0; i < s[u"conds"_s].toArray().size(); ++i) buttons << button(u"✕"_s, false, false);
                buttons << button(u"+ 添加条件"_s, false, false);
            }
        }
        buttons << button(u"运行回测"_s, page[u"running"_s].toBool(), false);
        const QJsonObject sw = page[u"sweep"_s].toObject();
        if (sw[u"sweepable"_s].toBool()) {
            buttons << button(u"扫参数 · 看样本外"_s, sw[u"running"_s].toBool(), !sw[u"canRun"_s].toBool());
            if (sw[u"result"_s].isObject() && sw[u"result"_s][u"pages"_s].toInt() > 1) {
                const int pg = sw[u"result"_s][u"page"_s].toInt(), pages = sw[u"result"_s][u"pages"_s].toInt();
                buttons << button(QString(), false, pg <= 1) << button(QString(), false, pg >= pages);
            }
        }
        QCOMPARE(buttons, plain(c[u"buttons"_s]).toArray());

        // 卡片的状态色(文档次序)
        QStringList cards;
        if (!page[u"failure"_s].toString().isEmpty()) cards << u"bad"_s;
        if (page[u"result"_s].isObject()) {
            const QJsonObject r = page[u"result"_s].toObject();
            cards << r[u"tone"_s].toString() << u"info"_s;
            if (r[u"rules"_s].isObject()) cards << u"info"_s;
            cards << u"info"_s;
            if (r[u"trades"_s].isObject()) cards << u"info"_s;
            cards << u"warn"_s;
        }
        if (!sw[u"failure"_s].toString().isEmpty()) cards << u"bad"_s;
        if (sw[u"result"_s].isObject()) cards << sw[u"result"_s][u"tone"_s].toString();
        QStringList expectedCards;
        for (const QJsonValue& v : c[u"cards"_s].toArray()) expectedCards << v.toString();
        QCOMPARE(cards, expectedCards);

        // 着色的数:成交明细的胶囊、扫描表与滚动前推的 perf-num
        QJsonArray tones;
        if (page[u"result"_s][u"trades"_s].isObject())
            for (const QJsonValue& x : page[u"result"_s][u"trades"_s][u"rows"_s].toArray())
                tones << QJsonObject{{u"cls"_s, x[u"ok"_s].toBool() ? u"status filled"_s : u"status rejected"_s}, {u"text"_s, x[u"ret"_s]}};
        if (sw[u"result"_s].isObject()) {
            const auto perf = [](const QJsonValue& tone, const QJsonValue& text) { return QJsonObject{{u"cls"_s, (u"perf-num "_s + tone.toString())}, {u"text"_s, text}}; };
            for (const QJsonValue& x : sw[u"result"_s][u"rows"_s].toArray())
                tones << perf(x[u"isTone"_s], x[u"is"_s]) << perf(x[u"oosTone"_s], x[u"oos"_s]) << perf(x[u"excessTone"_s], x[u"excess"_s]);
            for (const QJsonValue& f : sw[u"result"_s][u"folds"_s].toArray()) tones << perf(f[u"retTone"_s], f[u"ret"_s]);
        }
        QCOMPARE(tones, plain(c[u"tones"_s]).toArray());

        // 数字瓦片的着色
        QStringList tileTones, expectedTiles;
        const auto addTiles = [&](const QJsonValue& list) { for (const QJsonValue& t : list.toArray()) tileTones << t[u"tone"_s].toString(); };
        if (page[u"result"_s].isObject()) {
            addTiles(page[u"result"_s][u"tiles"_s]);
            addTiles(page[u"result"_s][u"statTiles"_s]);
        }
        if (sw[u"result"_s].isObject()) addTiles(sw[u"result"_s][u"tiles"_s]);
        for (const QJsonValue& t : c[u"tiles"_s].toArray()) expectedTiles << t[u"cls"_s].toString();
        QCOMPARE(tileTones, expectedTiles);

        // 输入框里的字
        QStringList got, want;
        for (const auto& [v, p] : inputsOf(page)) got << v + u" ‖ "_s + p;
        for (const QJsonValue& i : c[u"inputs"_s].toArray())
            if (!i[u"value"_s].toString().isEmpty() || !i[u"placeholder"_s].toString().isEmpty()) want << i[u"value"_s].toString() + u" ‖ "_s + i[u"placeholder"_s].toString();
        QCOMPARE(got, want);

        // 分页:页码几个
        int pager = 0;
        for (const QJsonValue& p : sw[u"result"_s][u"pager"_s].toArray()) pager += p.isDouble() ? 1 : 0;
        QCOMPARE(pager, c[u"pager"_s].toInt());
        // 挑参数按的那一组分段
        if (sw[u"sweepable"_s].toBool())
            QCOMPARE(plain(c[u"segments"_s]).toArray(), (QJsonArray{sw[u"objective"_s].toString() == u"return", sw[u"objective"_s].toString() == u"calmar"}));
    }

    void charts_data() {
        QTest::addColumn<QJsonObject>("c");
        int i = 0;
        for (const QJsonValue& p : fixture()[u"charts"_s].toArray()) QTest::newRow(qPrintable(QString::number(i++))) << p.toObject();
    }
    void charts() {
        QFETCH(QJsonObject, c);
        QCOMPARE(plain(backtest::equityChart(c[u"input"_s])), plain(c[u"chart"_s]).isUndefined() ? QJsonValue(QJsonValue::Null) : plain(c[u"chart"_s]));
    }

    // 算子换一种:换成常数带上原来的数;换成要周期的指标带上原来的周期(没有就 20);别的不带周期
    void pickOperand() {
        const QJsonObject sma{{u"kind"_s, u"indicator"_s}, {u"name"_s, u"sma"_s}, {u"period"_s, 50}};
        QCOMPARE(backtest::pickOperand(sma, u"rsi"_s), (QJsonObject{{u"kind"_s, u"indicator"_s}, {u"name"_s, u"rsi"_s}, {u"period"_s, 50}}));
        QCOMPARE(backtest::pickOperand(sma, u"close"_s), (QJsonObject{{u"kind"_s, u"indicator"_s}, {u"name"_s, u"close"_s}}));
        QCOMPARE(backtest::pickOperand(sma, u"const"_s), (QJsonObject{{u"kind"_s, u"const"_s}}));
        QCOMPARE(backtest::pickOperand(QJsonObject{{u"kind"_s, u"const"_s}, {u"value"_s, 30}}, u"const"_s), (QJsonObject{{u"kind"_s, u"const"_s}, {u"value"_s, 30}}));
        QCOMPARE(backtest::pickOperand(QJsonObject{{u"kind"_s, u"const"_s}, {u"value"_s, 30}}, u"ema"_s),
                 (QJsonObject{{u"kind"_s, u"indicator"_s}, {u"name"_s, u"ema"_s}, {u"period"_s, 20}}));
    }

    // "5, 10 20" → [5, 10, 20];全角逗号也分;认不出、≤ 0 的丢掉
    void parseValues() {
        QCOMPARE(backtest::parseValues(u"5, 10 20"_s), (QJsonArray{5, 10, 20}));
        QCOMPARE(backtest::parseValues(u" 7,14,,x, -3 0 2.5 "_s), (QJsonArray{7, 14, 2.5}));
        QCOMPARE(backtest::parseValues(QString()), QJsonArray{});
        // JS 的 \s 认全角空格(U+3000)与 NBSP
        QCOMPARE(backtest::parseValues(u"5\u300010\u00a015"_s), (QJsonArray{5, 10, 15}));
    }

    // 跑一次的载荷
    void runSpec() {
        const QJsonArray strategies = fixture()[u"pages"_s][1][u"seed"_s][u"strategies"_s].toArray();
        backtest::PageInput in;
        in.strategies = strategies;
        in.symbol = u" nvda "_s;
        in.start = u"2025-09-08"_s;
        in.end = u"2026-09-08"_s;
        in.strategyKey = u"rsi"_s;
        in.params = QJsonObject{{u"period"_s, 14}, {u"buy_below"_s, QJsonValue::Null}, {u"sell_above"_s, 70}};
        QCOMPARE(backtest::runSpec(in), (QJsonObject{{u"symbol"_s, u"NVDA"_s}, {u"start"_s, u"2025-09-08"_s}, {u"end"_s, u"2026-09-08"_s}, {u"strategy"_s, u"rsi"_s},
                                                     {u"params"_s, QJsonObject{{u"period"_s, 14}, {u"sell_above"_s, 70}}}, {u"instrument"_s, QJsonObject{{u"type"_s, u"stock"_s}}}}));
        // 自定义带条件;期权的空格子退回默认;成本有数才带
        in.strategyKey = u"custom"_s;
        in.params = {};
        in.instType = u"butterfly"_s;
        in.inst = QJsonObject{{u"dte"_s, QJsonValue::Null}, {u"offset"_s, -2.5}, {u"width"_s, 0}, {u"risk"_s, 5}};
        in.cost = 0.1;
        const QJsonObject spec = backtest::runSpec(in);
        QCOMPARE(spec[u"rules"_s].toObject(), backtest::defaultRules());
        QCOMPARE(spec[u"instrument"_s].toObject(), (QJsonObject{{u"type"_s, u"butterfly"_s}, {u"dte"_s, 30}, {u"offset_pct"_s, -2.5}, {u"width_pct"_s, 2}, {u"risk_pct"_s, 5}}));
        QCOMPARE(spec[u"cost_pct"_s].toDouble(), 0.1);
        in.cost = QJsonValue::Null;
        QVERIFY(!backtest::runSpec(in).contains(u"cost_pct"_s));
    }

    // 扫参数的载荷:标的 = 上面那只 + 再加的;网格按策略参数的次序、只带解析出数的;切分与折数空着退回 70 / 0
    void sweepSpec() {
        backtest::PageInput in;
        in.strategies = fixture()[u"pages"_s][1][u"seed"_s][u"strategies"_s].toArray();
        in.symbol = u"nvda"_s;
        in.start = u"2025-09-08"_s;
        in.end = u"2026-09-08"_s;
        in.strategyKey = u"rsi"_s;
        in.swExtra = u"msft,amzn  ,"_s;
        in.swGrid = QJsonObject{{u"buy_below"_s, u"x"_s}, {u"sell_above"_s, u"60 70"_s}};
        in.swSplit = QJsonValue::Null;
        in.swFolds = QJsonValue::Null;
        in.swObjective = u"calmar"_s;
        QCOMPARE(backtest::sweepSpec(in), (QJsonObject{{u"symbols"_s, QJsonArray{u"NVDA"_s, u"MSFT"_s, u"AMZN"_s}}, {u"start"_s, u"2025-09-08"_s}, {u"end"_s, u"2026-09-08"_s},
                                                       {u"strategy"_s, u"rsi"_s}, {u"grid"_s, QJsonObject{{u"period"_s, QJsonArray{7, 14, 21}}, {u"sell_above"_s, QJsonArray{60, 70}}}},
                                                       {u"instrument"_s, QJsonObject{{u"type"_s, u"stock"_s}}}, {u"split_pct"_s, 70}, {u"folds"_s, 0}, {u"objective"_s, u"calmar"_s}}));
    }
};

QTEST_GUILESS_MAIN(TestBacktestRules)
#include "tst_backtest_rules.moc"
