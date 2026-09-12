/** 用户通知(对应 Python notify.py,§5.6)。通知内容属于 S1,只留在本机。 */
import { execFile } from "node:child_process";
import * as os from "node:os";

import { fmtF, pyG } from "./py.js";

export type Sink = (title: string, subtitle: string, body: string) => void;

export class Notifier {
  enabled: boolean;
  readonly sinks: Sink[];
  readonly history: Array<[string, string, string]> = [];

  constructor(enabled = true, extraSinks?: Sink[] | null) {
    this.enabled = enabled;
    this.sinks = [...(extraSinks ?? [])];
  }

  notify(title: string, body: string, subtitle = "", options?: { os?: boolean }): void {
    this.history.push([title, subtitle, body]);
    for (const sink of this.sinks) sink(title, subtitle, body);
    // os:false —— 只进通知流,不走系统通知。价位提醒、异动提醒的"弹"由桌面端的置顶弹窗负责,
    // 这里再弹一次系统通知(macOS 的 osascript)就是同一件事说两遍。
    if (options?.os === false) return;
    if (!this.enabled) return;
    if (os.platform() !== "darwin") {
      // stdout 只跑 RPC 协议(§10.1),通知落到 stderr 的日志面板
      console.error(`[通知] ${title} | ${subtitle} | ${body}`);
      return;
    }
    const script = `display notification ${q(body)} with title ${q(title)} subtitle ${q(subtitle || " ")}`;
    execFile("osascript", ["-e", script], () => undefined);
  }

  rejection(code: string, message: string): void {
    this.notify("指令被拒绝", message, code);
  }

  warning(message: string): void {
    this.notify("下单提醒", message, "warning");
  }

  fill(symbol: string, action: string, qty: number, price: number, account: string): void {
    this.notify("成交回报", `${action} ${symbol} ${pyG(qty)} @ ${fmtF(price, 4)}`, `账户 ${account}`);
  }

  breaker(reason: string): void {
    this.notify("已熔断:自动执行暂停", reason, "circuit breaker");
  }
}

/** AppleScript 字符串转义,防脚本注入。 */
function q(text: string): string {
  return '"' + text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ") + '"';
}
