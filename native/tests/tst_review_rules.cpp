// 「交易分析」(shell/review_rules)对着原版现算的期望值(tests/fixtures/gen_review.mjs,本机时区 Asia/Shanghai):
//   · 28 个页面场景:整页的字(候选的各种写法、结果的各种形态)、卡片的状态色、瓦片的着色、着色的数、按钮(读着)、开关、类型分段、EM 框点不点得动;
//   · 三张图(原文 useMemo 切出来跑):JSON 那一份逐字段比。
#include "shell/review_rules.h"

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
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/review.json"));
        if (!f.open(QIODevice::ReadOnly)) qFatal("review.json 打不开");
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

review::PageInput inputOf(const QJsonObject& c) {
    const QJsonObject seed = c[u"seed"_s].toObject(), local = c[u"local"_s].toObject();
    review::PageInput in;
    in.candidates = seed[u"candidates"_s].toArray();
    in.selected = local[u"dafri-review-record"_s].toString();
    if (local.contains(u"dafri-review-timeframe"_s)) in.timeframe = local[u"dafri-review-timeframe"_s].toString();
    if (local.contains(u"dafri-review-kind"_s)) in.kind = local[u"dafri-review-kind"_s].toString();
    // Number(read('dafri-review-em-manual')) || null
    const double em = local[u"dafri-review-em-manual"_s].toString().toDouble();
    in.em = em ? QJsonValue(em) : QJsonValue(QJsonValue::Null);
    in.includeLocal = seed[u"includeLocal"_s].toBool();
    if (seed.contains(u"freshness"_s)) in.freshness = seed[u"freshness"_s].toString();
    in.available = seed.contains(u"available"_s) ? seed[u"available"_s] : QJsonValue(QJsonValue::Null);
    in.data = seed.contains(u"data"_s) ? seed[u"data"_s] : QJsonValue(QJsonValue::Null);
    in.error = seed[u"error"_s].toString();
    in.loading = seed[u"loading"_s].toBool();
    in.nowMs = fixture()[u"now"_s].toDouble();
    in.zone = QTimeZone("Asia/Shanghai");
    return in;
}

}  // namespace

class TestReviewRules : public QObject {
    Q_OBJECT
private slots:
    void pages_data() {
        QTest::addColumn<QJsonObject>("c");
        for (const QJsonValue& p : fixture()[u"pages"_s].toArray()) QTest::newRow(qPrintable(p[u"name"_s].toString())) << p.toObject();
    }
    void pages() {
        QFETCH(QJsonObject, c);
        const QJsonObject page = review::pageModel(inputOf(c));
        QStringList expected;
        for (const QJsonValue& t : c[u"texts"_s].toArray()) expected << t.toString();
        compareTexts(normalize(review::pageTexts(page)), expected);

        const QJsonObject r = page[u"result"_s].toObject();
        // 卡片的状态色(文档次序):本地提醒、两张图、止盈策略(内里的「不能回放」)、结论卡片;股票:一张图、结论卡片;分析失败
        QStringList cards;
        if (!page[u"error"_s].toString().isEmpty()) cards << u"bad"_s;
        if (!r.isEmpty()) {
            if (r[u"local"_s].toBool()) cards << u"warn"_s;
            cards << u"info"_s;
            if (r[u"exitPlan"_s].isObject()) {
                cards << u"info"_s << u"info"_s;
                if (r[u"exitPlan"_s].toObject().contains(u"notApplicable"_s)) cards << u"warn"_s;
            }
            for (const QJsonValue& f : r[u"findings"_s].toArray()) cards << f[u"tone"_s].toString();
        }
        QStringList want;
        for (const QJsonValue& v : c[u"cards"_s].toArray()) want << v.toString();
        QCOMPARE(cards, want);
        // 瓦片的着色
        QStringList tiles, wantTiles;
        for (const QJsonValue& x : r[u"tiles"_s].toArray()) tiles << x[u"tone"_s].toString();
        for (const QJsonValue& x : c[u"tiles"_s].toArray()) wantTiles << x.toString();
        QCOMPARE(tiles, wantTiles);
        // 着色的数(止盈策略那几张表)
        QJsonArray nums;
        const auto cell = [](const QJsonValue& v) { return QJsonObject{{u"cls"_s, (u"num "_s + v[u"tone"_s].toString()).trimmed()}, {u"text"_s, v[u"text"_s]}}; };
        if (r[u"exitPlan"_s].isObject()) {
            const QJsonObject ep = r[u"exitPlan"_s].toObject();
            for (const QJsonValue& l : ep[u"levels"_s].toArray()) nums << cell(l[u"perContract"_s]) << cell(l[u"expected"_s]);
            for (const QJsonValue& o : ep[u"outcomes"_s].toArray()) nums << cell(o[u"v"_s]);
            for (const QJsonValue& e : ep[u"events"_s].toArray()) nums << cell(e[u"pnl"_s]);
        }
        QCOMPARE(nums, c[u"nums"_s].toArray());
        // 按钮:同步成交、分析(读着)、开关本身(AntD Switch 也是一个没字的 button)
        QJsonArray buttons{QJsonObject{{u"text"_s, u"同步成交"_s}, {u"loading"_s, false}, {u"disabled"_s, false}},
                           QJsonObject{{u"text"_s, u"分析"_s}, {u"loading"_s, page[u"loading"_s].toBool()}, {u"disabled"_s, false}},
                           QJsonObject{{u"text"_s, QString()}, {u"loading"_s, false}, {u"disabled"_s, false}}};
        QCOMPARE(buttons, c[u"buttons"_s].toArray());
        // 开关、类型分段、EM 框
        QCOMPARE(c[u"switches"_s].toArray(), QJsonArray{page[u"includeLocal"_s].toBool()});
        QJsonArray segs;
        for (const QJsonValue& k : page[u"kinds"_s].toArray()) segs << (k[u"value"_s] == page[u"kind"_s]);
        QCOMPARE(c[u"segments"_s].toArray(), segs);
        const QJsonObject emInput = c[u"inputs"_s].toArray().last().toObject();
        QCOMPARE(emInput[u"disabled"_s].toBool(), page[u"emDisabled"_s].toBool());
        // 步长 0.5:至少一位小数(同 rc-input-number)
        const auto emText = [](double v) { const QString s = QString::number(v, 'g', 15); return s.contains(u'.') ? s : s + u".0"_s; };
        QCOMPARE(emInput[u"value"_s].toString(), page[u"em"_s].isNull() ? QString() : emText(page[u"em"_s].toDouble()));
    }

    void charts_data() {
        QTest::addColumn<QJsonObject>("c");
        int i = 0;
        for (const QJsonValue& p : fixture()[u"charts"_s].toArray()) QTest::newRow(qPrintable(p[u"kind"_s].toString() + QString::number(i++))) << p.toObject();
    }
    void charts() {
        QFETCH(QJsonObject, c);
        const QString kind = c[u"kind"_s].toString();
        const QJsonValue got = kind == u"stock" ? review::stockChart(c[u"input"_s]) : kind == u"underlying" ? review::underlyingChart(c[u"input"_s]) : review::flyChart(c[u"input"_s]);
        QCOMPARE(got, c[u"chart"_s].isUndefined() ? QJsonValue(QJsonValue::Null) : c[u"chart"_s]);
    }
};

QTEST_GUILESS_MAIN(TestReviewRules)
#include "tst_review_rules.moc"
