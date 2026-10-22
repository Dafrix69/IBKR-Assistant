// 生成 day-logs.json:engine-ts 的 ivSamples.ts、playbookLog.ts(原模块现跑):追加之后文件里逐字写了什么(含美东日界、夏令时那几天)、
// 读回来哪些行算数(手写的坏文件:半行、形状不对、\r\n、BOM、不是 JSON 的文件名)、dates / days / prune。
//   node native/tests/fixtures/gen_day_logs.mjs <编过的 engine-ts 目录>
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const { IvSampleStore } = await import(pathToFileURL(join(engine, 'dist/src/ivSamples.js')).href);
const { PlaybookLog } = await import(pathToFileURL(join(engine, 'dist/src/playbookLog.js')).href);

const leg = (strike, right, iv = 0.18) => ({ strike, right, bid: 1.2, ask: 1.3, iv });
const samples = [
  { t: Date.parse('2026-10-16T13:30:00Z'), symbol: 'SPX', expiry: '20261016', trading_class: 'SPXW', spot: 7801.5, spot_source: 'quote', by: 'loop', anchor: 7800, legs: [leg(7800, 'C'), leg(7800, 'P', null)] },
  { t: Date.parse('2026-10-16T03:59:59Z'), symbol: 'SPX', expiry: '20261016', trading_class: 'SPXW', spot: 7790, spot_source: 'futures', by: 'plan', legs: [] },
  { t: Date.parse('2026-10-16T04:00:00Z'), symbol: 'SPX', expiry: '20261016', trading_class: 'SPXW', spot: 7791, spot_source: 'futures', by: 'plan', legs: [] },
  { t: Date.parse('2026-03-08T06:59:59Z'), symbol: 'SPX', expiry: '20260309', trading_class: 'SPXW', spot: 6000, spot_source: 'quote', by: 'loop', legs: [leg(6000, 'C')] },
  { t: Date.parse('2026-03-08T07:00:00Z'), symbol: 'SPX', expiry: '20260309', trading_class: 'SPXW', spot: 6000, spot_source: 'quote', by: 'loop', legs: [] },
  { t: Date.parse('2026-11-01T05:30:00Z'), symbol: 'SPX', expiry: '20261102', trading_class: 'SPXW', spot: 7000, spot_source: 'quote', by: 'loop', legs: [] },
  { t: Date.parse('2026-10-16T12:00:00Z'), symbol: 'SPX', expiry: '20261016', trading_class: 'SPXW', spot: 7799, spot_source: 'quote', by: 'loop', legs: [{ strike: 1, right: 'X' }] },
  { t: Date.parse('2026-10-16T11:00:00Z'), symbol: '中文', expiry: '20261016', trading_class: '', spot: 0, spot_source: '', by: 'loop', legs: [] },
  { t: Date.parse('2026-10-16T10:00:00Z'), symbol: 'SPX', expiry: '20261016', trading_class: 'SPXW', spot: 1e-300, spot_source: 'q ', by: 'loop', legs: [leg(1.5, 'P', 0.1)], extra: { z: 1, a: [2] } },
];
const ivDir = mkdtempSync(join(tmpdir(), 'iv-'));
const iv = new IvSampleStore(ivDir);
for (const s of samples) iv.append(s);
const ivFiles = Object.fromEntries(readdirSync(ivDir).sort().map((n) => [n, readFileSync(join(ivDir, n), 'utf8')]));
const crafted = {
  '2026-01-02.jsonl': '{"t":1,"symbol":"A","expiry":"x","spot":1,"legs":[]}\n{"t":2,"symbol":"A","exp\n\n  \n{"t":"3","symbol":"A","expiry":"x","spot":1,"legs":[]}\r\n{"t":0,"symbol":"A","expiry":"x","spot":-1,"legs":[]}\n{"t":-5,"symbol":"B","expiry":"x","spot":2,"legs":[{"strike":1,"right":"P"}]}\r\n﻿{"t":9,"symbol":"A","expiry":"x","spot":1,"legs":[]}\n[1]\nnull\n{"t":1e400,"symbol":"A","expiry":"x","spot":1,"legs":[]}\n{"t":4,"symbol":"A","expiry":"x","spot":1,"legs":[[]]}',
  '2026-01-03.jsonl': '',
  'notes.txt': 'x', '2026-1-04.jsonl': '{}', '2026-01-05.jsonl.bak': '{}',
};
for (const [n, t] of Object.entries(crafted)) writeFileSync(join(ivDir, n), t);
const ivDates = iv.dates();
const ivRead = Object.fromEntries(ivDates.map((d) => [d, iv.read(d)]));
const ivDays = iv.days();
const ivPrune = iv.prune(3);
const ivAfter = iv.dates();
const ivPruneDefault = iv.prune();

const pbDir = mkdtempSync(join(tmpdir(), 'pb-'));
const pb = new PlaybookLog(pbDir);
const band = { at: 1, anchor: 7800, strike: 7800, expiry: '20261016', call: 10, put: 9, em: 19, lower: 7781, upper: 7819, source: 'live' };
const records = [
  ['2026-10-16', { kind: 'prior', band }], ['2026-10-16', { kind: 'open', band: { ...band, source: 'backfill' } }], ['2026-10-16', { kind: 'frame', band: { ...band, em: 'x' } }],
  ['2026-10-16', { kind: 'event', event: { at: 2, level: 7819, price: 7820, state: 'B2', kind: 'enter' } }], ['2026-10-16', { kind: 'event', event: { at: 2, level: 7819, price: 7820, state: 'B2', kind: 'boom' } }],
  ['2026-10-16', { kind: 'anchor', anchor: { at: 3, price: 7800.25, source: 'live' } }], ['2026-10-16', { kind: 'anchor', anchor: { at: 3, price: 0, source: 'live' } }],
  ['2026-10-17', { kind: 'machine', machine: { at: 4, state: 'B3', trigger: null, since: 5, lost: null } }], ['2026-10-17', { kind: 'machine', machine: { at: 4, state: 'X', trigger: null, since: null, lost: null } }],
  ['2026-10-17', { kind: 'machine', machine: { at: 4, state: 'R', trigger: 'x', since: null, lost: null } }], ['2026-10-17', { kind: 'other', band }], ['2026-10-17', { kind: 'frame' }],
  ['2026-10-18', { kind: 'event', event: null }], ['2026-10-18', [1, 2]],
];
for (const [d, r] of records) pb.append(d, r);
const pbFiles = Object.fromEntries(readdirSync(pbDir).sort().map((n) => [n, readFileSync(join(pbDir, n), 'utf8')]));
const pbRead = Object.fromEntries(pb.dates().map((d) => [d, pb.read(d)]));
const pbPrune = pb.prune(1);
const pbAfter = pb.dates();
writeFileSync(join(here, 'day-logs.json'), JSON.stringify({ samples, ivFiles, crafted, ivDates, ivRead, ivDays, ivPrune, ivAfter, ivPruneDefault, records, pbFiles, pbRead, pbPrune, pbAfter }) + '\n');
console.log('day-logs.json', ivDates.length, 'iv 天', Object.keys(pbRead).length, '剧本天');
