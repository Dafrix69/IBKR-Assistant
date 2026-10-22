// 生成 track-actions.json:追踪卡片上三个按钮按下去做什么(desktop/renderer-react/src/lib/TrackCard.tsx 的 toggle / closeNow / remove)。
// 「立即平仓」会真的发单,所以和 gen_track_form.mjs 一样:把原文件里的三个函数原样切出来,依赖换成记录调用的假货,每个场景记下每一步。
//   node native/tests/fixtures/gen_track_actions.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const lib = join(here, '..', '..', '..', 'desktop/renderer-react/src/lib');
const src = readFileSync(join(lib, 'TrackCard.tsx'), 'utf8');
const fn = (name) => {
  const i = src.indexOf(`  async function ${name}() {`);
  if (i < 0) throw new Error(`TrackCard.tsx 里找不到 ${name}()`);
  const j = src.indexOf('\n  }\n', i);
  return src.slice(i, j + 4);
};
const body = ['toggle', 'closeNow', 'remove'].map(fn).join('\n');
if (/\(\w+: |\): /.test(body)) throw new Error('三个函数里有类型标注,要先去掉');
// legLabel 同 gen_track_rules.mjs:从同一个文件切出来
const ls = src.indexOf('export function legLabel(');
const legLabel = new Function(`${src.slice(ls, src.indexOf('\n}\n', ls) + 2).replace('export function legLabel(symbol: string, secType: string, contract?: Record<string, unknown>): string {', 'function legLabel(symbol, secType, contract) {')}; return legLabel;`)();
const make = new Function('t', 'dafri', 'loadTracker', 'loadRecords', 'showBanner', 'errorMessage', 'setBusy', 'legLabel', `${body}\n  return { toggle, closeNow, remove };`);

const tracks = {
  nvda: { id: 'tk1', symbol: 'NVDA', sec_type: 'STK', account: 'IBKR模拟', contract: { secType: 'STK' }, enabled: true },
  paused: { id: 'tk3', symbol: 'NVDA', sec_type: 'STK', account: 'IBKR模拟', contract: {}, enabled: false },
  fly: { id: 'tk2', symbol: 'SPX', sec_type: 'BAG', account: '模拟', contract: { label: '买入看涨蝴蝶 7725/7750/7775' }, enabled: 1 },
  opt: { id: 'tk4', symbol: 'AAPL', sec_type: 'OPT', account: '主账户', contract: { lastTradeDateOrContractMonth: '20260918', strike: 320, right: 'C' }, enabled: true },
};
// 场景:按哪个钮、哪张卡、确认框点什么、引擎回什么('throw:原因' = 报错)
const scenarios = [
  ['暂停', 'toggle', 'nvda', [], {}],
  ['恢复', 'toggle', 'paused', [], {}],
  ['暂停失败', 'toggle', 'nvda', [], 'throw:引擎忙'],
  ['立即平仓:点了取消', 'closeNow', 'fly', [false], null],
  ['立即平仓', 'closeNow', 'fly', [true], { fired: { reason: '手动平仓' } }],
  ['立即平仓:回执没有原因', 'closeNow', 'opt', [true], {}],
  ['立即平仓:被拒', 'closeNow', 'nvda', [true], 'throw:熔断中,不发单'],
  ['删除:点了取消', 'remove', 'nvda', [false], null],
  ['删除', 'remove', 'fly', [true], {}],
  ['删除失败', 'remove', 'opt', [true], 'throw:没有这条追踪'],
];
const cases = [];
for (const [name, action, key, confirms, result] of scenarios) {
  const calls = [];
  const answers = [...confirms];
  const reply = (call) => async (...args) => {
    calls.push({ call, args: JSON.parse(JSON.stringify(args)) });
    if (typeof result === 'string') throw new Error(result.slice(6));
    return result;
  };
  const dafri = {
    confirm: async (opts) => { calls.push({ call: 'confirm', ...opts }); return answers.shift() ?? false; },
    updateTracker: reply('updateTracker'), closePositionNow: reply('closePositionNow'), deleteTracker: reply('deleteTracker'),
  };
  const fns = make(tracks[key], dafri,
    async (refresh) => calls.push({ call: 'reload', refresh }), async () => calls.push({ call: 'records' }),
    (text, info) => calls.push({ call: 'banner', text, info: Boolean(info) }), (err) => err.message,
    (b) => calls.push({ call: 'busy', busy: b }), legLabel);
  await fns[action]();
  cases.push({ name, action, track: tracks[key], confirms, result, calls });
}
writeFileSync(join(here, 'track-actions.json'), JSON.stringify({ generator: 'native/tests/fixtures/gen_track_actions.mjs', cases }, null, 2) + '\n');
console.log(`track-actions.json: ${cases.length} 个场景`);
