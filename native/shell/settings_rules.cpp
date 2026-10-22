#include "shell/settings_rules.h"

#include "shell/jsvalue.h"
#include "shell/records_rules.h"

#include <QDateTime>

#include <cmath>
#include <limits>

namespace ibkr::shell::settings {

using namespace Qt::StringLiterals;

namespace {

QJsonObject obj(const QJsonValue& v) { return v.toObject(); }
/// a ?? b(undefined / null 才换)
QJsonValue orNull(const QJsonValue& v) { return v.isUndefined() || v.isNull() ? QJsonValue(QJsonValue::Null) : v; }
/// filled:不是 null、是有限的数
bool filled(const QJsonValue& v) { return v.isDouble() && std::isfinite(v.toDouble()); }
bool positive(const QJsonValue& v) { return filled(v) && v.toDouble() > 0; }
/// 比较时照 JS 的隐式转换(null → 0、"5" → 5、undefined → NaN)
double num(const QJsonValue& v) { return jsNumber(v); }

/// 账户能单独覆盖的那几项:表单里的名字 → 配置里的键
const QList<QPair<QString, QString>>& accountKeys() {
    static const QList<QPair<QString, QString>> keys{
        {u"notional"_s, u"max_order_notional"_s}, {u"contracts"_s, u"max_option_contracts"_s},
        {u"openRisk"_s, u"max_open_risk_usd"_s}, {u"underlying"_s, u"max_underlying_contracts"_s}};
    return keys;
}

}  // namespace

// ---- lib/settingsForm.ts ---------------------------------------------------------------------------

QJsonObject toForm(const QJsonValue& settings) {
    const QJsonObject s = obj(settings);
    const QJsonObject p = obj(s.value("policies"_L1));
    const QJsonObject l = obj(s.value("limits"_L1));
    const QJsonObject pr = obj(s.value("protections"_L1));
    const QJsonObject sg = obj(pr.value("stoploss_guard"_L1));
    const QJsonObject dd = obj(pr.value("max_drawdown"_L1));
    const QJsonObject cd = obj(pr.value("cooldown"_L1));
    const QJsonObject dl = obj(pr.value("daily_loss"_L1));
    const QJsonObject rb = obj(s.value("risk_budget"_L1));
    const QJsonArray accounts = s.value("accounts"_L1).toArray();
    QJsonObject byAccount, rbEquity;
    for (const QJsonValue& a : accounts) {
        const QString alias = jsString(a.toObject().value("alias"_L1));
        const QJsonObject own = obj(obj(l.value("by_account"_L1)).value(alias));
        QJsonObject fields;
        for (const auto& [field, key] : accountKeys()) fields[field] = orNull(own.value(key));
        byAccount[alias] = fields;
        rbEquity[alias] = orNull(obj(rb.value("equity_usd"_L1)).value(alias));
    }
    const QJsonValue mid = l.value("auto_mid_spread_share"_L1);
    return QJsonObject{
        {u"autoExecute"_s, jsTruthy(p.value("auto_execute"_L1))},
        {u"allowLive"_s, jsTruthy(p.value("allow_live_trading"_L1))},
        {u"triggerVerify"_s, jsTruthy(p.value("require_trigger_price_verification"_L1))},
        {u"notional"_s, orNull(l.value("max_order_notional"_L1))},
        {u"contracts"_s, orNull(l.value("max_option_contracts"_L1))},
        {u"mktShares"_s, orNull(l.value("max_mkt_shares"_L1))},
        {u"slippage"_s, orNull(l.value("max_spread_slippage"_L1))},
        {u"dupe"_s, orNull(l.value("duplicate_window_minutes"_L1))},
        // 0 = 不设:表单里摆成空格子
        {u"openRisk"_s, jsTruthy(l.value("max_open_risk_usd"_L1)) ? l.value("max_open_risk_usd"_L1) : QJsonValue(QJsonValue::Null)},
        {u"underlying"_s, jsTruthy(l.value("max_underlying_contracts"_L1)) ? l.value("max_underlying_contracts"_L1) : QJsonValue(QJsonValue::Null)},
        {u"midShare"_s, jsTruthy(mid) ? QJsonValue(jsRound(jsNumber(mid) * 1000) / 10) : QJsonValue(QJsonValue::Null)},
        {u"byAccount"_s, byAccount},
        {u"slGuard"_s, jsTruthy(sg.value("enabled"_L1))},
        {u"slLookback"_s, orNull(sg.value("lookback_minutes"_L1))},
        {u"slCount"_s, orNull(sg.value("trigger_count"_L1))},
        {u"slPause"_s, orNull(sg.value("pause_minutes"_L1))},
        {u"ddGuard"_s, jsTruthy(dd.value("enabled"_L1))},
        {u"ddLookback"_s, orNull(dd.value("lookback_minutes"_L1))},
        {u"ddUsd"_s, orNull(dd.value("max_drawdown_usd"_L1))},
        {u"ddPause"_s, orNull(dd.value("pause_minutes"_L1))},
        {u"coolOn"_s, jsTruthy(cd.value("enabled"_L1))},
        {u"coolMinutes"_s, orNull(cd.value("minutes"_L1))},
        {u"coolScope"_s, cd.value("scope"_L1).toString() == u"position" ? u"position"_s : u"symbol"_s},
        {u"dailyOn"_s, jsTruthy(dl.value("enabled"_L1))},
        {u"dailyUsd"_s, orNull(dl.value("max_loss_usd"_L1))},
        {u"dailyBasis"_s, dl.value("basis"_L1).toString() == u"account" ? u"account"_s : u"realized"_s},
        {u"rbOn"_s, jsTruthy(rb.value("enabled"_L1))},
        {u"rbRisk"_s, orNull(rb.value("max_risk_pct"_L1))},
        {u"rbPosition"_s, orNull(rb.value("max_position_pct"_L1))},
        {u"rbEquity"_s, rbEquity},
    };
}

QStringList accountOrder(const QJsonValue& saved) {
    QStringList out;
    for (const QJsonValue& a : obj(saved).value("accounts"_L1).toArray()) {
        const QString alias = jsString(a.toObject().value("alias"_L1));
        if (!out.contains(alias)) out << alias;
    }
    return out;
}

namespace {
/// 这个对象的键,先按给的次序、再把剩下的按原样(排过序的)接在后面
QStringList keysInOrder(const QJsonObject& o, const QStringList& order) {
    QStringList out;
    for (const QString& k : order)
        if (o.contains(k) && !out.contains(k)) out << k;
    for (auto it = o.begin(); it != o.end(); ++it)
        if (!out.contains(it.key())) out << it.key();
    return out;
}
}  // namespace

QStringList formProblems(const QJsonObject& f, const QStringList& accountOrder) {
    QStringList out;
    const auto need = [&out](bool ok, const QString& text) {
        if (!ok) out << text;
    };
    const auto v = [&f](const char* k) { return f.value(QLatin1String(k)); };
    need(positive(v("notional")), u"「单笔名义金额上限」要填一个大于 0 的数"_s);
    need(filled(v("contracts")) && num(v("contracts")) >= 1, u"「期权 / 价差单笔上限」至少是 1 张"_s);
    need(filled(v("mktShares")) && num(v("mktShares")) >= 1, u"「市价单股数上限」至少是 1 股"_s);
    need(filled(v("slippage")) && num(v("slippage")) >= 0, u"「AUTO_MID 滑点上限」要填一个不小于 0 的数"_s);
    need(filled(v("dupe")) && num(v("dupe")) >= 0, u"「重复防抖窗口」不能空着:空着会被存成 0,等于关掉重复单防抖。确实要关就填 0"_s);
    // f.midShare === null || (>= 0 && <= 100):不是数的(NaN 一类)比较都不成立
    need(v("midShare").isNull() || (num(v("midShare")) >= 0 && num(v("midShare")) <= 100), u"「AUTO_MID 按价差让价」要在 0 到 100 之间(百分比)"_s);
    const QJsonObject by = v("byAccount").toObject();
    for (const QString& alias : keysInOrder(by, accountOrder)) {
        const QJsonObject own = by.value(alias).toObject();
        need(own.value("notional"_L1).isNull() || num(own.value("notional"_L1)) > 0, u"「%1」的单笔名义金额上限要大于 0;想用全局的就空着"_s.arg(alias));
        need(own.value("contracts"_L1).isNull() || num(own.value("contracts"_L1)) >= 1, u"「%1」的期权 / 价差单笔上限至少是 1 张;想用全局的就空着"_s.arg(alias));
    }
    if (v("slGuard").toBool()) {
        need(positive(v("slLookback")) && positive(v("slPause")), u"「止损护栏」开着:往回看与暂停多久都要填大于 0 的分钟数"_s);
        need(filled(v("slCount")) && num(v("slCount")) >= 1, u"「止损护栏」开着:几次止损算数至少是 1"_s);
    }
    if (v("ddGuard").toBool()) {
        need(positive(v("ddLookback")) && positive(v("ddPause")), u"「回撤护栏」开着:往回看与暂停多久都要填大于 0 的分钟数"_s);
        need(positive(v("ddUsd")), u"「回撤护栏」开着:回撤阈值要填大于 0 的金额。填 0 或空着,这条规则不会生效"_s);
    }
    if (v("coolOn").toBool()) need(positive(v("coolMinutes")), u"「同标的冷却」开着:冷却多久要填大于 0 的分钟数"_s);
    if (v("dailyOn").toBool()) need(positive(v("dailyUsd")), u"「日内亏损上限」开着:当天最多亏要填大于 0 的金额。填 0 或空着,这条规则不会生效"_s);
    if (v("rbOn").toBool()) need(positive(v("rbRisk")) && positive(v("rbPosition")), u"「按账户权益提醒」开着:两个百分比都要填大于 0 的数"_s);
    return out;
}

namespace {

/// keep(section, key, v):填了送填的;空着照已保存的送回去(那一份是数才送),都没有就不送这个键
void keep(QJsonObject& out, const QJsonObject& section, const QString& key, const QJsonValue& v) {
    if (filled(v)) out[key] = v;
    else if (section.value(key).isDouble()) out[key] = section.value(key);
}

/// 按账户覆盖的那一段:填了的送数;空着的,已保存的那份里本来就没有 → 不送,本来有 → 送 null(清掉这一项的覆盖)。一项都没有时整段不送
QJsonObject accountLimitsPatch(const QJsonObject& f, const QJsonObject& saved) {
    QJsonObject out;
    const QJsonObject by = f.value("byAccount"_L1).toObject();
    for (auto it = by.begin(); it != by.end(); ++it) {
        const QJsonObject own = it.value().toObject();
        const QJsonObject had = saved.value(it.key()).toObject();
        QJsonObject one;
        for (const auto& [field, key] : accountKeys()) {
            const QJsonValue value = own.value(field);
            if (filled(value)) one[key] = value;
            else if (!had.value(key).isNull() && !had.value(key).isUndefined()) one[key] = QJsonValue::Null;
        }
        if (!one.isEmpty()) out[it.key()] = one;
    }
    return out;
}

}  // namespace

QJsonObject toPatch(const QJsonObject& f, const QJsonValue& savedValue) {
    const QJsonObject saved = obj(savedValue);
    const QJsonObject l = obj(saved.value("limits"_L1));
    const QJsonObject pr = obj(saved.value("protections"_L1));
    const QJsonObject rb = obj(saved.value("risk_budget"_L1));
    const auto v = [&f](const char* k) { return f.value(QLatin1String(k)); };

    QJsonObject equity;
    const QJsonObject rbEquity = v("rbEquity").toObject();
    for (auto it = rbEquity.begin(); it != rbEquity.end(); ++it)  // 0 = 这个账户不提醒(引擎的口径)
        equity[it.key()] = filled(it.value()) && it.value().toDouble() > 0 ? it.value().toDouble() : 0.0;

    QJsonObject limits;
    keep(limits, l, u"max_order_notional"_s, v("notional"));
    keep(limits, l, u"max_option_contracts"_s, v("contracts"));
    keep(limits, l, u"max_mkt_shares"_s, v("mktShares"));
    keep(limits, l, u"max_spread_slippage"_s, v("slippage"));
    keep(limits, l, u"duplicate_window_minutes"_s, v("dupe"));
    // 这三项「空着 = 不设」:空就是引擎的 0(数本身就是开关)
    limits[u"max_open_risk_usd"_s] = positive(v("openRisk")) ? num(v("openRisk")) : 0.0;
    limits[u"max_underlying_contracts"_s] = positive(v("underlying")) ? std::trunc(num(v("underlying"))) : 0.0;
    limits[u"auto_mid_spread_share"_s] = positive(v("midShare")) ? std::min(num(v("midShare")), 100.0) / 100 : 0.0;
    const QJsonObject byAccount = accountLimitsPatch(f, obj(l.value("by_account"_L1)));
    if (!byAccount.isEmpty()) limits[u"by_account"_s] = byAccount;

    QJsonObject sg{{u"enabled"_s, v("slGuard").toBool()}};
    keep(sg, obj(pr.value("stoploss_guard"_L1)), u"lookback_minutes"_s, v("slLookback"));
    keep(sg, obj(pr.value("stoploss_guard"_L1)), u"trigger_count"_s, v("slCount"));
    keep(sg, obj(pr.value("stoploss_guard"_L1)), u"pause_minutes"_s, v("slPause"));
    QJsonObject dd{{u"enabled"_s, v("ddGuard").toBool()}};
    keep(dd, obj(pr.value("max_drawdown"_L1)), u"lookback_minutes"_s, v("ddLookback"));
    keep(dd, obj(pr.value("max_drawdown"_L1)), u"max_drawdown_usd"_s, v("ddUsd"));
    keep(dd, obj(pr.value("max_drawdown"_L1)), u"pause_minutes"_s, v("ddPause"));
    QJsonObject cd{{u"enabled"_s, v("coolOn").toBool()}, {u"scope"_s, v("coolScope").toString()}};
    keep(cd, obj(pr.value("cooldown"_L1)), u"minutes"_s, v("coolMinutes"));
    QJsonObject dl{{u"enabled"_s, v("dailyOn").toBool()}, {u"basis"_s, v("dailyBasis").toString()}};
    keep(dl, obj(pr.value("daily_loss"_L1)), u"max_loss_usd"_s, v("dailyUsd"));
    QJsonObject budget{{u"enabled"_s, v("rbOn").toBool()}, {u"equity_usd"_s, equity}};
    keep(budget, rb, u"max_risk_pct"_s, v("rbRisk"));
    keep(budget, rb, u"max_position_pct"_s, v("rbPosition"));

    return QJsonObject{
        {u"policies"_s, QJsonObject{{u"auto_execute"_s, v("autoExecute").toBool()},
                                    {u"allow_live_trading"_s, v("allowLive").toBool()},
                                    {u"require_trigger_price_verification"_s, v("triggerVerify").toBool()}}},
        {u"limits"_s, limits},
        {u"protections"_s, QJsonObject{{u"stoploss_guard"_s, sg}, {u"max_drawdown"_s, dd}, {u"cooldown"_s, cd}, {u"daily_loss"_s, dl}}},
        {u"risk_budget"_s, budget},
    };
}

bool isDirty(const QJsonObject& form, const QJsonValue& saved) {
    // 原版比的是 JSON.stringify(f) 与 JSON.stringify(toForm(saved)):两边的键都由 toForm 定、次序相同,结构相等即字面相等
    if (saved.isNull() || saved.isUndefined()) return false;
    return form != toForm(saved);
}

// ---- 设置页 ----------------------------------------------------------------------------------------

QString fmtBytes(double bytes) {
    if (bytes >= 1024 * 1024) return jsToFixed(bytes / 1024 / 1024, 1) + u" MB"_s;
    return jsNumberToString(std::max(1.0, jsRound(bytes / 1024))) + u" KB"_s;
}

namespace {

QJsonObject switchRow(const QString& key, const QString& icon, const QString& tint, const QString& label, const QString& sub, bool checked, bool disabled = false) {
    return QJsonObject{{u"kind"_s, u"switch"_s}, {u"key"_s, key}, {u"icon"_s, icon}, {u"tint"_s, tint}, {u"label"_s, label}, {u"sub"_s, sub},
                       {u"checked"_s, checked}, {u"disabled"_s, disabled}};
}

constexpr double kNone = std::numeric_limits<double>::quiet_NaN();

QJsonObject numberRow(const QString& key, const QString& icon, const QString& tint, const QString& label, const QString& sub, const QJsonValue& value,
                      double min, double max, double step, const QString& placeholder = {}, bool disabled = false) {
    QJsonObject r{{u"kind"_s, u"number"_s}, {u"key"_s, key}, {u"icon"_s, icon}, {u"tint"_s, tint}, {u"label"_s, label}, {u"sub"_s, sub},
                  {u"value"_s, orNull(value)}, {u"step"_s, step}, {u"placeholder"_s, placeholder}, {u"disabled"_s, disabled}};
    if (!std::isnan(min)) r[u"min"_s] = min;
    if (!std::isnan(max)) r[u"max"_s] = max;
    return r;
}

QJsonObject segmentRow(const QString& key, const QString& icon, const QString& tint, const QString& label, const QString& sub, const QJsonArray& options, const QString& selected) {
    return QJsonObject{{u"kind"_s, u"segment"_s}, {u"key"_s, key}, {u"icon"_s, icon}, {u"tint"_s, tint}, {u"label"_s, label}, {u"sub"_s, sub},
                       {u"options"_s, options}, {u"selected"_s, selected}};
}

QJsonArray options(std::initializer_list<QPair<QString, QString>> list) {
    QJsonArray out;
    for (const auto& [value, label] : list) out.append(QJsonObject{{u"value"_s, value}, {u"label"_s, label}});
    return out;
}

const QString kProtectHint1 = u"比熔断细一档:接连止损、盈亏回撤过大、当天亏到上限、同一只刚平过仓,就先停一会儿自动执行。到点自己解除,不用人工。"_s;
const QString kProtectHint2 = u"只挡新单,永远不挡平仓。"_s;
const QString kProtectHint3 = u"被挡下的单停在「仅校验未发送」,保护期过了还能再发。"_s;
const QString kAccountsHint = u"只填要和上面不一样的那几项,空着的用上面的;往松了改同样要确认。"_s;
const QString kBudgetHint = u"一单占账户权益太多时,在订单卡片上多一句提醒;只提醒,不拦单,平仓单不受影响。权益填了就用填的;空着的 IBKR 美元账户用券商报的净值。"_s;
const QString kConfigHint = u"账户在「接入 → 账户」里配。连接(端口、client id)只能手动编辑配置文件,改完重启交易引擎生效。"_s;
const QString kEventsHint = u"今天要公布的数(CPI、非农、FOMC…)一直挂在顶栏下面,直到公布过了一阵;公布前弹窗提醒,「应对」能把一句对冲指令写进指令框。板块联动:一个板块里多数成分股同向走出一大截时也挂上去。"_s;
const QString kDataHint = u"每天第一次打开、每次升级之前,软件会自动给交易库留一份备份(每日 7 份、升级前 3 份、手动 5 份,旧的自动清掉)。备份和交易库在同一块盘上:换电脑、防硬盘损坏,请把备份目录另拷一份到别处。"_s;

QJsonArray eventsRows(const QJsonObject& d) {
    const bool on = d.value("enabled"_L1).toBool();
    const bool cross = d.value("cross_market"_L1).toBool();
    const QJsonArray leads = d.value("lead_minutes"_L1).toArray();
    const QJsonValue share = d.value("sector_share"_L1);
    return QJsonArray{
        switchRow(u"enabled"_s, u"sf-bell"_s, u"orange"_s, u"重要事件"_s, u"关了就不挂、不提醒、不拉日历"_s, on),
        switchRow(u"feed"_s, u"sf-scan"_s, u"blue"_s, u"公开日历"_s,
                  u"Forex Factory 的本周日历(faireconomy.media),几小时拉一次;关了只剩内置的官方日程(CPI、PPI、非农、FOMC、PCE、GDP)"_s,
                  d.value("feed"_L1).toBool(), !on),
        numberRow(u"min_stars"_s, u"sf-layers"_s, u"orange"_s, u"最低星级"_s,
                  u"仿照金十的分档(本软件自己定,不是金十的数据):5 星 CPI / 非农 / FOMC 决议 / 联储主席讲话,4 星 PPI / 零售 / 初请失业金 / PCE / GDP / ISM / JOLTS / ADP;3 星以下只在公布前一小时上顶"_s,
                  d.value("min_stars"_L1), 1, 5, 1, {}, !on),
        numberRow(u"lead1"_s, u"sf-clock"_s, u"orange"_s, u"第一次提前提醒"_s, u"分钟;空着 = 不要这一档"_s, leads.size() > 0 ? leads.at(0) : QJsonValue(), 1, 1440, 5, u"不要"_s, !on),
        numberRow(u"lead2"_s, u"sf-clock"_s, u"orange"_s, u"第二次提前提醒"_s, u"分钟"_s, leads.size() > 1 ? leads.at(1) : QJsonValue(), 1, 1440, 5, u"不要"_s, !on),
        switchRow(u"cross_market"_s, u"sf-antenna"_s, u"purple"_s, u"跨市场跟跌套利(P0)"_s,
                  u"美股大动而韩股(EWY)、A 股(ASHR)的美股 ETF 没同步时,从美股盘中起挂到顶上并弹窗,到 A 股开盘后一小时;「应对」默认卖空 KORU / YINN"_s, cross, !on),
        numberRow(u"cross_market_pct"_s, u"sf-updown"_s, u"purple"_s, u"跨市场:美股涨跌幅"_s, u"% 标普 500 较昨收,超过它才看"_s, d.value("cross_market_pct"_L1), 0.3, 10, 0.1, {}, !on || !cross),
        numberRow(u"cross_lag_pct"_s, u"sf-updown"_s, u"purple"_s, u"跨市场:差距"_s, u"个点:ETF 比指数少跌(少涨)这么多才算没跟"_s, d.value("cross_lag_pct"_L1), 0.2, 10, 0.1, {}, !on || !cross),
        numberRow(u"sector_move_pct"_s, u"sf-updown"_s, u"red"_s, u"板块联动:涨跌幅"_s, u"% 较昨收,同向超过它才算"_s, d.value("sector_move_pct"_L1), 0.5, 50, 0.5, {}, !on),
        numberRow(u"sector_share"_s, u"sf-layers"_s, u"red"_s, u"板块联动:比例"_s, u"% 的成分股同向超线"_s, QJsonValue(jsRound(jsNumber(share) * 100)), 30, 100, 10, {}, !on),
        numberRow(u"sector_min_stocks"_s, u"sf-layers"_s, u"red"_s, u"板块联动:最少只数"_s, u"有行情的成分股少于它的板块不看"_s, d.value("sector_min_stocks"_L1), 2, 30, 1, {}, !on),
    };
}

QJsonObject dataModel(const PageInput& in, const QTimeZone& zone) {
    if (!in.dataError.isEmpty()) return QJsonObject{{u"state"_s, u"error"_s}, {u"error"_s, in.dataError}};
    if (in.dataInfo.isNull() || in.dataInfo.isUndefined()) return QJsonObject{{u"state"_s, u"loading"_s}};
    const QJsonObject info = in.dataInfo.toObject();
    const QString busy = in.dataBusy.isString() ? in.dataBusy.toString() : QString();
    const bool anyBusy = in.dataBusy.isString();
    static const QHash<QString, QString> reason{{u"daily"_s, u"每日自动"_s}, {u"upgrade"_s, u"升级前"_s}, {u"manual"_s, u"手动"_s}};
    QJsonArray rows;
    for (const QJsonValue& v : info.value("backups"_L1).toArray()) {
        const QJsonObject b = v.toObject();
        const QString name = b.value("name"_L1).toString();
        rows.append(QJsonObject{{u"name"_s, name},
                                {u"label"_s, records::fmtTime(b.value("at"_L1), zone)},
                                {u"sub"_s, u"%1 · %2"_s.arg(reason.value(b.value("reason"_L1).toString(), jsString(b.value("reason"_L1))), fmtBytes(jsNumber(b.value("bytes"_L1))))},
                                {u"loading"_s, anyBusy && busy == name},
                                {u"disabled"_s, anyBusy && busy != name}});
    }
    return QJsonObject{{u"state"_s, u"ready"_s}, {u"dbPath"_s, jsString(info.value("db_path"_L1))}, {u"backupLoading"_s, busy == u"backup"},
                       {u"empty"_s, rows.isEmpty()}, {u"rows"_s, rows}};
}

}  // namespace

QJsonObject pageModel(const PageInput& in, const QTimeZone& zone) {
    // 玻璃滑杆 0–100、步长 5:rc-slider 把值落到最近的一格(0.72 → 72 → 70)
    QJsonObject m{
        {u"appearance"_s, QJsonObject{{u"themeMode"_s, in.themeMode}, {u"upDown"_s, in.upDown}, {u"glass"_s, jsRound(jsRound(in.glass * 100) / 5) * 5}}},
        {u"data"_s, dataModel(in, zone)},
        {u"events"_s, in.eventsDraft.isObject() ? QJsonValue(eventsRows(in.eventsDraft.toObject())) : QJsonValue(QJsonValue::Null)},
    };
    if (!in.form.isObject()) {
        m[u"loading"_s] = true;
        m[u"dirty"_s] = false;
        m[u"saving"_s] = in.saving;
        return m;
    }
    const QJsonObject f = in.form.toObject();
    const auto v = [&f](const char* k) { return f.value(QLatin1String(k)); };
    m[u"loading"_s] = false;
    m[u"dirty"_s] = isDirty(f, in.saved);
    m[u"saving"_s] = in.saving;
    m[u"gates"_s] = QJsonArray{
        switchRow(u"autoExecute"_s, u"sf-bolt"_s, u"orange"_s, u"允许自动执行"_s, u"关闭时只解析校验,永不发单。关是当场生效的,开要点保存"_s, v("autoExecute").toBool()),
        switchRow(u"allowLive"_s, u"sf-dollar"_s, u"red"_s, u"允许实盘账户下单"_s, u"默认关闭,纸面账户不受此限。关是当场生效的,开要点保存"_s, v("allowLive").toBool()),
        switchRow(u"triggerVerify"_s, u"sf-shield"_s, u"blue"_s, u"触发方向必须有现价"_s, u"拿不到现价就拒绝条件单"_s, v("triggerVerify").toBool()),
    };
    m[u"limits"_s] = QJsonArray{
        numberRow(u"notional"_s, u"sf-dollar"_s, u"green"_s, u"单笔名义金额上限"_s, u"USD"_s, v("notional"), 0, kNone, 100),
        numberRow(u"contracts"_s, u"sf-layers"_s, u"purple"_s, u"期权 / 价差单笔上限"_s, u"张"_s, v("contracts"), 1, kNone, 1),
        numberRow(u"mktShares"_s, u"sf-gauge"_s, u"orange"_s, u"市价单股数上限"_s, u"无法估价时"_s, v("mktShares"), 1, kNone, 10),
        numberRow(u"slippage"_s, u"sf-scan"_s, u"teal"_s, u"AUTO_MID 滑点上限"_s, u"美元 / 张"_s, v("slippage"), 0, kNone, 0.01),
        numberRow(u"midShare"_s, u"sf-scan"_s, u"teal"_s, u"AUTO_MID 按价差让价"_s, u"%:中间价到立刻成交价那一段让多少。空着 = 不用它,照上面的固定滑点"_s, v("midShare"), 0, 100, 5, u"不用"_s),
        numberRow(u"dupe"_s, u"sf-clock"_s, u"gray"_s, u"重复防抖窗口"_s, u"分钟"_s, v("dupe"), 0, kNone, 1),
        numberRow(u"openRisk"_s, u"sf-shield"_s, u"red"_s, u"在手期权的最坏亏损上限"_s, u"USD,每个账户各算:在手的 + 这一单超过就拒;平仓不拦。空着 = 不设"_s, v("openRisk"), 0, kNone, 100, u"不设"_s),
        numberRow(u"underlying"_s, u"sf-layers"_s, u"purple"_s, u"同标的同到期的张数上限"_s, u"张,组合按组数:在手的 + 这一单超过就拒。空着 = 不设"_s, v("underlying"), 0, kNone, 1, u"不设"_s),
    };
    // 按账户覆盖:多于一个账户才摆;纸面 / 实盘看已保存的那份账户表
    QJsonArray accounts;
    const QJsonObject by = v("byAccount").toObject();
    if (by.size() > 1) {
        QHash<QString, bool> paper;
        for (const QJsonValue& a : obj(in.saved).value("accounts"_L1).toArray()) paper[jsString(a.toObject().value("alias"_L1))] = jsTruthy(a.toObject().value("is_paper"_L1));
        static const QList<std::tuple<QString, QString, double, double>> fields{
            {u"notional"_s, u"单笔金额"_s, 100, 0}, {u"contracts"_s, u"单笔张数"_s, 1, 1}, {u"openRisk"_s, u"在手风险"_s, 100, 0}, {u"underlying"_s, u"同标的张数"_s, 1, 0}};
        // 原版按 Object.entries(byAccount) 的次序(= 账户表的次序);QJsonObject 是排过序的,照账户表重排
        QStringList order;
        for (const QJsonValue& a : obj(in.saved).value("accounts"_L1).toArray()) order << jsString(a.toObject().value("alias"_L1));
        for (auto it = by.begin(); it != by.end(); ++it)
            if (!order.contains(it.key())) order << it.key();
        for (const QString& alias : order) {
            if (!by.contains(alias)) continue;
            const QJsonObject own = by.value(alias).toObject();
            QJsonArray cells;
            for (const auto& [key, label, step, min] : fields)
                cells.append(QJsonObject{{u"key"_s, key}, {u"label"_s, label}, {u"step"_s, step}, {u"min"_s, min}, {u"value"_s, orNull(own.value(key))}});
            const bool isPaper = paper.value(alias, false);
            accounts.append(QJsonObject{{u"alias"_s, alias}, {u"tint"_s, isPaper ? u"gray"_s : u"red"_s}, {u"sub"_s, isPaper ? u"纸面账户"_s : u"实盘账户"_s}, {u"fields"_s, cells}});
        }
    }
    m[u"accounts"_s] = accounts;
    QJsonArray prot{switchRow(u"slGuard"_s, u"sf-shield"_s, u"orange"_s, u"止损护栏"_s, u"窗口内止损够次数就暂停自动执行"_s, v("slGuard").toBool())};
    if (v("slGuard").toBool()) {
        prot.append(numberRow(u"slLookback"_s, u"sf-clock"_s, u"gray"_s, u"往回看"_s, u"分钟"_s, v("slLookback"), 1, kNone, 10));
        prot.append(numberRow(u"slCount"_s, u"sf-xmark"_s, u"red"_s, u"几次止损算数"_s, u"次"_s, v("slCount"), 1, kNone, 1));
        prot.append(numberRow(u"slPause"_s, u"sf-hourglass"_s, u"orange"_s, u"暂停多久"_s, u"分钟,从最后一次止损算起"_s, v("slPause"), 1, kNone, 10));
    }
    prot.append(switchRow(u"ddGuard"_s, u"sf-arrow-down"_s, u"red"_s, u"回撤护栏"_s, u"已实现盈亏从峰值回落够多就暂停"_s, v("ddGuard").toBool()));
    if (v("ddGuard").toBool()) {
        prot.append(numberRow(u"ddLookback"_s, u"sf-clock"_s, u"gray"_s, u"往回看"_s, u"分钟"_s, v("ddLookback"), 1, kNone, 60));
        prot.append(numberRow(u"ddUsd"_s, u"sf-dollar"_s, u"red"_s, u"回撤阈值"_s, u"USD,盈亏以券商报的为准"_s, v("ddUsd"), 0, kNone, 100));
        prot.append(numberRow(u"ddPause"_s, u"sf-hourglass"_s, u"orange"_s, u"暂停多久"_s, u"分钟,从最低点算起"_s, v("ddPause"), 1, kNone, 10));
    }
    prot.append(switchRow(u"coolOn"_s, u"sf-pulse"_s, u"teal"_s, u"同标的冷却"_s, u"刚平过仓的标的,一段时间内不再下新单"_s, v("coolOn").toBool()));
    if (v("coolOn").toBool()) {
        prot.append(numberRow(u"coolMinutes"_s, u"sf-clock"_s, u"gray"_s, u"冷却多久"_s, u"分钟"_s, v("coolMinutes"), 1, kNone, 5));
        prot.append(segmentRow(u"coolScope"_s, u"sf-layers"_s, u"teal"_s, u"冷却挡什么"_s,
                               u"只做一个标的的人选「同一个结构」:只挡和刚平掉的那份持仓同到期、同行权价的单,别的照发"_s,
                               options({{u"symbol"_s, u"这只标的"_s}, {u"position"_s, u"同一个结构"_s}}), v("coolScope").toString()));
    }
    prot.append(switchRow(u"dailyOn"_s, u"sf-gauge"_s, u"red"_s, u"日内亏损上限"_s, u"当天(美东)净亏到线,当天不再下新单;第二天零点自己解除"_s, v("dailyOn").toBool()));
    if (v("dailyOn").toBool()) {
        prot.append(numberRow(u"dailyUsd"_s, u"sf-dollar"_s, u"red"_s, u"当天最多亏"_s, u"USD,盈亏以券商报的为准"_s, v("dailyUsd"), 0, kNone, 100));
        prot.append(segmentRow(u"dailyBasis"_s, u"sf-gauge"_s, u"red"_s, u"拿什么算"_s,
                               u"已实现盈亏:只数软件发的单、平了才算。账户当日盈亏:券商报的,含没平的浮亏和在 TWS 里手动做的单,每个账户各算各的(只认美元账户;券商没报时退回已实现盈亏)"_s,
                               options({{u"realized"_s, u"已实现盈亏"_s}, {u"account"_s, u"账户当日盈亏"_s}}), v("dailyBasis").toString()));
    }
    m[u"protections"_s] = prot;
    QJsonArray budget{switchRow(u"rbOn"_s, u"sf-gauge"_s, u"orange"_s, u"按账户权益提醒"_s, u"期权 / 组合看最坏亏损,股票看名义金额"_s, v("rbOn").toBool())};
    if (v("rbOn").toBool()) {
        budget.append(numberRow(u"rbRisk"_s, u"sf-xmark"_s, u"red"_s, u"期权 / 组合最坏亏损"_s, u"占权益 %,冠军们多在 0.5–2"_s, v("rbRisk"), 0.1, 100, 0.5));
        budget.append(numberRow(u"rbPosition"_s, u"sf-layers"_s, u"purple"_s, u"股票仓位"_s, u"名义金额占权益 %"_s, v("rbPosition"), 0.1, 1000, 5));
        // 次序同账户表(Object.keys(form.rbEquity) 按 toForm 时账户的次序)
        const QJsonObject eq = v("rbEquity").toObject();
        QStringList order;
        for (const QJsonValue& a : obj(in.saved).value("accounts"_L1).toArray()) order << jsString(a.toObject().value("alias"_L1));
        for (auto it = eq.begin(); it != eq.end(); ++it)
            if (!order.contains(it.key())) order << it.key();
        for (const QString& alias : order) {
            if (!eq.contains(alias)) continue;
            budget.append(numberRow(u"rbEquity:"_s + alias, u"sf-dollar"_s, u"green"_s, alias + u" 的权益"_s, u"USD,空着 = 用券商报的净值(拿不到就不提醒)"_s,
                                    eq.value(alias), 0, kNone, 1000));
        }
    }
    m[u"budget"_s] = budget;
    m[u"problems"_s] = in.checked ? QJsonArray::fromStringList(formProblems(f, accountOrder(in.saved))) : QJsonArray{};
    return m;
}

namespace {

void rowTexts(QStringList& out, const QJsonArray& rows) {
    for (const QJsonValue& v : rows) {
        const QJsonObject r = v.toObject();
        out << r.value("label"_L1).toString() << r.value("sub"_L1).toString();
        if (r.value("kind"_L1).toString() == u"segment")
            for (const QJsonValue& o : r.value("options"_L1).toArray()) out << o.toObject().value("label"_L1).toString();
    }
}

}  // namespace

QStringList pageTexts(const QJsonObject& m) {
    QStringList out{u"设置"_s};
    if (m.value("dirty"_L1).toBool()) out << u"有未保存的修改"_s << u"保存设置"_s;
    out << u"外观"_s << u"深浅色"_s << u"跟随系统,或固定一种"_s << u"跟随系统"_s << u"浅色"_s << u"深色"_s
        << u"Liquid Glass"_s << u"侧栏、工具栏这些玻璃面有多透:左边通透,右边着色(更好读)"_s
        << u"涨跌配色"_s << u"K 线、行情带、盈亏数字统一跟随;默认美股习惯"_s << u"绿涨红跌"_s << u"红涨绿跌"_s;
    if (!m.value("loading"_L1).toBool()) {
        out << u"执行闸门"_s;
        rowTexts(out, m.value("gates"_L1).toArray());
        out << u"风控限额"_s;
        rowTexts(out, m.value("limits"_L1).toArray());
        const QJsonArray accounts = m.value("accounts"_L1).toArray();
        for (const QJsonValue& a : accounts) {
            out << a.toObject().value("alias"_L1).toString() << a.toObject().value("sub"_L1).toString();
            for (const QJsonValue& c : a.toObject().value("fields"_L1).toArray()) out << c.toObject().value("label"_L1).toString();
        }
        if (!accounts.isEmpty()) out << kAccountsHint;
        out << u"保护规则"_s << kProtectHint1 << kProtectHint2 << kProtectHint3;
        rowTexts(out, m.value("protections"_L1).toArray());
        out << u"单笔风险预算"_s;
        rowTexts(out, m.value("budget"_L1).toArray());
        out << kBudgetHint;
        const QJsonArray problems = m.value("problems"_L1).toArray();
        if (!problems.isEmpty()) {
            out << u"还不能保存"_s;
            for (const QJsonValue& p : problems) out << p.toString();
        }
        out << u"保存设置"_s << kConfigHint << u"打开配置文件所在位置"_s;
    }
    out << u"重要事件"_s;
    if (m.value("events"_L1).isArray()) {
        rowTexts(out, m.value("events"_L1).toArray());
        out << kEventsHint;
    } else {
        out << u"设置还没读到。"_s;
    }
    out << u"数据与备份"_s;
    const QJsonObject d = m.value("data"_L1).toObject();
    const QString state = d.value("state"_L1).toString();
    if (state == u"error") {
        out << u"读不到备份清单"_s << d.value("error"_L1).toString() << u"重试"_s << u"交易引擎起来之后这里才读得到。"_s;
    } else if (state == u"ready") {
        out << u"交易库"_s << d.value("dbPath"_L1).toString() << u"立即备份"_s << u"打开备份目录"_s;
        if (d.value("empty"_L1).toBool()) out << u"还没有备份"_s << u"第一份会在下一次启动时自动留下,也可以现在点「立即备份」"_s;
        for (const QJsonValue& v : d.value("rows"_L1).toArray())
            out << v.toObject().value("label"_L1).toString() << v.toObject().value("sub"_L1).toString() << u"恢复到这一份…"_s;
        out << kDataHint;
    }
    out.removeAll(QString());
    return out;
}

// ---- 关于页 ----------------------------------------------------------------------------------------

namespace {

/// UpdatePanel 的 fmtDate:本机时区的 YYYY-MM-DD;读不出是空
QString fmtDate(const QJsonValue& iso, const QTimeZone& zone) {
    if (!iso.isString() || iso.toString().isEmpty()) return {};
    const double ms = jsDateParse(iso.toString(), zone);
    if (std::isnan(ms)) return {};
    return QDateTime::fromMSecsSinceEpoch(qint64(ms), zone).toString(u"yyyy-MM-dd"_s);
}

QString fmtSize(const QJsonValue& bytes) {
    if (!bytes.isDouble() || !std::isfinite(bytes.toDouble()) || bytes.toDouble() == 0) return {};
    return u" · %1 MB"_s.arg(jsToFixed(bytes.toDouble() / 1024 / 1024, 0));
}

}  // namespace

QJsonObject aboutModel(const AboutInput& in) {
    QJsonObject m{{u"loading"_s, false}, {u"error"_s, in.error}};
    QJsonArray rows;
    QString current;
    if (in.error.isEmpty() && (in.info.isNull() || in.info.isUndefined())) {
        m[u"loading"_s] = true;
    } else if (in.error.isEmpty()) {
        const QJsonObject app = in.info.toObject().value("app"_L1).toObject();
        const QJsonObject self = in.info.toObject().value("self"_L1).toObject();
        current = jsTruthy(app.value("version"_L1)) ? jsString(app.value("version"_L1)) : QString();
        const auto row = [&rows](const QString& label, const QString& value) { rows.append(QJsonObject{{u"label"_s, label}, {u"value"_s, value}}); };
        const auto str = [](const QJsonValue& v) { return v.isUndefined() || v.isNull() ? QString() : jsString(v); };
        row(u"应用版本"_s, str(app.value("version"_L1)));
        if (jsTruthy(app.value("engineVersion"_L1))) row(u"交易引擎"_s, jsString(app.value("engineVersion"_L1)));
        if (app.contains("electron"_L1) || !app.contains("qt"_L1)) {
            row(u"Electron"_s, str(app.value("electron"_L1)));
            row(u"Chromium"_s, str(app.value("chrome"_L1)));
            row(u"Node"_s, str(app.value("node"_L1)));
        } else {
            // Qt 版没有 Electron / Chromium / Node 这三样,换成它自己用的 Qt 的版本
            row(u"Qt"_s, str(app.value("qt"_L1)));
        }
        row(u"配置文件"_s, str(app.value("configPath"_L1)));
        if (jsTruthy(app.value("logPath"_L1))) row(u"日志文件"_s, jsString(app.value("logPath"_L1)));
        row(u"提示词"_s, u"%1 · %2"_s.arg(str(self.value("prompt_version"_L1)), str(self.value("prompt_fingerprint"_L1))));
        row(u"系统提示词"_s, u"%1 字 / %2 组少样本"_s.arg(str(self.value("system_prompt_chars"_L1)), str(self.value("fewshot_pairs"_L1))));
        QStringList accounts;
        for (const QJsonValue& v : self.value("accounts"_L1).toArray()) {
            const QJsonObject a = v.toObject();
            accounts << u"%1(%2%3)"_s.arg(str(a.value("alias"_L1)), str(a.value("account_masked"_L1)), jsTruthy(a.value("is_paper"_L1)) ? u" 纸面"_s : u" 实盘"_s);
        }
        row(u"账户"_s, accounts.isEmpty() ? u"—"_s : accounts.join(u"、"_s));
        rows.append(QJsonObject{{u"label"_s, u"图表"_s}, {u"value"_s, u"TradingView Lightweight Charts™ · Copyright (c) 2025 TradingView, Inc. ·"_s},
                                {u"link"_s, u"https://www.tradingview.com/"_s}});
    }
    m[u"rows"_s] = rows;

    // UpdatePanel
    const QJsonObject u = in.update.toObject();
    const QJsonValue infoV = u.value("info"_L1);
    const QJsonObject info = infoV.toObject();
    const bool hasInfo = infoV.isObject();
    const bool checking = u.value("checking"_L1).toBool();
    const QString error = u.value("error"_L1).isString() ? u.value("error"_L1).toString() : QString();
    QString status;
    if (checking && !hasInfo) status = u"正在检查…"_s;
    else if (!error.isEmpty() && !hasInfo) status = error;
    else if (!hasInfo) status = u"还没检查过"_s;
    else if (info.value("newer"_L1).toBool())
        status = u"有新版本 %1%2"_s.arg(jsString(info.value("latest"_L1)),
                                    jsTruthy(info.value("publishedAt"_L1)) ? u"(%1 发布)"_s.arg(fmtDate(info.value("publishedAt"_L1), in.zone)) : QString());
    else if (jsTruthy(info.value("latest"_L1))) status = u"已是最新版本(GitHub 上最新是 %1)"_s.arg(jsString(info.value("latest"_L1)));
    else status = u"没读出最新的版本号"_s;
    const bool newer = hasInfo && info.value("newer"_L1).toBool();
    const QJsonValue newerVersion = newer ? orNull(info.value("latest"_L1)) : QJsonValue(QJsonValue::Null);
    QJsonArray buttons;
    if (newer && info.value("download"_L1).isObject()) {
        const QJsonObject dl = info.value("download"_L1).toObject();
        buttons.append(QJsonObject{{u"kind"_s, u"download"_s}, {u"text"_s, u"下载 %1%2"_s.arg(jsString(info.value("latest"_L1)), fmtSize(dl.value("size"_L1)))},
                                   {u"url"_s, jsString(dl.value("url"_L1))}, {u"primary"_s, true}, {u"loading"_s, false}});
    }
    if (newer)
        buttons.append(QJsonObject{{u"kind"_s, u"page"_s}, {u"text"_s, info.value("download"_L1).isObject() ? u"发布页"_s : u"去发布页下载"_s},
                                   {u"url"_s, jsString(info.value("url"_L1))}, {u"primary"_s, false}, {u"loading"_s, false}});
    if (newerVersion.isString() && !newerVersion.toString().isEmpty() && newerVersion.toString() != u.value("dismissed"_L1).toString())
        buttons.append(QJsonObject{{u"kind"_s, u"dismiss"_s}, {u"text"_s, u"忽略这一版"_s}, {u"version"_s, newerVersion}, {u"primary"_s, false}, {u"loading"_s, false}});
    buttons.append(QJsonObject{{u"kind"_s, u"check"_s}, {u"text"_s, u"检查更新"_s}, {u"primary"_s, false}, {u"loading"_s, checking}});
    const QString shown = !current.isEmpty() ? current : jsTruthy(info.value("current"_L1)) ? jsString(info.value("current"_L1)) : u"—"_s;
    m[u"update"_s] = QJsonObject{
        {u"label"_s, u"当前版本 "_s + shown},
        {u"sub"_s, !error.isEmpty() && hasInfo ? u"%1 · 上次检查失败:%2"_s.arg(status, error) : status},
        {u"buttons"_s, buttons},
        {u"auto"_s, u.value("auto"_L1).toBool(true)},
        {u"notes"_s, newer && jsTruthy(info.value("notes"_L1)) ? jsString(info.value("notes"_L1)) : QString()},
    };
    m[u"supportBusy"_s] = in.supportBusy;
    const QString mod = in.mac ? u"⌘"_s : u"Ctrl"_s;
    const QList<QPair<QStringList, QString>> shortcuts{
        {{mod, u"Enter"_s}, u"解析当前指令(不发送)"_s},
        {{mod, u"Shift"_s, u"Enter"_s}, u"解析并发送(有确认框)"_s},
        {{mod, u"Shift"_s, u"H"_s}, u"暂停全部自动执行(熔断)"_s},
        {{mod, u"R"_s}, u"刷新状态"_s},
        {{u"Esc"_s}, u"收起打开的记录详情"_s},
        {{u"↑"_s, u"↓"_s}, u"侧栏导航移动(焦点在侧栏时)"_s},
        {{mod, u"1 ~ 9"_s}, u"按侧栏顺序切换页面"_s},
    };
    QJsonArray keys;
    for (const auto& [k, what] : shortcuts) keys.append(QJsonObject{{u"keys"_s, QJsonArray::fromStringList(k)}, {u"what"_s, what}});
    m[u"shortcuts"_s] = keys;
    m[u"log"_s] = in.log;
    return m;
}

QStringList aboutTexts(const QJsonObject& m) {
    QStringList out{u"关于"_s};
    const auto lines = [&out](const QString& text) {
        for (const QString& l : text.split(u'\n')) out << l.simplified();
    };
    if (!m.value("error"_L1).toString().isEmpty()) out << m.value("error"_L1).toString();
    for (const QJsonValue& v : m.value("rows"_L1).toArray()) {
        const QJsonObject r = v.toObject();
        out << r.value("label"_L1).toString() << r.value("value"_L1).toString() << r.value("link"_L1).toString();
    }
    out << u"更新"_s;
    const QJsonObject u = m.value("update"_L1).toObject();
    out << u.value("label"_L1).toString() << u.value("sub"_L1).toString();
    for (const QJsonValue& b : u.value("buttons"_L1).toArray()) out << b.toObject().value("text"_L1).toString();
    out << u"自动检查更新"_s << u"启动后查一次,之后每 12 小时一次"_s
        << u"只读取 GitHub 上公开的发布信息;不下载、不安装、不上传任何数据。下载的安装包装上去会替换旧版,配置与交易记录都在用户目录里,不受影响。"_s;
    lines(u.value("notes"_L1).toString());
    out << u"支持"_s << u"诊断信息"_s << u"遇到问题时导出一份,连同问题描述一起发给支持"_s << u"导出诊断信息…"_s << u"拷贝概要"_s
        << u"文件位置"_s << u"日志、配置文件所在的文件夹"_s << u"打开日志所在位置"_s << u"打开配置文件所在位置"_s
        << u"条款与许可"_s << u"风险揭示、使用条款、隐私说明;本软件用到的开源组件及其许可"_s << u"查看条款"_s << u"第三方许可声明"_s
        << u"诊断信息里有版本与系统、引擎状态、脱敏后的配置、最近的日志;没有交易记录、成交、持仓与 API Key,真实账号已打码。"_s;
    out << u"键盘快捷键"_s;
    for (const QJsonValue& v : m.value("shortcuts"_L1).toArray()) {
        for (const QJsonValue& k : v.toObject().value("keys"_L1).toArray()) out << k.toString();
        out << v.toObject().value("what"_L1).toString();
    }
    out << u"引擎日志"_s;
    lines(m.value("log"_L1).toString());
    out << u"重启交易引擎"_s;
    out.removeAll(QString());
    return out;
}

}  // namespace ibkr::shell::settings
