/** 提示词装配与版本管理(对应 Python prompts.py,§2 / §3 / §11)。
 *
 * 提示词是配置不是代码:模板文件放 prompts/ 带版本号,渲染后算 sha256 指纹。
 * 渲染后两道自检:不许残留 {{VAR}};不许出现任何真实账号(§9.1)。
 * 指纹算法与 Python 逐字节一致(浮点感知 JSON 见 pyjson.ts)。
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { EtNow, Settings } from "./config.js";
import { BJ, ET } from "./config.js";
import { JVal, parseJson, pyDumpsSorted, toPlain } from "./pyjson.js";
import { wallParts, pad2 } from "./tz.js";

const PLACEHOLDER_RE = /\{\{[A-Z_]+\}\}/g;

export class PromptError extends Error {}

export interface FewShotPair {
  name: string;
  user: string;
  /** 业务用的普通对象 */
  assistant: unknown;
  /** 指纹用的浮点感知形式 */
  assistantJ: JVal;
}

export interface PromptBundle {
  version: string;
  system_text: string;
  user_template: string;
  fewshot: FewShotPair[];
}

export function fingerprint(bundle: PromptBundle): string {
  const payload =
    bundle.system_text +
    "\n--\n" +
    pyDumpsSorted({ kind: "arr", items: bundle.fewshot.map((p) => p.assistantJ) });
  return crypto.createHash("sha256").update(payload, "utf-8").digest("hex").slice(0, 16);
}

/** 只改了系统提示词、少样本原样沿用的版本,不再复制一份字节相同的 fewshot 文件:指到内容相同的旧版本。
 *  指纹只算渲染后的系统提示词与少样本内容,所以别名不改变任何版本的指纹。与 Python prompts.py 同一张表。 */
const FEWSHOT_ALIAS: Record<string, string> = { "v1.7.0": "v1.6.0" };

export function loadPromptBundle(settings: Settings): PromptBundle {
  const version = settings.prompt_version;
  const directory = settings.prompt_dir;
  const systemRaw = readFile(path.join(directory, `system_${version}.md`));
  const userRaw = readFile(path.join(directory, `user_message_${version}.md`));

  const fewshotPath = path.join(directory, `fewshot_${FEWSHOT_ALIAS[version] ?? version}.json`);
  const fewshot: FewShotPair[] = [];
  if (fs.existsSync(fewshotPath)) {
    const text = fs.readFileSync(fewshotPath, "utf-8");
    const data = parseJson(text);
    if (data.kind === "obj") {
      const pairs = data.entries.find(([k]) => k === "pairs")?.[1];
      if (pairs && pairs.kind === "arr") {
        for (const pair of pairs.items) {
          if (pair.kind !== "obj") continue;
          const get = (key: string): JVal | undefined =>
            pair.entries.find(([k]) => k === key)?.[1];
          const nameJ = get("name");
          const userJ = get("user");
          const assistantJ = get("assistant");
          if (!userJ || userJ.kind !== "str" || !assistantJ) {
            throw new PromptError(`少样本文件格式不对:${fewshotPath}`);
          }
          fewshot.push({
            name: nameJ && nameJ.kind === "str" ? nameJ.value : "",
            user: userJ.value,
            assistant: toPlain(assistantJ),
            assistantJ,
          });
        }
      }
    }
  }

  const systemText = renderSystem(systemRaw, settings);
  return { version, system_text: systemText, user_template: userRaw, fewshot };
}

export function renderSystem(template: string, settings: Settings): string {
  const limits = settings.limits;
  const text = substitute(template, {
    MAX_ORDER_NOTIONAL: numStr(limits.max_order_notional),
    MAX_OPTION_CONTRACTS: String(limits.max_option_contracts),
    MAX_MKT_SHARES: String(limits.max_mkt_shares),
    SYMBOL_ALIAS_TABLE: settings.promptSymbolTable(),
    ACCOUNT_ALIAS_TABLE: settings.promptAccountTable(),
  });
  assertComplete(text, "system");
  assertNoAccountIds(text, settings);
  return text;
}

export function renderUser(
  bundle: PromptBundle,
  settings: Settings,
  instruction: string,
  nowEt: EtNow,
  marketStatus?: string | null,
  snapshot?: Record<string, number> | null,
): string {
  const status = marketStatus || settings.marketStatus(nowEt);
  const text = substitute(bundle.user_template, {
    NOW_ET: strfMinute(nowEt.epochMs, ET),
    NOW_BJ: strfMinute(nowEt.epochMs, BJ),
    MARKET_STATUS: status,
    MAX_ORDER_NOTIONAL: numStr(settings.limits.max_order_notional),
    MAX_OPTION_CONTRACTS: String(settings.limits.max_option_contracts),
    MARKET_SNAPSHOT_LINE: snapshotLine(snapshot),
    USER_INSTRUCTION: instruction.trim(),
  });
  assertComplete(text, "user");
  assertNoAccountIds(text, settings);
  return text;
}

function strfMinute(epochMs: number, tz: string): string {
  const p = wallParts(epochMs, tz);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** 行情快照行。没有快照时整行省略(§3)。 */
function snapshotLine(snapshot?: Record<string, number> | null): string {
  if (!snapshot || !Object.keys(snapshot).length) return "";
  const parts = Object.entries(snapshot).map(
    ([sym, price]) => `${sym.toUpperCase()} 现价 ${numStr(price)}`,
  );
  return "\n相关行情快照:" + parts.join(";") + "\n";
}

function substitute(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(values)) {
    out = out.split(`{{${key}}}`).join(value);
  }
  return out;
}

function assertComplete(text: string, which: string): void {
  const leftovers = [...new Set(text.match(PLACEHOLDER_RE) ?? [])].sort();
  if (leftovers.length) {
    throw new PromptError(`${which} 提示词存在未替换的模板变量:${leftovers.join(", ")}`);
  }
}

/** §9.1:真实账号永远不进提示词。最后一道纯代码检查。 */
function assertNoAccountIds(text: string, settings: Settings): void {
  for (const acct of settings.accounts) {
    if (acct.account_id && text.includes(acct.account_id)) {
      throw new PromptError(
        `提示词中出现了真实账号(别名 ${acct.alias}),违反 S0 数据流向约束,已中止调用。`,
      );
    }
  }
}

/** Python 的 _num:整数值去掉小数,其余 "%f" 去尾零。 */
function numStr(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function readFile(p: string): string {
  if (!fs.existsSync(p)) throw new PromptError(`提示词文件不存在:${p}`);
  // Python 的 read_text 走 universal newlines(\r\n → \n),这里保持同一语义
  return fs.readFileSync(p, "utf-8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
