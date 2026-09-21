/** 行情页两节共用的那几样:本地记住用户的选择、盘口一档的类型、一档与一侧的显示。
 *
 * 2026-09-21 从 pages/Market.tsx 搬出来(函数体逐字未改)。BookBody / BookSide 放这里是因为
 * **K线 PA 那一节里也嵌着一块盘口**——两节都要画同一份快照,不该各画各的。
 */
import type { BookLevel, BookSnapshot } from '../bridge';
import { fmtMoney } from './format';
import { EmptyState, Meta } from '../ui/kit';

/** 盘口墙上的一格:要么是引擎给的那份盘口,要么是这一次读取失败留下的一句话。 */
export type BookCell = BookSnapshot | { error: string };

export function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 同上 */
  }
}

export interface Books {
  symbols: string[];
  data: Record<string, any>;
  loading: Set<string>;
  load: (symbol: string) => Promise<void>;
  refreshAll: () => Promise<void>;
  add: (raw: string) => Promise<boolean>;
  remove: (symbol: string) => void;
  /** 上面正在看的标的:不在关注里也跟着一起刷新;传空串就是不看了 */
  focus: (symbol: string) => void;
}

/** 一个标的的盘口:一档摘要 + 买卖各五档的深度梯子。上面的「盘口 · 标的」与盘口墙的卡片共用。
 *  形状在引擎契约里(engine-ts/src/contract/book.ts);读取失败时这一格存的是 { error },所以多带一个 error。 */
export function BookBody({ snapshot, loading }: { snapshot: BookCell | null; loading: boolean }) {
  if (!snapshot) return <p className="muted">{loading ? '正在读取盘口…' : '点「刷新」读取盘口。'}</p>;
  if ('error' in snapshot) return <EmptyState compact>{snapshot.error}</EmptyState>;
  // l1 / liquidity 契约保证有(引擎那头两家适配层都是先摆好这两项再往里填),不再 `|| {}` 兜一层
  const l1 = snapshot.l1;
  const liq = snapshot.liquidity;
  const hasDepth = snapshot.bids.length || snapshot.asks.length;
  return (
    <>
      <Meta
        items={[
          l1.last != null ? `最新 ${fmtMoney(l1.last)}` : null,
          l1.spread != null ? `价差 ${l1.spread}(${l1.spread_bps} bps)` : null,
          liq.spread_grade ? `流动性 ${liq.spread_grade}` : null,
          liq.bid_depth != null ? `深度 买${liq.bid_depth} / 卖${liq.ask_depth}` : null,
          liq.imbalance_pct != null ? `失衡 ${liq.imbalance_pct >= 0 ? '买盘厚' : '卖盘厚'} ${Math.abs(liq.imbalance_pct)}%${liq.l1_only ? '(仅一档)' : ''}` : null,
        ]}
      />
      <div className="row tight book-l1">
        <span className="status filled">{`买一 ${l1.bid != null ? fmtMoney(l1.bid) : '—'}${l1.bid_size ? ` ×${l1.bid_size}` : ''}`}</span>
        <span className="status rejected">{`卖一 ${l1.ask != null ? fmtMoney(l1.ask) : '—'}${l1.ask_size ? ` ×${l1.ask_size}` : ''}`}</span>
      </div>
      {hasDepth ? (
        <div className="book-grid">
          <BookSide title="买盘" levels={(snapshot.bids || []).slice(0, 5)} side="bid" />
          <BookSide title="卖盘" levels={(snapshot.asks || []).slice(0, 5)} side="ask" />
        </div>
      ) : null}
      {snapshot.note ? <div className="stock-sub">{snapshot.note}</div> : null}
    </>
  );
}

export function BookSide({ title, levels, side }: { title: string; levels: BookLevel[]; side: 'bid' | 'ask' }) {
  const maxSize = Math.max(...levels.map((l) => l.size), 1);
  return (
    <div>
      <div className="muted">{title}</div>
      {levels.map((level, i) => (
        <div className="book-row" key={i}>
          <div className={`book-bar ${side}`} style={{ width: `${Math.max((level.size / maxSize) * 100, 2)}%` }} />
          <span className="book-price">{fmtMoney(level.price)}</span>
          <span className="book-size">{String(level.size)}</span>
        </div>
      ))}
    </div>
  );
}
