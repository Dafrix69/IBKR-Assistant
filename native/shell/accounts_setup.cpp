#include "shell/accounts_setup.h"

#include "shell/config_guard.h"
#include "shell/jsvalue.h"

#include <QFile>
#include <QJsonObject>
#include <QRegularExpression>

#include <cmath>

using namespace Qt::StringLiterals;

namespace ibkr::shell::accounts {

namespace {

/// String(v ?? '')
QString str(const OJson* v) {
    if (!v || v->type == OJson::Null) return {};
    return jsString(v->toQJson());
}
/// String(v)(没有就是 "undefined",同 JS)
QString jsStr(const OJson* v) { return v ? jsString(v->toQJson()) : u"undefined"_s; }

bool isTrue(const OJson* v) { return v && v->type == OJson::Bool && v->b; }

QString kindOf(const OJson& a) { return isTrue(a.get(u"is_paper"_s)) ? u"纸面"_s : u"实盘"_s; }

/// 配置里自己有的那条连接
const OJson* connectionOf(const OJson& config, const QString& name) {
    const OJson* conns = config.get(u"connections"_s);
    if (!conns || !conns->isObject()) return nullptr;
    const OJson* c = conns->get(name);
    return c && c->isObject() ? c : nullptr;
}

QString brokerOf(const OJson& config, const QString& connection) {
    const OJson* c = connectionOf(config, connection);
    const OJson* b = c ? c->get(u"broker"_s) : nullptr;
    return b && b->type == OJson::String ? b->s : u"ibkr"_s;
}

std::optional<Plan> fail(QString* error, const QString& why) {
    if (error) *error = why;
    return std::nullopt;
}

}  // namespace

std::optional<Plan> applyChange(const OJson& config, const OJson& change, QString* error) {
    if (!config.isObject()) return fail(error, u"配置文件读不出来,先修好它再改账户"_s);
    if (!change.isObject()) return fail(error, u"没有收到要改的内容"_s);
    QList<OJson> accounts;
    if (const OJson* list = config.get(u"accounts"_s); list && list->isArray())
        for (const OJson& a : list->items)
            if (a.isObject()) accounts.append(a);
    const QString alias = jsTrim(str(change.get(u"alias"_s)));
    if (alias.isEmpty()) return fail(error, u"别名不能空着"_s);
    if (alias.toUcs4().size() > kAliasMax) return fail(error, u"别名太长了(最多 %1 个字)"_s.arg(kAliasMax));
    static const QRegularExpression bad(uR"([\x{0000}-\x{001f}\x{007f}"\\])"_s);
    if (bad.match(alias).hasMatch()) return fail(error, u"别名里不能有引号、反斜杠与控制字符"_s);
    if (alias.toUpper() == u"DEFAULT") return fail(error, u"DEFAULT 是保留字(指默认账户),换一个别名"_s);
    qsizetype index = -1;
    for (qsizetype i = 0; i < accounts.size(); ++i)
        if (jsStr(accounts[i].get(u"alias"_s)) == alias) { index = i; break; }

    const auto withAccounts = [&config](const QList<OJson>& list) {
        OJson out = config;
        OJson arr;
        arr.type = OJson::Array;
        arr.items = list;
        out.set(u"accounts"_s, arr);
        return out;
    };
    const QString action = str(change.get(u"action"_s));
    if (action == u"remove") {
        if (index < 0) return fail(error, u"没有叫「%1」的账户"_s.arg(alias));
        const OJson removed = accounts.takeAt(index);
        QStringList lines{u"删除账户「%1」(%2,%3)"_s.arg(alias, jsStr(removed.get(u"account_id"_s)), kindOf(removed))};
        if (isTrue(removed.get(u"default"_s)) && !accounts.isEmpty()) {
            accounts[0].set(u"default"_s, OJson::boolean(true));
            lines << u"它原来是默认账户:默认账户改成「%1」"_s.arg(jsStr(accounts[0].get(u"alias"_s)));
        }
        if (accounts.isEmpty()) lines << u"删掉之后配置里一个账户都没有了:解析得了指令,但发不了单"_s;
        lines << QString() << u"只改本机的配置,不影响券商那边的账户与持仓。用这个别名建的追踪会失效。"_s;
        return Plan{withAccounts(accounts), u"删除账户"_s, lines, {}};
    }
    if (action != u"upsert") return fail(error, u"不认识的操作:%1"_s.arg(jsStr(change.get(u"action"_s))));
    const QString accountId = jsTrim(str(change.get(u"account_id"_s)));
    static const QRegularExpression idShape(uR"(\A[A-Za-z]{0,3}[0-9]{4,12}\z)"_s);
    if (!idShape.match(accountId).hasMatch())
        return fail(error, u"账号的格式不对:IBKR 是 U 或 DU 开头加数字(在 TWS 右上角、账户窗口里看得到),富途是纯数字"_s);
    const OJson* isPaperValue = change.get(u"is_paper"_s);
    if (!isPaperValue || isPaperValue->type != OJson::Bool) return fail(error, u"要选清楚这是纸面账户还是实盘账户"_s);
    const bool isPaper = isPaperValue->b;
    const QString connection = jsTrim(str(change.get(u"connection"_s)));
    const OJson* conn = connectionOf(config, connection);
    if (!conn) return fail(error, u"配置里没有叫「%1」的连接"_s.arg(connection));
    const QString broker = brokerOf(config, connection);
    if (broker == u"ibkr" && isPaper && !accountId.startsWith(u'D', Qt::CaseInsensitive))
        return fail(error, u"这个账号不是 IBKR 模拟账号的样子(模拟账号以 D 开头,如 DU1234567),不能标成纸面——标错了,实盘闸门对它就不起作用"_s);
    for (qsizetype i = 0; i < accounts.size(); ++i)
        if (i != index && jsStr(accounts[i].get(u"account_id"_s)) == accountId)
            return fail(error, u"这个账号已经配给了别名「%1」"_s.arg(jsStr(accounts[i].get(u"alias"_s))));

    const std::optional<OJson> before = index >= 0 ? std::optional<OJson>(accounts[index]) : std::nullopt;
    const bool makeDefault = isTrue(change.get(u"make_default"_s)) || (before ? isTrue(before->get(u"default"_s)) : accounts.isEmpty());
    OJson next;
    next.type = OJson::Object;
    next.set(u"alias"_s, OJson::string(alias));
    next.set(u"account_id"_s, OJson::string(accountId));
    next.set(u"is_paper"_s, OJson::boolean(isPaper));
    next.set(u"connection"_s, OJson::string(connection));
    if (makeDefault) {
        next.set(u"default"_s, OJson::boolean(true));
        for (OJson& a : accounts) a.remove(u"default"_s);
    }
    if (index >= 0) accounts[index] = next;
    else accounts.append(next);

    const OJson* port = conn->get(u"port"_s);
    QStringList lines{
        u"别名:"_s + alias,
        u"账号:"_s + accountId,
        u"类别:%1账户%2"_s.arg(kindOf(next), isPaper ? QString() : u"(发到它的订单会用真钱成交)"_s),
        u"连接:%1(%2,端口 %3)"_s.arg(connection, broker == u"futu" ? u"富途 OpenD"_s : u"IBKR"_s, port && port->type != OJson::Null ? jsStr(port) : u"?"_s),
        u"默认账户:"_s + (makeDefault ? u"是"_s : u"否"_s),
    };
    if (before) {
        lines << QString() << u"原来是:%1,%2,连接 %3"_s.arg(jsStr(before->get(u"account_id"_s)), kindOf(*before), str(before->get(u"connection"_s)));
        if (!isTrue(before->get(u"is_paper"_s)) && isPaper) lines << u"注意:这个别名从实盘改成了纸面。"_s;
    }
    lines << QString() << u"保存后交易引擎会重启(几秒钟),券商连接会重连。请核对账号与 TWS 里显示的一致。"_s;
    return Plan{withAccounts(accounts), before ? u"修改账户"_s : u"添加账户"_s, lines, {}};
}

std::optional<Plan> planChange(const QString& configPath, const OJson& change, QString* error) {
    QFile f(configPath);
    if (!f.open(QIODevice::ReadOnly)) return fail(error, u"配置文件读不了:"_s + f.errorString());
    const QByteArray before = f.readAll();
    QString parseError;
    const auto config = parseOJson(QString::fromUtf8(before), &parseError);
    if (!config) return fail(error, u"配置文件不是合法的 JSON,先修好它再改账户:"_s + parseError);
    auto plan = applyChange(*config, change, error);
    if (plan) plan->before = before;
    return plan;
}

bool commitChange(const QString& configPath, const Plan& plan) {
    config::writeAtomic(configPath + u".bak"_s, plan.before);  // 备份写不进去不挡保存
    return config::writeAtomic(configPath, stringifyOJson(plan.config, 2).toUtf8());
}

QStringList placeholderAliases(const OJson& config) {
    QStringList out;
    const OJson* list = config.isObject() ? config.get(u"accounts"_s) : nullptr;
    if (!list || !list->isArray()) return out;
    static const QRegularExpression zeros(uR"(\A[A-Za-z]*0+\z)"_s);
    for (const OJson& a : list->items)
        if (a.isObject() && zeros.match(str(a.get(u"account_id"_s))).hasMatch()) out << jsStr(a.get(u"alias"_s));
    return out;
}

QJsonArray connectionChoices(const OJson& config) {
    QJsonArray out;
    const OJson* conns = config.isObject() ? config.get(u"connections"_s) : nullptr;
    if (!conns || !conns->isObject()) return out;
    for (const auto& [name, c] : conns->fields) {
        if (!c.isObject()) continue;
        const OJson* b = c.get(u"broker"_s);
        const double port = c.get(u"port"_s) ? jsNumber(c.get(u"port"_s)->toQJson()) : std::nan("");
        out.append(QJsonObject{{u"name"_s, name}, {u"broker"_s, b && b->type == OJson::String ? b->s : u"ibkr"_s},
                               {u"port"_s, std::isfinite(port) && port != 0 ? QJsonValue(port) : QJsonValue()}});
    }
    return out;
}

}  // namespace ibkr::shell::accounts
