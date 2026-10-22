#include "shell/redactor.h"

#include "shell/jsvalue.h"
#include "util/redact.h"

#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRegularExpression>
#include <QSet>

#include <algorithm>

using namespace Qt::StringLiterals;

namespace ibkr::shell {

namespace {

// JS 正则的 \s(PCRE 的 \s 不认 U+FEFF、全角空格这些)
#define JS_WS R"(\t\n\x{0B}\f\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF})"

const QRegularExpression& noticeLine() {
    // 通知行只留标题(标题是固定的那几个:成交回报 / 指令被拒绝 / 下单提醒…)
    static const QRegularExpression re(QStringLiteral(R"((\[通知\][)" JS_WS R"(]*[^|\n]*)\|[^\n]*)"));
    return re;
}

struct Rule {
    QRegularExpression re;
    QString to;
};

const QList<Rule>& secretRules() {
    static const QList<Rule> rules{
        // sk-…(Anthropic / OpenAI / DeepSeek 一类)
        {QRegularExpression(uR"(\bsk-[A-Za-z0-9_-]{8,})"_s), u"sk-***"_s},
        {QRegularExpression(QStringLiteral(R"(\b(Bearer)[)" JS_WS R"(]+[A-Za-z0-9._~+/=-]{8,})"), QRegularExpression::CaseInsensitiveOption), u"\\1 ***"_s},
        // Discord 的 token:三段 base64url 用点连起来。JWT 也是这个样子,一并抹掉
        {QRegularExpression(uR"(\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,})"_s), u"***.***.***"_s},
        // api_key=… / "apiKey": "…" / x-api-key: … / password=… / token=…
        {QRegularExpression(QStringLiteral(R"(\b(x-api-key|api[_-]?key|apikey|authorization|password|passwd|secret|token)(["']?[)" JS_WS
                                           R"(]*[:=][)" JS_WS R"(]*["']?)([^)" JS_WS R"("',;&]{6,}))"),
                            QRegularExpression::CaseInsensitiveOption),
         u"\\1\\2***"_s},
    };
    return rules;
}

}  // namespace

Redactor::Redactor(const QStringList& accounts, const QString& homedir) {
    QStringList unique;
    for (const QString& a : accounts) {
        const QString t = jsTrim(a);
        if (t.size() >= 4 && !unique.contains(t)) unique.append(t);
    }
    // 长的先换:短账号可能是长账号的一段
    std::stable_sort(unique.begin(), unique.end(), [](const QString& a, const QString& b) { return a.size() > b.size(); });
    for (const QString& a : unique) accounts_.append({a, util::maskAccount(a)});
    if (homedir.size() > 3) home_ = homedir;
}

QString Redactor::operator()(const QString& input) const {
    QString text = input;
    if (text.isEmpty()) return text;
    text.replace(noticeLine(), u"\\1| (内容不进日志)"_s);
    for (const auto& [from, to] : accounts_) text.replace(from, to);
    text = util::maskAccountLikeIds(text);
    for (const Rule& r : secretRules()) text.replace(r.re, r.to);
    if (!home_.isEmpty()) text.replace(home_, u"~"_s);
    return text;
}

QStringList accountsFromConfig(const QJsonValue& config) {
    QStringList out;
    if (!config.isObject()) return out;
    for (const QJsonValue& a : config.toObject().value("accounts"_L1).toArray()) {
        if (!a.isObject()) continue;
        const QJsonValue id = a.toObject().value("account_id"_L1);
        const QString s = jsTruthy(id) ? jsString(id) : QString();
        if (!s.isEmpty()) out.append(s);
    }
    return out;
}

QJsonValue redactConfig(const QJsonValue& config, const QString& homedir) {
    if (!config.isObject()) return QJsonValue();
    QJsonObject copy = config.toObject();
    if (copy.value("accounts"_L1).isArray()) {
        QJsonArray accounts = copy.value("accounts"_L1).toArray();
        for (qsizetype i = 0; i < accounts.size(); ++i) {
            if (!accounts[i].isObject()) continue;
            QJsonObject a = accounts[i].toObject();
            if (a.contains("account_id"_L1)) {
                const QJsonValue id = a.value("account_id"_L1);
                a.insert(u"account_id"_s, util::maskAccount(jsTruthy(id) ? jsString(id) : QString()));
            }
            accounts[i] = a;
        }
        copy.insert(u"accounts"_s, accounts);
    }
    // 再整体过一遍:别处(备注、别名)里要是也出现了账号或 Key,一样抹掉
    const Redactor redact(accountsFromConfig(config), homedir);
    const QString text = redact(QString::fromUtf8(QJsonDocument(copy).toJson(QJsonDocument::Compact)));
    return QJsonDocument::fromJson(text.toUtf8()).object();
}

std::optional<OJson> redactConfigOrdered(const OJson& config, const QString& homedir) {
    if (!config.isObject()) return std::nullopt;
    OJson copy = config;
    if (OJson* accounts = copy.get(u"accounts"_s); accounts && accounts->isArray()) {
        for (OJson& a : accounts->items) {
            OJson* id = a.isObject() ? a.get(u"account_id"_s) : nullptr;
            if (!id) continue;
            const QJsonValue v = id->toQJson();
            *id = OJson::string(util::maskAccount(jsTruthy(v) ? jsString(v) : QString()));
        }
    }
    const Redactor redact(accountsFromConfig(config.toQJson()), homedir);
    return parseOJson(redact(stringifyOJson(copy, 0)));
}

}  // namespace ibkr::shell
