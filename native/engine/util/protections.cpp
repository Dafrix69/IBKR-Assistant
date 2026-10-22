#include "util/protections.h"

#include "util/collate.h"
#include "util/jsformat.h"
#include "util/tz.h"

#include <QJsonArray>

#include <algorithm>
#include <cmath>

namespace ibkr::util {

using namespace Qt::StringLiterals;

namespace {
QString n(double v) { return jsNumberToString(v); }

QString remaining(double untilMs, double nowMs) {
    const double mins = std::ceil((untilMs - nowMs) / 60'000);
    return mins >= 60 ? u"%1 小时 %2 分钟"_s.arg(n(std::floor(mins / 60)), n(std::fmod(mins, 60))) : n(mins) + u" 分钟"_s;
}
}  // namespace

QString cooldownKey(const QString& symbol, const QString& leg) { return symbol + u'|' + leg; }

bool isStopLike(const QString& state) {
    const QString bare = state.contains(u':') ? state.mid(state.lastIndexOf(u':') + 1) : state;
    return bare == u"stop_loss" || bare == u"profit_trail";
}

double etDayStart(double nowMs, int offsetDays) {
    const QString et = QString::fromUtf16(kET);
    const WallParts p = wallParts(nowMs, et);
    const double day = dateUtc(p.year, p.month - 1, p.day + offsetDays);
    const WallParts d = wallParts(day, u"UTC"_s);  // getUTCFullYear / Month / Date
    return wallToEpoch({d.year, d.month, d.day, 0, 0, 0}, et);
}

bool protectionsEnabled(const contract::ProtectionsConfig& cfg) {
    return cfg.stoploss_guard.enabled || cfg.max_drawdown.enabled || cfg.cooldown.enabled || cfg.daily_loss.enabled;
}

bool needsPnlEvents(const contract::ProtectionsConfig& cfg) { return cfg.max_drawdown.enabled || cfg.daily_loss.enabled; }

double protectionsSince(const contract::ProtectionsConfig& cfg, double nowMs) {
    const double lookback = std::max({cfg.stoploss_guard.enabled ? cfg.stoploss_guard.lookback_minutes : 0.0,
                                      cfg.max_drawdown.enabled ? cfg.max_drawdown.lookback_minutes : 0.0, cfg.cooldown.enabled ? cfg.cooldown.minutes : 0.0});
    const double since = nowMs - lookback * 60'000;
    return cfg.daily_loss.enabled ? std::min(since, etDayStart(nowMs) - 1) : since;
}

ProtectionState evaluateProtections(const contract::ProtectionsConfig& cfg, const std::vector<CloseEvent>& closes, const std::vector<PnlEvent>& pnl, double nowMs,
                                    const std::optional<contract::OrderedMap<double>>& accountDaily, const QStringList& accountsExpected) {
    std::vector<ProtectionPause> pauses;

    const auto& guard = cfg.stoploss_guard;
    if (guard.enabled && guard.trigger_count > 0) {
        const double since = nowMs - guard.lookback_minutes * 60'000;
        std::vector<CloseEvent> hits;
        for (const CloseEvent& c : closes)
            if (c.atMs > since && c.atMs <= nowMs && isStopLike(c.state)) hits.push_back(c);
        std::stable_sort(hits.begin(), hits.end(), [](const CloseEvent& a, const CloseEvent& b) { return a.atMs < b.atMs; });
        if (double(hits.size()) >= guard.trigger_count) {
            const double untilMs = hits.back().atMs + guard.pause_minutes * 60'000;
            if (untilMs > nowMs)
                pauses.push_back({u"stoploss_guard"_s,
                                  u"%1 分钟内止损 %2 次(阈值 %3 次),自动执行先停 %4 分钟"_s.arg(n(guard.lookback_minutes), n(double(hits.size())), n(guard.trigger_count), n(guard.pause_minutes)),
                                  untilMs});
        }
    }

    const auto& dd = cfg.max_drawdown;
    if (dd.enabled && dd.max_drawdown_usd > 0) {
        const double since = nowMs - dd.lookback_minutes * 60'000;
        std::vector<PnlEvent> rows;
        for (const PnlEvent& p : pnl)
            if (p.atMs > since && p.atMs <= nowMs && std::isfinite(p.pnl)) rows.push_back(p);
        std::stable_sort(rows.begin(), rows.end(), [](const PnlEvent& a, const PnlEvent& b) { return a.atMs < b.atMs; });
        double running = 0, peak = 0, worst = 0, worstAtMs = 0;
        for (const PnlEvent& row : rows) {
            running += row.pnl;
            if (running > peak) peak = running;
            const double drop = peak - running;
            if (drop > worst) {
                worst = drop;
                worstAtMs = row.atMs;
            }
        }
        if (worst >= dd.max_drawdown_usd) {
            const double untilMs = worstAtMs + dd.pause_minutes * 60'000;
            if (untilMs > nowMs)
                pauses.push_back({u"max_drawdown"_s,
                                  u"%1 分钟内已实现盈亏从峰值回撤 %2 美元(阈值 %3),自动执行先停 %4 分钟"_s.arg(n(dd.lookback_minutes), jsToFixed(worst, 2), n(dd.max_drawdown_usd), n(dd.pause_minutes)),
                                  untilMs});
        }
    }

    const auto& daily = cfg.daily_loss;
    contract::OrderedMap<ProtectionPause> accountPauses;
    QList<QPair<QString, double>> reported;
    if (daily.basis == u"account" && accountDaily)
        for (const QString& k : accountDaily->keys()) {
            const double v = accountDaily->value(k);
            if (std::isfinite(v)) reported.append({k, v});
        }
    const auto realizedLoss = [&]() -> std::optional<double> {
        const double start = etDayStart(nowMs);
        double total = 0;
        int count = 0;
        for (const PnlEvent& p : pnl)
            if (p.atMs >= start && p.atMs <= nowMs && std::isfinite(p.pnl)) {
                total += p.pnl;
                ++count;
            }
        return count && -total >= daily.max_loss_usd ? std::optional<double>(-total) : std::nullopt;
    };
    if (daily.enabled && daily.max_loss_usd > 0 && !reported.isEmpty()) {
        for (const auto& [alias, value] : reported) {
            if (-value < daily.max_loss_usd) continue;
            accountPauses.insert(alias, {u"daily_loss"_s,
                                         u"账户 %1 今天的盈亏(券商报的,含未平仓)是 %2 美元,到了日内亏损上限 %3,今天这个账户不再下新单"_s.arg(alias, jsToFixed(value, 2), n(daily.max_loss_usd)),
                                         etDayStart(nowMs, 1)});
        }
        QStringList missing;
        for (const QString& alias : accountsExpected) {
            bool found = false;
            for (const auto& r : reported) found = found || r.first == alias;
            if (!found) missing << alias;
        }
        const std::optional<double> loss = missing.isEmpty() ? std::nullopt : realizedLoss();
        if (loss)
            for (const QString& alias : missing)
                accountPauses.insert(alias, {u"daily_loss"_s,
                                             u"账户 %1 券商没有报当日盈亏,退回按已实现算:今天(美东)已实现亏损 %2 美元,到了日内亏损上限 %3,今天这个账户不再下新单"_s.arg(alias, jsToFixed(*loss, 2), n(daily.max_loss_usd)),
                                             etDayStart(nowMs, 1)});
    } else if (daily.enabled && daily.max_loss_usd > 0) {
        if (const std::optional<double> loss = realizedLoss())
            pauses.push_back({u"daily_loss"_s, u"今天(美东)已实现亏损 %1 美元,到了日内亏损上限 %2,今天不再下新单"_s.arg(jsToFixed(*loss, 2), n(daily.max_loss_usd)), etDayStart(nowMs, 1)});
    }

    contract::OrderedMap<ProtectionPause> cooldowns;
    const auto& cool = cfg.cooldown;
    if (cool.enabled && cool.minutes > 0) {
        for (const CloseEvent& close : closes) {
            if (close.symbol.isEmpty()) continue;
            const double untilMs = close.atMs + cool.minutes * 60'000;
            if (untilMs <= nowMs) continue;
            const bool byPosition = cool.scope == u"position";
            const QString key = byPosition ? cooldownKey(close.symbol, close.leg) : close.symbol;
            if (const ProtectionPause* cur = cooldowns.find(key); cur && cur->untilMs >= untilMs) continue;
            cooldowns.insert(key, {u"cooldown"_s,
                                   byPosition ? u"%1 的这一份持仓刚平过,冷却 %2 分钟内不再开同样的仓"_s.arg(close.symbol, n(cool.minutes))
                                              : u"%1 刚平过仓,冷却 %2 分钟内不再下新单"_s.arg(close.symbol, n(cool.minutes)),
                                   untilMs});
        }
    }

    // 同时触发就取解除得最晚的那条
    std::stable_sort(pauses.begin(), pauses.end(), [](const ProtectionPause& a, const ProtectionPause& b) { return b.untilMs < a.untilMs; });
    ProtectionState out;
    if (!pauses.empty()) out.pause = pauses.front();
    out.cooldowns = cooldowns;
    out.accountPauses = accountPauses;
    return out;
}

std::optional<QString> protectionBlock(const ProtectionState& state, const QString& symbol, double nowMs, const QString& account, const QString& leg) {
    if (state.pause && state.pause->untilMs > nowMs) return state.pause->reason + u","_s + remaining(state.pause->untilMs, nowMs) + u"后自动恢复"_s;
    if (!account.isEmpty())
        if (const ProtectionPause* a = state.accountPauses.find(account); a && a->untilMs > nowMs)
            return a->reason + u","_s + remaining(a->untilMs, nowMs) + u"后自动恢复"_s;
    if (!symbol.isEmpty()) {
        const ProtectionPause* cool = state.cooldowns.find(symbol);
        if (!cool) cool = state.cooldowns.find(cooldownKey(symbol, leg));
        if (cool && cool->untilMs > nowMs) return cool->reason + u","_s + remaining(cool->untilMs, nowMs) + u"后自动恢复"_s;
    }
    return std::nullopt;
}

QJsonObject protectionsSummary(const ProtectionState& state, double nowMs) {
    struct Row {
        QString key;
        double until;
        QString reason;
    };
    std::vector<Row> cooling, accounts;
    for (const QString& key : state.cooldowns.keys()) {
        const ProtectionPause p = state.cooldowns.value(key);
        if (p.untilMs > nowMs) cooling.push_back({key.split(u'|').value(0, key), p.untilMs, p.reason});
    }
    for (const QString& key : state.accountPauses.keys()) {
        const ProtectionPause p = state.accountPauses.value(key);
        if (p.untilMs > nowMs) accounts.push_back({key, p.untilMs, p.reason});
    }
    const auto byKey = [](const Row& a, const Row& b) { return localeCompare(a.key, b.key) < 0; };
    std::stable_sort(cooling.begin(), cooling.end(), byKey);
    std::stable_sort(accounts.begin(), accounts.end(), byKey);
    QJsonArray coolArr, accArr;
    for (const Row& r : cooling) coolArr.append(QJsonObject{{u"symbol"_s, r.key}, {u"until_ms"_s, r.until}, {u"reason"_s, r.reason}});
    for (const Row& r : accounts) accArr.append(QJsonObject{{u"account"_s, r.key}, {u"until_ms"_s, r.until}, {u"reason"_s, r.reason}});
    const bool paused = state.pause && state.pause->untilMs > nowMs;
    return QJsonObject{{u"paused"_s, paused},
                       {u"rule"_s, paused ? state.pause->rule : QString()},
                       {u"reason"_s, paused ? state.pause->reason : QString()},
                       {u"until_ms"_s, paused ? QJsonValue(state.pause->untilMs) : QJsonValue(QJsonValue::Null)},
                       {u"cooldowns"_s, coolArr},
                       {u"accounts"_s, accArr}};
}

}  // namespace ibkr::util
