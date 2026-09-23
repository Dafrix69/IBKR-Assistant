/** 历史交易结局(引擎 tradeOutcomes 算好的事实)的排版:想法页的「对照的交易」与下单页的「历史相似交易」共用。只排版,不算。 */
import type { IdeaTradeFact, IdeaTradeResult } from '../bridge';

export const RESULT_LABEL: Record<IdeaTradeResult, string> = { win: '赚', loss: '亏', flat: '持平', open: '未了结', unknown: '结果不明' };

/** 一笔一行:日期 结构(模拟):结局 收益率 / 点数(说明) */
export function tradeText(t: IdeaTradeFact): string {
  const pct = t.return_pct === null ? '' : ` ${t.return_pct > 0 ? '+' : ''}${t.return_pct}%`;
  const pts = t.pnl_points === null || t.pnl_points === undefined ? '' : ` ${t.pnl_points > 0 ? '+' : ''}${t.pnl_points} 点/份`;
  return `${t.opened_at.slice(0, 10)} ${t.label}${t.paper ? '(模拟)' : ''}:${RESULT_LABEL[t.result]}${pct}${pts}${t.note ? `(${t.note})` : ''}`;
}
