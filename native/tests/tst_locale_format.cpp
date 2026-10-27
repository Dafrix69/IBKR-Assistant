// JS 的数值换算与千分位写法:界面这边几处照 JS 的口径显示数字。
#include "shell/jsvalue.h"
#include "shell/locale_format.h"

#include <QJsonValue>
#include <QTest>

#include <cmath>

using namespace ibkr;
using namespace Qt::StringLiterals;

class TestLocaleFormat : public QObject {
    Q_OBJECT
private slots:
    void jsNumberAndStringBasics() {
        QCOMPARE(shell::jsNumber(QJsonValue(u""_s)), 0.0);
        QVERIFY(std::isnan(shell::jsNumber(QJsonValue(QJsonValue::Undefined))));
        QCOMPARE(shell::jsNumber(QJsonValue(QJsonValue::Null)), 0.0);
        QCOMPARE(shell::jsNumber(QJsonValue(u" 0x1F40 "_s)), 8000.0);
        QVERIFY(std::isnan(shell::jsNumber(QJsonValue(u"1,000"_s))));
        QCOMPARE(shell::jsString(QJsonValue(0.1)), u"0.1"_s);
        QCOMPARE(shell::jsNumberToString(1e21), u"1e+21"_s);
        QCOMPARE(shell::jsNumberToString(-1.5e-7), u"-1.5e-7"_s);
        QCOMPARE(shell::formatEnUs(1.005, 2), u"1.01"_s);
        QCOMPARE(shell::formatEnUs(-1234567.891, 2), u"-1,234,567.89"_s);
    }
};

QTEST_GUILESS_MAIN(TestLocaleFormat)
#include "tst_locale_format.moc"
