import { useState } from 'react';
import { BookWall, useBooks } from '../lib/BookWall';
import { PaPanel } from '../lib/PaPanel';
import { PageHead } from '../ui/kit';

// 行情:一页看一个标的——K 线 + 价格行为读盘(判断由引擎算、权重公开),图下面就是它的盘口(深度梯子,只读);
// 页面下半是「关注的盘口」,同时盯几个标的的价差与深度,点代码就把它换成上面正在看的那个。
// 原来是「K线 PA / 订单簿」两个子页、各填各的标的;看图的人下一眼要看的就是这只票的盘口,分两页等于同一个代码敲两遍。

export function MarketPage() {
  const books = useBooks();
  // 盘口墙上点了哪个代码:带序号,同一个代码连点两次也算两次
  const [pick, setPick] = useState<{ symbol: string; seq: number } | null>(null);
  return (
    <section className="tab-panel active" id="page-market">
      <PageHead title="行情" />
      <PaPanel books={books} pick={pick} />
      <BookWall books={books} onAnalyze={(symbol) => setPick((p) => ({ symbol, seq: (p?.seq || 0) + 1 }))} />
    </section>
  );
}


