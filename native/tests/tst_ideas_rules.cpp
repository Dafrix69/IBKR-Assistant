// 「想法」(shell/ideas_rules)对着原版现算的期望值(tests/fixtures/gen_ideas.mjs,本机时区 Asia/Shanghai、时钟 2026-08-21 21:50):
//   14 个页面场景,整页的字、按钮(字与读着)、时间的悬停提示(fmtTime 的全写)、筛选的选中、「附带交易结果」勾没勾。
#include "shell/ideas_rules.h"

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
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/ideas.json"));
        if (!f.open(QIODevice::ReadOnly)) qFatal("ideas.json 打不开");
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

}  // namespace

class TestIdeasRules : public QObject {
    Q_OBJECT

private slots:
    void pages_data() {
        QTest::addColumn<int>("index");
        const QJsonArray pages = fixture()[u"pages"_s].toArray();
        QVERIFY(pages.size() >= 14);
        for (qsizetype i = 0; i < pages.size(); ++i) QTest::newRow(qPrintable(pages[i][u"name"_s].toString())) << int(i);
    }
    void pages() {
        QFETCH(int, index);
        const QJsonObject c = fixture()[u"pages"_s].toArray()[index].toObject();
        const QJsonObject seed = c[u"seed"_s].toObject();
        ideas::PageInput in;
        in.filter = seed.contains(u"filter"_s) ? seed[u"filter"_s].toString() : u"active"_s;
        in.ideas = seed[u"ideas"_s].toArray();
        in.loadError = seed[u"loadError"_s].toString();
        in.digests = seed[u"digests"_s].toArray();
        in.query = seed[u"query"_s].toString();
        in.matched = seed[u"matched"_s].toObject();
        for (const QJsonValue& id : seed[u"analyzing"_s].toArray()) in.analyzing.insert(id.toString());
        in.digesting = seed[u"digesting"_s].toBool();
        in.withTrades = seed.contains(u"withTrades"_s) ? seed[u"withTrades"_s].toBool() : true;
        in.nowMs = fixture()[u"now"_s].toDouble();
        in.zone = QTimeZone("Asia/Shanghai");
        const QJsonObject page = ideas::pageModel(in);
        QStringList want;
        for (const QJsonValue& x : c[u"texts"_s].toArray()) want << x.toString();
        compareTexts(normalize(ideas::pageTexts(page)), want);

        // 读着的按钮:总结、正在分析的那几张
        QStringList loading, wantLoading;
        for (const QJsonValue& b : c[u"buttons"_s].toArray())
            if (b[u"loading"_s].toBool()) wantLoading << b[u"text"_s].toString();
        if (in.digesting) loading << page[u"digestButton"_s].toString();
        for (const QJsonValue& card : page[u"cards"_s].toArray())
            if (card[u"active"_s].toBool() && card[u"analyzing"_s].toBool()) loading << card[u"analyzeLabel"_s].toString();
        QCOMPARE(loading, wantLoading);
        // 时间的悬停提示:总结那一行、每张卡片的时间、分析时间(照页面里的次序)
        QStringList titles;
        if (page[u"digest"_s].isObject())
            for (const QJsonValue& m : page[u"digest"_s][u"meta"_s].toArray())
                if (m.toObject().contains(u"title"_s)) titles << m[u"title"_s].toString();
        for (const QJsonValue& card : page[u"cards"_s].toArray()) {
            for (const QJsonValue& m : card[u"meta"_s].toArray())
                if (m.toObject().contains(u"title"_s)) titles << m[u"title"_s].toString();
            if (card[u"analysis"_s].isObject())
                for (const QJsonValue& m : card[u"analysis"_s][u"meta"_s].toArray())
                    if (m.toObject().contains(u"title"_s)) titles << m[u"title"_s].toString();
        }
        QStringList wantTitles;
        for (const QJsonValue& x : c[u"titles"_s].toArray()) wantTitles << x.toString();
        QCOMPARE(titles, wantTitles);
        QCOMPARE(c[u"segments"_s].toArray(), (QJsonArray{in.filter == u"active", in.filter == u"all"}));
        QCOMPARE(c[u"withTrades"_s].toBool(), page[u"withTrades"_s].toBool());
    }
};

QTEST_GUILESS_MAIN(TestIdeasRules)
#include "tst_ideas_rules.moc"
