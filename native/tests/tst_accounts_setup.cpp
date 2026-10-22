// 账户设置(shell/accounts_setup)对着原模块(desktop/accounts-setup.js)现算的结果逐条对:改完的配置(键次序、2 格缩进)、
// 确认框上的话、拒绝的那句;外加占位账户与连接选单;planChange / commitChange 在真文件上(.bak 是改动前的原文)。
#include "json_compare.h"
#include "shell/accounts_setup.h"

#include <QFile>
#include <QJsonDocument>
#include <QTemporaryDir>
#include <QTest>

using namespace ibkr;
using namespace ibkr::shell;
using namespace Qt::StringLiterals;


class TestAccountsSetup : public QObject {
    Q_OBJECT
private slots:
    void changesMatchJs() {
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/accounts-setup.json"));
        QVERIFY(f.open(QIODevice::ReadOnly));
        // 键次序要按原文:整份用保序的读法
        const OJson doc = *parseOJson(QString::fromUtf8(f.readAll()));
        QCOMPARE(int(doc.get(u"aliasMax"_s)->n), accounts::kAliasMax);
        const OJson& base = *doc.get(u"base"_s);
        int i = 0;
        for (const OJson& c : doc.get(u"cases"_s)->items) {
            const OJson& cfg = c.get(u"base"_s) ? *c.get(u"base"_s) : base;
            QString error;
            const auto plan = accounts::applyChange(cfg, *c.get(u"change"_s), &error);
            const bool ok = c.get(u"ok"_s)->b;
            QVERIFY2(bool(plan) == ok, qPrintable(u"#%1 %2"_s.arg(i).arg(error)));
            if (plan) {
                QCOMPARE(plan->headline, c.get(u"headline"_s)->s);
                QStringList want;
                for (const OJson& l : c.get(u"lines"_s)->items) want << l.s;
                QCOMPARE(plan->lines, want);
                QCOMPARE(stringifyOJson(plan->config, 2), c.get(u"config"_s)->s);
            } else {
                QCOMPARE(error, c.get(u"error"_s)->s);
            }
            ++i;
        }
        QStringList placeholders;
        for (const OJson& p : doc.get(u"placeholders"_s)->items) placeholders << p.s;
        QCOMPARE(accounts::placeholderAliases(base), placeholders);
        const QString d = test::jsonDiff(doc.get(u"choices"_s)->toQJson(), accounts::connectionChoices(base));
        QVERIFY2(d.isEmpty(), qPrintable(d));
    }

    void planAndCommitOnDisk() {
        QTemporaryDir dir;
        const QString cfg = dir.filePath(u"settings.json"_s);
        const QByteArray original = R"({
  "accounts": [{"alias": "实盘", "account_id": "U7654321", "is_paper": false, "connection": "live"}],
  "connections": {"live": {"port": 7496}}
})";
        QFile f(cfg);
        QVERIFY(f.open(QIODevice::WriteOnly));
        f.write(original);
        f.close();
        QString error;
        const auto plan = accounts::planChange(cfg, *parseOJson(uR"({"action":"upsert","alias":"新","account_id":"U1112223","is_paper":false,"connection":"live"})"_s), &error);
        QVERIFY2(plan, qPrintable(error));
        QVERIFY(accounts::commitChange(cfg, *plan));
        QFile bak(cfg + u".bak"_s);
        QVERIFY(bak.open(QIODevice::ReadOnly));
        QCOMPARE(bak.readAll(), original);
        QFile now(cfg);
        QVERIFY(now.open(QIODevice::ReadOnly));
        const QString text = QString::fromUtf8(now.readAll());
        QVERIFY(text.startsWith(u"{\n  \"accounts\": ["_s));  // 键次序没被排成 connections 在前
        QVERIFY(text.contains(u"\"alias\": \"新\""_s));
        // 文件坏了:拒绝,原文不动
        QVERIFY(f.open(QIODevice::WriteOnly));
        f.write("{");
        f.close();
        QVERIFY(!accounts::planChange(cfg, *parseOJson(uR"({"action":"remove","alias":"新"})"_s), &error));
        QVERIFY(error.startsWith(u"配置文件不是合法的 JSON,先修好它再改账户:"_s));
        QVERIFY(!accounts::planChange(dir.filePath(u"none.json"_s), OJson(), &error));
        QVERIFY(error.startsWith(u"配置文件读不了:"_s));
    }
};

QTEST_GUILESS_MAIN(TestAccountsSetup)
#include "tst_accounts_setup.moc"
