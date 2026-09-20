/** 引擎这一层共用的时刻工具:engine.ts 与 engine/hosted.ts 都要用,所以单独放一处(函数体一字未改)。 */
import { etNowFromEpoch } from "../config.js";

export function nowIsoSecondsEt(): string {
  // Python 版用 now_et().isoformat(timespec="seconds");这里给出等价的 ET 时刻串
  const now = etNowFromEpoch(Date.now());
  return new Date(now.epochMs).toISOString().replace(/\.\d{3}Z$/, "+00:00");
}
