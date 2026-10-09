// 蝶式出场参数的离线扫描:拿软件自己记下来的盘口(fly-iv/ 目录),问"换一组出场参数,过去这些天会怎样"。
//
//   npm run build && npm run sweep:fly -- --dir auto --arm 50,100,150 --tighten 150,200,300
//   npm run sweep:fly -- --dir D:/dafri/fly-iv --wings 25 --entry-from 09:45 --entry-to 13:30 --debit-min 1 --debit-max 4 \
//       --dist-min 10 --dist-max 40 --arm 50,75,100,150 --stop-mult none,0.5 --commission 0.65 --out D:/tmp/sweep.json
//   npm run sweep:fly -- --dir auto --entries D:/tmp/my-entries.json --by all --arm 50,100,150      # 只算自己真实的入场
//   npm run sweep:fly -- --dir auto --replay --replay-grid '{"stop":[0.4,0.5,0.6],"trail_arm":[1.2,1.3,1.5]}'
//
// 只读:不改样本目录、不写仓库、不改任何源文件。要把结果留下来,用 --out 指一个仓库之外的路径(JSON)。
// 算法在 src/flyExitSweep*.ts(纯函数,tests/fly-exit-sweep.spec.ts 拿合成的"记下来的天"钉着);这里只管读目录、
// 把参数拼成配置、打印报告。口径、怎么读报告、它说不了什么,见 docs/features/fly-exit-sweep.md。
//
// --dir:样本目录(services/ivRecorder.ts 写的 fly-iv/,一天一个 .jsonl)。auto = 从配置里的 storage.db_path 找
//        (--config 指定配置文件;和 calibrate-fly-iv.mjs 的 --samples auto 同一个找法)。没有别的默认路径。
//
// 入场人群(都没有默认值,不给就是不限;报告里逐项写明):
//   --symbol SPX                只扫这个标的的样本(默认 = 后台那一路记的标的)
//   --by loop|plan|all          用哪一路记的样本(默认 loop:后台五分钟一笔的那一路,行权价一整天不换)
//   --entry-from / --entry-to   入场时刻的窗口,美东 HH:MM
//   --wings 25,50               翼宽;--right C|P
//   --debit-min / --debit-max   入场价 D(点)
//   --dist-min / --dist-max     中心在现价虚值一侧多少点(看涨 = 中心 − 现价,看跌 = 现价 − 中心)
//   --entries file.json         真实入场的清单:[{"time":"2026-10-07 10:32","center":7750,"wing":25,"right":"C","quantity":1,"debit":2.2}]
//                               (time 是美东墙钟或带时区的 ISO;quantity、debit 可以不给)。给了就只算这几笔
// 成交口径:
//   --entry-spread-share 1      入场价 = 中间价 + 这一份 ×(立刻买得到的价 − 中间价);1 = 两翼卖价、中心买价(默认,保守)
//   --commission 0.65           每张合约每一边的佣金(美元)。**没有默认值**:不给,报告写明"扣佣金之前"
//   --terminal natural|settle   一直没出场的怎么了结(默认 natural:当天最后一笔的立刻成交价)
//   --settle-within 5.5         settle 口径下,最后一笔离收盘不超过这么多分钟才算记到了收盘(默认 = 记录间隔 + 一个节拍)
//   --stop-basis mid|natural    止损类拿哪个价判(默认 mid,和追踪的默认一样)
//   --qty 1  --multiplier 100   每个情景几组;合约乘数
//   --stride 1                  隔几笔样本判断一次
// 实盘预设要比的参数(每一项给几个取值,做全部组合;参照组 = flyexit 里现在的值,永远在):
//   --arm 50,100,150  --tighten 150,200,300  --tiers 40/30/20,50/35/20  --tight-at 3,4
//   --late-after 15:00,15:30  --late-factor 0.5,1  --floor 0.2,0.3  --stop-mult none,0.5  --exit-at none,15:30
//   --ref '{"stop_mult":0.5}'   参照组里预设之外的那两项(止损、到点)是每条追踪上人填的;你实盘固定这么设,就在这里说
//   --grid file.json            {"live":{"arm_usd":[…],…},"sets":[{…}],"replay":{"stop":[…]}}:同上,写成文件
// 回放策略(flyexit.simulate):
//   --replay                    连回放策略一起比;--replay-grid '{"stop":[0.4,0.5]}' 给要比的参数(键是 flyexit.DEFAULTS 上的)
//   --em auto|36                EM 每天从记下来的平值跨式取(默认),或一律用这个数
// 统计:
//   --objective r|usd           结论按哪个目标出(默认 r:盈亏 ÷ 付出的权利金);--level 0.95  --draws 2000  --seed 1
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENGINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const FLAGS = new Set([
  "dir", "config", "out", "symbol", "by", "entry-from", "entry-to", "wings", "right", "debit-min", "debit-max", "dist-min", "dist-max", "entries",
  "entry-spread-share", "commission", "terminal", "settle-within", "stop-basis", "qty", "multiplier", "stride",
  "arm", "tighten", "tiers", "tight-at", "late-after", "late-factor", "floor", "stop-mult", "exit-at", "ref", "grid",
  "replay", "replay-grid", "em", "objective", "level", "draws", "seed",
]);
const SWITCHES = new Set(["replay"]);

const fail = (message) => {
  console.error(`扫描没做:${message}`);
  process.exit(1);
};

// 不认识的参数当场拒:一个写错名字的人群限定被悄悄忽略,报告说的就不是你以为的那群蝶
const given = new Map();
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (!arg.startsWith("--")) fail(`看不懂「${arg}」:参数都以 -- 开头。`);
  const name = arg.slice(2);
  if (!FLAGS.has(name)) fail(`没有 --${name} 这个参数(用法在这个脚本的开头)。`);
  if (SWITCHES.has(name)) {
    given.set(name, "1");
  } else {
    if (argv[i + 1] === undefined) fail(`--${name} 后面要跟一个值。`);
    given.set(name, argv[i + 1]);
    i += 1;
  }
}
const opt = (name, dflt = null) => (given.has(name) ? given.get(name) : dflt);
const num = (name, dflt = null) => {
  const raw = opt(name);
  if (raw === null) return dflt;
  const v = Number(raw);
  if (!Number.isFinite(v)) fail(`--${name} 要是一个数,收到「${raw}」。`);
  return v;
};
const list = (name) => (opt(name) === null ? null : String(opt(name)).split(",").map((v) => v.trim()).filter(Boolean));
const nums = (name) => {
  const raw = list(name);
  if (raw === null) return undefined;
  return raw.map((v) => {
    if (!Number.isFinite(Number(v))) fail(`--${name} 里的「${v}」不是数。`);
    return Number(v);
  });
};
const numsOrNone = (name) => {
  const raw = list(name);
  if (raw === null) return undefined;
  return raw.map((v) => {
    if (v === "none") return null;
    if (!Number.isFinite(Number(v))) fail(`--${name} 里的「${v}」不是数(不设写 none)。`);
    return Number(v);
  });
};
const oneOf = (name, choices, dflt) => {
  const v = opt(name, dflt);
  if (!choices.includes(v)) fail(`--${name} 只能是 ${choices.join(" / ")},收到「${v}」。`);
  return v;
};
const json = (text, what) => {
  try {
    return JSON.parse(text);
  } catch (err) {
    return fail(`${what} 不是合法的 JSON:${err.message}`);
  }
};
const readJson = (file) => {
  if (!fs.existsSync(file)) fail(`没有 ${file}。`);
  return json(fs.readFileSync(file, "utf-8"), file);
};

/** --dir auto:配置里的交易库在哪,样本就在它旁边的 fly-iv/(和 calibrate-fly-iv.mjs 同一个找法) */
function samplesDir() {
  const dir = opt("dir");
  if (dir === null) fail("要给 --dir(样本目录;auto = 从配置里的 storage.db_path 找)。");
  if (dir !== "auto") return path.resolve(dir);
  const config = path.resolve(opt("config", process.env.DAFRI_CONFIG || path.join(ENGINE_DIR, "..", "config", "settings.json")));
  if (!fs.existsSync(config)) fail(`--dir auto 要读配置里的 storage.db_path,但没有 ${config}。用 --config 指过去,或者直接给 --dir 一个目录。`);
  const raw = String(readJson(config)?.storage?.db_path ?? "");
  if (!raw) fail(`${config} 里没有 storage.db_path。`);
  const db = raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\") ? path.join(os.homedir(), raw.slice(2)) : raw;
  return path.join(path.dirname(path.resolve(db)), "fly-iv");
}

function loadSamples(dir) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();
  } catch {
    fail(`读不了样本目录 ${dir}。`);
  }
  const out = [];
  for (const name of files) {
    for (const line of fs.readFileSync(path.join(dir, name), "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const s = JSON.parse(line);
        if (typeof s.t === "number" && s.spot > 0 && Array.isArray(s.legs)) out.push(s);
      } catch {
        /* 写了一半的行 */
      }
    }
  }
  return { files: files.length, samples: out };
}

/** --out 写到哪。派生出来的数可以留,但不留在仓库里:里面有按天的盈亏,换一批数据就过时。算之前就查,别算完才发现写不了 */
function outTarget() {
  const out = opt("out");
  if (out === null) return null;
  const target = path.resolve(out);
  // 比的是解开符号链接之后的真路径(/tmp 之类)
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return fail(`--out 的目录不存在:${p}`);
    }
  };
  const repo = real(path.resolve(ENGINE_DIR, "..")), where = real(path.dirname(target));
  if (where === repo || where.startsWith(repo + path.sep)) fail(`--out 不能指到仓库里(${repo}):结果不进仓库。`);
  return target;
}

async function main() {
  const target = outTarget();
  const lib = (name) => path.join(ENGINE_DIR, "dist", "src", name);
  if (!fs.existsSync(lib("flyExitSweep.js"))) fail("没有 dist/src/flyExitSweep.js:先 npm run build。");
  const { runSweep } = await import(lib("flyExitSweep.js"));
  const { SweepError, entriesFrom, gridFileFrom, liveReference, liveSets, replaySets } = await import(lib("flyExitSweepSpec.js"));
  const { summarise } = await import(lib("flyExitSweepStats.js"));
  const { formatReport } = await import(lib("flyExitSweepReport.js"));
  const tracker = await import(lib("tracker.js")); // 判定用的就是实盘那一份
  const { IvRecorderService } = await import(lib(path.join("services", "ivRecorder.js")));

  const dir = samplesDir();
  const { files, samples } = loadSamples(dir);
  if (!samples.length) fail(`${dir} 里没有样本(${files} 个文件)。`);

  const tiers = list("tiers")?.map((t) => {
    const parts = t.split("/").map(Number);
    if (parts.length !== 3 || parts.some((v) => !Number.isFinite(v))) fail(`--tiers 的每一组要写成 40/30/20,收到「${t}」。`);
    return parts;
  });
  const exitAt = list("exit-at")?.map((v) => (v === "none" ? null : v));
  const em = opt("em", "auto");
  if (em !== "auto" && !(Number(em) > 0)) fail(`--em 要是 auto 或一个正数,收到「${em}」。`);
  const right = opt("right") === null ? null : oneOf("right", ["C", "P"], null);
  const objective = oneOf("objective", ["r", "usd"], "r");
  let config;
  try {
    // 文件与命令行里写错的键名、看不懂的时刻,都由模块里的校验当场拒(flyExitSweepSpec 的 gridFileFrom / entriesFrom / liveSets / replaySets)
    const file = gridFileFrom(opt("grid") === null ? {} : readJson(path.resolve(opt("grid"))));
    const grid = {
      ...file.live,
      ...Object.fromEntries(Object.entries({
        arm_usd: nums("arm"), tighten_usd: nums("tighten"), tiers, tight_at: nums("tight-at"), late_after: list("late-after") ?? undefined,
        late_factor: nums("late-factor"), floor: nums("floor"), stop_mult: numsOrNone("stop-mult"), exit_at: exitAt,
      }).filter(([, v]) => v !== undefined)),
    };
    const reference = { ...liveReference(), ...(opt("ref") === null ? {} : json(opt("ref"), "--ref")) };
    const replayGrid = { ...file.replay, ...(opt("replay-grid") === null ? {} : json(opt("replay-grid"), "--replay-grid")) };
    const wantReplay = given.has("replay") || Object.keys(replayGrid).length > 0;
    config = {
      symbol: opt("symbol", IvRecorderService.SYMBOL),
      population: {
        by: oneOf("by", ["loop", "plan", "all"], "loop"), entry_from: opt("entry-from"), entry_to: opt("entry-to"),
        wings: nums("wings") ?? null, rights: right === null ? null : [right],
        debit_min: num("debit-min"), debit_max: num("debit-max"), dist_min: num("dist-min"), dist_max: num("dist-max"),
      },
      entries: opt("entries") === null ? null : entriesFrom(readJson(path.resolve(opt("entries")))),
      fill: {
        entry_spread_share: num("entry-spread-share", 1), commission: num("commission"),
        terminal: oneOf("terminal", ["natural", "settle"], "natural"),
        // 后台那一路每隔 INTERVAL 记一笔、每个 TICK 看一眼:记到了收盘的那一天,最后一笔离收盘不会超过两者之和
        settle_within_min: num("settle-within", (IvRecorderService.INTERVAL_MS + IvRecorderService.TICK_MS) / 60_000),
        stop_basis: oneOf("stop-basis", ["mid", "natural"], "mid"), qty: num("qty", 1), multiplier: num("multiplier", 100),
      },
      live: liveSets(reference, grid, file.sets),
      replay: wantReplay ? { em: em === "auto" ? "auto" : Number(em), sets: replaySets(replayGrid) } : null,
      stride: num("stride", 1),
    };
  } catch (err) {
    if (err instanceof SweepError) fail(err.message);
    throw err;
  }

  console.error(`读到 ${dir}:${files} 天的文件、${samples.length} 笔;实盘预设 ${config.live.length} 组${config.replay ? `、回放策略 ${config.replay.sets.length} 组` : ""}。开始算……`);
  let result;
  try {
    result = runSweep(samples, config, tracker, (date, done, total) => console.error(`  ${date}(${done}/${total})`));
  } catch (err) {
    if (err instanceof SweepError) fail(err.message);
    throw err;
  }
  const summary = summarise(result, objective, { level: num("level", 0.95), draws: num("draws", 2000), seed: num("seed", 1) });
  console.log(formatReport(result, summary).join("\n"));
  console.log(`\n样本目录:${dir}`);

  if (target === null) {
    console.log("没有写任何文件(要把数留下来加 --out 路径.json)。");
    return;
  }
  fs.writeFileSync(target, JSON.stringify({ dir, args: Object.fromEntries(given), result, summary }, null, 2));
  console.log(`已写入 ${target}。`);
}

main().catch((err) => {
  console.error(`扫描没做成:${err.message}`);
  process.exit(1);
});
