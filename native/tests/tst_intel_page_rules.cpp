// 「情报」页、档案抽屉、查标的(shell/intel_page_rules)对着原版现算的期望值(tests/fixtures/gen_intel.mjs,本机时区 Asia/Shanghai):
//   · 13 个页面场景:整页的字、提示条的颜色、种类分段、只看持仓的开关、关键字框、每一行的种类 / 状态色 / 和持仓有关没有 / 标的胶囊(持仓、描边、猜的、悬停字)/
//     信任的圆点 / 时刻与悬停的全写 / 结果胶囊的颜色 / 涨跌色 / 写进指令框,常被提到那一排;
//   · 10 份档案:整份的字、价与涨跌的颜色、标签胶囊(颜色、圆点、悬停字)、列表项的类(事件的 high / medium)、价位胶囊(类与悬停字)、时间线;
//   · 5 个查标的:字、输入框的警告、胶囊。
#include "shell/intel_page_rules.h"

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
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/intel.json"));
        if (!f.open(QIODevice::ReadOnly)) qFatal("intel.json 打不开");
        return QJsonDocument::fromJson(f.readAll()).object();
    }();
    return j;
}
const QTimeZone kZone("Asia/Shanghai");

QStringList normalize(const QStringList& in) {
    QStringList out;
    static const QRegularExpression ws(u"\\s+"_s);
    for (const QString& s : in) {
        const QString t = QString(s).replace(ws, u" "_s).trimmed();
        if (!t.isEmpty()) out << t;
    }
    return out;
}

void compareTexts(const QStringList& got, const QJsonArray& want) {
    QStringList expected;
    for (const QJsonValue& t : want) expected << t.toString();
    for (qsizetype i = 0; i < std::max(got.size(), expected.size()); ++i) {
        if (got.value(i) != expected.value(i))
            QFAIL(qPrintable(u"第 %1 段:期望「%2」,实际「%3」\n前后:%4"_s.arg(i).arg(expected.value(i), got.value(i), expected.mid(std::max<qsizetype>(0, i - 3), 6).join(u" | "_s))));
    }
}

/// 时间线的每一行,摆成生成器抽出来的那个形状
QJsonArray rowsOf(const QJsonObject& timeline) {
    QJsonArray out;
    for (const QJsonValue& g : timeline[u"groups"_s].toArray())
        for (const QJsonValue& r : g[u"rows"_s].toArray()) {
            QJsonArray syms;
            for (const QJsonValue& s : r[u"syms"_s].toArray()) {
                QStringList cls;
                if (s[u"held"_s].toBool()) cls << u"held"_s;
                if (s[u"current"_s].toBool()) cls << u"current"_s;
                if (s[u"guess"_s].toBool()) cls << u"guess"_s;
                syms.append(QJsonObject{{u"cls"_s, cls.join(u' ')}, {u"title"_s, s[u"guess"_s].toBool() ? QString() : s[u"tip"_s].toString()}, {u"text"_s, s[u"text"_s]}});
            }
            const QJsonObject f = r[u"foot"_s].toObject();
            QJsonArray pills;
            if (f.contains(u"outcome"_s)) pills.append(QJsonObject{{u"tint"_s, u"var(--%1)"_s.arg(f[u"outcome"_s][u"tint"_s].toString())}, {u"dot"_s, false}, {u"title"_s, QString()}});
            out.append(QJsonObject{{u"kind"_s, r[u"kind"_s]}, {u"tone"_s, r[u"tone"_s]}, {u"held"_s, r[u"held"_s]}, {u"syms"_s, syms}, {u"trusted"_s, r[u"trusted"_s]},
                                   {u"time"_s, QJsonObject{{u"title"_s, r[u"timeTip"_s]}, {u"text"_s, r[u"time"_s]}}}, {u"pills"_s, pills},
                                   {u"move"_s, f.contains(u"move"_s) ? f[u"move"_s][u"tone"_s] : QJsonValue(QJsonValue::Null)}, {u"write"_s, f.contains(u"instruction"_s)}});
        }
    return out;
}

}  // namespace

class TestIntelPageRules : public QObject {
    Q_OBJECT
private slots:
    void pages_data() {
        QTest::addColumn<QJsonObject>("c");
        for (const QJsonValue& p : fixture()[u"pages"_s].toArray()) QTest::newRow(qPrintable(p[u"name"_s].toString())) << p.toObject();
    }
    void pages() {
        QFETCH(QJsonObject, c);
        const QJsonObject page = intel::pageModel(c[u"state"_s].toObject(), c[u"query"_s].toString(), c[u"connected"_s].toBool(), fixture()[u"now"_s].toDouble(), kZone);
        compareTexts(normalize(intel::pageTexts(page)), c[u"texts"_s].toArray());
        QJsonArray notices;
        for (const QJsonValue& n : page[u"notices"_s].toArray()) notices.append(n[u"tone"_s].toString() == u"warn" ? u"warning"_s : n[u"tone"_s].toString());
        QCOMPARE(notices, c[u"notices"_s].toArray());
        QJsonArray segs;
        for (const QJsonValue& k : page[u"kinds"_s].toArray()) segs.append(k[u"value"_s] == page[u"kind"_s]);
        QCOMPARE(segs, c[u"segments"_s].toArray());
        QCOMPARE(c[u"switches"_s].toArray(), QJsonArray{page[u"heldOnly"_s].toBool()});
        QCOMPARE(c[u"inputs"_s].toArray(), (QJsonArray{QJsonObject{{u"value"_s, page[u"query"_s]}, {u"placeholder"_s, u"筛:代码或原文里的字"_s}}}));
        QCOMPARE(rowsOf(page[u"timeline"_s].toObject()), c[u"rows"_s].toArray());
        QJsonArray chips;
        for (const QJsonValue& h : page[u"hot"_s].toArray())
            chips.append(QJsonObject{{u"cls"_s, h[u"held"_s].toBool() ? u"held"_s : QString()}, {u"title"_s, h[u"held"_s].toBool() ? u"持仓中"_s : QString()},
                                     {u"text"_s, u"%1 %2"_s.arg(h[u"symbol"_s].toString()).arg(h[u"n"_s].toInt())}});
        QCOMPARE(chips, c[u"chips"_s].toArray());
        // 按钮:查标的、刷新(读着)、每一行的标的胶囊与写进指令框
        QJsonArray buttons{QJsonObject{{u"text"_s, u"查标的 "_s + intel::modKey() + u"K"_s}, {u"loading"_s, false}, {u"disabled"_s, false}},
                           QJsonObject{{u"text"_s, u"刷新"_s}, {u"loading"_s, page[u"loading"_s].toBool()}, {u"disabled"_s, false}}};
        for (const QJsonValue& g : page[u"timeline"_s][u"groups"_s].toArray())
            for (const QJsonValue& r : g[u"rows"_s].toArray()) {
                for (const QJsonValue& s : r[u"syms"_s].toArray()) buttons.append(QJsonObject{{u"text"_s, s[u"text"_s]}, {u"loading"_s, false}, {u"disabled"_s, false}});
                if (r[u"foot"_s].toObject().contains(u"instruction"_s)) buttons.append(QJsonObject{{u"text"_s, u"写进指令框"_s}, {u"loading"_s, false}, {u"disabled"_s, false}});
            }
        QCOMPARE(buttons, c[u"buttons"_s].toArray());
    }

    void dossiers_data() {
        QTest::addColumn<QJsonObject>("c");
        for (const QJsonValue& p : fixture()[u"dossiers"_s].toArray()) QTest::newRow(qPrintable(p[u"name"_s].toString())) << p.toObject();
    }
    void dossiers() {
        QFETCH(QJsonObject, c);
        const QJsonObject m = intel::dossierModel(c[u"state"_s][u"dossier"_s].toObject(), kZone);
        compareTexts(normalize(intel::dossierTexts(m)), c[u"texts"_s].toArray());
        QCOMPARE(c[u"notices"_s].toArray(), m[u"error"_s].toString().isEmpty() ? QJsonArray{} : QJsonArray{u"warning"_s});
        QJsonArray heroes;
        if (m[u"ready"_s].toBool()) {
            const QString dir = m[u"head"_s][u"dir"_s].toString();
            heroes.append((u"hero-num "_s + dir).trimmed());
            if (!m[u"head"_s][u"change"_s].toString().isEmpty()) heroes.append((u"dossier-chg "_s + dir).trimmed());
        }
        QCOMPARE(heroes, c[u"heroes"_s].toArray());
        QJsonArray pills;
        for (const QJsonValue& p : m[u"head"_s][u"pills"_s].toArray())
            pills.append(QJsonObject{{u"tint"_s, u"var(--%1)"_s.arg(p[u"tint"_s].toString())}, {u"dot"_s, p[u"dot"_s]}, {u"title"_s, p[u"tip"_s]}});
        // 时间线里结果胶囊也是 Pill(生成器按文档次序抽:头上的在前)
        for (const QJsonValue& r : rowsOf(m[u"timeline"_s].toObject()))
            for (const QJsonValue& p : r[u"pills"_s].toArray()) pills.append(p);
        QCOMPARE(pills, c[u"pills"_s].toArray());
        QJsonArray lis, levels;
        for (const QJsonValue& s : m[u"sections"_s].toArray()) {
            for (const QJsonValue& r : s[u"rows"_s].toArray()) {
                if (s[u"kind"_s].toString() == u"levels") levels.append(QJsonObject{{u"cls"_s, u"level-"_s + r[u"kind"_s].toString()}, {u"title"_s, r[u"tip"_s]}, {u"text"_s, r[u"text"_s]}});
                else lis.append(s[u"title"_s].toString() == u"接下来的事"_s ? r[u"cls"_s].toString() : QString());
            }
        }
        QCOMPARE(lis, c[u"lis"_s].toArray());
        QCOMPARE(levels, c[u"chips"_s].toArray());
        QCOMPARE(rowsOf(m[u"timeline"_s].toObject()), c[u"rows"_s].toArray());
        QJsonArray buttons{QJsonObject{{u"text"_s, u"刷新"_s}, {u"loading"_s, m[u"loading"_s].toBool()}, {u"disabled"_s, false}},
                           QJsonObject{{u"text"_s, u"K 线"_s}, {u"loading"_s, false}, {u"disabled"_s, false}},
                           QJsonObject{{u"text"_s, u"写指令"_s}, {u"loading"_s, false}, {u"disabled"_s, false}}};
        for (const QJsonValue& g : m[u"timeline"_s][u"groups"_s].toArray())
            for (const QJsonValue& r : g[u"rows"_s].toArray()) {
                for (const QJsonValue& s : r[u"syms"_s].toArray()) buttons.append(QJsonObject{{u"text"_s, s[u"text"_s]}, {u"loading"_s, false}, {u"disabled"_s, false}});
                if (r[u"foot"_s].toObject().contains(u"instruction"_s)) buttons.append(QJsonObject{{u"text"_s, u"写进指令框"_s}, {u"loading"_s, false}, {u"disabled"_s, false}});
            }
        QCOMPARE(buttons, c[u"buttons"_s].toArray());
    }

    void lookups_data() {
        QTest::addColumn<QJsonObject>("c");
        for (const QJsonValue& p : fixture()[u"lookups"_s].toArray()) QTest::newRow(qPrintable(p[u"name"_s].toString())) << p.toObject();
    }
    void lookups() {
        QFETCH(QJsonObject, c);
        const QJsonObject m = intel::lookupModel(c[u"state"_s].toObject(), c[u"text"_s].toString());
        compareTexts(normalize(intel::lookupTexts(m)), c[u"texts"_s].toArray());
        QCOMPARE(m[u"warn"_s].toBool(), c[u"warn"_s].toBool());
        QCOMPARE(c[u"inputs"_s].toArray(), (QJsonArray{QJsonObject{{u"value"_s, c[u"text"_s]}, {u"placeholder"_s, u"代码,如 NVDA、SPX、$TSLA"_s}}}));
        QJsonArray chips;
        for (const QString& key : {u"held"_s, u"recent"_s})
            for (const QJsonValue& s : m[key].toArray()) chips.append(QJsonObject{{u"cls"_s, QString()}, {u"title"_s, QString()}, {u"text"_s, s}});
        QCOMPARE(chips, c[u"chips"_s].toArray());
    }

    // 相对时间按时间线自己的「此刻」(feed.at)算,不是本机的钟;盈亏 0 是二级色(muted),不上涨跌色
    void relativeToFeedAtAndZeroPnl() {
        const double at = 1792303200000;
        const QJsonObject item{{u"id"_s, u"x"_s}, {u"kind"_s, u"signal"_s}, {u"at"_s, at - 5 * 60'000}, {u"symbols"_s, QJsonArray{}}, {u"guesses"_s, QJsonArray{}},
                               {u"held"_s, QJsonArray{}}, {u"title"_s, u"t"_s}, {u"body"_s, QString()}, {u"tone"_s, u"info"_s}, {u"source"_s, u"cross"_s}};
        const QJsonObject state{{u"feed"_s, QJsonObject{{u"items"_s, QJsonArray{item}}, {u"held"_s, QJsonArray{}}, {u"total_messages"_s, 1}, {u"at"_s, at}}}};
        const QJsonObject page = intel::pageModel(state, QString(), true, at + 3 * 3600'000, kZone);
        QCOMPARE(page[u"timeline"_s][u"groups"_s][0][u"rows"_s][0][u"time"_s].toString(), u"5 分钟前"_s);
        const QJsonObject pos{{u"key"_s, u"k"_s}, {u"symbol"_s, u"NVDA"_s}, {u"sec_type"_s, u"STK"_s}, {u"label"_s, u"NVDA"_s}, {u"quantity"_s, 1}, {u"multiplier"_s, 1},
                              {u"avg_cost"_s, 10}, {u"unrealized_pnl"_s, 0}, {u"unrealized_pct"_s, 0}};
        const QJsonObject dossier{{u"symbol"_s, u"NVDA"_s}, {u"loading"_s, false}, {u"error"_s, QJsonValue::Null},
                                  {u"data"_s, QJsonObject{{u"symbol"_s, u"NVDA"_s}, {u"at"_s, at}, {u"connected"_s, true}, {u"held"_s, true}, {u"quote"_s, QJsonValue::Null},
                                                         {u"positions"_s, QJsonArray{pos}}, {u"timeline"_s, QJsonArray{}}}}};
        const QJsonObject m = intel::dossierModel(dossier, kZone);
        QCOMPARE(m[u"sections"_s][0][u"rows"_s][0][u"pnl"_s][u"cls"_s].toString(), u"muted"_s);
        QCOMPARE(m[u"sections"_s][0][u"rows"_s][0][u"pnl"_s][u"text"_s].toString(), u"0.00"_s);
    }

    // 认得出的代码:去 $、转大写
    void lookupSymbol() {
        QCOMPARE(intel::lookupModel({}, u" $nvda "_s)[u"symbol"_s].toString(), u"NVDA"_s);
        QVERIFY(intel::lookupModel({}, u"英伟达"_s)[u"symbol"_s].toString().isEmpty());
        QVERIFY(!intel::lookupModel({}, u"  "_s)[u"warn"_s].toBool());
    }
};

QTEST_GUILESS_MAIN(TestIntelPageRules)
#include "tst_intel_page_rules.moc"
