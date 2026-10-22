// engine/util/pyjson 对着原模块(engine-ts/src/pyjson.ts)现算的答案(tests/fixtures/gen_pyjson.mjs):prompts/ 下每一份真的 fewshot,
// 外加浮点记号、转义、宽松处、读不出的边角——pyDumps / pyDumpsSorted 逐字相同、toPlain 的值相同、读不出时的话相同。
#include "util/error.h"
#include "util/pyjson.h"

#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QTest>

using namespace ibkr::util;
using namespace Qt::StringLiterals;

class TestPyJson : public QObject {
    Q_OBJECT
private slots:
    void cases() {
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/pyjson.json"));
        QVERIFY(f.open(QIODevice::ReadOnly));
        const QJsonArray cases = QJsonDocument::fromJson(f.readAll()).object()[u"cases"_s].toArray();
        QVERIFY(cases.size() >= 40);
        for (const QJsonValue& v : cases) {
            const QJsonObject c = v.toObject();
            const QString name = c[u"name"_s].toString();
            if (c.contains(u"error"_s)) {
                try {
                    parseJson(c[u"text"_s].toString());
                    QFAIL(qPrintable(name + u":应当读不出"_s));
                } catch (const JsError& e) {
                    QCOMPARE(e.message(), c[u"error"_s].toString());
                }
                continue;
            }
            const JVal parsed = parseJson(c[u"text"_s].toString());
            QCOMPARE(pyDumps(parsed), c[u"dumps"_s].toString());
            QCOMPARE(pyDumpsSorted(parsed), c[u"sorted"_s].toString());
            const QJsonValue plain = toPlain(parsed);
            const QJsonValue want = QJsonDocument::fromJson(u"[%1]"_s.arg(c[u"plain"_s].toString()).toUtf8()).array().at(0);
            QVERIFY2(plain == want, qPrintable(name));
        }
    }
};

QTEST_GUILESS_MAIN(TestPyJson)
#include "tst_pyjson.moc"
