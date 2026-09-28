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
  /**
   * 是不是连续失败**自动**合上的。手动熔断(界面按钮、菜单、Dock、状态文件损坏)是 false。
   * 两种熔断对"已经在保护持仓的东西"处置不同:手动熔断是人说"全部停下",照旧撤单、连平仓也不发;
   * 自动熔断只说明解析或下单接连出错——那时撤掉券商侧的止损单、停掉软件止损,等于在软件出毛病的时候
   * 把持仓的保护一起拿掉(2026-09-27 审计:大模型接口超时三次,下一轮对账就把全部托管止损撤了)。
   * 旧版状态文件没有这一项,按手动处理——对保护最保守的那一侧。
   */
  auto: boolean;
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
      return { engaged: false, reason: "", at: "", consecutive_failures: 0, consecutive_parse_failures: 0, auto: false };
    }
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(fs.readFileSync(this.path, "utf-8"));
    } catch {
      // 状态文件坏了 → 按已熔断处理,宁可停,不可乱下单
      return {
        engaged: true, reason: "熔断状态文件损坏,已按安全侧处理", at: "",
        consecutive_failures: 0, consecutive_parse_failures: 0, auto: false,
      };
    }
    return {
      engaged: Boolean(raw["engaged"]),
      reason: String(raw["reason"] ?? ""),
      at: String(raw["at"] ?? ""),
      consecutive_failures: Math.trunc(Number(raw["consecutive_failures"] ?? 0)) || 0,
      consecutive_parse_failures: Math.trunc(Number(raw["consecutive_parse_failures"] ?? 0)) || 0,
      auto: raw["auto"] === true,
    };
  }

  isEngaged(): boolean {
    return this.state().engaged;
  }

  /** auto 只由 recordFailure 传 true;其余调用方(手动熔断)一律是手动。 */
  engage(reason: string, auto = false): BreakerState {
    const state = this.state();
    const next: BreakerState = {
      engaged: true,
      reason,
      at: localIsoSeconds(),
      consecutive_failures: state.consecutive_failures,
      consecutive_parse_failures: state.consecutive_parse_failures,
      auto,
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
      auto: false,
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
      return this.engage(`连续 ${count} 次失败后自动熔断(最近一次:${reason})`, true);
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
      auto: state.auto,
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
