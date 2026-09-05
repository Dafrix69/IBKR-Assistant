// 图表引擎(canvas)。K线 PA、交易分析的两张图、回测净值曲线都走这一套坐标系:
// 按真实像素画(ResizeObserver 量容器、devicePixelRatio 缩放),字号 11px、线宽 1px 固定,
// 右侧价格轴、底部时间轴、淡网格,轴上的价格标签与图内文字标签都做碰撞避让,十字光标读数通用。
//
// 图上出现的每一条线都对应引擎算出的一个字段,这里不新算任何东西:调用方把引擎结果翻译成一份
// 描述(spec),这里只负责画。spec 的字段:
//   times     x 轴的时间序列(缺省取 bars 的 time);所有元素都用 time 定位,不用下标
//   bars      蜡烛 [{time, open, high, low, close, volume?}],可以是 times 的子集(稀疏)
//   lines     折线 [{values 与 times 对齐 | points:[{time,value}], color, width, dash, alpha, step, label, header}]
//   hlines    水平线 [{price, color, dash, alpha, width, label, tag, fit}]  tag=轴上标签,fit=是否撑开价格区间
//   bands     区域 [{from, to, top, bottom, color, fill, stroke, dash, label}] 或竖带 [{v:true, from, to, color, fill, label}]
//   vlines    竖线 [{time, color, dash, label}]
//   markers   标记 [{time, price, shape:'dot'|'tri-up'|'tri-down', color, label, labelPos:'above'|'below', labelAlpha}]
//   last      现价:点线 + 轴上钉住的标签
//   legend    [[glyph, color, text]];  header(i) → [[text, color]] 顶部第一行的读数(均线之类)
//   readout(i) → [[text, color]] 十字光标读数,缺省念 bars 里那根的开高低收量
//   volume    是否画量能子图(缺省:有成交量就画);yMin 价格区间下限(蝶价不会小于 0)
// 颜色写 token 名('up' / 'down' / 'blue' / 'orange' / 'purple' / 'label' / 'label2')或字面量,
// 画的时候再解析,深浅色与「涨跌配色」切换后重画自然拿到新值。
//
// 蜡烛的配色不用系统绿红:systemGreen / systemRed 是给圆点和开关用的饱和色,几百根挤在一起会发光。
// 这里用图表业界通用的一对(青绿 #26a69a / 珊瑚红 #ef5350,TradingView 的默认值),文字与圆点仍用系统色。
'use strict';

(function () {
  const AXIS_W = 64;           // 右侧价格轴
  const AXIS_H = 20;           // 底部时间轴
  const VOL_H = 56;            // 量能子图
  const GAP = 8;               // 价格区与量能区之间
  const PAD_L = 8;
  const FONT_SIZE = 11;
  const TAG_H = 16;            // 轴上价格标签高度,也是碰撞避让的最小间距
  const LABEL_H = 12;          // 图内小标签(9px 字)的行高
  const MA_STYLE = { 5: 'orange', 10: 'blue', 20: 'purple' };

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }
  function palette() {
    const up = cssVar('--chart-up', '') || cssVar('--up', '#26a69a');
    const down = cssVar('--chart-down', '') || cssVar('--down', '#ef5350');
    return {
      up, down,
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
  function resolve(P, color) {
    if (!color) return P.label2;
    return P[color] || color;
  }

  /** 把颜色叠上透明度:支持 #rgb/#rrggbb 与 rgb()/rgba()。 */
  function alpha(color, a) {
    const c = String(color).trim();
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

  /** 一维碰撞避让:按 y 排序,重叠的向两边推开,再夹回区间。pinned 的不动(现价)。 */
  function layoutTags(tags, minY, maxY, h) {
    const H = h || TAG_H;
    const sorted = tags.slice().sort((a, b) => a.y - b.y);
    for (const t of sorted) t.ly = Math.min(maxY - H / 2, Math.max(minY + H / 2, t.y));
    for (let pass = 0; pass < 8; pass += 1) {
      let moved = false;
      for (let i = 1; i < sorted.length; i += 1) {
        const a = sorted[i - 1];
        const b = sorted[i];
        const overlap = a.ly + H - b.ly;
        if (overlap > 0) {
          moved = true;
          if (a.pinned && !b.pinned) b.ly += overlap;
          else if (b.pinned && !a.pinned) a.ly -= overlap;
          else { a.ly -= overlap / 2; b.ly += overlap / 2; }
        }
      }
      for (const t of sorted) {
        if (!t.pinned) t.ly = Math.min(maxY - H / 2, Math.max(minY + H / 2, t.ly));
      }
      if (!moved) break;
    }
    return sorted;
  }

  /** 二维的文字标签避让:已放下的矩形列表,新标签和谁重叠就往 dir 方向挪一行,最多挪 6 次。 */
  function placeLabel(placed, rect, dir) {
    for (let k = 0; k < 6; k += 1) {
      const hit = placed.some((r) => rect.x < r.x + r.w && rect.x + rect.w > r.x && rect.y < r.y + r.h && rect.y + rect.h > r.y);
      if (!hit) break;
      rect.y += dir * (rect.h + 1);
    }
    placed.push(rect);
    return rect;
  }

  /** 把 spec 里按 time 定位的东西翻译成下标;稀疏的 bars / 折线点都在这里对齐到 times。 */
  function normalize(spec) {
    const times = spec.times || (spec.bars || []).map((b) => b.time);
    const idx = new Map(times.map((t, i) => [t, i]));
    const barAt = new Array(times.length).fill(null);
    for (const b of spec.bars || []) if (idx.has(b.time)) barAt[idx.get(b.time)] = b;
    const lines = (spec.lines || []).map((ln) => {
      let values = ln.values;
      if (!values && ln.points) {
        values = new Array(times.length).fill(null);
        for (const p of ln.points) if (idx.has(p.time)) values[idx.get(p.time)] = p.value;
      }
      return { ...ln, values: values || [] };
    });
    return { times, idx, barAt, lines };
  }

  function mount(container, spec) {
    const canvas = document.createElement('canvas');
    canvas.className = 'pa-canvas';
    canvas.setAttribute('role', 'img');
    if (spec.ariaLabel) canvas.setAttribute('aria-label', spec.ariaLabel);
    container.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    const state = { spec, norm: normalize(spec), hover: null, width: 0, height: 0 };

    function draw() {
      const spec = state.spec;
      const { times, idx, barAt, lines } = state.norm;
      const P = palette();
      const col = (c) => resolve(P, c);
      const n = times.length;
      const hasBars = barAt.some(Boolean);
      const hasVol = spec.volume !== false && barAt.some((b) => b && b.volume > 0);
      const headerRows = (spec.header ? 1 : 0) + 1;
      const padTop = 8 + headerRows * 17;

      const W = state.width;
      const H = state.height;
      const x0 = PAD_L;
      const x1 = W - AXIS_W;
      const priceTop = padTop;
      const volBottom = H - AXIS_H;
      const priceBottom = hasVol ? volBottom - VOL_H - GAP : volBottom;
      const volTop = priceBottom + GAP;

      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.font = `${FONT_SIZE}px ${P.font}`;
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 1;

      if (n < 2 || x1 - x0 < 60 || priceBottom - priceTop < 50) {
        ctx.fillStyle = P.label3;
        ctx.textAlign = 'center';
        ctx.fillText(n < 2 ? '数据不足,无法成图' : '窗口太窄', W / 2, H / 2);
        return;
      }

      // ---- 坐标 ----
      const slot = (x1 - x0) / n;
      const x = (i) => x0 + slot * (i + 0.5);
      let lo = Infinity;
      let hi = -Infinity;
      const take = (v) => { if (v != null && Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } };
      for (const b of barAt) if (b) { take(b.low); take(b.high); }
      for (const ln of lines) for (const v of ln.values) take(v);
      for (const h of spec.hlines || []) if (h.fit !== false) take(h.price);
      for (const m of spec.markers || []) if (m.fit !== false) take(m.price);
      for (const bd of spec.bands || []) if (bd.fit) { take(bd.top); take(bd.bottom); }
      take(spec.last);
      if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
      const pad = (hi - lo) * (spec.padPct || 0.05) || Math.abs(hi) * 0.001 || 1;
      lo -= pad;
      hi += pad;
      if (spec.yMin != null) lo = Math.max(spec.yMin, lo);
      const span = hi - lo || 1;
      const y = (p) => priceBottom - ((p - lo) / span) * (priceBottom - priceTop);
      const visible = (p) => p != null && p >= lo && p <= hi;
      const step = niceStep(span, Math.max(3, Math.floor((priceBottom - priceTop) / 46)));
      const dec = spec.decimals != null ? spec.decimals : decimalsFor(step);
      const lastIdx = (() => { for (let i = n - 1; i >= 0; i -= 1) if (barAt[i] || lines.some((l) => l.values[i] != null)) return i; return n - 1; })();
      const rightEdge = x(lastIdx) + slot / 2;   // 区域只画到最后一根,不铺到轴上
      const xAt = (t, dflt) => (idx.has(t) ? x(idx.get(t)) : dflt);

      // ---- 网格 + 价格轴 ----
      ctx.strokeStyle = alpha(P.label, 0.06);
      ctx.fillStyle = P.label2;
      ctx.textAlign = 'left';
      const first = Math.ceil(lo / step) * step;
      for (let p = first; p <= hi; p += step) {
        const yy = crisp(y(p));
        ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x1, yy); ctx.stroke();
        ctx.fillText(fmtPrice(p, dec), x1 + 6, yy);
      }
      ctx.strokeStyle = P.separator;
      ctx.beginPath(); ctx.moveTo(crisp(x1), priceTop - 6); ctx.lineTo(crisp(x1), volBottom); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x0, crisp(volBottom)); ctx.lineTo(x1, crisp(volBottom)); ctx.stroke();
      if (hasVol) { ctx.beginPath(); ctx.moveTo(x0, crisp(priceBottom)); ctx.lineTo(x1, crisp(priceBottom)); ctx.stroke(); }

      // ---- 时间轴 ----
      const every = Math.max(1, Math.ceil(76 / slot));
      ctx.textAlign = 'center';
      ctx.fillStyle = P.label2;
      let lastDate = null;
      for (let i = 0; i < n; i += every) {
        const withDate = lastDate !== null && dateOf(times[i]) !== lastDate;
        if (lastDate === null || withDate) lastDate = dateOf(times[i]);
        const xx = x(i);
        ctx.strokeStyle = alpha(P.label, 0.06);
        ctx.beginPath(); ctx.moveTo(crisp(xx), priceTop); ctx.lineTo(crisp(xx), volBottom); ctx.stroke();
        const text = timeLabel(times[i], withDate || (i === 0 && every * 3 >= n));
        // 首尾两个标签不许出画布:靠边的改成左对齐 / 右对齐
        const tw = ctx.measureText(text).width;
        const tx = Math.min(x1 - tw / 2, Math.max(x0 + tw / 2, xx));
        ctx.fillText(text, tx, volBottom + AXIS_H / 2 + 1);
      }

      // ---- 区域(最底层)----
      const leftLabels = [];   // 图内左侧的小字标签,统一避让后再画
      for (const bd of spec.bands || []) {
        const color = col(bd.color);
        if (bd.v) {
          const from = xAt(bd.from, x0) - slot / 2;
          const to = xAt(bd.to, x1) + slot / 2;
          ctx.fillStyle = alpha(color, bd.fill != null ? bd.fill : 0.06);
          ctx.fillRect(from, priceTop, Math.max(to - from, 1), priceBottom - priceTop);
          if (bd.label) {
            ctx.fillStyle = alpha(color, 0.8);
            ctx.font = `9px ${P.font}`;
            ctx.textAlign = 'left';
            ctx.fillText(bd.label, from + 3, priceTop + 7);
            ctx.font = `${FONT_SIZE}px ${P.font}`;
          }
          continue;
        }
        if (!visible(bd.top) && !visible(bd.bottom)) continue;
        const start = bd.from != null ? xAt(bd.from, x0) - slot / 2 : x0;
        const end = bd.to != null ? xAt(bd.to, rightEdge) + slot / 2 : rightEdge;
        const top = y(Math.min(bd.top, hi));
        const bottom = y(Math.max(bd.bottom, lo));
        ctx.fillStyle = alpha(color, bd.fill != null ? bd.fill : 0.07);
        ctx.fillRect(start, top, Math.max(end - start, 2), Math.max(bottom - top, 1));
        if (bd.stroke) {
          ctx.setLineDash(bd.dash || []);
          ctx.strokeStyle = alpha(color, bd.stroke);
          ctx.strokeRect(crisp(start), crisp(top), Math.max(end - start, 2), Math.max(bottom - top, 1));
          ctx.setLineDash([]);
        }
        if (bd.label) leftLabels.push({ y: top + 7, x: start + 3, text: bd.label, color: alpha(color, 0.8) });
      }

      // ---- 水平线:虚线,价格标签放轴上(稍后统一避让),名字放线的左端 ----
      const tags = [];
      for (const h of spec.hlines || []) {
        if (!visible(h.price)) continue;
        const color = col(h.color);
        const yy = crisp(y(h.price));
        ctx.setLineDash(h.dash || []);
        ctx.lineWidth = h.width || 1;
        ctx.strokeStyle = alpha(color, h.alpha != null ? h.alpha : 0.5);
        ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x1, yy); ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineWidth = 1;
        if (h.tag !== false) tags.push({ y: y(h.price), text: fmtPrice(h.price, dec), bg: alpha(color, 0.9), fg: '#fff' });
        if (h.label) leftLabels.push({ y: y(h.price) - 6, x: x0 + 3, text: h.label, color: alpha(color, 0.85) });
      }

      // ---- 量能:95 分位归一化,开盘第一根巨量不再把其余压成一条线 ----
      const bodyW = (() => {
        let w = Math.floor(slot * 0.68);
        if (slot >= 5) w = Math.min(w, Math.floor(slot) - 2);
        w = Math.max(1, w);
        return w % 2 === 0 && w > 1 ? w - 1 : w;   // 奇数宽,影线正好落在正中那一列像素
      })();
      const bodyLeft = (i) => Math.floor(crisp(x(i))) - (bodyW - 1) / 2;
      if (hasVol) {
        const vols = barAt.map((b) => (b && b.volume) || 0).filter((v) => v > 0).sort((a, b) => a - b);
        const cap = vols[Math.min(vols.length - 1, Math.floor(0.95 * (vols.length - 1)))] || vols[vols.length - 1];
        const volH = volBottom - volTop;
        for (let i = 0; i < n; i += 1) {
          const b = barAt[i];
          const v = b ? b.volume || 0 : 0;
          if (v <= 0) continue;
          const h = Math.max(1, Math.min(volH, (v / cap) * volH));
          ctx.fillStyle = alpha(b.close >= b.open ? P.up : P.down, 0.5);
          ctx.fillRect(bodyLeft(i), Math.round(volBottom - h), bodyW, Math.round(h));
        }
        ctx.fillStyle = P.label3;
        ctx.textAlign = 'right';
        ctx.font = `9px ${P.font}`;
        ctx.fillText(`满格 = ${fmtVol(cap)}(95 分位)`, x1 - 4, volTop + 6);
        ctx.font = `${FONT_SIZE}px ${P.font}`;
      }

      // ---- 蜡烛:影线 1px 居中,实体奇数宽、根根之间留空 ----
      if (hasBars) {
        for (let i = 0; i < n; i += 1) {
          const b = barAt[i];
          if (!b) continue;
          const up = b.close >= b.open;
          const color = up ? P.up : P.down;
          const cx = crisp(x(i));
          ctx.strokeStyle = color;
          ctx.beginPath(); ctx.moveTo(cx, Math.round(y(b.high))); ctx.lineTo(cx, Math.round(y(b.low))); ctx.stroke();
          const top = Math.round(y(Math.max(b.open, b.close)));
          const h = Math.max(1, Math.round(Math.abs(y(b.close) - y(b.open))));
          ctx.fillStyle = color;
          ctx.fillRect(bodyLeft(i), top, bodyW, h);
        }
      }

      // ---- 折线 ----
      for (const ln of lines) {
        const color = alpha(col(ln.color), ln.alpha != null ? ln.alpha : 0.9);
        ctx.strokeStyle = color;
        ctx.lineWidth = ln.width || 1;
        ctx.lineJoin = 'round';
        ctx.setLineDash(ln.dash || []);
        ctx.beginPath();
        let started = false;
        let prevY = null;
        for (let i = 0; i < n && i < ln.values.length; i += 1) {
          const v = ln.values[i];
          if (v == null) { started = false; continue; }
          const px = x(i);
          const py = y(v);
          if (!started) { ctx.moveTo(px, py); started = true; }
          else if (ln.step) { ctx.lineTo(px - slot / 2, prevY); ctx.lineTo(px - slot / 2, py); ctx.lineTo(px, py); }
          else ctx.lineTo(px, py);
          prevY = py;
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineWidth = 1;
      }

      // ---- 标记:圆点 / 三角 + 文字(文字之间避让)----
      const placed = [];
      ctx.font = `9px ${P.font}`;
      ctx.textAlign = 'center';
      for (const m of spec.markers || []) {
        if (!idx.has(m.time) || !visible(m.price)) continue;
        const px = x(idx.get(m.time));
        const py = y(m.price);
        const color = col(m.color);
        ctx.fillStyle = color;
        if (m.shape === 'tri-up') {
          ctx.beginPath(); ctx.moveTo(px, py - 1); ctx.lineTo(px - 4.5, py + 7); ctx.lineTo(px + 4.5, py + 7); ctx.closePath(); ctx.fill();
        } else if (m.shape === 'tri-down') {
          ctx.beginPath(); ctx.moveTo(px, py + 1); ctx.lineTo(px - 4.5, py - 7); ctx.lineTo(px + 4.5, py - 7); ctx.closePath(); ctx.fill();
        } else {
          ctx.beginPath(); ctx.arc(px, py, 2.5, 0, Math.PI * 2); ctx.fill();
        }
        if (m.label) {
          const above = m.labelPos !== 'below';
          const w = ctx.measureText(m.label).width + 4;
          const rect = placeLabel(placed, { x: px - w / 2, y: above ? py - 9 - LABEL_H : py + 5, w, h: LABEL_H }, above ? -1 : 1);
          ctx.fillStyle = alpha(m.labelColor ? col(m.labelColor) : color, m.labelAlpha != null ? m.labelAlpha : 0.95);
          ctx.fillText(m.label, px, rect.y + LABEL_H / 2);
        }
      }
      ctx.font = `${FONT_SIZE}px ${P.font}`;

      // ---- 竖线(开仓 / 平仓):顶部写字,靠右的写在线左边 ----
      const vlabels = [];
      for (const vl of spec.vlines || []) {
        if (!idx.has(vl.time)) continue;
        const px = crisp(x(idx.get(vl.time)));
        const color = col(vl.color);
        ctx.setLineDash(vl.dash || [3, 3]);
        ctx.strokeStyle = alpha(color, 0.8);
        ctx.beginPath(); ctx.moveTo(px, priceTop); ctx.lineTo(px, priceBottom); ctx.stroke();
        ctx.setLineDash([]);
        if (vl.label) vlabels.push({ px, color, text: vl.label, left: px > x0 + (x1 - x0) * 0.6 });
      }
      ctx.font = `10px ${P.font}`;
      const vplaced = [];
      for (const v of vlabels) {
        const w = ctx.measureText(v.text).width + 6;
        const rect = placeLabel(vplaced, { x: v.left ? v.px - 4 - w : v.px + 4, y: priceTop + 2, w, h: 13 }, 1);
        ctx.fillStyle = v.color;
        ctx.textAlign = v.left ? 'right' : 'left';
        ctx.fillText(v.text, v.left ? v.px - 4 : v.px + 4, rect.y + 6.5);
      }
      ctx.font = `${FONT_SIZE}px ${P.font}`;

      // ---- 现价:点线 + 轴上标签(固定,不参与被推开)----
      if (visible(spec.last)) {
        const yy = crisp(y(spec.last));
        ctx.setLineDash([1, 3]);
        ctx.strokeStyle = P.blue;
        ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x1, yy); ctx.stroke();
        ctx.setLineDash([]);
        tags.push({ y: y(spec.last), text: fmtPrice(spec.last, dec), bg: P.blue, fg: '#fff', pinned: true });
      }

      // ---- 图内左侧小标签 ----
      ctx.font = `9px ${P.font}`;
      ctx.textAlign = 'left';
      for (const t of layoutTags(leftLabels, priceTop, priceBottom, LABEL_H)) {
        ctx.fillStyle = t.color;
        ctx.fillText(t.text, t.x, t.ly);
      }
      ctx.font = `${FONT_SIZE}px ${P.font}`;

      // ---- 轴上的价格标签,统一避让后再画 ----
      for (const t of layoutTags(tags, priceTop, priceBottom)) {
        drawTag(ctx, x1 + 2, t.ly, t.text, t.bg, t.fg, P);
        if (Math.abs(t.ly - t.y) > 1) {   // 被推开的标签画一条引线回到真实价位
          ctx.strokeStyle = alpha(P.label, 0.25);
          ctx.beginPath(); ctx.moveTo(x1, crisp(t.y)); ctx.lineTo(x1 + 2, crisp(t.ly)); ctx.stroke();
        }
      }

      // ---- 顶部:第一行读数(均线等),第二行图例 / 十字光标读数 ----
      const hoverIdx = state.hover ? Math.min(n - 1, Math.max(0, Math.floor((state.hover.x - x0) / slot))) : null;
      const refIdx = hoverIdx != null ? hoverIdx : lastIdx;
      ctx.textAlign = 'left';
      let row = 10;
      const writeRow = (parts, yy) => {
        let tx = x0 + 2;
        for (const [text, color] of parts) {
          if (!text) continue;
          ctx.fillStyle = color;
          ctx.fillText(text, tx, yy);
          tx += ctx.measureText(text).width + 12;
        }
      };
      if (spec.header) {
        writeRow((spec.header(refIdx, { fmt: (v) => fmtPrice(v, dec), P, col }) || []), row);
        row += 17;
      }
      if (hoverIdx != null) {
        const parts = spec.readout
          ? spec.readout(hoverIdx, { fmt: (v) => fmtPrice(v, dec), fmtVol, P, col, timeLabel })
          : defaultReadout(hoverIdx);
        writeRow(parts || [], row);
      } else {
        let tx = x0 + 2;
        for (const [glyph, color, text] of spec.legend || []) {
          ctx.fillStyle = col(color);
          ctx.fillText(glyph, tx, row);
          tx += ctx.measureText(glyph).width + 3;
          ctx.fillStyle = P.label2;
          ctx.fillText(text, tx, row);
          tx += ctx.measureText(text).width + 12;
        }
      }
      function defaultReadout(i) {
        const b = barAt[i];
        if (b) {
          let prev = null;
          for (let k = i - 1; k >= 0; k -= 1) if (barAt[k]) { prev = barAt[k]; break; }
          const chg = prev ? ((b.close - prev.close) / prev.close) * 100 : null;
          return [
            [timeLabel(times[i], true), P.label2],
            [`开 ${fmtPrice(b.open, dec)}`, P.label],
            [`高 ${fmtPrice(b.high, dec)}`, P.label],
            [`低 ${fmtPrice(b.low, dec)}`, P.label],
            [`收 ${fmtPrice(b.close, dec)}`, b.close >= b.open ? P.up : P.down],
            b.volume != null ? [`量 ${fmtVol(b.volume)}`, P.label2] : ['', ''],
            [chg == null ? '' : `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`, chg == null ? P.label2 : chg >= 0 ? P.up : P.down],
          ];
        }
        const parts = [[timeLabel(times[i], true), P.label2]];
        for (const ln of lines) {
          const v = ln.values[i];
          if (v != null && ln.label) parts.push([`${ln.label} ${fmtPrice(v, dec)}`, col(ln.color)]);
        }
        return parts;
      }

      // ---- 十字光标 ----
      if (hoverIdx != null && state.hover) {
        const hx = crisp(x(hoverIdx));
        const hy = crisp(Math.min(priceBottom, Math.max(priceTop, state.hover.y)));
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = alpha(P.label, 0.45);
        ctx.beginPath(); ctx.moveTo(hx, priceTop); ctx.lineTo(hx, volBottom); ctx.stroke();
        if (state.hover.y >= priceTop && state.hover.y <= priceBottom) {
          ctx.beginPath(); ctx.moveTo(x0, hy); ctx.lineTo(x1, hy); ctx.stroke();
          ctx.setLineDash([]);
          const price = lo + ((priceBottom - hy) / (priceBottom - priceTop)) * span;
          drawTag(ctx, x1 + 2, hy, fmtPrice(price, dec), P.label, P.surface, P);
        }
        ctx.setLineDash([]);
        const tlabel = timeLabel(times[hoverIdx], true);
        ctx.font = `${FONT_SIZE - 1}px ${P.font}`;
        const tw = ctx.measureText(tlabel).width + 12;
        drawTag(ctx, Math.min(x1 - tw, Math.max(x0, hx - tw / 2)), volBottom + AXIS_H / 2, tlabel, P.label, P.surface, P, tw);
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
      update(next) { state.spec = next; state.norm = normalize(next); schedule(); },
      destroy() { cleanup(); canvas.remove(); },
    };
  }

  /** K线 PA:把引擎的 pa.analyze 结果翻译成 spec。字段对应关系见文件头。 */
  function paSpec(r) {
    const ma = r.ma || {};
    const periods = Object.keys(ma).map(Number).sort((a, b) => a - b);
    return {
      ariaLabel: `${r.symbol || ''} ${r.timeframe_label || ''} K 线图`,
      bars: r.bars || [],
      last: r.last,
      lines: periods.map((p) => ({ values: ma[String(p)] || [], color: MA_STYLE[p] || 'label2', alpha: 0.85, label: `MA${p}` })),
      hlines: (r.levels || []).map((l) => ({
        price: l.price, color: l.side === 'resistance' ? 'down' : 'up', dash: [2, 2], alpha: 0.45, fit: false,
      })),
      bands: [
        ...(r.fvgs || []).map((g) => ({
          from: g.time, top: g.top, bottom: g.bottom, color: g.side === 'bull' ? 'up' : 'down',
          fill: 0.07, stroke: 0.22, label: g.side === 'bull' ? 'FVG↑' : 'FVG↓',
        })),
        ...(r.order_block ? [{
          from: r.order_block.time, top: r.order_block.top, bottom: r.order_block.bottom,
          color: 'label', fill: 0.06, stroke: 0.28, dash: [2, 2], label: 'OB',
        }] : []),
      ],
      markers: (r.swings || []).slice(-8).map((s) => ({
        time: s.time, price: s.price, shape: 'dot', color: s.kind === 'high' ? 'down' : 'up',
        label: s.label || '', labelPos: s.kind === 'high' ? 'above' : 'below', labelColor: 'label', labelAlpha: 0.45, fit: false,
      })),
      legend: [
        ['■', 'up', '阳线'], ['■', 'down', '阴线'],
        ['╌', 'up', '支撑'], ['╌', 'down', '阻力'],
        ['▮', 'up', 'FVG'], ['▯', 'label2', '订单块'], ['·', 'blue', '现价'],
      ],
      header: periods.length ? (i, h) => periods.map((p) => {
        const v = (ma[String(p)] || [])[i];
        return [`MA${p} ${v == null ? '—' : h.fmt(v)}`, h.col(MA_STYLE[p] || 'label2')];
      }) : null,
    };
  }

  window.DafriChart = { mount };
  window.DafriPaChart = { mount: (container, result) => mount(container, paSpec(result)) };
})();
