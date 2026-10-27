#include "shell/config_home.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>

namespace ibkr::shell::config_home {

using namespace Qt::StringLiterals;

QString configPath(const QString& userDataDir) { return QDir(userDataDir).filePath(u"settings.json"_s); }

QStringList migrationSources(const QString& repoDir, const QStringList& legacyDirs, const QString& example) {
    QStringList out;
    if (!repoDir.isEmpty()) out << QDir(repoDir).filePath(u"config/settings.json"_s);
    for (const QString& d : legacyDirs) out << configPath(d);
    if (!example.isEmpty()) out << example;
    return out;
}

bool Migration::fromExample() const { return from.endsWith(u"settings.example.json"_s); }

Migration migrate(const QString& target, const QStringList& sources) {
    Migration m;
    if (QFileInfo::exists(target)) return m;
    for (const QString& s : sources) {
        if (!QFileInfo(s).isFile()) continue;
        QDir().mkpath(QFileInfo(target).absolutePath());
        if (!QFile::copy(s, target)) {
            m.error = u"写不进配置文件:%1"_s.arg(target);
            return m;
        }
        // 配置里有账号映射:只给自己读写(QFile::copy 带过来的是源文件的权限,示例是 0644)
        QFile::setPermissions(target, QFileDevice::ReadOwner | QFileDevice::WriteOwner);
        m.from = s;
        return m;
    }
    return m;
}

bool carryPrefs(const QStringList& legacyDirs, const QString& toDir) {
    const QString target = QDir(toDir).filePath(u"qt-settings.ini"_s);
    if (QFileInfo::exists(target)) return false;
    for (const QString& d : legacyDirs) {
        const QString src = QDir(d).filePath(u"qt-settings.ini"_s);
        if (!QFileInfo(src).isFile()) continue;
        QDir().mkpath(toDir);
        return QFile::copy(src, target);
    }
    return false;
}

}  // namespace ibkr::shell::config_home
