/**
 * 绩效体检的分享卡片:把 review.performance 的结果画成一张 1080×1350 的 PNG(朋友圈、小红书、X 都是 4:5 放得下)。
 *
 * 口径:
 *   * **默认不带金额。** 胜率、盈亏比、R、利润因子这些比例就够说明"系统好不好";账户多大、赚了多少钱是隐私。
 *     金额要用户在弹窗里自己勾「显示金额」才画上去。
 *   * **不夸大。** 账本里有模拟盘的交易就在副标题写明「含模拟盘」;不到 20 笔在页脚写「样本偏少」——
 *     晒出去的卡片会被当成战绩看,少一句话就是误导。
 *   * 权益曲线只画形状,不标坐标轴:形状说明稳不稳,刻度会把金额带出去。
 *   * 不含任何账号、标的明细、持仓;全在本机画,不上传。
 *
 * 纯绘制:输入结果 + 选项,输出画好的 canvas。不碰 store、不碰 bridge。
 */
import type { PerformanceKind, PerformanceScope, ReviewPerformanceResult } from '../bridge';
import { paintAppMark } from '../ui/AppMark';

export const CARD_W = 1080;
export const CARD_H = 1350;

export interface ShareCardOptions {
  scope: PerformanceScope;
  kind: PerformanceKind;
  days: number;
  showAmounts: boolean;
  /** 涨跌配色:red-up 时盈利画红色(A 股 / 港股习惯) */
  redUp: boolean;
  /** 卡片右上角的日期;测试与预览台固定它 */
  date?: Date;
}

const SCOPE_LABEL: Record<PerformanceScope, string> = { all: '全部账户', live: '实盘', paper: '模拟盘' };
const KIND_LABEL: Record<PerformanceKind, string> = { all: '全部品种', butterfly: '蝴蝶', stock: '股票', option: '期权' };

const C = {
  bg0: '#0f1218',
  bg1: '#07080b',
  panel: 'rgba(255,255,255,0.055)',
  panelEdge: 'rgba(255,255,255,0.08)',
  label: '#f5f5f7',
  secondary: 'rgba(235,235,245,0.62)',
  tertiary: 'rgba(235,235,245,0.36)',
  accent: '#0a84ff',
  green: '#30d158',
  red: '#ff453a',
};

function cssFont(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

const num = (v: number | null | undefined, digits = 2): string =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');

const pct = (v: number | null | undefined): string => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${num(v, 1)}%`);

const usd = (v: number): string => {
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  return `${sign}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 副标题:范围 · 品种 · 时间。「全部账户」里混着模拟盘时说清楚。 */
export function cardSubtitle(r: ReviewPerformanceResult, o: Pick<ShareCardOptions, 'scope' | 'kind' | 'days'>): string {
  let scope = SCOPE_LABEL[o.scope];
  if (o.scope === 'all') {
    const paper = r.mix.paper > 0;
    const live = r.mix.live > 0;
    scope = paper && live ? '实盘 + 模拟盘' : paper ? '模拟盘' : '实盘';
  }
  const span = o.days ? `最近 ${o.days} 天` : '全部时间';
  return `${scope} · ${KIND_LABEL[o.kind]} · ${span}`;
}

/** 页脚那句话:样本少就直说。 */
export function cardFootnote(r: ReviewPerformanceResult): string {
  const n = r.stats.trades;
  const base = '本机代码计算 · 不含账户信息 · 不构成投资建议';
  return n < 20 ? `样本 ${n} 笔,偏少 · ${base}` : base;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function panel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  roundRect(ctx, x, y, w, h, 36);
  ctx.fillStyle = C.panel;
  ctx.fill();
  ctx.strokeStyle = C.panelEdge;
  ctx.lineWidth = 2;
  ctx.stroke();
}

/** 一个"标签在上、数在下"的格子。数字按格宽收字号:"42.5%"、"+0.55R" 这种宽窄差很多,定死字号就会撞到隔壁一格。 */
function stat(
  ctx: CanvasRenderingContext2D, x: number, y: number, label: string, value: string,
  fonts: { ui: string; display: string }, size: number, maxWidth: number, color = C.label,
): void {
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = C.secondary;
  ctx.font = `500 28px ${fonts.ui}`;
  ctx.fillText(label, x, y);
  ctx.fillStyle = color;
  let px = size;
  ctx.font = `600 ${px}px ${fonts.display}`;
  while (px > 24 && ctx.measureText(value).width > maxWidth) {
    px -= 2;
    ctx.font = `600 ${px}px ${fonts.display}`;
  }
  // 基线按原字号放:同一排的数不管缩没缩,底边都对齐
  ctx.fillText(value, x, y + size + 6);
}

function equityCurve(ctx: CanvasRenderingContext2D, r: ReviewPerformanceResult, x: number, y: number, w: number, h: number, up: string, down: string): void {
  // 从 0 起画:第一笔之前的权益就是 0,曲线才看得出第一笔是赚是亏
  const pts = [0, ...r.equity.map((p) => p.equity)];
  if (pts.length < 3) {
    ctx.fillStyle = C.tertiary;
    ctx.font = `500 28px ${cssFont('--font', 'sans-serif')}`;
    ctx.textAlign = 'center';
    ctx.fillText('笔数太少,画不出曲线', x + w / 2, y + h / 2);
    return;
  }
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  const span = hi - lo || 1;
  const px = (i: number) => x + (i / (pts.length - 1)) * w;
  const py = (v: number) => y + h - ((v - lo) / span) * h;
  const last = pts[pts.length - 1] ?? 0;
  const color = last >= 0 ? up : down;

  // 零线:虚线,不标数
  if (lo < 0 && hi > 0) {
    ctx.save();
    ctx.setLineDash([10, 12]);
    ctx.strokeStyle = C.tertiary;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, py(0));
    ctx.lineTo(x + w, py(0));
    ctx.stroke();
    ctx.restore();
  }

  ctx.beginPath();
  pts.forEach((v, i) => (i === 0 ? ctx.moveTo(px(i), py(v)) : ctx.lineTo(px(i), py(v))));
  ctx.lineTo(px(pts.length - 1), y + h);
  ctx.lineTo(px(0), y + h);
  ctx.closePath();
  const fill = ctx.createLinearGradient(0, y, 0, y + h);
  fill.addColorStop(0, `${color}55`);
  fill.addColorStop(1, `${color}00`);
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.beginPath();
  pts.forEach((v, i) => (i === 0 ? ctx.moveTo(px(i), py(v)) : ctx.lineTo(px(i), py(v))));
  ctx.strokeStyle = color;
  ctx.lineWidth = 5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
}


/** 画卡片。返回画好的 canvas;调用方 toDataURL('image/png') 拿图。 */
export function drawShareCard(r: ReviewPerformanceResult, o: ShareCardOptions): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const fonts = {
    ui: cssFont('--font', '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'),
    display: cssFont('--font-display', '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'),
  };
  const up = o.redUp ? C.red : C.green;
  const down = o.redUp ? C.green : C.red;
  const s = r.stats;
  const P = 80;

  // 底:深色渐变 + 右上角一团强调色的光
  const bg = ctx.createLinearGradient(0, 0, CARD_W, CARD_H);
  bg.addColorStop(0, C.bg0);
  bg.addColorStop(1, C.bg1);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  const glow = ctx.createRadialGradient(CARD_W - 120, 80, 10, CARD_W - 120, 80, 620);
  glow.addColorStop(0, 'rgba(10,132,255,0.30)');
  glow.addColorStop(1, 'rgba(10,132,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // 顶:品牌 + 日期
  paintAppMark(ctx, P, 72, 56);
  ctx.fillStyle = C.label;
  ctx.font = `600 32px ${fonts.ui}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('IBKR-Assistant', P + 76, 100);
  ctx.fillStyle = C.tertiary;
  ctx.font = `500 28px ${fonts.ui}`;
  ctx.textAlign = 'right';
  ctx.fillText(ymd(o.date ?? new Date()), CARD_W - P, 100);

  // 标题
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = C.label;
  ctx.font = `700 72px ${fonts.display}`;
  ctx.fillText('交易体检', P, 250);
  ctx.fillStyle = C.secondary;
  ctx.font = `500 32px ${fonts.ui}`;
  ctx.fillText(cardSubtitle(r, o), P, 304);

  // 三个大数:胜率 / 盈亏比 / 每笔期望(有 R 用 R,没有用利润因子)
  const col = (CARD_W - 2 * P) / 3;
  const fit = col - 32;
  const heroY = 400;
  stat(ctx, P, heroY, '胜率', pct(s.win_rate), fonts, 96, fit);
  stat(ctx, P + col, heroY, '盈亏比', num(s.payoff_ratio), fonts, 96, fit);
  if (r.r_stats.expectancy_r !== null && r.r_stats.trades > 0) {
    const e = r.r_stats.expectancy_r;
    // 区间跨着 0(正负还没分清)的不上色,和页面上同一条规矩
    const ci = r.r_stats.expectancy_ci;
    const clear = ci !== null && (ci.lo > 0 || ci.hi < 0);
    stat(ctx, P + 2 * col, heroY, '每笔期望', `${e > 0 ? '+' : ''}${num(e)}R`, fonts, 96, fit, !clear ? C.label : e > 0 ? up : down);
  } else {
    const pf = s.profit_factor;
    stat(ctx, P + 2 * col, heroY, '利润因子', num(pf), fonts, 96, fit, pf === null ? C.label : pf >= 1 ? up : down);
  }

  // 权益曲线
  const cy = 590;
  const ch = 380;
  panel(ctx, P, cy, CARD_W - 2 * P, ch);
  ctx.fillStyle = C.secondary;
  ctx.font = `500 28px ${fonts.ui}`;
  ctx.textAlign = 'left';
  ctx.fillText('平仓权益曲线', P + 40, cy + 60);
  if (o.showAmounts) {
    ctx.textAlign = 'right';
    ctx.fillStyle = s.net_pnl >= 0 ? up : down;
    ctx.font = `600 32px ${fonts.display}`;
    ctx.fillText(usd(s.net_pnl), CARD_W - P - 40, cy + 60);
  }
  equityCurve(ctx, r, P + 40, cy + 100, CARD_W - 2 * P - 80, ch - 140, up, down);

  // 六个小格
  const gy = 1030;
  const sqn = r.r_stats.sqn;
  const cells: [string, string][] = [
    ['已了结', `${s.trades} 笔`],
    ['利润因子', num(s.profit_factor)],
    sqn !== null ? ['SQN', `${num(sqn)}${r.r_stats.sqn_label ? ` ${r.r_stats.sqn_label}` : ''}`] : ['盈利日', r.per_day.days ? `${r.per_day.green_days}/${r.per_day.days}` : '—'],
    ['最长连胜', `${s.max_consecutive_wins}`],
    ['最长连亏', `${s.max_consecutive_losses}`],
    o.showAmounts
      ? ['最大回撤', r.drawdown.max > 0 ? usd(-r.drawdown.max) : '0']
      : ['恢复因子', num(r.drawdown.recovery_factor)],
  ];
  cells.forEach(([label, value], i) => {
    const cx = P + (i % 3) * col;
    const cyy = gy + Math.floor(i / 3) * 120;
    stat(ctx, cx, cyy, label, value, fonts, 52, fit);
  });

  // 页脚
  ctx.textAlign = 'left';
  ctx.fillStyle = C.tertiary;
  ctx.font = `500 24px ${fonts.ui}`;
  ctx.fillText(cardFootnote(r), P, CARD_H - 64);
  return canvas;
}
