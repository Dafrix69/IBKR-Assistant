// 蝴蝶测算的 IV 模型:拿历史数据重新校准一遍。
//
//   npm run build && npm run calibrate:fly -- --fetch            # 取数据、校准、打印报告(不改任何文件)
//   npm run calibrate:fly -- --fetch --write                     # 同上,并把结果写进 src/flyIvModel.ts
//   npm run calibrate:fly -- --data D:/calib                     # 用这个目录里已经有的数据(不联网)
//   npm run calibrate:fly -- --fetch --price QQQ --iv ^VXN       # 换标的(IV 指数要自己配对)
//   npm run calibrate:fly -- --fetch --samples auto --write      # 连同软件自己攒的当日到期期权 IV 一起估
//   npm run calibrate:fly -- --data D:/calib --samples D:/dafri/fly-iv
//
// --samples:软件自己记下来的当日到期期权 IV(services/ivRecorder.ts,交易库旁边的 fly-iv/ 目录)。auto = 从配置里的
// storage.db_path 找那个目录(--config 指定配置文件)。只读,不改那个目录里的任何东西。攒够了(至少 40 天)、
// 估出来在留出的那一段上不输指数那一份,才写进模型的 own;否则只出报告。
//
// 要三份小时线(标的、1 天期 IV 指数、长一档的 IV 指数)和一份标的的 5 分钟线。--fetch 从公开行情接口取
// (和引擎顶栏行情带用的是同一个),落在 --data 目录里;原始数据**不进仓库**,进仓库的只有估出来的参数。
// 目录里的文件是那个接口原样的 JSON(chart.result[0] 里的 timestamp 与 indicators.quote[0]),别的来源的数据转成这个形状也能用。
//
// 算法在 src/flyCalibration.ts(纯函数,tests/fly-calibration.spec.ts 拿合成数据钉着);这里只管取数、调用、出报告。
// 写完之后跑一遍测试:fly-plan.spec 里有几条是对着具体数字的,参数变了它们会红——那是行为变了,核对过再改断言。
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENGINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};

const dataDir = path.resolve(opt("data", path.join(os.tmpdir(), "dafri-fly-calibration")));
const priceSymbol = opt("price", "SPY");
const ivSymbol = opt("iv", "^VIX1D");
const ivLongSymbol = opt("iv-long", "^VIX9D");
const ivLongDays = Number(opt("iv-long-days", "9"));
const HOST = "https://query1.finance.yahoo.com/v8/finance/chart/";

/** --samples auto:配置里的交易库在哪,样本就在它旁边的 fly-iv/ */
function samplesDir() {
  const given = opt("samples", "");
  if (!given) return null;
  if (given !== "auto") return path.resolve(given);
  const config = path.resolve(opt("config", process.env.DAFRI_CONFIG || path.join(ENGINE_DIR, "..", "config", "settings.json")));
  if (!fs.existsSync(config)) throw new Error(`--samples auto 要读配置里的 storage.db_path,但没有 ${config}。用 --config 指过去,或者直接给 --samples 一个目录。`);
  const raw = String(JSON.parse(fs.readFileSync(config, "utf-8"))?.storage?.db_path ?? "");
  if (!raw) throw new Error(`${config} 里没有 storage.db_path。`);
  const db = raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\") ? path.join(os.homedir(), raw.slice(2)) : raw;
  return path.join(path.dirname(path.resolve(db)), "fly-iv");
}

function loadSamples(dir) {
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();
  } catch {
    throw new Error(`读不了样本目录 ${dir}。`);
  }
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

const fileOf = (symbol, interval) => path.join(dataDir, `${symbol.replace(/[^A-Za-z0-9]/g, "")}-${interval}.json`);

async function fetchOne(symbol, interval, range) {
  const url = `${HOST}${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: globalThis.AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${symbol} ${interval}:HTTP ${res.status}`);
  const text = await res.text();
  if (!JSON.parse(text)?.chart?.result?.[0]?.timestamp?.length) throw new Error(`${symbol} ${interval}:回来的数据是空的`);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(fileOf(symbol, interval), text);
}

function load(symbol, interval) {
  const file = fileOf(symbol, interval);
  if (!fs.existsSync(file)) throw new Error(`没有 ${file}。先带 --fetch 跑一遍,或者把数据放到 --data 目录里。`);
  const r = JSON.parse(fs.readFileSync(file, "utf-8")).chart.result[0];
  const q = r.indicators.quote[0];
  const bars = [];
  for (let i = 0; i < r.timestamp.length; i += 1) {
    if (q.open[i] == null || q.close[i] == null) continue;
    bars.push({ sec: r.timestamp[i], open: q.open[i], close: q.close[i] });
  }
  return bars;
}

const dayOf = (sec) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(sec * 1000));
const pct = (v) => `${(v * 100).toFixed(1)}%`;

async function main() {
  const lib = path.join(ENGINE_DIR, "dist", "src", "flyCalibration.js");
  if (!fs.existsSync(lib)) throw new Error("没有 dist/src/flyCalibration.js:先 npm run build。");
  const { calibrate, fitFromSamples, ownIsBetter, predict, remainingShare, OPEN_MINUTE, OWN_MIN_DAYS } = await import(lib);

  if (has("fetch")) {
    for (const [symbol, interval, range] of [
      [priceSymbol, "60m", "730d"], [priceSymbol, "5m", "60d"], [ivSymbol, "60m", "730d"], [ivLongSymbol, "60m", "730d"],
    ]) {
      await fetchOne(symbol, interval, range);
      console.log(`取到 ${symbol} ${interval} → ${fileOf(symbol, interval)}`);
    }
  }

  const priceHourly = load(priceSymbol, "60m"), priceFine = load(priceSymbol, "5m");
  const ivHourly = load(ivSymbol, "60m"), ivLongHourly = load(ivLongSymbol, "60m");
  const base = {
    priceHourly, priceFine, ivHourly, ivLongHourly, ivLongDays,
    source: `${priceSymbol} 小时线与 5 分钟线、${ivSymbol} 与 ${ivLongSymbol} 小时线(公开行情接口)`,
    proxy: ivSymbol.replace("^", ""),
    version: new Date().toISOString().slice(0, 10),
  };
  const model = calibrate(base);

  console.log(`\n样本:${model.period.from} → ${model.period.to},${model.days} 个交易日,${model.fit.rows} 个窗口`);
  console.log(`实际的常规时段方差 ÷ 开盘时隐含的一天方差 = ${model.realized_to_implied}`);

  console.log("\n日内方差分布(每半小时占全天的份额 / 这一桶开始时还剩几成)");
  model.variance_weights.forEach((w, i) => {
    const minute = OPEN_MINUTE + i * 30;
    const at = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
    console.log(`  ${at}  ${pct(w).padStart(6)}  ${pct(remainingShare(model.variance_weights, minute)).padStart(6)}`);
  });

  console.log("\nIV 对走势的反应:ln(乘数) = a + b·u + c·u²(u = 走了全天标准差的几倍,跌为负)");
  console.log(`  1 天期  a=${model.response.a}  b=${model.response.b}  c=${model.response.c}`);
  if (model.response_long) {
    console.log(`  ${model.response_long.days} 天期  a=${model.response_long.a}  b=${model.response_long.b}  c=${model.response_long.c}`);
  }
  console.log("  u      IV 乘数");
  for (const u of [-3, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 3]) {
    console.log(`  ${String(u).padStart(4)}   ×${Math.exp(predict(model.response, u)).toFixed(3)}`);
  }
  console.log(`\n拟合:样本内 R² ${model.fit.r2_in};样本外 R² ${model.fit.r2_out}(${model.fit.test.from} → ${model.fit.test.to},${model.fit.test.days} 天),同一段上"IV 不变"是 ${model.fit.r2_out_flat}`);
  console.log(`残差:sd ≈ ${model.resid_k} × √(这一段占全天方差的份额) × (${model.resid_move.base} + ${model.resid_move.slope}·|u|);"半数情况下"的区间在样本里盖住了 ${pct(model.fit.coverage_half)}`);

  // 分段看稳不稳:系数在哪一段都差不多,才谈得上"校准"
  console.log("\n分三段各自拟合(系数稳不稳)");
  const dates = [...new Set(ivHourly.map((b) => dayOf(b.sec)))].filter((d) => d >= model.period.from && d <= model.period.to).sort();
  for (let k = 0; k < 3; k += 1) {
    const from = dates[Math.floor((dates.length * k) / 3)], to = dates[Math.min(dates.length - 1, Math.floor((dates.length * (k + 1)) / 3))];
    const within = (bars) => bars.filter((b) => { const d = dayOf(b.sec); return d >= from && d <= to; });
    try {
      // 5 分钟线只有最近 60 天:半小时怎么分沿用全样本的,这里只看小时份额与反应系数
      const part = calibrate({
        ...base, priceHourly: within(priceHourly), ivHourly: within(ivHourly), ivLongHourly: within(ivLongHourly),
        fineShares: model.variance_weights,
      });
      const hours = [];
      for (let h = 0; h < 6; h += 1) hours.push(part.variance_weights[2 * h] + part.variance_weights[2 * h + 1]);
      hours.push(part.variance_weights[12]);
      console.log(`  ${from} → ${to}(${part.days} 天)  b=${part.response.b}  c=${part.response.c}  小时份额 ${hours.map(pct).join(" ")}`);
    } catch (err) {
      console.log(`  ${from} → ${to}:${err.message}`);
    }
  }

  // ---- 自己攒的当日到期期权 IV ----
  const dir = samplesDir();
  if (dir === null) {
    console.log("\n没有给 --samples:只按指数校准。软件自己攒的期权 IV 在交易库旁边的 fly-iv/ 目录里,攒够了加 --samples auto。");
  } else {
    const { files, samples } = loadSamples(dir);
    console.log(`\n自己攒的当日到期期权 IV:${dir},${files} 天的文件,${samples.length} 笔`);
    try {
      const own = fitFromSamples(samples, model);
      console.log(`  样本:${own.period.from} → ${own.period.to},${own.days} 天,${own.rows} 个窗口`);
      console.log(`  反应:a=${own.response.a}  b=${own.response.b}  c=${own.response.c}(指数那一份:b=${model.response.b}  c=${model.response.c})`);
      console.log(`  IV 自己的日内走法(10:00 起每半小时):${own.drift.map((v) => v.toFixed(3)).join(" ")}`);
      console.log(`  留出的那一段上:自己这一份 R² ${own.fit.r2_out},指数那一份 R² ${own.fit.r2_out_index};区间盖住了 ${pct(own.fit.coverage_half)}`);
      if (ownIsBetter(own)) {
        model.own = own;
        console.log("  → 自己这一份更强:当日到期的蝶用它。");
      } else {
        console.log("  → 自己这一份不比指数那一份强:不换,接着用指数那一份。");
      }
    } catch (err) {
      console.log(`  还用不上:${err.message}(至少要 ${OWN_MIN_DAYS} 天)`);
    }
  }

  if (has("write")) {
    const target = path.join(ENGINE_DIR, "src", "flyIvModel.ts");
    const body =
      "/** 蝴蝶测算的 IV 模型:拿历史数据校准出来的参数。\n" +
      " *\n" +
      " * **由 scripts/calibrate-fly-iv.mjs 生成,不要手改。** 要改就重新校准:\n" +
      " *   npm run build && npm run calibrate:fly -- --fetch --write\n" +
      " * 口径、检验与局限见 docs/features/fly-plan.md「校准」。\n" +
      " */\n" +
      "import type { FlyIvModel } from \"./flyCalibration.js\";\n\n" +
      `export const FLY_IV_MODEL: FlyIvModel = ${JSON.stringify(model, null, 2)};\n`;
    fs.writeFileSync(target, body);
    console.log(`\n已写入 ${target}。接着跑:npm run build && npx vitest run fly-`);
    console.log("止盈策略用的也是这份日内分布(flyexit.VARIANCE_WEIGHTS):golden-flyexit 会红,核对过再 npm run golden:update -- golden-flyexit");
  } else {
    console.log("\n没有写任何文件(要写进 src/flyIvModel.ts 加 --write)。");
  }
}

main().catch((err) => {
  console.error(`校准没成功:${err.message}`);
  process.exit(1);
});
