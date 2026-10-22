// 日志脱敏(desktop/redact.js 逐条搬):落盘的日志、交给界面的引擎日志、导出的诊断包,都先过这一遍。宁可多抹,不可漏。
// 抹:配置里写着的真实账号(逐个精确替换)、长得像 IBKR 账号的串、API Key 与令牌、家目录里的用户名、通知行的内容。
// 期望值由 node 跑原模块现算(tests/fixtures/gen_redact.mjs)。
#pragma once

#include "shell/ordered_json.h"

#include <QJsonValue>
#include <QList>
#include <QPair>
#include <QString>
#include <QStringList>

namespace ibkr::shell {

class Redactor {
public:
    /// accounts:配置里的真实账号;homedir 空 = 不抹家目录(redact.js 里 homedir 短于 4 个字也不抹)
    explicit Redactor(const QStringList& accounts = {}, const QString& homedir = {});
    QString operator()(const QString& text) const;

private:
    QList<QPair<QString, QString>> accounts_;
    QString home_;
};

/// 配置(settings.json 的内容)里的真实账号
QStringList accountsFromConfig(const QJsonValue& config);
/// 给界面与诊断包看的配置:真实账号打码,其余照旧,再整体过一遍脱敏;不是对象返回 null。homedir 同 Redactor
QJsonValue redactConfig(const QJsonValue& config, const QString& homedir);
/// 同上,保持键的次序(诊断包里给人看的那一份用它)
std::optional<OJson> redactConfigOrdered(const OJson& config, const QString& homedir);

}  // namespace ibkr::shell
