'use strict';
// 给预览台的 mock-bridge.js 生成一份真实形状的 pa.analyze 返回值。
//
// 数据来源:黄金基线 engine-ts/baseline/golden/priceaction.json 里的 K 线,交给引擎的纯函数
// analyze() / htfSummary() / agreement() 算——和 rpc 组装 pa.analyze 结果的字段一模一样,只是 K 线
// 不来自券商。这样 K线 PA 页在预览台里画出来的就是引擎真会给的东西,而不是手编的样子货。
//
//   node tools/gen_pa_mock.js              # 改写 tools/mock-bridge.js 与 tools/mock-bridge-empty.js
//   node tools/gen_pa_mock.js --stress     # 另写 tools/mock-bridge-stress.js:极端样例
//   node tools/gen_pa_mock.js downtrend    # 换一个黄金用例(默认 uptrend)
//
// 需要 engine-ts 已编译(dist/):desktop 的 npm start 会自动编,或在 engine-ts 下 npm run build。
const fs = require('node:fs');
const path = require('node:path');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..', '..');
const GOLDEN = path.join(ROOT, 'engine-ts', 'baseline', 'golden');
const pa = require(path.join(ROOT, 'engine-ts', 'dist', 'src', 'priceaction.js'));

const args = process.argv.slice(2);
const stress = args.includes('--stress');
const names = args.filter((a) => !a.startsWith('--'));

// K 线序列被抽到 _bars.json 去重,golden 里只留 {"$bars": id}:读回时展开
const bars = JSON.parse(fs.readFileSync(path.join(GOLDEN, '_bars.json'), 'utf8'));
function resolve(value) {
  if (Array.isArray(value)) return value.map(resolve);
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 1 && typeof value.$bars === 'string') return structuredClone(bars[value.$bars]);
    return Object.fromEntries(keys.map((k) => [k, resolve(value[k])]));
  }
  return value;
}
const golden = resolve(JSON.parse(fs.readFileSync(path.join(GOLDEN, 'priceaction.json'), 'utf8')));
const wanted = names[0] || 'uptrend';
const testCase = golden.cases.find((c) => c.name === wanted);
if (!testCase) {
  console.error(`priceaction.json 里没有用例 ${wanted}`);
  process.exit(1);
}
const rows = testCase.rows;
const nowIso = String(testCase.now).replace(' ', 'T');
const nowMs = Date.parse(nowIso);
const symbol = 'NVDA';
const timeframe = testCase.timeframe;

/** n 根合成 1 根(高周期背景用);凑不满 n 根的尾巴丢掉。 */
function aggregate(source, n) {
  const out = [];
  for (let i = 0; i + n <= source.length; i += n) {
    const chunk = source.slice(i, i + n);
    out.push({
      time: chunk[0].time,
      open: chunk[0].open,
      high: Math.max(...chunk.map((r) => r.high)),
      low: Math.min(...chunk.map((r) => r.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((acc, r) => acc + r.volume, 0),
    });
  }
  return out;
}

const result = pa.analyze(rows, symbol, timeframe, undefined, nowMs, true);
const htfKey = pa.TIMEFRAMES[timeframe].htf;
let factor = Math.max(1, Math.floor(pa.TIMEFRAMES[htfKey].seconds / pa.TIMEFRAMES[timeframe].seconds));
// 黄金基线只有 160 根 5 分钟线,合成 1 小时只剩 13 根,不够 analyze 的 30 根门槛;
// 高周期在这里只是背景摘要,合成粒度放宽到"至少凑够 30 根"即可
factor = Math.max(1, Math.min(factor, Math.floor(rows.length / 30)));
const higher = pa.htfSummary(pa.analyze(aggregate(rows, factor), symbol, htfKey, undefined, nowMs, true));
result.htf = higher;
result.agreement = pa.agreement(result, higher);
result.cached = false;
result.rth = false;
result.fetched_at = nowIso;

if (stress) {
  // 极端样例:开盘第一根巨量(公开源常见)、5 个关键位挤在 0.3% 价格区间、FVG 与订单块重叠
  const last = result.last;
  const r4 = (x) => Math.round(x * 1e4) / 1e4;
  result.bars[0].volume = result.bars[0].volume * 40;
  result.levels = [-0.003, -0.0015, -0.0005, 0.0005, 0.0015, 0.003].map((k) => ({
    price: r4(last * (1 + k)),
    side: k > 0 ? 'resistance' : 'support',
    touches: 2,
    swings: 1,
    distance_pct: Math.round(k * 100 * 100) / 100,
  }));
  const t0 = result.bars[Math.floor(result.bars.length / 2)].time;
  result.fvgs = [
    { side: 'bull', top: r4(last * 0.995), bottom: r4(last * 0.99), time: t0, filled_pct: 0 },
    {
      side: 'bear', top: r4(last * 1.004), bottom: r4(last * 1.001),
      time: result.bars[result.bars.length - 20].time, filled_pct: 30,
    },
  ];
  result.order_block = { top: r4(last * 0.997), bottom: r4(last * 0.992), time: t0 };
}

const payload = JSON.stringify(result);
const target = path.join(HERE, stress ? 'mock-bridge-stress.js' : 'mock-bridge.js');
let src = fs.readFileSync(path.join(HERE, 'mock-bridge.js'), 'utf8');
const pattern = /paAnalyze:\s*async\s*\(\)\s*=>\s*\((\{\}|\{[\s\S]*?\})\),/;
if (!pattern.test(src)) {
  console.error('mock-bridge.js 里找不到 paAnalyze 定义');
  process.exit(1);
}
src = src.replace(pattern, () => 'paAnalyze: async () => (' + payload + '),');
fs.writeFileSync(target, src, 'utf8');

if (stress) {
  console.log('stress mock:', path.basename(target), '|', payload.length, 'chars');
  process.exit(0);
}
const emptyPath = path.join(HERE, 'mock-bridge-empty.js');
let esrc = fs.readFileSync(emptyPath, 'utf8');
const emptyPattern = /paAnalyze:\s*async\s*\(\)\s*=>\s*(\(\{\}\)|\{[^}]*\}),/;
if (!emptyPattern.test(esrc)) {
  console.error('mock-bridge-empty.js 里找不到 paAnalyze 定义');
  process.exit(1);
}
// 真实 RPC 未连券商时抛 -32015,不会返回空对象;空态 mock 也照抛
esrc = esrc.replace(
  emptyPattern,
  () => 'paAnalyze: async () => { throw new Error("实时 K 线需要 TWS:请先在「TWS 连接」面板连接引擎。"); },'
);
fs.writeFileSync(emptyPath, esrc, 'utf8');
console.log(
  'pa mock:', testCase.name, rows.length, 'bars →', path.basename(target), '/', path.basename(emptyPath),
  '|', payload.length, 'chars'
);
