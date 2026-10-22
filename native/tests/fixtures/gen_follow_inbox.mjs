// 生成 follow-inbox.json:engine-ts/src/followInbox.ts(原模块现跑)。parseInboxLine 在一把行上;Node 的 UTF-8 解码(Buffer.toString)在一组坏字节上
// (收件文件是一块块读的,一个字可能被切成两半);一段脚本化的文件会话:start 时已有的内容不读、追加(从半行、半个字处切开)、
// 清空、换成更短的文件、删掉、一行认不出、同一句错不重复报——每一步之后发出了哪些消息与错、received、lastAt、error。Date 换成可复现的。
//   node native/tests/fixtures/gen_follow_inbox.mjs <编过的 engine-ts 目录>
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
let NOW = Date.UTC(2026, 9, 19, 14, 0, 0);
const RealDate = Date;
globalThis.Date = class extends RealDate { constructor(...a) { if (a.length === 0) super(NOW); else super(...a); } static now() { return NOW; } };
const F = await import(pathToFileURL(join(engine, 'dist/src/followInbox.js')).href);

const good = (o = {}) => JSON.stringify({ v: 1, key: 'k1', seen_at: '2026-10-19T10:00:00-04:00', channel: 'c', author: 'Charlie', time_label: '10:00', content: '买 7800C', ...o });
const lines = [good(), good({ key: '  k2  ', author: ' Char\r\nlie \n' }), good({ v: 2 }), good({ v: '1' }), good({ v: undefined }), good({ key: '' }), good({ key: 'x'.repeat(121) }), good({ key: 'x'.repeat(120) }),
  good({ key: 5 }), good({ author: '   ' }), good({ author: 'A'.repeat(100) }), good({ content: undefined }), good({ content: '' }), good({ content: 5 }), good({ seen_at: 'nope' }),
  good({ seen_at: undefined }), good({ seen_at: '2026-10-19T10:00:00Z' }), '[1]', 'null', '5', 'not json', '{"v":1', good({ author: '😀'.repeat(50) }), good({ extra: { a: 1 } })];
const parsed = lines.map((l) => ({ line: l, out: F.parseInboxLine(l) }));
const ids = [' a\r\n\nb ', 'x'.repeat(100), '', '\n'].map((n) => ({ n, out: F.localAuthorId(n) }));

const byteCases = [[0x61], [0xe4, 0xb8], [0xe4, 0xb8, 0xad], [0xff, 0x61], [0xc0, 0x80], [0xed, 0xa0, 0x80], [0xf0, 0x9f, 0x98], [0xf0, 0x9f, 0x98, 0x80], [0xf4, 0x90, 0x80, 0x80],
  [0xe0, 0x80, 0x80], [0x80, 0x80], [0xef, 0xbb, 0xbf, 0x61], [0xc2], [0xe4, 0x61], [0xf0, 0x61, 0x62], [0xf8, 0x88, 0x80, 0x80, 0x80], [0xe1, 0x80, 0xe1, 0x80, 0x80], [0xdf, 0xbf, 0xc2]];
const utf8 = byteCases.map((b) => ({ hex: Buffer.from(b).toString('hex'), out: Buffer.from(b).toString('utf-8') }));

const dir = mkdtempSync(join(tmpdir(), 'inbox-'));
const path = join(dir, 'follow-inbox.jsonl');
const events = [];
const inbox = new F.FollowInbox(path, { onMessage: (m) => events.push({ m }), onError: (e) => events.push({ e }) });
const L = (o) => good(o) + '\n';
const zh = Buffer.from(L({ key: 'zh', content: '中文消息' }));
const ops = [
  ['poll'], ['write', L({ key: 'old' })], ['start'], ['poll'],
  ['append', L({ key: 'a1' })], ['poll'],
  ['append', good({ key: 'half' }).slice(0, 30)], ['poll'], ['append', good({ key: 'half' }).slice(30) + '\n'], ['poll'],
  ['appendBytes', zh.subarray(0, 60).toString('hex')], ['poll'], ['appendBytes', zh.subarray(60).toString('hex')], ['poll'],
  ['append', 'garbage line\n'], ['poll'], ['append', 'garbage line\n'], ['poll'], ['append', 'other garbage\n' + L({ key: 'after' })], ['poll'],
  ['append', '\n   \n'], ['poll'], ['write', L({ key: 'new-file' })], ['poll'], ['clock', 60000], ['append', L({ key: 'n2' }) + L({ key: 'n3' })], ['poll'],
  ['append', good({ key: 'pending-half' }).slice(0, 25)], ['poll'], ['write', 'x'], ['poll'], ['append', L({ key: 'after-truncate' })], ['poll'],
  ['delete'], ['poll'], ['write', L({ key: 'recreated' })], ['poll'], ['append', '{"v":3}\n'], ['poll'], ['poll'],
];
const session = [];
for (const op of ops) {
  events.length = 0;
  if (op[0] === 'write') writeFileSync(path, op[1]);
  else if (op[0] === 'append') appendFileSync(path, op[1]);
  else if (op[0] === 'appendBytes') appendFileSync(path, Buffer.from(op[1], 'hex'));
  else if (op[0] === 'delete') rmSync(path);
  else if (op[0] === 'clock') NOW += op[1];
  else if (op[0] === 'start') { inbox.start(); inbox.stop(); }
  else if (op[0] === 'poll') inbox.poll();
  session.push({ op, clock: NOW, events: [...events], received: inbox.received, lastAt: inbox.lastAt, error: inbox.error });
}
writeFileSync(join(here, 'follow-inbox.json'), JSON.stringify({ parsed, ids, utf8, session, inboxPath: F.inboxPath('/a/b/trades.db') }) + '\n');
console.log('follow-inbox.json', parsed.length, '行', session.length, '步');
