// 排版对照的浏览器那一半:在 React 版(预览台)里跑,把看得见的每一段字量出来,形状和 Qt 版 --dump-texts 写的一样:
// [{ text, x, y, w, h, size, weight, color }]。用法:在浏览器面板里执行这段,返回值存成 JSON,交给 compare_texts.mjs。
// 一段字 = 一个文字节点的第一行(多行的段按行拆不比);SVG 里的 <text>/<tspan> 也算。看不见的(display:none、透明、在视口外)不算。
(() => {
  const out = [];
  const W = window.innerWidth, H = window.innerHeight;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const el = node.parentElement;
    if (!el || el.closest('title, script, style')) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const r = range.getBoundingClientRect();
    if (!r.width || !r.height || r.bottom < 0 || r.top > H || r.right < 0 || r.left > W) continue;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || Number(s.opacity) === 0) continue;
    let hidden = false;
    for (let p = el; p; p = p.parentElement) if (getComputedStyle(p).opacity === '0') { hidden = true; break; }
    if (hidden) continue;
    out.push({ text, x: Math.round(r.left * 10) / 10, y: Math.round(r.top * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10,
      size: parseFloat(s.fontSize), weight: Number(s.fontWeight),
      // SVG 的字画出来的颜色是 fill,不是继承来的 color
      color: el instanceof SVGElement && s.fill && s.fill !== 'none' ? s.fill : s.color });
  }
  return out;
})()
