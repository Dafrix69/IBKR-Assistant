#include "shell/access_rules.h"

#include "shell/jsvalue.h"
#include "shell/records_rules.h"

#include <QRegularExpression>
#include <QSet>

#include <algorithm>
#include <cmath>

namespace ibkr::shell::access {

using namespace Qt::StringLiterals;

namespace {

QString S(const QJsonValue& v) { return jsString(v); }
double N(const QJsonValue& v) { return jsNumber(v); }
bool T(const QJsonValue& v) { return jsTruthy(v); }
bool has(const QJsonValue& v) { return !v.isUndefined() && !v.isNull(); }
QJsonArray arr(const QJsonValue& v) { return v.toArray(); }
QStringList strs(const QJsonValue& v) {
    QStringList out;
    for (const QJsonValue& x : v.toArray()) out << S(x);
    return out;
}
/// `${v ?? '—'}`
QString orDash(const QJsonValue& v) { return has(v) ? S(v) : u"—"_s; }
/// Object.entries 的次序:读进来时记下的 "__keys"(OJson::toQJsonKeyed),没有就按 QJsonObject 的次序
QStringList keysOf(const QJsonValue& o) {
    QStringList out;
    const QJsonArray order = o[u"__keys"_s].toArray();
    if (!order.isEmpty()) {
        for (const QJsonValue& k : order) out << k.toString();
        return out;
    }
    for (const QString& k : o.toObject().keys())
        if (k != u"__keys") out << k;
    return out;
}

}  // namespace

// ==== lib/followForm.ts ====================================================================================
namespace follow {

namespace {
const QRegularExpression& discordId() {
    static const QRegularExpression re(u"^\\d{15,21}\\z"_s);
    return re;
}
const QRegularExpression& localAuthor() {
    static const QRegularExpression re(u"^local:[^\\r\\n]{1,80}\\z"_s);
    return re;
}
constexpr int kLocalChannelMax = 100;
/// 数字框:空 / 不是有限数是 null
QJsonValue numOrNull(const QJsonValue& v) { return v.isDouble() && std::isfinite(v.toDouble()) ? v : QJsonValue(QJsonValue::Null); }
/// 两份名单一样不一样(排过序比,同 JS 的 [...a].sort().join())
bool sameList(const QStringList& a, QStringList b) {
    if (a.size() != b.size()) return false;
    QStringList x = a;
    std::sort(x.begin(), x.end(), [](const QString& p, const QString& q) { return QString::compare(p, q, Qt::CaseSensitive) < 0; });
    std::sort(b.begin(), b.end(), [](const QString& p, const QString& q) { return QString::compare(p, q, Qt::CaseSensitive) < 0; });
    return x.join(u',') == b.join(u',');
}
QStringList unique(const QStringList& in) {
    QStringList out;
    for (const QString& s : in)
        if (!out.contains(s)) out << s;
    return out;
}
/// 价:最多四位小数,去掉末尾的 0(最多去两个:至少留两位)
QString price(double v) {
    QString fixed = jsToFixed(std::abs(v), 4);
    for (int i = 0; i < 2 && fixed.endsWith(u'0'); ++i) fixed.chop(1);
    return v < 0 ? u"-"_s + fixed : fixed;
}
}  // namespace

bool isAuthorId(const QString& id) { return discordId().match(id).hasMatch() || localAuthor().match(id).hasMatch(); }

bool isClock(const QString& text) {
    static const QRegularExpression re(u"^([01]?\\d|2[0-3]):[0-5]\\d\\z"_s);
    return re.match(jsTrim(text)).hasMatch();
}

QJsonObject toForm(const QJsonValue& cfg) {
    return {{u"enabled"_s, T(cfg[u"enabled"_s])},
            {u"channelId"_s, has(cfg[u"channel_id"_s]) ? S(cfg[u"channel_id"_s]) : QString()},
            {u"authorIds"_s, QJsonArray::fromStringList(strs(cfg[u"author_ids"_s]))},
            {u"accounts"_s, QJsonArray::fromStringList(strs(cfg[u"accounts"_s]))},
            {u"maxAge"_s, has(cfg[u"max_age_seconds"_s]) ? cfg[u"max_age_seconds"_s] : QJsonValue(QJsonValue::Null)},
            {u"perDay"_s, has(cfg[u"max_orders_per_day"_s]) ? cfg[u"max_orders_per_day"_s] : QJsonValue(QJsonValue::Null)},
            {u"maxRisk"_s, has(cfg[u"max_risk_usd"_s]) ? cfg[u"max_risk_usd"_s] : QJsonValue(QJsonValue::Null)},
            {u"localInbox"_s, T(cfg[u"local_inbox"_s])},
            {u"localChannel"_s, has(cfg[u"local_channel"_s]) ? S(cfg[u"local_channel"_s]) : QString()},
            {u"trackFly"_s, T(cfg[u"track_fly"_s])},
            {u"trackExitAt"_s, has(cfg[u"track_exit_at"_s]) ? S(cfg[u"track_exit_at"_s]) : QString()}};
}

QStringList formProblems(const QJsonObject& form) {
    QStringList out;
    const QString channel = jsTrim(form[u"channelId"_s].toString());
    if (!channel.isEmpty() && !discordId().match(channel).hasMatch()) out << u"频道 ID 是一串 15–21 位数字(Discord 里右键频道 →「复制频道 ID」)"_s;
    const QStringList authors = strs(form[u"authorIds"_s]);
    if (std::any_of(authors.begin(), authors.end(), [](const QString& id) { return !isAuthorId(id); })) out << u"信任名单里有不是 Discord ID、也不是本地收件显示名的条目"_s;
    const QString rawLocal = form[u"localChannel"_s].toString();
    if (jsTrim(rawLocal).size() > kLocalChannelMax || rawLocal.contains(u'\r') || rawLocal.contains(u'\n'))
        out << u"本地收件的频道名最多 %1 字,不能换行"_s.arg(kLocalChannelMax);
    const bool enabled = form[u"enabled"_s].toBool();
    if (enabled && channel.isEmpty() && !form[u"localInbox"_s].toBool()) out << u"打开自动跟单之前要先填频道 ID,或者打开本地收件"_s;
    if (enabled && authors.isEmpty()) out << u"打开自动跟单之前至少要信任一个发送者"_s;
    const QString exit = form[u"trackExitAt"_s].toString();
    if (!jsTrim(exit).isEmpty() && !isClock(exit)) out << u"到点平仓的钟点要写成美东时间的 HH:MM(如 15:45),或者空着"_s;
    const auto range = [&](const QJsonValue& value, const QString& label, double min, std::optional<double> max, bool whole) {
        const QJsonValue v = numOrNull(value);
        if (v.isNull()) out << label + u"不能空着"_s;
        else if (v.toDouble() < min || (max && v.toDouble() > *max))
            out << u"%1要在 %2%3"_s.arg(label, jsNumberToString(min), max ? u"–"_s + jsNumberToString(*max) : u" 以上"_s);
        else if (whole && std::floor(v.toDouble()) != v.toDouble()) out << label + u"要填整数"_s;
    };
    range(form[u"maxAge"_s], u"「消息多旧就不跟」"_s, 1, 600, true);
    range(form[u"perDay"_s], u"「每天最多跟几单」"_s, 1, 100, true);
    range(form[u"maxRisk"_s], u"「每单最坏亏损上限」"_s, 1, std::nullopt, false);
    return out;
}

QJsonObject toConfig(const QJsonObject& form) {
    // Number(null) 是 0:只在 formProblems 为空时调,这里不会是 null
    const auto num = [](const QJsonValue& v) { return QJsonValue(v.isNull() ? 0.0 : jsNumber(v)); };
    return {{u"enabled"_s, form[u"enabled"_s].toBool()},
            {u"channel_id"_s, jsTrim(form[u"channelId"_s].toString())},
            {u"author_ids"_s, QJsonArray::fromStringList(unique(strs(form[u"authorIds"_s])))},
            {u"accounts"_s, QJsonArray::fromStringList(unique(strs(form[u"accounts"_s])))},
            {u"max_age_seconds"_s, num(form[u"maxAge"_s])},
            {u"max_orders_per_day"_s, num(form[u"perDay"_s])},
            {u"max_risk_usd"_s, num(form[u"maxRisk"_s])},
            {u"local_inbox"_s, form[u"localInbox"_s].toBool()},
            {u"local_channel"_s, jsTrim(form[u"localChannel"_s].toString())},
            {u"track_fly"_s, form[u"trackFly"_s].toBool()},
            {u"track_exit_at"_s, jsTrim(form[u"trackExitAt"_s].toString())}};
}

bool isDirty(const QJsonObject& form, const QJsonValue& saved) {
    if (!saved.isObject()) return false;
    // 数字比较是 !==:null 与数也算不一样
    const auto numDiff = [](const QJsonValue& a, const QJsonValue& b) { return a.isNull() || b.isNull() ? a.isNull() != b.isNull() : a.toDouble() != b.toDouble(); };
    return form[u"enabled"_s].toBool() != saved[u"enabled"_s].toBool() || jsTrim(form[u"channelId"_s].toString()) != S(saved[u"channel_id"_s]) ||
           !sameList(strs(form[u"authorIds"_s]), strs(saved[u"author_ids"_s])) || !sameList(strs(form[u"accounts"_s]), strs(saved[u"accounts"_s])) ||
           numDiff(form[u"maxAge"_s], saved[u"max_age_seconds"_s]) || numDiff(form[u"perDay"_s], saved[u"max_orders_per_day"_s]) ||
           numDiff(form[u"maxRisk"_s], saved[u"max_risk_usd"_s]) || form[u"localInbox"_s].toBool() != T(saved[u"local_inbox"_s]) ||
           jsTrim(form[u"localChannel"_s].toString()) != (has(saved[u"local_channel"_s]) ? S(saved[u"local_channel"_s]) : QString()) ||
           form[u"trackFly"_s].toBool() != T(saved[u"track_fly"_s]) ||
           jsTrim(form[u"trackExitAt"_s].toString()) != (has(saved[u"track_exit_at"_s]) ? S(saved[u"track_exit_at"_s]) : QString());
}

QJsonObject addAuthor(const QJsonObject& form, const QString& id) {
    const QString clean = jsTrim(id);
    QStringList authors = strs(form[u"authorIds"_s]);
    if (!isAuthorId(clean) || authors.contains(clean)) return form;
    QJsonObject out = form;
    authors << clean;
    out[u"authorIds"_s] = QJsonArray::fromStringList(authors);
    return out;
}

QJsonObject readerText(const QJsonValue& reader, const QString& channel) {
    const QString state = S(reader[u"state"_s]);
    const auto r = [](const QString& tone, const QString& text) { return QJsonObject{{u"tone"_s, tone}, {u"text"_s, text}}; };
    if (state == u"off") return r(u"info"_s, u"关着"_s);
    if (state == u"no_channel") return r(u"info"_s, u"没有填频道名:软件不自己读窗口,要自己运行脚本(见下面的步骤)。"_s);
    if (state == u"unavailable") return r(u"warn"_s, u"这台电脑上的这一份软件没带读窗口的程序(只有 macOS 的安装包带着):要自己运行脚本。"_s);
    if (state == u"starting") return r(u"info"_s, u"正在启动…"_s);
    if (state == u"reading")
        return r(u"ok"_s, u"正在读「%1」。Discord 要一直停在这个频道;锁屏、合盖、睡眠时读不到,期间的消息不补。"_s.arg(has(reader[u"title"_s]) ? S(reader[u"title"_s]) : channel));
    if (state == u"waiting") return r(u"warn"_s, u"没在读:Discord 没有窗口停在「%1」。切回那个频道就继续;离开期间的消息不补。"_s.arg(channel));
    if (state == u"no_list") return r(u"bad"_s, u"没在读:窗口在这个频道,但消息读不到。退出 Discord,用 open -a Discord --args --force-renderer-accessibility 重新打开。"_s);
    if (state == u"no_discord") return r(u"warn"_s, u"没在读:Discord 没在运行。打开它(要带 --force-renderer-accessibility)并停在这个频道。"_s);
    if (state == u"untrusted")
        return r(u"bad"_s, u"没在读:软件没有辅助功能权限。系统设置 → 隐私与安全性 → 辅助功能,打开 Datrix 的开关,几秒内自己接上。"
                          u"换了新版本之后开着也读不到:系统记的还是旧版本——确认旧版本已经退出,在终端运行 tccutil reset Accessibility com.dafri.trading,"
                          u"等名单里重新出现这一项再打开(不要用「+」「−」)。"_s);
    // failed
    return r(u"bad"_s, has(reader[u"error"_s]) ? S(reader[u"error"_s]) : u"读窗口的程序没有起来。"_s);
}

QString outcomeLabel(const QString& o) {
    static const QHash<QString, QString> m{{u"sent"_s, u"已跟单"_s},     {u"held"_s, u"没有发出"_s},     {u"observed"_s, u"只观察"_s},
                                           {u"stale"_s, u"太旧"_s},       {u"unparsed"_s, u"没接住"_s},   {u"capped"_s, u"超上限"_s},
                                           {u"blocked"_s, u"闸门关着"_s}, {u"rejected"_s, u"被拒"_s}};
    return m.value(o);
}

QString outcomeTone(const QString& o) {
    if (o == u"sent") return u"success"_s;
    if (o == u"observed") return u"default"_s;
    return o == u"rejected" ? u"error"_s : u"warning"_s;
}

std::optional<QString> quoteLine(const QJsonValue& entry) {
    const QJsonValue q = entry[u"quote"_s];
    if (!T(q)) return std::nullopt;
    const bool debit = S(q[u"side"_s]) == u"debit";
    const double gap = jsToFixed(N(q[u"mid"_s]) - N(q[u"leader"_s]), 4).toDouble();
    const QString versus = gap == 0 ? u"和对方一样"_s
                           : debit  ? u"比对方%1 %2"_s.arg(gap > 0 ? u"贵"_s : u"便宜"_s, price(std::abs(gap)))
                                    : u"比对方%1 %2"_s.arg(gap < 0 ? u"少收"_s : u"多收"_s, price(std::abs(gap)));
    const double natural = N(q[u"natural"_s]);
    const QString nat = debit         ? u"立刻成交要付 "_s + price(natural)
                        : natural > 0 ? u"立刻成交能收 "_s + price(natural)
                                      : u"立刻成交一分钱都收不到(要倒付 %1)"_s.arg(price(std::abs(natural)));
    const QString since = S(entry[u"message_id"_s]).startsWith(u"local:"_s) ? u"读到消息"_s : u"消息发出"_s;
    QStringList parts{u"对方%1 %2"_s.arg(debit ? QString() : u"收"_s, price(N(q[u"leader"_s]))),
                      u"此刻中间价%1 %2(%3)"_s.arg(debit ? QString() : u"收"_s, price(N(q[u"mid"_s])), versus), nat,
                      u"%1 %2 秒后"_s.arg(since, S(q[u"lag_s"_s]))};
    if (T(q[u"paper"_s])) parts << u"纸面账户的行情,可能是延迟的"_s;
    return parts.join(u" · "_s);
}

}  // namespace follow

// ==== 共用:lib/connectBits.tsx ==============================================================================
namespace {

/// InfoCard:{ tone, title, body, meta, reason?, hint?, rows?, action?, snippet? }
QJsonObject infoCard(const QString& tone, const QString& title, const QString& body = QString(), const QStringList& meta = {}) {
    return {{u"tone"_s, tone}, {u"title"_s, title}, {u"body"_s, body}, {u"meta"_s, QJsonArray::fromStringList(meta)}};
}

/// 程序卡:跑着 ok、装了没跑 warn、没装 bad;装了没跑带一颗「启动 …」
QJsonArray appsCards(const QJsonValue& apps, const QString& missingText, const QJsonObject& bits) {
    QJsonArray out;
    for (const QJsonValue& a : arr(apps)) {
        const bool running = T(a[u"running"_s]), installed = T(a[u"installed"_s]);
        const QStringList paths = strs(a[u"paths"_s]);
        QJsonObject card = infoCard(running ? u"ok"_s : installed ? u"warn"_s : u"bad"_s, S(a[u"name"_s]),
                                    running ? u"正在运行"_s : installed ? u"已安装,未运行"_s : missingText, paths.isEmpty() ? QStringList{} : QStringList{paths.first()});
        if (installed && !running)
            card[u"action"_s] = QJsonObject{{u"text"_s, u"启动 "_s + S(a[u"name"_s])}, {u"key"_s, S(a[u"key"_s])}, {u"loading"_s, S(bits[u"launching"_s]) == S(a[u"key"_s]) && has(bits[u"launching"_s])}};
        out.append(card);
    }
    return out;
}

/// 端口栅格:[{ port, label, open, state, configured }]
QJsonArray portsGrid(const QJsonValue& ports, const QJsonValue& connected) {
    static const QHash<QString, QString> as{{u"live"_s, u"实盘"_s}, {u"paper"_s, u"模拟"_s}};
    const QStringList conns = strs(connected);
    QJsonArray out;
    for (const QJsonValue& p : arr(ports)) {
        const bool open = T(p[u"open"_s]);
        QJsonObject cell{{u"port"_s, S(p[u"port"_s])},
                         {u"label"_s, S(p[u"label"_s])},
                         {u"open"_s, open},
                         {u"state"_s, open ? u"开放 · %1 ms"_s.arg(has(p[u"latency_ms"_s]) ? S(p[u"latency_ms"_s]) : u"?"_s) : T(p[u"error"_s]) ? S(p[u"error"_s]) : u"未监听"_s}};
        if (T(p[u"configured_as"_s])) {
            const QString c = S(p[u"configured_as"_s]);
            cell[u"configured"_s] = u"配置为%1%2"_s.arg(as.value(c, c), conns.contains(c) ? u" · 已连接"_s : QString());
        }
        out.append(cell);
    }
    return out;
}

/// 「连不上时照着做」:没连上时默认展开
QJsonObject guide(const QString& id, const QJsonValue& steps, bool connected) {
    QJsonArray items;
    for (const QJsonValue& s : arr(steps)) items.append(QJsonObject{{u"title"_s, S(s[u"title"_s])}, {u"detail"_s, S(s[u"detail"_s])}});
    return {{u"id"_s, id}, {u"steps"_s, items}, {u"defaultOpen"_s, !connected}};
}

/// 握手卡
QJsonObject diagnosis(const QJsonValue& r, const QString& versionLabel, const QStringList& extraMeta) {
    const bool connected = T(r[u"connected"_s]), error = T(r[u"error"_s]);
    QStringList meta;
    if (connected) {
        meta << u"%1 %2"_s.arg(versionLabel, orDash(r[u"server_version"_s])) << extraMeta;
        if (has(r[u"port_latency_ms"_s])) meta << S(r[u"port_latency_ms"_s]) + u" ms"_s;
    }
    QJsonObject card = infoCard(connected && !error ? u"ok"_s : connected ? u"warn"_s : u"bad"_s,
                                u"连接 %1 · %2:%3"_s.arg(S(r[u"connection"_s]), orDash(r[u"host"_s]), orDash(r[u"port"_s])), connected ? u"握手成功"_s : u"未连接"_s, meta);
    if (error) card[u"reason"_s] = S(r[u"error"_s]);
    if (T(r[u"hint"_s])) card[u"hint"_s] = S(r[u"hint"_s]);
    QJsonArray rows;
    for (const QJsonValue& a : arr(r[u"accounts"_s]))
        if (S(a[u"connection"_s]) == S(r[u"connection"_s]))
            rows.append(QJsonObject{{u"text"_s, u"%1 → %2"_s.arg(S(a[u"alias"_s]), S(a[u"account_masked"_s]))}, {u"resolved"_s, T(a[u"resolved"_s])},
                                    {u"state"_s, T(a[u"resolved"_s]) ? u"对得上"_s : u"不在可管账户里"_s}});
    if (!rows.isEmpty()) card[u"rows"_s] = rows;
    return card;
}

/// 「3 · 握手与账户」那一格:握手着 / 失败 / 还没做 / 一张张结果卡
QJsonObject diagSection(const QJsonObject& st, const QString& working, const QString& versionLabel, const std::function<QStringList(const QJsonValue&)>& extra) {
    const QString state = st.contains(u"diagState"_s) ? S(st[u"diagState"_s]) : u"idle"_s;
    if (state == u"working") return {{u"working"_s, working}};
    if (state == u"error") return {{u"empty"_s, u"诊断失败:"_s + S(st[u"diagError"_s])}};
    if (!st[u"diag"_s].isArray()) return {{u"empty"_s, u"点「检测连接」做一次只读握手"_s}};
    QJsonArray cards;
    for (const QJsonValue& r : arr(st[u"diag"_s])) cards.append(diagnosis(r, versionLabel, extra(r)));
    return {{u"cards"_s, cards}};
}

QJsonObject connectRow(const QJsonValue& status, const QJsonObject& bits) {
    return {{u"text"_s, T(status[u"broker_connected"_s]) ? u"断开交易引擎"_s : u"连接交易引擎"_s}, {u"busy"_s, bits[u"busy"_s].toBool()}};
}

QJsonObject notice(const QString& tone, const QString& title, const QString& text, const QJsonArray& parts = {}) {
    QJsonObject n{{u"tone"_s, tone}, {u"title"_s, title}, {u"text"_s, text}};
    if (!parts.isEmpty()) n[u"parts"_s] = parts;
    return n;
}

QJsonObject button(const QString& text, bool loading = false, bool disabled = false, const QString& kind = u"default"_s) {
    return {{u"text"_s, text}, {u"loading"_s, loading}, {u"disabled"_s, disabled}, {u"kind"_s, kind}};
}

}  // namespace

QJsonArray subtabs() {
    QJsonArray out;
    for (const auto& [v, l] : std::initializer_list<std::pair<QString, QString>>{
             {u"tws"_s, u"TWS"_s}, {u"futu"_s, u"富途 OpenD"_s}, {u"accounts"_s, u"账户"_s}, {u"llm"_s, u"大模型"_s}, {u"follow"_s, u"Discord 跟单"_s}})
        out.append(QJsonObject{{u"value"_s, v}, {u"label"_s, l}});
    return out;
}

// ==== TWS ==================================================================================================
// { notices, buttons: { scan, diagnose }, apps: { loading | empty | cards }, ports: { loading | empty | cells }, diag, connect, guide }
QJsonObject twsModel(const QJsonObject& st, const QJsonObject& bits, const QJsonValue& status) {
    const bool connected = T(status[u"broker_connected"_s]);
    QJsonArray notices;
    const QJsonValue current = st[u"current"_s];
    if (S(current) == u"ibkr" && has(current)) notices.append(notice(u"info"_s, u"当前券商接入:IBKR。"_s, u"引擎正通过此通道下单。"_s));
    else if (T(current)) notices.append(notice(u"warn"_s, u"当前券商接入:富途 OpenD。"_s, u"本页仅检测 IBKR,引擎不经此下单;切换请到「富途 OpenD」页。"_s));
    notices.append(notice(u"info"_s, u"不接触你的 IBKR 账号密码。"_s, u"登录在 TWS / IB Gateway 自己的窗口完成;这里只检测本机 API 端口、诊断握手、核对账户别名。"_s));
    const QJsonValue scan = st[u"scan"_s];
    const bool scanned = scan.isObject();
    const bool scanFailed = T(st[u"scanError"_s]);
    QJsonObject apps, ports;
    if (scanFailed) apps = {{u"empty"_s, u"检测失败:"_s + S(st[u"scanError"_s])}};
    else if (!scanned) apps = {{u"loading"_s, true}};
    else apps = {{u"cards"_s, appsCards(scan[u"apps"_s], u"未安装(请从 IBKR 官网下载)"_s, bits)}};
    if (scanned) ports = {{u"cells"_s, portsGrid(scan[u"ports"_s], scan[u"connected"_s])}};
    else if (scanFailed) ports = {{u"empty"_s, u"—"_s}};
    else ports = {{u"loading"_s, true}};
    const QString diagState = st.contains(u"diagState"_s) ? S(st[u"diagState"_s]) : u"idle"_s;
    return {{u"notices"_s, notices},
            {u"buttons"_s, QJsonArray{button(u"重新检测"_s), button(u"检测连接"_s, diagState == u"working", false, u"primary"_s)}},
            {u"apps"_s, apps},
            {u"ports"_s, ports},
            {u"diag"_s, diagSection(st, u"正在握手…(首次连接 TWS 会弹确认框,点 Yes)"_s, u"服务器版本"_s,
                                    [](const QJsonValue& r) { return QStringList{u"clientId "_s + S(r[u"client_id"_s])}; })},
            {u"connect"_s, connectRow(status, bits)},
            {u"guide"_s, guide(u"tws-primer"_s, scan[u"guide"_s], connected)}};
}

// ==== 富途 ==================================================================================================
QJsonObject futuModel(const QJsonObject& st, const QJsonObject& bits, const QJsonValue& status) {
    static const QHash<QString, QString> hint{{u"ibkr"_s, u"需本机运行并登录 TWS 或 IB Gateway。支持组合单(价差 / 蝴蝶 / 铁鹰)。"_s},
                                              {u"futu"_s, u"需本机运行并登录富途 OpenD。不支持组合单,多腿结构会被拒绝。"_s}};
    const bool connected = T(status[u"broker_connected"_s]);
    const QJsonValue catalog = st[u"catalog"_s];
    QJsonObject providers;
    if (T(st[u"catalogError"_s])) providers = {{u"empty"_s, u"读取失败:"_s + S(st[u"catalogError"_s])}};
    else if (!catalog.isObject()) providers = {{u"loading"_s, true}};
    else {
        QJsonArray cards;
        for (const QJsonValue& p : arr(catalog[u"providers"_s])) {
            const bool current = T(p[u"current"_s]);
            QStringList conns;
            const QJsonValue cs = p[u"connections"_s];
            for (const QString& k : keysOf(cs)) conns << u"%1 %2:%3"_s.arg(k, S(cs[k][u"host"_s]), S(cs[k][u"port"_s]));
            QJsonObject card = infoCard(current ? u"ok"_s : u"warn"_s, S(p[u"label"_s]) + (current ? u" · 当前生效"_s : QString()), hint.value(S(p[u"key"_s])),
                                        {conns.isEmpty() ? u"未配置连接"_s : conns.join(u" · "_s), u"%1 个账户"_s.arg(arr(p[u"accounts"_s]).size())});
            if (T(p[u"config_snippet"_s])) card[u"snippet"_s] = S(p[u"config_snippet"_s]);
            else if (!current)
                card[u"action"_s] = QJsonObject{{u"text"_s, u"切到"_s + S(p[u"label"_s])}, {u"key"_s, S(p[u"key"_s])}, {u"label"_s, S(p[u"label"_s])},
                                                {u"loading"_s, has(st[u"switching"_s]) && S(st[u"switching"_s]) == S(p[u"key"_s])}};
            cards.append(card);
        }
        providers = {{u"cards"_s, cards}};
    }
    const QJsonValue scan = st[u"scan"_s];
    const bool scanned = scan.isObject(), scanFailed = T(st[u"scanError"_s]);
    QJsonObject apps, ports;
    if (scanFailed) apps = {{u"empty"_s, u"检测失败:"_s + S(st[u"scanError"_s])}};
    else if (!scanned) apps = {{u"loading"_s, true}};
    else {
        QJsonArray cards;
        if (scan[u"sdk_installed"_s] == QJsonValue(false))
            cards.append(infoCard(u"warn"_s, u"这个版本没有带富途的接口库"_s,
                                  u"富途通道的适配桥还没有完成真机核对,暂未开放。进程检测与端口探测照常可用;端口通的时候,「检测连接」的握手会停在「适配桥尚未完成真机核对」。IBKR 通道不受影响。"_s));
        for (const QJsonValue& c : appsCards(scan[u"apps"_s], u"未找到(绿色包放在非常见目录时检测不到,可手动启动)"_s, bits)) cards.append(c);
        apps = {{u"cards"_s, cards}};
    }
    if (scanned) ports = {{u"cells"_s, portsGrid(scan[u"ports"_s], scan[u"connected"_s])}};
    else if (scanFailed) ports = {{u"empty"_s, u"—"_s}};
    else ports = {{u"loading"_s, true}};
    const QString diagState = st.contains(u"diagState"_s) ? S(st[u"diagState"_s]) : u"idle"_s;
    const auto login = [](const QJsonValue& v) { return v == QJsonValue(true) ? u"已登录"_s : v == QJsonValue(false) ? u"未登录"_s : u"未知"_s; };
    const QString unlockState = !catalog.isObject() ? u"检测中…"_s
                                : T(catalog[u"futu"_s][u"unlock_password_saved"_s]) ? u"已存密码(md5),连接引擎后点「交易解锁」"_s
                                                                                    : u"未存密码,模拟盘不受影响,实盘单会被拦下"_s;
    return {{u"providers"_s, providers},
            {u"buttons"_s, QJsonArray{button(u"重新检测"_s), button(u"检测连接"_s, diagState == u"working", false, u"primary"_s)}},
            {u"apps"_s, apps},
            {u"ports"_s, ports},
            {u"diag"_s, diagSection(st, u"正在握手…(OpenD 需已登录,否则超时)"_s, u"OpenD 版本"_s,
                                    [&](const QJsonValue& r) { return QStringList{u"行情登录 "_s + login(r[u"qot_logined"_s]), u"交易登录 "_s + login(r[u"trd_logined"_s])}; })},
            {u"connect"_s, connectRow(status, bits)},
            {u"password"_s, st[u"password"_s].toString()},
            {u"isMd5"_s, st[u"isMd5"_s].toBool()},
            {u"saving"_s, st[u"saving"_s].toBool()},
            {u"unlocking"_s, st[u"unlocking"_s].toBool()},
            {u"unlockState"_s, unlockState},
            {u"guide"_s, guide(u"futu-primer"_s, scan[u"guide"_s], connected)}};
}

// ==== 账户 ==================================================================================================
QJsonObject accountsModel(const QJsonObject& st, const QJsonValue& status) {
    const QJsonArray accounts = arr(status[u"accounts"_s]);
    const QJsonValue info = st[u"info"_s];
    const QJsonArray connections = arr(info[u"connections"_s]);
    const QStringList placeholders = strs(info[u"placeholders"_s]);
    const bool busy = st[u"busy"_s].toBool();
    QJsonArray notices{notice(u"info"_s, u"别名是给指令用的,账号留在本机。"_s,
                              u"指令里写「模拟」「主账户」就是指这里的别名;发给大模型的只有别名,没有账号。纸面还是实盘会写在每张订单上,请如实选。"_s)};
    if (!placeholders.isEmpty())
        notices.append(notice(u"warn"_s, u"还有账户用的是示例里的占位账号"_s,
                              u"「%1」的账号还是全零的占位。点「修改」填上你自己的账号(TWS 右上角、或「账户」窗口里看得到),不用的别名可以删掉。"_s.arg(placeholders.join(u"」「"_s))));
    QJsonArray rows;
    for (const QJsonValue& a : accounts) {
        QJsonArray pills;
        if (T(a[u"default"_s])) pills.append(QJsonObject{{u"tint"_s, u"blue"_s}, {u"text"_s, u"默认"_s}});
        pills.append(QJsonObject{{u"tint"_s, T(a[u"is_paper"_s]) ? u"gray"_s : u"orange"_s}, {u"text"_s, T(a[u"is_paper"_s]) ? u"纸面"_s : u"实盘"_s}});
        rows.append(QJsonObject{{u"alias"_s, S(a[u"alias"_s])},
                                {u"pills"_s, pills},
                                {u"sub"_s, u"%1 · 连接 %2%3"_s.arg(S(a[u"account_masked"_s]), S(a[u"connection"_s]),
                                                                  placeholders.contains(S(a[u"alias"_s])) ? u" · 占位账号,还没填"_s : QString())},
                                {u"account"_s, a}});
    }
    QJsonObject m{{u"notices"_s, notices}, {u"count"_s, accounts.size()}, {u"rows"_s, rows}, {u"busy"_s, busy}};
    if (accounts.isEmpty()) m[u"empty"_s] = status.isObject() ? u"还没有配置账户。"_s : u"交易引擎起来之后这里才读得到。"_s;
    const QJsonValue d = st[u"draft"_s];
    if (!d.isObject()) {
        m[u"add"_s] = button(u"添加账户"_s, false, connections.isEmpty(), u"primary"_s);
        return m;
    }
    const auto brokerOf = [&](const QString& name) {
        for (const QJsonValue& c : connections)
            if (S(c[u"name"_s]) == name) return S(c[u"broker"_s]);
        return u"ibkr"_s;
    };
    const QString idText = jsTrim(S(d[u"accountId"_s]));
    static const QRegularExpression dPrefix(u"^D"_s, QRegularExpression::CaseInsensitiveOption);
    const bool paper = d[u"paper"_s].toBool();
    const bool mismatch = paper && !idText.isEmpty() && brokerOf(S(d[u"connection"_s])) == u"ibkr" && !dPrefix.match(idText).hasMatch();
    QJsonArray connOptions;
    for (const QJsonValue& c : connections)
        connOptions.append(QJsonObject{{u"value"_s, S(c[u"name"_s])},
                                       {u"label"_s, u"%1 · %2%3"_s.arg(S(c[u"name"_s]), S(c[u"broker"_s]) == u"futu" ? u"富途"_s : u"IBKR"_s,
                                                                      T(c[u"port"_s]) ? u" · 端口 "_s + S(c[u"port"_s]) : QString())}});
    const bool editing = has(d[u"editing"_s]);
    m[u"draft"_s] = QJsonObject{
        {u"title"_s, editing ? u"修改「%1」"_s.arg(S(d[u"editing"_s])) : u"添加账户"_s},
        {u"editing"_s, editing},
        {u"alias"_s, S(d[u"alias"_s])},
        {u"accountId"_s, S(d[u"accountId"_s])},
        {u"paper"_s, paper},
        {u"connection"_s, S(d[u"connection"_s])},
        {u"makeDefault"_s, d[u"makeDefault"_s].toBool()},
        {u"idSub"_s, editing ? u"为了不把账号显示出来,修改时要重新填一遍"_s : u"IBKR:U 或 DU 开头加数字;富途:纯数字"_s},
        {u"kindSub"_s, mismatch ? u"这个账号不是模拟账号的样子(模拟账号以 D 开头),不能标成纸面"_s : u"实盘账户的订单会用真钱成交"_s},
        {u"mismatch"_s, mismatch},
        {u"connections"_s, connOptions},
        {u"save"_s, button(u"保存…"_s, busy, jsTrim(S(d[u"alias"_s])).isEmpty() || idText.isEmpty() || S(d[u"connection"_s]).isEmpty() || mismatch, u"primary"_s)},
    };
    return m;
}

// ==== 大模型 =================================================================================================
QJsonObject llmModel(const QJsonObject& st, const QJsonValue& catalog) {
    const QString provider = st[u"provider"_s].toString();
    QJsonObject meta;
    QJsonArray providers;
    for (const QJsonValue& p : arr(catalog[u"providers"_s])) {
        providers.append(QJsonObject{{u"value"_s, S(p[u"key"_s])}, {u"label"_s, S(p[u"label"_s])}});
        if (S(p[u"key"_s]) == provider) meta = p.toObject();
    }
    const QJsonValue current = catalog[u"current"_s];
    const bool same = current.isObject() && provider == S(current[u"provider"_s]);
    QStringList models = strs(meta[u"models"_s]);
    if (same && T(current[u"model"_s]) && !models.contains(S(current[u"model"_s]))) models.prepend(S(current[u"model"_s]));
    QJsonArray modelOptions;
    for (const QString& mm : models) modelOptions.append(QJsonObject{{u"value"_s, mm}, {u"label"_s, mm}});
    const bool configured = T(catalog[u"key_configured"_s][provider]);
    QJsonObject m{{u"providers"_s, providers},
                  {u"provider"_s, provider},
                  {u"models"_s, modelOptions},
                  {u"model"_s, st[u"model"_s].toString()},
                  {u"customModel"_s, st[u"customModel"_s].toString()},
                  {u"needsBaseUrl"_s, T(meta[u"needs_base_url"_s])},
                  {u"baseUrl"_s, st[u"baseUrl"_s].toString()},
                  {u"apiKey"_s, st[u"apiKey"_s].toString()},
                  {u"keyState"_s, !catalog.isObject() ? u"default"_s : configured ? u"success"_s : u"warning"_s},
                  {u"keyText"_s, !catalog.isObject() ? u"检测中…"_s : configured ? u"已配置(存于 Keychain)"_s : u"未配置"_s},
                  {u"supportsEffort"_s, T(meta[u"supports_effort"_s])},
                  {u"effort"_s, st.contains(u"effort"_s) ? S(st[u"effort"_s]) : u"high"_s},
                  {u"supportsTemperature"_s, T(meta[u"supports_temperature"_s])},
                  {u"temperature"_s, st[u"temperature"_s].isDouble() ? st[u"temperature"_s] : QJsonValue(QJsonValue::Null)},
                  {u"maxTokens"_s, st[u"maxTokens"_s].isDouble() ? st[u"maxTokens"_s] : QJsonValue(QJsonValue::Null)},
                  {u"timeout"_s, st[u"timeout"_s].isDouble() ? st[u"timeout"_s] : QJsonValue(QJsonValue::Null)},
                  {u"testing"_s, st[u"testing"_s].toBool()},
                  {u"docs"_s, T(meta[u"docs"_s]) ? S(meta[u"docs"_s]) : QString()}};
    const QJsonValue test = st[u"test"_s];
    if (test.isObject()) {
        if (test.toObject().contains(u"pending"_s)) m[u"test"_s] = QJsonObject{{u"working"_s, u"正在测试…会真打一次最小请求"_s}};
        else if (T(test[u"ok"_s])) {
            QJsonObject card = infoCard(u"ok"_s, u"连通 · "_s + S(test[u"model"_s]), QString(),
                                        {S(test[u"latency_ms"_s]) + u" ms"_s, u"结构化输出:"_s + S(test[u"structured_mode"_s]),
                                         u"in %1 / out %2"_s.arg(orDash(test[u"usage"_s][u"input_tokens"_s]), orDash(test[u"usage"_s][u"output_tokens"_s]))});
            if (S(test[u"structured_mode"_s]) == u"json_object")
                card[u"reason"_s] = u"端点不支持 json_schema,已降级为 json_object + 提示词内嵌 schema,拒绝率可能升高。"_s;
            m[u"test"_s] = QJsonObject{{u"card"_s, card}};
        } else m[u"test"_s] = QJsonObject{{u"card"_s, infoCard(u"bad"_s, u"测试失败"_s, S(test[u"error"_s]))}};
    }
    return m;
}

// ==== Discord 跟单 ==========================================================================================
namespace {

const QJsonArray& setupSteps() {
    static const QJsonArray s{
        QJsonObject{{u"title"_s, u"建一个 bot"_s}, {u"detail"_s, u"Discord Developer Portal → New Application → 左侧 Bot → Reset Token,把那一整段复制到下面保存。"_s}},
        QJsonObject{{u"title"_s, u"打开 Message Content Intent"_s}, {u"detail"_s, u"同一页往下:Privileged Gateway Intents → Message Content Intent。不开的话 bot 看不到消息正文。"_s}},
        QJsonObject{{u"title"_s, u"把 bot 拉进一个你能管理的服务器"_s},
                    {u"detail"_s, u"OAuth2 → URL Generator 勾 bot,权限只要 View Channels 与 Read Message History;打开生成的链接,选你自己的服务器。"_s}},
        QJsonObject{{u"title"_s, u"让单子出现在 bot 看得到的频道里"_s},
                    {u"detail"_s, u"对方的频道是公告频道:点它的「关注」,转到你服务器的一个频道。不是公告频道:请对方同时在你的服务器里发一份,或者请那边的管理员把 bot 拉进去。"_s}},
        QJsonObject{{u"title"_s, u"填频道 ID、挑信任的发送者"_s},
                    {u"detail"_s, u"Discord 设置 → 高级 → 开发者模式;之后右键频道 →「复制频道 ID」。存好之后等对方发一条消息,在下面「频道里最近看到的消息」里点「信任」。"_s}},
    };
    return s;
}

const QJsonArray& inboxSteps() {
    static const QJsonArray s{
        QJsonObject{{u"title"_s, u"让 Discord 把消息暴露给辅助功能"_s},
                    {u"detail"_s, u"退出 Discord,在终端里用 open -a Discord --args --force-renderer-accessibility 重新打开。不带这个参数时,窗口里的消息读不到(「读窗口」那一行会说明)。Discord 每次重开都要这样开。"_s}},
        QJsonObject{{u"title"_s, u"填频道名,打开本地收件,保存"_s},
                    {u"detail"_s, u"频道名是 Discord 窗口标题里的那个(不含 #)。保存之后软件自己读这个窗口,以后随软件启动、随软件退出。Discord 要一直开着并停在这个频道,电脑不能锁屏、不能睡。"_s}},
        QJsonObject{{u"title"_s, u"给 Datrix 辅助功能权限"_s},
                    {u"detail"_s, u"头一次系统会弹提示:系统设置 → 隐私与安全性 → 辅助功能,打开 Datrix。授权之后几秒内「读窗口」那一行变成「在读」。换了新版本之后要重新授权一次,做法写在「读窗口」那一行里。"_s}},
        QJsonObject{{u"title"_s, u"信任显示名"_s},
                    {u"detail"_s, u"对方发一条之后,在「频道里最近看到的消息」里点「信任」(条目是 local:显示名)。注意:频道里别人把昵称改成一样的,软件分不出来——只适合私密小群。"_s}},
        QJsonObject{{u"title"_s, u"不用安装包、或者想自己运行脚本"_s},
                    {u"detail"_s, u"频道名留空,自己运行仓库里的 native/tools/discord-window-follow.swift:swift 那个文件 --channel 频道名 --out 上面显示的收件文件路径;辅助功能权限给运行它的终端。"_s}},
    };
    return s;
}

QJsonObject linkText(const QJsonValue& link, bool tokenSaved, bool inboxOn) {
    const QString state = S(link[u"state"_s]);
    const auto r = [](const QString& tone, const QString& text) { return QJsonObject{{u"tone"_s, tone}, {u"text"_s, text}}; };
    if (state == u"off" && inboxOn) return r(u"info"_s, u"没有填频道 ID,不连 Discord;消息只来自本地收件。"_s);
    if (state == u"ready") {
        if (link[u"channel_known"_s] == QJsonValue(false))
            return r(u"warn"_s, u"已连上(bot:%1),但 bot 所在的服务器里没有这个频道 ID:它听不到那里的消息。"_s.arg(orDash(link[u"bot"_s])));
        return r(u"ok"_s, u"已连上(bot:%1),正在听这个频道。"_s.arg(orDash(link[u"bot"_s])));
    }
    if (state == u"connecting") return r(u"info"_s, has(link[u"error"_s]) ? S(link[u"error"_s]) : u"正在连接 Discord…"_s);
    if (state == u"failed") return r(u"bad"_s, has(link[u"error"_s]) ? S(link[u"error"_s]) : u"连接失败。"_s);
    if (state == u"no_token") return r(u"warn"_s, u"还没有保存 bot token。"_s);
    return r(u"info"_s, tokenSaved ? u"还没有填频道 ID,没有连接 Discord。"_s : u"还没有配置,没有连接 Discord。"_s);
}

}  // namespace

QJsonObject followModel(const QJsonObject& st, const QJsonValue& appStatus, const QTimeZone& zone) {
    const QJsonValue status = st[u"status"_s], form = st[u"form"_s];
    if (T(st[u"loadError"_s]) && !status.isObject()) return {{u"empty"_s, u"读取失败:"_s + S(st[u"loadError"_s])}};
    if (!status.isObject() || !form.isObject()) return {{u"loading"_s, true}};
    const QJsonObject f = form.toObject();
    const QStringList problems = follow::formProblems(f);
    const bool dirty = follow::isDirty(f, status[u"config"_s]);
    const QString busy = has(st[u"busy"_s]) ? S(st[u"busy"_s]) : QString();
    const QJsonObject link = linkText(status[u"link"_s], T(status[u"token_configured"_s]), f[u"localInbox"_s].toBool());
    const QJsonValue inbox = status[u"inbox"_s];
    const QString inboxText = T(inbox[u"error"_s])      ? S(inbox[u"error"_s])
                              : T(inbox[u"watching"_s]) ? u"正在读。这次启动以来收到 %1 条%2"_s.arg(S(inbox[u"received"_s]),
                                                                                                T(inbox[u"last_at"_s]) ? u",最近一条 "_s + records::fmtTime(inbox[u"last_at"_s], zone) : QString())
                              : f[u"localInbox"_s].toBool() ? u"保存之后开始读"_s
                                                            : u"关着"_s;
    const QJsonObject reader = follow::readerText(inbox[u"reader"_s], has(status[u"config"_s][u"local_channel"_s]) ? S(status[u"config"_s][u"local_channel"_s]) : QString());
    static const QHash<QString, QPair<QString, QString>> readerTag{{u"ok"_s, {u"success"_s, u"在读"_s}}, {u"warn"_s, {u"warning"_s, u"没在读"_s}}, {u"bad"_s, {u"error"_s, u"没在读"_s}}};
    const QStringList authorIds = strs(f[u"authorIds"_s]);
    const QJsonArray seen = arr(status[u"seen"_s]);
    QJsonArray authors;
    for (const QString& id : authorIds) {
        QString name;
        for (const QJsonValue& s : seen)
            if (S(s[u"author_id"_s]) == id) {
                name = S(s[u"author_name"_s]);
                break;
            }
        authors.append(QJsonObject{{u"id"_s, id}, {u"text"_s, name.isEmpty() ? id : u"%1 · %2"_s.arg(name, id)}});
    }
    QJsonArray seenRows;
    int strangers = 0;
    for (const QJsonValue& s : seen)
        if (!authorIds.contains(S(s[u"author_id"_s]))) ++strangers;
    for (qsizetype i = 0; i < std::min<qsizetype>(seen.size(), 8); ++i) {
        const QJsonValue s = seen[i];
        seenRows.append(QJsonObject{{u"name"_s, T(s[u"author_name"_s]) ? S(s[u"author_name"_s]) : u"(没有名字)"_s},
                                    {u"id"_s, S(s[u"author_id"_s])},
                                    {u"local"_s, S(s[u"source"_s]) == u"local"},
                                    {u"sub"_s, u"%1 · %2"_s.arg(records::fmtTime(s[u"at"_s], zone), T(s[u"text"_s]) ? S(s[u"text"_s]) : u"(没有文字内容)"_s)},
                                    {u"trusted"_s, authorIds.contains(S(s[u"author_id"_s]))}});
    }
    const QString newAuthor = st[u"newAuthor"_s].toString();
    QJsonArray accounts;
    const QStringList picked = strs(f[u"accounts"_s]);
    for (const QJsonValue& a : arr(appStatus[u"accounts"_s]))
        accounts.append(QJsonObject{{u"value"_s, S(a[u"alias"_s])},
                                    {u"label"_s, u"%1(%2%3)"_s.arg(S(a[u"alias"_s]), T(a[u"is_paper"_s]) ? u"纸面"_s : u"实盘"_s, T(a[u"default"_s]) ? u",默认"_s : QString())},
                                    {u"checked"_s, picked.contains(S(a[u"alias"_s]))}});
    QJsonArray recent;
    for (const QJsonValue& e : arr(status[u"recent"_s])) {
        QString sub = u"%1 · %2 ·「%3」%4"_s.arg(records::fmtTime(e[u"at"_s], zone), T(e[u"author_name"_s]) ? S(e[u"author_name"_s]) : S(e[u"author_id"_s]), S(e[u"text"_s]),
                                               T(e[u"detail"_s]) ? u" · "_s + S(e[u"detail"_s]) : QString());
        QJsonObject row{{u"key"_s, S(e[u"message_id"_s])},
                        {u"label"_s, T(e[u"summary"_s]) ? S(e[u"summary"_s]) : S(e[u"text"_s])},
                        {u"sub"_s, sub},
                        {u"tag"_s, follow::outcomeLabel(S(e[u"outcome"_s]))},
                        {u"tone"_s, follow::outcomeTone(S(e[u"outcome"_s]))}};
        if (T(e[u"quote"_s]))
            if (const auto q = follow::quoteLine(e)) row[u"quote"_s] = *q;
        recent.append(row);
    }
    const bool checked = st[u"checked"_s].toBool();
    const QString token = st[u"token"_s].toString();
    const bool tokenSaved = T(status[u"token_configured"_s]);
    return {{u"link"_s, link},
            {u"tokenPlaceholder"_s, tokenSaved ? u"已保存;要换就粘贴新的"_s : u"粘贴 bot token"_s},
            {u"token"_s, token},
            {u"saveToken"_s, button(u"保存 token"_s, busy == u"token", jsTrim(token).isEmpty())},
            {u"reconnect"_s, button(u"重新连接"_s, busy == u"reconnect", !tokenSaved)},
            {u"setupOpen"_s, !tokenSaved},
            {u"setupSteps"_s, setupSteps()},
            {u"inboxSteps"_s, inboxSteps()},
            {u"channelId"_s, f[u"channelId"_s]},
            {u"authors"_s, authors},
            {u"newAuthor"_s, newAuthor},
            {u"canAdd"_s, follow::addAuthor(f, newAuthor) != f},
            {u"localInbox"_s, f[u"localInbox"_s]},
            {u"localChannel"_s, f[u"localChannel"_s]},
            {u"reader"_s, QJsonObject{{u"tone"_s, reader[u"tone"_s]}, {u"text"_s, reader[u"text"_s]},
                                      {u"tag"_s, readerTag.contains(reader[u"tone"_s].toString()) ? QJsonValue(QJsonObject{{u"color"_s, readerTag.value(reader[u"tone"_s].toString()).first},
                                                                                                                      {u"text"_s, readerTag.value(reader[u"tone"_s].toString()).second}})
                                                                                                  : QJsonValue(QJsonValue::Null)}}},
            {u"inbox"_s, QJsonObject{{u"text"_s, inboxText}, {u"path"_s, S(inbox[u"path"_s])},
                                     {u"tone"_s, T(inbox[u"error"_s]) ? u"warn"_s : T(inbox[u"watching"_s]) ? u"ok"_s : u"info"_s}}},
            {u"seen"_s, seenRows},
            {u"seenEmpty"_s, seen.isEmpty() ? (S(status[u"link"_s][u"state"_s]) == u"ready" || T(inbox[u"watching"_s]) ? u"还没有收到新消息"_s
                                                                                                                     : u"连上 Discord(或打开本地收件)之后,这里会列出频道里的新消息"_s)
                                            : QString()},
            {u"trustHint"_s, strangers > 0 && authorIds.isEmpty()},
            {u"accounts"_s, accounts},
            {u"maxRisk"_s, f[u"maxRisk"_s]},
            {u"perDay"_s, f[u"perDay"_s]},
            {u"perDaySub"_s, u"美东一天;今天已跟 %1 单"_s.arg(S(status[u"today"_s][u"sent"_s]))},
            {u"maxAge"_s, f[u"maxAge"_s]},
            {u"trackFly"_s, f[u"trackFly"_s]},
            {u"trackExitAt"_s, f[u"trackExitAt"_s]},
            {u"tracksPending"_s, N(status[u"tracks_pending"_s])},
            {u"enabled"_s, f[u"enabled"_s]},
            {u"problems"_s, checked && !problems.isEmpty() ? QJsonArray::fromStringList(problems) : QJsonArray{}},
            {u"save"_s, button(u"保存"_s, busy == u"save", !dirty, u"primary"_s)},
            {u"dirty"_s, dirty},
            {u"recent"_s, recent}};
}

// ==== SSR 的字 ==============================================================================================
namespace {

void cardTexts(QStringList& t, const QJsonValue& c) {
    t << c[u"title"_s].toString();
    if (!c[u"body"_s].toString().isEmpty()) t << c[u"body"_s].toString();
    for (const QJsonValue& m : c[u"meta"_s].toArray()) t << m.toString();
    if (c.toObject().contains(u"snippet"_s)) t << u"尚未配置连接与账户。把下面这段并入 config/settings.json 后再切换:"_s << c[u"snippet"_s].toString();
    if (c[u"action"_s].isObject()) t << c[u"action"_s][u"text"_s].toString();
    if (c.toObject().contains(u"reason"_s)) t << c[u"reason"_s].toString();
    if (c.toObject().contains(u"hint"_s)) t << c[u"hint"_s].toString();
    for (const QJsonValue& r : c[u"rows"_s].toArray()) t << r[u"text"_s].toString() << r[u"state"_s].toString();
}
void blockTexts(QStringList& t, const QJsonValue& b) {
    if (b.toObject().contains(u"empty"_s)) t << b[u"empty"_s].toString();
    if (b.toObject().contains(u"working"_s)) t << b[u"working"_s].toString();
    for (const QJsonValue& c : b[u"cards"_s].toArray()) cardTexts(t, c);
    for (const QJsonValue& p : b[u"cells"_s].toArray()) {
        t << p[u"port"_s].toString() << p[u"label"_s].toString() << p[u"state"_s].toString();
        if (p.toObject().contains(u"configured"_s)) t << p[u"configured"_s].toString();
    }
}
void noticeTexts(QStringList& t, const QJsonValue& notices) {
    for (const QJsonValue& n : notices.toArray()) {
        if (!n[u"title"_s].toString().isEmpty()) t << n[u"title"_s].toString();
        if (n.toObject().contains(u"parts"_s))
            for (const QJsonValue& p : n[u"parts"_s].toArray()) t << p.toString();
        else if (!n[u"text"_s].toString().isEmpty()) t << n[u"text"_s].toString();
    }
}
void guideTexts(QStringList& t, const QJsonValue& g, bool open) {
    t << u"连不上时照着做"_s;
    if (open)
        for (const QJsonValue& s : g[u"steps"_s].toArray()) t << s[u"title"_s].toString() << s[u"detail"_s].toString();
}
/// SectionTitle 的数是 AntD Badge:每一位数是一段
QStringList badge(int n) {
    QStringList out;
    for (const QChar c : QString::number(n)) out << QString(c);
    return out;
}

}  // namespace

QStringList pageTexts(const QString& sub, const QJsonObject& m) {
    QStringList t{u"接入"_s};
    for (const QJsonValue& s : subtabs()) t << s[u"label"_s].toString();
    if (sub == u"tws" || sub == u"futu") {
        const bool futu = sub == u"futu";
        if (futu) {
            t << u"IBKR API 跑不起来时的备用通道。"_s << u"同样不接触你的富途账号密码,登录在 OpenD 自己的窗口完成;这里只检测端口、诊断握手、核对账户别名。"_s << u"不支持组合单"_s
              << u":价差 / 蝴蝶 / 铁鹰拆单有腿风险,引擎会直接拒绝,请切回 IBKR。"_s << u"没有原生条件单"_s << u":条件单由本软件盯盘,"_s << u"软件关掉就不会触发"_s
              << u"(IBKR 的条件单挂在券商服务器,掉线仍有效)。"_s << u"0 · 当前券商接入"_s;
            blockTexts(t, m[u"providers"_s]);
            t << u"同一时刻只连一家。切换会断开现有连接并写入配置;别名、限额、校验层不变。"_s;
        } else noticeTexts(t, m[u"notices"_s]);
        t << u"重新检测"_s << u"检测连接"_s << u"1 · 程序"_s;
        blockTexts(t, m[u"apps"_s]);
        t << u"2 · API 端口"_s;
        blockTexts(t, m[u"ports"_s]);
        t << u"3 · 握手与账户"_s;
        blockTexts(t, m[u"diag"_s]);
        t << u"4 · 连接引擎"_s << m[u"connect"_s][u"text"_s].toString() << u"「检测连接」是一次性只读探测;这里才是引擎下单用的长连接。"_s;
        if (futu)
            t << u"5 · 交易解锁(仅实盘需要)"_s << u"只存 md5"_s << u"于 Keychain / DPAPI,明文算完即丢,不写配置、不进日志。模拟盘无需解锁。"_s << u"我填的已经是 md5"_s
              << u"不勾则由引擎本机计算"_s << u"解锁状态"_s << m[u"unlockState"_s].toString() << u"保存"_s << u"交易解锁"_s
              << u"解锁随 OpenD 会话失效,重启 OpenD 后需重新解锁;未解锁时实盘单会在引擎侧被拦下。"_s;
        guideTexts(t, m[u"guide"_s], m[u"guide"_s][u"defaultOpen"_s].toBool());
        return t;
    }
    if (sub == u"accounts") {
        noticeTexts(t, m[u"notices"_s]);
        t << u"已配置的账户"_s << badge(m[u"count"_s].toInt());
        if (m.contains(u"empty"_s)) t << m[u"empty"_s].toString();
        for (const QJsonValue& r : m[u"rows"_s].toArray()) {
            t << r[u"alias"_s].toString();
            for (const QJsonValue& p : r[u"pills"_s].toArray()) t << p[u"text"_s].toString();
            t << r[u"sub"_s].toString() << u"修改"_s << u"删除"_s;
        }
        if (!m[u"draft"_s].isObject()) {
            t << u"添加账户"_s;
            return t;
        }
        const QJsonObject d = m[u"draft"_s].toObject();
        t << d[u"title"_s].toString() << u"别名"_s << u"指令里怎么称呼它,如「模拟」「主账户」"_s << u"账号"_s << d[u"idSub"_s].toString() << u"类别"_s << d[u"kindSub"_s].toString()
          << u"纸面(模拟)"_s << u"实盘"_s << u"连接"_s << u"经哪条连接下单"_s;
        for (const QJsonValue& c : d[u"connections"_s].toArray())
            if (c[u"value"_s] == d[u"connection"_s]) t << c[u"label"_s].toString();
        t << u"默认账户"_s << u"指令里没点名账户时发到它"_s << u"是"_s << u"否"_s
          << u"连接(端口、client id)不能从这里改:账户只能挂到配置里已有的连接上。保存时会弹出确认框,请对着它核对账号。"_s << u"保存…"_s << u"取消"_s;
        return t;
    }
    if (sub == u"llm") {
        t << u"发给模型的只有指令原文、当前时间、行情快照、账户别名与限额;"_s << u"真实账号、余额、持仓、成交记录不出本机"_s << u"。"_s << u"供应商"_s;
        for (const QJsonValue& p : m[u"providers"_s].toArray()) t << p[u"label"_s].toString();
        t << u"模型"_s;
        if (!m[u"model"_s].toString().isEmpty()) t << m[u"model"_s].toString();
        t << u"自定义模型"_s << u"留空则用上面选中的"_s;
        if (m[u"needsBaseUrl"_s].toBool()) t << u"Base URL"_s << u"OpenAI 兼容端点"_s;
        t << u"API Key"_s << u"按供应商分开存于系统凭据库,不落配置、不进日志"_s << u"当前供应商 Key"_s << m[u"keyText"_s].toString() << u"保存"_s << u"调用参数"_s;
        if (m[u"supportsEffort"_s].toBool()) t << u"推理档位"_s << u"effort,仅 Anthropic"_s << m[u"effort"_s].toString();
        if (m[u"supportsTemperature"_s].toBool()) t << u"temperature"_s << u"留空 = 不发送"_s;
        t << u"max_tokens"_s << u"超时(秒)"_s << u"测试连接"_s << u"保存配置"_s;
        if (m[u"test"_s].isObject()) {
            const QJsonObject test = m[u"test"_s].toObject();
            if (test.contains(u"working"_s)) t << test[u"working"_s].toString();
            else cardTexts(t, test[u"card"_s]);
        }
        if (!m[u"docs"_s].toString().isEmpty()) t << m[u"docs"_s].toString();
        return t;
    }
    // follow
    if (m.contains(u"empty"_s)) return t << m[u"empty"_s].toString();
    if (m.contains(u"loading"_s)) return t;
    t << u"信任的人在频道里发的蝴蝶单与贷方价差,不经确认直接发到券商。"_s
      << u"只认本地速记完整接住的两种写法:写明价格的买入蝴蝶(「1.8 挂15蝴蝶 15CM」)、写明方向与价格的贷方价差(「7770 7775 bear call -2 -2.5」,区间按收得多的一头挂)。 "
         u"没写价格、没写 bull put / bear call、带止损或条件的只提醒、不发,也不交给大模型猜。开关关着时只观察:照样解析、照样记在下面,但一张单都不发。"_s
      << u"对方发错一条、或者对方的 Discord 账号被盗,都会变成你账户里的订单——先只观察几天,再打开。"_s << u"1 · Bot 与连接"_s
      << u"bot token 只存在系统凭证库(Keychain / 凭据管理器),不写配置、不进日志。"_s << u"不要填你自己账号的 token"_s << u":用个人账号跑自动化违反 Discord 的条款,会被封号。"_s
      << u"连接"_s << m[u"link"_s][u"text"_s].toString() << u"保存 token"_s << u"重新连接"_s << u"第一次配置:五步"_s;
    if (m[u"setupOpen"_s].toBool())
        for (const QJsonValue& s : m[u"setupSteps"_s].toArray()) t << s[u"title"_s].toString() << s[u"detail"_s].toString();
    t << u"2 · 听哪个频道、信任谁"_s << u"频道 ID"_s << u"bot 加入的服务器里的一个频道"_s << u"信任的发送者"_s
      << u"只有这些人在这个频道发的消息才会被当成单子。关注过来的公告频道,发送者是那条关注本身(信任它 = 信任能在源频道发公告的人)。"_s;
    for (const QJsonValue& a : m[u"authors"_s].toArray()) t << a[u"text"_s].toString();
    if (m[u"authors"_s].toArray().isEmpty()) t << u"还没有信任任何人"_s;
    t << u"手动添加"_s << u"右键对方头像 →「复制用户 ID」;本地收件的写成 local:显示名"_s << u"添加"_s << u"本地收件"_s
      << u"对方的私密频道拉不进 bot 时:从你屏幕上的 Discord 窗口把新消息抄进收件文件,软件读文件。不用任何 token,Discord 那边什么都收不到。"_s << u"读哪个频道"_s
      << u"Discord 窗口标题里的频道名(不含 #)。填了,软件自己读这个窗口,随软件启动和退出;留空就要自己运行脚本。"_s << u"读窗口"_s << m[u"reader"_s][u"text"_s].toString();
    if (m[u"reader"_s][u"tag"_s].isObject()) t << m[u"reader"_s][u"tag"_s][u"text"_s].toString();
    t << u"收件文件"_s << m[u"inbox"_s][u"text"_s].toString() << m[u"inbox"_s][u"path"_s].toString() << u"本地收件怎么用"_s << u"频道里最近看到的消息(只在内存里,重启引擎就清空):"_s;
    for (const QJsonValue& s : m[u"seen"_s].toArray()) {
        t << s[u"name"_s].toString() << s[u"id"_s].toString();
        if (s[u"local"_s].toBool()) t << u"本地收件"_s;
        t << s[u"sub"_s].toString() << (s[u"trusted"_s].toBool() ? u"已信任"_s : u"信任"_s);
    }
    if (!m[u"seenEmpty"_s].toString().isEmpty()) t << m[u"seenEmpty"_s].toString();
    if (m[u"trustHint"_s].toBool()) t << u"点某一条右边的「信任」,就把它的发送者加进名单;保存之后才生效。"_s;
    t << u"3 · 发到哪、最多亏多少"_s << u"发到这些账户"_s << u"一个都不勾 = 默认账户。勾两个就每单各发一份,上限各算各的。"_s;
    for (const QJsonValue& a : m[u"accounts"_s].toArray()) t << a[u"label"_s].toString();
    t << u"每单最坏亏损上限"_s << u"USD。蝴蝶 = 张数 × 100 × 权利金;贷方价差 = 张数 × 100 ×(宽度 − 收到的权利金)"_s << u"每天最多跟几单"_s << m[u"perDaySub"_s].toString()
      << u"消息多旧就不跟"_s << u"秒。断线之后补到的旧消息不追"_s << u"这三个上限是跟单多加的一道;「设置」里的限额、保护规则、熔断照常生效,取更严的那个。"_s << u"4 · 成交之后"_s
      << u"成交后自动建追踪(只管蝴蝶)"_s
      << u"跟进来的蝴蝶成交之后,软件自己给它建一条持仓追踪并打开「到价自动平仓」:按蝶式预设(分档利润回撤)盯着,触发了直接发平仓单,不再问你。贷方价差不建。软件关着、电脑睡着时不盯。"_s
      << u"到点平仓(美东)"_s
      << u"自动建的那条追踪到这个钟点持仓还在就平,写成 HH:MM(如 15:45);留空 = 不设。建追踪时这个钟点已经过了,就落在下一次(第二天)。只在上面那一项开着时有用。"_s;
    const int pending = m[u"tracksPending"_s].toInt();
    if (pending > 0)
        t << u"在等成交"_s << u"有 %1 只跟进去的蝴蝶还没成交(或刚成交):成交之后几秒内自动建追踪,建好、建不了都会发通知。"_s.arg(pending) << u"%1 只"_s.arg(pending);
    t << u"软件只跟对方的开仓:他什么时候走、止盈止损设在哪,软件不知道。上面这一项是用你自己的规则替跟进来的蝴蝶收尾,不是跟着他平。"_s << u"5 · 开关"_s << u"自动跟单"_s
      << u"关着 = 只观察。关是当场生效的,开要点保存"_s;
    if (!m[u"problems"_s].toArray().isEmpty()) {
        t << u"还不能保存"_s;
        for (const QJsonValue& p : m[u"problems"_s].toArray()) t << p.toString();
    }
    t << u"保存"_s;
    if (m[u"dirty"_s].toBool()) t << u"有未保存的修改"_s;
    t << u"最近的信号"_s << badge(int(m[u"recent"_s].toArray().size()));
    for (const QJsonValue& r : m[u"recent"_s].toArray()) {
        t << r[u"label"_s].toString() << r[u"sub"_s].toString();
        if (r.toObject().contains(u"quote"_s)) t << r[u"quote"_s].toString();
        t << r[u"tag"_s].toString();
    }
    if (m[u"recent"_s].toArray().isEmpty())
        t << u"信任的发送者发来像单子的消息之后,每一条跟了没有、为什么,都记在这里;连着 TWS 时还会记下处理完那一刻的盘口,对着对方写的价"_s;
    return t;
}

}  // namespace ibkr::shell::access
