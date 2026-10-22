// 生成 ideas.json:「想法」(desktop/renderer-react/src/pages/Ideas.tsx + lib/tradeFacts.ts 的 tradeText)。
//   SSR 把原页面渲染出来抽字;列表、读不到、总结历史、总结着、附带交易结果、检索词与命中方式、正在分析的那几张、输入框里的字
//   由 ssr/build.mjs 的 SEEDS 灌进 useState 的初值(effect 在 SSR 里不跑)。时间按本机时区写,时钟钉在 2026-08-21 21:50。
//   TZ=Asia/Shanghai node native/tests/fixtures/gen_ideas.mjs <装好依赖的 desktop 目录>
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = process.argv[2];
if (!desktop) throw new Error('要给装好依赖的 desktop 目录');
if (process.env.TZ !== 'Asia/Shanghai') throw new Error('时间按本机时区写:要 TZ=Asia/Shanghai 跑');

const NOW = Date.UTC(2026, 7, 21, 13, 50, 0);
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};

const out = mkdtempSync(join(tmpdir(), 'ssr-'));
execFileSync(process.execPath, [join(here, 'ssr/build.mjs'), desktop, out], { stdio: 'inherit' });

globalThis.window = {
  dafri: new Proxy({}, { get: () => async () => ({}) }),
  localStorage: { getItem: () => null, setItem() {} },
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};
globalThis.localStorage = window.localStorage;
Object.defineProperty(globalThis, 'navigator', { value: { platform: 'MacIntel', userAgent: 'node' }, configurable: true });
const ui = await import(pathToFileURL(join(out, 'entry.mjs')).href);

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ');
const texts = (html) => decode(html.replace(/<title>[\s\S]*?<\/title>/g, '').replace(/<[^>]+>/g, '\n'))
  .split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
const buttons = (html) => [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({ text: texts(m[2]).join(''), loading: /ant-btn-loading/.test(m[1]) }))
  .filter((b) => b.text);
const titles = (html) => [...html.matchAll(/<span title="([^"]*)">/g)].map((m) => decode(m[1]));
const segments = (html) => [...html.matchAll(/<label class="ant-segmented-item([^"]*)"/g)].map((m) => /item-selected/.test(m[1]));
const checkbox = (html) => /ant-checkbox-checked/.test(html);
const inputValue = (html) => decode(/<input[^>]*placeholder="例:AXTI[^"]*"[^>]*value="([^"]*)"/.exec(html)?.[1] ?? /<input[^>]*value="([^"]*)"[^>]*placeholder="例:AXTI/.exec(html)?.[1] ?? '');

// ---- 数据 ------------------------------------------------------------------------------------
const I = (o) => ({ id: 'x', text: '一条想法', status: 'active', symbols: ['AXTI'], created_at: '2026-08-21T12:00:00Z', ...o });
const base = [
  I({ id: 'i1', text: 'AXTI 周五尾盘买入,量能起来了', created_at: '2026-08-20T20:00:00Z' }),
  I({ id: 'i2', text: '留意 SPY 770 这个整数关口', status: 'done', symbols: ['SPY'], created_at: '2026-08-19T14:00:00Z' }),
];
const brief = { last: 12.34, chg_1d_pct: 3.2, chg_20d_pct: -5.1, chg_60d_pct: 18, rsi14: 61.2, vs_sma50_pct: 4.4, vs_sma200_pct: -2, vol20_annual_pct: 55, from_52w_high_pct: -12.5,
  anchor: { label: '周五收盘', price: 11.8, chg_from_anchor_pct: 4.58 } };
const analysis = { symbol: 'AXTI', summary: '量能放大的突破,等回踩确认', thesis: '周五尾盘放量,周线级别第一次站上 50 日线', checks: ['盘前是否有增发公告', '期权链 IV 是否已经抬高'], risks: ['小盘股流动性差', '财报在下周'],
  suggestion: '小仓位试,破 11.5 走', model: 'claude-x', analyzed_at: '2026-08-21T13:30:00Z', brief };
const rich = [
  I({ id: 'a1', text: 'AXTI 周五尾盘买入', analysis }),
  I({ id: 'a2', symbols: ['NVDA', 'AMD'], text: '芯片轮动', analysis: { ...analysis, symbol: 'NVDA', brief: { ...brief, anchor: { label: '前高', price: 140, chg_from_anchor_pct: -3 } } } }),
  I({ id: 'a3', symbols: [], text: '纯想法,没有标的', analysis: { summary: '', checks: [], risks: [] } }),
  I({ id: 'a4', text: '行情失败', analysis: { symbol: 'TSLA', summary: '看不清', brief: { error: '没有行情权限' } } }),
  I({ id: 'a5', text: '没连券商', analysis: { symbol: 'AAPL', summary: '先记下' } }),
  I({ id: 'a6', text: '锚点没有涨跌', analysis: { symbol: 'QQQ', summary: 's', brief: { last: 500, anchor: { label: '整数', price: 500, chg_from_anchor_pct: null } } } }),
  I({ id: 'a7', text: '只有锚点', analysis: { symbol: 'IWM', brief: { anchor: { label: '均线', price: 210, chg_from_anchor_pct: 0 } }, model: '', analyzed_at: null } }),
  I({ id: 'a8', text: '已归档的', status: 'archived', symbols: null, created_at: '2026-07-01T00:00:00Z' }),
  I({ id: 'a9', text: '状态不认识', status: 'weird', created_at: 'not a date' }),
  I({ id: 'a10', text: '空的时间', created_at: null }),
];
const trade = (o) => ({ opened_at: '2026-08-10T14:00:00Z', label: 'SPX 蝶 7600/7615/7630', paper: false, result: 'win', return_pct: 45.2, pnl_points: 3.1, note: '', ...o });
const digest = { id: 'd1', created_at: '2026-08-21T12:30:00Z', idea_count: 42, focus: null, trades: [trade({}), trade({ paper: true, result: 'loss', return_pct: -100, pnl_points: -1.5, note: '穿过上翼' }), trade({ result: 'open', return_pct: null, pnl_points: null })],
  digest: { summary: '耐心的突破单赚钱,追高的亏', themes: ['尾盘放量', '整数关口'], lessons: ['破位就走'], patterns: ['写了止损的想法胜率高'], actions: ['下单前先写失效价'], model: 'claude-x' } };
const digests = [digest, { ...digest, id: 'd0', created_at: '2026-08-01T00:00:00Z' }, { ...digest, id: 'dm' }];

const pages = [];
async function page(name, seed = {}) {
  globalThis.__ssrSeed = seed;
  const html = ui.renderIdeasPage();
  globalThis.__ssrSeed = undefined;
  if (process.env.DUMP_HTML?.startsWith(`${name}:`)) writeFileSync(process.env.DUMP_HTML.slice(name.length + 1), html);
  pages.push({ name, seed, texts: texts(html), buttons: buttons(html), titles: titles(html), segments: segments(html), withTrades: checkbox(html), input: inputValue(html) });
}
await page('预览台的数据', { ideas: base });
await page('读不到', { ideas: base, loadError: 'ideas.list 超时' });
await page('没有进行中的', {});
await page('全部也没有', { filter: 'all' });
await page('检索没命中', { query: 'RKLB' });
await page('检索命中', { query: '蝴蝶', ideas: base, matched: { i1: ['symbol', 'semantic'], i2: ['recent'] } });
await page('各种分析', { filter: 'all', ideas: rich });
await page('分析着', { ideas: rich.slice(0, 2), analyzing: ['a1'] });
await page('知识总结', { ideas: base, digests });
await page('只有一次总结、缺键、检索过', { ideas: base, digests: [{ id: 'd', created_at: '2026-08-20T01:00:00Z', idea_count: 3, focus: { q: '蝴蝶', symbols: ['SPX', 'XSP'] }, digest: {} }] });
await page('检索加总结着', { query: '结算', ideas: base, digests: [digest], digesting: true });
await page('不附带交易结果', { ideas: base, withTrades: false, query: 'x' });
await page('输入框里有字', { ideas: base, text: '新想法 RKLB' });
await page('焦点只有标的', { ideas: base, digests: [{ ...digest, focus: { q: '', symbols: ['SPX'] }, trades: [] }] });

writeFileSync(join(here, 'ideas.json'), JSON.stringify({ generator: 'native/tests/fixtures/gen_ideas.mjs', now: NOW, pages }, null, 1) + '\n');
console.log(`ideas.json: ${pages.length} 个页面场景`);
