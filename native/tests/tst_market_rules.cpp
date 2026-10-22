// 「行情」(shell/market_rules)对着原版现算的期望值(tests/fixtures/gen_market.mjs):
//   · 34 个页面场景,整页的字(SSR 渲染原页面抽字)、两个输入框的值、按钮(字、读着)、开关、三块参考资料开没开、周期下拉显示的那一档;
//   · lib/chart/paSpec.ts 翻出来的图(JSON 那一份逐字段比,顶部的均线读数按每一根比)。
#include "shell/market_rules.h"
#include "shell/pa_spec.h"

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
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/market.json"));
        if (!f.open(QIODevice::ReadOnly)) qFatal("market.json 打不开");
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

std::optional<bool> primer(const QJsonObject& local, const QString& id) {
    const QJsonValue v = local[u"dafri-primer-"_s + id];
    if (v.isUndefined()) return std::nullopt;
    return v.toString() == u"1";
}

market::PageInput inputOf(const QJsonObject& c) {
    const QJsonObject seed = c[u"seed"_s].toObject(), local = c[u"local"_s].toObject();
    market::PageInput in;
    in.symbol = local[u"dafri-pa-symbol"_s].toString();
    in.timeframe = local.contains(u"dafri-pa-timeframe"_s) ? local[u"dafri-pa-timeframe"_s].toString() : u"5m"_s;
    in.rth = local[u"dafri-pa-rth"_s].toString() == u"1";
    in.timeframes = c[u"timeframes"_s].toArray();
    in.data = seed.contains(u"pa"_s) ? seed[u"pa"_s] : QJsonValue(QJsonValue::Null);
    in.error = seed[u"paError"_s].toString();
    in.loading = seed[u"paLoading"_s].toBool();
    in.comment = seed.contains(u"comment"_s) ? seed[u"comment"_s] : QJsonValue(QJsonValue::Null);
    in.commenting = seed[u"commenting"_s].toBool();
    in.books = market::readSymbols(local[u"dafri-book-symbols"_s].toString());
    in.bookData = seed[u"books"_s].toObject();
    for (const QJsonValue& s : seed[u"bookLoading"_s].toArray()) in.bookLoading.insert(s.toString());
    in.introOpen = primer(local, u"intro-pa"_s);
    in.legendOpen = primer(local, u"pa-legend-primer"_s);
    in.bookPrimerOpen = primer(local, u"book-primer"_s);
    return in;
}

}  // namespace

class TestMarketRules : public QObject {
    Q_OBJECT

private slots:
    void pages_data() {
        QTest::addColumn<int>("index");
        const QJsonArray pages = fixture()[u"pages"_s].toArray();
        QVERIFY(pages.size() >= 30);
        for (qsizetype i = 0; i < pages.size(); ++i) QTest::newRow(qPrintable(pages[i][u"name"_s].toString())) << int(i);
    }
    void pages() {
        QFETCH(int, index);
        const QJsonObject c = fixture()[u"pages"_s].toArray()[index].toObject();
        const market::PageInput in = inputOf(c);
        const QJsonObject page = market::pageModel(in);
        QStringList want;
        for (const QJsonValue& x : c[u"texts"_s].toArray()) want << x.toString();
        compareTexts(normalize(market::pageTexts(page)), want);

        // 两个输入框:标的(本机记着的)与「再盯一个」(空)
        const QJsonArray inputs = c[u"inputs"_s].toArray();
        QCOMPARE(inputs.size(), 2);
        QCOMPARE(inputs[0][u"value"_s].toString(), page[u"symbol"_s].toString());
        QCOMPARE(inputs[1][u"value"_s].toString(), QString());
        // 只看正常时段的开关
        QCOMPARE(c[u"switches"_s].toArray(), QJsonArray{page[u"rth"_s].toBool()});
        // 参考资料:数据来源、图例、读盘常识(展开的那几块)
        QCOMPARE(c[u"primers"_s].toArray(), (QJsonArray{page[u"introOpen"_s].toBool(), page[u"legendOpen"_s].toBool(), page[u"books"_s][u"primerOpen"_s].toBool()}));
        // 按钮:读着的那几个(分析、盘口刷新、AI 解读、卡片上的刷新),「全部刷新」能不能点
        QStringList loading, want2;
        for (const QJsonValue& b : c[u"buttons"_s].toArray()) {
            if (b[u"loading"_s].toBool()) want2 << b[u"text"_s].toString();
            if (b[u"text"_s] == u"全部刷新"_s) QCOMPARE(b[u"disabled"_s].toBool(), page[u"books"_s][u"refreshAllDisabled"_s].toBool());
        }
        if (in.loading) loading << u"分析"_s;
        const QJsonObject pa = page[u"pa"_s].toObject();
        if (pa[u"book"_s][u"loading"_s].toBool()) loading << u"刷新"_s;
        if (pa[u"ai"_s][u"loading"_s].toBool()) loading << pa[u"ai"_s][u"button"_s].toString();
        for (const QJsonValue& card : page[u"books"_s][u"cards"_s].toArray())
            if (card[u"loading"_s].toBool()) loading << u"读取中…"_s;
        QCOMPARE(loading, want2);
    }

    void specs_data() {
        QTest::addColumn<int>("index");
        const QJsonArray specs = fixture()[u"specs"_s].toArray();
        for (qsizetype i = 0; i < specs.size(); ++i) QTest::newRow(qPrintable(specs[i][u"name"_s].toString())) << int(i);
    }
    void specs() {
        QFETCH(int, index);
        const QJsonObject c = fixture()[u"specs"_s].toArray()[index].toObject();
        const QJsonObject got = pa::specJson(c[u"input"_s]);
        const QJsonObject want = c[u"spec"_s].toObject();
        for (const QString& k : want.keys()) QVERIFY2(got.value(k) == want.value(k), qPrintable(k));
        QCOMPARE(got.keys(), want.keys());
        const chart::Spec s = pa::spec(c[u"input"_s]);
        if (c[u"header"_s].isNull()) {
            QVERIFY(!s.header);
            return;
        }
        QVERIFY(bool(s.header));
        chart::Helpers h;
        h.fmt = [](double v) { return jsToFixed(v, 2); };
        const QJsonArray rows = c[u"header"_s].toArray();
        for (qsizetype i = 0; i < rows.size(); ++i) {
            QJsonArray parts;
            const std::optional<chart::Parts> row = s.header(int(i), h);
            QVERIFY(row.has_value());
            for (const auto& [text, color] : *row) parts.append(QJsonArray{text, color});
            QVERIFY2(parts == rows[i].toArray(), qPrintable(u"第 %1 根"_s.arg(i)));
        }
    }

    void readSymbols() {
        QCOMPARE(market::readSymbols(QString()), QStringList{});
        QCOMPARE(market::readSymbols(u"not json"_s), QStringList{});
        QCOMPARE(market::readSymbols(u"{\"a\":1}"_s), QStringList{});
        QCOMPARE(market::readSymbols(u"[1,\"spy\",null,true]"_s), (QStringList{u"1"_s, u"spy"_s, u"null"_s, u"true"_s}));
    }
};

QTEST_GUILESS_MAIN(TestMarketRules)
#include "tst_market_rules.moc"
