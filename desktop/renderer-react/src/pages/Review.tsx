import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Descriptions, InputNumber, Select, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { dafri, errorMessage } from '../bridge';
import { CanvasChart } from '../lib/Chart';
import { fmtMoney, fmtTimeShort } from '../lib/format';
import { FINAL_STATUS_LABEL } from '../lib/labels';
import { showBanner } from '../store/banner';
import { takeReviewRequest, useReviewRequest } from '../store/review';
import { EmptyState, Group, PageHead, Primer, StatTile, StatusCard, SwitchRow, Working, type Tone } from '../ui/kit';

// 交易分析(蝴蝶复盘)与止盈策略回放。数字全来自引擎的 review.analyze;这里只负责摆。

const REVIEW_TONE: Record<string, Tone> = { good: 'ok', warn: 'warn', bad: 'bad', info: 'info' };
const REVIEW_KIND: Record<string, string> = { closed: '已平仓', expired: '已到期', open: '持仓中' };
const PHASE_LABEL: Record<string, string> = { A: '阶段 A', B: '阶段 B', C: '阶段 C' };
const TF_OPTIONS = [
  { value: 'auto', label: '自动周期' },
  { value: '1m', label: '1 分钟' },
  { value: '5m', label: '5 分钟' },
  { value: '15m', label: '15 分钟' },
  { value: '1h', label: '1 小时' },
  { value: '1d', label: '日线' },
];

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 同上 */
  }
}

function candidateLabel(c: any): string {
  const when = fmtTimeShort(c.created_at);
  const strikes = (c.strikes || []).map((s: unknown) => String(s)).join('/');
  const state =
    c.source === 'ibkr' ? 'IBKR 成交' : c.filled ? '已成交' : c.final_status ? FINAL_STATUS_LABEL[c.final_status] || c.final_status : c.status || '本地 · 未成交';
  const price = c.price == null ? '' : ` @ ${c.price}${c.price_estimated ? '(限价)' : ''}`;
  const acct = c.account ? ` · ${c.account}` : '';
  if (c.exit) {
    const pnl = c.exit.pnl == null ? '' : ` · 盈亏 ${c.exit.pnl > 0 ? '+' : ''}${c.exit.pnl}`;
    return `${when} ${c.action === 'BUY' ? '买' : '卖'} @ ${c.price ?? '—'} → ${fmtTimeShort(c.exit.time)} 平 @ ${c.exit.price ?? '—'}${pnl} · ${c.qty} 张 ${c.symbol} ${strikes} ${c.right}蝴蝶 · 到期 ${c.expiry}${acct} · ${state}`;
  }
  return `${when} · ${c.action === 'BUY' ? '买' : '卖'} ${c.qty} ${c.symbol} ${strikes} ${c.right}蝴蝶 · 到期 ${c.expiry}${price}${acct} · ${state} · 未平仓 / 到期`;
}

export function ReviewPage() {
  const [candidates, setCandidates] = useState<any[]>([]);
  const [selected, setSelected] = useState(() => read('dafri-review-record') || '');
  const [timeframe, setTimeframe] = useState(() => read('dafri-review-timeframe') || 'auto');
  const [em, setEm] = useState<number | null>(() => Number(read('dafri-review-em')) || 36);
  const [includeLocal, setIncludeLocal] = useState(false);
  const [freshness, setFreshness] = useState('—');
  const [available, setAvailable] = useState<boolean | null>(null);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const requestSeq = useReviewRequest();

  /** keep:从交易记录跳过来时要保住的那一张,别被"选中第一条"的兜底顶掉。 */
  const loadCandidates = useCallback(async (local: boolean, keep?: string) => {
    try {
      const result = await dafri.reviewCandidates(200, local);
      const list: any[] = result?.candidates || [];
      setCandidates(list);
      setAvailable(Boolean(result?.ibkr_available));
      const bits: string[] = [];
      if (result?.ibkr_available) bits.push(result.synced == null ? '已连 TWS' : `本次新增 ${result.synced} 笔成交`);
      else bits.push('未连 TWS,只看本地累积的成交');
      bits.push(`库内成交 ${result?.fills_stored ?? 0} 笔`);
      setFreshness((f) => (f === '—' || f.startsWith('已连') || f.startsWith('未连') || f.startsWith('本次') ? bits.join(' · ') : f));
      setSelected((s) => {
        const want = keep ?? s;
        return list.some((c) => c.id === want) ? want : list[0]?.id || '';
      });
      return list;
    } catch (err) {
      showBanner(`读取成交明细失败:${errorMessage(err)}`, false);
      return [];
    }
  }, []);

  const run = useCallback(
    async (id: string) => {
      if (!id) {
        showBanner('先选一张蝴蝶', true);
        return;
      }
      write('dafri-review-record', id);
      write('dafri-review-timeframe', timeframe);
      write('dafri-review-em', String(em || 36));
      setLoading(true);
      try {
        const r = await dafri.reviewAnalyze({ id, timeframe, exit: { em: em || 36 } });
        setData(r);
        setError(null);
        setFreshness(`${r.timeframe_label} · ${r.series.bars.length} 根 · ${REVIEW_KIND[r.outcome.kind] || ''}`);
      } catch (err) {
        setData(null);
        setError(errorMessage(err));
      } finally {
        setLoading(false);
      }
    },
    [timeframe, em],
  );

  useEffect(() => {
    void loadCandidates(includeLocal);
  }, [includeLocal, loadCandidates]);

  // 从交易记录详情跳过来:选中那一张并直接分析。
  // 它可能是本地校验过、没在券商成交的那种——默认的候选列表里没有它,得把「附带本地未成交的记录」打开,
  // 否则下拉框会退回到第一条 IBKR 成交,而下面的图和结论却是点进来的那一张,两者对不上。
  useEffect(() => {
    if (!requestSeq) return;
    const id = takeReviewRequest();
    if (!id) return;
    setSelected(id);
    void (async () => {
      const list = await loadCandidates(includeLocal, id);
      if (!includeLocal && !list.some((c) => c.id === id)) {
        setIncludeLocal(true);
        await loadCandidates(true, id);
      }
      await run(id);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestSeq]);

  const emptyOption =
    available === null ? '加载中…' : available ? '今天的成交里没有蝴蝶(TWS 只给当天的;更早的要在连着时同步过才有)' : '还没有同步到任何 IBKR 成交:先连接 TWS 再点「同步成交」';

  return (
    <section className="tab-panel active" id="page-review">
      <PageHead title="交易分析" extra={<span className="muted">{freshness}</span>} />
      <div className="row tight">
        <Select
          className="grow"
          value={selected || undefined}
          placeholder={emptyOption}
          options={candidates.map((c) => ({ value: c.id, label: candidateLabel(c) }))}
          onChange={(v) => {
            setSelected(v);
            write('dafri-review-record', v);
          }}
          aria-label="选择一张蝴蝶"
        />
        <Select value={timeframe} options={TF_OPTIONS} onChange={setTimeframe} style={{ width: 110 }} aria-label="K 线周期" />
        <label className="row tight m0" title="当日 0DTE 隐含日内波动(点):策略文档要求每日从 ATM straddle 取,EM = straddle × 0.85;默认 36">
          <span className="muted">EM</span>
          <InputNumber min={1} max={500} step={0.5} value={em} onChange={(v) => setEm(v == null ? null : Number(v))} style={{ width: 72 }} aria-label="隐含日内波动 EM" />
        </label>
        <Button size="small" type="text" title="向 TWS 重新拉取成交明细并刷新列表" onClick={() => void loadCandidates(includeLocal)}>
          同步成交
        </Button>
        <Button type="primary" id="btn-review-run" loading={loading} onClick={() => void run(selected)}>
          分析
        </Button>
      </div>
      <Group>
        <SwitchRow label="附带本地未成交的记录" sub="默认只列 IBKR 真实成交过的蝴蝶;打开后把本地校验过但没成交的也列出来(按限价估算)" checked={includeLocal} onChange={setIncludeLocal} />
      </Group>
      <Primer id="intro-review" intro summary="数据来源、结论规则与止盈策略">
        <p className="hint">
          列表来自 <strong>IBKR 的成交明细</strong>:引擎从 TWS 拉取逐笔成交,按订单把三条腿合成一张蝴蝶,并存进本地库累积
          (TWS 的接口只给当天的成交,所以历史靠每次连着时同步来的那些)。选一张后拉取标的在<strong>开仓前后到平仓 / 到期</strong>的 K 线,
          画出三条行权价与盈利区,并按规则给出结论:开仓位置、开仓前后走势、持有期间离中心多远、曾经的机会、结局与方向对错。
          理论价值按<strong>到期内在价值</strong>算(是下界,不是当时能卖到的价)。平仓按同一张蝴蝶的反向成交认定,没有就按到期结算。
          K 线走 TWS 历史数据,需连接引擎。<strong>止盈策略</strong>按《SPX 0DTE 蝶式止盈策略 v2.0》回放:蝶价走势取 IBKR 组合分钟中间价,
          标出 1.35×D / 1.70×D 两档止盈、0.5×D 止损与预计盈利,SPX 图上标出 ±0.45W / ±0.55W / ±0.8W 临界线,并逐分钟回放策略会在哪里出手、与实际结果对比。
        </p>
      </Primer>
      <div id="review-result" className="cards">
        {loading ? (
          <Working>正在拉取 K 线并复盘…</Working>
        ) : error ? (
          <StatusCard tone="bad" title="分析失败">
            <div>{error}</div>
          </StatusCard>
        ) : !data ? (
          <EmptyState>选一张蝴蝶后点「分析」。</EmptyState>
        ) : (
          <ReviewResult r={data} />
        )}
      </div>
    </section>
  );
}

// ---- 结果 ----------------------------------------------------------------

function signed(v: number | null | undefined) {
  return <span className={`num${v != null && v > 0 ? ' pos' : v != null && v < 0 ? ' neg' : ''}`}>{v == null ? '—' : fmtMoney(v)}</span>;
}

function ReviewResult({ r }: { r: any }) {
  const p = r.profile;
  const z = r.zone;
  const o = r.outcome;
  const s = r.stats;
  const pnl = o.kind === 'open' ? o.pnl_if_expired_now : o.pnl;
  const pnlLabel = o.kind === 'open' ? '若此刻到期' : '盈亏';

  const detailRows: [string, unknown][] = [
    ['开仓时间(美东)', `${r.entry.time_et}${r.entry.estimated ? '(按提交时间)' : ''}`],
    ['结局', `${REVIEW_KIND[o.kind] || o.kind}${o.time_et ? ' · ' + o.time_et : ''}`],
    ['平仓 / 结算价', o.price == null ? null : String(o.price)],
    ['持有 K 线数', s.hold_bars],
    ['持有期间标的区间', `${s.hold_low} ~ ${s.hold_high}`],
    ['最接近中心', s.closest ? `${s.closest.price}(${s.closest.time},距 ${s.closest.distance})` : null],
    ['盈利区内收盘 K 线', s.in_zone_bars == null ? null : `${s.in_zone_bars}/${s.hold_bars}`],
    ['最好的理论时刻', s.best_theoretical ? `${s.best_theoretical.time} · ${fmtMoney(s.best_theoretical.pnl)}` : null],
    ['最大盈利 / 最大亏损', z.known ? `${fmtMoney(z.max_profit)} / ${fmtMoney(z.max_loss)}` : null],
    ['平仓记录', o.record_id],
  ];
  const liveRows = detailRows.filter(([, v]) => v !== null && v !== undefined && v !== '');

  return (
    <>
      {r.source === 'local' ? (
        <StatusCard tone="warn" title="这是本地记录,不是券商成交">
          <div>这张蝴蝶没有在 IBKR 成交过,下面的权利金按限价、开仓时刻按提交时间估算。</div>
        </StatusCard>
      ) : null}
      <div className="stat-grid">
        <StatTile label="结构" value={`${p.symbol} ${p.lower}/${p.center}/${p.upper} ${p.right_label}`} />
        <StatTile label={`权利金${p.price_estimated ? '(估算)' : ''}`} value={p.debit == null ? '—' : String(p.debit)} />
        <StatTile label="盈利区" value={z.known ? `${z.lower_be} ~ ${z.upper_be}` : '—'} />
        <StatTile label="开仓时标的" value={`${s.entry_underlying}(距中心 ${s.dist_entry > 0 ? '+' : ''}${s.dist_entry})`} />
        <StatTile label={o.kind === 'open' ? '最新标的' : '结局时标的'} value={`${s.exit_underlying}(距中心 ${s.dist_exit > 0 ? '+' : ''}${s.dist_exit})`} />
        <StatTile label={pnlLabel} value={pnl == null ? '—' : `${fmtMoney(pnl)}${o.pnl_pct != null ? ` (${o.pnl_pct}%)` : ''}`} tone={pnl == null ? '' : pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : ''} />
      </div>
      <UnderlyingChart r={r} />
      {r.exit_plan ? (
        <>
          <FlyChart r={r} />
          <ExitPlan r={r} />
        </>
      ) : null}
      {(r.findings || []).map((f: any, i: number) => (
        <StatusCard key={i} tone={REVIEW_TONE[f.tone] || 'info'} title={f.title}>
          <div>{f.text}</div>
        </StatusCard>
      ))}
      {liveRows.length ? (
        <div className="detail-section">
          <h4>明细</h4>
          <Descriptions size="small" column={1} colon={false} items={liveRows.map(([k, v]) => ({ key: k, label: k, children: String(v) }))} />
        </div>
      ) : null}
      {(r.notes || []).length ? (
        <ul className="review-notes">
          {r.notes.map((n: string, i: number) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** 标的走势:蜡烛 + 三条行权价 + 盈利区 + 止盈策略的临界线 + 开仓/平仓竖线。字段全部来自 r.series 与 r.exit_plan。 */
function UnderlyingChart({ r }: { r: any }) {
  const spec = useMemo(() => {
    const bars = r.series.bars || [];
    if (bars.length < 2) return null;
    const levels: any[] = r.series.levels || [];
    const LEVEL_STYLE: Record<string, any> = {
      lower: { color: 'orange', dash: [4, 3], alpha: 0.8, label: '下翼' },
      center: { color: 'blue', dash: [], alpha: 0.9, label: '中心' },
      upper: { color: 'orange', dash: [4, 3], alpha: 0.8, label: '上翼' },
      lower_be: { color: 'up', dash: [2, 2], alpha: 0.6, tag: false, label: '盈亏平衡' },
      upper_be: { color: 'up', dash: [2, 2], alpha: 0.6, tag: false, label: '盈亏平衡' },
    };
    const hlines: any[] = [];
    for (const l of levels) {
      const st = LEVEL_STYLE[l.kind];
      if (st) hlines.push({ price: l.price, ...st });
    }
    // 止盈策略的临界线(|S−K| 的 0.45W / 0.55W / 0.8W):不撑开区间、不占轴,名字写在上沿那条线的左端
    const ZONE_STYLE: Record<string, [string, string]> = { hold: ['blue', '持有'], half: ['purple', '清半'], stop: ['down', '止损'] };
    for (const zone of (r.exit_plan || {}).zones || []) {
      const st = ZONE_STYLE[zone.kind];
      if (!st) continue;
      hlines.push({ price: zone.high, color: st[0], dash: [2, 3], alpha: 0.45, tag: false, fit: false, label: `${st[1]} ±${zone.half_width}` });
      hlines.push({ price: zone.low, color: st[0], dash: [2, 3], alpha: 0.45, tag: false, fit: false });
    }
    const lowerBe = levels.find((l) => l.kind === 'lower_be');
    const upperBe = levels.find((l) => l.kind === 'upper_be');
    const bands = lowerBe && upperBe ? [{ top: upperBe.price, bottom: lowerBe.price, color: 'up', fill: 0.1 }] : [];
    const MARK: Record<string, [string, string]> = { entry: ['blue', '开仓'], exit: ['purple', '平仓'], expiry: ['purple', '到期'] };
    const vlines: any[] = [];
    const markers: any[] = [];
    for (const m of r.series.markers || []) {
      const st = MARK[m.kind] || MARK.entry;
      vlines.push({ time: m.time, color: st[0], label: `${st[1]} ${m.price}` });
      markers.push({ time: m.time, price: m.price, shape: 'dot', color: st[0], fit: false });
    }
    const legend: [string, string, string][] = [
      ['■', 'up', '阳线'], ['■', 'down', '阴线'], ['—', 'blue', '中心'], ['╌', 'orange', '上下翼'],
      ['▮', 'up', '盈利区(到期)'], ['┆', 'blue', '开仓'], ['┆', 'purple', '平仓 / 到期'],
    ];
    if (r.exit_plan) legend.push(['╌', 'label2', '临界线 ±0.45W / 0.55W / 0.8W']);
    return { ariaLabel: '标的走势', bars, hlines, bands, vlines, markers, legend, volume: false };
  }, [r]);
  return (
    <StatusCard title={`标的走势(${r.timeframe_label},开仓前后到${REVIEW_KIND[r.outcome.kind] === '持仓中' ? '现在' : '结局'})`}>
      {spec ? <CanvasChart size="mid" spec={spec} /> : null}
    </StatusCard>
  );
}

/** 蝶价走势:组合分钟中间价的蜡烛 + 模型价虚线 + 止盈/止损水平线 + 回撤触发价阶梯 + 开仓/平仓/策略事件标记。 */
function FlyChart({ r }: { r: any }) {
  const fs = r.fly_series || {};
  const spec = useMemo(() => {
    const plan = r.exit_plan || {};
    const sim = plan.simulation || {};
    const real: any[] = fs.bars || [];
    const path: any[] = sim.series || [];
    const times = Array.from(new Set([...real.map((b) => b.time), ...path.map((pt) => pt.time)])).sort();
    if (times.length < 2) return null;
    const pathAt = new Map(path.map((pt) => [pt.time, pt]));
    const phases: { phase: string; from: string; to: string }[] = [];
    let band: { phase: string; from: string; to: string } | null = null;
    for (const t of times) {
      const ph = (pathAt.get(t) || {}).phase;
      if (!ph) {
        band = null;
        continue;
      }
      if (band && band.phase === ph) band.to = t;
      else {
        band = { phase: ph, from: t, to: t };
        phases.push(band);
      }
    }
    const bands = phases.filter((b) => b.phase !== 'A').map((b) => ({ v: true, from: b.from, to: b.to, color: b.phase === 'B' ? 'orange' : 'purple', fill: 0.06, label: PHASE_LABEL[b.phase] }));
    const EXIT: Record<string, [string, string]> = { tp1: ['up', '第一档'], tp2: ['up', '第二档'], trail_arm: ['orange', '回撤追踪激活'], stop: ['down', '止损'] };
    const hlines = (plan.levels || [])
      .filter((l: any) => EXIT[l.kind] && l.price != null)
      .map((l: any) => ({ price: l.price, color: EXIT[l.kind][0], dash: l.kind === 'trail_arm' ? [2, 2] : [5, 3], alpha: 0.8, label: EXIT[l.kind][1] }));
    const lines = [
      { points: path.filter((pt) => pt.source === 'model').map((pt) => ({ time: pt.time, value: pt.price })), color: 'label', alpha: 0.55, dash: [3, 2], label: '模型价' },
      { points: path.filter((pt) => pt.trail_stop != null).map((pt) => ({ time: pt.time, value: pt.trail_stop })), color: 'orange', alpha: 0.85, dash: [4, 2], step: true, label: '回撤触发价' },
    ];
    const MARK: Record<string, [string, string]> = { entry: ['blue', '开仓'], exit: ['purple', '实际平仓'] };
    const markers: any[] = [];
    for (const m of fs.markers || []) {
      if (m.price == null) continue;
      const st = MARK[m.kind] || MARK.entry;
      markers.push({ time: m.time, price: m.price, shape: 'dot', color: st[0], label: `${st[1]} ${m.price}` });
    }
    for (const e of sim.events || []) {
      const color = e.source === 'settle' ? 'purple' : e.pnl >= 0 ? 'up' : 'down';
      markers.push({ time: e.time, price: e.price, shape: 'tri-down', color, label: `策略 ${e.qty} 张 @ ${e.price}` });
    }
    const legend = [
      ['╌', 'up', '止盈档位'], ['╌', 'down', '止损'], ['╌', 'orange', '回撤激活 / 触发价'],
      ['·', 'blue', '开仓'], ['·', 'purple', '实际平仓'], ['╌', 'label2', '模型价'], ['▼', 'up', '策略出手点'],
    ];
    return { ariaLabel: '蝶价走势', times, bars: real, lines, hlines, bands, markers, legend, volume: false, yMin: 0, padPct: 0.08 };
  }, [r, fs]);
  return (
    <StatusCard title={`蝶价走势(组合中间价 · 1 分钟 · ${fs.source === 'ibkr' ? 'IBKR 真实数据' : '模型价'})`}>
      {spec ? <CanvasChart size="mid" spec={spec} /> : <EmptyState compact>没有蝶价数据:引擎未连 TWS,或 IBKR 没有这张组合的历史分钟线。</EmptyState>}
    </StatusCard>
  );
}

/** 止盈点位与预计盈利 + 策略回放事件 + 三种结局对比。 */
function ExitPlan({ r }: { r: any }) {
  const plan = r.exit_plan || {};
  const sim = plan.simulation || {};
  const p = r.profile || {};
  const ph = plan.phases || {};
  const t = sim.totals || {};
  const events: any[] = sim.events || [];

  const levelCols: ColumnsType<any> = [
    { title: '点位', dataIndex: 'label' },
    { title: '蝶价', dataIndex: 'price', align: 'right', render: (v) => String(v) },
    { title: '倍数', dataIndex: 'mult_of_debit', align: 'right', render: (v) => `${v}×D` },
    { title: '张数', dataIndex: 'tranche_qty', align: 'right', render: (v) => (v ? String(v) : '—') },
    { title: '每张盈亏', dataIndex: 'pnl_per_contract', align: 'right', render: (v) => signed(v) },
    { title: '预计盈亏', dataIndex: 'expected_pnl', align: 'right', render: (v) => signed(v) },
  ];
  const outcomes: { k: string; v: number | null; note: string }[] = [
    { k: '按策略回放', v: t.strategy, note: `${events.length} 次出手` },
    { k: '实际', v: t.actual, note: r.outcome.kind === 'closed' ? `以 ${r.outcome.price} 平仓` : r.outcome.kind === 'expired' ? '到期结算' : '持仓中,未计' },
    { k: '持到结算 / 最新', v: t.hold_to_settle, note: '按最后一根标的 K 线的内在价值' },
    { k: '最高蝶价', v: t.best_mid_pnl, note: t.best_mid != null ? `中间价曾到 ${t.best_mid}` : '' },
    {
      k: '浮盈高水位',
      v: t.profit_peak != null && p.debit != null ? t.profit_peak * p.multiplier * p.qty : null,
      note: t.profit_peak ? `激活之后记到 ${t.profit_peak} 点,回撤追踪按它算` : '没到回撤追踪的激活线',
    },
  ];
  const outcomeCols: ColumnsType<(typeof outcomes)[number]> = [
    { title: '结局对比', dataIndex: 'k' },
    { title: '盈亏', dataIndex: 'v', align: 'right', render: (v) => signed(v) },
    { title: '说明', dataIndex: 'note' },
  ];
  const eventCols: ColumnsType<any> = [
    { title: '时间', dataIndex: 'time', render: (v) => String(v).slice(11) },
    { title: '阶段', dataIndex: 'phase', render: (v) => <Tag bordered={false}>{PHASE_LABEL[v] || v}</Tag> },
    { title: '张数', dataIndex: 'qty', align: 'right', render: (v) => String(v) },
    { title: '蝶价', dataIndex: 'price', align: 'right', render: (v, e) => `${v}${e.source === 'model' ? '(模型)' : ''}` },
    { title: '盈亏', dataIndex: 'pnl', align: 'right', render: (v) => signed(v) },
    { title: '规则', dataIndex: 'rule' },
  ];

  return (
    <StatusCard title="止盈策略(SPX 0DTE 蝶式 v2.1 · 浮盈回撤追踪)">
      <p className="hint">
        {`入场 D = ${p.debit ?? '—'},翼宽 W = ${p.width},EM = ${ph.em_at_open}(翼宽 = ${ph.wing_in_sigma ?? '—'} 个日 σ)。` +
          `阶段 A 到 ${ph.a_until};阶段 C 自 ${ph.c_from} 起(σ_剩余 ${ph.sigma_at_switch} < W/1.6 = ${ph.threshold})。` +
          (plan.actual_exit_mult != null ? ` 实际平仓价 = ${plan.actual_exit_mult}×D。` : '')}
      </p>
      <Table className="review-table" size="small" pagination={false} rowKey={(_, i) => String(i)} columns={levelCols} dataSource={plan.levels || []} />
      {sim.applicable === false ? (
        <StatusCard tone="warn" title="不能回放">
          <div>{sim.reason || ''}</div>
        </StatusCard>
      ) : (
        <>
          <Table className="review-table" size="small" pagination={false} rowKey="k" columns={outcomeCols} dataSource={outcomes} />
          <Table
            className="review-table"
            size="small"
            pagination={false}
            rowKey={(_, i) => String(i)}
            columns={eventCols}
            dataSource={events}
            locale={{ emptyText: <EmptyState compact>策略在这段数据里没有出手</EmptyState> }}
          />
        </>
      )}
      {(plan.notes || []).length ? (
        <ul className="review-notes">
          {plan.notes.map((n: string, i: number) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      ) : null}
    </StatusCard>
  );
}
