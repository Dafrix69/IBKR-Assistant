// services/ideaSemantic.ts 逐句搬:想法的语义检索(第二期)——给关键词检索补上「意思相近、字面对不上」的那几条。两种做法,mode 选:
//   llm(默认):把查询和池里的想法(短编号 + 原文)交给配置的大模型,让它挑相关的编号;按「查询 + 这批想法」缓存;挑回来的编号由代码核对,只认池里真有的。
//   embed:本机 Ollama 嵌入 + 余弦,门槛跟着模型走;想法的向量懒算存库(store.vectors)。
// 出任何错(模型报错、超时、回包不对)返回空(= TS 的 null),调用方退回纯关键词,一句不报错。
// 期望值:tests/fixtures/gen_svc_ideasemantic.mjs(原 IdeaSemanticService 对着假大模型 / 假嵌入器、真的交易库现跑),tests/tst_svc_ideasemantic.cpp。
//
// 与 TS 的对应与不同:
//   · 测试里默认 off(vitest 设 VITEST)的那一条不搬——C++ 没有 VITEST;缺省 mode 只看 DAFRI_SEMANTIC / DAFRI_EMBED(都没有 = llm),测试自己设 mode。
//   · Embedder 接口:EmbedderPort(model + embed);OllamaEmbedder 包一层(makeOllamaEmbedderPort)。向量是 double 数组,存库转 float(同 Float32Array.from)。
//   · LlmJson:std::function<Task<OJson>(system, user, schema)>。LlmPick(zod .strict(){ids: string[] ≤ 50})手写:不是对象 / 多出别的键 / ids 不是字符串数组 / 超过 50 条都当回包不对。
//   · 缓存键:TS 用 sha1(查询 \0 编号串);键只用来认"同一问",这里同样用 sha1(QCryptographicHash)。缓存是进程内的 Map(先进先出,64 组)。
//   · `[...text].slice(0, 300)` 按码点数(不是 UTF-16 单元),这里同。
#pragma once

#include "contract/ordered_map.h"
#include "orchestrate/services/svc_host.h"

#include <QHash>
#include <QList>

#include <functional>
#include <memory>
#include <optional>
#include <vector>

namespace ibkr::orchestrate {

enum class SemanticMode { Llm, Embed, Off };
using LlmJson = std::function<util::Task<util::OJson>(QString system, QString user, util::OJson schema)>;

class EmbedderPort {
public:
    virtual ~EmbedderPort() = default;
    virtual QString model() const = 0;
    /// 一批文本 → 一批向量,顺序对应。失败抛
    virtual util::Task<std::vector<std::vector<double>>> embed(std::vector<QString> texts, double timeoutMs) = 0;
};
/// 本机 Ollama(parsing/embeddings):地址不是本机抛 EmbedError
std::shared_ptr<EmbedderPort> makeOllamaEmbedderPort(const QString& baseUrl, const QString& model, const util::OJson& keepAlive);

/// id → 分数(llm 模式没有分数,按名次给 1 往下递减),Map 的先后 = 名次
using RankMap = contract::OrderedMap<double>;

class IdeaSemanticService : public SvcBase {
public:
    // ---- embed 模式
    static constexpr double kDefaultMinScore = 0.5;
    static constexpr int kTopK = 3;
    static constexpr int kBatch = 16;
    // ---- llm 模式
    static constexpr int kLlmPoolMax = 200;
    static constexpr int kLlmTextMax = 300;
    static constexpr int kLlmTopK = 8;
    static constexpr int kLlmCacheMax = 64;
    static const QString kLlmSystem;
    /// 各模型的门槛;没量过的用 kDefaultMinScore
    static double minScoreOf(const QString& model);

    explicit IdeaSemanticService(SvcHost& host);

    SemanticMode mode;
    /// embed 模式用的嵌入器;空 = 取不到(地址不是本机等)
    std::shared_ptr<EmbedderPort> embedder;

    /// 在 pool 里按语义找和 query 相近的。关掉、不可用、出错时返回空(调用方退回纯关键词)。llm 模式要调用方给 llm
    util::Task<std::optional<RankMap>> rank(QString query, QList<util::OJson> pool, LlmJson llm = {});

private:
    util::Task<std::optional<RankMap>> rankByLlm(QString q, QList<util::OJson> pool, LlmJson llm);
    util::Task<std::optional<RankMap>> rankByEmbedding(QString q, QList<util::OJson> pool);

    QList<QPair<QString, RankMap>> llmCache_;  // 先进先出
};

}  // namespace ibkr::orchestrate
