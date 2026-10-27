#include "shell/instance_guard.h"

#include <QDir>
#include <QFileInfo>
#include <QSysInfo>
#include <QStandardPaths>

#if defined(Q_OS_UNIX)
#include <algorithm>
#include <cerrno>
#include <climits>
#include <csignal>
#include <unistd.h>
#endif

namespace ibkr::shell {

using namespace Qt::StringLiterals;

namespace {

/// 只比第一段、不分大小写:有的机器 gethostname 带 .local,有的不带
QString shortHost(const QString& host) { return host.section(u'.', 0, 0).toLower(); }

#if defined(Q_OS_UNIX)
/// 符号链接本身的内容(不解析成绝对路径)
std::optional<QString> readLink(const QString& path) {
    char buffer[PATH_MAX];
    const QByteArray native = QFile::encodeName(path);
    const ssize_t n = ::readlink(native.constData(), buffer, sizeof buffer - 1);
    if (n <= 0) return std::nullopt;
    return QFile::decodeName(QByteArray(buffer, static_cast<qsizetype>(n)));
}
#endif

}  // namespace

QString currentUserDataDir() {
    // 测试用:把同意记录、Qt 版的锁、Electron 的 SingletonLock 都指到临时目录,碰不到用户的那一份
    if (const QString dir = qEnvironmentVariable("IBKR_USER_DATA_DIR"); !dir.isEmpty()) return dir;
    return QDir(QStandardPaths::writableLocation(QStandardPaths::GenericDataLocation)).filePath(u"Datrix"_s);
}

QStringList legacyUserDataDirs() {
    if (!qEnvironmentVariable("IBKR_USER_DATA_DIR").isEmpty()) return {};
    // 改过两次名:Dafri Trading → IBKR-Assistant → Datrix
    const QDir base(QStandardPaths::writableLocation(QStandardPaths::GenericDataLocation));
    return {base.filePath(u"IBKR-Assistant"_s), base.filePath(u"Dafri Trading"_s)};
}

QStringList electronUserDataDirs() {
    if (const QString dir = qEnvironmentVariable("IBKR_USER_DATA_DIR"); !dir.isEmpty()) return {dir};
    // Electron 版在新目录没有配置时继续用有配置的旧目录(config-guard.js 的 legacyUserDataDir),
    // 这里按同一个次序挑出它正在用的那个放第一个,其余的跟在后面
    const QString current = currentUserDataDir();
    const QStringList legacy = legacyUserDataDirs();
    QString active = current;
    if (!QFileInfo::exists(QDir(current).filePath(u"settings.json"_s))) {
        auto withConfig = std::find_if(legacy.begin(), legacy.end(), [](const QString& d) { return QFileInfo::exists(QDir(d).filePath(u"settings.json"_s)); });
        auto present = std::find_if(legacy.begin(), legacy.end(), [](const QString& d) { return QFileInfo::exists(d); });
        if (withConfig != legacy.end()) active = *withConfig;
        else if (present != legacy.end()) active = *present;
    }
    QStringList dirs{active};
    for (const QString& d : QStringList{current} + legacy)
        if (d != active) dirs << d;
    return dirs;
}

QString localHostName() { return QSysInfo::machineHostName(); }

bool processAlive(qint64 pid) {
#if defined(Q_OS_UNIX)
    if (pid <= 0) return false;
    // 发 0 号信号只检查不打扰;EPERM 说明进程在、只是不是我们的
    return ::kill(static_cast<pid_t>(pid), 0) == 0 || errno == EPERM;
#else
    Q_UNUSED(pid);
    return false;
#endif
}

std::optional<qint64> runningElectronPid(const QStringList& userDataDirs, const QString& hostName) {
#if defined(Q_OS_UNIX)
    for (const QString& dir : userDataDirs) {
        const auto target = readLink(QDir(dir).filePath(u"SingletonLock"_s));
        if (!target) continue;
        // 形如 DAFRIXWANG-MC3-90300:最后一个 - 之后是 pid,之前是主机名(主机名里可以有 -)
        const qsizetype dash = target->lastIndexOf(u'-');
        if (dash <= 0) continue;
        bool ok = false;
        const qint64 pid = target->mid(dash + 1).toLongLong(&ok);
        if (!ok) continue;
        if (shortHost(target->left(dash)) != shortHost(hostName)) continue;
        if (processAlive(pid)) return pid;
    }
#else
    Q_UNUSED(userDataDirs);
    Q_UNUSED(hostName);
#endif
    return std::nullopt;
}

std::unique_ptr<QLockFile> lockQtShell(const QString& lockPath) {
    QDir().mkpath(QFileInfo(lockPath).absolutePath());
    auto lock = std::make_unique<QLockFile>(lockPath);
    // 0 = 不按"锁多久了"算过期(Qt 版一开就是一整天,默认 30 秒会被第二个实例当成过期抢走);
    // 崩掉留下的锁照样认得出:QLockFile 看锁文件里的 pid 已经不在,就当作过期
    lock->setStaleLockTime(0);
    if (!lock->tryLock(0)) return nullptr;
    return lock;
}

QString engineStartBlocker(const QStringList& electronDirs, const QString& hostName) {
    if (const auto pid = runningElectronPid(electronDirs, hostName)) {
        return u"IBKR-Assistant 的 Electron 版正在运行(进程 %1)。两个版本同时开,会有两个引擎同时连 TWS、"
               "同时盯同一个交易库发平仓单。先退出 Electron 版,再开 Qt 版。"_s.arg(*pid);
    }
    return {};
}

}  // namespace ibkr::shell
