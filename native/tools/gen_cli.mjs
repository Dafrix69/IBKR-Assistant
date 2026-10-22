// 生成 tests/fixtures/cli.json:命令行入口(engine-ts 的 cli.ts main(argv))——原模块现跑,记下每一行 console.log / console.error、返回码与落到磁盘上的东西。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tools/gen_cli.mjs <编过的 engine-ts 目录>
//
// 怎么跑:每个场景一个新的临时目录(配置 = baseline/rpc/base_config.json + 临时库,IBKR_USER_DATA_DIR 指到临时目录,时钟固定),
// 真的 main(argv)。不连券商、不碰真配置与真库、不写钥匙串(set-key 不在这里:它会写真的系统凭证库,C++ 那边用假的 setSecret 另测)。
// rpc 子命令只走到「读配置、开库」就抛的那几条(配置不在 / 不是 JSON / 校验不过、库坏了 / 比软件新),不会起服务。
// process.exit(行情快照写错了)换成抛一个标记,记成 {exit: 码}。main() 抛的错记成 {threw: "<类名>: <话>"}。
// 输出里的随机与机器相关的东西(uuid、临时目录)在这里与 C++ 测试里同一组正则换成占位串(norm 字段原样写进夹具,两边读同一份)。
// 固定输入、无随机;同一台机器上跑两次逐字节相同。
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const imp = (p) => import(pathToFileURL(join(engine, 'dist/src', p)).href);
const Database = createRequire(join(engine, 'package.json'))('better-sqlite3');

const root = mkdtempSync(join(tmpdir(), 'cli-oracle-'));
process.env.IBKR_USER_DATA_DIR = root;

const { main } = await imp('cli.js');
const { setClock } = await imp('config.js');
const { TradeStore } = await imp('store.js');
const { REQUIRED_COLUMNS } = await imp('fillsCsv.js');
const { OPTION_COLUMNS } = await imp('optionTradesCsv.js');
const { POSITION_COLUMNS } = await imp('optionPositionsCsv.js');
const base = JSON.parse(readFileSync(join(engine, 'baseline', 'rpc', 'base_config.json'), 'utf-8'));

const NORM = [
  ['[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '<ID>'],
  ['已记下\\([0-9a-f]{8}\\)', '已记下(<ID8>)'],
  ['\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})?', '<TS>'],
];
const norm = (text, dir) => {
  let t = text.split(dir).join('<DIR>');
  for (const [re, rep] of NORM) t = t.replace(new RegExp(re, 'g'), rep);
  return t;
};

const CLOCKS = { open: Date.parse('2026-08-14T10:32:00-04:00'), saturday: Date.parse('2026-08-15T10:32:00-04:00'), after: Date.parse('2026-08-14T20:10:00-04:00') };

// ---------------------------------------------------------------- 夹具文件
const PAYLOAD = {
  orders: [{
    intent_summary: '限价 230 买入 100 股 AAPL', contract: { secType: 'STK', symbol: 'AAPL', exchange: 'SMART', currency: 'USD' }, execution_type: 'IMMEDIATE', trigger: null, account: 'DEFAULT',
    order: { action: 'BUY', orderType: 'LMT', totalQuantity: 100, price_mode: 'EXPLICIT', lmtPrice: 230.0, tif: 'DAY', outsideRth: false }, reason: '回调到位', confidence: 0.99, warnings: [],
  }],
  rejections: [{ original_text: '顺便梭哈', code: 'UNCLEAR', message: '「梭哈」没有明确数量与标的,拒绝。' }],
};
const withOrder = (patch) => ({ ...PAYLOAD, orders: [{ ...PAYLOAD.orders[0], ...patch }] });
const FILES = {
  'good.json': JSON.stringify(PAYLOAD),
  'lowconf.json': JSON.stringify(withOrder({ confidence: 0.5 })),
  'big.json': JSON.stringify(withOrder({ order: { ...PAYLOAD.orders[0].order, totalQuantity: 1000 } })),
  'twoaccounts.json': JSON.stringify({ orders: [PAYLOAD.orders[0], { ...PAYLOAD.orders[0], account: '主账户', intent_summary: '实盘买入' }, { ...PAYLOAD.orders[0], account: '没有这个' }], rejections: [] }),
  'schemaerr.json': JSON.stringify({ orders: [{ ...PAYLOAD.orders[0], contract: { secType: 'STK', exchange: 'SMART', currency: 'USD' } }, PAYLOAD.orders[0]], rejections: [{ nope: 1 }] }),
  'mkt.json': JSON.stringify(withOrder({ order: { action: 'BUY', orderType: 'MKT', totalQuantity: 100, price_mode: 'EXPLICIT', lmtPrice: null, tif: 'DAY', outsideRth: false } })),
  'empty.json': JSON.stringify({ orders: [], rejections: [] }),
  'notobject.json': '[]',
  'nullpayload.json': 'null',
  'ordersnotarray.json': '{"orders":{},"rejections":[]}',
  'badjson.json': '{"orders": [',
  'bom.json': '﻿' + JSON.stringify(PAYLOAD),
  'option.json': JSON.stringify(withOrder({ contract: { secType: 'OPT', symbol: 'SPX', exchange: 'SMART', currency: 'USD', lastTradeDateOrContractMonth: '20260814', strike: 7500, right: 'C', multiplier: '100' }, order: { ...PAYLOAD.orders[0].order, totalQuantity: 2, lmtPrice: 3.5 } })),
};
const FCOLS = [...REQUIRED_COLUMNS];
const good = { trade_time_utc: '2025-10-31T09:13:36Z', symbol: 'AAPL', sec_type: 'STK', currency: 'USD', side: 'BUY', size: '10', price: '150', exchange: 'X', commission: '1', order_id: '5', trade_id: 'g1' };
const fl = (o) => FCOLS.map((c) => o[c]).join(',');
FILES['fills.csv'] = [FCOLS.join(','), fl(good), fl({ ...good, trade_id: 'g2', size: '0' }), fl(good), fl({ ...good, trade_id: 'g3', symbol: 'nvda', price: '900.5' }), fl({ ...good, trade_id: 'g4', sec_type: 'OPT' })].join('\n');
FILES['fills-bom.csv'] = '﻿' + FILES['fills.csv'].replace(/\n/g, '\r\n');
FILES['fills-missing-col.csv'] = 'trade_time_utc,symbol\n2025-10-31T09:13:36Z,AAPL\n';
const OCOLS = [...OPTION_COLUMNS];
const tgood = { time_et: '2026-07-20 10:23:05', date_et: '2026-07-20', symbol: 'SPX', asset: '期权', structure: '蝴蝶', action: '平仓', direction: '', qty: '1', net_price: '2', realized_pnl: '50', commission: '1', legs: 'B1 C7410,S2 C7425,B1 C7440', order_ids: '1', note: '' };
const qq = (v) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const tl = (o) => OCOLS.map((c) => qq(o[c])).join(',');
FILES['trades.csv'] = [OCOLS.join(','), tl(tgood), tl({ ...tgood, time_et: '2026-07-21 11:00:00', date_et: '2026-07-21', action: '开仓', realized_pnl: '0' }), tl({ ...tgood, qty: '0' }), tl({ ...tgood, time_et: '2026-07-22 11:00:00', date_et: '2026-07-22', action: '到期结算', realized_pnl: '-20.5' })].join('\n');
const PCOLS = Object.entries(POSITION_COLUMNS);
const q = (s) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const pgood = { open: '2026-07-20 10:23:05', symbol: 'SPX', structure: '蝴蝶', direction: '', qty: '1', expiry: '20260720', dte: '0', right: 'p', strikes: '1/2/3', center: '2', width: '1', ratio: '1:2:1', netPrice: '1', legs: 'L', exit: '持有到期', status: '已了结', closed: '', holdMin: '5', pnl: '10', commission: '1' };
const pl = (o) => PCOLS.map(([k]) => q(o[k])).join(',');
FILES['positions.csv'] = [PCOLS.map(([, c]) => q(c)).join(','), pl(pgood), pl({ ...pgood, open: '2026-07-21 10:00:00', structure: '垂直价差' }), pl({ ...pgood, open: '2026-07-22 10:00:00' }), pl({ ...pgood, qty: 'x' })].join('\n');

// ---------------------------------------------------------------- 跑一个场景
class ExitSignal extends Error { constructor(code) { super(`exit ${code}`); this.code = code; } }
let n = 0;
async function run(spec) {
  n += 1;
  const dir = join(root, `s${n}`);
  mkdirSync(dir);
  // broker.auto_connect 关掉:万一哪个 rpc 场景没在 serve() 之前抛,也不会去连任何券商
  const configTemplate = { ...base, broker: { provider: 'ibkr', auto_connect: false }, storage: { db_path: '{DIR}/t.db' }, ...(spec.config ?? {}) };
  const config = JSON.parse(JSON.stringify(configTemplate).split('{DIR}').join(dir));
  const settingsPath = join(dir, 'settings.json');
  if (spec.rawConfig !== undefined) writeFileSync(settingsPath, spec.rawConfig);
  else if (!spec.noConfig) writeFileSync(settingsPath, JSON.stringify(config));
  for (const [name, text] of Object.entries(FILES)) writeFileSync(join(dir, name), text);
  for (const [name, text] of Object.entries(spec.files ?? {})) writeFileSync(join(dir, name), text);
  setClock(CLOCKS[spec.clock ?? 'open']);
  const log = [], err = [];
  const oLog = console.log, oErr = console.error, oExit = process.exit;
  console.log = (...a) => log.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  process.exit = (c) => { throw new ExitSignal(c); };
  const res = { argv: spec.argv };
  const argv = spec.argv.map((a) => a.split('{DIR}').join(dir));
  void argv;
  const oCwd = process.cwd();
  try {
    if (spec.cwd) process.chdir(dir);
    if (spec.chmod) chmodSync(join(dir, spec.chmod[0]), spec.chmod[1]);
    for (const step of spec.before ?? []) await step(dir);
    if (spec.steps?.length) {
      const store = new TradeStore(config.storage.db_path);
      for (const step of spec.steps) {
        if (step.createRecord) store.createRecord(JSON.parse(JSON.stringify(step.createRecord)));
        else if (step.appendEvent) store.appendEvent(...step.appendEvent);
        else if (step.setFinalStatus) store.setFinalStatus(...step.setFinalStatus);
        else if (step.addIdea) { const idea = store.addIdea(...step.addIdea); if (step.status) store.setIdeaStatus(idea.id, step.status); }
        else throw new Error(`没有这种步骤:${JSON.stringify(step)}`);
      }
      store.close();
    }
    const runs = spec.argvs ?? [spec.argv];
    for (let i = 0; i < runs.length; i += 1) {
      if (runs.length > 1) log.push(`--- run ${i + 1} ---`);
      const a = runs[i].map((x) => x.split('{DIR}').join(dir));
      if (spec.config_flag !== false && !runs[i].includes('--config') && !spec.noConfigFlag) a.push('--config', settingsPath);
      res.code = await main(a);
      (res.codes ??= []).push(res.code);
    }
  } catch (e) {
    if (e instanceof ExitSignal) res.exit = e.code;
    else res.threw = `${e?.constructor?.name}: ${e?.message}`;
  } finally {
    process.chdir(oCwd);
    if (spec.chmod) chmodSync(join(dir, spec.chmod[0]), 0o644);
    console.log = oLog; console.error = oErr; process.exit = oExit;
  }
  res.log = log.map((l) => norm(l, dir));
  res.err = err.map((l) => norm(l, dir));
  if (res.threw) res.threw = norm(res.threw, dir);
  res.files = {};
  for (const f of spec.read ?? []) {
    try { res.files[f] = norm(readFileSync(join(dir, f), 'utf-8'), dir); } catch (e) { res.files[f] = `ENOENT`; void e; }
  }
  if (spec.dbExport) {
    const store = new TradeStore(config.storage.db_path);
    res.db = norm(JSON.stringify(store.exportAll(), null, 2), dir);
    store.close();
  }
  res.dirFiles = readdirSync(dir).filter((f) => !(f in FILES) && f !== 'settings.json' && !(f in (spec.files ?? {}))).sort();
  return { spec: { name: spec.name, argv: spec.argv, clock: spec.clock ?? 'open', files: spec.files ?? {}, rawConfig: spec.rawConfig ?? null, noConfig: !!spec.noConfig,
    read: spec.read ?? [], dbExport: !!spec.dbExport, noConfigFlag: !!spec.noConfigFlag, cwd: !!spec.cwd, subdir: !!spec.subdir, chmod: spec.chmod ?? null, newerDb: !!spec.newerDb, dbIsDir: !!spec.dbIsDir, steps: spec.steps ?? [], argvs: spec.argvs ?? null, configTemplate }, res };
}

const S = [];
const add = (name, argv, extra = {}) => S.push({ name, argv, ...extra });

// ---- selftest
add('selftest, market open', ['selftest']);
add('selftest, saturday', ['selftest'], { clock: 'saturday' });
add('selftest, after hours', ['selftest'], { clock: 'after' });
add('selftest with auto_execute on', ['selftest'], { config: { policies: { ...base.policies, auto_execute: true, allow_live_trading: true } } });
add('selftest, --config before the command', ['--config', '{DIR}/settings.json', 'selftest'], { noConfigFlag: true });
add('selftest, --config in the middle', ['selftest', '--config', '{DIR}/settings.json', 'extra'], { noConfigFlag: true });
// ---- validate
add('validate good payload', ['validate', '{DIR}/good.json']);
add('validate good payload with snapshot', ['validate', '{DIR}/good.json', '--snapshot', 'AAPL=230.1,spx=7462.35']);
add('validate low confidence', ['validate', '{DIR}/lowconf.json']);
add('validate exceeds limit', ['validate', '{DIR}/big.json']);
add('validate two accounts and an unknown one', ['validate', '{DIR}/twoaccounts.json']);
add('validate schema errors', ['validate', '{DIR}/schemaerr.json']);
add('validate empty', ['validate', '{DIR}/empty.json']);
add('validate option order', ['validate', '{DIR}/option.json', '--snapshot', 'SPX=7500']);
add('validate option order after hours', ['validate', '{DIR}/option.json'], { clock: 'after' });
add('validate payload that is an array', ['validate', '{DIR}/notobject.json']);
add('validate payload null', ['validate', '{DIR}/nullpayload.json']);
add('validate orders not an array', ['validate', '{DIR}/ordersnotarray.json']);
add('validate bad json', ['validate', '{DIR}/badjson.json']);
add('validate bom', ['validate', '{DIR}/bom.json']);
add('validate missing file', ['validate', '{DIR}/nope.json']);
add('validate a directory', ['validate', '{DIR}']);
add('validate market order priced from the snapshot', ['validate', '{DIR}/mkt.json', '--snapshot', 'aapl=200.5']);
add('validate market order without a snapshot', ['validate', '{DIR}/mkt.json']);
add('validate market order with an empty-key snapshot entry', ['validate', '{DIR}/mkt.json', '--snapshot', '=5,AAPL=201']);
add('validate with an empty path', ['validate', '']);
add('validate unreadable file', ['validate', '{DIR}/good.json'], { chmod: ['good.json', 0] });
add('import-fills with a relative path', ['import-fills', 'fills.csv', '--account', '模拟'], { cwd: true, dbExport: true });
add('import-fills with a path through a subdirectory', ['import-fills', '{DIR}/sub/../fills.csv', '--account', '模拟', '--dry-run'], { before: [async (dir) => { mkdirSync(join(dir, 'sub')); }], subdir: true });
add('validate bad snapshot exits', ['validate', '{DIR}/good.json', '--snapshot', 'AAPL=abc']);
add('validate snapshot odd spellings', ['validate', '{DIR}/good.json', '--snapshot', ' ß = 1 , aapl=0x10 ,, x=Infinity,y=,z=  ,k=1e3']);
add('validate snapshot with no value for the flag', ['validate', '{DIR}/good.json', '--snapshot']);
add('parse is not ported but reads the snapshot first', ['parse', 'hello', '--snapshot', 'AAPL=bad']);
// ---- 库
add('records on an empty db', ['records']);
add('records with limit', ['records', '--limit', '3']);
add('ideas on an empty db', ['ideas']);
add('idea then ideas', ['idea', '看多 NVDA 回调到 130 加仓'], { argvs: [['idea', '看多 NVDA 回调到 130 加仓'], ['ideas']], dbExport: true });
add('idea with several symbols and a sentence', ['idea', 'AAPL 和 MSFT 财报后再看,SPX 7500 附近减仓'], { argvs: [['idea', 'AAPL 和 MSFT 财报后再看,SPX 7500 附近减仓'], ['ideas', '--all']], dbExport: true });
add('halt', ['halt'], { read: ['breaker.json'], dbExport: true });
add('halt with reason', ['halt', '--reason', '手动停一下 "quote"'], { read: ['breaker.json'], dbExport: true });
add('resume without a halt', ['resume'], { read: ['breaker.json'], dbExport: true });
add('export', ['export', '{DIR}/out.json'], { read: ['out.json'] });
add('export without a path', ['export']);
add('usage with no command', []);
add('usage with unknown command', ['frobnicate']);
add('usage with only --config', ['--config', '{DIR}/settings.json'], { noConfigFlag: true });
// ---- import
add('import-fills dry run', ['import-fills', '{DIR}/fills.csv', '--account', '模拟', '--dry-run']);
add('import-fills', ['import-fills', '{DIR}/fills.csv', '--account', '模拟'], { dbExport: true });
add('import-fills with BOM and CRLF into the real account', ['import-fills', '{DIR}/fills-bom.csv', '--account', '主账户'], { dbExport: true });
add('import-fills missing column', ['import-fills', '{DIR}/fills-missing-col.csv', '--account', '模拟']);
add('import-fills unknown alias', ['import-fills', '{DIR}/fills.csv', '--account', '没有']);
add('import-fills no alias', ['import-fills', '{DIR}/fills.csv']);
add('import-fills no file', ['import-fills', '--account', '模拟']);
add('import-fills missing file', ['import-fills', '{DIR}/nope.csv', '--account', '模拟']);
add('import-fills no accounts configured', ['import-fills', '{DIR}/fills.csv', '--account', 'x'], { config: { accounts: [] } });
add('import-option-trades dry run', ['import-option-trades', '{DIR}/trades.csv', '--account', '模拟', '--dry-run']);
add('import-option-trades', ['import-option-trades', '{DIR}/trades.csv', '--account', '模拟'], { dbExport: true });
add('import-option-trades unknown alias', ['import-option-trades', '{DIR}/trades.csv', '--account', '没有']);
add('import-option-positions dry run', ['import-option-positions', '{DIR}/positions.csv', '--account', '主账户', '--dry-run']);
add('import-option-positions', ['import-option-positions', '{DIR}/positions.csv', '--account', '主账户'], { dbExport: true });
add('import-option-positions unknown alias', ['import-option-positions', '{DIR}/positions.csv']);
const REC = (id, symbol, qty, at) => ({ id, created_at: at, signature: `sig-${id}`, contract: { secType: 'STK', symbol }, order: { action: 'BUY', orderType: 'LMT', totalQuantity: qty, lmtPrice: 230 }, account: { alias: '模拟', account_id: 'DU7654321' }, llm: { prompt_version: 'v1.8.0' }, intent_summary: `买 ${symbol}` });
const RECSTEPS = [{ createRecord: REC('rec-1', 'AAPL', 100, '2026-08-14T13:00:00+00:00') }, { createRecord: REC('rec-2', 'NVDA', 5, '2026-08-14T14:00:00+00:00') }, { createRecord: REC('rec-3', 'MSFT', 7, '2026-08-14T15:00:00+00:00') },
  { appendEvent: ['rec-1', 'submitted', { order_id: 17 }] }, { appendEvent: ['rec-1', 'status', { status: 'Filled', filled: 100 }] }, { setFinalStatus: ['rec-1', 'filled'] }];
add('records with data', ['records'], { steps: RECSTEPS });
add('records with limit 2', ['records', '--limit', '2'], { steps: RECSTEPS });
add('records with limit 0 and junk', ['records', '--limit', 'abc'], { steps: RECSTEPS });
add('records with limit written oddly', ['records', '--limit', ' 2 '], { steps: RECSTEPS });
add('ideas listing', ['ideas'], { steps: [{ addIdea: ['买 AAPL', ['AAPL']] }, { addIdea: ['看 SPX 7500', ['SPX']] }] });
add('ideas with --all and limit', ['ideas', '--all', '--limit', '1'], { steps: [{ addIdea: ['买 AAPL', ['AAPL']] }, { addIdea: ['看 SPX 7500', ['SPX']] }] });
add('import-fills twice: second run sees them', ['import-fills', '{DIR}/fills.csv', '--account', '模拟'], { argvs: [['import-fills', '{DIR}/fills.csv', '--account', '模拟'], ['import-fills', '{DIR}/fills.csv', '--account', '模拟']], dbExport: true });
add('import-option-trades twice', ['import-option-trades', '{DIR}/trades.csv', '--account', '模拟'], { argvs: [['import-option-trades', '{DIR}/trades.csv', '--account', '模拟'], ['import-option-trades', '{DIR}/trades.csv', '--account', '模拟']], dbExport: true });
add('import-option-positions twice, then the other account', ['import-option-positions', '{DIR}/positions.csv', '--account', '主账户'], { argvs: [['import-option-positions', '{DIR}/positions.csv', '--account', '主账户'], ['import-option-positions', '{DIR}/positions.csv', '--account', '主账户'], ['import-option-positions', '{DIR}/positions.csv', '--account', '模拟']], dbExport: true });
add('halt then resume', ['halt'], { argvs: [['halt', '--reason', 'r1'], ['resume']], read: ['breaker.json'], dbExport: true });
add('idea with no ticker in it', ['idea', '随便记一句没有代码的话'], { argvs: [['idea', '随便记一句没有代码的话'], ['ideas']] });
const MANY = Array.from({ length: 22 }, (_, i) => ({ addIdea: [`想法 ${i} AAPL`, ['AAPL']] }));
add('ideas default limit is 20', ['ideas'], { steps: MANY });
add('ideas --all includes archived ones, default does not', ['ideas'], { argvs: [['ideas'], ['ideas', '--all']], steps: [{ addIdea: ['活的', ['AAPL']] }, { addIdea: ['归档的', ['MSFT']], status: 'archived' }, { addIdea: ['做完的', ['SPX']], status: 'done' }] });
add('export into a directory that does not exist', ['export', '{DIR}/nodir/out.json']);
add('export onto a directory', ['export', '{DIR}'], {});
add('import-option-trades for one account then the other', ['import-option-trades', '{DIR}/trades.csv', '--account', '模拟'], { argvs: [['import-option-trades', '{DIR}/trades.csv', '--account', '模拟'], ['import-option-trades', '{DIR}/trades.csv', '--account', '主账户']], dbExport: true });
// ---- 配置读不进来(非 rpc 命令:main 抛)
add('missing config for selftest', ['selftest'], { noConfig: true });
add('syntax error in config for selftest', ['selftest'], { rawConfig: '{"limits": ' });
add('invalid config for selftest', ['selftest'], { config: { limits: { ...base.limits, max_order_notional: -1 } } });
// ---- rpc 那一支的错误映射(走到 serve 之前就抛的)
add('rpc: missing config', ['rpc'], { noConfig: true });
add('rpc: config is not json', ['rpc'], { rawConfig: '{"limits": \n  oops' });
add('rpc: config is not an object', ['rpc'], { rawConfig: '[1,2]' });
add('rpc: config fails validation', ['rpc'], { config: { limits: { ...base.limits, max_order_notional: -1 } } });
add('rpc: db is corrupt', ['rpc'], { files: { 't.db': 'this is not a sqlite database at all, just text\n'.repeat(200) } });
add('rpc: db is newer than the software', ['rpc'], { before: [async (dir) => { const db = new Database(join(dir, 't.db')); db.pragma('user_version = 999'); db.close(); }], newerDb: true });
add('rpc: db path is a directory', ['rpc'], { before: [async (dir) => { mkdirSync(join(dir, 't.db')); }], dbIsDir: true });

const out = { norm: NORM, clocks: CLOCKS, base: base, files: FILES, scenarios: [] };
for (const spec of S) {
  const r = await run(spec);
  out.scenarios.push(r);
}
writeFileSync(join(here, '..', 'tests', 'fixtures', 'cli.json'), JSON.stringify(out));
console.log(`cli.json:${out.scenarios.length} 个场景`);
process.exit(0);
