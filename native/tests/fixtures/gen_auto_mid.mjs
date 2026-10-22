// 生成 auto_mid.json:engine-ts 的 autoMid.ts(原模块现跑)与它用的 broker.ts 那一小段纯定价(legMid / comboMidPrice / alignTickUp / alignTickDown)。
// 腿报价、份额、结构宽度、跳动取常见值与各种坏值(NaN、Infinity、0、负数、倒挂),随机组合(固定种子);答案是 {out} 或 {error:"类名: 话"}。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_auto_mid.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dec, enc, rng } from './execsupport_world.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const A = await import(pathToFileURL(join(engine, 'dist/src/autoMid.js')).href);
const B = await import(pathToFileURL(join(engine, 'dist/src/broker.js')).href);

const run = (f) => { try { return { out: enc(f()) }; } catch (e) { return { error: `${e.constructor.name}: ${e.message}` }; } };
const r = rng(0xa070_31d0);

const bids = [3.9, 1.9, 0.5, 2.9, 0.9, 0.05, 0.1, 0.15, 12.35, 7.5, 0, -1, NaN, Infinity, -Infinity, 1e-9, 1000.25];
const asks = [4.1, 2.1, 0.7, 3.1, 1.1, 0.3, 0.2, 0.15, 12.45, 7.55, 0, NaN, Infinity, 0.01, 1000.35];
const legQuote = () => {
  const bid = r.pick(bids);
  const widen = r.pick([0, 0.05, 0.2, 0.01, 0.4, -0.5]);
  const ask = r.chance(0.6) && Number.isFinite(bid) ? Math.round((bid + Math.abs(widen)) * 10000) / 10000 : r.pick(asks);
  return { action: r.pick(['BUY', 'SELL', 'BUY', 'SELL', 'HOLD', '']), ratio: r.pick([1, 1, 1, 2, 0.5, 3, 0, -1, NaN]), bid, ask };
};
const FLY = [{ action: 'BUY', ratio: 1, bid: 3.9, ask: 4.1 }, { action: 'SELL', ratio: 2, bid: 1.9, ask: 2.1 }, { action: 'BUY', ratio: 1, bid: 0.5, ask: 0.7 }];
const CREDIT = [{ action: 'SELL', ratio: 1, bid: 2.9, ask: 3.1 }, { action: 'BUY', ratio: 1, bid: 0.9, ask: 1.1 }];
const legLists = () => {
  const p = r.next();
  if (p < 0.12) return FLY.map((l) => ({ ...l }));
  if (p < 0.24) return CREDIT.map((l) => ({ ...l }));
  if (p < 0.27) return [];
  return Array.from({ length: 1 + r.int(4) }, legQuote);
};
const plausibleLegs4 = () => {
  const n = 2 + r.int(3);
  const first = r.pick(['BUY', 'SELL']);
  return Array.from({ length: n }, (_, i) => {
    const bid = Math.round((0.05 + r.next() * 14) * 10000) / 10000;
    return { action: i % 2 === 0 ? first : (first === 'BUY' ? 'SELL' : 'BUY'), ratio: r.pick([1, 1, 2]), bid, ask: Math.round((bid + 0.0001 * (1 + r.int(900))) * 10000) / 10000 };
  });
};
const plausibleLegs = () => {
  const n = 2 + r.int(3);
  const first = r.pick(['BUY', 'SELL']);
  return Array.from({ length: n }, (_, i) => {
    const bid = Math.round((0.05 + r.next() * 14) * 20) / 20;
    return { action: i % 2 === 0 ? first : (first === 'BUY' ? 'SELL' : 'BUY'), ratio: r.pick([1, 1, 2]), bid, ask: Math.round((bid + 0.05 * (1 + r.int(6))) * 100) / 100 };
  });
};
const shares = [0, 1, 0.5, 0.3, 0.25, 0.1, 0.75, 0.0001, 1.0000001, -0.1, 1.2, NaN, Infinity, -0, 0.333333, 0.9999999];
const widths = [null, null, null, 0.9, 1, 5, 2.5, 0.04, 0, -1, NaN, Infinity, 100];
const ticks = [undefined, undefined, undefined, 0.0001, 0.00001, 0.05, 0.01, 0.25, 0.1, 0, -0.05, NaN, Infinity, 1];

const out = { natural: [], share: [], mid: [], legMid: [], align: [] };
for (const legs of [FLY, CREDIT]) out.natural.push({ legs: enc(legs), ...run(() => A.comboNaturalPrice(legs)) });
for (let i = 0; i < 700; i += 1) {
  const legs = r.chance(0.3) ? plausibleLegs4() : legLists();
  out.natural.push({ legs: enc(legs), ...run(() => A.comboNaturalPrice(legs)) });
  out.mid.push({ legs: enc(legs), ...run(() => B.comboMidPrice(legs)) });
}
for (let i = 0; i < 2600; i += 1) {
  const legs = r.chance(0.25) ? plausibleLegs4() : r.chance(0.5) ? plausibleLegs() : (r.chance(0.35) ? r.pick([FLY, CREDIT]).map((l) => ({ ...l })) : legLists());
  const action = r.pick(['BUY', 'SELL', 'BUY', 'SELL', 'HOLD']);
  const share = r.chance(0.6) ? r.pick([0, 1, 0.5, 0.3, 0.25, 0.1, 0.75, 0.333333, 0.9]) : r.pick(shares);
  const width = r.pick(widths);
  const tick = r.pick(ticks);
  out.share.push({ legs: enc(legs), action, share: enc(share), width: enc(width), tick: enc(tick), ...run(() => A.autoMidShareLimit(legs, action, share, width, tick)) });
}
{
  const flat = [{ action: 'BUY', ratio: 1, bid: 1, ask: 1.2 }, { action: 'SELL', ratio: 1, bid: 1, ask: 1.2 }];
  for (const action of ['BUY', 'SELL']) for (const share of [0, 0.5, 1]) {
    out.share.push({ legs: enc(flat), action, share: enc(share), width: enc(null), tick: enc(undefined), ...run(() => A.autoMidShareLimit(flat, action, share, null, undefined)) });
  }
}
for (let i = 0; i < 400; i += 1) {
  const leg = legQuote();
  out.legMid.push({ leg: enc(leg), ...run(() => B.legMid(leg)) });
}
const values = [0, 0.2, 0.15, 0.175, 0.1750000001, 1.9999999999, -0.35, 7.5, 4.0000000009, 0.05, 0.0499999999, 1e-12, 12345.678, -0, NaN, Infinity, -Infinity, 1e21, 0.30000000000000004, 3.9999999990000003];
const tickVals = [undefined, 0.0001, 0.00001, 0.00003, 0.05, 0.01, 0.25, 0.1, 0, -1, NaN, Infinity, 0.3, 1];
for (const value of values) for (const tick of tickVals) {
  out.align.push({ value: enc(value), tick: enc(tick), up: enc(B.alignTickUp(value, tick)), down: enc(B.alignTickDown(value, tick)) });
}
for (let i = 0; i < 400; i += 1) {
  const value = Math.round((r.next() * 20 - 5) * 100000) / 100000, tick = r.pick(tickVals);
  out.align.push({ value: enc(value), tick: enc(tick), up: enc(B.alignTickUp(value, tick)), down: enc(B.alignTickDown(value, tick)) });
}
const text = JSON.stringify(out);
writeFileSync(join(here, 'auto_mid.json'), text);
console.log(`auto_mid.json:${(text.length / 1024).toFixed(0)} KB`);
