// 「交易指令」页的纯逻辑(shell/trade_rules)对着原版现算的期望值(tests/fixtures/gen_trade_page.mjs):
//   · 整页的字:SSR 把 pages/Trade.tsx 渲染出来、按文档次序抽字,33 个场景(就绪检查表、实盘闸门、保护规则、各种结果卡片……);
//   · 损益图:原 SVG 的路径、刻度线、刻度字,一位不差;
//   · 发单账户:lib/accountPick.ts 的 pickAccounts 与 store/trade.ts 读本机存的勾选;「写进指令」;拒绝码与来源的两张词表。
#include "shell/trade_rules.h"

#include "shell/jsvalue.h"

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
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/trade-page.json"));
        if (!f.open(QIODevice::ReadOnly)) qFatal("trade-page.json 打不开");
        return QJsonDocument::fromJson(f.readAll()).object();
    }();
    return j;
}

std::optional<QStringList> optList(const QJsonValue& v) {
    if (!v.isArray()) return std::nullopt;
    QStringList out;
    for (const QJsonValue& x : v.toArray()) out << x.toString();
    return out;
}

QStringList list(const QJsonValue& v) { return optList(v).value_or(QStringList{}); }

/// 同生成器的 texts():按换行切开、空白折成一个、去掉空段(输入框里的字也这么切)
QStringList normalize(const QStringList& in) {
    QStringList out;
    static const QRegularExpression ws(u"\\s+"_s);
    for (const QString& s : in)
        for (const QString& part : s.split(u'\n')) {
            const QString t = QString(part).replace(ws, u" "_s).trimmed();
            if (!t.isEmpty()) out << t;
        }
    return out;
}

trade::PageInput inputOf(const QJsonObject& c) {
    trade::PageInput in;
    in.status = c[u"status"];
    in.llm = c[u"llm"];
    in.placeholders = list(c[u"seed"][u"placeholders"]);
    in.savedPicked = optList(c[u"savedPicked"]);
    in.composer = c[u"composer"].toObject();
    // 生成器给一整页的票据灌的是同一份历史相似交易:按这一页每张票据的键填上
    QJsonObject state;
    if (c[u"seed"].toObject().contains(u"similar"_s)) state.insert(u"res"_s, c[u"seed"][u"similar"]);
    if (c[u"seed"].toObject().contains(u"similarErr"_s)) state.insert(u"err"_s, c[u"seed"][u"similarErr"]);
    if (in.composer.value(u"payload"_s).isObject())
        for (const QJsonValue& card : trade::resultCards(in.composer.value(u"payload"_s).toObject()))
            if (card[u"similarKey"].isString()) in.similar.insert(card[u"similarKey"].toString(), state);
    return in;
}

/// 损益图画出来的样子(同 SVG 里的那几样):路径、刻度线、刻度字
QJsonObject drawn(const QJsonObject& chart) {
    const QJsonObject d = chart[u"d"].toObject();
    QJsonArray paths{d[u"area"], d[u"area"], d[u"line"], d[u"line"]};
    const auto n = [](const QJsonValue& v) { return jsNumberToString(v.toDouble()); };
    QJsonArray lines{QJsonObject{{u"x1"_s, u"0"_s}, {u"y1"_s, n(chart[u"zeroY"])}, {u"x2"_s, u"600"_s}, {u"y2"_s, n(chart[u"zeroY"])}, {u"stroke"_s, u"var(--label-tertiary)"_s}}};
    for (const QJsonValue& x : chart[u"ticks"].toArray())
        lines.append(QJsonObject{{u"x1"_s, n(x)}, {u"y1"_s, n(chart[u"tickY1"])}, {u"x2"_s, n(x)}, {u"y2"_s, n(chart[u"tickY2"])}, {u"stroke"_s, u"var(--label-tertiary)"_s}});
    if (!chart[u"spotX"].isNull())
        lines.append(QJsonObject{{u"x1"_s, n(chart[u"spotX"])}, {u"y1"_s, n(chart[u"spotY1"])}, {u"x2"_s, n(chart[u"spotX"])}, {u"y2"_s, n(chart[u"spotY2"])}, {u"stroke"_s, u"var(--blue)"_s}});
    QJsonArray axis;
    for (const QJsonValue& a : chart[u"axis"].toArray())
        axis.append(QJsonObject{{u"cls"_s, a[u"spot"].toBool() ? u"spot"_s : QString()}, {u"left"_s, a[u"leftText"]}, {u"text"_s, a[u"text"]}});
    return {{u"viewBox"_s, u"0 0 600 120"_s}, {u"paths"_s, paths}, {u"lines"_s, lines}, {u"axis"_s, axis}};
}

QJsonObject expectedDrawing(const QJsonObject& p) {
    return {{u"viewBox"_s, p[u"viewBox"]}, {u"paths"_s, p[u"paths"]}, {u"lines"_s, p[u"lines"]}, {u"axis"_s, p[u"axis"]}};
}

QString compact(const QJsonValue& v) { return QString::fromUtf8(QJsonDocument(QJsonArray{v}).toJson(QJsonDocument::Compact)); }

}  // namespace

class TestTradeRules : public QObject {
    Q_OBJECT
private slots:
    void pageTexts_data() {
        QTest::addColumn<QJsonObject>("c");
        const QJsonArray pages = fixture()[u"pages"].toArray();
        QVERIFY(pages.size() >= 30);
        for (const QJsonValue& c : pages) QTest::newRow(qPrintable(c[u"name"].toString())) << c.toObject();
    }
    void pageTexts() {
        QFETCH(QJsonObject, c);
        const trade::PageInput in = inputOf(c);
        const QJsonObject model = trade::tradePageModel(in);
        QCOMPARE(model[u"picked"].toArray(), c[u"pickedNow"].toArray());
        // 「发送」按钮:提示里写着发不出去的原因(熔断、没连、自动执行没开——这几样不进页面的字)、灰不灰、橙不橙
        const QJsonObject send = c[u"send"].toObject();
        QCOMPARE(model[u"send"][u"tip"].toString(), send[u"title"].toString());
        QCOMPARE(!model[u"send"][u"canExecute"].toBool() || model[u"busy"] == u"parse"_s, send[u"disabled"].toBool());
        QCOMPARE(model[u"send"][u"warn"].toBool(), send[u"warn"].toBool());
        const QStringList got = normalize(trade::pageTexts(model, in.composer[u"text"].toString()));
        const QStringList expected = list(c[u"texts"]);
        for (qsizetype i = 0; i < std::max(got.size(), expected.size()); ++i) {
            if (got.value(i) != expected.value(i))
                QFAIL(qPrintable(u"第 %1 段:期望「%2」,实际「%3」\n前后:%4"_s.arg(i).arg(expected.value(i), got.value(i), expected.mid(std::max<qsizetype>(0, i - 3), 6).join(u" | "_s))));
        }
    }

    void payoffsOnTickets() {
        // 页面场景里每张票据的损益图,按出现的次序
        const QJsonArray payoffs = fixture()[u"payoffs"].toArray();
        int checked = 0;
        for (const QJsonValue& cv : fixture()[u"pages"].toArray()) {
            const QJsonObject c = cv.toObject();
            QJsonArray expected;
            for (const QJsonValue& p : payoffs)
                if (p[u"scenario"] == c[u"name"]) expected.append(p);
            QJsonArray got;
            const QJsonObject result = trade::tradePageModel(inputOf(c))[u"result"].toObject();
            for (const QJsonValue& card : result[u"cards"].toArray())
                if (card[u"ticket"][u"payoff"].isObject()) got.append(card[u"ticket"][u"payoff"]);
            QCOMPARE(got.size(), expected.size());
            for (qsizetype i = 0; i < got.size(); ++i) {
                QCOMPARE(compact(drawn(got[i].toObject())), compact(expectedDrawing(expected[i].toObject())));
                ++checked;
            }
        }
        QVERIFY(checked >= 5);
    }

    void payoffsDirect() {
        int checked = 0;
        for (const QJsonValue& p : fixture()[u"payoffs"].toArray()) {
            if (!p[u"input"].isObject()) continue;
            const QJsonObject in = p[u"input"].toObject();
            const QJsonObject chart = trade::payoffChart(in[u"legs"].toArray(), in[u"premium"], in[u"spot"]);
            QCOMPARE(compact(drawn(chart)), compact(expectedDrawing(p.toObject())));
            ++checked;
        }
        QCOMPARE(checked, 8);
        QVERIFY(trade::payoffChart({}, 1.0, 1.0).isEmpty());
    }

    void picks() {
        const QJsonArray cases = fixture()[u"picks"].toArray();
        QVERIFY(cases.size() >= 14);
        for (const QJsonValue& c : cases)
            QCOMPARE(trade::pickAccounts(c[u"usable"].toArray(), optList(c[u"saved"])), list(c[u"result"]));
    }

    void storedPicks() {
        const QJsonArray usable{QJsonObject{{u"alias"_s, u"模拟"_s}, {u"default"_s, true}}, QJsonObject{{u"alias"_s, u"主账户"_s}}};
        for (const QJsonValue& c : fixture()[u"stored"].toArray()) {
            const std::optional<QString> raw = c[u"raw"].isString() ? std::optional<QString>(c[u"raw"].toString()) : std::nullopt;
            QCOMPARE(trade::pickAccounts(usable, trade::readPicked(raw)), list(c[u"picked"]));
            const QStringList saved{u"主账户"_s, u"模拟"_s};
            QCOMPARE(trade::pickAccounts(usable, saved), list(c[u"afterSave"]));
            QCOMPARE(QString::fromUtf8(QJsonDocument(QJsonArray::fromStringList(saved)).toJson(QJsonDocument::Compact)), c[u"written"].toString());
        }
    }

    void appends() {
        for (const QJsonValue& c : fixture()[u"appends"].toArray())
            QCOMPARE(trade::appendInstruction(c[u"text"].toString(), c[u"line"].toString()), c[u"result"].toString());
    }

    void rejectLabels() {
        // lib/labels.ts 的两张词表逐项对:每个拒绝码、每个来源都摆一张卡片看标题
        const QJsonObject labels = fixture()[u"labels"].toObject();
        const QJsonObject codes = labels[u"REJECT_CODE_LABEL"].toObject();
        const QJsonObject sources = labels[u"REJECT_SOURCE_LABEL"].toObject();
        QVERIFY(codes.size() >= 20);
        for (auto it = codes.begin(); it != codes.end(); ++it) {
            const QJsonArray cards = trade::resultCards({{u"rejections"_s, QJsonArray{QJsonObject{{u"source"_s, u"llm"_s}, {u"code"_s, it.key()}}}}});
            QCOMPARE(cards[0][u"title"].toString(), u"模型拒绝 · "_s + it.value().toString());
        }
        for (auto it = sources.begin(); it != sources.end(); ++it) {
            const QJsonArray cards = trade::resultCards({{u"rejections"_s, QJsonArray{QJsonObject{{u"source"_s, it.key()}, {u"code"_s, u"X"_s}}}}});
            QCOMPARE(cards[0][u"title"].toString(), it.value().toString() + u" · X"_s);
        }
    }

    void insertSnippet() {
        // Trade.tsx 的 insertSnippet:句尾追加整句前补换行;逗号开头的补充片段原样接上;插在中间不补
        auto r = trade::insertSnippet(u"abc"_s, 3, 3, u"x"_s);
        QCOMPARE(r.text, u"abc\nx"_s);
        QCOMPARE(r.caret, 5);
        r = trade::insertSnippet(u"abc"_s, 3, 3, u",理由:"_s);
        QCOMPARE(r.text, u"abc,理由:"_s);
        r = trade::insertSnippet(u"abc\n"_s, 4, 4, u"x"_s);
        QCOMPARE(r.text, u"abc\nx"_s);
        r = trade::insertSnippet(QString(), 0, 0, u"x"_s);
        QCOMPARE(r.text, u"x"_s);
        QCOMPARE(r.caret, 1);
        r = trade::insertSnippet(u"abcdef"_s, 1, 3, u"XY"_s);
        QCOMPARE(r.text, u"aXYdef"_s);
        QCOMPARE(r.caret, 3);
    }

    void similarQuery() {
        // 缺的键写 null(?? null),腿里没给的键不出现
        const QJsonObject q = trade::similarQuery({{u"sec_type"_s, u"BAG"_s}, {u"symbol"_s, u"SPX"_s}, {u"action"_s, u"BUY"_s},
                                                  {u"legs"_s, QJsonArray{QJsonObject{{u"action"_s, u"BUY"_s}, {u"strike"_s, 1}}}}});
        QCOMPARE(QJsonDocument(q).toJson(QJsonDocument::Compact),
                 R"({"action":"BUY","combo_strategy":null,"expiry":null,"legs":[{"action":"BUY","strike":1}],"limit_price":null,"right":null,"sec_type":"BAG","symbol":"SPX"})");
    }
};

QTEST_GUILESS_MAIN(TestTradeRules)
#include "tst_trade_rules.moc"
