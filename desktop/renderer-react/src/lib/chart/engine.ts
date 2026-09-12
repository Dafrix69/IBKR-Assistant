// 图表引擎:框架交给 TradingView 的 lightweight-charts——价格轴与刻度、时间轴、网格、蜡烛、量能子图、
// 十字光标、拖动平移 / 滚轮与双指缩放 / 拖轴缩放 / 双击轴复位、高分屏与尺寸自适应;
// 业务叠加层(折线、区域、关键位、标记、竖线、现价、轴上标签避让)在 overlays.ts 里用它的 primitives 画。
//
// 与原来 canvas 引擎保持一致的几条(docs/features/priceaction.md):
//   · 价格区间不用库的默认算法:按「可见区间内的蜡烛 + 折线 + fit 的水平线 / 标记 / 区域 + 现价」取上下限、
//     各留 5%(padPct)、yMin 夹底——蝶价图不会出现负数刻度,不撑开区间的关键位也不会把 K 线压扁;
//   · 量能按 95 分位归一化,开盘第一根巨量不把其余柱子压成一条线;
//   · 顶部两行读数(均线 / 图例 / 十字光标读数)是 DOM,主图顶部按像素给它们留位,不压住蜡烛;
//   · 横轴按时间串的墙钟显示(当 UTC 喂给库,库按 UTC 显示),不做时区换算。
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  TickMarkType,
  createChart,
  type AutoscaleInfo,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type LineWidth,
  type Time,
  type UTCTimestamp,
  type WhitespaceData,
} from 'lightweight-charts';
import { SpecOverlay, VolumeCapLabel } from './overlays';
import { readPalette, resolveColor, withAlpha, type Palette } from './palette';
import {
  decimalsFor,
  fmtPrice,
  fmtVol,
  niceStep,
  normalize,
  timeLabel,
  type ChartHelpers,
  type ChartSpec,
  type Normalized,
  type Parts,
} from './spec';

const HEADER_ROW = 17; // 顶部读数一行的高度
const VOL_H = 56; // 量能子图
const AXIS_W = 64; // 右侧价格轴最小宽度
const TIME_AXIS_H = 22; // 库的时间轴高度(11px 字)

export interface ChartHandle {
  update(spec: ChartSpec): void;
  destroy(): void;
}

export interface MountOptions {
  /** 滚轮缩放 / 平移。嵌在长页面里的小图关掉,不然鼠标经过图表时页面就滚不动了 */
  wheel?: boolean;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 视口身份:同一个标的 / 周期刷新时保留用户缩放到的位置,换了就重新铺满 */
function viewKeyOf(spec: ChartSpec, norm: Normalized): string {
  return spec.viewKey ?? `${spec.ariaLabel ?? ''}|${norm.times[0] ?? ''}`;
}

export function mountChart(container: HTMLElement, initial: ChartSpec, opts: MountOptions = {}): ChartHandle {
  let spec = initial;
  let norm = normalize(spec);
  let P: Palette = readPalette();
  let dec = 2;
  let stampIdx = new Map<number, number>();
  let hoverIdx: number | null = null;

  let chart: IChartApi | null = null;
  let carrier: ISeriesApi<'Line'> | null = null;
  let candles: ISeriesApi<'Candlestick'> | null = null;
  let volume: ISeriesApi<'Histogram'> | null = null;
  let volumeCap = 0;

  const legend = document.createElement('div');
  legend.className = 'chart-legend';
  const notice = document.createElement('p');
  notice.className = 'chart-empty';
  container.classList.add('chart-host');
  container.setAttribute('role', 'img');

  const headerPx = (): number => 8 + ((spec.header ? 1 : 0) + 1) * HEADER_ROW;
  const hasVolume = (): boolean =>
    spec.volume !== false && norm.barAt.some((b) => b !== null && (b.volume ?? 0) > 0);

  const helpers = (): ChartHelpers => ({
    fmt: (v) => fmtPrice(v, dec),
    fmtVol,
    P,
    col: (c) => resolveColor(P, c),
    timeLabel,
  });

  // ---- 价格区间 ------------------------------------------------------------
  function priceRange(a: number, b: number): [number, number] | null {
    let lo = Infinity;
    let hi = -Infinity;
    const take = (v: number | null | undefined): void => {
      if (v != null && Number.isFinite(v)) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    };
    for (let i = a; i <= b; i += 1) {
      const bar = norm.barAt[i];
      if (bar) {
        take(bar.low);
        take(bar.high);
      }
      for (const ln of norm.lines) take(ln.values[i]);
    }
    for (const h of spec.hlines ?? []) if (h.fit !== false) take(h.price);
    for (const m of spec.markers ?? []) {
      const i = norm.idx.get(String(m.time));
      if (m.fit !== false && i !== undefined && i >= a && i <= b) take(m.price);
    }
    for (const bd of spec.bands ?? []) {
      if (bd.fit) {
        take(bd.top);
        take(bd.bottom);
      }
    }
    take(spec.last);
    if (!Number.isFinite(lo)) return null;
    const pad = (hi - lo) * (spec.padPct ?? 0.05) || Math.abs(hi) * 0.001 || 1;
    lo -= pad;
    hi += pad;
    if (spec.yMin != null) lo = Math.max(spec.yMin, lo);
    return [lo, hi];
  }

  /** 载体序列的 autoscale:按当前可见的下标区间算;其余序列一律不参与 */
  const autoscale = (): AutoscaleInfo | null => {
    const n = norm.times.length;
    const r = chart?.timeScale().getVisibleLogicalRange();
    const a = r ? Math.max(0, Math.floor(r.from)) : 0;
    const b = r ? Math.min(n - 1, Math.ceil(r.to)) : n - 1;
    const range = priceRange(Math.min(a, b), Math.max(a, b)) ?? priceRange(0, n - 1);
    return range ? { priceRange: { minValue: range[0], maxValue: range[1] } } : null;
  };
  const noAutoscale = (): AutoscaleInfo | null => null;

  // ---- 时间轴 --------------------------------------------------------------
  const tickMark = (time: Time, type: TickMarkType): string => {
    const s = Number(time);
    if (!norm.realTime) {
      const i = stampIdx.get(s);
      return i === undefined ? '' : timeLabel(norm.times[i]);
    }
    const d = new Date(s * 1000);
    const Y = d.getUTCFullYear();
    const M = pad2(d.getUTCMonth() + 1);
    const D = pad2(d.getUTCDate());
    switch (type) {
      case TickMarkType.Year:
        return String(Y);
      case TickMarkType.Month:
        return `${d.getUTCMonth() + 1}月`; // 年份只在跨年那一格写;每个月头都写 2026-04 太吵
      case TickMarkType.DayOfMonth:
        return `${M}-${D}`;
      case TickMarkType.TimeWithSeconds:
        return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
      default:
        return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
    }
  };
  const crosshairTime = (time: Time): string => {
    const i = stampIdx.get(Number(time));
    return i === undefined ? '' : timeLabel(norm.times[i], true);
  };

  // ---- 顶部读数(DOM)-------------------------------------------------------
  function writeRow(row: HTMLElement, parts: Parts): void {
    for (const [text, color] of parts) {
      if (!text) continue;
      const span = document.createElement('span');
      span.textContent = text;
      span.style.color = color;
      row.appendChild(span);
    }
  }

  function defaultReadout(i: number): Parts {
    const b = norm.barAt[i];
    if (b) {
      let prev = null;
      for (let k = i - 1; k >= 0; k -= 1) {
        if (norm.barAt[k]) {
          prev = norm.barAt[k];
          break;
        }
      }
      const chg = prev ? ((b.close - prev.close) / prev.close) * 100 : null;
      return [
        [timeLabel(norm.times[i], true), P.label2],
        [`开 ${fmtPrice(b.open, dec)}`, P.label],
        [`高 ${fmtPrice(b.high, dec)}`, P.label],
        [`低 ${fmtPrice(b.low, dec)}`, P.label],
        [`收 ${fmtPrice(b.close, dec)}`, b.close >= b.open ? P.up : P.down],
        b.volume != null ? [`量 ${fmtVol(b.volume)}`, P.label2] : ['', ''],
        [chg == null ? '' : `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`, chg == null ? P.label2 : chg >= 0 ? P.up : P.down],
      ];
    }
    const parts: Parts = [[timeLabel(norm.times[i], true), P.label2]];
    for (const ln of norm.lines) {
      const v = ln.values[i];
      if (v != null && ln.label) parts.push([`${ln.label} ${fmtPrice(v, dec)}`, resolveColor(P, ln.color)]);
    }
    return parts;
  }

  function renderLegend(): void {
    legend.replaceChildren();
    if (!chart) return;
    const refIdx = hoverIdx ?? norm.lastIdx;
    if (spec.header) {
      const row = document.createElement('div');
      row.className = 'chart-legend-row';
      writeRow(row, spec.header(refIdx, helpers()) ?? []);
      legend.appendChild(row);
    }
    const row = document.createElement('div');
    row.className = 'chart-legend-row';
    if (hoverIdx !== null) {
      writeRow(row, (spec.readout ? spec.readout(hoverIdx, helpers()) : defaultReadout(hoverIdx)) ?? []);
    } else {
      for (const [glyph, color, text] of spec.legend ?? []) {
        const item = document.createElement('span');
        const g = document.createElement('i');
        g.textContent = glyph;
        g.style.color = resolveColor(P, color);
        item.append(g, document.createTextNode(text));
        row.appendChild(item);
      }
    }
    legend.appendChild(row);
  }

  // ---- 图表本体 ------------------------------------------------------------
  /** 视口复位:铺满全部数据、价格轴恢复自动。双击时间轴、换了标的都走这里 */
  function resetView(c: IChartApi): void {
    // 拖过价格轴,库会把自动缩放关掉且不会自己打开:换成价位差很远的标的,新图会整个落在画面外
    c.priceScale('right', 0).setAutoScale(true);
    c.timeScale().fitContent();
  }

  function chartOptions() {
    const wheel = Boolean(opts.wheel);
    const grid = withAlpha(P.label, 0.08);
    const cross = { color: withAlpha(P.label, 0.45), style: LineStyle.Dashed, width: 1 as LineWidth, labelBackgroundColor: P.label };
    return {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' }, // 圆角底色由容器的 CSS 铺
        textColor: P.label2,
        fontSize: 11,
        fontFamily: P.font,
        // 默认的 TradingView 角标会往页面注入 <style>(被本应用的 CSP 拦掉,控制台报错)。
        // 署名与链接放在「关于」页,满足 Apache-2.0 + NOTICE 的要求
        attributionLogo: false,
        panes: { separatorColor: P.separator, separatorHoverColor: 'transparent', enableResize: false },
      },
      localization: {
        locale: 'zh-CN',
        priceFormatter: (p: number) => fmtPrice(p, dec),
        timeFormatter: crosshairTime,
      },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      // Normal:竖线吸附到 K 线,横线跟着鼠标走(默认的 Magnet 会把横线吸到收盘价上)
      crosshair: { mode: CrosshairMode.Normal, vertLine: cross, horzLine: cross },
      hoveredSeriesOnTop: false, // 叠放顺序固定:区域在蜡烛下,折线与标记在蜡烛上
      rightPriceScale: { borderColor: P.separator, minimumWidth: AXIS_W, entireTextOnly: true },
      // rightOffset 不写在这里:每次换色 / 刷新都会重新 applyOptions,写了就会把平移到中间的视图拽回最右边
      timeScale: {
        borderColor: P.separator,
        timeVisible: norm.intraday,
        secondsVisible: false,
        fixLeftEdge: true,
        fixRightEdge: true,
        lockVisibleTimeRangeOnResize: true,
        tickMarkFormatter: tickMark,
      },
      handleScroll: { mouseWheel: wheel, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      // 时间轴的双击复位自己接:库的复位是回到默认 6px 一根,不是打开时铺满的样子
      handleScale: { mouseWheel: wheel, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: { time: false, price: true } },
    };
  }

  const overlay = new SpecOverlay({ spec, norm, P, dec, headerPx: headerPx() });
  const volLabel = new VolumeCapLabel();

  function createTheChart(): IChartApi {
    const opts = chartOptions();
    const c = createChart(container, { ...opts, timeScale: { ...opts.timeScale, rightOffset: 0 } });
    // 预览台专用:tools/chart_interaction_check.js 读视口与价格轴状态。生产构建里 MODE 是常量,这一行会被整个删掉
    if (import.meta.env.MODE === 'preview') (container as HTMLElement & { __chart?: IChartApi }).__chart = c;
    c.chartElement().addEventListener('dblclick', (e) => {
      const rect = c.chartElement().getBoundingClientRect();
      if (e.clientY >= rect.bottom - c.timeScale().height()) resetView(c);
    });
    // 载体:第一个加进图的序列,看不见,每个时间槽都有值。叠加层与价格区间都挂在它身上(原因见 overlays.ts)
    carrier = c.addSeries(
      LineSeries,
      {
        lineVisible: false,
        pointMarkersVisible: false,
        crosshairMarkerVisible: false,
        lastValueVisible: false,
        priceLineVisible: false,
        autoscaleInfoProvider: autoscale,
      },
      0,
    );
    carrier.attachPrimitive(overlay);
    container.appendChild(legend); // 叠在画布之上(CSS 里 pointer-events: none)
    c.subscribeCrosshairMove((param) => {
      const n = norm.times.length;
      const next = param.point && param.logical != null ? Math.min(n - 1, Math.max(0, Math.round(param.logical))) : null;
      if (next !== hoverIdx) {
        hoverIdx = next;
        renderLegend();
      }
    });
    return c;
  }

  function teardownChart(): void {
    chart?.remove();
    chart = null;
    carrier = null;
    candles = null;
    volume = null;
    hoverIdx = null;
    legend.remove();
  }

  function syncSeries(c: IChartApi, mid: number): void {
    const { times, stamps, barAt } = norm;
    const t = (i: number) => stamps[i] as UTCTimestamp;

    carrier?.setData(times.map((_, i): LineData<Time> => ({ time: t(i), value: mid })));
    // 价格轴的刻度步长以载体为准(它是主图第一个序列)。默认 minMove 0.01 会把步长卡在 0.01:
    // 净值在 0.998–1.004 之间晃的回测图,轴上就只剩一个 1.000
    carrier?.applyOptions({ priceFormat: { type: 'price', precision: dec, minMove: Math.pow(10, -dec) } });

    // 蜡烛:没有蜡烛的时刻给空白点({time},不带 open 键),x 轴就严格等于 spec.times
    if (barAt.some(Boolean)) {
      if (!candles) candles = c.addSeries(CandlestickSeries, {}, 0);
      candles.applyOptions({
        upColor: P.up,
        downColor: P.down,
        wickUpColor: P.up,
        wickDownColor: P.down,
        borderUpColor: P.up,
        borderDownColor: P.down,
        borderVisible: false,
        priceLineVisible: false,
        lastValueVisible: false,
        autoscaleInfoProvider: noAutoscale,
      });
      candles.setData(
        times.map((_, i): CandlestickData<Time> | WhitespaceData<Time> => {
          const b = barAt[i];
          return b ? { time: t(i), open: b.open, high: b.high, low: b.low, close: b.close } : { time: t(i) };
        }),
      );
    } else if (candles) {
      c.removeSeries(candles);
      candles = null;
    }

    // 量能子图:95 分位封顶,满格值写在子图右上角
    if (hasVolume()) {
      const vols = barAt.map((b) => (b && b.volume) || 0).filter((v) => v > 0).sort((a, b) => a - b);
      volumeCap = vols[Math.min(vols.length - 1, Math.floor(0.95 * (vols.length - 1)))] || vols[vols.length - 1];
      if (!volume) {
        // 挂在子图自己的叠加刻度上,不挂右侧价格轴:成交量刻度(如 "1500000.00")虽然不显示,
        // 仍会参与轴宽测量,把主图的价格轴也撑宽
        volume = c.addSeries(HistogramSeries, { priceScaleId: 'vol' }, 1);
        volume.attachPrimitive(volLabel);
        volume.priceScale().applyOptions({ scaleMargins: { top: 0, bottom: 0 } });
      }
      volume.applyOptions({
        priceLineVisible: false,
        lastValueVisible: false,
        base: 0,
        autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: volumeCap } }),
      });
      const upV = withAlpha(P.up, 0.5);
      const downV = withAlpha(P.down, 0.5);
      volume.setData(
        times.map((_, i): HistogramData<Time> | WhitespaceData<Time> => {
          const b = barAt[i];
          const v = b ? b.volume || 0 : 0;
          return b && v > 0 ? { time: t(i), value: v, color: b.close >= b.open ? upV : downV } : { time: t(i) };
        }),
      );
      volLabel.set(volumeCap, P);
    } else if (volume) {
      volume.detachPrimitive(volLabel);
      c.removeSeries(volume);
      volume = null;
    }
  }

  /** 尺寸相关:顶部读数留位、量能子图高度、窗口太窄时的提示 */
  function layout(c: IChartApi): void {
    const H = container.clientHeight;
    const W = container.clientWidth;
    const panes = c.panes();
    const priceH = Math.max(1, H - TIME_AXIS_H - (panes.length > 1 ? VOL_H : 0));
    if (panes.length > 1) {
      // 按像素折成比例:setHeight 在第一次布局前按零高度换算,不可靠
      panes[0].setStretchFactor(priceH);
      panes[1].setStretchFactor(VOL_H);
    }
    // 顶部按像素给读数行留位;下沿的 5% 已经算在价格区间里了
    c.priceScale('right', 0).applyOptions({ scaleMargins: { top: Math.min(0.5, headerPx() / priceH), bottom: 0 } });
    const tooNarrow = W - AXIS_W < 60 || priceH - headerPx() < 50;
    const el = c.chartElement();
    el.style.visibility = tooNarrow ? 'hidden' : '';
    legend.style.visibility = tooNarrow ? 'hidden' : '';
    if (tooNarrow) {
      notice.textContent = '窗口太窄';
      if (!notice.isConnected) container.appendChild(notice);
    } else {
      notice.remove();
    }
  }

  function render(): void {
    P = readPalette();
    const n = norm.times.length;
    const full = n >= 2 ? priceRange(0, n - 1) : null;
    const hasData = norm.barAt.some(Boolean) || norm.lines.some((l) => l.values.some((v) => v != null));
    if (n < 2 || !hasData || !full) {
      teardownChart();
      notice.textContent = '数据不足,无法成图';
      if (!notice.isConnected) container.appendChild(notice);
      return;
    }
    notice.remove();
    stampIdx = new Map(norm.stamps.map((s, i) => [s, i] as const));
    const paneGuess = Math.max(60, (container.clientHeight || 300) - TIME_AXIS_H - (hasVolume() ? VOL_H : 0) - headerPx());
    dec = spec.decimals ?? decimalsFor(niceStep(full[1] - full[0], Math.max(3, Math.floor(paneGuess / 46))));
    container.setAttribute('aria-label', spec.ariaLabel ?? '图表');

    const fresh = !chart;
    if (!chart) chart = createTheChart();
    else chart.applyOptions(chartOptions());
    syncSeries(chart, (full[0] + full[1]) / 2);
    overlay.setState({ spec, norm, P, dec, headerPx: headerPx() });
    layout(chart);
    if (fresh) chart.timeScale().fitContent();
    if (hoverIdx !== null && hoverIdx >= n) hoverIdx = null;
    renderLegend();
  }

  // ---- 尺寸、主题 ----------------------------------------------------------
  const ro = new ResizeObserver(() => {
    if (chart) layout(chart);
  });
  ro.observe(container);

  // 深浅色 / 涨跌配色变化时重新取色(库不认 CSS 变量,颜色要解析成字面量再交给它)
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onTheme = (): void => {
    if (!container.isConnected) return;
    // 换色只换颜色:缩放 / 平移到的位置原样放回去
    const range = chart?.timeScale().getVisibleLogicalRange() ?? null;
    render();
    if (chart && range) chart.timeScale().setVisibleLogicalRange(range);
  };
  mq.addEventListener('change', onTheme);
  const mo = new MutationObserver(onTheme);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-updown', 'data-vibrancy', 'data-theme'] });

  render();

  return {
    update(nextSpec: ChartSpec): void {
      if (nextSpec === spec) return;
      const prevNorm = norm;
      const prevKey = viewKeyOf(spec, prevNorm);
      const prevRange = chart?.timeScale().getVisibleLogicalRange() ?? null;
      const hadChart = Boolean(chart);
      spec = nextSpec;
      norm = normalize(spec);
      render();
      if (!chart) return;
      if (!hadChart) return; // 刚从「数据不足」变成有图:render 里已经铺满

      // 视口:同一个标的 / 周期的刷新保留用户缩放到的位置;没缩放过或者换了东西,重新铺满
      const pn = prevNorm.times.length;
      const n = norm.times.length;
      const zoomed = prevRange !== null && pn > 1 && (prevRange.from > 0.5 || prevRange.to < pn - 1.5);
      if (!zoomed || viewKeyOf(spec, norm) !== prevKey) {
        resetView(chart);
        return;
      }
      const width = prevRange.to - prevRange.from;
      if (prevRange.to >= pn - 1.5) {
        // 贴着最右边看的:新 K 线进来继续贴着最右边
        const to = n - 1 + (prevRange.to - (pn - 1));
        chart.timeScale().setVisibleLogicalRange({ from: to - width, to });
        return;
      }
      // 停在中间看的:按左沿那根的时间找回位置(滚动窗口前面掉了几根也对得上)
      const fromTime = prevNorm.times[Math.max(0, Math.min(pn - 1, Math.round(prevRange.from)))];
      const at = norm.idx.get(fromTime);
      if (at === undefined) {
        resetView(chart);
        return;
      }
      const shift = at - Math.round(prevRange.from);
      chart.timeScale().setVisibleLogicalRange({ from: prevRange.from + shift, to: prevRange.to + shift });
    },
    destroy(): void {
      ro.disconnect();
      mo.disconnect();
      mq.removeEventListener('change', onTheme);
      teardownChart();
      notice.remove();
      container.classList.remove('chart-host');
    },
  };
}
