#include "transport/params.h"

#include "analysis/flyexit.h"
#include "analysis/tracker_rules.h"
#include "util/jsformat.h"
#include "util/jsnum.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/py.h"

#include <cmath>

using namespace Qt::StringLiterals;

namespace ibkr::rpc {

using util::OJson;
namespace js = util::js;

namespace {

[[noreturn]] void invalidParams(const QString& message) { throw util::RpcError(-32602, message); }

/// typeof item === "object" && item !== null && !Array.isArray(item)
bool isPlainObject(const OJson& item) { return item.type == OJson::Object; }

/// /^\s*[-+]?\d+\s*$/(JS 的 \s = isJsWhitespace;\d 只认 ASCII 数字)
bool looksLikeInteger(const QString& s) {
    qsizetype i = 0;
    const qsizetype n = s.size();
    while (i < n && util::isJsWhitespace(s[i])) ++i;
    if (i < n && (s[i] == u'-' || s[i] == u'+')) ++i;
    const qsizetype digitsFrom = i;
    while (i < n && s[i] >= u'0' && s[i] <= u'9') ++i;
    if (i == digitsFrom) return false;
    while (i < n && util::isJsWhitespace(s[i])) ++i;
    return i == n;
}

}  // namespace

bool symbolMatches(const QString& s) {
    if (s.isEmpty() || s.size() > 12) return false;
    if (!(s[0] >= u'A' && s[0] <= u'Z')) return false;
    for (qsizetype i = 1; i < s.size(); ++i) {
        const QChar c = s[i];
        if (!((c >= u'A' && c <= u'Z') || (c >= u'0' && c <= u'9') || c == u'.' || c == u'-')) return false;
    }
    return true;
}

QString symbolOrRaise(const OJson& params) {
    const OJson* raw = js::prop(&params, u"symbol"_s);
    const QString symbol = util::jsTrim(js::strOr(raw, QString())).toUpper();
    if (!symbolMatches(symbol)) invalidParams(u"标的代码不合法:'%1'"_s.arg(js::str(raw)));
    return symbol;
}

std::optional<double> optFloat(const OJson* value) {
    if (js::nullish(value) || (value->type == OJson::String && value->s.isEmpty())) return std::nullopt;
    const double out = js::num(value);
    if (std::isnan(out)) invalidParams(u"不是有效数字:'%1'"_s.arg(js::str(value)));
    return out;
}

std::optional<double> optInt(const OJson* value) {
    if (js::nullish(value) || (value->type == OJson::String && value->s.isEmpty()) || (value->type == OJson::Number && value->n == 0)) return std::nullopt;
    if (value->type == OJson::Number) {
        if (!std::isfinite(value->n)) invalidParams(u"整数参数不合法:'%1'"_s.arg(js::str(value)));
        return std::trunc(value->n);
    }
    const QString text = js::str(value);
    if (!looksLikeInteger(text)) invalidParams(u"整数参数不合法:'%1'"_s.arg(text));
    return util::jsParseInt(text, 10);
}

std::optional<double> drawdownArmOf(const OJson& params) {
    const std::optional<double> pct = optFloat(js::prop(&params, u"profit_drawdown_arm_pct"_s));
    if (!pct) return std::nullopt;
    if (!(*pct > 0 && *pct <= 1000)) invalidParams(u"利润回撤的起算门槛要在 0(不含)到 1000% 之间,当前 %1"_s.arg(util::pyG(*pct)));
    return *pct / 100;
}

OJson drawdownTiersOf(const OJson& params, std::optional<double> flyUnitCostUsd) {
    using namespace analysis::flyexit;
    if (js::strOr(js::prop(&params, u"profit_drawdown_preset"_s), QString()).toLower() == u"fly") {
        // 组合持仓按金额起算($100 起追、$200 收紧);别的持仓、或成本算不出来,退回按比例的预设
        const OJson usd = drawdownUsdPreset(flyUnitCostUsd, nullptr);
        const OJson* usdTiers = js::prop(&usd, u"tiers"_s);
        const OJson* usdArm = js::prop(&usd, u"arm"_s);
        return js::object({
            {u"profit_drawdown_tiers"_s, js::nullish(usdTiers) ? drawdownTiers(nullptr) : *usdTiers},
            {u"profit_drawdown_late"_s, drawdownLate(nullptr)},
            {u"profit_drawdown_arm"_s, js::nullish(usdArm) ? js::N(drawdownArm(nullptr)) : *usdArm},
            {u"profit_drawdown_floor"_s, js::N(drawdownFloor(nullptr))},
        });
    }
    // 自列档位 / 固定百分比:激活线用用户填的起算门槛(不填就是 null),最少回吐只有蝶式那套才有。这一步在查档位之前(它也会抛)
    const OJson arm = js::NOrNull(drawdownArmOf(params));
    const OJson* raw = js::prop(&params, u"profit_drawdown_tiers"_s);
    if (js::nullish(raw) || (raw->type == OJson::String && raw->s.isEmpty())) {
        return js::object({{u"profit_drawdown_tiers"_s, js::Null()}, {u"profit_drawdown_late"_s, js::Null()},
                           {u"profit_drawdown_arm"_s, arm}, {u"profit_drawdown_floor"_s, js::Null()}});
    }
    if (!js::isArr(raw) || raw->items.isEmpty()) invalidParams(u"profit_drawdown_tiers 要是一个非空数组"_s);
    OJson tiers = js::array();
    for (const OJson& item : raw->items) {
        if (!isPlainObject(item)) invalidParams(u"分档的每一项要是 {above, pct} 对象"_s);
        const std::optional<double> above = optFloat(js::prop(&item, u"above"_s));
        const std::optional<double> pct = optFloat(js::prop(&item, u"pct"_s));
        if (!above || !pct) invalidParams(u"分档的 above 与 pct 都不能空"_s);
        if (*above < 0) invalidParams(u"分档的 above(浮盈倍数)不能为负"_s);
        if (!(*pct > 0 && *pct <= 100)) invalidParams(u"分档的 pct 要在 0(不含)到 100 之间,当前 %1"_s.arg(util::pyG(*pct)));
        tiers.items.append(js::object({{u"above"_s, js::N(*above)}, {u"pct"_s, js::N(*pct)}}));
    }
    OJson late = js::Null();
    const OJson* lateRaw = js::prop(&params, u"profit_drawdown_late"_s);
    if (js::isObjectLike(lateRaw) && js::truthy(js::prop(lateRaw, u"after"_s))) {
        const std::optional<double> factor = optFloat(js::prop(lateRaw, u"factor"_s));
        if (!factor || !(*factor > 0 && *factor <= 1)) invalidParams(u"尾盘收紧的 factor 要在 0(不含)到 1 之间"_s);
        late = js::object({{u"after"_s, js::S(js::str(js::prop(lateRaw, u"after"_s)))}, {u"factor"_s, js::N(*factor)}});
    }
    return js::object({{u"profit_drawdown_tiers"_s, tiers}, {u"profit_drawdown_late"_s, late},
                       {u"profit_drawdown_arm"_s, arm}, {u"profit_drawdown_floor"_s, js::Null()}});
}

OJson exitSettingsOf(const OJson& params, double nowMs) {
    const QString clock = util::jsTrim(js::strOr(js::prop(&params, u"exit_at"_s), QString()));
    std::optional<double> exitAtMs;
    if (!clock.isEmpty()) {
        const OJson clockValue = js::S(clock);
        exitAtMs = analysis::nextOccurrenceMs(&clockValue, nowMs);
        if (!exitAtMs) invalidParams(u"到点平仓的时刻要写成美东时间的 HH:MM(如 15:45),收到「%1」。"_s.arg(clock));
    }
    const std::optional<double> confirm = optFloat(js::prop(&params, u"spot_stop_confirm_s"_s));
    if (confirm && !(*confirm >= 0 && *confirm <= 600)) invalidParams(u"标的止损的确认秒数要在 0 到 600 之间,当前 %1"_s.arg(util::pyG(*confirm)));
    const OJson* raw = js::prop(&params, u"take_profit_tiers"_s);
    OJson tiers = js::Null();
    if (!js::nullish(raw) && !(raw->type == OJson::String && raw->s.isEmpty())) {
        if (!js::isArr(raw) || raw->items.isEmpty()) invalidParams(u"take_profit_tiers 要是一个非空数组"_s);
        if (raw->items.size() > analysis::kMaxTpTiers) invalidParams(u"分批止盈最多 %1 档。"_s.arg(analysis::kMaxTpTiers));
        tiers = js::array();
        for (const OJson& item : raw->items) {
            if (!isPlainObject(item)) invalidParams(u"分批止盈的每一项要是 {price, fraction_pct} 对象"_s);
            const std::optional<double> price = optFloat(js::prop(&item, u"price"_s));
            const std::optional<double> fraction = optFloat(js::prop(&item, u"fraction_pct"_s));
            if (!price || !fraction) invalidParams(u"分批止盈的 price 与 fraction_pct 都不能空"_s);
            tiers.items.append(js::object({{u"price"_s, js::N(*price)}, {u"fraction_pct"_s, js::N(*fraction)}}));
        }
    }
    return js::object({
        {u"exit_at"_s, clock.isEmpty() ? js::Null() : js::S(clock)},
        {u"exit_at_ms"_s, js::NOrNull(exitAtMs)},
        {u"spot_stop_confirm_s"_s, confirm && *confirm > 0 ? js::N(*confirm) : js::Null()},
        {u"take_profit_tiers"_s, tiers},
    });
}

OJson stopSettingsOf(const OJson& params) {
    OJson out = js::object();
    const OJson* peak = js::prop(&params, u"peak_confirm"_s);
    if (js::isBool(peak)) out.set(u"peak_confirm"_s, *peak);
    const OJson* stopBasis = js::prop(&params, u"stop_basis"_s);
    if (!js::nullish(stopBasis) && !(stopBasis->type == OJson::String && stopBasis->s.isEmpty())) {
        const QString basis = js::str(stopBasis);
        if (basis != u"mid" && basis != u"natural") invalidParams(u"stop_basis 只能是 mid 或 natural,收到「%1」"_s.arg(basis));
        out.set(u"stop_basis"_s, js::S(basis));
    }
    struct Range {
        QString key;
        double lo, hi;
        QString label;
        bool whole;
    };
    // 范围只挡手误,不是建议值。改价间隔的下限 0.25 秒:一张单一秒最多改 4 次,离 TWS 每秒 50 条消息的上限远;上限 1 秒是节拍本身
    const Range ranges[] = {
        {u"stop_chase_grace"_s, 0, 60, u"止损追价先等的轮数"_s, true},
        {u"stop_chase_step"_s, 1, 20, u"止损追价每轮让的跳数"_s, true},
        {u"stop_chase_max_pct"_s, 0, 100, u"止损追价的让价上限(%)"_s, false},
        {u"chase_lead"_s, 0, 3, u"追价按跌速多让的倍数"_s, false},
        {u"chase_interval_s"_s, 0.25, 1, u"追价改价的最短间隔(秒)"_s, false},
    };
    for (const Range& r : ranges) {
        if (!params.get(r.key)) continue;  // `key in params`
        const std::optional<double> value = optFloat(js::prop(&params, r.key));
        if (value && (!(*value >= r.lo && *value <= r.hi) || (r.whole && !(std::isfinite(*value) && std::floor(*value) == *value)))) {
            invalidParams(u"%1要是 %2 到 %3 之间的%4,当前 %5"_s.arg(r.label, util::jsNumberToString(r.lo), util::jsNumberToString(r.hi),
                                                      r.whole ? u"整数"_s : u"数"_s, util::pyG(*value)));
        }
        out.set(r.key, js::NOrNull(value));
    }
    return out;
}

}  // namespace ibkr::rpc
