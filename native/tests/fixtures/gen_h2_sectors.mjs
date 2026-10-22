// 生成 h2_sectors.json:engine-ts 的 sectors.ts(sectors.* 与 pool.set_watch,原类现跑)对着 h2_world.mjs 的假 RpcContext;库是真的(临时库)。
// C++ 一半:tests/tst_h2_sectors.cpp。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_h2_sectors.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_CONFIG, enc, loadH2 } from './h2_world.mjs';
import { rng } from './broker_world.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const h2 = await loadH2(engine);

const START = Date.parse('2026-10-12T10:30:00-04:00');
const DUMP = ['audit_log', 'app_prefs', 'alert_watches', 'quality_stocks', 'sectors'];
const call = (id, m, a = {}) => ({ op: 'call', id, m, a });
const st = (m, a) => ({ op: 'store', m, a });
const scenarios = [];
const add = (name, script) => scenarios.push({ name, script: { start: START, dump: DUMP, ...script } });
const S1 = '00000000-0000-4000-8000-000000000001';
const S2 = '00000000-0000-4000-8000-000000000002';
const stock = (symbol, company = '', tag = '') => ({ symbol, company, reason: '手动添加', tag });
const WATCH = (symbol, skipped = []) => ({ value: { symbol, price_on: true, anomaly_on: skipped.length === 0, skipped } });
const pick = (n) => ({ stocks: Array.from({ length: n }, (_, i) => ({ symbol: ['NVDA', 'AMD', 'AVGO', 'TSM', 'ASML', 'MU', 'QCOM', 'INTC', 'AMAT', 'LRCX', 'KLAC', 'MRVL', 'ARM', 'ON', 'TXN', 'ADI'][i], company: `公司${i}`, reason: `理由${i}`, tag: ['芯片', '设备', '存储'][i % 3] })) });
const fresh = { error: 'x' };
void fresh;

add('sectors.list / add:先迁移;名字怎么算重复 / 空 / 太长由库报;留痕', {
  steps: [call('a', 'sectors.list'), call('b', 'sectors.add', { name: 'AI 算力' }), call('c', 'sectors.add', { name: 'AI 算力' }), call('d', 'sectors.add', { name: '  ' }), call('e', 'sectors.add', { name: 'x'.repeat(40) }),
    call('f', 'sectors.add', { name: ' 光模块 ' }), call('g', 'sectors.add', {}), call('h', 'sectors.list')],
});
add('sectors.delete:先迁移;成分股记下来、板块没了之后交给池子收尾;找不到', {
  ports: { 'pool.dropWatches': [{ value: ['NVDA'] }, { value: [] }] },
  steps: [st('addSector', ['半导体']), st('setSectorStocks', [S1, [stock('NVDA', '英伟达'), stock('AMD')]]), st('addSector', ['空板块']),
    call('a', 'sectors.delete', { id: 'nope' }), call('b', 'sectors.delete', { id: ` ${S1} ` }), call('c', 'sectors.delete', { id: S2 }), call('d', 'sectors.delete', { id: S1 }), call('e', 'sectors.delete', {})],
});
add('sectors.pick:成功(去重、新股开默认开关并收集 skipped、被换下的老股交给池子收尾)', {
  ports: {
    'pool.setWatch': [WATCH('NVDA'), WATCH('AMD', ['价位提醒已满 30 只']), WATCH('AVGO'), WATCH('TSM', ['异动监控已满 30 只', '另一句'])],
    'pool.dropWatches': [{ value: ['OLD1'] }],
  },
  llm: [{ value: { stocks: [...pick(6).stocks, { symbol: 'NVDA', company: '重复', reason: 'dup', tag: '' }, { symbol: 'amd', company: '小写', reason: 'x', tag: '一二三四五六七八九十一二三四' }] } }],
  steps: [st('addSector', ['半导体']), st('setSectorStocks', [S1, [stock('OLD1'), stock('NVDA', '英伟达'), stock('OLD2')]]), call('a', 'sectors.pick', { id: S1 })],
});
add('sectors.pick:模型抛错 / 回包不合结构 / 板块不存在 / 等模型时板块被删了 / 解析器没脚本', {
  llm: [{ error: '调用超时' }, { error: 'boom', kind: 'rpc', code: -32011 }, { value: {} }, { value: { stocks: [] } }, { value: { stocks: [{ symbol: 'bad symbol!' }] } }, { value: { stocks: 'x' } }, { value: { stocks: pick(2).stocks, extra: 1 } },
    { value: pick(3), effects: [{ m: 'deleteSector', a: [S1] }] }],
  steps: [st('addSector', ['半导体']), call('a', 'sectors.pick', { id: S1 }), call('b', 'sectors.pick', { id: S1 }), call('c', 'sectors.pick', { id: S1 }), call('d', 'sectors.pick', { id: S1 }), call('e', 'sectors.pick', { id: S1 }),
    call('f', 'sectors.pick', { id: S1 }), call('g', 'sectors.pick', { id: S1 }), call('h', 'sectors.pick', { id: S1 }), call('i', 'sectors.pick', { id: 'nope' }), call('j', 'sectors.pick', {})],
});
add('sectors.add_stock:加进来就开两个开关;代码不合法 / 重复 / 满 30 只 / 板块不存在;公司名截 60;标签截 12', {
  ports: { 'pool.setWatch': [WATCH('NVDA'), WATCH('VRT', ['价位提醒已满']), { error: '池子坏了' }] },
  steps: [st('addSector', ['半导体']), call('a', 'sectors.add_stock', { id: S1, symbol: 'nvda', company: ' 英伟达 ', tag: '  芯片  ' }), call('b', 'sectors.add_stock', { id: S1, symbol: 'NVDA' }),
    call('c', 'sectors.add_stock', { id: S1, symbol: 'vrt', company: 'x'.repeat(100), tag: '一二三四五六七八九十一二三四五' }), call('d', 'sectors.add_stock', { id: S1, symbol: 'bad$' }), call('e', 'sectors.add_stock', { id: S1, symbol: '' }),
    call('f', 'sectors.add_stock', { id: 'nope', symbol: 'AMD' }), call('g', 'sectors.add_stock', { id: S1, symbol: 'amd' }), call('h', 'sectors.add_stock', { id: S1 }),
    ...Array.from({ length: 30 }, (_, i) => st('setSectorStocks', [S1, Array.from({ length: Math.min(30, 3 + i) }, (_, j) => stock(`A${String(j).padStart(2, '0')}`))])),
    call('i', 'sectors.add_stock', { id: S1, symbol: 'ZZZ' })],
});
add('sectors.remove_stock:先迁移;移出去的交给池子收尾;不在板块里 / 板块不存在;代码大小写与空白', {
  ports: { 'pool.dropWatches': [{ value: ['NVDA'] }, { value: [] }] },
  steps: [st('addSector', ['半导体']), st('setSectorStocks', [S1, [stock('NVDA'), stock('AMD')]]), call('a', 'sectors.remove_stock', { id: S1, symbol: ' nvda ' }), call('b', 'sectors.remove_stock', { id: S1, symbol: 'NVDA' }),
    call('c', 'sectors.remove_stock', { id: 'nope', symbol: 'AMD' }), call('d', 'sectors.remove_stock', { id: S1, symbol: 'AMD' }), call('e', 'sectors.remove_stock', { id: S1 })],
});
add('sectors.quotes:没成分股 / 没连券商 / 连着(去重排序)/ 券商抛错', {
  h2router: { sessions: 1, results: { stockQuotes: [{ value: { AMD: { last: 100 }, NVDA: { last: 200 } } }, { error: '行情断了', kind: 'broker' }] } },
  steps: [call('a', 'sectors.quotes'), st('addSector', ['半导体']), st('addSector', ['AI']), st('setSectorStocks', [S1, [stock('NVDA'), stock('AMD'), stock('')]]), st('setSectorStocks', [S2, [stock('AMD'), stock('AAPL')]]),
    call('b', 'sectors.quotes'), { op: 'h2router', v: 'make' }, call('c', 'sectors.quotes'), call('d', 'sectors.quotes'), { op: 'h2routerSet', set: { sessions: 0 } }, call('e', 'sectors.quotes'), { op: 'h2router', v: 'null' }, call('f', 'sectors.quotes')],
});
add('sectors.set_tag:标签截 12、空串清掉;找不到板块 / 不在板块', {
  steps: [st('addSector', ['半导体']), st('setSectorStocks', [S1, [stock('NVDA', '', '旧'), stock('AMD')]]), call('a', 'sectors.set_tag', { id: S1, symbol: 'nvda', tag: '  数据中心  ' }), call('b', 'sectors.set_tag', { id: S1, symbol: 'NVDA', tag: '' }),
    call('c', 'sectors.set_tag', { id: S1, symbol: 'amd' }), call('d', 'sectors.set_tag', { id: S1, symbol: 'TSLA', tag: 'x' }), call('e', 'sectors.set_tag', { id: 'nope', symbol: 'AMD', tag: 'x' }), call('f', 'sectors.set_tag', { id: S1, symbol: 'amd', tag: '一二三四五六七八九十一二三四' })],
});
add('pool.set_watch:两个开关至少一个;null 当没传;返回池子的回执;代码不合法', {
  ports: { 'pool.setWatch': [WATCH('NVDA'), { value: { symbol: 'AMD', price_on: false, anomaly_on: true, skipped: [] } }, { error: '指数不能盯异动', kind: 'rpc', code: -32602 }] },
  steps: [call('a', 'pool.set_watch', { symbol: 'nvda', price: true }), call('b', 'pool.set_watch', { symbol: 'AMD', anomaly: true, price: false }), call('c', 'pool.set_watch', { symbol: 'spx', anomaly: true }),
    call('d', 'pool.set_watch', { symbol: 'AMD' }), call('e', 'pool.set_watch', { symbol: 'AMD', price: null, anomaly: null }), call('f', 'pool.set_watch', { symbol: 'bad$', price: true }), call('g', 'pool.set_watch', { price: true }),
    call('h', 'pool.set_watch', { symbol: 'AMD', price: 1 })],
});

// ---- 固定种子的随机参数
{
  const r = rng(0x5ec7_0a1f);
  const junk = () => r.pick(['', ' ', 'NVDA', 'nvda ', 'bad$', 'x'.repeat(14), 0, 1, 5, '7', 'abc', true, false, null, [], {}, 'é', S1, S2, ` ${S1} `, '一二三四五六七八九十一二三四五六']);
  for (let n = 0; n < 40; n += 1) {
    const steps = [st('addSector', ['半导体']), st('addSector', ['AI'])];
    for (let i = 0; i < r.int(5); i += 1) steps.push(st('setSectorStocks', [r.pick([S1, S2]), Array.from({ length: r.int(5) }, () => stock(r.pick(['NVDA', 'AMD', 'AVGO', 'TSM']), '', r.pick(['', '芯片'])))]));
    for (let i = 0; i < 12; i += 1) {
      const m = r.pick(['sectors.list', 'sectors.add', 'sectors.delete', 'sectors.add_stock', 'sectors.remove_stock', 'sectors.set_tag', 'pool.set_watch', 'sectors.quotes', 'sectors.pick']);
      const p = {};
      for (const k of r.pick([['id'], ['name'], ['id', 'symbol'], ['id', 'symbol', 'tag'], ['id', 'symbol', 'company', 'tag'], ['symbol', 'price', 'anomaly'], ['symbol', 'price'], []])) p[k] = r.chance(0.5) ? r.pick([S1, S2, 'NVDA', 'AMD']) : junk();
      steps.push(call(`c${i}`, m, p));
    }
    scenarios.push({
      name: `随机 ${n}`,
      script: {
        start: START, seed: n + 1, dump: DUMP, steps,
        ports: { 'pool.setWatch': [WATCH('NVDA'), WATCH('AMD', ['满了'])], 'pool.dropWatches': [{ value: ['NVDA'] }, { value: [] }] },
        llm: [{ value: pick(3) }, { error: 'boom' }],
        h2router: { sessions: 1, results: { stockQuotes: [{ value: { NVDA: { last: 1 } } }] } },
      },
    });
  }
}

const out = [];
for (const s of scenarios) {
  const expected = await h2.run(s.script);
  out.push({ name: s.name, script: enc(s.script), expected: enc(expected) });
}
const text = JSON.stringify({ base: BASE_CONFIG, scenarios: out });
writeFileSync(join(here, 'h2_sectors.json'), text);
console.log(`h2_sectors.json:${out.length} 个场景,${(text.length / 1024).toFixed(0)} KB`);
