#include "util/run_marker.h"

#include <QCoreApplication>
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>

namespace ibkr::util::run_marker {

using namespace Qt::StringLiterals;

QString dirFor(const QString& settingsPath) { return QFileInfo(settingsPath).absolutePath() + u"/guard-run"_s; }

void markRunning(const QString& dir, const QString& name) {
    QDir().mkpath(dir);
    const QString running = dir + u'/' + name + u".running"_s;
    const QString crashed = dir + u'/' + name + u".crashed"_s;
    if (QFile::exists(running)) {
        QFile::remove(crashed);
        QFile::rename(running, crashed);
    }
    QFile f(running);
    if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate)) return;
    const QJsonObject o{{u"pid"_s, double(QCoreApplication::applicationPid())},
                        {u"at"_s, QDateTime::currentDateTimeUtc().toString(Qt::ISODate)}};
    f.write(QJsonDocument(o).toJson(QJsonDocument::Compact));
}

void markStopped(const QString& dir, const QString& name) { QFile::remove(dir + u'/' + name + u".running"_s); }

std::optional<QString> takeCrashed(const QString& dir, const QString& name) {
    const QString crashed = dir + u'/' + name + u".crashed"_s;
    QFile f(crashed);
    if (!f.open(QIODevice::ReadOnly)) return std::nullopt;
    const QJsonObject o = QJsonDocument::fromJson(f.readAll()).object();
    f.close();
    QFile::remove(crashed);
    return o.value(u"at"_s).toString();
}

}  // namespace ibkr::util::run_marker
