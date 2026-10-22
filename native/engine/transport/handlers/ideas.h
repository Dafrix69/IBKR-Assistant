// engine-ts/src/rpc/handlers/ideas.ts 逐句搬:ideas.*——想法备忘、AI 分析与知识总结(handlers2 簇)。
//
// TS 原样照搬的怪行为(别当 bug 改):
//   · ideas.list / ideas.digests:`Number(limit || 默认)`——0 与空串走默认值,"abc" 得 NaN 原样流进 listIdeas / SQL;`Math.min(x, 上限)` 对 NaN 仍是 NaN。
//   · ideas.search:`Number.isFinite(n) && n > 0` 才取 min(n, 200),否则 50(所以 "abc" / 负数 / 0.5 之类都是 50)。
//   · ideas.add 的字数是 `[...text].length`(码点数),2000 封顶。
//   · ideas.analyze:`JSON.stringify(freshSymbols) !== JSON.stringify(idea.symbols ?? [])` 才改库;提示词里的「周几」按美东日历日算,不是按 wallParts。
//   · ideas.digest:`statusLabel[status] ?? status`;条数在 slice(0,100) 之后才判空;交易结果的「时间线」里 sort() 是 UTF-16 码元序的默认排序。
//   · zod 的 `.parse()` 失败文案见 handlers2_support.h 的 zodErrorMessage(只还原到 Issue 带的字段,已知差异)。
// 与 TS 的不同:`await import(...)`(动态 import)不搬;`this.router !== null && this.router.sessions().length` 收成 liveRouter()。
#pragma once

#include "transport/context.h"
#include "transport/handlers/handlers2_ports.h"

namespace ibkr::rpc {

class IdeasHandlers : public HandlerBase {
public:
    IdeasHandlers(RpcContext& ctx, Handlers2Ports& ports) : HandlerBase(ctx), ports_(ports) {}
    MethodTable methods() override;

    static const QString kAnalyzeSystem;      // IDEA_ANALYZE_SYSTEM
    static const QString kDigestSystem;       // IDEA_DIGEST_SYSTEM
    static const QString kDigestTradesSystem; // IDEA_DIGEST_TRADES_SYSTEM

private:
    util::OJson ideasAdd(const util::OJson& params);
    util::OJson ideasList(const util::OJson& params);
    util::OJson ideasUpdate(const util::OJson& params);
    util::OJson ideasDigests(const util::OJson& params);
    util::Task<util::OJson> ideasSearch(util::OJson params);
    util::Task<util::OJson> ideasAnalyze(util::OJson params);
    util::Task<util::OJson> ideasDigest(util::OJson params);
    util::Task<util::OJson> ideasSimilarTrades(util::OJson params);
    /// 带焦点的取数:范围内最近的一批 + 命中焦点的按时间分层抽。返回新的在前
    util::Task<QList<util::OJson>> pickByFocus(QString scope, util::OJson focus);
    /// 语义挑选用的「调一次大模型要 JSON」:配置里的那个模型(同知识总结)
    orchestrate::LlmJson llmJson();
    util::Task<util::OJson> runLlm(QString system, QString user, util::OJson schema);

    Handlers2Ports& ports_;
};

}  // namespace ibkr::rpc
