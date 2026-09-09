import { useEffect, useRef } from 'react';
import { ALERT_SOURCE_LABEL, ALERT_SOURCE_SHORT, type AlertLevel } from '../store/alerts';

/**
 * 价位条(SVG):一只股票的墙、均线、整数关口、52 周高低和现价摆在一条横轴上。
 *
 * 三条设计决定,都是被"叠成一团"逼出来的:
 *  1. 标签钉在各自的价位上,用引线连到刻度;同一侧的标签按位置从左到右推开,推不开的抬到第二层。
 *  2. 横轴分核心区与压缩区:现价 ±12% 内是核心区,占大部分宽度;52 周高低这类离得很远的价位放进
 *     两端的压缩区,轴上画一个断口。否则一个 +70% 的 52 周高会把所有墙和均线挤到一个像素里。
 *  3. 价格两位小数;距现价的百分比进 title,悬停就有,不占图。
 * 阻力 / 中性在轴上方,支撑 / 现价在轴下方。宽度按容器实测,容器变宽窄会重画。
 */
const CORE_PCT = 12;
const ZONE_W = 0.13;
const FONT = 10;
const LANE_H = 15;
const MAX_LANES = 2;

function fmtLevelPrice(price: number): string {
  if (!Number.isFinite(price)) return '—';
  return Number.isInteger(price) ? String(price) : price.toFixed(2);
}

let measureCtx: CanvasRenderingContext2D | null = null;
function measure(text: string, mono: boolean, weight: number): number {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx) return text.length * FONT * 0.6;
  const family = mono
    ? getComputedStyle(document.documentElement).getPropertyValue('--font-mono') || 'monospace'
    : getComputedStyle(document.body).fontFamily || 'system-ui';
  measureCtx.font = `${weight} ${FONT}px ${family}`;
  return measureCtx.measureText(text).width;
}

function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const key of Object.keys(attrs)) node.setAttribute(key, String(attrs[key]));
  return node;
}

interface Item {
  price: number;
  level?: AlertLevel;
  spot?: boolean;
  kind: string;
  name: string;
  text: string;
  w: number;
  x: number;
  lx: number;
  lane: number;
  side: 'above' | 'below';
  tip: string;
}

/** 同一层里按 x 推开:保持左右次序,相邻中心距不小于两者半宽之和 + 间隙;右端溢出就整体往回推。 */
function spread(items: Item[], width: number, gap: number): void {
  const sorted = items.slice().sort((a, b) => a.x - b.x);
  for (const it of sorted) it.lx = Math.min(Math.max(it.x, it.w / 2), width - it.w / 2);
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    cur.lx = Math.max(cur.lx, prev.lx + prev.w / 2 + cur.w / 2 + gap);
  }
  const last = sorted[sorted.length - 1];
  if (last && last.lx + last.w / 2 > width) {
    last.lx = width - last.w / 2;
    for (let i = sorted.length - 2; i >= 0; i -= 1) {
      const next = sorted[i + 1];
      const cur = sorted[i];
      cur.lx = Math.min(cur.lx, next.lx - next.w / 2 - cur.w / 2 - gap);
    }
  }
}

/** 一侧的标签分层:按 x 顺序,放得下就进第一层,否则第二层;两层都放不下就挤进右端更靠左的那层。 */
function lanes(items: Item[], gap: number): Item[][] {
  const out: Item[][] = [];
  for (const it of items.slice().sort((a, b) => a.x - b.x)) {
    let placed = false;
    for (let lane = 0; lane < MAX_LANES; lane += 1) {
      out[lane] = out[lane] || [];
      const last = out[lane][out[lane].length - 1];
      if (!last || it.x - it.w / 2 >= last.x + last.w / 2 + gap) {
        out[lane].push(it);
        it.lane = lane;
        placed = true;
        break;
      }
    }
    if (!placed) {
      let best = 0;
      for (let lane = 1; lane < MAX_LANES; lane += 1) {
        const a = out[best][out[best].length - 1];
        const b = out[lane][out[lane].length - 1];
        if ((b ? b.x + b.w / 2 : -Infinity) < (a ? a.x + a.w / 2 : -Infinity)) best = lane;
      }
      out[best].push(it);
      it.lane = best;
    }
  }
  return out.filter((l) => l && l.length);
}

/** 横轴的价格 → x 映射:核心区线性,两端压缩区各自线性。 */
function scale(prices: number[], spot: number | null, width: number, margin: number) {
  const inner = width - margin * 2;
  const center = spot != null ? spot : (Math.min(...prices) + Math.max(...prices)) / 2;
  const radius = center * (CORE_PCT / 100);
  const near = prices.filter((p) => Math.abs(p - center) <= radius);
  let coreLo = Math.min(center, ...near);
  let coreHi = Math.max(center, ...near);
  const pad = (coreHi - coreLo) * 0.06 || center * 0.004 || 1;
  coreLo -= pad;
  coreHi += pad;
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const hasLeft = minP < coreLo;
  const hasRight = maxP > coreHi;
  const zoneW = inner * ZONE_W;
  const leftW = hasLeft ? zoneW : 0;
  const rightW = hasRight ? zoneW : 0;
  const coreW = inner - leftW - rightW;
  const coreX0 = margin + leftW;
  const xOf = (price: number): number => {
    if (price >= coreLo && price <= coreHi) return coreX0 + ((price - coreLo) / (coreHi - coreLo)) * coreW;
    // 压缩区:最远的价位贴在轴的两端,离核心区留 15% 的空当画断口
    if (price < coreLo) return margin + ((price - minP) / (coreLo - minP || 1)) * leftW * 0.85;
    return coreX0 + coreW + rightW * 0.15 + ((price - coreHi) / (maxP - coreHi || 1)) * rightW * 0.85;
  };
  const breaks: number[] = [];
  if (hasLeft) breaks.push(coreX0 - 4);
  if (hasRight) breaks.push(coreX0 + coreW + 4);
  return { xOf, breaks };
}

export function buildLevelStripSvg(levels: AlertLevel[], spot: number | null | undefined, width: number): SVGElement | null {
  const pts: { price: number; level?: AlertLevel; spot?: boolean }[] = (levels || [])
    .map((l) => ({ price: Number(l.price), level: l }))
    .filter((pt) => Number.isFinite(pt.price));
  const spotNum = spot != null && Number.isFinite(Number(spot)) ? Number(spot) : null;
  if (spotNum != null) pts.push({ price: spotNum, spot: true });
  if (!pts.length) return null;

  const margin = 10;
  const { xOf, breaks } = scale(pts.map((p) => p.price), spotNum, width, margin);
  const gap = 6;
  const items: Item[] = pts.map((pt) => {
    const kind = pt.spot ? 'spot' : pt.level?.kind === 'resistance' ? 'resistance' : pt.level?.kind === 'support' ? 'support' : 'neutral';
    const name = pt.spot ? '现价' : ALERT_SOURCE_SHORT[pt.level?.source || ''] || ALERT_SOURCE_LABEL[pt.level?.source || ''] || '价位';
    const text = fmtLevelPrice(pt.price);
    const w = measure(name, false, 500) + 3 + measure(text, true, 600) + 6;
    const gapPct = spotNum != null && !pt.spot ? (pt.price / spotNum - 1) * 100 : null;
    return {
      price: pt.price, level: pt.level, spot: pt.spot, kind, name, text, w, x: xOf(pt.price), lx: 0, lane: 0,
      side: kind === 'support' || kind === 'spot' ? 'below' : 'above',
      tip: `${pt.spot ? '现价' : pt.level?.label || name} ${text}${gapPct != null ? ` · 距现价 ${gapPct > 0 ? '+' : ''}${gapPct.toFixed(2)}%` : ''}`,
    };
  });
  const lanesAbove = lanes(items.filter((it) => it.side === 'above'), gap);
  const lanesBelow = lanes(items.filter((it) => it.side === 'below'), gap);
  for (const lane of lanesAbove) spread(lane, width, gap);
  for (const lane of lanesBelow) spread(lane, width, gap);

  const tick = 5;
  const axisY = 4 + lanesAbove.length * LANE_H + tick + 4;
  const height = axisY + tick + 4 + lanesBelow.length * LANE_H + 4;
  const svg = svgEl('svg', { class: 'lstrip-svg', width, height, viewBox: `0 0 ${width} ${height}` });

  svg.appendChild(svgEl('line', { class: 'lstrip-axis', x1: margin - 6, x2: width - margin + 6, y1: axisY, y2: axisY }));
  for (const bx of breaks) {
    svg.appendChild(svgEl('path', { class: 'lstrip-break', d: `M${bx - 3} ${axisY + 5} l3 -10 M${bx + 1} ${axisY + 5} l3 -10` }));
  }

  const labelY = (it: Item) => (it.side === 'above' ? axisY - tick - 4 - it.lane * LANE_H : axisY + tick + 4 + FONT + it.lane * LANE_H);
  // 引线先画,压在刻度和文字下面
  for (const it of items) {
    const ly = labelY(it);
    const anchorY = it.side === 'above' ? ly + 2 : ly - FONT;
    const tipY = it.side === 'above' ? axisY - tick : axisY + tick;
    if (Math.abs(it.lx - it.x) > 1 || it.lane > 0) {
      svg.appendChild(svgEl('path', {
        class: `lstrip-lead ${it.kind}`,
        d: `M${it.x} ${tipY} L${it.x} ${tipY + (it.side === 'above' ? -3 : 3)} L${it.lx} ${anchorY}`,
      }));
    }
  }
  for (const it of items) {
    if (it.kind === 'spot') {
      svg.appendChild(svgEl('circle', { class: 'lstrip-spot', cx: it.x, cy: axisY, r: 4 }));
    } else {
      svg.appendChild(svgEl('line', {
        class: `lstrip-tick ${it.kind}`, x1: it.x, x2: it.x,
        y1: it.side === 'above' ? axisY - tick : axisY, y2: it.side === 'above' ? axisY : axisY + tick,
      }));
    }
  }
  for (const it of items) {
    const text = svgEl('text', { class: `lstrip-text ${it.kind}`, x: it.lx, y: labelY(it), 'text-anchor': 'middle' });
    const name = svgEl('tspan', { class: 'lstrip-name' });
    name.textContent = it.name;
    const price = svgEl('tspan', { class: 'lstrip-price', dx: 3 });
    price.textContent = it.text;
    text.appendChild(name);
    text.appendChild(price);
    const title = svgEl('title', {});
    title.textContent = it.tip;
    text.appendChild(title);
    svg.appendChild(text);
  }
  return svg;
}

/** 会按容器宽度自绘的价位条。 */
export function LevelStrip({ levels, spot }: { levels: AlertLevel[]; spot: number | null | undefined }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = host.current;
    if (!box) return;
    let drawnWidth = 0;
    const draw = () => {
      const w = Math.floor(box.clientWidth);
      if (!w || w === drawnWidth) return;
      drawnWidth = w;
      while (box.firstChild) box.removeChild(box.firstChild);
      const svg = buildLevelStripSvg(levels, spot, w);
      if (svg) box.appendChild(svg);
    };
    const frame = requestAnimationFrame(draw);
    const ro = new ResizeObserver(draw);
    ro.observe(box);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      drawnWidth = 0;
      while (box.firstChild) box.removeChild(box.firstChild);
    };
  }, [levels, spot]);
  return <div ref={host} className="lstrip" />;
}
