// 量一次正在运行的应用:每类进程的常驻内存与 CPU、安装包多大、引擎起来到连上券商要多久。
// 给重写(docs/briefs/qt-rewrite.md)留一份"现在是多少"的基线;Qt 版用同一份脚本量,两份数字才比得了。
//
//   node tools/perf_snapshot.js                          # 采 10 次、每秒一次,打到终端
//   node tools/perf_snapshot.js --samples 30 --out ../docs/reports/perf/2026-10-18-electron.json
//   node tools/perf_snapshot.js --app /Applications/Datrix.app
//
// 要在自己的终端里跑:Claude 的沙箱不让跑 ps。只读进程表、安装包目录与 main.log,不碰应用本身。
// 每个数取多次采样的中位数,并给出最小与最大:单次采样受 GC、页面切换影响太大。
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 一行 ps 归到哪一类进程。引擎是同一个可执行文件跑 engine-ts,所以先认它 */
function roleOf(command) {
  if (/engine-ts[/\\]dist/.test(command)) return 'engine';
  if (command.includes('Helper (Renderer)')) return 'renderer';
  if (command.includes('Helper (GPU)')) return 'gpu';
  if (command.includes('Helper (Plugin)')) return 'plugin';
  if (command.includes('Helper')) return 'utility';
  if (/Datrix\.app[/\\]Contents[/\\]MacOS[/\\]Datrix(\s|$)/.test(command)) return 'main';
  if (/discord-window-follow|inbox-reader/.test(command)) return 'reader';
  return null;
}

/** `ps -axo pid=,rss=,%cpu=,command=` 的输出 → 属于这个应用的那几行(rss 单位 KB) */
function parsePs(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const role = roleOf(m[4]);
    if (role !== null) rows.push({ pid: Number(m[1]), rssKb: Number(m[2]), cpu: Number(m[3]), role });
  }
  return rows;
}

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 多次采样 → 每类与合计的中位数 / 最小 / 最大(内存 MB、CPU %) */
function summarize(samples) {
  const roles = new Set(samples.flatMap((rows) => rows.map((r) => r.role)));
  const stat = (xs) => ({ median: Math.round(median(xs) * 10) / 10, min: Math.min(...xs), max: Math.max(...xs) });
  const out = { samples: samples.length, processes: {}, total: null };
  for (const role of [...roles].sort()) {
    const mb = samples.map((rows) => rows.filter((r) => r.role === role).reduce((a, r) => a + r.rssKb, 0) / 1024);
    const cpu = samples.map((rows) => rows.filter((r) => r.role === role).reduce((a, r) => a + r.cpu, 0));
    const count = median(samples.map((rows) => rows.filter((r) => r.role === role).length));
    out.processes[role] = { count, rss_mb: stat(mb.map((x) => Math.round(x))), cpu_pct: stat(cpu) };
  }
  const totalMb = samples.map((rows) => Math.round(rows.reduce((a, r) => a + r.rssKb, 0) / 1024));
  const totalCpu = samples.map((rows) => rows.reduce((a, r) => a + r.cpu, 0));
  out.total = { rss_mb: stat(totalMb), cpu_pct: stat(totalCpu) };
  return out;
}

/** main.log 里每一次「启动引擎」到其后第一次「已连上」的毫秒数(最近的在后) */
function startupTimes(logText) {
  const TS = /^\[(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\.(\d{3})/;
  const at = (line) => {
    const m = TS.exec(line);
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]).getTime() : null;
  };
  const out = [];
  let start = null;
  for (const line of logText.split('\n')) {
    const t = at(line);
    if (t === null) continue;
    if (line.includes('启动引擎')) start = t;
    else if (start !== null && line.includes('[link] 已连上')) { out.push(t - start); start = null; }
  }
  return out;
}

function duMb(p) {
  try {
    return Math.round(Number(execFileSync('du', ['-sk', p], { encoding: 'utf8' }).split(/\s/)[0]) / 1024);
  } catch {
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
  const n = Number(flag('samples', '10'));
  const app = flag('app', path.resolve(__dirname, '..', 'dist', 'mac-arm64', 'Datrix.app'));
  const log = path.join(os.homedir(), 'Library', 'Logs', 'Datrix', 'main.log');
  const samples = [];
  for (let i = 0; i < n; i += 1) {
    samples.push(parsePs(execFileSync('ps', ['-axo', 'pid=,rss=,%cpu=,command='], { encoding: 'utf8', maxBuffer: 32 << 20 })));
    if (i + 1 < n) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!samples.some((rows) => rows.length)) {
    process.stderr.write('没找到在运行的 Datrix。先把应用打开、连上 TWS,再量。\n');
    process.exit(1);
  }
  const dmg = fs.existsSync(path.dirname(app)) ? fs.readdirSync(path.resolve(path.dirname(app), '..')).find((f) => f.endsWith('.dmg')) : null;
  const starts = fs.existsSync(log) ? startupTimes(fs.readFileSync(log, 'utf8')) : [];
  const report = {
    at: new Date().toISOString(), host: { platform: process.platform, arch: process.arch, cpus: os.cpus().length, mem_gb: Math.round(os.totalmem() / 2 ** 30) },
    app: { path: app, size_mb: duMb(app), dmg_mb: dmg ? duMb(path.resolve(path.dirname(app), '..', dmg)) : null },
    ...summarize(samples),
    engine_start_to_connected_ms: { last5: starts.slice(-5), median_all: median(starts), n: starts.length },
  };
  const json = JSON.stringify(report, null, 2);
  const out = flag('out', null);
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, json + '\n');
  }
  process.stdout.write(json + '\n');
}

module.exports = { parsePs, roleOf, startupTimes, summarize };
if (require.main === module) main();
