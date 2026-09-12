// K线 PA:把引擎 pa.analyze 的结果翻译成 spec。图上每条线都对应引擎算出的一个字段:
//   bars → 蜡烛与量能   ma → 均线(与 bars 逐根对齐)   levels → 关键位虚线(支撑绿 / 阻力红)
//   fvgs → FVG 色块      order_block → 订单块         swings → 摆动点(最近 8 个)   last → 现价
import type { ChartSpec } from './spec';

const MA_STYLE: Record<number, string> = { 5: 'orange', 10: 'blue', 20: 'purple' };

export function paSpec(r: any): ChartSpec {
  const ma: Record<string, Array<number | null>> = r?.ma || {};
  const periods = Object.keys(ma).map(Number).sort((a, b) => a - b);
  return {
    ariaLabel: `${r?.symbol || ''} ${r?.timeframe_label || ''} K 线图`,
    // 换了标的、周期或盘前盘后口径,K 线就不是同一组了:视口重新铺满
    viewKey: `${r?.symbol || ''}|${r?.timeframe || ''}|${r?.rth ? 'rth' : 'all'}`,
    bars: r?.bars || [],
    last: r?.last,
    lines: periods.map((p) => ({ values: ma[String(p)] || [], color: MA_STYLE[p] || 'label2', alpha: 0.7, label: `MA${p}` })),
    hlines: (r?.levels || []).map((l: any) => ({
      price: l.price,
      color: l.side === 'resistance' ? 'down' : 'up',
      dash: [2, 2],
      alpha: 0.45,
      fit: false,
    })),
    bands: [
      ...(r?.fvgs || []).map((g: any) => ({
        from: g.time,
        top: g.top,
        bottom: g.bottom,
        color: g.side === 'bull' ? 'up' : 'down',
        fill: 0.07,
        stroke: 0.22,
        label: g.side === 'bull' ? 'FVG↑' : 'FVG↓',
      })),
      ...(r?.order_block
        ? [
            {
              from: r.order_block.time,
              top: r.order_block.top,
              bottom: r.order_block.bottom,
              color: 'label',
              fill: 0.06,
              stroke: 0.28,
              dash: [2, 2],
              label: 'OB',
            },
          ]
        : []),
    ],
    markers: (r?.swings || []).slice(-8).map((s: any) => ({
      time: s.time,
      price: s.price,
      shape: 'dot' as const,
      color: s.kind === 'high' ? 'down' : 'up',
      label: s.label || '',
      labelPos: s.kind === 'high' ? ('above' as const) : ('below' as const),
      labelColor: 'label',
      labelAlpha: 0.45,
      fit: false,
    })),
    legend: [
      ['■', 'up', '阳线'],
      ['■', 'down', '阴线'],
      ['╌', 'up', '支撑'],
      ['╌', 'down', '阻力'],
      ['▮', 'up', 'FVG'],
      ['▯', 'label2', '订单块'],
      ['·', 'blue', '现价'],
    ],
    header: periods.length
      ? (i, h) =>
          periods.map((p): [string, string] => {
            const v = (ma[String(p)] || [])[i];
            return [`MA${p} ${v == null ? '—' : h.fmt(v)}`, h.col(MA_STYLE[p] || 'label2')];
          })
      : null,
  };
}
