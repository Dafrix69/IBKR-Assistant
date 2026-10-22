// 生成 h2_ideas.json:engine-ts 的 ideas handler(rpc/handlers/ideas.ts,原类现跑)对着 h2_world.mjs 的假 RpcContext。
// C++ 一半:tests/tst_h2_ideas.cpp(tests/h2_world.h 的同一份脚本)。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_h2_ideas.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_CONFIG, enc, loadH2 } from './h2_world.mjs';
import { rng } from './broker_world.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const h2 = await loadH2(engine);

const START = Date.parse('2026-10-14T10:30:00-04:00'); // 周三
const DAY = 86_400_000;
const call = (id, m, a = {}) => ({ op: 'call', id, m, a });
const scenarios = [];
const add = (name, script) => scenarios.push({ name, script: { start: START, dump: ['ideas', 'idea_digests', 'audit_log', 'sectors'], ...script } });
const idea = (text, symbols) => ({ op: 'store', m: 'addIdea', a: symbols === undefined ? [text] : [text, symbols] });
const day = { op: 'advance', ms: DAY };
const status = (n, s) => ({ op: 'store', m: 'setIdeaStatus', a: [`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, s] });
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// 一批想法:id 依次 01..;每条隔一天;1..5 归档、6..7 完成、8 活动
const TEXTS = [
  ['看好 NVDA 的 AI 算力,回调买入', ['NVDA']], ['AAPL 财报前不动', ['AAPL']], ['SPX 7500 附近做蝴蝶,宽度 25', ['SPX']], ['半导体板块 NVDA AMD 同涨,注意追高', ['NVDA', 'AMD']],
  ['今天情绪化加仓了 TSLA,下次不许', ['TSLA']], ['规则:不在财报日前一天开新仓', []], ['NVDA 突破 200 日线,持有到周五', ['NVDA']], ['还没想好做什么', []],
];
const SEED = TEXTS.flatMap(([t, s]) => [idea(t, s), day]);
const ARCH = [1, 2, 3, 4, 5].map((n) => status(n, 'archived')).concat([6, 7].map((n) => status(n, 'done')));
const SEEDED = [...SEED, ...ARCH];

// ---- ideas.add
add('ideas.add:去空白;空 → 想法内容为空;2000 码点整够、2001 超;emoji 按码点;抽标的不兜底 SPX', {
  steps: [call('a', 'ideas.add', { text: '  看好 NVDA 和 AAPL  \n' }), call('b', 'ideas.add', { text: '' }), call('c', 'ideas.add', { text: ' \t\n ﻿ ' }),
    call('d', 'ideas.add', { text: '好'.repeat(2000) }), call('e', 'ideas.add', { text: '好'.repeat(2001) }), call('f', 'ideas.add', { text: '😀'.repeat(2000) }),
    call('g', 'ideas.add', { text: '😀'.repeat(2001) }), call('h', 'ideas.add', { text: '大盘 SPX 今天怎么走' }), call('i', 'ideas.add', { text: '没有标的的一句话' }),
    call('j', 'ideas.add', { text: '  ' + '好'.repeat(1999) + '  ' }), call('k', 'ideas.add', {}), call('l', 'ideas.add', { text: 5 }), call('m', 'ideas.add', { text: null }), call('n', 'ideas.add', { text: 'TSLA 看多', extra: 1 }),
    call('o', 'ideas.add', []), call('p', 'ideas.add', { text: '好'.repeat(1999) + '😀' }), call('q', 'ideas.add', { text: '好'.repeat(2000) + '😀' })],
});

// ---- ideas.list
add('ideas.list:status / limit 的各种取值(0 走默认、abc → NaN、串数字、封顶 500);未知状态 → -32602 原话', {
  steps: [...SEEDED, call('a', 'ideas.list', {}), call('b', 'ideas.list', { status: 'archived' }), call('c', 'ideas.list', { status: 'done', limit: 1 }), call('d', 'ideas.list', { status: 'active', limit: '2' }),
    call('e', 'ideas.list', { status: '' }), call('f', 'ideas.list', { status: 'nope' }), call('g', 'ideas.list', { limit: 0 }), call('h', 'ideas.list', { limit: '0' }), call('i', 'ideas.list', { limit: 'abc' }),
    call('j', 'ideas.list', { limit: 2.9 }), call('k', 'ideas.list', { limit: -1 }), call('l', 'ideas.list', { limit: 100000 }), call('m', 'ideas.list', { limit: '  ' }), call('n', 'ideas.list', { limit: '3.5' }),
    call('o', 'ideas.list', { limit: '1e1' }), call('p', 'ideas.list', { limit: '0x2' }), call('q', 'ideas.list', { limit: 1e308 }), call('r', 'ideas.list', { limit: true }), call('s', 'ideas.list', { status: 5 }),
    call('t', 'ideas.list', { status: null, limit: null }), call('u', 'ideas.list', { limit: '-0' }), call('v', 'ideas.list', { limit: 'Infinity' }), call('w', 'ideas.list', { limit: '١٢' }), call('x', 'ideas.list', { limit: [] }), call('y', 'ideas.list', { status: ' archived' })],
});

// ---- ideas.update
add('ideas.update:缺 id、状态不认识、想法不存在、两头空白、id 不是串;检查先后次序', {
  steps: [...SEED.slice(0, 4), call('a', 'ideas.update', { id: ID(1), status: 'done' }), call('b', 'ideas.update', { id: ID(1), status: 'nope' }), call('c', 'ideas.update', { status: 'done' }),
    call('d', 'ideas.update', { id: ID(99), status: 'done' }), call('e', 'ideas.update', { id: `  ${ID(2)}\n`, status: ' archived ' }), call('f', 'ideas.update', { id: 5, status: 'done' }), call('g', 'ideas.update', { id: '', status: 'done' }),
    call('h', 'ideas.update', { id: '   ', status: 'nope' }), call('i', 'ideas.update', { id: ID(3), status: '' }), call('j', 'ideas.update', { id: ID(3) }), call('k', 'ideas.update', { id: ID(3), status: 'active' }),
    call('l', 'ideas.update', { id: null, status: 'done' }), call('m', 'ideas.update', { id: ID(4), status: 'done', x: 1 }), call('n', 'ideas.update', { id: ID(99), status: 'nope' })],
});

// ---- ideas.search(无语义)
const SEARCHES = [{}, { q: 'NVDA' }, { symbols: 'NVDA' }, { symbols: ['AAPL', 'TSLA'] }, { symbols: 'nvda, amd' }, { symbols: ' NVDA  AMD ' }, { q: '财报' }, { q: '财报 规则' }, { q: 'ab' }, { q: '蝴蝶 宽度' },
  { since: '2026-10-16' }, { until: '2026-10-16' }, { since: '2026-10-16', until: '2026-10-18' }, { since: '2026-10-18', until: '2026-10-16' }, { status: 'archived' }, { status: 'done', q: '持有' }, { status: 'nope' },
  { since: 'bad' }, { until: '2026-02-30' }, { since: '2026-1-1' }, { since: ' 2026-10-15 ' }, { until: '' }, { limit: 2 }, { limit: '3' }, { limit: 0 }, { limit: -5 }, { limit: 'abc' }, { limit: 1000 }, { limit: 0.5 }, { limit: 1.5 },
  { limit: Infinity === 1 ? 1 : 1e308 }, { q: '   ' }, { q: '"引号"' }, { q: 'NVDA', symbols: 'AAPL', status: 'archived', limit: 1 }, { symbols: '' }, { symbols: [] }, { symbols: ['', ' '] }, { since: '0000-01-01' }, { since: '9999-12-31', until: '9999-12-31' },
  { q: 5 }, { symbols: 5 }, { since: 5 }, { x: 1 }, { symbols: 'A'.repeat(100) }, { q: '长'.repeat(400) }, { symbols: Array.from({ length: 30 }, (_, i) => `S${i}`) }];
add('ideas.search(语义不可用 / 没连券商):关键词 / 标的 / 时间窗 / 状态 / limit 的各种取值与错误', {
  ports: { 'ideaSemantic.rank': [{ value: null }] },
  steps: [...SEEDED, ...SEARCHES.map((a, i) => call(`s${String(i).padStart(2, '0')}`, 'ideas.search', a))],
});
add('ideas.search:语义挑选——空 Map 不合并、有分数的合并(补进池里的、给命中的打 semantic)、封顶 limit', {
  ports: { 'ideaSemantic.rank': [{ value: {} }, { value: { [ID(1)]: 1, [ID(6)]: 0.9, 'ghost': 0.5 } }, { value: { [ID(8)]: 1 } }, { value: null }, { error: '嵌入挂了' }, { value: { [ID(2)]: 1, [ID(3)]: 0.9, [ID(4)]: 0.8 } }] },
  steps: [...SEEDED, call('a', 'ideas.search', { q: '大涨' }), call('b', 'ideas.search', { q: '大涨' }), call('c', 'ideas.search', { q: '  不动 ', status: 'archived' }), call('d', 'ideas.search', { q: '随便' }),
    call('e', 'ideas.search', { q: '随便' }), call('f', 'ideas.search', { q: '半导体', limit: 2 }), call('g', 'ideas.search', { q: '', symbols: 'NVDA' }), call('h', 'ideas.search', { q: '大涨', since: '2026-10-17', until: '2026-10-19' })],
});
add('ideas.search:语义替身去调 llmJson 闭包——completeJson 的参数原样转手,回话 / 抛错都原样回到替身', {
  llm: [{ value: { ids: ['x'] } }, { error: '模型超时' }, { value: null }],
  ports: { 'ideaSemantic.rank': [{ value: { [ID(1)]: 1 }, callLlm: { system: 'S', user: 'U', schema: { type: 'object' } } }, { value: null, callLlm: { system: '系统', user: '用户' } }, { value: {}, callLlm: { system: 'a', user: 'b', schema: { p: [1, 2] } } }] },
  steps: [...SEEDED, call('a', 'ideas.search', { q: '大涨' }), call('b', 'ideas.search', { q: '大涨' }), call('c', 'ideas.search', { q: '大涨' })],
});

// ---- ideas.analyze
const BARS = (() => {
  const out = [];
  const end = Date.parse('2026-10-13T00:00:00Z');
  let close = 100;
  for (let t = end - 380 * DAY; t <= end; t += DAY) {
    const d = new Date(t).getUTCDay();
    if (d === 0 || d === 6) continue;
    close += 0.5;
    out.push({ date: new Date(t).toISOString().slice(0, 10), open: close - 0.25, high: close + 1, low: close - 1, close, volume: 1000 });
  }
  return out;
})();
const GOOD_A = { summary: '与动能匹配度一般', thesis: '需要站回均线', checks: ['财报日期'], risks: ['波动率偏高'], suggestion: '等回调' };
add('ideas.analyze:没连券商——brief 为 null;库里标的与现抽的不同就自愈;成功落库 + 留痕;不存在 / 空 id', {
  llm: [{ value: GOOD_A }, { value: { ...GOOD_A, thesis: ' 带空白 ', extra: 1 } }, { value: { summary: '  ' } }],
  steps: [idea('上周五尾盘买入的 AAPL,考虑加仓', ['OLD']), idea('没有标的的一句', []), idea('NVDA AMD 都看', ['NVDA', 'AMD']), idea('SPX 这周怎么走', ['SPX']),
    call('a', 'ideas.analyze', { id: ID(1) }), call('b', 'ideas.analyze', { id: ID(2) }), call('c', 'ideas.analyze', { id: ID(99) }), call('d', 'ideas.analyze', { id: '' }), call('e', 'ideas.analyze', { id: `  ${ID(3)} ` }),
    call('f', 'ideas.analyze', {}), call('g', 'ideas.analyze', { id: 5 }), call('h', 'ideas.analyze', { id: ID(4) })],
});
add('ideas.analyze:连着券商——日线情报 + 价格锚点 + 提示词原文;取行情失败 → brief.error(截 120);0 个会话当没连', {
  h2router: { sessions: 1, results: { historicalBars: [{ value: BARS }, { error: '行情订阅失败:' + 'x'.repeat(200) }, { value: [] }, { value: [BARS[0]] }, { value: [{ date: '2026-10-09', close: 'x', high: null, low: 1 }, { date: '2026-10-12', close: 5 }] }, { value: BARS }] } },
  llm: [{ value: GOOD_A }],
  steps: [idea('上周五尾盘买入的 AAPL,考虑加仓', ['AAPL']), idea('NVDA 前天收盘价买的', []), idea('TSLA 昨天的低点接', []), idea('MSFT 一个月前的价位', []), idea('GOOG 突破', []), idea('AMD 本周二开盘', []),
    { op: 'h2router', v: 'make' }, call('a', 'ideas.analyze', { id: ID(1) }), call('b', 'ideas.analyze', { id: ID(2) }), call('c', 'ideas.analyze', { id: ID(3) }), call('d', 'ideas.analyze', { id: ID(4) }),
    call('e', 'ideas.analyze', { id: ID(5) }), call('f', 'ideas.analyze', { id: ID(6) }),
    { op: 'h2routerSet', set: { sessions: 0 } }, call('g', 'ideas.analyze', { id: ID(1) }), { op: 'h2router', v: 'null' }, call('h', 'ideas.analyze', { id: ID(1) })],
});
add('ideas.analyze:模型出错 / 回包不合 schema(多余键、条数超限、类型不对)→ -32011「AI 分析失败」;失败不落库', {
  llm: [{ error: '模型超时' }, { value: { summary: 'x', extra: 1 } }, { value: { summary: 'x', checks: Array.from({ length: 9 }, (_, i) => String(i)) } }, { value: { summary: 5 } }, { value: null }, { value: [] },
    { value: { summary: '好', checks: [1] } }, { error: '带码', kind: 'rpc', code: -32009 }, { value: { thesis: 'x' } }, { value: 'text' }, { value: { summary: 'ok' } }],
  steps: [idea('NVDA 看多', ['NVDA']), ...Array.from({ length: 11 }, (_, i) => call(`a${String(i).padStart(2, '0')}`, 'ideas.analyze', { id: ID(1) }))],
});
add('ideas.analyze:周几与美东时刻(周一凌晨 / 周日晚)、换了配置里的模型名', {
  settings: { llm: { model: 'm-2' } },
  llm: [{ value: GOOD_A }, { value: GOOD_A }, { value: GOOD_A }],
  steps: [idea('NVDA 看多', ['NVDA']), { op: 'advance', ms: 4 * DAY + 3_600_000 * 3 }, call('a', 'ideas.analyze', { id: ID(1) }), { op: 'advance', ms: 11 * 3_600_000 }, call('b', 'ideas.analyze', { id: ID(1) }),
    { op: 'advance', ms: 7 * DAY + 5 * 60_000 }, call('c', 'ideas.analyze', { id: ID(1) })],
});

// ---- ideas.digest
const DIGEST_A = { summary: '偏好动量', themes: ['AI(4 条)'], lessons: ['写价位'], patterns: [], actions: ['建规则'] };
const FACT = (id, over = {}) => ({ id, kind: 'butterfly', symbol: 'SPX', opened_at: '2026-10-05T14:00:00.000Z', closed_at: '2026-10-05T19:00:00.000Z', label: 'SPX 7500/7525/7550 看涨蝴蝶 买入', entry_price: 2.5, exit_price: 4, how: 'closed', result: 'win', return_pct: 60, paper: false, note: '', ...over });
const FACTS = [
  FACT('ib:1'), FACT('ib:2', { opened_at: '2026-10-08T15:00:00.000Z', closed_at: null, how: 'open', result: 'open', exit_price: null, return_pct: null }),
  FACT('stk:3', { kind: 'stock', symbol: 'NVDA', label: 'NVDA 做多', opened_at: '2026-09-30T14:00:00.000Z', result: 'loss', return_pct: -3.2, note: '止损', paper: true }),
  FACT('opt:4', { kind: 'option', symbol: 'AAPL', label: 'AAPL 190C', opened_at: '', result: 'unknown', pnl_points: 1.5, return_pct: null, entry_price: null, note: '没配对' }),
];
const TH = (facts) => ({ value: { facts, butterflies: [], options: [], positions: [] } });
add('ideas.digest:范围检查与错误话;没有想法;scope 的取法(空白、大小写、null);行数封顶;条目文案', {
  llm: [{ value: DIGEST_A }, { value: DIGEST_A }, { value: DIGEST_A }, { value: DIGEST_A }],
  steps: [call('a', 'ideas.digest', { scope: 'archived' }), call('b', 'ideas.digest', { scope: 'nope' }), call('c', 'ideas.digest', {}), call('d', 'ideas.digest', { scope: 'all' }), call('e', 'ideas.digest', { scope: ' ' }),
    call('f', 'ideas.digest', { scope: 'ARCHIVED' }), call('g', 'ideas.digest', { scope: null }), call('h', 'ideas.digest', { scope: 5 }),
    ...SEED, ...ARCH,
    { op: 'store', m: 'setIdeaAnalysis', a: [ID(1), { summary: '当时的判断', thesis: 't' }] }, { op: 'store', m: 'setIdeaAnalysis', a: [ID(2), { summary: '' }] },
    call('i', 'ideas.digest', { scope: 'archived' }), call('j', 'ideas.digest', { scope: ' done ' }), call('k', 'ideas.digest', { scope: 'all' }), call('l', 'ideas.digest', {}),
    { op: 'store', m: 'setIdeaStatus', a: [ID(8), 'archived'] }, call('m', 'ideas.digest', { scope: 'active' }), call('n', 'ideas.digest', { scope: 'archived', x: 1 })],
});
add('ideas.digest:超过 100 条只取最近 100;条目按时间从早到晚', {
  llm: [{ value: DIGEST_A }],
  steps: [...Array.from({ length: 105 }, (_, i) => [idea(`想法 ${i} NVDA`, ['NVDA']), { op: 'store', m: 'setIdeaStatus', a: [ID(i + 1), 'archived'] }, { op: 'advance', ms: 3_600_000 }]).flat(), call('a', 'ideas.digest', { scope: 'archived' })],
});
add('ideas.digest:模型出错 / 回包不合 schema → -32011「知识总结失败」;成功落库(带 model、idea_ids)与留痕', {
  settings: { llm: { model: 'm-3' } },
  llm: [{ error: '超时' }, { value: { summary: '' } }, { value: { summary: 'x', themes: Array.from({ length: 9 }, () => 'a') } }, { value: { summary: 'x', lessons: Array.from({ length: 11 }, () => 'a') } }, { value: { summary: ' 好 ', actions: Array.from({ length: 6 }, () => 'a') } },
    { value: { summary: 'x', zzz: 1 } }, { value: null }, { value: { summary: 'x', actions: Array.from({ length: 7 }, () => 'a') } }],
  steps: [...SEEDED, ...Array.from({ length: 8 }, (_, i) => call(`a${i}`, 'ideas.digest', { scope: 'archived' }))],
});
add('ideas.digest:带焦点——标的 / 关键词 / 两者;分层抽样;语义补充;焦点不规整(全空 → 当没焦点)', {
  llm: [{ value: DIGEST_A }],
  ports: { 'ideaSemantic.rank': [{ value: null }, { value: { [ID(4)]: 1 } }, { value: {} }, { value: { [ID(6)]: 1 }, callLlm: { system: 's', user: 'u', schema: {} } }, { error: '挂了' }] },
  steps: [...SEEDED, call('a', 'ideas.digest', { scope: 'archived', focus: { symbols: ['NVDA'] } }), call('b', 'ideas.digest', { scope: 'all', focus: { q: '财报 规则' } }), call('c', 'ideas.digest', { scope: 'done', focus: { q: '持有', symbols: ['nvda', ' amd '] } }),
    call('d', 'ideas.digest', { scope: 'archived', focus: {} }), call('e', 'ideas.digest', { scope: 'archived', focus: { q: '   ', symbols: [] } }), call('f', 'ideas.digest', { scope: 'all', focus: { q: '规则' } }),
    call('g', 'ideas.digest', { scope: 'all', focus: { symbols: ['ZZZZ'] } }), call('h', 'ideas.digest', { focus: { q: 5 } }), call('i', 'ideas.digest', { focus: 'x' }), call('j', 'ideas.digest', { focus: null }),
    call('k', 'ideas.digest', { scope: 'nope', focus: { q: 'x' } }), call('l', 'ideas.digest', { scope: 'archived', focus: { q: '加仓' } })],
});
add('ideas.digest:附带交易结果(trades: true)——事实 / 时间线 / 胜负行;只有交易没有想法;交易也没有 → -32602;tradeHistory 抛错;trades 取值', {
  llm: [{ value: DIGEST_A }],
  ports: { 'tradeHistory.load': [TH(FACTS), TH(FACTS), TH([]), TH([FACT('ib:9', { opened_at: '2030-01-01T00:00:00.000Z' })]), TH(FACTS), { error: '库读不了' }, TH(FACTS), TH([FACT('ib:5', { opened_at: '' })]), TH(FACTS)] },
  steps: [call('a', 'ideas.digest', { trades: true }), ...SEEDED, call('b', 'ideas.digest', { scope: 'archived', trades: true }), call('c', 'ideas.digest', { scope: 'done', trades: true }), call('d', 'ideas.digest', { scope: 'all', trades: true }),
    call('e', 'ideas.digest', { scope: 'all', trades: true, focus: { symbols: ['NVDA', 'SPX'], q: '突破' } }), call('f', 'ideas.digest', { scope: 'all', trades: true }), call('g', 'ideas.digest', { scope: 'archived', trades: 1 }),
    call('h', 'ideas.digest', { scope: 'archived', trades: 'true' }), call('i', 'ideas.digest', { scope: 'archived', trades: false }), call('j', 'ideas.digest', { scope: 'archived', trades: true }), call('k', 'ideas.digest', { scope: 'archived', trades: true }), call('l', 'ideas.digest', { scope: 'archived', trades: true }),
    { op: 'store', m: 'setIdeaStatus', a: [ID(1), 'active'] }, call('m', 'ideas.digest', { scope: 'archived', trades: true })],
});
add('ideas.digest:没有想法但有交易 → 仍总结(「这个范围内没有想法,只有交易结果」)', {
  llm: [{ value: DIGEST_A }, { error: '超时' }],
  ports: { 'tradeHistory.load': [TH(FACTS), TH(FACTS)] },
  steps: [call('a', 'ideas.digest', { scope: 'archived', trades: true }), call('b', 'ideas.digest', { scope: 'all', trades: true, focus: { q: '没有' } })],
});

// ---- ideas.digests
add('ideas.digests:limit 的取法(0 走 20、封顶 100、abc → NaN、串数字)', {
  llm: [{ value: DIGEST_A }],
  steps: [...SEEDED, ...Array.from({ length: 4 }, (_, i) => [call(`d${i}`, 'ideas.digest', { scope: 'archived' }), day]).flat(), call('a', 'ideas.digests', {}), call('b', 'ideas.digests', { limit: 2 }), call('c', 'ideas.digests', { limit: '1' }),
    call('d', 'ideas.digests', { limit: 0 }), call('e', 'ideas.digests', { limit: 'abc' }), call('f', 'ideas.digests', { limit: 1000 }), call('g', 'ideas.digests', { limit: -3 }), call('h', 'ideas.digests', { limit: 1.9 }), call('i', 'ideas.digests', { limit: null }),
    call('j', 'ideas.digests', { limit: true }), call('k', 'ideas.digests', { x: 1 })],
});

// ---- ideas.similar_trades
const FLY = { sec_type: 'BAG', symbol: 'spx', action: 'BUY', limit_price: 2.5, expiry: '20261014', right: 'C', combo_strategy: 'BUTTERFLY', legs: [{ action: 'BUY', ratio: 1, strike: 7500, right: 'C' }, { action: 'SELL', ratio: 2, strike: 7525, right: 'C' }, { action: 'BUY', ratio: 1, strike: 7550, right: 'C' }] };
const STK = { sec_type: 'STK', symbol: 'nvda', action: 'BUY' };
const OPT = { sec_type: 'OPT', symbol: 'AAPL', action: 'BUY', limit_price: 1.2, expiry: '20261016', right: 'C', legs: [{ action: 'BUY', ratio: 1, strike: 190, right: 'C' }] };
const VERT = { sec_type: 'BAG', symbol: 'SPX', action: 'BUY', limit_price: 3, expiry: '20261014', combo_strategy: 'VERTICAL', legs: [{ action: 'BUY', ratio: 1, strike: 7500, right: 'C' }, { action: 'SELL', ratio: 1, strike: 7525, right: 'C' }] };
const SIMFACTS = [FACT('ib:1', { symbol: 'NVDA', kind: 'stock', label: 'NVDA 做多', result: 'win' }), FACT('stk:2', { kind: 'stock', symbol: 'AMD', label: 'AMD 做多', result: 'loss', return_pct: -2 }), FACT('stk:3', { kind: 'stock', symbol: 'NVDA', label: 'NVDA 做多', result: 'flat', return_pct: 0 })];
add('ideas.similar_trades:各票据种类;股票按自定义板块列出同板块;spot / 区间走替身;lessons 取提到标的的归档想法', {
  ports: {
    'tradeHistory.load': [TH(SIMFACTS), TH(SIMFACTS), TH([]), TH(SIMFACTS), TH(SIMFACTS), TH(SIMFACTS), TH(SIMFACTS), TH(SIMFACTS), { error: '库读不了' }],
    'similarContext.spot': [{ value: 7510 }, { value: null }, { error: '无行情' }],
    'similarContext.flyEntryUnderlyings': [{ value: { 'ib:9': 7498 } }, { value: {} }],
    'similarContext.stockRanges': [{ value: { query: 0.8, byId: { 'ib:1': 0.2, 'stk:3': 0.9 } } }, { value: { query: null, byId: {} } }, { error: '无日线' }],
  },
  steps: [...SEEDED, { op: 'store', m: 'addSector', a: ['AI'] }, { op: 'store', m: 'setSectorStocks', a: [ID(9), [{ symbol: 'NVDA', company: 'N', reason: 'r', tag: 't' }, { symbol: 'amd', company: 'A', reason: 'r', tag: 't' }, { symbol: 'NVDA' }, { symbol: '' }]] },
    call('a', 'ideas.similar_trades', STK), call('b', 'ideas.similar_trades', { ...STK, sec_type: 'stk', symbol: ' amd ' }), call('c', 'ideas.similar_trades', FLY), call('d', 'ideas.similar_trades', FLY), call('e', 'ideas.similar_trades', OPT),
    call('f', 'ideas.similar_trades', VERT), call('g', 'ideas.similar_trades', { ...STK, symbol: 'ZZZ' }), call('h', 'ideas.similar_trades', { ...FLY, limit_price: null, expiry: null }), call('i', 'ideas.similar_trades', STK),
    call('j', 'ideas.similar_trades', { ...STK, symbol: '  ' }), call('k', 'ideas.similar_trades', { ...STK, symbol: '' }), call('l', 'ideas.similar_trades', { sec_type: 'STK' }), call('m', 'ideas.similar_trades', { ...STK, extra: 1, legs: [{ action: 'BUY' }] }),
    call('n', 'ideas.similar_trades', { ...STK, limit_price: 'x' }), call('o', 'ideas.similar_trades', { ...STK, symbol: 'nvda' })],
});
add('ideas.similar_trades:蝴蝶 / 股票走不同的行情替身分支;替身抛错照抛', {
  ports: { 'tradeHistory.load': [TH(SIMFACTS), TH(SIMFACTS), TH(SIMFACTS)], 'similarContext.spot': [{ error: 'spot 坏了' }], 'similarContext.stockRanges': [{ error: 'ranges 坏了' }], 'similarContext.flyEntryUnderlyings': [{ error: 'fly 坏了' }] },
  steps: [call('a', 'ideas.similar_trades', FLY), call('b', 'ideas.similar_trades', STK), call('c', 'ideas.similar_trades', OPT), call('d', 'ideas.similar_trades', { ...FLY, symbol: 'spx' })],
});

// ---- 条数上限(520 条想法;不 dump 想法表,免得每步整张重读)
add('条数上限:list 默认 200 / 封顶 500;search 默认 50 / 封顶 200;lessons 取 3 条', {
  dump: ['audit_log'],
  llm: [{ value: DIGEST_A }],
  ports: { 'ideaSemantic.rank': [{ value: null }], 'tradeHistory.load': [TH(SIMFACTS)], 'similarContext.stockRanges': [{ value: { query: null, byId: {} } }] },
  steps: [...Array.from({ length: 520 }, (_, i) => [idea(`NVDA 想法 ${i}`, ['NVDA']), { op: 'store', m: 'setIdeaStatus', a: [ID(i + 1), 'archived'] }, { op: 'advance', ms: 60_000 }]).flat(),
    call('a', 'ideas.list', {}), call('b', 'ideas.list', { limit: 600 }), call('c', 'ideas.list', { limit: 500 }), call('d', 'ideas.list', { limit: 499 }),
    call('e', 'ideas.search', {}), call('f', 'ideas.search', { limit: 1000 }), call('g', 'ideas.search', { limit: 200 }), call('h', 'ideas.search', { q: 'NVDA', limit: 300 }), call('i', 'ideas.search', { q: '想法', symbols: 'NVDA' }),
    call('j', 'ideas.similar_trades', { sec_type: 'STK', symbol: 'nvda', action: 'BUY' }), call('k', 'ideas.digest', { scope: 'archived' }), call('l', 'ideas.digest', { scope: 'all', focus: { symbols: ['NVDA'] } })],
});
add('ideas.digests 条数:默认 20、封顶 100(105 份总结)', {
  dump: ['audit_log'],
  llm: [{ value: DIGEST_A }],
  steps: [idea('NVDA 看多', ['NVDA']), status(1, 'archived'), ...Array.from({ length: 105 }, (_, i) => [call(`d${String(i).padStart(3, '0')}`, 'ideas.digest', { scope: 'archived' }), { op: 'advance', ms: 1000 }]).flat(),
    call('a', 'ideas.digests', {}), call('b', 'ideas.digests', { limit: 1000 }), call('c', 'ideas.digests', { limit: 100 })],
});

// ---- 固定种子的随机参数
{
  const r = rng(20261021);
  const junk = () => r.pick([undefined, null, '', ' ', 0, 1, -1, 2.5, 1e9, '3', 'abc', true, false, [], ['a'], [1, 'b'], {}, { q: 'x' }, '好'.repeat(2500), '😀'.repeat(30), 'NVDA', 'archived', 'done', 'all', '2026-10-15', '2026-02-30', ID(1), ID(2), 'x'.repeat(300)]);
  const METHODS = { 'ideas.add': ['text'], 'ideas.list': ['status', 'limit'], 'ideas.update': ['id', 'status'], 'ideas.analyze': ['id'], 'ideas.digest': ['scope', 'focus', 'trades'], 'ideas.digests': ['limit'], 'ideas.search': ['q', 'symbols', 'since', 'until', 'status', 'limit'], 'ideas.similar_trades': ['sec_type', 'symbol', 'action', 'limit_price', 'expiry', 'right', 'combo_strategy', 'legs'] };
  const names = Object.keys(METHODS);
  const steps = [...SEEDED];
  for (let i = 0; i < 90; i += 1) {
    const m = r.pick(names);
    const a = {};
    for (const k of METHODS[m]) if (r.chance(0.6)) a[k] = junk();
    if (r.chance(0.1)) steps.push(call(`z${String(i).padStart(3, '0')}`, m, junk()));
    else steps.push(call(`z${String(i).padStart(3, '0')}`, m, a));
  }
  add('随机参数(固定种子 20261021):字符串 / 数字 / null / 数组 / 超长乱抛,专打 schema 与 JS 取值路径', {
    llm: [{ value: GOOD_A }, { value: DIGEST_A }, { error: '超时' }, { value: DIGEST_A }, { value: GOOD_A }],
    ports: { 'ideaSemantic.rank': [{ value: null }, { value: { [ID(2)]: 1 } }], 'tradeHistory.load': [TH(SIMFACTS), TH([])], 'similarContext.spot': [{ value: 7500 }], 'similarContext.stockRanges': [{ value: { query: 0.5, byId: {} } }], 'similarContext.flyEntryUnderlyings': [{ value: {} }] },
    h2router: { sessions: 1, results: { historicalBars: [{ value: BARS }] } },
    steps: [{ op: 'h2router', v: 'make' }, ...steps],
  });
}

const out = [];
for (const s of scenarios) {
  if (process.env.ONLY && !s.name.includes(process.env.ONLY)) continue;
  const expected = await h2.run(s.script);
  out.push({ name: s.name, script: enc(s.script), expected: enc(expected) });
}
const text = JSON.stringify({ base: BASE_CONFIG, scenarios: out });
writeFileSync(join(here, 'h2_ideas.json'), text);
console.log(`h2_ideas.json:${out.length} 个场景,${(text.length / 1024).toFixed(0)} KB`);
