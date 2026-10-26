'use strict';
/**
 * 预览引擎:让 Qt 版(native/)拿预览台同一份 mock 数据,不连任何券商。
 *
 *   node tools/preview_engine.js [--config x]     # 说 stdio JSON-RPC,同真引擎;native 的 Datrix --engine preview 拉它
 *
 * mock-bridge.js 只有具名函数(window.dafri.status() 之类),没有通用的 rpc。所以这里:
 *   1. 用假的 electron 把 preload.js 跑起来,对每个具名函数用空入参探一次,记下它调的是哪个引擎方法 → 方法名对具名函数的表;
 *   2. 请求来了按方法名找到具名函数,入参取 params 的值依次当参数(mock 多半不看入参,看的也只看第一个)。
 * 没有出路到 TWS / 网络 / 磁盘:只读 mock 里写死的数据。默认**不**拉它,必须明说 --engine preview。
 */
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const readline = require('node:readline');
const vm = require('node:vm');

const here = __dirname;
const MOCK = process.env.PREVIEW_MOCK || path.join(here, 'mock-bridge.js');

function loadMock() {
  const window = { localStorage: undefined, addEventListener() {}, setTimeout, clearTimeout };
  const sandbox = { window, console, setTimeout, clearTimeout, Date, Math, JSON, Promise };
  window.window = window;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(MOCK, 'utf8'), sandbox, { filename: MOCK });
  return window.dafri;
}

/** 跑 preload.js,返回 具名函数名 → 它调的引擎方法(探一次) */
function probeMethods() {
  const calls = [];
  const fakeElectron = {
    contextBridge: { exposeInMainWorld: (_name, api) => { fakeElectron.api = api; } },
    ipcRenderer: {
      invoke: (channel, payload) => { calls.push({ channel, payload }); return Promise.resolve(null); },
      on() {}, removeListener() {}, removeAllListeners() {}, send() {},
    },
  };
  const orig = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'electron' ? fakeElectron : orig.call(this, request, ...rest);
  };
  try {
    require(path.join(here, 'preload.js'));
  } finally {
    Module._load = orig;
  }
  const table = {};
  for (const [name, fn] of Object.entries(fakeElectron.api || {})) {
    if (typeof fn !== 'function') continue;
    calls.length = 0;
    try { fn(); } catch { /* 需要入参的:探不出就算了 */ }
    const rpc = calls.find((c) => c.channel === 'rpc' && c.payload && typeof c.payload.method === 'string');
    if (rpc) table[rpc.payload.method] = name;
  }
  return table;
}

function main() {
  const dafri = loadMock();
  const table = probeMethods();
  const write = (m) => process.stdout.write(JSON.stringify(m) + '\n');
  write({ jsonrpc: '2.0', method: 'event', params: { event: 'ready', data: { protocol: '1.0', config: 'preview' } } });
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let pending = 0;
  let closed = false;
  const maybeExit = () => { if (closed && pending === 0) process.exit(0); };
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let req;
    try { req = JSON.parse(line); } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '无法解析的 JSON' } }); return; }
    const id = req.id ?? null;
    if (req.method === 'sectors.earnings') {
      const symbol = req.params?.symbol || 'NVDA';
      const result = symbol === 'NVDA' ? {
        symbol, source: 'IBKR WSH', at: Date.now(), status: 'available', message: '',
        upcoming: {date:'2026-11-18',timing:'AFTER MARKET',status:'CONFIRMED',days_until:26},
        history: [{date:'2026-08-26',timing:'AFTER MARKET',status:'CONFIRMED',gap:2.1,day1:3.4,day5:-1.2,missing:''},
          {date:'2026-05-27',timing:'UNSPECIFIED',status:'CONFIRMED',gap:null,day1:null,day5:null,missing:'发布时间缺失'}],
        basis:'演示数据，非真实财报或行情。美东日期，相对财报前一交易日收盘。'
      } : {symbol,source:'IBKR WSH',at:Date.now(),status:'missing',message:'演示：IBKR WSH 财报数据缺失',history:[]};
      write({jsonrpc:'2.0',id,result}); return;
    }
    if (req.method === 'options.entry_context') {
      write({jsonrpc:'2.0',id,result:{at:Date.now(),SPX:{error:'演示：实时分钟线缺失'},SPY:{error:'演示：实时分钟线缺失'}}}); return;
    }
    if (req.method === 'options.terrain') {
      const date = req.params?.date || '2026-10-22';
      const t = Date.parse(date + 'T14:00:00Z');
      const records = [0, 300000, 900000].map((offset, n) => ({
        received_at: t + offset, status: 'observed',
        wall: { spot: 6000 + n * 7, net_gex: -2e9 + n * 1e9,
          strikes: Array.from({length: 21}, (_, i) => ({ strike: 5950 + i * 5,
            net_gex: Math.sin(i / 3 + n * 0.7) * 4e9 })), coverage: { lower: 5950, upper: 6050, thinned: false } }
      }));
      write({jsonrpc:'2.0',id,result:{dates:['2026-10-21','2026-10-22'],records:req.params?.date ? records : [],rejected_records:0,demo:true}});
      return;
    }
    const fn = table[String(req.method ?? '')];
    if (!fn || typeof dafri[fn] !== 'function') {
      write({ jsonrpc: '2.0', id, error: { code: -32601, message: `预览引擎没有这个方法的假数据:${req.method}` } });
      return;
    }
    pending += 1;
    try {
      const params = req.params && typeof req.params === 'object' ? req.params : {};
      const args = Object.entries(params).filter(([k]) => k !== '__confirmed').map(([, v]) => v);
      write({ jsonrpc: '2.0', id, result: JSON.parse(JSON.stringify(await dafri[fn](...args) ?? null)) });
    } catch (err) {
      write({ jsonrpc: '2.0', id, error: { code: -32000, message: String(err && err.message ? err.message : err) } });
    } finally {
      pending -= 1;
      maybeExit();
    }
  });
  rl.on('close', () => { closed = true; maybeExit(); });
}

if (require.main === module) main();
module.exports = { probeMethods, loadMock };
