// 「支持与数据」(app/support_service):对着假引擎、临时目录与本机的假 GitHub。
// 导出诊断(取消、引擎不在也导得出、整份脱敏)、改账户(先问、写盘留 .bak、重启引擎;不合规的不问就拒)、
// 从备份恢复交易库(先让引擎留一份、停引擎、换库、再拉起)、检查新版本(各种 HTTP 结局、超时、十分钟缓存)、打开所在位置。
#include "shell/alerter.h"
#include "shell/engine_supervisor.h"
#include "shell/log_file.h"
#include "shell_harness.h"
#include "support_service.h"

#include <QDir>
#include <QFile>
#include <QJsonArray>
#include <QTcpServer>
#include <QTcpSocket>
#include <QTemporaryDir>

using namespace ibkr;
using namespace ibkr::test;
using namespace Qt::StringLiterals;

namespace {

struct Result {
    bool done = false;
    QJsonObject value;
    QString error;
    app::SupportService::Done cb() {
        return [this](const QJsonObject& v, const QString& e) {
            done = true;
            value = v;
            error = e;
        };
    }
};

/// 一个假的 GitHub:按顺序回预先排好的应答(状态行 + 正文);回 "HANG" 就一直不回
struct FakeGitHub {
    QTcpServer server;
    QStringList replies;
    int requests = 0;
    QByteArray lastRequest;
    FakeGitHub() {
        server.listen(QHostAddress::LocalHost);
        QObject::connect(&server, &QTcpServer::newConnection, [this] {
            QTcpSocket* s = server.nextPendingConnection();
            QObject::connect(s, &QTcpSocket::readyRead, s, [this, s] {
                lastRequest += s->readAll();
                if (!lastRequest.contains("\r\n\r\n")) return;
                ++requests;
                const QString r = replies.isEmpty() ? u"500|"_s : replies.takeFirst();
                if (r == u"HANG") return;
                const qsizetype bar = r.indexOf(u'|');
                const QByteArray body = r.mid(bar + 1).toUtf8();
                s->write("HTTP/1.1 " + r.left(bar).toUtf8() + " X\r\nContent-Type: application/json\r\nContent-Length: " + QByteArray::number(body.size()) +
                         "\r\nConnection: close\r\n\r\n" + body);
                s->disconnectFromHost();
            });
        });
    }
    QString url() const { return u"http://127.0.0.1:%1/repos/x/releases/latest"_s.arg(server.serverPort()); }
};

struct Rig {
    QTemporaryDir dir;
    QString results = dir.filePath(u"results.json"_s);
    QString config = dir.filePath(u"settings.json"_s);
    shell::EngineClient engine;
    shell::EngineSupervisor supervisor{&engine};
    shell::LogFile log{dir.filePath(u"logs/qt-main.log"_s)};
    struct Out : shell::AlertOutputs {
        QStringList notices;
        void playWav(const QByteArray&) override {}
        bool notify(const QString& t, const QString&) override { notices << t; return true; }
    } outputs;
    shell::Alerter alerter{nullptr, &outputs, {}};
    QStringList logs;
    int ready = 0;
    QStringList revealed;
    QList<app::Confirm> asked;
    int answer = 1;
    QString savePath;
    FakeGitHub github;
    std::unique_ptr<app::SupportService> support;

    explicit Rig(bool readOnly = false)
        : engine(fakeEngine({{u"FAKE_LOG_PARAMS"_s, u"1"_s}, {u"FAKE_READY"_s, u"1"_s}, {u"FAKE_RESULTS_FILE"_s, results}}), 40) {
        QObject::connect(&engine, &shell::EngineClient::logLine, [this](const QString& l) { logs.append(l); });
        QObject::connect(&engine, &shell::EngineClient::engineEvent, [this](const QString& e, const QJsonValue&) { if (e == u"ready") ++ready; });
        app::SupportService::Deps d;
        d.engine = &engine;
        d.supervisor = &supervisor;
        d.log = &log;
        d.alerter = &alerter;
        d.configPath = config;
        d.userDataDir = dir.path();
        d.appVersion = u"0.5.2"_s;
        d.confirm = [this](const app::Confirm& c) { asked << c; return answer; };
        d.pickSavePath = [this](const QString&, const QString&, const QString&) { return savePath; };
        d.reveal = [this](const QString& p) { revealed << p; };
        d.openPath = [this](const QString& p) { revealed << p; return QString(); };
        d.latestApi = github.url();
        d.updateTimeoutMs = 400;
        d.platform = u"darwin"_s;
        d.arch = u"arm64"_s;
        d.readOnly = readOnly;
        support = std::make_unique<app::SupportService>(d);
    }
    ~Rig() {
        supervisor.prepareQuit();
        shell::StopOptions o;
        o.drainMs = 0;
        stopSync(engine, o);
    }
    void write(const QString& path, const QByteArray& text) {
        QDir().mkpath(QFileInfo(path).path());
        QFile f(path);
        QVERIFY(f.open(QIODevice::WriteOnly));
        f.write(text);
    }
    QByteArray read(const QString& path) {
        QFile f(path);
        return f.open(QIODevice::ReadOnly) ? f.readAll() : QByteArray();
    }
    void start() {
        engine.start();
        QTRY_COMPARE(ready, 1);
    }
};

}  // namespace

class TestSupportService : public QObject {
    Q_OBJECT
private slots:
    void exportDiagnostics() {
        Rig r;
        r.write(r.config, R"({"accounts":[{"alias":"实盘","account_id":"U1234567"}],"llm":{"model":"x"}})");
        r.write(r.results, R"({"system.status":{"broker_connected":true,"note":"账户 U1234567"},"system.selftest":{"ok":true,"symbol_aliases":{"a":"A"}},"data.backups":{"dir":"/x"}})");
        // 取消
        Result canceled;
        r.support->exportDiagnostics(canceled.cb());
        QTRY_VERIFY(canceled.done);
        QCOMPARE(canceled.value.value(u"canceled").toBool(), true);
        // 引擎在
        r.start();
        r.savePath = r.dir.filePath(u"diag.txt"_s);
        Result done;
        r.support->exportDiagnostics(done.cb());
        QTRY_VERIFY(done.done);
        QVERIFY2(done.error.isEmpty(), qPrintable(done.error));
        const QString text = QString::fromUtf8(r.read(r.savePath));
        QVERIFY(text.contains(u"===== 引擎状态(system.status) ====="_s));
        QVERIFY(text.contains(u"\"symbol_alias_count\": 1"_s));
        QVERIFY(text.contains(u"\"running\": true"_s));
        QVERIFY(!text.contains(u"U1234567"_s));
        QVERIFY(text.contains(u"U***567"_s));
        QVERIFY(text.contains(u"\"consent\": null"_s));
        QCOMPARE(r.revealed, QStringList{r.savePath});
        QVERIFY(r.read(r.log.path()).contains("[support] 已导出诊断信息"));
    }

    void exportWithoutEngine() {
        Rig r;
        r.savePath = r.dir.filePath(u"diag.txt"_s);
        Result done;
        r.support->exportDiagnostics(done.cb());
        QTRY_VERIFY(done.done);
        const QString text = QString::fromUtf8(r.read(r.savePath));
        QVERIFY(text.contains(u"\"running\": false"_s));
        QVERIFY(text.contains(u"文件不存在"_s));  // 配置没有
        QVERIFY(!text.contains(u"引擎状态"_s));
    }

    void changeAccount() {
        Rig r;
        const QByteArray original = R"({"connections":{"live":{"port":7496}},"accounts":[]})";
        r.write(r.config, original);
        r.start();
        // 不合规:不问就拒
        Result bad;
        r.support->changeAccount(*shell::parseOJson(uR"({"action":"upsert","alias":"甲","account_id":"x","is_paper":false,"connection":"live"})"_s), bad.cb());
        QVERIFY(bad.done);
        QVERIFY(bad.error.startsWith(u"账号的格式不对"_s));
        QVERIFY(r.asked.isEmpty());
        // 不再问:就算框上会答取消,也直接写盘、留 .bak、重启引擎
        r.answer = 0;
        const auto change = *shell::parseOJson(uR"({"action":"upsert","alias":"甲","account_id":"U12345678","is_paper":false,"connection":"live"})"_s);
        Result saved;
        r.support->changeAccount(change, saved.cb());
        QVERIFY(saved.value.value(u"ok").toBool());
        QVERIFY(r.asked.isEmpty());
        QCOMPARE(r.read(r.config + u".bak"_s), original);
        QVERIFY(r.read(r.config).contains("\"account_id\": \"U12345678\""));
        QTRY_COMPARE(r.ready, 2);
        QVERIFY(r.read(r.log.path()).contains("[accounts] 添加账户:甲"));
    }

    // 预览 / 截图(readOnly):改账户、恢复交易库都当场拒,不问、不写、不重启引擎
    void readOnlyNeverWrites() {
        Rig r(true);
        const QByteArray original = R"({"connections":{"live":{"port":7496}},"accounts":[]})";
        r.write(r.config, original);
        const QString db = r.dir.filePath(u"data/trades.db"_s);
        r.write(db, "OLD");
        r.write(QDir(r.dir.filePath(u"data/backups"_s)).filePath(u"trades-20261001-120000-manual.db"_s), QByteArray("SQLite format 3\0", 16) + QByteArray(40, 'x'));
        r.write(r.results, QJsonDocument(QJsonObject{{u"data.backups"_s, QJsonObject{{u"dir"_s, r.dir.filePath(u"data/backups"_s)}, {u"db_path"_s, db}}}}).toJson());
        r.start();
        r.answer = 1;
        Result change;
        r.support->changeAccount(*shell::parseOJson(uR"({"action":"upsert","alias":"甲","account_id":"U12345678","is_paper":false,"connection":"live"})"_s), change.cb());
        QVERIFY(change.done);
        QCOMPARE(change.error, u"预览模式不改配置文件"_s);
        Result restore;
        r.support->restoreBackup(u"trades-20261001-120000-manual.db"_s, restore.cb());
        QVERIFY(restore.done);
        QCOMPARE(restore.error, u"预览模式不换交易库"_s);
        QVERIFY(r.asked.isEmpty());
        QCOMPARE(r.read(r.config), original);
        QCOMPARE(r.read(db), QByteArray("OLD"));
        QVERIFY(!QFile::exists(r.config + u".bak"_s));
        QTest::qWait(300);
        QCOMPARE(r.ready, 1);
    }

    void restoreBackup() {
        Rig r;
        const QString db = r.dir.filePath(u"data/trades.db"_s);
        r.write(db, "OLD");
        r.write(QDir(r.dir.filePath(u"data/backups"_s)).filePath(u"trades-20261001-120000-manual.db"_s), QByteArray("SQLite format 3\0", 16) + QByteArray(40, 'x'));
        r.write(r.results, QJsonDocument(QJsonObject{{u"data.backups"_s, QJsonObject{{u"dir"_s, r.dir.filePath(u"data/backups"_s)}, {u"db_path"_s, db}}}}).toJson());
        // 引擎不在
        Result down;
        r.support->restoreBackup(u"trades-20261001-120000-manual.db"_s, down.cb());
        QTRY_VERIFY(down.done);
        QVERIFY(down.error.startsWith(u"交易引擎没有在运行"_s));
        r.start();
        Result unknown;
        r.support->restoreBackup(u"trades-20990101-000000-manual.db"_s, unknown.cb());
        QTRY_VERIFY(unknown.done);
        QCOMPARE(unknown.error, u"找不到这份备份,请刷新备份列表后再试"_s);
        Result ok;
        r.support->restoreBackup(u"trades-20261001-120000-manual.db"_s, ok.cb());
        QTRY_VERIFY_WITH_TIMEOUT(ok.done, 15000);
        QVERIFY2(ok.error.isEmpty(), qPrintable(ok.error));
        QVERIFY(r.logs.contains(u"[fake] data.backup {}"_s));
        QVERIFY(r.read(db).startsWith("SQLite format 3"));
        QCOMPARE(QDir(r.dir.filePath(u"data"_s)).entryList({u"trades.db.before-restore-*"_s}, QDir::Files).size(), 1);
        QTRY_COMPARE(r.ready, 2);
        QCOMPARE(r.outputs.notices, QStringList{u"交易库已恢复"_s});
        QVERIFY(r.asked.last().detail.startsWith(u"备份:"_s));
    }

    void checkUpdate() {
        Rig r;
        const QString release = uR"({"tag_name":"v0.6.0","html_url":"https://github.com/Dafrix69/IBKR-Assistant/releases/tag/v0.6.0","body":"## 新\n- 一"})"_s;
        r.github.replies = {u"200|"_s + release, u"404|{}"_s, u"403|{}"_s, u"429|{}"_s, u"502|{}"_s, u"200|not json"_s, u"HANG"_s};
        const auto check = [&r](bool force) {
            Result res;
            r.support->checkUpdate(force, res.cb());
            [&] { QTRY_VERIFY_WITH_TIMEOUT(res.done, 5000); }();
            return res;
        };
        Result a = check(false);
        QVERIFY2(a.error.isEmpty(), qPrintable(a.error));
        QCOMPARE(a.value.value(u"latest").toString(), u"0.6.0"_s);
        QCOMPARE(a.value.value(u"newer").toBool(), true);
        QVERIFY(r.github.lastRequest.contains("User-Agent: Datrix/0.5.2"));
        QVERIFY(r.github.lastRequest.contains("Accept: application/vnd.github+json"));
        // 十分钟内不再问
        QCOMPARE(check(false).value.value(u"latest").toString(), u"0.6.0"_s);
        QCOMPARE(r.github.requests, 1);
        QCOMPARE(check(true).error, u"还没有发布过正式版本"_s);
        QCOMPARE(check(true).error, u"GitHub 限制了查询频率,过一小时再试"_s);
        QCOMPARE(check(true).error, u"GitHub 限制了查询频率,过一小时再试"_s);
        QCOMPARE(check(true).error, u"检查更新失败(HTTP 502)"_s);
        QCOMPARE(check(true).error, u"GitHub 返回的内容读不懂,稍后再试"_s);
        QCOMPARE(check(true).error, u"连接 GitHub 超时,稍后再试(不影响交易)"_s);
        // 连不上
        r.github.server.close();
        QCOMPARE(check(true).error, u"连不上 GitHub,稍后再试(不影响交易)"_s);
        // 上一次成功的那一份留着(诊断包里带上)
        QVERIFY(r.support->lastUpdateCheck());
    }

    // 外部链接只认 github.com 与 www.tradingview.com 的 https;别的不开、记一行日志
    void externalLinks() {
        for (const QString& ok : {u"https://github.com/Dafrix69/IBKR-Assistant/releases/latest"_s, u"https://www.tradingview.com/"_s, u"https://GitHub.com/x"_s})
            QVERIFY2(app::SupportService::externalAllowed(ok), qPrintable(ok));
        for (const QString& no : {u"http://github.com/x"_s, u"https://github.com.evil.example/x"_s, u"https://evil.example/github.com"_s, u"file:///etc/passwd"_s,
                                  u"javascript:alert(1)"_s, u"https://tradingview.com/"_s, u"not a url"_s, u""_s})
            QVERIFY2(!app::SupportService::externalAllowed(no), qPrintable(no));
        Rig r;
        QVERIFY(!r.support->openExternal(u"https://evil.example/"_s));
        QVERIFY(r.read(r.log.path()).contains("[shell] 拒绝打开外部链接 https://evil.example/"));
    }

    void revealKinds() {
        Rig r;
        Result logs, config, notices, unknown;
        r.support->reveal(u"logs"_s, logs.cb());
        r.support->reveal(u"config"_s, config.cb());
        r.support->reveal(u"notices"_s, notices.cb());
        r.support->reveal(u"../etc"_s, unknown.cb());
        QCOMPARE(r.revealed, (QStringList{r.log.path(), r.config}));
        QVERIFY(notices.error.startsWith(u"这一份是打包时生成的"_s));
        QCOMPARE(unknown.error, u"未知的位置:../etc"_s);
        Result backups;
        r.support->reveal(u"backups"_s, backups.cb());
        QTRY_VERIFY(backups.done);
        QCOMPARE(backups.error, u"交易引擎没有在运行,读不到备份目录"_s);
    }
};

QTEST_GUILESS_MAIN(TestSupportService)
#include "tst_support_service.moc"
