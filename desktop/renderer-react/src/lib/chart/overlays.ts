// 业务叠加层:图表库画轴、网格、蜡烛、量能与十字光标,并负责缩放平移;库里没有、或者画法对不上的——
// 折线(断点不连、任意虚线、1.5px)、FVG / 订单块色块、竖带、关键位虚线与左端名字、开平仓竖线、
// 带文字避让的标记、现价点线、轴上价格标签的避让与引线——在这里用库的 primitives 接口画,
// 画法、透明度、避让规则与原来的 canvas 引擎一致(见 docs/features/priceaction.md)。
//
// 为什么折线也自己画:库的折线**遇到空白点不断开**(空白点不进绘制序列,前后两点直接连上),
// 蝶价图的「模型价」只在部分分钟有值,连起来就是在真实价格段上画了一条不存在的线;
// 库的线宽只有 1–4 整数、虚线只有 5 种比例预设,也表达不了 1.5px 与 [3,2]。
//
// 坐标全部走库:x = 下标对应的 logical 坐标,y = 载体序列的 priceToCoordinate。
// 缩放、平移之后库会调 updateAllViews / 重画,这里重新取一次坐标就跟上了。
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  ISeriesPrimitiveAxisView,
  Logical,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';
import { layoutTags, placeLabel, type Rect } from './layout';
import { resolveColor, withAlpha, type Palette } from './palette';
import { fmtPrice, fmtVol, type ChartSpec, type Normalized } from './spec';

/** 图内小标签(9px 字)的行高 */
const LABEL_H = 12;
/** 库画的轴上标签高度,也是避让的最小间距:11px 字 + 上下内边距 2×(2.5/12×11) + 上下边框 2×(2/12×11) ≈ 19.25,
 *  高分屏奇偶取整还会再多 1px。取小了相邻标签会叠掉 2–3px */
const TAG_H = 20;
/** 被推开的轴上标签的引线:画在图区最右边这几个像素里(轴上标签的底色从刻度那一段就开始铺,画在轴上会被盖住) */
const LEADER_W = 6;

export interface OverlayState {
  spec: ChartSpec;
  norm: Normalized;
  P: Palette;
  dec: number;
  /** 顶部读数行占掉的像素:竖带、竖线、左侧名字都从这下面开始,不压住读数 */
  headerPx: number;
}

interface Frame {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
}

const crisp = (v: number): number => Math.round(v) + 0.5;

/** 一个绘制层。renderer 对象固定不变:库按引用缓存 */
class View implements IPrimitivePaneView {
  private readonly r: IPrimitivePaneRenderer;

  constructor(
    private readonly z: PrimitivePaneViewZOrder,
    paint: (f: Frame) => void,
  ) {
    this.r = {
      draw: (target: CanvasRenderingTarget2D) =>
        target.useMediaCoordinateSpace(({ context, mediaSize }) => {
          context.save();
          try {
            paint({ ctx: context as CanvasRenderingContext2D, width: mediaSize.width, height: mediaSize.height });
          } finally {
            context.restore();
          }
        }),
    };
  }

  zOrder(): PrimitivePaneViewZOrder {
    return this.z;
  }

  renderer(): IPrimitivePaneRenderer {
    return this.r;
  }
}

/** 轴上标签。全部用 fixedCoordinate:位置由下面的 layoutTags 算好(现价钉住、别人让位),库不再二次推挤 */
class AxisTag implements ISeriesPrimitiveAxisView {
  constructor(
    private readonly at: number,
    private readonly label: string,
    private readonly bg: string,
    private readonly fg: string,
  ) {}

  coordinate(): number {
    return -1e6; // 文档要求:用 fixedCoordinate 的标签给一个很远的负数,免得库给它预留位置
  }

  fixedCoordinate(): number {
    return this.at;
  }

  text(): string {
    return this.label;
  }

  textColor(): string {
    return this.fg;
  }

  backColor(): string {
    return this.bg;
  }

  tickVisible(): boolean {
    return false; // 刻度那一段留给引线
  }
}

interface PlacedTag {
  y: number;
  ly: number;
  text: string;
  bg: string;
  pinned?: boolean;
}

/**
 * 主图叠加层,挂在主图的**载体序列**上——一条看不见、每个时间槽都有值的折线。
 * 库只在「可见区间里有数据」的序列上换算价格坐标、跑 primitives;稀疏的蜡烛(蝶价图)滚到没有 K 线的
 * 地方就会整层消失,所以不挂在蜡烛上。载体是第一个加进图的序列,它的 normal 层画在蜡烛下面。
 *   normal:区域、关键位虚线(在网格之上、蜡烛之下)
 *   top:   折线、标记、竖线、现价点线、左侧名字、轴上标签的引线(在蜡烛之上)
 *   轴上:  关键位与现价的价格标签(避让,现价钉住)
 *
 * 可见范围的上沿是 headerPx 而不是 0:主图顶部按像素给读数行留了位,那一段对应的是比价格区间上限还高的价,
 * 原来的引擎在那里什么都不画。画上去就是一条关键位虚线穿过均线读数行。
 */
export class SpecOverlay implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: (() => void) | null = null;
  private tags: PlacedTag[] = [];
  private axisViews: ISeriesPrimitiveAxisView[] = [];
  private readonly views: IPrimitivePaneView[];

  constructor(private state: OverlayState) {
    this.views = [new View('normal', (f) => this.drawUnder(f)), new View('top', (f) => this.drawOver(f))];
  }

  setState(state: OverlayState): void {
    this.state = state;
    this.updateAllViews();
    this.requestUpdate?.();
  }

  attached({ chart, series, requestUpdate }: SeriesAttachedParameter<Time>): void {
    this.chart = chart as IChartApi;
    this.series = series;
    this.requestUpdate = requestUpdate;
    this.updateAllViews();
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  priceAxisViews(): readonly ISeriesPrimitiveAxisView[] {
    return this.axisViews;
  }

  /** 视口变了:重算轴上标签的位置。关键位与现价的价格标签按 y 排序、重叠的推开,现价钉住不动 */
  updateAllViews(): void {
    const { spec, P, dec, headerPx } = this.state;
    const paneH = this.chart?.panes()[0]?.getHeight() ?? 0;
    const raw: PlacedTag[] = [];
    // 价格在可见区间里才有标签(和原来一样);读数行那一段是比上限还高的价,不算
    const visible = (y: number | null): y is number => y !== null && y >= Math.min(headerPx, paneH / 2) && y <= paneH;
    for (const h of spec.hlines ?? []) {
      if (h.tag === false) continue;
      const y = this.y(h.price);
      if (!visible(y)) continue; // 画面外的价位不画线,也不占轴上的位置
      raw.push({ y, ly: y, text: fmtPrice(h.price, dec), bg: withAlpha(resolveColor(P, h.color), 0.9) });
    }
    const lastY = this.y(spec.last);
    if (spec.last != null && visible(lastY)) raw.push({ y: lastY, ly: lastY, text: fmtPrice(spec.last, dec), bg: P.blue, pinned: true });
    // 轴上标签可以用满整根价格轴:顶部读数行只盖在图区上,不占轴。原来夹在读数行下面,
    // 现价与阻力位挨着最高价时(K线 PA 常见),被推开的那个标签没地方挪,会被钉住的现价标签压住一半
    this.tags = paneH > 0 ? layoutTags(raw, 0, paneH, TAG_H) : [];
    this.axisViews = this.tags.map((t) => new AxisTag(t.ly, t.text, t.bg, '#fff')); // 新数组:库按引用缓存
  }

  // ---- 坐标 ----------------------------------------------------------------
  private y(price: number | null | undefined): number | null {
    if (price == null || !Number.isFinite(price) || !this.series) return null;
    const c = this.series.priceToCoordinate(price);
    return c === null ? null : Number(c);
  }

  /** 下标 → x。库的横轴按下标等距,取两个整数下标的坐标就能线性换算(非整数下标库会返回 0) */
  private xFn(): { x: (i: number) => number; slot: number } | null {
    const ts = this.chart?.timeScale();
    const a = ts?.logicalToCoordinate(0 as Logical);
    const b = ts?.logicalToCoordinate(1 as Logical);
    if (a == null || b == null) return null;
    const x0 = Number(a);
    // 不设下限:数据点多于像素时库铺满后的间距本来就可以小于 1px,夹住就会让叠加层整体错位
    const slot = Math.max(1e-6, Number(b) - x0);
    return { x: (i) => x0 + i * slot, slot };
  }

  private indexOf(time: string | null | undefined): number | undefined {
    return time == null ? undefined : this.state.norm.idx.get(String(time));
  }

  // ---- 下层:区域 + 关键位虚线 -----------------------------------------------
  private drawUnder({ ctx, width, height }: Frame): void {
    const X = this.xFn();
    if (!X) return;
    const { spec, P, norm, headerPx } = this.state;
    const { x, slot } = X;
    const rightEdge = x(norm.lastIdx) + slot / 2; // 区域只画到最后一根,不铺到轴上

    for (const bd of spec.bands ?? []) {
      const color = resolveColor(P, bd.color);
      const fi = this.indexOf(bd.from);
      const ti = this.indexOf(bd.to);
      if (bd.v) {
        const from = fi !== undefined ? x(fi) - slot / 2 : 0;
        const to = ti !== undefined ? x(ti) + slot / 2 : width;
        if (to < 0 || from > width) continue;
        ctx.fillStyle = withAlpha(color, bd.fill ?? 0.06);
        ctx.fillRect(from, headerPx, Math.max(to - from, 1), height - headerPx);
        if (bd.label) {
          ctx.fillStyle = withAlpha(color, 0.8);
          ctx.font = `9px ${P.font}`;
          ctx.textBaseline = 'middle';
          ctx.textAlign = 'left';
          ctx.fillText(bd.label, from + 3, headerPx + 7);
        }
        continue;
      }
      if (bd.top == null || bd.bottom == null) continue;
      const y1 = this.y(bd.top);
      const y2 = this.y(bd.bottom);
      if (y1 === null || y2 === null) continue;
      // 上沿夹到价格区间的上限(y = headerPx),不铺进读数行
      const top = Math.max(headerPx, Math.min(y1, y2));
      const bottom = Math.min(height, Math.max(y1, y2));
      if (bottom <= headerPx || top >= height) continue; // 整块在可见价格区间之外
      // 起点那根滚到了左边外面也照样有坐标(负数);时间对不上号的从最左边画起
      const start = fi !== undefined ? x(fi) - slot / 2 : 0;
      const end = ti !== undefined ? x(ti) + slot / 2 : rightEdge;
      if (end < 0 || start > width) continue;
      ctx.fillStyle = withAlpha(color, bd.fill ?? 0.07);
      ctx.fillRect(start, top, Math.max(end - start, 2), Math.max(bottom - top, 1));
      if (bd.stroke) {
        ctx.setLineDash(bd.dash ?? []);
        ctx.lineWidth = 1;
        ctx.strokeStyle = withAlpha(color, bd.stroke);
        ctx.strokeRect(crisp(start), crisp(top), Math.max(end - start, 2), Math.max(bottom - top, 1));
        ctx.setLineDash([]);
      }
    }

    for (const h of spec.hlines ?? []) {
      const y = this.y(h.price);
      if (y === null || y < headerPx || y > height) continue;
      ctx.setLineDash(h.dash ?? []);
      ctx.lineWidth = h.width ?? 1;
      ctx.strokeStyle = withAlpha(resolveColor(P, h.color), h.alpha ?? 0.5);
      ctx.beginPath();
      ctx.moveTo(0, crisp(y));
      ctx.lineTo(width, crisp(y));
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // ---- 上层:折线、标记、竖线、现价、左侧名字 ---------------------------------
  private drawOver({ ctx, width, height }: Frame): void {
    const X = this.xFn();
    if (!X) return;
    const { spec, P, norm, headerPx } = this.state;
    const { x, slot } = X;
    const n = norm.times.length;
    // 只画看得见的那一段(左右各多带一根,线头接得上)
    const a = Math.max(0, Math.floor(-x(0) / slot) - 1);
    const b = Math.min(n - 1, Math.ceil((width - x(0)) / slot) + 1);
    ctx.textBaseline = 'middle';

    // 折线:遇到空值断开;step 在两根之间的半格处跳变
    for (const ln of norm.lines) {
      ctx.strokeStyle = withAlpha(resolveColor(P, ln.color), ln.alpha ?? 0.9);
      ctx.lineWidth = ln.width || 1;
      ctx.lineJoin = 'round';
      ctx.setLineDash(ln.dash ?? []);
      ctx.beginPath();
      let started = false;
      let prevY = 0;
      for (let i = a; i <= b; i += 1) {
        const v = ln.values[i];
        const py = v == null ? null : this.y(v);
        if (py === null) {
          started = false;
          continue;
        }
        const px = x(i);
        if (!started) {
          ctx.moveTo(px, py);
          started = true;
        } else if (ln.step) {
          ctx.lineTo(px - slot / 2, prevY);
          ctx.lineTo(px - slot / 2, py);
          ctx.lineTo(px, py);
        } else {
          ctx.lineTo(px, py);
        }
        prevY = py;
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.lineWidth = 1;

    // 标记:圆点 / 三角 + 文字(文字之间按矩形避让)
    const placed: Rect[] = [];
    ctx.font = `9px ${P.font}`;
    ctx.textAlign = 'center';
    for (const m of spec.markers ?? []) {
      const i = this.indexOf(m.time);
      const py = this.y(m.price);
      if (i === undefined || py === null || py < headerPx || py > height) continue;
      const px = x(i);
      if (px < -slot || px > width + slot) continue;
      const color = resolveColor(P, m.color);
      ctx.fillStyle = color;
      ctx.beginPath();
      if (m.shape === 'tri-up') {
        ctx.moveTo(px, py - 1);
        ctx.lineTo(px - 4.5, py + 7);
        ctx.lineTo(px + 4.5, py + 7);
        ctx.closePath();
      } else if (m.shape === 'tri-down') {
        ctx.moveTo(px, py + 1);
        ctx.lineTo(px - 4.5, py - 7);
        ctx.lineTo(px + 4.5, py - 7);
        ctx.closePath();
      } else {
        ctx.arc(px, py, 2.5, 0, Math.PI * 2);
      }
      ctx.fill();
      if (m.label) {
        const above = m.labelPos !== 'below';
        const w = ctx.measureText(m.label).width + 4;
        const rect = placeLabel(placed, { x: px - w / 2, y: above ? py - 9 - LABEL_H : py + 5, w, h: LABEL_H }, above ? -1 : 1);
        ctx.fillStyle = withAlpha(m.labelColor ? resolveColor(P, m.labelColor) : color, m.labelAlpha ?? 0.95);
        ctx.fillText(m.label, px, rect.y + LABEL_H / 2);
      }
    }

    // 竖线(开仓 / 平仓):顶部写字,靠右的写在线左边,同一处的字逐行错开
    const vlabels: Array<{ px: number; color: string; text: string; left: boolean }> = [];
    for (const vl of spec.vlines ?? []) {
      const i = this.indexOf(vl.time);
      if (i === undefined) continue;
      const px = crisp(x(i));
      if (px < 0 || px > width) continue;
      const color = resolveColor(P, vl.color);
      ctx.setLineDash(vl.dash ?? [3, 3]);
      ctx.strokeStyle = withAlpha(color, 0.8);
      ctx.beginPath();
      ctx.moveTo(px, headerPx);
      ctx.lineTo(px, height);
      ctx.stroke();
      ctx.setLineDash([]);
      if (vl.label) vlabels.push({ px, color, text: vl.label, left: px > width * 0.6 });
    }
    ctx.font = `10px ${P.font}`;
    const vplaced: Rect[] = [];
    for (const v of vlabels) {
      const w = ctx.measureText(v.text).width + 6;
      const rect = placeLabel(vplaced, { x: v.left ? v.px - 4 - w : v.px + 4, y: headerPx + 2, w, h: 13 }, 1);
      ctx.fillStyle = v.color;
      ctx.textAlign = v.left ? 'right' : 'left';
      ctx.fillText(v.text, v.left ? v.px - 4 : v.px + 4, rect.y + 6.5);
    }

    // 现价:点线(轴上的标签钉住,见 updateAllViews)
    const lastY = this.y(spec.last);
    if (lastY !== null && lastY >= headerPx && lastY <= height) {
      ctx.setLineDash([1, 3]);
      ctx.strokeStyle = P.blue;
      ctx.beginPath();
      ctx.moveTo(0, crisp(lastY));
      ctx.lineTo(width, crisp(lastY));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 图内左侧小标签:区域的名字(FVG↑ / OB)与关键位的名字,统一纵向避让
    const left: Array<{ y: number; x: number; text: string; color: string }> = [];
    for (const bd of spec.bands ?? []) {
      if (bd.v || !bd.label || bd.top == null || bd.bottom == null) continue;
      const yHi = this.y(Math.max(bd.top, bd.bottom));
      const yLo = this.y(Math.min(bd.top, bd.bottom));
      if (yHi === null || yLo === null || yLo <= headerPx || yHi >= height) continue;
      const fi = this.indexOf(bd.from);
      const lx = (fi !== undefined ? x(fi) - slot / 2 : 0) + 3;
      if (lx > width) continue;
      // 上沿超出价格区间时名字贴着区间顶边写(原来的做法:上沿夹到可见区间)
      left.push({ y: Math.max(headerPx, yHi) + 7, x: lx, text: bd.label, color: withAlpha(resolveColor(P, bd.color), 0.8) });
    }
    for (const h of spec.hlines ?? []) {
      if (!h.label) continue;
      const y = this.y(h.price);
      if (y === null || y < headerPx || y > height) continue;
      left.push({ y: y - 6, x: 3, text: h.label, color: withAlpha(resolveColor(P, h.color), 0.85) });
    }
    ctx.font = `9px ${P.font}`;
    ctx.textAlign = 'left';
    for (const t of layoutTags(left, headerPx, height, LABEL_H)) {
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, Math.max(3, t.x), t.ly);
    }

    // 被推开的轴上标签:图区最右边画一条引线,从真实价位斜到标签所在的高度
    ctx.strokeStyle = withAlpha(P.label, 0.35);
    ctx.lineWidth = 1;
    for (const t of this.tags) {
      if (Math.abs(t.ly - t.y) <= 1) continue;
      ctx.beginPath();
      ctx.moveTo(width - LEADER_W, crisp(t.y));
      ctx.lineTo(width, crisp(t.ly));
      ctx.stroke();
    }
  }
}

/** 量能子图右上角的「满格 = X(95 分位)」。 */
export class VolumeCapLabel implements ISeriesPrimitive<Time> {
  private requestUpdate: (() => void) | null = null;
  private readonly views: IPrimitivePaneView[];
  private cap = 0;
  private P: Palette | null = null;

  constructor() {
    this.views = [
      new View('top', ({ ctx, width }) => {
        if (!this.P || !(this.cap > 0)) return;
        ctx.font = `9px ${this.P.font}`;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = this.P.label3;
        ctx.fillText(`满格 = ${fmtVol(this.cap)}(95 分位)`, width - 4, 7);
      }),
    ];
  }

  set(cap: number, P: Palette): void {
    this.cap = cap;
    this.P = P;
    this.requestUpdate?.();
  }

  attached({ requestUpdate }: SeriesAttachedParameter<Time>): void {
    this.requestUpdate = requestUpdate;
  }

  detached(): void {
    this.requestUpdate = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }
}
