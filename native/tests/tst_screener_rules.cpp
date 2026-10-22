// 「扫描」(shell/screener_rules)对着原版现算的期望值(tests/fixtures/gen_screener.mjs,本机时区 Asia/Shanghai):
//   · 23 个页面场景:整页的字、表的行(次序、打开的那一行、压暗)、RS 格(着色、--heat、悬停)、信号胶囊(种类、悬停)、表头的排序箭头、
//     基准与筛选的选中、周期标签勾没勾、趋势模板的小点、标签卡的柱高、读着的按钮;
//   · 极值偏离的两张图(原文 useMemo 切出来跑):JSON 那一份逐字段比。
#include "shell/screener_rules.h"

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
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/screener.json"));
        if (!f.open(QIODevice::ReadOnly)) qFatal("screener.json 打不开");
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

screener::PageInput inputOf(const QJsonObject& c) {
    const QJsonObject seed = c[u"seed"_s].toObject(), local = c[u"local"_s].toObject();
    screener::PageInput in;
    in.sectors = c[u"sectors"_s].toArray();
    in.sector = local.contains(u"dafri-screener-sector"_s) ? local[u"dafri-screener-sector"_s].toString() : u"all"_s;
    if (seed[u"sort"_s].isObject()) {
        in.sortKey = seed[u"sort"_s][u"key"_s].toString();
        in.sortOrder = seed[u"sort"_s][u"order"_s].toString();
    }
    if (seed.contains(u"benchmark"_s)) in.benchmark = seed[u"benchmark"_s].toString();
    if (seed.contains(u"timeframes"_s)) {
        in.timeframes.clear();
        for (const QJsonValue& t : seed[u"timeframes"_s].toArray()) in.timeframes << t.toString();
    }
    if (seed.contains(u"ma"_s)) in.ma = seed[u"ma"_s];
    in.busy = seed[u"scanBusy"_s].toBool();
    in.progress = seed[u"progress"_s].toString();
    in.rs = seed.contains(u"rs"_s) ? seed[u"rs"_s] : QJsonValue(QJsonValue::Null);
    in.infl = seed.contains(u"infl"_s) ? seed[u"infl"_s] : QJsonValue(QJsonValue::Null);
    in.dev.symbol = seed[u"devSymbol"_s].toString();
    in.dev.free = seed[u"devFree"_s].toString();
    if (seed.contains(u"devTf"_s)) in.dev.timeframe = seed[u"devTf"_s].toString();
    in.dev.busy = seed[u"devBusy"_s].toBool();
    in.dev.result = seed.contains(u"dev"_s) ? seed[u"dev"_s] : QJsonValue(QJsonValue::Null);
    in.dev.status = seed[u"devStatus"_s].toString();
    in.leaders = seed.contains(u"leaders"_s) ? seed[u"leaders"_s] : QJsonValue(QJsonValue::Null);
    in.leadersBusy = seed[u"leadersBusy"_s].toBool();
    in.leadersError = seed[u"leadersError"_s].toString();
    if (seed.contains(u"leadersFilter"_s)) in.leadersFilter = seed[u"leadersFilter"_s].toString();
    in.nowMs = fixture()[u"now"_s].toDouble();
    in.zone = QTimeZone("Asia/Shanghai");
    return in;
}

}  // namespace

class TestScreenerRules : public QObject {
    Q_OBJECT

private slots:
    void pages_data() {
        QTest::addColumn<int>("index");
        const QJsonArray pages = fixture()[u"pages"_s].toArray();
        QVERIFY(pages.size() >= 20);
        for (qsizetype i = 0; i < pages.size(); ++i) QTest::newRow(qPrintable(pages[i][u"name"_s].toString())) << int(i);
    }
    void pages() {
        QFETCH(int, index);
        const QJsonObject c = fixture()[u"pages"_s].toArray()[index].toObject();
        const screener::PageInput in = inputOf(c);
        const QJsonObject page = screener::pageModel(in);
        QStringList want;
        for (const QJsonValue& x : c[u"texts"_s].toArray()) want << x.toString();
        compareTexts(normalize(screener::pageTexts(page)), want);

        // 表的行:次序、打开的那一行、压暗;接着是强势股那张表的行(只有代码)
        QJsonArray rows;
        for (const QJsonValue& r : page[u"table"_s][u"rows"_s].toArray())
            rows.append(QJsonObject{{u"key"_s, r[u"symbol"_s]}, {u"open"_s, r[u"open"_s]}, {u"dim"_s, r[u"dim"_s]}});
        if (page[u"leaders"_s][u"data"_s].isObject())
            for (const QJsonValue& r : page[u"leaders"_s][u"data"_s][u"rows"_s].toArray())
                rows.append(QJsonObject{{u"key"_s, r[u"symbol"_s]}, {u"open"_s, false}, {u"dim"_s, false}});
        QCOMPARE(rows, c[u"rows"_s].toArray());

        // RS 格:每行的各窗口 + 综合
        QJsonArray cells;
        const QJsonArray columns = page[u"table"_s][u"columns"_s].toArray();
        for (const QJsonValue& r : page[u"table"_s][u"rows"_s].toArray())
            for (const QJsonValue& col : columns) {
                const QString key = col[u"key"_s].toString();
                if (!key.startsWith(u'w') && key != u"score") continue;
                const QJsonObject x = r[u"cells"_s][key].toObject();
                cells.append(QJsonObject{{u"cls"_s, (x[u"sorted"_s].toBool() ? u"ant-table-column-sort "_s : QString()) + u"rs-cell "_s + x[u"cls"_s].toString()}, {u"heat"_s, x.contains(u"heat"_s) ? x[u"heat"_s] : QJsonValue(QJsonValue::Null)},
                                         {u"title"_s, x[u"title"_s].toString()}});
            }
        QCOMPARE(cells, c[u"rsCells"_s].toArray());

        // 信号胶囊(表里的,再加强势股表里的 VCP 与「拿不到」)
        QJsonArray sigs;
        for (const QJsonValue& r : page[u"table"_s][u"rows"_s].toArray()) {
            for (const QJsonValue& col : columns) {
                const QString key = col[u"key"_s].toString();
                const QJsonObject x = r[u"cells"_s][key].toObject();
                if (key == u"last" && x[u"err"_s].toBool()) sigs.append(QJsonObject{{u"cls"_s, u"sig err"_s}, {u"title"_s, x[u"title"_s]}});
                if (!key.startsWith(u"tf:"_s)) continue;
                const QString kind = x[u"kind"_s].toString();
                sigs.append(QJsonObject{{u"cls"_s, kind == u"sig" ? u"sig "_s + x[u"cls"_s].toString() : u"sig "_s + kind}, {u"title"_s, x[u"title"_s].toString()}});
            }
        }
        if (page[u"leaders"_s][u"data"_s].isObject())
            for (const QJsonValue& r : page[u"leaders"_s][u"data"_s][u"rows"_s].toArray()) {
                if (!r[u"error"_s].toString().isEmpty()) sigs.append(QJsonObject{{u"cls"_s, u"sig err"_s}, {u"title"_s, r[u"error"_s]}});
                const QJsonObject v = r[u"vcp"_s].toObject();
                if (v[u"found"_s].toBool()) sigs.append(QJsonObject{{u"cls"_s, v[u"bull"_s].toBool() ? u"sig bull"_s : u"sig none"_s}, {u"title"_s, u""_s}});
            }
        QCOMPARE(sigs, c[u"sigs"_s].toArray());

        // 表头的排序箭头
        QJsonArray orders;
        for (const QJsonValue& col : columns)
            if (!col[u"order"_s].toString().isEmpty()) orders.append(col[u"order"_s] == u"ascend"_s ? u"ascending"_s : u"descending"_s);
        QCOMPARE(orders, c[u"sortOrders"_s].toArray());

        // Segmented:基准、强势股的筛选(有数据时)
        QJsonArray segs{page[u"benchmark"_s] == u"SPY"_s, page[u"benchmark"_s] == u"QQQ"_s};
        if (page[u"leaders"_s][u"data"_s].isObject())
            for (const QJsonValue& s : page[u"leaders"_s][u"data"_s][u"segments"_s].toArray()) segs.append(s[u"value"_s] == page[u"leaders"_s][u"filter"_s]);
        QCOMPARE(segs, c[u"segments"_s].toArray());
        QJsonArray tfs;
        for (const QJsonValue& t : page[u"timeframes"_s].toArray()) tfs.append(t[u"checked"_s]);
        QCOMPARE(tfs, c[u"tfChecked"_s].toArray());

        // 趋势模板的小点与标签卡的柱
        QJsonArray dots;
        if (page[u"leaders"_s][u"data"_s].isObject())
            for (const QJsonValue& r : page[u"leaders"_s][u"data"_s][u"rows"_s].toArray())
                for (const QJsonValue& d : r[u"dots"_s].toArray()) dots.append(d);
        QCOMPARE(dots, c[u"dots"_s].toArray());
        QJsonArray bars;
        for (const QJsonValue& card : page[u"tagCards"_s][u"cards"_s].toArray())
            for (const QJsonValue& b : card[u"bars"_s].toArray())
                if (b[u"pos"_s].toBool() || b[u"neg"_s].toBool()) bars.append(QJsonObject{{u"cls"_s, b[u"pos"_s].toBool() ? u"pos"_s : u"neg"_s}, {u"h"_s, b[u"h"_s]}});
        QCOMPARE(bars, c[u"bars"_s].toArray());

        // 读着的按钮:扫描、强势股、复盘
        QStringList loading, wantLoading;
        for (const QJsonValue& b : c[u"buttons"_s].toArray())
            if (b[u"loading"_s].toBool()) wantLoading << b[u"text"_s].toString();
        if (page[u"busy"_s].toBool()) loading << u"扫描"_s;
        if (page[u"leaders"_s][u"busy"_s].toBool()) loading << u"筛选强势股"_s;
        if (page[u"dev"_s][u"busy"_s].toBool()) loading << u"复盘"_s;
        QCOMPARE(loading, wantLoading);
    }

    void charts_data() {
        QTest::addColumn<int>("index");
        const QJsonArray charts = fixture()[u"charts"_s].toArray();
        for (qsizetype i = 0; i < charts.size(); ++i) QTest::newRow(qPrintable(QString::number(i))) << int(i);
    }
    void charts() {
        QFETCH(int, index);
        const QJsonObject c = fixture()[u"charts"_s].toArray()[index].toObject();
        const QJsonValue got = screener::devCharts(c[u"input"_s]);
        const QJsonValue want = c[u"charts"_s];
        if (want.isNull()) {
            QVERIFY(got.isNull());
            return;
        }
        for (const QString& k : {u"dev"_s, u"pressure"_s})
            for (const QString& f : want[k].toObject().keys()) QVERIFY2(got[k][f] == want[k][f], qPrintable(k + u'.' + f));
    }
};

QTEST_GUILESS_MAIN(TestScreenerRules)
#include "tst_screener_rules.moc"
