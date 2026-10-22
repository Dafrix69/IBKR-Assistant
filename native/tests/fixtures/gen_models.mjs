// 生成 models.json:engine-ts/src/models.ts 的每个 zod schema(原模块现跑)在一大把输入上的 safeParse:成功时的输出,失败时每一条 issue 的
// code、path、message(先后照原样);外加 parseLlmPayload 在整段载荷上的结果。输入 = 每个 schema 几份合法的样子,
// 再把每个字段逐个换成一组坏值(缺、null、空串、带空白、数字串、0、负数、小数、超大、布尔、数组、对象、多出来的键……)。
//   node native/tests/fixtures/gen_models.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const M = await import(pathToFileURL(join(engine, 'dist/src/models.js')).href);

const leg = { action: 'BUY', ratio: 1, lastTradeDateOrContractMonth: '20261016', strike: 7800, right: 'C' };
const stk = { secType: 'STK', symbol: 'nvda ' };
const opt = { secType: 'OPT', symbol: 'SPX', lastTradeDateOrContractMonth: '20261016', strike: '7800', right: 'P', tradingClass: ' SPXW ', multiplier: '100.0' };
const bag = { secType: 'BAG', symbol: 'SPX', combo_strategy: 'BUTTERFLY', legs: [leg, { ...leg, action: 'SELL', ratio: '2', strike: 7815 }, { ...leg, strike: 7830 }] };
const order = { action: 'BUY', orderType: 'LMT', totalQuantity: 2, lmtPrice: 3.5 };
const parsed = { intent_summary: '买 SPX 蝶', contract: bag, execution_type: 'IMMEDIATE', order: { ...order, price_mode: 'AUTO_MID', lmtPrice: null }, confidence: '0.95' };
const trigger = { symbol: 'spx', secType: 'IND', operator: '>=', value: '7700' };
const examples = {
  LegSchema: [leg, { ...leg, ratio: '2', strike: ' 7815.5 ', tradingClass: 'SPXW', multiplier: '' }],
  ContractSpecSchema: [stk, opt, bag, { ...stk, exchange: ' ARCA ', currency: 'USD' }, { secType: 'BAG', symbol: 'SPX', combo_strategy: 'VERTICAL', legs: [leg, { ...leg, action: 'SELL', strike: 7810 }] },
    { secType: 'BAG', symbol: 'SPX', combo_strategy: 'IRON_CONDOR', legs: [leg, leg, leg, leg] }],
  TriggerSpecSchema: [trigger, { ...trigger, type: 'PRICE', secType: 'STK', operator: '<=', value: 1.5 }],
  OrderSpecSchema: [order, { action: 'SELL', orderType: 'MKT', totalQuantity: '5' }, { action: 'BUY', orderType: 'STP', totalQuantity: 1, auxPrice: 9.5 },
    { action: 'BUY', orderType: 'STP LMT', totalQuantity: 1, auxPrice: 9.5, lmtPrice: 9.6, tif: 'GTC', outsideRth: true },
    { action: 'SELL', orderType: 'TRAIL', totalQuantity: 1, trailingPercent: '5' }, { action: 'SELL', orderType: 'TRAIL', totalQuantity: 1, auxPrice: 2 },
    { action: 'BUY', orderType: 'LMT', totalQuantity: 1, price_mode: 'AUTO_MID' }],
  ParsedOrderSchema: [parsed, { intent_summary: ' 条件单 ', contract: opt, execution_type: 'CONDITIONAL', trigger, order, confidence: 0.9, account: ' 主账户 ', reason: ' r ', warnings: ['w'] }],
  RejectionSchema: [{ original_text: ' 买点 ', code: 'MISSING_PRICE', message: ' 缺价 ' }],
  StockPickSchema: [{ symbol: 'amd', company: ' AMD ', reason: ' 强 ', tag: '  数据中心芯片设计与制造龙头企业  ' }, { symbol: 'BRK.B' }],
  SectorPicksSchema: [{ stocks: [{ symbol: 'NVDA' }, { symbol: 'AMD', tag: '芯片' }] }],
  RuleOperandSchema: [{ kind: 'indicator', name: 'sma', period: 20 }, { kind: 'const', value: '70' }, { kind: 'indicator', name: 'close' }],
  RuleConditionSchema: [{ left: { kind: 'indicator', name: 'rsi', period: '14' }, op: '<', right: { kind: 'const', value: 30 } }],
  CustomRulesSchema: [{ entry: [{ left: { kind: 'indicator', name: 'close' }, op: 'cross_up', right: { kind: 'indicator', name: 'sma', period: 50 } }] }],
  BacktestInstrumentSchema: [{}, { type: 'butterfly', dte: '7', offset_pct: '-2.5', width_pct: 1, risk_pct: 5 }],
  IdeaAnalysisSchema: [{ summary: ' s ', thesis: 't', checks: ['a'], risks: [], suggestion: 'x' }],
  IdeaDigestSchema: [{ summary: 's', themes: ['a', 'b'], lessons: [], patterns: [], actions: ['x'] }],
  PACommentSchema: [{ summary: 's', reading: 'r', watch: ['w'], risks: ['k'] }],
  ParseResultSchema: [{ orders: [parsed], rejections: [{ original_text: 'x', code: 'UNCLEAR', message: 'm' }] }, {}],
};
const badValues = [undefined, null, '', '  ', ' 12 ', '12abc', '0x10', 'Infinity', '1e400', 0, -1, 0.5, 1.5, 2, 3, 100, 101, 1e21, true, false, [], [1], {}, { a: 1 }, 'buy', 'ZZZ', 'a'.repeat(13), '20261332', '2026101', '20260229', '20280229',
  '  20261016 ', 'SPX', 'spx.x', '1ABC', 'AB-C', '中文', 300, 365, 366, -30.5, 20.5, 251];
const cases = [];
const run = (name, input) => {
  const r = M[name].safeParse(input);
  cases.push({ schema: name, input: input === undefined ? '__undefined__' : input, ...(r.success ? { data: r.data } : { issues: r.error.issues.map((i) => [i.code, i.path.map(String), i.message]) }) });
};
for (const [name, exs] of Object.entries(examples)) {
  for (const ex of exs) {
    run(name, ex);
    run(name, { ...ex, extra_key: 1, Another: 2 });
    for (const key of Object.keys(ex).concat(['__absent__'])) {
      for (const bad of badValues) {
        const copy = structuredClone(ex);
        if (bad === undefined) delete copy[key]; else copy[key] = bad;
        run(name, copy);
      }
    }
  }
  for (const top of [null, undefined, 'x', 5, [], true]) run(name, top);
}
// 嵌套里的坏值:合约的腿、订单的子对象
for (const legBad of [{ ...leg, ratio: 3 }, { ...leg, right: 'X' }, { ...leg, strike: -1 }, { ...leg, lastTradeDateOrContractMonth: '20261399' }, 'leg', null]) {
  run('ContractSpecSchema', { ...bag, legs: [legBad, leg, leg] });
  run('ParsedOrderSchema', { ...parsed, contract: { ...bag, legs: [leg, legBad, leg] } });
}
for (const o of [{ ...order, lmtPrice: null }, { ...order, orderType: 'MKT' }, { ...order, orderType: 'TRAIL' }, { ...order, orderType: 'TRAIL', auxPrice: 1, trailingPercent: 2 }, { ...order, totalQuantity: 0 }, { ...order, extra: 1 }, { ...order, trailingPercent: 101 }])
  run('ParsedOrderSchema', { ...parsed, contract: opt, order: o });
run('ParsedOrderSchema', { ...parsed, execution_type: 'CONDITIONAL' });
run('ParsedOrderSchema', { ...parsed, trigger, contract: stk, order: { ...order, price_mode: 'AUTO_MID', lmtPrice: null }, account: '   ' });
run('ParsedOrderSchema', { ...parsed, contract: { ...stk, strike: 1, legs: [leg], combo_strategy: 'VERTICAL', extra: 1 }, order: { ...order, lmtPrice: 'abc', bogus: 1 }, confidence: 2 });
run('ContractSpecSchema', { secType: 'BAG', symbol: 'SPX', combo_strategy: 'BUTTERFLY', legs: [leg] });
run('ContractSpecSchema', { secType: 'BAG', symbol: 'SPX', legs: [leg, leg] });
run('ContractSpecSchema', { secType: 'BAG', symbol: 'SPX', strike: 5, combo_strategy: 'VERTICAL', legs: null });
run('ContractSpecSchema', { secType: 'OPT', symbol: 'SPX', legs: [], combo_strategy: null });
run('ContractSpecSchema', { secType: 'STK', symbol: 'X', legs: [], combo_strategy: null });
run('SectorPicksSchema', { stocks: Array.from({ length: 16 }, () => ({ symbol: 'A' })) });
run('CustomRulesSchema', { entry: [], exit: Array.from({ length: 7 }, () => ({ left: { kind: 'const', value: 1 }, op: '>', right: { kind: 'const', value: 2 } })) });
run('RuleOperandSchema', { kind: 'indicator', name: 'sma', period: 0 });
run('RuleOperandSchema', { kind: 'indicator', name: 'sma', period: null });
run('RuleOperandSchema', { kind: 'const', value: null, name: null });
run('IdeaAnalysisSchema', { summary: 's', checks: Array(9).fill('c') });
for (const q of ['1' + '0'.repeat(400), '-1', '+3', ' +2 ', '-0', '+', '1e3']) { run('OrderSpecSchema', { ...order, totalQuantity: q }); run('LegSchema', { ...leg, ratio: q }); }
run('ParseResultSchema', { orders: [{ ...parsed, confidence: 9 }, 'bad', { ...parsed, order: 5 }], rejections: [{ code: 'X' }, null] });
for (const ws of ['\ufeffAMD\ufeff', '\u0085AMD', '\u00a0amd\u3000', '\u2028x\u2029', '\u200bAMD', '\u180eA']) { run('StockPickSchema', { symbol: ws, company: ws }); run('LegSchema', { ...leg, lastTradeDateOrContractMonth: ws + '20261016' }); }
for (const ot of ['MKT', 'STP', 'TRAIL', 'STP LMT']) run('OrderSpecSchema', { action: 'BUY', orderType: ot, totalQuantity: 1, price_mode: 'AUTO_MID', auxPrice: 1, lmtPrice: 1 });

// parseLlmPayload
const payloads = [{ orders: [parsed, { ...parsed, confidence: 5 }, { intent_summary: '  ', original_text: 'o' }, 'not an object', { symbol: 'X'.repeat(300) }], rejections: [{ original_text: 'a', code: 'UNCLEAR', message: 'm' }, { code: 'BOGUS' }, 5], zeta: 1, alpha: 2 },
  {}, { orders: null, rejections: null }, { orders: {} }, { rejections: 'x' }, null, [], 'x', { orders: [{ ...parsed, contract: { ...bag, legs: [leg] }, order: { ...order, orderType: 'XX' }, intent_summary: 'a\nb' }] },
  { orders: [Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i]))] }, { orders: [{ ...parsed, 'a\nb': 1, 'c\nd': 2 }] }];
const llm = payloads.map((p) => { try { return { payload: p, out: M.parseLlmPayload(p) }; } catch (e) { return { payload: p, error: e.message }; } });
const mult = [{ multiplier: '100' }, { multiplier: '50' }, { multiplier: '0' }, { multiplier: '-5' }, { multiplier: 'abc' }, { multiplier: '' }, {}, { multiplier: '1e3' }].map((c) => ({ c, out: M.multiplierValue(c) }));
writeFileSync(join(here, 'models.json'), JSON.stringify({ cases, llm, mult }) + '\n');
console.log(`models.json:${cases.length} 次 safeParse(${cases.filter((c) => c.issues).length} 次没过),parseLlmPayload ${llm.length} 段`);
