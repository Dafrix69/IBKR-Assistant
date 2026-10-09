/** 今天的 EM(常规时段一个标准差的点数):从日内剧本的底账里读,一分钟读一次文件。
 *
 * 持仓追踪的 clock 档(拿不到任何市场波动率时的模型默认值)与标的目标价的试算用它;以前是写死的 36。
 * 读不到(软件今天没在盘初开着、不是交易日、提前收盘日)回 null,调用方退回默认值并照旧标成"不是市场价"。
 */
import * as path from "node:path";

import type { EtNow, Settings } from "../config.js";
import { PlaybookLog } from "../playbookLog.js";
import { sessionEmOf } from "../sessionEm.js";

export class SessionEmCache {
  private cached: { date: string; atMs: number; em: number | null } | null = null;
  static readonly TTL_MS = 60_000;

  constructor(private readonly settings: () => Settings) {}

  today(at: EtNow): number | null {
    const hit = this.cached;
    if (hit !== null && hit.date === at.date && at.epochMs - hit.atMs < SessionEmCache.TTL_MS && at.epochMs >= hit.atMs) return hit.em;
    const s = this.settings();
    let em: number | null = null;
    try {
      const records = new PlaybookLog(path.join(path.dirname(s.db_path), "playbook")).read(at.date);
      em = sessionEmOf(records, s.early_close_days.includes(at.date))?.em ?? null;
    } catch {
      em = null; // 底账读不了不该影响盯盘:退回默认值
    }
    this.cached = { date: at.date, atMs: at.epochMs, em };
    return em;
  }
}
