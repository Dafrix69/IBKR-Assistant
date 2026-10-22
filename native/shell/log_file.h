// 日志落盘(同 Electron 版 main.js 里的 electron-log):主进程(这里是 Qt 壳)、引擎 stderr、QML 报错、qWarning 都写进一份滚动日志,
// 单份 4 MB、留一份旧的(.old.log)。行的样子同 electron-log:"[2026-10-18 11:04:19.123] [info] 文字",desktop/tools/log_report.js 照样读。
// 落盘之前先脱敏(shell/redactor):账号、API Key、家目录里的用户名。交易数据不进日志。
// Electron 版写 userData/logs/main.log;Qt 版写同一个目录下的 qt-main.log,两版同时开着也不会交错写坏一份。
#pragma once

#include "shell/redactor.h"

#include <QFile>
#include <QMutex>
#include <QString>

namespace ibkr::shell {

class LogFile {
public:
    static constexpr qint64 kMaxBytes = 4 * 1024 * 1024;

    explicit LogFile(QString path, qint64 maxBytes = kMaxBytes);
    QString path() const { return path_; }
    /// level:info / warn / error / debug
    void write(const QString& level, const QString& text);
    void info(const QString& text) { write(QStringLiteral("info"), text); }
    void warn(const QString& text) { write(QStringLiteral("warn"), text); }
    void error(const QString& text) { write(QStringLiteral("error"), text); }
    /// 按配置里现在写着的账号重建脱敏器(配置读不出来就只剩"按样子抹"的那一道)
    void setRedactor(const Redactor& redactor);
    /// 读配置文件,取出账号,重建脱敏器
    void refreshRedactorFromConfig(const QString& configPath);

    /// 把 Qt 自己的 qDebug / qWarning / QML 报错也接进这一份(进程里只能装一个);nullptr 卸下
    static void installMessageHandler(LogFile* log);

private:
    void rotateIfNeeded(qint64 incoming);

    QString path_;
    qint64 maxBytes_;
    QMutex mutex_;
    QFile file_;
    Redactor redact_;
};

}  // namespace ibkr::shell
