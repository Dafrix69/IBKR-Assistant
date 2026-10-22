// 生成 follow-reader.json:engine-ts/src/followReader.ts(原模块现跑)。parseReaderLine / readerArgs / readerProgram 在一组输入上;
// FollowReader 用假的子进程与假的 setTimeout 走一段脚本,每一步之后:报出的状态、view、起了几次子进程(参数)、kill 了谁、排着的定时器。
//   node native/tests/fixtures/gen_follow_reader.mjs <编过的 engine-ts 目录>
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
// 假定时器:followReader 只用 setTimeout / clearTimeout
const timers = [];
let nextId = 1;
globalThis.setTimeout = (fn, ms) => { const t = { id: nextId++, fn, ms, unref() {} }; timers.push(t); return t; };
globalThis.clearTimeout = (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); };
const R = await import(pathToFileURL(join(engine, 'dist/src/followReader.js')).href);

const lines = ['{"state":"reading","title":"Charlie\\n频道"}', '{"state":"waiting"}', '{"state":"failed"}', '{"state":"starting"}', '{"state":5}', '{"state":"reading","title":""}',
  '{"state":"no_list","title":5}', '[1]', 'null', 'not json', '', '{"state":"untrusted","title":"' + 'x'.repeat(250) + '"}', '{"state":"no_discord","title":"a\\r\\n\\r\\nb"}'];
const parsed = lines.map((l) => ({ l, out: R.parseReaderLine(l) }));
const args = [['c', '/o', true], ['频道 A', '/a b/c', false]].map((a) => ({ a, out: R.readerArgs(...a) }));
const dir = mkdtempSync(join(tmpdir(), 'reader-'));
writeFileSync(join(dir, 'reader'), 'x');
mkdirSync(join(dir, 'sub'));
const programs = [[{ DAFRI_INBOX_READER: join(dir, 'reader') }, 'darwin'], [{ DAFRI_INBOX_READER: join(dir, 'reader') }, 'win32'], [{ DAFRI_INBOX_READER: '  ' + join(dir, 'reader') + '  ' }, 'darwin'],
  [{ DAFRI_INBOX_READER: 'relative/reader' }, 'darwin'], [{ DAFRI_INBOX_READER: join(dir, 'sub') }, 'darwin'], [{ DAFRI_INBOX_READER: join(dir, 'missing') }, 'darwin'], [{}, 'darwin']]
  .map(([env, platform], i) => ({ i, out: R.readerProgram(env, platform) === null ? null : 'FOUND' }));

class FakeChild {
  constructor(id) { this.id = id; this.handlers = {}; this.killed = false; this.stdout = { on: (e, f) => { this.handlers.stdout = f; } }; this.stderr = { on: (e, f) => { this.handlers.stderr = f; } }; }
  on(e, f) { this.handlers[e] = f; }
  kill() { this.killed = true; return true; }
}
const children = [];
let throwNext = false;
const statuses = [];
const reader = new R.FollowReader('/bin/reader', 'Charlie', '/x/inbox.jsonl', { onStatus: (s) => statuses.push(s) }, {
  spawn: (program, a) => { if (throwNext) { throwNext = false; throw new Error('spawn ENOENT'); } const c = new FakeChild(children.length); c.args = a; children.push(c); return c; },
});
const last = () => children[children.length - 1];
const ops = [['start'], ['stdout', '{"state":"wai'], ['stdout', 'ting"}\n{"state":"reading","title":"T"}\nnoise\n'], ['stdout', '{"state":"reading","title":"T"}\n'], ['exit', 1], ['fire'],
  ['exit', 77], ['fire'], ['exit', 0], ['fire'], ['exit', null], ['fire'], ['exit', 3], ['fire'], ['exit', 3], ['fire'], ['exit', 3], ['fire'], ['exit', 3], ['fire'], ['exit', 3], ['fire'],
  ['stdout', '{"state":"reading"}\n'], ['error', 'EPIPE'], ['exit', 9], ['fire'], ['oldExit', 0], ['oldStdout', '{"state":"waiting"}\n'], ['throwNext'], ['exit', 2], ['fire'], ['fire'],
  ['start'], ['stop'], ['fire'], ['start'], ['exit', 77], ['stop'], ['fire'], ['exit', 1]];
const steps = [];
for (const op of ops) {
  statuses.length = 0;
  const [k, v] = op;
  if (k === 'start') reader.start();
  else if (k === 'stop') reader.stop();
  else if (k === 'stdout') last()?.handlers.stdout?.(Buffer.from(v));
  else if (k === 'exit') last()?.handlers.exit?.(v);
  else if (k === 'error') last()?.handlers.error?.(new Error(v));
  else if (k === 'oldExit') children[0].handlers.exit(v);
  else if (k === 'oldStdout') children[0].handlers.stdout(Buffer.from(v));
  else if (k === 'throwNext') throwNext = true;
  else if (k === 'fire') { const t = timers.shift(); if (t) t.fn(); }
  steps.push({ op, statuses: [...statuses], view: reader.view, spawned: children.length, lastArgs: last()?.args ?? null, killed: children.map((c) => c.killed), timers: timers.map((t) => t.ms) });
}
writeFileSync(join(here, 'follow-reader.json'), JSON.stringify({ parsed, args, programs, steps }) + '\n');
console.log('follow-reader.json', steps.length, '步');
