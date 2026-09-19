// 只读联调:真连 TWS / IB Gateway,把引擎的只读接口按固定顺序走一遍,最后按已知的坑出诊断。
//
//   npm run probe                                  # 配置里全部 IBKR 连接,全部步骤
//   npm run probe -- --connection live             # 只连一条(可逗号分隔多条)
//   npm run probe -- --steps connect,quotes,bars   # 只跑其中几步(diagnose / connect 会按需自动补上)
//   npm run probe -- --symbols NVO,AAPL --index SPX --client-id 71
//   npm run probe -- --config D:/other/settings.json
//   npm run probe -- --steps stockreview --seed-fills D:/backup/trades.db   # 股票复盘;拿一份库的备份把历史成交灌进临时库
//
// 走的是引擎的 RPC(dist/src/cli.js rpc)——和桌面应用同一条路,不是另写一套连接代码。
//
// 安全边界(为什么敢对着实盘 TWS 跑):
//   · 不碰用户的库和配置:从真配置派生一份临时配置写进系统临时目录,库也在那里;
//   · 临时配置里自动执行、实盘、组合实盘三道闸全部强制关掉;
//   · client id 用 71 起(桌面应用占着 11/12,诊断握手用 client_id+90),不抢应用的连接;
//   · RPC 只准调下面 ALLOWED 里的只读方法,发单、撤单、追踪、改配置一律在探针这一侧就拒掉;
//   · 临时库是空的:没有追踪、没有托管单、没有条件单,引擎的盯盘循环没有东西可以动。
//
// 报告(含每一步的完整返回)落在临时目录的 report.json,两次联调可以直接 diff。
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const ENGINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ENGINE_DIR, "dist", "src", "cli.js");

// ---- 参数 ----------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const list = (v) => (v ? String(v).split(",").map((s) => s.trim()).filter(Boolean) : []);

// 真配置不进仓库(.gitignore),所以在 git worktree 里跑时本目录下没有这份文件——
// 退到主检出(git common dir 的上一级)去找,免得每次都要写 --config
function defaultConfig() {
  const here = path.join(ENGINE_DIR, "..", "config", "settings.json");
  if (fs.existsSync(here)) return here;
  const git = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: ENGINE_DIR, encoding: "utf-8" });
  const main = git.status === 0 ? path.join(path.dirname(git.stdout.trim()), "config", "settings.json") : null;
  return main && fs.existsSync(main) ? main : here;
}
const baseConfig = path.resolve(opt("config", process.env.DAFRI_CONFIG || defaultConfig()));
const clientIdBase = Number(opt("client-id", "71"));
const symbols = list(opt("symbols", "AAPL,SPY")).map((s) => s.toUpperCase());
const indexSymbol = String(opt("index", "SPX")).toUpperCase();
const timeoutMs = Number(opt("timeout", "90000"));
// TWS 只给当天的成交,空的临时库里看不到历史:给一份库的**备份**,只把 broker_fills 这一张表灌进临时库
// (追踪、托管单、条件单一条不带——临时库照旧没有东西可以让盯盘循环去动)
const seedFills = opt("seed-fills", "");

// ---- 只读白名单 ------------------------------------------------------------
// 新增一步之前先确认那个 RPC 不会发单、撤单、改配置、动追踪。写库只许写临时库。
const ALLOWED = new Set([
  "system.status", "tws.scan", "tws.diagnose", "broker.connect", "broker.disconnect",
  "positions.list", "book.snapshot", "pa.analyze", "options.wall", "macro.board",
  "review.candidates", "records.list",
  // 复盘:读成交、拉 K 线、算数;唯一的写是把当天成交记进(临时)库
  "review.analyze",
]);

// ---- 步骤 ----------------------------------------------------------------
// 每一步是若干次 RPC;needs 是它依赖的前置步骤(只挑几步跑时自动补上)。
const STEPS = {
  env: { title: "引擎与端口", needs: [], calls: () => [["system.status", {}], ["tws.scan", {}]] },
  diagnose: { title: "握手与账户核对", needs: [], calls: (c) => [["tws.diagnose", { connections: c }]] },
  connect: { title: "建立交易连接", needs: [], calls: (c) => [["broker.connect", { connections: c }]] },
  positions: { title: "持仓", needs: ["connect"], calls: () => [["positions.list", {}]] },
  // 指数没有订单簿,不在这里查:指数现价看 after 那一步的 index_spot(夜盘按期货推算)与期权墙的现价
  quotes: {
    title: "盘口 / 深度行情",
    needs: ["connect"],
    calls: () => symbols.map((s) => ["book.snapshot", { symbol: s }]),
  },
  bars: {
    title: "历史 K 线",
    needs: ["connect"],
    calls: () => [
      ["pa.analyze", { symbol: indexSymbol, timeframe: "5m" }],
      ["pa.analyze", { symbol: symbols[0] ?? "AAPL", timeframe: "1d" }],
    ],
  },
  options: { title: "期权链(期权墙)", needs: ["connect"], calls: () => [["options.wall", { symbol: indexSymbol, width: 10 }]] },
  macro: { title: "宏观行情带", needs: ["connect"], calls: () => [["macro.board", { force: true }]] },
  fills: { title: "券商成交回报", needs: ["connect"], calls: () => [["review.candidates", { limit: 50 }]] },
  // 不走引擎:引擎的行情流会自动退到延迟、被拒也只记在流上,走 RPC 看不出"这个用户名到底有没有实时"。
  // 这一步直接用底层 API 逐个品种各问一次实时(类型 1)与延迟(类型 3),把 TWS 的原话摆出来。
  entitlements: { title: "行情权限(逐个品种:实时 / 延迟)", needs: ["positions"], run: () => checkEntitlements() },
  // 股票复盘:候选列表(期初仓位要靠当前持仓反推,所以排在 positions 之后)+ 逐笔分析
  stockreview: { title: "股票交易复盘", needs: ["positions"], script: () => stockReviewStep() },
  after: { title: "连接后的引擎状态", needs: [], calls: () => [["system.status", {}]] },
};

// ---- 已知的坑:出现这些签名就给出结论 ------------------------------------------
// 只扫报错、事件与引擎日志,不扫正常返回——返回里全是价格,7354.25 里也有个 354。
const SIGNATURES = [
  {
    re: /different IP address/i,
    say: "同一个 IBKR 用户名在别处也登着(手机 / 网页 / 另一台 TWS):历史数据与快照跟着那边走。" +
      "换一个用户名登录这台 TWS,或者退出别处的登录(退出后要等几分钟才恢复)。",
  },
  {
    re: /(?:^|[^\d.])10197\s*[:：]|IBKR 10197/,
    say: "10197:行情被另一个会话占用。同一用户名在别处登录时,实时行情只发给其中一个会话。",
  },
  {
    re: /(?:^|[^\d.])(354|10089|10090|10091|10167|10168)\s*[:：]/,
    say: "没有这个品种的行情订阅。行情订阅是按**用户名**算的,不是按账户:换了用户名登录同一账户," +
      "要在账户管理里给这个用户名重新订(或在 Market Data Subscriptions 里把订阅共享给它)。",
  },
  { re: /(?:^|[^\d.])101\s*[:：]/, say: "101:行情线路用完(默认约 100 条)。断开重连可立即释放。" },
  { re: /(?:^|[^\d.])326\s*[:：]|client id is already in use/i, say: "326:client id 被占用,换 --client-id 再跑。" },
  { re: /(?:^|[^\d.])(502|504)\s*[:：]|ECONNREFUSED/, say: "连不上 API 端口:TWS 没开 API、端口不对,或停在登录界面。" },
  { re: /(?:^|[^\d.])162\s*[:：]/, say: "162:历史数据请求被拒(常见于没有订阅,或同一用户名在别处登录)。" },
];

// ---- 选步骤 ----------------------------------------------------------------
const wanted = list(opt("steps", "")).length ? list(opt("steps", "")) : Object.keys(STEPS);
const unknown = wanted.filter((s) => !(s in STEPS));
if (unknown.length) {
  console.error(`没有这些步骤:${unknown.join("、")}。可选:${Object.keys(STEPS).join(" / ")}`);
  process.exit(2);
}
const order = [];
const add = (name) => {
  for (const dep of STEPS[name].needs) add(dep);
  if (!order.includes(name)) order.push(name);
};
wanted.forEach(add);
order.sort((a, b) => Object.keys(STEPS).indexOf(a) - Object.keys(STEPS).indexOf(b));

// ---- 临时配置 --------------------------------------------------------------
if (!fs.existsSync(baseConfig)) {
  console.error(`找不到配置:${baseConfig}(用 --config 指定,或设 DAFRI_CONFIG)`);
  process.exit(2);
}
const base = JSON.parse(fs.readFileSync(baseConfig, "utf-8"));
const ibkrConns = Object.entries(base.connections ?? {}).filter(([, c]) => (c.broker ?? "ibkr") === "ibkr");
const pick = list(opt("connection", ""));
const conns = pick.length ? ibkrConns.filter(([n]) => pick.includes(n)) : ibkrConns;
if (!conns.length) {
  console.error(`配置里没有可用的 IBKR 连接${pick.length ? `(要的是 ${pick.join("、")})` : ""}。`);
  process.exit(2);
}
const connNames = conns.map(([n]) => n);

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-probe-"));
const cfg = structuredClone(base);
cfg.broker = { ...(cfg.broker ?? {}), provider: "ibkr" };
cfg.connections = Object.fromEntries(conns.map(([n, c], i) => [n, { ...c, client_id: clientIdBase + i }]));
cfg.accounts = (cfg.accounts ?? []).filter((a) => connNames.includes(a.connection));
if (cfg.accounts.length && !cfg.accounts.some((a) => a.default)) cfg.accounts[0].default = true;
cfg.policies = { ...(cfg.policies ?? {}), auto_execute: false, allow_live_trading: false, allow_combo_live: false };
cfg.storage = { ...(cfg.storage ?? {}), db_path: path.join(workDir, "probe.db").split(path.sep).join("/") };
const configPath = path.join(workDir, "settings.json");
fs.writeFileSync(configPath, JSON.stringify(cfg, null, 1));

// ---- dist 过期就先编译(探针跑的是编译产物,改了源码不编译等于测上一版)-------------------
function stale() {
  if (!fs.existsSync(CLI)) return true;
  const src = path.join(ENGINE_DIR, "src");
  return fs.readdirSync(src).filter((f) => f.endsWith(".ts")).some((f) => {
    const out = path.join(ENGINE_DIR, "dist", "src", f.replace(/\.ts$/, ".js"));
    return !fs.existsSync(out) || fs.statSync(out).mtimeMs < fs.statSync(path.join(src, f)).mtimeMs;
  });
}
if (stale()) {
  console.log("dist 比源码旧,先编译一遍……");
  const r = spawnSync("npx", ["tsc"], { cwd: ENGINE_DIR, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// ---- 拉起引擎 RPC ------------------------------------------------------------
const child = spawn(process.execPath, [CLI, "--config", configPath, "rpc"], { cwd: ENGINE_DIR, stdio: ["pipe", "pipe", "pipe"] });
const stderr = [];
child.stderr.on("data", (d) => stderr.push(String(d)));
const waiting = new Map();
const events = [];
let nextId = 1;
readline.createInterface({ input: child.stdout }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id != null && waiting.has(msg.id)) {
    waiting.get(msg.id)(msg);
    waiting.delete(msg.id);
  } else if (msg.method === "event") {
    events.push(msg.params);
  }
});

function call(method, params) {
  if (!ALLOWED.has(method)) throw new Error(`探针不调 ${method}:不在只读白名单里`);
  const id = nextId++;
  const t0 = performance.now();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      resolve({ ms: Math.round(performance.now() - t0), error: { message: `超时 ${timeoutMs} ms` } });
    }, timeoutMs);
    waiting.set(id, (msg) => {
      clearTimeout(timer);
      resolve({ ms: Math.round(performance.now() - t0), result: msg.result, error: msg.error });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const clip = (v, n) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s && s.length > n ? `${s.slice(0, n)} …(共 ${s.length} 字)` : s;
};

// 每一步的一句话摘要:把最要紧的字段挑出来,完整返回在 report.json
function brief(method, params, r) {
  if (r.error) return r.error.message;
  const x = r.result ?? {};
  switch (method) {
    case "system.status":
      return `美东 ${x.now_et} ${x.market_status} · 券商已连 ${x.broker_connected} · 上游 ${x.broker_upstream_ok} · ` +
        `自动执行 ${x.auto_execute} · 实盘 ${x.allow_live_trading} · 指数现价 ${JSON.stringify(x.index_spot ?? {})} · ` +
        `盯盘循环 ${x.tracker_loop?.running ? `在跑(${x.tracker_loop.ticks} 轮)` : "未起"}`;
    case "tws.scan":
      return (x.ports ?? []).map((p) => `${p.port}${p.open ? "开" : "关"}${p.configured_as ? `(${p.configured_as})` : ""}`).join(" · ");
    case "tws.diagnose":
      return (x.results ?? []).map((d) =>
        `${d.connection}: ${d.connected ? "握手成功" : `失败 ${d.error}`} · server ${d.server_version} · ` +
        `可管账户 ${JSON.stringify(d.managed_accounts)} · 别名 ${(d.accounts ?? []).map((a) => `${a.alias}${a.resolved ? "✓" : "✗"}`).join(" ")}` +
        `${d.unmapped_accounts?.length ? ` · 未配别名 ${JSON.stringify(d.unmapped_accounts)}` : ""}`).join(" | ");
    case "broker.connect":
      return `已连 ${JSON.stringify(x.connected)}${Object.keys(x.failed ?? {}).length ? ` · 失败 ${JSON.stringify(x.failed)}` : ""}`;
    case "positions.list": {
      const rows = x.positions ?? [];
      const priced = rows.filter((p) => p.market_price !== null && p.market_price !== undefined).length;
      return `${rows.length} 条持仓(${priced} 条有市价)${rows.length ? `:${rows.slice(0, 8).map((p) => `${p.label ?? p.symbol} ×${p.quantity}`).join("、")}` : ""}`;
    }
    case "book.snapshot": {
      // L1 在盘外常常是空的(SMART 不报夜盘价),深度档位才说明这个用户名有没有行情
      const l1 = x.l1 ?? {};
      const top = (side) => (side?.length ? `${side[0].price}×${side[0].size}` : "—");
      return `${params.symbol} L1 买 ${l1.bid ?? "—"} / 卖 ${l1.ask ?? "—"} / 最新 ${l1.last ?? "—"} · ` +
        `深度 ${x.bids?.length ?? 0}+${x.asks?.length ?? 0} 档(买一 ${top(x.bids)} / 卖一 ${top(x.asks)})${x.note ? ` · ${x.note}` : ""}`;
    }
    case "pa.analyze": {
      const last = x.last_bar ?? null;
      return `${params.symbol} ${params.timeframe}:${x.bar_count ?? 0} 根,最后一根 ${last?.time ?? last ?? "—"}` +
        `${x.cached ? "(缓存)" : ""}${x.warnings?.length ? ` · ${x.warnings.join(";")}` : ""}`;
    }
    case "options.wall":
      return `${params.symbol} 到期 ${x.expiry} · 现价 ${x.spot}(${x.spot_source}) · ${x.strike_count} 档 · ` +
        `OI 合计 call ${x.total_call_oi} / put ${x.total_put_oi} · 希腊值 ${x.has_greeks ? "有" : "无"}`;
    case "macro.board": {
      const rows = x.rows ?? [];
      return `${x.live_count ?? 0}/${rows.length} 条走券商实时,其余来自公开源:` +
        rows.map((i) => `${i.label} ${i.last ?? "—"}(${i.source})`).join(" · ");
    }
    case "review.analyze": {
      if (x.kind !== "stock") return `${x.intent_summary ?? params.id}:${x.outcome?.kind} · 盈亏 ${x.outcome?.pnl ?? "—"}`;
      const s = x.stats ?? {};
      return `${x.intent_summary} · ${x.timeframe_label} ${x.series?.bars?.length ?? 0} 根 · ${x.outcome?.kind} 盈亏 ${x.outcome?.pnl ?? "—"} · ` +
        `进场位置 ${s.entry_position ?? "—"} 出场位置 ${s.exit_position ?? "—"} 兑现 ${s.capture_pct ?? "—"}% · ` +
        `结论 ${(x.findings ?? []).map((f) => `${f.title}[${f.tone}]`).join(" ")}${x.notes?.length ? ` · 注 ${x.notes.length} 条` : ""}`;
    }
    case "review.candidates":
      return `券商可用 ${x.ibkr_available} · 本次同步成交 ${x.synced} 条 · 库里共 ${x.fills_stored} 条 · 候选 ${(x.candidates ?? []).length} 条(股票 ${(x.candidates ?? []).filter((c) => c.kind === "stock").length})`;
    default:
      return clip(x, 300);
  }
}

// ---- 行情权限:底层 API 直问 --------------------------------------------------
// 行情订阅是按**用户名**算的:同一个账户换个用户名登录,订阅不跟过去。TWS 界面里有报价也不代表
// API 拿得到(10089 = 只订了界面用的那一档)。所以逐个品种各订一次实时与延迟,看 TWS 回什么。
const LIVE_FIELDS = new Set([1, 2, 4, 6, 7, 9, 14]); // BID ASK LAST HIGH LOW CLOSE OPEN
const DELAYED_FIELDS = new Set([66, 67, 68, 72, 73, 75, 76]); // 同上的 DELAYED_* 版本
const MD_CODES = new Set([354, 10089, 10090, 10091, 10167, 10168, 10197, 200]);

async function checkEntitlements() {
  const { IBApi, EventName } = await import("@stoqey/ib");
  const conn = cfg.connections[connNames[0]];
  const api = new IBApi({ host: conn.host, port: conn.port });
  const seen = new Map(); // reqId → { live, delayed, codes: Map<code, msg> }
  const details = new Map(); // reqId → contract[]
  const done = new Map(); // reqId → resolve
  const state = (id) => {
    if (!seen.has(id)) seen.set(id, { live: false, delayed: false, codes: new Map() });
    return seen.get(id);
  };
  api.on(EventName.error, (err, code, reqId) => {
    if (reqId > 0 && MD_CODES.has(Number(code))) state(reqId).codes.set(Number(code), String(err?.message ?? err).slice(0, 160));
    if (reqId > 0 && done.has(reqId) && Number(code) === 200) done.get(reqId)();
  });
  api.on(EventName.tickPrice, (reqId, field) => {
    if (LIVE_FIELDS.has(field)) state(reqId).live = true;
    if (DELAYED_FIELDS.has(field)) state(reqId).delayed = true;
  });
  api.on(EventName.contractDetails, (reqId, d) => {
    if (!details.has(reqId)) details.set(reqId, []);
    details.get(reqId).push(d.contract);
  });
  api.on(EventName.contractDetailsEnd, (reqId) => done.get(reqId)?.());

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("底层连接超时(10 秒)")), 10_000);
    api.once(EventName.nextValidId, () => {
      clearTimeout(t);
      resolve();
    });
    api.connect(clientIdBase + 10);
  });

  try {
    let reqId = 7000;
    // 期货取到期日晚于今天的最近一张——和引擎夜盘推算指数现价用的是同一张
    const cdId = reqId++;
    const esList = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(details.get(cdId) ?? []), 6000);
      done.set(cdId, () => {
        clearTimeout(t);
        resolve(details.get(cdId) ?? []);
      });
      api.reqContractDetails(cdId, { symbol: "ES", secType: "FUT", exchange: "CME", currency: "USD" });
    });
    // 按美东日期比,只比前 8 位:TWS 回的到期字段有时带着时间("20260918 08:30 US/Central"),
    // 整串比会把今天到期的那张也算成"晚于今天"
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date()).replaceAll("-", "");
    const expiry = (c) => String(c.lastTradeDateOrContractMonth).slice(0, 8);
    const es = esList.filter((c) => expiry(c) > today).sort((a, b) => expiry(a).localeCompare(expiry(b)))[0];

    const targets = symbols.map((s) => [`${s} 正股`, { symbol: s, secType: "STK", exchange: "SMART", currency: "USD" }]);
    if (es) targets.push([`ES ${String(es.lastTradeDateOrContractMonth).slice(0, 6)} 期货`, { conId: es.conId, exchange: "CME" }]);
    targets.push([`${indexSymbol} 指数`, { symbol: indexSymbol, secType: "IND", exchange: "CBOE", currency: "USD" }]);
    // 手上的期权腿:持仓盈亏、追踪到价、追价平仓都靠它们的报价
    const held = report.steps.find((s) => s.method === "positions.list")?.result?.positions ?? [];
    for (const p of held.filter((x) => x.sec_type === "OPT" && x.contract).slice(0, 2)) {
      targets.push([`${p.label} 期权`, { ...p.contract, exchange: "SMART" }]);
    }

    const rounds = {};
    for (const type of [1, 3]) {
      api.reqMarketDataType(type);
      const ids = targets.map(([, contract]) => {
        const id = reqId++;
        api.reqMktData(id, contract, "", false, false);
        return id;
      });
      await sleep(4000);
      ids.forEach((id) => api.cancelMktData(id));
      rounds[type] = ids.map((id) => state(id));
      await sleep(300);
    }

    return targets.map(([name], i) => {
      const rt = rounds[1][i];
      const dl = rounds[3][i];
      const rtCodes = [...rt.codes.keys()];
      const level = rt.live && !rtCodes.some((c) => c !== 10167) ? "实时"
        : dl.live ? "实时"
          : dl.delayed ? "仅延迟"
            : "无";
      return {
        name, level,
        realtime_codes: Object.fromEntries(rt.codes),
        delayed_codes: Object.fromEntries(dl.codes),
      };
    });
  } finally {
    api.disconnect();
  }
}

// ---- 股票复盘 ----------------------------------------------------------------
async function stockReviewStep() {
  if (seedFills) {
    const { createRequire } = await import("node:module");
    const Database = createRequire(import.meta.url)("better-sqlite3");
    const src = new Database(path.resolve(seedFills), { readonly: true, fileMustExist: true });
    const rows = src.prepare("SELECT exec_id, account_id, perm_id, time, fill_json FROM broker_fills").all();
    src.close();
    const dst = new Database(cfg.storage.db_path);
    const put = dst.prepare("INSERT OR IGNORE INTO broker_fills (exec_id, account_id, perm_id, time, fill_json) VALUES (?, ?, ?, ?, ?)");
    dst.transaction(() => rows.forEach((r) => put.run(r.exec_id, r.account_id, r.perm_id, r.time, r.fill_json)))();
    dst.close();
    console.log(`  · 从 ${seedFills} 灌入 ${rows.length} 条历史成交`);
  }
  const listed = await doCall("stockreview", "review.candidates", { limit: 200 });
  const stocks = (listed.result?.candidates ?? []).filter((c) => c.kind === "stock");
  for (const c of stocks) {
    console.log(`  · ${c.id} ${c.intent_summary} · ${c.status}${c.carried ? " · carried" : ""}${c.opening_assumed ? " · 期初未核对" : ""}`);
  }
  for (const c of stocks.slice(0, 8)) await doCall("stockreview", "review.analyze", { id: c.id, timeframe: "auto" });
}

async function doCall(name, method, params) {
  const r = await call(method, params);
  const ok = !r.error;
  report.steps.push({ step: name, method, params, ok, ms: r.ms, result: r.result ?? null, error: r.error ?? null });
  console.log(`  ${ok ? "✓" : "✗"} ${method} ${String(r.ms).padStart(6)} ms  ${clip(brief(method, params, r), 600)}`);
  return r;
}

// ---- 跑 ------------------------------------------------------------------
console.log(`配置:${baseConfig}\n临时目录:${workDir}\n连接:${connNames.map((n) => `${n}(${cfg.connections[n].host}:${cfg.connections[n].port} client ${cfg.connections[n].client_id})`).join("、")}` +
  `\n账户:${cfg.accounts.map((a) => `${a.alias}${a.is_paper ? "·纸面" : "·实盘"}`).join("、") || "(无)"}\n步骤:${order.join(" → ")}\n`);

const report = { at: new Date().toISOString(), base_config: baseConfig, connections: cfg.connections, steps: [] };
for (const name of order) {
  const step = STEPS[name];
  console.log(`— ${name}:${step.title}`);
  if (step.script) {
    await step.script();
    continue;
  }
  if (step.run) {
    const t0 = performance.now();
    let result = null;
    let error = null;
    try {
      result = await step.run();
    } catch (exc) {
      error = { message: String(exc?.message ?? exc) };
    }
    const ms = Math.round(performance.now() - t0);
    report.steps.push({ step: name, method: `(直连) ${name}`, params: null, ok: !error, ms, result, error });
    if (error) console.log(`  ✗ ${String(ms).padStart(6)} ms  ${error.message}`);
    for (const row of result ?? []) {
      const codes = { ...row.realtime_codes, ...row.delayed_codes };
      const why = Object.keys(codes).filter((c) => c !== "10167").join("/");
      console.log(`  ${row.level === "实时" ? "✓" : "✗"} ${row.name.padEnd(24)} ${row.level}${why ? `(${why})` : ""}`);
    }
    continue;
  }
  for (const [method, params] of step.calls(connNames)) await doCall(name, method, params);
}

// 引擎的节拍器、行情暖机都是后台跑的,留一点时间让它们把报错吐出来
await new Promise((r) => setTimeout(r, 1500));
child.stdin.end();
await new Promise((r) => {
  const t = setTimeout(() => {
    child.kill();
    r();
  }, 5000);
  child.on("exit", () => {
    clearTimeout(t);
    r();
  });
});

// ---- 诊断 ------------------------------------------------------------------
const noisy = [
  ...report.steps.filter((s) => s.error).map((s) => `${s.method}: ${s.error.message}`),
  ...events.filter((e) => e.event !== "ready" && e.event !== "tws").map((e) => JSON.stringify(e.data ?? e)),
  ...stderr.join("").split(/\r?\n/),
].filter(Boolean);
const findings = [];
for (const sig of SIGNATURES) {
  const hits = noisy.filter((line) => sig.re.test(line));
  if (hits.length) findings.push({ say: sig.say, hits: hits.slice(0, 3) });
}
// 行情权限:引擎自己会退到延迟、被拒也不报,所以这几条只能从直连那一步推出来
const ent = report.steps.find((s) => s.step === "entitlements")?.result ?? [];
const notLive = ent.filter((r) => r.level !== "实时");
if (notLive.length) {
  const all = Object.values(Object.assign({}, ...notLive.map((r) => ({ ...r.realtime_codes, ...r.delayed_codes }))));
  const apiOnly = all.some((m) => /API|additional subscription/i.test(m));
  findings.push({
    say: `这个登录在 API 上没有实时行情:${notLive.map((r) => `${r.name}(${r.level})`).join("、")}。` +
      "行情订阅按用户名算,换一个用户名登录同一账户,订阅不会跟过去,要在账户管理 → 设置 → 市场数据订阅里给这个用户名单独订" +
      `${apiOnly ? ";10089 还说明 TWS 界面里能看到报价也不算数——那一档只给界面用,API 要另订" : ""}。`,
    hits: [],
  });
  const es = notLive.find((r) => r.name.startsWith("ES "));
  if (es) {
    findings.push({
      say: `ES 期货只有${es.level === "仅延迟" ? "延迟(约 10–15 分钟)" : "——连延迟都没有"}:夜盘的 SPX 现价是拿 ES 减基差推出来的,` +
        "速记蝴蝶的中心、条件单的触发方向复核都会用这个落后的价——而引擎目前不会把它标成延迟。",
      hits: [],
    });
  }
}
const held = report.steps.find((s) => s.method === "positions.list")?.result?.positions ?? [];
if (held.length && held.every((p) => p.market_price === null || p.market_price === undefined)) {
  findings.push({
    say: `${held.length} 条持仓一个市价都没拿到:持仓页没有盈亏,追踪的止盈止损到价也不会触发。` +
      "引擎的持仓市价只来自行情流(portfolio() 还没接 TWS 的账户推送),所以行情订阅缺了这里就全空。",
    hits: [],
  });
}
const accounts = report.steps.find((s) => s.method === "tws.diagnose")?.result?.results ?? [];
for (const d of accounts) {
  const bad = (d.accounts ?? []).filter((a) => !a.resolved);
  if (bad.length) findings.push({ say: `${d.connection}:别名 ${bad.map((a) => a.alias).join("、")} 对不上这个 TWS 可管的账户,发到它们的单会被拒。`, hits: [] });
}

report.events = events;
report.stderr = stderr.join("");
report.findings = findings;
fs.writeFileSync(path.join(workDir, "report.json"), JSON.stringify(report, null, 1));

const failed = report.steps.filter((s) => !s.ok);
console.log(`\n${report.steps.length - failed.length}/${report.steps.length} 通过${failed.length ? `;失败:${failed.map((s) => `${s.step}/${s.method}`).join("、")}` : ""}`);
if (findings.length) {
  console.log("\n诊断:");
  for (const f of findings) {
    console.log(`  · ${f.say}`);
    for (const h of f.hits) console.log(`      ${clip(h, 240)}`);
  }
} else {
  console.log("诊断:没有命中已知的坑(10197 / different IP / 行情权限 / 线路用完 / client id 冲突 / 持仓无市价)。");
}
const logTail = stderr.join("").trim().split(/\r?\n/).filter(Boolean).slice(-15);
if (logTail.length) console.log(`\n引擎日志(最后 ${logTail.length} 行):\n${logTail.map((l) => `  ${clip(l, 240)}`).join("\n")}`);
console.log(`\n完整报告:${path.join(workDir, "report.json")}`);
process.exit(failed.length ? 1 : 0);
