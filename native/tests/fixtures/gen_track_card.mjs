// 生成 track-card.json:持仓追踪页「正在追踪」那张卡片(desktop/renderer-react/src/lib/TrackCard.tsx)在各种状态下写出来的字。
// 不手写期望值:用 vite 的 SSR 把原组件打包(ssr/build.mjs),对每个场景渲染成 HTML,按文档次序抽出每一段文字。
// C++ 的 shell/track_card 的模型要按同样的次序说出同样的话(价位条是浏览器里才画的 SVG,SSR 里是空的,两边都不比它)。
//   node native/tests/fixtures/gen_track_card.mjs <装好依赖的 desktop 目录,如 /tmp/claude-501/ibkr-qtref/desktop>
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = process.argv[2];
if (!desktop) throw new Error('要给装好依赖的 desktop 目录');
const out = mkdtempSync(join(tmpdir(), 'ssr-'));
execFileSync(process.execPath, [join(here, 'ssr/build.mjs'), desktop, out], { stdio: 'inherit' });

// 「计算中」:重算挂起不回;每个场景开始前把上一场挂着的放掉,busy 才不会漏进下一场
const pending = [];
const hold = () => new Promise((resolve) => pending.push(resolve));
globalThis.window = {
  dafri: new Proxy({}, { get: (_t, name) => (name === 'listAlerts' ? async () => ({ watches: window.__watches || [] }) : name === 'status' ? async () => window.__status : name === 'refreshAlert' ? hold : async () => ({})) }),
  localStorage: { getItem: () => null, setItem() {} },
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};
globalThis.localStorage = window.localStorage;
const ui = await import(pathToFileURL(join(out, 'entry.mjs')).href);

/** HTML → 按文档次序的每一段字(去掉标签,空白收拢,空段丢掉) */
const texts = (html) => html
  .replace(/<title>[\s\S]*?<\/title>/g, '')
  .replace(/<[^>]+>/g, '\n')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ')
  .split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);

const FLY = { secType: 'BAG', symbol: 'SPX', label: '买入看涨蝴蝶 7725/7750/7775' };
const nvda = { id: 'tk1', account: 'IBKR模拟', symbol: 'NVDA', sec_type: 'STK', contract: { secType: 'STK', symbol: 'NVDA' },
  targets: { take_profit: 240, stop_loss: 200, trail_pct: 5 }, auto_close: { enabled: true, order_type: 'MKT', host_at_broker: true }, enabled: true, peak: 225, fired_at: null, fired_state: '' };
const nvdaLive = { id: 'tk1', state: 'holding', price: 219.74, peak: 225, trail_stop: 213.75, unrealized_pnl: 3974, unrealized_pct: 22.08, reason: '', stop_effective: 213.75 };
const fly = { id: 'tk2', account: '模拟', symbol: 'SPX', sec_type: 'BAG', contract: FLY,
  targets: { take_profit: null, stop_loss: null, trail_pct: null, profit_drawdown_pct: null, profit_drawdown_tiers: [{ above: 0, pct: 40 }], profit_drawdown_arm: 0.222222, spot_target: null, spot_stop_below: 7700, spot_stop_above: 7790 },
  auto_close: { enabled: true, order_type: 'LMT', close_fraction_pct: 100, host_at_broker: false, chase_max_pct: 10 }, enabled: true, peak: 5.4, fired_at: null, fired_state: '' };
const flyLive = { id: 'tk2', state: 'holding', price: 5.23, peak: 5.4, trail_stop: null, cost_basis: 450, unrealized_pnl: 73, unrealized_pct: 16.22, reason: '', stop_effective: null,
  profit_peak: 90, profit_drawdown_threshold: null, profit_trail_stop: null, spot_stop: { below: 7700, above: 7790, spot: 7722.35, spot_note: '', hit: null, reason: '' } };
const L = (price, source, label, kind = 'pivot') => ({ price, source, label, kind });
const nvdaWatch = { id: 'w1', symbol: 'NVDA', enabled: true, last_price: 219.5, expiry: '2026-09-11',
  levels: [L(230, 'call_wall', 'Call 墙', 'resistance'), L(220, 'round', '整数关口'), L(215, 'max_pain', '痛点'), L(210, 'put_wall', 'Put 墙', 'support')],
  wall: { regime: 'positive', net_gex_ratio: 0.31, gross_gex: 5, max_pain: { strike: 215 }, days_to_expiry: 4 } };
const spxWatch = { id: 'w2', symbol: 'SPX', enabled: true, last_price: 7720, expiry: '20261008',
  levels: [L(7700, 'put_wall', 'Put 墙', 'support'), L(7725, 'max_pain', '痛点'), L(7750, 'call_wall', 'Call 墙', 'resistance')],
  wall: { regime: 'negative', net_gex_ratio: -0.118, gross_gex: 3, max_pain: null, days_to_expiry: 0 } };

const scenarios = [
  ['正股托管、在盯价位', nvda, nvdaLive, { orders: [{ kind: 'tp', label: '托管止盈 240.0' }, { kind: 'ptrail', label: '回撤停损 210' }] }, true, true, [nvdaWatch], []],
  ['正股托管、还没挂出、没连', nvda, nvdaLive, undefined, false, false, [], []],
  ['蝶式分档、标的止损、价位当天到期', fly, flyLive, undefined, false, true, [spxWatch], []],
  ['蝶式:还没盈利过', fly, { ...flyLive, profit_peak: -12 }, undefined, false, true, [], []],
  ['蝶式:没有起算门槛', { ...fly, targets: { ...fly.targets, profit_drawdown_arm: null } }, flyLive, undefined, false, true, [], []],
  ['利润回撤已激活', { ...fly, targets: { ...fly.targets, profit_drawdown_tiers: null, profit_drawdown_pct: 30 }, auto_close: { ...fly.auto_close, close_fraction_pct: 50 } },
    { ...flyLive, profit_trail_stop: 4.6, profit_drawdown_threshold: 30, profit_peak: 120 }, undefined, false, true, [], []],
  ['分档、当前阈值', fly, { ...flyLive, profit_drawdown_threshold: 27, profit_trail_stop: 4.9, profit_peak: 150 }, undefined, false, true, [], []],
  ['拿不到现价', nvda, { ...nvdaLive, price: null, unrealized_pnl: null }, undefined, false, true, [nvdaWatch], ['w1']],
  ['拿不到现价但有标的止损', fly, { ...flyLive, price: null }, undefined, false, true, [], []],
  ['什么都没设', { ...nvda, targets: {}, auto_close: { enabled: false }, peak: null }, { ...nvdaLive, trail_stop: null, stop_effective: null }, undefined, false, true, [], []],
  ['期权按标的目标价', { ...fly, sec_type: 'OPT', contract: { secType: 'OPT', symbol: 'SPX', lastTradeDateOrContractMonth: '20261120', strike: 7700, right: 'C' }, targets: { spot_target: 7750 } },
    { ...flyLive, spot_stop: undefined, spot_target: { spot_target: 7750, price: 9.85, pnl: 462, spot: 7722 } }, undefined, false, true, [], []],
  ['标的目标价挂起', { ...fly, targets: { spot_target: 7750 } }, { ...flyLive, spot_stop: undefined, spot_target: { held: true, reason: '盘口太宽,先不挂单' } }, undefined, false, true, [], []],
  ['标的目标价这一轮算不出', { ...fly, targets: { spot_target: 7750 } }, { ...flyLive, spot_stop: undefined, spot_target: { price: null } }, undefined, false, true, [], []],
  ['已暂停', { ...nvda, enabled: false }, nvdaLive, undefined, false, true, [], []],
  ['止盈已触发', { ...nvda, fired_at: '2026-10-18T10:00:00Z', fired_state: 'take_profit' }, nvdaLive, undefined, false, true, [], []],
  ['止损触发追价中', { ...fly, fired_at: '2026-10-18T10:00:00Z', fired_state: 'sweep:stop_loss' },
    { ...flyLive, sweeping: true, chase: { rounds: 4, limit: 4.1, natural: 4.0, floor: 3.7 }, reason: '止损 4.20 触发' }, undefined, false, true, [], []],
  ['到价被拦', nvda, { ...nvdaLive, blocked: ['熔断中', '实盘未授权'] }, undefined, false, true, [], []],
  ['止损按可成交价判', { ...fly, auto_close: { ...fly.auto_close, stop_basis: 'natural', stop_chase_step: 2 } }, { ...flyLive, stop_price: 5.05 }, undefined, false, true, [], []],
  ['可成交价这一轮拿不到', { ...fly, auto_close: { ...fly.auto_close, stop_basis: 'natural' } }, { ...flyLive, stop_price: null }, undefined, false, true, [], []],
  ['出场细则与分批止盈', { ...nvda, targets: { ...nvda.targets, exit_at: '15:45', exit_at_ms: Date.UTC(2026, 9, 19, 19, 45), spot_stop_confirm_s: 5,
    take_profit_tiers: [{ price: 230, fraction_pct: 50, done: true }, { price: 240, fraction_pct: 50 }] } }, nvdaLive, undefined, false, true, [], []],
  ['手动平仓', { ...nvda, fired_at: 'x', fired_state: 'manual' }, nvdaLive, undefined, false, true, [], []],
  ['盈亏为零', nvda, { ...nvdaLive, unrealized_pnl: 0, unrealized_pct: 0 }, undefined, false, true, [], []],
  ['亏损', nvda, { ...nvdaLive, unrealized_pnl: -12.5, unrealized_pct: -0.31 }, undefined, false, true, [], []],
  ['还没有盯盘行', nvda, { id: 'tk1' }, undefined, false, true, [], []],
  ['价位还没算出来', nvda, nvdaLive, undefined, false, true, [{ ...nvdaWatch, levels: [] }], []],
  ['价位算着呢', nvda, nvdaLive, undefined, false, true, [{ ...nvdaWatch, levels: [] }], ['w1']],
  ['富途', nvda, nvdaLive, undefined, false, false, [], [], 'futu'],
];
const cases = [];
for (const [name, t, live, hosted, delayed, connected, watches, busy, provider] of scenarios) {
  while (pending.length) pending.shift()({});
  await new Promise((r) => setTimeout(r, 0));
  await ui.seedAlerts(watches, busy);
  if (provider) await ui.seedStatus({ broker_provider: provider });
  else await ui.seedStatus(null);
  const html = ui.renderTrackCard({ t, live, hosted, delayed, connected, flash: false });
  cases.push({ name, t, live, hosted: hosted ?? null, delayed, connected, watches, busy, gateway: provider === 'futu' ? 'OpenD' : 'TWS', texts: texts(html) });
}
writeFileSync(join(here, 'track-card.json'), JSON.stringify({ generator: 'native/tests/fixtures/gen_track_card.mjs', cases }, null, 2) + '\n');
console.log(`track-card.json: ${cases.length} 个场景`);
