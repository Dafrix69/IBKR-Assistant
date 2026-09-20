import { useEffect, useRef, useState } from 'react';
import { Button, Collapse } from 'antd';
import { fmtMoney } from '../lib/format';
import { legLabel, TrackCard } from '../lib/TrackCard';
import { TrackForm } from '../lib/TrackForm';
import { gatewayName, useStatus } from '../store/status';
import { loadTracker, refreshPositions, useTracker, type Position } from '../store/tracker';
import { Pill, SymBadge } from '../ui/graphics';
import { EmptyState, Notice, PageHead, Primer, SectionTitle, StatusCard } from '../ui/kit';




export function TrackerPage() {
  const status = useStatus();
  const snap = useTracker();
  const connected = Boolean(status?.broker_connected);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const trackersHead = useRef<HTMLHeadingElement>(null);

  // 进页即刷;停留期间持仓的现价与盈亏跟着行情走:IBKR 每秒读一次(读的是引擎里常驻订阅的缓存),
  // 富途每次是真的查询,5 秒一次。只读持仓,追踪列表不用跟着每秒重取
  const refreshMs = status?.broker_provider === 'futu' ? 5_000 : 1_000;
  useEffect(() => {
    void loadTracker(true);
    if (!connected) return;
    const t = setInterval(() => void refreshPositions(), refreshMs);
    return () => clearInterval(t);
  }, [connected, refreshMs]);

  /** 建完追踪后把视线带过去:滚到「正在追踪」,并把那张新卡片闪一下。 */
  function reveal(trackId: string | null) {
    trackersHead.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (!trackId) return;
    setFlashId(trackId);
    setTimeout(() => setFlashId((v) => (v === trackId ? null : v)), 1800);
  }

  const byKey = new Map(snap.positions.map((p) => [p.key, p]));
  const combos = snap.positions.filter((p) => p.sec_type === 'BAG');
  const inCombo = new Set(combos.flatMap((c) => c.legs || []));
  const singles = snap.positions.filter((p) => p.sec_type !== 'BAG' && !inCombo.has(p.key));

  return (
    <section className="tab-panel active" id="page-tracker">
      <PageHead
        title="持仓追踪"
        extra={
          <Button size="small" onClick={() => void loadTracker(true)}>
            刷新持仓
          </Button>
        }
      />
      <Notice tone="warn" title="这一页会真的发单。">
        打开「到价自动平仓」后,价格触及止盈 / 止损时软件会自动发出平仓单;仍受三道闸门约束:自动执行已打开、实盘账户需在「设置」里允许实盘下单、熔断期间不发。
        <strong>软件必须开着。</strong>盯盘在本机进行,关掉就不再盯,不同于挂在券商服务器上的条件单。
      </Notice>

      <SectionTitle>账户持仓</SectionTitle>
      <Primer id="intro-tracker" intro summary="哪些持仓会出现在这里">
        <p className="hint">
          这里只列<strong>券商账户里的实际持仓</strong>(IBKR 走 portfolio / positions,富途走持仓查询),
          且只含配置里有别名的账户。已校验未发送、排队中、已提交未成交的订单都不是持仓,不会出现在这里,也不能追踪。
        </p>
      </Primer>
      <div className="cards" id="positions">
        {snap.positionsError ? (
          <EmptyState>{snap.positionsError}</EmptyState>
        ) : !snap.positions.length ? (
          <EmptyState>{connected ? '这个账户里没有持仓。' : `连接${gatewayName(status)}之后才能读到持仓。`}</EmptyState>
        ) : (
          <>
            {/* 组合优先:一只蝴蝶就是一张卡,组合价格与盈亏在最上面,整组一个追踪表单;腿明细折叠在下面 */}
            {combos.map((combo) => {
              const legs = (combo.legs || []).map((k) => byKey.get(k)).filter((p): p is Position => Boolean(p));
              return (
                <StatusCard
                  key={combo.key}
                  title={`${combo.symbol} · ${combo.label}`}
                  extra={<Pill tint={combo.net_side === 'credit' ? 'orange' : 'indigo'}>{combo.net_side === 'credit' ? '贷方 · 收权利金' : '借方 · 付权利金'}</Pill>}
                >
                  <PositionBody p={combo} compact={false} openKey={openKey} setOpenKey={setOpenKey} onCreated={reveal} />
                  <Collapse
                    ghost
                    size="small"
                    className="combo-legs"
                    items={[
                      {
                        key: 'legs',
                        label: <span className="muted">{`腿明细(${legs.length})· 按腿追踪`}</span>,
                        children: legs.map((p) => (
                          <StatusCard key={p.key} title={p.label || legLabel(p.symbol, p.sec_type, p.contract)} extra={<Pill tint={p.quantity > 0 ? 'up' : 'down'} icon={<i className={`tri ${p.quantity > 0 ? 'up' : 'down'}`} />}>{p.quantity > 0 ? '多头' : '空头'}</Pill>}>
                            <PositionBody p={p} compact openKey={openKey} setOpenKey={setOpenKey} onCreated={reveal} />
                          </StatusCard>
                        )),
                      },
                    ]}
                  />
                </StatusCard>
              );
            })}
            {singles.map((p) => (
              <StatusCard key={p.key} title={p.label || legLabel(p.symbol, p.sec_type, p.contract)} extra={<Pill tint={p.quantity > 0 ? 'up' : 'down'} icon={<i className={`tri ${p.quantity > 0 ? 'up' : 'down'}`} />}>{p.quantity > 0 ? '多头' : '空头'}</Pill>}>
                <PositionBody p={p} compact={false} openKey={openKey} setOpenKey={setOpenKey} onCreated={reveal} />
              </StatusCard>
            ))}
          </>
        )}
      </div>

      <SectionTitle innerRef={trackersHead}>正在追踪</SectionTitle>
      {connected && snap.tracks.length ? <LoopPulse loop={snap.loop} /> : null}
      <div className="cards" id="trackers">
        {!snap.tracks.length ? (
          <EmptyState>还没有在追踪任何持仓。在上面的持仓卡片里设置止盈止损。</EmptyState>
        ) : (
          snap.tracks.map((t) => (
            <TrackCard key={t.id} t={t} live={snap.rows[t.id] || { id: t.id }} hosted={snap.hosted[t.id]} delayed={snap.delayed} connected={connected} flash={t.id === flashId} />
          ))
        )}
      </div>
    </section>
  );
}

/** 盯盘节拍器的心跳。它停了、慢了、报错了,都得在这里一眼看见——静默停摆比慢更危险。 */
function LoopPulse({ loop }: { loop: import('../store/tracker').LoopHeartbeat | null }) {
  if (!loop) return <div className="hint">盯盘节拍器:等第一轮结果…</div>;
  const stale = loop.age_ms !== null && loop.age_ms > 3_000;
  const bad = !loop.running || stale || Boolean(loop.last_error);
  const text = !loop.running
    ? '盯盘节拍器没在跑:追踪止盈与托管调价都停了'
    : loop.last_error
      ? `盯盘这一轮没做成:${loop.last_error}`
      : stale
        ? `盯盘节拍器已经 ${Math.round((loop.age_ms || 0) / 1000)} 秒没跳了`
        : `盯盘:引擎每 ${Math.round(loop.interval_ms / 100) / 10} 秒一轮 · 上一轮 ${loop.last_ms ?? '—'} ms` +
          (loop.slow_ticks ? ` · 慢过 ${loop.slow_ticks} 轮(最长 ${loop.max_ms} ms)` : '');
  return <div className={bad ? 'hint warn-text' : 'hint'} id="tracker-loop-pulse">{text}</div>;
}

// ---- 一条持仓(正股、期权腿或组合)的卡片主体:数量、成本、现价、盈亏、追踪表单 ----------------

function PositionBody({
  p,
  compact,
  openKey,
  setOpenKey,
  onCreated,
}: {
  p: Position;
  compact: boolean;
  openKey: string | null;
  setOpenKey: (k: string | null) => void;
  onCreated: (id: string | null) => void;
}) {
  const isCombo = p.sec_type === 'BAG';
  const unit = isCombo ? '组' : p.sec_type === 'OPT' ? '张' : '股';
  // 组合的成本/现价是"每组净价"(IBKR 口径含乘数的成本 → 按乘数折回每股价),借方/贷方要标出来
  const perUnit = (v: number | null | undefined) => (isCombo && v != null ? v / (p.multiplier || 100) : v);
  const open = openKey === p.key;
  const cost = perUnit(p.avg_cost);
  // 休市没有现价(个股期权没有夜盘):退到昨收估一个数,并明说它是昨收
  const stale = p.unrealized_pnl == null && p.market_price == null && p.close_price != null;
  const pnl = stale ? p.close_pnl : p.unrealized_pnl;
  const pct = stale ? p.close_pct : p.unrealized_pct;
  const dir = pnl == null || pnl === 0 ? '' : pnl > 0 ? 'up' : 'down';
  return (
    <>
      <div className={compact ? 'pos-hero compact' : 'pos-hero'}>
        {!compact ? <SymBadge symbol={p.symbol} tint={dir === 'down' ? 'down' : dir === 'up' ? 'up' : 'blue'} /> : null}
        <div className="pos-hero-main">
          <div className={`hero-num ${compact ? 'sm ' : ''}${dir}`}>{pnl == null ? '—' : `${pnl > 0 ? '+' : ''}${fmtMoney(pnl)}`}</div>
          <div className="hero-sub">
            {isCombo ? '组合未实现盈亏' : '未实现盈亏'}
            {stale ? (
              <span title="这个合约此刻休市,券商不报买卖价也没有最新成交,只有昨收。这里按昨收估算,仅供参考;追踪的触发与挂单定价不用它,开盘有报价后自动换回现价。"> · 按昨收估算(休市无报价)</span>
            ) : null}
            {p.pnl_source === 'computed' ? (
              <span title="券商这条路没报盈亏(只给了成本),这里用与追踪器同一套口径算出来;对账以券商为准。"> · 本地按现价计算</span>
            ) : null}
          </div>
        </div>
        {pct != null && dir ? (
          <Pill tint={dir === 'up' ? 'up' : 'down'} icon={<i className={`tri ${dir}`} />}>{`${Math.abs(Number(pct)).toFixed(2)}%`}</Pill>
        ) : null}
        <div className="pos-facts">
          <span>
            <em>{`${Math.abs(p.quantity)}`}</em>
            {unit}
          </span>
          <span>
            <em>{fmtMoney(cost)}</em>
            {isCombo ? (p.net_side === 'credit' ? '净收' : '净付') : '成本'}
          </span>
          <span>
            <em>{p.market_price != null ? fmtMoney(p.market_price) : stale ? fmtMoney(p.close_price) : '—'}</em>
            {stale ? (isCombo ? '组合昨收' : '昨收') : isCombo ? '组合现价' : '现价'}
          </span>
          {!compact ? (
            <span>
              <em className="txt">{p.account}</em>
              账户
            </span>
          ) : null}
        </div>
      </div>
      {p.tracked ? (
        <div className="muted">已在追踪中,设置见下方。</div>
      ) : (
        <>
          {/* 表单默认收起:十个字段摊在每张卡片里,两只持仓就是两屏表单。一次只展开一张 */}
          <div className="row tight track-toggle">
            <Button size="small" onClick={() => setOpenKey(open ? null : p.key)}>
              {open ? '收起' : '设置追踪'}
            </Button>
          </div>
          {open ? <TrackForm p={p} onCreated={onCreated} /> : null}
        </>
      )}
    </>
  );
}

/** 给一个持仓配止盈止损的表单。刻意做在卡片里——设置的对象就在眼前,不用记。 */

