/** 命令行入口(对应 Python cli.py)。默认全部"只解析不下单",
 * 真正发单必须显式打开开关。危险程度阶梯与 Python 版一致:
 *
 *   node dist/cli.js selftest                       # 不联网:渲染提示词 + 自检
 *   node dist/cli.js validate fixture.json          # 不联网:现成 JSON 过硬校验
 *   node dist/cli.js parse "买入 AAPL 100股 limit 230"   # 调 LLM,不下单
 *   node dist/cli.js run "..." --i-understand-this-places-real-orders
 *   node dist/cli.js records / halt / resume / export / set-key / rpc
 *   node dist/cli.js import-fills fills.csv --account 别名 [--dry-run]   # 补历史成交(只收股票)
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { BrokerRouter } from "./broker.js";
import { Settings, loadSettings, nowEt } from "./config.js";
import { TradingEngine } from "./engine.js";
import { parseFillsCsv } from "./fillsCsv.js";
import { FutuRouter } from "./futuBroker.js";
import { setSecret } from "./keychain.js";
import { KillSwitch } from "./killswitch.js";
import { extractSymbols } from "./market.js";
import { parseLlmPayload } from "./models.js";
import { Notifier } from "./notify.js";
import { buildParser, structuredOutputSchema } from "./providers.js";
import { fingerprint, loadPromptBundle, renderUser } from "./prompts.js";
import { TradeStore } from "./store.js";
import { Validator, primaryCode, rejectionMessage } from "./validator.js";
import { fmtF } from "./py.js";

export async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  let configPath: string | null = null;
  const configIdx = args.indexOf("--config");
  if (configIdx >= 0) {
    configPath = args[configIdx + 1] ?? null;
    args.splice(configIdx, 2);
  }
  const command = args.shift();

  if (command === "rpc") {
    const { main: rpcMain } = await import("./rpc.js");
    return rpcMain(configPath);
  }

  const settings = loadSettings(configPath ?? undefined);

  switch (command) {
    case "selftest":
      return selftest(settings);
    case "validate":
      return validate(settings, args[0]!, parseSnapshot(flagValue(args, "--snapshot") ?? ""));
    case "parse":
      return parseCmd(
        settings, args[0]!, parseSnapshot(flagValue(args, "--snapshot") ?? ""),
        accountsArg(flagValue(args, "--accounts")),
      );
    case "run":
      return run(
        settings, args[0]!, args.includes("--i-understand-this-places-real-orders"),
        accountsArg(flagValue(args, "--accounts")),
      );
    case "records": {
      const store = new TradeStore(settings.db_path);
      const limit = Number(flagValue(args, "--limit") ?? 10);
      console.log(JSON.stringify(store.listRecords(limit), null, 2));
      return 0;
    }
    case "idea": {
      const store = new TradeStore(settings.db_path);
      const idea = store.addIdea(args[0]!, extractSymbols(args[0]!, settings, null, false));
      console.log(`已记下(${String(idea["id"]).slice(0, 8)}):${idea["text"]}`);
      return 0;
    }
    case "ideas": {
      const store = new TradeStore(settings.db_path);
      const all = args.includes("--all");
      const ideas = store.listIdeas(all ? null : "active", Number(flagValue(args, "--limit") ?? 20));
      console.log(JSON.stringify(ideas, null, 2));
      return 0;
    }
    case "halt": {
      const reason = flagValue(args, "--reason") ?? "用户手动熔断";
      const ks = new KillSwitch(path.join(path.dirname(settings.db_path), "breaker.json"));
      const state = ks.engage(reason);
      new TradeStore(settings.db_path).audit("cli", "halt", { reason });
      console.log(`已熔断:${state.reason}`);
      return 0;
    }
    case "resume": {
      const ks = new KillSwitch(path.join(path.dirname(settings.db_path), "breaker.json"));
      ks.release("cli");
      new TradeStore(settings.db_path).audit("cli", "resume", {});
      console.log("熔断已解除。注意:auto_execute 仍受配置控制。");
      return 0;
    }
    case "export": {
      const data = new TradeStore(settings.db_path).exportAll();
      fs.writeFileSync(args[0]!, JSON.stringify(data, null, 2), "utf-8");
      console.log(`已导出到 ${args[0]}`);
      return 0;
    }
    case "import-fills":
      return importFills(settings, args[0] ?? "", flagValue(args, "--account") ?? "", args.includes("--dry-run"));
    case "set-key":
      setSecret(settings.llm.keychain_service, settings.llm.keychain_account, args[0]!);
      console.log(`已写入 Keychain(service=${settings.llm.keychain_service})`);
      return 0;
    default:
      console.error(
        "用法:cli <selftest|rpc|validate|parse|run|records|idea|ideas|halt|resume|export|import-fills|set-key> [--config path]",
      );
      return 1;
  }
}

// ----------------------------------------------------------------------
/**
 * 把 IBKR 账户成交导出(fills.csv)补进 broker_fills:TWS 只给当天的成交,攒之前的历史靠这个。只收股票(见 fillsCsv.ts)。
 * 导出里没有账户号,--account 按配置里的别名指明它是哪个账户;账户号不打印。已有的 exec_id 不动(只增不改)。
 */
function importFills(settings: Settings, csvPath: string, alias: string, dryRun: boolean): number {
  const account = settings.accounts.find((a) => a.alias === alias);
  if (!csvPath || account === undefined) {
    const known = settings.accounts.map((a) => a.alias).join("、") || "(配置里没有账户)";
    console.error(`用法:cli import-fills fills.csv --account <别名> [--dry-run];可选的别名:${known}`);
    return 1;
  }
  const parsed = parseFillsCsv(fs.readFileSync(csvPath, "utf-8"), account.account_id);
  const store = new TradeStore(settings.db_path);
  const known = new Set(store.listFills(1_000_000).map((f) => String(f["exec_id"] ?? "")));
  const fresh = parsed.fills.filter((f) => !known.has(f.exec_id));
  console.log(`账户:${alias}${account.is_paper ? "(模拟)" : ""}`);
  console.log(`股票成交 ${parsed.fills.length} 笔(${parsed.first ?? "-"} → ${parsed.last ?? "-"}),库里已有 ${parsed.fills.length - fresh.length} 笔,新增 ${fresh.length} 笔`);
  for (const [reason, count] of Object.entries(parsed.skipped)) console.log(`  未收 ${count} 行:${reason}`);
  if (dryRun) {
    console.log("--dry-run:没有写库。");
    return 0;
  }
  const added = store.rememberFills(parsed.fills);
  store.audit("cli", "fills_import", { file: path.basename(csvPath), account: alias, added, skipped: parsed.skipped });
  console.log(`已写入 ${added} 笔。`);
  return 0;
}

function selftest(settings: Settings): number {
  const bundle = loadPromptBundle(settings);
  const moment = nowEt();
  const user = renderUser(bundle, settings, "买入 AAPL 100股 limit 230", moment, null, { AAPL: 230.1 });
  console.log(`提示词版本 : ${bundle.version} (${fingerprint(bundle)})`);
  console.log(`少样本对数 : ${bundle.fewshot.length}`);
  console.log(`系统提示词 : ${[...bundle.system_text].length} 字`);
  console.log(`市场状态   : ${settings.marketStatus(moment)}`);
  console.log(`账户别名   : ${settings.aliasList().join(", ")}`);
  console.log(
    `自动执行   : ${pyBool(settings.policies.auto_execute)} / 实盘允许:${pyBool(settings.policies.allow_live_trading)}`,
  );
  const schema = structuredOutputSchema();
  console.log(
    `输出 schema 顶层字段:${Object.keys((schema["properties"] as object) ?? {}).sort().join(", ")}`,
  );
  console.log("-".repeat(60));
  console.log(user);
  return 0;
}

function validate(settings: Settings, payloadPath: string, snapshot: Record<string, number>): number {
  const payload = JSON.parse(fs.readFileSync(payloadPath, "utf-8"));
  const parsed = parseLlmPayload(payload);
  const validator = new Validator(settings, nowEt(), snapshot);
  const outcome = validator.validateAll(parsed.orders);
  for (const note of parsed.schema_errors) console.log(`[schema] ${note}`);
  for (const rejection of parsed.rejections) {
    console.log(`[模型拒绝] ${rejection.code}: ${rejection.message}`);
  }
  for (const approved of outcome.approved) {
    console.log(
      `[通过] ${approved.order.intent_summary} | 账户=${approved.account.alias} | ` +
      `敞口≈${fmtF(approved.notional, 2)} USD`,
    );
    for (const warning of approved.warnings) console.log(`        ! ${warning}`);
  }
  for (const rejected of outcome.rejected) {
    console.log(`[校验拒绝] ${primaryCode(rejected)}: ${rejectionMessage(rejected)}`);
  }
  return outcome.rejected.length ? 2 : 0;
}

/** `--accounts 模拟,主账户`:目标账户别名,写两个就同时向两个账户发单。 */
function accountsArg(raw: string | null | undefined): string[] {
  return (raw ?? "").split(",").map((a) => a.trim()).filter(Boolean);
}

async function parseCmd(
  settings: Settings, instruction: string, snapshot: Record<string, number>,
  accounts: string[] = [],
): Promise<number> {
  // parse 子命令永不下单,不管配置怎么写
  settings.policies = { ...settings.policies, auto_execute: false };
  const engine = new TradingEngine({
    settings, parser: buildParser(settings.llm) as any, notifier: new Notifier(false),
  });
  const result = await engine.handleInstruction(instruction, "manual", null, snapshot, accounts);
  console.log(JSON.stringify(result, null, 2));
  return result.rejections.length ? 2 : 0;
}

async function run(
  settings: Settings, instruction: string, confirmed: boolean, accounts: string[] = [],
): Promise<number> {
  if (!confirmed) {
    console.error("拒绝执行:缺少 --i-understand-this-places-real-orders 开关。");
    return 1;
  }
  if (!settings.policies.auto_execute) {
    console.error("拒绝执行:配置里 policies.auto_execute=false。");
    return 1;
  }
  const router = buildRouter(settings);
  const engine = new TradingEngine({
    settings, parser: buildParser(settings.llm) as any, router: router as any,
  });
  try {
    const result = await engine.handleInstruction(instruction, "manual", null, null, accounts);
    console.log(JSON.stringify(result, null, 2));
    // 富途没有事件流:同步拉一次回报,否则命令行跑出来的单永远停在 Submitted
    await engine.syncBrokerOrders();
  } finally {
    await router.disconnectAll();
  }
  return 0;
}

/** 按配置里生效的那家券商建 router(命令行与 RPC 用同一条规则)。 */
export function buildRouter(settings: Settings): BrokerRouter | FutuRouter {
  if (settings.broker.provider === "futu") return new FutuRouter(settings);
  return new BrokerRouter(settings);
}

function parseSnapshot(raw: string): Record<string, number> {
  const snapshot: Record<string, number> = {};
  for (const chunkRaw of raw.split(",")) {
    const chunk = chunkRaw.trim();
    if (!chunk) continue;
    const [symbol, , value] = partition(chunk, "=");
    const num = Number(value);
    if (Number.isNaN(num)) {
      console.error(`行情快照格式应为 SPX=7462.35,AAPL=230,收到:'${chunk}'`);
      process.exit(1);
    }
    snapshot[symbol.trim().toUpperCase()] = num;
  }
  return snapshot;
}

function partition(text: string, sep: string): [string, string, string] {
  const idx = text.indexOf(sep);
  if (idx < 0) return [text, "", ""];
  return [text.slice(0, idx), sep, text.slice(idx + sep.length)];
}

function flagValue(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  return idx >= 0 ? (args[idx + 1] ?? null) : null;
}

function pyBool(v: boolean): string {
  return v ? "True" : "False";
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]).includes("cli");
if (isMain && import.meta.url.endsWith(path.basename(process.argv[1] ?? ""))) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (exc) => {
      console.error(String(exc?.stack ?? exc));
      process.exit(1);
    },
  );
}
