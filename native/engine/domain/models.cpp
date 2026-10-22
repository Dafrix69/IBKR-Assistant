#include "domain/models.h"

#include "util/error.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/tz.h"

#include <QRegularExpression>

#include <cmath>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace z = ibkr::util::zod;
namespace js = ibkr::util::js;

namespace ibkr::domain::models {

namespace {

bool symbolOk(const QString& v) {
    static const QRegularExpression re(u"^[A-Z][A-Z0-9.\\-]{0,11}\\z"_s);
    return re.match(v).hasMatch();
}

bool asciiDigits(const QString& s) {
    for (QChar c : s)
        if (c < u'0' || c > u'9') return false;
    return !s.isEmpty();
}

// pydantic 的宽松数值:float 字段接受数字与数字字符串;int 字段接受整数值的 float 与整数字符串,拒绝 100.5
z::SchemaPtr looseFloat() {
    return z::preprocess(
        [](const OJson* v, z::CheckCtx&) -> std::optional<OJson> {
            if (v && v->type == OJson::String) {
                const QString t = util::jsTrim(v->s);
                const double n = util::jsStringToNumber(t);
                if (!t.isEmpty() && !std::isnan(n)) return OJson::number(n);
            }
            return v ? std::optional<OJson>(*v) : std::nullopt;
        },
        z::number()->finite());
}

z::SchemaPtr looseInt() {
    return z::preprocess(
        [](const OJson* v, z::CheckCtx&) -> std::optional<OJson> {
            if (v && v->type == OJson::String) {
                QString t = util::jsTrim(v->s);
                const QString digits = t.startsWith(u'+') || t.startsWith(u'-') ? t.mid(1) : t;
                if (asciiDigits(digits)) return OJson::number(util::jsStringToNumber(t));
            }
            return v ? std::optional<OJson>(*v) : std::nullopt;
        },
        z::number()->integer());
}

void checkExpiry(const OJson& value, z::CheckCtx& ctx) {
    const QString v = value.s;
    if (v.size() != 8 || !asciiDigits(v)) {
        ctx.addIssue(u"到期日必须是 YYYYMMDD 8 位数字"_s);
        return;
    }
    if (!util::isValidYmd(v.left(4).toDouble(), v.mid(4, 2).toDouble(), v.mid(6, 2).toDouble())) ctx.addIssue(u"到期日不是合法日期: "_s + v);
}

z::SchemaPtr makeSymbolField(std::function<QString(const QString&)> describe) {
    return z::string()
        ->transform([](const OJson& v, z::CheckCtx&) { return OJson::string(util::jsTrim(v.s).toUpper()); })
        ->superRefine([describe](const OJson& v, z::CheckCtx& ctx) {
            if (!symbolOk(v.s)) ctx.addIssue(describe(v.s));
        });
}

z::SchemaPtr expiryField() { return z::str()->trim()->superRefine(checkExpiry); }

/// 空串 / 纯空白 / 数值等于 100 的写法一律归一成 "100",别的值原样留着(由校验层按"只支持 100"拒绝)
z::SchemaPtr multiplierField() {
    return z::string()
        ->transform([](const OJson& v, z::CheckCtx&) {
            const QString t = util::jsTrim(v.s);
            return OJson::string(t.isEmpty() || util::jsStringToNumber(t) == 100 ? u"100"_s : t);
        })
        ->defaulted(OJson::string(u"100"_s));
}

const OJson* f(const OJson& o, const char16_t* k) { return o.get(QString::fromUtf16(k)); }
bool isNull(const OJson* v) { return v && v->type == OJson::Null; }  // TS 的 `=== null`(undefined 不算)
bool notNull(const OJson* v) { return !isNull(v); }                 // TS 的 `!== null`

z::SchemaPtr makeLeg() {
    return z::object({{u"action"_s, z::enumOf(kActions)},
                      {u"ratio"_s, looseInt()->pipe(z::number()->min(1)->max(2))},
                      {u"lastTradeDateOrContractMonth"_s, expiryField()},
                      {u"strike"_s, looseFloat()->pipe(z::number()->gt(0))},
                      {u"right"_s, z::enumOf(kRights)},
                      {u"tradingClass"_s, z::str()->trim()->nullable()->defaulted(OJson::null())},
                      {u"multiplier"_s, multiplierField()}})
        ->strict();
}

z::SchemaPtr makeContract() {
    return z::object({{u"secType"_s, z::enumOf(kSecTypes)},
                      {u"symbol"_s, makeSymbolField([](const QString& v) { return u"标的代码必须是大写字母/数字组成的 ticker: '%1'"_s.arg(v); })},
                      {u"exchange"_s, z::str()->trim()->defaulted(OJson::string(u"SMART"_s))},
                      {u"currency"_s, z::literal(OJson::string(u"USD"_s))->defaulted(OJson::string(u"USD"_s))},
                      {u"lastTradeDateOrContractMonth"_s, expiryField()->nullable()->defaulted(OJson::null())},
                      {u"strike"_s, looseFloat()->pipe(z::number()->gt(0))->nullable()->defaulted(OJson::null())},
                      {u"right"_s, z::enumOf(kRights)->nullable()->defaulted(OJson::null())},
                      {u"multiplier"_s, multiplierField()},
                      {u"tradingClass"_s, z::str()->trim()->nullable()->defaulted(OJson::null())},
                      {u"combo_strategy"_s, z::enumOf({u"VERTICAL"_s, u"BUTTERFLY"_s, u"IRON_CONDOR"_s})->nullable()->defaulted(OJson::null())},
                      {u"legs"_s, z::array(legSchema().shared_from_this())->nullable()->defaulted(OJson::null())}})
        ->strict()
        ->superRefine([](const OJson& c, z::CheckCtx& ctx) {
            const OJson* optFields[] = {f(c, u"lastTradeDateOrContractMonth"), f(c, u"strike"), f(c, u"right")};
            const OJson* legs = f(c, u"legs");
            const bool legsNonEmpty = legs && legs->type == OJson::Array && !legs->items.isEmpty();  // c.legs && c.legs.length
            const QString sec = js::str(f(c, u"secType"));
            if (sec == u"STK") {
                bool any = false;
                for (const OJson* o : optFields) any = any || notNull(o);
                if (any || legsNonEmpty || js::truthy(f(c, u"combo_strategy"))) ctx.addIssue(u"STK 合约不得携带期权/组合字段"_s);
            } else if (sec == u"OPT") {
                bool missing = false;
                for (const OJson* o : optFields) missing = missing || isNull(o);
                if (missing) ctx.addIssue(u"期权四要素缺失(到期日/行权价/Call-Put)"_s);
                if (legsNonEmpty || js::truthy(f(c, u"combo_strategy"))) ctx.addIssue(u"单腿期权不得携带 legs/combo_strategy"_s);
            } else {
                bool any = false;
                for (const OJson* o : optFields) any = any || notNull(o);
                if (any) ctx.addIssue(u"BAG 合约的期权要素必须写在 legs 里"_s);
                const OJson* cs = f(c, u"combo_strategy");
                const QString key = js::nullish(cs) ? QString() : js::str(cs);
                const int expected = key == u"VERTICAL" ? 2 : key == u"BUTTERFLY" ? 3 : key == u"IRON_CONDOR" ? 4 : -1;
                if (expected < 0) ctx.addIssue(u"combo_strategy 仅支持 VERTICAL / BUTTERFLY / IRON_CONDOR"_s);
                else if (!legs || legs->type != OJson::Array || legs->items.size() != expected)
                    ctx.addIssue(u"%1 必须正好 %2 条腿"_s.arg(js::str(cs)).arg(expected));
            }
        });
}

z::SchemaPtr makeTrigger() {
    return z::object({{u"type"_s, z::literal(OJson::string(u"PRICE"_s))->defaulted(OJson::string(u"PRICE"_s))},
                      {u"symbol"_s, makeSymbolField([](const QString& v) { return u"触发标的必须是 ticker: '%1'"_s.arg(v); })},
                      {u"secType"_s, z::enumOf(kTriggerSecTypes)},
                      {u"operator"_s, z::enumOf(kOperators)},
                      {u"value"_s, looseFloat()->pipe(z::number()->gt(0))}})
        ->strict();
}

z::SchemaPtr makeOrder() {
    return z::object({{u"action"_s, z::enumOf(kActions)},
                      {u"orderType"_s, z::enumOf(kOrderTypes)},
                      {u"totalQuantity"_s, looseInt()->pipe(z::number()->gt(0))},
                      {u"price_mode"_s, z::enumOf(kPriceModes)->defaulted(OJson::string(u"EXPLICIT"_s))},
                      {u"lmtPrice"_s, looseFloat()->pipe(z::number()->gt(0))->nullable()->defaulted(OJson::null())},
                      {u"auxPrice"_s, looseFloat()->pipe(z::number()->gt(0))->nullable()->defaulted(OJson::null())},
                      {u"trailingPercent"_s, looseFloat()->pipe(z::number()->gt(0)->max(100))->nullable()->defaulted(OJson::null())},
                      {u"tif"_s, z::enumOf(kTifs)->defaulted(OJson::string(u"DAY"_s))},
                      {u"outsideRth"_s, z::boolean()->defaulted(OJson::boolean(false))}})
        ->strict()
        ->superRefine([](const OJson& o, z::CheckCtx& ctx) {
            const QString t = js::str(f(o, u"orderType"));
            const QString mode = js::str(f(o, u"price_mode"));
            const OJson *lmt = f(o, u"lmtPrice"), *aux = f(o, u"auxPrice"), *pct = f(o, u"trailingPercent");
            if (t == u"MKT") {
                if (notNull(lmt)) ctx.addIssue(u"市价单不得带 lmtPrice"_s);
            } else if (t == u"LMT") {
                if (mode == u"EXPLICIT" && isNull(lmt)) ctx.addIssue(u"限价单缺少 lmtPrice(铁律 3)"_s);
                if (mode == u"AUTO_MID" && notNull(lmt)) ctx.addIssue(u"AUTO_MID 时 lmtPrice 必须为 null"_s);
            } else if (t == u"STP") {
                if (isNull(aux)) ctx.addIssue(u"止损单缺少 auxPrice 触发价"_s);
                if (notNull(lmt)) ctx.addIssue(u"STP 不得带 lmtPrice,需要限价请用 STP LMT"_s);
            } else if (t == u"STP LMT") {
                if (isNull(aux) || isNull(lmt)) ctx.addIssue(u"STP LMT 需要同时给出 auxPrice 与 lmtPrice"_s);
            } else if (t == u"TRAIL") {
                if (notNull(aux) == notNull(pct)) ctx.addIssue(u"TRAIL 必须且只能给 auxPrice 或 trailingPercent 其一"_s);
            }
            if (mode == u"AUTO_MID" && t != u"LMT") ctx.addIssue(u"AUTO_MID 只适用于 LMT"_s);
            if (notNull(pct) && t != u"TRAIL") ctx.addIssue(u"trailingPercent 只适用于 TRAIL"_s);
        });
}

z::SchemaPtr makeParsedOrder() {
    return z::object({{u"intent_summary"_s, z::str()->trim()->min(1)},
                      {u"contract"_s, contractSpecSchema().shared_from_this()},
                      {u"execution_type"_s, z::enumOf(kExecutionTypes)},
                      {u"trigger"_s, triggerSpecSchema().shared_from_this()->nullable()->defaulted(OJson::null())},
                      {u"account"_s, z::str()->trim()->defaulted(OJson::string(u"DEFAULT"_s))},
                      {u"order"_s, orderSpecSchema().shared_from_this()},
                      {u"reason"_s, z::str()->trim()->defaulted(OJson::string(QString()))},
                      {u"confidence"_s, looseFloat()->pipe(z::number()->min(0)->max(1))},
                      {u"warnings"_s, z::array(z::string())->defaulted(js::array())}})
        ->strict()
        ->superRefine([](const OJson& o, z::CheckCtx& ctx) {
            // §2 铁律 7b:execution_type 与 trigger 必须一致
            const QString et = js::str(f(o, u"execution_type"));
            const OJson* trig = f(o, u"trigger");
            if (et == u"CONDITIONAL" && isNull(trig)) ctx.addIssue(u"CONDITIONAL 订单缺少 trigger"_s);
            if (et == u"IMMEDIATE" && notNull(trig)) ctx.addIssue(u"IMMEDIATE 订单不得带 trigger"_s);
            // §2 铁律 3:AUTO_MID 只有期权组合可用
            if (js::str(js::propStrict(f(o, u"order"), u"price_mode"_s)) == u"AUTO_MID" && js::str(js::propStrict(f(o, u"contract"), u"secType"_s)) != u"BAG")
                ctx.addIssue(u"AUTO_MID 仅适用于期权组合(BAG),单腿期权与股票缺价必须拒绝"_s);
            if (util::jsTrim(js::str(f(o, u"account"))).isEmpty()) ctx.addIssue(u"account 不得为空,未指定时应为 DEFAULT"_s);
        });
}

z::SchemaPtr makeRejection() {
    return z::object({{u"original_text"_s, z::str()->trim()}, {u"code"_s, z::enumOf(kRejectionCodes)}, {u"message"_s, z::str()->trim()}})->strict();
}

z::SchemaPtr makeStockPick() {
    return z::object({{u"symbol"_s, makeSymbolField([](const QString& v) { return u"选股结果里的标的不合法: '%1'"_s.arg(v); })},
                      {u"company"_s, z::str()->trim()->defaulted(OJson::string(QString()))},
                      {u"reason"_s, z::str()->trim()->defaulted(OJson::string(QString()))},
                      {u"tag"_s, z::string()->defaulted(OJson::string(QString()))->transform([](const OJson& v, z::CheckCtx&) {
                           return OJson::string(util::jsTrim(v.s).left(kMaxTagLen));
                       })}})
        ->strict();
}

z::SchemaPtr makeRuleOperand() {
    return z::object({{u"kind"_s, z::enumOf({u"indicator"_s, u"const"_s})},
                      {u"name"_s, z::enumOf(kRuleIndicators)->nullable()->defaulted(OJson::null())},
                      {u"period"_s, looseInt()->pipe(z::number()->min(1)->max(250))->nullable()->defaulted(OJson::null())},
                      {u"value"_s, looseFloat()->nullable()->defaulted(OJson::null())}})
        ->strict()
        ->superRefine([](const OJson& o, z::CheckCtx& ctx) {
            static const QStringList needsPeriod{u"sma"_s, u"ema"_s, u"rsi"_s, u"highest"_s, u"lowest"_s, u"change_pct"_s};
            if (js::str(f(o, u"kind")) == u"indicator") {
                const OJson* name = f(o, u"name");
                if (!js::truthy(name)) ctx.addIssue(u"指标操作数缺少 name"_s);
                else if (needsPeriod.contains(js::str(name)) && !js::truthy(f(o, u"period"))) ctx.addIssue(u"指标 %1 需要 period"_s.arg(js::str(name)));
            } else if (isNull(f(o, u"value"))) {
                ctx.addIssue(u"常数操作数缺少 value"_s);
            }
        });
}

z::SchemaPtr strArray(double maxN) { return z::array(z::string())->max(maxN)->defaulted(js::array()); }

}  // namespace

#define IBKR_SCHEMA(fn, expr)                    \
    const z::Schema& fn() {                      \
        static const z::SchemaPtr s = (expr);    \
        return *s;                               \
    }

IBKR_SCHEMA(legSchema, makeLeg())
IBKR_SCHEMA(contractSpecSchema, makeContract())
IBKR_SCHEMA(triggerSpecSchema, makeTrigger())
IBKR_SCHEMA(orderSpecSchema, makeOrder())
IBKR_SCHEMA(parsedOrderSchema, makeParsedOrder())
IBKR_SCHEMA(rejectionSchema, makeRejection())
IBKR_SCHEMA(stockPickSchema, makeStockPick())
IBKR_SCHEMA(sectorPicksSchema, z::object({{u"stocks"_s, z::array(stockPickSchema().shared_from_this())->min(1)->max(15)}})->strict())
IBKR_SCHEMA(ruleOperandSchema, makeRuleOperand())
IBKR_SCHEMA(ruleConditionSchema, z::object({{u"left"_s, ruleOperandSchema().shared_from_this()}, {u"op"_s, z::enumOf(kRuleOps)}, {u"right"_s, ruleOperandSchema().shared_from_this()}})->strict())
IBKR_SCHEMA(customRulesSchema, z::object({{u"entry"_s, z::array(ruleConditionSchema().shared_from_this())->min(1)->max(6)},
                                           {u"exit"_s, z::array(ruleConditionSchema().shared_from_this())->max(6)->defaulted(js::array())}})
                                    ->strict())
IBKR_SCHEMA(backtestInstrumentSchema,
            z::object({{u"type"_s, z::enumOf({u"stock"_s, u"call"_s, u"put"_s, u"call_spread"_s, u"put_spread"_s, u"butterfly"_s})->defaulted(OJson::string(u"stock"_s))},
                       {u"dte"_s, looseInt()->pipe(z::number()->min(1)->max(365))->defaulted(OJson::number(30))},
                       {u"offset_pct"_s, looseFloat()->pipe(z::number()->min(-30)->max(30))->defaulted(OJson::number(0))},
                       {u"width_pct"_s, looseFloat()->pipe(z::number()->gt(0)->max(20))->defaulted(OJson::number(2))},
                       {u"risk_pct"_s, looseFloat()->pipe(z::number()->gt(0)->max(100))->defaulted(OJson::number(10))}})
                ->strict())
IBKR_SCHEMA(ideaAnalysisSchema, z::object({{u"summary"_s, z::str()->trim()->min(1)},
                                            {u"thesis"_s, z::str()->trim()->defaulted(OJson::string(QString()))},
                                            {u"checks"_s, strArray(8)},
                                            {u"risks"_s, strArray(8)},
                                            {u"suggestion"_s, z::str()->trim()->defaulted(OJson::string(QString()))}})
                                     ->strict())
IBKR_SCHEMA(ideaDigestSchema, z::object({{u"summary"_s, z::str()->trim()->min(1)},
                                          {u"themes"_s, strArray(8)},
                                          {u"lessons"_s, strArray(10)},
                                          {u"patterns"_s, strArray(8)},
                                          {u"actions"_s, strArray(6)}})
                                   ->strict())
IBKR_SCHEMA(paCommentSchema, z::object({{u"summary"_s, z::str()->trim()->min(1)},
                                         {u"reading"_s, z::str()->trim()->defaulted(OJson::string(QString()))},
                                         {u"watch"_s, strArray(6)},
                                         {u"risks"_s, strArray(6)}})
                                  ->strict())
IBKR_SCHEMA(parseResultSchema, z::object({{u"orders"_s, z::array(parsedOrderSchema().shared_from_this())->defaulted(js::array())},
                                           {u"rejections"_s, z::array(rejectionSchema().shared_from_this())->defaulted(js::array())}})
                                    ->strict())

#undef IBKR_SCHEMA

double multiplierValue(const OJson& contract) {
    const double v = js::num(contract.get(u"multiplier"_s));
    return std::isfinite(v) && v > 0 ? v : 100.0;
}

bool isOptionLike(const OJson& order) {
    const QString sec = js::str(js::path(&order, {u"contract"_s, u"secType"_s}));
    return sec == u"OPT" || sec == u"BAG";
}

QString briefZodError(const std::vector<z::Issue>& issues) {
    QStringList parts;
    for (const z::Issue& i : issues) parts << (i.path.isEmpty() ? i.message : i.path.join(u'.') + u": "_s + i.message);
    return parts.join(u"; "_s).replace(u'\n', u' ').left(300);
}

namespace {
QString excerpt(const OJson& item) {
    if (item.type == OJson::Object)
        for (const QString& key : {u"intent_summary"_s, u"original_text"_s, u"symbol"_s})
            if (const OJson* v = item.get(key); v && v->type == OJson::String && !v->s.isEmpty()) return v->s.left(200);
    return js::stringify(item).left(200);
}
}  // namespace

OJson parseLlmPayload(const OJson* payload) {
    if (!payload || payload->type != OJson::Object) throw util::JsError(u"LLM 输出不是 JSON 对象"_s);
    QList<OJson> orders, rejections;
    QStringList schemaErrors;
    const OJson* rawOrders = payload->get(u"orders"_s);
    const OJson emptyArr = js::array();
    if (js::nullish(rawOrders)) rawOrders = &emptyArr;
    if (rawOrders->type != OJson::Array) throw util::JsError(u"orders 字段不是数组"_s);
    for (qsizetype idx = 0; idx < rawOrders->items.size(); ++idx) {
        const OJson& item = rawOrders->items[idx];
        const auto parsed = z::safeParse(parsedOrderSchema(), &item);
        if (parsed.success) {
            orders << *parsed.data;
        } else {
            const QString detail = briefZodError(parsed.issues);
            schemaErrors << u"orders[%1]: %2"_s.arg(idx).arg(detail);
            rejections << js::object({{u"original_text"_s, js::S(excerpt(item))},
                                      {u"code"_s, js::S(u"UNCLEAR"_s)},
                                      {u"message"_s, js::S(u"解析结果未通过软件层结构校验,已拦截(orders[%1]):%2。请把指令写得更明确后重试。"_s.arg(idx).arg(detail))}});
        }
    }
    const OJson* rawRejections = payload->get(u"rejections"_s);
    if (js::nullish(rawRejections)) rawRejections = &emptyArr;
    if (rawRejections->type != OJson::Array) throw util::JsError(u"rejections 字段不是数组"_s);
    for (qsizetype idx = 0; idx < rawRejections->items.size(); ++idx) {
        const OJson& item = rawRejections->items[idx];
        const auto parsed = z::safeParse(rejectionSchema(), &item);
        if (parsed.success) {
            rejections << *parsed.data;
        } else {
            schemaErrors << u"rejections[%1]: %2"_s.arg(idx).arg(briefZodError(parsed.issues));
            rejections << js::object({{u"original_text"_s, js::S(excerpt(item))},
                                      {u"code"_s, js::S(u"UNCLEAR"_s)},
                                      {u"message"_s, js::S(u"模型给出的拒绝条目本身格式不合法,已按拒绝处理。"_s)}});
        }
    }
    QStringList unknownTop;
    for (const auto& [k, v] : payload->fields)
        if (k != u"orders" && k != u"rejections") unknownTop << k;
    std::sort(unknownTop.begin(), unknownTop.end());
    if (!unknownTop.isEmpty()) schemaErrors << u"顶层多余字段已忽略: "_s + unknownTop.join(u", "_s);
    return js::object({{u"orders"_s, js::array(orders)}, {u"rejections"_s, js::array(rejections)}, {u"schema_errors"_s, js::strings(schemaErrors)}});
}

}  // namespace ibkr::domain::models
