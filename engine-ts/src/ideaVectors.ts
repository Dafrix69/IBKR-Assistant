/**
 * 想法原文的嵌入向量(想法检索第二期)。一条想法 × 一个模型一行,Float32 存 BLOB——不引向量库:
 * 一万条 × 1024 维暴力余弦是个位数毫秒(idea-retrieval.md「不引向量库」)。
 * 想法原文不可改,但仍记一个原文指纹:哪天真允许改了,旧向量不会悄悄冒充新原文。换模型就按新模型重算,旧的留着不删。
 * 与 TradeStore 共用同一个连接:`store.vectors`。
 */
import type Database from "better-sqlite3";
import * as crypto from "node:crypto";

import { utcIso } from "./tz.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS idea_vectors (
    idea_id    TEXT NOT NULL,
    model      TEXT NOT NULL,
    dim        INTEGER NOT NULL,
    text_hash  TEXT NOT NULL,
    vec        BLOB NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (idea_id, model)
);
`;

/** 原文指纹(sha1 前 16 位,够认出「原文变了」) */
export function textHash(text: string): string {
  return crypto.createHash("sha1").update(text, "utf8").digest("hex").slice(0, 16);
}

export class IdeaVectorStore {
  constructor(private readonly db: Database.Database) {
    db.exec(SCHEMA);
  }

  /** 这些想法在这个模型下已有、且原文没变的向量:id → 向量 */
  get(model: string, ideas: ReadonlyArray<{ id: string; text: string }>): Map<string, Float32Array> {
    const out = new Map<string, Float32Array>();
    const stmt = this.db.prepare("SELECT text_hash, vec FROM idea_vectors WHERE idea_id=? AND model=?");
    for (const idea of ideas) {
      const row = stmt.get(idea.id, model) as { text_hash: string; vec: Buffer } | undefined;
      if (row === undefined || row.text_hash !== textHash(idea.text)) continue;
      out.set(idea.id, new Float32Array(row.vec.buffer.slice(row.vec.byteOffset, row.vec.byteOffset + row.vec.byteLength)));
    }
    return out;
  }

  put(ideaId: string, text: string, model: string, vec: ArrayLike<number>): void {
    const f32 = Float32Array.from(vec);
    this.db
      .prepare(
        "INSERT OR REPLACE INTO idea_vectors (idea_id, model, dim, text_hash, vec, created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(ideaId, model, f32.length, textHash(text), Buffer.from(f32.buffer), utcIso(Date.now() - (Date.now() % 1000)));
  }

  count(model: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM idea_vectors WHERE model=?").get(model) as { n: number }).n;
  }
}
