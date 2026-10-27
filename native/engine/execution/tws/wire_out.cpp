#include "execution/tws/wire_out.h"

#include "util/jsformat.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"

#include <QtEndian>

#include <cmath>
#include <functional>
#include <limits>

using namespace Qt::StringLiterals;

namespace ibkr::tws::wire {

namespace js = util::js;

namespace {

using V = const OJson*;

/// 用到的 MIN_SERVER_VERSION(api/data/enum/min-server-version.js);≤ 100 的只留分支里还写着的那几个
namespace mv {
constexpr int kSyntRealtimeBars = 124;
constexpr int kFractionalPositions = 101;
constexpr int kSecDefOptParamsReq = 104;
constexpr int kPnl = 127;
constexpr int kPeggedToBenchmark = 102;
constexpr int kModelsSupport = 103;
constexpr int kExtOperator = 105;
constexpr int kSoftDollarTier = 106;
constexpr int kCashQty = 111;
constexpr int kReqSmartComponents = 114;
constexpr int kTickByTick = 137;
constexpr int kDecisionMaker = 138;
constexpr int kTickByTickIgnoreSize = 140;
constexpr int kMifidExecution = 139;
constexpr int kAutoPriceForHedge = 141;
constexpr int kOrderContainer = 145;
constexpr int kSmartDepth = 146;
constexpr int kDPegOrders = 148;
constexpr int kMktDepthPrimExchange = 149;
constexpr int kPriceMgmtAlgo = 151;
constexpr int kDuration = 158;
constexpr int kPostToAts = 160;
constexpr int kAutoCancelParent = 162;
constexpr int kHistoricalSchedule = 165;
constexpr int kAdvancedOrderReject = 166;
constexpr int kManualOrderTime = 169;
constexpr int kPegbestPegmidOffsets = 170;
constexpr int kBondIssuerId = 176;
constexpr int kFaProfileDesupport = 177;
constexpr int kCustomerAccount = 183;
constexpr int kProfessionalCustomer = 184;
constexpr int kRfqFields = 187;
constexpr int kIncludeOvernight = 189;
constexpr int kUndoRfqFields = 190;
constexpr int kCmeTaggingFields = 192;
}  // namespace mv

constexpr int kUpdateTws = 503;
constexpr double kIntegerMax = 2147483647;
constexpr double kMaxDouble = std::numeric_limits<double>::max();

[[noreturn]] void typeError(const QString& message) { throw WireError(u"TypeError"_s, message); }

/// o.key(o 是 null / undefined 时抛 V8 的 TypeError 原话)
V get(V o, const QString& key) {
    if (js::nullish(o)) typeError(u"Cannot read properties of %1 (reading '%2')"_s.arg(o ? u"null"_s : u"undefined"_s, key));
    return js::prop(o, key);
}
/// o?.key
V opt(V o, const QString& key) { return js::nullish(o) ? nullptr : js::prop(o, key); }

/// v.length(数组的个数、字符串的码元数、对象上的 length 键;数与布尔上是 undefined)。v 不能是 null / undefined
std::optional<OJson> lengthOf(V v) {
    if (v->type == OJson::Array) return OJson::number(double(v->items.size()));
    if (v->type == OJson::String) return OJson::number(double(v->s.size()));
    if (v->type == OJson::Object) {
        if (const OJson* l = v->get(u"length"_s)) return *l;
    }
    return std::nullopt;
}
/// v?.length
std::optional<OJson> optLength(V v) { return js::nullish(v) ? std::nullopt : lengthOf(v); }
bool truthy(const std::optional<OJson>& v) { return v && js::truthy(&*v); }

/// v.forEach(f):不是数组就是 V8 的 "<表达式> is not a function"
void forEach(V v, const QString& expr, const std::function<void(V)>& f) {
    if (!js::isArr(v)) typeError(expr + u" is not a function"_s);
    for (const OJson& x : v->items) f(&x);
}

/// v == "字面量"(JS 的宽松相等:数与布尔转成数比,数组与对象先转成原始值)
bool looseEq(V v, const QString& lit) {
    if (js::nullish(v)) return false;
    switch (v->type) {
    case OJson::String: return v->s == lit;
    case OJson::Number: return v->n == util::jsStringToNumber(lit);
    case OJson::Bool: return (v->b ? 1.0 : 0.0) == util::jsStringToNumber(lit);
    case OJson::Array: return js::str(v) == lit;
    case OJson::Object: return lit == u"[object Object]"_s;
    case OJson::Null: return false;
    }
    return false;
}

/// SecType.BAG === contract.secType?.toUpperCase()
bool isBag(V contract) {
    V secType = get(contract, u"secType"_s);
    if (js::nullish(secType)) return false;
    if (!js::isStr(secType)) typeError(u"contract.secType?.toUpperCase is not a function"_s);
    return secType->s.toUpper() == u"BAG"_s;
}

bool isPegBenchOrder(V t) { return looseEq(t, u"PEG BENCH"_s) || looseEq(t, u"PEGBENCH"_s); }
bool isPegBestOrder(V t) { return looseEq(t, u"PEG BEST"_s) || looseEq(t, u"PEGBEST"_s); }
bool isPegMidOrder(V t) { return looseEq(t, u"PEG MID"_s) || looseEq(t, u"PEGMID"_s); }

/// nullifyMax:正好是 Number.MAX_VALUE 的数当 undefined
V nullifyMax(V v) { return js::isNum(v) && v->n == kMaxDouble ? nullptr : v; }

/// JS 的 x > 0(x 先转成数;undefined、对象是 NaN)
bool gtZero(const std::optional<OJson>& v) { return v && js::num(&*v) > 0; }

V ptr(const Arg& a) { return a ? &*a : nullptr; }

/// encodeTagValues:`${tv.tag}=${tv.value};` 连起来
OJson encodeTagValues(V tagValues) {
    QString result;
    if (!js::nullish(tagValues)) {
        forEach(tagValues, u"tagValues?.forEach"_s, [&](V tv) {
            const QString tag = js::str(get(tv, u"tag"_s));
            result += tag + u'=' + js::str(get(tv, u"value"_s)) + u';';
        });
    }
    return OJson::string(result);
}

/// 一条消息的字段表;sendMsg 时展平(同 socket.js 的 flattenDeep)
class Tokens {
public:
    explicit Tokens(int serverVersion) : sv(serverVersion) {}

    void push(V v) { items_.append(v ? *v : OJson::null()); }
    void push(const OJson& v) { items_.append(v); }
    void push(const std::optional<OJson>& v) { items_.append(v ? *v : OJson::null()); }
    void num(double n) { items_.append(OJson::number(n)); }
    void str(const QString& s) { items_.append(OJson::string(s)); }
    void boolean(bool b) { items_.append(OJson::boolean(b)); }

    Encoded send() const {
        OJson flat;
        flat.type = OJson::Array;
        flatten(items_, flat.items);
        return {flat, {}};
    }
    /// Encoder.emitError:话前面加 "Server Version N: ",reqId ?? -1(Controller 再补一个 undefined 的 advancedOrderReject)
    Encoded error(const QString& message, V reqId = nullptr) const {
        OJson args = js::array({OJson::string(u"Server Version %1: %2"_s.arg(sv).arg(message)), OJson::number(kUpdateTws),
                                js::nullish(reqId) ? OJson::number(-1) : *reqId, OJson::null()});
        return {std::nullopt, {Emit{u"error"_s, args}}};
    }

    const int sv;

private:
    static void flatten(const QList<OJson>& in, QList<OJson>& out) {
        for (const OJson& x : in) {
            if (x.type == OJson::Array) flatten(x.items, out);
            else out.append(x);
        }
    }
    QList<OJson> items_;
};

/// 合约那几格的读法各条请求不一样,只把最常见的一段(conId 起到 localSymbol)放在调用处逐条写,不另抽函数:次序就是 TypeError 的次序
void pushLegsShort(Tokens& t, V contract) {
    // BAG 的组合腿(行情、K 线那几条只发四格)
    V legs = get(contract, u"comboLegs"_s);
    if (!js::truthy(legs)) {
        t.num(0);
    } else {
        t.push(lengthOf(legs));
        forEach(legs, u"contract.comboLegs.forEach"_s, [&](V leg) {
            t.push(get(leg, u"conId"_s));
            t.push(get(leg, u"ratio"_s));
            t.push(get(leg, u"action"_s));
            t.push(get(leg, u"exchange"_s));
        });
    }
}

}  // namespace

QStringList fieldsOf(const OJson& tokens) {
    QStringList out;
    const std::function<void(const OJson&)> walk = [&](const OJson& v) {
        if (v.type == OJson::Array) {
            for (const OJson& x : v.items) walk(x);
        } else if (v.type == OJson::Bool) {
            out << (v.b ? u"1"_s : u"0"_s);
        } else if (v.type == OJson::Null) {
            out << QString();
        } else {
            out << js::str(&v);
        }
    };
    walk(tokens);
    return out;
}

QByteArray bytesOf(const OJson& tokens) {
    const QStringList fields = fieldsOf(tokens);
    const QByteArray data = util::toNodeUtf8(fields.join(QChar(u'\0')));
    // 首格(展平之后)是串时是 V100 以前的样子,不加长度
    const OJson* first = &tokens;
    while (first && first->type == OJson::Array) first = first->items.isEmpty() ? nullptr : &first->items.first();
    if (first && first->type == OJson::String) return data;
    QByteArray size(4, '\0');
    qToBigEndian(quint32(data.size() + 1), size.data());
    return size + data + '\0';
}

Encoded reqContractDetails(int serverVersion, const Arg& reqIdArg, const Arg& contractArg) {
    Tokens t(serverVersion);
    V reqId = ptr(reqIdArg), c = ptr(contractArg);
    if (t.sv < mv::kBondIssuerId && js::truthy(get(c, u"issuerId"_s)))
        return t.error(u"It does not support issuerId parameter in reqContractDetails."_s, reqId);
    t.num(9);  // REQ_CONTRACT_DATA
    t.num(8);
    t.push(reqId);
    t.push(get(c, u"conId"_s));
    t.push(get(c, u"symbol"_s));
    t.push(get(c, u"secType"_s));
    t.push(get(c, u"lastTradeDateOrContractMonth"_s));
    t.push(get(c, u"strike"_s));
    t.push(get(c, u"right"_s));
    t.push(get(c, u"multiplier"_s));
    t.push(get(c, u"exchange"_s));
    t.push(get(c, u"primaryExch"_s));
    t.push(get(c, u"currency"_s));
    t.push(get(c, u"localSymbol"_s));
    t.push(get(c, u"tradingClass"_s));
    t.push(get(c, u"includeExpired"_s));
    t.push(get(c, u"secIdType"_s));
    t.push(get(c, u"secId"_s));
    if (t.sv >= mv::kBondIssuerId) t.push(get(c, u"issuerId"_s));
    return t.send();
}

Encoded reqMktData(int serverVersion, const Arg& reqIdArg, const Arg& contractArg, const Arg& genericTickList, const Arg& snapshot,
                   const Arg& regulatorySnapshot) {
    Tokens t(serverVersion);
    V reqId = ptr(reqIdArg), c = ptr(contractArg);
    t.num(1);  // REQ_MKT_DATA
    t.num(11);
    t.push(reqId);
    t.push(get(c, u"conId"_s));
    t.push(get(c, u"symbol"_s));
    t.push(get(c, u"secType"_s));
    t.push(get(c, u"lastTradeDateOrContractMonth"_s));
    t.push(get(c, u"strike"_s));
    t.push(get(c, u"right"_s));
    t.push(get(c, u"multiplier"_s));
    t.push(get(c, u"exchange"_s));
    t.push(get(c, u"primaryExch"_s));
    t.push(get(c, u"currency"_s));
    t.push(get(c, u"localSymbol"_s));
    t.push(get(c, u"tradingClass"_s));
    if (isBag(c)) pushLegsShort(t, c);
    V dnc = get(c, u"deltaNeutralContract"_s);
    if (js::truthy(dnc)) {
        t.boolean(true);
        t.push(get(dnc, u"conId"_s));
        t.push(get(dnc, u"delta"_s));
        t.push(get(dnc, u"price"_s));
    } else {
        t.boolean(false);
    }
    t.push(genericTickList);
    t.push(snapshot);
    if (t.sv >= mv::kReqSmartComponents) t.push(regulatorySnapshot);
    t.str(QString());
    return t.send();
}

Encoded cancelMktData(int serverVersion, const Arg& reqId) {
    Tokens t(serverVersion);
    t.num(2);
    t.num(1);
    t.push(reqId);
    return t.send();
}

Encoded reqTickByTickData(int serverVersion, const Arg& reqIdArg, const Arg& contractArg, const Arg& tickType, const Arg& numberOfTicks, const Arg& ignoreSize) {
    Tokens t(serverVersion);
    V reqId = ptr(reqIdArg), c = ptr(contractArg);
    if (t.sv < mv::kTickByTick) return t.error(u"It does not support tick-by-tick requests."_s, reqId);
    t.num(97);  // REQ_TICK_BY_TICK_DATA,没有版本格
    t.push(reqId);
    t.push(get(c, u"conId"_s));
    t.push(get(c, u"symbol"_s));
    t.push(get(c, u"secType"_s));
    t.push(get(c, u"lastTradeDateOrContractMonth"_s));
    t.push(get(c, u"strike"_s));
    t.push(get(c, u"right"_s));
    t.push(get(c, u"multiplier"_s));
    t.push(get(c, u"exchange"_s));
    t.push(get(c, u"primaryExch"_s));
    t.push(get(c, u"currency"_s));
    t.push(get(c, u"localSymbol"_s));
    t.push(get(c, u"tradingClass"_s));
    t.push(tickType);
    if (t.sv >= mv::kTickByTickIgnoreSize) {
        t.push(numberOfTicks);
        t.push(ignoreSize);
    }
    return t.send();
}

Encoded cancelTickByTickData(int serverVersion, const Arg& reqId) {
    Tokens t(serverVersion);
    if (t.sv < mv::kTickByTick) return t.error(u"It does not support tick-by-tick requests."_s, ptr(reqId));
    t.num(98);
    t.push(reqId);
    return t.send();
}

Encoded reqMarketDataType(int serverVersion, const Arg& marketDataType) {
    Tokens t(serverVersion);
    t.num(59);
    t.num(1);
    t.push(marketDataType);
    return t.send();
}

Encoded reqHistoricalData(int serverVersion, const Arg& reqIdArg, const Arg& contractArg, const Arg& endDateTime, const Arg& durationStr,
                          const Arg& barSizeSetting, const Arg& whatToShow, const Arg& useRTH, const Arg& formatDate, const Arg& keepUpToDate,
                          const Arg& chartOptions) {
    Tokens t(serverVersion);
    V reqId = ptr(reqIdArg), c = ptr(contractArg);
    if (t.sv < mv::kHistoricalSchedule && whatToShow && whatToShow->type == OJson::String && whatToShow->s.toUpper() == u"SCHEDULE"_s)
        return t.error(u"It does not support requesting of historical schedule."_s, reqId);
    t.num(20);  // REQ_HISTORICAL_DATA
    if (t.sv < mv::kSyntRealtimeBars) t.num(6);
    t.push(reqId);
    t.push(get(c, u"conId"_s));
    t.push(get(c, u"symbol"_s));
    t.push(get(c, u"secType"_s));
    t.push(get(c, u"lastTradeDateOrContractMonth"_s));
    t.push(get(c, u"strike"_s));
    t.push(get(c, u"right"_s));
    t.push(get(c, u"multiplier"_s));
    t.push(get(c, u"exchange"_s));
    t.push(get(c, u"primaryExch"_s));
    t.push(get(c, u"currency"_s));
    t.push(get(c, u"localSymbol"_s));
    t.push(get(c, u"tradingClass"_s));
    t.boolean(js::truthy(get(c, u"includeExpired"_s)));
    t.push(endDateTime);
    t.push(barSizeSetting);
    t.push(durationStr);
    t.push(useRTH);
    t.push(whatToShow);
    t.push(formatDate);
    if (isBag(c)) pushLegsShort(t, c);
    if (t.sv >= mv::kSyntRealtimeBars) t.push(keepUpToDate);
    t.push(encodeTagValues(ptr(chartOptions)));
    return t.send();
}

Encoded cancelHistoricalData(int serverVersion, const Arg& reqId) {
    Tokens t(serverVersion);
    t.num(25);
    t.num(1);
    t.push(reqId);
    return t.send();
}

Encoded reqPositions(int serverVersion) {
    Tokens t(serverVersion);
    t.num(61);
    t.num(1);
    return t.send();
}

Encoded cancelPositions(int serverVersion) {
    Tokens t(serverVersion);
    t.num(64);
    t.num(1);
    return t.send();
}

Encoded reqAccountSummary(int serverVersion, const Arg& reqId, const Arg& group, const Arg& tags) {
    Tokens t(serverVersion);
    t.num(62);
    t.num(1);
    t.push(reqId);
    t.push(group);
    t.push(tags);
    return t.send();
}

Encoded cancelAccountSummary(int serverVersion, const Arg& reqId) {
    Tokens t(serverVersion);
    t.num(63);
    t.num(1);
    t.push(reqId);
    return t.send();
}

Encoded reqPnL(int serverVersion, const Arg& reqId, const Arg& account, const Arg& modelCode) {
    Tokens t(serverVersion);
    if (t.sv < mv::kPnl) return t.error(u"It does not support pnl requests."_s, ptr(reqId));
    t.num(92);
    t.push(reqId);
    t.push(account);
    t.push(modelCode);
    return t.send();
}

Encoded cancelPnL(int serverVersion, const Arg& reqId) {
    Tokens t(serverVersion);
    if (t.sv < mv::kPnl) return t.error(u"It does not support pnl requests."_s, ptr(reqId));
    t.num(93);
    t.push(reqId);
    return t.send();
}

Encoded reqMktDepth(int serverVersion, const Arg& reqIdArg, const Arg& contractArg, const Arg& numRows, const Arg& isSmartDepth,
                    const Arg& mktDepthOptions) {
    Tokens t(serverVersion);
    V reqId = ptr(reqIdArg), c = ptr(contractArg);
    if (t.sv < mv::kSmartDepth && js::truthy(ptr(isSmartDepth))) return t.error(u"It does not support SMART depth request."_s, reqId);
    if (t.sv < mv::kMktDepthPrimExchange && js::truthy(get(c, u"primaryExch"_s)))
        return t.error(u"It does not support primaryExch parameter in reqMktDepth."_s, reqId);
    t.num(10);  // REQ_MKT_DEPTH
    t.num(5);
    t.push(reqId);
    t.push(get(c, u"conId"_s));
    t.push(get(c, u"symbol"_s));
    t.push(get(c, u"secType"_s));
    t.push(get(c, u"lastTradeDateOrContractMonth"_s));
    t.push(get(c, u"strike"_s));
    t.push(get(c, u"right"_s));
    t.push(get(c, u"multiplier"_s));
    t.push(get(c, u"exchange"_s));
    if (t.sv >= mv::kMktDepthPrimExchange) t.push(get(c, u"primaryExch"_s));
    t.push(get(c, u"currency"_s));
    t.push(get(c, u"localSymbol"_s));
    t.push(get(c, u"tradingClass"_s));
    t.push(numRows);
    if (t.sv >= mv::kSmartDepth) t.push(isSmartDepth);
    t.push(encodeTagValues(ptr(mktDepthOptions)));
    return t.send();
}

Encoded cancelMktDepth(int serverVersion, const Arg& reqIdArg, const Arg& isSmartDepth) {
    Tokens t(serverVersion);
    V reqId = ptr(reqIdArg);
    if (t.sv < mv::kSmartDepth && js::truthy(ptr(isSmartDepth))) return t.error(u"It does not support SMART depth cancel."_s, reqId);
    t.num(11);
    t.num(1);
    t.push(reqId);
    if (t.sv >= mv::kSmartDepth) t.push(isSmartDepth);
    return t.send();
}

Encoded placeOrder(int serverVersion, const Arg& idArg, const Arg& contractArg, const Arg& orderArg) {
    Tokens t(serverVersion);
    V id = ptr(idArg), c = ptr(contractArg), o = ptr(orderArg);
    const auto has = [](V v) { return v != nullptr; };  // x !== undefined
    // ---- 版本不够的特性(只留 > 100 的那几道;更老的分支在 V100 连接上走不到)----
    if (t.sv < mv::kModelsSupport && js::truthy(get(o, u"modelCode"_s))) return t.error(u"It does not support model code parameter."_s, id);
    if (t.sv < mv::kExtOperator && js::truthy(get(o, u"extOperator"_s))) return t.error(u"It does not support ext operator"_s, id);
    if (t.sv < mv::kSoftDollarTier && (js::truthy(opt(get(o, u"softDollarTier"_s), u"name"_s)) || js::truthy(opt(get(o, u"softDollarTier"_s), u"value"_s))))
        return t.error(u"It does not support soft dollar tier"_s, id);
    if (t.sv < mv::kCashQty && has(get(o, u"cashQty"_s))) return t.error(u"It does not support cash quantity parameter"_s, id);
    if (t.sv < mv::kDecisionMaker && (js::truthy(get(o, u"mifid2DecisionMaker"_s)) || js::truthy(get(o, u"mifid2DecisionAlgo"_s))))
        return t.error(u"It does not support MIFID II decision maker parameters"_s, id);
    if (t.sv < mv::kMifidExecution && (js::truthy(get(o, u"mifid2ExecutionTrader"_s)) || js::truthy(get(o, u"mifid2ExecutionAlgo"_s))))
        return t.error(u"It does not support MIFID II execution parameters"_s, id);
    if (t.sv < mv::kAutoPriceForHedge && js::truthy(get(o, u"dontUseAutoPriceForHedge"_s)))
        return t.error(u"It does not support don't use auto price for hedge parameter."_s, id);
    if (t.sv < mv::kOrderContainer && js::truthy(get(o, u"isOmsContainer"_s))) return t.error(u"It does not support oms container parameter."_s, id);
    if (t.sv < mv::kDPegOrders && js::truthy(get(o, u"discretionaryUpToLimitPrice"_s))) return t.error(u"It does not support D-Peg orders."_s, id);
    if (t.sv < mv::kPriceMgmtAlgo && !js::nullish(get(o, u"usePriceMgmtAlgo"_s)))
        return t.error(u"It does not support price management algo parameter"_s, id);
    if (t.sv < mv::kDuration && !js::nullish(get(o, u"duration"_s))) return t.error(u"It does not support duration attribute"_s, id);
    if (t.sv < mv::kPostToAts && !js::nullish(get(o, u"postToAts"_s))) return t.error(u"It does not support postToAts attribute"_s, id);
    if (t.sv < mv::kAutoCancelParent && !js::nullish(get(o, u"autoCancelParent"_s)))
        return t.error(u"It does not support autoCancelParent attribute"_s, id);
    if (t.sv < mv::kAdvancedOrderReject && !js::nullish(get(o, u"advancedErrorOverride"_s)))
        return t.error(u"It does not support advanced error override attribute"_s, id);
    if (t.sv < mv::kManualOrderTime && truthy(optLength(get(o, u"manualOrderTime"_s))))
        return t.error(u"It does not support manual order time attribute"_s, id);
    if (t.sv < mv::kPegbestPegmidOffsets &&
        (has(get(o, u"minTradeQty"_s)) || has(get(o, u"minCompeteSize"_s)) || has(get(o, u"competeAgainstBestOffset"_s)) ||
         has(get(o, u"midOffsetAtWhole"_s)) || has(get(o, u"midOffsetAtHalf"_s))))
        return t.error(u"It does not support PEG BEST / PEG MID order parameters: minTradeQty, minCompeteSize, competeAgainstBestOffset, midOffsetAtWhole and midOffsetAtHalf"_s, id);
    if (t.sv < mv::kCustomerAccount && js::truthy(get(o, u"customerAccount"_s))) return t.error(u"It does not support customer account parameter"_s, id);
    if (t.sv < mv::kProfessionalCustomer && js::truthy(get(o, u"professionalCustomer"_s)))
        return t.error(u"It does not support professional customer parameter"_s, id);
    if (t.sv < mv::kIncludeOvernight && js::truthy(get(o, u"includeOvernight"_s))) return t.error(u"It does not support include overnight parameter"_s, id);
    if (t.sv < mv::kCmeTaggingFields && js::truthy(get(o, u"manualOrderIndicator"_s)))
        return t.error(u"It does not support manual order indicator parameter"_s, id);

    const auto field = [&](const QString& key) { t.push(get(o, key)); };
    const auto fieldMax = [&](const QString& key) { t.push(nullifyMax(get(o, key))); };
    t.num(3);  // PLACE_ORDER
    if (t.sv < mv::kOrderContainer) t.num(45);
    t.push(id);
    // 合约
    t.push(get(c, u"conId"_s));
    t.push(get(c, u"symbol"_s));
    t.push(get(c, u"secType"_s));
    t.push(get(c, u"lastTradeDateOrContractMonth"_s));
    t.push(get(c, u"strike"_s));
    t.push(get(c, u"right"_s));
    t.push(get(c, u"multiplier"_s));
    t.push(get(c, u"exchange"_s));
    t.push(get(c, u"primaryExch"_s));
    t.push(get(c, u"currency"_s));
    t.push(get(c, u"localSymbol"_s));
    t.push(get(c, u"tradingClass"_s));
    t.push(get(c, u"secIdType"_s));
    t.push(get(c, u"secId"_s));
    // 主要的单字段
    field(u"action"_s);
    if (t.sv >= mv::kFractionalPositions) {
        field(u"totalQuantity"_s);
    } else {
        V q = get(o, u"totalQuantity"_s);
        if (js::truthy(q)) t.num(util::jsRound(js::num(q)));
        else t.push(nullptr);
    }
    field(u"orderType"_s);
    fieldMax(u"lmtPrice"_s);
    fieldMax(u"auxPrice"_s);
    // 扩展字段
    for (const QString& k : {u"tif"_s, u"ocaGroup"_s, u"account"_s, u"openClose"_s, u"origin"_s, u"orderRef"_s, u"transmit"_s, u"parentId"_s,
                             u"blockOrder"_s, u"sweepToFill"_s, u"displaySize"_s, u"triggerMethod"_s, u"outsideRth"_s, u"hidden"_s})
        field(k);
    // BAG 的组合腿
    if (isBag(c)) {
        V legs = get(c, u"comboLegs"_s);
        if (!truthy(optLength(legs))) {
            t.num(0);
        } else {
            t.push(lengthOf(legs));
            forEach(legs, u"contract.comboLegs.forEach"_s, [&](V leg) {
                for (const QString& k : {u"conId"_s, u"ratio"_s, u"action"_s, u"exchange"_s, u"openClose"_s, u"shortSaleSlot"_s, u"designatedLocation"_s,
                                         u"exemptCode"_s})
                    t.push(get(leg, k));
            });
        }
    }
    // BAG 单上每条腿的价
    if (isBag(c)) {
        V legs = get(o, u"orderComboLegs"_s);
        if (!truthy(optLength(legs))) {
            t.num(0);
        } else {
            t.push(lengthOf(legs));
            forEach(legs, u"order.orderComboLegs.forEach"_s, [&](V leg) { t.push(nullifyMax(get(leg, u"price"_s))); });
        }
    }
    if (isBag(c)) {
        V params = get(o, u"smartComboRoutingParams"_s);
        const std::optional<OJson> count = !js::truthy(params) ? std::optional<OJson>(OJson::number(0)) : lengthOf(params);
        t.push(count);
        if (gtZero(count)) {
            forEach(get(o, u"smartComboRoutingParams"_s), u"order.smartComboRoutingParams?.forEach"_s, [&](V p) {
                t.push(get(p, u"tag"_s));
                t.push(get(p, u"value"_s));
            });
        }
    }
    t.str(QString());  // 早已不用的 sharesAllocation
    field(u"discretionaryAmt"_s);
    field(u"goodAfterTime"_s);
    field(u"goodTillDate"_s);
    field(u"faGroup"_s);
    field(u"faMethod"_s);
    field(u"faPercentage"_s);
    if (t.sv < mv::kFaProfileDesupport) t.str(QString());  // 早已不用的 faProfile
    if (t.sv >= mv::kModelsSupport) field(u"modelCode"_s);
    field(u"shortSaleSlot"_s);
    field(u"designatedLocation"_s);
    field(u"exemptCode"_s);
    field(u"ocaType"_s);
    field(u"rule80A"_s);
    field(u"settlingFirm"_s);
    field(u"allOrNone"_s);
    fieldMax(u"minQty"_s);
    fieldMax(u"percentOffset"_s);
    field(u"eTradeOnly"_s);
    field(u"firmQuoteOnly"_s);
    fieldMax(u"nbboPriceCap"_s);
    fieldMax(u"auctionStrategy"_s);
    fieldMax(u"startingPrice"_s);
    fieldMax(u"stockRefPrice"_s);
    fieldMax(u"delta"_s);
    field(u"stockRangeLower"_s);  // 版本 26 的波动率单特例走不到
    field(u"stockRangeUpper"_s);
    field(u"overridePercentageConstraints"_s);
    // 波动率单
    fieldMax(u"volatility"_s);
    fieldMax(u"volatilityType"_s);
    field(u"deltaNeutralOrderType"_s);
    fieldMax(u"deltaNeutralAuxPrice"_s);
    if (js::truthy(get(o, u"deltaNeutralOrderType"_s))) {
        field(u"deltaNeutralConId"_s);
        field(u"deltaNeutralSettlingFirm"_s);
        field(u"deltaNeutralClearingAccount"_s);
        field(u"deltaNeutralClearingIntent"_s);
    }
    if (js::truthy(get(o, u"deltaNeutralOrderType"_s))) {
        field(u"deltaNeutralOpenClose"_s);
        field(u"deltaNeutralShortSale"_s);
        field(u"deltaNeutralShortSaleSlot"_s);
        field(u"deltaNeutralDesignatedLocation"_s);
    }
    field(u"continuousUpdate"_s);
    fieldMax(u"referencePriceType"_s);
    fieldMax(u"trailStopPrice"_s);
    fieldMax(u"trailingPercent"_s);
    // 分批单
    fieldMax(u"scaleInitLevelSize"_s);
    fieldMax(u"scaleSubsLevelSize"_s);
    fieldMax(u"scalePriceIncrement"_s);
    if (has(get(o, u"scalePriceIncrement"_s))) {
        fieldMax(u"scalePriceAdjustValue"_s);
        fieldMax(u"scalePriceAdjustInterval"_s);
        fieldMax(u"scaleProfitOffset"_s);
        field(u"scaleAutoReset"_s);
        fieldMax(u"scaleInitPosition"_s);
        fieldMax(u"scaleInitFillQty"_s);
        field(u"scaleRandomPercent"_s);
    }
    field(u"scaleTable"_s);
    field(u"activeStartTime"_s);
    field(u"activeStopTime"_s);
    // 对冲
    field(u"hedgeType"_s);
    if (js::truthy(get(o, u"hedgeType"_s))) field(u"hedgeParam"_s);
    field(u"optOutSmartRouting"_s);
    field(u"clearingAccount"_s);
    field(u"clearingIntent"_s);
    field(u"notHeld"_s);
    V dnc = get(c, u"deltaNeutralContract"_s);
    if (js::truthy(dnc)) {
        t.boolean(true);
        t.push(get(dnc, u"conId"_s));
        t.push(get(dnc, u"delta"_s));
        t.push(get(dnc, u"price"_s));
    } else {
        t.boolean(false);
    }
    // 算法单
    field(u"algoStrategy"_s);
    if (js::truthy(get(o, u"algoStrategy"_s))) {
        const std::optional<OJson> len = optLength(get(o, u"algoParams"_s));
        const std::optional<OJson> count = truthy(len) ? lengthOf(get(o, u"algoParams"_s)) : std::optional<OJson>(OJson::number(0));
        t.push(count);
        if (gtZero(count)) {
            V params = get(o, u"algoParams"_s);
            if (!js::nullish(params)) {
                forEach(params, u"order.algoParams?.forEach"_s, [&](V p) {
                    t.push(get(p, u"tag"_s));
                    t.push(get(p, u"value"_s));
                });
            }
        }
    }
    field(u"algoId"_s);
    field(u"whatIf"_s);
    field(u"orderMiscOptions"_s);
    field(u"solicited"_s);
    field(u"randomizeSize"_s);
    field(u"randomizePrice"_s);
    if (t.sv >= mv::kPeggedToBenchmark) {
        if (isPegBenchOrder(get(o, u"orderType"_s))) {
            field(u"referenceContractId"_s);
            field(u"isPeggedChangeAmountDecrease"_s);
            field(u"peggedChangeAmount"_s);
            field(u"referenceChangeAmount"_s);
            field(u"referenceExchangeId"_s);
        }
        V conds = get(o, u"conditions"_s);
        const std::optional<OJson> n = js::truthy(conds) ? lengthOf(conds) : std::optional<OJson>(OJson::number(0));
        t.push(n);
        if (gtZero(n)) {
            V list = get(o, u"conditions"_s);
            if (!js::nullish(list)) {
                forEach(list, u"order.conditions?.forEach"_s, [&](V cond) {
                    t.push(get(cond, u"type"_s));
                    t.push(get(cond, u"conjunctionConnection"_s));
                    V type = get(cond, u"type"_s);
                    const double kind = js::isNum(type) ? type->n : std::nan("");  // switch 是严格相等:只认数
                    QList<QString> keys;
                    if (kind == 5) keys = {u"secType"_s, u"exchange"_s, u"symbol"_s};                               // Execution
                    else if (kind == 4) keys = {u"isMore"_s, u"strValue"_s};                                       // Margin
                    else if (kind == 7) keys = {u"isMore"_s, u"strValue"_s, u"conId"_s, u"exchange"_s};               // PercentChange
                    else if (kind == 1) keys = {u"isMore"_s, u"strValue"_s, u"conId"_s, u"exchange"_s, u"triggerMethod"_s};  // Price
                    else if (kind == 3) keys = {u"isMore"_s, u"strValue"_s};                                       // Time
                    else if (kind == 6) keys = {u"isMore"_s, u"strValue"_s, u"conId"_s, u"exchange"_s};               // Volume
                    for (const QString& k : keys) t.push(get(cond, k));
                });
            }
            field(u"conditionsIgnoreRth"_s);
            field(u"conditionsCancelOrder"_s);
        }
        for (const QString& k : {u"adjustedOrderType"_s, u"triggerPrice"_s, u"lmtPriceOffset"_s, u"adjustedStopPrice"_s, u"adjustedStopLimitPrice"_s,
                                 u"adjustedTrailingAmount"_s, u"adjustableTrailingUnit"_s})
            field(k);
    }
    if (t.sv >= mv::kExtOperator) field(u"extOperator"_s);
    if (t.sv >= mv::kSoftDollarTier) {
        V tier = get(o, u"softDollarTier"_s);
        if (js::truthy(opt(tier, u"name"_s))) t.push(get(get(o, u"softDollarTier"_s), u"name"_s));
        else t.str(QString());
        tier = get(o, u"softDollarTier"_s);
        if (js::truthy(opt(tier, u"value"_s))) t.push(get(get(o, u"softDollarTier"_s), u"value"_s));
        else t.str(QString());
    }
    if (t.sv >= mv::kCashQty) fieldMax(u"cashQty"_s);
    if (t.sv >= mv::kDecisionMaker) {
        field(u"mifid2DecisionMaker"_s);
        field(u"mifid2DecisionAlgo"_s);
    }
    if (t.sv >= mv::kMifidExecution) {
        field(u"mifid2ExecutionTrader"_s);
        field(u"mifid2ExecutionAlgo"_s);
    }
    if (t.sv >= mv::kAutoPriceForHedge) field(u"dontUseAutoPriceForHedge"_s);
    if (t.sv >= mv::kOrderContainer) field(u"isOmsContainer"_s);
    if (t.sv >= mv::kDPegOrders) field(u"discretionaryUpToLimitPrice"_s);
    if (t.sv >= mv::kPriceMgmtAlgo) field(u"usePriceMgmtAlgo"_s);
    if (t.sv >= mv::kDuration) field(u"duration"_s);
    if (t.sv >= mv::kPostToAts) field(u"postToAts"_s);
    if (t.sv >= mv::kAutoCancelParent) field(u"autoCancelParent"_s);
    if (t.sv >= mv::kAdvancedOrderReject) field(u"advancedErrorOverride"_s);
    if (t.sv >= mv::kManualOrderTime) field(u"manualOrderTime"_s);
    if (t.sv >= mv::kPegbestPegmidOffsets) {
        bool sendMidOffsets = false;
        if (looseEq(get(c, u"exchange"_s), u"IBKRATS"_s)) field(u"minTradeQty"_s);
        if (isPegBestOrder(get(o, u"orderType"_s))) {
            field(u"minCompeteSize"_s);
            field(u"competeAgainstBestOffset"_s);
            V offset = get(o, u"competeAgainstBestOffset"_s);
            if (js::isNum(offset) && offset->n == std::numeric_limits<double>::infinity()) sendMidOffsets = true;  // 与 Infinity 严格相等
        } else if (isPegMidOrder(get(o, u"orderType"_s))) {
            sendMidOffsets = true;
        }
        if (sendMidOffsets) {
            field(u"midOffsetAtWhole"_s);
            field(u"midOffsetAtHalf"_s);
        }
    }
    if (t.sv >= mv::kCustomerAccount) field(u"customerAccount"_s);
    if (t.sv >= mv::kProfessionalCustomer) field(u"professionalCustomer"_s);
    if (t.sv >= mv::kRfqFields && t.sv < mv::kUndoRfqFields) {
        t.str(QString());
        t.num(kIntegerMax);
    }
    if (t.sv >= mv::kIncludeOvernight) field(u"includeOvernight"_s);
    if (t.sv >= mv::kCmeTaggingFields) field(u"manualOrderIndicator"_s);
    return t.send();
}

Encoded cancelOrder(int serverVersion, const Arg& orderIdArg, const Arg& orderCancelArg) {
    Tokens t(serverVersion);
    V orderId = ptr(orderIdArg), oc = ptr(orderCancelArg);
    if (t.sv < mv::kManualOrderTime && truthy(optLength(get(oc, u"manualOrderCancelTime"_s))))
        return t.error(u"It does not support manual order cancel time attribute"_s, orderId);
    if (t.sv < mv::kCmeTaggingFields && (truthy(optLength(get(oc, u"extOperator"_s))) || !js::nullish(get(oc, u"manualOrderIndicator"_s))))
        return t.error(u"It does not support ext operator and manual order indicator parameters"_s, orderId);
    t.num(4);  // CANCEL_ORDER
    if (t.sv < mv::kCmeTaggingFields) t.num(1);
    t.push(orderId);
    if (t.sv >= mv::kManualOrderTime) t.push(get(oc, u"manualOrderCancelTime"_s));
    if (t.sv >= mv::kRfqFields && t.sv < mv::kUndoRfqFields) {
        t.str(QString());
        t.str(QString());
        t.num(kIntegerMax);
    }
    if (t.sv >= mv::kCmeTaggingFields) {
        t.push(get(oc, u"extOperator"_s));
        V indicator = get(oc, u"manualOrderIndicator"_s);
        if (js::nullish(indicator)) t.num(kIntegerMax);
        else t.push(indicator);
    }
    return t.send();
}

Encoded reqAllOpenOrders(int serverVersion) {
    Tokens t(serverVersion);
    t.num(16);
    t.num(1);
    return t.send();
}

Encoded reqOpenOrders(int serverVersion) {
    Tokens t(serverVersion);
    t.num(5);
    t.num(1);
    return t.send();
}

Encoded reqAutoOpenOrders(int serverVersion, const Arg& autoBind) {
    Tokens t(serverVersion);
    t.num(15);
    t.num(1);
    t.push(autoBind);
    return t.send();
}

Encoded reqExecutions(int serverVersion, const Arg& reqId, const Arg& filterArg) {
    Tokens t(serverVersion);
    V f = ptr(filterArg);
    t.num(7);  // REQ_EXECUTIONS
    t.num(3);
    t.push(reqId);
    for (const QString& k : {u"clientId"_s, u"acctCode"_s, u"time"_s, u"symbol"_s, u"secType"_s, u"exchange"_s, u"side"_s}) t.push(get(f, k));
    return t.send();
}

Encoded reqSecDefOptParams(int serverVersion, const Arg& reqId, const Arg& underlyingSymbol, const Arg& futFopExchange,
                           const Arg& underlyingSecType, const Arg& underlyingConId) {
    Tokens t(serverVersion);
    if (t.sv < mv::kSecDefOptParamsReq) return t.error(u"It does not support reqSecDefOptParams."_s, ptr(reqId));
    t.num(78);
    t.push(reqId);
    t.push(underlyingSymbol);
    t.push(futFopExchange);
    t.push(underlyingSecType);
    t.push(underlyingConId);
    return t.send();
}

Encoded reqManagedAccts(int serverVersion) {
    Tokens t(serverVersion);
    t.num(17);
    t.num(1);
    return t.send();
}

Encoded reqIds(int serverVersion, const Arg& numIds) {
    Tokens t(serverVersion);
    t.num(8);
    t.num(1);
    t.push(numIds);
    return t.send();
}

// WSH field order: @stoqey/ib (MIT), encoder reqWshEventData, protocol >=173.
Encoded wsh(int sv, int command, double reqId, const QString& filter, const QString& start, const QString& end) {
    Tokens t(sv);
    const OJson id = OJson::number(reqId);
    if (sv < 173) return t.error(u"WSH date filters require TWS protocol 173 or later"_s, &id);
    t.num(command); t.num(reqId);
    if (command == 102) {
        t.num(2147483647); t.str(filter);
        t.boolean(false); t.boolean(false); t.boolean(false);
        t.str(start); t.str(end); t.num(1000);
    }
    return t.send();
}

Encoded reqCurrentTime(int serverVersion) {
    Tokens t(serverVersion);
    t.num(49);
    t.num(1);
    return t.send();
}

Encoded startApi(int serverVersion, const Arg& clientId) {
    Tokens t(serverVersion);
    if (t.sv < 3) return {};
    if (t.sv < 70) {  // LINKING 以前只发 client id
        t.push(clientId);
        return t.send();
    }
    t.num(71);  // START_API
    t.num(2);
    t.push(clientId);
    if (t.sv >= 72) t.str(QString());  // OPTIONAL_CAPABILITIES
    return t.send();
}

namespace api {

Encoded cancelOrder(int serverVersion, const Arg& orderId, const Arg& orderCancelParam) {
    if (!orderCancelParam || orderCancelParam->type == OJson::Null)
        return wire::cancelOrder(serverVersion, orderId, js::object({{u"extOperator"_s, js::S(QString())}}));
    if (orderCancelParam->type == OJson::String)
        return wire::cancelOrder(serverVersion, orderId, js::object({{u"manualOrderCancelTime"_s, *orderCancelParam}, {u"extOperator"_s, js::S(QString())}}));
    return wire::cancelOrder(serverVersion, orderId, orderCancelParam);
}

Encoded reqMktData(int serverVersion, const Arg& reqId, const Arg& contract, const Arg& genericTickList, const Arg& snapshot,
                   const Arg& regulatorySnapshot) {
    const Arg ticks = js::nullish(ptr(genericTickList)) ? Arg(js::S(QString())) : genericTickList;
    return wire::reqMktData(serverVersion, reqId, contract, ticks, snapshot, regulatorySnapshot);
}

Encoded reqPnL(int serverVersion, const Arg& reqId, const Arg& account, const Arg& modelCode) {
    const Arg model = js::nullish(ptr(modelCode)) ? Arg(js::S(QString())) : modelCode;
    return wire::reqPnL(serverVersion, reqId, account, model);
}

Encoded reqIds(int serverVersion, const Arg& numIds) { return wire::reqIds(serverVersion, numIds ? numIds : Arg(js::N(0))); }

Encoded reqHistoricalData(int serverVersion, const Arg& reqId, const Arg& contract, const Arg& endDateTime, const Arg& durationStr,
                          const Arg& barSizeSetting, const Arg& whatToShow, const Arg& useRTH, const Arg& formatDate, const Arg& keepUpToDate) {
    return wire::reqHistoricalData(serverVersion, reqId, contract, endDateTime, durationStr, barSizeSetting, whatToShow, useRTH, formatDate, keepUpToDate,
                                   std::nullopt);
}

}  // namespace api

}  // namespace ibkr::tws::wire
