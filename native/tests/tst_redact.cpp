// 遮账号:用例照抄 engine-ts/tests/desktop-redact.spec.ts(规则同 desktop/redact.js)。
#include "util/redact.h"

#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;

class TestRedact : public QObject {
    Q_OBJECT
private slots:
    void maskOneAccount() {
        QCOMPARE(util::maskAccount(u"DU7654321"_s), u"DU***321"_s);
        QCOMPARE(util::maskAccount(u"U1234567"_s), u"U***567"_s);
        QCOMPARE(util::maskAccount(u"28190044"_s), u"***044"_s);
        QCOMPARE(util::maskAccount(u"U1234"_s), u"***"_s);
        QCOMPARE(util::maskAccountList(u"U1234567,DU7654321"_s), u"U***567,DU***321"_s);
    }
    void maskAccountLikeIdsInText() {
        QCOMPARE(util::maskAccountLikeIds(u"managedAccounts: U9988776,DU1122334,F5566778"_s), u"managedAccounts: U***776,DU***334,F***778"_s);
        // 不误伤:订单号、行权价、日期、小写十六进制
        const QString clean = u"orderId 12345678 strike 7450 expiry 20260928 ref f1234567"_s;
        QCOMPARE(util::maskAccountLikeIds(clean), clean);
        QCOMPARE(util::maskAccountLikeIds(u"账户 U1234567 的保证金不足"_s), u"账户 U***567 的保证金不足"_s);
    }
};

QTEST_GUILESS_MAIN(TestRedact)
#include "tst_redact.moc"
