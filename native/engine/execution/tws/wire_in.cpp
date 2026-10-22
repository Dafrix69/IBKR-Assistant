#include "execution/tws/wire_in.h"

#include "execution/tws/codec.h"
#include "util/jsformat.h"
#include "util/jsnum.h"
#include "util/jsobj.h"
#include "util/v8json.h"

#include <cmath>
#include <limits>

using namespace Qt::StringLiterals;

namespace ibkr::tws::wire {

namespace js = util::js;
using detail::finalize;
using detail::isUndef;
using detail::undef;

namespace {

constexpr double kMaxDouble = std::numeric_limits<double>::max();
constexpr double kInf = std::numeric_limits<double>::infinity();
constexpr double kMaxSafeInteger = 9007199254740991.0;
constexpr double kUnknownId = 505;  // ErrorCode.UNKNOWN_ID
const QString kReport = u" Please report to https://github.com/stoqey/ib"_s;

/// 用到的 MIN_SERVER_VERSION
namespace mv {
constexpr int kPeggedToBenchmark = 102;
constexpr int kModelsSupport = 103;
constexpr int kSoftDollarTier = 106;
constexpr int kMdSizeMultiplier = 110;
constexpr int kCashQty = 111;
constexpr int kAggGroup = 121;
constexpr int kUnderlyingInfo = 122;
constexpr int kSyntRealtimeBars = 124;
constexpr int kMarketRules = 126;
constexpr int kUnrealizedPnl = 129;
constexpr int kMarketCapPrice = 131;
constexpr int kRealExpirationDate = 134;
constexpr int kRealizedPnl = 135;
constexpr int kLastLiquidity = 136;
constexpr int kAutoPriceForHedge = 141;
constexpr int kWhatIfExtFields = 142;
constexpr int kOrderContainer = 145;
constexpr int kSmartDepth = 146;
constexpr int kDPegOrders = 148;
constexpr int kPriceMgmtAlgo = 151;
constexpr int kStockType = 152;
constexpr int kEncodeMsgAscii7 = 153;
constexpr int kPriceBasedVolatility = 156;
constexpr int kDuration = 158;
constexpr int kPostToAts = 160;
constexpr int kAutoCancelParent = 162;
constexpr int kFractionalSizeSupport = 163;
constexpr int kSizeRules = 164;
constexpr int kAdvancedOrderReject = 166;
constexpr int kPegbestPegmidOffsets = 170;
constexpr int kFaProfileDesupport = 177;
constexpr int kPendingPriceRevision = 178;
constexpr int kFundDataFields = 179;
constexpr int kLastTradeDate = 182;
constexpr int kCustomerAccount = 183;
constexpr int kProfessionalCustomer = 184;
constexpr int kBondAccruedInterest = 185;
constexpr int kIneligibilityReasons = 186;
constexpr int kIncludeOvernight = 189;
constexpr int kCmeTaggingFieldsInOpenOrder = 193;
}  // namespace mv

/// 读不够:库的 UnderrunError(只在解码器里面接住)
struct Underrun {
    QString message;
};

OJson N(double v) { return OJson::number(v); }
OJson S(const QString& v) { return OJson::string(v); }
OJson B(bool v) { return OJson::boolean(v); }
OJson obj() { return js::object(); }
OJson arr() { return js::array(); }

/// validateOptionType:只认 "P" / "C"
OJson optionType(const QString& v) { return v == u"P"_s || v == u"C"_s ? S(v) : undef(); }

/// 一个数(或 undefined 占位)的值,undefined 是 NaN 之外单独判
bool isNumber(const OJson& v) { return v.type == OJson::Number; }

/// parseInt(s)(不带基数):去掉开头的 JS 空白与正负号,0x / 0X 开头按十六进制,其余按十进制
double parseIntNoRadix(const QString& s) {
    qsizetype i = 0;
    while (i < s.size() && util::isJsWhitespace(s[i])) ++i;
    double sign = 1;
    qsizetype j = i;
    if (j < s.size() && (s[j] == u'-' || s[j] == u'+')) {
        if (s[j] == u'-') sign = -1;
        ++j;
    }
    if (j + 1 < s.size() && s[j] == u'0' && (s[j + 1] == u'x' || s[j + 1] == u'X')) return sign * util::jsParseInt(QStringView(s).sliced(j), 16);
    return util::jsParseInt(s, 10);
}

/// Unicode 的 Cased(大小写字母)与 Case_Ignorable(附加符号、格式符、撇号之类),给词尾 Σ 的规则用
bool isCased(QChar c) { return c.isLower() || c.isUpper() || c.isTitleCase(); }
bool isCaseIgnorable(QChar c) {
    switch (c.category()) {
    case QChar::Mark_NonSpacing:
    case QChar::Mark_Enclosing:
    case QChar::Other_Format:
    case QChar::Letter_Modifier:
    case QChar::Symbol_Modifier: return true;
    default: break;
    }
    static const QString mid = QStringLiteral("'.:\u00B7\u0387\u05F4\u2018\u2019\u2024\u2027\uFE13\uFE52\uFE55\uFF07\uFF0E\uFF1A");
    return mid.contains(c);
}
/// toLocaleLowerCase():Qt 的 toLower 之外补上词尾的 Σ → ς(JS 照 Unicode 的 Final_Sigma 规则,Qt 不管上下文)
QString jsToLower(const QString& s) {
    QString out = s.toLower();
    if (out.size() != s.size()) return out;  // 有一对多的映射时位置对不上,不再补(Σ 与它们同时出现的串这里不管)
    for (qsizetype i = 0; i < s.size(); ++i) {
        if (s[i] != QChar(0x03A3)) continue;
        qsizetype b = i - 1;
        while (b >= 0 && isCaseIgnorable(s[b])) --b;
        if (b < 0 || !isCased(s[b])) continue;
        qsizetype a = i + 1;
        while (a < s.size() && isCaseIgnorable(s[a])) ++a;
        if (a < s.size() && isCased(s[a])) continue;
        out[i] = QChar(0x03C2);
    }
    return out;
}

/// IN_MSG_ID(core/io/enum/in-msg-id.js)的名字表
const QList<QPair<int, QString>>& inMsgIds() {
    static const QList<QPair<int, QString>> ids = {
        {-1, u"UNDEFINED"_s}, {1, u"TICK_PRICE"_s}, {2, u"TICK_SIZE"_s}, {3, u"ORDER_STATUS"_s}, {4, u"ERR_MSG"_s}, {5, u"OPEN_ORDER"_s},
        {6, u"ACCT_VALUE"_s}, {7, u"PORTFOLIO_VALUE"_s}, {8, u"ACCT_UPDATE_TIME"_s}, {9, u"NEXT_VALID_ID"_s}, {10, u"CONTRACT_DATA"_s},
        {11, u"EXECUTION_DATA"_s}, {12, u"MARKET_DEPTH"_s}, {13, u"MARKET_DEPTH_L2"_s}, {14, u"NEWS_BULLETINS"_s}, {15, u"MANAGED_ACCTS"_s},
        {16, u"RECEIVE_FA"_s}, {17, u"HISTORICAL_DATA"_s}, {18, u"BOND_CONTRACT_DATA"_s}, {19, u"SCANNER_PARAMETERS"_s}, {20, u"SCANNER_DATA"_s},
        {21, u"TICK_OPTION_COMPUTATION"_s}, {45, u"TICK_GENERIC"_s}, {46, u"TICK_STRING"_s}, {47, u"TICK_EFP"_s}, {49, u"CURRENT_TIME"_s},
        {50, u"REAL_TIME_BARS"_s}, {51, u"FUNDAMENTAL_DATA"_s}, {52, u"CONTRACT_DATA_END"_s}, {53, u"OPEN_ORDER_END"_s}, {54, u"ACCT_DOWNLOAD_END"_s},
        {55, u"EXECUTION_DATA_END"_s}, {56, u"DELTA_NEUTRAL_VALIDATION"_s}, {57, u"TICK_SNAPSHOT_END"_s}, {58, u"MARKET_DATA_TYPE"_s},
        {59, u"COMMISSION_REPORT"_s}, {61, u"POSITION"_s}, {62, u"POSITION_END"_s}, {63, u"ACCOUNT_SUMMARY"_s}, {64, u"ACCOUNT_SUMMARY_END"_s},
        {65, u"VERIFY_MESSAGE_API"_s}, {66, u"VERIFY_COMPLETED"_s}, {67, u"DISPLAY_GROUP_LIST"_s}, {68, u"DISPLAY_GROUP_UPDATED"_s},
        {69, u"VERIFY_AND_AUTH_MESSAGE_API"_s}, {70, u"VERIFY_AND_AUTH_COMPLETED"_s}, {71, u"POSITION_MULTI"_s}, {72, u"POSITION_MULTI_END"_s},
        {73, u"ACCOUNT_UPDATE_MULTI"_s}, {74, u"ACCOUNT_UPDATE_MULTI_END"_s}, {75, u"SECURITY_DEFINITION_OPTION_PARAMETER"_s},
        {76, u"SECURITY_DEFINITION_OPTION_PARAMETER_END"_s}, {77, u"SOFT_DOLLAR_TIERS"_s}, {78, u"FAMILY_CODES"_s}, {79, u"SYMBOL_SAMPLES"_s},
        {80, u"MKT_DEPTH_EXCHANGES"_s}, {81, u"TICK_REQ_PARAMS"_s}, {82, u"SMART_COMPONENTS"_s}, {83, u"NEWS_ARTICLE"_s}, {84, u"TICK_NEWS"_s},
        {85, u"NEWS_PROVIDERS"_s}, {86, u"HISTORICAL_NEWS"_s}, {87, u"HISTORICAL_NEWS_END"_s}, {88, u"HEAD_TIMESTAMP"_s}, {89, u"HISTOGRAM_DATA"_s},
        {90, u"HISTORICAL_DATA_UPDATE"_s}, {91, u"REROUTE_MKT_DATA"_s}, {92, u"REROUTE_MKT_DEPTH"_s}, {93, u"MARKET_RULE"_s}, {94, u"PNL"_s},
        {95, u"PNL_SINGLE"_s}, {96, u"HISTORICAL_TICKS"_s}, {97, u"HISTORICAL_TICKS_BID_ASK"_s}, {98, u"HISTORICAL_TICKS_LAST"_s},
        {99, u"TICK_BY_TICK"_s}, {100, u"ORDER_BOUND"_s}, {101, u"COMPLETED_ORDER"_s}, {102, u"COMPLETED_ORDERS_END"_s}, {103, u"REPLACE_FA_END"_s},
        {104, u"WSH_META_DATA"_s}, {105, u"WSH_EVENT_DATA"_s}, {106, u"HISTORICAL_SCHEDULE"_s}, {107, u"USER_INFO"_s},
    };
    return ids;
}

/// 库里有解码、这里没搬的消息号(processMsg 的 case 里有,这里不认)
bool unported(double id) {
    static const QList<int> ids = {6, 7, 8, 14, 16, 18, 19, 20, 47, 50, 51, 54, 56, 67, 68, 71, 72, 73, 74, 77, 78, 79, 80, 82, 83, 84, 85, 86, 87, 88,
                                   89, 91, 92, 93, 95, 96, 97, 98, 99, 101, 102, 103, 104, 105, 106, 107};
    for (int x : ids)
        if (id == x) return true;
    return false;
}

// ---------------------------------------------------------------- 各条消息

void tickPrice(Decoder& d) {
    const double version = d.readInt();
    const double tickerId = d.readInt();
    const double tickType = d.readInt();
    const OJson price = d.readDouble();
    OJson size = undef();
    if (version >= 2) size = d.readDecimal();
    OJson canAutoExecute = undef();
    if (version >= 3) canAutoExecute = B(d.readBool());
    d.queueEvent(u"tickPrice"_s, {N(tickerId), N(tickType), price, canAutoExecute});
    // 价对应的量:BID 的量是 BID_SIZE = 0,库判 `if (sizeTickType)` 时被当成没有(照搬)
    double sizeTickType = std::nan("");
    if (version >= 2) {
        if (tickType == 1) sizeTickType = 0;
        else if (tickType == 2) sizeTickType = 3;
        else if (tickType == 4) sizeTickType = 5;
        else if (tickType == 66) sizeTickType = 69;
        else if (tickType == 67) sizeTickType = 70;
        else if (tickType == 68) sizeTickType = 71;
    }
    if (sizeTickType != 0 && !std::isnan(sizeTickType)) d.queueEvent(u"tickSize"_s, {N(tickerId), N(sizeTickType), size});
}

void tickSize(Decoder& d) {
    d.readInt();  // 版本
    const double tickerId = d.readInt();
    const double tickType = d.readInt();
    const OJson size = d.readDecimal();
    d.queueEvent(u"tickSize"_s, {N(tickerId), N(tickType), size});
}

void orderStatus(Decoder& d) {
    const double version = d.serverVersion() >= mv::kMarketCapPrice ? kMaxSafeInteger : d.readInt();
    const double id = d.readInt();
    const QString status = d.readStr();
    const OJson filled = d.readDecimal();
    const OJson remaining = d.readDecimal();
    const OJson avgFillPrice = d.readDouble();
    OJson permId = undef(), parentId = undef(), lastFillPrice = undef(), clientId = undef(), whyHeld = undef(), mktCapPrice = undef();
    if (version >= 2) permId = N(d.readInt());
    if (version >= 3) parentId = N(d.readInt());
    if (version >= 4) lastFillPrice = d.readDouble();
    if (version >= 5) clientId = N(d.readInt());
    if (version >= 6) whyHeld = S(d.readStr());
    if (d.serverVersion() >= mv::kMarketCapPrice) mktCapPrice = d.readDouble();
    d.queueEvent(u"orderStatus"_s, {N(id), S(status), filled, remaining, avgFillPrice, permId, parentId, lastFillPrice, clientId, whyHeld, mktCapPrice});
}

/// OrderDecoder:OPEN_ORDER 的一格一格(同库的 OrderDecoder,方法名照抄)
class OrderDecoder {
public:
    OrderDecoder(Decoder& d, OJson& contract, OJson& order, OJson& orderState, double version)
        : d(d), contract(contract), order(order), orderState(orderState), version(version), sv(d.serverVersion()) {}

    void readOrderId() { order.set(u"orderId"_s, N(d.readInt())); }
    void readContractFields() {
        if (version >= 17) contract.set(u"conId"_s, N(d.readInt()));
        contract.set(u"symbol"_s, S(d.readStr()));
        contract.set(u"secType"_s, S(d.readStr()));
        contract.set(u"lastTradeDateOrContractMonth"_s, S(d.readStr()));
        contract.set(u"strike"_s, d.readDouble());
        contract.set(u"right"_s, optionType(d.readStr()));
        if (version >= 32) contract.set(u"multiplier"_s, N(util::jsStringToNumber(d.readStr())));  // +readStr():Number(),不是 parseFloat
        contract.set(u"exchange"_s, S(d.readStr()));
        contract.set(u"currency"_s, S(d.readStr()));
        if (version >= 2) contract.set(u"localSymbol"_s, S(d.readStr()));
        if (version >= 32) contract.set(u"tradingClass"_s, S(d.readStr()));
    }
    void readAction() { str(order, u"action"_s); }
    void readTotalQuantity() { order.set(u"totalQuantity"_s, d.readDecimal()); }
    void readOrderType() { str(order, u"orderType"_s); }
    void readLmtPrice() { order.set(u"lmtPrice"_s, version < 29 ? d.readDouble() : d.readDoubleOrUndefined()); }
    void readAuxPrice() { order.set(u"auxPrice"_s, version < 30 ? d.readDouble() : d.readDoubleOrUndefined()); }
    void readTIF() { str(order, u"tif"_s); }
    void readOcaGroup() { str(order, u"ocaGroup"_s); }
    void readAccount() { str(order, u"account"_s); }
    void readOpenClose() { str(order, u"openClose"_s); }
    void readOrigin() { integer(order, u"origin"_s); }
    void readOrderRef() { str(order, u"orderRef"_s); }
    void readClientId() {
        if (version >= 3) integer(order, u"clientId"_s);
    }
    void readPermId() {
        if (version >= 4) integer(order, u"permId"_s);
    }
    void readOutsideRth() {
        if (version >= 4) {
            if (version < 18) d.readBool();
            else boolean(order, u"outsideRth"_s);
        }
    }
    void readHidden() {
        if (version >= 4) order.set(u"hidden"_s, B(d.readInt() == 1));
    }
    void readDiscretionaryAmount() {
        if (version >= 4) order.set(u"discretionaryAmt"_s, d.readDouble());
    }
    void readGoodAfterTime() {
        if (version >= 5) str(order, u"goodAfterTime"_s);
    }
    void skipSharesAllocation() {
        if (version >= 6) d.readStr();
    }
    void readFAParams() {
        if (version >= 7) {
            str(order, u"faGroup"_s);
            str(order, u"faMethod"_s);
            str(order, u"faPercentage"_s);
            if (version < mv::kFaProfileDesupport) str(order, u"faProfile"_s);
        }
    }
    void readModelCode() {
        if (version >= mv::kModelsSupport) str(order, u"modelCode"_s);
    }
    void readGoodTillDate() {
        if (version >= 8) str(order, u"goodTillDate"_s);
    }
    void readRule80A() {
        if (version >= 9) str(order, u"rule80A"_s);
    }
    void readPercentOffset() {
        if (version >= 9) order.set(u"percentOffset"_s, d.readDoubleOrUndefined());
    }
    void readSettlingFirm() {
        if (version >= 9) str(order, u"settlingFirm"_s);
    }
    void readShortSaleParams() {
        if (version >= 9) {
            integer(order, u"shortSaleSlot"_s);
            str(order, u"designatedLocation"_s);
            if (version == 51) d.readInt();  // exemptCode
            else if (version >= 23) integer(order, u"exemptCode"_s);
        }
    }
    void readAuctionStrategy() {
        if (version >= 9) integer(order, u"auctionStrategy"_s);
    }
    void readBoxOrderParams() {
        if (version >= 9) {
            order.set(u"startingPrice"_s, d.readDoubleOrUndefined());
            order.set(u"stockRefPrice"_s, d.readDoubleOrUndefined());
            order.set(u"delta"_s, d.readDoubleOrUndefined());
        }
    }
    void readPegToStkOrVolOrderParams() {
        if (version >= 9) {
            order.set(u"stockRangeLower"_s, d.readDoubleOrUndefined());
            order.set(u"stockRangeUpper"_s, d.readDoubleOrUndefined());
        }
    }
    void readDisplaySize() {
        if (version >= 9) order.set(u"displaySize"_s, d.readIntOrUndefined());
    }
    void readOldStyleOutsideRth() {
        if (version >= 9 && version < 18) d.readBool();
    }
    void readBlockOrder() {
        if (version >= 9) boolean(order, u"blockOrder"_s);
    }
    void readSweepToFill() {
        if (version >= 9) boolean(order, u"sweepToFill"_s);
    }
    void readAllOrNone() {
        if (version >= 9) boolean(order, u"allOrNone"_s);
    }
    void readMinQty() {
        if (version >= 9) order.set(u"minQty"_s, d.readIntOrUndefined());
    }
    void readOcaType() {
        if (version >= 9) integer(order, u"ocaType"_s);
    }
    void readETradeOnly() {
        if (version >= 9) boolean(order, u"eTradeOnly"_s);
    }
    void readFirmQuoteOnly() {
        if (version >= 9) boolean(order, u"firmQuoteOnly"_s);
    }
    void readNbboPriceCap() {
        if (version >= 9) order.set(u"nbboPriceCap"_s, d.readDoubleOrUndefined());
    }
    void readParentId() {
        if (version >= 10) integer(order, u"parentId"_s);
    }
    void readTriggerMethod() {
        if (version >= 10) integer(order, u"triggerMethod"_s);
    }
    void readVolOrderParams(bool readOpenOrderAttribs) {
        if (!(version >= 11)) return;  // TS 是 if (this.version >= 11) {…}:version 读成 NaN 时跳过
        order.set(u"volatility"_s, d.readDoubleOrUndefined());
        integer(order, u"volatilityType"_s);
        if (version == 11) {
            const double receivedInt = d.readInt();
            order.set(u"deltaNeutralOrderType"_s, S(receivedInt == 0 ? u"NONE"_s : u"MKT"_s));
        } else {
            str(order, u"deltaNeutralOrderType"_s);
            order.set(u"deltaNeutralAuxPrice"_s, d.readDoubleOrUndefined());
            const bool hasType = !order.get(u"deltaNeutralOrderType"_s)->s.isEmpty();
            if (version >= 27 && hasType) {
                integer(order, u"deltaNeutralConId"_s);
                if (readOpenOrderAttribs) {
                    str(order, u"deltaNeutralSettlingFirm"_s);
                    str(order, u"deltaNeutralClearingAccount"_s);
                    str(order, u"deltaNeutralClearingIntent"_s);
                }
            }
            if (version >= 31 && hasType) {
                if (readOpenOrderAttribs) str(order, u"deltaNeutralOpenClose"_s);
                boolean(order, u"deltaNeutralShortSale"_s);
                integer(order, u"deltaNeutralShortSaleSlot"_s);
                str(order, u"deltaNeutralDesignatedLocation"_s);
            }
        }
        integer(order, u"continuousUpdate"_s);
        if (version == 26) {
            order.set(u"stockRangeLower"_s, d.readDouble());
            order.set(u"stockRangeUpper"_s, d.readDouble());
        }
        integer(order, u"referencePriceType"_s);
    }
    void readTrailParams() {
        if (version >= 13) order.set(u"trailStopPrice"_s, d.readDoubleOrUndefined());
        if (version >= 30) order.set(u"trailingPercent"_s, d.readDoubleOrUndefined());
    }
    void readBasisPoints() {
        if (version >= 14) {
            order.set(u"basisPoints"_s, d.readDoubleOrUndefined());
            order.set(u"basisPointsType"_s, d.readIntOrUndefined());
        }
    }
    void readComboLegs() {
        if (version >= 14) str(contract, u"comboLegsDescription"_s);
        if (!(version >= 29)) return;  // TS 是 if (this.version >= 29) {…}:version 读成 NaN 时跳过
        const double comboLegsCount = d.readInt();
        if (comboLegsCount > 0) {
            contract.set(u"comboLegs"_s, arr());
            for (double i = 0; i < comboLegsCount; ++i) {
                const double conId = d.readInt();
                const double ratio = d.readInt();
                const QString action = d.readStr();
                const QString exchange = d.readStr();
                const double openClose = d.readInt();
                const double shortSaleSlot = d.readInt();
                const QString designatedLocation = d.readStr();
                const double exemptCode = d.readInt();
                contract.get(u"comboLegs"_s)
                    ->items.append(js::object({{u"conId"_s, N(conId)}, {u"ratio"_s, N(ratio)}, {u"action"_s, S(action)}, {u"exchange"_s, S(exchange)},
                                               {u"openClose"_s, N(openClose)}, {u"shortSaleSlot"_s, N(shortSaleSlot)},
                                               {u"designatedLocation"_s, S(designatedLocation)}, {u"exemptCode"_s, N(exemptCode)}}));
            }
        }
        const double orderComboLegsCount = d.readInt();
        if (orderComboLegsCount > 0) {
            order.set(u"orderComboLegs"_s, arr());
            for (double i = 0; i < orderComboLegsCount; ++i) {
                const OJson price = d.readDoubleOrUndefined();
                order.get(u"orderComboLegs"_s)->items.append(js::object({{u"price"_s, price}}));
            }
        }
    }
    void readSmartComboRoutingParams() {
        if (!(version >= 26)) return;  // TS 是 if (this.version >= 26) {…}:version 读成 NaN 时跳过
        const double count = d.readInt();
        if (count > 0) {
            order.set(u"smartComboRoutingParams"_s, arr());
            for (double i = 0; i < count; ++i) {
                const QString tag = d.readStr();
                const QString value = d.readStr();
                order.get(u"smartComboRoutingParams"_s)->items.append(js::object({{u"tag"_s, S(tag)}, {u"value"_s, S(value)}}));
            }
        }
    }
    void readScaleOrderParams() {
        if (version >= 15) {
            if (version >= 20) {
                order.set(u"scaleInitLevelSize"_s, d.readIntOrUndefined());
                order.set(u"scaleSubsLevelSize"_s, d.readIntOrUndefined());
            } else {
                d.readIntOrUndefined();  // notSuppScaleNumComponents
                order.set(u"scaleInitLevelSize"_s, d.readIntOrUndefined());
            }
            order.set(u"scalePriceIncrement"_s, d.readDoubleOrUndefined());
        }
        const OJson* inc = order.get(u"scalePriceIncrement"_s);
        // this.order.scalePriceIncrement && this.order.scalePriceIncrement > 0.0
        if (version >= 28 && inc && isNumber(*inc) && inc->n > 0.0) {
            order.set(u"scalePriceAdjustValue"_s, d.readDoubleOrUndefined());
            order.set(u"scalePriceAdjustInterval"_s, d.readIntOrUndefined());
            order.set(u"scaleProfitOffset"_s, d.readDoubleOrUndefined());
            boolean(order, u"scaleAutoReset"_s);
            order.set(u"scaleInitPosition"_s, d.readIntOrUndefined());
            order.set(u"scaleInitFillQty"_s, d.readIntOrUndefined());
            boolean(order, u"scaleRandomPercent"_s);
        }
    }
    void readHedgeParams() {
        if (version >= 24) {
            str(order, u"hedgeType"_s);
            if (!order.get(u"hedgeType"_s)->s.isEmpty()) str(order, u"hedgeParam"_s);
        }
    }
    void readOptOutSmartRouting() {
        if (version >= 25) boolean(order, u"optOutSmartRouting"_s);
    }
    void readClearingParams() {
        if (version >= 19) {
            str(order, u"clearingAccount"_s);
            str(order, u"clearingIntent"_s);
        }
    }
    void readNotHeld() {
        if (version >= 22) boolean(order, u"notHeld"_s);
    }
    void readDeltaNeutral() {
        if (version >= 20 && d.readBool()) {
            const double conId = d.readInt();
            const OJson delta = d.readDouble();
            const OJson price = d.readDouble();
            contract.set(u"deltaNeutralContract"_s, js::object({{u"conId"_s, N(conId)}, {u"delta"_s, delta}, {u"price"_s, price}}));
        }
    }
    void readAlgoParams() {
        if (!(version >= 21)) return;  // TS 是 if (this.version >= 21) {…}:version 读成 NaN 时跳过
        str(order, u"algoStrategy"_s);
        if (order.get(u"algoStrategy"_s)->s.isEmpty()) return;
        const double count = d.readInt();
        if (count > 0) {
            order.set(u"algoParams"_s, arr());
            for (double i = 0; i < count; ++i) {
                const QString tag = d.readStr();
                const QString value = d.readStr();
                order.get(u"algoParams"_s)->items.append(js::object({{u"tag"_s, S(tag)}, {u"value"_s, S(value)}}));
            }
        }
    }
    void readSolicited() {
        if (version >= 33) boolean(order, u"solicited"_s);
    }
    void readWhatIfInfoAndCommission() {
        if (!(version >= 16)) return;  // TS 是 if (this.version >= 16) {…}:version 读成 NaN 时跳过
        boolean(order, u"whatIf"_s);
        orderState.set(u"status"_s, S(d.readStr()));
        if (sv >= mv::kWhatIfExtFields) {
            for (const QString& k : {u"initMarginBefore"_s, u"maintMarginBefore"_s, u"equityWithLoanBefore"_s, u"initMarginChange"_s,
                                     u"maintMarginChange"_s, u"equityWithLoanChange"_s})
                orderState.set(k, d.readDoubleOrUndefined());
        }
        for (const QString& k : {u"initMarginAfter"_s, u"maintMarginAfter"_s, u"equityWithLoanAfter"_s, u"commission"_s, u"minCommission"_s,
                                 u"maxCommission"_s})
            orderState.set(k, d.readDoubleOrUndefined());
        orderState.set(u"commissionCurrency"_s, S(d.readStr()));
        orderState.set(u"warningText"_s, S(d.readStr()));
    }
    void readVolRandomizeFlags() {
        if (version >= 34) {
            boolean(order, u"randomizeSize"_s);
            boolean(order, u"randomizePrice"_s);
        }
    }
    void readPegToBenchParams() {
        if (sv < mv::kPeggedToBenchmark) return;
        const QString type = order.get(u"orderType"_s)->s;
        if (type == u"PEG BENCH"_s || type == u"PEGBENCH"_s) {
            integer(order, u"referenceContractId"_s);
            boolean(order, u"isPeggedChangeAmountDecrease"_s);
            order.set(u"peggedChangeAmount"_s, d.readDouble());
            order.set(u"referenceChangeAmount"_s, d.readDouble());
            str(order, u"referenceExchangeId"_s);
        }
    }
    void readConditions() {
        if (sv < mv::kPeggedToBenchmark) return;
        const double n = d.readInt();
        if (!(n > 0)) return;
        // new Array(n):超过 2^32 − 1 是 RangeError;空位(认不出的条件类型)出 JSON 是 null
        if (n > 4294967295.0) throw WireError(u"RangeError"_s, u"Invalid array length"_s);
        order.set(u"conditions"_s, arr());
        for (double i = 0; i < n; ++i) {
            const double type = d.readInt();
            const QString conj = jsToLower(d.readStr());  // toLocaleLowerCase
            OJson c = obj();
            if (type == 5) {  // Execution
                const QString secType = d.readStr();
                const QString exchange = d.readStr();
                const QString symbol = d.readStr();
                c = js::object({{u"exchange"_s, S(exchange)}, {u"secType"_s, S(secType)}, {u"symbol"_s, S(symbol)}, {u"conjunctionConnection"_s, S(conj)},
                                {u"type"_s, N(5)}});
            } else if (type == 4) {  // Margin
                const bool isMore = d.readBool();
                const double value = d.readInt();
                c = js::object({{u"percent"_s, N(value)}, {u"isMore"_s, B(isMore)}, {u"conjunctionConnection"_s, S(conj)}, {u"type"_s, N(4)}});
            } else if (type == 7) {  // PercentChange
                const bool isMore = d.readBool();
                const OJson value = d.readDouble();
                const double conId = d.readInt();
                const QString exchange = d.readStr();
                c = js::object({{u"percent"_s, value}, {u"conId"_s, N(conId)}, {u"exchange"_s, S(exchange)}, {u"isMore"_s, B(isMore)},
                                {u"conjunctionConnection"_s, S(conj)}, {u"type"_s, N(7)}});
            } else if (type == 1) {  // Price
                const bool isMore = d.readBool();
                const OJson value = d.readDouble();
                const double conId = d.readInt();
                const QString exchange = d.readStr();
                const double triggerMethod = d.readInt();
                c = js::object({{u"price"_s, value}, {u"triggerMethod"_s, N(triggerMethod)}, {u"conId"_s, N(conId)}, {u"exchange"_s, S(exchange)},
                                {u"isMore"_s, B(isMore)}, {u"conjunctionConnection"_s, S(conj)}, {u"type"_s, N(1)}});
            } else if (type == 3) {  // Time
                const bool isMore = d.readBool();
                const QString value = d.readStr();
                c = js::object({{u"time"_s, S(value)}, {u"isMore"_s, B(isMore)}, {u"conjunctionConnection"_s, S(conj)}, {u"type"_s, N(3)}});
            } else if (type == 6) {  // Volume
                const bool isMore = d.readBool();
                const double value = d.readInt();
                const double conId = d.readInt();
                const QString exchange = d.readStr();
                c = js::object({{u"volume"_s, N(value)}, {u"conId"_s, N(conId)}, {u"exchange"_s, S(exchange)}, {u"isMore"_s, B(isMore)},
                                {u"conjunctionConnection"_s, S(conj)}, {u"type"_s, N(6)}});
            } else {
                c = OJson::null();  // 空位
            }
            order.get(u"conditions"_s)->items.append(c);
        }
        boolean(order, u"conditionsIgnoreRth"_s);
        boolean(order, u"conditionsCancelOrder"_s);
    }
    void readAdjustedOrderParams() {
        if (sv < mv::kPeggedToBenchmark) return;
        str(order, u"adjustedOrderType"_s);
        order.set(u"triggerPrice"_s, d.readDoubleOrUndefined());
        order.set(u"trailStopPrice"_s, d.readDoubleOrUndefined());  // readStopPriceAndLmtPriceOffset
        order.set(u"lmtPriceOffset"_s, d.readDoubleOrUndefined());
        order.set(u"adjustedStopPrice"_s, d.readDoubleOrUndefined());
        order.set(u"adjustedStopLimitPrice"_s, d.readDoubleOrUndefined());
        order.set(u"adjustedTrailingAmount"_s, d.readDoubleOrUndefined());
        integer(order, u"adjustableTrailingUnit"_s);
    }
    void readSoftDollarTier() {
        if (sv < mv::kSoftDollarTier) return;
        const QString name = d.readStr();
        const QString value = d.readStr();
        const QString displayName = d.readStr();
        order.set(u"softDollarTier"_s, js::object({{u"name"_s, S(name)}, {u"value"_s, S(value)}, {u"displayName"_s, S(displayName)}}));
    }
    void readCashQty() {
        if (sv >= mv::kCashQty) order.set(u"cashQty"_s, d.readDoubleOrUndefined());
    }
    void readDontUseAutoPriceForHedge() {
        if (sv >= mv::kAutoPriceForHedge) boolean(order, u"dontUseAutoPriceForHedge"_s);
    }
    void readIsOmsContainer() {
        if (sv >= mv::kOrderContainer) boolean(order, u"isOmsContainer"_s);
    }
    void readDiscretionaryUpToLimitPrice() {
        if (sv >= mv::kDPegOrders) boolean(order, u"discretionaryUpToLimitPrice"_s);
    }
    void readUsePriceMgmtAlgo() {
        if (sv >= mv::kPriceMgmtAlgo) boolean(order, u"usePriceMgmtAlgo"_s);
    }
    void readDuration() {
        if (sv >= mv::kDuration) integer(order, u"duration"_s);
    }
    void readPostToAts() {
        if (sv >= mv::kPostToAts) order.set(u"postToAts"_s, d.readIntOrUndefined());
    }
    void readAutoCancelParent() {
        if (sv >= mv::kAutoCancelParent) boolean(order, u"autoCancelParent"_s);
    }
    void readPegBestPegMidOrderAttributes() {
        if (sv < mv::kPegbestPegmidOffsets) return;
        order.set(u"minTradeQty"_s, d.readIntOrUndefined());
        order.set(u"minCompeteSize"_s, d.readIntOrUndefined());
        order.set(u"competeAgainstBestOffset"_s, d.readDoubleOrUndefined());
        order.set(u"midOffsetAtWhole"_s, d.readDoubleOrUndefined());
        order.set(u"midOffsetAtHalf"_s, d.readDoubleOrUndefined());
    }
    void readCustomerAccount() {
        if (sv >= mv::kCustomerAccount) str(order, u"customerAccount"_s);
    }
    void readProfessionalCustomer() {
        if (sv >= mv::kProfessionalCustomer) boolean(order, u"professionalCustomer"_s);
    }
    void readBondAccruedInterest() {
        if (sv >= mv::kBondAccruedInterest) str(order, u"bondAccruedInterest"_s);
    }
    void readIncludeOvernight() {
        if (sv >= mv::kIncludeOvernight) boolean(order, u"includeOvernight"_s);
    }
    void readCMETaggingFields() {
        if (sv >= mv::kCmeTaggingFieldsInOpenOrder) {
            str(order, u"extOperator"_s);
            order.set(u"manualOrderIndicator"_s, d.readIntOrUndefined());
        }
    }

private:
    void str(OJson& o, const QString& k) { o.set(k, S(d.readStr())); }
    void integer(OJson& o, const QString& k) { o.set(k, N(d.readInt())); }
    void boolean(OJson& o, const QString& k) { o.set(k, B(d.readBool())); }

    Decoder& d;
    OJson& contract;
    OJson& order;
    OJson& orderState;
    const double version;
    const int sv;
};

void openOrder(Decoder& d) {
    const double version = d.serverVersion() < mv::kOrderContainer ? d.readInt() : d.serverVersion();
    OJson contract = obj();
    OJson order = js::object({{u"orderType"_s, S(u"MKT"_s)}});  // 后面会被盖掉
    OJson orderState = js::object({{u"status"_s, S(u"Unknown"_s)}});
    OrderDecoder o(d, contract, order, orderState, version);
    o.readOrderId();
    o.readContractFields();
    o.readAction();
    o.readTotalQuantity();
    o.readOrderType();
    o.readLmtPrice();
    o.readAuxPrice();
    o.readTIF();
    o.readOcaGroup();
    o.readAccount();
    o.readOpenClose();
    o.readOrigin();
    o.readOrderRef();
    o.readClientId();
    o.readPermId();
    o.readOutsideRth();
    o.readHidden();
    o.readDiscretionaryAmount();
    o.readGoodAfterTime();
    o.skipSharesAllocation();
    o.readFAParams();
    o.readModelCode();
    o.readGoodTillDate();
    o.readRule80A();
    o.readPercentOffset();
    o.readSettlingFirm();
    o.readShortSaleParams();
    o.readAuctionStrategy();
    o.readBoxOrderParams();
    o.readPegToStkOrVolOrderParams();
    o.readDisplaySize();
    o.readOldStyleOutsideRth();
    o.readBlockOrder();
    o.readSweepToFill();
    o.readAllOrNone();
    o.readMinQty();
    o.readOcaType();
    o.readETradeOnly();
    o.readFirmQuoteOnly();
    o.readNbboPriceCap();
    o.readParentId();
    o.readTriggerMethod();
    o.readVolOrderParams(true);
    o.readTrailParams();
    o.readBasisPoints();
    o.readComboLegs();
    o.readSmartComboRoutingParams();
    o.readScaleOrderParams();
    o.readHedgeParams();
    o.readOptOutSmartRouting();
    o.readClearingParams();
    o.readNotHeld();
    o.readDeltaNeutral();
    o.readAlgoParams();
    o.readSolicited();
    o.readWhatIfInfoAndCommission();
    o.readVolRandomizeFlags();
    o.readPegToBenchParams();
    o.readConditions();
    o.readAdjustedOrderParams();
    o.readSoftDollarTier();
    o.readCashQty();
    o.readDontUseAutoPriceForHedge();
    o.readIsOmsContainer();
    o.readDiscretionaryUpToLimitPrice();
    o.readUsePriceMgmtAlgo();
    o.readDuration();
    o.readPostToAts();
    o.readAutoCancelParent();
    o.readPegBestPegMidOrderAttributes();
    o.readCustomerAccount();
    o.readProfessionalCustomer();
    o.readBondAccruedInterest();
    o.readIncludeOvernight();
    o.readCMETaggingFields();
    d.queueEvent(u"openOrder"_s, {*order.get(u"orderId"_s), contract, order, orderState});
}

void nextValidId(Decoder& d) {
    d.readInt();  // 版本
    d.queueEvent(u"nextValidId"_s, {N(d.readInt())});
}

void contractData(Decoder& d) {
    const int sv = d.serverVersion();
    double version = 8;
    if (sv < mv::kSizeRules) version = d.readInt();
    double reqId = -1;
    if (version >= 3) reqId = d.readInt();
    OJson details = js::object({{u"contract"_s, obj()}});
    const auto c = [&]() -> OJson& { return *details.get(u"contract"_s); };
    c().set(u"symbol"_s, S(d.readStr()));
    c().set(u"secType"_s, S(d.readStr()));
    // readLastTradeDate:有 "-"(不在开头)按它切,否则按字面的 "\s+" 切(库的写法,不是正则,实际不切)
    const QString lastTrade = d.readStr();
    if (!lastTrade.isEmpty()) {
        const QStringList split = lastTrade.indexOf(u'-') > 0 ? lastTrade.split(u'-') : lastTrade.split(u"\\s+"_s);
        c().set(u"lastTradeDateOrContractMonth"_s, S(split[0]));
        if (split.size() > 1) details.set(u"lastTradeTime"_s, S(split[1]));
    }
    if (sv >= mv::kLastTradeDate) c().set(u"lastTradeDate"_s, S(d.readStr()));
    c().set(u"strike"_s, d.readDouble());
    c().set(u"right"_s, optionType(d.readStr()));
    c().set(u"exchange"_s, S(d.readStr()));
    c().set(u"currency"_s, S(d.readStr()));
    c().set(u"localSymbol"_s, S(d.readStr()));
    details.set(u"marketName"_s, S(d.readStr()));
    c().set(u"tradingClass"_s, S(d.readStr()));
    c().set(u"conId"_s, N(d.readInt()));
    details.set(u"minTick"_s, d.readDouble());
    if (sv >= mv::kMdSizeMultiplier && sv < mv::kSizeRules) d.readInt();  // mdSizeMultiplier,早已不用
    c().set(u"multiplier"_s, d.readDouble());
    details.set(u"orderTypes"_s, S(d.readStr()));
    details.set(u"validExchanges"_s, S(d.readStr()));
    if (version >= 2) details.set(u"priceMagnifier"_s, N(d.readInt()));
    if (version >= 4) details.set(u"underConId"_s, N(d.readInt()));
    if (version >= 5) {
        details.set(u"longName"_s, S(d.readStr()));
        c().set(u"primaryExch"_s, S(d.readStr()));
        if (sv >= mv::kEncodeMsgAscii7) details.set(u"longName"_s, S(decodeUnicodeEscapes(details.get(u"longName"_s)->s)));
    }
    if (version >= 6) {
        for (const QString& k : {u"contractMonth"_s, u"industry"_s, u"category"_s, u"subcategory"_s, u"timeZoneId"_s, u"tradingHours"_s, u"liquidHours"_s})
            details.set(k, S(d.readStr()));
    }
    if (version >= 8) {
        details.set(u"evRule"_s, S(d.readStr()));
        details.set(u"evMultiplier"_s, d.readDouble());
    }
    if (version >= 7) {
        const double count = d.readInt();
        if (count > 0) {
            details.set(u"secIdList"_s, arr());
            for (double i = 0; i < count; ++i) {
                const QString tag = d.readStr();
                const QString value = d.readStr();
                details.get(u"secIdList"_s)->items.append(js::object({{u"tag"_s, S(tag)}, {u"value"_s, S(value)}}));
            }
        }
    }
    if (sv >= mv::kAggGroup) details.set(u"aggGroup"_s, N(d.readInt()));
    if (sv >= mv::kUnderlyingInfo) {
        details.set(u"underSymbol"_s, S(d.readStr()));
        details.set(u"underSecType"_s, S(d.readStr()));
    }
    if (sv >= mv::kMarketRules) details.set(u"marketRuleIds"_s, S(d.readStr()));
    if (sv >= mv::kRealExpirationDate) details.set(u"realExpirationDate"_s, S(d.readStr()));
    if (sv >= mv::kStockType) details.set(u"stockType"_s, S(d.readStr()));
    if (sv >= mv::kFractionalSizeSupport && sv < mv::kSizeRules) d.readDecimal();  // sizeMinTick,早已不用
    if (sv >= mv::kSizeRules) {
        details.set(u"minSize"_s, d.readDecimal());
        details.set(u"sizeIncrement"_s, d.readDecimal());
        details.set(u"suggestedSizeIncrement"_s, d.readDecimal());
    }
    if (sv >= mv::kFundDataFields && c().get(u"secType"_s)->s == u"FUND"_s) {
        for (const QString& k : {u"fundName"_s, u"fundFamily"_s, u"fundType"_s, u"fundFrontLoad"_s, u"fundBackLoad"_s, u"fundBackLoadTimeInterval"_s,
                                 u"fundManagementFee"_s})
            details.set(k, S(d.readStr()));
        for (const QString& k : {u"fundClosed"_s, u"fundClosedForNewInvestors"_s, u"fundClosedForNewMoney"_s}) details.set(k, B(d.readBool()));
        for (const QString& k : {u"fundNotifyAmount"_s, u"fundMinimumInitialPurchase"_s, u"fundSubsequentMinimumPurchase"_s, u"fundBlueSkyStates"_s,
                                 u"fundBlueSkyTerritories"_s, u"fundDistributionPolicyIndicator"_s, u"fundAssetType"_s})
            details.set(k, S(d.readStr()));
    }
    if (sv >= mv::kIneligibilityReasons) {
        const double count = d.readInt();
        OJson list = arr();
        for (double i = 0; i < count; ++i) {
            const QString id = d.readStr();
            const QString description = d.readStr();
            list.items.append(js::object({{u"id"_s, S(id)}, {u"description"_s, S(description)}}));
        }
        details.set(u"ineligibilityReasonList"_s, list);
    }
    d.queueEvent(u"contractDetails"_s, {N(reqId), details});
}

void executionData(Decoder& d) {
    const int sv = d.serverVersion();
    double version = sv;
    if (version < mv::kLastLiquidity) version = d.readInt();
    double reqId = -1;
    if (version >= 7) reqId = d.readInt();
    const double orderId = d.readInt();
    OJson c = obj();
    if (version >= 5) c.set(u"conId"_s, N(d.readInt()));
    c.set(u"symbol"_s, S(d.readStr()));
    c.set(u"secType"_s, S(d.readStr()));
    c.set(u"lastTradeDateOrContractMonth"_s, S(d.readStr()));
    c.set(u"strike"_s, d.readDouble());
    c.set(u"right"_s, optionType(d.readStr()));
    if (version >= 9) c.set(u"multiplier"_s, d.readDouble());
    c.set(u"exchange"_s, S(d.readStr()));
    c.set(u"currency"_s, S(d.readStr()));
    c.set(u"localSymbol"_s, S(d.readStr()));
    if (version >= 10) c.set(u"tradingClass"_s, S(d.readStr()));
    OJson e = obj();
    e.set(u"orderId"_s, N(orderId));
    for (const QString& k : {u"execId"_s, u"time"_s, u"acctNumber"_s, u"exchange"_s, u"side"_s}) e.set(k, S(d.readStr()));
    e.set(u"shares"_s, d.readDecimal());
    e.set(u"price"_s, d.readDouble());
    if (version >= 2) e.set(u"permId"_s, N(d.readInt()));
    if (version >= 3) e.set(u"clientId"_s, N(d.readInt()));
    if (version >= 4) e.set(u"liquidation"_s, N(d.readInt()));
    if (version >= 6) {
        e.set(u"cumQty"_s, d.readDecimal());
        e.set(u"avgPrice"_s, d.readDouble());
    }
    if (version >= 8) e.set(u"orderRef"_s, S(d.readStr()));
    if (version >= 9) {
        e.set(u"evRule"_s, S(d.readStr()));
        e.set(u"evMultiplier"_s, d.readDouble());
    }
    if (sv >= mv::kModelsSupport) e.set(u"modelCode"_s, S(d.readStr()));
    if (sv >= mv::kLastLiquidity) e.set(u"lastLiquidity"_s, N(d.readInt()));
    if (sv >= mv::kPendingPriceRevision) e.set(u"pendingPriceRevision"_s, B(d.readBool()));
    d.queueEvent(u"execDetails"_s, {N(reqId), c, e});
}

void marketDepth(Decoder& d) {
    d.readInt();  // 版本
    const double id = d.readInt();
    const double position = d.readInt();
    const double operation = d.readInt();
    const double side = d.readInt();
    const OJson price = d.readDouble();
    const OJson size = d.readDecimal();
    d.queueEvent(u"updateMktDepth"_s, {N(id), N(position), N(operation), N(side), price, size});
}

void marketDepthL2(Decoder& d) {
    d.readInt();  // 版本
    const double id = d.readInt();
    const double position = d.readInt();
    const QString marketMaker = d.readStr();
    const double operation = d.readInt();
    const double side = d.readInt();
    const OJson price = d.readDouble();
    const OJson size = d.readDecimal();
    OJson isSmartDepth = undef();
    if (d.serverVersion() >= mv::kSmartDepth) isSmartDepth = B(d.readBool());
    d.queueEvent(u"updateMktDepthL2"_s, {N(id), N(position), S(marketMaker), N(operation), N(side), price, size, isSmartDepth});
}

void managedAccts(Decoder& d) {
    d.readInt();  // 版本
    d.queueEvent(u"managedAccounts"_s, {S(d.readStr())});
}

void historicalData(Decoder& d) {
    const int sv = d.serverVersion();
    double version = kMaxSafeInteger;
    if (sv < mv::kSyntRealtimeBars) version = d.readInt();
    const double reqId = d.readInt();
    QString completedIndicator = u"finished"_s;
    if (version >= 2) {
        const QString start = d.readStr();
        const QString end = d.readStr();
        completedIndicator += u'-' + start + u'-' + end;
    }
    double itemCount = d.readInt();
    // while (itemCount--):先看旧值真不真(NaN、0 停),再减一;负数一直读到读不够
    for (;;) {
        const double was = itemCount;
        itemCount = was - 1;
        if (was == 0 || std::isnan(was)) break;
        const QString date = d.readStr();
        const OJson open = d.readDouble();
        const OJson high = d.readDouble();
        const OJson low = d.readDouble();
        const OJson close = d.readDouble();
        const OJson volume = d.readDecimal();
        const OJson wap = d.readDecimal();
        OJson hasGaps = undef();
        if (sv < mv::kSyntRealtimeBars) hasGaps = B(d.readBool());
        OJson barCount = undef();
        if (version >= 3) barCount = N(d.readInt());
        d.queueEvent(u"historicalData"_s, {N(reqId), S(date), open, high, low, close, volume, barCount, wap, hasGaps});
    }
    // 收尾的那一条
    d.queueEvent(u"historicalData"_s, {N(reqId), S(completedIndicator), N(-1), N(-1), N(-1), N(-1), N(-1), N(-1), N(-1), B(false)});
}

void historicalDataUpdate(Decoder& d) {
    const double reqId = d.readInt();
    const double barCount = d.readInt();
    const QString date = d.readStr();
    const OJson open = d.readDouble();
    const OJson close = d.readDouble();  // 库的次序:close 在 high、low 之前
    const OJson high = d.readDouble();
    const OJson low = d.readDouble();
    const OJson wap = d.readDecimal();
    const OJson volume = d.readDecimal();
    d.queueEvent(u"historicalDataUpdate"_s, {N(reqId), S(date), open, high, low, close, volume, N(barCount), wap});
}

void tickOptionComputation(Decoder& d) {
    const int sv = d.serverVersion();
    const double version = sv >= mv::kPriceBasedVolatility ? kMaxDouble : d.readInt();
    const double tickerId = d.readInt();
    const double tickType = d.readInt();
    OJson tickAttrib = undef();
    if (sv >= mv::kPriceBasedVolatility) tickAttrib = N(d.readInt());
    // -1 / -2 是"还没算出来"
    const auto notYet = [](const OJson& v, double mark) { return isNumber(v) && v.n == mark ? undef() : v; };
    const OJson impliedVol = notYet(d.readDouble(), -1);
    const OJson delta = notYet(d.readDouble(), -2);
    OJson optPrice = undef(), pvDividend = undef(), gamma = undef(), vega = undef(), theta = undef(), undPrice = undef();
    if (version >= 6 || tickType == 13 || tickType == 83) {  // MODEL_OPTION / DELAYED_MODEL_OPTION
        optPrice = notYet(d.readDouble(), -1);
        pvDividend = notYet(d.readDouble(), -1);
    }
    if (version >= 6) {
        gamma = notYet(d.readDouble(), -2);
        vega = notYet(d.readDouble(), -2);
        theta = notYet(d.readDouble(), -2);
        undPrice = notYet(d.readDouble(), -1);
    }
    d.queueEvent(u"tickOptionComputation"_s, {N(tickerId), N(tickType), tickAttrib, impliedVol, delta, optPrice, pvDividend, gamma, vega, theta, undPrice});
}

void tickGeneric(Decoder& d) {
    d.readInt();  // 版本
    const double tickerId = d.readInt();
    const double tickType = d.readInt();
    const OJson value = d.readDouble();
    d.queueEvent(u"tickGeneric"_s, {N(tickerId), N(tickType), value});
}

void tickString(Decoder& d) {
    d.readInt();  // 版本
    const double tickerId = d.readInt();
    const double tickType = d.readInt();
    const QString value = d.readStr();
    d.queueEvent(u"tickString"_s, {N(tickerId), N(tickType), S(value)});
}

void currentTime(Decoder& d) {
    d.readInt();  // 版本
    d.queueEvent(u"currentTime"_s, {N(d.readInt())});
}

/// 只有一个 reqId 的收尾消息(前面一格版本)
void versionedEnd(Decoder& d, const QString& name) {
    d.readInt();  // 版本
    d.queueEvent(name, {N(d.readInt())});
}

void commissionReport(Decoder& d) {
    d.readInt();  // 版本
    OJson r = obj();
    r.set(u"execId"_s, S(d.readStr()));
    r.set(u"commission"_s, d.readDouble());
    r.set(u"currency"_s, S(d.readStr()));
    r.set(u"realizedPNL"_s, d.readDouble());
    r.set(u"yield"_s, d.readDouble());
    r.set(u"yieldRedemptionDate"_s, N(d.readInt()));
    d.queueEvent(u"commissionReport"_s, {r});
}

void position(Decoder& d) {
    const double version = d.readInt();
    const QString account = d.readStr();
    OJson c = obj();
    c.set(u"conId"_s, N(d.readInt()));
    c.set(u"symbol"_s, S(d.readStr()));
    c.set(u"secType"_s, S(d.readStr()));
    c.set(u"lastTradeDateOrContractMonth"_s, S(d.readStr()));
    c.set(u"strike"_s, d.readDouble());
    c.set(u"right"_s, optionType(d.readStr()));
    c.set(u"multiplier"_s, d.readDouble());
    c.set(u"exchange"_s, S(d.readStr()));
    c.set(u"currency"_s, S(d.readStr()));
    c.set(u"localSymbol"_s, S(d.readStr()));
    if (version >= 2) c.set(u"tradingClass"_s, S(d.readStr()));
    const OJson pos = d.readDecimal();
    OJson avgCost = N(0);
    if (version >= 3) avgCost = d.readDouble();
    d.queueEvent(u"position"_s, {S(account), c, pos, avgCost});
}

void accountSummary(Decoder& d) {
    d.readInt();  // 版本
    const double reqId = d.readInt();
    const QString account = d.readStr();
    const QString tag = d.readStr();
    const QString value = d.readStr();
    const QString currency = d.readStr();
    d.queueEvent(u"accountSummary"_s, {N(reqId), S(account), S(tag), S(value), S(currency)});
}

void secDefOptParameter(Decoder& d) {
    const double reqId = d.readInt();
    const QString exchange = d.readStr();
    const double underlyingConId = d.readInt();
    const QString tradingClass = d.readStr();
    const OJson multiplier = d.readDouble();
    const double expCount = d.readInt();
    OJson expirations = arr();
    for (double i = 0; i < expCount; ++i) expirations.items.append(S(d.readStr()));
    const double strikeCount = d.readInt();
    OJson strikes = arr();
    for (double j = 0; j < strikeCount; ++j) {
        const OJson strike = d.readDouble();
        if (!isUndef(strike)) strikes.items.append(strike);
    }
    d.queueEvent(u"securityDefinitionOptionParameter"_s, {N(reqId), S(exchange), N(underlyingConId), S(tradingClass), multiplier, expirations, strikes});
}

void tickReqParams(Decoder& d) {
    const double tickerId = d.readInt();
    const double minTick = d.readInt();  // 库按整数读 minTick(0.01 读成 0),照搬
    const QString bboExchange = d.readStr();
    const double snapshotPermissions = d.readInt();
    d.queueEvent(u"tickReqParams"_s, {N(tickerId), N(minTick), S(bboExchange), N(snapshotPermissions)});
}

void pnl(Decoder& d) {
    const double reqId = d.readInt();
    const OJson daily = d.readDouble();
    OJson unrealized = undef(), realized = undef();
    if (d.serverVersion() >= mv::kUnrealizedPnl) unrealized = d.readDouble();
    if (d.serverVersion() >= mv::kRealizedPnl) realized = d.readDouble();
    d.queueEvent(u"pnl"_s, {N(reqId), daily, unrealized, realized});
}

void orderBound(Decoder& d) {
    const double permId = d.readInt();
    const OJson clientId = d.readDouble();
    const double orderId = d.readInt();
    d.queueEvent(u"orderBound"_s, {N(permId), clientId, N(orderId)});
}

}  // namespace

// ---------------------------------------------------------------- Decoder

QString inMsgName(double msgId) {
    for (const auto& [id, name] : inMsgIds())
        if (msgId == id) return name;
    return u"undefined"_s;
}

void Decoder::enqueueMessage(const QStringList& tokens) {
    queue_.push_back(std::nullopt);
    for (const QString& t : tokens) queue_.push_back(t);
    queue_.push_back(std::nullopt);
}

QString Decoder::readStr() {
    if (queue_.empty()) throw Underrun{u"An underrun error has occurred"_s};
    std::optional<QString> v = std::move(queue_.front());
    queue_.pop_front();
    if (!v) throw Underrun{u"End of message reached."_s};
    return *v;
}

bool Decoder::readBool() {
    const double v = parseIntNoRadix(readStr());
    return v != 0 && !std::isnan(v);
}

double Decoder::readInt() {
    const QString token = readStr();
    if (token.isEmpty()) return 0;
    return util::jsParseInt(token, 10);
}

OJson Decoder::readIntOrUndefined() {
    const QString token = readStr();
    if (token.isEmpty()) return undef();
    const double v = util::jsParseInt(token, 10);
    return v == 2147483647 ? undef() : N(v);
}

OJson Decoder::readDouble() {
    const QString token = readStr();
    if (token.isEmpty()) return N(0);
    const double v = util::jsParseFloat(token);
    return v == kMaxDouble ? undef() : N(v);
}

OJson Decoder::readDoubleOrUndefined() {
    const QString token = readStr();
    if (token.isEmpty()) return undef();
    const double v = util::jsParseFloat(token);
    return v == kMaxDouble ? undef() : N(v);
}

OJson Decoder::readDecimal() {
    QString token = readStr();
    if (token.isEmpty()) return undef();
    const double v = util::jsParseFloat(token.remove(u','));
    return v == kMaxDouble || v == kInf ? undef() : N(v);
}

void Decoder::queueEvent(const QString& name, const QList<OJson>& args) { emitQueue_.push_back({name, js::array(args)}); }

void Decoder::emitDirect(const Emit& e) { out_->push_back({e.name, finalize(e.args)}); }

void Decoder::drainQueue() {
    while (!queue_.empty() && queue_.front()) queue_.pop_front();
    if (!queue_.empty()) queue_.pop_front();
}

/// emitError(话, code, reqId, advanced) 经 Controller:[话, code, reqId ?? -1, advanced]
static Emit errorEmit(const QString& message, double code, const OJson& reqId = undef(), const OJson& advanced = undef()) {
    return {u"error"_s, js::array({S(message), N(code), isUndef(reqId) ? N(-1) : reqId, advanced})};
}

void Decoder::decodeErrMsg() {
    const double version = readInt();
    if (version < 2) {
        const QString message = readStr();
        emitDirect(errorEmit(message, kUnknownId));
        return;
    }
    const double id = readInt();
    const double code = readInt();
    QString message = readStr();
    if (serverVersion_ >= mv::kEncodeMsgAscii7) message = decodeUnicodeEscapes(message);
    OJson advanced = undef();
    if (serverVersion_ >= mv::kAdvancedOrderReject) {
        const QString json = readStr();
        if (!json.isEmpty()) {
            const QString text = decodeUnicodeEscapes(json);
            if (const auto why = util::v8JsonParseError(text)) throw WireError(u"SyntaxError"_s, *why);
            const auto parsedAdvanced = util::parseOJson(text);
            if (!parsedAdvanced) throw WireError(u"RangeError"_s, u"Maximum call stack size exceeded"_s);  // 超过 parseOJson 的嵌套深度上限
            advanced = *parsedAdvanced;
        }
    }
    if (id == -1) emitDirect({u"info"_s, js::array({S(message), N(code)})});
    else emitDirect(errorEmit(message, code, N(id), advanced));
}

void Decoder::processMsg(double id) {
    if (id == 1) tickPrice(*this);
    else if (id == 2) tickSize(*this);
    else if (id == 3) orderStatus(*this);
    else if (id == 4) decodeErrMsg();
    else if (id == 5) openOrder(*this);
    else if (id == 9) nextValidId(*this);
    else if (id == 10) contractData(*this);
    else if (id == 11) executionData(*this);
    else if (id == 12) marketDepth(*this);
    else if (id == 13) marketDepthL2(*this);
    else if (id == 15) managedAccts(*this);
    else if (id == 17) historicalData(*this);
    else if (id == 21) tickOptionComputation(*this);
    else if (id == 45) tickGeneric(*this);
    else if (id == 46) tickString(*this);
    else if (id == 49) currentTime(*this);
    else if (id == 52) versionedEnd(*this, u"contractDetailsEnd"_s);
    else if (id == 53) {
        readInt();  // 版本
        queueEvent(u"openOrderEnd"_s, {});
    } else if (id == 55) versionedEnd(*this, u"execDetailsEnd"_s);
    else if (id == 57) versionedEnd(*this, u"tickSnapshotEnd"_s);
    else if (id == 58) {
        readInt();  // 版本
        const double reqId = readInt();
        const double type = readInt();
        queueEvent(u"marketDataType"_s, {N(reqId), N(type)});
    } else if (id == 59) commissionReport(*this);
    else if (id == 61) position(*this);
    else if (id == 62) {
        readInt();  // 版本
        queueEvent(u"positionEnd"_s, {});
    } else if (id == 63) accountSummary(*this);
    else if (id == 64) versionedEnd(*this, u"accountSummaryEnd"_s);
    else if (id == 75) secDefOptParameter(*this);
    else if (id == 76) queueEvent(u"securityDefinitionOptionParameterEnd"_s, {N(readInt())});
    else if (id == 81) tickReqParams(*this);
    else if (id == 90) historicalDataUpdate(*this);
    else if (id == 94) pnl(*this);
    else if (id == 100) orderBound(*this);
    else if (unported(id)) {
        // 库里有、这里没搬:整条跳过,留个记号
        while (!queue_.empty() && queue_.front()) queue_.pop_front();
        queueEvent(u"__unported__"_s, {N(id)});
    } else {
        emitDirect(errorEmit(u"No parser implementation found for token: %1 (%2)."_s.arg(inMsgName(id), util::jsNumberToString(id)), kUnknownId));
    }
}

void Decoder::process(std::vector<Emit>& out) {
    out_ = &out;
    while (!queue_.empty()) {
        emitQueue_.clear();
        bool verifyMessageBoundary = false;
        if (!queue_.front()) {
            verifyMessageBoundary = true;
            queue_.pop_front();
        }
        double msgId = -1;  // IN_MSG_ID.UNDEFINED
        try {
            msgId = readInt();
            processMsg(msgId);
            if (verifyMessageBoundary) {
                if (!queue_.empty() && queue_.front()) {
                    OJson left = arr();
                    for (const auto& t : queue_) left.items.append(t ? S(*t) : OJson::null());
                    emitDirect(errorEmit(u"Decoding error on %1: unprocessed data left on queue (%2)."_s.arg(inMsgName(msgId), js::stringify(left)) + kReport,
                                         kUnknownId));
                }
                drainQueue();
            }
        } catch (const Underrun& e) {
            if (verifyMessageBoundary) emitDirect(errorEmit(u"Underrun error on %1: %2"_s.arg(inMsgName(msgId), e.message) + kReport, kUnknownId));
            drainQueue();
        }
        for (const Emit& e : emitQueue_) out.push_back({e.name, finalize(e.args)});
        emitQueue_.clear();
    }
}

std::vector<Emit> decode(int serverVersion, const QStringList& tokens) {
    Decoder d(serverVersion);
    d.enqueueMessage(tokens);
    std::vector<Emit> out;
    d.process(out);
    return out;
}

}  // namespace ibkr::tws::wire
