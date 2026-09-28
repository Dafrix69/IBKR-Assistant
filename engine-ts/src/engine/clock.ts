/** 引擎这一层共用的时刻工具:engine.ts 与 engine/hosted.ts 都要用,所以单独放一处(函数体一字未改)。 */
import { etNowFromEpoch } from "../config.js";

/** 本机时区的此刻,精确到秒,带偏移(从 engine.ts 搬来,函数体一字未改)。 */
export function localIsoSeconds(): string {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const pad = (n: number): string => String(Math.abs(n)).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`
  );
}

export function nowIsoSecondsEt(): string {
  // Python 版用 now_et().isoformat(timespec="seconds");这里给出等价的 ET 时刻串
  const now = etNowFromEpoch(Date.now());
  return new Date(now.epochMs).toISOString().replace(/\.\d{3}Z$/, "+00:00");
}
