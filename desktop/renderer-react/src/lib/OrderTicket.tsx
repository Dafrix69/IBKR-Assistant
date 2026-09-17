/**
 * 订单票据:把一笔解析出来的订单画成"票"——方向徽章、标的、数量 × 价、合约要素;
 * 期权(单腿 / 组合)再画一张到期损益图,各腿排成一行小胶囊。
 *
 * 数据来自引擎摘要里的 ticket(engine.ts 的 orderTicket):只读展示,界面不拿它做任何判断。
 * 老记录 / 老引擎没有 ticket 时调用方退回一行文字,不在这里猜。
 */
import { fmtExpiry, fmtMoney } from './format';
import { PayoffAxis, PayoffChart, Pill, SymBadge, type PayoffLeg } from '../ui/graphics';

export interface TicketLeg {
  action: 'BUY' | 'SELL';
  ratio: number;
  strike: number;
  right: 'C' | 'P';
}

export interface Ticket {
  sec_type: 'STK' | 'OPT' | 'BAG' | string;
  symbol: string;
  action: 'BUY' | 'SELL';
  quantity: number;
  order_type: string;
  price_mode?: string;
  limit_price?: number | null;
  aux_price?: number | null;
  trailing_percent?: number | null;
  tif?: string;
  expiry?: string | null;
  strike?: number | null;
  right?: 'C' | 'P' | null;
  multiplier?: number;
  combo_strategy?: string | null;
  legs?: TicketLeg[];
  trigger?: { symbol: string; operator: string; value: number } | null;
}

const COMBO_NAME: Record<string, string> = { VERTICAL: '垂直价差', BUTTERFLY: '蝴蝶', IRON_CONDOR: '铁鹰' };
const ORDER_TYPE_NAME: Record<string, string> = { MKT: '市价', LMT: '限价', STP: '止损', 'STP LMT': '止损限价', TRAIL: '跟踪止损' };

export function isTicket(v: unknown): v is Ticket {
  return Boolean(v && typeof v === 'object' && typeof (v as Ticket).symbol === 'string' && typeof (v as Ticket).action === 'string');
}

/** 票据上的各腿 → 损益图的腿。整单是 SELL 时每条腿的方向整体反过来。 */
function payoffLegs(t: Ticket): PayoffLeg[] {
  const flip = t.action === 'SELL' ? -1 : 1;
  if (t.sec_type === 'OPT' && t.strike != null && t.right) return [{ sign: flip as 1 | -1, right: t.right, strike: t.strike }];
  if (t.sec_type !== 'BAG') return [];
  return (t.legs || []).map((l) => ({ sign: ((l.action === 'BUY' ? 1 : -1) * flip) as 1 | -1, right: l.right, strike: l.strike, ratio: l.ratio }));
}

function priceText(t: Ticket): string {
  if (t.order_type === 'MKT') return '市价';
  if (t.price_mode === 'AUTO_MID') return '中间价';
  if (t.order_type === 'TRAIL') return t.trailing_percent != null ? `${t.trailing_percent}%` : fmtMoney(t.aux_price);
  if (t.order_type === 'STP') return fmtMoney(t.aux_price);
  return fmtMoney(t.limit_price);
}

export function OrderTicket({ ticket: t, spot }: { ticket: Ticket; spot?: number | null }) {
  const buy = t.action === 'BUY';
  const unit = t.sec_type === 'STK' ? '股' : t.sec_type === 'BAG' ? '组' : '张';
  const legs = payoffLegs(t);
  // 建仓付出的净权利金:买入付、卖出收。只有明确给了限价才画得出盈亏平衡,市价 / 中间价只画形状
  const premium = t.limit_price != null && t.order_type === 'LMT' ? (buy ? t.limit_price : -t.limit_price) : null;
  const kind = t.sec_type === 'BAG' ? COMBO_NAME[t.combo_strategy || ''] || '组合' : t.sec_type === 'OPT' ? (t.right === 'C' ? '看涨期权' : '看跌期权') : '正股';
  return (
    <div className="ticket">
      <div className="ticket-head">
        <SymBadge symbol={t.symbol} tint={buy ? 'up' : 'down'} />
        <div className="ticket-title">
          <div className="ticket-sym">
            {t.symbol}
            <Pill tint={buy ? 'up' : 'down'}>
              {buy ? '买入' : '卖出'}
            </Pill>
          </div>
          <div className="hero-sub">
            {kind}
            {t.sec_type === 'OPT' && t.strike != null ? ` · ${t.strike}${t.right}` : ''}
            {t.expiry ? ` · ${fmtExpiry(t.expiry)}` : ''}
          </div>
        </div>
        <div className="ticket-nums">
          <span>
            <em>{t.quantity}</em>
            {unit}
          </span>
          <i className="ticket-times" aria-hidden="true">
            ×
          </i>
          <span>
            <em>{priceText(t)}</em>
            {ORDER_TYPE_NAME[t.order_type] || t.order_type}
            {t.tif && t.tif !== 'DAY' ? ` · ${t.tif}` : ''}
          </span>
        </div>
      </div>
      {t.trigger ? (
        <div className="ticket-trigger">
          <Pill tint="orange" dot>
            条件单
          </Pill>
          <span>{`${t.trigger.symbol} ${t.trigger.operator} ${t.trigger.value} 时触发`}</span>
        </div>
      ) : null}
      {legs.length ? (
        <>
          {t.sec_type === 'BAG' ? (
            <div className="ticket-legs">
              {[...legs]
                .sort((a, b) => a.strike - b.strike)
                .map((l, i) => (
                  <Pill key={i} tint={l.sign > 0 ? 'up' : 'down'}>
                    {`${l.sign > 0 ? '+' : '−'}${l.ratio || 1} · ${l.strike}${l.right}`}
                  </Pill>
                ))}
            </div>
          ) : null}
          <div className="payoff-wrap">
            <PayoffChart legs={legs} premium={premium} spot={spot} />
            <PayoffAxis legs={legs} spot={spot} />
          </div>
          <div className="hero-sub">{premium != null ? '到期损益(按限价计入权利金):绿色一段赚,红色一段亏' : '到期损益的形状(没有明确限价,未计权利金)'}</div>
        </>
      ) : null}
    </div>
  );
}

/** 记录详情里存的是完整的 contract / order(ParsedOrder 的原样),压成同一张票据。字段不全就不画。 */
export function ticketFromRecord(contract: any, order: any, trigger?: any): Ticket | null {
  if (!contract?.symbol || !order?.action || !order?.totalQuantity) return null;
  const legs: TicketLeg[] = Array.isArray(contract.legs)
    ? contract.legs.filter((l: any) => l && Number.isFinite(Number(l.strike)) && (l.right === 'C' || l.right === 'P')).map((l: any) => ({ action: l.action, ratio: Number(l.ratio) || 1, strike: Number(l.strike), right: l.right }))
    : [];
  return {
    sec_type: contract.secType,
    symbol: contract.symbol,
    action: order.action,
    quantity: Number(order.totalQuantity),
    order_type: order.orderType,
    price_mode: order.price_mode,
    limit_price: order.lmtPrice ?? null,
    aux_price: order.auxPrice ?? null,
    trailing_percent: order.trailingPercent ?? null,
    tif: order.tif,
    expiry: contract.lastTradeDateOrContractMonth ?? contract.legs?.[0]?.lastTradeDateOrContractMonth ?? null,
    strike: contract.strike != null ? Number(contract.strike) : null,
    right: contract.right ?? null,
    combo_strategy: contract.combo_strategy ?? null,
    legs,
    trigger: trigger?.symbol ? { symbol: trigger.symbol, operator: trigger.operator, value: trigger.value } : null,
  };
}
