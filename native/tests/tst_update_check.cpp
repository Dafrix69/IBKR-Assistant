// 新版本检查(shell/update_check)对着原模块(desktop/update-check.js)现算的结果逐条对:版本比较(18 × 18)、
// 安装包挑选(链接只认本仓库)、发布说明的纯文本、整条 release 的摘要。
#include "json_compare.h"
#include "shell/update_check.h"

#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QTest>

using namespace ibkr;
using namespace ibkr::shell;
using namespace Qt::StringLiterals;

class TestUpdateCheck : public QObject {
    Q_OBJECT
private slots:
    void matchesJs() {
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/update-check.json"));
        QVERIFY(f.open(QIODevice::ReadOnly));
        const QJsonObject doc = QJsonDocument::fromJson(f.readAll()).object();
        QCOMPARE(doc.value(u"releasesPage"_s).toString(), update::kReleasesPage);
        QCOMPARE(doc.value(u"latestApi"_s).toString(), update::kLatestApi);
        for (const QJsonValue& v : doc.value(u"compare"_s).toArray()) {
            const QJsonObject c = v.toObject();
            const auto got = update::compareVersions(c.value(u"a"_s), c.value(u"b"_s));
            QVERIFY2((got ? QJsonValue(*got) : QJsonValue()) == c.value(u"out"_s),
                     qPrintable(u"%1 vs %2"_s.arg(c.value(u"a"_s).toVariant().toString(), c.value(u"b"_s).toVariant().toString())));
        }
        for (const QJsonValue& v : doc.value(u"parse"_s).toArray()) {
            const QJsonObject c = v.toObject();
            const auto got = update::parseVersion(c.value(u"v"_s));
            QJsonValue g;
            if (got) g = QJsonObject{{u"nums"_s, QJsonArray{got->nums[0], got->nums[1], got->nums[2]}}, {u"pre"_s, got->pre}};
            const QString d = test::jsonDiff(c.value(u"out"_s), g);
            QVERIFY2(d.isEmpty(), qPrintable(d));
        }
        for (const QJsonValue& v : doc.value(u"pick"_s).toArray()) {
            const QJsonObject c = v.toObject();
            const QJsonValue assets = c.value(u"assetsNotArray"_s).toBool() ? QJsonValue(u"nope"_s) : doc.value(u"assets"_s);
            const QString d = test::jsonDiff(c.value(u"out"_s), update::assetFor(assets, c.value(u"platform"_s).toString(), c.value(u"arch"_s).toString()));
            QVERIFY2(d.isEmpty(), qPrintable(d));
        }
        for (const QJsonValue& v : doc.value(u"plain"_s).toArray()) QCOMPARE(update::plainNotes(v[u"body"]), v[u"out"].toString());
        for (const QJsonValue& v : doc.value(u"summaries"_s).toArray()) {
            const QJsonObject c = v.toObject();
            const QString d = test::jsonDiff(c.value(u"out"_s), update::summarizeRelease(c.value(u"release"_s), c.value(u"current"_s).toString(), u"darwin"_s, u"arm64"_s, doc.value(u"now"_s).toDouble()));
            QVERIFY2(d.isEmpty(), qPrintable(d));
        }
    }
};

QTEST_GUILESS_MAIN(TestUpdateCheck)
#include "tst_update_check.moc"
