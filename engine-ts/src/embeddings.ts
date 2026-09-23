/**
 * 本机文本嵌入(想法检索第二期,见 docs/features/idea-retrieval.md):调本机 Ollama 的 /api/embed,不引向量库、不加 npm 依赖。
 *
 * **只许本机地址**:想法原文里可能有仓位、金额,嵌入是一次外发——所以地址不是 127.0.0.1 / localhost / ::1 就当场拒,
 * 而不是「发出去之前用正则洗一遍」(正则一定漏)。
 */

/** 默认模型:qwen3-embedding 0.6B(1024 维,中文可用,约 640 MB)。可用环境变量 DAFRI_EMBED_MODEL 换 */
export const DEFAULT_EMBED_MODEL = "qwen3-embedding:0.6b";
export const DEFAULT_EMBED_URL = "http://127.0.0.1:11434";

/**
 * 查询要带指令前缀(qwen3-embedding 的用法:文档原样嵌入,查询前面加任务说明),两边不对称是故意的。
 * 改这句 = 换一套相似度,门槛要重新量(见 services/ideaSemantic.ts 的 MIN_SCORE)。
 */
export const QUERY_INSTRUCTION =
  "Instruct: Given a trading journal search query, retrieve notes that discuss the same trading mistake or idea\nQuery: ";

export class EmbedError extends Error {}

export interface Embedder {
  readonly model: string;
  /** 一批文本 → 一批向量,顺序对应。失败抛 EmbedError */
  embed(texts: readonly string[], timeoutMs?: number): Promise<number[][]>;
}

/** 只认本机回环地址 */
export function isLoopbackUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export class OllamaEmbedder implements Embedder {
  constructor(private readonly baseUrl: string, readonly model: string) {
    if (!isLoopbackUrl(baseUrl)) throw new EmbedError(`嵌入服务只许本机地址,收到:${baseUrl}`);
  }

  async embed(texts: readonly string[], timeoutMs = 20_000): Promise<number[][]> {
    if (!texts.length) return [];
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (exc) {
      throw new EmbedError(`连不上本机嵌入服务(${this.baseUrl}):${(exc as Error).message}`, { cause: exc });
    }
    const body = (await res.json().catch(() => null)) as { embeddings?: unknown; error?: unknown } | null;
    if (!res.ok || body === null || !Array.isArray(body.embeddings)) {
      throw new EmbedError(`本机嵌入服务报错(HTTP ${res.status}):${String(body?.error ?? "回包不对")}`);
    }
    const out = body.embeddings as unknown[];
    if (out.length !== texts.length || !out.every((v) => Array.isArray(v) && v.length > 0)) {
      throw new EmbedError("本机嵌入服务回的向量条数或形状不对");
    }
    return out as number[][];
  }
}

/** 余弦相似度;长度不一致或有零向量时 0 */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    dot += x * y; na += x * x; nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
