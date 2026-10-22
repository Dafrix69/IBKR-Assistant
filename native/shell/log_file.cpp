#include "shell/log_file.h"

#include <QDateTime>
#include <QDir>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>

#include <atomic>
#include <cstdio>

using namespace Qt::StringLiterals;

namespace ibkr::shell {

namespace {

std::atomic<LogFile*> g_log{nullptr};
QtMessageHandler g_previous = nullptr;

void handler(QtMsgType type, const QMessageLogContext& ctx, const QString& msg) {
    if (LogFile* log = g_log.load()) {
        const QString level = type == QtDebugMsg ? u"debug"_s : type == QtInfoMsg ? u"info"_s : type == QtWarningMsg ? u"warn"_s : u"error"_s;
        if (type != QtDebugMsg) log->write(level, msg);
    }
    // 照样打到 stderr(开发时在终端里看得到;自检与测试也靠它)
    if (g_previous) g_previous(type, ctx, msg);
}

}  // namespace

LogFile::LogFile(QString path, qint64 maxBytes) : path_(std::move(path)), maxBytes_(maxBytes), file_(path_), redact_({}, QDir::homePath()) {
    QDir().mkpath(QFileInfo(path_).absolutePath());
}

void LogFile::setRedactor(const Redactor& redactor) {
    QMutexLocker lock(&mutex_);
    redact_ = redactor;
}

void LogFile::refreshRedactorFromConfig(const QString& configPath) {
    QStringList accounts;
    QFile f(configPath);
    if (f.open(QIODevice::ReadOnly)) accounts = accountsFromConfig(QJsonDocument::fromJson(f.readAll()).object());
    setRedactor(Redactor(accounts, QDir::homePath()));
}

void LogFile::rotateIfNeeded(qint64 incoming) {
    const qint64 size = file_.isOpen() ? file_.size() : QFileInfo(path_).size();
    if (size + incoming <= maxBytes_) return;
    // 同 electron-log:满了把这一份改名成 .old.log(覆盖更早的那份),新开一份
    file_.close();
    QFileInfo info(path_);
    const QString old = info.dir().filePath(info.completeBaseName() + u".old."_s + info.suffix());
    QFile::remove(old);
    QFile::rename(path_, old);
}

void LogFile::write(const QString& level, const QString& text) {
    QMutexLocker lock(&mutex_);
    const QString line = u"[%1] [%2] %3\n"_s.arg(QDateTime::currentDateTime().toString(u"yyyy-MM-dd HH:mm:ss.zzz"_s), level, redact_(text));
    const QByteArray bytes = line.toUtf8();
    rotateIfNeeded(bytes.size());
    if (!file_.isOpen() && !file_.open(QIODevice::Append | QIODevice::Text)) return;
    file_.write(bytes);
    file_.flush();
}

void LogFile::installMessageHandler(LogFile* log) {
    g_log.store(log);
    if (log) {
        QtMessageHandler prev = qInstallMessageHandler(handler);
        if (prev != handler) g_previous = prev;
    } else {
        qInstallMessageHandler(g_previous);
    }
}

}  // namespace ibkr::shell
