// engine/util/v8json 对着 node 的 JSON.parse(tests/fixtures/gen_v8json.mjs):4119 份文本(手写的边角、几份真配置、对它们的随机损坏),
// 每一份报的话逐字相同,合法的报空;外加 parseOJson 收不收与它一致(两边对"什么算合法 JSON"不能有分歧)。
#include "util/ordered_json.h"
#include "util/v8json.h"

#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QTest>

using namespace ibkr::util;
using namespace Qt::StringLiterals;

class TestV8Json : public QObject {
    Q_OBJECT
private slots:
    void cases() {
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR) + u"/v8json.json"_s);
        QVERIFY(f.open(QIODevice::ReadOnly));
        // 用 parseOJson 读期望值:QJsonDocument 会吞掉字符串里的 U+FEFF
        const auto doc = parseOJson(QString::fromUtf8(f.readAll()));
        QVERIFY(doc);
        int n = 0, bad = 0;
        for (const OJson& c : doc->get(u"cases"_s)->items) {
            const QString t = c.get(u"t"_s)->s;
            const auto got = v8JsonParseError(t);
            const QString want = c.get(u"e"_s) ? c.get(u"e"_s)->s : QString();
            if (got.value_or(QString()) != want) qWarning().noquote() << "文本:" << QJsonDocument(QJsonArray{t}).toJson(QJsonDocument::Compact);
            QCOMPARE(got.value_or(QString()), want);
            if (parseOJson(t).has_value() == got.has_value()) qWarning().noquote() << "parseOJson 不一致:" << QJsonDocument(QJsonArray{t}).toJson(QJsonDocument::Compact) << want;
            QCOMPARE(parseOJson(t).has_value(), !got.has_value());
            ++n;
            bad += got ? 1 : 0;
        }
        QCOMPARE(n, 4119);
        QCOMPARE(bad, 3044);
    }
};

QTEST_GUILESS_MAIN(TestV8Json)
#include "tst_v8json.moc"
