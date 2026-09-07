// 解析链路时延压测:一组自拟指令逐条 instruction.submit(execute:false,绝不下单),
// 记每条的墙钟时延、走的是本地速记还是大模型、模型自报时延与 token 用量、结果计数。
//
//   node tools/latency_bench.js                       # TS 引擎,进程内,固定交易日时钟(美东 2026-08-14 10:32,盘中)
//   node tools/latency_bench.js --engine py           # Python 引擎,走 stdio RPC,真实时钟(没有时钟钩子)
//   node tools/latency_bench.js --clock real          # TS 引擎也用真实时钟(周末会看到速记的本地拒绝)
//   node tools/latency_bench.js --only A,C --repeat 2 # 只跑某几类,重复几轮
//   node tools/latency_bench.js --cold                # 不预热 SPX 现价,量速记第一次冷取的代价
//
// 为什么要固定时钟:速记的默认到期是"当日",周末跑出来的数字全是"非交易日"的拒绝,量的不是解析。
// 数据库一律指向临时目录,不碰真实的 trades.db(解析模式也会落拒绝记录)。大模型那部分是真调用,会花钱。
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DESKTOP = path.resolve(__dirname, '..');
const TRADE = path.resolve(DESKTOP, '..');
const TS_ROOT = path.resolve(TRADE, '..', 'trade-ts');
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const engine = flag('engine', 'ts');
const clock = flag('clock', 'fixed');
const repeat = Number(flag('repeat', '1'));
const only = flag('only', '');
const outFile = flag('out', path.join(DESKTOP, '.uipreview', 'latency', `${engine}-${clock}.json`));

// 语料:分类 + 预期路径。local = 本地速记;llm = 大模型;error = RPC 直接报错。
// 每一类都对应界面上真会出现的写法;F 类是应当被拒的,拒得对不对也在看。
const CORPUS = [
  ['A', 'local', '1.8 挂15蝴蝶 15CM'],
  ['A', 'local', '7520的20cm蝴蝶'],
  ['A', 'local', 'spx明天 7850 40cm 2.3'],
  ['A', 'local', '帮我挂个 2.5 的 30蝴蝶 20cm,不追价'],
  ['A', 'local', '两张 15蝴蝶 15cm 权利金不超过 2'],
  ['A', 'local', '看跌 20蝴蝶 15cm 1.5'],
  ['A', 'local', '15蝴蝶 翼宽15 1.8'],
  ['A', 'local', '7520的20cm蝴蝶 2.2 今天'],
  ['B', 'llm', 'spx到7500时,买一张 7520 7550 7580 蝴蝶,权利金 2'],
  ['B', 'local', '1.8 挂15蝴蝶 15CM 理由:开盘冲高回落'],   // v3 语法:理由本地接住
  ['B', 'llm', '卖出 7200/7250/7650/7700 铁鹰'],
  ['B', 'llm', '开一张今天的 7520 7550 call spread'],
  ['B', 'llm', 'spx 今天 7500/7480 put spread 一张,权利金上限 5'],
  ['B', 'llm', '铁鹰:SPX 今天 7300/7350/7700/7750,收 2 块'],
  ['C', 'llm', '买入 AAPL 100股 limit 230,理由:回调到位'],
  ['C', 'llm', '市价买 50 股 TSLA'],
  ['C', 'llm', '苹果316买100股'],
  ['C', 'llm', '卖出 NVDA 200 股,限价 220,GTC'],
  ['C', 'llm', 'AAPL 跌到 220 买 100 股'],
  ['C', 'llm', '买 1000 股 MSFT 市价'],
  ['C', 'llm', 'buy 100 AAPL at 230 limit'],
  ['D', 'llm', '买2张英伟达周五180call 限价5.5'],
  ['D', 'llm', '买 1 张 SPY 本周五 560 put,权利金不超过 3'],
  ['D', 'llm', '卖出 1 张 TSLA 下周 400 call'],
  ['D', 'llm', '买入 QQQ 本周 470/475 看涨价差 1 张,限价 1.2'],
  ['E', 'llm', 'SPY 涨到 775 时买入 100 股'],
  ['E', 'llm', 'spx到7500时,开一张今天的 7520 7550 call spread。理由:突破 7500 整数关口后追动能'],
  ['E', 'llm', '买 100 股 AAPL 限价 230;再买 50 股 MSFT 市价'],
  ['E', 'llm', '用长线账户买 100 股 AAPL 限价 230'],
  ['F', 'llm', '梭哈'],
  ['F', 'llm', '买入 AAPL 100股 limit 230,顺便梭哈'],
  ['F', 'llm', '今天大盘怎么样'],
  ['F', 'llm', '买点特斯拉'],
  ['F', 'llm', '帮我把 NVDA 的仓位平了'],
  ['G', 'error', ''],
  ['G', 'llm', '买入 AAPL 100股 limit 230。理由:财报后回调到位,机构持仓稳定,估值回到合理区间,技术面在 20 日线附近企稳,成交量温和放大,行业景气度未变,美债收益率回落利好成长股估值修复,同时分批建仓控制风险。'],
  ['H', 'llm', '买入 AAPL 100股 limit 230'],
  ['H', 'llm', '买入 AAPL 100股 limit 230'],
];

/** 临时配置:真实 settings.json 的一份拷贝,只把数据库指到临时目录。 */
function scratchConfig() {
  const src = JSON.parse(fs.readFileSync(path.join(TRADE, 'config', 'settings.json'), 'utf8'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dafri-latency-'));
  src.storage = { db_path: path.join(dir, 'trades.db') };
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(src, null, 1));
  return file;
}

function summarize(row) {
  const res = row.result || {};
  const llm = res.llm || {};
  const p = row.error ? 'error' : llm.model === 'local-shorthand' ? 'local' : llm.model ? 'llm' : '?';
  const first = (res.submitted || [])[0] || (res.queued || [])[0] || (res.validated_only || [])[0];
  const rej = (res.rejections || [])[0];
  return {
    path: p, llm_ms: llm.latency_ms ?? null, model: llm.model ?? null, usage: llm.usage ?? null,
    submitted: (res.submitted || []).length, queued: (res.queued || []).length,
    validated: (res.validated_only || []).length, rejections: (res.rejections || []).length,
    first_intent: first ? first.intent_summary : '',
    first_rejection: rej ? `${rej.code}: ${String(rej.message).slice(0, 100)}` : (row.error ? String(row.error.message).slice(0, 100) : ''),
  };
}

async function tsInProcess(configPath) {
  process.env.DAFRI_PROMPT_DIR = process.env.DAFRI_PROMPT_DIR || path.join(TRADE, 'prompts');
  const { RpcServer } = require(path.join(TS_ROOT, 'dist', 'src', 'rpc.js'));
  const { setClock } = require(path.join(TS_ROOT, 'dist', 'src', 'config.js'));
  if (clock !== 'real') setClock(Date.parse('2026-08-14T10:32:00-04:00'));
  // 真应用的 serve() 启动时会预热 SPX 公开现价;进程内没有 serve(),这里照做,--cold 则量"第一次冷取"
  if (!args.includes('--cold')) {
    const { publicIndexPrice } = require(path.join(TS_ROOT, 'dist', 'src', 'macro.js'));
    await publicIndexPrice('SPX').catch(() => null);
  }
  const server = new RpcServer(configPath, () => {});
  let id = 0;
  return {
    call: (method, params) => server.handle({ jsonrpc: '2.0', id: ++id, method, params }),
    close: () => {},
  };
}

function pyStdio(configPath) {
  const python = process.env.DAFRI_PYTHON || path.join(TRADE, '.venv', 'Scripts', 'python.exe');
  const proc = spawn(python, ['-m', 'ibkr_agent', 'rpc'], {
    cwd: TRADE,
    env: { ...process.env, DAFRI_CONFIG: configPath, PYTHONPATH: path.join(TRADE, 'src'), PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
  });
  proc.stderr.on('data', () => {});
  const pending = new Map();
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += String(d);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  let id = 0;
  return {
    call: (method, params) => new Promise((resolve, reject) => {
      const n = ++id;
      const t = setTimeout(() => { pending.delete(n); reject(new Error('timeout ' + method)); }, 120000);
      pending.set(n, (m) => { clearTimeout(t); resolve(m); });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
    }),
    close: () => { proc.stdin.end(); setTimeout(() => { try { proc.kill(); } catch { /* 已退出 */ } }, 300); },
  };
}

async function main() {
  const configPath = scratchConfig();
  const client = engine === 'py' ? pyStdio(configPath) : await tsInProcess(configPath);
  const t0 = process.hrtime.bigint();
  await client.call('system.status', {});
  const startupMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const wanted = only ? only.split(',') : null;
  const rows = [];
  for (let r = 0; r < repeat; r += 1) {
    for (const [cat, expect, text] of CORPUS) {
      if (wanted && !wanted.includes(cat)) continue;
      const started = process.hrtime.bigint();
      let msg;
      try { msg = await client.call('instruction.submit', { text, execute: false }); }
      catch (e) { msg = { error: { message: e.message } }; }
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const s = summarize(msg);
      rows.push({ cat, expect, text: text.slice(0, 70), ms: Math.round(ms * 10) / 10, ...s });
      process.stdout.write(`${cat} ${expect.padEnd(5)} -> ${s.path.padEnd(5)} ${String(Math.round(ms)).padStart(6)} ms  ${text.slice(0, 40)}\n`);
    }
  }
  client.close();
  // 汇总:各路径的分位数、路径是否与预期一致
  const q = (xs, p) => { if (!xs.length) return null; const a = xs.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))]; };
  const by = (p) => rows.filter((r) => r.path === p).map((r) => r.ms);
  const summary = {
    engine, clock, startupMs: Math.round(startupMs), n: rows.length,
    local: { n: by('local').length, p50: q(by('local'), 0.5), p90: q(by('local'), 0.9), max: q(by('local'), 1) },
    llm: { n: by('llm').length, p50: q(by('llm'), 0.5), p90: q(by('llm'), 0.9), max: q(by('llm'), 1) },
    mismatch: rows.filter((r) => r.expect !== r.path).map((r) => `${r.cat} ${r.text.slice(0, 24)} → ${r.path}`),
  };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ summary, rows }, null, 2));
  process.stdout.write(`\n${JSON.stringify(summary, null, 1)}\n→ ${outFile}\n`);
  setTimeout(() => process.exit(0), 400);
}
main().catch((e) => { console.error(e); process.exit(1); });
