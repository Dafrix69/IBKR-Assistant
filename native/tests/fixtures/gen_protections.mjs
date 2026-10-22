// 生成 protections.json:engine-ts/src/protections.ts(原模块现跑)在随机的配置、平仓序列、已实现盈亏序列、券商报的账户当日盈亏上的
// evaluateProtections / protectionBlock / protectionsSummary / protectionsSince,外加 etDayStart(含 DST 那几天)与 isStopLike。
//   node native/tests/fixtures/gen_protections.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const pr = await import(pathToFileURL(join(engine, 'dist/src/protections.js')).href);

let seed = 0x7f4a7c15;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const symbols = ['SPX', 'NVDA', 'AAPL', 'TSLA', ''];
const states = ['stop_loss', 'profit_trail', 'take_profit', 'sweep:stop_loss', 'sweep:take_profit', 'time_exit'];
const legs = ['20261016|C7800/C7815/C7830', '20261016|P7700', '', undefined];
const accounts = ['模拟', '主账户', '富途模拟', 'IRA'];
const bases = [Date.UTC(2026, 9, 16, 14, 0), Date.UTC(2026, 2, 8, 6, 30), Date.UTC(2026, 10, 1, 5, 30), Date.UTC(2026, 9, 17, 3, 59), Date.UTC(2026, 9, 16, 3, 59)];
const scenarios = [];
for (let i = 0; i < 400; i++) {
  const cfg = {
    stoploss_guard: { enabled: rnd() < 0.6, lookback_minutes: pick([30, 60, 120, 0]), trigger_count: pick([1, 2, 3, 0]), pause_minutes: pick([15, 60, 90, 0]) },
    max_drawdown: { enabled: rnd() < 0.6, lookback_minutes: pick([60, 240, 1440]), max_drawdown_usd: pick([100, 500, 1000, 0]), pause_minutes: pick([30, 120]) },
    cooldown: { enabled: rnd() < 0.6, minutes: pick([5, 30, 0]), scope: pick(['symbol', 'position', 'symbol']) },
    daily_loss: { enabled: rnd() < 0.6, max_loss_usd: pick([200, 500, 1130.5, 0]), basis: pick(['realized', 'account']) },
  };
  const nowMs = pick(bases) + Math.floor(rnd() * 6) * 3600000;
  const closes = Array.from({ length: Math.floor(rnd() * 7) }, () => {
    const c = { atMs: nowMs - Math.floor(rnd() * 300) * 60000 + (rnd() < 0.1 ? 120000 : 0), symbol: pick(symbols), state: pick(states) };
    const leg = pick(legs);
    if (leg !== undefined) c.leg = leg;
    return c;
  });
  const pnl = Array.from({ length: Math.floor(rnd() * 9) }, () => ({ atMs: nowMs - Math.floor(rnd() * 1500) * 60000, pnl: Math.round((rnd() - 0.6) * 80000) / 100 }));
  if (rnd() < 0.1) pnl.push({ atMs: nowMs - 60000, pnl: NaN });
  const accountDaily = rnd() < 0.5 ? null : Object.fromEntries(accounts.filter(() => rnd() < 0.6).map((a) => [a, rnd() < 0.1 ? NaN : Math.round((rnd() - 0.7) * 200000) / 100]));
  const expected = accounts.filter(() => rnd() < 0.5);
  record(cfg, nowMs, closes, pnl, accountDaily, expected);
}
// 正好等于上限的那几格(亏到上限 = 暂停):券商报的账户盈亏与已实现盈亏各一份
const off = { enabled: false, lookback_minutes: 60, trigger_count: 1, pause_minutes: 15 };
const offDd = { enabled: false, lookback_minutes: 60, max_drawdown_usd: 100, pause_minutes: 30 };
const offCool = { enabled: false, minutes: 5, scope: 'symbol' };
for (const basis of ['account', 'realized']) {
  const cfg = { stoploss_guard: off, max_drawdown: offDd, cooldown: offCool, daily_loss: { enabled: true, max_loss_usd: 500, basis } };
  const nowMs = bases[0];
  record(cfg, nowMs, [], [{ atMs: nowMs - 60000, pnl: -300 }, { atMs: nowMs - 120000, pnl: -200 }], { 模拟: -500, 主账户: -499.99, IRA: -500.01 }, ['模拟', '主账户', 'IRA']);
  record(cfg, nowMs, [], [{ atMs: nowMs - 60000, pnl: -300 }, { atMs: nowMs - 120000, pnl: -199.99 }], null, []);
}
function record(cfg, nowMs, closes, pnl, accountDaily, expected) {
  const state = pr.evaluateProtections(cfg, closes, pnl, nowMs, accountDaily, expected);
  const blocks = [];
  for (const sym of ['SPX', 'NVDA', 'AAPL', '']) for (const acc of [undefined, '模拟', '主账户']) for (const leg of [undefined, '20261016|P7700']) {
    for (const dt of [0, 30 * 60000]) {
      const order = {};
      if (acc !== undefined) order.account = acc;
      if (leg !== undefined) order.leg = leg;
      blocks.push({ sym, acc: acc ?? null, leg: leg ?? null, dt, out: pr.protectionBlock(state, sym, nowMs + dt, order) });
    }
  }
  const enc = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'number' && Number.isNaN(v) ? 'NaN' : v)));
  scenarios.push({
    cfg, nowMs, closes, pnl: enc(pnl), accountDaily: accountDaily === null ? null : Object.entries(accountDaily).map(([k, v]) => [k, Number.isNaN(v) ? 'NaN' : v]), expected,
    state: { pause: state.pause, cooldowns: Object.entries(state.cooldowns), accountPauses: Object.entries(state.accountPauses) },
    blocks, summary: pr.protectionsSummary(state, nowMs), summaryLater: pr.protectionsSummary(state, nowMs + 45 * 60000),
    since: pr.protectionsSince(cfg, nowMs), enabled: pr.protectionsEnabled(cfg), needsPnl: pr.needsPnlEvents(cfg),
  });
}
const dayStarts = [];
for (const b of [...bases, Date.UTC(2026, 2, 8, 7, 30), Date.UTC(2026, 2, 9, 3, 30), Date.UTC(2026, 10, 2, 4, 30), Date.UTC(2026, 10, 2, 5, 30)])
  for (const off of [0, 1, -1]) dayStarts.push({ nowMs: b, off, out: pr.etDayStart(b, off) });
const stopLike = states.concat(['a:b:stop_loss', 'stop_loss:', '']).map((s) => ({ s, out: pr.isStopLike(s) }));
writeFileSync(join(here, 'protections.json'), JSON.stringify({ generator: 'native/tests/fixtures/gen_protections.mjs', scenarios, dayStarts, stopLike }, null, 1) + '\n');
console.log(`protections.json:${scenarios.length} 个场景`);
