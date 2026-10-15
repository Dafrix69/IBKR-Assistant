/**
 * 「应对」:事件公布之前先把一句对冲指令写好。只写进指令框——发不发、什么时候发,还是「解析并校验」「发送」那两个按钮和那个确认框的事。
 *
 * 两种结构都是解析器认得的写法(lib/eventRules.hedgeInstruction):买 put 价差(借方,最大亏损 = 权利金)、卖 call 价差(贷方 bear call)。
 * 现价:SPX 从测算面板那一路取(store/spot);别的标的自己填。
 */
import { useEffect, useState } from 'react';
import { Button, Input, InputNumber, Modal, Segmented, Space } from 'antd';
import { CROSS_MARKETS, countdownText, hedgeExpiryFor, hedgeInstruction, whenText, type CrossMarketEvent, type HedgeKind } from './eventRules';
import { showBanner } from '../store/banner';
import { etToday, useEvents, type RuleEvent } from '../store/events';
import { navigate } from '../store/nav';
import { useSpot } from '../store/spot';
import { appendInstruction, setTradePane } from '../store/trade';
import { Notice } from '../ui/kit';

const KIND_OPTIONS: { label: string; value: HedgeKind }[] = [
  { label: '买 put 价差(借方)', value: 'put_spread' },
  { label: '卖 call 价差(贷方)', value: 'bear_call' },
  { label: '卖空正股 / ETF', value: 'short_stock' },
];

/** 美东常规时段(周一到周五 09:30 ~ 16:00)之外,正股指令要加「盘外」且必须是限价 */
function outsideRth(now: number): boolean {
  const d = new Date(now);
  const parts = d.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  const m = /(\w{3}),?\s+(\d{2}):(\d{2})/.exec(parts);
  if (!m) return true;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === 'Sat' || m[1] === 'Sun' || minutes < 9 * 60 + 30 || minutes >= 16 * 60;
}

export function EventActions({ event, onClose }: { event: RuleEvent; onClose: () => void }) {
  const { now, list } = useEvents();
  const spot = useSpot();
  const today = etToday(now);
  // 跨市场那条:默认做空韩股的 3 倍 ETF(用户原话「做空 KORU」);跌是做空,涨是做多——做多正股助手不写,人自己改
  const cross = event.kind === 'cross' ? (event as CrossMarketEvent).cross : null;
  const [symbol, setSymbol] = useState(cross ? 'KORU' : 'SPX');
  const [manualSpot, setManualSpot] = useState('');
  const [kind, setKind] = useState<HedgeKind>(cross ? 'short_stock' : 'put_spread');
  const [width, setWidth] = useState<number | null>(25);
  const [qty, setQty] = useState<number | null>(cross ? 100 : 1);
  const [price, setPrice] = useState<number | null>(null);
  const [expiry, setExpiry] = useState(() => hedgeExpiryFor(event, today));
  const [reason, setReason] = useState(cross ? `美股${cross.direction === 'down' ? '大跌' : '大涨'} ${cross.us_pct}%,亚洲开盘前跟${cross.direction === 'down' ? '跌' : '涨'}` : `${event.title} 前对冲`);
  const outside = outsideRth(now);

  // 换到别的标的:现价得自己填;宽度按常见档距换
  useEffect(() => {
    if (symbol.trim().toUpperCase() === 'SPX') setWidth(25);
  }, [symbol]);

  const isSpx = symbol.trim().toUpperCase() === 'SPX';
  const liveSpot = isSpx && spot.quote && (spot.quote.source === 'quote' || spot.quote.source === 'futures') ? spot.quote.price : null;
  const spotValue = manualSpot.trim() ? Number(manualSpot) : liveSpot;
  const out = hedgeInstruction({
    symbol, spot: Number.isFinite(spotValue as number) ? (spotValue as number) : null, kind, width: width ?? 0, qty: qty ?? 0, expiry, todayEt: today, reason,
    price, outside,
  });
  const stock = kind === 'short_stock';
  const leads = list?.config.lead_minutes ?? [];

  function write() {
    if (out.problem) return;
    appendInstruction(out.text);
    setTradePane('result');
    navigate('trade');
    showBanner('已写进指令框。先点「解析并校验」核对腿与权利金,再决定发不发。', true);
    onClose();
  }

  return (
    <Modal open title={`应对:${event.title}`} onCancel={onClose} footer={null} width={560} destroyOnHidden>
      <div className="event-actions">
        <p className="event-actions-when">
          {whenText(event.at, now)}(美东 {event.time_et}),{countdownText(event, now)}。
          {leads.length ? `公布前 ${leads.join(' / ')} 分钟会弹窗提醒,公布那一刻再提醒一次。` : '公布那一刻会弹窗提醒。'}
        </p>
        {(event.items ?? []).filter((i) => i.forecast || i.previous).length ? (
          <ul className="event-actions-facts">
            {(event.items ?? []).filter((i) => i.forecast || i.previous).map((i) => (
              <li key={i.title}>{i.title}:预期 {i.forecast || '—'},前值 {i.previous || '—'}</li>
            ))}
          </ul>
        ) : null}
        {cross ? (
          <Notice tone="warn" title="跟跌 / 跟涨常有时间差,但不是一定">
            {event.note} 下面这句只写进指令框,不会自己发出去;卖空的限价自己看 TWS 的盘口填。
            <div className="event-cross-chips">
              {CROSS_MARKETS.flatMap((m) => m.symbols.map((s) => (
                <Button key={s} size="small" type={symbol.toUpperCase() === s ? 'primary' : 'default'} onClick={() => { setSymbol(s); setKind('short_stock'); }}>{m.name} {s}</Button>
              )))}
            </div>
          </Notice>
        ) : (
          <Notice tone="warn" title="公布前后指数常有跳空">
            当日到期的蝶可能直接穿出翼;持仓追踪的止损按可成交价判也追不上一个跳空。要对冲、减仓或干脆不开,都趁公布之前。
            下面这句只写进指令框,不会自己发出去。
          </Notice>
        )}
        <div className="event-hedge">
          <div className="fly-row">
            <label><span>标的</span><Input size="small" style={{ width: 80 }} value={symbol} onChange={(e) => setSymbol(e.target.value)} /></label>
            {/* 卖空正股不用现价(限价由人填);label 的 display:flex 会盖过 hidden,所以不渲染而不是藏起来 */}
            {stock ? null : (
              <label title={isSpx && liveSpot ? `实时(${spot.quote?.source === 'futures' ? '期货推算' : '指数'})` : '没连券商或不是 SPX 时自己填'}>
                <span>现价</span>
                <Input size="small" style={{ width: 96 }} value={manualSpot} placeholder={liveSpot ? String(liveSpot) : '自己填'} onChange={(e) => setManualSpot(e.target.value)} />
              </label>
            )}
            {stock ? (
              <>
                <label><span>股数</span><InputNumber size="small" style={{ width: 80 }} min={1} step={100} value={qty} onChange={(v) => setQty(v === null ? null : Number(v))} /></label>
                <label title={outside ? '现在是常规时段之外:指令里会加「盘外」,必须限价' : '常规时段里;照样写限价,不写市价'}>
                  <span>限价{outside ? '(盘外)' : ''}</span>
                  <InputNumber size="small" style={{ width: 96 }} min={0.01} step={0.1} value={price} placeholder="看 TWS 盘口" onChange={(v) => setPrice(v === null ? null : Number(v))} />
                </label>
              </>
            ) : (
              <>
                <label><span>宽度(点)</span><InputNumber size="small" style={{ width: 72 }} min={0.5} step={isSpx ? 5 : 1} value={width} onChange={(v) => setWidth(v === null ? null : Number(v))} /></label>
                <label><span>张数</span><InputNumber size="small" style={{ width: 64 }} min={1} step={1} value={qty} onChange={(v) => setQty(v === null ? null : Number(v))} /></label>
                <label><span>到期日</span><Input size="small" style={{ width: 116 }} value={expiry} onChange={(e) => setExpiry(e.target.value)} /></label>
              </>
            )}
          </div>
          <div className="fly-row">
            <Segmented
              size="small"
              options={KIND_OPTIONS}
              value={kind}
              onChange={(v) => {
                setKind(v as HedgeKind);
                // 期权按张、正股按股:从价差切到卖空时 1 张变成 1 股没有意义,给个常见的起点
                if (v === 'short_stock' && (qty ?? 0) < 100) setQty(100);
              }}
            />
            <label className="event-hedge-reason"><span>理由</span><Input size="small" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          </div>
          {out.problem ? (
            <p className="muted">{out.problem}</p>
          ) : (
            <>
              <p className="event-hedge-legs muted">{out.legs}。{stock ? '' : '不写权利金,按下单时的盘口中间价(AUTO_MID)挂。'}</p>
              <pre className="event-hedge-text">{out.text}</pre>
            </>
          )}
        </div>
        <Space className="event-actions-foot">
          <Button onClick={onClose}>关闭</Button>
          <Button type="primary" disabled={Boolean(out.problem)} onClick={write}>写进指令框</Button>
        </Space>
      </div>
    </Modal>
  );
}
