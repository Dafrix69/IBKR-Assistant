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

/** 带符号的美元:+$1,234.50 / -$85.00 */
export function usd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v < 0 ? '-' : v > 0 ? '+' : ''}$${fmtMoney(Math.abs(v))}`;
}

const sign = (v: number | null | undefined): 'pos' | 'neg' | '' => (v == null ? '' : v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const pct = (v: number | null | undefined): string => (v == null ? '—' : `${v}%`);
const plain = (v: number | null | undefined): string => (v == null ? '—' : String(v));

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

export function StatsSection({ r }: { r: ReviewPerformanceResult }) {
  const s = r.stats;
  const streak = r.streak.kind === 'none' ? '—' : `${r.streak.kind === 'win' ? '连赚' : '连亏'} ${r.streak.count} 笔`;
  return (
    <StatusCard title={`${s.trades} 笔已了结 · 赚 ${s.wins} · 亏 ${s.losses} · 持平 ${s.flats}`}>
      <div className="stat-grid">
        <StatTile label="净盈亏" value={usd(s.net_pnl)} tone={sign(s.net_pnl)} />
        <StatTile label="期望值(每笔)" value={usd(s.expectancy)} tone={sign(s.expectancy)} />
        <StatTile label="胜率" value={pct(s.win_rate)} />
        <StatTile label="保本所需胜率" value={pct(s.breakeven_win_rate)} />
        <StatTile label="盈亏比(均盈 / 均亏)" value={plain(s.payoff_ratio)} />
        <StatTile label="利润因子" value={plain(s.profit_factor)} />
        <StatTile label="平均盈利" value={usd(s.avg_win)} />
        <StatTile label="平均亏损" value={usd(s.avg_loss)} />
        <StatTile label="最大单笔亏损" value={usd(s.largest_loss)} tone={sign(s.largest_loss)} />
        <StatTile label="最大回撤(平仓)" value={usd(-r.drawdown.max)} tone={r.drawdown.max > 0 ? 'neg' : ''} />
        <StatTile label="恢复因子" value={plain(r.drawdown.recovery_factor)} />
        <StatTile label="最长连亏" value={`${s.max_consecutive_losses} 笔`} />
        <StatTile label="眼下" value={streak} />
        <StatTile label={`R 期望(${r.r_stats.trades} 笔)`} value={r.r_stats.expectancy_r == null ? '—' : `${r.r_stats.expectancy_r}R`} tone={sign(r.r_stats.expectancy_r)} />
        <StatTile label="SQN" value={r.r_stats.sqn == null ? '—' : `${r.r_stats.sqn} · ${r.r_stats.sqn_label}`} />
        <StatTile label="凯利比例" value={r.kelly == null ? '—' : `${(r.kelly * 100).toFixed(1)}%`} />
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

const groupCols: ColumnsType<PerfGroup> = [
  { title: '', dataIndex: 'label', key: 'label' },
  { title: '笔数', dataIndex: 'trades', key: 'trades', align: 'right' },
  { title: '胜率', dataIndex: 'win_rate', key: 'win_rate', align: 'right', render: (v: number | null) => pct(v) },
  { title: '净盈亏', dataIndex: 'net_pnl', key: 'net_pnl', align: 'right', render: (v: number) => <span className={`perf-num ${sign(v)}`}>{usd(v)}</span> },
  { title: '每笔期望', dataIndex: 'expectancy', key: 'expectancy', align: 'right', render: (v: number | null) => <span className={`perf-num ${sign(v)}`}>{usd(v)}</span> },
  { title: '利润因子', dataIndex: 'profit_factor', key: 'profit_factor', align: 'right', render: (v: number | null) => plain(v) },
];

function GroupTable({ title, rows }: { title: string; rows: PerfGroup[] }) {
  if (!rows.length) return null;
  return (
    <div className="perf-group">
      <h4>{title}</h4>
      <Table<PerfGroup> className="review-table" size="small" pagination={false} rowKey="key" columns={groupCols} dataSource={rows} />
    </div>
  );
}

export function GroupsSection({ r }: { r: ReviewPerformanceResult }) {
  return (
    <StatusCard title="分开看:优势在哪儿">
      <div className="perf-groups">
        <GroupTable title="品种" rows={r.groups.kind} />
        <GroupTable title="开仓时段(美东)" rows={r.groups.session} />
        <GroupTable title="星期" rows={r.groups.weekday} />
        <GroupTable title="标的" rows={r.groups.symbol} />
      </div>
      <Meta items={['一组不到 8 笔时胜率与期望都不稳,只当参考']} />
    </StatusCard>
  );
}

const ledgerCols: ColumnsType<LedgerTrade> = [
  { title: '了结', dataIndex: 'closed_at', key: 'closed_at', render: (v: string) => fmtTimeShort(v), width: 110 },
  { title: '交易', dataIndex: 'label', key: 'label', ellipsis: true, render: (v: string, t) => `${v}${t.paper ? ' · 模拟' : ''}` },
  { title: '盈亏', dataIndex: 'pnl', key: 'pnl', align: 'right', render: (v: number, t) => <span className={`perf-num ${sign(v)}`} title={t.net_of_commission ? '已扣佣金' : '未扣佣金'}>{usd(v)}</span> },
  { title: 'R', dataIndex: 'r', key: 'r', align: 'right', render: (v: number | null) => (v == null ? '—' : `${v}R`), width: 70 },
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
