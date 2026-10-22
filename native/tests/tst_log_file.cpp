// 日志落盘(shell/log_file):行的样子同 electron-log(log_report.js 认得)、落盘前脱敏、满了滚成 .old.log、qWarning 也进来。
#include "shell/log_file.h"

#include <QFile>
#include <QRegularExpression>
#include <QTemporaryDir>
#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;

namespace {
QString read(const QString& path) {
    QFile f(path);
    return f.open(QIODevice::ReadOnly) ? QString::fromUtf8(f.readAll()) : QString();
}
}  // namespace

class TestLogFile : public QObject {
    Q_OBJECT
private slots:
    void writesRedactedLinesInElectronLogFormat() {
        QTemporaryDir dir;
        const QString path = dir.filePath(u"logs/qt-main.log"_s);
        QFile cfg(dir.filePath(u"settings.json"_s));
        QVERIFY(cfg.open(QIODevice::WriteOnly));
        cfg.write(R"({"accounts":[{"alias":"实盘","account_id":"U1234567"},{"alias":"富途","account_id":"28190044"}]})");
        cfg.close();
        shell::LogFile log(path);
        log.refreshRedactorFromConfig(cfg.fileName());
        log.info(u"[engine] 账户 28190044 下单被拒 key sk-abcdefghijk"_s);
        log.warn(u"at "_s + QDir::homePath() + u"/x.js"_s);
        const QStringList lines = read(path).split(u'\n', Qt::SkipEmptyParts);
        QCOMPARE(lines.size(), 2);
        // desktop/tools/log_report.js 的 TS 正则
        static const QRegularExpression ts(uR"(^\[(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\.(\d+)\] \[(info|warn)\] )"_s);
        QVERIFY2(ts.match(lines[0]).hasMatch(), qPrintable(lines[0]));
        QVERIFY2(lines[0].endsWith(u"[engine] 账户 ***044 下单被拒 key sk-***"_s), qPrintable(lines[0]));
        QVERIFY2(lines[1].endsWith(u"[warn] at ~/x.js"_s), qPrintable(lines[1]));
    }

    void rotatesIntoOldLog() {
        QTemporaryDir dir;
        const QString path = dir.filePath(u"main.log"_s);
        shell::LogFile log(path, 200);
        for (int i = 0; i < 6; ++i) log.info(u"第 %1 行 ................................"_s.arg(i));
        QVERIFY(QFile::exists(dir.filePath(u"main.old.log"_s)));
        QVERIFY(QFileInfo(path).size() <= 200);
        QVERIFY(read(path).contains(u"第 5 行"_s));
        QVERIFY(!read(path).contains(u"第 0 行"_s));
    }

    void qtWarningsGoIntoTheFile() {
        QTemporaryDir dir;
        shell::LogFile log(dir.filePath(u"main.log"_s));
        shell::LogFile::installMessageHandler(&log);
        qWarning("QML 报错 U7654321");
        shell::LogFile::installMessageHandler(nullptr);
        qWarning("卸下之后的不进");
        const QString text = read(log.path());
        QVERIFY2(text.contains(u"[warn] QML 报错 U***321"_s), qPrintable(text));
        QVERIFY(!text.contains(u"卸下之后"_s));
    }
};

QTEST_GUILESS_MAIN(TestLogFile)
#include "tst_log_file.moc"
