// 条款同意页的模型(shell/consent_model):读 docs/legal/ 真的三份文本、认版本号、同意只认现行版本。
#include "shell/consent_model.h"

#include <QSignalSpy>
#include <QTemporaryDir>
#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;

class TestConsentModel : public QObject {
    Q_OBJECT
private slots:
    void realLegalTextsAgreeWithTheEngineVersion() {
        const auto docs = shell::loadLegalDocs(QStringLiteral(IBKR_REPO_DIR "/docs/legal"));
        QCOMPARE(docs.size(), 3);
        for (const auto& d : docs) QVERIFY2(d.text.size() > 200, qPrintable(d.key));
        // 三份写的版本一致,而且就是现行版本(同 desktop-consent.spec 钉的那一条)
        QCOMPARE(shell::legalVersion(docs), QString::fromLatin1(shell::kTermsVersion));
    }
    void disagreeingOrMissingVersionIsEmpty() {
        QList<shell::LegalDoc> docs{{u"a"_s, u"A"_s, u"# x\n\n版本:2026-10-15\n"_s}, {u"b"_s, u"B"_s, u"版本:2026-10-14\n"_s}};
        QCOMPARE(shell::legalVersion(docs), QString());
        docs[1].text = u"没写版本"_s;
        QCOMPARE(shell::legalVersion(docs), QString());
        docs[1].text = u"版本: 2026-10-15  \n"_s;
        QCOMPARE(shell::legalVersion(docs), u"2026-10-15"_s);
    }
    void acceptRecordsAndSurvives() {
        QTemporaryDir dir;
        shell::ConsentStore store(dir.path());
        shell::ConsentModel model(&store, QStringLiteral(IBKR_REPO_DIR "/docs/legal"), u"0.6.0"_s);
        QVERIFY(!model.accepted());
        QSignalSpy changed(&model, &shell::ConsentModel::changed);
        model.accept();
        QVERIFY(model.accepted());
        QVERIFY(model.error().isEmpty());
        QVERIFY(changed.size() >= 1);
        QVERIFY(!model.acceptedAt().isEmpty());
        // 重开:记在文件里,另一个模型(或 Electron 版)读得到
        shell::ConsentModel again(&store, QStringLiteral(IBKR_REPO_DIR "/docs/legal"), u"0.6.0"_s);
        QVERIFY(again.accepted());
    }
    void cannotAcceptWhenTheTextsHaveNoVersion() {
        QTemporaryDir dir;
        shell::ConsentStore store(dir.path());
        shell::ConsentModel model(&store, dir.path() + u"/nonexistent"_s, u"x"_s);
        model.accept();
        QVERIFY(!model.accepted());
        QVERIFY(model.error().contains(u"读不出版本号"_s));
    }
    void viewingAndDeclining() {
        QTemporaryDir dir;
        shell::ConsentStore store(dir.path());
        shell::ConsentModel model(&store, QStringLiteral(IBKR_REPO_DIR "/docs/legal"), u"x"_s);
        QSignalSpy quit(&model, &shell::ConsentModel::quitRequested);
        model.showTerms();
        QVERIFY(model.viewing());
        model.hideTerms();
        QVERIFY(!model.viewing());
        model.decline();
        QCOMPARE(quit.size(), 1);
        QCOMPARE(model.docs().size(), 3);
    }
};

QTEST_GUILESS_MAIN(TestConsentModel)
#include "tst_consent_model.moc"
