/** 日内剧本的底账:存在交易库旁边的 playbook/ 目录里,一个美东交易日一个文件,一行一条(JSON)。
 *
 * 为什么要落盘:昨日口径是**前一天**收盘后取的,引擎一重启内存里就没了;盘初口径一天只有一次机会。
 * 每五分钟的当前区间与事件也记着,回头核对「收盘落在区间里的比例」「触发之后到没到目标」用的就是它。
 * 状态机每变一次也记一条:重启之后接着判,靠的是它,不是把事件重放一遍(静默期里没报的那一次不在事件里)。
 *
 * 和 ivSamples.ts 同一条规矩:只有行情(时刻、现价、行权价、中间价),没有账号、持仓、订单;只追加,坏的行跳过。
 */
import * as fs from "node:fs";
import * as path from "node:path";

import type { PlaybookAnchor, PlaybookBand, PlaybookEvent, PlaybookState } from "./contract/options.js";

/** 状态机那几样要落盘的:每变一次记一条,重启时拿最后一条接着判(静默期里没报出来的那一次也在里面) */
export interface PlaybookMachineMark {
  at: number;
  state: PlaybookState;
  trigger: number | null;
  since: number | null;
  /** B2 失效时丢掉的那条线(还没重新上膛);没有是 null */
  lost: number | null;
}

/**
 * prior / open / frame 是取价的三种区间,event 是报出来的事件——这四种的样子不变,只读它们的地方照旧。
 * anchor(09:35 的锚,不靠盘初那一条区间也在)与 machine(状态)是后加的两种:不认识它们的读法会跳过。
 */
export type PlaybookRecord =
  | { kind: "prior" | "open" | "frame"; band: PlaybookBand }
  | { kind: "event"; event: PlaybookEvent }
  | { kind: "anchor"; anchor: PlaybookAnchor }
  | { kind: "machine"; machine: PlaybookMachineMark };

const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function validBand(raw: unknown): raw is PlaybookBand {
  if (raw === null || typeof raw !== "object") return false;
  const b = raw as Record<string, unknown>;
  return num(b["at"]) && num(b["anchor"]) && num(b["strike"]) && typeof b["expiry"] === "string" && num(b["call"]) &&
    num(b["put"]) && num(b["em"]) && num(b["lower"]) && num(b["upper"]) && (b["source"] === "live" || b["source"] === "backfill");
}

function validEvent(raw: unknown): raw is PlaybookEvent {
  if (raw === null || typeof raw !== "object") return false;
  const e = raw as Record<string, unknown>;
  return num(e["at"]) && num(e["level"]) && num(e["price"]) && typeof e["state"] === "string" &&
    (e["kind"] === "enter" || e["kind"] === "invalid" || e["kind"] === "accel");
}

const numOrNull = (v: unknown): boolean => v === null || num(v);

function validAnchor(raw: unknown): raw is PlaybookAnchor {
  if (raw === null || typeof raw !== "object") return false;
  const a = raw as Record<string, unknown>;
  return num(a["at"]) && num(a["price"]) && a["price"] > 0 && (a["source"] === "live" || a["source"] === "backfill");
}

function validMachine(raw: unknown): raw is PlaybookMachineMark {
  if (raw === null || typeof raw !== "object") return false;
  const m = raw as Record<string, unknown>;
  return num(m["at"]) && (m["state"] === "B2" || m["state"] === "B3" || m["state"] === "R" || m["state"] === "none") &&
    numOrNull(m["trigger"]) && numOrNull(m["since"]) && numOrNull(m["lost"]);
}

function validRecord(raw: unknown): raw is PlaybookRecord {
  if (raw === null || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;
  if (r["kind"] === "event") return validEvent(r["event"]);
  if (r["kind"] === "anchor") return validAnchor(r["anchor"]);
  if (r["kind"] === "machine") return validMachine(r["machine"]);
  return (r["kind"] === "prior" || r["kind"] === "open" || r["kind"] === "frame") && validBand(r["band"]);
}

export class PlaybookLog {
  /** 留多少个交易日:一年多一点 */
  static readonly KEEP_DAYS = 400;

  constructor(readonly dir: string) {}

  private fileOf(date: string): string {
    return path.join(this.dir, `${date}.jsonl`);
  }

  /** 追加一条到某个交易日的文件里(昨日口径是前一天写进**第二天**的文件的,所以日期由调用方给) */
  append(date: string, record: PlaybookRecord): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.fileOf(date), JSON.stringify(record) + "\n", { encoding: "utf-8", mode: 0o600 });
  }

  read(date: string): PlaybookRecord[] {
    let text: string;
    try {
      text = fs.readFileSync(this.fileOf(date), "utf-8");
    } catch {
      return [];
    }
    const out: PlaybookRecord[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const raw: unknown = JSON.parse(line);
        if (validRecord(raw)) out.push(raw);
      } catch {
        /* 写了一半的行 */
      }
    }
    return out;
  }

  dates(): string[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    return names.map((n) => FILE_RE.exec(n)?.[1]).filter((d): d is string => d !== undefined).sort();
  }

  /** 只留最近 keep 个文件。返回删了几个 */
  prune(keep: number = PlaybookLog.KEEP_DAYS): number {
    const dates = this.dates();
    const drop = dates.slice(0, Math.max(0, dates.length - keep));
    for (const date of drop) {
      try {
        fs.unlinkSync(this.fileOf(date));
      } catch {
        /* 删不掉就留着,下次再试 */
      }
    }
    return drop.length;
  }
}
