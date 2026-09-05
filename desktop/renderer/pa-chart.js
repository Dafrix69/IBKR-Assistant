// K 线图(canvas)。图上出现的每一条线都对应引擎算出的一个字段,这里不新算任何东西:
// 蜡烛/量能 = r.bars,均线 = r.ma,关键位 = r.levels,缺口 = r.fvgs,订单块 = r.order_block,
// 摆动点 = r.swings,现价 = r.last。十字光标的读数只是把 r.bars 里那一根的字段念出来。
//
// 为什么重写:原来是一张按 660×300 画好的 SVG 再被拉伸到整页宽——字号、线宽都跟着容器变,
// 1900px 宽时 9px 的字变成 26px,而且没有坐标轴,关键位标签直接按 y 放会叠成一团。
// 这里按真实像素画(ResizeObserver 量容器,devicePixelRatio 缩放),字号 11px、线宽 1px 固定,
// 有价格轴、时间轴、淡网格,轴上的价格标签做碰撞避让——这些是富途/moomoo 那类图表的工程底线。
//
// 依赖:无。颜色全部从 CSS token 读(--up/--down/--blue/--orange/--purple/--label*),跟随深浅色与「涨跌配色」。
'use strict';

(function () {
  const PAD_TOP = 38;          // 顶部两行文字:均线读数 + 图例/十字光标读数
  const AXIS_W = 64;           // 右侧价格轴
  const AXIS_H = 20;           // 底部时间轴
  const VOL_H = 54;            // 量能子图
  const GAP = 10;              // 价格区与量能区之间
  const PAD_L = 8;
  const FONT_SIZE = 11;
  const TAG_H = 16;            // 轴上价格标签高度,也是碰撞避让的最小间距
  const MA_STYLE = { 5: 'orange', 10: 'blue', 20: 'purple' };

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }
  function palette() {
    return {
      up: cssVar('--up', '#28cd41'),
      down: cssVar('--down', '#ff3b30'),
      blue: cssVar('--blue', '#007aff'),
      orange: cssVar('--orange', '#ff9500'),
      purple: cssVar('--purple', '#af52de'),
      label: cssVar('--label', '#000'),
      label2: cssVar('--label-secondary', 'rgba(60,60,67,0.6)'),
      label3: cssVar('--label-tertiary', 'rgba(60,60,67,0.3)'),
      separator: cssVar('--separator', 'rgba(60,60,67,0.18)'),
      surface: cssVar('--bg-elevated', '#fff'),
      font: getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif',
      mono: cssVar('--font-mono', 'ui-monospace, monospace'),
    };
  }

  /** 把颜色叠上透明度:支持 #rgb/#rrggbb 与 rgb()/rgba()。 */
  function alpha(color, a) {
    const c = color.trim();
    if (c.startsWith('#')) {
      const hex = c.length === 4 ? c.slice(1).split('').map((ch) => ch + ch).join('') : c.slice(1, 7);
      const n = parseInt(hex, 16);
      return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
    }
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (m) {
      const parts = m[1].split(',').map((s) => s.trim());
      return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${a})`;
    }
    return c;
  }

  /** "好看的"刻度步长:1 / 2 / 2.5 / 5 × 10^k,目标约 target 个刻度。 */
  function niceStep(span, target) {
    const raw = span / Math.max(1, target);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const m of [1, 2, 2.5, 5, 10]) {
      if (raw <= m * mag) return m * mag;
    }
    return 10 * mag;
  }
  function decimalsFor(step) {
    if (step >= 1) return 2;
    return Math.min(4, Math.max(2, -Math.floor(Math.log10(step))));
  }
  function fmtPrice(p, dec) {
    return Number(p).toFixed(dec);
  }
  function fmtVol(v) {
    if (v == null) return '—';
    if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
    if (v >= 1e4) return (v / 1e4).toFixed(1) + '万';
    return String(Math.round(v));
  }
  /** 'YYYY-MM-DD HH:MM' → 时间轴标签;跨日或日线时带日期 */
  function timeLabel(t, withDate) {
    const s = String(t || '');
    const hm = s.length >= 16 ? s.slice(11, 16) : '';
    const md = s.length >= 10 ? s.slice(5, 10) : s;
    if (!hm) return md;
    return withDate ? `${md} ${hm}` : hm;
  }
  function dateOf(t) {
    return String(t || '').slice(0, 10);
  }
  function crisp(v) {
    return Math.round(v) + 0.5;
  }

  /** 轴上标签的碰撞避让:按 y 排序,重叠的向两边推开,再夹回绘图区。pinned 的不动(现价)。 */
  function layoutTags(tags, minY, maxY) {
    const sorted = tags.slice().sort((a, b) => a.y - b.y);
    for (const t of sorted) t.ly = Math.min(maxY - TAG_H / 2, Math.max(minY + TAG_H / 2, t.y));
    for (let pass = 0; pass < 6; pass += 1) {
      let moved = false;
      for (let i = 1; i < sorted.length; i += 1) {
        const a = sorted[i - 1];
        const b = sorted[i];
        const overlap = a.ly + TAG_H - b.ly;
        if (overlap > 0) {
          moved = true;
          if (a.pinned && !b.pinned) b.ly += overlap;
          else if (b.pinned && !a.pinned) a.ly -= overlap;
          else { a.ly -= overlap / 2; b.ly += overlap / 2; }
        }
      }
      for (const t of sorted) {
        if (!t.pinned) t.ly = Math.min(maxY - TAG_H / 2, Math.max(minY + TAG_H / 2, t.ly));
      }
      if (!moved) break;
    }
    return sorted;
  }

  function mount(container, result) {
    const canvas = document.createElement('canvas');
    canvas.className = 'pa-canvas';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `${result.symbol || ''} ${result.timeframe_label || ''} K 线图`);
    container.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    const state = { r: result, hover: null, width: 0, height: 0 };

    function geometry() {
      const W = state.width;
      const H = state.height;
      const x0 = PAD_L;
      const x1 = W - AXIS_W;
      const priceTop = PAD_TOP;
      const priceBottom = H - AXIS_H - VOL_H - GAP;
      const volTop = priceBottom + GAP;
      const volBottom = H - AXIS_H;
      return { W, H, x0, x1, priceTop, priceBottom, volTop, volBottom };
    }

    function draw() {
      const r = state.r;
      const bars = r.bars || [];
      const g = geometry();
      const P = palette();
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(g.W * dpr) || canvas.height !== Math.round(g.H * dpr)) {
        canvas.width = Math.round(g.W * dpr);
        canvas.height = Math.round(g.H * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, g.W, g.H);
      ctx.font = `${FONT_SIZE}px ${P.font}`;
      ctx.textBaseline = 'middle';

      if (bars.length < 2 || g.x1 - g.x0 < 60 || g.priceBottom - g.priceTop < 60) {
        ctx.fillStyle = P.label3;
        ctx.textAlign = 'center';
        ctx.fillText(bars.length < 2 ? 'K 线不足,无法成图' : '窗口太窄', g.W / 2, g.H / 2);
        return;
      }

      // ---- 坐标 ----
      const n = bars.length;
      const slot = (g.x1 - g.x0) / n;
      const x = (i) => g.x0 + slot * (i + 0.5);
      const idxOf = new Map(bars.map((b, i) => [b.time, i]));
      let lo = Infinity;
      let hi = -Infinity;
      for (const b of bars) { lo = Math.min(lo, b.low); hi = Math.max(hi, b.high); }
      for (const series of Object.values(r.ma || {})) {
        for (const v of series) if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      }
      const pad = (hi - lo) * 0.05 || Math.abs(hi) * 0.001 || 1;
      lo -= pad;
      hi += pad;
      const span = hi - lo;
      const y = (p) => g.priceBottom - ((p - lo) / span) * (g.priceBottom - g.priceTop);
      const visible = (p) => p != null && p >= lo && p <= hi;
      const step = niceStep(span, Math.max(4, Math.floor((g.priceBottom - g.priceTop) / 46)));
      const dec = decimalsFor(step);
      const rightEdge = x(n - 1) + slot / 2;   // 区域只画到最后一根 K 线,不铺到轴上

      // ---- 网格 + 价格轴 ----
      ctx.lineWidth = 1;
      ctx.strokeStyle = alpha(P.label, 0.07);
      ctx.fillStyle = P.label2;
      ctx.textAlign = 'left';
      const first = Math.ceil(lo / step) * step;
      for (let p = first; p <= hi; p += step) {
        const yy = crisp(y(p));
        ctx.beginPath(); ctx.moveTo(g.x0, yy); ctx.lineTo(g.x1, yy); ctx.stroke();
        ctx.fillText(fmtPrice(p, dec), g.x1 + 6, yy);
      }
      // 轴线
      ctx.strokeStyle = P.separator;
      ctx.beginPath(); ctx.moveTo(crisp(g.x1), g.priceTop - 6); ctx.lineTo(crisp(g.x1), g.volBottom); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(g.x0, crisp(g.volBottom)); ctx.lineTo(g.x1, crisp(g.volBottom)); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(g.x0, crisp(g.priceBottom)); ctx.lineTo(g.x1, crisp(g.priceBottom)); ctx.stroke();

      // ---- 时间轴 ----
      const every = Math.max(1, Math.ceil(72 / slot));
      ctx.textAlign = 'center';
      ctx.fillStyle = P.label2;
      let lastDate = null;
      for (let i = 0; i < n; i += every) {
        const withDate = lastDate !== null && dateOf(bars[i].time) !== lastDate;
        if (lastDate === null) lastDate = dateOf(bars[i].time);
        if (withDate) lastDate = dateOf(bars[i].time);
        const xx = x(i);
        ctx.strokeStyle = alpha(P.label, 0.07);
        ctx.beginPath(); ctx.moveTo(crisp(xx), g.priceTop); ctx.lineTo(crisp(xx), g.volBottom); ctx.stroke();
        ctx.fillText(timeLabel(bars[i].time, withDate || i === 0 && n > 0 && every * 3 >= n), xx, g.volBottom + AXIS_H / 2 + 1);
      }

      // ---- 区域(最底层):FVG / 订单块,退到背景里 ----
      for (const gap of r.fvgs || []) {
        if (!visible(gap.top) && !visible(gap.bottom)) continue;
        const start = idxOf.has(gap.time) ? x(idxOf.get(gap.time)) - slot / 2 : g.x0;
        const top = y(Math.min(gap.top, hi));
        const bottom = y(Math.max(gap.bottom, lo));
        const color = gap.side === 'bull' ? P.up : P.down;
        ctx.fillStyle = alpha(color, 0.07);
        ctx.fillRect(start, top, Math.max(rightEdge - start, 2), Math.max(bottom - top, 1));
        ctx.strokeStyle = alpha(color, 0.22);
        ctx.strokeRect(crisp(start), crisp(top), Math.max(rightEdge - start, 2), Math.max(bottom - top, 1));
        ctx.fillStyle = alpha(color, 0.75);
        ctx.font = `9px ${P.font}`;
        ctx.textAlign = 'left';
        ctx.fillText(gap.side === 'bull' ? 'FVG↑' : 'FVG↓', start + 3, top + 7);
        ctx.font = `${FONT_SIZE}px ${P.font}`;
      }
      const ob = r.order_block;
      if (ob && (visible(ob.top) || visible(ob.bottom))) {
        const start = idxOf.has(ob.time) ? x(idxOf.get(ob.time)) - slot / 2 : g.x0;
        const top = y(Math.min(ob.top, hi));
        const bottom = y(Math.max(ob.bottom, lo));
        ctx.fillStyle = alpha(P.label, 0.06);
        ctx.fillRect(start, top, Math.max(rightEdge - start, 2), Math.max(bottom - top, 1));
        ctx.setLineDash([2, 2]);
        ctx.strokeStyle = alpha(P.label, 0.28);
        ctx.strokeRect(crisp(start), crisp(top), Math.max(rightEdge - start, 2), Math.max(bottom - top, 1));
        ctx.setLineDash([]);
        ctx.fillStyle = alpha(P.label, 0.6);
        ctx.font = `9px ${P.font}`;
        ctx.textAlign = 'left';
        ctx.fillText('OB', start + 3, top + 7);
        ctx.font = `${FONT_SIZE}px ${P.font}`;
      }

      // ---- 关键位:细虚线,标签放轴上(稍后统一避让) ----
      const tags = [];
      for (const level of r.levels || []) {
        if (!visible(level.price)) continue;
        const color = level.side === 'resistance' ? P.down : P.up;
        const yy = crisp(y(level.price));
        ctx.setLineDash([2, 2]);
        ctx.strokeStyle = alpha(color, 0.45);
        ctx.beginPath(); ctx.moveTo(g.x0, yy); ctx.lineTo(g.x1, yy); ctx.stroke();
        ctx.setLineDash([]);
        tags.push({ y: y(level.price), text: fmtPrice(level.price, dec), bg: alpha(color, 0.85), fg: '#fff' });
      }

      // ---- 量能:95 分位归一化,开盘第一根巨量不再把其余压成一条线 ----
      const vols = bars.map((b) => b.volume || 0).filter((v) => v > 0).sort((a, b) => a - b);
      if (vols.length) {
        const cap = vols[Math.min(vols.length - 1, Math.floor(0.95 * (vols.length - 1)))] || vols[vols.length - 1];
        const volH = g.volBottom - g.volTop;
        const bodyW = Math.max(1, Math.floor(slot * 0.6));
        for (let i = 0; i < n; i += 1) {
          const b = bars[i];
          const v = b.volume || 0;
          if (v <= 0) continue;
          const h = Math.max(1, Math.min(volH, (v / cap) * volH));
          ctx.fillStyle = alpha(b.close >= b.open ? P.up : P.down, 0.6);
          ctx.fillRect(Math.round(x(i) - bodyW / 2), g.volBottom - h, bodyW, h);
        }
        // 量能刻度说明放右上角、贴着轴,不压在柱子上
        ctx.fillStyle = P.label3;
        ctx.textAlign = 'right';
        ctx.font = `9px ${P.font}`;
        ctx.fillText(`满格 = ${fmtVol(cap)}(95 分位)`, g.x1 - 4, g.volTop + 6);
        ctx.font = `${FONT_SIZE}px ${P.font}`;
      }

      // ---- 蜡烛 ----
      const bodyW = Math.max(1, Math.floor(slot * 0.62));
      for (let i = 0; i < n; i += 1) {
        const b = bars[i];
        const up = b.close >= b.open;
        const color = up ? P.up : P.down;
        const cx = crisp(x(i));
        ctx.strokeStyle = color;
        ctx.beginPath(); ctx.moveTo(cx, y(b.high)); ctx.lineTo(cx, y(b.low)); ctx.stroke();
        const top = y(Math.max(b.open, b.close));
        const h = Math.max(1, Math.abs(y(b.close) - y(b.open)));
        ctx.fillStyle = color;
        ctx.fillRect(Math.round(x(i) - bodyW / 2), Math.round(top), bodyW, Math.round(h));
      }

      // ---- 均线(引擎算的 r.ma,与 bars 逐根对齐) ----
      const ma = r.ma || {};
      const maPeriods = Object.keys(ma).map(Number).sort((a, b) => a - b);
      for (const period of maPeriods) {
        const series = ma[String(period)] || [];
        const color = P[MA_STYLE[period] || 'label2'];
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < n && i < series.length; i += 1) {
          const v = series[i];
          if (v == null) { started = false; continue; }
          if (!started) { ctx.moveTo(x(i), y(v)); started = true; } else ctx.lineTo(x(i), y(v));
        }
        ctx.stroke();
      }

      // ---- 摆动点 ----
      ctx.font = `9px ${P.font}`;
      ctx.textAlign = 'center';
      for (const swing of (r.swings || []).slice(-8)) {
        if (!idxOf.has(swing.time) || !visible(swing.price)) continue;
        const i = idxOf.get(swing.time);
        const above = swing.kind === 'high';
        ctx.fillStyle = alpha(above ? P.down : P.up, 0.9);
        ctx.beginPath(); ctx.arc(x(i), y(swing.price), 2, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = alpha(P.label, 0.45);
        ctx.fillText(swing.label || '', x(i), y(swing.price) + (above ? -9 : 9));
      }
      ctx.font = `${FONT_SIZE}px ${P.font}`;

      // ---- 现价:点线 + 轴上标签(固定,不参与被推开) ----
      if (visible(r.last)) {
        const yy = crisp(y(r.last));
        ctx.setLineDash([1, 3]);
        ctx.strokeStyle = P.blue;
        ctx.beginPath(); ctx.moveTo(g.x0, yy); ctx.lineTo(g.x1, yy); ctx.stroke();
        ctx.setLineDash([]);
        tags.push({ y: y(r.last), text: fmtPrice(r.last, dec), bg: P.blue, fg: '#fff', pinned: true });
      }

      // ---- 轴上的价格标签,统一避让后再画 ----
      for (const t of layoutTags(tags, g.priceTop, g.priceBottom)) {
        drawTag(ctx, g.x1 + 2, t.ly, t.text, t.bg, t.fg, P);
        if (Math.abs(t.ly - t.y) > 1) {   // 被推开的标签画一条引线回到真实价位
          ctx.strokeStyle = alpha(P.label, 0.25);
          ctx.beginPath(); ctx.moveTo(g.x1, crisp(t.y)); ctx.lineTo(g.x1 + 2, crisp(t.ly)); ctx.stroke();
        }
      }

      // ---- 顶部两行:均线读数 + 图例 / 十字光标读数 ----
      const hoverIdx = state.hover ? Math.min(n - 1, Math.max(0, Math.floor((state.hover.x - g.x0) / slot))) : null;
      const refIdx = hoverIdx != null ? hoverIdx : n - 1;
      ctx.textAlign = 'left';
      let tx = g.x0 + 2;
      for (const period of maPeriods) {
        const v = (ma[String(period)] || [])[refIdx];
        ctx.fillStyle = P[MA_STYLE[period] || 'label2'];
        const text = `MA${period} ${v == null ? '—' : fmtPrice(v, dec)}`;
        ctx.fillText(text, tx, 10);
        tx += ctx.measureText(text).width + 14;
      }
      const b = bars[refIdx];
      const prev = refIdx > 0 ? bars[refIdx - 1] : null;
      if (hoverIdx != null && b) {
        const chg = prev ? ((b.close - prev.close) / prev.close) * 100 : null;
        const parts = [
          [timeLabel(b.time, true), P.label2],
          [`开 ${fmtPrice(b.open, dec)}`, P.label],
          [`高 ${fmtPrice(b.high, dec)}`, P.label],
          [`低 ${fmtPrice(b.low, dec)}`, P.label],
          [`收 ${fmtPrice(b.close, dec)}`, b.close >= b.open ? P.up : P.down],
          [`量 ${fmtVol(b.volume)}`, P.label2],
          [chg == null ? '' : `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`, chg == null ? P.label2 : chg >= 0 ? P.up : P.down],
        ];
        tx = g.x0 + 2;
        for (const [text, color] of parts) {
          if (!text) continue;
          ctx.fillStyle = color;
          ctx.fillText(text, tx, 27);
          tx += ctx.measureText(text).width + 12;
        }
      } else {
        const legend = [
          ['■', P.up, '阳线'], ['■', P.down, '阴线'],
          ['╌', P.up, '支撑'], ['╌', P.down, '阻力'],
          ['▮', alpha(P.up, 0.45), 'FVG'], ['▯', alpha(P.label, 0.5), '订单块'],
          ['·', P.blue, '现价'],
        ];
        tx = g.x0 + 2;
        for (const [glyph, color, text] of legend) {
          ctx.fillStyle = color;
          ctx.fillText(glyph, tx, 27);
          tx += ctx.measureText(glyph).width + 3;
          ctx.fillStyle = P.label2;
          ctx.fillText(text, tx, 27);
          tx += ctx.measureText(text).width + 12;
        }
      }

      // ---- 十字光标 ----
      if (hoverIdx != null && state.hover) {
        const hx = crisp(x(hoverIdx));
        const hy = crisp(Math.min(g.priceBottom, Math.max(g.priceTop, state.hover.y)));
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = alpha(P.label, 0.45);
        ctx.beginPath(); ctx.moveTo(hx, g.priceTop); ctx.lineTo(hx, g.volBottom); ctx.stroke();
        if (state.hover.y >= g.priceTop && state.hover.y <= g.priceBottom) {
          ctx.beginPath(); ctx.moveTo(g.x0, hy); ctx.lineTo(g.x1, hy); ctx.stroke();
          ctx.setLineDash([]);
          const price = lo + ((g.priceBottom - hy) / (g.priceBottom - g.priceTop)) * span;
          drawTag(ctx, g.x1 + 2, hy, fmtPrice(price, dec), P.label, P.surface, P);
        }
        ctx.setLineDash([]);
        drawTag(ctx, hx - 30, g.volBottom + AXIS_H / 2, timeLabel(bars[hoverIdx].time, true), P.label, P.surface, P, 60);
      }
    }

    function drawTag(c, xLeft, yCenter, text, bg, fg, P, width) {
      c.font = `${FONT_SIZE - 1}px ${P.font}`;
      const w = width || Math.max(AXIS_W - 4, c.measureText(text).width + 10);
      const top = Math.round(yCenter - TAG_H / 2);
      c.fillStyle = bg;
      roundRect(c, xLeft, top, w, TAG_H, 3);
      c.fill();
      c.fillStyle = fg;
      c.textAlign = 'center';
      c.fillText(text, xLeft + w / 2, yCenter + 0.5);
      c.textAlign = 'left';
      c.font = `${FONT_SIZE}px ${P.font}`;
    }
    function roundRect(c, x0, y0, w, h, rad) {
      c.beginPath();
      c.moveTo(x0 + rad, y0);
      c.arcTo(x0 + w, y0, x0 + w, y0 + h, rad);
      c.arcTo(x0 + w, y0 + h, x0, y0 + h, rad);
      c.arcTo(x0, y0 + h, x0, y0, rad);
      c.arcTo(x0, y0, x0 + w, y0, rad);
      c.closePath();
    }

    // ---- 尺寸、交互、主题 ----
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; draw(); });
    };
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      state.width = Math.floor(rect.width);
      state.height = Math.floor(rect.height);
      if (state.width > 0 && state.height > 0) schedule();
    });
    ro.observe(container);

    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      state.hover = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      schedule();
    });
    canvas.addEventListener('mouseleave', () => { state.hover = null; schedule(); });

    // 深浅色 / 涨跌配色变化时重画;画布已经不在文档里就把监听全撤掉
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onTheme = () => { if (!canvas.isConnected) { cleanup(); return; } schedule(); };
    mq.addEventListener('change', onTheme);
    const mo = new MutationObserver(onTheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-updown', 'data-vibrancy'] });
    function cleanup() {
      ro.disconnect();
      mo.disconnect();
      mq.removeEventListener('change', onTheme);
      if (frame) cancelAnimationFrame(frame);
    }

    return {
      update(next) { state.r = next; schedule(); },
      destroy() { cleanup(); canvas.remove(); },
    };
  }

  window.DafriPaChart = { mount };
})();
