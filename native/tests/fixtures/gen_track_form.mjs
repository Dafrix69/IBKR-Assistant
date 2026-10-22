// 生成 track-form.json:「新建追踪」表单按下「开始追踪」之后真的会做什么(desktop/renderer-react/src/lib/TrackForm.tsx 的 start())。
// 这是钱路径:tracker.add 是在授权软件到价自动发单。所以不手写期望值,而是**把原文件里的 start() 原样切出来跑**:
// 依赖换成记录调用的假货(试算、确认框、建追踪、横幅),每个场景记下它问了什么、确认框上写了什么、发出去的载荷是什么。
// 每一份载荷再拿引擎的 zod schema(engine-ts/src/contract/schema/tracker.ts,.strict())真校验一遍,结果一并写进文件。
//   [ENGINE_MODULES=<装好依赖的 engine-ts/node_modules>] node native/tests/fixtures/gen_track_form.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
// 引擎的源码用 .js 后缀 import .ts;zod 可能被 iCloud 收走,ENGINE_MODULES 指一份没被收走的
const engineModules = process.env.ENGINE_MODULES || join(repo, 'engine-ts/node_modules');
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'zod') return { url: pathToFileURL(join(engineModules, 'zod/index.js')).href, shortCircuit: true, format: 'module' };
    if (spec.endsWith('.js') && ctx.parentURL?.includes('/engine-ts/src/')) {
      const ts = fileURLToPath(new URL(spec, ctx.parentURL)).replace(/\.js$/, '.ts');
      if (existsSync(ts)) return { url: pathToFileURL(ts).href, shortCircuit: true };
    }
    return next(spec, ctx);
  },
});
const lib = join(repo, 'desktop/renderer-react/src/lib');
const X = await import(join(lib, 'trackExitForm.ts'));
const S = await import(join(lib, 'spotStopFormat.ts'));
const { TrackerAddParamsSchema } = await import(join(repo, 'engine-ts/src/contract/schema/tracker.ts'));

// ---- 把 start() 与它用到的几个派生量原样切出来
const src = readFileSync(join(lib, 'TrackForm.tsx'), 'utf8');
const slice = (from, to) => {
  const i = src.indexOf(from);
  const j = src.indexOf(to, i);
  if (i < 0 || j < 0) throw new Error(`TrackForm.tsx 里找不到 ${from}`);
  return src.slice(i, j);
};
const line = (prefix) => {
  const m = src.split('\n').find((l) => l.trim().startsWith(prefix));
  if (!m) throw new Error(`TrackForm.tsx 里找不到 ${prefix}`);
  return m.trim();
};
let start = slice('  async function start() {', '\n  const num = (');
// 去掉 TypeScript 的写法(只有这三处);改了原文件这里对不上就当场报错
const strip = [['const spec: TrackerAddSpec = {', 'const spec = {'], ['let quoted: SpotTargetRow | null = null;', 'let quoted = null;'], ['spotTarget!', 'spotTarget']];
for (const [a, b] of strip) {
  if (!start.includes(a)) throw new Error(`start() 里找不到 ${a}`);
  start = start.replace(a, b);
}
// 载荷建好的那一刻记一份(不管后面发没发出去)
start = start.replace('\n    const problems = exitProblems(', '\n    __spec(spec);\n    const problems = exitProblems(');
const derived = ['const long =', 'const isCombo =', 'const auto =', 'const hasSpotTarget =', 'const hostAllowed =', 'const hostOn =', 'const derivative =', 'const str ='].map(line).join('\n')
  .replace('const str = (v: number | null) =>', 'const str = (v) =>');
if (/\(\w+: /.test(derived)) throw new Error(`派生量里还有类型标注:${derived}`);
const deps = ['p', 'status', 'autoPicked', 'tp', 'sl', 'trail', 'profitDd', 'ddArm', 'tiers', 'spotTarget', 'stopBelow', 'stopAbove', 'fraction', 'chaseMax', 'orderType', 'host', 'exits',
  'dafri', 'showBanner', 'setSaving', 'loadTracker', 'onCreated', 'fmtNum', 'fmtMoney', 'spotStopConfirmLine', 'exitConfirmLines', 'exitProblems', 'exitSpec', 'errorMessage', '__spec'];
const make = new Function(...deps, `${derived}\n${start}\n  return start;`);

// ---- format.ts 的两个(它引 dayjs,这里不必:这两个函数不碰日期)。照原文切出来
const fmtSrc = readFileSync(join(lib, 'format.ts'), 'utf8');
const fn = (name) => {
  const i = fmtSrc.indexOf(`export function ${name}(`);
  const body = fmtSrc.slice(i, fmtSrc.indexOf('\n}\n', i) + 2).replace('export ', '').replace(/\(value: unknown(, digits = 2)?\): string/, (_m, d) => `(value${d ? ', digits = 2' : ''})`);
  return new Function(`${body}; return ${name};`)();
};
const fmtNum = fn('fmtNum');
const fmtMoney = fn('fmtMoney');

const positions = {
  stk: { key: 'k:NVDA', symbol: 'NVDA', sec_type: 'STK', quantity: 100, account: '模拟' },
  short: { key: 'k:TSLA', symbol: 'TSLA', sec_type: 'STK', quantity: -50, account: '主账户' },
  opt: { key: 'k:SPXC', symbol: 'SPX', sec_type: 'OPT', quantity: 2, account: '主账户' },
  bag: { key: 'k:SPXFLY', symbol: 'SPX', sec_type: 'BAG', quantity: 1, account: '主账户' },
};
const E = X.emptyExitFields;
// 表单每一项的初值照原文件的 useState(...) 现算(组合的平仓方式默认限价就在这里),不手抄:C++ 的 FormState 缺省值要和它一样
const stateDefaults = [...src.matchAll(/const \[(\w+), \w+\] = useState(?:<[^>]*>)?\((.*)\);/g)]
  .filter(([, name]) => !['preview', 'previewErr', 'saving'].includes(name));
const defaultsFor = (p) => {
  const isCombo = new Function('p', `return ${line('const isCombo =').replace('const isCombo =', '').replace(/;$/, '')}`)(p);
  const out = {};
  for (const [, name, init] of stateDefaults) out[name] = new Function('p', 'isCombo', 'emptyExitFields', `return ${init};`)(p, isCombo, X.emptyExitFields);
  return out;
};
const quote = { price: 5.2, pnl: 340, pnl_pct: 65.4, natural: 4.9, sigma_source: 'smile', spot: 7712.4 };
// 每个场景:position、表单的值、试算回什么(数组按调用次序;'throw:原因' = 报错)、确认框点什么、建追踪回什么
const scenarios = [
  ['仅提醒的正股', 'stk', { tp: 200, sl: 170 }, [], [], { track: { id: 't1' } }],
  ['正股开自动平仓', 'stk', { sl: 170, trail: 5, autoPicked: true }, [], [true], { track: { id: 't2' } }],
  ['全局自动执行开着:默认打开', 'stk', { sl: 170, status: { auto_execute: true } }, [], [true], { track: { id: 't2b' } }],
  ['确认框点了取消', 'stk', { sl: 170, autoPicked: true }, [], [false], null],
  ['托管却没开自动平仓', 'stk', { sl: 170, host: true }, [], [], null],
  ['正股托管', 'stk', { tp: 200, sl: 170, host: true, autoPicked: true, orderType: 'LMT' }, [], [true], { track: { id: 't3' } }],
  ['空头正股', 'short', { tp: 250, sl: 300, fraction: 50, autoPicked: true }, [], [true], {}],
  ['期权按标的目标价', 'opt', { spotTarget: 7750, autoPicked: true, chaseMax: 20 }, [{ spot_target: quote }], [true], { track: { id: 't4' } }],
  ['试算是模型默认波动率', 'opt', { spotTarget: 7750, autoPicked: true }, [{ spot_target: { ...quote, sigma_source: 'clock' } }], [], null],
  ['试算带警告', 'opt', { spotTarget: 7750, autoPicked: true }, [{ spot_target: { ...quote, warning: '盘口太宽,这个价不可信' } }], [], null],
  ['试算报错', 'opt', { spotTarget: 7750, autoPicked: true }, ['throw:读道满了'], [], null],
  ['试算算不出价', 'opt', { spotTarget: 7750, autoPicked: true }, [{ spot_target: { price: null, reason: '行情断了' } }], [], null],
  ['试算算不出价也没原因', 'opt', { spotTarget: 7750, autoPicked: true }, [{ spot_target: null }], [], null],
  ['目标价但只提醒:不试算', 'opt', { spotTarget: 7750, tp: 9 }, [], [], { track: { id: 't5' } }],
  ['组合托管、盘外推算', 'bag', { spotTarget: 7725, host: true, autoPicked: true, orderType: 'LMT', stopBelow: 7680 },
    [{ spot_target: { ...quote, spot_note: '盘外按 ES 推算', spot: 7701.25 } }], [true], { track: { id: 't6' } }],
  ['组合没目标价不能托管', 'bag', { host: true, autoPicked: true, sl: 1.2, orderType: 'LMT' }, [], [true], { track: { id: 't7' } }],
  ['组合不改平仓方式:默认限价', 'bag', { sl: 1.2, autoPicked: true }, [], [true], { track: { id: 't7b' } }],
  ['正股不改平仓方式:默认市价', 'stk', { sl: 170, autoPicked: true }, [], [true], { track: { id: 't7c' } }],
  ['分档利润回撤', 'bag', { tiers: true, profitDd: 30, autoPicked: true, orderType: 'LMT' }, [], [true], { track: { id: 't8' } }],
  ['利润回撤带门槛', 'opt', { profitDd: 30, ddArm: 15 }, [], [], { track: { id: 't9' } }],
  ['利润回撤清空门槛', 'opt', { profitDd: 30, ddArm: null }, [], [], { track: { id: 't10' } }],
  ['出场细则有毛病', 'opt', { exits: { ...E, exitAt: '25:00' }, autoPicked: true }, [], [], null],
  ['出场细则齐全', 'opt', { stopBelow: 7650, stopAbove: 7800, autoPicked: true,
    exits: { ...E, exitAt: '15:45', stopConfirm: 5, stopBasis: 'natural', chaseGrace: 3, chaseStep: 2, chaseMax: 40, peakConfirm: true, tiers: [{ price: 8, fraction: 50 }] } },
    [], [true], { track: { id: 't11' } }],
  ['正股止损确认却没止损', 'stk', { exits: { ...E, stopConfirm: 5 } }, [], [], null],
  ['正股止损确认', 'stk', { sl: 170, exits: { ...E, stopConfirm: 5 }, autoPicked: true }, [], [true], { track: { id: 't12' } }],
  ['建追踪被引擎拒', 'stk', { sl: 170 }, [], [], 'throw:止损价要低于现价'],
  ['小数与零', 'opt', { tp: 0.05, sl: 0, trail: 12.5, fraction: 100, chaseMax: 0 }, [], [], { track: { id: 't13' } }],
];

const cases = [];
let problems = 0;
for (const [name, posKey, values, previews, confirms, addResult] of scenarios) {
  const calls = [];
  let spec = null;
  const queue = [...previews];
  const answers = [...confirms];
  const dafri = {
    previewSpotTarget: async (key, target, chaseMax) => {
      calls.push({ call: 'preview', key, target, chaseMax: chaseMax ?? null });
      const r = queue.shift();
      if (typeof r === 'string' && r.startsWith('throw:')) throw new Error(r.slice(6));
      return r;
    },
    confirm: async (opts) => {
      calls.push({ call: 'confirm', ...opts });
      return answers.shift() ?? false;
    },
    addTracker: async (s) => {
      calls.push({ call: 'add', spec: s });
      if (typeof addResult === 'string') throw new Error(addResult.slice(6));
      return addResult;
    },
  };
  const v = { ...defaultsFor(positions[posKey]), status: { auto_execute: false }, ...values };
  const run = make(positions[posKey], v.status, v.autoPicked, v.tp, v.sl, v.trail, v.profitDd, v.ddArm, v.tiers, v.spotTarget, v.stopBelow, v.stopAbove, v.fraction, v.chaseMax,
    v.orderType, v.host, v.exits, dafri,
    (text, info) => calls.push({ call: 'banner', text, info: Boolean(info) }),
    (on) => calls.push({ call: 'saving', on }),
    async (refresh) => calls.push({ call: 'reload', refresh }),
    (id) => calls.push({ call: 'created', id }),
    fmtNum, fmtMoney, S.spotStopConfirmLine, X.exitConfirmLines, X.exitProblems, X.exitSpec, (err) => err.message, (s) => { spec = s; });
  await run();
  // 载荷里 undefined 的键在线上不存在(JSON 序列化丢掉,IPC 再转 JSON 给引擎时同样没有)
  const wire = spec ? JSON.parse(JSON.stringify(spec)) : null;
  const parsed = wire ? TrackerAddParamsSchema.safeParse(wire) : null;
  if (parsed && !parsed.success) problems += 1;
  const { status: _s, ...given } = values;
  cases.push({ name, position: positions[posKey], values: given, autoExecute: v.status.auto_execute, previews, confirms, addResult,
    spec: wire, schemaOk: parsed ? parsed.success : null, schemaIssues: parsed && !parsed.success ? parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) : [],
    calls: JSON.parse(JSON.stringify(calls)) });
}
const defaults = Object.fromEntries(Object.entries(positions).map(([k, p]) => [k, { position: p, values: defaultsFor(p) }]));
writeFileSync(join(here, 'track-form.json'), JSON.stringify({ generator: 'native/tests/fixtures/gen_track_form.mjs', defaults, cases }, null, 2) + '\n');
console.log(`track-form.json: ${cases.length} 个场景,schema 不认的载荷 ${problems} 份`);
