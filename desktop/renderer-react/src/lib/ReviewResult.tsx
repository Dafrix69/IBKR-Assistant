/** 复盘的结论怎么摆:蝶 / 正股两种结果卡,以及止盈退出那一段。
 *
 * 2026-09-21 从 pages/Review.tsx 搬出来(函数体逐字未改)。三张图在 reviewCharts.tsx。
 * 数字全是引擎算好的(tradereview.ts / flyexit.ts,黄金基线钉着),这里只负责摆。
 */
import { Descriptions, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { PHASE_LABEL, REVIEW_KIND } from './labels';
import type {
  ButterflyReviewResult, ExitPhases, ExitPlan as ExitPlanData, ExitTotals, ReviewFinding, StockReviewResult,
} from '../bridge';
import { fmtMoney, fmtNum, fmtTimeShort } from './format';
import { FlyChart, StockChart, UnderlyingChart } from './reviewCharts';
import { EmptyState, StatTile, StatusCard, type Tone } from '../ui/kit';

/** 引擎给的那一档结论配什么色。只这一处用。 */
const REVIEW_TONE: Record<string, Tone> = { good: 'ok', warn: 'warn', bad: 'bad', info: 'info' };

export function signed(v: number | null | undefined) {
  return <span className={`num${v != null && v > 0 ? ' pos' : v != null && v < 0 ? ' neg' : ''}`}>{v == null ? '—' : fmtMoney(v)}</span>;
}

export function ReviewResult({ r }: { r: ButterflyReviewResult }) {
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
        <StatTile label="开仓时标的" value={`${s.entry_underlying}(距中心 ${(s.dist_entry ?? 0) > 0 ? '+' : ''}${s.dist_entry})`} />
        <StatTile label={o.kind === 'open' ? '最新标的' : '结局时标的'} value={`${s.exit_underlying}(距中心 ${(s.dist_exit ?? 0) > 0 ? '+' : ''}${s.dist_exit})`} />
        <StatTile label={pnlLabel} value={pnl == null ? '—' : `${fmtMoney(pnl)}${o.pnl_pct != null ? ` (${o.pnl_pct}%)` : ''}`} tone={pnl == null ? '' : pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : ''} />
      </div>
      <UnderlyingChart r={r} />
      {r.exit_plan ? (
        <>
          <FlyChart r={r} />
          <ExitPlan r={r} />
        </>
      ) : null}
      {(r.findings || []).map((f: ReviewFinding, i: number) => (
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

// ---- 股票 ----------------------------------------------------------------

export const pctText = (v: number | null | undefined) => (v == null ? '' : ` (${v > 0 ? '+' : ''}${v}%)`);

export function StockResult({ r }: { r: StockReviewResult }) {
  const p = r.profile;
  const o = r.outcome;
  const s = r.stats;
  const long = p.side === 'LONG';
  const open = o.kind === 'open';
  const pnl = o.pnl;
  const execs = (list: any[]) => list.map((e) => `${e.time_et || fmtTimeShort(e.time)} ${e.action === 'BUY' ? '买' : '卖'} ${e.qty} @ ${e.price}`).join(';');

  const detailRows: [string, unknown][] = [
    ['账户', r.account],
    ['开始时间(美东)', r.entry.time_et],
    ['结局', `${REVIEW_KIND[o.kind] || o.kind}${o.time_et ? ' · ' + o.time_et : ''}`],
    [long ? '买入' : '卖空', p.entries.length ? execs(p.entries) : null],
    [long ? '卖出' : '买回', p.exits.length ? execs(p.exits) : null],
    ['持有 K 线数', s.hold_bars],
    ['持有期间区间', s.hold_low == null ? null : `${s.hold_low} ~ ${s.hold_high}`],
    ['最大浮盈', s.mfe ? `${fmtMoney(s.mfe.amount)}${pctText(s.mfe.pct)} · ${s.mfe.time} 到 ${s.mfe.price}` : null],
    ['最大浮亏', s.mae ? `${fmtMoney(-s.mae.amount)}${pctText(s.mae.pct == null ? null : -s.mae.pct)} · ${s.mae.time} 到 ${s.mae.price}` : null],
    ['兑现了最大浮盈的', s.capture_pct == null ? null : `${s.capture_pct}%`],
    ['已实现 / 浮动盈亏', o.realized_pnl == null ? null : `${fmtMoney(o.realized_pnl)} / ${o.unrealized_pnl == null ? '—' : fmtMoney(o.unrealized_pnl)}`],
    ['佣金(未扣)', o.commission ? fmtMoney(o.commission) : null],
  ];
  const liveRows = detailRows.filter(([, v]) => v !== null && v !== undefined && v !== '');
  const position = (v: number | null | undefined) => (v == null ? '—' : `区间的 ${fmtNum(v * 100, 0)}%`);

  return (
    <>
      <div className="stat-grid">
        <StatTile label="交易" value={`${p.side_label} ${p.symbol} ${p.qty} 股`} />
        <StatTile label={long ? '买入均价' : '卖空均价'} value={p.avg_entry == null ? '未知(建仓更早)' : String(p.avg_entry)} />
        <StatTile label={open ? '最新价' : long ? '卖出均价' : '买回均价'} value={open ? String(o.underlying) : p.avg_exit == null ? '—' : String(p.avg_exit)} />
        <StatTile label="进场位置" value={s.entry_position == null ? '—' : `${long ? '离最低' : '离最高'} ${fmtNum((1 - s.entry_position) * 100, 0)}%`} />
        <StatTile label="出场位置" value={position(s.exit_position)} />
        <StatTile label={open ? '盈亏(含浮动)' : '盈亏'} value={pnl == null ? '—' : `${fmtMoney(pnl)}${pctText(o.pnl_pct)}`} tone={pnl == null ? '' : pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : ''} />
      </div>
      <StockChart r={r} />
      {(r.findings || []).map((f: ReviewFinding, i: number) => (
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

/** 止盈点位与预计盈利 + 策略回放事件 + 三种结局对比。 */
export function ExitPlan({ r }: { r: ButterflyReviewResult }) {
  // 兜底成空对象之后编译器就只认得 `{}` 了,所以这三处标上类型(值一个字没动)
  const plan: Partial<ExitPlanData> = r.exit_plan || {};
  const sim = plan.simulation;
  // ExitSimulation 是按 applicable 判别的联合:适用那一支 totals / events / series 一定都在,
  // 不适用那一支只有 reason。先认出"跑过的那一支",下面就不必每处再兜一次底(值和从前一样)。
  const run = sim && sim.applicable ? sim : null;
  const p = r.profile || {};
  const ph: Partial<ExitPhases> = plan.phases || {};
  const t: Partial<ExitTotals> = run?.totals || {};
  const notes = plan.notes || [];
  const events: Array<Record<string, unknown>> = run?.events || [];

  const levelCols: ColumnsType<any> = [
    { title: '点位', dataIndex: 'label' },
    { title: '蝶价', dataIndex: 'price', align: 'right', render: (v) => String(v) },
    { title: '倍数', dataIndex: 'mult_of_debit', align: 'right', render: (v) => `${v}×D` },
    { title: '张数', dataIndex: 'tranche_qty', align: 'right', render: (v) => (v ? String(v) : '—') },
    { title: '每张盈亏', dataIndex: 'pnl_per_contract', align: 'right', render: (v) => signed(v) },
    { title: '预计盈亏', dataIndex: 'expected_pnl', align: 'right', render: (v) => signed(v) },
  ];
  // v 带上 undefined:totals 是可选的,兜底成 {} 之后这几项本来就可能没有(以前 r 是 any,一样的值)
  const outcomes: { k: string; v: number | null | undefined; note: string }[] = [
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
      {sim && sim.applicable === false ? (
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
      {notes.length ? (
        <ul className="review-notes">
          {notes.map((n: string, i: number) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      ) : null}
    </StatusCard>
  );
}
