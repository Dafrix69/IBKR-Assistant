// 生成 ib_link.json:engine-ts 的 ibLink.ts(原模块现跑):账号掩码、liveSessions、coveredAccounts、UpstreamWatch。
// 会话是脚本驱动的假会话(execsupport_world.mjs),日志记下会话上被调用的每一次。C++ 一半:tests/tst_ib_link.cpp。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_ib_link.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { drain, enc, loadWorld, rng } from './execsupport_world.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const X = await import(pathToFileURL(join(engine, 'dist/src/ibLink.js')).href);
const { World, tickerKey } = await loadWorld(engine);
const START = Date.parse('2026-10-12T09:40:00-04:00');

async function run(script) {
  const world = new World(script, tickerKey);
  const watches = new Map();
  const steps = [];
  const names = (list) => list.map((s) => s.name);
  try {
    for (const step of script.steps) {
      const rec = { op: step.op };
      if (!world.commonStep(step)) {
        const mapOf = () => new Map(step.map.map(([conn, name]) => [conn, world.session(name)]));
        if (step.op === 'live') {
          try { rec.result = { ok: names(X.liveSessions(mapOf(), (m) => new Error(m))) }; } catch (e) { rec.result = { error: e.message }; }
        } else if (step.op === 'covered') {
          rec.result = { ok: [...X.coveredAccounts(step.accounts, mapOf())] };
        } else if (step.op === 'newWatch') watches.set(step.id, new X.UpstreamWatch());
        else if (step.op === 'watch') {
          watches.get(step.watch).watch(step.connection, world.session(step.session), (up) => world.rec(null, 'onLinkCallback', [step.connection, up]));
        } else if (step.op === 'clear') watches.get(step.watch).clear();
        else if (step.op === 'lost') rec.result = watches.get(step.watch).lost;
        else throw new Error(`不认识的步 ${step.op}`);
      }
      await drain();
      const lost = {};
      for (const [id, w] of [...watches.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) lost[id] = w.lost;
      rec.lost = lost;
      steps.push(rec);
    }
    return { log: world.log, steps };
  } finally {
    world.restore();
  }
}

const scenarios = [];
const add = (name, script) => scenarios.push({ name, script: { start: START, events: [], ...script } });
const sess = (name, over = {}) => ({ name, connected: true, accounts: [], caps: ['OnLink'], ...over });

add('liveSessions:连着的那些;全断了报连接名;一条都没有报另一句', {
  sessions: [sess('A', { connected: false }), sess('B'), sess('C', { connected: false })],
  steps: [
    { op: 'live', map: [['live', 'A'], ['paper', 'B'], ['x', 'C']] },
    { op: 'live', map: [['live', 'A'], ['x', 'C']] },
    { op: 'live', map: [] },
    { op: 'connected', session: 'B', v: false },
    { op: 'live', map: [['live', 'A'], ['paper', 'B']] },
  ],
});
add('coveredAccounts:管着的账号,或会话没报账号时按配置的连接名认', {
  sessions: [sess('A', { accounts: ['U1', 'U2'] }), sess('B', { accounts: [] }), sess('C', { accounts: ['DU9'], connected: false }), sess('D', { accounts: ['U1'] })],
  steps: [
    { op: 'covered', map: [['live', 'A'], ['paper', 'B'], ['old', 'C']], accounts: [
      { alias: 'main', account_id: 'U1', connection: 'live' }, { alias: 'second', account_id: 'U2', connection: 'live' },
      { alias: 'paper', account_id: 'DU9', connection: 'paper' }, { alias: 'p2', account_id: 'DU8', connection: 'paper' },
      { alias: 'ghost', account_id: 'DU7', connection: 'old' }, { alias: 'other', account_id: 'U5', connection: 'live' }] },
    { op: 'covered', map: [['live', 'A'], ['copy', 'D']], accounts: [{ alias: 'main', account_id: 'U1', connection: 'live' }, { alias: 'again', account_id: 'U1', connection: 'copy' }] },
    { op: 'covered', map: [['live', 'A']], accounts: [] },
    { op: 'covered', map: [], accounts: [{ alias: 'a', account_id: 'U1', connection: 'live' }] },
    { op: 'covered', map: [['paper', 'B'], ['paper2', 'B']], accounts: [{ alias: 'same', account_id: 'U1', connection: 'paper' }, { alias: 'same', account_id: 'U1', connection: 'paper2' }] },
  ],
});
add('UpstreamWatch:1100 / 2110 记断,1101 / 1102 与 socket 连回来记通;别的码不动;lost 取最先断的那条', {
  sessions: [sess('A'), sess('B'), sess('C', { caps: [] })],
  steps: [
    { op: 'newWatch', id: 'w' },
    { op: 'watch', watch: 'w', connection: 'live', session: 'A' },
    { op: 'watch', watch: 'w', connection: 'paper', session: 'B' },
    { op: 'watch', watch: 'w', connection: 'bare', session: 'C' },
    { op: 'emitConnectivity', session: 'B', code: 2110 },
    { op: 'emitConnectivity', session: 'A', code: 1100 },
    { op: 'lost', watch: 'w' },
    { op: 'emitConnectivity', session: 'B', code: 1100 },
    { op: 'lost', watch: 'w' },
    { op: 'emitConnectivity', session: 'A', code: 1300 },
    { op: 'emitConnectivity', session: 'A', code: 1102 },
    { op: 'lost', watch: 'w' },
    { op: 'emitLink', session: 'B', up: false },
    { op: 'emitLink', session: 'B', up: true },
    { op: 'lost', watch: 'w' },
    { op: 'emitConnectivity', session: 'C', code: 1100 },
    { op: 'emitLink', session: 'A', up: true },
    { op: 'lost', watch: 'w' },
    { op: 'emitConnectivity', session: 'A', code: 2110 },
    { op: 'watch', watch: 'w', connection: 'live', session: 'A' },
    { op: 'lost', watch: 'w' },
    { op: 'clear', watch: 'w' },
    { op: 'lost', watch: 'w' },
  ],
});
add('UpstreamWatch:两个 watcher 互不相干;同一条连接换新会话从通算起', {
  sessions: [sess('A'), sess('B'), sess('C')],
  steps: [
    { op: 'newWatch', id: 'w1' }, { op: 'newWatch', id: 'w2' },
    { op: 'watch', watch: 'w1', connection: 'live', session: 'A' },
    { op: 'watch', watch: 'w2', connection: 'live', session: 'B' },
    { op: 'emitConnectivity', session: 'A', code: 1100 }, { op: 'emitConnectivity', session: 'B', code: 2110 },
    { op: 'lost', watch: 'w1' }, { op: 'lost', watch: 'w2' },
    { op: 'watch', watch: 'w1', connection: 'live', session: 'C' },
    { op: 'lost', watch: 'w1' }, { op: 'lost', watch: 'w2' },
    { op: 'emitConnectivity', session: 'A', code: 1100 }, { op: 'lost', watch: 'w1' },
    { op: 'emitConnectivity', session: 'C', code: 1101 }, { op: 'lost', watch: 'w1' },
  ],
});

// ---- 随机序列
{
  const r = rng(0x11c0_beef);
  for (let n = 0; n < 40; n += 1) {
    const sessions = ['A', 'B', 'C', 'D'].map((nm) => sess(nm, { connected: r.chance(0.7), accounts: r.pick([[], ['U1'], ['U1', 'U2'], ['DU9'], ['U2']]), caps: r.chance(0.8) ? ['OnLink'] : [] }));
    const conns = ['live', 'paper', 'x'];
    const steps = [{ op: 'newWatch', id: 'w' }];
    for (let i = 0; i < 18; i += 1) {
      const p = r.next();
      if (p < 0.2) steps.push({ op: 'watch', watch: 'w', connection: r.pick(conns), session: r.pick(['A', 'B', 'C', 'D']) });
      else if (p < 0.5) steps.push({ op: 'emitConnectivity', session: r.pick(['A', 'B', 'C', 'D']), code: r.pick([1100, 2110, 1101, 1102, 1300, 0, -1, 504]) });
      else if (p < 0.62) steps.push({ op: 'emitLink', session: r.pick(['A', 'B', 'C', 'D']), up: r.chance(0.5) });
      else if (p < 0.7) steps.push({ op: 'clear', watch: 'w' });
      else if (p < 0.8) steps.push({ op: 'live', map: conns.filter(() => r.chance(0.7)).map((c) => [c, r.pick(['A', 'B', 'C', 'D'])]) });
      else if (p < 0.92) {
        steps.push({ op: 'covered', map: conns.filter(() => r.chance(0.7)).map((c) => [c, r.pick(['A', 'B', 'C', 'D'])]),
          accounts: Array.from({ length: r.int(5) }, (_, k) => ({ alias: r.pick(['main', 'second', 'paper', 'a', 'b']), account_id: r.pick(['U1', 'U2', 'DU9', 'DU8']), connection: r.pick(conns) })) });
      } else steps.push({ op: 'connected', session: r.pick(['A', 'B', 'C', 'D']), v: r.chance(0.5) });
    }
    add(`随机 ${n}`, { sessions, steps });
  }
}

const redact = ['', 'U', 'U123', 'U1234', 'U12345', 'U123456', 'DU1234567', 'U1234567', 'abcdef', '汉字汉字汉字汉字', '😀😀😀😀', '  ', 'ab cd ef', 'x'.repeat(40)];
const out = scenarios.map((s) => ({ name: s.name, script: enc(s.script), expected: enc(null) }));
for (let i = 0; i < scenarios.length; i += 1) out[i].expected = enc(await run(scenarios[i].script));
const text = JSON.stringify({ scenarios: out, redact: redact.map((s) => [s, X.redactForLog(s)]) });
writeFileSync(join(here, 'ib_link.json'), text);
console.log(`ib_link.json:${scenarios.length} 个场景,${(text.length / 1024).toFixed(0)} KB`);
