// 条款文本解析器(shell/doc_parse)对着原模块(desktop/renderer-react/src/lib/docParse.ts)现算的结果:
// 三份真条款 + 专挑边界的几段(句号贴着的加粗、#### 不算标题、表格规则行、CRLF、全角空格)。逐块逐字一致。
#include "json_compare.h"
#include "shell/doc_parse.h"

#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;

class TestDocParse : public QObject {
    Q_OBJECT
private slots:
    void matchesTsModule_data() {
        QTest::addColumn<QString>("source");
        QTest::addColumn<QJsonArray>("expected");
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/doc-parse.json"));
        QVERIFY(f.open(QIODevice::ReadOnly));
        const QJsonArray cases = QJsonDocument::fromJson(f.readAll()).object().value(u"cases"_s).toArray();
        QVERIFY(cases.size() >= 8);
        for (const QJsonValue& c : cases) {
            const QJsonObject o = c.toObject();
            QTest::newRow(qPrintable(o.value(u"name"_s).toString())) << o.value(u"source"_s).toString() << o.value(u"blocks"_s).toArray();
        }
    }
    void matchesTsModule() {
        QFETCH(QString, source);
        QFETCH(QJsonArray, expected);
        const QJsonArray got = shell::docBlocksToJson(shell::parseDoc(source));
        const QString diff = test::jsonDiff(expected, got);
        QVERIFY2(diff.isEmpty(), qPrintable(diff));
    }

    // 富文本只有我们自己的标签:正文里的 < & " 一律转义,条款里写了 <script> 也只是几个字
    void htmlEscapesText() {
        const QString html = shell::docToHtml(shell::parseDoc(u"# A<b>\n- x & **<i>y</i>**\n\"q\""_s));
        QVERIFY2(html.contains(u"A&lt;b&gt;"_s) && html.contains(u"x &amp; <b>&lt;i&gt;y&lt;/i&gt;</b>"_s) && html.contains(u"&quot;q&quot;"_s), qPrintable(html));
        QVERIFY(!html.contains(u"<i>"_s));
    }
};

QTEST_GUILESS_MAIN(TestDocParse)
#include "tst_doc_parse.moc"
