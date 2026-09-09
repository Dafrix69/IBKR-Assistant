import { useEffect, useRef } from 'react';

/**
 * canvas 图表(renderer/pa-chart.js 的 DafriChart 引擎)的 React 包装。
 * 图上出现的每一条线都对应引擎算出的一个字段,这里不新算任何东西:调用方把引擎结果翻译成 spec,引擎只负责画。
 * spec 变了就整个重挂;引擎自己有 ResizeObserver,容器尺寸变化不用管。
 */
export function CanvasChart({ size, spec }: { size: 'short' | 'mid'; spec: unknown }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
    if (window.DafriChart) {
      window.DafriChart.mount(node, spec);
    } else {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = '图表模块未加载';
      node.appendChild(p);
    }
    return () => {
      while (node.firstChild) node.removeChild(node.firstChild);
    };
  }, [spec]);
  return <div ref={host} className={`chart-wrap ${size}`} />;
}
