#include "parsing/validator.h"

#include "analysis/open_risk.h"
#include "domain/models.h"
#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/market_js.h"
#include "util/py.h"
#include "util/risk_budget.h"
#include "util/tz.h"

#include <algorithm>
#include <cmath>
#include <vector>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;
namespace jsmath = ibkr::util::jsmath;

namespace ibkr::parsing::validator {

namespace {

const OJson* P(const OJson* o, const char16_t* k) { return js::prop(o, QString::fromUtf16(k)); }
const OJson* P(const OJson& o, const char16_t* k) { return js::prop(&o, QString::fromUtf16(k)); }
QString Sx(const OJson& o, const char16_t* k) { return js::str(P(o, k)); }
double Nx(const OJson& o, const char16_t* k) { return js::num(P(o, k)); }
bool isStrEq(const OJson* v, const char16_t* s) { return js::isStr(v) && v->s == QString::fromUtf16(s); }
/// v !== null(undefined 也算不是 null)
bool notNull(const OJson* v) { return !(v && v->type == OJson::Null); }
/// v === n(只认数)
bool isNumEq(const OJson* v, double n) { return js::isNum(v) && v->n == n; }
QString n2s(double v) { return util::jsNumberToString(v); }

Issue bad(const QString& message) { return {u"BAD_SPREAD"_s, message}; }

/// SameValueZero(Set 的判等):原始值按类型与值,NaN 等于 NaN,对象 / 数组只等于它自己
bool sameValueZero(const OJson* a, const OJson* b) {
    if (a == nullptr || b == nullptr) return a == b;
    if (a->type != b->type) return false;
    switch (a->type) {
    case OJson::Null: return true;
    case OJson::Bool: return a->b == b->b;
    case OJson::Number: return a->n == b->n || (std::isnan(a->n) && std::isnan(b->n));
    case OJson::String: return a->s == b->s;
    default: return a == b;
    }
}
/// new Set(values).size
qsizetype distinctCount(const std::vector<const OJson*>& values) {
    std::vector<const OJson*> seen;
    for (const OJson* v : values)
        if (std::none_of(seen.begin(), seen.end(), [&](const OJson* s) { return sameValueZero(s, v); })) seen.push_back(v);
    return qsizetype(seen.size());
}

/// [...(contract.legs ?? [])]
std::vector<const OJson*> legsOf(const OJson& contract) {
    std::vector<const OJson*> out;
    const OJson* legs = P(contract, u"legs");
    if (js::nullish(legs)) return out;
    for (const OJson& l : legs->items) out.push_back(&l);
    return out;
}
/// .sort((a, b) => a.strike - b.strike)
std::vector<const OJson*> sortedByStrike(std::vector<const OJson*> legs) {
    util::market::jsSort(legs, [](const OJson* a, const OJson* b) { return Nx(*a, u"strike") - Nx(*b, u"strike"); });
    return legs;
}
std::vector<const OJson*> filterRight(const std::vector<const OJson*>& legs, const char16_t* right) {
    std::vector<const OJson*> out;
    for (const OJson* l : legs)
        if (isStrEq(P(*l, u"right"), right)) out.push_back(l);
    return sortedByStrike(out);
}

// ---- 限额口径的价格 ----------------------------------------------------------
std::optional<double> positivePrice(const OJson* value) {
    if (js::nullish(value)) return std::nullopt;
    const double v = js::num(value);
    return std::isfinite(v) && v > 0 ? std::optional<double>(v) : std::nullopt;
}
std::optional<double> positivePrice(const std::optional<double>& value) {
    if (!value) return std::nullopt;
    return std::isfinite(*value) && *value > 0 ? value : std::nullopt;
}

/// 正股这一单的参考成交价(snapshotPrice 空 = null)
std::optional<double> stockReferencePrice(const OJson& spec, const std::optional<double>& snapshotPrice) {
    const auto limit = positivePrice(P(spec, u"lmtPrice"));
    const OJson* orderType = P(spec, u"orderType");
    const bool buyCapped = isStrEq(orderType, u"LMT") || isStrEq(orderType, u"STP LMT");
    if (isStrEq(P(spec, u"action"), u"BUY") && buyCapped && limit) return limit;
    const bool stopIsPrice = isStrEq(orderType, u"STP") || isStrEq(orderType, u"STP LMT");
    std::vector<double> candidates;
    for (const auto& c : {limit, stopIsPrice ? positivePrice(P(spec, u"auxPrice")) : std::nullopt, positivePrice(snapshotPrice)})
        if (c) candidates.push_back(*c);
    if (candidates.empty()) return std::nullopt;
    double m = -INFINITY;  // Math.max(...candidates)
    for (const double c : candidates) m = jsmath::max(m, c);
    return m;
}

std::optional<double> optionPremiumCap(const OJson& spec) {
    const OJson* t = P(spec, u"orderType");
    if (!isStrEq(t, u"LMT") && !isStrEq(t, u"STP LMT")) return std::nullopt;
    return positivePrice(P(spec, u"lmtPrice"));
}

Issue unpriceableOptionBuy(const OJson& spec) {
    const OJson* t = P(spec, u"orderType");
    if (isStrEq(t, u"STP") || isStrEq(t, u"TRAIL")) {
        return {u"UNPRICEABLE"_s, u"单腿期权的 "_s + js::str(t) +
                                      u" 买单没有限价:触发价 / 回撤额不是权利金,成交价没有上限,"_s
                                      u"无法核对限额,已拒绝。请改成限价单或止损限价单(STP LMT),例如'权利金不超过 5.5'"_s
                                      u"或'涨到 6 后以不高于 6.5 买入'。"_s};
    }
    return {u"UNPRICEABLE"_s, u"单腿期权缺少可用于估算风险敞口的价格(权利金),无法核对限额,已拒绝。"_s
                              u"请写明权利金上限,例如'权利金不超过 5.5'。"_s};
}

// ---- 合约要素复核 ----------------------------------------------------------
QList<Issue> nonStandardMultiplier(const OJson& contract) {
    const OJson* sec = P(contract, u"secType");
    if (!isStrEq(sec, u"OPT") && !isStrEq(sec, u"BAG")) return {};
    std::vector<const OJson*> values{P(contract, u"multiplier")};
    for (const OJson* l : legsOf(contract)) values.push_back(P(*l, u"multiplier"));
    // values.find((m) => m !== "100"):找到的那一格是 undefined 时与"没找到"分不开
    const OJson* odd = nullptr;
    for (const OJson* m : values)
        if (!isStrEq(m, u"100")) {
            odd = m;
            break;
        }
    if (odd == nullptr) return {};
    return {{u"UNSUPPORTED"_s, u"期权合约乘数只支持 100(美股 / 美指标准期权),收到 '"_s + js::str(odd) +
                                   u"'。非标准乘数的合约本系统不支持,也无法按它核对限额,已拒绝。"_s}};
}

bool isThirdFriday(const QString& dateIso) {
    if (util::weekdayOfDate(dateIso) != 4) return false;
    const double day = util::jsStringToNumber(dateIso.mid(8, 2));
    return day >= 15 && day <= 21;
}
std::optional<QString> thirdFridayOfMonth(const QString& yearMonth) {
    for (int day = 15; day <= 21; day++) {
        const QString iso = yearMonth + u'-' + util::pad2(day);
        if (isThirdFriday(iso)) return iso;
    }
    return std::nullopt;
}
QString prevTradingDay(const QString& dateIso, const domain::Settings& settings) {
    double ms = util::jsDateParse(dateIso + u"T00:00:00Z"_s);
    for (int i = 0; i < 10; i++) {
        ms -= 86'400'000;
        const QString iso = util::isoString(ms).left(10);
        if (settings.isTradingDay(iso)) return iso;
    }
    return dateIso;
}
/// 指数月度期权的最后交易日 = 第三个周五的前一个交易日
bool isIndexMonthlyExpiry(const QString& dateIso, const domain::Settings& settings) {
    const auto thirdFri = thirdFridayOfMonth(dateIso.left(7));
    if (!thirdFri) return false;
    return prevTradingDay(*thirdFri, settings) == dateIso;
}

/// reviewTradingClass 的答案:keep = 原样回 current(那一格的值,可能是 null / undefined)
struct Reviewed {
    bool keep = false;
    QString value;
};
Reviewed reviewTradingClass(const OJson* current, const QString& expiryIso, const contract::IndexConfig& cfg, const domain::Settings& settings) {
    const QString expected = isIndexMonthlyExpiry(expiryIso, settings) ? cfg.monthly_trading_class : cfg.daily_trading_class;
    if (expected.isEmpty()) return {true, {}};
    const QString given = util::jsTrim(js::nullish(current) ? QString() : js::str(current)).toUpper();
    if (given.isEmpty()) return {false, expected};
    if (given == expected.toUpper()) return {false, expected};
    const QString daily = cfg.daily_trading_class;
    if (!daily.isEmpty() && given == daily.toUpper()) return {false, daily};
    return {false, expected};
}

QList<Issue> mixedTradingClass(const OJson& contract) {
    if (!isStrEq(P(contract, u"secType"), u"BAG")) return {};
    QStringList classes;  // Set:插入次序
    for (const OJson* l : legsOf(contract)) {
        const OJson* tc = P(*l, u"tradingClass");
        const QString c = util::jsTrim(js::nullish(tc) ? QString() : js::str(tc)).toUpper();
        if (!c.isEmpty() && !classes.contains(c)) classes << c;
    }
    if (classes.size() <= 1) return {};
    std::sort(classes.begin(), classes.end());  // 默认排序:按 UTF-16 码元
    return {bad(u"组合各腿的 tradingClass 不一致("_s + classes.join(u" / "_s) +
                u"):不同交易类的结算方式不同(如 SPX 为次日开盘 AM 结算、SPXW 为当天收盘 PM 结算),混在一张组合里不支持。"_s
                u"请把各腿统一写成同一类后重试。"_s)};
}

bool differentPrice(const OJson* a, const OJson* b) {
    if (js::nullish(a) || js::nullish(b)) return false;
    // Number.isFinite 不转换:串不算
    return js::isNum(a) && js::isNum(b) && std::isfinite(a->n) && std::isfinite(b->n) && std::fabs(a->n - b->n) >= 0.005;
}

/// 单腿取合约的到期日,组合取第一条腿的(YYYYMMDD)
QString orderExpiry(const OJson& contract) {
    const OJson* own = P(contract, u"lastTradeDateOrContractMonth");
    if (!js::nullish(own)) return js::str(own).left(8);
    const OJson* first = js::prop(P(contract, u"legs"), u"0"_s);
    const OJson* fromLeg = P(first, u"lastTradeDateOrContractMonth");
    return js::nullish(fromLeg) ? QString() : js::str(fromLeg).left(8);
}

/// qtyClose(a, b, tolerance):a === b 只认同一个数;别的照 Math.abs / 减法换成数
bool qtyClose(double a, const OJson* b, double tolerance) {
    if (js::isNum(b) && a == b->n) return true;
    const double bn = js::num(b);
    double base = jsmath::max(std::fabs(a), std::fabs(bn));
    if (base == 0 || std::isnan(base)) base = 1.0;
    return std::fabs(a - bn) / base <= tolerance;
}

QString expiryToIso(const QString& raw) { return raw.mid(0, 4) + u'-' + raw.mid(4, 2) + u'-' + raw.mid(6, 2); }

}  // namespace

QString primaryCode(const RejectedOrder& rejected) { return rejected.issues.isEmpty() ? u"UNSUPPORTED"_s : rejected.issues.first().code; }

QString rejectionMessage(const RejectedOrder& rejected) {
    QStringList seen;
    for (const Issue& issue : rejected.issues)
        if (!seen.contains(issue.message)) seen << issue.message;
    return seen.join(u" / "_s);
}

// ================================================================ Validator
Validator::Validator(const domain::Settings& settings, const domain::EtNow& nowEt, const OJson* snapshot, const QList<OJson>* recentOrders,
                     MarketStatusFn marketStatusFn, ValidatorExtras extras)
    : settings_(settings), nowEt_(nowEt), marketStatusFn_(std::move(marketStatusFn)), extras_(std::move(extras)) {
    if (snapshot && snapshot->type == OJson::Object)
        for (const auto& [k, v] : snapshot->fields) snapshot_.insert(k.toUpper(), js::num(&v));
    if (recentOrders) recentOrders_ = *recentOrders;
    marketStatus_ = settings_.marketStatus(nowEt_);
}

QString Validator::statusFor(const OJson& order) const {
    if (marketStatusFn_) {
        std::optional<QString> got;
        try {
            got = marketStatusFn_(order);
        } catch (...) {
            got = std::nullopt;  // 查时段失败不该让校验整个炸
        }
        if (got && !got->isEmpty()) return *got;
    }
    return marketStatus_;
}

ValidationOutcome Validator::validateAll(QList<OJson>& orders, std::optional<double> limit) {
    ValidationOutcome outcome;
    const double lim = limit ? *limit : settings_.limits.max_orders_per_input;
    QHash<QString, double> seenInBatch;
    for (qsizetype index = 0; index < orders.size(); ++index) {
        OJson& order = orders[index];
        if (double(index) >= lim) {
            outcome.rejected.append({order, {{u"EXCEEDS_LIMIT"_s, u"单次输入最多解析 "_s + n2s(lim) + u" 笔订单,本条排在第 "_s + n2s(double(index) + 1) +
                                                                       u" 位,已拦截。请拆成多次提交。"_s}}});
            continue;
        }
        auto [issues, approved] = validateOne(order, &seenInBatch);
        if (!issues.isEmpty() || !approved) {
            outcome.rejected.append({order, issues});
        } else {
            seenInBatch.insert(approved->signature, js::num(js::path(&order, {u"order"_s, u"totalQuantity"_s})));
            outcome.approved.append(*approved);
        }
    }
    return outcome;
}

std::pair<QList<Issue>, std::optional<ApprovedOrder>> Validator::validateOne(OJson& order, const QHash<QString, double>* seenInBatch) {
    QList<Issue> issues;
    QStringList warnings;

    // 1. 置信度
    const double minConf = settings_.limits.min_confidence;
    const double confidence = Nx(order, u"confidence");
    if (confidence < minConf) {
        issues.append({u"LOW_CONFIDENCE"_s, u"解析置信度 "_s + util::fmtF(confidence, 2) + u" 低于阈值 "_s + util::fmtF(minConf, 2) +
                                                u",按规则改判拒绝。请把指令写得更明确后重试。"_s});
    }

    // 2. 账户映射
    const QString accountAlias = Sx(order, u"account");
    const contract::AccountConfig* account = settings_.accountByAlias(accountAlias);
    if (account == nullptr) {
        QString aliases = settings_.aliasList().join(u"、"_s);
        if (aliases.isEmpty()) aliases = u"(未配置)"_s;
        issues.append({u"UNKNOWN_ACCOUNT"_s, u"账户别名 '"_s + accountAlias + u"' 不在别名表中(可用:"_s + aliases + u")。请改写指令或先在设置里添加别名。"_s});
    } else if (!account->is_paper && !settings_.policies.allow_live_trading) {
        const QString unflagged = settings_.paper_flag_missing.contains(account->alias)
                                      ? u"(配置里没写 is_paper,按实盘处理;若它是模拟账户,请写明 \"is_paper\": true)"_s
                                      : QString();
        issues.append({u"LIVE_TRADING_DISABLED"_s, u"订单指向实盘账户 "_s + account->alias + unflagged +
                                                       u",但当前没有允许实盘下单(默认关闭)。请先在纸面账户跑够回归测试,再到「设置」里打开「允许实盘账户下单」。"_s});
    }

    // 3. 合约复核(就地复核 tradingClass)
    OJson* contractMut = js::propMut(&order, u"contract"_s);
    if (contractMut == nullptr) throw util::JsError(u"Cannot read properties of undefined (reading 'lastTradeDateOrContractMonth')"_s);
    issues.append(checkContract(*contractMut, warnings));
    const OJson& contract = *contractMut;
    const OJson& spec = *js::propStrict(&order, u"order"_s);

    // 4. 价差结构复核
    if (isStrEq(P(contract, u"secType"), u"BAG")) issues.append(checkSpread(contract, spec));

    // 5. 触发方向复核
    if (notNull(P(order, u"trigger"))) issues.append(checkTrigger(order, warnings));

    // 6. 限额复算:这个账户实际生效的那一份
    const contract::Limits limits = account == nullptr ? settings_.limits : settings_.limitsFor(account->alias);
    const auto [notional, limitIssues] = checkLimits(order, limits);
    issues.append(limitIssues);
    // 6b. 账户在手的两条累计上限
    if (account != nullptr && limitIssues.isEmpty()) issues.append(checkOpenLimits(order, account->alias, limits, notional, warnings));

    // 7. 交易时段
    issues.append(checkSession(order, warnings));

    // 8. 重复防抖
    const QString signature = orderSignature(order, accountAlias);
    issues.append(checkDuplicate(order, signature, seenInBatch ? *seenInBatch : QHash<QString, double>{}));

    // 9. 原因缺失只警告
    if (util::jsTrim(Sx(order, u"reason")).isEmpty()) warnings << u"未提供操作原因,建议补充以便复盘"_s;

    if (!issues.isEmpty() || account == nullptr) return {issues, std::nullopt};

    // 10. 单笔风险预算:只告警
    if (const auto budget = util::riskBudgetWarning(budgetConfig(), account->alias, Sx(contract, u"secType"), notional)) warnings << *budget;
    countInBatch(order, account->alias, notional);

    QStringList merged;
    if (const OJson* own = P(order, u"warnings"); js::isArr(own))
        for (const OJson& w : own->items) merged << js::str(&w);
    merged << warnings;
    return {{}, ApprovedOrder{order, *account, notional, signature, merged}};
}

// ---- 合约 ---------------------------------------------------------
QList<Issue> Validator::checkContract(OJson& contract, QStringList& warnings) const {
    QList<Issue> issues;
    // 到期日的那几格:[那一格所在的对象, 原文];合约自己的(写了的话)在前,各腿在后
    std::vector<std::pair<OJson*, QString>> expirySlots;
    if (js::truthy(P(contract, u"lastTradeDateOrContractMonth"))) expirySlots.emplace_back(&contract, Sx(contract, u"lastTradeDateOrContractMonth"));
    if (OJson* legs = js::propMut(&contract, u"legs"_s); legs && legs->type == OJson::Array)
        for (OJson& l : legs->items) expirySlots.emplace_back(&l, Sx(l, u"lastTradeDateOrContractMonth"));
    else if (legs && legs->type != OJson::Null)
        throw util::JsError(u"(contract.legs ?? []) is not iterable"_s);

    const QString today = nowEt_.date;
    for (const auto& [slot, raw] : expirySlots) {
        const QString expiry = expiryToIso(raw);
        if (expiry < today) {
            issues.append({u"EXPIRED_CONTRACT"_s, u"到期日 "_s + raw + u" 已早于当前美东日期 "_s + today + u",合约不存在。"_s});
        } else if (!settings_.isTradingDay(expiry)) {
            issues.append({u"EXPIRED_CONTRACT"_s, u"到期日 "_s + raw + u" 不是交易日(周末或休市日),请确认后重写。"_s});
        }
    }

    // 指数期权的 tradingClass 按到期日复核:只纠正"这天根本没有这条链"的写法,不替用户换结算方式
    const QString symbol = Sx(contract, u"symbol");
    const contract::IndexConfig* indexCfg = settings_.indexConfig(symbol);
    if (indexCfg && !expirySlots.empty()) {
        for (const auto& [slot, raw] : expirySlots) {
            const OJson* current = P(*slot, u"tradingClass");
            const Reviewed reviewed = reviewTradingClass(current, expiryToIso(raw), *indexCfg, settings_);
            if (reviewed.keep || (js::isStr(current) && current->s == reviewed.value)) continue;
            const QString shown = current && current->type == OJson::Null ? u"None"_s : u'\'' + js::str(current) + u'\'';
            warnings << symbol + u' ' + raw + u" 到期的 tradingClass 由 "_s + shown + u" 复核为 '"_s + reviewed.value + u"'(按到期日判定)"_s;
            slot->set(u"tradingClass"_s, OJson::string(reviewed.value));
        }
    }
    issues.append(mixedTradingClass(contract));
    issues.append(nonStandardMultiplier(contract));
    return issues;
}

// ---- 价差 ---------------------------------------------------------
QList<Issue> Validator::checkSpread(const OJson& contract, const OJson& order) const {
    const OJson* strategy = P(contract, u"combo_strategy");
    if (isStrEq(strategy, u"BUTTERFLY")) return checkButterfly(contract, order);
    if (isStrEq(strategy, u"IRON_CONDOR")) return checkIronCondor(contract, order);
    return checkVertical(contract, order);
}

QList<Issue> Validator::checkVertical(const OJson& contract, const OJson& order) const {
    const std::vector<const OJson*> legs = legsOf(contract);
    if (legs.size() != 2) return {bad(u"垂直价差必须正好两条腿。"_s)};

    std::vector<const OJson*> buys, sells;
    for (const OJson* l : legs) {
        if (isStrEq(P(*l, u"action"), u"BUY")) buys.push_back(l);
        if (isStrEq(P(*l, u"action"), u"SELL")) sells.push_back(l);
    }
    if (buys.size() != 1 || sells.size() != 1) return {bad(u"垂直价差必须一买一卖各一条腿。"_s)};
    const OJson& buy = *buys[0];
    const OJson& sell = *sells[0];
    QList<Issue> issues;
    if (!js::strictEqual(P(buy, u"right"), P(sell, u"right"))) issues.append(bad(u"两腿必须同为 Call 或同为 Put。"_s));
    if (!js::strictEqual(P(buy, u"lastTradeDateOrContractMonth"), P(sell, u"lastTradeDateOrContractMonth"))) issues.append(bad(u"垂直价差两腿到期日必须相同。"_s));
    if (js::strictEqual(P(buy, u"strike"), P(sell, u"strike"))) issues.append(bad(u"两腿行权价不能相同。"_s));
    if (!isNumEq(P(buy, u"ratio"), 1) || !isNumEq(P(sell, u"ratio"), 1)) issues.append(bad(u"垂直价差只支持 1:1 比例。"_s));
    if (!issues.isEmpty()) return issues;

    // 方向复核:借方价差(BUY)买低卖高(call)/ 买高卖低(put),SELL 相反
    const bool debit = isStrEq(P(order, u"action"), u"BUY");
    const double buyK = Nx(buy, u"strike"), sellK = Nx(sell, u"strike");
    const bool call = isStrEq(P(buy, u"right"), u"C");
    const bool ok = call ? (debit ? buyK < sellK : buyK > sellK) : (debit ? buyK > sellK : buyK < sellK);
    if (!ok) {
        issues.append(bad((debit ? u"买入(借方)"_s : u"卖出(贷方)"_s) + u' ' + (call ? u"call"_s : u"put"_s) + u" spread 的腿方向不对:买 "_s +
                          util::fmtF(buyK, 2) + u" / 卖 "_s + util::fmtF(sellK, 2) + u" 不构成该方向的垂直价差。"_s));
    }

    const OJson* lmt = P(order, u"lmtPrice");
    if (isStrEq(P(order, u"price_mode"), u"AUTO_MID") && notNull(lmt)) issues.append(bad(u"AUTO_MID 时 lmtPrice 必须为空。"_s));
    if (isStrEq(P(order, u"price_mode"), u"EXPLICIT") && notNull(lmt) && debit) {
        const double width = std::fabs(buyK - sellK);
        if (js::num(lmt) > width) {
            issues.append(bad(u"借方价差净权利金 "_s + util::fmtF(js::num(lmt), 2) + u" 超过行权价差 "_s + util::fmtF(width, 2) + u",数学上不可能盈利。"_s));
        }
    }
    return issues;
}

QList<Issue> Validator::checkButterfly(const OJson& contract, const OJson& order) const {
    const std::vector<const OJson*> legs = sortedByStrike(legsOf(contract));
    if (legs.size() != 3) return {bad(u"蝴蝶必须正好三条腿。"_s)};

    const OJson& lo = *legs[0];
    const OJson& mid = *legs[1];
    const OJson& hi = *legs[2];
    QList<Issue> issues;
    if (!isStrEq(P(order, u"action"), u"BUY")) issues.append(bad(u"仅支持买入(借方)蝴蝶:卖出蝴蝶的保证金与风险结构不在本系统支持范围内。"_s));
    const auto field = [&](const char16_t* k) {
        std::vector<const OJson*> v;
        for (const OJson* l : legs) v.push_back(P(*l, k));
        return v;
    };
    if (distinctCount(field(u"right")) != 1) issues.append(bad(u"蝴蝶三条腿必须同为 Call 或同为 Put。"_s));
    if (distinctCount(field(u"lastTradeDateOrContractMonth")) != 1) issues.append(bad(u"蝴蝶三条腿到期日必须相同。"_s));
    if (distinctCount(field(u"strike")) != 3) issues.append(bad(u"蝴蝶三条腿行权价必须互不相同。"_s));
    if (!isStrEq(P(lo, u"action"), u"BUY") || !isStrEq(P(hi, u"action"), u"BUY") || !isStrEq(P(mid, u"action"), u"SELL"))
        issues.append(bad(u"买入蝴蝶的腿方向必须是:买最低价、卖中间价、买最高价。"_s));
    if (!isNumEq(P(lo, u"ratio"), 1) || !isNumEq(P(hi, u"ratio"), 1) || !isNumEq(P(mid, u"ratio"), 2))
        issues.append(bad(u"蝴蝶比例必须是 1:-2:1(外翼各 1 张,中腿 2 张)。"_s));
    if (!issues.isEmpty()) return issues;

    const double wingLo = Nx(mid, u"strike") - Nx(lo, u"strike");
    const double wingHi = Nx(hi, u"strike") - Nx(mid, u"strike");
    if (std::fabs(wingLo - wingHi) > 0.01) {
        return {bad(u"蝴蝶两翼必须等距(当前 "_s + util::fmtF(wingLo, 2) + u" / "_s + util::fmtF(wingHi, 2) + u")。不等翼(broken wing)结构不支持。"_s)};
    }

    const OJson* lmt = P(order, u"lmtPrice");
    if (isStrEq(P(order, u"price_mode"), u"EXPLICIT") && notNull(lmt)) {
        if (js::num(lmt) > wingLo) {
            issues.append(bad(u"蝴蝶净权利金 "_s + util::fmtF(js::num(lmt), 2) + u" 超过翼宽 "_s + util::fmtF(wingLo, 2) + u",数学上不可能盈利。"_s));
        }
    }
    return issues;
}

QList<Issue> Validator::checkIronCondor(const OJson& contract, const OJson& order) const {
    const std::vector<const OJson*> legs = sortedByStrike(legsOf(contract));
    if (legs.size() != 4) return {bad(u"铁鹰必须正好四条腿。"_s)};

    QList<Issue> issues;
    if (!isStrEq(P(order, u"action"), u"SELL")) issues.append(bad(u"仅支持卖出(贷方)铁鹰:收权利金、卖内侧买外翼。借方(反向)铁鹰不支持。"_s));
    std::vector<const OJson*> expiries, strikes;
    for (const OJson* l : legs) {
        expiries.push_back(P(*l, u"lastTradeDateOrContractMonth"));
        strikes.push_back(P(*l, u"strike"));
    }
    if (distinctCount(expiries) != 1) issues.append(bad(u"铁鹰四条腿到期日必须相同。"_s));
    if (std::any_of(legs.begin(), legs.end(), [](const OJson* l) { return !isNumEq(P(*l, u"ratio"), 1); })) issues.append(bad(u"铁鹰四条腿比例必须都是 1。"_s));
    if (distinctCount(strikes) != 4) issues.append(bad(u"铁鹰四条腿行权价必须互不相同(内侧同价的铁蝶结构不支持)。"_s));

    const std::vector<const OJson*> puts = filterRight(legs, u"P");
    const std::vector<const OJson*> calls = filterRight(legs, u"C");
    if (puts.size() != 2 || calls.size() != 2) issues.append(bad(u"铁鹰必须由两条 Put 腿与两条 Call 腿组成。"_s));
    if (!issues.isEmpty()) return issues;

    if (Nx(*puts.back(), u"strike") >= Nx(*calls.front(), u"strike")) issues.append(bad(u"铁鹰的 Put 侧行权价必须整体低于 Call 侧。"_s));
    if (!isStrEq(P(*puts[0], u"action"), u"BUY") || !isStrEq(P(*puts[1], u"action"), u"SELL"))
        issues.append(bad(u"Put 侧腿方向不对:应买入低行权价、卖出高行权价。"_s));
    if (!isStrEq(P(*calls[0], u"action"), u"SELL") || !isStrEq(P(*calls[1], u"action"), u"BUY"))
        issues.append(bad(u"Call 侧腿方向不对:应卖出低行权价、买入高行权价。"_s));
    return issues;
}

// ---- 触发条件 ------------------------------------------------------
QList<Issue> Validator::checkTrigger(const OJson& order, QStringList& warnings) const {
    const OJson* trigger = P(order, u"trigger");
    const QString symbol = js::str(js::propStrict(trigger, u"symbol"_s));
    const QString op = Sx(*trigger, u"operator");
    const double value = Nx(*trigger, u"value");
    const auto found = snapshot_.constFind(symbol);
    if (found == snapshot_.cend()) {
        if (settings_.policies.require_trigger_price_verification) {
            return {{u"AMBIGUOUS_TRIGGER"_s, u"缺少 "_s + symbol + u" 的现价快照,无法独立复核触发方向(" + op + u' ' + util::fmtF(value, 4) + u"),按策略拒绝。"_s}};
        }
        warnings << u"未取得 "_s + symbol + u" 现价,触发方向未经软件层复核"_s;
        return {};
    }
    const double price = found.value();

    const bool priceTruthy = price != 0 && !std::isnan(price);
    const double gapBps = priceTruthy ? (std::fabs(price - value) / price) * 10'000 : 0.0;
    if (gapBps < settings_.policies.trigger_min_gap_bps) {
        return {{u"AMBIGUOUS_TRIGGER"_s, symbol + u" 现价 "_s + util::fmtF(price, 4) + u" 与触发价 "_s + util::fmtF(value, 4) + u" 相差仅 "_s + util::fmtF(gapBps, 1) +
                                             u" 个基点,方向不可靠,已拒绝。"_s}};
    }

    const QString expected = price < value ? u">="_s : u"<="_s;
    if (const OJson* given = P(*trigger, u"operator"); !(js::isStr(given) && given->s == expected)) {
        return {{u"TRIGGER_MISMATCH"_s, u"触发方向判反了:"_s + symbol + u" 现价 "_s + util::fmtF(price, 4) + u' ' + (price < value ? u"低于"_s : u"高于"_s) + u" 触发价 "_s +
                                            util::fmtF(value, 4) + u",应为 "_s + expected + u",模型给的是 "_s + op + u"。"_s}};
    }
    warnings << u"已复核:"_s + symbol + u" 现价 "_s + util::fmtF(price, 4) + u",触发条件 "_s + op + u' ' + util::fmtF(value, 4) + u" 方向一致"_s;
    return {};
}

contract::RiskBudgetConfig Validator::budgetConfig() const {
    const contract::RiskBudgetConfig& cfg = settings_.risk_budget;
    if (!extras_.equity) return cfg;
    // { ...this.extras.equity, ...filled }:人填了(> 0)的盖过券商报的
    contract::RiskBudgetConfig out = cfg;
    contract::OrderedMap<double> merged = *extras_.equity;
    for (const QString& alias : cfg.equity_usd.keys()) {
        const double v = cfg.equity_usd.value(alias);
        if (v > 0) merged.insert(alias, v);
    }
    out.equity_usd = merged;
    return out;
}

void Validator::countInBatch(const OJson& order, const QString& alias, double notional) {
    const OJson& contract = *P(order, u"contract");
    const OJson* secType = P(contract, u"secType");
    if (!isStrEq(secType, u"OPT") && !isStrEq(secType, u"BAG")) return;
    if (extras_.isReduction && extras_.isReduction(order, alias)) {
        if (extras_.consumeReduction) extras_.consumeReduction(order, alias);
        return;
    }
    batchRisk_.insert(alias, batchRisk_.value(alias, 0) + notional);
    const QString key = analysis::open_risk::contractsKey(alias, Sx(contract, u"symbol"), orderExpiry(contract));
    batchContracts_.insert(key, batchContracts_.value(key, 0) + Nx(*P(order, u"order"), u"totalQuantity"));
}

QList<Issue> Validator::checkOpenLimits(const OJson& order, const QString& alias, const contract::Limits& limits, double notional, QStringList& warnings) const {
    const OJson& contract = *P(order, u"contract");
    const OJson* secType = P(contract, u"secType");
    if (!isStrEq(secType, u"OPT") && !isStrEq(secType, u"BAG")) return {};
    if (!(limits.max_open_risk_usd > 0) && !(limits.max_underlying_contracts > 0)) return {};
    if (!extras_.capNote.isEmpty()) warnings << extras_.capNote;
    if (!extras_.exposure || (extras_.isReduction && extras_.isReduction(order, alias))) return {};
    const OJson& exposure = *extras_.exposure;
    if (exposure.type == OJson::Null) {
        return {{u"UNPRICEABLE"_s, u"读不到账户 "_s + alias + u" 的持仓,核对不了在手的累计上限(在手风险 / 同标的张数),已拒绝。连上券商后重试。"_s}};
    }
    QList<Issue> issues;
    // 别名是 Object.prototype 上的名字时 TS 那边成了字符串拼接、和上限比较是 NaN:永远不拦(头文件里写了)
    if (limits.max_open_risk_usd > 0 && !util::market::onObjectPrototype(alias)) {
        const OJson* own = js::propStrict(&exposure, u"riskUsd"_s);
        const OJson* riskHeld = js::propStrict(own, alias);
        const double held = (js::nullish(riskHeld) ? 0 : js::num(riskHeld)) + batchRisk_.value(alias, 0);
        if (held + notional > limits.max_open_risk_usd) {
            issues.append({u"EXCEEDS_LIMIT"_s, u"账户 "_s + alias + u" 在手期权的最坏亏损合计约 "_s + util::fmtF(held, 2) + u" USD,加上这一单 "_s + util::fmtF(notional, 2) +
                                                   u" USD,超过在手风险上限 "_s + util::fmtF(limits.max_open_risk_usd, 2) + u" USD。"_s});
        }
    }
    if (limits.max_underlying_contracts > 0) {
        const QString expiry = orderExpiry(contract);
        const QString symbol = Sx(contract, u"symbol");
        const QString key = analysis::open_risk::contractsKey(alias, symbol, expiry);
        const OJson* got = js::propStrict(js::propStrict(&exposure, u"contracts"_s), key);
        const double held = (js::nullish(got) ? 0 : js::num(got)) + batchContracts_.value(key, 0);
        const double qty = Nx(*P(order, u"order"), u"totalQuantity");
        if (held + qty > limits.max_underlying_contracts) {
            issues.append({u"EXCEEDS_LIMIT"_s, u"账户 "_s + alias + u" 在 "_s + symbol + u' ' + expiry + u" 到期上已有 "_s + util::pyG(held) + u" 张,加上这一单 "_s + n2s(qty) +
                                                   u" 张,超过同一标的同一到期的上限 "_s + n2s(limits.max_underlying_contracts) + u" 张。"_s});
        }
    }
    return issues;
}

// ---- 限额 ---------------------------------------------------------
std::pair<double, QList<Issue>> Validator::checkLimits(const OJson& order, const contract::Limits& limits) const {
    const OJson& contract = *P(order, u"contract");
    const OJson& spec = *P(order, u"order");
    const double qty = Nx(spec, u"totalQuantity");
    const OJson* secType = P(contract, u"secType");
    QList<Issue> issues;
    double notional = 0;

    if (isStrEq(secType, u"BAG")) {
        const double width = riskWidth(contract);
        const OJson* lmt = P(spec, u"lmtPrice");
        if (isStrEq(P(spec, u"price_mode"), u"EXPLICIT") && notNull(lmt)) {
            if (isStrEq(P(spec, u"action"), u"BUY")) {
                // 借方组合最大亏损 = 付出的净权利金
                notional = qty * domain::models::multiplierValue(contract) * js::num(lmt);
            } else {
                // 贷方组合最大亏损 = 宽度 - 收到的权利金
                notional = qty * domain::models::multiplierValue(contract) * jsmath::max(width - js::num(lmt), 0.0);
            }
        } else {
            // AUTO_MID:权利金未知,用结构宽度做最大亏损上界
            notional = qty * domain::models::multiplierValue(contract) * width;
        }
    } else if (isStrEq(secType, u"OPT")) {
        if (isStrEq(P(spec, u"action"), u"SELL")) {
            if (!isStrEq(P(contract, u"right"), u"P")) {
                return {0.0, {{u"UNSUPPORTED"_s, u"裸卖 Call 的最大亏损无上限,且本系统无法核对你是否持有正股(备兑)。单腿卖出 Call 不支持;备兑思路请直接在 TWS 操作,"_s
                                                 u"或改用风险有界的贷方价差(卖出 call spread)。"_s}}};
            }
            const OJson* strike = P(contract, u"strike");
            if (!js::truthy(strike) || js::num(strike) <= 0) {
                return {0.0, {{u"UNPRICEABLE"_s, u"卖出 Put 需要行权价才能按最坏情况(被行权接货)核算敞口,当前合约缺少行权价,已拒绝。"_s}}};
            }
            // 卖出 Put 按现金担保口径计敞口
            notional = qty * domain::models::multiplierValue(contract) * js::num(strike);
        } else {
            // 买入期权:最大亏损 = 付出的权利金(标的现价不是权利金,不做快照兜底)
            const auto premium = optionPremiumCap(spec);
            if (!premium) return {0.0, {unpriceableOptionBuy(spec)}};
            notional = qty * domain::models::multiplierValue(contract) * *premium;
        }
    } else {
        const auto snap = snapshot_.constFind(Sx(contract, u"symbol"));
        const auto ref = stockReferencePrice(spec, snap == snapshot_.cend() ? std::nullopt : std::optional<double>(snap.value()));
        if (!ref) {
            if (qty > limits.max_mkt_shares) {
                const QString orderType = Sx(spec, u"orderType");
                const QString shares = n2s(Nx(spec, u"totalQuantity"));
                return {0.0, {{u"EXCEEDS_LIMIT"_s, orderType == u"MKT"
                                                        ? u"无法估算市价单金额(指令与行情快照都没有参考价),股数 "_s + shares + u" 超过市价单上限 "_s + n2s(limits.max_mkt_shares) + u" 股。"_s
                                                        : u"无法估算这张 "_s + orderType + u" 单的金额(回撤额不是价格,行情快照也没有现价),股数 "_s + shares +
                                                              u" 超过无参考价时的上限 "_s + n2s(limits.max_mkt_shares) + u" 股。"_s}}};
            }
            return {0.0, {}};
        }
        notional = qty * *ref;
    }

    if (notional > limits.max_order_notional) {
        issues.append({u"EXCEEDS_LIMIT"_s, u"本笔风险敞口约 "_s + util::fmtF(notional, 2) + u" USD,超过单笔上限 "_s + util::fmtF(limits.max_order_notional, 2) + u" USD。"_s});
    }
    if ((isStrEq(secType, u"OPT") || isStrEq(secType, u"BAG")) && Nx(spec, u"totalQuantity") > limits.max_option_contracts) {
        issues.append({u"EXCEEDS_LIMIT"_s, u"期权/价差单笔 "_s + n2s(Nx(spec, u"totalQuantity")) + u" 张,超过上限 "_s + n2s(limits.max_option_contracts) + u" 张。"_s});
    }
    return {notional, issues};
}

// ---- 交易时段 ------------------------------------------------------
QList<Issue> Validator::checkSession(const OJson& order, QStringList& warnings) const {
    const QString policy = settings_.policies.closed_market_policy;
    const QString status = statusFor(order);
    const OJson& spec = *P(order, u"order");
    const bool outsideRth = js::truthy(P(spec, u"outsideRth"));
    const bool mkt = isStrEq(P(spec, u"orderType"), u"MKT");

    if (status == u"休市") {
        if (isStrEq(P(order, u"execution_type"), u"CONDITIONAL")) {
            warnings << u"当前休市,条件单进入等待队列,开盘后才可能触发"_s;
            return {};
        }
        if (policy == u"reject_all") return {{u"MARKET_CLOSED"_s, u"当前休市,按策略拒绝所有直接执行型订单。"_s}};
        if (policy == u"reject_market_orders" && mkt) {
            return {{u"MARKET_CLOSED"_s, u"当前休市,市价单会在开盘瞬间以未知价格成交,风险过大,已拒绝。请改成限价单,例如'限价 230 买入'。"_s}};
        }
        warnings << u"当前休市,订单将挂到下一个交易时段"_s;
        return {};
    }

    const bool extended = kExtendedStatuses.contains(status);
    if (extended && !outsideRth) {
        warnings << u"当前为"_s + status + u",outsideRth=false:订单会挂着,到常规时段才送交易所。要在"_s + status + u"就成交,指令里加「盘外」或「隔夜」。"_s;
    }
    if (extended && outsideRth && mkt) {
        // 交易所盘外只接受限价单:盘外市价单必须硬拒而不是警告
        return {{u"UNSUPPORTED"_s, status + u"市价单不被交易所支持:盘外只接受限价单,市价单会一直等到开盘才成交,与盘外成交的意图矛盾。请改写为盘外限价单,例如'盘前限价 X 买入…'。"_s}};
    }
    return {};
}

// ---- 重复防抖 ------------------------------------------------------
QList<Issue> Validator::checkDuplicate(const OJson& order, const QString& signature, const QHash<QString, double>& seenInBatch) const {
    const contract::Limits& limits = settings_.limits;
    const OJson& spec = *P(order, u"order");
    const double qty = Nx(spec, u"totalQuantity");

    if (const auto seen = seenInBatch.constFind(signature); seen != seenInBatch.cend()) {
        const OJson prev = OJson::number(seen.value());
        if (qtyClose(qty, &prev, limits.duplicate_qty_tolerance)) {
            return {{u"DUPLICATE_ORDER"_s, u"同一条输入里出现了重复订单("_s + signature + u"),已拦截第二笔以防重复下单。"_s}};
        }
    }

    const double windowMs = limits.duplicate_window_minutes * 60'000;
    for (const OJson& recent : recentOrders_) {
        const OJson* sig = P(recent, u"signature");
        if (!(js::isStr(sig) && sig->s == signature)) continue;
        if (nowEt_.epochMs - Nx(recent, u"createdAtMs") > windowMs) continue;
        const OJson* quantity = P(recent, u"quantity");
        if (!qtyClose(qty, quantity, limits.duplicate_qty_tolerance)) continue;
        // 那一张已经撤掉、这一次的限价和它差到一分钱以上:不是手滑重复,是没成交、撤了、换个价再来
        const OJson* finalStatus = P(recent, u"finalStatus");
        if (isStrEq(finalStatus, u"cancelled") && differentPrice(P(spec, u"lmtPrice"), P(recent, u"limitPrice"))) continue;
        if (finalStatus && finalStatus->type == OJson::Null) {
            return {{u"DUPLICATE_ORDER"_s, n2s(limits.duplicate_window_minutes) + u" 分钟内提交过的同一张单("_s + signature + u",数量 "_s + js::pyG(quantity) +
                                               u")还没有终态:它可能还挂在券商那边,再发一张两张都可能成交。先撤掉那一张(或等它成交),再发新的;确要两张都留,改变数量。"_s}};
        }
        return {{u"DUPLICATE_ORDER"_s, n2s(limits.duplicate_window_minutes) + u" 分钟内已提交过高度相似的订单("_s + signature + u",数量 "_s + js::pyG(quantity) +
                                           u"),已拦截以防重复下单。如确需再下一笔,请等待窗口结束或改变数量。"_s}};
    }
    return {};
}

// ================================================================ 指纹与宽度
QString orderSignature(const OJson& order, const QString& accountAlias) {
    const OJson& contract = *js::propStrict(&order, u"contract"_s);
    const OJson* secType = P(contract, u"secType");
    QStringList parts{accountAlias, js::str(js::path(&order, {u"order"_s, u"action"_s})), js::str(secType), Sx(contract, u"symbol")};
    if (isStrEq(secType, u"OPT")) {
        const OJson* strike = P(contract, u"strike");
        parts << js::strOr(P(contract, u"lastTradeDateOrContractMonth"), QString()) << (js::nullish(strike) ? util::pyG(0) : js::pyG(strike))
              << js::strOr(P(contract, u"right"), QString());
    } else if (isStrEq(secType, u"BAG")) {
        for (const OJson* leg : sortedByStrike(legsOf(contract)))
            parts << Sx(*leg, u"action") << Sx(*leg, u"ratio") << Sx(*leg, u"lastTradeDateOrContractMonth") << js::pyG(P(*leg, u"strike")) << Sx(*leg, u"right");
    }
    return parts.join(u'|');
}

double riskWidth(const OJson& contract) {
    const std::vector<const OJson*> legs = sortedByStrike(legsOf(contract));
    const OJson* strategy = P(contract, u"combo_strategy");
    if (isStrEq(strategy, u"VERTICAL") && legs.size() == 2) return std::fabs(Nx(*legs[1], u"strike") - Nx(*legs[0], u"strike"));
    if (isStrEq(strategy, u"BUTTERFLY") && legs.size() == 3) return Nx(*legs[1], u"strike") - Nx(*legs[0], u"strike");
    if (isStrEq(strategy, u"IRON_CONDOR") && legs.size() == 4) {
        const auto puts = filterRight(legs, u"P");
        const auto calls = filterRight(legs, u"C");
        if (puts.size() == 2 && calls.size() == 2) {
            return jsmath::max(Nx(*puts[1], u"strike") - Nx(*puts[0], u"strike"), Nx(*calls[1], u"strike") - Nx(*calls[0], u"strike"));
        }
    }
    return 0.0;
}

// ================================================================ JSON
OJson toJson(const Issue& issue) { return js::object({{u"code"_s, js::S(issue.code)}, {u"message"_s, js::S(issue.message)}}); }

OJson toJson(const ApprovedOrder& a) {
    const OJson account = js::object({{u"alias"_s, js::S(a.account.alias)},
                                      {u"account_id"_s, js::S(a.account.account_id)},
                                      {u"is_paper"_s, js::B(a.account.is_paper)},
                                      {u"connection"_s, js::S(a.account.connection)},
                                      {u"default"_s, js::B(a.account.isDefault)}});
    return js::object({{u"order"_s, a.order}, {u"account"_s, account}, {u"notional"_s, js::N(a.notional)}, {u"signature"_s, js::S(a.signature)}, {u"warnings"_s, js::strings(a.warnings)}});
}

OJson toJson(const RejectedOrder& r) {
    OJson issues = js::array();
    for (const Issue& i : r.issues) issues.items.append(toJson(i));
    return js::object({{u"order"_s, r.order}, {u"issues"_s, issues}});
}

OJson toJson(const ValidationOutcome& outcome) {
    OJson approved = js::array(), rejected = js::array();
    for (const ApprovedOrder& a : outcome.approved) approved.items.append(toJson(a));
    for (const RejectedOrder& r : outcome.rejected) rejected.items.append(toJson(r));
    return js::object({{u"approved"_s, approved}, {u"rejected"_s, rejected}});
}

}  // namespace ibkr::parsing::validator
