/**
 * 下单页「历史相似交易」:解析出一张订单后,在历史交易里找相似的,数胜负、按出场方式分开,再带上相关的复盘经验。
 *
 * 引擎 ideas.similar_trades 规则打分(tradeSimilar.ts),不调模型,本地出结果。**只读展示**:不拦单、不改单,
 * 也不回流到任何下单决策——看完怎么下还是你定。
 */
import { useEffect, useState } from 'react';
import { dafri, errorMessage } from '../bridge';
import type { IdeasSimilarTradesParams, IdeasSimilarTradesResult, SimilarExitStat } from '../bridge';
import type { Ticket } from './OrderTicket';
import { tradeText } from './tradeFacts';

/** 列出来的最多几笔(引擎给到 8 笔,卡片里放 5 笔就够看) */
const SHOWN = 5;

function tally(x: { win: number; loss: number; flat: number; open: number; unknown: number }): string {
  const parts = [`赚 ${x.win}`, `亏 ${x.loss}`];
  if (x.flat) parts.push(`持平 ${x.flat}`);
  if (x.open) parts.push(`未了结 ${x.open}`);
  if (x.unknown) parts.push(`结果不明 ${x.unknown}`);
  return parts.join(' · ');
}

function exitLine(e: SimilarExitStat): string {
  return `${e.exit}:${tally(e)}`;
}

export function SimilarTrades({ ticket }: { ticket: Ticket }) {
  const [res, setRes] = useState<IdeasSimilarTradesResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // 票据是解析结果里的对象,同一张单不会变;按内容做键,换了单才重取
  const key = JSON.stringify([ticket.sec_type, ticket.symbol, ticket.action, ticket.limit_price, ticket.expiry, ticket.combo_strategy, ticket.legs]);

  useEffect(() => {
    let alive = true;
    const query: IdeasSimilarTradesParams = {
      sec_type: ticket.sec_type,
      symbol: ticket.symbol,
      action: ticket.action,
      limit_price: ticket.limit_price ?? null,
      expiry: ticket.expiry ?? null,
      right: ticket.right ?? null,
      combo_strategy: ticket.combo_strategy ?? null,
      legs: (ticket.legs || []).map((l) => ({ action: l.action, ratio: l.ratio, strike: l.strike, right: l.right })),
    };
    setRes(null);
    setErr(null);
    dafri
      .similarTrades(query)
      .then((r) => alive && setRes(r))
      .catch((e: unknown) => alive && setErr(errorMessage(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 按票据内容取一次,key 就是内容
  }, [key]);

  if (err) return <div className="hint">历史相似交易取不到:{err}</div>;
  if (!res) return <div className="hint">正在找历史相似交易…</div>;
  const basis = res.basis.join(' · ');
  if (!res.count && !res.matches.length) return <div className="hint">历史里没有相似的交易(按 {basis} 比)。</div>;
  return (
    <div className="similar-trades">
      <div>
        <strong>历史相似 {res.count} 笔</strong>:{tally(res)}
        <span className="muted">(按 {basis} 比)</span>
      </div>
      {res.exits.length > 1 ? <div className="hint">{res.exits.map(exitLine).join(';')}</div> : null}
      <ul>
        {res.matches.slice(0, SHOWN).map((m) => (
          <li key={m.fact.id} title={m.reasons.join('、')}>
            {tradeText(m.fact)}
            {m.primary ? null : <span className="muted">(同板块,不算进胜负)</span>}
          </li>
        ))}
      </ul>
      {res.lessons.length ? (
        <>
          <div>相关复盘:</div>
          <ul>
            {res.lessons.map((idea) => (
              <li key={idea.id}>{idea.text.length > 90 ? `${idea.text.slice(0, 90)}…` : idea.text}</li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
