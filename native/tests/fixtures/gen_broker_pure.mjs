// 生成 broker_pure.json:engine-ts 的 broker.ts 里的纯函数(原模块现跑),种子固定的大表。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_broker_pure.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_CONFIG, canonOrder, dec, enc, loadBroker, rng } from './broker_world.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const { broker: B, config, tz } = await loadBroker(engine);
const r = rng(0xb20c_e777);
const run = (f) => { try { return { out: enc(f()) }; } catch (e) { return { error: `${e.constructor.name}: ${e.message}` }; } };
const out = {};

// ---------------------------------------------------------------- autoMidLimit / bagSignedLimit
{
  const NaNs = [NaN, Infinity, -Infinity];
  const mids = [0, -0, 0.05, -0.05, 0.1749, 0.175, 0.2, 3.5, -3.5, 12.35, -12.35, 100, -100, 1e-9, -1e-9, ...NaNs];
  const cases = [];
  for (let i = 0; i < 2600; i += 1) {
    const mid = r.chance(0.5) ? r.pick(mids) : (r.next() - 0.5) * r.pick([0.5, 5, 40, 400]);
    const mid2 = r.chance(0.5) ? Math.round(mid * 20) / 20 : mid;
    const action = r.pick(['BUY', 'SELL', 'BUY', 'SELL', 'HOLD', '']);
    const slip = r.pick([0, 0.05, 0.1, 0.3, 1, -0.01, NaN, 0.07, 2.5]);
    const width = r.pick([null, null, 1, 5, 25, 0.3, 0, -1, NaN, 12.35, 3.5]);
    const tick = r.pick([0.05, 0.05, 0.05, 0.01, 0.1, 0, -1, NaN, 0.25]);
    const args = [mid2, action, slip, width, tick];
    cases.push({ in: enc(args), ...run(() => B.autoMidLimit(args[0], args[1], args[2], args[3], args[4])) });
  }
  out.autoMidLimit = cases;
  const bag = [];
  for (const action of ['BUY', 'SELL', 'HOLD', '']) for (const lim of [null, 0, -0, 1, -1, 12.35, NaN, Infinity, 1e-9]) bag.push({ in: enc([action, lim]), ...run(() => B.bagSignedLimit(action, lim)) });
  out.bagSignedLimit = bag;
}

// ---------------------------------------------------------------- cleanPrice / finiteQuote(unknown 的各种值)
{
  const U = '__undefined__';
  const values = [U, null, 0, -0, 1, -1, 12.5, 1e-9, 1e21, NaN, Infinity, -Infinity, '', ' ', '12.5', ' 7 ', '1e3', '-3', 'abc', '0x10', '0b11', 'Infinity', '-Infinity', '.5', '5.', '1,5', true, false, [], [5], [1, 2], ['7'], [[3]], {}, { a: 1 }, 'NaN', '٣'];
  const mk = (v) => (v === U ? undefined : v);
  out.cleanPrice = values.map((v) => ({ in: enc(v), ...run(() => B.cleanPrice(mk(v))) }));
  out.finiteQuote = values.map((v) => ({ in: enc(v), ...run(() => B.finiteQuote(mk(v))) }));
}

// ---------------------------------------------------------------- quoteErrorMessage
{
  const codes = [101, 10197, 354, 10089, 10167, 2104, 200, 0, 1.5, -1, 10090];
  const msgs = ['Max number of tickers has been reached', 'Requested market data is not subscribed', 'x'.repeat(150), '汉字'.repeat(70), '😀'.repeat(61), 'a'.repeat(119) + '😀', '', ' ', 'line\nbreak', 'quote "x" \\ back'];
  const cases = [];
  for (let i = 0; i < 400; i += 1) {
    const n = r.int(6);
    const errors = Array.from({ length: n }, () => [r.pick(codes), r.pick(msgs)]);
    const symbol = r.pick(['SPX', 'AAPL', 'A', '汉', '']);
    cases.push({ in: enc([symbol, errors]), ...run(() => B.quoteErrorMessage(symbol, errors)) });
  }
  out.quoteErrorMessage = cases;
}

// ---------------------------------------------------------------- strikeWidth / priceConditionSpec / shouldFire
{
  const mkLeg = (strike) => ({ action: 'BUY', ratio: 1, lastTradeDateOrContractMonth: '20261016', strike, right: 'C', tradingClass: null, multiplier: '100' });
  const strikes = [7500, 7525, 7550, 7600, 7525, 0.5, NaN, '7500', 1e6, -5, 7500.25];
  const cases = [];
  for (let i = 0; i < 700; i += 1) {
    const n = r.pick([0, 1, 2, 2, 3, 3, 3, 4, 5]);
    const legs = r.chance(0.05) ? null : Array.from({ length: n }, () => mkLeg(r.pick(strikes)));
    const contract = { secType: 'BAG', symbol: 'SPX', combo_strategy: r.pick(['VERTICAL', 'BUTTERFLY', 'IRON_CONDOR', null, 'BUTTERFLY']), legs };
    if (r.chance(0.05)) delete contract.legs;
    cases.push({ in: enc(contract), ...run(() => B.strikeWidth(dec(enc(contract)))) });
  }
  out.strikeWidth = cases;

  const trigs = [
    { type: 'PRICE', symbol: 'SPX', secType: 'IND', operator: '>=', value: 7500 }, { type: 'PRICE', symbol: 'AAPL', secType: 'STK', operator: '<=', value: 190.5 },
    { symbol: 'X', secType: 'STK', operator: '>', value: 1 }, { symbol: 'X', operator: '>=' }, {}, null, '__undefined__', 5, 'str', { symbol: 'Y', secType: 'IND', operator: '>=', value: 0 },
    { symbol: 'Y', secType: 'IND', operator: '>=', value: NaN },
  ];
  out.priceConditionSpec = trigs.map((t) => ({ in: enc(t), ...run(() => B.priceConditionSpec(t === '__undefined__' ? undefined : dec(enc(t)))) }));
  const fires = [];
  for (const t of trigs.filter((x) => x && typeof x === 'object')) for (const p of [0, 1, 7499.99, 7500, 7500.01, 190.5, NaN, Infinity, -1]) {
    fires.push({ in: enc([t, p]), ...run(() => B.shouldFire({ record_id: 'r', approved: {}, trigger: dec(enc(t)), created_at: '', fired: false }, p)) });
  }
  out.shouldFire = fires;
}

// ---------------------------------------------------------------- bookLiquidity
{
  const sizes = [0, 1, 5, 100, 250.55, -3, '7', '', null, '__undefined__', 'abc', NaN, true, 1e9];
  const lvl = () => { const o = { price: 100 }; const s = r.pick(sizes); if (s !== '__undefined__') o.size = s; return o; };
  const l1s = [{ spread_bps: 4.99 }, { spread_bps: 5.5 }, { spread_bps: 19.99 }, { spread_bps: 20.5 }, { spread_bps: 21 }, { spread_bps: 59.9 }, { spread_bps: 60 }, { spread_bps: 60.1 }, { bid_size: 'abc' }, { ask_size: 'abc' }, { bid_size: 'abc', ask_size: 'x' }, { bid_size: true, ask_size: 'abc' }, undefined, null, {}, { spread_bps: 3 }, { spread_bps: 5 }, { spread_bps: 5.01 }, { spread_bps: 20 }, { spread_bps: 60.5 }, { spread_bps: 1000 }, { spread_bps: null }, { spread_bps: '4' }, { spread_bps: 'x' }, { spread_bps: NaN }, { spread_bps: 0 },
    { bid_size: 10, ask_size: 30 }, { bid_size: 0, ask_size: 0 }, { bid_size: null, ask_size: 5 }, { bid_size: '8', ask_size: '2' }, { bid_size: 3 }, { spread_bps: 4, bid_size: 10, ask_size: 20 }, { bid_size: -5, ask_size: 1 }];
  const cases = [];
  for (let i = 0; i < 600; i += 1) {
    const book = {};
    const l1 = r.pick(l1s);
    if (l1 !== undefined) book.l1 = l1;
    const nb = r.pick([0, 0, 1, 2, 5]), na = r.pick([0, 0, 1, 3, 5]);
    if (r.chance(0.9)) book.bids = Array.from({ length: nb }, lvl);
    if (r.chance(0.9)) book.asks = Array.from({ length: na }, lvl);
    cases.push({ in: enc(book), ...run(() => B.bookLiquidity(dec(enc(book)))) });
  }
  out.bookLiquidity = cases;
}

// ---------------------------------------------------------------- buildOrderIntent
{
  const types = ['MKT', 'LMT', 'STP', 'STP LMT', 'TRAIL', 'FOK', ''];
  const numOrNull = () => r.pick([null, null, 230, 99.95, 0.01, 1500]);
  const cases = [];
  for (let i = 0; i < 1200; i += 1) {
    const spec = {
      action: r.pick(['BUY', 'SELL']), orderType: r.pick(types), totalQuantity: r.pick([1, 100, 2, 1000]), price_mode: r.pick(['EXPLICIT', 'AUTO_MID']),
      lmtPrice: numOrNull(), auxPrice: numOrNull(), trailingPercent: r.pick([null, null, 5, 0.5, 100]), tif: r.pick(['DAY', 'GTC']), outsideRth: r.chance(0.3),
    };
    // 键缺失(undefined)与 null 的区别 C++ 的 optional 表达不了:OrderSpec 的 schema 总会补齐这几格,不进夹具(报告里记为未钉住)
    const override = r.pick([null, null, null, 7.95, -3.25, 0, NaN, Infinity, 230]);
    const actionOverride = r.pick([null, null, 'BUY', 'SELL']);
    const acct = r.pick(['DU7654321', 'U1234567', '']);
    cases.push({ in: enc([spec, acct, override, actionOverride]), ...run(() => canonOrder(B.buildOrderIntent(structuredClone(spec), acct, override, actionOverride))) });
  }
  out.buildOrderIntent = cases;
}

// ---------------------------------------------------------------- lastRthSession
{
  const variants = [
    {},
    { market_holidays: ['2026-10-12', '2026-10-13'], early_close_days: ['2026-10-14'] },
    { market_holidays: Array.from({ length: 24 }, (_, i) => new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10)) },
    { early_close_days: ['2026-11-27', '2026-12-24', '2026-10-15'], market_holidays: ['2026-11-26', '2026-12-25', '2027-01-01'] },
  ];
  const settingsList = variants.map((v) => config.fromDict({ ...JSON.parse(JSON.stringify(BASE_CONFIG)), ...v, storage: { db_path: '/tmp/x/trades.db' } }));
  const cases = [];
  const base = Date.UTC(2026, 8, 1);
  for (let i = 0; i < 700; i += 1) {
    const epoch = base + Math.floor(r.next() * 140 * 86400000);
    const vi = r.int(variants.length);
    const now = config.etNowFromEpoch(epoch);
    cases.push({ in: enc([epoch, vi]), ...run(() => B.lastRthSession(now, settingsList[vi])) });
  }
  for (const [d, h, m] of [['2026-10-12', 16, 0], ['2026-10-12', 15, 59], ['2026-11-27', 13, 0], ['2026-11-27', 12, 59], ['2026-10-17', 12, 0], ['2026-10-13', 2, 0]]) {
    const epoch = tz.wallToEpoch({ year: Number(d.slice(0, 4)), month: Number(d.slice(5, 7)), day: Number(d.slice(8)), hour: h, minute: m, second: 0 }, tz.ET);
    for (let vi = 0; vi < variants.length; vi += 1) cases.push({ in: enc([epoch, vi]), ...run(() => B.lastRthSession(config.etNowFromEpoch(epoch), settingsList[vi])) });
  }
  out.lastRthSession = cases;
  out.lastRthVariants = variants;
}

// ---------------------------------------------------------------- contemporaneousBasis
{
  const times = Array.from({ length: 8 }, (_, i) => `2026-10-12 15:${String(50 + i).padStart(2, '0')}`);
  const closes = [7600.5, 7650.25, 0, -1, NaN, Infinity, 7700, 7700.00005, 1e6, 1, 0.5];
  const mk = () => Array.from({ length: r.int(7) }, () => ({ time: r.pick(times), close: r.pick(closes) }));
  const cases = [];
  for (let i = 0; i < 400; i += 1) {
    const a = mk(), b = mk();
    cases.push({ in: enc([a, b]), ...run(() => B.contemporaneousBasis(a, b)) });
  }
  out.contemporaneousBasis = cases;
}

// ---------------------------------------------------------------- parseIbTime / fillRow
{
  const U = '__undefined__';
  const strs = ['20261012  09:35:00', '20261012 09:35:00 US/Eastern', '20261012-13:35:00', '20261012 09:35:00 America/Chicago', '20261012 09:35:00 Asia/Shanghai', '20261012', '20261012 ', ' 20261012  09:35:00 ', '2026-10-12 09:35:00', '2026-10-12T09:35:00', '2026-10-12 09:35:00.123', '2026-10-12T09:35:00Z',
    '2026-10-12', '1791815400', '1791815400000', '12345678', '123456789', '0', '00', '', '   ', 'garbage', '20261301  09:35:00', '20261012  25:00:00', '20260308  02:30:00', '20261101  01:30:00', '20261101 01:30:00 US/Eastern', '2026-02-30 10:00:00', 'Mon Oct 12 2026 09:35:00 GMT-0400', '٢٠٢٦', '9'.repeat(400), '1e3', '+123', '-123', '12.5',
    '20261012  09:35:00 Bad/Zone', '20261012 09:35 US/Eastern', '2026-10-12 9:35:00', 'Oct 12, 2026', '2026/10/12 09:35:00'];
  const values = [U, null, 0, 1791815400000, 1791815400, -5, 1.5, NaN, Infinity, -Infinity, 8.64e15, 8.65e15, true, false, [], ['20261012'], {}, ...strs];
  const mk = (v) => (v === U ? undefined : v);
  out.parseIbTime = values.map((v) => ({ in: enc(v), ...run(() => B.parseIbTime(mk(v))) }));

  const fr = [];
  const times2 = [...strs.slice(0, 14), U, null, 1791815400000, NaN];
  const mkc = () => {
    const c = {};
    const put = (k, vals) => { const v = r.pick(vals); if (v !== U) c[k] = v; };
    put('secType', ['OPT', 'STK', 'BAG', '', null, U, 5]); put('symbol', ['SPX', 'AAPL', '', null, U]); put('lastTradeDateOrContractMonth', ['20261012', '', null, U, 20261012]);
    put('strike', [7600, 0, -0, '7600', null, U, NaN, Infinity, 'x', 7600.5]); put('right', ['C', 'P', '', null, U]); put('tradingClass', ['SPXW', '', null, U]);
    put('multiplier', ['100', 100, null, U, '']); put('conId', [123, 0, '456', null, U, NaN, 12.9, -3, 1e12]); put('currency', ['USD', null, U]); put('exchange', ['SMART', '', U]);
    return c;
  };
  const mke = () => {
    const e = {};
    const put = (k, vals) => { const v = r.pick(vals); if (v !== U) e[k] = v; };
    put('execId', ['e1', 'e2', '', null, U, 7, 'x'.repeat(5)]); const t = r.pick(times2); if (t !== U) e.time = t; put('acctNumber', ['DU7654321', null, U, '']); put('side', ['BOT', 'SLD', '', U]);
    put('shares', [1, 2.5, 0, '3', null, U, NaN, -1, 'x']); put('price', [3.2, 0, '4.5', null, U, NaN, -0]); put('orderId', [5, 0, '7', null, U, NaN, 5.9, -2]); put('permId', [600, 0, null, U, 'x', 1e11]);
    put('orderRef', ['rec-1', '', null, U]); put('commission', [0.65, 0, null, U, NaN, Infinity, '1.5', 1e308]);
    return e;
  };
  for (let i = 0; i < 900; i += 1) {
    const c = r.chance(0.05) ? r.pick([null, {}, 5, 'x']) : mkc(), e = r.chance(0.04) ? r.pick([null, {}, 5]) : mke();
    fr.push({ in: enc([c, e]), ...run(() => B.fillRow(dec(enc(c)) ?? {}, dec(enc(e)) ?? {})) });
  }
  out.fillRow = fr;
}

const text = JSON.stringify(out);
writeFileSync(join(here, 'broker_pure.json'), text);
console.log(`broker_pure.json:${(text.length / 1024).toFixed(0)} KB`);
