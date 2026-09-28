/**
 * 应用图标在界面里的那一份:顶栏左上角的品牌标、分享卡片的角标。
 *
 * 几何与配色**逐项照抄** desktop/tools/make_icon.swift(应用图标 build/icon.* 就是它画的):超椭圆底板、
 * 左上亮蓝 → 右下深海蓝、三根逐级走高越往右越实的白 K 线、右上一大一小两颗暖金四角星、上沿亮的玻璃边。
 * 以前界面里是一张"蓝方块 + 白折线"的旧图,应用图标换了它没跟着换——Dock 里一个样、窗口左上角另一个样。
 * 图标再改,改 make_icon.swift 的同时改这里的常量;坐标都在"底板单位坐标"(0…1,左上为原点)里。
 *
 * 两种画法共用一份几何:<AppMark>(SVG,顶栏)与 paintAppMark(canvas,分享卡片那张 PNG)。
 * 只画底板本身:落影与四周的留白是 macOS 图标网格的事,嵌在界面里不要。
 */
import { useId } from 'react';

interface Candle { x: number; top: number; bottom: number; high: number; low: number; alpha: number }
const CANDLES: Candle[] = [
  { x: 0.245, top: 0.600, bottom: 0.780, high: 0.545, low: 0.835, alpha: 0.58 },
  { x: 0.425, top: 0.470, bottom: 0.670, high: 0.410, low: 0.735, alpha: 0.80 },
  { x: 0.605, top: 0.310, bottom: 0.545, high: 0.240, low: 0.620, alpha: 1.00 },
];
const CANDLE_W = 0.118;
const WICK_W = 0.020;
const CANDLE_R = 0.024;
/** [中心 x, 中心 y, 半径] */
const SPARKLES: [number, number, number][] = [[0.775, 0.285, 0.098], [0.680, 0.165, 0.038]];
const PINCH = 0.14;

const BG_STOPS: [number, string][] = [[0, '#4A95FF'], [0.48, '#1A5BDB'], [1, '#0B2566']];
const GOLD_STOPS: [number, string][] = [[0, '#FFF4CF'], [0.5, '#FFD063'], [1, '#F5A524']];

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

/** 四角星:四个尖,边是往里凹的二次曲线。回 [起点, [控制点, 终点] × 4]。 */
function sparkleCurve(cx: number, cy: number, r: number): { start: [number, number]; segs: [[number, number], [number, number]][] } {
  const tips: [number, number][] = [[cx, cy - r], [cx + r, cy], [cx, cy + r], [cx - r, cy]];
  const k = r * PINCH;
  const ctrls: [number, number][] = [[cx + k, cy - k], [cx + k, cy + k], [cx - k, cy + k], [cx - k, cy - k]];
  return {
    start: tips[0] as [number, number],
    segs: ctrls.map((c, i) => [c, tips[(i + 1) % 4] as [number, number]]),
  };
}

// ---- SVG(界面) --------------------------------------------------------------------------

const U = 100; // SVG 用 0…100 的 viewBox,免得路径里全是小数
const f = (v: number) => +(v * U).toFixed(2);

const SQUIRCLE_D = `M${SQUIRCLE.map(([x, y]) => `${f(x)} ${f(y)}`).join('L')}Z`;
const sparkleD = (cx: number, cy: number, r: number) => {
  const { start, segs } = sparkleCurve(cx, cy, r);
  return `M${f(start[0])} ${f(start[1])}` + segs.map(([c, p]) => `Q${f(c[0])} ${f(c[1])} ${f(p[0])} ${f(p[1])}`).join('') + 'Z';
};

export function AppMark({ size = 24, className }: { size?: number; className?: string }) {
  // 同一页上可能有好几枚(顶栏、弹层里的预览):渐变的 id 必须各自唯一
  const id = useId().replace(/:/g, '');
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
        {SPARKLES.map(([cx, cy, r], i) => (
          <linearGradient key={i} id={`${id}gold${i}`} x1={f(cx)} y1={f(cy - r)} x2={f(cx)} y2={f(cy + r)} gradientUnits="userSpaceOnUse">
            {GOLD_STOPS.map(([o, c]) => <stop key={o} offset={o} stopColor={c} />)}
          </linearGradient>
        ))}
        <clipPath id={`${id}clip`}><path d={SQUIRCLE_D} /></clipPath>
      </defs>
      <g clipPath={`url(#${id}clip)`}>
        <path d={SQUIRCLE_D} fill={`url(#${id}bg)`} />
        <rect width={U} height={U} fill={`url(#${id}glow)`} />
        <rect width={U} height={U} fill={`url(#${id}dusk)`} />
        {/* 透明度放在整组上:影线和实体先合成一个形状再整体变淡。各自带透明度的话,重叠那段会叠出一道亮条
            (make_icon.swift 里同一个坑,那边是合成一条路径一次填) */}
        {CANDLES.map((c) => (
          <g key={c.x} fill="#fff" opacity={c.alpha}>
            <rect x={f(c.x - WICK_W / 2)} y={f(c.high)} width={f(WICK_W)} height={f(c.low - c.high)} rx={f(WICK_W / 2)} />
            <rect x={f(c.x - CANDLE_W / 2)} y={f(c.top)} width={f(CANDLE_W)} height={f(c.bottom - c.top)} rx={f(CANDLE_R)} />
          </g>
        ))}
        {SPARKLES.map(([cx, cy, r], i) => <path key={i} d={sparkleD(cx, cy, r)} fill={`url(#${id}gold${i})`} />)}
        {/* 玻璃边:描边压在轮廓上,裁掉外半边,只剩往里的那一道 */}
        <path d={SQUIRCLE_D} fill="none" stroke={`url(#${id}rim)`} strokeWidth="1.5" />
      </g>
    </svg>
  );
}

// ---- canvas(分享卡片) -------------------------------------------------------------------

/** 在 (x, y) 画一枚边长 size 的图标(和 <AppMark> 同一份几何;这边带上 K 线的托影与星的金光)。 */
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

  for (const c of CANDLES) {
    const path = new Path2D();
    const [wx, wy] = u(c.x - WICK_W / 2, c.high);
    path.roundRect(wx, wy, WICK_W * size, (c.low - c.high) * size, (WICK_W * size) / 2);
    const [bx, by] = u(c.x - CANDLE_W / 2, c.top);
    path.roundRect(bx, by, CANDLE_W * size, (c.bottom - c.top) * size, CANDLE_R * size);
    ctx.save();
    ctx.shadowColor = 'rgba(2,10,36,0.35)';
    ctx.shadowBlur = size * 0.03;
    ctx.shadowOffsetY = size * 0.012;
    ctx.fillStyle = `rgba(255,255,255,${c.alpha})`;
    ctx.fill(path);
    ctx.restore();
  }

  for (const [cx, cy, r] of SPARKLES) {
    const { start, segs } = sparkleCurve(cx, cy, r);
    const path = new Path2D();
    path.moveTo(...u(...start));
    for (const [c, p] of segs) path.quadraticCurveTo(...u(...c), ...u(...p));
    path.closePath();
    const gold = ctx.createLinearGradient(...u(cx, cy - r), ...u(cx, cy + r));
    for (const [o, c] of GOLD_STOPS) gold.addColorStop(o, c);
    ctx.save();
    ctx.shadowColor = 'rgba(255,211,107,0.55)';
    ctx.shadowBlur = r * size * 0.45;
    ctx.fillStyle = gold;
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
