#include "shell/diagnostics.h"

#include "shell/config_guard.h"
#include "shell/redactor.h"

#include <QDateTime>
#include <QDir>
#include <QTimeZone>
#include <QFile>
#include <QJsonObject>
#include <QRegularExpression>

using namespace Qt::StringLiterals;

namespace ibkr::shell::diagnostics {

namespace {

QString section(const QString& title, const QString& body) { return u"\n===== %1 =====\n%2\n"_s.arg(title, body); }

QString pretty(const OJson& v) { return stringifyOJson(v, 2); }

QString text(const OJson* v) { return v && v->type == OJson::String ? v->s : QString(); }

/// 自检里的别名表可能很长,而且是用户自己的词表:只报条数
OJson slimSelftest(const OJson& selftest) {
    if (!selftest.isObject()) return selftest;
    OJson out = selftest;
    const OJson* aliases = selftest.get(u"symbol_aliases"_s);
    const int count = aliases && aliases->isObject() ? int(aliases->fields.size()) : 0;
    out.remove(u"symbol_aliases"_s);
    out.remove(u"symbol_alias_count"_s);
    out.fields.append({u"symbol_alias_count"_s, OJson::number(count)});
    return out;
}

}  // namespace

Tail tailFile(const QString& file, int maxLines) {
    Tail t;
    QFile f(file);
    if (!f.exists()) {
        t.error = u"文件不存在"_s;
        return t;
    }
    if (!f.open(QIODevice::ReadOnly)) {
        t.error = f.errorString();
        return t;
    }
    static const QRegularExpression newline(u"\\r?\\n"_s);
    QStringList lines = QString::fromUtf8(f.readAll()).split(newline);
    if (!lines.isEmpty() && lines.last().isEmpty()) lines.removeLast();
    t.ok = true;
    t.total = int(lines.size());
    t.lines = lines.mid(std::max<qsizetype>(0, lines.size() - maxLines));
    return t;
}

QString buildReport(const Input& input) {
    // 配置:读不出来也要导得出来——那正是最需要它的时候
    std::optional<OJson> config;
    QString configError;
    {
        QFile f(input.configPath);
        if (!f.exists()) configError = u"文件不存在"_s;
        else if (!f.open(QIODevice::ReadOnly)) configError = u"读不出来:"_s + f.errorString();
        else {
            QString parseError;
            config = parseOJson(QString::fromUtf8(f.readAll()), &parseError);
            if (!config) configError = u"读不出来:"_s + parseError;
        }
    }
    const Redactor redact(config ? accountsFromConfig(config->toQJson()) : QStringList(), input.homedir);
    const auto clip = [](const QString& line) { return line.size() > kMaxLineChars ? line.left(kMaxLineChars) + u" …(截断)"_s : line; };

    QStringList parts;
    parts << u"Datrix 诊断信息"_s;
    parts << u"生成时间:"_s + QDateTime::fromMSecsSinceEpoch(qint64(input.now), QTimeZone::UTC).toString(u"yyyy-MM-ddTHH:mm:ss.zzzZ"_s);
    parts << u"这份文件不含交易记录、成交、持仓、API Key;真实账号已打码。发出去之前仍建议自己看一遍。"_s;
    parts << section(u"应用与系统"_s, pretty(input.app.isObject() ? input.app : OJson::fromQJson(QJsonObject())));

    const Engine engine = input.engine.value_or(Engine{});
    OJson head;
    head.type = OJson::Object;
    head.set(u"running"_s, OJson::boolean(engine.running));
    head.set(u"restarts"_s, OJson::number(engine.restarts));
    OJson errors;
    errors.type = OJson::Array;
    for (const QString& e : engine.errors) errors.items.append(OJson::string(e));
    head.set(u"errors"_s, errors);
    parts << section(u"交易引擎"_s, pretty(head));
    if (engine.status) parts << section(u"引擎状态(system.status)"_s, pretty(*engine.status));
    if (engine.selftest) parts << section(u"引擎自检(system.selftest)"_s, pretty(slimSelftest(*engine.selftest)));
    if (engine.backups) parts << section(u"交易库与备份(data.backups)"_s, pretty(*engine.backups));

    if (config) {
        const auto safe = redactConfigOrdered(*config, QDir::homePath());
        parts << section(u"配置(已脱敏)"_s, safe ? pretty(*safe) : u"null"_s);
    } else {
        parts << section(u"配置(已脱敏)"_s, u"配置文件 %1 %2"_s.arg(input.configPath, configError));
    }
    if (input.extra && input.extra->isObject() && !input.extra->fields.isEmpty()) parts << section(u"其它"_s, pretty(*input.extra));

    const Tail log = tailFile(input.logPath, kLogTailLines);
    QStringList clipped;
    for (const QString& l : log.lines) clipped << clip(l);
    parts << section(u"日志 %1(共 %2 行,取最后 %3 行)"_s.arg(input.logPath).arg(log.total).arg(log.lines.size()),
                     log.ok ? clipped.join(u'\n') : u"读不出来:"_s + log.error);
    if (!input.oldLogPath.isEmpty()) {
        const Tail old = tailFile(input.oldLogPath, kOldLogTailLines);
        if (old.ok) {
            QStringList c;
            for (const QString& l : old.lines) c << clip(l);
            parts << section(u"上一份日志 %1(取最后 %2 行)"_s.arg(input.oldLogPath).arg(old.lines.size()), c.join(u'\n'));
        }
    }
    // 整份再过一遍脱敏:状态、配置、日志里任何一处漏出来的账号 / Key / 家目录用户名,都在这里抹掉
    return redact(parts.join(u'\n'));
}

QString buildSummary(const Input& input) {
    const OJson& app = input.app;
    const Engine engine = input.engine.value_or(Engine{});
    const auto field = [](const OJson& o, const QString& key) { return text(o.get(key)); };
    const auto orQ = [](const QString& s) { return s.isEmpty() ? u"?"_s : s; };
    QStringList lines;
    lines << u"Datrix %1(%2 %3,系统 %4)"_s.arg(orQ(field(app, u"version"_s)), orQ(field(app, u"platform"_s)), field(app, u"arch"_s), orQ(field(app, u"os"_s)));
    lines << (app.get(u"qt"_s) ? u"Qt "_s + field(app, u"qt"_s) : u"Electron %1 · Node %2"_s.arg(orQ(field(app, u"electron"_s)), orQ(field(app, u"node"_s))));
    lines << u"引擎:%1%2"_s.arg(engine.running ? u"运行中"_s : u"未运行"_s, engine.restarts ? u",本次启动后自动重启过 %1 次"_s.arg(engine.restarts) : QString());
    if (engine.status) {
        const OJson& s = *engine.status;
        const auto flag = [&s](const QString& k) { const OJson* v = s.get(k); return v && v->type == OJson::Bool && v->b; };
        const OJson* upstream = s.get(u"broker_upstream_ok"_s);
        const OJson* breaker = s.get(u"breaker"_s);
        const bool engaged = breaker && breaker->isObject() && breaker->get(u"engaged"_s) && breaker->get(u"engaged"_s)->type == OJson::Bool && breaker->get(u"engaged"_s)->b;
        lines << u"券商:%1 %2%3 · 市场 %4 · 美东 %5"_s.arg(orQ(field(s, u"broker_provider"_s)), flag(u"broker_connected"_s) ? u"已连接"_s : u"未连接"_s,
                                                           upstream && upstream->type == OJson::Bool && !upstream->b ? u"(上游中断)"_s : QString(),
                                                           orQ(field(s, u"market_status"_s)), orQ(field(s, u"now_et"_s)));
        lines << u"熔断 %1"_s.arg(engaged ? u"已合上(%1)"_s.arg(field(*breaker, u"reason"_s)) : u"未合上"_s);
        lines << u"模型 %1 · 提示词 %2"_s.arg(orQ(field(s, u"model"_s)), orQ(field(s, u"prompt_version"_s)));
    }
    for (const QString& e : engine.errors) lines << u"引擎报错:"_s + e;
    return Redactor({}, input.homedir)(lines.join(u'\n'));
}

QString defaultFileName(double nowMs, const QTimeZone& zone) { return u"Datrix-诊断-%1.txt"_s.arg(config::stamp(nowMs, zone)); }

}  // namespace ibkr::shell::diagnostics
