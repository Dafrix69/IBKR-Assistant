// 生成 power.json:电源与合盖(desktop/power-watch.js、desktop/lid-guard.js)对一串串事件现算的输出,C++ 的 shell/power_guard 逐步对。
// 每个脚本 = 一串步骤 { op, args },每一步记下返回值与之后的状态。
//   node native/tests/fixtures/gen_power.mjs
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const req = createRequire(import.meta.url);
const PW = req(join(here, '..', '..', '..', 'desktop/power-watch.js'));
const LG = req(join(here, '..', '..', '..', 'desktop/lid-guard.js'));
const MIN = 60_000;

const powerScripts = [
  [{ op: 'observe', args: { onBattery: false } }, { op: 'observe', args: { live: 2 } }, { op: 'observe', args: { onBattery: true } }, { op: 'observe', args: { onBattery: true, live: 3 } },
    { op: 'observe', args: { onBattery: false } }, { op: 'observe', args: { onBattery: true, live: 1, lidAwake: true } }, { op: 'observe', args: { live: 0 } }],
  [{ op: 'observe', args: { onBattery: true } }, { op: 'observe', args: { live: 2.7 } }, { op: 'observe', args: { live: -3 } }, { op: 'observe', args: { live: 'x' } }, { op: 'observe', args: {} },
    { op: 'suspend', args: { now: 1000 } }, { op: 'resume', args: { now: 1000 + 45_400 } }, { op: 'resume', args: { now: 5 } },
    { op: 'suspend', args: { now: 0 } }, { op: 'resume', args: { now: 59.5 * MIN } }, { op: 'suspend', args: { now: 0 } }, { op: 'resume', args: { now: 135 * MIN + 29_000 } }],
  [{ op: 'suspend', args: { now: 0 } }, { op: 'observe', args: { live: 1 } }, { op: 'observe', args: { onBattery: true } }],
];
const lidScripts = [
  // 有追踪在盯 → 请求关;授权了 → 自己关的;没追踪满 10 分钟 → 请求恢复
  { init: {}, steps: [{ op: 'observe', args: { live: 2, sleepDisabled: false, now: 0 } }, { op: 'done', args: { on: true, outcome: 'ok' } },
    { op: 'observe', args: { live: 2, sleepDisabled: true, now: MIN } }, { op: 'observe', args: { live: 0, sleepDisabled: true, now: 2 * MIN } },
    { op: 'observe', args: { live: 0, sleepDisabled: true, now: 11 * MIN } }, { op: 'observe', args: { live: 0, sleepDisabled: true, now: 12 * MIN } },
    { op: 'done', args: { on: false, outcome: 'ok' } }, { op: 'observe', args: { live: 0, sleepDisabled: false, now: 13 * MIN } }] },
  // 授权框取消:这一段不再问;条数回到 0 再起来算新的一段
  { init: {}, steps: [{ op: 'observe', args: { live: 1, sleepDisabled: false, now: 0 } }, { op: 'done', args: { on: true, outcome: 'cancelled' } },
    { op: 'observe', args: { live: 1, sleepDisabled: false, now: MIN } }, { op: 'observe', args: { live: 0, now: 2 * MIN } }, { op: 'observe', args: { live: 3, sleepDisabled: false, now: 3 * MIN } },
    { op: 'done', args: { on: true, outcome: 'failed', detail: 'execution error' } }, { op: 'done', args: { on: true, outcome: 'failed' } }] },
  // 读不到 pmset:什么都不做;busy 时不再要;关掉开关当场恢复;恢复被取消:退出前不再问
  { init: { enabled: true, owned: true }, steps: [{ op: 'observe', args: { live: 0, now: 0 } }, { op: 'wantsReading', args: { live: 0 } },
    { op: 'observe', args: { live: 0, sleepDisabled: true, now: 1 } }, { op: 'setEnabled', args: { enabled: false } }, { op: 'observe', args: { live: 0, sleepDisabled: true, now: 2 } },
    { op: 'observe', args: { live: 0, sleepDisabled: true, now: 3 } }, { op: 'done', args: { on: false, outcome: 'cancelled' } }, { op: 'observe', args: { live: 0, sleepDisabled: true, now: 4 } },
    { op: 'quitAction', args: {} }, { op: 'setEnabled', args: { enabled: true } }, { op: 'quitAction', args: {} }, { op: 'done', args: { on: false, outcome: 'failed', detail: 'x' } }] },
  // 自己关的被人在终端里恢复:不再算自己的,这一段也不再去关
  { init: { enabled: true, owned: true }, steps: [{ op: 'observe', args: { live: 2, sleepDisabled: false, now: 0 } }, { op: 'state', args: {} },
    { op: 'observe', args: { live: 2, sleepDisabled: false, now: 1 } }, { op: 'quitAction', args: {} }, { op: 'wantsReading', args: { live: 2 } }] },
  // 开关关着:不去关;wantsReading
  { init: { enabled: false, owned: false }, steps: [{ op: 'wantsReading', args: { live: 5 } }, { op: 'observe', args: { live: 5, sleepDisabled: false, now: 0 } },
    { op: 'observe', args: { live: 2.9, sleepDisabled: true, now: 1 } }, { op: 'quitAction', args: {} }] },
];
const cases = [];
for (const steps of powerScripts) {
  const w = new PW.PowerWatch();
  cases.push({ kind: 'power', steps: steps.map((s) => {
    const out = s.op === 'observe' ? w.observe(s.args) : w[s.op](s.args.now);
    return { ...s, out, state: { onBattery: w.onBattery, live: w.live, warned: w.warned, lidAwake: w.lidAwake } };
  }) });
}
for (const script of lidScripts) {
  const g = new LG.LidGuard(script.init);
  cases.push({ kind: 'lid', init: script.init, steps: script.steps.map((s) => {
    let out;
    if (s.op === 'observe') out = g.observe(s.args);
    else if (s.op === 'done') out = g.done(s.args.on, s.args.outcome, s.args.detail);
    else if (s.op === 'setEnabled') out = g.setEnabled(s.args.enabled) ?? null;
    else if (s.op === 'wantsReading') out = g.wantsReading(s.args.live);
    else out = g[s.op]();
    return { ...s, out, state: { enabled: g.enabled, owned: g.owned, sleepDisabled: g.sleepDisabled, live: g.live, declined: g.declined, restoreDeclined: g.restoreDeclined, busy: g.busy } };
  }) });
}
const helpers = [];
for (const t of ['Sleep On\n SleepDisabled\t\t1\n', ' SleepDisabled 0', 'nothing here', '', 'SleepDisabled x', ' sleepdisabled 1']) helpers.push({ fn: 'parseSleepDisabled', input: t, out: LG.parseSleepDisabled(t) });
for (const on of [true, false]) helpers.push({ fn: 'pmsetScript', input: on, out: LG.pmsetScript(on) });
for (const e of [{ stderr: 'execution error: User canceled. (-128)' }, { message: '用户已取消。' }, { message: 'User cancelled' }, { stderr: 'boom', message: 'Command failed' }, {}]) helpers.push({ fn: 'isCancelled', input: e, out: LG.isCancelled(e) });
for (const ms of [0, 999, 45_400, 59_999, 60_000, 89_999, 59.5 * MIN, 135 * MIN + 29_000, -5]) helpers.push({ fn: 'minutesText', input: ms, out: PW.minutesText(ms) });
for (const [live, lid] of [[3, false], [1, true]]) helpers.push({ fn: 'batteryNotice', input: { live, lidAwake: lid }, out: PW.batteryNotice(live, lid) });
writeFileSync(join(here, 'power.json'), JSON.stringify({ generator: 'gen_power.mjs', offDelayMs: LG.OFF_DELAY_MS, cases, helpers }, null, 1) + '\n');
console.log(`power.json: ${cases.length} scripts, ${helpers.length} helper cases`);
