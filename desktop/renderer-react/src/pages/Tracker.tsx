import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Collapse, InputNumber, Select, Space, Switch } from 'antd';
import { dafri, errorMessage, type TrackerAddSpec } from '../bridge';
import { fmtMoney, fmtNum } from '../lib/format';
import { showBanner } from '../store/banner';
import { loadRecords } from '../store/records';
import { gatewayName, pickableAccounts, useStatus } from '../store/status';
import { loadTracker, refreshPositions, useTracker, type LiveRow, type Position, type SpotTargetRow, type Track, type TrackTargets } from '../store/tracker';
import { Pill, PriceRail, Ring, SymBadge, type Tint } from '../ui/graphics';
import { EmptyState, Meta, Notice, PageHead, Primer, SectionTitle, StatusCard, type Tone } from '../ui/kit';

/** σ 是从哪来的,用人话说一遍。clock 那一档必须显眼——它是模型默认值,不是市场价。 */
const SIGMA_SOURCE_HINT: Record<string, string> = {
  none: '正股:目标价就是价格,不用波动率',
  smile: '每条腿按各自当前的报价反解波动率,在目标价处各自重估',
  net: '按这份持仓当前的报价反解波动率',
  leg: '有腿缺报价,按最贴近平值那条腿的波动率给所有腿用',
  clock: '拿不到市场报价,用的是模型默认波动率(EM×√剩余方差)——不是市场价,只当个参考',
};

const TRACK_STATE_LABEL: Record<string, string> = {
  holding: '持有中',
  take_profit: '止盈已触发',
  profit_trail: '利润回撤已触发',
  stop_loss: '止损已触发',
  closed: '持仓已不在',
  // 触发了、正在把托管单改到立刻成交的价往下追(见引擎 sweepReason)
  'sweep:take_profit': '到了目标价,追价平仓中',
  'sweep:stop_loss': '止损触发,追价平仓中',
  'sweep:profit_trail': '利润回撤触发,追价平仓中',
};

/** 盈亏的颜色和符号。0 不着色——把 0 画成绿色会让人以为赚了。 */
function Pnl({ value, pct }: { value: number | null | undefined; pct?: number | string | null }) {
  if (value === null || value === undefined) return <span className="muted">—</span>;
  const up = value > 0;
  const cls = value === 0 ? 'muted' : up ? 'pnl-up' : 'pnl-down';
  const sign = up ? '+' : '';
  return (
    <span className={cls}>
      {`${sign}${fmtMoney(value)}`}
      {pct !== null && pct !== undefined ? <span className="pnl-pct">{` ${sign}${pct}%`}</span> : null}
    </span>
  );
}

/** 期权腿显示成票面样子:SPX 7615P 2026-09-01;组合用引擎给的组合名。 */
function legLabel(symbol: string, secType: string, contract?: Record<string, unknown>): string {
  const c = contract || {};
  if (secType === 'BAG') return c.label ? `${symbol} · ${c.label}` : `${symbol} 组合`;
  if (secType !== 'OPT' && secType !== 'FOP') return symbol;
  let expiry = String(c.lastTradeDateOrContractMonth || '').slice(0, 8);
  if (expiry.length === 8) expiry = `${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6)}`;
  const strike = c.strike != null ? String(Number(c.strike)) : '';
  const right = String(c.right || '').slice(0, 1).toUpperCase();
  return [symbol, strike + right, expiry].filter((s) => s.trim()).join(' ');
}

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
function TrackForm({ p, onCreated }: { p: Position; onCreated: (id: string | null) => void }) {
  const status = useStatus();
  const long = p.quantity > 0;
  const isCombo = p.sec_type === 'BAG';
  const [tp, setTp] = useState<number | null>(null);
  const [sl, setSl] = useState<number | null>(null);
  const [trail, setTrail] = useState<number | null>(null);
  const [profitDd, setProfitDd] = useState<number | null>(null);
  const [tiers, setTiers] = useState(false);
  const [spotTarget, setSpotTarget] = useState<number | null>(null);
  // 试算结果和它算的那个目标价绑在一起:改了目标价、防抖还没跑完的那几百毫秒里,
  // 旧结果必须立刻失效——否则用户同意的是上一个目标价的数,发出去的是新的。
  const [preview, setPreview] = useState<{ target: number; row: SpotTargetRow } | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [fraction, setFraction] = useState<number | null>(null);
  // 追价平仓最多让到自然价的百分之几(期权 / 组合);空 = 引擎默认 10%
  const [chaseMax, setChaseMax] = useState<number | null>(null);
  const [auto, setAuto] = useState(false);
  const [orderType, setOrderType] = useState<'MKT' | 'LMT'>(isCombo ? 'LMT' : 'MKT');
  const [host, setHost] = useState(false);
  const [saving, setSaving] = useState(false);

  const acct = pickableAccounts(status).find((a) => a.alias === p.account);
  const isPaper = acct ? acct.is_paper : true;
  const hasSpotTarget = spotTarget !== null && spotTarget > 0;
  // 只认算的就是当前这个目标价的那一份;对不上就当没有
  const priced = hasSpotTarget && preview?.target === spotTarget ? preview.row : null;
  // 组合在券商那边只托管一张限价止盈单,价由标的目标价现算——没填目标价就开不了(引擎 checkTargets
  // 同一条规矩)。止损、利润回撤照样能设:软件盯着,触发时把那张托管单改到立刻成交的价
  const hostAllowed = !isCombo || hasSpotTarget;
  const hostOn = host && hostAllowed;
  const derivative = isCombo || p.sec_type === 'OPT' || p.sec_type === 'FOP';
  const str = (v: number | null) => (v === null || v === undefined ? '' : String(v));

  // 填标的目标价的时候就把「那时值多少、赚多少」摆出来:这个数就是将要挂出去的限价,
  // 得让人在按下按钮之前看见它。防抖 400ms——每敲一个字符打一次行情请求没必要。
  useEffect(() => {
    if (spotTarget === null || !(spotTarget > 0)) {
      setPreview(null);
      setPreviewErr(null);
      return;
    }
    let alive = true;
    const target = spotTarget;
    setPreview(null);          // 目标价一变,旧的数当场作废,不给"看着还在"的错觉
    setPreviewErr(null);
    const t = setTimeout(async () => {
      try {
        const res = await dafri.previewSpotTarget(p.key, target, chaseMax);
        if (!alive) return;
        const row = res?.spot_target || null;
        setPreview(row?.price != null ? { target, row } : null);
        setPreviewErr(row?.price != null ? null : row?.reason || '这一刻算不出这个点位的价格。');
      } catch (err) {
        if (!alive) return;
        setPreview(null);
        setPreviewErr(errorMessage(err));
      }
    }, 400);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [p.key, spotTarget, chaseMax]);

  async function start() {
    // 标上契约类型:这个字面量里写错一个键名(或引擎契约改了键名)就编译不过,而不是追踪建成了、那道保护没设上
    const spec: TrackerAddSpec = {
      key: p.key,
      take_profit: hasSpotTarget ? '' : str(tp),
      stop_loss: str(sl),
      trail_pct: str(trail),
      profit_drawdown_pct: tiers ? '' : str(profitDd),
      profit_drawdown_preset: tiers ? 'fly' : undefined,
      spot_target: str(spotTarget),
      close_fraction_pct: str(fraction) || undefined,
      chase_max_pct: str(chaseMax) || undefined,
      auto_close: auto,
      order_type: orderType,
      host_at_broker: hostOn,
    };
    if (spec.host_at_broker && !spec.auto_close) {
      // 托管单就是授权发单——没有总开关的托管是自相矛盾的设置
      showBanner('托管到券商需先打开「到价自动平仓」:挂托管单即发单授权。', false);
      return;
    }
    // 「同意价格后发单」:同意的那一刻现取一次价,不拿几秒前那份凑数。
    // 算不出来就不往下走——盲签一张会真发出去的单,比不发危险得多。
    let quoted: SpotTargetRow | null = null;
    if (hasSpotTarget && (spec.auto_close || spec.host_at_broker)) {
      setSaving(true);
      try {
        const res = await dafri.previewSpotTarget(p.key, spotTarget!, chaseMax);
        quoted = res?.spot_target || null;
      } catch (err) {
        showBanner(errorMessage(err), false);
        setSaving(false);
        return;
      } finally {
        setSaving(false);
      }
      if (quoted?.price == null) {
        showBanner(quoted?.reason || `这一刻算不出 ${p.symbol} 到 ${spotTarget} 的价格,先别发单。`, false);
        return;
      }
      if (quoted.sigma_source === 'clock') {
        // 能同意的只有市场价算出来的数;模型默认波动率算的参考价没有人能替你担保
        showBanner('现在拿不到市场报价,这个价是按模型默认波动率算的参考值,不能拿它发单。等行情来了再设。', false);
        return;
      }
      if (quoted.warning) {
        showBanner(quoted.warning, false);
        return;
      }
    }
    // 要同意的那句话:先说价,再说它之后会怎么动
    const priceLine = quoted
      ? (quoted.spot_note ? `现价 ${quoted.spot != null ? fmtNum(quoted.spot) : '—'}:${quoted.spot_note}\n` : '') +
        `${p.symbol} 到 ${fmtNum(spotTarget)} → ${isCombo ? '组合净价' : '价格'}约 ${fmtMoney(quoted.price)}` +
        `,预估收益 ${fmtMoney(quoted.pnl)}\n` +
        `这个价按当前波动率算出来,软件开着时每秒重算并改单——标的真走到 ${fmtNum(spotTarget)} 时\n` +
        `挂的就是那一刻的价,不是现在这个数。\n` +
        (derivative
          ? `标的真到了 ${fmtNum(spotTarget)}(软件开着时按秒盯),不等${isCombo ? '组合' : '期权'}价追上来,` +
            '直接按各腿当时的买卖价挂立刻成交的价平掉,没成交就每秒再追。\n'
          : '')
      : '';
    if (spec.host_at_broker) {
      const ok = await dafri.confirm({
        title: quoted ? '确认这个止盈价位,并挂到券商' : '托管到券商服务器',
        message: quoted
          ? `${p.symbol} 到 ${fmtNum(spotTarget)} 就走,现在算下来约 ${fmtMoney(quoted.price)}。`
          : `${p.symbol} 的止盈/止损将作为 GTC 单挂在券商服务器上。`,
        detail:
          priceLine +
          `数量 ${Math.abs(p.quantity)} · 账户 ${p.account}\n` +
          '这张 GTC 限价单会立刻挂到券商服务器上;软件关闭后它仍然有效,价格停在最后一次调整的位置。\n' +
          '触发由券商实时行情决定,一张成交其余自动撤销(OCA)。',
        confirmLabel: quoted ? '同意这个价,挂单' : '我确认',
      });
      if (!ok) return;
    } else if (spec.auto_close) {
      // 这一步是在授权软件替你发单,值得一次明确的确认
      const ok = await dafri.confirm({
        title: quoted ? '确认这个止盈价位,并开启自动平仓' : '开启到价自动平仓',
        message: quoted
          ? `${p.symbol} 到 ${fmtNum(spotTarget)} 就走,现在算下来约 ${fmtMoney(quoted.price)}。`
          : `${p.symbol} 到价后会自动发出平仓单,不再询问。`,
        detail: priceLine +
          `数量 ${Math.abs(p.quantity)} · 账户 ${p.account} · ${orderType === 'MKT' ? '市价平仓' : '限价平仓'}\n软件关闭后不再盯盘。`,
        confirmLabel: quoted ? '同意这个价,开始追踪' : '我确认',
      });
      if (!ok) return;
    }
    setSaving(true);
    try {
      const created = await dafri.addTracker(spec);
      showBanner(`已开始追踪 ${p.symbol},下面「正在追踪」里可以看盯盘进度。`, true);
      await loadTracker(true);
      onCreated(created?.track?.id || null);
    } catch (err) {
      showBanner(errorMessage(err), false);
    } finally {
      setSaving(false);
    }
  }

  const num = (props: { label: string; hint: string; value: number | null; onChange: (v: number | null) => void; disabled?: boolean; autoFocus?: boolean }) => (
    <label className="track-field">
      <span>{props.label}</span>
      <InputNumber
        min={0}
        step={0.01}
        placeholder={props.hint}
        value={props.value}
        disabled={props.disabled}
        autoFocus={props.autoFocus}
        onChange={(v) => props.onChange(v === null || v === undefined ? null : Number(v))}
      />
    </label>
  );

  return (
    <div className="track-form">
      {/* 标的目标价:人心里想的止盈位是**标的**走到哪儿,不是这份持仓值多少。
          换算成价格由引擎每轮现算——同一个目标位,上午和尾盘对应的期权价差着一倍。 */}
      <label className="track-field">
        <span>
          标的目标价({p.symbol})
          <span className="sub">填标的走到哪儿就走;止盈价按当前波动率每秒现算,不用自己估</span>
        </span>
        <InputNumber
          min={0}
          step={1}
          placeholder={`${p.symbol} 走到多少`}
          value={spotTarget}
          onChange={(v) => setSpotTarget(v === null || v === undefined ? null : Number(v))}
        />
      </label>
      {spotTarget !== null && spotTarget > 0 ? (
        <div className="track-preview">
          {priced ? (
            <>
              <Meta
                items={[
                  `${p.symbol} 到 ${fmtNum(spotTarget)}`,
                  <span className="strong">{`${isCombo ? '组合净价' : '约值'} ${fmtMoney(priced.price)}`}</span>,
                  <span className={(priced.pnl ?? 0) >= 0 ? 'pnl-up' : 'pnl-down'}>
                    {`预估收益 ${(priced.pnl ?? 0) >= 0 ? '+' : ''}${fmtMoney(priced.pnl)}`}
                    {priced.pnl_pct != null ? ` (${Number(priced.pnl_pct).toFixed(1)}%)` : ''}
                  </span>,
                ]}
              />
              {priced.warning ? <div className="hint warn-text">{priced.warning}</div> : null}
              {priced.natural != null ? (
                <div className="hint">
                  {`现在立刻平掉约 ${fmtMoney(priced.natural)}(按各腿当前买卖价;标的到了目标价、或止损类目标触发时,平仓单会改到这个口径的价追着平)`}
                  {priced.chase_floor != null
                    ? `;追价先在这个价上等两秒,之后每秒再让一跳,最多让到 ${fmtMoney(priced.chase_floor)}(${priced.chase_max_pct ?? 10}%)`
                    : ''}
                </div>
              ) : null}
              <div className={priced.sigma_source === 'clock' ? 'hint warn-text' : 'hint'}>
                {SIGMA_SOURCE_HINT[priced.sigma_source || ''] || ''}
                {priced.leg_sigmas
                  ? ` · σ_剩余 ${Object.entries(priced.leg_sigmas).map(([k, v]) => `${k} ${fmtNum(v)}`).join(' / ')} 点`
                  : priced.sigma != null ? ` · σ_剩余 ${fmtNum(priced.sigma)} 点` : ''}
              </div>
              {priced.spot_note ? (
                <div className="hint">{`${p.symbol} 现价 ${priced.spot != null ? fmtNum(priced.spot) : '—'}:${priced.spot_note}`}</div>
              ) : null}
              {priced.sigma_source === 'clock' ? (
                <div className="hint warn-text">这个价只能参考:拿不到市场报价,不能拿它开自动平仓或挂单。</div>
              ) : null}
            </>
          ) : (
            <div className="hint">{previewErr || '正在按当前行情试算…'}</div>
          )}
        </div>
      ) : null}
      {/* 填了标的目标价,止盈价就由引擎每轮现算——把它禁掉,免得人以为自己填的那个数说了算 */}
      {num({
        label: '止盈价',
        hint: hasSpotTarget ? '由上面的标的目标价现算' : long ? '高于现价' : '低于现价',
        value: hasSpotTarget ? null : tp,
        onChange: setTp,
        disabled: hasSpotTarget,
        autoFocus: true,
      })}
      {num({ label: '止损价', hint: long ? '低于现价' : '高于现价', value: sl, onChange: setSl })}
      {/* 两个"追踪"是不同刻度,标签必须自解释:价格回撤 5% 在利润口径上会被成本杠杆放大 */}
      {num({ label: '跟踪止损 %(按价格)', hint: '价格从峰值回落 N%,全平', value: trail, onChange: setTrail })}
      {num({ label: '利润回撤 %(按利润)', hint: '利润从峰值缩水 N%', value: profitDd, onChange: setProfitDd, disabled: tiers })}
      <label className="switch-row">
        <span className="group-label">
          分档利润回撤(蝶式 40/30/20)
          <span className="sub">按浮盈相对成本的倍数换档:&lt;1× 让 40%、1–3× 让 30%、≥3× 让 20%,15:00 后一律减半。勾上就不看上面那个固定百分比</span>
        </span>
        <Switch
          checked={tiers}
          onChange={(v) => {
            setTiers(v);
            if (v) setProfitDd(null);
          }}
        />
      </label>
      {/* 触发后平掉多少仓位:100 = 全平,50 = 卖一半锁利。向下取整,绝不超过持仓 */}
      {num({ label: '触发后平仓比例 %', hint: '默认 100 全平,50=卖一半', value: fraction, onChange: setFraction })}
      {/* 追价平仓的让价上限:触发后平仓单先挂在立刻成交价上等两秒,之后每秒再让一跳,让到这个比例为止 */}
      {p.sec_type !== 'STK'
        ? num({ label: '追价最多让价 %', hint: '默认 10;触发后先挂立刻成交价等两秒,之后每秒再让一跳,让到这里为止(至少两跳)', value: chaseMax, onChange: setChaseMax })
        : null}
      <label className="switch-row">
        <span className="group-label">
          到价自动平仓
          <span className="sub">到价即自动发平仓单,不再询问;仍受自动执行、实盘开关、熔断三道闸门约束</span>
        </span>
        <Switch checked={auto} onChange={setAuto} />
      </label>
      <label className="track-field">
        <span>平仓方式</span>
        <Select
          value={orderType}
          disabled={isCombo}
          onChange={(v) => setOrderType(v)}
          options={[
            { value: 'MKT', label: '市价(一定成交)' },
            { value: 'LMT', label: '限价(控价,可能不成交)' },
          ]}
        />
      </label>
      {/* 托管到券商:GTC+OCA 挂在 IBKR 服务器,关机也生效;富途账户引擎会当场拒绝 */}
      <label className="switch-row">
        <span className="group-label">
          止盈/止损托管到券商(IBKR)
          <span className="sub">
            {isCombo
              ? hasSpotTarget
                ? '券商那边挂一张限价止盈单,价按上面的标的目标价每秒现算、原地改;GTC,关机也有效。止损、利润回撤由软件盯着——它们触发,或标的真到了目标价,软件把这张单改到立刻成交的价平掉(软件开着时)'
                : '组合要先填上面的「标的目标价」才能托管:托管的就是按它算出来的那张限价止盈单'
              : 'GTC 单挂在券商服务器,关机也触发,不受本机轮询与行情延迟影响。利润回撤为动态停损,软件开着时按秒调整,关掉则停在最后价位'}
          </span>
        </span>
        <Switch checked={hostOn} disabled={!hostAllowed} onChange={setHost} />
      </label>
      {isCombo ? (
        <div className="muted combo-note">
          <div>
            组合按整组净价触发。平仓会发一张腿方向全部反转的 BAG 限价单,价按各腿当前买卖价算的立刻成交价(组合不发市价单:每条腿各吃一次价差)。托管到券商:挂一张按标的目标价算出的限价止盈单,止损类目标由软件盯,触发时把这张单改到立刻成交的价。
          </div>
          <div>
            {isPaper ? (
              <>
                <span className="tag paper">模拟账户</span> 组合追踪与到价自动平仓已完全开放,不需要任何额外开关——就在这里测。
              </>
            ) : (
              <>
                <span className="tag live">实盘账户</span> 组合平仓单还没在实盘核对过:到价会算、会提醒,但不会发单,除非在配置里打开
                policies.allow_combo_live。建议先在模拟账户跑通。
              </>
            )}
          </div>
        </div>
      ) : null}
      {/* 设了目标价却算不出价钱,就不给点:那一步下去要么被引擎拒、要么是盲签一张真单 */}
      <Button
        type="primary"
        size="small"
        loading={saving}
        disabled={hasSpotTarget && !priced}
        title={hasSpotTarget && !priced ? '这个点位的价格还没算出来' : undefined}
        onClick={() => void start()}
      >
        开始追踪
      </Button>
    </div>
  );
}

// ---- 正在追踪的一条 ------------------------------------------------------------------------

const GAUGE_TINT: Record<'ok' | 'warn' | 'bad', Tint> = { ok: 'green', warn: 'orange', bad: 'red' };

/** 一条"离触发还有多远"的量表。没有现价就不画——画一条假的比不画更坏。 */
function Gauge({ live, targets }: { live: LiveRow; targets: TrackTargets }) {
  const price = live.price;
  if (price == null) {
    return (
      <div className="track-gauge">
        <span className="muted">拿不到现价,本轮不判断</span>
      </div>
    );
  }
  const rows: { label: string; target: number; note: string; tone: 'ok' | 'warn' | 'bad' }[] = [];
  const pending: string[] = [];
  const hasTrail = Boolean(targets.profit_drawdown_tiers) || targets.profit_drawdown_pct != null;
  if (live.profit_trail_stop != null) {
    const pct = live.profit_drawdown_threshold;
    rows.push({
      label: pct != null ? `利润回撤 ${fmtNum(pct)}%` : '利润回撤',
      target: live.profit_trail_stop,
      note: live.profit_peak != null ? `峰值利润 ${fmtMoney(live.profit_peak)}` : '',
      tone: 'warn',
    });
  } else if (hasTrail) {
    // 设了回撤、但峰值利润还没越过成本:回撤无从谈起,不是"没设"
    const peak = live.profit_peak;
    pending.push(
      peak != null && peak <= 0
        ? `利润回撤已设,但这笔从建仓起还没盈利过(峰值利润 ${fmtMoney(peak)})——先转正才会开始算回撤,在那之前只有止损能保护它。`
        : '利润回撤已设,等第一次盈利后开始记峰值。',
    );
  }
  const st = live.spot_target;
  if (st?.held) {
    pending.push(st.reason || '还没拿到市场报价,先不挂单。');
  } else if (st?.price != null) {
    // 目标价每轮重算,所以这一行的 target 也每轮变;标签里带上标的位置,
    // 否则界面上只剩一个孤零零的价格,看不出它是怎么来的
    rows.push({
      label: `标的到 ${fmtNum(st.spot_target)}`,
      target: st.price,
      note: st.pnl != null ? `预估收益 ${fmtMoney(st.pnl)}` : '',
      tone: 'ok',
    });
  } else if (targets.spot_target != null) {
    pending.push(st?.reason || `标的目标价 ${fmtNum(targets.spot_target)} 已设,但这一轮算不出对应的价位。`);
  }
  if (targets.take_profit != null && targets.spot_target == null) {
    rows.push({ label: '止盈', target: targets.take_profit, note: '', tone: 'ok' });
  }
  if (live.stop_effective != null) {
    rows.push({
      label: live.trail_stop != null && live.stop_effective === live.trail_stop ? '跟踪止损' : '止损',
      target: live.stop_effective,
      note: '',
      tone: 'bad',
    });
  }
  if (!rows.length && !pending.length) {
    return (
      <div className="track-gauge">
        <span className="muted">没设任何触发条件,只是挂着看</span>
      </div>
    );
  }
  return (
    <div className="track-gauge">
      {pending.map((text) => (
        <div className="muted" key={text}>
          {text}
        </div>
      ))}
      {rows.length ? (
        <div className="gauge-rings">
          {rows.map((r) => {
            const gap = r.target - price;
            const pct = price ? Math.abs(gap / price) * 100 : 0;
            // 距离越近环越满:20% 以外就算"还远",满环 = 已经贴着触发价
            const closeness = Math.max(0.02, Math.min(1, 1 - Math.min(pct, 20) / 20));
            return (
              <div className="gauge-ring" key={r.label}>
                <Ring value={closeness} tint={GAUGE_TINT[r.tone]} size={58} title="环越满 = 离触发越近">
                  {fmtNum(pct, 1)}
                  <small>%</small>
                </Ring>
                <div className="gauge-ring-text">
                  <span className="gauge-label">{r.label}</span>
                  <span className="gauge-value">{fmtMoney(r.target)}</span>
                  <span className="muted">{`还差 ${gap >= 0 ? '+' : ''}${fmtNum(gap, 4)}${r.note ? ` · ${r.note}` : ''}`}</span>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function TrackCard({
  t,
  live,
  hosted,
  delayed,
  connected,
  flash,
}: {
  t: Track;
  live: LiveRow;
  hosted?: { orders: { kind: string; label: string }[] };
  delayed: boolean;
  connected: boolean;
  flash: boolean;
}) {
  const status = useStatus();
  const [busy, setBusy] = useState<'toggle' | 'close' | 'delete' | null>(null);
  const fired = Boolean(t.fired_at);
  const sweeping = String(t.fired_state || '').startsWith('sweep:');
  const kind: Tone = sweeping ? 'warn' : fired ? (t.fired_state === 'take_profit' ? 'ok' : 'bad') : t.enabled ? 'info' : 'warn';
  const targets = t.targets || {};
  const autoClose = t.auto_close || {};
  const ddTiers = targets.profit_drawdown_tiers || null;
  const frac = autoClose.close_fraction_pct;
  const now = live.profit_drawdown_threshold;

  async function toggle() {
    setBusy('toggle');
    try {
      await dafri.updateTracker({ id: t.id, enabled: !t.enabled });
      await loadTracker(false);
    } catch (err) {
      showBanner(errorMessage(err), false);
    } finally {
      setBusy(null);
    }
  }

  async function closeNow() {
    const ok = await dafri.confirm({
      title: '立即平仓',
      message: `马上把 ${t.symbol} 的持仓平掉?`,
      detail: '这会立刻发出一张平仓单,和到价自动平仓走的是同一条路。',
      confirmLabel: '平仓',
    });
    if (!ok) return;
    setBusy('close');
    try {
      const res = await dafri.closePositionNow(t.id);
      showBanner(`平仓单已发出:${res?.fired?.reason ?? ''}`, true);
      await Promise.all([loadTracker(true), loadRecords()]);
    } catch (err) {
      showBanner(errorMessage(err), false);
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    const ok = await dafri.confirm({
      title: '删除追踪',
      message: `不再追踪 ${t.symbol}?`,
      detail: '只删除追踪设置,不影响持仓本身。',
      confirmLabel: '删除',
    });
    if (!ok) return;
    setBusy('delete');
    try {
      await dafri.deleteTracker(t.id);
      await loadTracker(false);
    } catch (err) {
      showBanner(errorMessage(err), false);
    } finally {
      setBusy(null);
    }
  }

  return (
    <StatusCard
      tone={kind}
      flash={flash}
      title={`${legLabel(t.symbol, t.sec_type, t.contract)} · ${t.account}`}
      extra={
        <Pill dot tint={sweeping ? 'orange' : fired ? (t.fired_state === 'take_profit' ? 'green' : 'red') : t.enabled ? 'blue' : 'gray'}>
          {fired ? TRACK_STATE_LABEL[t.fired_state || ''] || '已触发' : t.enabled ? TRACK_STATE_LABEL[live.state || ''] || '持有中' : '已暂停'}
        </Pill>
      }
    >
      <Meta
        items={[
          targets.take_profit ? `止盈 ${fmtMoney(targets.take_profit)}` : null,
          targets.stop_loss ? `止损 ${fmtMoney(targets.stop_loss)}` : null,
          // 分档时阈值每一轮都可能变,显示当前生效的那一档而不是配置里的静态值
          targets.profit_drawdown_pct || ddTiers
            ? (ddTiers ? `利润回撤 分档${now != null ? ` · 当前 ${now}%` : ''}` : `利润回撤 ${targets.profit_drawdown_pct}%`) + (frac && frac < 100 ? ` → 平 ${frac}%` : '')
            : null,
          ddTiers && live.profit_peak != null ? `峰值利润 ${fmtMoney(live.profit_peak)}` : null,
          targets.trail_pct ? `跟踪 ${targets.trail_pct}%${live.trail_stop ? ` → ${fmtMoney(live.trail_stop)}` : ''}` : null,
          t.peak ? `最有利价 ${fmtMoney(t.peak)}` : null,
          <span className={autoClose.enabled ? 'tag live' : 'tag paper'}>{autoClose.enabled ? '自动平仓已开' : '仅提醒'}</span>,
        ]}
      />

      {autoClose.host_at_broker ? (
        <Meta
          items={[
            <span className="tag live">券商托管</span>,
            ...(hosted?.orders?.length
              ? hosted.orders.map((o) => (o.kind === 'ptrail' ? `${o.label}(秒级调整)` : o.label))
              : [<span className="muted">{connected ? '托管单尚未挂出(对账中,或被闸门拦住——看下方提示)' : `连接${gatewayName(status)}后自动挂出`}</span>]),
            delayed ? <span className="muted">行情可能延迟:动态调整或滞后;触发由券商实时行情决定,不受影响</span> : null,
          ]}
        />
      ) : null}

      {live.unrealized_pnl !== undefined ? (
        <div className="pos-hero compact">
          <div className="pos-hero-main">
            <div className={`hero-num sm ${!live.unrealized_pnl ? '' : live.unrealized_pnl > 0 ? 'up' : 'down'}`}>
              <Pnl value={live.unrealized_pnl} pct={live.unrealized_pct} />
            </div>
            <div className="hero-sub">未实现盈亏</div>
          </div>
        </div>
      ) : null}
      {/* 价位轨:止损 / 现价 / 止盈落在同一根轴上——"现在站在哪、两头各还有多远"一眼看完 */}
      {!fired && live.price != null ? (
        <PriceRail
          marks={[
            { key: 'stop', price: live.stop_effective ?? targets.stop_loss, label: live.trail_stop != null && live.stop_effective === live.trail_stop ? '跟踪止损' : '止损', kind: 'stop' },
            { key: 'ptrail', price: live.profit_trail_stop, label: '回撤线', kind: 'other' },
            { key: 'now', price: live.price, label: '现价', kind: 'now' },
            { key: 'tp', price: live.spot_target?.held ? null : live.spot_target?.price ?? (targets.spot_target == null ? targets.take_profit : null), label: '止盈', kind: 'target' },
          ]}
        />
      ) : null}
      {/* 盯盘条:离触发还有多远。分档回撤的触发价每轮都会跳,所以取引擎算好的那个 */}
      {!fired && t.enabled ? <Gauge live={live} targets={targets} /> : null}
      {live.reason ? <div className="reason">{live.reason}</div> : null}
      {/* 追价平仓:追到哪了。轮 = 秒;挂的价只朝成交方向动,让到「最多让到」为止 */}
      {sweeping && live.chase ? (
        <div className="reason">
          {`追价第 ${live.chase.rounds} 秒:挂 ${fmtMoney(live.chase.limit)}`}
          {live.chase.natural != null ? `,此刻立刻成交价 ${fmtMoney(live.chase.natural)}` : ''}
          {live.chase.floor != null ? `,最多让到 ${fmtMoney(live.chase.floor)}` : ''}
        </div>
      ) : null}
      {live.blocked?.length ? <Alert type="warning" showIcon message="到价了但没有平仓" description={live.blocked.join('、')} style={{ marginTop: 8 }} /> : null}

      <Space size={6} className="card-actions" wrap>
        <Button size="small" loading={busy === 'toggle'} onClick={() => void toggle()}>
          {t.enabled ? '暂停' : '恢复'}
        </Button>
        <Button size="small" className="btn-warn" loading={busy === 'close'} onClick={() => void closeNow()}>
          立即平仓
        </Button>
        <Button size="small" type="text" loading={busy === 'delete'} onClick={() => void remove()}>
          删除
        </Button>
      </Space>
    </StatusCard>
  );
}
