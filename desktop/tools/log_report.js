// 从原始 main.log 重算"慢在哪":各方法慢请求的分位数、12 秒超时按天的分布、「节拍停了」有几次其实是电脑在睡。
// 只读两份原始记录,不读任何人整理过的结论:
//
//   node tools/log_report.js                                   # 默认 ~/Library/Logs/IBKR-Assistant/main.log
//   node tools/log_report.js path/to/main.log --pmset pmset.txt # 再拿系统自己的睡眠记录对照(pmset -g log > pmset.txt)
//   node tools/log_report.js --json                             # 机器读的那一份
//
// 睡眠区间有两路来源,互相独立:主进程 power-watch 记的「[power] 系统睡眠 / 系统醒来」(Electron powerMonitor),
// 和 macOS 自己的 `pmset -g log`(Sleep → Wake / DarkWake)。一次停摆的 [停下, 写日志那一刻] 和某段睡眠有重叠,就算"其实在睡"。
// 来历见 docs/journal/sleep-read-as-stall.md;那篇里的数字就是这份脚本算出来的。
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TS = /^\[(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\.(\d+)\]/;
/** 日志的时刻是本机本地时间,不带时区:按本地时间解析 */
function logTime(line) {
  const m = TS.exec(line);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, ms] = m.map(Number);
  return new Date(y, mo - 1, d, h, mi, s, Math.round(ms / 10 ** (String(m[7]).length - 3))).getTime();
}

/** 引擎 durationText 的三种写法:「31 秒」「16 分钟」「2 小时 8 分」/「42 小时」→ 毫秒;认不出是 0 */
function durationMs(text) {
  const t = text.trim();
  let m;
  if ((m = /^(\d+) 秒$/.exec(t))) return Number(m[1]) * 1000;
  if ((m = /^(\d+) 分钟$/.exec(t))) return Number(m[1]) * 60_000;
  if ((m = /^(\d+) 小时(?: (\d+) 分)?$/.exec(t))) return Number(m[1]) * 3_600_000 + Number(m[2] ?? 0) * 60_000;
  return 0;
}

function parseMainLog(text) {
  const slow = [], stalls = [], power = [], perf = [];
  for (const line of text.split('\n')) {
    const at = logTime(line);
    if (at === null) continue;
    let m;
    if ((m = /\[rpc\] 慢请求 (\S+) (\d+) ms(?:,排队 (\d+) ms)?/.exec(line))) {
      slow.push({ at, method: m[1], runMs: Number(m[2]), waitMs: m[3] ? Number(m[3]) : null });
    } else if ((m = /\[盯盘\] 节拍停了 ([^(]+)\(/.exec(line))) {
      stalls.push({ at, stoppedMs: durationMs(m[1]), saidAsleep: line.includes('电脑在睡眠'), line: line.trim() });
    } else if (line.includes('[power] 系统睡眠')) {
      power.push({ at, type: 'sleep' });
    } else if (line.includes('[power] 系统醒来')) {
      power.push({ at, type: 'wake' });
    } else if ((m = /\[perf\] (\{.*\})\s*$/.exec(line))) {
      try { perf.push({ at, ...JSON.parse(m[1]) }); } catch { /* 截断的行跳过 */ }
    }
  }
  return { slow, stalls, power, perf };
}

/** 主进程记的睡眠:一次「系统睡眠」到下一次「系统醒来」 */
function powerIntervals(power) {
  const out = [];
  let from = null;
  for (const p of power) {
    if (p.type === 'sleep') from = p.at;
    else if (from !== null) { out.push({ from, to: p.at, source: 'power' }); from = null; }
  }
  return out;
}

/** `pmset -g log` 的睡眠:Sleep 那一行到下一次 Wake 或 DarkWake。行首是「2026-10-17 01:44:54 +0800 Sleep …」 */
function parsePmset(text) {
  const out = [];
  let from = null;
  for (const line of text.split('\n')) {
    const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d)\s+(Sleep|Wake|DarkWake)\s/.exec(line);
    if (!m) continue;
    const at = Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`);
    if (m[5] === 'Sleep') from = from ?? at;
    else if (from !== null) { out.push({ from, to: at, source: 'pmset' }); from = null; }
  }
  return out;
}

function overlaps(a0, a1, sleeps) {
  return sleeps.some((s) => a0 < s.to && s.from < a1);
}

function nearestRank(sorted, q) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

/** @param timeoutMs 一个"整超时"的值(合约确认 12 秒);±150 ms 以内都算 */
function report(parsed, extraSleeps = [], timeoutMs = 12_000) {
  const sleeps = [...powerIntervals(parsed.power), ...extraSleeps];
  const since = sleeps.length ? Math.min(...sleeps.map((s) => s.from)) : -Infinity;
  const inSleep = (at) => overlaps(at - 1, at + 1, sleeps);

  const byMethod = {};
  for (const r of parsed.slow) (byMethod[r.method] ??= []).push(r);
  const methods = {};
  for (const [method, rows] of Object.entries(byMethod)) {
    const run = rows.map((r) => r.runMs).sort((a, b) => a - b);
    const waits = rows.filter((r) => r.waitMs !== null).map((r) => r.waitMs).sort((a, b) => a - b);
    const timeouts = rows.filter((r) => Math.abs(r.runMs - timeoutMs) <= 150);
    const perDay = {};
    for (const r of timeouts) {
      const d = new Date(r.at);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      perDay[key] = (perDay[key] ?? 0) + 1;
    }
    methods[method] = {
      n: rows.length, p50: nearestRank(run, 0.5), p90: nearestRank(run, 0.9), max: run[run.length - 1] ?? 0,
      wait_p90: waits.length ? nearestRank(waits, 0.9) : null,
      in_sleep: rows.filter((r) => r.at >= since && inSleep(r.at)).length,
      at_timeout: timeouts.length, at_timeout_in_sleep: timeouts.filter((r) => inSleep(r.at)).length, at_timeout_by_day: perDay,
    };
  }

  const covered = parsed.stalls.filter((s) => s.at >= since);
  const asleep = covered.filter((s) => overlaps(s.at - s.stoppedMs, s.at, sleeps));
  return {
    sleeps: { power: sleeps.filter((s) => s.source === 'power').length, pmset: sleeps.filter((s) => s.source === 'pmset').length },
    slow: { total: parsed.slow.length, methods },
    stalls: {
      total: parsed.stalls.length, since_sleep_records: covered.length,
      overlapping_sleep: asleep.length,
      said_awake_but_overlapping_sleep: asleep.filter((s) => !s.saidAsleep).length,
      not_overlapping: covered.filter((s) => !asleep.includes(s)).map((s) => s.line),
    },
    perf_lines: parsed.perf.length,
  };
}

function text(r) {
  const out = [];
  out.push(`睡眠区间:主进程 ${r.sleeps.power} 段,pmset ${r.sleeps.pmset} 段`);
  out.push(`慢请求 ${r.slow.total} 条(数字是执行时长;带排队的只有新版日志才有)`);
  const rows = Object.entries(r.slow.methods).sort(([, a], [, b]) => b.n - a.n);
  for (const [m, s] of rows.slice(0, 15)) {
    const days = Object.entries(s.at_timeout_by_day).map(([d, n]) => `${d}:${n}`).join(' ');
    out.push(`  ${m.padEnd(20)} n=${String(s.n).padEnd(5)} p50=${String(s.p50).padEnd(7)} p90=${String(s.p90).padEnd(8)} ` +
      `睡眠里=${s.in_sleep}  整超时=${s.at_timeout}(睡眠里 ${s.at_timeout_in_sleep})${days ? '  ' + days : ''}` +
      (s.wait_p90 !== null ? `  排队p90=${s.wait_p90}` : ''));
  }
  out.push(`「节拍停了」${r.stalls.total} 次;有睡眠记录以来 ${r.stalls.since_sleep_records} 次,其中 ${r.stalls.overlapping_sleep} 次和某段睡眠重叠` +
    `(日志说"电脑没睡"的占 ${r.stalls.said_awake_but_overlapping_sleep} 次)`);
  for (const l of r.stalls.not_overlapping.slice(0, 30)) out.push(`  没重叠:${l.slice(0, 160)}`);
  return out.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : null; };
  const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--pmset') ??
    path.join(os.homedir(), 'Library', 'Logs', 'IBKR-Assistant', 'main.log');
  const pmset = flag('pmset');
  const parsed = parseMainLog(fs.readFileSync(file, 'utf8'));
  const r = report(parsed, pmset ? parsePmset(fs.readFileSync(pmset, 'utf8')) : []);
  process.stdout.write((args.includes('--json') ? JSON.stringify(r, null, 2) : text(r)) + '\n');
}

module.exports = { durationMs, logTime, parseMainLog, parsePmset, powerIntervals, report };
if (require.main === module) main();
