/** 想法的语义检索(第二期):本机嵌入 + 余弦,给关键词检索补上「意思相近、字面对不上」的那几条。
 *
 * 先按结构过滤(状态、时间窗由调用方先筛好),再在这批里按语义排;**只是补充**:
 *  · 分数 ≥ 门槛、且排进前 TOP_K 名的才算「语义相近」。**门槛跟着模型走**——各模型的余弦刻度不一样:
 *    qwen3-embedding 8B(Q8)在真实笔记 + 10 个标注查询上,「≥ 0.36 且前 3 名」精确 67%、召回 70%(0.33 的 F1 更高,
 *    但多出来的是摆在检索结果里的噪声,取精确);0.6B 刻度偏高、分得开的点在 0.5。没量过的模型按保守的 0.5;
 *  · 本机 Ollama 没开、模型没装、超时:返回 null,调用方退回纯关键词,一句不报错。
 * 想法的向量懒算:第一次用到时把缺的补上并存库(store.vectors),之后只算查询那一句。
 *
 * 测试里默认不连(vitest 会设 VITEST),要测语义就给 `embedder` 塞一个假的;用户可以用 DAFRI_EMBED=off 关掉。
 */
import type { Idea } from "../contract/ideas.js";
import { DEFAULT_EMBED_MODEL, DEFAULT_EMBED_URL, OllamaEmbedder, QUERY_INSTRUCTION, cosine } from "../embeddings.js";
import type { Embedder } from "../embeddings.js";
import { ServiceBase } from "./host.js";

export class IdeaSemanticService extends ServiceBase {
  /** 各模型的门槛(见文件头的实测);换了没量过的模型就用 DEFAULT_MIN_SCORE,换模型之后要重量 */
  static readonly MIN_SCORE: Readonly<Record<string, number>> = {
    "qwen3-embedding:8b-q8_0": 0.36,
    "qwen3-embedding:0.6b": 0.5,
  };
  static readonly DEFAULT_MIN_SCORE = 0.5;
  /** 最多补几条:排进前几名才算 */
  static readonly TOP_K = 3;
  /** 一次最多给多少条想法算向量 */
  static readonly BATCH = 16;

  /** null = 关掉(测试默认、DAFRI_EMBED=off、地址不是本机) */
  embedder: Embedder | null = defaultEmbedder();

  /**
   * 预热:引擎启动时在后台把模型载进显存(8B 冷启动约 3 秒),第一次检索就不用等。
   * 尽力而为:没开嵌入、Ollama 没开、模型没装,一律算了,不影响启动。
   */
  async warm(): Promise<void> {
    try {
      await this.embedder?.embed(["warm up"], 60_000);
    } catch {
      // 预热失败不要紧,检索时会再试,再不行就退回关键词
    }
  }

  /**
   * 在 `pool` 里按语义找和 `query` 相近的:id → 分数(只含过了门槛、前 TOP_K 名的)。
   * 嵌入不可用时返回 null——调用方退回纯关键词。
   */
  async rank(query: string, pool: readonly Idea[]): Promise<Map<string, number> | null> {
    const embedder = this.embedder;
    const q = query.trim();
    if (embedder === null || !q || !pool.length) return embedder === null ? null : new Map();
    const vectors = this.engine.store.vectors;
    try {
      const have = vectors.get(embedder.model, pool);
      const missing = pool.filter((i) => !have.has(i.id));
      for (let i = 0; i < missing.length; i += IdeaSemanticService.BATCH) {
        const batch = missing.slice(i, i + IdeaSemanticService.BATCH);
        const vecs = await embedder.embed(batch.map((b) => b.text), 60_000); // 8B 第一次载入 + 一批长文本,给足
        batch.forEach((idea, j) => {
          const v = vecs[j] ?? [];
          vectors.put(idea.id, idea.text, embedder.model, v);
          have.set(idea.id, Float32Array.from(v));
        });
      }
      // 8B 空闲 5 分钟会被 Ollama 卸载,再用时冷启动约 3 秒(2026-09-23 实测),8 秒够
      const [qv = []] = await embedder.embed([QUERY_INSTRUCTION + q], 8_000);
      const floor = IdeaSemanticService.MIN_SCORE[embedder.model] ?? IdeaSemanticService.DEFAULT_MIN_SCORE;
      const scored = pool
        .map((idea) => [idea.id, cosine(qv, have.get(idea.id) ?? [])] as const)
        .sort((a, b) => b[1] - a[1])
        .slice(0, IdeaSemanticService.TOP_K)
        .filter(([, s]) => s >= floor);
      return new Map(scored.map(([id, s]) => [id, Math.round(s * 1000) / 1000]));
    } catch {
      return null; // 嵌入是锦上添花:出任何错都退回关键词
    }
  }
}

function defaultEmbedder(): Embedder | null {
  if (process.env["VITEST"] || process.env["DAFRI_EMBED"] === "off") return null;
  try {
    const keep = process.env["DAFRI_EMBED_KEEP_ALIVE"];
    return new OllamaEmbedder(
      process.env["DAFRI_EMBED_URL"] || DEFAULT_EMBED_URL, process.env["DAFRI_EMBED_MODEL"] || DEFAULT_EMBED_MODEL,
      keep === undefined || keep === "" ? -1 : (Number.isFinite(Number(keep)) ? Number(keep) : keep),
    );
  } catch {
    return null; // 地址不是本机:不连
  }
}
