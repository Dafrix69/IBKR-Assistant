/** 当日到期期权 IV 的样本:存在交易库旁边的 fly-iv/ 目录里,一天一个文件,一行一笔(JSON)。
 *
 * 为什么要自己攒:蝴蝶测算里"IV 怎么变"是拿 IV 指数(VIX1D)校准的,不是期权自己的 IV——过期期权的历史行情
 * IBKR 不给,公开数据里也没有。要拿真的期权 IV 校准,只能从今天起自己记(用户 2026-09-28:「让软件自己攒」)。
 *
 * 为什么不进交易库:这是行情,不是交易记录。单独放着,坏了、删了都碰不到订单与追踪;库的结构版本也不用动。
 * 里面**只有行情**:时刻、现价、行权价、盘口、IV。没有账号、没有持仓、没有订单。
 *
 * 只追加,不改写。一行坏了(断电时写了半行)读的时候跳过那一行,别的照用。
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { dateStrAt, ET } from "./tz.js";

export interface IvSampleLeg {
  strike: number;
  right: "C" | "P";
  bid: number | null;
  ask: number | null;
  /** IBKR 的模型 IV(年化小数) */
  iv: number | null;
}

export interface IvSample {
  /** 记下来的时刻(毫秒) */
  t: number;
  symbol: string;
  /** 到期日 YYYYMMDD */
  expiry: string;
  trading_class: string;
  spot: number;
  /** quote = 券商的现价;futures = 按期货推算 */
  spot_source: string;
  /** loop = 后台按节拍记的;plan = 测算读行情时顺带记的 */
  by: "loop" | "plan";
  /** 后台那一路当天的锚(开盘后第一笔的现价取整):行权价围着它取,一整天不换,同一个行权价才连得成线 */
  anchor?: number;
  legs: IvSampleLeg[];
}

export interface IvSampleDay { date: string; samples: number; bytes: number }

const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

function validLeg(raw: unknown): raw is IvSampleLeg {
  if (raw === null || typeof raw !== "object") return false;
  const leg = raw as Record<string, unknown>;
  return typeof leg["strike"] === "number" && Number.isFinite(leg["strike"]) && (leg["right"] === "C" || leg["right"] === "P");
}

function validSample(raw: unknown): raw is IvSample {
  if (raw === null || typeof raw !== "object") return false;
  const s = raw as Record<string, unknown>;
  return typeof s["t"] === "number" && Number.isFinite(s["t"]) && typeof s["symbol"] === "string" &&
    typeof s["expiry"] === "string" && typeof s["spot"] === "number" && s["spot"] > 0 &&
    Array.isArray(s["legs"]) && s["legs"].every(validLeg);
}

export class IvSampleStore {
  /** 留多少天:一年多一点,够校准用;再久的行情的样子已经变了 */
  static readonly KEEP_DAYS = 400;

  constructor(readonly dir: string) {}

  private fileOf(date: string): string {
    return path.join(this.dir, `${date}.jsonl`);
  }

  /** 追加一笔,落在它那个时刻的美东日期的文件里。目录没有就建 */
  append(sample: IvSample): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.fileOf(dateStrAt(sample.t, ET)), JSON.stringify(sample) + "\n", { encoding: "utf-8", mode: 0o600 });
  }

  /** 有样本的日子,从早到晚。目录还没有就是空的 */
  dates(): string[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    return names.map((n) => FILE_RE.exec(n)?.[1]).filter((d): d is string => d !== undefined).sort();
  }

  /** 这一天的样本,按时刻排好。坏的行跳过 */
  read(date: string): IvSample[] {
    let text: string;
    try {
      text = fs.readFileSync(this.fileOf(date), "utf-8");
    } catch {
      return [];
    }
    const out: IvSample[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const raw: unknown = JSON.parse(line);
        if (validSample(raw)) out.push(raw);
      } catch {
        /* 写了一半的行 */
      }
    }
    return out.sort((a, b) => a.t - b.t);
  }

  /** 每天有多少笔、占多大 */
  days(): IvSampleDay[] {
    return this.dates().map((date) => {
      let bytes = 0;
      try {
        bytes = fs.statSync(this.fileOf(date)).size;
      } catch {
        /* 刚被删掉 */
      }
      return { date, samples: this.read(date).length, bytes };
    });
  }

  /** 只留最近 keep 天的文件。返回删了几个 */
  prune(keep: number = IvSampleStore.KEEP_DAYS): number {
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
