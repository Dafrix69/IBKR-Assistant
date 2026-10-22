// 图表交互对拍的浏览器那一半(在 chart-harness/index.html 里跑,见 tools/chart_harness.mjs;库要是开发版,名字没压缩):
// 对 cases.json 的第一个场景(K线 PA,1066 × 440)依次做库的鼠标处理器会做的那几件事——直接调它的模型(合成的鼠标事件库收不到),
// 每一步之后记下可见下标范围、价格轴是不是自动、主图顶与底的价、每根的间距:
//   滚轮缩放(zoomTime)、按住拖动(startScrollTime / scrollTimeTo)、拖时间轴(startScaleTime / scaleTimeTo)、拖价格轴(startScalePrice /
//   scalePriceTo)、价格手动时在图里拖(startScrollPrice / scrollPriceTo)、双击价格轴(resetPriceScale)、双击时间轴(engine.ts 的 resetView)、
//   滚轮横向(scrollChart)、刷新(同一个 viewKey 多一根 / 换了 viewKey)。
(async () => {
  const cases = await (await fetch('cases.json')).json();
  const frames = (n) => new Promise((done) => { const step = (k) => (k ? requestAnimationFrame(() => step(k - 1)) : done()); step(n); });
  const c = cases[0];
  const host = document.getElementById('host');
  host.replaceChildren();
  const box = document.createElement('div');
  box.style.cssText = `position:relative;width:${c.w}px;height:${c.h}px`;
  host.appendChild(box);
  const handle = window.__chartHarness.mountChart(box, c.spec, { wheel: false });
  await frames(3);
  const chart = box.__chart;
  const model = chart._private__chartWidget._internal_model();
  const pane = model._internal_panes()[0];
  const ps = pane._internal_defaultPriceScale();
  const carrier = chart.panes()[0].getSeries()[0];
  const steps = [];
  const record = async (name) => {
    await frames(2);
    const r = chart.timeScale().getVisibleLogicalRange();
    const h = chart.panes()[0].getHeight();
    steps.push({ name, from: r.from, to: r.to, barSpacing: model._internal_timeScale()._internal_barSpacing(), rightOffset: model._internal_timeScale()._internal_rightOffset(),
      auto: ps._internal_isAutoScale(), top: carrier.coordinateToPrice(0), bottom: carrier.coordinateToPrice(h - 1) });
  };
  await record('铺满');
  for (let k = 0; k < 3; k += 1) model._internal_zoomTime(500, 1);
  await record('滚轮放大 3 格 @500');
  model._internal_startScrollTime(500); model._internal_scrollTimeTo(600); model._internal_endScrollTime();
  await record('右拖 100');
  model._internal_startScrollTime(500); model._internal_scrollTimeTo(3000); model._internal_endScrollTime();
  await record('右拖到头');
  model._internal_startScrollTime(500); model._internal_scrollTimeTo(380); model._internal_endScrollTime();
  await record('左拖 120');
  model._internal_zoomTime(900, -1); model._internal_zoomTime(900, -0.4);
  await record('滚轮缩小 1.4 格 @900');
  model._internal_zoomTime(-50, 1);
  await record('滚轮放大 @-50(夹到 1)');
  model._internal_startScaleTime(500); model._internal_scaleTimeTo(400); model._internal_endScaleTime();
  await record('拖时间轴 500 → 400');
  model._internal_startScaleTime(300); model._internal_scaleTimeTo(700); model._internal_endScaleTime();
  await record('拖时间轴 300 → 700');
  model._internal_startScalePrice(pane, ps, 100); model._internal_scalePriceTo(pane, ps, 150); model._internal_endScalePrice(pane, ps);
  await record('拖价格轴 100 → 150');
  model._internal_startScrollPrice(pane, ps, 200); model._internal_scrollPriceTo(pane, ps, 260); model._internal_endScrollPrice(pane, ps);
  await record('价格手动时下拖 60');
  model._internal_scrollChart(1.5 * -80);
  await record('滚轮横向 deltaX 1.5');
  model._internal_resetPriceScale(pane, ps);
  await record('双击价格轴');
  model._internal_zoomTime(500, 1); model._internal_zoomTime(500, 1);
  await record('再放大 2 格');
  const more = { ...c.spec, bars: [...c.spec.bars, { ...c.spec.bars[c.spec.bars.length - 1], time: '2026-08-21 10:10' }] };
  handle.update(more);
  await record('刷新:同一个 viewKey 多一根(贴着右边)');
  model._internal_startScrollTime(500); model._internal_scrollTimeTo(700); model._internal_endScrollTime();
  await record('右拖 200');
  handle.update({ ...more, bars: [...more.bars, { ...more.bars[more.bars.length - 1], time: '2026-08-21 10:11' }] });
  await record('刷新:停在中间时多一根');
  handle.update({ ...more, viewKey: 'other' });
  await record('刷新:换了 viewKey');
  chart.priceScale('right', 0).setAutoScale(true); chart.timeScale().fitContent();
  await record('双击时间轴(resetView)');
  // 改尺寸(engine.ts 开着 lockVisibleTimeRangeOnResize,ResizeObserver 接到之后库按 新宽 / 旧宽 缩放间距)
  const resize = async (w) => { box.style.width = `${w}px`; await frames(4); };
  await resize(800);
  await record('铺满时窄到 800');
  for (let k = 0; k < 3; k += 1) model._internal_zoomTime(400, 1);
  await record('窄着放大 3 格 @400');
  await resize(1066);
  await record('放大后宽回 1066');
  model._internal_startScrollTime(500); model._internal_scrollTimeTo(3000); model._internal_endScrollTime();
  await record('右拖到头(左沿露出来)');
  await resize(700);
  await record('左沿露着时窄到 700');
  handle.destroy();
  return steps;
})();
