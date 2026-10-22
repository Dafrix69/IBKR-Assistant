// 生成 ib-wire-out.json 与 ib-wire-in.json:TS 引擎在用的 @stoqey/ib(MIT)的 Encoder / Decoder 现跑,给 C++ 的
// native/engine/execution/tws/wire_out.* 与 wire_in.* 对拍(tests/tst_ib_wire.cpp)。
//
// 发出去:每个请求在接口版本 100..193 的各档上,拿随机与边角的参数(STK/OPT/FOP/BAG/IND/FUT 合约、1–4 腿的组合、引擎用的各种单型、
//   缺的键、null、怪类型、中文与 emoji)调库的 Encoder,记下它交给 sendMsg 的字段(展平之后、布尔还没变 0/1)、按 socket.js 拼出的字节、
//   报的错(Controller 那一层的样子:[话, code, reqId ?? -1, undefined]),以及抛出来的 TypeError。IBApi 那一层补的缺省值(cancelOrder 的
//   orderCancel、reqMktData 的 genericTickList ?? ""、reqPnL 的 modelCode ?? ""、reqIds 的 0、reqHistoricalData 不传 chartOptions)另记一节。
// 读进来:每种消息号在几档接口版本上,字段由"读到哪种就造哪种"的录制跑出来(解码器要整数就给像整数的串,要串就给串……),
//   再整条 / 截短 / 多出几格喂给一个新的 Decoder(同 socket.js:enqueueMessage 再 process),记下它发的每一个事件(含 error / info,
//   按真实先后:读不够时先报错、再发已经排队的),以及 process() 抛出来的东西(坏 JSON 的 SyntaxError、条件数过大的 RangeError)。
//   另有"流":同一个 Decoder 连着收几条再处理,出过错之后队列里剩的东西怎么被下一条读走。
//
//   ELECTRON_RUN_AS_NODE=1 /tmp/claude-501/accept/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
//     native/tests/fixtures/gen_ib_wire.mjs /tmp/claude-501/ibkr-stage2/engine-ts
//
// 报文全是合成的:账号是 U1234567 / DU7654321 这种样子的假号。
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给 engine-ts 目录(里面有 node_modules/@stoqey/ib)');
const require = createRequire(join(engine, 'package.json'));
const { Decoder } = require('@stoqey/ib/dist/core/io/decoder.js');
const { Encoder } = require('@stoqey/ib/dist/core/io/encoder.js');
const { Socket } = require('@stoqey/ib/dist/core/io/socket.js');
const { IBApi } = require('@stoqey/ib/dist/api/api.js');
const libVersion = require('@stoqey/ib/package.json').version;
const encoderSource = readFileSync(require.resolve('@stoqey/ib/dist/core/io/encoder.js'), 'utf8');

let seed = 0x1b0e_7a11;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const chance = (p) => rnd() < p;
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const enc = (o) => JSON.parse(JSON.stringify(o === undefined ? '__undefined__' : o, (k, v) => {
  if (v === undefined) return '__undefined__';
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return '__NaN__';
    if (v === Infinity) return '__Inf__';
    if (v === -Infinity) return '__-Inf__';
    if (Object.is(v, -0)) return '__neg0__';
  }
  return v;
}));
// 数组里的 undefined 也写成占位串(enc 的 replacer 对数组元素同样调用,所以 enc 已经够了;这里只是给参数表用的别名)
const encArgs = (args) => enc(args);

// ---------------------------------------------------------------- 发出去
function flattenDeep(arr, out = []) {
  for (const v of arr) Array.isArray(v) ? flattenDeep(v, out) : out.push(v);
  return out;
}
// 照 socket.js 的 send():展平、布尔变 0/1、\0 连起来、TextEncoder 编码、首格不是串时加 4 字节长度(= 字节数 + 1)与末尾的 0
function sendBytes(tokens) {
  tokens = flattenDeep(tokens);
  tokens.forEach((v, i) => { if (v === true || v === false || v instanceof Boolean) tokens[i] = v ? 1 : 0; });
  const data = Array.from(new TextEncoder().encode(tokens.join('\0')));
  const framed = typeof tokens[0] !== 'string' ? [...[24, 16, 8, 0].map((s) => 0xff & ((data.length + 1) >> s)), ...data, 0] : data;
  return Buffer.from(new Uint8Array(framed)).toString('hex');
}
const errorName = (e) => `${e.constructor.name}: ${e.message}`;
function runEncoder(sv, call, withHex = true) {
  const sent = [];
  const errors = [];
  const encoder = new Encoder({
    serverVersion: sv,
    sendMsg: (t) => sent.push(t),
    // Controller.emitError:new Error(话), code, reqId ?? NO_VALID_ID, advancedOrderReject
    emitError: (msg, code, reqId, advanced) => errors.push({ name: 'error', args: [msg, code, reqId ?? -1, advanced] }),
  });
  try {
    call(encoder);
  } catch (e) {
    return { error: errorName(e), errors: enc(errors), sent: sent.length };
  }
  if (sent.length > 1) throw new Error('一次调用发了两条');
  const r = { errors: enc(errors) };
  if (sent.length) { r.tokens = enc(flattenDeep(sent[0])); if (withHex) r.hex = sendBytes(sent[0]); }
  return r;
}

const versions = [100, 101, 102, 103, 105, 106, 110, 111, 124, 131, 136, 138, 139, 141, 142, 145, 146, 148, 149, 150, 151, 156, 158, 160, 162, 163, 164,
  165, 166, 169, 170, 176, 177, 178, 182, 183, 184, 185, 186, 187, 188, 189, 190, 191, 192, 193];
const sv = () => (chance(0.3) ? pick([100, 150, 163, 176, 187, 193]) : pick(versions));

const weird = [undefined, null, 0, -0, 1, -1, 2.5, NaN, Infinity, -Infinity, Number.MAX_VALUE, 2147483647, 1e21, 1e-7, '', 'x', ' 7 ', '中文', 'a😀b', true, false, [], [1, 'b'], {}, { a: 1 }];
const strs = ['', 'SMART', 'CBOE', 'GLOBEX', 'USD', 'SPX', 'SPXW', 'AAPL', 'ES', 'MES', '期权', 'é', 'İ', 'tab\there', 'a😀', 'x,y'];
const nums = [0, 1, -1, 2, 7790, 7790.5, 0.05, 1e-9, 123456789, -0, 2147483647, Number.MAX_VALUE, NaN, Infinity];
const maybe = (p, f) => (chance(p) ? f() : undefined);
const value = () => (chance(0.15) ? pick(weird) : chance(0.5) ? pick(strs) : pick(nums));

function setSome(o, key, p, f) { if (chance(p)) o[key] = f(); }
function comboLeg() {
  const l = {};
  setSome(l, 'conId', 0.95, () => (chance(0.9) ? int(1, 900000000) : value()));
  setSome(l, 'ratio', 0.9, () => (chance(0.9) ? int(1, 3) : value()));
  setSome(l, 'action', 0.9, () => pick(['BUY', 'SELL', 'SSHORT', value()]));
  setSome(l, 'exchange', 0.9, () => pick(['SMART', 'CBOE', '', value()]));
  setSome(l, 'openClose', 0.4, () => pick([0, 1, 2, value()]));
  setSome(l, 'shortSaleSlot', 0.3, () => pick([0, 1, 2, value()]));
  setSome(l, 'designatedLocation', 0.3, () => pick(['', 'X', value()]));
  setSome(l, 'exemptCode', 0.3, () => pick([-1, 0, 3, value()]));
  return l;
}
function contract() {
  // 串当合约不测:"AAPL".strike 是 String.prototype.strike(一个函数),拼进字段是函数的源码,引擎不会这样传
  if (chance(0.015)) return pick([undefined, null, 5]);
  const c = {};
  const secType = chance(0.04) ? pick([5, 'bag', 'Bag', '', null, ['BAG'], true]) : pick(['STK', 'OPT', 'FOP', 'BAG', 'BAG', 'IND', 'FUT', 'CASH']);
  setSome(c, 'conId', 0.6, () => (chance(0.9) ? int(1, 900000000) : value()));
  setSome(c, 'symbol', 0.9, () => pick(['SPX', 'AAPL', 'ES', 'MES', 'XSP', 'QQQ', '中文', value()]));
  c.secType = secType;
  if (secType === undefined) delete c.secType;
  setSome(c, 'lastTradeDateOrContractMonth', 0.5, () => pick(['20261007', '202612', '', value()]));
  setSome(c, 'strike', 0.5, () => pick([7790, 7790.5, 0, 225, value()]));
  setSome(c, 'right', 0.5, () => pick(['C', 'P', 'CALL', '', value()]));
  setSome(c, 'multiplier', 0.4, () => pick(['100', 50, '', value()]));
  setSome(c, 'exchange', 0.85, () => pick(['SMART', 'CBOE', 'GLOBEX', 'CME', 'IBKRATS', 'BEST', value()]));
  setSome(c, 'primaryExch', 0.3, () => pick(['NASDAQ', 'ARCA', '', value()]));
  setSome(c, 'currency', 0.85, () => pick(['USD', 'HKD', value()]));
  setSome(c, 'localSymbol', 0.4, () => pick(['SPXW  261007P07790000', 'ESZ6', value()]));
  setSome(c, 'tradingClass', 0.4, () => pick(['SPXW', 'ES', '', value()]));
  setSome(c, 'includeExpired', 0.2, () => pick([true, false, value()]));
  setSome(c, 'secIdType', 0.1, () => pick(['ISIN', value()]));
  setSome(c, 'secId', 0.1, () => pick(['US0378331005', value()]));
  setSome(c, 'issuerId', 0.1, () => pick(['e123', '', value()]));
  if (secType === 'BAG' || chance(0.1)) {
    const r = rnd();
    if (r < 0.85) c.comboLegs = Array.from({ length: int(1, 4) }, comboLeg);
    else if (r < 0.9) c.comboLegs = [];
    else c.comboLegs = pick([null, 'ab', { length: 2 }, 5, [null], [comboLeg(), 3]]);
  }
  if (chance(0.08)) c.deltaNeutralContract = chance(0.85) ? { conId: int(1, 9999), delta: pick([0.5, -0.25, NaN]), price: pick([100.5, 0]) } : pick(['x', 1, {}]);
  return c;
}

// placeOrder 读的 order.* 键:从库的源码里扒(漏不了)
const placeOrderSrc = encoderSource.slice(encoderSource.indexOf('placeOrder(id, contract, order) {'), encoderSource.indexOf('replaceFA(reqId, faDataType, xml) {'));
const orderKeys = [...new Set([...placeOrderSrc.matchAll(/order\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))];
const condition = () => {
  const type = chance(0.9) ? pick([1, 3, 4, 5, 6, 7]) : pick([2, '1', undefined, null, 99]);
  const c = { type, conjunctionConnection: pick(['and', 'or', 'AND', undefined]) };
  for (const k of ['secType', 'exchange', 'symbol', 'isMore', 'strValue', 'conId', 'triggerMethod']) setSome(c, k, 0.8, () => pick([value(), true, 'SMART', '7800', 1234]));
  return c;
};
const tagValues = () => {
  const r = rnd();
  if (r < 0.8) return Array.from({ length: int(1, 3) }, () => ({ tag: pick(['NonGuaranteed', 'maxPctVol', value()]), value: pick(['1', '0.1', value()]) }));
  if (r < 0.9) return [];
  return pick([null, 'ab', { length: 1 }, [null], 7]);
};
function order() {
  if (chance(0.01)) return pick([undefined, null]);
  const o = {};
  const orderType = chance(0.05) ? value() : pick(['MKT', 'LMT', 'STP', 'STP LMT', 'TRAIL', 'TRAIL LIMIT', 'REL', 'VOL', 'PEG BENCH', 'PEGBENCH', 'PEG BEST', 'PEGBEST', 'PEG MID', 'PEGMID']);
  o.action = chance(0.95) ? pick(['BUY', 'SELL']) : value();
  o.orderType = orderType;
  setSome(o, 'totalQuantity', 0.95, () => (chance(0.85) ? pick([1, 2, 10, 0.5, 2.5, 100]) : value()));
  setSome(o, 'lmtPrice', 0.6, () => (chance(0.85) ? pick([1.05, -2.35, 0, 12.5, Number.MAX_VALUE]) : value()));
  setSome(o, 'auxPrice', 0.4, () => (chance(0.85) ? pick([7700, 0.5, Number.MAX_VALUE]) : value()));
  setSome(o, 'tif', 0.8, () => pick(['DAY', 'GTC', 'IOC', value()]));
  setSome(o, 'ocaGroup', 0.3, () => pick(['oca-1', '跟单', value()]));
  setSome(o, 'ocaType', 0.3, () => pick([1, 2, 3, value()]));
  setSome(o, 'outsideRth', 0.5, () => pick([true, false, value()]));
  setSome(o, 'transmit', 0.8, () => pick([true, false, value()]));
  setSome(o, 'parentId', 0.2, () => pick([0, 1234, value()]));
  setSome(o, 'account', 0.6, () => pick(['U1234567', 'DU7654321', value()]));
  setSome(o, 'trailStopPrice', 0.2, () => pick([7700, value()]));
  setSome(o, 'trailingPercent', 0.2, () => pick([1.5, value()]));
  if (chance(0.12)) {
    o.deltaNeutralOrderType = pick(['MKT', 'LMT', '']);
    for (const k of ['deltaNeutralAuxPrice', 'deltaNeutralConId', 'deltaNeutralSettlingFirm', 'deltaNeutralClearingAccount', 'deltaNeutralClearingIntent',
      'deltaNeutralOpenClose', 'deltaNeutralShortSale', 'deltaNeutralShortSaleSlot', 'deltaNeutralDesignatedLocation']) setSome(o, k, 0.9, value);
  }
  if (chance(0.3)) o.orderComboLegs = chance(0.85) ? Array.from({ length: int(1, 4) }, () => (chance(0.9) ? { price: pick([1.2, Number.MAX_VALUE, undefined, value()]) } : {})) : pick([[], null, 'ab', { length: 1 }, [null]]);
  if (chance(0.3)) o.smartComboRoutingParams = tagValues();
  if (chance(0.2)) { o.algoStrategy = pick(['Adaptive', '', value()]); if (chance(0.8)) o.algoParams = tagValues(); }
  if (chance(0.2)) o.conditions = chance(0.85) ? Array.from({ length: int(1, 3) }, condition) : pick([[], null, 'ab', { length: 1 }, [null]]);
  if (chance(0.15)) o.softDollarTier = chance(0.8) ? { name: pick(['', 'n', value()]), value: pick(['', 'v', value()]) } : value();
  setSome(o, 'competeAgainstBestOffset', 0.1, () => pick([Infinity, 0.5, value()]));
  for (const k of orderKeys) if (!(k in o) && !['orderComboLegs', 'smartComboRoutingParams', 'algoParams', 'conditions', 'softDollarTier', 'algoStrategy'].includes(k)) setSome(o, k, 0.025, value);
  return o;
}
const reqId = () => (chance(0.9) ? int(0, 100000) : value());
const arg = (p, f) => (chance(p) ? f() : value());

const out = { generator: 'native/tests/fixtures/gen_ib_wire.mjs', library: `@stoqey/ib ${libVersion}`, encoder: [], api: [] };
const encCase = (fn, version, args) => {
  // 字节只抽两成记(其余靠字段表;拼字节的规矩是同一个函数)
  const r = runEncoder(version, (e) => e[fn](...args), chance(0.2));
  out.encoder.push({ fn, sv: version, args: encArgs(args), ...r });
};
const N = { placeOrder: 1500, reqContractDetails: 300, reqMktData: 400, reqHistoricalData: 400, reqMktDepth: 300, cancelOrder: 300, reqExecutions: 150 };
for (let i = 0; i < N.placeOrder; i += 1) encCase('placeOrder', sv(), [reqId(), contract(), order()]);
for (let i = 0; i < N.reqContractDetails; i += 1) encCase('reqContractDetails', sv(), [reqId(), contract()]);
for (let i = 0; i < N.reqMktData; i += 1) encCase('reqMktData', sv(), [reqId(), contract(), arg(0.8, () => pick(['', '100,101,106', '233'])), arg(0.8, () => pick([true, false])), arg(0.8, () => pick([true, false]))]);
for (let i = 0; i < N.reqHistoricalData; i += 1) {
  encCase('reqHistoricalData', sv(), [reqId(), contract(), arg(0.8, () => pick(['', '20261007 16:00:00 US/Eastern'])), arg(0.8, () => pick(['1 D', '2 W'])),
    arg(0.8, () => pick(['1 min', '5 mins', '1 day'])), arg(0.8, () => pick(['TRADES', 'MIDPOINT', 'schedule', 'SCHEDULE'])), arg(0.8, () => pick([0, 1, true, false])),
    arg(0.8, () => pick([1, 2])), arg(0.8, () => pick([true, false])), chance(0.5) ? undefined : tagValues()]);
}
for (let i = 0; i < N.reqMktDepth; i += 1) encCase('reqMktDepth', sv(), [reqId(), contract(), arg(0.8, () => pick([5, 10])), arg(0.8, () => pick([true, false])), chance(0.5) ? undefined : tagValues()]);
const orderCancel = () => {
  if (chance(0.1)) return pick([undefined, null, 'x', 5]);
  const c = {};
  setSome(c, 'manualOrderCancelTime', 0.5, () => pick(['', '20261007-10:00:00', value()]));
  setSome(c, 'extOperator', 0.6, () => pick(['', 'op', value()]));
  setSome(c, 'manualOrderIndicator', 0.5, () => pick([0, 1, null, value()]));
  return c;
};
for (let i = 0; i < N.cancelOrder; i += 1) encCase('cancelOrder', sv(), [reqId(), orderCancel()]);
const filter = () => {
  if (chance(0.05)) return pick([undefined, null]);
  const f = {};
  for (const k of ['clientId', 'acctCode', 'time', 'symbol', 'secType', 'exchange', 'side']) setSome(f, k, 0.5, value);
  return f;
};
for (let i = 0; i < N.reqExecutions; i += 1) encCase('reqExecutions', sv(), [reqId(), filter()]);
for (let i = 0; i < 60; i += 1) {
  const v = sv();
  encCase('cancelMktData', v, [reqId()]);
  encCase('reqMarketDataType', v, [arg(0.8, () => pick([1, 2, 3, 4]))]);
  encCase('cancelHistoricalData', v, [reqId()]);
  encCase('reqAccountSummary', v, [reqId(), arg(0.8, () => 'All'), arg(0.8, () => pick(['NetLiquidation,BuyingPower', '$LEDGER']))]);
  encCase('cancelAccountSummary', v, [reqId()]);
  encCase('reqPnL', v, [reqId(), arg(0.8, () => 'U1234567'), arg(0.5, () => '')]);
  encCase('cancelPnL', v, [reqId()]);
  encCase('cancelMktDepth', v, [reqId(), arg(0.8, () => pick([true, false]))]);
  encCase('reqAutoOpenOrders', v, [arg(0.8, () => pick([true, false]))]);
  encCase('reqSecDefOptParams', v, [reqId(), arg(0.8, () => pick(['SPX', 'ES'])), arg(0.8, () => pick(['', 'CME'])), arg(0.8, () => pick(['IND', 'FUT'])), arg(0.8, () => int(1, 9e8))]);
  encCase('reqIds', v, [arg(0.8, () => pick([0, 1]))]);
  for (const fn of ['reqPositions', 'cancelPositions', 'reqAllOpenOrders', 'reqOpenOrders', 'reqManagedAccts', 'reqCurrentTime']) encCase(fn, v, []);
}
// 握手之后的报到:socket.js 的 startAPI()(this 换成一个只有版本与 client id 的假 socket)
out.startApi = [];
for (const v of [100, 150, 193]) for (const id of [0, 9012, 2147483647, -1]) {
  let tokens;
  Socket.prototype.startAPI.call({ serverVersion: v, _clientId: id, send: (t) => { tokens = t; } });
  out.startApi.push({ sv: v, clientId: id, tokens: enc(tokens), hex: sendBytes(tokens) });
}
// IBApi 那一层(引擎调的是它):this 换成一个假 controller,schedule 立刻执行
function runApi(version, fn, args) {
  return runEncoder(version, (encoder) => IBApi.prototype[fn].call({ controller: { schedule: (f) => f(), encoder } }, ...args));
}
for (let i = 0; i < 80; i += 1) {
  const v = sv();
  const cases = [
    ['cancelOrder', [reqId(), chance(0.5) ? undefined : chance(0.5) ? pick(['', '20261007-10:00:00']) : orderCancel()]],
    ['reqMktData', [reqId(), contract(), chance(0.5) ? undefined : arg(0.5, () => '233'), arg(0.8, () => false), arg(0.8, () => false)]],
    ['reqPnL', [reqId(), 'U1234567', chance(0.5) ? undefined : pick(['', null, 'M'])]],
    ['reqIds', chance(0.5) ? [] : [arg(0.5, () => 1)]],
    ['reqHistoricalData', [reqId(), contract(), '', '1 D', '1 min', 'TRADES', 1, 1, chance(0.5)]],
  ];
  for (const [fn, args] of cases) out.api.push({ fn, sv: v, args: encArgs(args), ...runApi(v, fn, args) });
}

// ---------------------------------------------------------------- 读进来
const readers = ['readStr', 'readBool', 'readDouble', 'readDoubleOrUndefined', 'readDecimal', 'readInt', 'readIntOrUndefined'];
const intTok = () => {
  const r = rnd();
  if (r < 0.55) return String(int(0, 3));
  if (r < 0.65) return String(int(0, 40));
  if (r < 0.73) return '';
  if (r < 0.96) return pick(['-1', '-0', '1', '2', '13', '66', '67', '68', '83', '2147483647', ' 7', '7x', 'abc', '1.9', '0x10', '+3', '1e3', '51', '11', '26', '-5', '9007199254740993']);
  return String(int(-100000, 1e9));
};
// 定点样本用:造串 / 造数时一半取这里给的(null = 不偏)
const bias = { str: null, dbl: null };
const dblTok = () => {
  if (bias.dbl && rnd() < 0.5) return pick(bias.dbl);
  const r = rnd();
  if (r < 0.5) return String(pick([0, 1, -1, -2, 1.25, 7790.5, 0.05, 123.456, -0.75, 1e-5]));
  if (r < 0.6) return '';
  if (r < 0.85) return pick(['1.7976931348623157E308', '1.7976931348623157e+308', 'Infinity', '-Infinity', 'NaN', '-0', '1,234.5', '1e400', ' 2.5', '3.5abc', 'x', '2147483647', '.5']);
  return String((rnd() - 0.5) * 1e6);
};
const strTok = () => {
  if (bias.str && rnd() < 0.5) return pick(bias.str);
  const r = rnd();
  if (r < 0.3) return pick(['', 'SPX', 'OPT', 'BAG', 'FUND', 'STK', 'P', 'C', 'CALL', 'SMART', 'USD', 'MKT', 'LMT', 'Submitted', 'U1234567']);
  if (r < 0.4) return pick(['PEG BENCH', 'PEGBENCH', 'VOL', 'Adaptive', 'and', 'OR', 'İstanbul', 'ΣΑΣ', 'Straße']);
  if (r < 0.5) return pick(['20261007', '20261007-16:00:00', '20261007 16:00 US/Eastern', '-20261007', 'a-b-c', 'x\\s+y', '202612']);
  if (r < 0.6) return pick(['\\u8ba2\\u5355', 'a\\u005cu0041b', 'x\\uzzzzy', '\\u12', '中文', 'a😀b', 'tab\tx', '"quoted"', '1,000']);
  if (r < 0.7) return pick(['{"rejectReason":"x","code":7}', '{"r":"\\u4f59"}', '[1,2]', 'null', '"s"', '{bad', '', 'x']);
  if (r < 0.85) return intTok();
  return dblTok();
};
const boolTok = () => pick(['0', '1', '', '2', '-1', 'true', '0x1', ' 1', '0.5', '1e3', '00', '-0', '-0x1', '+0x1', '-0x0', ' \t0X10', '0x']);
function synth(version, msgId, firstInt, condCount) {
  // 录制跑:解码器每读一格,按它要的类型现造一格;过了 600 格就停(负数的条数会一直读下去)
  const log = [String(msgId)];
  synth.condDone = false;
  let kind = 'readStr';
  const d = new Decoder({ serverVersion: version, emitEvent() {}, emitError() {}, emitInfo() {} });
  for (const m of readers) {
    if (m === 'readStr') continue;
    const orig = d[m].bind(d);
    d[m] = () => { const prev = kind; kind = m; try { return orig(); } finally { kind = prev; } };
  }
  d.readStr = () => {
    if (log.length > 600) throw Object.assign(new Error('stop'), { name: 'UnderrunError' });
    const t = condCount !== undefined && kind === 'readInt' && new Error().stack.includes('readConditions') && !synth.condDone ? (synth.condDone = true, condCount) : firstInt !== undefined && kind === 'readInt' ? firstInt : kind === 'readStr' ? strTok() : kind === 'readBool' ? boolTok() : kind.startsWith('readInt') ? intTok() : dblTok();
    if (kind === 'readInt') firstInt = undefined;
    log.push(t);
    return t;
  };
  try { d.processMsg(msgId); } catch { /* 录到哪算哪 */ }
  return log;
}
function decodeOnce(version, tokens) {
  const emits = [];
  const d = new Decoder({
    serverVersion: version,
    emitEvent: (name, ...args) => emits.push({ name, args }),
    emitError: (msg, code, reqId, advanced) => emits.push({ name: 'error', args: [msg, code, reqId ?? -1, advanced] }),
    emitInfo: (msg, code) => emits.push({ name: 'info', args: [msg, code] }),
  });
  d.enqueueMessage(tokens);
  let thrown;
  try { d.process(); } catch (e) { thrown = errorName(e); }
  const r = { emits: enc(emits) };
  if (thrown !== undefined) r.thrown = thrown;
  return r;
}
const ported = { 1: 60, 2: 40, 3: 120, 4: 160, 5: 220, 9: 20, 10: 200, 11: 160, 12: 30, 13: 40, 15: 15, 17: 80, 21: 120, 45: 20, 46: 20, 49: 15, 52: 15,
  53: 10, 55: 15, 57: 15, 58: 15, 59: 40, 61: 60, 62: 10, 63: 30, 64: 15, 75: 60, 76: 15, 81: 30, 90: 30, 94: 50, 100: 30 };
const inCases = [];
const pushIn = (name, version, tokens) => inCases.push({ name, sv: version, tokens, ...decodeOnce(version, tokens) });
for (const [id, n] of Object.entries(ported)) {
  for (let i = 0; i < n; i += 1) {
    const version = sv();
    // 消息里自带版本号的几种:版本格按引擎可能见到的范围造(否则高版本的分支多半走不到)
    const firstInt = { 3: pick(['1', '2', '5', '6', '7']), 5: String(pick([1, 2, 3, 4, 5, 9, 11, 17, 18, 21, 22, 26, 27, 29, 30, 31, 32, 33, 34, 34, 34, 51])),
      10: String(int(1, 8)), 11: String(int(1, 11)), 17: String(int(1, 3)), 21: String(int(1, 7)), 61: String(int(1, 3)) }[id];
    const tokens = synth(version, Number(id), chance(0.9) ? firstInt : undefined);
    pushIn(`${id} full`, version, tokens);
    if (tokens.length > 1 && chance(0.6)) pushIn(`${id} cut`, version, tokens.slice(0, int(0, tokens.length - 1)));
    if (chance(0.25)) pushIn(`${id} extra`, version, [...tokens, ...Array.from({ length: int(1, 3) }, strTok)]);
  }
}
// 不认识与没搬的消息号、读不出的号
for (const idTok of ['0', '22', '44', '48', '60', '65', '66', '69', '70', '108', '999', '-1', '-0', '', 'abc', ' 9', '4x', '1e1', '6', '7', '8', '14', '16', '18', '19', '20', '47', '50', '51', '54', '56', '67', '68', '71', '72', '77', '80', '84', '99', '101', '107']) {
  // 6/7/8/14/16/18–20/47/50/51/54/56/67/68/71/72/77/80/84/99/101/107 库里有解码、C++ 没搬:只记下,C++ 那边单测"不冒充没有"
  pushIn(`id ${idTok}`, 193, [idTok, '1', 'x']);
}
pushIn('empty message', 193, []);
// readBool 是不带基数的 parseInt:带符号的十六进制
for (const b of ['-0x1', '+0x1', '0x1', '-0x0', ' \t-0X10', '0x', '-', '+0x', '-0b1', '1e3', ' 0 ']) pushIn(`1 bool ${b}`, 193, ['1', '3', '1', '1', '1.5', '10', b]);
for (const cc of ['4294967295', '4294967296', '4294967294', '2', '0', '-3']) {
  const version = pick([150, 176, 193]);
  // 条件数那一格读不到时(前面先读不够了)重录,直到真走到
  for (let tries = 0; tries < 200; tries += 1) {
    const tokens = synth(version, 5, undefined, cc);
    const r = decodeOnce(version, tokens);
    if (synth.condDone || tries === 199) { pushIn(`5 condcount ${cc}`, version, tokens); break; }
  }
}
// 坏 JSON / 条件数过大 / 历史行情负条数
pushIn('err bad json', 193, ['4', '2', '7', '201', 'rejected', '{bad']);
pushIn('err json array', 166, ['4', '2', '7', '201', 'rejected', '[1,"\\u4e2d"]']);
pushIn('err json before 166', 165, ['4', '2', '7', '201', 'rejected', '{bad']);
pushIn('err v1', 193, ['4', '1', 'old style']);
pushIn('hist negative count', 193, ['17', '5', 'a', 'b', '-1', '20261007', '1', '2', '3', '4', '5', '6', '7', '20261008', '1', '2']);
out.unportedIds = [6, 7, 8, 14, 16, 18, 19, 20, 47, 50, 51, 54, 56, 67, 68, 71, 72, 73, 74, 77, 78, 79, 80, 82, 83, 84, 85, 86, 87, 88, 89, 91, 92, 93, 95, 96, 97, 98, 99, 101, 102, 103, 104, 105, 106, 107];

// 流:同一个解码器连着收、隔着处理
const streams = [];
for (let i = 0; i < 120; i += 1) {
  const version = sv();
  const emits = [];
  const d = new Decoder({
    serverVersion: version,
    emitEvent: (name, ...args) => emits.push({ name, args }),
    emitError: (msg, code, reqId, advanced) => emits.push({ name: 'error', args: [msg, code, reqId ?? -1, advanced] }),
    emitInfo: (msg, code) => emits.push({ name: 'info', args: [msg, code] }),
  });
  const steps = [];
  for (let s = int(2, 7); s > 0; s -= 1) {
    if (chance(0.65)) {
      const id = Number(pick(Object.keys(ported)));
      let tokens = chance(0.15) ? ['4', '2', '7', '201', 'x', '{bad'] : synth(version, id);
      if (chance(0.3) && tokens.length > 1) tokens = tokens.slice(0, int(1, tokens.length - 1));
      d.enqueueMessage(tokens);
      steps.push({ enqueue: tokens });
    } else {
      emits.length = 0;
      let thrown;
      try { d.process(); } catch (e) { thrown = errorName(e); }
      const st = { process: enc(emits) };
      if (thrown !== undefined) st.thrown = thrown;
      steps.push(st);
    }
  }
  emits.length = 0;
  let thrown;
  try { d.process(); } catch (e) { thrown = errorName(e); }
  const st = { process: enc(emits) };
  if (thrown !== undefined) st.thrown = thrown;
  steps.push(st);
  streams.push({ sv: version, steps });
}

// 消息里自带的版本格读成 NaN(读不出的串):TS 的 `version >= N` 与 `version < N` 在 NaN 上都是假,
// C++ 里 `if (version < N) return;` 与 `if (version >= N) {…}` 就不再等价。每种自带版本格的消息在它读版本的那几档接口版本上各造几条。
// 放在流之后,前面的用例不受影响。
const nanVersionCases = [];
{
  const own = { 5: [100, 110, 124, 136, 144], 3: [100, 124, 130], 10: [100, 136, 150, 163], 11: [100, 124, 135], 17: [100, 110, 123], 21: [100, 131, 155],
    1: [100, 193], 61: [100, 193], 4: [100, 152, 165, 193], 2: [193], 12: [193], 13: [150], 52: [193], 59: [193] };
  const eventOf = { 5: 'openOrder', 3: 'orderStatus', 10: 'contractDetails', 11: 'execDetails', 17: 'historicalData', 21: 'tickOptionComputation', 1: 'tickPrice',
    61: 'position', 4: null, 2: 'tickSize', 12: 'updateMktDepth', 13: 'updateMktDepthL2', 52: 'contractDetailsEnd', 59: 'commissionReport' };
  for (const [id, versions] of Object.entries(own)) {
    for (const version of versions) {
      for (const bad of ['abc', 'NaN', '-', 'v34', ' x', '.']) {
        let tokens;
        for (let tries = 0; tries < 300; tries += 1) {
          tokens = synth(version, Number(id), bad);
          const r = decodeOnce(version, tokens);
          if (eventOf[id] === null || r.thrown === undefined && r.emits.some((e) => e.name === eventOf[id]) && !r.emits.some((e) => e.name === 'error')) break;
        }
        nanVersionCases.push({ name: `${id} nan-version ${bad}`, sv: version, tokens, ...decodeOnce(version, tokens) });
        if (tokens.length > 3) {
          const cut = tokens.slice(0, int(2, tokens.length - 1));
          nanVersionCases.push({ name: `${id} nan-version cut`, sv: version, tokens: cut, ...decodeOnce(version, cut) });
        }
      }
    }
  }
}

// 版本的分界:每道闸(接口版本的 MIN_SERVER_VERSION、消息自带的版本号)取 N−1、N、N+1 各一条整读到事件的样本,
// 随机抽的版本落不到分界上时,`>=` 写成 `>` 之类的错就查不出来
const boundaryCases = [];
{
  const around = (ns, lo, hi) => [...new Set(ns.flatMap((n) => [n - 1, n, n + 1]))].filter((v) => v >= lo && v <= hi).sort((a, b) => a - b);
  // 消息号 → [接口版本的闸, 消息自带版本号的闸, 读版本格的那几档接口版本, 要等到的事件]
  const gates = {
    1: [[], [2, 3], [193], 'tickPrice'],
    3: [[131], [2, 3, 4, 5, 6], [100, 130], 'orderStatus'],
    4: [[153, 166], [2], [152, 166], null],
    5: [[102, 103, 106, 111, 141, 142, 145, 148, 151, 158, 160, 162, 170, 177, 183, 184, 185, 189, 193],
      [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 51, 103], [100, 144], 'openOrder'],
    10: [[110, 121, 122, 126, 134, 152, 153, 163, 164, 179, 182, 186], [2, 3, 4, 5, 6, 7, 8], [100, 163], 'contractDetails'],
    11: [[103, 136, 178], [2, 3, 4, 5, 6, 7, 8, 9, 10], [100, 135], 'execDetails'],
    13: [[146], [], [], 'updateMktDepthL2'],
    17: [[124], [2, 3], [100, 123], 'historicalData'],
    21: [[156], [6], [100, 155], 'tickOptionComputation'],
    61: [[], [2, 3], [193], 'position'],
    94: [[129, 135], [], [], 'pnl'],
  };
  const sample = (name, version, id, first, event) => {
    let tokens;
    for (let tries = 0; tries < 300; tries += 1) {
      tokens = synth(version, id, first);
      const r = decodeOnce(version, tokens);
      if (r.thrown === undefined && (event === null ? r.emits.length > 0 : r.emits.some((e) => e.name === event)) && !r.emits.some((e) => e.name === 'error' && /^(Underrun|Decoding)/.test(e.args[0]))) break;
    }
    boundaryCases.push({ name, sv: version, tokens, ...decodeOnce(version, tokens) });
  };
  // 分界上只有特定的值才分得出两边的:空的价格格(readDouble 是 0、readDoubleOrUndefined 是 undefined)、PEG BENCH 单、
  // 带 \\u 转义的长名、FUND 合约。偏着造,直到解出来的正是那种样子
  const targeted = (name, version, id, first, want, b) => {
    Object.assign(bias, b);
    let tokens, r;
    for (let tries = 0; tries < 5000; tries += 1) {
      tokens = synth(version, id, first);
      r = decodeOnce(version, tokens);
      if (r.thrown === undefined && r.emits.length && !r.emits.some((e) => e.name === 'error') && want(r.emits[0].args)) break;
      if (tries === 4999) throw new Error(`造不出 ${name}`);
    }
    bias.str = null;
    bias.dbl = null;
    boundaryCases.push({ name, sv: version, tokens, ...r });
  };
  for (const v of [28, 29, 30, 31]) {
    targeted(`5 target empty lmt v${v}`, 100, 5, String(v), (a) => a[2].lmtPrice === (v >= 29 ? '__undefined__' : 0), { dbl: [''] });
    targeted(`5 target empty aux v${v}`, 144, 5, String(v), (a) => a[2].auxPrice === (v >= 30 ? '__undefined__' : 0), { dbl: [''] });
  }
  for (const v of [101, 102, 103]) targeted(`5 target pegbench sv ${v}`, v, 5, '40', (a) => a[2].orderType === 'PEG BENCH', { str: ['PEG BENCH'] });
  for (const v of [152, 153, 154]) {
    targeted(`10 target escaped longName sv ${v}`, v, 10, '8', (a) => /订|\\u8ba2/.test(a[1].longName ?? ''), { str: ['\\u8ba2\\u5355'] });
    boundaryCases.push({ name: `4 target escaped message sv ${v}`, sv: v, tokens: ['4', '2', '7', '201', 'a\\u8ba2b', ''], ...decodeOnce(v, ['4', '2', '7', '201', 'a\\u8ba2b', '']) });
  }
  for (const v of [178, 179, 180]) targeted(`10 target fund sv ${v}`, v, 10, '8', (a) => a[1].contract.secType === 'FUND', { str: ['FUND'] });
  for (const [idStr, [svGates, msgGates, readAt, event]] of Object.entries(gates)) {
    const id = Number(idStr);
    for (const v of around(svGates, 100, 193)) sample(`${id} boundary sv ${v}`, v, id, undefined, event);
    for (const v of around(msgGates, 0, 200)) for (const at of readAt) sample(`${id} boundary version ${v}`, at, id, String(v), event);
  }
}

// placeOrder 单独一份(每份夹具不过 ~3 MB)
const orders = out.encoder.filter((c) => c.fn === 'placeOrder');
out.encoder = out.encoder.filter((c) => c.fn !== 'placeOrder');
writeFileSync(join(here, 'ib-wire-orders.json'), JSON.stringify({ generator: out.generator, library: out.library, encoder: orders }) + '\n');
writeFileSync(join(here, 'ib-wire-out.json'), JSON.stringify(out) + '\n');
// 分帧:收到的字节里有坏的 UTF-8 时,socket.js 的 onData 用 Buffer#toString('utf8') 解(坏字节换成 U+FFFD,规则同 WHATWG),再按 \0 切、去掉最后一格
const utf8Frames = [];
for (const payload of ['34003200ff00', '3400c0af00', '3400e4bb00', '3400eda08000', '3400f09f988000', '3400efbbbf4100', '3400f490808000', '34008000', '3400e4bb4100',
  '3400e4bbb700', '3400f8888080800000', '3400ed9fbf00', '3400eeb08000', '3400e000', '3400f0908000', '00', 'ff00ff00']) {
  const data = Buffer.from(payload, 'hex');
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length, 0);
  utf8Frames.push({ hex: Buffer.concat([size, data]).toString('hex'), tokens: data.toString('utf8').split('\0').slice(0, -1) });
}
writeFileSync(join(here, 'ib-wire-edge.json'), JSON.stringify({ generator: out.generator, library: out.library, unportedIds: out.unportedIds, messages: [...nanVersionCases, ...boundaryCases], utf8Frames }) + '\n');
writeFileSync(join(here, 'ib-wire-in.json'), JSON.stringify({ generator: out.generator, library: out.library, unportedIds: out.unportedIds, messages: inCases, streams }) + '\n');
console.log(`ib-wire: ${orders.length} placeOrder, ${out.encoder.length} other encoder, ${out.api.length} api, ${inCases.length} messages, ${nanVersionCases.length} nan-version, ${boundaryCases.length} boundary, ${streams.length} streams; @stoqey/ib ${libVersion}`);
