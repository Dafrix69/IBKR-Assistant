import { useEffect, useRef } from 'react';
import { mountChart, type ChartHandle } from './chart/engine';
import type { ChartSpec } from './chart/spec';

export type { ChartSpec } from './chart/spec';

/**
 * 图表(lib/chart 引擎:lightweight-charts 画框架,业务叠加层自己画)的 React 包装。
 * 图上出现的每一条线都对应引擎算出的一个字段,这里不新算任何东西:调用方把引擎结果翻译成 spec。
 *
 * 图表只挂一次,之后 spec 变了走 update——不再每次拆掉重建:K线 PA 每 20 秒刷新一次,
 * 重建会把用户缩放 / 平移到的位置扔掉。尺寸变化由库自己跟。
 */
export function CanvasChart({
  size,
  spec,
  className,
  wheel = false,
}: {
  size?: 'short' | 'mid';
  spec: ChartSpec;
  /** 容器样式;缺省按 size 取 chart-wrap 的高度 */
  className?: string;
  /** 滚轮缩放。嵌在长页面里的小图保持关闭,不然鼠标经过时页面滚不动 */
  wheel?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<ChartHandle | null>(null);
  const latest = useRef(spec);

  // 先于挂载的 effect 声明:首次渲染时它先记下 spec(此时还没挂,update 是空操作),挂载拿的就是最新的
  useEffect(() => {
    latest.current = spec;
    handle.current?.update(spec);
  }, [spec]);

  useEffect(() => {
    const node = host.current;
    if (!node) return;
    handle.current = mountChart(node, latest.current, { wheel });
    return () => {
      handle.current?.destroy();
      handle.current = null;
    };
  }, [wheel]);

  return <div ref={host} className={className ?? `chart-wrap ${size ?? 'mid'}`} />;
}
