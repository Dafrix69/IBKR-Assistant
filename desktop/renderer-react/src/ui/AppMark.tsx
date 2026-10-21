/**
 * 应用图标在界面里的那一份:顶栏左上角的品牌标、分享卡片的角标。
 *
 * 几何与配色**逐项照抄** desktop/tools/make_icon.swift(应用图标 build/icon.* 就是它画的):超椭圆底板、
 * 左上亮蓝 → 右下深海蓝、白色粗笔画的 D、D 里逐级走高越往右越实的柱子(最高那根暖金)、上沿亮的玻璃边。
 * 32px 及以下用脚本里的小尺寸版:笔画更粗、只有两根柱子。
 * 以前界面里是一张"蓝方块 + 白折线"的旧图,应用图标换了它没跟着换——Dock 里一个样、窗口左上角另一个样。
 * 图标再改,改 make_icon.swift 的同时改这里的常量;坐标都在"底板单位坐标"(0…1,左上为原点)里。
 *
 * 两种画法共用一份几何:<AppMark>(SVG,顶栏)与 paintAppMark(canvas,分享卡片那张 PNG)。
 * 只画底板本身:落影与四周的留白是 macOS 图标网格的事,嵌在界面里不要。
 */
import { useId } from 'react';

interface Mark { left: number; top: number; bottom: number; right: number; stroke: number }
interface Bar { x: number; width: number; height: number; gold: boolean; alpha: number }
interface Glyph { mark: Mark; base: number; bars: Bar[] }
const LARGE: Glyph = {
  mark: { left: 0.238, top: 0.218, bottom: 0.782, right: 0.762, stroke: 0.083 },
  base: 0.684,
  bars: [
    { x: 0.342, width: 0.070, height: 0.136, gold: false, alpha: 0.58 },
    { x: 0.449, width: 0.070, height: 0.226, gold: false, alpha: 0.85 },
    { x: 0.556, width: 0.070, height: 0.325, gold: true, alpha: 1.00 },
  ],
};
const SMALL: Glyph = {
  mark: { left: 0.238, top: 0.218, bottom: 0.782, right: 0.762, stroke: 0.115 },
  base: 0.670,
  bars: [
    { x: 0.365, width: 0.095, height: 0.180, gold: false, alpha: 0.85 },
    { x: 0.505, width: 0.095, height: 0.330, gold: true, alpha: 1.00 },
  ],
};
const glyphFor = (size: number): Glyph => (size <= 32 ? SMALL : LARGE);

const BG_STOPS: [number, string][] = [[0, '#4A95FF'], [0.48, '#1A5BDB'], [1, '#0B2566']];
const GOLD_STOPS: [number, string][] = [[0, '#FFF4CF'], [0.45, '#FFD063'], [1, '#F5A524']];

/** 超椭圆(n = 5)的轮廓点:和 Apple 的连续曲率圆角几乎重合(同 make_icon.swift 的 squircle)。 */
const SQUIRCLE: [number, number][] = (() => {
  const n = 5;
  const steps = 180;
  const out: [number, number][] = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * 2 * Math.PI;
    const c = Math.cos(t);
    const s = Math.sin(t);
    out.push([0.5 + 0.5 * Math.sign(c) * Math.abs(c) ** (2 / n), 0.5 + 0.5 * Math.sign(s) * Math.abs(s) ** (2 / n)]);
  }
  return out;
})();

/** D:竖笔 + 右边一个半圆。回 [竖笔 x, 上 y, 下 y, 半圆圆心 x, 半径]。 */
function letterD(m: Mark): { left: number; top: number; bottom: number; cx: number; r: number } {
  const r = (m.bottom - m.top) / 2;
  return { left: m.left, top: m.top, bottom: m.bottom, cx: m.right - r, r };
}

// ---- SVG(界面) --------------------------------------------------------------------------

const U = 100; // SVG 用 0…100 的 viewBox,免得路径里全是小数
const f = (v: number) => +(v * U).toFixed(2);

const SQUIRCLE_D = `M${SQUIRCLE.map(([x, y]) => `${f(x)} ${f(y)}`).join('L')}Z`;
const letterDPath = (m: Mark) => {
  const d = letterD(m);
  return `M${f(d.left)} ${f(d.top)}H${f(d.cx)}A${f(d.r)} ${f(d.r)} 0 0 1 ${f(d.cx)} ${f(d.bottom)}H${f(d.left)}Z`;
};

export function AppMark({ size = 24, className }: { size?: number; className?: string }) {
  // 同一页上可能有好几枚(顶栏、弹层里的预览):渐变的 id 必须各自唯一
  const id = useId().replace(/:/g, '');
  const g = glyphFor(size);
  const gold = g.bars.find((b) => b.gold);
  return (
    <svg className={className} width={size} height={size} viewBox={`0 0 ${U} ${U}`} aria-hidden="true">
      <defs>
        <linearGradient id={`${id}bg`} x1="15" y1="0" x2="85" y2="100" gradientUnits="userSpaceOnUse">
          {BG_STOPS.map(([o, c]) => <stop key={o} offset={o} stopColor={c} />)}
        </linearGradient>
        <radialGradient id={`${id}glow`} cx="22" cy="10" r="75" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity="0.22" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}dusk`} x1="50" y1="55" x2="50" y2="100" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#020A24" stopOpacity="0" />
          <stop offset="1" stopColor="#020A24" stopOpacity="0.3" />
        </linearGradient>
        <linearGradient id={`${id}rim`} x1="50" y1="0" x2="50" y2="100" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity="0.55" />
          <stop offset="0.6" stopColor="#fff" stopOpacity="0.08" />
          <stop offset="1" stopColor="#fff" stopOpacity="0.18" />
        </linearGradient>
        {gold && (
          <linearGradient id={`${id}gold`} x1="0" y1={f(g.base - gold.height)} x2="0" y2={f(g.base)} gradientUnits="userSpaceOnUse">
            {GOLD_STOPS.map(([o, c]) => <stop key={o} offset={o} stopColor={c} />)}
          </linearGradient>
        )}
        <clipPath id={`${id}clip`}><path d={SQUIRCLE_D} /></clipPath>
      </defs>
      <g clipPath={`url(#${id}clip)`}>
        <path d={SQUIRCLE_D} fill={`url(#${id}bg)`} />
        <rect width={U} height={U} fill={`url(#${id}glow)`} />
        <rect width={U} height={U} fill={`url(#${id}dusk)`} />
        <path d={letterDPath(g.mark)} fill="none" stroke="#fff" strokeWidth={f(g.mark.stroke)} strokeLinejoin="round" />
        {g.bars.map((b) => (
          <rect key={b.x} x={f(b.x)} y={f(g.base - b.height)} width={f(b.width)} height={f(b.height)} rx={f(b.width * 0.3)}
            fill={b.gold ? `url(#${id}gold)` : '#fff'} opacity={b.gold ? 1 : b.alpha} />
        ))}
        {/* 玻璃边:描边压在轮廓上,裁掉外半边,只剩往里的那一道 */}
        <path d={SQUIRCLE_D} fill="none" stroke={`url(#${id}rim)`} strokeWidth="1.5" />
      </g>
    </svg>
  );
}

// ---- canvas(分享卡片) -------------------------------------------------------------------

/** 在 (x, y) 画一枚边长 size 的图标(和 <AppMark> 同一份几何;这边带上 D 的托影与金柱的光)。 */
export function paintAppMark(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  const u = (px: number, py: number): [number, number] => [x + px * size, y + py * size];
  const shape = new Path2D();
  SQUIRCLE.forEach(([px, py], i) => {
    const [ax, ay] = u(px, py);
    if (i === 0) shape.moveTo(ax, ay);
    else shape.lineTo(ax, ay);
  });
  shape.closePath();

  ctx.save();
  ctx.clip(shape);
  const bg = ctx.createLinearGradient(...u(0.15, 0), ...u(0.85, 1));
  for (const [o, c] of BG_STOPS) bg.addColorStop(o, c);
  ctx.fillStyle = bg;
  ctx.fill(shape);
  const glow = ctx.createRadialGradient(...u(0.22, 0.1), 0, ...u(0.22, 0.1), size * 0.75);
  glow.addColorStop(0, 'rgba(255,255,255,0.22)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(x, y, size, size);
  const dusk = ctx.createLinearGradient(...u(0.5, 0.55), ...u(0.5, 1));
  dusk.addColorStop(0, 'rgba(2,10,36,0)');
  dusk.addColorStop(1, 'rgba(2,10,36,0.3)');
  ctx.fillStyle = dusk;
  ctx.fillRect(x, y, size, size);

  const g = glyphFor(size);
  const d = letterD(g.mark);
  const dPath = new Path2D();
  dPath.moveTo(...u(d.left, d.top));
  dPath.lineTo(...u(d.cx, d.top));
  dPath.arc(...u(d.cx, (d.top + d.bottom) / 2), d.r * size, -Math.PI / 2, Math.PI / 2);
  dPath.lineTo(...u(d.left, d.bottom));
  dPath.closePath();
  ctx.save();
  ctx.shadowColor = 'rgba(2,10,36,0.35)';
  ctx.shadowBlur = size * 0.03;
  ctx.shadowOffsetY = size * 0.012;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = g.mark.stroke * size;
  ctx.lineJoin = 'round';
  ctx.stroke(dPath);
  ctx.restore();

  for (const b of g.bars) {
    const [bx, by] = u(b.x, g.base - b.height);
    const path = new Path2D();
    path.roundRect(bx, by, b.width * size, b.height * size, b.width * size * 0.3);
    ctx.save();
    if (b.gold) {
      const fill = ctx.createLinearGradient(bx, by, bx, by + b.height * size);
      for (const [o, c] of GOLD_STOPS) fill.addColorStop(o, c);
      ctx.shadowColor = 'rgba(255,211,107,0.45)';
      ctx.shadowBlur = size * 0.035;
      ctx.fillStyle = fill;
    } else {
      ctx.fillStyle = `rgba(255,255,255,${b.alpha})`;
    }
    ctx.fill(path);
    ctx.restore();
  }

  const rim = ctx.createLinearGradient(...u(0.5, 0), ...u(0.5, 1));
  rim.addColorStop(0, 'rgba(255,255,255,0.55)');
  rim.addColorStop(0.6, 'rgba(255,255,255,0.08)');
  rim.addColorStop(1, 'rgba(255,255,255,0.18)');
  ctx.strokeStyle = rim;
  ctx.lineWidth = size * 0.015;
  ctx.stroke(shape);
  ctx.restore();
}
