// 解析结果的严格 schema(engine-ts/src/models.ts 逐句搬,zod → util/zod):LLM 的输出永远是不可信输入,多余字段直接失败(strict),
// 单条坏订单降级成拒绝、不牵连其他订单。语义 / 算术复核在 parsing 层的 validator。
// 解析出来的订单是 JS 对象(zod 的输出,键序同 schema 的字段先后)。
// 各 schema 函数第一次调用时才建(函数内的 static);不要在命名空间级的静态初始化里调用它们——那时头文件里的枚举表可能还没初始化。
#pragma once

#include "util/ordered_json.h"
#include "util/zod.h"

#include <QStringList>

namespace ibkr::domain::models {

inline const QStringList kSecTypes{QStringLiteral("STK"), QStringLiteral("OPT"), QStringLiteral("BAG")};
inline const QStringList kRights{QStringLiteral("C"), QStringLiteral("P")};
inline const QStringList kActions{QStringLiteral("BUY"), QStringLiteral("SELL")};
inline const QStringList kOrderTypes{QStringLiteral("LMT"), QStringLiteral("MKT"), QStringLiteral("STP"), QStringLiteral("STP LMT"), QStringLiteral("TRAIL")};
inline const QStringList kPriceModes{QStringLiteral("EXPLICIT"), QStringLiteral("AUTO_MID")};
inline const QStringList kTifs{QStringLiteral("DAY"), QStringLiteral("GTC")};
inline const QStringList kExecutionTypes{QStringLiteral("IMMEDIATE"), QStringLiteral("CONDITIONAL")};
inline const QStringList kTriggerSecTypes{QStringLiteral("IND"), QStringLiteral("STK")};
inline const QStringList kOperators{QStringLiteral(">="), QStringLiteral("<=")};
inline const QStringList kRejectionCodes{QStringLiteral("MISSING_QUANTITY"), QStringLiteral("MISSING_PRICE"), QStringLiteral("AMBIGUOUS_SYMBOL"),
                                         QStringLiteral("INCOMPLETE_OPTION"), QStringLiteral("AMBIGUOUS_TRIGGER"), QStringLiteral("UNKNOWN_ACCOUNT"),
                                         QStringLiteral("EXCEEDS_LIMIT"), QStringLiteral("UNSUPPORTED"), QStringLiteral("UNCLEAR")};
inline constexpr int kMaxTagLen = 12;
inline const QStringList kRuleIndicators{QStringLiteral("close"), QStringLiteral("open"), QStringLiteral("high"), QStringLiteral("low"),
                                         QStringLiteral("sma"), QStringLiteral("ema"), QStringLiteral("rsi"), QStringLiteral("highest"),
                                         QStringLiteral("lowest"), QStringLiteral("change_pct"), QStringLiteral("macd_hist")};
inline const QStringList kRuleOps{QStringLiteral(">"), QStringLiteral("<"), QStringLiteral(">="), QStringLiteral("<="), QStringLiteral("cross_up"), QStringLiteral("cross_down")};

// 各 schema(同 TS 的同名导出)
const util::zod::Schema& legSchema();
const util::zod::Schema& contractSpecSchema();
const util::zod::Schema& triggerSpecSchema();
const util::zod::Schema& orderSpecSchema();
const util::zod::Schema& parsedOrderSchema();
const util::zod::Schema& rejectionSchema();
const util::zod::Schema& stockPickSchema();
const util::zod::Schema& sectorPicksSchema();
const util::zod::Schema& ruleOperandSchema();
const util::zod::Schema& ruleConditionSchema();
const util::zod::Schema& customRulesSchema();
const util::zod::Schema& backtestInstrumentSchema();
const util::zod::Schema& ideaAnalysisSchema();
const util::zod::Schema& ideaDigestSchema();
const util::zod::Schema& paCommentSchema();
const util::zod::Schema& parseResultSchema();

/// 乘数的数值:非有限、零或负数一律按 100(乘数只会让敞口变大)
double multiplierValue(const util::OJson& contract);
bool isOptionLike(const util::OJson& order);

/// {orders, rejections, schema_errors};payload 不是对象 / orders、rejections 不是数组时抛(同 TS 的 TypeError 原话)
util::OJson parseLlmPayload(const util::OJson* payload);
/// 一串 issue 压成一行(path: message;…,换行换成空格,截到 300 码元)
QString briefZodError(const std::vector<util::zod::Issue>& issues);

}  // namespace ibkr::domain::models
