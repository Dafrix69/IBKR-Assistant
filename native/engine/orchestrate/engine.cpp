// engine.ts 的指令主线(解析 → 校验 → 下单 → 落库 → 通知)、条件单队列、熔断 / 保护规则、落库。一行对一行搬,不改行为。
#include "orchestrate/engine.h"

#include "analysis/market.h"
#include "analysis/playbook.h"
#include "domain/day_logs.h"
#include "domain/models.h"
#include "execution/auto_mid.h"
#include "orchestrate/closing.h"
#include "orchestrate/engine_impl.h"
#include "orchestrate/services/follow_service.h"
#include "orchestrate/session_hours.h"
#include "parsing/shorthand.h"
#include "util/jsformat.h"
#include "util/jsobj.h"
#include "util/py.h"

#include <QFileInfo>

#include <algorithm>
#include <cmath>

namespace ibkr::orchestrate {

using namespace Qt::StringLiterals;
namespace js = util::js;
namespace prompts = parsing::prompts;
namespace providers = parsing::providers;
namespace val = parsing::validator;
using util::OJson;
using util::Task;

namespace {

/// TS 的 `x.slice(start, end)` 里下标的归一(ToIntegerOrInfinity 再夹到 [0, len])
qsizetype sliceIndex(double v, qsizetype len) {
    const double n = std::isnan(v) ? 0 : std::trunc(v);
    if (n < 0) return static_cast<qsizetype>(std::max(0.0, double(len) + n));
    return static_cast<qsizetype>(std::min(n, double(len)));
}

/// 对象字面量里 `k: v`:v 是 undefined(空指针)时 JSON 里没有这个键
void setDefined(Rec& obj, const QString& key, const OJson* v) {
    if (v) obj.set(key, *v);
}

QString jsTrim(const QString& s) {
    qsizetype a = 0, b = s.size();
    const auto ws = [](QChar c) { return c.isSpace() || c == QChar(0xFEFF); };
    while (a < b && ws(s[a])) ++a;
    while (b > a && ws(s[b - 1])) --b;
    return s.mid(a, b - a);
}

}  // namespace

// ======================================================================
// 导出的纯函数
// ======================================================================
QStringList resolveFanoutAccounts(const domain::Settings& settings, const std::optional<QStringList>& accounts) {
    QStringList seen;
    if (!accounts || accounts->isEmpty()) return seen;
    for (const QString& raw : *accounts) {
        const QString alias = jsTrim(raw);
        if (alias.isEmpty() || seen.contains(alias)) continue;
        if (alias == u"DEFAULT" || settings.accountByAlias(alias) == nullptr) {
            const QString list = settings.aliasList().join(u"、"_s);
            throw util::JsError(u"账户别名 '"_s + alias + u"' 不在别名表中(可用:"_s + (list.isEmpty() ? u"(未配置)"_s : list) + u")。"_s);
        }
        seen << alias;
    }
    return seen;
}

std::pair<QList<Rec>, std::optional<QString>> fanOutOrders(const QList<Rec>& orders, const QStringList& accounts) {
    if (accounts.isEmpty()) return {orders, std::nullopt};
    QList<Rec> defaults, explicitOrders, expanded;
    for (const Rec& o : orders) {
        const OJson* a = js::prop(&o, u"account"_s);
        if (js::isStr(a) && a->s == u"DEFAULT") defaults << o;
        else explicitOrders << o;
    }
    for (const QString& alias : accounts) {
        for (const Rec& order : defaults) {
            Rec copy = order;
            copy.set(u"account"_s, js::S(alias));
            expanded << copy;
        }
    }
    expanded << explicitOrders;
    if (accounts.size() == 1 || defaults.isEmpty()) return {expanded, std::nullopt};
    const QString note = u"已按勾选账户同时发单:"_s + accounts.join(u"、"_s) + u"(每笔订单各 "_s + QString::number(accounts.size()) + u" 份,各自独立校验与记录)"_s;
    return {expanded, note};
}

Rec orderTicket(const Rec& parsed) {
    const OJson* c = js::prop(&parsed, u"contract"_s);
    const OJson* o = js::prop(&parsed, u"order"_s);
    Rec t = js::object();
    setDefined(t, u"sec_type"_s, js::prop(c, u"secType"_s));
    setDefined(t, u"symbol"_s, js::prop(c, u"symbol"_s));
    setDefined(t, u"action"_s, js::prop(o, u"action"_s));
    setDefined(t, u"quantity"_s, js::prop(o, u"totalQuantity"_s));
    setDefined(t, u"order_type"_s, js::prop(o, u"orderType"_s));
    setDefined(t, u"price_mode"_s, js::prop(o, u"price_mode"_s));
    setDefined(t, u"limit_price"_s, js::prop(o, u"lmtPrice"_s));
    setDefined(t, u"aux_price"_s, js::prop(o, u"auxPrice"_s));
    setDefined(t, u"trailing_percent"_s, js::prop(o, u"trailingPercent"_s));
    setDefined(t, u"tif"_s, js::prop(o, u"tif"_s));
    // c.lastTradeDateOrContractMonth ?? c.legs?.[0]?.lastTradeDateOrContractMonth ?? null
    const OJson* legs = js::prop(c, u"legs"_s);
    const OJson* expiry = js::prop(c, u"lastTradeDateOrContractMonth"_s);
    if (js::nullish(expiry)) expiry = js::prop(js::prop(legs, u"0"_s), u"lastTradeDateOrContractMonth"_s);
    t.set(u"expiry"_s, js::nullish(expiry) ? js::Null() : *expiry);
    setDefined(t, u"strike"_s, js::prop(c, u"strike"_s));
    setDefined(t, u"right"_s, js::prop(c, u"right"_s));
    t.set(u"multiplier"_s, js::N(domain::models::multiplierValue(c ? *c : js::object())));
    setDefined(t, u"combo_strategy"_s, js::prop(c, u"combo_strategy"_s));
    Rec outLegs = js::array();
    if (js::isArr(legs)) {
        for (const OJson& leg : legs->items) {
            Rec l = js::object();
            setDefined(l, u"action"_s, js::prop(&leg, u"action"_s));
            setDefined(l, u"ratio"_s, js::prop(&leg, u"ratio"_s));
            setDefined(l, u"strike"_s, js::prop(&leg, u"strike"_s));
            setDefined(l, u"right"_s, js::prop(&leg, u"right"_s));
            outLegs.items.append(l);
        }
    }
    t.set(u"legs"_s, outLegs);
    const OJson* trig = js::prop(&parsed, u"trigger"_s);
    if (js::truthy(trig)) {
        Rec tr = js::object();
        setDefined(tr, u"symbol"_s, js::prop(trig, u"symbol"_s));
        setDefined(tr, u"operator"_s, js::prop(trig, u"operator"_s));
        setDefined(tr, u"value"_s, js::prop(trig, u"value"_s));
        t.set(u"trigger"_s, tr);
    } else {
        t.set(u"trigger"_s, js::Null());
    }
    return t;
}

Rec dumpExcludeNone(const Rec& value) {
    if (value.type == OJson::Array) {
        Rec out = js::array();
        for (const OJson& x : value.items) out.items.append(dumpExcludeNone(x));
        return out;
    }
    if (value.type == OJson::Object) {
        Rec out = js::object();
        for (const auto& [k, v] : value.fields) {
            if (v.type == OJson::Null) continue;
            out.set(k, dumpExcludeNone(v));
        }
        return out;
    }
    return value;
}

Rec EngineResult::toJson() const {
    const auto arr = [](const QList<Rec>& l) { return js::array(l); };
    Rec o = js::object({{u"submitted"_s, arr(submitted)},
                        {u"queued"_s, arr(queued)},
                        {u"validated_only"_s, arr(validated_only)},
                        {u"rejections"_s, arr(rejections)},
                        {u"warnings"_s, js::strings(warnings)}});
    o.set(u"llm"_s, llm ? *llm : js::Null());
    return o;
}

std::optional<double> SessionEmCache::today(const domain::EtNow& at) {
    if (cached_ && cached_->date == at.date && at.epochMs - cached_->atMs < kTtlMs && at.epochMs >= cached_->atMs) return cached_->em;
    const domain::Settings& s = settings_();
    std::optional<double> em;
    try {
        const domain::PlaybookLog log(QFileInfo(s.db_path).path() + u"/playbook"_s);
        const auto found = analysis::playbook::sessionEmOf(log.read(at.date), s.early_close_days.contains(at.date));
        if (found) em = found->em;
    } catch (...) {
        em = std::nullopt;  // 底账读不了不该影响盯盘:退回默认值
    }
    cached_ = Hit{at.date, at.epochMs, em};
    return em;
}

// ======================================================================
// 构造
// ======================================================================
TradingEngine::TradingEngine(EngineArgs args)
    : settings(std::move(args.settings)),
      parser(std::move(args.parser)),
      sessionEm([this]() -> const domain::Settings& { return settings; }),
      awakeClock([] { return wake::awakeClockMs(); }),
      store_(args.store ? std::move(args.store) : std::make_shared<domain::TradeStore>(settings.db_path)),
      notifier_(args.notifier ? std::move(args.notifier) : std::make_shared<util::Notifier>()),
      router_(std::move(args.router)),
      setTimeout_(defaultSetTimeout()) {
    killswitch_ = args.killswitch ? std::move(args.killswitch)
                                  : std::make_shared<util::KillSwitch>(QFileInfo(settings.db_path).path() + u"/breaker.json"_s, settings.policies.consecutive_failure_breaker);
    bundle = args.bundle ? std::move(*args.bundle) : prompts::loadPromptBundle(settings);
    storePort_ = args.storePort ? std::move(args.storePort) : std::shared_ptr<CoreStore>(makeCoreStorePort(*store_));
    breakerPort_ = args.breakerPort ? std::move(args.breakerPort) : std::shared_ptr<BreakerPort>(makeBreakerPort(*killswitch_));
    trackerLoop = js::object({{u"running"_s, js::B(false)},
                              {u"interval_ms"_s, js::N(kTrackerTickMs)},
                              {u"ticks"_s, js::N(0)},
                              {u"slow_ticks"_s, js::N(0)},
                              {u"last_at"_s, js::Null()},
                              {u"last_ms"_s, js::Null()},
                              {u"max_ms"_s, js::N(0)},
                              {u"last_error"_s, js::S(QString())},
                              {u"poll"_s, js::Null()},
                              {u"hosted"_s, js::Null()},
                              {u"hold"_s, js::S(QString())},
                              {u"live_tracks"_s, js::N(0)}});
    impl_ = std::make_unique<Impl>(*this);
    hostedOrders_ = std::make_unique<HostedOrders>(*impl_->hostedHost);
    exits_ = std::make_unique<TrackExits>(*impl_->exitsHost);
    accounts_ = std::make_unique<AccountGuard>(*impl_->guardHost);
    reconciler_ = std::make_unique<Reconciler>(*impl_->reconHost);
    callbacks_ = std::make_unique<IbCallbacks>(*impl_->cbHost);
}

TradingEngine::~TradingEngine() { *alive_ = false; }

void TradingEngine::setTimerHook(SetTimeout hook) {
    setTimeout_ = hook;
    hostedOrders_->setTimeout = hook;
    reconciler_->setTimeout = hook;
}

// ======================================================================
// 指令
// ======================================================================
Task<Rec> TradingEngine::buildSnapshot(QStringList symbols, Rec cached) {
    Rec snapshot = js::object();
    for (const QString& symbol : symbols) {
        if (const OJson* c = cached.get(symbol)) {
            snapshot.set(symbol, js::N(js::num(c)));
            continue;
        }
        std::optional<double> price;
        try {
            price = co_await router_->indexPrice(symbol);
        } catch (...) {
            price = std::nullopt;  // 行情失败不阻断解析
        }
        if (price && *price != 0 && !std::isnan(*price)) snapshot.set(symbol, js::N(*price));
    }
    co_return snapshot;
}

Task<EngineResult> TradingEngine::handleInstruction(QString instruction, QString channel, std::optional<domain::EtNow> moment, std::optional<Rec> snapshot,
                                                    std::optional<QStringList> accounts, bool dryRun, InstructionScope scope) {
    EngineResult result;
    const domain::EtNow at = moment ? *moment : domain::nowEt();
    const QStringList targets = resolveFanoutAccounts(settings, accounts);

    const util::BreakerState breaker = breakerPort_->state();
    if (breaker.engaged) {
        const QString message = u"自动执行已熔断("_s + breaker.reason + u"),本条指令未解析。请在软件里手动解除后重试。"_s;
        notifier_->breaker(message);
        result.warnings << message;
        co_return result;
    }

    Rec snap = snapshot && snapshot->type == OJson::Object ? *snapshot : js::object();
    if (router_) {
        const QStringList symbols = analysis::market::extractSymbols(instruction, settings);
        snap = co_await buildSnapshot(symbols, snap);
    }

    // 本地速记优先:固定行话不等大模型,解析不了回空交给大模型。它会往 snap 里补现价
    const std::optional<Rec> localPayload = co_await tryLocalShorthand(*impl_->shorthandHost, instruction, &snap, at);

    providers::LLMResponse response;
    if (localPayload) {
        response.text = util::stringifyOJson(*localPayload, 0);
        response.model = js::S(parsing::shorthand::kLocalModel);
        response.prompt_version = bundle.version;
        response.prompt_fingerprint = prompts::fingerprint(bundle);
        response.latency_ms = 0;
        response.usage = js::object();
        response.structured_mode = u"none"_s;
    } else {
        const QString userMessage = prompts::renderUser(bundle, settings, instruction, at, QString(), &snap);
        std::optional<QString> llmError;
        try {
            // 跟单那一趟:解析器一被叫到就拒(抛的不是 LLMError,引擎不计解析失败、不碰熔断,原样抛回)
            if (scope.localOnly) throw FollowLocalOnlyError();
            response = co_await parser->parse(bundle, userMessage);
        } catch (const domain::LLMError& exc) {
            llmError = exc.message();
        }
        if (llmError) {
            // 调用失败 = 这条指令被拒了,不是"提示"
            const auto engaged = breakerPort_->recordFailure(*llmError, u"parse"_s);
            notifier_->rejection(u"LLM_ERROR"_s, *llmError);
            if (engaged) notifier_->breaker(engaged->reason);
            storePort_->audit(u"engine"_s, u"llm_error"_s, js::object({{u"instruction"_s, js::S(instruction)}, {u"error"_s, js::S(*llmError)}}));
            result.rejections << js::object({{u"source"_s, js::S(u"engine"_s)},
                                             {u"code"_s, js::S(u"LLM_ERROR"_s)},
                                             {u"message"_s, js::S(*llmError)},
                                             {u"original_text"_s, js::S(instruction)}});
            co_return result;
        }
    }

    result.llm = js::object({{u"model"_s, response.model},
                             {u"prompt_version"_s, js::S(response.prompt_version)},
                             {u"prompt_fingerprint"_s, js::S(response.prompt_fingerprint)},
                             {u"latency_ms"_s, js::N(response.latency_ms)},
                             {u"usage"_s, response.usage}});

    Rec parsed;
    std::optional<QString> payloadError;
    try {
        const OJson payload = response.payload();
        parsed = domain::models::parseLlmPayload(&payload);
    } catch (...) {
        payloadError = jsx::errorMessage(std::current_exception());
    }
    if (payloadError) {
        const auto engaged = breakerPort_->recordFailure(*payloadError, u"parse"_s);
        notifier_->rejection(u"BAD_PAYLOAD"_s, *payloadError);
        if (engaged) notifier_->breaker(engaged->reason);
        storePort_->audit(u"engine"_s, u"bad_payload"_s, js::object({{u"error"_s, js::S(*payloadError)}, {u"raw"_s, js::S(response.text.left(2000))}}));
        result.rejections << js::object({{u"source"_s, js::S(u"engine"_s)},
                                         {u"code"_s, js::S(u"BAD_PAYLOAD"_s)},
                                         {u"message"_s, js::S(*payloadError)},
                                         {u"original_text"_s, js::S(instruction)}});
        co_return result;
    }

    // 只清"解析失败"计数。券商失败计数必须等真正下单成功才清。
    breakerPort_->recordSuccess(u"parse"_s);
    if (const OJson* se = js::prop(&parsed, u"schema_errors"_s); js::isArr(se)) {
        for (const OJson& e : se->items) result.warnings << js::str(&e);
    }

    // 1. 模型自己拒绝的片段:照样落库,拒绝率是要统计的指标(§11)
    if (const OJson* rejs = js::prop(&parsed, u"rejections"_s); js::isArr(rejs)) {
        for (const OJson& rejection : rejs->items) {
            recordRejection(instruction, channel, response, rejection, u"rejected_by_llm"_s);
            notifier_->rejection(js::str(js::prop(&rejection, u"code"_s)), js::str(js::prop(&rejection, u"message"_s)));
            Rec r = js::object({{u"source"_s, js::S(u"llm"_s)}});
            setDefined(r, u"code"_s, js::prop(&rejection, u"code"_s));
            setDefined(r, u"message"_s, js::prop(&rejection, u"message"_s));
            setDefined(r, u"original_text"_s, js::prop(&rejection, u"original_text"_s));
            result.rejections << r;
        }
    }

    // 2. 软件层硬校验(先按勾选账户扇出:同一笔订单每个账户一份)。单条输入的订单上限在扇出**之前**截:它限的是"一句话最多几笔",不是"每个账户几笔"
    const double cap = settings.limits.max_orders_per_input;
    const QList<Rec> parsedOrders = js::isArr(js::prop(&parsed, u"orders"_s)) ? js::prop(&parsed, u"orders"_s)->items : QList<Rec>{};
    const qsizetype capEnd = sliceIndex(cap, parsedOrders.size());
    const auto [orders, fanoutNote] = fanOutOrders(parsedOrders.mid(0, capEnd), targets);
    if (fanoutNote) {
        result.warnings << *fanoutNote;
        storePort_->audit(u"engine"_s, u"fanout"_s,
                          js::object({{u"accounts"_s, js::strings(targets)}, {u"orders"_s, js::N(parsedOrders.size())}, {u"expanded"_s, js::N(orders.size())}}));
    }
    // 先把期权/组合的合约时段问一遍(按天缓存,一天只有一次网络往返):校验链路是同步的,读不到缓存就只能退回正股日历
    co_await prewarmContractHours(*impl_->hoursHost, orders);
    QList<Rec> priced = autoOutsideRth(*impl_->hoursHost, orders, at);
    const QList<Rec> recent = storePort_->recentOrderDetails(settings.limits.duplicate_window_minutes, at.epochMs);
    const val::MarketStatusFn statusFn = [this, at](const OJson& o) { return orderMarketStatus(*impl_->hoursHost, o, at); };
    val::ValidatorExtras extras = co_await accounts_->validatorExtras();
    val::Validator validator(settings, at, &snap, &recent, statusFn, std::move(extras));
    val::ValidationOutcome outcome = validator.validateAll(priced, static_cast<double>(std::max<qsizetype>(priced.size(), 1)));
    {
        const qsizetype from = sliceIndex(cap, parsedOrders.size());
        for (qsizetype i = from; i < parsedOrders.size(); ++i) {
            val::RejectedOrder r;
            r.order = parsedOrders[i];
            const double idx = double(i - from);
            r.issues.append({u"EXCEEDS_LIMIT"_s, u"单次输入最多解析 "_s + util::jsNumberToString(cap) + u" 笔订单,本条排在第 "_s + util::jsNumberToString(cap + idx + 1) +
                                                     u" 位,已拦截。请拆成多次提交。"_s});
            outcome.rejected.append(std::move(r));
        }
    }

    for (const val::RejectedOrder& rejected : outcome.rejected) {
        recordValidatorRejection(instruction, channel, response, rejected);
        notifier_->rejection(val::primaryCode(rejected), val::rejectionMessage(rejected));
        Rec r = js::object({{u"source"_s, js::S(u"validator"_s)},
                            {u"code"_s, js::S(val::primaryCode(rejected))},
                            {u"message"_s, js::S(val::rejectionMessage(rejected))}});
        setDefined(r, u"intent_summary"_s, js::prop(&rejected.order, u"intent_summary"_s));
        result.rejections << r;
    }

    // 3. 通过的订单。保护规则放行平仓要看持仓:一批只读一次(undefined = 还没读,null = 读不到)
    enum class GuardRows { Unread, Unreadable, Read } guardState = GuardRows::Unread;
    QList<Rec> guardRows;
    for (const val::ApprovedOrder& approved : outcome.approved) {
        const QString recordId = recordApproved(instruction, channel, response, approved);
        for (const QString& warning : approved.warnings) {
            notifier_->warning(warning);
            storePort_->appendEvent(recordId, u"warning"_s, js::object({{u"message"_s, js::S(warning)}}));
        }
        result.warnings << approved.warnings;

        Rec summary = js::object({{u"record_id"_s, js::S(recordId)}});
        setDefined(summary, u"intent_summary"_s, js::prop(&approved.order, u"intent_summary"_s));
        summary.set(u"account"_s, js::S(approved.account.alias));
        summary.set(u"notional"_s, js::N(util::pyRound(approved.notional, 2)));
        // 界面画订单票据与到期损益图用的结构化摘要:只读展示,不回流到任何决策
        summary.set(u"ticket"_s, orderTicket(approved.order));
        const QString intent = js::str(js::prop(&approved.order, u"intent_summary"_s));

        if (dryRun || !settings.policies.auto_execute) {
            storePort_->appendEvent(recordId, u"status"_s, js::object({{u"status"_s, js::S(u"ValidatedOnly"_s)}}));
            notifier_->warning(dryRun ? u"已通过校验(只解析,未发送):"_s + intent : u"已通过校验但未发送(自动执行未打开):"_s + intent);
            result.validated_only << summary;
            // 解析预热:后台把合约 qualify 一遍填 conId 缓存——用户下一步点「发送」时组合腿零往返。失败无害
            prewarm(approved);
            continue;
        }

        // 批内熔断:每笔发出前重查一次开关
        const util::BreakerState breakerNow = breakerPort_->state();
        if (breakerNow.engaged) {
            storePort_->setFinalStatus(recordId, u"halted_by_breaker"_s, breakerNow.reason);
            notifier_->rejection(u"BREAKER_ENGAGED"_s, u"熔断已触发,本批剩余订单未提交:"_s + intent);
            result.rejections << js::object({{u"source"_s, js::S(u"engine"_s)},
                                             {u"code"_s, js::S(u"BREAKER_ENGAGED"_s)},
                                             {u"message"_s, js::S(u"熔断已触发,订单未提交("_s + breakerNow.reason + u")"_s)},
                                             {u"record_id"_s, js::S(recordId)}});
            continue;
        }

        // 保护规则:接连止损 / 回撤过大 / 同一标的刚平过仓。挡下的单停在"仅校验未发送",不落终态——保护期过了原样再发一次就行
        const QString symbol = js::strOr(js::prop(js::prop(&approved.order, u"contract"_s), u"symbol"_s), QString());
        std::optional<QString> guard = util::protectionBlock(protectionState(), symbol, util::dateNow(), approved.account.alias, orderLegId(approved.order));
        // 只挡新单、永不挡平仓:每条腿都在减已有持仓的单照发(engine/closing.ts)。读不到持仓就认不准,照旧挡
        if (guard && router_) {
            if (guardState == GuardRows::Unread) {
                try {
                    guardRows = co_await router_->positions();
                    guardState = GuardRows::Read;
                } catch (...) {
                    guardState = GuardRows::Unreadable;
                }
            }
            if (guardState == GuardRows::Read && reducesPositions(approved.order, approved.account.alias, guardRows)) guard = std::nullopt;
        }
        if (guard) {
            storePort_->appendEvent(recordId, u"status"_s, js::object({{u"status"_s, js::S(u"ValidatedOnly"_s)}}));
            storePort_->appendEvent(recordId, u"warning"_s, js::object({{u"message"_s, js::S(u"保护规则拦下:"_s + *guard)}}));
            storePort_->audit(u"engine"_s, u"protection_blocked"_s,
                              js::object({{u"record"_s, js::S(recordId)},
                                          {u"symbol"_s, js::S(js::strOr(js::prop(js::prop(&approved.order, u"contract"_s), u"symbol"_s), QString()))},
                                          {u"reason"_s, js::S(*guard)}}));
            notifier_->warning(u"保护规则拦下,已通过校验但未发送:"_s + *guard);
            result.validated_only << summary;
            continue;
        }

        std::optional<QString> brokerError;
        try {
            const Rec extra = co_await execute(recordId, approved);
            jsx::assign(summary, extra);
        } catch (const execution::BrokerError& exc) {
            brokerError = exc.message();
        }
        if (brokerError) {
            storePort_->setFinalStatus(recordId, u"ibkr_error"_s, *brokerError);
            const auto engaged = breakerPort_->recordFailure(*brokerError, u"broker"_s);
            const QString code = brokerCode();
            notifier_->rejection(code, *brokerError);
            if (engaged) notifier_->breaker(engaged->reason);
            result.rejections << js::object({{u"source"_s, js::S(u"broker"_s)}, {u"code"_s, js::S(code)}, {u"message"_s, js::S(*brokerError)}, {u"record_id"_s, js::S(recordId)}});
            continue;
        }

        if (js::truthy(summary.get(u"queued"_s))) {
            result.queued << summary;
        } else {
            // 真正把单发出去了才算"券商成功";仅进入盯盘队列不算。
            breakerPort_->recordSuccess(u"broker"_s);
            result.submitted << summary;
        }
    }
    co_return result;
}

// ------------------------------------------------------------------
void TradingEngine::prewarm(const val::ApprovedOrder& approved) {
    if (!router_ || !router_->hasQualify()) return;
    const OJson* contract = js::prop(&approved.order, u"contract"_s);
    prewarmPromise = prewarmRun(contract ? *contract : js::Null(), approved.account);
}

Task<> TradingEngine::prewarmRun(Rec contract, contract::AccountConfig account) {
    try {
        co_await router_->qualify(std::move(contract), std::move(account));
    } catch (...) {
        /* 预热失败无害:发送时会正式再走一遍并给出真实报错 */
    }
}

Task<Rec> TradingEngine::execute(QString recordId, val::ApprovedOrder approved) {
    if (!router_) throw execution::BrokerError(u"未接入券商连接(router=None),无法下单。"_s);
    const Rec parsed = approved.order;
    const OJson* trigger = js::prop(&parsed, u"trigger"_s);
    const bool hasTrigger = trigger == nullptr || trigger->type != OJson::Null;
    const OJson* orderSpec = js::prop(&parsed, u"order"_s);
    const QString intent = js::str(js::prop(&parsed, u"intent_summary"_s));

    // 方式 B:①条件单 + AUTO_MID;②券商没有原生条件单——必须软件盯盘
    const bool nativeConditions = router_->supportsNativeConditions();
    if (hasTrigger && (js::str(js::prop(orderSpec, u"price_mode"_s)) == u"AUTO_MID" || !nativeConditions)) {
        // 进队列之前先问:这个触发标的,券商到底报不报得出价?
        std::optional<QString> reason;
        if (router_->hasQuoteCapability()) reason = router_->quoteCapability(js::str(js::prop(trigger, u"symbol"_s)));
        if (reason && !reason->isEmpty()) throw execution::BrokerError(*reason);
        auto pending = std::make_shared<execution::PendingTrigger>();
        pending->record_id = recordId;
        pending->approved = approved;
        pending->trigger = trigger ? *trigger : js::Null();
        pending->created_at = localIsoSeconds();
        pending->fired = false;
        pendingTriggers.push_back(pending);
        storePort_->appendEvent(recordId, u"status"_s, js::object({{u"status"_s, js::S(u"PendingTrigger"_s)}}));
        notifier_->warning(u"已进入盯盘队列:"_s + intent + u"(软件必须保持运行,否则条件不会触发)"_s);
        co_return js::object({{u"queued"_s, js::B(true)}, {u"mode"_s, js::S(u"software_watch"_s)}});
    }

    // 立即执行的 AUTO_MID 组合:现在就取盘口中间价定限价
    std::optional<double> limitOverride;
    if (js::str(js::prop(orderSpec, u"price_mode"_s)) == u"AUTO_MID") {
        const double limit = co_await priceAutoMid(approved);
        limitOverride = limit;
        const QString note = approved.account.is_paper ? u"(纸面账户:无实时期权订阅时按延迟盘口定价,成交价参考性有限)"_s : QString();
        storePort_->appendEvent(recordId, u"warning"_s,
                                js::object({{u"message"_s, js::S(u"AUTO_MID 定价:盘口中间价 ± "_s + (settings.limits.auto_mid_spread_share > 0 ? u"价差的一份"_s : u"滑点上限"_s) +
                                                                  u" → 限价 "_s + util::fmtF(limit, 4) + note)}}));
    }

    storePort_->markSubmitIntent(recordId);  // 先留痕再发单:发到一半进程被杀,对账与重复单防抖还认得出这条记录
    const execution::PlacementResult placement = co_await router_->place(recordId, approved, limitOverride);
    indexPlacement(recordId, placement);
    const auto idOrNull = [](const std::optional<int>& v) { return v ? js::N(*v) : js::Null(); };
    storePort_->appendEvent(recordId, u"status"_s,
                            js::object({{u"status"_s, js::S(placement.status)}, {u"order_id"_s, idOrNull(placement.order_id)}, {u"perm_id"_s, idOrNull(placement.perm_id)}}));
    notifier_->notify(u"订单已提交"_s, intent, u"账户 "_s + domain::redactAccount(approved.account.account_id));
    co_return js::object({{u"queued"_s, js::B(hasTrigger)},
                          {u"mode"_s, js::S(hasTrigger ? u"ibkr_condition"_s : u"immediate"_s)},
                          {u"order_id"_s, idOrNull(placement.order_id)},
                          {u"status"_s, js::S(placement.status)}});
}

Task<QList<Rec>> TradingEngine::firePending(Rec prices) {
    QList<Rec> fired;
    // 触发时刻的熔断复查:条件单可能在校验后数小时才触发
    if (breakerPort_->state().engaged) co_return fired;
    // 保护规则同理在触发这一刻复查。**排队的单不作废**:保护期内它继续排着,到点自己就能发
    const util::ProtectionState guard = protectionState();
    const auto snapshotList = pendingTriggers;
    for (const auto& pending : snapshotList) {
        if (pending->fired) continue;
        const OJson* contract = js::prop(&pending->approved.order, u"contract"_s);
        const std::optional<QString> blocked = util::protectionBlock(guard, js::strOr(js::prop(contract, u"symbol"_s), QString()), util::dateNow(),
                                                                     pending->approved.account.alias, orderLegId(pending->approved.order));
        if (blocked && !(co_await accounts_->isReduceOnly(pending->approved))) continue;  // 只挡新单:排着的平仓单照发
        const OJson* price = js::prop(&prices, js::str(js::prop(&pending->trigger, u"symbol"_s)));
        if (js::nullish(price) || !execution::shouldFire(*pending, js::num(price))) continue;
        // C++ 独有(TS 没有,见头文件「与 TS 的有意差别」):每一张发出前再查一次熔断(同 handleInstruction 的批内熔断)——前面那张的定价 / 发单在 await,
        // 这期间熔断可能被别处合上;halt() 清了队列而这里手里还拿着一份副本,也不许再发。挡下的留在队里不落终态(同函数开头的复查)。
        // 直接问开关、不走 breakerPort_:调用记录与 TS 一致,没有多出来的 state() 调用
        if (killswitch_->state().engaged) break;
        if (std::find(pendingTriggers.begin(), pendingTriggers.end(), pending) == pendingTriggers.end()) continue;
        pending->fired = true;  // 先落闩
        double limit = 0;
        execution::PlacementResult placement;
        std::optional<QString> failure;  // 券商的拒绝
        std::optional<QString> unknown;  // 连接层 / 事件循环的意外异常
        try {
            limit = co_await priceAutoMid(pending->approved);
            storePort_->markSubmitIntent(pending->record_id);
            placement = co_await router_->place(pending->record_id, pending->approved, limit);
        } catch (const execution::BrokerError& exc) {
            failure = exc.message();
        } catch (...) {
            unknown = jsx::errorMessage(std::current_exception());
        }
        if (failure) {
            storePort_->setFinalStatus(pending->record_id, u"ibkr_error"_s, *failure);
            const auto engaged = breakerPort_->recordFailure(*failure, u"broker"_s);
            notifier_->rejection(brokerCode(), *failure);
            if (engaged) {
                notifier_->breaker(engaged->reason);
                break;  // 熔断已挂起:本轮不再触发任何后续条件单
            }
            continue;
        }
        if (unknown) {
            // 连接层/事件循环的意外异常。去哪核对要跟着生效的券商说。
            const QString where = router_ && router_->broker() == u"futu" ? u"富途客户端"_s : u"TWS"_s;
            const QString detail = u"触发下单过程中发生未知异常,订单可能已经到达券商,请立即在"_s + where + u"里核对未成交单:"_s + *unknown;
            storePort_->setFinalStatus(pending->record_id, u"ibkr_error"_s, detail);
            const auto engaged = breakerPort_->recordFailure(*unknown, u"broker"_s);
            notifier_->rejection(brokerCode(), detail);
            if (engaged) {
                notifier_->breaker(engaged->reason);
                break;
            }
            continue;
        }
        breakerPort_->recordSuccess(u"broker"_s);
        indexPlacement(pending->record_id, placement);
        const auto idOrNull = [](const std::optional<int>& v) { return v ? js::N(*v) : js::Null(); };
        storePort_->appendEvent(pending->record_id, u"trigger"_s,
                                js::object({{u"symbol"_s, js::copyOrNull(js::prop(&pending->trigger, u"symbol"_s))}, {u"price"_s, *price}, {u"limit"_s, js::N(limit)}}));
        storePort_->appendEvent(pending->record_id, u"status"_s,
                                js::object({{u"status"_s, js::S(placement.status)}, {u"order_id"_s, idOrNull(placement.order_id)}, {u"perm_id"_s, idOrNull(placement.perm_id)}}));
        notifier_->notify(u"条件已触发"_s,
                          js::str(js::prop(&pending->trigger, u"symbol"_s)) + u" 现价 "_s + util::fmtF(js::num(price), 4) + u",已按净价 "_s + util::fmtF(limit, 4) + u" 提交"_s);
        fired << js::object({{u"record_id"_s, js::S(pending->record_id)}, {u"limit"_s, js::N(limit)}, {u"price"_s, *price}});
    }
    std::vector<std::shared_ptr<execution::PendingTrigger>> keep;
    for (const auto& p : pendingTriggers)
        if (!p->fired) keep.push_back(p);
    pendingTriggers = std::move(keep);
    co_return fired;
}

Task<double> TradingEngine::priceAutoMid(val::ApprovedOrder approved) {
    const OJson* contract = js::prop(&approved.order, u"contract"_s);
    const Rec contractRec = contract ? *contract : js::Null();
    const std::vector<execution::LegQuote> quotes = co_await router_->legQuotes(contractRec, approved.account);
    // 让价两种算法二选一:盘口价差的一份(auto_mid_spread_share > 0),或固定金额(max_spread_slippage)
    const double share = settings.limits.auto_mid_spread_share;
    const QString action = js::str(js::prop(js::prop(&approved.order, u"order"_s), u"action"_s));
    if (share > 0) co_return execution::autoMidShareLimit(quotes, action, share, execution::strikeWidth(contractRec));
    const double mid = execution::comboMidPrice(quotes);
    co_return execution::autoMidLimit(mid, action, settings.limits.max_spread_slippage, execution::strikeWidth(contractRec));
}

int TradingEngine::expirePending(std::optional<domain::EtNow> moment) {
    const domain::EtNow at = moment ? *moment : domain::nowEt();
    if (settings.marketStatus(at) != u"休市") return 0;
    int count = 0;
    for (const auto& pending : pendingTriggers) {
        if (js::str(js::prop(js::prop(&pending->approved.order, u"order"_s), u"tif"_s)) == u"GTC") continue;
        storePort_->setFinalStatus(pending->record_id, u"expired_untriggered"_s, std::nullopt);
        notifier_->warning(u"条件单当日未触发,已失效:"_s + js::str(js::prop(&pending->approved.order, u"intent_summary"_s)));
        pending->fired = true;
        count += 1;
    }
    std::vector<std::shared_ptr<execution::PendingTrigger>> keep;
    for (const auto& p : pendingTriggers)
        if (!p->fired) keep.push_back(p);
    pendingTriggers = std::move(keep);
    return count;
}

util::ProtectionState TradingEngine::protectionState(std::optional<double> nowMsArg) {
    const double now = nowMsArg ? *nowMsArg : util::dateNow();
    const contract::ProtectionsConfig& cfg = settings.protections;
    if (!util::protectionsEnabled(cfg)) return util::ProtectionState{};
    const double sinceMs = util::protectionsSince(cfg, now);
    try {
        // 日内亏损上限按账户当日盈亏算时,券商报的数由 accountGuard 现取;今天到过线的账户停到美东零点
        const QList<Rec> closesRows = storePort_->recentCloses(sinceMs, now);
        QList<Rec> pnlRows;
        if (util::needsPnlEvents(cfg)) pnlRows = storePort_->realizedPnlEvents(sinceMs, now);
        std::vector<util::CloseEvent> closes;
        for (const Rec& r : closesRows) closes.push_back({js::num(js::prop(&r, u"atMs"_s)), js::str(js::prop(&r, u"symbol"_s)), js::str(js::prop(&r, u"state"_s)),
                                                           js::strOr(js::prop(&r, u"leg"_s), QString())});
        std::vector<util::PnlEvent> pnl;
        for (const Rec& r : pnlRows) pnl.push_back({js::num(js::prop(&r, u"atMs"_s)), js::num(js::prop(&r, u"pnl"_s))});
        return accounts_->protections(cfg, closes, pnl, now);
    } catch (...) {
        // 算不出来就放行:保护规则误拦是妨碍交易,而它本身避免不了任何已经发生的亏损
        storePort_->audit(u"engine"_s, u"protections_failed"_s, js::object({{u"error"_s, js::S(jsx::errorMessage(std::current_exception()).left(300))}}));
        return util::ProtectionState{};
    }
}

Task<Rec> TradingEngine::halt(QString reason) {
    const util::BreakerState state = killswitch_->engage(reason);
    int cancelled = 0;
    // C++ 独有:撤单抛了也要把软件侧的队列与托管缓存清掉(TS 里 cancelAllOpen 一抛,这两步就被跳过——熔断合上了,队里的条件单却留着)
    std::exception_ptr cancelFailure;
    QString cancelFailureText;
    try {
        if (router_) cancelled = co_await router_->cancelAllOpen();
    } catch (...) {
        cancelFailure = std::current_exception();
        cancelFailureText = jsx::errorMessage(cancelFailure);
    }
    pendingTriggers.clear();
    // 托管单也被 cancelAllOpen 撤掉了,缓存跟着清;熔断解除后由对账循环按闸门决定要不要重挂
    hostedOrders_->clear();
    if (cancelFailure) {
        storePort_->audit(u"user"_s, u"halt"_s, js::object({{u"reason"_s, js::S(reason)}, {u"cancelled"_s, js::N(0)}, {u"cancel_failed"_s, js::S(cancelFailureText.left(300))}}));
        notifier_->breaker(reason + u"(撤单失败:"_s + cancelFailureText.left(200) + u";软件侧的条件单已清,请立刻到券商核对未成交单)"_s);
        std::rethrow_exception(cancelFailure);
    }
    storePort_->audit(u"user"_s, u"halt"_s, js::object({{u"reason"_s, js::S(reason)}, {u"cancelled"_s, js::N(cancelled)}}));
    notifier_->breaker(reason + u"(已撤销 "_s + QString::number(cancelled) + u" 笔未成交单)"_s);
    co_return js::object({{u"engaged"_s, js::B(state.engaged)}, {u"cancelled"_s, js::N(cancelled)}});
}

// ------------------------------------------------------------------ 回报接线用的小账
void TradingEngine::indexPlacement(const QString& recordId, const execution::PlacementResult& placement) {
    for (const std::optional<int>& key : {placement.perm_id, placement.order_id}) {
        if (key && *key != 0) orderIndex.insert(*key, recordId);
    }
    if (placement.order_id && *placement.order_id != 0) sentOrders.insert(*placement.order_id, SentOrder{util::dateNow(), SentOrder::Kind::Place});
    replayUnmatched();
}

// ------------------------------------------------------------------ 落库
Rec TradingEngine::baseRecord(const QString& instruction, const QString& channel, const providers::LLMResponse* response) {
    return js::object({{u"input"_s, js::object({{u"raw_instruction"_s, js::S(instruction)}, {u"reason"_s, js::S(QString())}, {u"input_channel"_s, js::S(channel)}})},
                       {u"llm"_s, js::object({{u"model"_s, response ? response->model : js::S(QString())},
                                              {u"prompt_version"_s, js::S(response ? response->prompt_version : QString())},
                                              {u"prompt_fingerprint"_s, js::S(response ? response->prompt_fingerprint : QString())},
                                              {u"intent_summary"_s, js::S(QString())},
                                              {u"confidence"_s, js::Null()},
                                              {u"warnings"_s, js::array()},
                                              {u"raw_response"_s, js::S(response ? response->text : QString())},
                                              {u"usage"_s, response ? response->usage : js::object()}})},
                       {u"execution_type"_s, js::Null()},
                       {u"trigger"_s, js::Null()},
                       {u"triggered_at"_s, js::Null()},
                       {u"account"_s, js::object()},
                       {u"contract"_s, js::object()},
                       {u"order"_s, js::object()},
                       {u"ibkr"_s, js::object({{u"order_id"_s, js::Null()},
                                               {u"perm_id"_s, js::Null()},
                                               {u"status_timeline"_s, js::array()},
                                               {u"fills"_s, js::array()},
                                               {u"avg_fill_price"_s, js::Null()},
                                               {u"total_commission"_s, js::Null()},
                                               {u"realized_pnl"_s, js::Null()}})},
                       {u"final_status"_s, js::Null()},
                       {u"error_detail"_s, js::Null()},
                       {u"signature"_s, js::S(QString())}});
}

QString TradingEngine::recordApproved(const QString& instruction, const QString& channel, const providers::LLMResponse& response, const val::ApprovedOrder& approved) {
    const Rec& order = approved.order;
    Rec record = baseRecord(instruction, channel, &response);
    record.get(u"input"_s)->set(u"reason"_s, js::copyOrNull(js::prop(&order, u"reason"_s)));
    Rec* llm = record.get(u"llm"_s);
    llm->set(u"intent_summary"_s, js::copyOrNull(js::prop(&order, u"intent_summary"_s)));
    llm->set(u"confidence"_s, js::copyOrNull(js::prop(&order, u"confidence"_s)));
    llm->set(u"warnings"_s, js::strings(approved.warnings));
    record.set(u"execution_type"_s, js::copyOrNull(js::prop(&order, u"execution_type"_s)));
    const OJson* trig = js::prop(&order, u"trigger"_s);
    record.set(u"trigger"_s, js::truthy(trig) ? *trig : js::Null());
    record.set(u"account"_s, js::object({{u"alias"_s, js::S(approved.account.alias)}, {u"account_id"_s, js::S(approved.account.account_id)}, {u"is_paper"_s, js::B(approved.account.is_paper)}}));
    record.set(u"contract"_s, dumpExcludeNone(js::copyOrNull(js::prop(&order, u"contract"_s))));
    record.set(u"order"_s, dumpExcludeNone(js::copyOrNull(js::prop(&order, u"order"_s))));
    record.set(u"notional_estimate"_s, js::N(util::pyRound(approved.notional, 2)));
    record.set(u"signature"_s, js::S(approved.signature));
    return storePort_->createRecord(record);
}

QString TradingEngine::recordRejection(const QString& instruction, const QString& channel, const providers::LLMResponse& response, const Rec& rejection,
                                       const QString& finalStatus) {
    Rec record = baseRecord(instruction, channel, &response);
    record.get(u"llm"_s)->set(u"intent_summary"_s, js::copyOrNull(js::prop(&rejection, u"original_text"_s)));
    record.set(u"rejection"_s, rejection);
    const QString recordId = storePort_->createRecord(record);
    storePort_->setFinalStatus(recordId, finalStatus, js::str(js::prop(&rejection, u"message"_s)));
    return recordId;
}

QString TradingEngine::recordValidatorRejection(const QString& instruction, const QString& channel, const providers::LLMResponse& response,
                                                const val::RejectedOrder& rejected) {
    const Rec& order = rejected.order;
    Rec record = baseRecord(instruction, channel, &response);
    record.get(u"input"_s)->set(u"reason"_s, js::copyOrNull(js::prop(&order, u"reason"_s)));
    Rec* llm = record.get(u"llm"_s);
    llm->set(u"intent_summary"_s, js::copyOrNull(js::prop(&order, u"intent_summary"_s)));
    llm->set(u"confidence"_s, js::copyOrNull(js::prop(&order, u"confidence"_s)));
    record.set(u"execution_type"_s, js::copyOrNull(js::prop(&order, u"execution_type"_s)));
    const OJson* trig = js::prop(&order, u"trigger"_s);
    record.set(u"trigger"_s, js::truthy(trig) ? *trig : js::Null());
    record.set(u"contract"_s, dumpExcludeNone(js::copyOrNull(js::prop(&order, u"contract"_s))));
    record.set(u"order"_s, dumpExcludeNone(js::copyOrNull(js::prop(&order, u"order"_s))));
    Rec issues = js::array();
    for (const val::Issue& i : rejected.issues) issues.items.append(js::object({{u"code"_s, js::S(i.code)}, {u"message"_s, js::S(i.message)}}));
    record.set(u"rejection"_s, js::object({{u"code"_s, js::S(val::primaryCode(rejected))}, {u"message"_s, js::S(val::rejectionMessage(rejected))}, {u"issues"_s, issues}}));
    const QString recordId = storePort_->createRecord(record);
    storePort_->setFinalStatus(recordId, u"rejected_by_validator"_s, val::rejectionMessage(rejected));
    return recordId;
}

}  // namespace ibkr::orchestrate
