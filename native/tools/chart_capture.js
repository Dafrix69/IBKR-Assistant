// 图表对拍的浏览器那一半(在 chart-harness/ 页面里跑,见 tools/chart_harness.mjs):对 cases.json 的每个场景
// 用 React 版的引擎挂一张图、等它画完,量出:
//   · 库的公开接口:可见下标范围、每根的 x(logicalToCoordinate)、各窗格的高、价格轴宽、时间轴高;
//     载体序列(看不见、每格都有值的那条)上的价格 ↔ y:一串 y 反算的价、几个价算的 y;
//   · 挂在 CanvasRenderingContext2D.prototype.fillText 上记下的每一段字(轴上的刻度、十字光标的字、叠加层的字),
//     按画布的变换矩阵折回到页面坐标,带上对齐、字体、颜色与量出来的宽;
//   · 顶部读数(DOM)的每一行、「窗口太窄」「数据不足」的提示。
// 用法:在浏览器面板里打开 /chart-harness/,执行这个文件的内容(一个 async 的 IIFE),结果是 JSON。
(async () => {
  const cases = await (await fetch('cases.json')).json();
  const proto = CanvasRenderingContext2D.prototype;
  if (!proto.__origFillText) {
    proto.__origFillText = proto.fillText;
    proto.fillText = function (text, x, y, maxWidth) {
      if (window.__rec) {
        const m = this.getTransform();
        const r = this.canvas.getBoundingClientRect();
        const sx = this.canvas.width / (r.width || 1);
        const sy = this.canvas.height / (r.height || 1);
        const px = m.a * x + m.c * y + m.e;
        const py = m.b * x + m.d * y + m.f;
        window.__rec.push({
          text: String(text), x: +(r.left + px / sx).toFixed(2), y: +(r.top + py / sy).toFixed(2),
          align: this.textAlign, baseline: this.textBaseline, font: this.font, color: String(this.fillStyle),
          w: +((this.measureText(String(text)).width * m.a) / sx).toFixed(2),
          // 库对齐时量的是把 1–9 换成 0 的那串(TextWidthCache 的键)
          w0: +((this.measureText(String(text).replace(/[1-9]/g, '0')).width * m.a) / sx).toFixed(2),
        });
      }
      return proto.__origFillText.call(this, text, x, y, maxWidth);
    };
  }
  const frames = (n) => new Promise((done) => { const step = (k) => (k ? requestAnimationFrame(() => step(k - 1)) : done()); step(n); });
  const host = document.getElementById('host');
  const results = [];
  for (const c of cases) {
    host.replaceChildren();
    const box = document.createElement('div');
    box.style.cssText = `position:relative;width:${c.w}px;height:${c.h}px`;
    host.appendChild(box);
    const handle = window.__chartHarness.mountChart(box, c.spec, { wheel: false });
    await frames(3);
    await new Promise((r) => setTimeout(r, 60));
    const chart = box.__chart;
    const res = { name: c.name, w: c.w, h: c.h, dpr: window.devicePixelRatio };
    const notice = box.querySelector('.chart-empty');
    res.notice = notice && notice.isConnected ? notice.textContent : null;
    res.legend = [...box.querySelectorAll('.chart-legend-row')].map((row) => [...row.children].map((el) => ({ text: el.textContent, color: el.style.color || (el.querySelector('i') ? el.querySelector('i').style.color : '') })));
    if (chart && !res.notice) {
      // 整张重画一遍,只记这一遍的字
      window.__rec = [];
      chart.applyOptions({ layout: { fontSize: 11 } });
      await frames(3);
      res.texts = window.__rec;
      window.__rec = null;
      const ts = chart.timeScale();
      const range = ts.getVisibleLogicalRange();
      res.range = range ? { from: range.from, to: range.to } : null;
      res.timeScale = { width: ts.width(), height: ts.height() };
      res.priceScaleWidth = chart.priceScale('right').width();
      res.panes = chart.panes().map((p) => p.getHeight());
      const n = (c.spec.times || (c.spec.bars || []).map((b) => b.time)).length;
      res.xs = [];
      for (let i = 0; i < n + 2; i += 1) res.xs.push(ts.logicalToCoordinate(i));
      const carrier = chart.panes()[0].getSeries()[0];
      res.priceAtY = [];
      for (let y = 0; y <= res.panes[0]; y += Math.max(1, Math.floor(res.panes[0] / 12))) res.priceAtY.push([y, carrier.coordinateToPrice(y)]);
      res.yAtPrice = [];
      const probe = [];
      for (const b of c.spec.bars || []) probe.push(b.high, b.low);
      for (const l of c.spec.lines || []) for (const v of l.values || []) if (typeof v === 'number') probe.push(v);
      for (const p of probe.slice(0, 40)) res.yAtPrice.push([p, carrier.priceToCoordinate(p)]);
    }
    handle.destroy();
    results.push(res);
  }
  return results;
})();
