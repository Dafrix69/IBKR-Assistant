// svc1 簇的对拍脚本里要用的合成数据:日线、期权墙(用原模块 optionwall.analyze 对合成的链现算,不手写)。种子固定。
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

export const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

/** 以 endDate(含;是周末就往前找)为止的 n 个工作日,从早到晚。不管假日(日线里没有假日那根不影响这里要测的东西) */
export function weekdays(endDate, n) {
  const out = [];
  let ms = Date.parse(`${endDate}T12:00:00Z`);
  while (out.length < n) {
    const day = new Date(ms).getUTCDay();
    if (day !== 0 && day !== 6) out.push(ymd(ms));
    ms -= 86_400_000;
  }
  return out.reverse();
}

const round2 = (x) => Math.round(x * 100) / 100;

/** 随机游走的日线:{date, open, high, low, close, volume}。lastClose 是最后一根的收盘 */
export function dailyBars(r, n, endDate, lastClose, vol = 0.012) {
  const dates = weekdays(endDate, n);
  const closes = new Array(n);
  closes[n - 1] = lastClose;
  for (let i = n - 2; i >= 0; i -= 1) closes[i] = closes[i + 1] / (1 + (r.next() - 0.5) * 2 * vol);
  return dates.map((date, i) => {
    const close = closes[i];
    const open = i === 0 ? close : closes[i - 1] * (1 + (r.next() - 0.5) * vol);
    const high = Math.max(open, close) * (1 + r.next() * vol * 0.6);
    const low = Math.min(open, close) * (1 - r.next() * vol * 0.6);
    return { date, open: round2(open), high: round2(high), low: round2(low), close: round2(close), volume: Math.round(1e6 * (0.5 + r.next())) };
  });
}

/** 合成的期权链 → 原模块 analyze 现算的期权墙。expiry: YYYYMMDD */
export async function makeWall(engineDir, r, spot, symbol, expiry, nowMs, opts = {}) {
  const { analyze } = await import(pathToFileURL(join(engineDir, 'dist/src/optionwall.js')).href);
  const step = opts.step ?? (spot > 1000 ? 5 : spot > 200 ? 5 : 2.5);
  const center = Math.round(spot / step) * step;
  const rows = [];
  const half = opts.half ?? 12;
  for (let k = -half; k <= half; k += 1) {
    const strike = center + k * step;
    for (const right of ['C', 'P']) {
      const away = Math.abs(k) + 1;
      rows.push({
        strike, right, oi: Math.round((8000 / away + r.next() * 3000) * (right === 'C' && k > 0 ? 1.4 : 1)), volume: Math.round(2000 / away + r.next() * 800),
        gamma: 0.01 / away, iv: 0.18 + 0.01 * away,
      });
    }
  }
  const core = analyze(rows, spot, expiry, symbol, 100, nowMs, opts.tradingClass ?? '');
  return { ...core, expiries: [expiry], spot_source: 'quote', coverage: { lowest: center - half * step, highest: center + half * step, asked: 2 * half + 1, got: 2 * half + 1, thinned: false } };
}
