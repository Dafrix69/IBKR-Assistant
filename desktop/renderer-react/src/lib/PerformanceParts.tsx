/**
 * 绩效体检页的几节:体检结论、核心数字、平仓权益曲线、分组、账本。
 * 数字全是引擎 review.performance 算的(performance.ts),这里只负责摆,不自己加减。
 */
import { useMemo } from 'react';
import { Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { LedgerTrade, PerfGroup, PerformanceFinding, ReviewPerformanceResult } from '../bridge';
import { CanvasChart, type ChartSpec } from './Chart';
import { fmtMoney, fmtTimeShort } from './format';
import { Meta, StatTile, StatusCard, type Tone } from '../ui/kit';

const FINDING_TONE: Record<PerformanceFinding['tone'], Tone> = { good: 'ok', info: 'info', warn: 'warn', bad: 'bad' };
type Ci = PerfGroup['expectancy_ci'];

/** 带符号的美元:+$1,234.50 / -$85.00 */
export function usd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v < 0 ? '-' : v > 0 ? '+' : ''}$${fmtMoney(Math.abs(v))}`;
}

const sign = (v: number | null | undefined): 'pos' | 'neg' | '' => (v == null ? '' : v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const pct = (v: number | null | undefined): string => (v == null ? '—' : `${v}%`);
const plain = (v: number | null | undefined): string => (v == null ? '—' : String(v));
const rMult = (v: number | null | undefined): string => (v == null ? '—' : `${v}R`);
const kelly = (v: number | null | undefined): string => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
/** 区间整个在 0 的一边才算分清了正负;跨着 0 的数不上色。 */
const clear = (ci: Ci): boolean => ci != null && (ci.lo > 0 || ci.hi < 0);
const signIfClear = (v: number | null | undefined, ci: Ci): 'pos' | 'neg' | '' => (clear(ci) ? sign(v) : '');

export function FindingsSection({ findings }: { findings: PerformanceFinding[] }) {
  if (!findings.length) return null;
  return (
    <div className="perf-findings">
      {findings.map((f) => (
        <StatusCard key={f.id} tone={FINDING_TONE[f.tone]} title={f.title}>
          <div>{f.text}</div>
          <Meta className="perf-source" items={[`借鉴:${f.source}`]} />
        </StatusCard>
      ))}
    </div>
  );
}

/** R 盖住了多少、没盖住的为什么:R 期望与 SQN 只代表有 R 的那一部分。 */
function coverageText(r: ReviewPerformanceResult): string | null {
  const c = r.r_coverage;
  if (!c.trades) return null;
  const basis = [c.max_loss ? `按最大可亏 ${c.max_loss}` : '', c.stop ? `按开仓后 ${c.stop_window_minutes} 分钟内设的止损 ${c.stop}` : ''].filter(Boolean).join('、');
  const missing = c.missing.map((m) => `${m.label} ${m.trades} 笔`).join(';');
  const flats = c.flats ? `,其中 ${c.flats} 笔持平、不进 R 的统计` : '';
  return `R:${c.trades} 笔里 ${c.with_r} 笔有${basis ? `(${basis})` : ''}${flats}${missing ? `。没有的:${missing}` : ''}`;
}

function intervalText(r: ReviewPerformanceResult): string | null {
  const s = r.stats;
  const bits = [
    s.expectancy_ci ? `期望值 ${usd(s.expectancy_ci.lo)} ~ ${usd(s.expectancy_ci.hi)}` : '',
    s.win_rate_ci ? `胜率 ${s.win_rate_ci.lo}%–${s.win_rate_ci.hi}%` : '',
    r.r_stats.expectancy_ci ? `R 期望 ${r.r_stats.expectancy_ci.lo}R ~ ${r.r_stats.expectancy_ci.hi}R` : '',
  ].filter(Boolean);
  if (!bits.length) return s.wins + s.losses >= 2 ? '这些交易都在同一天了结,定不出区间:同一天的几笔不算几次独立的试验' : null;
  return `95% 区间(同一天了结的几笔不当成几次独立的试验):${bits.join(' · ')}。跨着 0 的数不上色`;
}

export function StatsSection({ r }: { r: ReviewPerformanceResult }) {
  const s = r.stats;
  const rs = r.r_stats;
  const streak = r.streak.kind === 'none' ? '—' : `${r.streak.kind === 'win' ? '连赚' : '连亏'} ${r.streak.count} 笔`;
  const kinds = r.groups.kind.map((g) => g.label);
  return (
    <StatusCard title={`${s.trades} 笔已了结 · 赚 ${s.wins} · 亏 ${s.losses} · 持平 ${s.flats}`}>
      <div className="stat-grid">
        <StatTile label="净盈亏" value={usd(s.net_pnl)} tone={sign(s.net_pnl)} />
        <StatTile label="期望值(每笔,美元)" value={usd(s.expectancy)} tone={signIfClear(s.expectancy, s.expectancy_ci)} />
        <StatTile label="胜率" value={pct(s.win_rate)} />
        <StatTile label="保本所需胜率" value={pct(s.breakeven_win_rate)} />
        <StatTile label="盈亏比(按美元)" value={plain(s.payoff_ratio)} />
        <StatTile label="利润因子" value={plain(s.profit_factor)} />
        <StatTile label="平均盈利" value={usd(s.avg_win)} />
        <StatTile label="平均亏损" value={usd(s.avg_loss)} />
        <StatTile label="最大单笔亏损" value={usd(s.largest_loss)} tone={sign(s.largest_loss)} />
        <StatTile label="最大回撤(平仓)" value={usd(-r.drawdown.max)} tone={r.drawdown.max > 0 ? 'neg' : ''} />
        <StatTile label="恢复因子" value={plain(r.drawdown.recovery_factor)} />
        <StatTile label="最长连亏" value={`${s.max_consecutive_losses} 笔`} />
        <StatTile label="眼下" value={streak} />
        <StatTile label="凯利比例(按美元)" value={kelly(r.kelly)} />
        <StatTile label={`R 期望(${rs.trades} 笔)`} value={rMult(rs.expectancy_r)} tone={signIfClear(rs.expectancy_r, rs.expectancy_ci)} />
        <StatTile label="盈亏比(按 R)" value={plain(rs.payoff_ratio)} />
        <StatTile label="凯利比例(按 R)" value={kelly(rs.kelly)} />
        <StatTile label="SQN" value={rs.sqn == null ? '—' : `${rs.sqn} · ${rs.sqn_label}`} />
      </div>
      <Meta
        items={[
          r.hold.win_median_minutes != null && r.hold.loss_median_minutes != null
            ? `持有中位数:赚的 ${r.hold.win_median_minutes} 分钟 · 亏的 ${r.hold.loss_median_minutes} 分钟`
            : null,
          r.per_day.days ? `${r.per_day.days} 个交易日里 ${r.per_day.green_days} 天为正` : null,
          r.per_day.worst_day ? `最差一天 ${r.per_day.worst_day.date} ${usd(r.per_day.worst_day.pnl)}` : null,
          r.recent ? `最近 ${r.recent.window} 笔期望 ${usd(r.recent.stats.expectancy)}` : null,
        ]}
      />
      <Meta
        items={[
          intervalText(r),
          coverageText(r),
          kinds.length > 1 ? `这里混着${kinds.join('、')}:按美元的期望值、盈亏比、凯利由单笔金额大的那一类主导,分开的数在下面「品种」表` : null,
          '持平(|盈亏| < $1)的不进胜率、盈亏比、期望值、凯利与 R',
        ]}
      />
    </StatusCard>
  );
}

/** 横轴是第几笔(冠军看资金曲线也是按笔看):同一分钟平掉两笔也不挤在一起。 */
export function EquitySection({ r }: { r: ReviewPerformanceResult }) {
  const chart = useMemo((): ChartSpec | null => {
    if (r.equity.length < 2) return null;
    const times = r.equity.map((_, i) => `#${i + 1}`);
    return {
      ariaLabel: '平仓权益曲线',
      viewKey: `${r.scope}|${r.kind}|${r.days ?? 'all'}|${r.equity.length}`,
      times,
      lines: [
        { values: r.equity.map((p) => p.equity), color: 'blue', width: 1.5, label: '累计已实现盈亏' },
        { values: r.equity.map((p) => -p.drawdown), color: 'down', alpha: 0.5, label: '离峰值' },
      ],
      hlines: [{ price: 0, color: 'label', dash: [3, 3], alpha: 0.25, tag: false }],
      legend: [['—', 'blue', '累计已实现盈亏'], ['—', 'down', '离峰值的回撤'], ['╌', 'label2', '0']],
      decimals: 2,
    };
  }, [r]);
  if (!chart) return null;
  const first = r.equity[0];
  const last = r.equity[r.equity.length - 1];
  return (
    <StatusCard title="平仓权益曲线(按笔)">
      <CanvasChart size="short" spec={chart} />
      <Meta items={[first && last ? `${fmtTimeShort(first.time)} → ${fmtTimeShort(last.time)} · 共 ${r.equity.length} 笔` : null]} />
    </StatusCard>
  );
}

/** 每笔期望:区间跨着 0 的不上色,鼠标停上去看区间。 */
function expectancyCell(v: number | null, g: PerfGroup) {
  const title = g.expectancy_ci ? `95% 区间 ${usd(g.expectancy_ci.lo)} ~ ${usd(g.expectancy_ci.hi)}${clear(g.expectancy_ci) ? '' : ':正负还没分清'}` : undefined;
  return <span className={`perf-num ${signIfClear(v, g.expectancy_ci)}`} title={title}>{usd(v)}</span>;
}

const groupCols: ColumnsType<PerfGroup> = [
  { title: '', dataIndex: 'label', key: 'label' },
  { title: '笔数', dataIndex: 'trades', key: 'trades', align: 'right' },
  { title: '胜率', dataIndex: 'win_rate', key: 'win_rate', align: 'right', render: (v: number | null) => pct(v) },
  { title: '净盈亏', dataIndex: 'net_pnl', key: 'net_pnl', align: 'right', render: (v: number) => <span className={`perf-num ${sign(v)}`}>{usd(v)}</span> },
  { title: '每笔期望', dataIndex: 'expectancy', key: 'expectancy', align: 'right', render: expectancyCell },
  { title: '利润因子', dataIndex: 'profit_factor', key: 'profit_factor', align: 'right', render: (v: number | null) => plain(v) },
];

// 品种这张表多几栏:美元口径下股票(几千上万的名义金额)会盖过蝶(几百的权利金),所以盈亏比、凯利各品种分开给,旁边放按 R 的
const kindCols: ColumnsType<PerfGroup> = [
  ...groupCols,
  { title: '盈亏比', dataIndex: 'payoff_ratio', key: 'payoff_ratio', align: 'right', render: (v: number | null) => plain(v) },
  { title: '凯利', dataIndex: 'kelly', key: 'kelly', align: 'right', render: (v: number | null) => kelly(v) },
  { title: 'R 期望', dataIndex: 'expectancy_r', key: 'expectancy_r', align: 'right', render: (v: number | null, g) => (v == null ? '—' : `${v}R(${g.r_trades} 笔)`) },
  { title: 'R 盈亏比', dataIndex: 'payoff_r', key: 'payoff_r', align: 'right', render: (v: number | null) => plain(v) },
  { title: 'R 凯利', dataIndex: 'kelly_r', key: 'kelly_r', align: 'right', render: (v: number | null) => kelly(v) },
  { title: 'SQN', dataIndex: 'sqn', key: 'sqn', align: 'right', render: (v: number | null) => plain(v) },
];

function GroupTable({ title, rows, columns = groupCols, wide }: { title: string; rows: PerfGroup[]; columns?: ColumnsType<PerfGroup>; wide?: boolean }) {
  if (!rows.length) return null;
  return (
    <div className="perf-group" style={wide ? { gridColumn: '1 / -1' } : undefined}>
      <h4>{title}</h4>
      <Table<PerfGroup> className="review-table" size="small" pagination={false} rowKey="key" columns={columns} dataSource={rows} scroll={wide ? { x: 'max-content' } : undefined} />
    </div>
  );
}

export function GroupsSection({ r }: { r: ReviewPerformanceResult }) {
  return (
    <StatusCard title="分开看:优势在哪儿">
      <div className="perf-groups">
        <GroupTable title="品种" rows={r.groups.kind} columns={kindCols} wide />
        <GroupTable title="开仓时段(美东)" rows={r.groups.session} />
        <GroupTable title="星期" rows={r.groups.weekday} />
        <GroupTable title="标的" rows={r.groups.symbol} />
      </div>
      <Meta items={['一组不到 8 笔时胜率与期望都不稳,只当参考', '每笔期望的 95% 区间跨着 0 时不上色(鼠标停上去看区间)']} />
    </StatusCard>
  );
}

const BASIS_LABEL: Record<NonNullable<LedgerTrade['risk_basis']>, string> = { max_loss: '分母是开仓时的最大可亏', stop: '分母是开仓后不久设的止损' };
const R_MISSING_LABEL: Record<NonNullable<LedgerTrade['r_missing']>, string> = {
  no_stop: '开仓后没及时设止损,没有初始风险', late_stop: '止损设得太晚,不算初始风险', undefined_risk: '风险不止权利金',
  no_open: '没配上开仓', no_cost: '开仓价或数量不明',
};

function rCell(v: number | null, t: LedgerTrade) {
  const title = t.risk_basis ? BASIS_LABEL[t.risk_basis] : t.r_missing ? R_MISSING_LABEL[t.r_missing] : undefined;
  return <span title={title}>{rMult(v)}</span>;
}

const ledgerCols: ColumnsType<LedgerTrade> = [
  { title: '了结', dataIndex: 'closed_at', key: 'closed_at', render: (v: string) => fmtTimeShort(v), width: 110 },
  { title: '交易', dataIndex: 'label', key: 'label', ellipsis: true, render: (v: string, t) => `${v}${t.paper ? ' · 模拟' : ''}` },
  { title: '盈亏', dataIndex: 'pnl', key: 'pnl', align: 'right', render: (v: number, t) => <span className={`perf-num ${sign(v)}`} title={t.net_of_commission ? '已扣佣金' : '未扣佣金'}>{usd(v)}</span> },
  { title: 'R', dataIndex: 'r', key: 'r', align: 'right', render: rCell, width: 70 },
  { title: '持有', dataIndex: 'hold_minutes', key: 'hold', align: 'right', width: 90, render: (v: number | null) => (v == null ? '—' : v >= 1440 ? `${(v / 1440).toFixed(1)} 天` : `${Math.round(v)} 分钟`) },
];

export function LedgerSection({ r }: { r: ReviewPerformanceResult }) {
  if (!r.trades.length) return null;
  return (
    <StatusCard title={`账本(新的在前,${r.trades.length} 笔)`}>
      <Table<LedgerTrade> className="review-table" size="small" rowKey="id" columns={ledgerCols} dataSource={r.trades} pagination={{ pageSize: 20, size: 'small', hideOnSinglePage: true }} />
      <Meta items={[...r.notes, excludedText(r)]} />
    </StatusCard>
  );
}

function excludedText(r: ReviewPerformanceResult): string | null {
  const bits: string[] = [];
  if (r.excluded.open) bits.push(`持仓中 ${r.excluded.open}`);
  if (r.excluded.unknown) bits.push(`结果不明 ${r.excluded.unknown}(多半是到期结算价取不到,连上 TWS 再看)`);
  if (r.excluded.no_cost) bits.push(`成本不明 ${r.excluded.no_cost}(建仓早于已同步的成交)`);
  return bits.length ? `没进账本:${bits.join(' · ')}` : null;
}
