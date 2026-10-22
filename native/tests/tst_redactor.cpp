// 日志脱敏(shell/redactor)对着原模块(desktop/redact.js)现算的结果逐条对;外加 redactConfig 不改传进去的那一份。
#include "json_compare.h"
#include "shell/redactor.h"
#include "util/redact.h"

#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;

class TestRedactor : public QObject {
    Q_OBJECT
private slots:
    void matchesJsModule_data() {
        QTest::addColumn<QJsonObject>("c");
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/redact.json"));
        QVERIFY(f.open(QIODevice::ReadOnly));
        const QJsonArray cases = QJsonDocument::fromJson(f.readAll()).object().value(u"cases"_s).toArray();
        QVERIFY(cases.size() >= 90);
        int n = 0;
        for (const QJsonValue& c : cases) QTest::newRow(qPrintable(u"%1 #%2"_s.arg(c.toObject().value(u"fn"_s).toString()).arg(n++))) << c.toObject();
    }
    void matchesJsModule() {
        QFETCH(QJsonObject, c);
        const QString fn = c.value(u"fn"_s).toString();
        QJsonValue got;
        if (fn == u"redact") {
            QStringList accounts;
            for (const QJsonValue& a : c.value(u"accounts"_s).toArray()) accounts.append(a.toString());
            got = shell::Redactor(accounts, c.value(u"homedir"_s).toString())(c.value(u"input"_s).toString());
        } else if (fn == u"maskAccount") {
            got = util::maskAccount(c.value(u"input"_s).toString());
        } else if (fn == u"accountsFromConfig") {
            got = QJsonArray::fromStringList(shell::accountsFromConfig(c.value(u"input"_s)));
        } else if (fn == u"redactConfig") {
            const QJsonValue input = c.value(u"input"_s);
            const QByteArray before = QJsonDocument(input.toObject()).toJson();
            got = shell::redactConfig(input, c.value(u"homedir"_s).toString());
            QCOMPARE(QJsonDocument(input.toObject()).toJson(), before);
        }
        const QString diff = test::jsonDiff(c.value(u"out"_s), got);
        QVERIFY2(diff.isEmpty(), qPrintable(diff + u"\n输入 "_s + QString::fromUtf8(QJsonDocument(QJsonArray{c.value(u"input"_s)}).toJson(QJsonDocument::Compact))));
    }
};

QTEST_GUILESS_MAIN(TestRedactor)
#include "tst_redactor.moc"
