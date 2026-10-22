#include "shell/config_guard.h"

#include <QDateTime>
#include <QFile>
#include <QFileInfo>
#include <QSaveFile>

using namespace Qt::StringLiterals;

namespace ibkr::shell::config {

namespace {

struct ReadResult {
    bool exists = false;
    bool ok = false;
    std::optional<QByteArray> text;
    OJson value;
    QString error;
};

/// 读一份 JSON。不存在、读不了、语法不对,各有各的说法;从不抛
ReadResult readJson(const QString& file) {
    ReadResult r;
    QFile f(file);
    if (!f.exists()) {
        r.error = u"文件不存在"_s;
        return r;
    }
    r.exists = true;
    if (!f.open(QIODevice::ReadOnly)) {
        r.error = f.errorString();
        return r;
    }
    r.text = f.readAll();
    QString parseError;
    const auto value = parseOJson(QString::fromUtf8(*r.text), &parseError);
    if (!value) {
        r.error = parseError;
        return r;
    }
    if (!value->isObject()) {
        r.error = u"最外层不是一个 { } 对象"_s;
        return r;
    }
    r.ok = true;
    r.value = *value;
    return r;
}

}  // namespace

QString stamp(double epochMs, const QTimeZone& zone) {
    return QDateTime::fromMSecsSinceEpoch(qint64(epochMs), zone).toString(u"yyyyMMdd-HHmmss"_s);
}

bool writeAtomic(const QString& target, const QByteArray& bytes) {
    QSaveFile f(target);
    if (!f.open(QIODevice::WriteOnly)) return false;
    f.setPermissions(QFileDevice::ReadOwner | QFileDevice::WriteOwner);
    f.write(bytes);
    return f.commit();
}

Inspection inspect(const QString& configPath) {
    const ReadResult current = readJson(configPath);
    const ReadResult backup = readJson(configPath + u".bak"_s);
    Inspection out;
    out.exists = current.exists;
    out.syntaxOk = current.ok;
    out.syntaxError = current.ok ? QString() : current.error;
    out.backupUsable = backup.ok;
    const QFileInfo info(configPath + u".bak"_s);
    if (info.exists()) out.backupAt = double(info.lastModified().toMSecsSinceEpoch());
    // 备份和现在这份一模一样:恢复它解决不了任何问题,不该把这个按钮摆出来
    out.sameAsCurrent = backup.ok && current.text && backup.text == current.text;
    return out;
}

std::optional<Restored> restoreBackup(const QString& configPath, double nowMs, QString* error, const QTimeZone& zone) {
    ReadResult backup = readJson(configPath + u".bak"_s);
    if (!backup.ok) {
        if (error) *error = u"没有可用的备份:"_s + backup.error;
        return std::nullopt;
    }
    Restored out;
    if (QFile::exists(configPath)) {
        out.brokenCopy = configPath + u".broken-"_s + stamp(nowMs, zone);
        QFile::remove(out.brokenCopy);
        QFile::copy(configPath, out.brokenCopy);
    }
    static const QList<QPair<QString, QString>> gates{{u"auto_execute"_s, u"允许自动执行"_s}, {u"allow_live_trading"_s, u"允许实盘账户下单"_s}};
    OJson& value = backup.value;
    if (OJson* policies = value.get(u"policies"_s); policies && policies->isObject()) {
        for (const auto& [gate, label] : gates) {
            OJson* v = policies->get(gate);
            if (!v || v->type != OJson::Bool || !v->b) continue;
            *v = OJson::boolean(false);
            out.closedGates.append(label);
        }
    }
    if (!writeAtomic(configPath, stringifyOJson(value, 2).toUtf8())) {
        if (error) *error = u"写不进配置文件:"_s + configPath;
        return std::nullopt;
    }
    return out;
}

}  // namespace ibkr::shell::config
