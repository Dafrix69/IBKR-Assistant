// 生成 killswitch.json:engine-ts/src/killswitch.ts(原模块现跑)在一串串操作上的状态(at 是当时的钟,比的时候只看有没有、长什么样)。
// 每个脚本从一份起始文件(不存在 / 各种内容 / 坏的)开始,依次做 engage / release / recordSuccess / recordFailure,记下每一步的返回与之后的 state()。
//   node native/tests/fixtures/gen_killswitch.mjs <编过的 engine-ts 目录>
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const { KillSwitch } = await import(pathToFileURL(join(engine, 'dist/src/killswitch.js')).href);
const readFile = (f) => { const t = readFileSync(f, 'utf8').replace(/"at":"[^"]*"/, '"at":"<AT>"'); try { return { json: JSON.parse(t) }; } catch { return { raw: t }; } };
const mask = (s) => (s === null || s === undefined ? s : { ...s, at: s.at ? '<AT>' : '' });

const starts = [null, '{"engaged":true,"reason":"手动","at":"2026-10-19T05:00:00+08:00","consecutive_failures":2,"consecutive_parse_failures":1,"auto":false}',
  '{"engaged":false,"reason":"","at":"","consecutive_failures":"2","consecutive_parse_failures":null}', '{"engaged":1,"reason":5,"consecutive_failures":2.9,"auto":"true"}',
  'not json', '5', '[]', '{}', '{"consecutive_failures":-1.5,"consecutive_parse_failures":"abc"}'];
const scripts = [
  [['failure', 'b1'], ['failure', 'b2'], ['failure', 'b3'], ['failure', 'b4'], ['success'], ['release']],
  [['failure', 'p1', 'parse'], ['failure', 'p2', 'parse'], ['success', 'broker'], ['failure', 'p3', 'parse'], ['success', 'parse'], ['failure', 'b', 'broker']],
  [['engage', '用户在菜单里点了'], ['failure', 'x'], ['failure', 'y'], ['failure', 'z'], ['release', 'cli']],
  [['success'], ['success', 'parse'], ['engage', '自动', true], ['release']],
];
const cases = [];
for (const [si, start] of starts.entries()) {
  for (const [ti, threshold] of [3, 1, 0, 2.5].entries()) {
    for (const [ki, script] of scripts.entries()) {
      const dir = mkdtempSync(join(tmpdir(), 'ks-'));
      const file = join(dir, 'sub', 'breaker.json');
      const ks = new KillSwitch(file, threshold);
      if (start !== null) writeFileSync(file, start);
      const steps = [{ op: 'state', state: mask(ks.state()) }];
      for (const [op, a, b] of script) {
        let ret;
        if (op === 'engage') ret = mask(ks.engage(a, b));
        else if (op === 'release') ret = mask(a === undefined ? ks.release() : ks.release(a));
        else if (op === 'success') { ks.recordSuccess(a); ret = null; }
        else ret = mask(ks.recordFailure(a, b));
        steps.push({ op, a: a ?? null, b: b ?? null, ret: ret ?? null, state: mask(ks.state()), file: existsSync(file) ? readFile(file) : null });
      }
      cases.push({ start, threshold, script: ki, steps });
    }
  }
}
writeFileSync(join(here, 'killswitch.json'), JSON.stringify({ generator: 'native/tests/fixtures/gen_killswitch.mjs', scripts, cases }, null, 1) + '\n');
console.log(`killswitch.json:${cases.length} 串`);
