#include "shell/confirm_grants.h"

#include "shell/jsvalue.h"
#include "util/jsnum.h"

#include <QCryptographicHash>
#include <QSet>

#include <algorithm>
#include <cmath>

namespace ibkr::shell {

using namespace Qt::StringLiterals;

namespace {

struct Purpose {
    const char16_t* key;
    const char16_t* headline;
};
/// 用途 → 对话框上由这里写的那一行。页面只能从这张表里选用途,不能自己起名字
constexpr Purpose kPurposes[] = {
    {u"instruction.submit", u"发送真实订单"},
    {u"tracker.close_now", u"立即平仓"},
    {u"tracker.add", u"授权软件自动平仓"},
    {u"broker.select", u"切换下单的券商"},
    {u"gate.auto_execute", u"打开自动执行"},
    {u"gate.allow_live_trading", u"允许实盘账户下单"},
    {u"limits.loosen", u"放宽风控限额"},
    {u"gate.follow", u"打开 Discord 自动跟单"},
};

/// settings.patch 里从关变开要凭据的闸门
const QStringList kGates{u"auto_execute"_s, u"allow_live_trading"_s};

enum class Loosen { Up, Down, Cap };
struct LimitRule {
    const char16_t* key;
    const char16_t* label;
    Loosen loosen;
};
/// 风控限额里"往松了改"要确认的那几项(按键名排好序,同 JS 的 Object.keys(LIMIT_RULES).sort())。
/// Up = 调大是放松,Down = 调小是放松;Cap = 0 表示"不设"的上限:从有到没有、或者调大,是放松
constexpr LimitRule kLimitRules[] = {
    {u"auto_mid_spread_share", u"AUTO_MID 按价差让价的份额", Loosen::Up},
    {u"duplicate_window_minutes", u"重复防抖窗口(分钟)", Loosen::Down},
    {u"max_mkt_shares", u"市价单股数上限", Loosen::Up},
    {u"max_open_risk_usd", u"在手期权的最坏亏损上限(USD)", Loosen::Cap},
    {u"max_option_contracts", u"期权 / 价差单笔上限(张)", Loosen::Up},
    {u"max_order_notional", u"单笔名义金额上限(USD)", Loosen::Up},
    {u"max_orders_per_input", u"一条指令最多几笔订单", Loosen::Up},
    {u"max_spread_slippage", u"AUTO_MID 滑点上限(美元 / 张)", Loosen::Up},
    {u"max_underlying_contracts", u"同标的同到期的张数上限", Loosen::Cap},
    {u"min_confidence", u"最低置信度", Loosen::Down},
};

/// 能按账户覆盖的那几项(引擎 config.ts 的 ACCOUNT_LIMIT_KEYS)
const QStringList kAccountLimitKeys{u"max_mkt_shares"_s, u"max_open_risk_usd"_s, u"max_option_contracts"_s, u"max_order_notional"_s, u"max_underlying_contracts"_s};

/// 跟单的三个上限:调大是放松
const QStringList kFollowCaps{u"max_age_seconds"_s, u"max_orders_per_day"_s, u"max_risk_usd"_s};

const LimitRule* limitRule(const QString& key) {
    for (const LimitRule& r : kLimitRules)
        if (key == QStringView(r.key)) return &r;
    return nullptr;
}

/// 从 from 改到 to 是不是放松。现在的值读不出来时按"放松了"算:宁可多问一次
bool isLooser(Loosen rule, double from, double to) {
    if (!std::isfinite(from)) return true;
    if (rule == Loosen::Cap) return from > 0 && (to == 0 || to > from);
    return rule == Loosen::Up ? to > from : to < from;
}

/// JS 的 x && typeof x === 'object'(数组也算对象)
bool isJsObject(const QJsonValue& v) { return v.isObject() || v.isArray(); }

/// 对象(或数组,键是下标)的键,按 JS 的 Object.keys(...).sort()
QStringList sortedKeys(const QJsonValue& v) {
    QStringList keys;
    if (v.isObject()) keys = v.toObject().keys();
    else if (v.isArray())
        for (qsizetype i = 0; i < v.toArray().size(); ++i) keys.append(QString::number(i));
    std::sort(keys.begin(), keys.end());
    return keys;
}

/// obj[key];不在是 undefined
QJsonValue member(const QJsonValue& v, const QString& key) {
    if (v.isObject()) return v.toObject().value(key);
    if (v.isArray()) {
        bool ok = false;
        const qsizetype i = key.toLongLong(&ok);
        if (ok && i >= 0 && i < v.toArray().size()) return v.toArray().at(i);
    }
    return QJsonValue(QJsonValue::Undefined);
}

bool hasKey(const QJsonValue& v, const QString& key) { return !member(v, key).isUndefined() || (v.isObject() && v.toObject().contains(key)); }

/// JS 的 x ?? fallback
QJsonValue orElse(const QJsonValue& v, const QJsonValue& fallback) { return v.isUndefined() || v.isNull() ? fallback : v; }

/// Array.isArray(v) ? [...new Set(v.map(String))].sort() : []
QJsonArray uniqueSortedStrings(const QJsonValue& v) {
    if (!v.isArray()) return {};
    QStringList out;
    QSet<QString> seen;
    for (const QJsonValue& item : v.toArray()) {
        const QString s = jsString(item);
        if (!seen.contains(s)) {
            seen.insert(s);
            out.append(s);
        }
    }
    std::sort(out.begin(), out.end());
    return QJsonArray::fromStringList(out);
}

QStringList strings(const QJsonArray& a) {
    QStringList out;
    for (const QJsonValue& v : a) out.append(v.toString());
    return out;
}

}  // namespace

QString formatEnUs(double n, int maxFractionDigits) {
    if (std::isnan(n)) return u"NaN"_s;
    if (std::isinf(n)) return n < 0 ? u"-∞"_s : u"∞"_s;
    // 从最短的那串十进制数字起四舍五入(同 ICU):1.005 是 1.01,不是二进制展开的 1.00
    QString s = jsNumberToString(std::fabs(n));
    if (s.contains(u'e')) s = QString::number(std::fabs(n), 'f', 20);
    QString intPart = s.section(u'.', 0, 0);
    QString frac = s.section(u'.', 1);
    if (frac.size() > maxFractionDigits) {
        const bool up = frac[maxFractionDigits].unicode() >= u'5';
        frac = frac.left(maxFractionDigits);
        if (up) {
            // 进位:从末位往前
            QString digits = intPart + frac;
            qsizetype i = digits.size() - 1;
            while (i >= 0) {
                if (digits[i] == u'9') {
                    digits[i] = u'0';
                    --i;
                } else {
                    digits[i] = QChar(digits[i].unicode() + 1);
                    break;
                }
            }
            if (i < 0) digits.prepend(u'1');
            intPart = digits.left(digits.size() - frac.size());
            frac = digits.right(frac.size());
        }
    }
    while (frac.endsWith(u'0')) frac.chop(1);
    QString grouped;
    for (qsizetype i = 0; i < intPart.size(); ++i) {
        if (i > 0 && (intPart.size() - i) % 3 == 0) grouped += u',';
        grouped += intPart[i];
    }
    // 负数舍到 0 也带负号(ICU 的写法:-0.004 → "-0",-0 也是 "-0")
    return (std::signbit(n) ? u"-"_s : QString()) + grouped + (frac.isEmpty() ? QString() : u'.' + frac);
}

namespace {

QJsonObject numbers(const QJsonValue& obj) {
    QJsonObject out;
    for (const QString& k : sortedKeys(obj)) {
        const QJsonValue v = member(obj, k);
        out.insert(k, v.isNull() ? QJsonValue(QJsonValue::Null) : QJsonValue(jsNumber(v)));
    }
    return out;
}

}  // namespace

QString purposeHeadline(const QString& purpose) {
    for (const Purpose& p : kPurposes)
        if (purpose == QStringView(p.key)) return QString::fromUtf16(p.headline);
    return {};
}

QStringList purposeNames() {
    QStringList out;
    for (const Purpose& p : kPurposes) out.append(QString::fromUtf16(p.key));
    return out;
}

QList<LoosenedLimit> loosenedLimits(const QJsonValue& patchLimits, const QJsonValue& currentLimits) {
    // 整段写成 null:引擎会把限额全部恢复成默认值(连按账户另设的与累计上限一并清掉)。这里不知道默认值是多少,
    // 列不出"从多少改到多少"——一律按放宽算;确认框那一头对着同一个函数列不出明细就不弹框,所以这种补丁过不了
    if (patchLimits.isNull()) return {{u"*"_s, u"整段风控限额恢复成默认值"_s, std::nan(""), std::nan("")}};
    const QJsonValue next = isJsObject(patchLimits) ? patchLimits : QJsonValue(QJsonObject{});
    const QJsonValue now = isJsObject(currentLimits) ? currentLimits : QJsonValue(QJsonObject{});
    QList<LoosenedLimit> out;
    for (const LimitRule& rule : kLimitRules) {
        const QString key = QString::fromUtf16(rule.key);
        if (!hasKey(next, key)) continue;
        const double to = jsNumber(member(next, key));
        const double from = jsNumber(member(now, key));
        if (!std::isfinite(to)) continue;  // 不是数:引擎的校验会拒,轮不到这里
        if (isLooser(rule.loosen, from, to)) out.append({key, QString::fromUtf16(rule.label), from, to});
    }
    // 按账户覆盖的限额:比的是这个账户**实际生效**的值——覆盖了用覆盖的,没覆盖用全局的(全局的以这次补丁之后的为准)
    const QJsonValue nowByRaw = member(now, u"by_account"_s);
    const QJsonValue nowBy = isJsObject(nowByRaw) ? nowByRaw : QJsonValue(QJsonObject{});
    // 引擎的深合并把 null 当"删掉":by_account 整个是 null = 所有账户的覆盖都清掉;某个账户是 null = 它那一条清掉
    QJsonObject cleared;
    for (const QString& key : kAccountLimitKeys) cleared.insert(key, QJsonValue::Null);
    QJsonValue nextBy = QJsonObject{};
    const QJsonValue nextByRaw = member(next, u"by_account"_s);
    if (nextByRaw.isNull()) {
        QJsonObject all;
        for (const QString& alias : sortedKeys(nowBy)) all.insert(alias, QJsonValue::Null);
        nextBy = all;
    } else if (isJsObject(nextByRaw)) {
        nextBy = nextByRaw;
    }
    const auto given = [](const QJsonValue& v) { return !v.isNull() && !v.isUndefined(); };
    for (const QString& alias : sortedKeys(nextBy)) {
        const QJsonValue raw = member(nextBy, alias);
        const QJsonValue own = raw.isNull() ? QJsonValue(cleared) : raw;
        if (!jsTruthy(own) || !isJsObject(own)) continue;
        const QJsonValue beforeRaw = member(nowBy, alias);
        const QJsonValue before = isJsObject(beforeRaw) ? beforeRaw : QJsonValue(QJsonObject{});
        for (const QString& key : kAccountLimitKeys) {
            if (!hasKey(own, key)) continue;
            // 之前没覆盖、现在也不覆盖:它跟着全局走,全局那一条已经算过了
            if (!given(member(own, key)) && !given(member(before, key))) continue;
            const double nextGlobal = jsNumber(member(next, key));
            const double globalNext = hasKey(next, key) && std::isfinite(nextGlobal) ? nextGlobal : jsNumber(member(now, key));
            const double to = given(member(own, key)) ? jsNumber(member(own, key)) : globalNext;
            const double from = given(member(before, key)) ? jsNumber(member(before, key)) : jsNumber(member(now, key));
            if (!std::isfinite(to)) continue;
            const LimitRule* rule = limitRule(key);
            if (rule && isLooser(rule->loosen, from, to)) {
                out.append({u"by_account.%1.%2"_s.arg(alias, key), u"%1:%2"_s.arg(alias, QString::fromUtf16(rule->label)), from, to});
            }
        }
    }
    return out;
}

QJsonObject followBinding(const QJsonValue& cfg) {
    const QJsonValue c = isJsObject(cfg) ? cfg : QJsonValue(QJsonObject{});
    return QJsonObject{
        {u"channel_id"_s, jsString(orElse(member(c, u"channel_id"_s), u""_s))},
        {u"author_ids"_s, uniqueSortedStrings(member(c, u"author_ids"_s))},
        {u"accounts"_s, uniqueSortedStrings(member(c, u"accounts"_s))},
        {u"max_age_seconds"_s, jsNumber(member(c, u"max_age_seconds"_s))},
        {u"max_orders_per_day"_s, jsNumber(member(c, u"max_orders_per_day"_s))},
        {u"max_risk_usd"_s, jsNumber(member(c, u"max_risk_usd"_s))},
        {u"local_inbox"_s, member(c, u"local_inbox"_s) == QJsonValue(true)},
        {u"local_channel"_s, jsTrim(jsString(orElse(member(c, u"local_channel"_s), u""_s)))},
        {u"track_fly"_s, member(c, u"track_fly"_s) == QJsonValue(true)},
        {u"track_exit_at"_s, jsTrim(jsString(orElse(member(c, u"track_exit_at"_s), u""_s)))},
    };
}

bool followWidened(const QJsonValue& next, const QJsonValue& now) {
    if (!jsTruthy(next) || member(next, u"enabled"_s) != QJsonValue(true)) return false;
    if (!jsTruthy(now) || member(now, u"enabled"_s) != QJsonValue(true)) return true;
    const QJsonObject a = followBinding(next);
    const QJsonObject b = followBinding(now);
    const auto str = [](const QJsonObject& o, const char16_t* k) { return o.value(QStringView(k)).toString(); };
    const auto flag = [](const QJsonObject& o, const char16_t* k) { return o.value(QStringView(k)).toBool(); };
    if (str(a, u"channel_id") != str(b, u"channel_id")) return true;
    if (flag(a, u"local_inbox") && !flag(b, u"local_inbox")) return true;
    if (flag(a, u"local_inbox") && !str(a, u"local_channel").isEmpty() && str(a, u"local_channel") != str(b, u"local_channel")) return true;
    if (flag(a, u"track_fly") && !flag(b, u"track_fly")) return true;
    if (flag(a, u"track_fly") && !str(a, u"track_exit_at").isEmpty() && str(a, u"track_exit_at") != str(b, u"track_exit_at")) return true;
    const QStringList aAuthors = strings(a.value(u"author_ids").toArray());
    const QStringList bAuthors = strings(b.value(u"author_ids").toArray());
    for (const QString& id : aAuthors)
        if (!bAuthors.contains(id)) return true;
    // 账户:空 = 默认账户,所以"变成空"不是收窄;只有两边都点了名、新的全在旧的里面才算收窄
    const QStringList aAcc = strings(a.value(u"accounts").toArray());
    const QStringList bAcc = strings(b.value(u"accounts").toArray());
    const bool allInB = std::all_of(aAcc.begin(), aAcc.end(), [&bAcc](const QString& x) { return bAcc.contains(x); });
    const bool sameAccounts = aAcc.size() == bAcc.size() && allInB;
    const bool narrowed = !aAcc.isEmpty() && !bAcc.isEmpty() && allInB;
    if (!sameAccounts && !narrowed) return true;
    for (const QString& key : kFollowCaps) {
        const double av = a.value(key).toDouble();
        const double bv = b.value(key).toDouble();
        if (!std::isfinite(bv) || !std::isfinite(av) || av > bv) return true;
    }
    return false;
}

FollowConfirmText followConfirmText(const QJsonObject& binding, const QJsonArray& accounts) {
    QHash<QString, QJsonObject> byAlias;
    for (const QJsonValue& a : accounts) byAlias.insert(jsString(member(a, u"alias"_s)), a.toObject());
    const auto kindOf = [&byAlias](const QString& alias) {
        if (!byAlias.contains(alias)) return u"类别未知"_s;
        return jsTruthy(byAlias.value(alias).value(u"is_paper")) ? u"纸面"_s : u"实盘"_s;
    };
    QJsonValue fallback(QJsonValue::Undefined);
    for (const QJsonValue& a : accounts)
        if (jsTruthy(member(a, u"default"_s))) {
            fallback = a;
            break;
        }
    if (fallback.isUndefined() && !accounts.isEmpty()) fallback = accounts.first();
    const QStringList named = strings(binding.value(u"accounts").toArray());
    const QStringList targets = !named.isEmpty() ? named : (!fallback.isUndefined() ? QStringList{jsString(member(fallback, u"alias"_s))} : QStringList{});
    bool live = false;
    for (const QString& alias : targets)
        if (kindOf(alias) != u"纸面") live = true;
    const auto money = [](double n) { return std::isfinite(n) ? formatEnUs(n, 2) : u"—"_s; };
    const QString channelId = binding.value(u"channel_id").toString();
    const bool localInbox = binding.value(u"local_inbox").toBool();
    const QString localChannel = binding.value(u"local_channel").toString();
    const bool trackFly = binding.value(u"track_fly").toBool();
    const QString trackExitAt = binding.value(u"track_exit_at").toString();
    QStringList targetText;
    for (const QString& alias : targets) targetText.append(u"%1(%2)"_s.arg(alias, kindOf(alias)));

    QStringList lines{
        u"打开之后,下面这些发送者发的蝴蝶单与贷方价差(bull put / bear call),软件不再问你,直接发到券商。"_s,
        QString(),
        u"频道 ID:%1"_s.arg(!channelId.isEmpty() ? channelId : localInbox ? u"(没有填,不连 Discord;消息只来自本地收件)"_s : u"(没有填)"_s),
        u"本地收件:%1"_s.arg(localInbox ? u"开着——从你屏幕上的 Discord 窗口抄下来的消息也算;发送者按显示名认,频道里别人改昵称冒充得了"_s : u"关着"_s),
    };
    if (localInbox) {
        lines.append(u"  读哪个频道:%1"_s.arg(!localChannel.isEmpty() ? u"窗口标题里带「%1」的那个,由软件自己读"_s.arg(localChannel)
                                                                     : u"(没有填,软件不自己读;读哪个频道由你运行的脚本定)"_s));
    }
    const QStringList authors = strings(binding.value(u"author_ids").toArray());
    lines.append(u"信任的发送者 ID:%1"_s.arg(!authors.isEmpty() ? authors.join(u"、"_s) : u"(一个都没有)"_s));
    lines.append(u"发到账户:%1%2"_s.arg(!targetText.isEmpty() ? targetText.join(u"、"_s) : u"(没有可用的账户)"_s, !named.isEmpty() ? QString() : u" —— 默认账户"_s));
    lines.append(u"每单最坏亏损上限:$%1%2"_s.arg(money(binding.value(u"max_risk_usd").toDouble()), targets.size() > 1 ? u"(每个账户各发一份、各算各的)"_s : QString()));
    lines.append(u"  蝴蝶按付出的权利金算;贷方价差按「宽度 − 收到的权利金」算,那是到期时价格穿过两个行权价的亏损。"_s);
    lines.append(u"每天最多跟:%1 单"_s.arg(money(binding.value(u"max_orders_per_day").toDouble())));
    lines.append(u"消息发出超过 %1 秒不跟"_s.arg(money(binding.value(u"max_age_seconds").toDouble())));
    lines.append(QString());
    if (trackFly) {
        lines.append(u"成交后自动建追踪:开着——跟进来的蝴蝶成交之后,软件自己给它建一条持仓追踪并打开「到价自动平仓」:"_s);
        lines.append(u"  按蝶式预设(分档利润回撤)盯着,触发了由软件直接发平仓单,不再问你;软件关着、电脑睡着时不盯。"_s);
        lines.append(u"  到点平仓:%1"_s.arg(!trackExitAt.isEmpty() ? u"美东 %1,到了这个钟点持仓还在就平(建追踪时这个钟点已经过了,就落在下一次)"_s.arg(trackExitAt) : u"不设"_s));
        lines.append(u"  只管买入的蝴蝶;贷方价差不建追踪。对方自己什么时候平仓,软件仍然不知道。"_s);
    } else {
        lines.append(u"成交后自动建追踪:关着——跟进来的持仓软件不会替你平,要你自己管,或者自己设持仓追踪。"_s);
    }
    lines.append(QString());
    lines.append(u"对方发错一条、或者对方的 Discord 账号被盗,都会直接变成你账户里的订单。上面这几个上限,加上「设置」里的限额与保护规则,是仅有的硬保护。"_s);
    lines.append(u"随时可以在「接入 → Discord 跟单」关掉;关是当场生效的。"_s);
    return {live, lines.join(u'\n')};
}

QString canonical(const QJsonValue& value) {
    if (value.isArray()) {
        QStringList parts;
        for (const QJsonValue& v : value.toArray()) parts.append(canonical(v));
        return u'[' + parts.join(u',') + u']';
    }
    if (value.isObject()) {
        const QJsonObject o = value.toObject();
        QStringList keys;
        for (auto it = o.begin(); it != o.end(); ++it)
            if (!it.value().isUndefined()) keys.append(it.key());
        std::sort(keys.begin(), keys.end());
        QStringList parts;
        for (const QString& k : keys) parts.append(jsonQuote(k) + u':' + canonical(o.value(k)));
        return u'{' + parts.join(u',') + u'}';
    }
    switch (value.type()) {
    case QJsonValue::Bool: return value.toBool() ? u"true"_s : u"false"_s;
    case QJsonValue::Double: {
        const double d = value.toDouble();
        return std::isfinite(d) ? jsNumberToString(d) : u"null"_s;  // JSON.stringify(NaN) 是 null
    }
    case QJsonValue::String: return jsonQuote(value.toString());
    default: return u"null"_s;
    }
}

QString grantDigest(const QString& purpose, const QJsonValue& binding) {
    const QString text = purpose + u'\n' + canonical(binding.isUndefined() || binding.isNull() ? QJsonValue(QJsonObject{}) : binding);
    return QString::fromLatin1(QCryptographicHash::hash(text.toUtf8(), QCryptographicHash::Sha256).toHex());
}

QJsonObject normalizeBinding(const QString& purpose, const QJsonValue& binding) {
    const QJsonValue b = isJsObject(binding) ? binding : QJsonValue(QJsonObject{});
    if (purpose == u"instruction.submit") {
        QJsonArray accounts;
        const QJsonValue raw = member(b, u"accounts"_s);
        if (raw.isArray())
            for (const QJsonValue& a : raw.toArray()) accounts.append(jsString(a));
        return {{u"text"_s, jsString(orElse(member(b, u"text"_s), u""_s))}, {u"accounts"_s, accounts}};
    }
    if (purpose == u"tracker.close_now") return {{u"id"_s, jsString(orElse(member(b, u"id"_s), u""_s))}};
    if (purpose == u"broker.select") return {{u"provider"_s, jsString(orElse(member(b, u"provider"_s), u""_s))}};
    if (purpose == u"gate.follow") return followBinding(b);
    if (purpose.startsWith(u"gate.")) return {};
    if (purpose == u"limits.loosen") {
        // 两种形状都从这里过:界面递来的是补丁里的 limits(by_account 是嵌套的,值可以是 null = 清掉);
        // 发出去的凭据绑的是摊平的「键 → 新值」。嵌套的那一段原样留着结构,不能一把 Number() 抹成 NaN
        QJsonObject limits;
        const QJsonValue givenRaw = member(b, u"limits"_s);
        const QJsonValue given = isJsObject(givenRaw) ? givenRaw : QJsonValue(QJsonObject{});
        for (const QString& key : sortedKeys(given)) {
            const QJsonValue value = member(given, key);
            if (key != u"by_account") {
                limits.insert(key, jsNumber(value));
            } else if (value.isNull()) {
                limits.insert(key, QJsonValue::Null);
            } else if (jsTruthy(value) && isJsObject(value)) {
                QJsonObject perAccount;
                for (const QString& alias : sortedKeys(value)) {
                    const QJsonValue one = member(value, alias);
                    perAccount.insert(alias, jsTruthy(one) && isJsObject(one) ? QJsonValue(numbers(one)) : QJsonValue(QJsonValue::Null));
                }
                limits.insert(key, perAccount);
            }
        }
        return {{u"limits"_s, limits}};
    }
    return b.toObject();
}

QList<GrantNeed> requiredGrants(const QString& method, const QJsonValue& params, const QJsonValue& current) {
    const QJsonValue p = isJsObject(params) ? params : QJsonValue(QJsonObject{});
    if (method == u"instruction.submit") {
        if (member(p, u"execute"_s) != QJsonValue(true)) return {};  // 只解析不发单
        return {{u"instruction.submit"_s, normalizeBinding(u"instruction.submit"_s, p)}};
    }
    if (method == u"tracker.close_now") return {{u"tracker.close_now"_s, normalizeBinding(u"tracker.close_now"_s, p)}};
    if (method == u"tracker.add") {
        // 只设提醒价位、不授权发单的追踪不用确认(界面上也没有那个确认框)
        if (!jsTruthy(member(p, u"auto_close"_s)) && !jsTruthy(member(p, u"host_at_broker"_s))) return {};
        return {{u"tracker.add"_s, p.toObject()}};
    }
    if (method == u"broker.select") return {{u"broker.select"_s, normalizeBinding(u"broker.select"_s, p)}};
    if (method == u"settings.patch") {
        const QJsonValue patch = member(p, u"patch"_s);
        const bool patchIsObject = jsTruthy(patch) && isJsObject(patch);
        const QJsonValue policiesRaw = patchIsObject ? member(patch, u"policies"_s) : QJsonValue(QJsonValue::Undefined);
        const QJsonValue next = jsTruthy(policiesRaw) && isJsObject(policiesRaw) ? policiesRaw : QJsonValue(QJsonObject{});
        const QJsonValue nowRaw = jsTruthy(current) ? member(current, u"policies"_s) : QJsonValue(QJsonValue::Undefined);
        const QJsonValue now = jsTruthy(nowRaw) && isJsObject(nowRaw) ? nowRaw : QJsonValue(QJsonObject{});
        QList<GrantNeed> needs;
        for (const QString& gate : kGates)
            if (member(next, gate) == QJsonValue(true) && member(now, gate) != QJsonValue(true)) needs.append({u"gate."_s + gate, {}});
        // JS 的 p.patch && p.patch.limits:补丁是假值时传的就是那个假值(null = 整段恢复默认)
        const QJsonValue patchLimits = jsTruthy(patch) ? (isJsObject(patch) ? member(patch, u"limits"_s) : QJsonValue(QJsonValue::Undefined)) : patch;
        const QJsonValue currentLimits = jsTruthy(current) ? member(current, u"limits"_s) : current;
        const QList<LoosenedLimit> loosened = loosenedLimits(patchLimits, currentLimits);
        if (!loosened.isEmpty()) {
            QJsonObject limits;
            for (const LoosenedLimit& l : loosened) limits.insert(l.key, l.to);
            needs.append({u"limits.loosen"_s, {{u"limits"_s, limits}}});
        }
        // Discord 跟单:补丁落下去之后的那一份(引擎也是这么合并的:这一段是平的,名单整个换)
        const QJsonValue followRaw = patchIsObject ? member(patch, u"follow"_s) : QJsonValue(QJsonValue::Undefined);
        if (jsTruthy(followRaw) && isJsObject(followRaw)) {
            const QJsonValue followNowRaw = jsTruthy(current) ? member(current, u"follow"_s) : QJsonValue(QJsonValue::Undefined);
            const bool hasNow = jsTruthy(followNowRaw) && isJsObject(followNowRaw);
            QJsonObject followNext = hasNow ? followNowRaw.toObject() : QJsonObject{};
            const QJsonObject patchFollow = followRaw.toObject();
            for (auto it = patchFollow.begin(); it != patchFollow.end(); ++it) followNext.insert(it.key(), it.value());
            if (followWidened(followNext, hasNow ? followNowRaw : QJsonValue(QJsonValue::Null))) {
                needs.append({u"gate.follow"_s, followBinding(followNext)});
            }
        }
        return needs;
    }
    return {};
}

void GrantBook::sweep(qint64 nowMs) {
    for (auto it = grants_.begin(); it != grants_.end();) {
        if (it.value() <= nowMs) it = grants_.erase(it);
        else ++it;
    }
}

void GrantBook::issue(const QString& purpose, const QJsonValue& binding, qint64 nowMs) {
    if (purposeHeadline(purpose).isEmpty()) throw GrantError(u"未知的确认用途:%1"_s.arg(purpose));
    sweep(nowMs);
    grants_.insert(grantDigest(purpose, normalizeBinding(purpose, binding)), nowMs + ttlMs_);
}

bool GrantBook::consume(const QString& purpose, const QJsonValue& binding, qint64 nowMs) {
    sweep(nowMs);
    return grants_.remove(grantDigest(purpose, normalizeBinding(purpose, binding))) > 0;
}

QStringList GrantBook::consumeAll(const QList<GrantNeed>& needs, qint64 nowMs) {
    sweep(nowMs);
    // 同 JS:这里按需求里给的 binding 原样算指纹(requiredGrants 给出的已经是整理过的那一份)
    QStringList missing;
    for (const GrantNeed& n : needs)
        if (!grants_.contains(grantDigest(n.purpose, n.binding))) missing.append(purposeHeadline(n.purpose).isEmpty() ? n.purpose : purposeHeadline(n.purpose));
    if (!missing.isEmpty()) return missing;
    for (const GrantNeed& n : needs) grants_.remove(grantDigest(n.purpose, n.binding));
    return {};
}

}  // namespace ibkr::shell
