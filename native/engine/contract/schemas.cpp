#include "contract/schemas.h"

using namespace Qt::StringLiterals;
using ibkr::util::OJson;

namespace ibkr::contract {

namespace {

using Shape = std::vector<std::pair<QString, zod::SchemaPtr>>;

zod::SchemaPtr str() { return zod::string(); }
zod::SchemaPtr num() { return zod::number(); }
zod::SchemaPtr boolean() { return zod::boolean(); }
zod::SchemaPtr unknown() { return zod::unknown(); }
/// z.record(z.string(), z.unknown())
zod::SchemaPtr recordUnknown() { return zod::record(zod::string(), zod::unknown()); }
/// z.union([z.number(), z.string()])
zod::SchemaPtr numOrStr() { return unionOf({zod::number(), zod::string()}); }

// ---------------------------------------------------------------- alerts.ts
ParamsSchema alertsCreate() {
    return obj({
        {u"symbol"_s, str()},
        // 老 handler 是 Number(step) || 5:数字串也认,所以这里不写死 z.number()
        {u"step"_s, optional(numOrStr())},
        // 认哪个值由 handler 定("tracker" 之外一律当空串)
        {u"origin"_s, optional(str())},
    });
}
ParamsSchema alertsDelete() { return obj({{u"id"_s, str()}}); }
ParamsSchema alertsRefresh() {
    return obj({
        {u"id"_s, str()},
        {u"expiry"_s, optional(str())},
        // 同 alerts.create:数字串也认,范围由 handler 报
        {u"step"_s, optional(numOrStr())},
    });
}
/// config 只要求"是个对象"(同 quality.set_config)
ParamsSchema alertsSetTouchConfig() {
    return obj({
        {u"config"_s, recordUnknown()},
        // 认哪两个值由 handler 报(给中文原因)
        {u"cross_confirm"_s, optional(unknown())},
    });
}

// ---------------------------------------------------------------- backtest.ts
ParamsSchema backtestRun() {
    return obj({
        {u"symbol"_s, str()},
        // golden-rpc 有一条只带一个坏代码的请求,期望的是「股票代码不合法」:这三项没带不能在这里拒
        {u"start"_s, requiredButReportedByHandler()},
        {u"end"_s, requiredButReportedByHandler()},
        {u"strategy"_s, requiredButReportedByHandler()},
        {u"params"_s, optional(recordUnknown())},
        {u"rules"_s, unknown()},
        {u"instrument"_s, unknown()},
        {u"cost_pct"_s, unknown()},
    });
}
ParamsSchema backtestSweep() {
    return obj({
        {u"symbols"_s, zod::array(str())},
        {u"start"_s, unknown()},
        {u"end"_s, unknown()},
        {u"strategy"_s, unknown()},
        {u"grid"_s, optional(zod::record(zod::string(), zod::array(numOrStr())))},
        {u"instrument"_s, unknown()},
        {u"cost_pct"_s, unknown()},
        {u"split_pct"_s, unknown()},
        {u"folds"_s, unknown()},
        {u"objective"_s, unknown()},
    });
}
// 不带 text 由 handler 报「策略描述为空」:golden-rpc 钉着这一句
ParamsSchema backtestParseRules() { return obj({{u"text"_s, requiredButReportedByHandler()}}); }

// ---------------------------------------------------------------- connection.ts
// provider:不给 / 给个不认识的,都由 handler 报「只支持 ibkr、futu」,所以收 unknown
ParamsSchema brokerSelect() { return obj({{u"provider"_s, unknown()}}); }
ParamsSchema brokerConnect() { return obj({{u"connections"_s, optional(zod::array(str()))}}); }
// 不认识的名字由 handler 报「未定义的连接:…」
ParamsSchema diagnose() { return obj({{u"connections"_s, optional(zod::array(str()))}}); }
// 只认固定的键:不认识的由 handler 报「只支持拉起 tws 或 gateway / opend」
ParamsSchema launch() { return obj({{u"app"_s, unknown()}}); }
ParamsSchema futuUnlock() { return obj({{u"connection"_s, optional(str())}}); }
ParamsSchema futuSetPassword() {
    return obj({
        // 不带密码时老 handler 报「交易解锁密码为空」,不换成 schema 的「缺少 password」
        {u"password"_s, requiredButReportedByHandler()},
        {u"already_md5"_s, unknown()},
    })->strict();
}

// ---------------------------------------------------------------- events.ts
ParamsSchema eventsList() { return obj({{u"force"_s, optional(truthyOf())}}); }
ParamsSchema eventsSetConfig() { return obj({{u"config"_s, recordUnknown()}}); }
ParamsSchema eventsAdd() {
    return obj({
        {u"title"_s, str()},
        {u"date_et"_s, str()},
        {u"time_et"_s, str()},
        {u"note"_s, optional(str())},
        {u"impact"_s, optional(zod::enumOf({u"high"_s, u"medium"_s}))},
        {u"linger_min"_s, optional(num())},
    });
}
ParamsSchema eventsRemove() { return obj({{u"id"_s, str()}}); }

// ---------------------------------------------------------------- follow.ts
ParamsSchema followSetToken() { return obj({{u"token"_s, str()}})->strict(); }

// ---------------------------------------------------------------- ideas.ts
// 老 handler 是 Number(limit || 默认值):数字串也认,所以不写死 z.number()
zod::SchemaPtr ideasLimit() { return optional(numOrStr()); }

ParamsSchema ideasAdd() { return obj({{u"text"_s, str()}}); }
ParamsSchema ideasList() { return obj({{u"status"_s, optional(str())}, {u"limit"_s, ideasLimit()}}); }
ParamsSchema ideasUpdate() {
    return obj({
        // 不带 id 由 handler 报「缺少想法 id」:golden-rpc 钉着这一句
        {u"id"_s, requiredButReportedByHandler()},
        {u"status"_s, str()},
    });
}
ParamsSchema ideasAnalyze() { return obj({{u"id"_s, str()}}); }
ParamsSchema ideasDigest() {
    // 焦点只管结构;词多长、标的认不认识是 handler 的事
    const auto focus = obj({{u"q"_s, optional(str())}, {u"symbols"_s, optional(zod::array(str()))}});
    return obj({
        {u"scope"_s, optional(str())},
        {u"focus"_s, optional(focus)},
        {u"trades"_s, optional(boolean())},
    });
}
ParamsSchema ideasSearch() {
    return obj({
        {u"q"_s, optional(str())},
        {u"symbols"_s, optional(unionOf({zod::array(str()), zod::string()}))},
        {u"since"_s, optional(str())},
        {u"until"_s, optional(str())},
        {u"status"_s, optional(str())},
        {u"limit"_s, ideasLimit()},
    });
}
// 票据只管结构;认不认得是什么结构、价是不是合理,是 handler 与 tradeSimilar 的事
ParamsSchema ideasSimilarTrades() {
    const auto leg = obj({
        {u"action"_s, str()},
        {u"ratio"_s, num()},
        {u"strike"_s, zod::number()->nullable()},
        {u"right"_s, zod::string()->nullable()},
    });
    return obj({
        {u"sec_type"_s, str()},
        {u"symbol"_s, str()},
        {u"action"_s, str()},
        {u"limit_price"_s, optional(zod::number()->nullable())},
        {u"expiry"_s, optional(zod::string()->nullable())},
        {u"right"_s, optional(zod::string()->nullable())},
        {u"combo_strategy"_s, optional(zod::string()->nullable())},
        {u"legs"_s, optional(zod::array(leg))},
    });
}
ParamsSchema ideasDigests() { return obj({{u"limit"_s, ideasLimit()}}); }

// ---------------------------------------------------------------- instruction.ts
ParamsSchema instructionSubmit() {
    return obj({
        // 老 handler 是 String(params["text"] ?? "").trim(),空了报「指令为空」——不给也要走到 handler
        {u"text"_s, requiredButReportedByHandler()},
        // Boolean(params["execute"]):给什么都认,只看真假
        {u"execute"_s, optional(truthyOf())},
        // **不写 z.array()**:golden-rpc 钉着「accounts 必须是账户别名数组」这句话;整条(是不是数组、每项是不是字符串、
        // 别名在不在表里)都归 handler
        {u"accounts"_s, optional(passThrough())},
        {u"channel"_s, optional(str())},
    })->strict();
}

// ---------------------------------------------------------------- intel.ts
ParamsSchema intelFeed() {
    const auto kinds = zod::array(zod::enumOf({u"message"_s, u"signal"_s, u"event"_s, u"order"_s, u"idea"_s}));
    return obj({
        {u"symbol"_s, optional(str())},
        {u"kinds"_s, optional(kinds)},
        {u"held_only"_s, optional(truthyOf())},
        {u"limit"_s, optional(num())},
        {u"since"_s, optional(num())},
    });
}
ParamsSchema intelDossier() { return obj({{u"symbol"_s, str()}, {u"limit"_s, optional(num())}}); }

// ---------------------------------------------------------------- llm.ts
zod::SchemaPtr llmInput() { return optional(recordUnknown()); }
ParamsSchema llmPatch() { return obj({{u"llm"_s, llmInput()}})->strict(); }
ParamsSchema llmTest() {
    return obj({
        {u"llm"_s, llmInput()},
        // 老 handler 是 params.api_key || null:空串 = 没给
        {u"api_key"_s, optional(str())},
    });
}

// ---------------------------------------------------------------- market.ts
// 不带 symbol:按规矩归 schema 报「缺少 symbol」;给了个非字符串同理
ParamsSchema bookSnapshot() { return obj({{u"symbol"_s, str()}}); }
// 老 handler 是 Boolean(params["force"]):给什么都收,照旧
ParamsSchema macroBoard() { return obj({{u"force"_s, optional(truthyOf())}}); }

// ---------------------------------------------------------------- options.ts
ParamsSchema optionsWall() {
    return obj({
        {u"symbol"_s, str()},
        {u"expiry"_s, optional(str())},
        // 老 handler 是 Math.trunc(Number(width ?? 10)):数字串也认
        {u"width"_s, optional(numOrStr())},
    });
}
// 新方法,数值一律是数字;strict:键名写错了(iv_shift 少了 _pct)当场拒
ParamsSchema flyPlan() {
    return obj({
        {u"symbol"_s, optional(str())},
        {u"expiry"_s, optional(str())},
        {u"center"_s, num()},
        {u"width"_s, num()},
        {u"right"_s, optional(str())},
        {u"quantity"_s, optional(num())},
        {u"cost"_s, optional(num())},
        {u"target_spot"_s, num()},
        {u"target_time"_s, str()},
        {u"target_date"_s, optional(str())},
        {u"spot"_s, optional(num())},
        {u"iv"_s, optional(num())},
        {u"iv_mode"_s, optional(zod::enumOf({u"auto"_s, u"flat"_s, u"shift"_s}))},
        {u"iv_shift_pct"_s, optional(num())},
    })->strict();
}
ParamsSchema ivRecorderSet() { return obj({{u"enabled"_s, boolean()}})->strict(); }
ParamsSchema optionsSpot() { return obj({{u"symbol"_s, optional(str())}})->strict(); }
ParamsSchema playbookSet() { return obj({{u"enabled"_s, boolean()}})->strict(); }

// ---------------------------------------------------------------- pool.ts
ParamsSchema poolSetWatch() {
    return obj({{u"symbol"_s, str()}, {u"price"_s, optional(boolean())}, {u"anomaly"_s, optional(boolean())}});
}

// ---------------------------------------------------------------- priceaction.ts
/// pa.analyze 与 pa.comment 同一份。rth / force 老 handler 都是 Boolean(x) / 三值判断:给什么都收,照旧
ParamsSchema paAnalyze() {
    return obj({{u"symbol"_s, str()}, {u"timeframe"_s, optional(str())}, {u"rth"_s, unknown()}, {u"force"_s, unknown()}});
}

// ---------------------------------------------------------------- quality.ts
ParamsSchema qualityAdd() { return obj({{u"symbol"_s, str()}, {u"note"_s, optional(str())}, {u"company"_s, optional(str())}}); }
ParamsSchema qualityUpdate() { return obj({{u"id"_s, str()}, {u"enabled"_s, optional(boolean())}, {u"note"_s, optional(str())}}); }
ParamsSchema qualityRemove() { return obj({{u"id"_s, str()}}); }
ParamsSchema qualitySetConfig() { return obj({{u"config"_s, recordUnknown()}}); }

// ---------------------------------------------------------------- records.ts
ParamsSchema recordsList() { return obj({{u"limit"_s, optional(numOrStr())}}); }
ParamsSchema recordsGet() { return obj({{u"id"_s, optional(str())}}); }

// ---------------------------------------------------------------- review.ts
ParamsSchema reviewCandidates() {
    return obj({
        // 老 handler 是 Number(limit ?? 200) || 200:数字串、0 都照收
        {u"limit"_s, optional(numOrStr())},
        // 老 handler 只看真假
        {u"include_local"_s, unknown()},
    });
}
ParamsSchema reviewAnalyze() {
    return obj({
        {u"id"_s, str()},
        {u"timeframe"_s, optional(str())},
        {u"exit"_s, unknown()},
    });
}
ParamsSchema reviewPerformance() {
    return obj({
        {u"scope"_s, optional(zod::enumOf({u"all"_s, u"live"_s, u"paper"_s}))},
        {u"kind"_s, optional(zod::enumOf({u"all"_s, u"butterfly"_s, u"stock"_s, u"option"_s}))},
        // 天数的范围(正整数、上限)是领域校验,在 handler
        {u"days"_s, optional(num())},
    });
}
ParamsSchema reviewSignals() { return obj({{u"days"_s, optional(num())}}); }

// ---------------------------------------------------------------- screener.ts
// 老 handler 一律过 optInt / optFloat:数字串照收,所以不写死 z.number()
zod::SchemaPtr screenerNumberField() { return optional(numOrStr()); }

ParamsSchema screenerRs() { return obj({{u"sector"_s, optional(str())}, {u"benchmark"_s, optional(str())}}); }
ParamsSchema screenerLeaders() { return obj({{u"sector"_s, optional(str())}, {u"benchmark"_s, optional(str())}}); }
ParamsSchema screenerInflection() {
    return obj({
        {u"sector"_s, optional(str())},
        // 不是数组、空数组,都由 handler 报「timeframes 要是非空数组」,所以这里收 unknown
        {u"timeframes"_s, unknown()},
        {u"ma_period"_s, screenerNumberField()},
    });
}
ParamsSchema screenerDeviation() {
    return obj({
        {u"symbol"_s, str()},
        {u"timeframe"_s, optional(str())},
        {u"period"_s, screenerNumberField()},
        {u"lookback"_s, screenerNumberField()},
        {u"smooth"_s, screenerNumberField()},
        {u"z_extreme"_s, screenerNumberField()},
    });
}

// ---------------------------------------------------------------- sectors.ts
ParamsSchema sectorsAdd() { return obj({{u"name"_s, str()}}); }
ParamsSchema sectorsId() { return obj({{u"id"_s, str()}}); }
ParamsSchema sectorsAddStock() {
    return obj({{u"id"_s, str()}, {u"symbol"_s, str()}, {u"company"_s, optional(str())}, {u"tag"_s, optional(str())}});
}
ParamsSchema sectorsRemoveStock() { return obj({{u"id"_s, str()}, {u"symbol"_s, str()}}); }
ParamsSchema sectorsSetTag() { return obj({{u"id"_s, str()}, {u"symbol"_s, str()}, {u"tag"_s, optional(str())}}); }

// ---------------------------------------------------------------- settings.ts
ParamsSchema settingsPatch() { return obj({{u"patch"_s, optional(recordUnknown())}})->strict(); }
ParamsSchema keychainSet() { return obj({{u"secret"_s, str()}, {u"provider"_s, optional(str())}})->strict(); }
ParamsSchema dataExport() { return obj({{u"path"_s, str()}}); }

// ---------------------------------------------------------------- system.ts
// 老 handler 是 String(params["reason"] || 默认句):这里只管"是不是个串",不替它判空
ParamsSchema breakerHalt() { return obj({{u"reason"_s, optional(str())}}); }

// ---------------------------------------------------------------- tracker.ts(这个域整个是 strict)
/// 表单里的一个数:数字或字符串,原样交给 handler 的 optFloat('' → 不设,"abc" → 「不是有效数字」)
zod::SchemaPtr numberField() { return optional(numOrStr()); }
/// z.union([z.number(), z.string(), z.null()])
zod::SchemaPtr numStrNull() { return unionOf({zod::number(), zod::string(), zod::null()}); }

Shape targetsInput() {
    return {
        {u"take_profit"_s, numberField()},
        {u"stop_loss"_s, numberField()},
        {u"trail_pct"_s, numberField()},
        {u"profit_drawdown_pct"_s, numberField()},
        {u"profit_drawdown_preset"_s, optional(str())},
        {u"profit_drawdown_tiers"_s,
         optional(unionOf({
             zod::literal(OJson::string(QString())),
             zod::array(obj({{u"above"_s, numStrNull()}, {u"pct"_s, numStrNull()}})->strict()),
         }))},
        {u"profit_drawdown_late"_s, optional(obj({{u"after"_s, str()}, {u"factor"_s, numberField()}})->strict())},
        {u"profit_drawdown_arm_pct"_s, numberField()},
        {u"spot_target"_s, numberField()},
        {u"spot_stop_below"_s, numberField()},
        {u"spot_stop_above"_s, numberField()},
        {u"spot_stop_confirm_s"_s, numberField()},
        {u"exit_at"_s, optional(str())},
        {u"take_profit_tiers"_s,
         optional(unionOf({
             zod::literal(OJson::string(QString())),
             zod::array(obj({{u"price"_s, numStrNull()}, {u"fraction_pct"_s, numStrNull()}})->strict()),
         }))},
    };
}

ParamsSchema trackerAdd() {
    Shape shape{{u"key"_s, str()}};
    for (auto& f : targetsInput()) shape.push_back(std::move(f));
    const Shape rest{
        // 授权发单的两个开关只收布尔:Boolean("false") 是 true,这种值不能靠"真假"糊过去
        {u"auto_close"_s, optional(boolean())},
        {u"order_type"_s, optional(str())},
        {u"slippage_pct"_s, numberField()},
        {u"close_fraction_pct"_s, numberField()},
        {u"host_at_broker"_s, optional(boolean())},
        {u"chase_max_pct"_s, numberField()},
        {u"stop_basis"_s, optional(str())},
        {u"stop_chase_grace"_s, numberField()},
        {u"stop_chase_step"_s, numberField()},
        {u"stop_chase_max_pct"_s, numberField()},
        {u"peak_confirm"_s, optional(boolean())},
        {u"chase_lead"_s, numberField()},
        {u"chase_interval_s"_s, numberField()},
        {u"note"_s, optional(str())},
    };
    for (const auto& f : rest) shape.push_back(f);
    return obj(std::move(shape))->strict();
}

ParamsSchema trackerUpdate() {
    const auto autoClose = obj({
                                   {u"enabled"_s, boolean()},
                                   {u"order_type"_s, str()},
                                   {u"slippage_pct"_s, num()},
                                   {u"close_fraction_pct"_s, num()},
                                   {u"host_at_broker"_s, boolean()},
                                   {u"chase_max_pct"_s, num()},
                                   {u"stop_basis"_s, str()},
                                   // 这三项收 null:null = 回到"和止盈同一套"(别的键不收 null)
                                   {u"stop_chase_grace"_s, zod::number()->nullable()},
                                   {u"stop_chase_step"_s, zod::number()->nullable()},
                                   {u"stop_chase_max_pct"_s, zod::number()->nullable()},
                                   {u"peak_confirm"_s, boolean()},
                                   // 同上:null = 回到默认(1 倍、1 秒)
                                   {u"chase_lead"_s, zod::number()->nullable()},
                                   {u"chase_interval_s"_s, zod::number()->nullable()},
                               })
                               ->partial()
                               ->strict();
    Shape shape{{u"id"_s, str()}, {u"enabled"_s, optional(boolean())}, {u"auto_close"_s, optional(autoClose)}};
    for (auto& f : targetsInput()) shape.push_back(std::move(f));
    return obj(std::move(shape))->strict();
}

ParamsSchema trackerDelete() { return obj({{u"id"_s, str()}})->strict(); }
ParamsSchema trackerTargetPreview() {
    return obj({{u"key"_s, str()}, {u"spot_target"_s, numberField()}, {u"chase_max_pct"_s, numberField()}})->strict();
}
/// 手动平仓:直接发一张平仓单,所以顶层 strict;不给 id 由 handler 报「没有这个追踪」
ParamsSchema trackerCloseNow() { return obj({{u"id"_s, requiredButReportedByHandler()}})->strict(); }

}  // namespace

const std::vector<NamedSchema>& paramsSchemas() {
    static const std::vector<NamedSchema> table = [] {
        const ParamsSchema none = noParams();
        const ParamsSchema paAnalyzeSchema = paAnalyze();
        const ParamsSchema sectorsIdSchema = sectorsId();
        const ParamsSchema diagnoseSchema = diagnose();
        const ParamsSchema launchSchema = launch();
        return std::vector<NamedSchema>{
            {u"alerts.list"_s, none},
            {u"alerts.create"_s, alertsCreate()},
            {u"alerts.delete"_s, alertsDelete()},
            {u"alerts.refresh"_s, alertsRefresh()},
            {u"alerts.poll"_s, none},
            {u"alerts.set_touch_config"_s, alertsSetTouchConfig()},

            {u"book.snapshot"_s, bookSnapshot()},

            {u"llm.catalog"_s, none},
            {u"llm.patch"_s, llmPatch()},
            {u"llm.test"_s, llmTest()},

            {u"macro.board"_s, macroBoard()},

            {u"events.list"_s, eventsList()},
            {u"events.set_config"_s, eventsSetConfig()},
            {u"events.add"_s, eventsAdd()},
            {u"events.remove"_s, eventsRemove()},

            {u"intel.feed"_s, intelFeed()},
            {u"intel.dossier"_s, intelDossier()},

            {u"backtest.strategies"_s, none},
            {u"backtest.run"_s, backtestRun()},
            {u"backtest.sweep"_s, backtestSweep()},
            {u"backtest.parse_rules"_s, backtestParseRules()},

            {u"broker.catalog"_s, none},
            {u"broker.select"_s, brokerSelect()},
            {u"broker.connect"_s, brokerConnect()},
            {u"broker.disconnect"_s, none},

            {u"tws.scan"_s, none},
            {u"tws.diagnose"_s, diagnoseSchema},
            {u"tws.launch"_s, launchSchema},

            {u"futu.scan"_s, none},
            {u"futu.diagnose"_s, diagnoseSchema},
            {u"futu.launch"_s, launchSchema},
            {u"futu.unlock"_s, futuUnlock()},
            {u"futu.set_password"_s, futuSetPassword()},

            {u"follow.status"_s, none},
            {u"follow.set_token"_s, followSetToken()},
            {u"follow.reconnect"_s, none},

            {u"ideas.add"_s, ideasAdd()},
            {u"ideas.list"_s, ideasList()},
            {u"ideas.update"_s, ideasUpdate()},
            {u"ideas.analyze"_s, ideasAnalyze()},
            {u"ideas.digest"_s, ideasDigest()},
            {u"ideas.digests"_s, ideasDigests()},
            {u"ideas.search"_s, ideasSearch()},
            {u"ideas.similar_trades"_s, ideasSimilarTrades()},

            {u"options.wall"_s, optionsWall()},
            {u"options.entry_context"_s, none},
            {u"options.fly_plan"_s, flyPlan()},
            {u"options.iv_recorder"_s, none},
            {u"options.iv_recorder_set"_s, ivRecorderSet()},
            {u"options.spot"_s, optionsSpot()},
            {u"options.playbook"_s, none},
            {u"options.playbook_set"_s, playbookSet()},

            {u"pa.timeframes"_s, none},
            {u"pa.analyze"_s, paAnalyzeSchema},
            {u"pa.comment"_s, paAnalyzeSchema},

            {u"pool.set_watch"_s, poolSetWatch()},

            {u"positions.list"_s, none},

            {u"quality.list"_s, none},
            {u"quality.add"_s, qualityAdd()},
            {u"quality.update"_s, qualityUpdate()},
            {u"quality.remove"_s, qualityRemove()},
            {u"quality.set_config"_s, qualitySetConfig()},

            {u"review.candidates"_s, reviewCandidates()},
            {u"review.analyze"_s, reviewAnalyze()},
            {u"review.performance"_s, reviewPerformance()},
            {u"review.signals"_s, reviewSignals()},

            {u"screener.rs"_s, screenerRs()},
            {u"screener.inflection"_s, screenerInflection()},
            {u"screener.deviation"_s, screenerDeviation()},
            {u"screener.leaders"_s, screenerLeaders()},

            {u"sectors.list"_s, none},
            {u"sectors.add"_s, sectorsAdd()},
            {u"sectors.delete"_s, sectorsIdSchema},
            {u"sectors.pick"_s, sectorsIdSchema},
            {u"sectors.quotes"_s, none},
            {u"sectors.add_stock"_s, sectorsAddStock()},
            {u"sectors.earnings"_s, obj({{u"symbol"_s, str()}})->strict()},
            {u"sectors.remove_stock"_s, sectorsRemoveStock()},
            {u"sectors.set_tag"_s, sectorsSetTag()},

            {u"settings.get"_s, none},
            {u"settings.patch"_s, settingsPatch()},
            {u"keychain.set"_s, keychainSet()},
            {u"data.export"_s, dataExport()},
            {u"data.backups"_s, none},
            {u"data.backup"_s, none},

            {u"instruction.submit"_s, instructionSubmit()},

            {u"records.list"_s, recordsList()},
            {u"records.get"_s, recordsGet()},

            {u"pending.list"_s, none},
            {u"pending.poll"_s, none},

            {u"system.status"_s, none},
            {u"system.selftest"_s, none},

            {u"breaker.state"_s, none},
            {u"breaker.halt"_s, breakerHalt()},
            {u"breaker.resume"_s, none},

            {u"tracker.list"_s, none},
            {u"tracker.add"_s, trackerAdd()},
            {u"tracker.update"_s, trackerUpdate()},
            {u"tracker.delete"_s, trackerDelete()},
            {u"tracker.target_preview"_s, trackerTargetPreview()},
            {u"tracker.poll"_s, none},
            {u"tracker.reconcile"_s, none},
            {u"tracker.close_now"_s, trackerCloseNow()},
        };
    }();
    return table;
}

}  // namespace ibkr::contract
