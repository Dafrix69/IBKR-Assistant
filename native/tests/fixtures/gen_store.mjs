// 生成 store.json:engine-ts/src/store.ts(连同 storeSafety / riskQueries / signalLog / followLog / messageLog / importedTrades / ideaVectors)
// 在一串操作上现跑的结果。Date 与 crypto.randomUUID 换成可复现的(C++ 测试换成同一套):每一步之前钟拨到 `clock`,id 依次是
// 00000000-0000-4000-8000-000000000001…。每一步记下返回值(或抛出的话与 code),以及之后整个库的样子(每张表按 rowid 的全部行、
// sqlite_master、user_version)。另有三段:老结构的库打开时的迁移、真应用开库的保险(版本、完整性、备份、打不开的人话)。
//   node native/tests/fixtures/gen_store.mjs <编过的 engine-ts 目录>
import cryptoDefault from 'node:crypto';
import { syncBuiltinESMExports, createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');

// ---- 可复现的钟与 id(要在 import store.js 之前换掉)
let NOW = Date.UTC(2026, 9, 19, 14, 30, 0);
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(NOW); else super(...a); }
  static now() { return NOW; }
}
globalThis.Date = FakeDate;
let uuidN = 0;
cryptoDefault.randomUUID = () => `00000000-0000-4000-8000-${String(++uuidN).padStart(12, '0')}`;
syncBuiltinESMExports();

const { TradeStore } = await import(pathToFileURL(join(engine, 'dist/src/store.js')).href);
const safety = await import(pathToFileURL(join(engine, 'dist/src/storeSafety.js')).href);
const Database = createRequire(join(engine, 'package.json'))('better-sqlite3');

// ---- 整个库的样子
function dumpDb(path) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const cell = (v) => (Buffer.isBuffer(v) ? { blob: v.toString('hex') } : v);
    const master = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all();
    const tables = {};
    for (const t of master) {
      if (t.type !== 'table') continue;
      // WITHOUT ROWID 的表(FTS5 的几张影子表)没有 rowid:按主键的自然次序
      let stmt;
      try { stmt = db.prepare(`SELECT * FROM "${t.name}" ORDER BY rowid`); } catch { stmt = db.prepare(`SELECT * FROM "${t.name}"`); }
      tables[t.name] = stmt.raw().all().map((r) => r.map(cell));
    }
    return { user_version: db.pragma('user_version', { simple: true }), master, tables };
  } finally {
    db.close();
  }
}
const errOf = (e) => ({ error: String(e?.message ?? e), code: e?.code ?? null, ename: e?.name ?? null, kind: e?.kind ?? null });
const plain = (v) => {
  if (v instanceof Map) return { __map: [...v.entries()].map(([k, x]) => [k, plain(x)]) };
  if (v instanceof Set) return { __set: [...v] };
  if (v instanceof Float32Array) return { __f32: [...v] };
  if (v === undefined) return null;
  return v;
};

// ---- 主脚本
const S = (n) => 'x'.repeat(n);
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T0 = NOW;
const at = (min) => T0 + min * 60000;
const iso = (min) => new RealDate(at(min)).toISOString().replace(/\.\d{3}Z$/, '+00:00');
const bagRecord = {
  contract: { symbol: 'SPX', secType: 'BAG', comboLegs: [{ conId: 3, ratio: 1 }], b: 1, a: 2, '10': 'x', '2': 'y' },
  order: { action: 'BUY', totalQuantity: 2, lmtPrice: 3.55, orderType: 'LMT' },
  account: { alias: '模拟', account_id: 'DU7654321' }, llm: { prompt_version: 'v1.8.0' }, signature: 'sig-bag', notional_estimate: 710,
  ibkr: { fills: [{ exec_id: 'E1', qty: 2, price: -3.5, sec_type: 'BAG' }] }, commissions: [{ exec_id: 'C1', commission: 1.1, realized_pnl: null }],
};
const ops = [
  // 记录与事件
  ['createRecord', [bagRecord]],
  ['createRecord', [{ id: 'rec-given', created_at: '2026-10-19T10:00:00-04:00', signature: 'sig-a', order: { totalQuantity: '3', lmtPrice: '1.25' }, contract: { symbol: 'NVDA', secType: 'STK' }, account: { alias: '主账户', account_id: 'U1234567' } }]],
  ['createRecord', [{}]],
  ['createRecord', [{ order: { totalQuantity: 'abc' }, contract: { symbol: 5 }, signature: null, z: [3, { b: 1, a: 2 }], '😀': '\ud800x' }]],
  ['appendEvent', [ID(1), 'status', { status: 'Submitted', order_id: 11, perm_id: 22 }]],
  ['appendEvent', [ID(1), 'fill', { exec_id: 'E1', qty: 2, price: -3.5, sec_type: 'BAG' }]],
  ['appendEvent', [ID(1), 'fill', { exec_id: 'E2', qty: 2, price: 10, commission: 0.65 }]],
  ['appendEvent', [ID(1), 'fill', { exec_id: 'E3', qty: 2, price: 5, commission: 0.65, time: '2026-10-19T14:31:00+00:00' }]],
  ['appendEvent', [ID(1), 'fill', { qty: 1, price: 1 }]],
  ['appendEvent', [ID(1), 'commission', { exec_id: 'C1', commission: 9, realized_pnl: 100 }]],
  ['appendEvent', [ID(1), 'commission', { exec_id: 'C2', commission: 0.65, realized_pnl: 12.5 }]],
  ['appendEvent', [ID(1), 'commission', { exec_id: 'C3', commission: '0.65', realized_pnl: '7' }]],
  ['appendEvent', [ID(1), 'commission', { exec_id: 'C3', commission: 0.65, realized_pnl: 7 }]],
  ['appendEvent', [ID(1), 'trigger', { spot: 7700.5 }]],
  ['appendEvent', [ID(1), 'warning', { text: '慢了' }]],
  ['appendEvent', [ID(1), 'status', { status: null, order_id: null }]],
  ['appendEvent', [ID(1), 'other', { x: 1 }]],
  ['getRecord', [ID(1)]],
  ['markSubmitIntent', ['rec-given']],
  ['setFinalStatus', ['rec-given', 'filled']],
  ['setFinalStatus', ['rec-given', 'bogus']],
  ['setFinalStatus', [ID(2), 'ibkr_error', '拒单了']],
  ['getRecord', ['rec-given']],
  ['getRecord', ['missing']],
  ['rememberFills', [[{ exec_id: 'F1', account_id: 'DU7654321', perm_id: 22, time: '20261019 10:31:00', order_ref: ID(1), contract: { secType: 'BAG', symbol: 'SPX' }, b: 2, a: 1 },
    { exec_id: 'E2', time: '20261019 10:31:01', order_ref: ID(1), contract: { secType: 'OPT' } },
    { exec_id: 'F1', time: 'dup' }, { time: 'no id' }, { exec_id: 'F3', order_ref: 'a%b_c', time: '20261019 09:00:00' }, { exec_id: 'F4', order_ref: 'aXbYc', time: '20261019 09:00:01' }]]],
  ['listFills', []], ['countFills', []], ['fillsByOrderRef', [ID(1)]], ['fillsByOrderRef', ['a%b_c']], ['fillsByOrderRef', ['']], ['fillsByOrderRef', [ID(1), 1]],
  ['createRecord', [{ contract: { symbol: 'SPX', secType: 'BAG' }, order: { totalQuantity: 1 }, signature: 'sig-legs' }]],
  ['appendEvent', [ID(4), 'fill', { exec_id: 'F1', qty: 1, price: -2.1 }]],
  ['appendEvent', [ID(4), 'fill', { exec_id: 'E2', qty: 1, price: 4 }]],
  ['appendEvent', [ID(4), 'fill', { exec_id: 'ZZ', qty: 1, price: 9 }]],
  ['getRecord', [ID(4)]],
  ['createRecord', [{ id: 'falsy-time', ibkr: { fills: [] } }]],
  ['appendEvent', ['falsy-time', 'fill', { exec_id: 'T1', qty: 1, price: 1, time: '' }]], ['appendEvent', ['falsy-time', 'fill', { exec_id: 'T2', qty: 1, price: 2, time: null }]],
  ['appendEvent', ['falsy-time', 'fill', { exec_id: 'T3', qty: 1, price: 3, time: 0 }]], ['getRecord', ['falsy-time']],
  ['createRecord', [{ id: 'comm-str', commissions: 'abc' }]], ['getRecord', ['comm-str']],
  ['createRecord', [{ id: 'comm-obj', commissions: { a: 1 } }]], ['getRecord', ['comm-obj']],
  ['createRecord', [{ id: 'comm-num', commissions: 5, ibkr: { fills: [{ exec_id: 'X', qty: 1 }] } }]], ['getRecord', ['comm-num']],
  ['createRecord', [{ id: 'comm-empty', commissions: '' }]], ['getRecord', ['comm-empty']],
  ['rawExec', ["UPDATE trade_records SET signature='x'"]],
  ['rawExec', ["DELETE FROM record_events"]],
  ['rawExec', ["UPDATE audit_log SET actor='x'"]],
  ['listRecords', []], ['exportAll', []],
  ['rawExec', ["INSERT INTO trade_records (id, created_at, signature, quantity, symbol, account_id, record_json) VALUES ('bad-json', '2026-10-19T14:00:00+00:00', '', 0, '', '', '{not json')"]],
  ['getRecord', ['bad-json']],
  ['rawExec', ["INSERT INTO trade_records (id, created_at, signature, quantity, symbol, account_id, record_json) VALUES ('null-json', '2026-10-19T14:00:00+00:00', '', 0, '', '', 'null')"]],
  ['getRecord', ['null-json']],
  ['rawExec', ['SELECT ?', [1]]], ['rawExec', ['SELECT 1', [1]]], ['rawExec', ['SELECT 1; SELECT 2']], ['rawExec', ['']], ['rawExec', ['SELEKT 1']], ['rawExec', ['SELECT ?', [true]]],
  // 审计与平仓痕
  ['audit', ['ui', 'tracker_add', { symbol: 'nvda', targets: { stop_loss: '120.5' }, account: '主账户', sec_type: 'STK' }]],
  ['audit', ['ui', 'tracker_add', { symbol: 'aapl', targets: { stop_loss: -1 } }]],
  ['audit', ['ui', 'tracker_add', { symbol: 'tsla', targets: { stop_loss: 200 }, account: null }]],
  ['audit', ['ui', 'tracker_add', { symbol: 'msft', targets: null }]],
  ['audit', ['ui', 'tracker_add', null]],
  ['audit', ['engine', 'auto_close', { symbol: 'SPX', state: 'stop_loss', mark: 3.2, record: ID(1), leg: '20261016|C7800' }], 1],
  ['audit', ['engine', 'hosted_sweep', { symbol: 'NVDA', state: 'sweep:take_profit', mark: 'abc', record: 5 }], 2],
  ['audit', ['engine', 'hosted_fill', { symbol: 'AAPL', state: 'take_profit' }], 3],
  ['audit', ['engine', 'daily_loss_trip', { alias: '模拟', reason: '亏到上限', until_ms: at(600) }], 4],
  ['audit', ['engine', 'daily_loss_trip', { alias: '', until_ms: 5 }], 5],
  ['rawExec', ["INSERT INTO audit_log (at, actor, action, detail) VALUES ('2026-10-19T14:40:00+00:00', 'engine', 'auto_close', 'not json')"]],
  ['plannedStops', []], ['closeTraces', []], ['closeTraces', [1]],
  ['recentCloses', [at(-60), at(10)]], ['recentCloses', [at(2), at(10)]],
  ['risk.dailyLossTrips', [at(-60), at(10)]],
  // 价位警告
  ['addWatch', [' nvda ', 5]], ['addWatch', ['NVDA']], ['addWatch', ['spy', 0, 'tracker']], ['addWatch', ['', 1]], ['addWatch', ['X', -1]], ['addWatch', ['X', 1001]],
  ['updateWatch', [ID(7), { levels: [1, 2], states: { a: 1 }, wall: null, events: [], touch: { ma: 20 }, enabled: false, step: 2.5, levels_at: iso(1), last_price: 101.5, expiry: '20261020', origin: 'x' }], 1],
  ['updateWatch', [ID(7), { bad: 1 }]], ['updateWatch', [ID(7), {}]], ['updateWatch', ['nope', { step: 1 }]], ['updateWatch', [ID(7), { step: true }]],
  ['listWatches', []], ['getWatch', [ID(7)]], ['getWatch', ['nope']],
  ['rawExec', ["UPDATE alert_watches SET levels='not json', wall='[1]' WHERE symbol='SPY'"]], ['listWatches', []],
  ['deleteWatch', [ID(5)]], ['deleteWatch', [ID(5)]],
  // 持仓追踪
  ['addTrack', [{ account: '模拟', symbol: 'SPX', sec_type: 'OPT', contract: { conId: 1 }, targets: { take_profit: 2 }, leg: '20261016|C7800/C7815/C7830', peak: 1.5, note: '蝶' }], 2],
  ['addTrack', [{ account: '模拟', symbol: 'SPX', sec_type: 'OPT', leg: '20261016|C7800/C7815/C7830' }]],
  ['addTrack', [{ account: '模拟', symbol: 'NVDA' }]], ['addTrack', [{ account: '模拟', symbol: 'NVDA' }]], ['addTrack', [{ symbol: 'AAPL' }]],
  ['addTrack', [{ account: '主账户', symbol: 'TSLA', leg: '', note: null, peak: null }]],
  ['updateTrack', [ID(8), { targets: null, enabled: 0, peak: 3, fired_at: iso(5), fired_state: 'stop_loss', fired_record: 'r', note: 'n', auto_close: { a: 1 } }], 3],
  ['updateTrack', [ID(8), { zeta: 1, alpha: 2, note: 'x' }]], ['updateTrack', [ID(8), {}]], ['updateTrack', ['nope', { note: 'x' }]],
  ['listTracks', []], ['getTrack', [ID(8)]], ['deleteTrack', [ID(13)]],
  ['rawExec', ["UPDATE position_tracks SET contract='', targets='bad' WHERE symbol='TSLA'"]], ['listTracks', []],
  // 优质股
  ['addQualityStock', [' a　b c ', '  为什么\u0001\u0002好\u007f  ' + '😀'.repeat(70)]], ['addQualityStock', ['ABC']], ['addQualityStock', [' \t ']], ['addQualityStock', ['msft']],
  ['updateQualityStock', [ID(14), { note: 'x\n\ny', enabled: false, states: null, events: Array.from({ length: 60 }, (_, i) => ({ i })) }], 4],
  ['updateQualityStock', [ID(14), { events: 'nope', states: { t: 1 } }]], ['updateQualityStock', [ID(14), { b: 1, a: 1 }]], ['updateQualityStock', [ID(14), {}]],
  ['rawExec', ["UPDATE quality_stocks SET states='[1]', events='{}' WHERE symbol='MSFT'"]],
  ['listQualityStocks', []], ['getQualityStock', [ID(14)]], ['deleteQualityStock', [ID(16)]],
  // 偏好
  ['setPref', ['anomaly', { spike: 2.5, b: [1, 2] }]], ['setPref', ['n', null]], ['setPref', ['u']], ['getPref', ['anomaly']], ['getPref', ['n']], ['getPref', ['missing']], ['getPref', ['u']],
  ['rawExec', ["INSERT INTO app_prefs (key, value, updated_at) VALUES ('bad', 'not json', 'x')"]], ['getPref', ['bad']],
  // 板块
  ['addSector', ['  半导体 ']], ['addSector', ['']], ['addSector', [S(51)]], ['addSector', [S(50)]], ['addSector', ['半导体']],
  ['setSectorStocks', [ID(17), [{ symbol: ' nvda ' }, { symbol: 'AMD' }, null, { name: 'x' }, { symbol: 'nvda' }]]],
  ['setSectorStocks', [ID(18), [{ symbol: 'AMD' }, { symbol: 'intc' }]]], ['symbolsInSectors', []],
  ['rawExec', ["UPDATE sectors SET stocks='{}' WHERE name='半导体'"]], ['listSectors', []], ['getSector', [ID(17)]], ['symbolsInSectors', []], ['deleteSector', [ID(18)]],
  // 想法
  ['addIdea', ['  SPX 下午容易拉升,蝴蝶别太早平  ', ['SPX']], 5], ['addIdea', ['止损要坚决 "引号" 测试', ['NVDA', 'nvda']], 6], ['addIdea', ['   ']], ['addIdea', ['蝴蝶 中心 选择', null], 7],
  ['setIdeaStatus', [ID(22), 'archived']], ['setIdeaStatus', [ID(22), 'bogus']], ['setIdeaSymbols', [ID(21), ['SPX', 'ES']]], ['setIdeaAnalysis', [ID(21), { verdict: 'ok', score: 0.7 }]],
  ['listIdeas', []], ['listIdeas', ['archived']], ['listIdeas', ['bogus']], ['listIdeas', [null, 1]], ['getIdea', [ID(21)]],
  ['searchIdeas', [{ symbols: [' spx '] }]], ['searchIdeas', [{ terms: ['蝴蝶'] }]], ['searchIdeas', [{ terms: ['蝴蝶别太', '"引号"'] }]], ['searchIdeas', [{ terms: ['止损要'], symbols: ['ES'] }]],
  ['searchIdeas', [{ statuses: ['active'], since: iso(5.5), until: iso(100) }]], ['searchIdeas', [{ statuses: ['bogus'] }]], ['searchIdeas', [{ limit: 0 }]], ['searchIdeas', [{}]],
  ['rawExec', ["UPDATE ideas SET symbols='bad', analysis='bad' WHERE id=?", [ID(20)]]], ['getIdea', [ID(20)]],
  ['addIdeaDigest', ['archived', [ID(22)], { summary: '总结', b: 1, a: 2 }], 8], ['addIdeaDigest', ['retrieval', [ID(22), ID(23)], { summary: 's' }, { query: 'q' }, [{ id: 't', pnl: 1 }]], 9],
  ['rawExec', ["INSERT INTO idea_digests (id, created_at, idea_ids, digest, focus, trades) VALUES ('d-bad', '2026-10-19T15:00:00+00:00', 'bad', '', '[1]', '{}')"]],
  ['listIdeaDigests', []], ['listIdeaDigests', [1]],
  // 在途记录与防抖
  ['createRecord', [{ id: 'w-old', created_at: iso(-7 * 1440 - 1), signature: 'sig-w', order: { totalQuantity: 1 } }]],
  ['createRecord', [{ id: 'w-edge', created_at: iso(-7 * 1440), signature: 'sig-w', order: { totalQuantity: 4, lmtPrice: 'x' } }]],
  ['createRecord', [{ id: 'w-val', created_at: iso(-1), signature: 'sig-v', order: {} }]],
  ['createRecord', [{ id: 'w-bad', created_at: 'not a date', signature: 'sig-b' }]],
  ['createRecord', [{ id: 'w-intent', created_at: iso(-2), signature: '', order: { totalQuantity: 2 }, account: { alias: '模拟' }, contract: { symbol: 'X' } }]],
  ['appendEvent', ['w-old', 'status', { status: 'Submitted' }]], ['appendEvent', ['w-edge', 'status', { status: 'PreSubmitted' }]],
  ['appendEvent', ['w-val', 'status', { status: 'ValidatedOnly' }]], ['appendEvent', ['w-bad', 'status', { status: 'Submitted' }]], ['markSubmitIntent', ['w-intent']],
  ['rawExec', ["INSERT INTO record_events (record_id, at, kind, payload) VALUES ('w-edge', '2026-10-19T14:30:00+00:00', 'status', 'not json')"]],
  ['listWorkingRecords', []], ['listWorkingRecords', [7, at(0), 1]], ['listWorkingRecords', [0.5]], ['listWorkingRecords', [7, at(0)]], ['listWorkingRecords', [7, at(0) + 1]],
  ['recentOrders', [10, at(0)]], ['risk.recentOrderDetails', [10 * 1440, at(0)]], ['risk.workingOrders', [at(-10 * 1440), at(10)]],
  ['realizedPnlEvents', [at(-60), at(60)]], ['realizedPnlEvents', [at(-60), at(-1)]],
  ['appendEvent', [ID(1), 'commission', { exec_id: 'C9', realized_pnl: 1.7976931348623157e308 }]], ['realizedPnlEvents', [at(-60), at(60)]],
  ['appendEvent', [ID(1), 'commission', { exec_id: 'D1', realized_pnl: -40 }], 11], ['appendEvent', [ID(1), 'commission', { exec_id: 'D2', realized_pnl: 5 }], 12],
  ['appendEvent', [ID(1), 'commission', { exec_id: 'D1', realized_pnl: -999 }], 13], ['realizedPnlEvents', [at(-60), at(60)]], ['realizedPnlEvents', [at(11.5), at(60)]],
  // 信号日志
  ['signals.log', [[{ at: iso(0), source: 'cross', symbol: 'nvda', expect: 'up', price: 120.5, label: S(210), variant: 'v1' }, { at: iso(1), source: 'touch', symbol: 'spy', expect: null, price: null, label: '', variant: null }]]],
  ['signals.log', [[]]],
  ['signals.logOnce', [[{ at: iso(2), source: 'leaders', symbol: 'AMD', expect: 'up', price: 1, label: 'a' }, { at: iso(2), source: 'leaders', symbol: 'amd', expect: 'up', price: 2, label: 'b' }, { at: iso(2), source: 'pa', symbol: 'AMD', expect: 'down', price: 3, label: 'c', variant: 'x' }], iso(0)]],
  ['signals.logOnce', [[{ at: iso(3), source: 'pa', symbol: 'AMD', expect: 'down', price: 3, label: 'c', variant: 'x' }, { at: iso(3), source: 'pa', symbol: 'AMD', expect: 'down', price: 3, label: 'c', variant: 'y' }], iso(0)]],
  ['rawExec', ["INSERT INTO signal_log (at, source, symbol, expect, price, label) VALUES ('2026-10-19T14:35:00+00:00', 'future_source', 'X', 'sideways', 1, 'l')"]],
  ['signals.list', []], ['signals.list', [iso(1.5), 2]], ['signals.listWithSeq', []],
  // 跟单日志
  ['follow.add', [{ at: iso(0), message_id: 'm1', author_id: '123456789012345678', author_name: S(90), text: S(250), outcome: 'sent', detail: S(500), summary: '买 7700C', record_ids: [ID(1), 5] }]],
  ['follow.add', [{ at: iso(0), message_id: 'm1', author_id: 'a', author_name: '', text: 'dup', outcome: 'held', detail: '', summary: '', record_ids: [] }]],
  ['follow.add', [{ at: iso(1), message_id: 'm2', author_id: 'local:Charlie', author_name: 'Charlie', text: 't', outcome: 'mystery', detail: '', summary: '', record_ids: [] }]],
  ['follow.add', [{ at: iso(2), message_id: 'm3', author_id: 'b', author_name: 'B', text: 't3', outcome: 'observed', detail: 'd', summary: 's', record_ids: [] }]],
  ['follow.has', ['m1']], ['follow.has', ['zz']],
  ['follow.addQuote', ['m1', iso(3), { side: 'debit', leader: 3.5, mid: 3.6, natural: 3.8, lag_s: 2.5, paper: true }]],
  ['follow.addQuote', ['m1', iso(4), { side: 'debit', leader: 1, mid: 1, natural: 1, lag_s: 1, paper: false }]],
  ['follow.addQuote', ['m3', iso(4), { side: 'flat', leader: 1, mid: 1, natural: 1, lag_s: 1 }]], ['follow.addQuote', ['m3', iso(4), { side: 'credit', leader: '1', mid: 1, natural: 1, lag_s: 1 }]],
  ['follow.addQuote', ['zz', iso(4), { side: 'credit', leader: 1, mid: 1, natural: 1, lag_s: 1 }]],
  ['follow.verdictsFor', [['m3', 'm1', 'm2', '', 'm1', 'zz']]], ['follow.sentSince', [iso(-1)]], ['follow.sentSince', [iso(1)]], ['follow.recent', []], ['follow.recent', [1]],
  // 消息底账
  ['messages.add', [{ at: iso(0), source: 'discord', message_id: 'x1', author_id: 'a', author_name: S(90), text: S(320), symbols: ['nvda', 'NVDA', 'spx'], guesses: ['spx', 'ZZ', 'zz'], trusted: true, prices: { NVDA: 120.5, SPX: 'x' } }]],
  ['messages.add', [{ at: iso(1), source: 'local', message_id: 'x2', author_id: 'b', author_name: 'B', text: '50%_off "q"', symbols: ['AMD'], guesses: [], trusted: false }]],
  ['messages.add', [{ at: iso(2), source: 'weird', message_id: 'x1', author_id: 'b', author_name: '', text: 'dup', symbols: [], guesses: [], trusted: 1, prices: {} }]],
  ['rawExec', ["INSERT INTO message_log (at, source, message_id, author_id, text, symbols, guesses, trusted, prices) VALUES ('2026-10-19T14:50:00+00:00', 'odd', 'x3', 'c', 't', 'bad', '[1,\"A\"]', 2, '[1]')"]],
  ['messages.has', ['x1']], ['messages.recent', [{}]], ['messages.recent', [{ symbol: 'nvda' }]], ['messages.recent', [{ symbol: 'n%v"d_a', since: iso(0.5), limit: 0 }]], ['messages.recent', [{ limit: 99999 }]], ['messages.recent', [{ symbol: 'n_v%d"a' }]], ['messages.countSince', [iso(-1), 'n_v%da']],
  ['messages.count', []], ['messages.countSince', [iso(0.5)]], ['messages.countSince', [iso(-1), 'AMD']], ['messages.countSince', [iso(-1), '']],
  // 导入的交易
  ['imports.rememberOptionTrades', [[{ account_id: 'U1', id: 'k1', time_et: '2026-10-01 10:00:00', date_et: '2026-10-01', symbol: 'SPX', structure: '蝴蝶', action: '开仓', direction: '买方', qty: 2, net_price: 3.5, realized_pnl: 0, commission: 2.6, legs: 'x', note: '', source: 'csv' },
    { account_id: 'U1', id: 'k1', time_et: 'dup', date_et: '', symbol: '', structure: '', action: '', direction: '', qty: null, net_price: null, realized_pnl: 0, commission: 0, legs: '', note: '', source: '' },
    { account_id: 'U1', id: 'k0', time_et: '2026-09-30 10:00:00', date_et: '2026-09-30', symbol: 'SPX', structure: '单腿', action: '平仓', direction: '', qty: null, net_price: null, realized_pnl: -50.5, commission: 1, legs: '', note: 'n', source: 'csv' }]]],
  ['imports.listOptionTrades', []],
  ['imports.rememberOptionPositions', [[{ account_id: 'U1', id: 'p1', open_et: '2026-10-01 10:00:00', symbol: 'SPX', structure: '蝴蝶', direction: '借方看涨', qty: 1, expiry: '20261001', dte: 0, right: 'C', strikes: '7410/7425/7440', center: 7425, width: 15, ratio: '1:2:1', net_price: 3.2, legs: 'B1 C7410,S2 C7425,B1 C7440', exit: '整体平仓', status: '已了结', closed_et: '2026-10-01 15:00:00', hold_min: 300, realized_pnl: 120, commission: 5.2, source: 'flex' }]]],
  ['imports.listOptionPositions', []],
  ['imports.rememberEntryUnderlying', ['t1', 'SPX', '2026-10-01T10:00:00-04:00', 7420.25, 'bars']], ['imports.rememberEntryUnderlying', ['t1', 'SPX', 'x', 1, 'dup']],
  ['imports.entryUnderlyings', [['t1', 'zz', 't1']]],
  // 向量
  ['vectors.put', ['i1', 'SPX 下午', 'm', [0.1, -2.5, 3.25e-8, 1e40]]], ['vectors.put', ['i2', 'old text', 'm', [1, 2]]], ['vectors.put', ['i1', 'SPX 下午', 'm2', [9]]],
  ['vectors.get', ['m', [['i1', 'SPX 下午'], ['i2', 'new text'], ['zz', 'x']]]], ['vectors.count', ['m']], ['vectors.count', ['none']],
  // 导出、备份、删除
  ['exportAll', []],
  ['backupNow', ['manual'], 10], ['backupNow', ['manual'], 10], ['listBackups', []],
  ['purgeEverything', ['delete all']],
];

function call(store, name, args) {
  const [head, method] = name.includes('.') ? name.split('.') : [null, name];
  if (name === 'listBackups') return safety.listBackups(store.dbPath);
  const target = head === null ? store : head === 'risk' ? store.risk : head === 'signals' ? store.signals : head === 'follow' ? store.follow : head === 'messages' ? store.messages : head === 'imports' ? store.imports : store.vectors;
  if (name === 'vectors.get') return target.get(args[0], args[1].map(([id, text]) => ({ id, text })));
  if (name === 'rawExec') return target.rawExec(args[0], args[1] ?? []);
  return target[method](...args);
}

const work = mkdtempSync(join(tmpdir(), 'store-'));
const dbPath = join(work, 'data', 'trades.db');
const store = new TradeStore(dbPath);
const steps = [];
let lastDump = '';
for (const [name, args, clockMin] of ops) {
  if (clockMin !== undefined) NOW = at(clockMin);
  const argsBefore = structuredClone(args);
  let res;
  try {
    const ret = call(store, name, args);
    res = { ret: plain(ret) };
    if (name === 'createRecord') res.mutated = args[0];
  } catch (e) {
    res = errOf(e);
  }
  const d = JSON.stringify(dumpDb(dbPath));
  steps.push({ name, args: argsBefore, clock: NOW, ...res, dump: d === lastDump ? null : JSON.parse(d) });
  lastDump = d;
}
store.close();
const purgeCheck = (() => {
  const s2 = new TradeStore(join(work, 'p', 'trades.db'));
  s2.purgeEverything('DELETE ALL MY TRADING DATA');
  return ['', '-wal', '-shm'].map((x) => existsSync(join(work, 'p', 'trades.db' + x)));
})();

// ---- 老结构的库:迁移
const OLD_SQL = `
CREATE TABLE ideas (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, text TEXT NOT NULL, symbols TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active');
INSERT INTO ideas VALUES ('i-old', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00', '老想法 蝴蝶 中心', '["SPX"]', 'active');
CREATE TABLE idea_digests (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'archived', idea_count INTEGER NOT NULL DEFAULT 0, idea_ids TEXT NOT NULL DEFAULT '[]', digest TEXT NOT NULL DEFAULT '{}');
CREATE TABLE alert_watches (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, symbol TEXT NOT NULL UNIQUE, step REAL NOT NULL DEFAULT 5.0, enabled INTEGER NOT NULL DEFAULT 1, expiry TEXT NOT NULL DEFAULT '', levels TEXT NOT NULL DEFAULT '[]', states TEXT NOT NULL DEFAULT '{}', last_price REAL, wall TEXT NOT NULL DEFAULT '', events TEXT NOT NULL DEFAULT '[]');
INSERT INTO alert_watches (id, created_at, updated_at, symbol) VALUES ('w-old', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00', 'QQQ');
CREATE TABLE position_tracks (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, account TEXT NOT NULL, symbol TEXT NOT NULL, sec_type TEXT NOT NULL DEFAULT 'STK', contract TEXT NOT NULL DEFAULT '{}', targets TEXT NOT NULL DEFAULT '{}', auto_close TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1, peak REAL, fired_at TEXT, fired_state TEXT NOT NULL DEFAULT '', fired_record TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', UNIQUE(account, symbol, sec_type));
INSERT INTO position_tracks (id, created_at, updated_at, account, symbol, peak, note) VALUES ('t-old', '2026-01-01T00:00:00+00:00', '2026-01-02T00:00:00+00:00', '模拟', 'NVDA', 1.5, '老的');
CREATE TABLE signal_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, source TEXT NOT NULL, symbol TEXT NOT NULL, expect TEXT, price REAL, label TEXT NOT NULL DEFAULT '');
INSERT INTO signal_log (at, source, symbol) VALUES ('2026-01-01T00:00:00+00:00', 'cross', 'QQQ');
`;
const migDir = mkdtempSync(join(tmpdir(), 'store-mig-'));
const migPath = join(migDir, 'trades.db');
{ const db = new Database(migPath); db.exec(OLD_SQL); db.close(); }
NOW = at(30);
uuidN = 1000;
const migStore = new TradeStore(migPath);
const migration = { tracks: migStore.listTracks(), watches: migStore.listWatches(), ideas: migStore.listIdeas(), search: migStore.searchIdeas({ terms: ['蝴蝶 中'] }), signals: migStore.signals.list() };
migStore.close();
migration.dump = dumpDb(migPath);

// ---- 真应用开库的保险
const safe = [];
const sDir = mkdtempSync(join(tmpdir(), 'store-safe-'));
const record = (label, fn) => {
  try { safe.push({ label, ok: plain(fn()) }); } catch (e) { const r = errOf(e); r.error = r.error.replaceAll(sDir, '<S>'); safe.push({ label, ...r }); }
};
const sPath = join(sDir, 'db', 'trades.db');
const listNames = () => safety.listBackups(sPath);
safety.resetIntegrityCache();
NOW = Date.UTC(2026, 9, 19, 1, 0, 0);
record('fresh', () => { const s = new TradeStore(sPath, { safety: true }); const v = dumpDb(sPath).user_version; s.close(); return { v, backups: listNames() }; });
NOW += 3600 * 1000;
record('reopen-daily', () => { const s = new TradeStore(sPath, { safety: true }); s.close(); return listNames(); });
NOW += 3600 * 1000;
record('within-20h', () => { const s = new TradeStore(sPath, { safety: true }); s.close(); return listNames(); });
NOW += 21 * 3600 * 1000;
record('after-20h', () => { const s = new TradeStore(sPath, { safety: true }); s.close(); return listNames(); });
record('same-second-twice', () => { const s = new TradeStore(sPath); const a = s.backupNow('manual'); const b = s.backupNow('manual'); s.close(); return [a, b]; });
record('manual-keep-5', () => { const s = new TradeStore(sPath); for (let i = 0; i < 5; i++) { NOW += 1000; s.backupNow('manual'); } s.close(); return listNames().filter((b) => b.reason === 'manual'); });
for (let i = 0; i < 9; i++) writeFileSync(join(sDir, 'db', 'backups', `trades-202601${String(10 + i).padStart(2, '0')}-000000-daily.db`), 'x'.repeat(i));
writeFileSync(join(sDir, 'db', 'backups', 'trades-20260101-000000-weekly.db'), 'nope');
writeFileSync(join(sDir, 'db', 'backups', 'trades-20260110-000000-daily-3.db'), 'z');
record('list-before-prune', () => listNames());
record('prune', () => safety.pruneBackups(sPath));
record('list-after-prune', () => listNames());
record('newer', () => { const db = new Database(sPath); db.pragma('user_version = 2'); db.close(); return new TradeStore(sPath, { safety: true }); });
record('older', () => { const db = new Database(sPath); db.pragma('user_version = 0'); db.close(); safety.resetIntegrityCache(); const s = new TradeStore(sPath, { safety: true }); s.close(); return { backups: listNames().filter((b) => b.reason === 'upgrade'), v: dumpDb(sPath).user_version }; });
const cPath = join(sDir, 'corrupt', 'trades.db');
mkdirSync(dirname(cPath), { recursive: true });
writeFileSync(cPath, Buffer.from('this is definitely not a sqlite database file, just text, repeated '.repeat(200)));
record('corrupt-header', () => new TradeStore(cPath, { safety: true }));
record('corrupt-no-safety', () => new TradeStore(cPath));
const qPath = join(sDir, 'qc', 'trades.db');
{
  mkdirSync(dirname(qPath), { recursive: true });
  const db = new Database(qPath);
  db.exec("CREATE TABLE t (a TEXT); CREATE INDEX t_a ON t(a);");
  const ins = db.prepare('INSERT INTO t VALUES (?)');
  for (let i = 0; i < 2000; i++) ins.run(`row-${i}-${'p'.repeat(40)}`);
  db.close();
  const bytes = readFileSync(qPath);
  bytes.fill(0x41, 4096 * 3 + 100, 4096 * 3 + 400);
  writeFileSync(qPath, bytes);
}
safety.resetIntegrityCache();
record('quick-check', () => new TradeStore(qPath, { safety: true }));
const roDir = join(sDir, 'ro');
mkdirSync(roDir);
chmodSync(roDir, 0o500);
record('unwritable', () => new TradeStore(join(roDir, 'trades.db'), { safety: true }));
record('unwritable-mkdir', () => new TradeStore(join(roDir, 'sub', 'trades.db'), { safety: true }));
chmodSync(roDir, 0o700);
const lPath = join(sDir, 'locked', 'trades.db');
mkdirSync(dirname(lPath), { recursive: true });
const holder = new Database(lPath);
holder.exec('CREATE TABLE x (a); BEGIN EXCLUSIVE; INSERT INTO x VALUES (1);');
record('locked', () => new TradeStore(lPath, { safety: true }));
holder.exec('ROLLBACK');
holder.close();

// ---- better-sqlite3 本身的行为(store 的接口看不见的那几样):run 的 changes / lastInsertRowid、DEFENSIVE、事务的嵌套、绑定的错
const probeOps = [
  ['exec', 'CREATE TABLE p (id INTEGER PRIMARY KEY, v, w REAL, t TEXT)'],
  ['run', 'INSERT INTO p (v, w, t) VALUES (?, ?, ?)', [1, 2, 'a']], ['run', 'INSERT INTO p (v, w, t) VALUES (?, ?, ?)', [1.5, 2.5, null]],
  ['run', 'UPDATE p SET v = v + 1'], ['run', 'SELECT * FROM p'], ['run', 'CREATE TABLE q (a)'], ['run', 'UPDATE p SET v = 0 WHERE id = 99'],
  ['run', 'INSERT OR IGNORE INTO p (id, v) VALUES (1, 5)'], ['all', 'SELECT id, v, typeof(v) AS tv, w, typeof(w) AS tw, t FROM p'],
  ['run', 'INSERT INTO p (v) VALUES (?)', [9007199254740993]], ['all', 'SELECT v, typeof(v) AS t FROM p WHERE id = 3'],
  ['get', 'SELECT 1 AS a, 2 AS a, 3 AS b'], ['get', 'SELECT * FROM p WHERE id = 99'], ['get', 'UPDATE p SET v = 1'], ['all', 'DELETE FROM p WHERE id = 99'],
  ['pragma', 'table_info(p)'], ['pragmaSimple', 'user_version'], ['pragmaSimple', 'journal_mode'], ['pragma', 'user_version = 7'], ['pragmaSimple', 'user_version'],
  ['pragma', 'nonexistent_pragma'], ['pragmaSimple', 'nonexistent_pragma'],
  ['exec', 'PRAGMA writable_schema = ON'], ['exec', "UPDATE sqlite_master SET sql = 'x' WHERE name = 'q'"], ['exec', 'PRAGMA writable_schema = OFF'],
  ['exec', 'SELECT 1; SELECT 2; ;  '], ['exec', 'INSERT INTO p (v) VALUES (1); SELEKT'], ['all', 'SELECT COUNT(*) AS n FROM p'],
  ['run', 'INSERT INTO p (v) VALUES (?)', []], ['run', 'INSERT INTO p (v) VALUES (?)', [1, 2]], ['run', 'INSERT INTO p (v) VALUES (?)', [false]],
  ['run', 'SELECT 1 /* trailing comment */ -- and this\n ;'], ['run', 'SELECT 1; -- x'], ['run', '  -- only a comment'],
  ['txNested'], ['all', 'SELECT id, v FROM p ORDER BY id'], ['inTransaction'],
  ['run', 'INSERT INTO p (v, t) VALUES (?, ?)', ['😀\ud800', '\u0000x']], ['all', "SELECT t, length(t) AS n, hex(v) AS h FROM p WHERE id = (SELECT max(id) FROM p)"],
  ['run', 'INSERT INTO p (v) VALUES (?)', ['\udc00x\udbff']], ['all', 'SELECT hex(v) AS h FROM p WHERE id = (SELECT max(id) FROM p)'],
  ['run', 'INSERT INTO p (v) VALUES (?)', ['a\udc00b']], ['all', 'SELECT hex(v) AS h FROM p WHERE id = (SELECT max(id) FROM p)'],
];
const probe = (() => {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'probe-')), 'p.db'));
  const out = [];
  for (const [m, sql, args] of probeOps) {
    try {
      let r;
      if (m === 'exec') r = db.exec(sql) && null;
      else if (m === 'pragma') r = db.pragma(sql);
      else if (m === 'pragmaSimple') r = db.pragma(sql, { simple: true });
      else if (m === 'inTransaction') r = db.inTransaction;
      else if (m === 'txNested') {
        const ins = db.prepare('INSERT INTO p (v) VALUES (?)');
        const inner = db.transaction(() => { ins.run(200); throw new Error('里面那层失败'); });
        const outer = db.transaction(() => { ins.run(100); try { inner(); } catch (e) { ins.run(String(e.message)); } ins.run(300); });
        outer();
        const failing = db.transaction(() => { ins.run(400); throw new Error('外层失败'); });
        try { failing(); } catch (e) { r = String(e.message); }
      } else r = db.prepare(sql)[m](...(args ?? []));
      out.push({ ok: r === undefined ? null : r });
    } catch (e) {
      out.push(errOf(e));
    }
  }
  db.close();
  return out;
})();

writeFileSync(join(here, 'store.json'), JSON.stringify({ t0: T0, probeOps, probe, steps, purgeCheck, oldSql: OLD_SQL, migration, safe, sqlite: new Database(':memory:').prepare('SELECT sqlite_version() AS v').get().v }) + '\n');
console.log(`store.json:${steps.length} 步(${steps.filter((s) => s.error).length} 步抛错),迁移 1 段,保险 ${safe.length} 段`);
