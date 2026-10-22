// 「绩效体检」(shell/performance_rules)对着原版现算的期望值(tests/fixtures/gen_performance.mjs,本机时区 Asia/Shanghai):
//   · 15 个页面场景:整页的字、卡片的状态色、瓦片的着色、着色的数(带悬停区间的)、R 格的悬停说明、按钮、范围分段、仓位计算器的三个框、账本的页数;
//   · 仓位计算器(sizing.ts)、分享卡片的副标题与页脚、平仓权益曲线的 spec(原文 useMemo 切出来跑)。
#include "shell/performance_rules.h"

#include <QFile>
#include <QJsonDocument>
#include <QRegularExpression>
#include <QTest>

#include <cmath>

using namespace ibkr;
using namespace ibkr::shell;
using namespace Qt::StringLiterals;

namespace {

QJsonObject fixture() {
    static const QJsonObject j = [] {
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/performance.json"));
        if (!f.open(QIODevice::ReadOnly)) qFatal("performance.json 打不开");
        return QJsonDocument::fromJson(f.readAll()).object();
    }();
    return j;
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

/// PositionSizer 的 readNum:Number(本机记的) 是正的有限数才算,不然给兜底
QJsonValue readNum(const QJsonObject& local, const QString& key, const QJsonValue& fallback) {
    if (!local.contains(key)) return fallback;
    bool ok = false;
    const QString s = local[key].toString().trimmed();
    const double v = s.isEmpty() ? 0 : s.toDouble(&ok);
    return (s.isEmpty() || ok) && std::isfinite(v) && v > 0 ? QJsonValue(v) : fallback;
}

performance::PageInput inputOf(const QJsonObject& c) {
    const QJsonObject seed = c[u"seed"_s].toObject(), local = c[u"local"_s].toObject();
    performance::PageInput in;
    if (local.contains(u"dafri-perf-scope"_s)) in.scope = local[u"dafri-perf-scope"_s].toString();
    if (local.contains(u"dafri-perf-kind"_s)) in.kind = local[u"dafri-perf-kind"_s].toString();
    in.days = local[u"dafri-perf-days"_s].toString().toInt();
    in.data = seed.contains(u"data"_s) ? seed[u"data"_s] : QJsonValue(QJsonValue::Null);
    in.error = seed[u"error"_s].toString();
    in.loading = seed[u"loading"_s].toBool();
    in.adviceBusy = seed[u"adviceBusy"_s].toString();
    in.sizerEquity = readNum(local, u"dafri-sizer-equity"_s, QJsonValue(QJsonValue::Null));
    in.sizerPct = readNum(local, u"dafri-sizer-pct"_s, 1);
    in.sizerUnit = seed.contains(u"sizerUnit"_s) ? seed[u"sizerUnit"_s] : performance::typicalUnitRisk(in.data);
    in.signalData = seed.contains(u"signals"_s) ? seed[u"signals"_s] : QJsonValue(QJsonValue::Null);
    in.signalsLoading = seed[u"signalsLoading"_s].toBool();
    in.signalsError = seed[u"signalsError"_s].toString();
    in.nowMs = fixture()[u"now"_s].toDouble();
    in.zone = QTimeZone("Asia/Shanghai");
    return in;
}

}  // namespace

class TestPerformanceRules : public QObject {
    Q_OBJECT
private slots:
    void pages_data() {
        QTest::addColumn<QJsonObject>("c");
        for (const QJsonValue& p : fixture()[u"pages"_s].toArray()) QTest::newRow(qPrintable(p[u"name"_s].toString())) << p.toObject();
    }
    void pages() {
        QFETCH(QJsonObject, c);
        const QJsonObject page = performance::pageModel(inputOf(c));
        QStringList expected;
        for (const QJsonValue& t : c[u"texts"_s].toArray()) expected << t.toString();
        compareTexts(normalize(performance::pageTexts(page)), expected);

        const auto strs = [](const QJsonValue& v) {
            QStringList out;
            for (const QJsonValue& x : v.toArray()) out << x.toString();
            return out;
        };
        const QJsonObject sg = page[u"signals"_s].toObject();
        // 卡片的状态色(文档次序):结论、保护规则建议、核心数字、权益曲线、分组、执行损耗、仓位计算器、账本;信号成绩单的报错与各组。
        // 「算不出来」与「混在一起算」是 Notice(Alert),不算卡片
        QStringList cards, tiles;
        const bool data = page[u"hasData"_s].toBool();
        if (data) {
            for (const QJsonValue& f : page[u"findings"_s].toArray()) cards << f[u"tone"_s].toString();
            for (qsizetype i = 0; i < page[u"advice"_s].toArray().size(); ++i) cards << u"warn"_s;
            cards << u"info"_s;
            if (page[u"equity"_s].isObject()) cards << u"info"_s;
            cards << u"info"_s;
            if (page[u"execution"_s].isObject()) cards << page[u"execution"_s][u"tone"_s].toString();
            cards << page[u"sizer"_s][u"tone"_s].toString();
            if (page[u"ledger"_s].isObject()) cards << u"info"_s;
            for (const QJsonValue& t : page[u"stats"_s][u"tiles"_s].toArray()) tiles << t[u"tone"_s].toString();
            for (const QJsonValue& t : page[u"execution"_s][u"tiles"_s].toArray()) tiles << t[u"tone"_s].toString();
            for (const QJsonValue& t : page[u"sizer"_s][u"tiles"_s].toArray()) tiles << t[u"tone"_s].toString();
        }
        if (!sg[u"error"_s].toString().isEmpty()) cards << u"bad"_s;
        for (const QJsonValue& g : sg[u"groups"_s].toArray()) cards << g[u"tone"_s].toString();
        QCOMPARE(cards, strs(c[u"cards"_s]));
        QCOMPARE(tiles, strs(c[u"tiles"_s]));
        // 着色的数(分组表的净盈亏与每笔期望、账本这一页的盈亏、信号的平均与多出)与 R 格的悬停说明
        QJsonArray nums, titles;
        const auto num = [&](const QJsonValue& cell) {
            nums << QJsonObject{{u"cls"_s, (u"perf-num "_s + cell[u"tone"_s].toString()).trimmed()}, {u"title"_s, cell[u"tip"_s].toString()}, {u"text"_s, cell[u"text"_s]}};
        };
        for (const QJsonValue& g : page[u"groups"_s][u"tables"_s].toArray())
            for (const QJsonValue& row : g[u"rows"_s].toArray()) num(row[u"cells"_s][u"net_pnl"_s]), num(row[u"cells"_s][u"expectancy"_s]);
        for (const QJsonValue& row : page[u"ledger"_s][u"table"_s][u"rows"_s].toArray()) {
            num(row[u"cells"_s][u"pnl"_s]);
            const QJsonValue r = row[u"cells"_s][u"r"_s];
            if (!r[u"tip"_s].toString().isEmpty()) titles << QJsonObject{{u"title"_s, r[u"tip"_s]}, {u"text"_s, r[u"text"_s]}};
        }
        for (const QJsonValue& g : sg[u"groups"_s].toArray())
            for (const QJsonValue& row : g[u"rows"_s].toArray()) num(row[u"cells"_s][u"mean"_s]), num(row[u"cells"_s][u"edge"_s]);
        QCOMPARE(nums, c[u"nums"_s].toArray());
        QCOMPARE(titles, c[u"titles"_s].toArray());
        // 按钮:重新计算(读着)、分享卡片、每条建议的「按建议填入」(在填的那条读着)、两张分页表的上一页 / 下一页、信号打分
        QJsonArray buttons;
        const auto button = [&](const QString& text, bool loading, bool disabled) {
            buttons << QJsonObject{{u"text"_s, text}, {u"loading"_s, loading}, {u"disabled"_s, disabled}};
        };
        button(u"重新计算"_s, page[u"loading"_s].toBool(), false);
        if (page[u"share"_s].toBool()) button(u"分享卡片"_s, false, false);
        int pagerItems = 0;
        if (data) {
            for (const QJsonValue& a : page[u"advice"_s].toArray()) button(u"按建议填入"_s, a[u"busy"_s].toBool(), false);
            for (const QJsonValue& t : {page[u"execution"_s][u"table"_s], page[u"ledger"_s][u"table"_s]}) {
                if (t[u"pages"_s].toInt() <= 1) continue;
                button(QString(), false, t[u"page"_s].toInt() == 1);
                button(QString(), false, t[u"page"_s].toInt() == t[u"pages"_s].toInt());
                pagerItems += int(t[u"pager"_s].toArray().size());
            }
        }
        button(sg[u"button"_s].toString(), sg[u"loading"_s].toBool(), false);
        QCOMPARE(buttons, c[u"buttons"_s].toArray());
        QCOMPARE(pagerItems, c[u"pager"_s].toInt());
        // 范围分段
        QJsonArray segs;
        for (const QJsonValue& o : page[u"scopes"_s].toArray()) segs << (o[u"value"_s] == page[u"scope"_s]);
        QCOMPARE(segs, c[u"segments"_s].toArray());
        // 仓位计算器的三个框(rc-input-number 按步长的小数位:1000 → 0、0.25 → 2、10 → 0)
        QJsonArray inputs;
        if (data) {
            const QJsonObject sz = page[u"sizer"_s].toObject();
            const auto text = [](const QJsonValue& v, int digits) { return v.isDouble() ? QString::number(v.toDouble(), 'f', digits) : QString(); };
            inputs << QJsonObject{{u"value"_s, text(sz[u"equity"_s], 0)}, {u"placeholder"_s, u"例如 50000"_s}}
                   << QJsonObject{{u"value"_s, text(sz[u"pct"_s], 2)}, {u"placeholder"_s, QString()}}
                   << QJsonObject{{u"value"_s, text(sz[u"unit"_s], 0)}, {u"placeholder"_s, u"蝶 = 权利金 × 100"_s}};
        }
        QCOMPARE(inputs, c[u"inputs"_s].toArray());
    }

    void sizing_data() {
        QTest::addColumn<QJsonObject>("c");
        int i = 0;
        for (const QJsonValue& p : fixture()[u"sizing"_s].toArray()) QTest::newRow(qPrintable(QString::number(i++))) << p.toObject();
    }
    void sizing() {
        QFETCH(QJsonObject, c);
        const QJsonObject in = c[u"input"_s].toObject();
        const auto got = performance::sizePosition(in[u"equity"_s], in[u"riskPct"_s], in[u"unitRisk"_s], in[u"losingStreak"_s]);
        const QJsonValue want = c[u"output"_s];
        if (!want.isObject()) {
            QVERIFY(!got);
            return;
        }
        QVERIFY(got);
        QCOMPARE(got->budget, want[u"budget"_s].toDouble());
        QCOMPARE(got->units, want[u"units"_s].toDouble());
        QCOMPARE(got->actualRisk, want[u"actualRisk"_s].toDouble());
        QCOMPARE(got->actualPct, want[u"actualPct"_s].toDouble());
        if (want[u"streakDrawdownPct"_s].isNull()) QVERIFY(!got->streakDrawdownPct);
        else QCOMPARE(*got->streakDrawdownPct, want[u"streakDrawdownPct"_s].toDouble());
    }

    void share_data() {
        QTest::addColumn<QJsonObject>("c");
        int i = 0;
        for (const QJsonValue& p : fixture()[u"share"_s].toArray()) QTest::newRow(qPrintable(QString::number(i++))) << p.toObject();
    }
    void share() {
        QFETCH(QJsonObject, c);
        const QJsonObject r{{u"mix"_s, c[u"mix"_s]}, {u"stats"_s, QJsonObject{{u"trades"_s, c[u"trades"_s]}}}};
        const QJsonObject o = c[u"options"_s].toObject();
        QCOMPARE(performance::cardSubtitle(r, o[u"scope"_s].toString(), o[u"kind"_s].toString(), o[u"days"_s].toInt()), c[u"subtitle"_s].toString());
        QCOMPARE(performance::cardFootnote(r), c[u"footnote"_s].toString());
    }

    // main.js 的 image-export:控制字符、路径分隔符、Windows 保留字符换下划线;最多 60 个 UTF-16 码元;空了是「交易体检」
    void safeImageName() {
        QCOMPARE(performance::safeImageName(u"交易体检-2026-10-19"_s), u"交易体检-2026-10-19"_s);
        QCOMPARE(performance::safeImageName(u"a/b\\c:d*e?f\"g<h>i|j\tk"_s), u"a_b_c_d_e_f_g_h_i_j_k"_s);
        QCOMPARE(performance::safeImageName(QString()), u"交易体检"_s);
        QCOMPARE(performance::safeImageName(QString(70, u'x')).size(), 60);
        QCOMPARE(performance::safeImageName(u"../../etc"_s), u".._.._etc"_s);
    }

    // 仓位计算器起手的每份最大亏损:只算风险定了的蝶,排序后取 Math.floor(n / 2) 那一个(偶数个取靠上的那个)
    void typicalUnitRiskPicksUpperMedianOfButterflies() {
        const auto t = [](const char* kind, const QJsonValue& risk) { return QJsonObject{{u"kind"_s, QString::fromLatin1(kind)}, {u"risk"_s, risk}}; };
        QJsonObject r{{u"trades"_s, QJsonArray{t("butterfly", 4), t("butterfly", 1), t("stock", 100), t("butterfly", 3), t("butterfly", QJsonValue::Null), t("butterfly", 2)}}};
        QCOMPARE(performance::typicalUnitRisk(r), QJsonValue(3));
        r[u"trades"_s] = QJsonArray{t("butterfly", 5), t("butterfly", 9), t("butterfly", 7)};
        QCOMPARE(performance::typicalUnitRisk(r), QJsonValue(7));
        r[u"trades"_s] = QJsonArray{t("stock", 5)};
        QVERIFY(performance::typicalUnitRisk(r).isNull());
        // 风险不是数的(NaN)不算:进 sort 是未定义行为,也会把中位数挪走
        r[u"trades"_s] = QJsonArray{t("butterfly", u"abc"_s), t("butterfly", 4), t("butterfly", 6)};
        QCOMPARE(performance::typicalUnitRisk(r), QJsonValue(6));
    }
    // 份数向下取整前加 1e-9:0.3 / 0.1 在浮点里是 2.999…,要算成 3 份(sizing.ts 同样)
    void sizePositionToleratesFloatNoise() {
        const auto s = performance::sizePosition(10, 3, 0.1, 2);
        QVERIFY(s);
        QCOMPARE(s->units, 3.0);
    }
    // 样本偏少:不到 20 笔才写
    void footnoteBelowTwentyOnly() {
        const auto r = [](int n) { return QJsonObject{{u"stats"_s, QJsonObject{{u"trades"_s, n}}}}; };
        QCOMPARE(performance::cardFootnote(r(19)), u"样本 19 笔,偏少 · 本机代码计算 · 不含账户信息 · 不构成投资建议"_s);
        QCOMPARE(performance::cardFootnote(r(20)), u"本机代码计算 · 不含账户信息 · 不构成投资建议"_s);
    }
    // 区间整个在 0 的一边才上色:贴着 0(hi = 0 或 lo = 0)不算分清了
    void expectancyToneNeedsIntervalOffZero() {
        QJsonObject data;
        for (const QJsonValue& p : fixture()[u"pages"_s].toArray())
            if (p[u"name"_s].toString() == u"体检结果") data = p[u"seed"_s][u"data"_s].toObject();
        QVERIFY(!data.isEmpty());
        const auto tone = [&](double expectancy, double lo, double hi) {
            QJsonObject d = data;
            QJsonObject st = d[u"stats"_s].toObject();
            st[u"expectancy"_s] = expectancy;
            st[u"expectancy_ci"_s] = QJsonObject{{u"lo"_s, lo}, {u"hi"_s, hi}};
            d[u"stats"_s] = st;
            performance::PageInput in;
            in.data = d;
            return performance::pageModel(in)[u"stats"_s][u"tiles"_s].toArray()[1][u"tone"_s].toString();
        };
        QCOMPARE(tone(-3, -5, 0), QString());
        QCOMPARE(tone(3, 0, 5), QString());
        QCOMPARE(tone(-3, -5, -0.01), u"neg"_s);
        QCOMPARE(tone(3, 0.01, 5), u"pos"_s);
    }

    void charts_data() {
        QTest::addColumn<QJsonObject>("c");
        int i = 0;
        for (const QJsonValue& p : fixture()[u"charts"_s].toArray()) QTest::newRow(qPrintable(QString::number(i++))) << p.toObject();
    }
    void charts() {
        QFETCH(QJsonObject, c);
        QCOMPARE(performance::equityChart(c[u"input"_s]), c[u"chart"_s].isUndefined() ? QJsonValue(QJsonValue::Null) : c[u"chart"_s]);
    }
};

QTEST_GUILESS_MAIN(TestPerformanceRules)
#include "tst_performance_rules.moc"
