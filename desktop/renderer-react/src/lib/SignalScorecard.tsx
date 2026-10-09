/**
 * 绩效体检页的「信号成绩单」:价位提醒、盯异动、强势股新入选、K线 PA 的方向,发出之后 1 / 5 / 20 个交易日押对了没有,
 * 和同一只标的在信号之前随手一天比。数字、结论、口径说明全是引擎 review.signals 给的(signalOutcomes.ts),这里不算。
 * 要逐只取日线,所以点了才算,不跟着页面自动刷。
 */
import { useState } from 'react';
import { Button, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { dafri, errorMessage } from '../bridge';
import type { ReviewSignalsResult, SignalGroup, SignalHorizonStats } from '../bridge';
import { fmtTimeShort } from './format';
import { EmptyState, Meta, Primer, StatusCard, type Tone, Working } from '../ui/kit';

const TONE: Record<SignalGroup['tone'], Tone> = { good: 'ok', info: 'info', warn: 'warn', bad: 'bad' };
const pct = (v: number | null | undefined): string => (v == null ? '—' : `${v > 0 ? '+' : ''}${v}%`);
const sign = (v: number | null | undefined): string => (v == null ? '' : v > 0 ? 'pos' : v < 0 ? 'neg' : '');

const cols: ColumnsType<SignalHorizonStats> = [
  { title: '持有', dataIndex: 'horizon', key: 'h', render: (v: number) => `${v} 个交易日` },
  { title: '走完(条)', dataIndex: 'n', key: 'n', align: 'right' },
  // 持有期互不重叠的有几段:同一天的、前后挨着的信号涨跌是一起的。右边几列都是按段算的(一段一票),下结论数的也是这个
  { title: '不重叠(段)', dataIndex: 'independent', key: 'indep', align: 'right' },
  { title: '平均', dataIndex: 'mean_pct', key: 'mean', align: 'right', render: (v: number | null) => <span className={`perf-num ${sign(v)}`}>{pct(v)}</span> },
  { title: '押对', dataIndex: 'hit_rate', key: 'hit', align: 'right', render: (v: number | null) => (v == null ? '—' : `${v}%`) },
  { title: '随手一天', dataIndex: 'baseline_pct', key: 'base', align: 'right', render: (v: number | null) => pct(v) },
  { title: '多出', dataIndex: 'edge_pct', key: 'edge', align: 'right', render: (v: number | null) => <span className={`perf-num ${sign(v)}`}>{pct(v)}</span> },
  { title: 't', dataIndex: 't', key: 't', align: 'right', render: (v: number | null) => (v == null ? '—' : String(v)) },
];

export function SignalScorecard({ days }: { days: number }) {
  const [data, setData] = useState<ReviewSignalsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setData(await dafri.reviewSignals(days ? { days } : {}));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="row tight">
        <Button size="small" loading={loading} onClick={() => void load()}>{data ? '重新打分' : '给信号打分'}</Button>
        <span className="muted">价位提醒、盯异动、强势股新入选、K线 PA 读出的方向,每一条之后押对了没有;要连 TWS 取日线</span>
      </div>
      {loading && !data ? <Working>正在逐只取日线…</Working> : null}
      {error ? <StatusCard tone="bad" title="算不出来"><div>{error}</div></StatusCard> : null}
      {data && !data.total ? (
        <EmptyState compact>还没有记下的信号。价位提醒与盯异动每发一条、强势股筛选扫出今天新入选的、K线 PA 读出方向,都会记一笔。</EmptyState>
      ) : null}
      {data && data.total ? (
        <>
          <div className="perf-findings">
            {data.groups.map((g) => (
              <StatusCard key={`${g.source}:${g.variant ?? ''}`} tone={TONE[g.tone]} title={`${g.label} · ${g.signals} 条`}>
                {/* 结论放正文:标题一行放不下会被截断,而这句话是整张卡最要紧的 */}
                <div>{g.verdict}</div>
                <Table<SignalHorizonStats> className="review-table" size="small" pagination={false} rowKey="horizon" columns={cols} dataSource={g.horizons} />
              </StatusCard>
            ))}
          </div>
          <Meta items={[
            data.missing_symbols.length ? `取不到日线:${data.missing_symbols.join('、')}` : null,
            data.dropped.uncovered ? `${data.dropped.uncovered} 条比取到的日线还早,没算` : null,
            data.dropped.no_baseline ? `${data.dropped.no_baseline} 条之前的日线不够,没有基线` : null,
            data.recent[0] ? `最近一条:${fmtTimeShort(data.recent[0].at)} ${data.recent[0].symbol} ${data.recent[0].label}` : null,
          ]} />
          <Primer id="signal-scorecard" summary="这些数是怎么算的、能信到什么程度" defaultOpen>
            {data.notes.map((note) => <p key={note}>{note}</p>)}
          </Primer>
        </>
      ) : null}
    </>
  );
}
