// 价位条的排版(shell/level_strip)对着原文件 LevelStrip.tsx 的 buildLevelStripSvg 在假 DOM 里跑出来的元素树逐个比:
// 轴、断口、引线、刻度、现价点、每个标签的坐标与文字。量字宽两边用同一条固定规则。
#include "json_compare.h"
#include "shell/level_strip.h"
#include "shell/track_levels.h"

#include <QFile>
#include <QJsonDocument>
#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;

namespace {
/// 生成器那边 undefined 的 text 不写出来、空 children 是 []:把两边都整理成"有字才有 text"
QJsonValue normalize(const QJsonValue& v) {
    if (!v.isObject()) return v;
    QJsonObject o = v.toObject();
    if (o.value("text"_L1).toString().isEmpty()) o.remove(u"text"_s);
    QJsonArray kids;
    for (const QJsonValue& c : o.value("children"_L1).toArray()) kids.append(normalize(c));
    if (o.contains(u"children"_s)) o.insert(u"children"_s, kids);
    return o;
}
}  // namespace

class TestLevelStrip : public QObject {
    Q_OBJECT
private slots:
    void matchesTsModule_data() {
        QTest::addColumn<QJsonObject>("c");
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/level-strip.json"));
        QVERIFY(f.open(QIODevice::ReadOnly));
        const QJsonArray cases = QJsonDocument::fromJson(f.readAll()).object().value(u"cases"_s).toArray();
        QVERIFY(cases.size() >= 10);
        for (const QJsonValue& c : cases) QTest::newRow(qPrintable(c[u"name"].toString())) << c.toObject();
    }
    // 两张名字表(短名、全名)和 store/alerts.ts 里的整张一样:多一个、少一个都红
    void sourceNamesMatch() {
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/level-strip.json"));
        QVERIFY(f.open(QIODevice::ReadOnly));
        const QJsonObject o = QJsonDocument::fromJson(f.readAll()).object();
        for (const auto& [key, names] : {std::pair{u"short"_s, &shell::levels::sourceShort()}, std::pair{u"label"_s, &shell::levels::sourceLabel()}}) {
            const QJsonObject table = o.value(key).toObject();
            QCOMPARE(qsizetype(table.size()), names->size());
            for (auto it = table.begin(); it != table.end(); ++it) QCOMPARE(names->value(it.key()), it.value().toString());
        }
    }
    void matchesTsModule() {
        QFETCH(QJsonObject, c);
        const QJsonValue spotValue = c[u"spot"];
        const std::optional<double> spot = spotValue.isDouble() ? std::optional<double>(spotValue.toDouble()) : std::nullopt;
        const QJsonObject got = shell::levels::buildLevelStrip(c[u"levels"].toArray(), spot, c[u"width"].toDouble(), shell::levels::measureFixed);
        const QJsonValue expected = c[u"svg"].isNull() ? QJsonValue(QJsonObject()) : normalize(c[u"svg"]);
        const QString diff = test::jsonDiff(expected, normalize(got));
        QVERIFY2(diff.isEmpty(), qPrintable(diff));
    }
};

QTEST_GUILESS_MAIN(TestLevelStrip)
#include "tst_level_strip.moc"
