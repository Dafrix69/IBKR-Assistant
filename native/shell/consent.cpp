#include "shell/consent.h"

#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSaveFile>
#include <QTimeZone>

#include <optional>

namespace ibkr::shell {

using namespace Qt::StringLiterals;

namespace {

/// 没同意条款之前不放行的方法
bool consentRequired(const QString& method) {
    return method == u"instruction.submit" || method == u"tracker.add" || method == u"tracker.update" || method == u"tracker.close_now";
}

QJsonArray readLog(const QString& file) {
    QFile f(file);
    if (!f.open(QIODevice::ReadOnly)) return {};  // 没有、或读不出来:按没同意过处理(保守的那一侧)
    const QJsonValue accepted = QJsonDocument::fromJson(f.readAll()).object().value(u"accepted");
    QJsonArray out;
    for (const QJsonValue& e : accepted.toArray())
        if (e.isObject() && e.toObject().value(u"version").isString()) out.append(e);
    return out;
}

}  // namespace

QString ConsentStore::path() const { return QDir(dir_).filePath(u"consent.json"_s); }

ConsentState ConsentStore::state() const {
    ConsentState s;
    s.version = QLatin1StringView(kTermsVersion);
    const QJsonArray log = readLog(path());
    for (qsizetype i = log.size() - 1; i >= 0; --i) {
        const QJsonObject e = log[i].toObject();
        if (e.value(u"version").toString() != s.version) continue;
        s.accepted = true;
        s.acceptedAt = e.value(u"at").toVariant().toString();
        break;
    }
    return s;
}

std::optional<ConsentState> ConsentStore::accept(const QString& version, const QString& appVersion, qint64 nowMs, QString* error) {
    if (version != QLatin1StringView(kTermsVersion)) {
        if (error) *error = u"条款版本对不上:界面上是 %1,现行的是 %2。请重启应用后重新阅读。"_s.arg(version, QLatin1StringView(kTermsVersion));
        return std::nullopt;
    }
    QJsonArray log = readLog(path());
    log.append(QJsonObject{
        {u"version"_s, version},
        {u"at"_s, QDateTime::fromMSecsSinceEpoch(nowMs, QTimeZone::UTC).toString(Qt::ISODateWithMs)},
        {u"app_version"_s, appVersion},
    });
    QDir().mkpath(dir_);
    // 原子写:写到临时文件再换上(同 consent.js 的 tmp + rename)
    QSaveFile file(path());
    if (!file.open(QIODevice::WriteOnly) || file.write(QJsonDocument(QJsonObject{{u"accepted"_s, log}}).toJson(QJsonDocument::Indented)) < 0 || !file.commit()) {
        if (error) *error = u"同意记录写不进去:%1"_s.arg(file.errorString());
        return std::nullopt;
    }
    return state();
}

QString ConsentStore::blockedWithoutConsent(const QString& method, const QJsonValue& params) {
    const QJsonObject p = params.toObject();
    if (consentRequired(method)) {
        // 只解析不发单(execute: false)不算:那是在看这个软件会怎么理解一句话
        if (method == u"instruction.submit" && p.value(u"execute") != QJsonValue(true)) return {};
        return u"还没有同意《风险揭示与使用条款》,不能发单或授权自动发单。请在应用里阅读并同意后再试。"_s;
    }
    if (method == u"settings.patch") {
        const QJsonValue patch = p.value(u"patch");
        // 打开 Discord 跟单 = 授权软件不经确认发单
        const QJsonValue follow = patch.isObject() ? patch.toObject().value(u"follow") : QJsonValue();
        if (follow.isObject() && follow.toObject().value(u"enabled") == QJsonValue(true)) {
            return u"还没有同意《风险揭示与使用条款》,不能打开 Discord 自动跟单。请在应用里阅读并同意后再试。"_s;
        }
    }
    return {};
}

}  // namespace ibkr::shell
