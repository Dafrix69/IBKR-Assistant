/**
 * 图形构件:把"一行字里的几个数"画出来。全部是内联 SVG / 纯 CSS,不引图表库——K 线那种重的图仍走 lib/chart。
 *
 *   IconTile    彩色圆角方块里一枚白色线稿图标(iOS 设置 / 侧栏的那种)
 *   Pill        淡染的状态胶囊:一个圆点或图标 + 两三个字
 *   Ring        环形量表:一个 0–1 的进度,中间放数
 *   Sparkline   迷你走势线,末点一颗圆点
 *   DeltaBar    以 0 为中心的双向条:涨跌幅、相对强度
 *   MeterBar    单向条:量比、进度
 *   SegBar      分段比例条:几种状态各占多少
 *   PriceRail   价位轨:止损 / 成本 / 现价 / 目标落在同一根轴上,成本到现价之间按盈亏着色
 *   PayoffChart 期权结构的到期损益图:盈利区绿、亏损区红,现价一根竖线
 *   StagePath   阶段路径:排队 → 已提交 → 成交 这种走到哪一步
 *
 * 颜色一律取 styles.css 的 token(var(--up) / var(--down) / var(--blue) …),涨跌配色翻转时自动跟着变。
 */
import type { CSSProperties, ReactNode } from 'react';
import { SfIcon } from './Icons';
function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export type Tint = 'blue' | 'green' | 'orange' | 'red' | 'purple' | 'teal' | 'indigo' | 'pink' | 'mint' | 'yellow' | 'gray' | 'up' | 'down';

const tintVar = (t: Tint | undefined): string => `var(--${t || 'blue'})`;

// ---- 图标瓦片 --------------------------------------------------------------

export function IconTile({ icon, tint = 'blue', size = 26, className, children, variant = 'solid' }: { icon?: string; tint?: Tint; size?: number; className?: string; children?: ReactNode; variant?: 'solid' | 'soft' | 'plain' }) {
  const style = { '--tile': tintVar(tint), width: size, height: size, borderRadius: Math.round(size * 0.29) } as CSSProperties;
  return (
    <span className={cx('icon-tile', variant !== 'solid' && variant, className)} style={style} aria-hidden="true">
      {icon ? <SfIcon name={icon} size={Math.round(size * (variant === 'plain' ? 0.75 : 0.62))} /> : children}
    </span>
  );
}

// ---- 状态胶囊 --------------------------------------------------------------

export function Pill({ tint = 'gray', children, dot, icon, solid, className, title }: { tint?: Tint; children: ReactNode; dot?: boolean; icon?: ReactNode; solid?: boolean; className?: string; title?: string }) {
  return (
    <span className={cx('pill', solid && 'solid', className)} style={{ '--tile': tintVar(tint) } as CSSProperties} title={title}>
      {dot ? <i className="pill-dot" /> : null}
      {icon}
      {children}
    </span>
  );
}

// ---- 环形量表 --------------------------------------------------------------

export function Ring({ value, size = 56, stroke = 6, tint = 'blue', children, className, title }: { value: number | null | undefined; size?: number; stroke?: number; tint?: Tint; children?: ReactNode; className?: string; title?: string }) {
  const v = value == null || !Number.isFinite(value) ? 0 : Math.max(0, Math.min(1, value));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <span className={cx('ring', className)} style={{ width: size, height: size }} title={title}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--bg-fill-strong)" strokeWidth={stroke} />
        {v > 0 ? (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={tintVar(tint)}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${c * v} ${c}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        ) : null}
      </svg>
      {children !== undefined ? <span className="ring-center">{children}</span> : null}
    </span>
  );
}

// ---- 迷你走势线 ------------------------------------------------------------

export function Sparkline({ values, width = 64, height = 22, tint, fill = true, className }: { values: number[]; width?: number; height?: number; tint?: Tint; fill?: boolean; className?: string }) {
  const pts = values.filter((v) => Number.isFinite(v));
  if (pts.length < 2) return null;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const pad = 2.5;
  const x = (i: number) => pad + (i / (pts.length - 1)) * (width - pad * 2);
  const y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);
  const line = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const color = tintVar(tint || (pts[pts.length - 1] >= pts[0] ? 'up' : 'down'));
  return (
    <svg className={cx('sparkline', className)} width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {fill ? <path d={`${line} L${x(pts.length - 1).toFixed(1)} ${height} L${x(0).toFixed(1)} ${height} Z`} fill={color} opacity={0.14} /> : null}
      <path d={line} fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={x(pts.length - 1)} cy={y(pts[pts.length - 1])} r={2.2} fill={color} />
    </svg>
  );
}

// ---- 条 --------------------------------------------------------------------

/** 以 0 为中心的双向条。value 与 scale 同单位(百分点);超过 scale 的封顶。 */
export function DeltaBar({ value, scale = 5, width = 56, className }: { value: number | null | undefined; scale?: number; width?: number; className?: string }) {
  const ok = value != null && Number.isFinite(value);
  const frac = ok ? Math.max(-1, Math.min(1, (value as number) / scale)) : 0;
  const half = Math.abs(frac) * 50;
  return (
    <span className={cx('delta-bar', className)} style={{ width }} aria-hidden="true">
      {ok && half > 0 ? <i className={frac > 0 ? 'up' : 'down'} style={frac > 0 ? { left: '50%', width: `${half}%` } : { right: '50%', width: `${half}%` }} /> : null}
    </span>
  );
}

export function MeterBar({ value, max = 1, tint = 'blue', width, className, title }: { value: number | null | undefined; max?: number; tint?: Tint; width?: number; className?: string; title?: string }) {
  const frac = value != null && Number.isFinite(value) && max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  return (
    <span className={cx('meter-bar', className)} style={{ width, '--tile': tintVar(tint) } as CSSProperties} title={title} aria-hidden="true">
      <i style={{ width: `${frac * 100}%` }} />
    </span>
  );
}

export function SegBar({ parts, className }: { parts: { key: string; value: number; tint: Tint; label?: string }[]; className?: string }) {
  const total = parts.reduce((a, p) => a + Math.max(0, p.value), 0);
  if (!total) return <span className={cx('seg-bar', 'empty', className)} />;
  return (
    <span className={cx('seg-bar', className)}>
      {parts
        .filter((p) => p.value > 0)
        .map((p) => (
          <i key={p.key} style={{ flexGrow: p.value, background: tintVar(p.tint) }} title={p.label ? `${p.label} ${p.value}` : undefined} />
        ))}
    </span>
  );
}

// ---- 价位轨 ----------------------------------------------------------------

export interface RailMark {
  key: string;
  price: number | null | undefined;
  label: string;
  kind: 'stop' | 'cost' | 'now' | 'target' | 'other';
}

const RAIL_TINT: Record<RailMark['kind'], string> = {
  stop: 'var(--down)',
  target: 'var(--up)',
  cost: 'var(--label-secondary)',
  now: 'var(--blue)',
  other: 'var(--orange)',
};

/**
 * 几个价位落在同一根横轴上。成本 → 现价 之间的那一段按盈亏着色(gain 由调用方给:空头的盈亏方向与价格相反)。
 * 标签上下交错摆,挤在一起时也不叠字。
 */
export function PriceRail({ marks, gain, digits = 2, className }: { marks: RailMark[]; gain?: boolean | null; digits?: number; className?: string }) {
  const live = marks.filter((m): m is RailMark & { price: number } => m.price != null && Number.isFinite(m.price));
  if (live.length < 2) return null;
  const W = 600;
  const H = 62;
  const padX = 34;
  const min = Math.min(...live.map((m) => m.price));
  const max = Math.max(...live.map((m) => m.price));
  const span = max - min || Math.abs(max) * 0.01 || 1;
  const x = (p: number) => padX + ((p - min) / span) * (W - padX * 2);
  const axisY = 31;
  const cost = live.find((m) => m.kind === 'cost');
  const now = live.find((m) => m.kind === 'now');
  const sorted = [...live].sort((a, b) => a.price - b.price);
  return (
    <svg className={cx('price-rail', className)} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={sorted.map((m) => `${m.label} ${m.price.toFixed(digits)}`).join(',')}>
      <line x1={padX - 14} y1={axisY} x2={W - padX + 14} y2={axisY} stroke="var(--bg-fill-strong)" strokeWidth={6} strokeLinecap="round" />
      {cost && now && gain != null ? (
        <line x1={x(cost.price)} y1={axisY} x2={x(now.price)} y2={axisY} stroke={gain ? 'var(--up)' : 'var(--down)'} strokeWidth={6} strokeLinecap="round" opacity={0.85} />
      ) : null}
      {sorted.map((m, i) => {
        const cx0 = x(m.price);
        const above = i % 2 === 0;
        const color = RAIL_TINT[m.kind];
        const anchor = cx0 < padX + 30 ? 'start' : cx0 > W - padX - 30 ? 'end' : 'middle';
        const tx = anchor === 'start' ? cx0 - 6 : anchor === 'end' ? cx0 + 6 : cx0;
        return (
          <g key={m.key}>
            {m.kind === 'now' ? (
              <>
                <circle cx={cx0} cy={axisY} r={9} fill="var(--blue)" opacity={0.18} />
                <circle cx={cx0} cy={axisY} r={5.5} fill="var(--blue)" stroke="#fff" strokeWidth={2} />
              </>
            ) : (
              <rect x={cx0 - 1.75} y={axisY - 8} width={3.5} height={16} rx={1.75} fill={color} />
            )}
            <text x={tx} y={above ? 11 : H - 3} textAnchor={anchor} className="price-rail-text">
              <tspan fill={m.kind === 'cost' ? 'var(--label-secondary)' : color} fontWeight={600}>
                {m.label}
              </tspan>
              <tspan dx={5} className="price-rail-num">
                {m.price.toFixed(digits)}
              </tspan>
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ---- 期权到期损益图 ---------------------------------------------------------

export interface PayoffLeg {
  /** +1 买入 / -1 卖出 */
  sign: 1 | -1;
  right: 'C' | 'P';
  strike: number;
  ratio?: number;
}

/** 到期时每 1 份结构的内在价值(不含权利金)。 */
function intrinsic(legs: PayoffLeg[], s: number): number {
  let v = 0;
  for (const l of legs) {
    const raw = l.right === 'C' ? Math.max(0, s - l.strike) : Math.max(0, l.strike - s);
    v += l.sign * (l.ratio || 1) * raw;
  }
  return v;
}

/**
 * 到期损益。premium 是建仓时每份**付出**的净权利金(收取则为负);给不出时只画形状、不标盈亏平衡。
 * 纵轴不标刻度——这张图回答的是"哪一段赚、哪一段亏、现在站在哪",具体数字在旁边的瓦片里。
 */
export function PayoffChart({ legs, premium, spot, height = 120, className }: { legs: PayoffLeg[]; premium?: number | null; spot?: number | null; height?: number; className?: string }) {
  if (!legs.length) return null;
  const strikes = legs.map((l) => l.strike).sort((a, b) => a - b);
  const lo = strikes[0];
  const hi = strikes[strikes.length - 1];
  const wing = hi > lo ? (hi - lo) * 0.6 : Math.max(lo * 0.06, 1);
  let xMin = lo - wing;
  let xMax = hi + wing;
  if (spot != null && Number.isFinite(spot)) {
    // 现价离得太远就不为它把图压扁:超出两倍翼宽的,只在边上标一个箭头
    if (spot > xMin - wing * 2 && spot < xMax + wing * 2) {
      xMin = Math.min(xMin, spot - wing * 0.3);
      xMax = Math.max(xMax, spot + wing * 0.3);
    }
  }
  const cost = premium != null && Number.isFinite(premium) ? premium : 0;
  const xs = Array.from(new Set([xMin, ...strikes, xMax])).sort((a, b) => a - b);
  const pts = xs.map((s) => ({ s, v: intrinsic(legs, s) - cost }));
  const vMin = Math.min(0, ...pts.map((p) => p.v));
  const vMax = Math.max(0, ...pts.map((p) => p.v));
  const vSpan = vMax - vMin || 1;
  const W = 600;
  const H = height;
  const padT = 10;
  const padB = 22;
  const X = (s: number) => ((s - xMin) / (xMax - xMin)) * W;
  const Y = (v: number) => padT + (1 - (v - vMin) / vSpan) * (H - padT - padB);
  const zeroY = Y(0);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.s).toFixed(1)} ${Y(p.v).toFixed(1)}`).join(' ');
  const area = `${line} L${W} ${zeroY.toFixed(1)} L0 ${zeroY.toFixed(1)} Z`;
  const id = `pf-${strikes.join('-')}-${Math.round(cost * 100)}`.replace(/[^\w-]/g, '_');
  const spotIn = spot != null && Number.isFinite(spot) && spot >= xMin && spot <= xMax;
  return (
    <svg className={cx('payoff', className)} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="到期损益图">
      <defs>
        <clipPath id={`${id}-up`}>
          <rect x={0} y={0} width={W} height={zeroY} />
        </clipPath>
        <clipPath id={`${id}-dn`}>
          <rect x={0} y={zeroY} width={W} height={H - zeroY} />
        </clipPath>
      </defs>
      <path d={area} fill="var(--up)" opacity={0.2} clipPath={`url(#${id}-up)`} />
      <path d={area} fill="var(--down)" opacity={0.16} clipPath={`url(#${id}-dn)`} />
      <line x1={0} y1={zeroY} x2={W} y2={zeroY} stroke="var(--label-tertiary)" strokeWidth={1} strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
      <path d={line} fill="none" stroke="var(--up)" strokeWidth={2.2} strokeLinejoin="round" clipPath={`url(#${id}-up)`} vectorEffect="non-scaling-stroke" />
      <path d={line} fill="none" stroke="var(--down)" strokeWidth={2.2} strokeLinejoin="round" clipPath={`url(#${id}-dn)`} vectorEffect="non-scaling-stroke" />
      {strikes.map((k) => (
        <g key={k}>
          <line x1={X(k)} y1={H - padB + 2} x2={X(k)} y2={H - padB + 7} stroke="var(--label-tertiary)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        </g>
      ))}
      {spotIn ? <line x1={X(spot as number)} y1={4} x2={X(spot as number)} y2={H - padB + 2} stroke="var(--blue)" strokeWidth={1.6} vectorEffect="non-scaling-stroke" /> : null}
    </svg>
  );
}

/** PayoffChart 下面那一排行权价标签:SVG 用 preserveAspectRatio=none 拉伸,字放进去会被压扁,所以用 HTML 叠。 */
export function PayoffAxis({ legs, spot }: { legs: PayoffLeg[]; spot?: number | null }) {
  const strikes = Array.from(new Set(legs.map((l) => l.strike))).sort((a, b) => a - b);
  if (!strikes.length) return null;
  const lo = strikes[0];
  const hi = strikes[strikes.length - 1];
  const wing = hi > lo ? (hi - lo) * 0.6 : Math.max(lo * 0.06, 1);
  let xMin = lo - wing;
  let xMax = hi + wing;
  if (spot != null && Number.isFinite(spot) && spot > xMin - wing * 2 && spot < xMax + wing * 2) {
    xMin = Math.min(xMin, spot - wing * 0.3);
    xMax = Math.max(xMax, spot + wing * 0.3);
  }
  const pct = (s: number) => `${(((s - xMin) / (xMax - xMin)) * 100).toFixed(2)}%`;
  const spotIn = spot != null && Number.isFinite(spot) && spot >= xMin && spot <= xMax;
  return (
    <div className="payoff-axis" aria-hidden="true">
      {strikes.map((k) => (
        <span key={k} style={{ left: pct(k) }}>
          {k}
        </span>
      ))}
      {spotIn ? (
        <span className="spot" style={{ left: pct(spot as number) }}>
          现价 {(spot as number).toFixed(2)}
        </span>
      ) : null}
    </div>
  );
}

// ---- 阶段路径 --------------------------------------------------------------

export function StagePath({ stages, current, tone = 'blue', className }: { stages: string[]; current: number; tone?: Tint; className?: string }) {
  return (
    <span className={cx('stage-path', className)} style={{ '--tile': tintVar(tone) } as CSSProperties}>
      {stages.map((s, i) => (
        <span key={s} className={cx('stage', i < current && 'done', i === current && 'now')}>
          <i />
          <em>{s}</em>
        </span>
      ))}
    </span>
  );
}

// ---- 代码徽章 --------------------------------------------------------------

/** 标的代码落在一枚淡染的圆角方块里;超过 4 个字符的缩小一号。 */
export function SymBadge({ symbol, tint = 'blue', small, className }: { symbol: string; tint?: Tint; small?: boolean; className?: string }) {
  const text = String(symbol || '').slice(0, 5);
  return (
    <span className={cx('sym-badge', small && 'sm', text.length > 4 && 'long', className)} style={{ '--tile': tintVar(tint) } as CSSProperties} aria-hidden="true">
      {text}
    </span>
  );
}

// ---- 小组件瓦片 ------------------------------------------------------------

/** iOS 小组件那种瓦片:左上一枚图标瓦片,下面一个大数和它的名字;右上角可以再放一块小图(环 / 走势线)。 */
export function Widget({ icon, tint = 'blue', value, label, extra, tone, className, onClick }: { icon: string; tint?: Tint; value: ReactNode; label: ReactNode; extra?: ReactNode; tone?: 'up' | 'down' | ''; className?: string; onClick?: () => void }) {
  return (
    <div className={cx('widget', onClick && 'clickable', className)} onClick={onClick} role={onClick ? 'button' : undefined}>
      <div className="widget-top">
        <IconTile icon={icon} tint={tint} size={30} variant="soft" />
        {extra}
      </div>
      <div className={cx('hero-num', tone)}>{value}</div>
      <div className="hero-sub">{label}</div>
    </div>
  );
}
