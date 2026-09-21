/** 复盘的三张图:股价、标的、蝶价。
 *
 * 2026-09-21 从 pages/Review.tsx 搬出来(函数体逐字未改)。
 * 每张图的点位全部来自引擎给的那一份序列,界面不自己重算——图上写的和结论里写的必须是同一批数。
 */
import { useMemo } from 'react';
import { PHASE_LABEL, REVIEW_KIND } from './labels';
import type { ButterflyReviewResult, StockReviewResult } from '../bridge';
import { CanvasChart, type ChartSpec } from './Chart';
import { EmptyState, StatusCard } from '../ui/kit';

/** 股价走势:蜡烛 + 买入 / 卖出均价线 + 每次出手一个三角(买朝上、卖朝下,落在成交价上)。 */
export function StockChart({ r }: { r: StockReviewResult }) {
  const spec = useMemo((): ChartSpec | null => {
    const bars = r.series.bars || [];
    if (bars.length < 2) return null;
    const long = r.profile.side === 'LONG';
    const LEVEL_STYLE: Record<string, any> = {
      avg_entry: { color: 'blue', dash: [], alpha: 0.9, label: long ? '买入均价' : '卖空均价' },
      avg_exit: { color: 'purple', dash: [4, 3], alpha: 0.9, label: long ? '卖出均价' : '买回均价' },
    };
    const hlines = (r.series.levels || []).filter((l: any) => LEVEL_STYLE[l.kind]).map((l: any) => ({ price: l.price, ...LEVEL_STYLE[l.kind] }));
    const markers = (r.series.markers || []).map((m: any) => {
      const buy = m.action === 'BUY';
      return {
        time: m.time,
        price: m.price,
        shape: buy ? ('tri-up' as const) : ('tri-down' as const),
        color: buy ? 'blue' : 'purple',
        label: `${buy ? '买' : '卖'} ${m.qty}`,
        labelPos: buy ? ('below' as const) : ('above' as const),
      };
    });
    const legend: [string, string, string][] = [
      ['■', 'up', '阳线'], ['■', 'down', '阴线'], ['▲', 'blue', '买入'], ['▼', 'purple', '卖出'],
      ['—', 'blue', long ? '买入均价' : '卖空均价'], ['╌', 'purple', long ? '卖出均价' : '买回均价'],
    ];
    return { ariaLabel: '股价走势', viewKey: `stock:${r.record_id}:${r.series.timeframe}`, bars, hlines, markers, legend, volume: true };
  }, [r]);
  return (
    <StatusCard title={`${r.profile.symbol} 走势(${r.timeframe_label},开仓前后到${r.outcome.kind === 'open' ? '现在' : '平仓之后'})`}>
      {spec ? <CanvasChart size="mid" spec={spec} /> : null}
    </StatusCard>
  );
}

/** 标的走势:蜡烛 + 三条行权价 + 盈利区 + 止盈策略的临界线 + 开仓/平仓竖线。字段全部来自 r.series 与 r.exit_plan。 */
export function UnderlyingChart({ r }: { r: ButterflyReviewResult }) {
  const spec = useMemo((): ChartSpec | null => {
    const bars = r.series.bars || [];
    if (bars.length < 2) return null;
    const levels: any[] = r.series.levels || [];
    const LEVEL_STYLE: Record<string, any> = {
      lower: { color: 'orange', dash: [4, 3], alpha: 0.8, label: '下翼' },
      center: { color: 'blue', dash: [], alpha: 0.9, label: '中心' },
      upper: { color: 'orange', dash: [4, 3], alpha: 0.8, label: '上翼' },
      lower_be: { color: 'up', dash: [2, 2], alpha: 0.6, tag: false, label: '盈亏平衡' },
      upper_be: { color: 'up', dash: [2, 2], alpha: 0.6, tag: false, label: '盈亏平衡' },
    };
    const hlines: any[] = [];
    for (const l of levels) {
      const st = LEVEL_STYLE[l.kind];
      if (st) hlines.push({ price: l.price, ...st });
    }
    // 止盈策略的临界线(|S−K| 的 0.45W / 0.55W / 0.8W):不撑开区间、不占轴,名字写在上沿那条线的左端
    const ZONE_STYLE: Record<string, [string, string]> = { hold: ['blue', '持有'], half: ['purple', '清半'], stop: ['down', '止损'] };
    for (const zone of (r.exit_plan || {}).zones || []) {
      const st = ZONE_STYLE[zone.kind];
      if (!st) continue;
      hlines.push({ price: zone.high, color: st[0], dash: [2, 3], alpha: 0.45, tag: false, fit: false, label: `${st[1]} ±${zone.half_width}` });
      hlines.push({ price: zone.low, color: st[0], dash: [2, 3], alpha: 0.45, tag: false, fit: false });
    }
    const lowerBe = levels.find((l) => l.kind === 'lower_be');
    const upperBe = levels.find((l) => l.kind === 'upper_be');
    const bands = lowerBe && upperBe ? [{ top: upperBe.price, bottom: lowerBe.price, color: 'up', fill: 0.1 }] : [];
    const MARK: Record<string, [string, string]> = { entry: ['blue', '开仓'], exit: ['purple', '平仓'], expiry: ['purple', '到期'] };
    const vlines: any[] = [];
    const markers: any[] = [];
    for (const m of r.series.markers || []) {
      const st = MARK[m.kind] || MARK.entry;
      vlines.push({ time: m.time, color: st[0], label: `${st[1]} ${m.price}` });
      markers.push({ time: m.time, price: m.price, shape: 'dot', color: st[0], fit: false });
    }
    const legend: [string, string, string][] = [
      ['■', 'up', '阳线'], ['■', 'down', '阴线'], ['—', 'blue', '中心'], ['╌', 'orange', '上下翼'],
      ['▮', 'up', '盈利区(到期)'], ['┆', 'blue', '开仓'], ['┆', 'purple', '平仓 / 到期'],
    ];
    if (r.exit_plan) legend.push(['╌', 'label2', '临界线 ±0.45W / 0.55W / 0.8W']);
    return { ariaLabel: '标的走势', bars, hlines, bands, vlines, markers, legend, volume: false };
  }, [r]);
  return (
    <StatusCard title={`标的走势(${r.timeframe_label},开仓前后到${REVIEW_KIND[r.outcome.kind] === '持仓中' ? '现在' : '结局'})`}>
      {spec ? <CanvasChart size="mid" spec={spec} /> : null}
    </StatusCard>
  );
}

/** 蝶价走势:组合分钟中间价的蜡烛 + 模型价虚线 + 止盈/止损水平线 + 回撤触发价阶梯 + 开仓/平仓/策略事件标记。 */
export function FlyChart({ r }: { r: ButterflyReviewResult }) {
  const fs = r.fly_series;
  const spec = useMemo((): ChartSpec | null => {
    const plan = r.exit_plan;
    const sim = plan?.simulation;
    // ExitSimulation 是按 applicable 判别的联合:先认出「跑过的那一支」,series / events 才在
    const run = sim && sim.applicable ? sim : null;
    const real = fs?.bars || [];
    const path = run?.series || [];
    const times = Array.from(new Set([...real.map((b) => b.time), ...path.map((pt) => pt.time)])).sort();
    if (times.length < 2) return null;
    const pathAt = new Map(path.map((pt) => [pt.time, pt]));
    const phases: { phase: string; from: string; to: string }[] = [];
    let band: { phase: string; from: string; to: string } | null = null;
    for (const t of times) {
      const ph = (pathAt.get(t) || {}).phase;
      if (!ph) {
        band = null;
        continue;
      }
      if (band && band.phase === ph) band.to = t;
      else {
        band = { phase: ph, from: t, to: t };
        phases.push(band);
      }
    }
    const bands = phases.filter((b) => b.phase !== 'A').map((b) => ({ v: true, from: b.from, to: b.to, color: b.phase === 'B' ? 'orange' : 'purple', fill: 0.06, label: PHASE_LABEL[b.phase] }));
    const EXIT: Record<string, [string, string]> = { tp1: ['up', '第一档'], tp2: ['up', '第二档'], trail_arm: ['orange', '回撤追踪激活'], stop: ['down', '止损'] };
    const hlines = (plan?.levels || [])
      .filter((l: any) => EXIT[l.kind] && l.price != null)
      .map((l: any) => ({ price: l.price, color: EXIT[l.kind][0], dash: l.kind === 'trail_arm' ? [2, 2] : [5, 3], alpha: 0.8, label: EXIT[l.kind][1] }));
    const lines = [
      { points: path.filter((pt) => pt.source === 'model').map((pt) => ({ time: pt.time, value: pt.price })), color: 'label', alpha: 0.55, dash: [3, 2], label: '模型价' },
      { points: path.filter((pt) => pt.trail_stop != null).map((pt) => ({ time: pt.time, value: pt.trail_stop })), color: 'orange', alpha: 0.85, dash: [4, 2], step: true, label: '回撤触发价' },
    ];
    const MARK: Record<string, [string, string]> = { entry: ['blue', '开仓'], exit: ['purple', '实际平仓'] };
    const markers: any[] = [];
    for (const m of fs?.markers || []) {
      if (m.price == null) continue;
      const st = MARK[m.kind] || MARK.entry;
      markers.push({ time: m.time, price: m.price, shape: 'dot', color: st[0], label: `${st[1]} ${m.price}` });
    }
    for (const e of run?.events || []) {
      const color = e['source'] === 'settle' ? 'purple' : Number(e['pnl']) >= 0 ? 'up' : 'down';
      markers.push({ time: e['time'], price: e['price'], shape: 'tri-down', color, label: `策略 ${e['qty']} 张 @ ${e['price']}` });
    }
    const legend: [string, string, string][] = [
      ['╌', 'up', '止盈档位'], ['╌', 'down', '止损'], ['╌', 'orange', '回撤激活 / 触发价'],
      ['·', 'blue', '开仓'], ['·', 'purple', '实际平仓'], ['╌', 'label2', '模型价'], ['▼', 'up', '策略出手点'],
    ];
    return { ariaLabel: '蝶价走势', times, bars: real, lines, hlines, bands, markers, legend, volume: false, yMin: 0, padPct: 0.08 };
  }, [r, fs]);
  return (
    <StatusCard title={`蝶价走势(组合中间价 · 1 分钟 · ${fs?.source === 'ibkr' ? 'IBKR 真实数据' : '模型价'})`}>
      {spec ? <CanvasChart size="mid" spec={spec} /> : <EmptyState compact>没有蝶价数据:引擎未连 TWS,或 IBKR 没有这张组合的历史分钟线。</EmptyState>}
    </StatusCard>
  );
}
