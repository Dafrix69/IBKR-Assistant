#include "analysis/backtest.h"

#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsobj.h"
#include "util/py.h"
#include "util/tz.h"

#include <QStringList>

#include <algorithm>
#include <cmath>
#include <limits>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;
namespace jm = ibkr::util::jsmath;

namespace ibkr::analysis::backtest {

namespace {
constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();
constexpr double kInf = std::numeric_limits<double>::infinity();

QString n2s(double v) { return util::jsNumberToString(v); }
/// xs[i]:越界(含 NaN、负数、小数下标)是 undefined → 当数用是 NaN
double at(const std::vector<double>& xs, double i) {
    if (!(i >= 0) || i != std::floor(i) || i >= double(xs.size())) return kNaN;
    return xs[size_t(i)];
}
std::optional<double> at(const Series& xs, double i) {
    if (!(i >= 0) || i != std::floor(i) || i >= double(xs.size())) return std::nullopt;
    return xs[size_t(i)];
}
/// pyRepr 吃 QJsonValue:undefined 单独给
QString reprOf(const OJson* v) { return util::pyRepr(v ? v->toQJson() : QJsonValue(QJsonValue::Undefined)); }
/// {...v}:对象拷自己的键;数组、串按下标键展开;别的(数、布尔、null、undefined)什么都不带
OJson spread(const OJson* v) {
    OJson out = js::object();
    if (!v) return out;
    if (v->type == OJson::Object) return *v;
    if (v->type == OJson::Array) {
        for (qsizetype i = 0; i < v->items.size(); ++i) out.set(QString::number(i), v->items[i]);
    } else if (v->type == OJson::String) {
        for (qsizetype i = 0; i < v->s.size(); ++i) out.set(QString::number(i), js::S(QString(v->s[i])));
    }
    return out;
}
/// `key in obj`(obj 是对象字面量 / 拷贝出来的普通对象)
bool hasIn(const OJson& obj, const QString& key) { return obj.get(key) != nullptr || onObjectPrototype(key) || key == u"__proto__"; }
}  // namespace

bool onObjectPrototype(const QString& k) {
    static const QStringList names{u"constructor"_s,      u"__defineGetter__"_s, u"__defineSetter__"_s, u"hasOwnProperty"_s,
                                   u"__lookupGetter__"_s, u"__lookupSetter__"_s, u"isPrototypeOf"_s,    u"propertyIsEnumerable"_s,
                                   u"toString"_s,         u"valueOf"_s,          u"toLocaleString"_s};
    return names.contains(k);
}

const OJson& strategies() {
    static const OJson s = js::object({
        {u"buy_hold"_s, js::object({{u"label"_s, js::S(u"买入持有"_s)},
                                    {u"desc"_s, js::S(u"第一天买入,一直持有到区间结束。是所有策略的基准。"_s)},
                                    {u"params"_s, js::object()},
                                    {u"param_labels"_s, js::object()}})},
        {u"sma_cross"_s, js::object({{u"label"_s, js::S(u"均线交叉"_s)},
                                     {u"desc"_s, js::S(u"快线上穿慢线持有,下穿空仓。"_s)},
                                     {u"params"_s, js::object({{u"fast"_s, js::N(10)}, {u"slow"_s, js::N(50)}})},
                                     {u"param_labels"_s, js::object({{u"fast"_s, js::S(u"快线周期(日)"_s)}, {u"slow"_s, js::S(u"慢线周期(日)"_s)}})}})},
        {u"rsi"_s, js::object({{u"label"_s, js::S(u"RSI 超卖买入"_s)},
                               {u"desc"_s, js::S(u"RSI 跌破买入线建仓,升破卖出线离场。"_s)},
                               {u"params"_s, js::object({{u"period"_s, js::N(14)}, {u"buy_below"_s, js::N(30)}, {u"sell_above"_s, js::N(70)}})},
                               {u"param_labels"_s, js::object({{u"period"_s, js::S(u"RSI 周期(日)"_s)},
                                                               {u"buy_below"_s, js::S(u"跌破这个值买入"_s)},
                                                               {u"sell_above"_s, js::S(u"升破这个值卖出"_s)}})}})},
        {u"breakout"_s, js::object({{u"label"_s, js::S(u"N 日突破"_s)},
                                    {u"desc"_s, js::S(u"收盘创 N 日新高买入,跌破 M 日低点离场(唐奇安通道)。"_s)},
                                    {u"params"_s, js::object({{u"entry"_s, js::N(20)}, {u"exit"_s, js::N(10)}})},
                                    {u"param_labels"_s, js::object({{u"entry"_s, js::S(u"入场:创 N 日新高"_s)}, {u"exit"_s, js::S(u"出场:跌破 M 日低点"_s)}})}})},
        {u"custom"_s, js::object({{u"label"_s, js::S(u"自定义(多条件)"_s)},
                                  {u"desc"_s, js::S(u"自己搭条件:全部入场条件同时满足时买入,全部出场条件同时满足时卖出。"_s)},
                                  {u"params"_s, js::object()},
                                  {u"param_labels"_s, js::object()}})},
    });
    return s;
}

const OJson& optionTypes() {
    static const OJson t = js::object({
        {u"call"_s, js::S(u"买入看涨"_s)},
        {u"put"_s, js::S(u"买入看跌"_s)},
        {u"call_spread"_s, js::S(u"看涨借方价差"_s)},
        {u"put_spread"_s, js::S(u"看跌借方价差"_s)},
        {u"butterfly"_s, js::S(u"买入蝴蝶"_s)},
    });
    return t;
}

namespace {
bool isIntParamKey(const QString& k) { return k == u"fast" || k == u"slow" || k == u"period" || k == u"entry" || k == u"exit"; }
std::vector<double> closesOf(const Bars& bars) {
    std::vector<double> out;
    out.reserve(bars.size());
    for (const Bar& b : bars) out.push_back(b.close);
    return out;
}
std::vector<std::pair<QString, const OJson*>> entriesOf(const OJson* v) {
    // Object.entries(params ?? {}):对象的键;数组、串的下标键;别的没有
    std::vector<std::pair<QString, const OJson*>> out;
    if (!v) return out;
    if (v->type == OJson::Object) {
        for (const auto& [k, x] : v->fields) out.emplace_back(k, &x);
    } else if (v->type == OJson::Array) {
        for (qsizetype i = 0; i < v->items.size(); ++i) out.emplace_back(QString::number(i), &v->items[i]);
    } else if (v->type == OJson::String) {
        static const OJson dummy = js::S(QString());  // 值用不上:下标键不在任何参数表里,当场就抛
        for (qsizetype i = 0; i < v->s.size(); ++i) out.emplace_back(QString::number(i), &dummy);
    }
    return out;
}
}  // namespace

// ---------------------------------------------------------------- 信号
namespace {
std::vector<double> strategyPositions(const Bars& bars, const QString& strategy, const OJson& p) {
    const std::vector<double> closes = closesOf(bars);
    const size_t n = bars.size();
    const auto P = [&](const QString& k) { return js::num(p.get(k)); };

    if (strategy == u"buy_hold") return std::vector<double>(n, 1);

    if (strategy == u"sma_cross") {
        const double fast = P(u"fast"_s), slow = P(u"slow"_s);
        if (fast >= slow) throw BacktestError(u"快线周期必须小于慢线周期(当前 %1/%2)"_s.arg(n2s(fast), n2s(slow)));
        const Series smaF = sma(closes, fast), smaS = sma(closes, slow);
        std::vector<double> out(n);
        for (size_t i = 0; i < n; ++i) out[i] = smaF[i] && smaS[i] && *smaF[i] > *smaS[i] ? 1 : 0;
        return out;
    }

    if (strategy == u"rsi") {
        const Series rsiSeries = rsi(closes, P(u"period"_s));
        const double buyBelow = P(u"buy_below"_s), sellAbove = P(u"sell_above"_s);
        if (buyBelow >= sellAbove) throw BacktestError(u"RSI 买入线必须低于卖出线"_s);
        std::vector<double> out;
        bool holding = false;
        for (const auto& value : rsiSeries) {
            if (!value) {
                out.push_back(0);
                continue;
            }
            if (!holding && *value < buyBelow) holding = true;
            else if (holding && *value > sellAbove) holding = false;
            out.push_back(holding ? 1 : 0);
        }
        return out;
    }

    // breakout(Object.prototype 上的名字也走到这里:entry / exit 是 undefined,当数是 NaN,比较全是假,同 JS)
    const double entryN = P(u"entry"_s), exitN = P(u"exit"_s);
    std::vector<double> out;
    bool holding = false;
    for (size_t i = 0; i < n; ++i) {
        const Bar& bar = bars[i];
        const double di = double(i);
        if (di < entryN) {
            out.push_back(0);
            continue;
        }
        if (!holding) {
            double hi = -kInf;
            for (double j = di - entryN; j < di; ++j) hi = jm::max(hi, bars[size_t(j)].high);
            if (bar.close > hi) holding = true;
        } else {
            const double start = jm::max(0, di - exitN);
            if (start < di) {
                double lo = kInf;
                for (double j = start; j < di; ++j) lo = jm::min(lo, bars[size_t(j)].low);
                if (bar.close < lo) holding = false;
            }
        }
        out.push_back(holding ? 1 : 0);
    }
    return out;
}

// ---------------------------------------------------------------- 自定义条件
Series operandSeries(const Bars& bars, const OJson* operand) {
    const size_t n = bars.size();
    const OJson* kind = js::prop(operand, u"kind"_s);
    if (js::isStr(kind) && kind->s == u"const") {
        const OJson* raw = js::prop(operand, u"value"_s);
        const double value = js::num(raw);
        if (js::nullish(raw) || std::isnan(value)) throw BacktestError(u"常数操作数缺少数值"_s);
        return Series(n, value);
    }

    const OJson* nameV = js::prop(operand, u"name"_s);
    const QString name = js::isStr(nameV) ? nameV->s : QString();
    const bool isName = js::isStr(nameV);
    const OJson* periodV = js::prop(operand, u"period"_s);
    double period = std::trunc(js::nullish(periodV) ? 0.0 : js::num(periodV));
    if (std::isnan(period) || period == 0) period = 0;  // `|| 0`:NaN 与 −0 都成 0
    static const QStringList needsPeriod{u"sma"_s, u"ema"_s, u"rsi"_s, u"highest"_s, u"lowest"_s, u"change_pct"_s};
    if (isName && needsPeriod.contains(name)) {
        if (!(period > 0 && period <= kMaxParam)) throw BacktestError(u"指标 %1 的 period 超出范围:%2"_s.arg(name, n2s(period)));
    }

    const std::vector<double> closes = closesOf(bars);
    const auto pick = [&](double Bar::*field) {
        Series out;
        out.reserve(n);
        for (const Bar& b : bars) out.emplace_back(b.*field);
        return out;
    };
    if (isName) {
        if (name == u"close") return pick(&Bar::close);
        if (name == u"open") return pick(&Bar::open);
        if (name == u"high") return pick(&Bar::high);
        if (name == u"low") return pick(&Bar::low);
        if (name == u"sma") return sma(closes, period);
        if (name == u"ema") return ema(closes, period);
        if (name == u"rsi") return rsi(closes, period);
        if (name == u"highest") {
            // 前 N 日最高(不含当日,突破判断的惯例)
            Series out;
            for (size_t i = 0; i < n; ++i) {
                if (double(i) < period) {
                    out.emplace_back(std::nullopt);
                    continue;
                }
                double hi = -kInf;
                for (size_t j = i - size_t(period); j < i; ++j) hi = jm::max(hi, bars[j].high);
                out.emplace_back(hi);
            }
            return out;
        }
        if (name == u"lowest") {
            Series out;
            for (size_t i = 0; i < n; ++i) {
                if (double(i) < period) {
                    out.emplace_back(std::nullopt);
                    continue;
                }
                double lo = kInf;
                for (size_t j = i - size_t(period); j < i; ++j) lo = jm::min(lo, bars[j].low);
                out.emplace_back(lo);
            }
            return out;
        }
        if (name == u"change_pct") {
            Series out;
            for (size_t i = 0; i < n; ++i)
                out.emplace_back(double(i) >= period ? std::optional((closes[i] / closes[i - size_t(period)] - 1.0) * 100.0) : std::nullopt);
            return out;
        }
        if (name == u"macd_hist") return macdHist(closes);
    }
    throw BacktestError(u"未知指标:"_s + reprOf(nameV));
}

std::vector<bool> condSeries(const Bars& bars, const OJson* cond) {
    const OJson* leftV = js::propStrict(cond, u"left"_s);
    static const OJson empty = js::object();
    const Series left = operandSeries(bars, js::nullish(leftV) ? &empty : leftV);
    const OJson* rightV = js::propStrict(cond, u"right"_s);
    const Series right = operandSeries(bars, js::nullish(rightV) ? &empty : rightV);
    const OJson* opV = js::propStrict(cond, u"op"_s);
    const QString op = js::isStr(opV) ? opV->s : QString();
    const bool isOp = js::isStr(opV);
    std::vector<bool> out;
    for (size_t i = 0; i < bars.size(); ++i) {
        const auto l = left[i], r = right[i];
        if (!l || !r) {
            out.push_back(false);
            continue;
        }
        if (isOp && op == u">") out.push_back(*l > *r);
        else if (isOp && op == u"<") out.push_back(*l < *r);
        else if (isOp && op == u">=") out.push_back(*l >= *r);
        else if (isOp && op == u"<=") out.push_back(*l <= *r);
        else if (isOp && (op == u"cross_up" || op == u"cross_down")) {
            const auto pl = i > 0 ? left[i - 1] : std::nullopt;
            const auto pr = i > 0 ? right[i - 1] : std::nullopt;
            if (!pl || !pr) out.push_back(false);
            else if (op == u"cross_up") out.push_back(*pl <= *pr && *l > *r);
            else out.push_back(*pl >= *pr && *l < *r);
        } else {
            throw BacktestError(u"未知比较符:"_s + reprOf(opV));
        }
    }
    return out;
}

/// (rules["entry"] as Rules[]).map(...):不是数组时 V8 的话
std::vector<std::vector<bool>> condList(const Bars& bars, const OJson* list, const QString& expr) {
    std::vector<std::vector<bool>> out;
    if (!js::isArr(list)) throw util::JsError(expr + u" is not a function"_s);
    for (const OJson& c : list->items) out.push_back(condSeries(bars, &c));
    return out;
}

std::vector<double> customPositions(const Bars& bars, const OJson& rules) {
    const auto entry = condList(bars, rules.get(u"entry"_s), u"rules.entry.map"_s);
    const OJson* exitV = rules.get(u"exit"_s);
    static const OJson none = js::array();
    const auto exit = condList(bars, js::nullish(exitV) ? &none : exitV, u"(rules.exit ?? []).map"_s);
    std::vector<double> out;
    bool holding = false;
    for (size_t i = 0; i < bars.size(); ++i) {
        const auto all = [&](const std::vector<std::vector<bool>>& cs) {
            return std::all_of(cs.begin(), cs.end(), [&](const std::vector<bool>& c) { return bool(c[i]); });
        };
        if (!holding && all(entry)) holding = true;
        else if (holding && !exit.empty() && all(exit)) holding = false;
        out.push_back(holding ? 1 : 0);
    }
    return out;
}
}  // namespace

Signal signalPositions(const Bars& bars, const QString& strategy, const OJson* params, const OJson* rules) {
    if (!hasIn(strategies(), strategy)) {
        throw BacktestError(u"未知策略:%1(可选:%2)"_s.arg(strategy, js::keys(&strategies()).join(u"、"_s)));
    }
    if (bars.size() < 5) throw BacktestError(u"区间内只有 %1 根日线,数据太少无法回测"_s.arg(bars.size()));

    Signal out;
    out.usedParams = js::object();
    if (strategy == u"custom") {
        const OJson* entry = js::prop(rules, u"entry"_s);
        // rules["entry"].length:串的长度在这里也算(之后 .map 不存在才抛)
        const bool hasLength = js::isStr(entry) ? !entry->s.isEmpty() : js::isArr(entry) ? !entry->items.isEmpty() : js::truthy(js::prop(entry, u"length"_s));
        if (!js::truthy(rules) || !(js::truthy(entry) && hasLength)) throw BacktestError(u"自定义策略至少需要一条入场条件"_s);
        if (!js::isObj(rules)) throw util::JsError(u"rules.entry.map is not a function"_s);
        out.positions = customPositions(bars, *rules);
    } else {
        // {...STRATEGIES[strategy].params}:Object.prototype 上的名字取不到 params,是空对象
        const OJson* meta = strategies().get(strategy);
        OJson merged = meta ? *meta->get(u"params"_s) : js::object();
        for (const auto& [key, rawValue] : entriesOf(params)) {
            if (!hasIn(merged, key)) throw BacktestError(u"策略 %1 没有参数 %2"_s.arg(strategy, key));
            const double value = js::num(rawValue);
            if (js::isBool(rawValue) || rawValue->type == OJson::Null || std::isnan(value)) throw BacktestError(u"参数 %1 必须是数字"_s.arg(key));
            const bool inRange = key == u"buy_below" || key == u"sell_above" ? value > 0 && value < 100 : value > 0 && value <= kMaxParam;
            if (!inRange) throw BacktestError(u"参数 %1 超出合理范围:%2"_s.arg(key, util::pyFloat(value)));
            // merged["__proto__"] = 数:改原型的赋值,给的是数时什么都不做
            if (key != u"__proto__") merged.set(key, js::N(isIntParamKey(key) ? std::trunc(value) : value));
        }
        out.positions = strategyPositions(bars, strategy, merged);
        out.usedParams = merged;
    }
    return out;
}

std::vector<double> heldAfterOpen(const std::vector<double>& signal) {
    std::vector<double> out(signal.size());
    for (size_t i = 0; i < signal.size(); ++i) out[i] = i == 0 ? 0 : signal[i - 1];
    return out;
}

Series macdHist(const std::vector<double>& closes) {
    const size_t n = closes.size();
    const Series e12 = ema(closes, 12), e26 = ema(closes, 26);
    Series line(n);
    for (size_t i = 0; i < n; ++i) line[i] = e12[i] && e26[i] ? std::optional(*e12[i] - *e26[i]) : std::nullopt;
    Series out(n);
    size_t first = 0;
    while (first < n && !line[first]) ++first;
    if (first >= n) return out;
    std::vector<double> sub;
    for (size_t i = first; i < n; ++i)
        if (line[i]) sub.push_back(*line[i]);
    const Series signal = ema(sub, 9);
    for (size_t j = 0; j < signal.size(); ++j)
        if (signal[j]) out[first + j] = sub[j] - *signal[j];
    return out;
}

Series ema(const std::vector<double>& values, double window) {
    Series out(values.size());
    if (double(values.size()) < window) return out;
    const double alpha = 2.0 / (window + 1.0);
    double acc = 0.0;
    for (double i = 0; i < window; ++i) acc += values[size_t(i)];
    double e = acc / window;
    const double w = std::ceil(window);  // 第一个不小于 window 的下标(window 是整数时就是它)
    if (window - 1 >= 0 && window == std::floor(window)) out[size_t(window - 1)] = e;
    for (double i = w; i < double(values.size()); ++i) {
        e = values[size_t(i)] * alpha + e * (1.0 - alpha);
        out[size_t(i)] = e;
    }
    return out;
}

Series sma(const std::vector<double>& values, double window) {
    Series out;
    out.reserve(values.size());
    double acc = 0.0;
    for (size_t i = 0; i < values.size(); ++i) {
        const double di = double(i);
        acc += values[i];
        if (di >= window) acc -= at(values, di - window);
        out.push_back(di >= window - 1 ? std::optional(acc / window) : std::nullopt);
    }
    return out;
}

namespace {
double rsiValue(double avgGain, double avgLoss) {
    if (avgLoss == 0) return 100.0;
    return 100.0 - 100.0 / (1.0 + avgGain / avgLoss);
}
}  // namespace

/// Wilder 平滑 RSI。前 period 根无值(period 是 1 起的整数)
Series rsi(const std::vector<double>& closes, double period) {
    Series out(closes.size());
    if (double(closes.size()) <= period) return out;
    const size_t p = size_t(period);
    double gains = 0.0, losses = 0.0;
    for (size_t i = 1; i <= p; ++i) {
        const double change = closes[i] - closes[i - 1];
        gains += jm::max(change, 0.0);
        losses += jm::max(-change, 0.0);
    }
    double avgGain = gains / period, avgLoss = losses / period;
    out[p] = rsiValue(avgGain, avgLoss);
    for (size_t i = p + 1; i < closes.size(); ++i) {
        const double change = closes[i] - closes[i - 1];
        avgGain = (avgGain * (period - 1) + jm::max(change, 0.0)) / period;
        avgLoss = (avgLoss * (period - 1) + jm::max(-change, 0.0)) / period;
        out[i] = rsiValue(avgGain, avgLoss);
    }
    return out;
}

// ---------------------------------------------------------------- 期权定价
double strikeStep(double price) {
    if (price <= 25) return 2.5;
    if (price <= 200) return 5;
    return 10;
}

namespace {
struct Leg {
    double ratio;
    QString right;
    double strike;
};
using Legs = std::vector<Leg>;

/// 腿的行权价贴到挂牌间隔上;宽度不足一档按一档。搭不出来(有腿的行权价 ≤ 0)回空
std::optional<Legs> optionLegs(const QString& instType, double s0, double offsetPct, double widthPct, double step) {
    const auto snap = [&](double x) { return util::jsRound(x / step) * step; };
    const double k = snap(s0 * (1.0 + offsetPct / 100.0));
    const double w = jm::max(snap((s0 * widthPct) / 100.0), step);
    Legs legs;
    if (instType == u"call") legs = {{1, u"C"_s, k}};
    else if (instType == u"put") legs = {{1, u"P"_s, k}};
    else if (instType == u"call_spread") legs = {{1, u"C"_s, k}, {-1, u"C"_s, k + w}};
    else if (instType == u"put_spread") legs = {{1, u"P"_s, k}, {-1, u"P"_s, k - w}};
    else legs = {{1, u"C"_s, k - w}, {-2, u"C"_s, k}, {1, u"C"_s, k + w}};  // butterfly
    for (const Leg& l : legs)
        if (!(l.strike > 0)) return std::nullopt;
    return legs;
}

struct Expiry {
    std::optional<qsizetype> idx;
    double beyond = 0;
};

Expiry listedExpiry(const std::vector<double>& dates, qsizetype i, double dte) {
    const double target = dates[size_t(i)] + dte;
    const qsizetype last = qsizetype(dates.size()) - 1;
    qsizetype k = i;
    while (k < last && dates[size_t(k + 1)] <= target) k += 1;
    if (k < last || dates[size_t(k)] == target) return {k, 0};
    const double span = dates[size_t(last)] - dates[0];
    return {std::nullopt, span > 0 ? ((target - dates[size_t(last)]) * double(last)) / span : 0};
}

double structureValue(const Legs& legs, double s, double t, double sigma) {
    double total = 0.0;
    for (const Leg& l : legs) total += l.ratio * bsPrice(s, l.strike, t, sigma, l.right);
    return total;
}
}  // namespace

/// Black-Scholes(r=0,无股息)。t<=0 或 sigma<=0 时退化为内在价值
double bsPrice(double s, double k, double t, double sigma, const QString& right) {
    if (t <= 0 || sigma <= 0) return right == u"C" ? jm::max(s - k, 0.0) : jm::max(k - s, 0.0);
    const double d1 = (jm::log(s / k) + 0.5 * sigma * sigma * t) / (sigma * std::sqrt(t));
    const double d2 = d1 - sigma * std::sqrt(t);
    const auto cdf = [](double x) { return 0.5 * (1.0 + erf(x / M_SQRT2)); };
    if (right == u"C") return s * cdf(d1) - k * cdf(d2);
    return k * cdf(-d2) - s * cdf(-d1);
}

Series trailingVol(const std::vector<double>& closes, int window) {
    Series out;
    for (qsizetype i = 0; i < qsizetype(closes.size()); ++i) {
        std::vector<double> rets;
        for (qsizetype k = i - window + 1; k >= 1 && k <= i; ++k) {
            const double a = closes[size_t(k - 1)], b = closes[size_t(k)];
            if (a > 0 && b > 0) rets.push_back(jm::log(b / a));
        }
        if (qsizetype(rets.size()) < window) {
            out.emplace_back(std::nullopt);
            continue;
        }
        double sum = 0;
        for (double r : rets) sum += r;
        const double mean = sum / double(rets.size());
        double variance = 0.0;
        for (double r : rets) variance += jm::pow(r - mean, 2);
        out.emplace_back(std::sqrt((variance / double(rets.size() - 1)) * kTradingDays));
    }
    return out;
}

Series trailingSessionShare(const Bars& bars, int window) {
    Series out;
    for (qsizetype i = 0; i < qsizetype(bars.size()); ++i) {
        double session = 0.0, whole = 0.0;
        int count = 0;
        for (qsizetype k = i - window + 1; k >= 1 && k <= i; ++k) {
            const double prev = bars[size_t(k - 1)].close;
            const double open = bars[size_t(k)].open, close = bars[size_t(k)].close;
            if (!(prev > 0 && open > 0 && close > 0)) break;
            session += jm::pow(jm::log(close / open), 2);
            whole += jm::pow(jm::log(close / prev), 2);
            count += 1;
        }
        out.emplace_back(count < window ? std::nullopt : std::optional(whole > 0 ? session / whole : 0.0));
    }
    return out;
}

double realizedVol(const std::vector<double>& closes, int window) {
    // closes.slice(-(window + 1))
    const qsizetype len = qsizetype(closes.size()), take = window + 1;
    const qsizetype from = take > 0 ? std::max<qsizetype>(len - take, 0) : std::min<qsizetype>(-take, len);
    const std::vector<double> tail(closes.begin() + from, closes.end());
    if (tail.size() < 6) return 0.25;
    std::vector<double> rets;
    for (size_t i = 1; i < tail.size(); ++i)
        if (tail[i - 1] > 0) rets.push_back(jm::log(tail[i] / tail[i - 1]));
    double sum = 0;
    for (double r : rets) sum += r;
    const double mean = sum / double(rets.size());
    double variance = 0.0;
    for (double r : rets) variance += jm::pow(r - mean, 2);
    variance /= jm::max(double(rets.size()) - 1, 1);
    return jm::min(jm::max(std::sqrt(variance * 252.0), 0.05), 2.0);
}

double erf(double x) { return jm::stdlibErf(x); }

// ---------------------------------------------------------------- 结算
namespace {
struct Span {
    const Bars& bars;
    const std::vector<double>& held;
    qsizetype lo, hi;
    double cost;
    bool heldAt(qsizetype i) const { return i >= 0 && i < qsizetype(held.size()) && held[size_t(i)] == 1; }
};

struct Settled {
    std::vector<double> equity, bench;
    std::vector<bool> exposed;
    QList<OJson> trades;
    std::vector<double> tradeReturns;
    double heldBars = 0;
    QStringList notes;
};

double benchFactor(const Bars& bars, qsizetype i) {
    const Bar& bar = bars[size_t(i)];
    const double overnight = i >= 2 ? bar.open / bars[size_t(i - 1)].close : 1.0;
    return overnight * (bar.close / bar.open);
}

Settled settleStock(const Span& w) {
    const Bars& bars = w.bars;
    const double cost = w.cost;
    const bool carried = w.heldAt(w.lo);
    Settled out;
    // 起点那一刻已经持有 = 按它的收盘价买进,付一次
    out.equity = {carried && cost > 0 ? 1.0 - cost : 1.0};
    out.bench = {1.0};
    out.exposed = {false};
    out.heldBars = carried ? 1 : 0;
    const auto book = [&](qsizetype entryIdx, double entryPx, qsizetype exitIdx, double exitPx, bool closed) {
        // 扣成本的口径和净值一致:买进付一次,平掉再付一次;还开着的那笔只扣进场那一次
        const double net = (exitPx / entryPx) * (1.0 - cost) * (closed ? 1.0 - cost : 1.0);
        out.trades.append(js::object({
            {u"entry_date"_s, js::S(bars[size_t(entryIdx)].date)},
            {u"exit_date"_s, closed ? js::S(bars[size_t(exitIdx)].date) : js::Null()},
            {u"entry_price"_s, js::N(entryPx)},
            {u"exit_price"_s, js::N(exitPx)},
            {u"return_pct"_s, js::N(util::pyRound((net - 1.0) * 100, 2))},
            {u"closed"_s, js::B(closed)},
        }));
        out.tradeReturns.push_back(net - 1.0);
    };
    struct Entry {
        qsizetype i;
        double px;
    };
    std::optional<Entry> entry;
    if (carried) entry = Entry{w.lo, bars[size_t(w.lo)].close};
    for (qsizetype i = w.lo + 1; i < w.hi; ++i) {
        const Bar& bar = bars[size_t(i)];
        const bool was = w.heldAt(i - 1), now = w.heldAt(i);
        double f = 1.0;
        if (was) f *= bar.open / bars[size_t(i - 1)].close;  // 隔夜
        if (now) f *= bar.close / bar.open;                 // 开盘之后
        if (was != now) {
            // 开盘换仓:买进或卖出,付一次
            if (cost > 0) f *= 1.0 - cost;
            if (now) {
                entry = Entry{i, bar.open};
            } else if (entry) {
                book(entry->i, entry->px, i, bar.open, true);
                entry.reset();
            }
        }
        out.equity.push_back(out.equity.back() * f);
        out.bench.push_back(out.bench.back() * benchFactor(bars, i));
        out.exposed.push_back(was || now);
        if (now) out.heldBars += 1;
    }
    if (entry) book(entry->i, entry->px, w.hi - 1, bars[size_t(w.hi - 1)].close, false);
    return out;
}

struct OptionSpec {
    QString type;
    double dte, offsetPct, widthPct, risk;
};

OptionSpec optionSpec(const OJson& inst) {
    const OJson* type = inst.get(u"type"_s);
    // inst["type"] in OPTION_TYPES:键先转成串
    const QString key = js::str(type);
    if (!hasIn(optionTypes(), key)) throw BacktestError(u"未知交易品种:"_s + key);
    // 用 is-null 判缺省:0 是非法值,不能被 `?? 默认值` 之外的写法吞掉
    const auto pick = [&](const QString& k, double dflt) {
        const OJson* v = inst.get(k);
        return !js::nullish(v) ? js::num(v) : dflt;
    };
    const double dte = std::trunc(pick(u"dte"_s, 30));
    const double offsetPct = pick(u"offset_pct"_s, 0.0);
    const double widthPct = pick(u"width_pct"_s, 2.0);
    const double risk = pick(u"risk_pct"_s, 10.0) / 100.0;
    if (!(dte >= 1 && dte <= 365)) throw BacktestError(u"到期天数 dte 必须在 1~365"_s);
    if (!(risk > 0 && risk <= 1)) throw BacktestError(u"单笔投入占比必须在 0~100%"_s);
    if (!(widthPct > 0 && widthPct <= 20) || std::abs(offsetPct) > 30) throw BacktestError(u"行权价偏移/宽度超出合理范围"_s);
    return {key, dte, offsetPct, widthPct, risk};
}

struct Holding {
    qsizetype entry_i;
    Legs legs;
    double cost;
    Expiry expiry;
    double sigma, share;
};

OJson optionTrade(const Bars& bars, const Holding& h, const std::optional<QString>& exitDate, double exitPx, double ret, const QString& why) {
    OJson strikes = js::array();
    for (const Leg& l : h.legs) strikes.items.append(js::N(l.strike));
    return js::object({
        {u"entry_date"_s, js::S(bars[size_t(h.entry_i)].date)},
        {u"exit_date"_s, exitDate ? js::S(*exitDate) : js::Null()},
        {u"entry_price"_s, js::N(util::pyRound(h.cost, 4))},
        {u"exit_price"_s, js::N(util::pyRound(exitPx, 4))},
        {u"return_pct"_s, js::N(util::pyRound(ret * 100, 2))},
        {u"closed"_s, js::B(exitDate.has_value())},
        {u"exit_reason"_s, js::S(why)},
        {u"strikes"_s, strikes},
    });
}

struct Missed {
    double vol = 0, build = 0, tick = 0;
};

QStringList optionNotes(const std::vector<double>& steps, const Missed& missed) {
    QStringList notes{
        u"期权价是 Black-Scholes 理论价,波动率用近 %1 日已实现波动率、每天按当天的重估。"_s.arg(kVolWindow) +
            u"市场上的隐含波动率通常高于已实现(方差风险溢价),所以单腿买方在这里被算便宜了,收益偏乐观;价差与蝴蝶往哪边偏不一定"_s,
        u"时间按交易日计(还剩几根日线 ÷ %1,和波动率同一个口径),开盘成交那天只算开盘到收盘那一段,占比按近 %2 根日线估。"_s.arg(n2s(kTradingDays)).arg(kVolWindow) +
            u"每个交易日当作波动一样大、周末与假日不计:财报、数据公布这类事件日前后,和跨长假的期权,实际比这里贵"_s,
        u"波动率和这个占比都只用 %1 根日线估,有抽样误差:在波动恒定的模拟行情上量过,平值单腿因此被算便宜约 1%,窄的平值蝴蝶被算贵约 3%~5%"_s.arg(kVolWindow),
        u"没进模型的:利率(r=0,看涨偏便宜、看跌偏贵)、股息、偏斜、期权自己的买卖价差(只能靠每边成本补)"_s,
    };
    if (!steps.empty()) {
        QStringList parts;
        for (double s : steps) parts << n2s(s);
        notes << u"行权价贴到标准挂牌间隔(这次用到 %1 一档),宽度不足一档按一档;实际挂牌可能更密"_s.arg(parts.join(u" / "_s));
    }
    if (missed.vol > 0) notes << u"有 %1 根日线策略要持仓却没开成:前面的历史不满 %2 根,算不出波动率,不估价"_s.arg(n2s(missed.vol)).arg(kVolWindow);
    if (missed.tick > 0)
        notes << u"有 %1 根日线策略要持仓却没开成:理论价不到 %2 美元(期权的最小报价单位),这个价买不到"_s.arg(n2s(missed.tick), n2s(kMinOptionTick));
    if (missed.build > 0) notes << u"有 %1 根日线策略要持仓却没开成:贴档之后搭不出这个结构"_s.arg(n2s(missed.build));
    return notes;
}

Settled settleOptions(const Span& w, const OJson& inst, const Series* volIn, const Series* shareIn) {
    const OptionSpec spec = optionSpec(inst);
    const Bars& bars = w.bars;
    const double cost = w.cost;
    const qsizetype n = qsizetype(bars.size());
    std::vector<double> dates;
    for (const Bar& b : bars) dates.push_back(util::dateOrdinal(b.date));
    const Series vol = volIn ? *volIn : trailingVol(closesOf(bars));
    const Series share = shareIn ? *shareIn : trailingSessionShare(bars);
    if (std::none_of(vol.begin(), vol.end(), [](const auto& v) { return v.has_value(); })) {
        throw BacktestError(u"期权估价要用近 %1 日已实现波动率,这里只有 %2 根日线,一个值都算不出来"_s.arg(kVolWindow).arg(n) +
                            u"(至少 %1 根)。把开始日期往前挪"_s.arg(kVolWindow + 1));
    }
    // 成交成本:开仓多付、平仓少收各 cost(按权利金算)
    const auto paid = [&](double c) { return c * (1.0 + cost); };
    const auto got = [&](double v) { return v * (1.0 - cost); };
    /// 第 i 根收盘时离到期还有几个交易日
    const auto barsLeft = [&](const Expiry& e, qsizetype i) { return double(e.idx.value_or(n - 1) - i) + e.beyond; };
    Settled out;
    Missed missed;
    std::vector<double> steps;  // Set:插入序
    double cash = 1.0;

    /// atOpen:开盘成交,比当天收盘多"开盘到收盘"那一段;否则是起点那一根的收盘
    const auto tryOpen = [&](qsizetype i, double s0, std::optional<double> sigma, std::optional<double> session, bool atOpen) -> std::optional<Holding> {
        if (!sigma || !session) {
            missed.vol += 1;
            return std::nullopt;
        }
        const double step = strikeStep(s0);
        const auto legs = optionLegs(spec.type, s0, spec.offsetPct, spec.widthPct, step);
        if (!legs) {
            missed.build += 1;
            return std::nullopt;
        }
        const Expiry expiry = listedExpiry(dates, i, spec.dte);
        const double price = structureValue(*legs, s0, (barsLeft(expiry, i) + (atOpen ? *session : 0.0)) / kTradingDays, *sigma);
        if (!(price >= kMinOptionTick)) {
            missed.tick += 1;
            return std::nullopt;
        }
        if (std::find(steps.begin(), steps.end(), step) == steps.end()) steps.push_back(step);
        return Holding{i, *legs, price, expiry, *sigma, *session};
    };
    const auto settle = [&](const Holding& h, qsizetype i, double proceeds, const QString& why) {
        const double ret = got(proceeds) / paid(h.cost) - 1.0;
        cash *= 1.0 + spec.risk * ret;
        out.trades.append(optionTrade(bars, h, bars[size_t(i)].date, proceeds, ret, why));
        out.tradeReturns.push_back(ret);
    };
    /// 第 i 根收盘时这笔持仓的理论价(当天的波动率)
    const auto markAtClose = [&](const Holding& h, qsizetype i) {
        return structureValue(h.legs, bars[size_t(i)].close, barsLeft(h.expiry, i) / kTradingDays, at(vol, double(i)).value_or(h.sigma));
    };

    std::optional<Holding> pos;
    for (qsizetype i = w.lo; i < w.hi; ++i) {
        const Bar& bar = bars[size_t(i)];
        const bool want = w.heldAt(i);
        const bool carriedIn = pos.has_value();
        if (i == w.lo) {
            // 起点没有"开盘"这一步:那一刻已经持有的,按起点的收盘价建仓
            if (want) pos = tryOpen(i, bar.close, at(vol, double(i)), at(share, double(i)), false);
        } else if (pos && !want) {
            const double t = (barsLeft(pos->expiry, i) + at(share, double(i - 1)).value_or(pos->share)) / kTradingDays;
            settle(*pos, i, structureValue(pos->legs, bar.open, t, at(vol, double(i - 1)).value_or(pos->sigma)), u"signal"_s);
            pos.reset();
        } else if (!pos && want) {
            pos = tryOpen(i, bar.open, at(vol, double(i - 1)), at(share, double(i - 1)), true);
        }
        const bool heldToday = carriedIn || pos.has_value();
        if (pos && pos->expiry.idx && i >= *pos->expiry.idx) {
            settle(*pos, i, structureValue(pos->legs, bar.close, 0.0, 0.0), u"expiry"_s);
            pos.reset();
        }
        if (pos) {
            out.heldBars += 1;
            out.equity.push_back(cash * (1.0 + spec.risk * (got(markAtClose(*pos, i)) / paid(pos->cost) - 1.0)));
        } else {
            out.equity.push_back(cash);
        }
        out.bench.push_back(i == w.lo ? 1.0 : out.bench.back() * benchFactor(bars, i));
        out.exposed.push_back(i > w.lo && heldToday);
    }

    if (pos) {
        const double value = markAtClose(*pos, w.hi - 1);
        out.trades.append(optionTrade(bars, *pos, std::nullopt, value, got(value) / paid(pos->cost) - 1.0, u"open"_s));
        out.tradeReturns.push_back(got(value) / paid(pos->cost) - 1.0);
    }
    std::vector<double> sorted = steps;
    std::stable_sort(sorted.begin(), sorted.end());
    out.notes = optionNotes(sorted, missed);
    return out;
}

// ---------------------------------------------------------------- 统计
/// 逐日净值 → 年化波动、Sharpe、Sortino(无风险利率与目标收益都按 0),以及在场的天数与那些天单日变动的均方根
void dailyStats(OJson& report, const std::vector<double>& equity, const std::vector<bool>& exposed) {
    std::vector<double> rets;
    double heldSq = 0.0, heldN = 0;
    for (size_t j = 1; j < equity.size(); ++j) {
        const double prev = equity[j - 1];
        const double r = prev > 0 ? equity[j] / prev - 1.0 : 0.0;
        rets.push_back(r);
        if (j < exposed.size() && exposed[j]) {
            heldSq += r * r;
            heldN += 1;
        }
    }
    const OJson heldMove = heldN > 0 ? js::N(util::pyRound(std::sqrt(heldSq / heldN) * 100, 4)) : js::Null();
    const double n = double(rets.size());
    if (n < 2) {
        report.set(u"volatility_pct"_s, js::Null());
        report.set(u"sharpe"_s, js::Null());
        report.set(u"sortino"_s, js::Null());
        report.set(u"held_days"_s, js::N(heldN));
        report.set(u"held_day_move_pct"_s, heldMove);
        return;
    }
    double sum = 0;
    for (double r : rets) sum += r;
    const double mean = sum / n;
    double variance = 0.0, downside = 0.0;
    for (double r : rets) {
        variance += jm::pow(r - mean, 2);
        if (r < 0) downside += r * r;
    }
    const double sd = std::sqrt(variance / (n - 1));
    const double down = std::sqrt(downside / n);
    const double ann = std::sqrt(kTradingDays);
    report.set(u"volatility_pct"_s, js::N(util::pyRound(sd * ann * 100, 2)));
    report.set(u"sharpe"_s, sd > 0 ? js::N(util::pyRound((mean / sd) * ann, 2)) : js::Null());
    report.set(u"sortino"_s, down > 0 ? js::N(util::pyRound((mean / down) * ann, 2)) : js::Null());
    report.set(u"held_days"_s, js::N(heldN));
    report.set(u"held_day_move_pct"_s, heldMove);
}

/// 只数已平仓的:还开着的那一笔没有结果,算进胜率等于拿浮盈充数
void tradeStats(OJson& report, const QList<OJson>& trades, const std::vector<double>& returns) {
    std::vector<double> closed, wins, losses;
    for (size_t i = 0; i < returns.size(); ++i) {
        const OJson* c = qsizetype(i) < trades.size() ? trades[qsizetype(i)].get(u"closed"_s) : nullptr;
        if (c && c->type == OJson::Bool && c->b) closed.push_back(returns[i]);
    }
    for (double r : closed) {
        if (r > 0) wins.push_back(r);
        if (r < 0) losses.push_back(r);
    }
    const auto sum = [](const std::vector<double>& xs) {
        double a = 0;
        for (double x : xs) a += x;
        return a;
    };
    const std::optional<double> avgWin = wins.empty() ? std::nullopt : std::optional(sum(wins) / double(wins.size()));
    const std::optional<double> avgLoss = losses.empty() ? std::nullopt : std::optional(sum(losses) / double(losses.size()));
    const double nc = double(closed.size());
    report.set(u"closed_trades"_s, js::N(nc));
    report.set(u"win_rate_pct"_s, nc ? js::N(util::pyRound((double(wins.size()) / nc) * 100, 1)) : js::Null());
    report.set(u"avg_win_pct"_s, avgWin ? js::N(util::pyRound(*avgWin * 100, 2)) : js::Null());
    report.set(u"avg_loss_pct"_s, avgLoss ? js::N(util::pyRound(*avgLoss * 100, 2)) : js::Null());
    report.set(u"payoff_ratio"_s, avgWin && avgLoss ? js::N(util::pyRound(*avgWin / -*avgLoss, 2)) : js::Null());
    report.set(u"profit_factor"_s, !losses.empty() ? js::N(util::pyRound(sum(wins) / -sum(losses), 2)) : js::Null());
    report.set(u"expectancy_pct"_s, nc ? js::N(util::pyRound((sum(closed) / nc) * 100, 2)) : js::Null());
}

double maxDrawdown(const std::vector<double>& equity) {
    double peak = equity[0], worst = 0.0;
    for (double value : equity) {
        peak = jm::max(peak, value);
        worst = jm::min(worst, value / peak - 1.0);
    }
    return worst;
}

OJson sampleCurve(const Bars& bars, qsizetype lo, qsizetype hi, const std::vector<double>& equity, const std::vector<double>& bench, double maxPoints = 300) {
    const qsizetype n = hi - lo;
    const qsizetype step = qsizetype(jm::max(1, std::ceil(double(n) / maxPoints)));
    std::vector<qsizetype> idx;
    for (qsizetype i = 0; i < n; i += step) idx.push_back(i);
    if (idx.back() != n - 1) idx.push_back(n - 1);
    OJson out = js::array();
    for (qsizetype i : idx) {
        out.items.append(js::object({
            {u"date"_s, js::S(bars[size_t(lo + i)].date)},
            {u"equity"_s, js::N(util::pyRound(equity[size_t(i)], 4))},
            {u"bench"_s, js::N(util::pyRound(bench[size_t(i)], 4))},
        }));
    }
    return out;
}

OJson summarize(const Span& w, const QString& strategy, const OJson& params, const Settled& s) {
    const Bars& bars = w.bars;
    const qsizetype n = w.hi - w.lo;
    const double final_ = s.equity[size_t(n - 1)];
    const double days = jm::max(util::dateOrdinal(bars[size_t(w.hi - 1)].date) - util::dateOrdinal(bars[size_t(w.lo)].date), 1);
    const double total = util::pyRound((final_ - 1.0) * 100, 2);
    const double benchTotal = util::pyRound((s.bench[size_t(n - 1)] - 1.0) * 100, 2);
    OJson r = js::object({
        {u"strategy"_s, js::S(strategy)},
        {u"params"_s, params},
        {u"bars"_s, js::N(double(n))},
        {u"start"_s, js::S(bars[size_t(w.lo)].date)},
        {u"end"_s, js::S(bars[size_t(w.hi - 1)].date)},
        {u"days"_s, js::N(days)},
        {u"total_return_pct"_s, js::N(total)},
        {u"buy_hold_return_pct"_s, js::N(benchTotal)},
        {u"excess_return_pct"_s, js::N(util::pyRound(total - benchTotal, 2))},
        {u"annualized_pct"_s, js::N(final_ > 0 ? util::pyRound((jm::pow(final_, 365.0 / days) - 1.0) * 100, 2) : -100.0)},
        {u"max_drawdown_pct"_s, js::N(util::pyRound(maxDrawdown(s.equity) * 100, 2))},
    });
    dailyStats(r, s.equity, s.exposed);
    r.set(u"trades"_s, js::N(double(s.trades.size())));
    tradeStats(r, s.trades, s.tradeReturns);
    r.set(u"exposure_pct"_s, js::N(util::pyRound((s.heldBars / double(n)) * 100, 1)));
    r.set(u"trade_list"_s, js::array(s.trades.mid(std::max<qsizetype>(0, s.trades.size() - 100))));
    r.set(u"curve"_s, sampleCurve(bars, w.lo, w.hi, s.equity, s.bench));
    r.set(u"notes"_s, js::strings(s.notes));
    return r;
}

/// 整段回测要说在前面的口径与偏差(界面原样摆)。品种自己的那几条(期权)夹在中间
QStringList runNotes(const Bars& bars, const std::vector<double>& signal, const OJson& r, double costPct) {
    QStringList notes;
    const qsizetype n = qsizetype(bars.size());
    const double last = at(signal, double(n - 1)), prev = at(signal, double(n - 2));
    const double lastV = std::isnan(last) ? 0 : last, prevV = std::isnan(prev) ? 0 : prev;  // ?? 0
    if (lastV != prevV) {
        notes << u"%1 收盘出了%2信号,要到下一个交易日开盘才成交,不在这次的结果里"_s.arg(bars[size_t(n - 1)].date, lastV == 1 ? u"买入"_s : u"卖出"_s);
    }
    if (costPct == 0) notes << u"没扣成交成本(佣金、买卖价差):换手越多,实际比这里差得越多"_s;
    const double days = r.get(u"days"_s)->n;
    if (days < 365) notes << u"区间只有 %1 天,不满一年:年化收益、年化波动、Sharpe、Sortino 都是把这一段外推到一年,只作参考"_s.arg(n2s(days));
    if (const OJson* own = r.get(u"notes"_s))
        for (const OJson& x : own->items) notes << x.s;
    notes << u"标的是现在挑的:它活到了今天,退市、被并购、跌没了的不会被拿来回测,结果偏乐观(幸存者偏差)"_s;
    return notes;
}
}  // namespace

OJson evaluateSegment(const SegmentInput& seg) {
    const Bars& bars = *seg.bars;
    const double costPct = seg.costPct.value_or(0);
    if (!(costPct >= 0 && costPct <= kMaxCostPct)) throw BacktestError(u"每边成交成本要在 0~%1% 之间"_s.arg(n2s(kMaxCostPct)));
    const double lo = seg.lo.value_or(0), hi = seg.hi.value_or(double(bars.size()));
    if (!(lo >= 0 && hi <= double(bars.size()) && hi - lo >= 2)) {
        throw BacktestError(u"这一截只有 %1 根日线,没法结算"_s.arg(n2s(jm::max(hi - lo, 0))));
    }
    for (qsizetype i = qsizetype(lo); i < qsizetype(hi); ++i) {
        const Bar& bar = bars[size_t(i)];
        if (!(bar.open > 0) || !(bar.close > 0)) throw BacktestError(u"%1 这根日线没有有效的开盘价 / 收盘价,没法按开盘成交结算"_s.arg(bar.date));
    }
    const Span win{bars, *seg.held, qsizetype(lo), qsizetype(hi), costPct / 100};
    const OJson* type = seg.inst.get(u"type"_s);
    const Settled settled = type && type->type == OJson::String && type->s == u"stock" ? settleStock(win) : settleOptions(win, seg.inst, seg.vol, seg.sessionShare);
    OJson report = summarize(win, seg.strategy, seg.params, settled);
    if (costPct > 0) report.set(u"cost_pct"_s, js::N(costPct));
    return report;
}

OJson runBacktest(const Bars& bars, const QString& strategy, const OJson* params, const OJson* rules, const OJson* instrument, double costPct) {
    const Signal sig = signalPositions(bars, strategy, params, rules);
    OJson inst = spread(js::nullish(instrument) ? nullptr : instrument);
    if (js::nullish(inst.get(u"type"_s))) inst.set(u"type"_s, js::S(u"stock"_s));
    const std::vector<double> held = heldAfterOpen(sig.positions);
    SegmentInput seg;
    seg.bars = &bars;
    seg.held = &held;
    seg.strategy = strategy;
    seg.params = sig.usedParams;
    seg.inst = inst;
    seg.costPct = costPct;
    OJson result = evaluateSegment(seg);
    if (js::truthy(rules)) result.set(u"rules"_s, *rules);
    result.set(u"instrument"_s, inst);
    result.set(u"notes"_s, js::strings(runNotes(bars, sig.positions, result, costPct)));
    return result;
}

}  // namespace ibkr::analysis::backtest
