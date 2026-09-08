/** 全局熔断开关(对应 Python killswitch.py,§9.7)。
 *
 * 用文件做状态:Electron 主进程、CLI、引擎三方看同一个开关,崩溃重启后依然有效。
 * 券商失败与解析失败分开计数,互不清零——两类失败不能互相掩护。
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface BreakerState {
  engaged: boolean;
  reason: string;
  at: string;
  consecutive_failures: number; // broker(下单)失败
  consecutive_parse_failures: number; // LLM 解析失败
}

export class KillSwitch {
  readonly path: string;
  readonly threshold: number;

  constructor(filePath: string, threshold = 3) {
    this.path = filePath;
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    this.threshold = Math.max(1, threshold);
  }

  state(): BreakerState {
    if (!fs.existsSync(this.path)) {
      return { engaged: false, reason: "", at: "", consecutive_failures: 0, consecutive_parse_failures: 0 };
    }
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(fs.readFileSync(this.path, "utf-8"));
    } catch {
      // 状态文件坏了 → 按已熔断处理,宁可停,不可乱下单
      return {
        engaged: true, reason: "熔断状态文件损坏,已按安全侧处理", at: "",
        consecutive_failures: 0, consecutive_parse_failures: 0,
      };
    }
    return {
      engaged: Boolean(raw["engaged"]),
      reason: String(raw["reason"] ?? ""),
      at: String(raw["at"] ?? ""),
      consecutive_failures: Math.trunc(Number(raw["consecutive_failures"] ?? 0)) || 0,
      consecutive_parse_failures: Math.trunc(Number(raw["consecutive_parse_failures"] ?? 0)) || 0,
    };
  }

  isEngaged(): boolean {
    return this.state().engaged;
  }

  engage(reason: string): BreakerState {
    const state = this.state();
    const next: BreakerState = {
      engaged: true,
      reason,
      at: localIsoSeconds(),
      consecutive_failures: state.consecutive_failures,
      consecutive_parse_failures: state.consecutive_parse_failures,
    };
    this.write(next);
    return next;
  }

  release(actor = "user"): BreakerState {
    const next: BreakerState = {
      engaged: false,
      reason: `由 ${actor} 手动解除`,
      at: localIsoSeconds(),
      consecutive_failures: 0,
      consecutive_parse_failures: 0,
    };
    this.write(next);
    return next;
  }

  /** 解析成功只清解析计数,下单成功才清券商计数。 */
  recordSuccess(kind: "broker" | "parse" = "broker"): void {
    const state = this.state();
    if (kind === "parse") {
      if (state.consecutive_parse_failures) {
        state.consecutive_parse_failures = 0;
        this.write(state);
      }
    } else if (state.consecutive_failures) {
      state.consecutive_failures = 0;
      this.write(state);
    }
  }

  recordFailure(reason: string, kind: "broker" | "parse" = "broker"): BreakerState | null {
    const state = this.state();
    let count: number;
    if (kind === "parse") {
      state.consecutive_parse_failures += 1;
      count = state.consecutive_parse_failures;
    } else {
      state.consecutive_failures += 1;
      count = state.consecutive_failures;
    }
    if (count >= this.threshold && !state.engaged) {
      this.write(state);
      return this.engage(`连续 ${count} 次失败后自动熔断(最近一次:${reason})`);
    }
    this.write(state);
    return null;
  }

  private write(state: BreakerState): void {
    // 原子写:先写临时文件再 rename,崩溃不会留下半截 JSON
    const payload = JSON.stringify({
      engaged: state.engaged,
      reason: state.reason,
      at: state.at,
      consecutive_failures: state.consecutive_failures,
      consecutive_parse_failures: state.consecutive_parse_failures,
    });
    const tmp = this.path.replace(/\.json$/, "") + ".json.tmp";
    fs.writeFileSync(tmp, payload, "utf-8");
    fs.renameSync(tmp, this.path);
  }
}

function localIsoSeconds(): string {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`
  );
}
