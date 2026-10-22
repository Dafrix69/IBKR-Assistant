// 生成 store-guard.json:交易库备份的列表、给人看的那一行、恢复时文件怎么挪(desktop/store-guard.js 在临时目录里真的跑)。
//   TZ=Asia/Shanghai node native/tests/fixtures/gen_store_guard.mjs
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const S = createRequire(import.meta.url)(join(here, '..', '..', '..', 'desktop/store-guard.js'));
const SQLITE = Buffer.from('SQLite format 3\u0000', 'latin1');
// 造法写进 fixture(不存字节):SQLite 头 + extra 个 0x07;text 是原样的文字
const db = (extra = 100) => Object.assign(Buffer.concat([SQLITE, Buffer.alloc(extra, 7)]), { recipe: { db: extra } });
const raw = (text) => Object.assign(Buffer.from(text, 'latin1'), { recipe: { text } });

const backups = {
  'trades-20260928-010000-daily.db': db(2_000_000),
  'trades-20260928-010000-daily-2.db': db(500),
  'trades-20260927-235959-upgrade.db': db(10),
  'trades-20261001-120000-manual.db': db(1_048_560),
  'trades-20261001-120000-manual-10.db': db(0),
  'trades-20260101-000000-weird.db': db(),
  'trades-2026-bad.db': db(),
  'notes.txt': raw('x'),
  'trades-20260930-080000-daily.db': raw(''),
  'trades-20260929-080000-daily.db': raw('not sqlite at all, sorry'),
};
const NOW = Date.UTC(2026, 9, 18, 4, 5, 6);
const dir = mkdtempSync(join(tmpdir(), 'sg-'));
const dbPath = join(dir, 'trades.db');
mkdirSync(join(dir, 'backups'));
for (const [name, bytes] of Object.entries(backups)) writeFileSync(join(dir, 'backups', name), bytes);
const list = S.listBackups(dbPath);
const described = list.map((b) => ({ name: b.name, line: S.describeBackup(b) }));
const extra = [{ name: 'x', reason: 'daily', at: '2026-01-05T23:30:00Z', bytes: 1 }, { name: 'y', reason: 'manual', at: '2026-01-05T15:59:00Z', bytes: 1536 }, { name: 'z', reason: 'other', at: '2026-01-05T15:59:00Z', bytes: 1048576 }]
  .map((b) => ({ backup: b, line: S.describeBackup(b) }));

// 恢复:有主文件 + WAL + SHM / 只剩 WAL / 名字不对 / 文件不是库 / 文件是空的
const restores = [];
const scenario = (name, setup, target, opts) => {
  const d = mkdtempSync(join(tmpdir(), 'sgr-'));
  const p = join(d, 'trades.db');
  mkdirSync(join(d, 'backups'));
  for (const [n, bytes] of Object.entries(backups)) writeFileSync(join(d, 'backups', n), bytes);
  setup(p);
  let result;
  try {
    const r = S.restoreBackup(p, target, { now: NOW, ...opts });
    result = { ok: true, restored: r.restored, kept: r.kept ? r.kept.slice(d.length + 1) : null };
  } catch (err) {
    result = { ok: false, error: String(err.message) };
  }
  const files = readdirSync(d).filter((f) => f !== 'backups').sort();
  const contents = Object.fromEntries(files.map((f) => [f, createHash('sha256').update(readFileSync(join(d, f))).digest('hex')]));
  restores.push({ name, target, opts: opts || {}, setupFiles: setup.files, result, files, contents });
  rmSync(d, { recursive: true, force: true });
};
const withFiles = (files) => { const f = (p) => { for (const [suffix, text] of Object.entries(files)) writeFileSync(p + suffix, text); }; f.files = files; return f; };
scenario('main+wal+shm', withFiles({ '': 'OLDDB', '-wal': 'W', '-shm': 'S' }), 'trades-20260928-010000-daily.db');
scenario('corrupt-aside', withFiles({ '': 'BROKEN' }), 'trades-20260927-235959-upgrade.db', { aside: 'corrupt' });
scenario('only-wal', withFiles({ '-wal': 'W' }), 'trades-20261001-120000-manual.db');
scenario('no-db', withFiles({}), 'trades-20260928-010000-daily-2.db');
scenario('bad-name', withFiles({ '': 'OLD' }), '../settings.json');
scenario('not-sqlite', withFiles({ '': 'OLD' }), 'trades-20260929-080000-daily.db');
scenario('empty', withFiles({ '': 'OLD' }), 'trades-20260930-080000-daily.db');
scenario('missing', withFiles({ '': 'OLD' }), 'trades-20260101-000000-daily.db');

const fatal = ['line\n[fatal:store:path] /x/trades.db\n[fatal:store:corrupt] 库损坏', '[fatal:store:locked] 被占着', 'nothing', '[fatal:store:path]  /a b/c.db  \r\n[fatal:store:newer] 版本 9\n[fatal:store:unwritable] 写不进去']
  .map((t) => ({ text: t, out: S.fatalLine(t) }));
writeFileSync(join(here, 'store-guard.json'), JSON.stringify({ generator: 'gen_store_guard.mjs', exitStore: S.EXIT_STORE, now: NOW, tz: process.env.TZ || '',
  backups: Object.fromEntries(Object.entries(backups).map(([k, v]) => [k, v.recipe])), list, described, extra, restores, fatal }, null, 1) + '\n');
rmSync(dir, { recursive: true, force: true });
console.log(`store-guard.json: ${list.length} listed, ${restores.length} restores`);
