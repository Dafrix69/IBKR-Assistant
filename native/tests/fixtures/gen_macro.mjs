// 生成 macro.json:engine-ts 的 macro.ts(原模块现跑)。一串一串的操作(行情带、公开源指数价、公开源报价、改路由、放行挂着的请求),
// 每一步记回包与这一步里取数器被叫了哪几次(url 与时限):缓存的 TTL、陈旧即返与后台刷新、单飞、主源挂了由 Cboe 兜回、TNX 的 10 倍口径、
// TWS 流式那一路(串的价、缺价、router 抛错或回 null)、取回来的格子被行情带改过之后从缓存里摊出来的键序。
// 取数器是假的:按 url 查路由表,给 JSON、抛错,或挂着等后面那一步放行。另有 defaultFetcher 对回包的判断(假的 fetch 回 Response)。
//   ELECTRON_RUN_AS_NODE=1 …/Electron native/tests/fixtures/gen_macro.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const M = await import(pathToFileURL(join(engine, 'dist/src/macro.js')).href);

let seed = 0x3ac2_0777;
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
const sortKeys = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
const flush = () => new Promise((r) => setImmediate(r));

let clock = 1_760_000_000;
Date.now = () => clock * 1000;

const yahoo = (key) => `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(key)}?interval=1d&range=5d`;
const cboe = (sym) => `https://cdn.cboe.com/api/global/delayed_quotes/quotes/_${sym}.json`;
const KEYS = ['^GSPC', '^NDX', '^VIX', '^TNX', 'GC=F', 'BZ=F', 'BTC-USD'];
const CBOE = ['SPX', 'NDX', 'VIX', 'TNX', 'RUT'];
const EXTRA = ['EWY', 'KORU', '^RUT', '^DJI', 'FXI', 'a b/c?', '中文', 'constructor'];

async function runScenario(name, ops) {
  M.clearMacroCache();
  const routes = {};
  const pend = {};
  const log = [];
  const waiting = [];
  const fetcher = (url, t) => {
    log.push([url, t]);
    const r = routes[url];
    if (!r) return Promise.reject(new Error(`no route ${url}`));
    if (r.throw !== undefined) return Promise.reject(new Error(r.throw));
    if (r.pending !== undefined) {
      // 挂着的路由只挡一次(之后换成 then):一次放行只接着跑一串,两边的先后才一样(见 tst_macro 开头)
      if (r.then) routes[url] = r.then; else delete routes[url];
      return new Promise((res, rej) => { (pend[r.pending] ??= []).push({ res, rej }); });
    }
    return Promise.resolve(structuredClone(r.json));
  };
  const steps = [];
  for (const [i, op] of ops.entries()) {
    if (op.now !== undefined) clock = op.now;
    let entry = null;
    if (op.op === 'route') {
      for (const [url, r] of Object.entries(op.set)) { if (r === null) delete routes[url]; else routes[url] = r; }
    } else if (op.op === 'resolve') {
      for (const w of pend[op.id] ?? []) { if (op.throw !== undefined) w.rej(new Error(op.throw)); else w.res(structuredClone(op.json)); }
      delete pend[op.id];
    } else {
      let p;
      if (op.op === 'board') {
        const router = op.router === undefined ? undefined : op.router === 'none' ? null : op.router === 'throw' ? { streamQuotes() { throw new Error('boom'); } }
          : op.router === 'null' ? { streamQuotes: () => null } : { streamQuotes: () => structuredClone(op.router) };
        p = M.macroBoard({ timeout: op.timeout, force: op.force, router, fetcher, now: () => clock });
      } else if (op.op === 'index') {
        p = M.publicIndexPrice(op.symbol, op.timeout, fetcher);
      } else if (op.op === 'quotes') {
        p = M.publicQuotes(op.symbols, op.timeout, fetcher).then(sortKeys);
      }
      entry = { i, done: false };
      p.then((v) => { entry.done = true; entry.out = enc(v); }, (e) => { entry.done = true; entry.error = `${e.constructor.name}: ${e.message}`; });
      waiting.push(entry);
    }
    await flush();
    // publicQuotes 是 Promise.all:各只的请求在 JS 里交替发出,C++ 一只取完再下一只——这一步的请求按字面排了再比(取回来的数各是各的键,不受先后影响)
    const step = { log: op.op === 'quotes' ? log.splice(0).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)) : log.splice(0) };
    const late = [];
    for (const w of [...waiting]) {
      if (!w.done) continue;
      waiting.splice(waiting.indexOf(w), 1);
      const r = w.error !== undefined ? { error: w.error } : { out: w.out };
      if (w === entry) Object.assign(step, r);
      else late.push({ op: w.i, ...r });
    }
    if (entry && !entry.done) step.pending = true;
    step.late = late;
    steps.push(step);
  }
  out.scenarios.push({ name, ops: enc(ops), steps });
}

const out = { scenarios: [], fetched: [] };

// ---------------------------------------------------------------- 回包的样子
const yahooPayloads = [
  { chart: { result: [{ meta: { regularMarketPrice: 7462.35, chartPreviousClose: 7400 } }] } },
  { chart: { result: [{ meta: { regularMarketPrice: 48.06, previousClose: 47.9 } }] } },
  { chart: { result: [{ meta: { regularMarketPrice: '101.5', chartPreviousClose: '100' } }] } },
  { chart: { result: [{ meta: { regularMarketPrice: 20, chartPreviousClose: 0, previousClose: 19 } }] } },
  { chart: { result: [{ meta: { regularMarketPrice: 20, chartPreviousClose: null, previousClose: 19 } }] } },
  { chart: { result: [{ meta: { regularMarketPrice: null } }] } }, { chart: { result: [] } }, { chart: { result: { 0: { meta: { regularMarketPrice: 3 } } } } },
  { chart: null }, null, 5, 'x', [], { chart: { result: [{ meta: { regularMarketPrice: 'abc', chartPreviousClose: 1 } }] } },
  { chart: { result: [{ meta: { regularMarketPrice: '', chartPreviousClose: 2 } }] } }, { chart: { result: [{ meta: { regularMarketPrice: true, chartPreviousClose: [4] } }] } },
];
const cboePayloads = [
  { data: { current_price: 7460.1, close: 7401.2, price_change: 58.9 } }, { data: { current_price: null, close: 48.1, price_change: -0.2 } },
  { data: { current_price: 18.2, close: 0, price_change: 1 } }, { data: { current_price: '19', close: '18', price_change: null } }, { data: {} }, { data: null },
  {}, null, { data: { current_price: 'n/a', close: 'n/a' } }, { data: 7 }, { data: { current_price: 0, close: 5, price_change: '' } },
];
let pendingIds = 0;
const respond = (payloads) => {
  const r = rnd();
  if (r < 0.15) return { throw: pick(['timeout', '', '数据源返回 HTTP 403 Forbidden', 'x'.repeat(130)]) };
  if (r < 0.22) return { pending: `p${(pendingIds += 1)}`, then: { json: pick(payloads) } };
  return null;
};
const randomRoutes = () => {
  const set = {};
  for (const k of [...KEYS, ...EXTRA]) set[yahoo(k)] = respond(yahooPayloads) ?? { json: pick(yahooPayloads) };
  for (const s of [...CBOE, 'undefined']) set[cboe(s)] = respond(cboePayloads) ?? { json: pick(cboePayloads) };
  return set;
};
const routerPool = [undefined, 'none', 'throw', 'null', {}, 'ab', 7,
  { 'IND:SPX@CBOE': { last: 7460, change_pct: 0.4 }, 'IND:TNX@CBOE': { last: 48.06, change_pct: -0.1 }, 'CRYPTO:BTC': { last: null } },
  { 'IND:TNX@CBOE': { last: '48.06' }, 'IND:VIX@CBOE': { last: '17' }, 'CONTFUT:GC@COMEX': 5, 'IND:NDX@NASDAQ': { last: 0, change_pct: null } },
  { 'CONTFUT:BZ@NYMEX': { last: 99.93, change_pct: 1.2 }, other: 1 }];

// ---------------------------------------------------------------- 写明的场景
const allGood = {};
for (const k of KEYS) allGood[yahoo(k)] = { json: yahooPayloads[0] };
for (const s of CBOE) allGood[cboe(s)] = { json: cboePayloads[0] };
const t0 = 1_760_000_000;
await runScenario('ttl-and-stale', [
  { op: 'route', set: allGood }, { op: 'board', now: t0 }, { op: 'board', now: t0 + 30 }, { op: 'board', now: t0 + 61 },
  { op: 'route', set: { [yahoo('^GSPC')]: { pending: 'g' } } }, { op: 'board', now: t0 + 200 }, { op: 'board', now: t0 + 201 },
  { op: 'resolve', id: 'g', json: yahooPayloads[1], now: t0 + 202 }, { op: 'board', now: t0 + 230 }, { op: 'board', now: t0 + 900 },
  { op: 'board', now: t0 + 905, force: true, timeout: 2 }, { op: 'route', set: { [yahoo('^VIX')]: { throw: 'down' }, [yahoo('GC=F')]: { throw: '' } } },
  { op: 'board', now: t0 + 2000 }, { op: 'board', now: t0 + 2001, force: true },
  { op: 'route', set: { [yahoo('^TNX')]: { throw: 'down' }, [cboe('TNX')]: { json: { data: { current_price: 48.06, close: 47.5, price_change: 0.56 } } } } },
  { op: 'board', now: t0 + 3000, force: true }, { op: 'board', now: t0 + 3005 }, { op: 'board', now: t0 + 3100 },
]);
await runScenario('exact-edges', [
  { op: 'route', set: allGood }, { op: 'board', now: t0 }, { op: 'board', now: t0 + 60 }, { op: 'board', now: t0 + 660 }, { op: 'board', now: t0 + 1270, force: true },
  { op: 'board', now: t0 + 1280, router: routerPool[7] }, { op: 'index', symbol: 'SPX', now: t0 + 2000 }, { op: 'index', symbol: 'SPX', now: t0 + 2030 },
  { op: 'index', symbol: 'SPX', now: t0 + 2630 },
]);
await runScenario('live-router', [
  { op: 'route', set: allGood }, { op: 'board', now: t0, router: routerPool[7] }, { op: 'board', now: t0 + 5, router: routerPool[8] },
  { op: 'board', now: t0 + 15, router: routerPool[9] }, { op: 'board', now: t0 + 20, router: 'throw' }, { op: 'board', now: t0 + 90, router: 'null' },
  { op: 'board', now: t0 + 100, router: 'ab' },
]);
await runScenario('index-price', [
  { op: 'route', set: allGood }, { op: 'index', symbol: 'spx', now: t0 }, { op: 'index', symbol: 'SPX', now: t0 + 10 },
  { op: 'route', set: { [cboe('SPX')]: { pending: 'c' } } }, { op: 'index', symbol: 'SPX', now: t0 + 40 }, { op: 'index', symbol: 'SPX', now: t0 + 41 },
  { op: 'resolve', id: 'c', json: { data: { current_price: 7470 } }, now: t0 + 42 }, { op: 'index', symbol: 'SPX', now: t0 + 50 },
  { op: 'route', set: { [cboe('SPX')]: { throw: 'x' } } }, { op: 'index', symbol: 'SPX', now: t0 + 1000 }, { op: 'index', symbol: 'SPX', now: t0 + 1001 },
  { op: 'route', set: { [cboe('RUT')]: { json: { data: {} } }, [yahoo('^RUT')]: { json: yahooPayloads[2] } } }, { op: 'index', symbol: 'rut', now: t0 + 1002 },
  { op: 'board', now: t0 + 1003 }, { op: 'index', symbol: 'DJI', now: t0 + 1004 }, { op: 'route', set: { [yahoo('^DJI')]: { json: yahooPayloads[0] } } },
  { op: 'index', symbol: 'dji', now: t0 + 1005 }, { op: 'index', symbol: 'DJI', now: t0 + 1010 }, { op: 'index', symbol: 'AAPL', now: t0 + 1011 },
  { op: 'index', symbol: '', now: t0 + 1012 }, { op: 'index', symbol: 'vix', timeout: 1.5, now: t0 + 1013 },
]);
await runScenario('quotes-share-cache', [
  { op: 'route', set: { ...allGood, [yahoo('EWY')]: { json: yahooPayloads[1] }, [yahoo('KORU')]: { throw: 'blocked' } } },
  { op: 'quotes', symbols: ['EWY', 'KORU', '^GSPC'], now: t0 }, { op: 'board', now: t0 + 1 }, { op: 'quotes', symbols: ['^GSPC', 'EWY'], now: t0 + 2 },
  { op: 'board', now: t0 + 70 }, { op: 'board', now: t0 + 71 }, { op: 'quotes', symbols: ['^VIX', 'KORU', 'constructor'], timeout: 2, now: t0 + 200 },
  { op: 'route', set: { [yahoo('constructor')]: { throw: 'nope' }, [cboe('undefined')]: { json: cboePayloads[0] } } },
  { op: 'quotes', symbols: ['constructor'], now: t0 + 300 }, { op: 'quotes', symbols: [], now: t0 + 301 },
]);
// ---------------------------------------------------------------- 随机的场景
for (let s = 0; s < 40; s += 1) {
  const ops = [{ op: 'route', set: randomRoutes() }];
  let t = t0 + Math.floor(rnd() * 1000);
  for (let k = 0; k < 18; k += 1) {
    t += pick([0, 1, 5, 11, 29, 31, 59, 61, 300, 599, 601, 2000]);
    const r = rnd();
    if (r < 0.45) ops.push({ op: 'board', now: t, force: rnd() < 0.15 ? true : undefined, router: pick(routerPool), timeout: pick([undefined, undefined, 3]) });
    else if (r < 0.65) ops.push({ op: 'index', now: t, symbol: pick(['SPX', 'spx', 'NDX', 'VIX', 'RUT', 'DJI', 'AAPL', 'tnx']), timeout: pick([undefined, 2]) });
    else if (r < 0.78) {
      const pool = [...EXTRA, ...KEYS];
      const syms = [...new Set(Array.from({ length: Math.floor(rnd() * 4) }, () => pick(pool)))];
      ops.push({ op: 'quotes', now: t, symbols: syms, timeout: pick([undefined, 2]) });
    } else if (r < 0.9) ops.push({ op: 'resolve', now: t, id: `p${1 + Math.floor(rnd() * pendingIds)}`, ...(rnd() < 0.3 ? { throw: 'late fail' } : { json: pick(rnd() < 0.5 ? yahooPayloads : cboePayloads) }) });
    else ops.push({ op: 'route', set: randomRoutes() });
  }
  for (let id = 1; id <= pendingIds; id += 1) ops.push({ op: 'resolve', id: `p${id}`, json: yahooPayloads[0] });
  await runScenario(`syn${s}`, ops);
}

// ---------------------------------------------------------------- defaultFetcher 对回包的判断
for (const [status, statusText, body] of [[200, 'OK', '{"a":1}'], [200, '', '[1,2]'], [403, 'Forbidden', '<html>'], [404, '', 'x'], [500, 'Internal Server Error', ''],
  [200, 'OK', '<!DOCTYPE html>\n<html>\n  <head>\t<title>Blocked</title></head>\r\n<body>Too many requests from your network — please wait</body></html>'],
  [200, 'OK', ''], [200, 'OK', '{"a":'], [299, 'X', '"s"'], [300, 'Multiple', '{}'], [200, 'OK', '﻿{"a":1}'], [200, 'OK', '   nope 　 x'],
  [204, '', ''], [201, 'Created', 'null'], [200, 'OK', 'NaN'], [200, 'OK', '1e999']]) {
  globalThis.fetch = async () => new Response(status === 204 ? null : body, { status, statusText });
  let r;
  try { r = { out: enc(await M.defaultFetcherForTest('https://example.invalid/x', 1000)) }; } catch (e) { r = { error: `${e.constructor.name}: ${e.message}` }; }
  out.fetched.push({ status, statusText, body: status === 204 ? '' : body, ok: status >= 200 && status < 300, ...r });
}
out.symbols = M.MACRO_SYMBOLS;
out.live = M.liveTickers();
out.cboeLast = [...cboePayloads, undefined, { data: { current_price: '', close: 3 } }].map((p) => ({ p: enc(p), out: enc(M.cboeLast(p)) }));

writeFileSync(join(here, 'macro.json'), JSON.stringify({ runtime: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`, ...out }) + '\n');
console.log('macro.json', Object.entries(out).map(([k, v]) => `${k}=${v.length}`).join(' '));
