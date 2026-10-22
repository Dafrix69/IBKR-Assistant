// 生成 follow.json:engine-ts 的 follow.ts(原模块现跑)。消息正文摘提及、分诊(频道 / 信任的人 / 像不像单子 / 新不新鲜)、
// 解析之后跟不跟(本地速记的真产出 + 拼坏的 payload,闸门与额度的各种组合)、相对中心在百位边上、引擎走完之后的下场、
// 对方写的价对着盘口、成交后建追踪的入参、等待中的追踪怎么核对、建好的追踪说成一句话。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_follow.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const F = await import(pathToFileURL(join(engine, 'dist/src/follow.js')).href);
const S = await import(pathToFileURL(join(engine, 'dist/src/shorthand.js')).href);
const C = await import(pathToFileURL(join(engine, 'dist/src/config.js')).href);

let seed = 0xf0110_1;
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
const run = (f) => { try { return { out: enc(f()) }; } catch (e) { return { error: `${e.constructor.name}: ${e.message}` }; } };
const hex = (s) => Buffer.from(s, 'utf16le').toString('hex');

const bodies = ['7520蝴蝶 15cm 2.5', '20蝴蝶 20CM', '3.6', '7770 7775 bear call -2 -2.5', '00 95 bull put 试下 -2', '7770 7775 -2', '蝴蝶先走一下', '止损了哦',
  '7520蝴蝶 15cm', '00蝴蝶 10cm 1.2', '95蝴蝶 10cm 1.2', '7520蝴蝶 15cm 2.5 3张', '7520蝴蝶 15cm 2.5 十张', '7700 7695 挂个-2试试 BULL PUT', '7520蝴蝶 15cm 理由:x',
  '7520蝴蝶 500cm 2', '7520蝴蝶 15cm 14.99', '7770 7775 bear call', 'QQQ 610蝴蝶 5cm 1', '7520蝴蝶　１５ｃｍ ２.５'];
const mentions = ['', '@everyone ', '@here ', '@Everyone ', '@everyoneX ', '<@123456> ', '<@!123> ', '<@&999> ', '<#42> ', '<@abc> ', '\ud83d ', ' @here '];
const texts = [];
for (const b of bodies) for (let k = 0; k < 4; k += 1) texts.push(pick(mentions) + b + (rnd() < 0.3 ? ' ' + pick(mentions) : '') + (rnd() < 0.1 ? '\ud800' : ''));
const out = { texts: [], triage: [], decide: [], center: [], worst: [], outcomes: [], leader: [], quotes: [], params: [], pending: [], verdicts: [], remainders: [], exits: [] };
for (const t of texts) out.texts.push({ t: hex(t), order: hex(F.orderText(t)), why: F.whyUnparsed(F.orderText(t)) });

const cfg = (over) => ({ enabled: false, channel_id: '111', author_ids: ['a1', 'local:Charlie'], accounts: [], max_age_seconds: 120, max_orders_per_day: 3, max_risk_usd: 300,
  local_inbox: false, local_channel: '', track_fly: false, track_exit_at: '', ...over });
const cfgs = [cfg({}), cfg({ enabled: true }), cfg({ local_inbox: true }), cfg({ channel_id: '' }), cfg({ max_age_seconds: 0 }), cfg({ max_risk_usd: 1000, enabled: true, max_orders_per_day: 0 })];
const now = Date.parse('2026-10-19T14:30:00Z');
for (let i = 0; i < 500; i += 1) {
  const c = pick(cfgs);
  const msg = { channel_id: pick(['111', 'local', '222', '']), author_id: pick(['a1', 'local:Charlie', 'b2', '']), content: pick(texts), sentAtMs: now - pick([0, 999, 1000, 120_000, 120_999, 121_000, -5000, 600_000]) };
  out.triage.push({ c: cfgs.indexOf(c), msg: { ...msg, content: hex(msg.content) }, nowMs: now, out: F.triage(c, msg, now) });
}
const moment = C.etNowFromEpoch(now);
const snaps = [{ SPX: 7512.3, QQQ: 612.4 }, { SPX: 7550 }, { SPX: 7690 }, { SPX: 7712 }];
const payloads = [];
for (const b of bodies) for (const s of snaps) payloads.push({ p: S.tryParseShorthand(F.orderText(b), s, moment), spot: s.SPX });
payloads.push({ p: S.tryParseShorthand('7520蝴蝶 15cm 2', {}, C.etNowFromEpoch(Date.parse('2026-10-18T14:30:00Z'))), spot: 7500 });
const junk = [null, 5, 'x', [], {}, { orders: [] }, { orders: [{}] }, { orders: [{ contract: {}, order: {} }] }, { rejections: [{ message: '不行' }] }, { rejections: [{}] }, { rejections: ['x'] },
  { orders: [{ intent_summary: 's', contract: { combo_strategy: 'BUTTERFLY', legs: [{ strike: 1 }, { strike: 3 }, { strike: 5 }] }, order: { action: 'BUY', totalQuantity: '2', lmtPrice: '0.5' } }] },
  { orders: [{ contract: { combo_strategy: 'BUTTERFLY', legs: [{ strike: 1 }, 'x', { strike: 5 }] }, order: { action: 'BUY', totalQuantity: 1, lmtPrice: 1 } }] },
  { orders: [{ contract: { combo_strategy: 'VERTICAL', legs: [{ strike: 7775 }, { strike: 7770 }] }, order: { action: 'SELL', totalQuantity: 1, lmtPrice: 5 } }] },
  { orders: [{ contract: { combo_strategy: 'VERTICAL', legs: [{ strike: 7775 }, { strike: 7770 }] }, order: { action: 'SELL', totalQuantity: 0.5, lmtPrice: 2 } }] },
  { orders: [{ contract: { combo_strategy: 'BUTTERFLY', legs: [{ strike: 1 }, { strike: 3 }, { strike: 5 }] }, order: { action: 'BUY', totalQuantity: 3, lmtPrice: 1 } }], rejections: 5 },
  ...[0, -1, '0', 'x'].map((lmt) => ({ orders: [{ intent_summary: 'p', contract: { combo_strategy: 'BUTTERFLY', legs: [{ strike: 1 }, { strike: 3 }, { strike: 5 }] }, order: { action: 'BUY', totalQuantity: 1, lmtPrice: lmt } }] }))];
for (const j of junk) payloads.push({ p: j, spot: 7500 });
const gatesList = [{ breaker: null, autoExecute: true, connected: true }, { breaker: '连亏', autoExecute: true, connected: true }, { breaker: null, autoExecute: false, connected: true }, { breaker: null, autoExecute: true, connected: false }];
for (const { p, spot } of payloads) for (const c of [0, 1, 5]) for (const g of gatesList) for (const sent of [0, 2, 3]) {
  if (rnd() < 0.6) continue;
  out.decide.push({ p: enc(p), c, g, sent, out: F.decide(cfgs[c], p, g, sent) });
}
for (const { p, spot } of payloads) for (const s of [spot, spot - 49.99, 7650, 7749.5, NaN, 7600]) out.center.push({ p: enc(p), spot: enc(s), out: enc(F.relativeCenterProblem(p, s)) });
for (const [q, pr, w] of [[10, 0.3, 5], [1, null, 15], [3, 1.005, 10], [7, 0.15, 5]]) out.worst.push({ q, pr, w, out: F.worstCaseUsd({ quantity: q, premium: pr, wing: w }) });
for (const [q, c, w] of [[10, 2.7, 5], [1, 6, 5], [3, 0.1, 0.3]]) out.worst.push({ q, c, w, credit: F.creditWorstCaseUsd({ quantity: q, credit: c, width: w }) });
const results = [
  { submitted: [{ account: '模拟', record_id: 'r1' }], queued: [], validated_only: [], rejections: [], warnings: [] },
  { submitted: [{ account: '模拟', record_id: 'r1' }], queued: [{ account: '主', record_id: 'r2' }], validated_only: [{ record_id: 'v' }], rejections: [{ message: '超限' }], warnings: [] },
  { submitted: [], queued: [], validated_only: [{ record_id: 'v1' }, { record_id: 'v2' }], rejections: [], warnings: ['w'] },
  { submitted: [], queued: [], validated_only: [], rejections: [{ message: '拒', record_id: 'x1' }, { message: '拒2', record_id: 5 }], warnings: [] },
  { submitted: [], queued: [], validated_only: [], rejections: [], warnings: ['只有提醒'] },
  { submitted: [], queued: [], validated_only: [], rejections: [], warnings: [] },
];
for (const r of results) out.outcomes.push({ r, out: F.outcomeOf(r) });
for (const strat of ['BUTTERFLY', 'VERTICAL', 'IRON', undefined]) for (const action of ['BUY', 'SELL']) for (const lmt of [2.5, '2', 0, -1, null, undefined, 'x']) {
  const order = { action, lmtPrice: lmt };
  out.leader.push({ contract: enc({ combo_strategy: strat }), order: enc(order), out: enc(F.leaderPrice({ combo_strategy: strat }, order)) });
}
for (const side of ['debit', 'credit']) for (const mid of [2.4, -2.4, 0, NaN]) for (const nat of [2.6, -2.2, NaN, 0]) for (const lag of [0, 1499, 1500, -3000, NaN]) {
  out.quotes.push({ side, mid: enc(mid), nat: enc(nat), lag: enc(lag), out: enc(F.followQuote({ side, price: 2.5 }, { mid, natural: nat }, lag, side === 'credit')) });
}
for (const ex of ['', ' 15:45 ', '15:45']) out.params.push({ key: 'k|SPX|BAG', ex, out: F.flyTrackParams('k|SPX|BAG', ex) });
const raws = [null, {}, 'x', [1, null, { record_id: 'r', account: 'a', symbol: 'SPX', leg: '20261019|7500C', at_ms: 1 }, { record_id: 'r', account: 'a', symbol: 'SPX', leg: 'L', at_ms: '5', settled_fills: 2 },
  { record_id: 'r', account: '', symbol: 'SPX', leg: 'L', at_ms: 1 }, { record_id: 5, account: 'a', symbol: 'SPX', leg: 'L', at_ms: 1, summary: 3, message_id: 'm', settled_fills: -1 },
  { record_id: 'r', account: 'a', symbol: 'SPX', leg: 'L', at_ms: 'x' }, { record_id: 'r', account: 'a', symbol: 'SPX', leg: 'L', at_ms: 2, settled_fills: NaN, extra: 1 }]];
for (const r of raws) out.pending.push({ raw: enc(r), out: enc(F.pendingTracksOf(r)) });
const dayMs = (s) => Date.parse(s);
const legs = ['20261019|7500C', '20261020|7500C', '20261016|7500C', 'abc', '2026101', ''];
const ats = [dayMs('2026-10-19T14:00:00Z'), dayMs('2026-10-20T01:00:00Z'), dayMs('2026-10-19T03:59:00Z')];
const nows = [dayMs('2026-10-19T20:00:00Z'), dayMs('2026-10-20T15:00:00Z'), dayMs('2026-10-21T15:00:00Z'), dayMs('2026-10-20T03:59:59Z')];
for (const leg of legs) for (const at of ats) {
  out.verdicts.push({ leg, at, last: F.pendingLastDay({ leg, at_ms: at }) });
  for (const nowMs of nows) for (let k = 0; k < 6; k += 1) {
    const facts = { nowMs, filled: rnd() < 0.6, final: rnd() < 0.5, held: pick([true, false, null]), track: pick(['none', 'active', 'idle']), misses: pick([0, 4, 5, 9]) };
    out.verdicts.push({ leg, at, facts, out: F.pendingVerdict({ leg, at_ms: at }, facts) });
    const settled = pick([undefined, 0, 2]);
    const rf = { nowMs, final: facts.final, fills: pick([0, 2, 3]), track: facts.track };
    out.remainders.push({ leg, at, settled: enc(settled), rf, out: F.remainderVerdict({ leg, at_ms: at, settled_fills: settled }, rf) });
  }
}
const tracks = [
  { targets: { profit_drawdown_tiers: [{ above: 0, pct: 40 }, { above: 1, pct: 30 }], profit_drawdown_arm: 0.333333, profit_drawdown_late: { after: '15:00', factor: 0.5 }, exit_at: '15:45', exit_at_ms: dayMs('2026-10-19T19:45:00Z') }, auto_close: { enabled: true } },
  { targets: { profit_drawdown_tiers: [], exit_at: '15:45', exit_at_ms: dayMs('2026-10-20T19:45:00Z') }, auto_close: { enabled: false } },
  { targets: { profit_drawdown_tiers: [{ pct: '30' }], profit_drawdown_arm: 'x', profit_drawdown_late: null }, auto_close: { enabled: 1 } },
  { targets: { exit_at: '', exit_at_ms: NaN }, auto_close: {} },
  { targets: {}, auto_close: { enabled: true } },
  { targets: { profit_drawdown_tiers: 'ab' }, auto_close: { enabled: true } },
  { targets: { exit_at: '09:30', exit_at_ms: 'x' }, auto_close: { enabled: true } },
  { auto_close: { enabled: true } },
  { targets: {} },
];
for (const t of tracks) out.exits.push({ track: enc(t), nowMs: now, ...run(() => F.trackExitsText(t, now)) });

writeFileSync(join(here, 'follow.json'), JSON.stringify({ runtime: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`, cfgs, ...out }) + '\n');
console.log('follow.json', Object.entries(out).map(([k, v]) => `${k}=${v.length}`).join(' '));
