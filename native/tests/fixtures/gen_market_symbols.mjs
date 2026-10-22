// 生成 market-symbols.json:engine-ts 的 market.ts(原模块现跑)。黄金基线 market.json 的配置与 12 句指令,加上随机拼的句子
// (大小写、紧贴中文 / 数字、型号、停用词、长单词、别名、常驻指数、ß 这类变长的大写)在几份配置上的抽取;按标的拉现价(缓存里有的、
// 抛错的、0 / NaN / null、Object.prototype 上的名字、像下标的代码)。(行情页那份 market.json 是界面的,不是这个。)
//   ELECTRON_RUN_AS_NODE=1 …/Electron native/tests/fixtures/gen_market_symbols.mjs <编过的 engine-ts 目录>
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const M = await import(pathToFileURL(join(engine, 'dist/src/market.js')).href);
const C = await import(pathToFileURL(join(engine, 'dist/src/config.js')).href);

let seed = 0x5e7b_011c;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const enc = (o) => JSON.parse(JSON.stringify(o === undefined ? '__undefined__' : o, (k, v) => {
  if (v === undefined) return '__undefined__';
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return '__NaN__';
    if (v === Infinity) return '__Inf__';
    if (v === -Infinity) return '__-Inf__';
    if (Object.is(v, -0)) return '__neg0__';
  }
  return v;
}));

const golden = JSON.parse(readFileSync(join(engine, 'baseline/golden/market.json'), 'utf8'));
const base = golden.base_config;
const configs = [
  base,
  { ...base, symbol_aliases: { ...(base.symbol_aliases ?? {}), 苹果: 'aapl', 英伟达: 'NVDA', 台积电: 'TSM', 果: 'X', 特斯拉汽车: 'TSLA', 'Berkshire B': 'BRK B', 某某: 'A', '': 'EMPTY' } },
  { ...base, index_symbols: {} },
  { ...base, symbol_aliases: {}, index_symbols: { NDX: (base.index_symbols ?? {}).SPX ?? {}, RUT: (base.index_symbols ?? {}).SPX ?? {} } },
];
const settings = configs.map((c) => C.fromDict(structuredClone(c)));
const out = { configs, cases: [], snapshots: [] };

const words = ['AAPL', 'aapl', 'Aapl', '买入', '卖出', '100股', '10股', 'GB300', 'RTX5090', 'H200', 'H20', '25cm', 'CM', 'cm', 'SPX', 'spx', 'Spx', 'BUY', 'buy', 'call', 'PUT',
  '苹果', '特斯拉', '英伟达', '台积电', 'NVDA', 'Nvda', 'ABCDEFG', 'ABCDEF', 'AB1', 'QQQ', 'NDX', 'rut', 'X', 'IT', 'AI', 'ß', 'straße', 'BRK.B', 'été', '蝴蝶', '15', 'limit', 'LMT', 'TSLA',
  'iPhone', 'GOOGL', 'GOOGLE', 'Berkshire B', 'ON', 'on', 'A', '期权', 'ETF', 'etf', '〇', '鿿', '一'];
const seps = [' ', '', '', ',', '。', '、', '\n', '/', '-', '3', '中'];
for (const c of golden.cases) for (const [si] of settings.entries()) out.cases.push({ text: c.text, s: si });
for (let i = 0; i < 700; i += 1) {
  let text = '';
  for (let n = 1 + Math.floor(rnd() * 6); n > 0; n -= 1) text += pick(words) + pick(seps);
  out.cases.push({ text, s: Math.floor(rnd() * settings.length) });
}
for (const t of ['', ' ', 'nothing here', '苹果', 'GB300 出货节奏', '买AAPL100股', 'AAPL1000', '25cm蝴蝶', 'SPX 7400 call', 'spx!', 'abcdefghij', 'ABCDE FGHIJ', 'AAPLX', 'X苹果X']) {
  for (const [si] of settings.entries()) out.cases.push({ text: t, s: si });
}
const extras = [undefined, null, [], ['QQQ'], ['qqq', 'AAPL', ''], ['spx']];
for (const c of out.cases) {
  const s = settings[c.s];
  const extra = pick(extras);
  c.extra = enc(extra);
  c.default = M.extractSymbols(c.text, s, extra);
  c.no_default = M.extractSymbols(c.text, s, extra, false);
}

// ---------------------------------------------------------------- 快照
const prices = { AAPL: 229.4, SPX: 7462.35, FAIL: '__throw__', NONE: null, ZERO: 0, NAN: '__NaN__', NEG: -3, 123: 5, 0: 1, constructor: 9, toString: 2, __proto__: 4, QQQ: 520.1 };
const lookup = (s) => {
  if (!Object.prototype.hasOwnProperty.call(prices, s)) return undefined;
  const v = prices[s];
  if (v === '__throw__') throw new Error('boom');
  if (v === '__NaN__') return NaN;
  return v;
};
const cachedPool = [undefined, null, {}, { NONE: 12.5 }, JSON.parse('{"NONE": 12.5, "123": "7", "constructor": 3, "__proto__": 5, "AAPL": null}'), { AAPL: 'abc', QQQ: '1e2', ZERO: 0 }, { valueOf: 1 }];
const symPool = ['AAPL', 'SPX', 'FAIL', 'NONE', 'ZERO', 'NAN', 'NEG', '123', '0', 'constructor', 'toString', '__proto__', 'hasOwnProperty', 'QQQ', 'MISSING', 'valueOf'];
out.prices = prices;
out.snapshots.push({ symbols: ['AAPL', 'SPX', 'FAIL', 'NONE'], cached: { NONE: 12.5 }, out: enc(M.buildSnapshot(['AAPL', 'SPX', 'FAIL', 'NONE'], lookup, { NONE: 12.5 })) });
for (let i = 0; i < 200; i += 1) {
  const symbols = [...new Set(Array.from({ length: Math.floor(rnd() * 7) }, () => pick(symPool)))];
  const cached = pick(cachedPool);
  out.snapshots.push({ symbols, cached: enc(cached), out: enc(M.buildSnapshot(symbols, lookup, cached)) });
}

writeFileSync(join(here, 'market-symbols.json'), JSON.stringify({ runtime: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`, ...out }) + '\n');
console.log('market-symbols.json', Object.entries(out).map(([k, v]) => `${k}=${v.length}`).join(' '));
