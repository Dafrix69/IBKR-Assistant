/**
 * 回测页的「参数扫描 · 样本外」:同一个策略试一批参数,样本内挑、样本外看,再做滚动前推。
 * 数字全是引擎 backtest.sweep 算的(backtestLab.ts),这里只负责拼网格与摆结果。
 */
import { useState } from 'react';
import { Button, Input, InputNumber, Segmented, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { dafri, errorMessage } from '../bridge';
import type { BacktestRunSpec, BacktestStrategy, BacktestSweepResult, BacktestSweepSpec, SweepObjective, SweepRow } from '../bridge';
import { Group, GroupRow, Meta, StatTile, StatusCard, Working } from '../ui/kit';

const pct = (v: number | null | undefined): string => (v == null ? '—' : `${v > 0 ? '+' : ''}${v}%`);
const tone = (v: number | null | undefined): 'pos' | 'neg' | '' => (v == null ? '' : v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const paramText = (p: Record<string, number>): string => Object.entries(p).map(([k, v]) => `${k}=${v}`).join(' · ');

/** "5, 10 20" → [5, 10, 20];认不出的丢掉 */
function parseValues(text: string): number[] {
  return text.split(/[,,\s]+/).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0);
}

/** 默认网格:默认值的一半、本身、一倍半 */
function defaultGrid(strategy: BacktestStrategy | null): Record<string, string> {
  return Object.fromEntries(Object.entries(strategy?.params || {}).map(([k, v]) => [k, [Math.max(1, Math.round(v / 2)), v, Math.round(v * 1.5)].join(', ')]));
}

const rowCols: ColumnsType<SweepRow> = [
  { title: '参数', dataIndex: 'params', key: 'params', render: (p: Record<string, number>) => paramText(p) },
  { title: '样本内', key: 'is', align: 'right', render: (_: unknown, r) => <span className={`perf-num ${tone(r.is.return_pct)}`}>{pct(r.is.return_pct)}</span> },
  { title: '样本外', key: 'oos', align: 'right', render: (_: unknown, r) => <span className={`perf-num ${tone(r.oos.return_pct)}`}>{pct(r.oos.return_pct)}</span> },
  { title: '样本外买入持有', key: 'bench', align: 'right', render: (_: unknown, r) => pct(r.oos.bench_return_pct) },
  { title: '样本外回撤', key: 'dd', align: 'right', render: (_: unknown, r) => pct(r.oos.max_drawdown_pct) },
  { title: '样本外名次', dataIndex: 'oos_rank', key: 'rank', align: 'right', width: 90 },
];

export interface SweepContext {
  symbol: string;
  start: string;
  end: string;
  strategy: BacktestStrategy | null;
  instrument: NonNullable<BacktestRunSpec['instrument']>;
  costPct: number | null;
}

export function SweepPanel({ ctx }: { ctx: SweepContext }) {
  const [extra, setExtra] = useState('');
  const [grid, setGrid] = useState<Record<string, string>>({});
  const [split, setSplit] = useState<number | null>(70);
  const [folds, setFolds] = useState<number | null>(3);
  const [objective, setObjective] = useState<SweepObjective>('return');
  const [result, setResult] = useState<BacktestSweepResult | null>(null);
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const strategy = ctx.strategy;
  const sweepable = strategy && strategy.key !== 'custom' && strategy.key !== 'buy_hold';
  const shown = { ...defaultGrid(strategy), ...grid };

  async function run() {
    if (!strategy) return;
    const symbols = [ctx.symbol, ...extra.split(/[,,\s]+/)].map((x) => x.trim().toUpperCase()).filter(Boolean);
    const spec: BacktestSweepSpec = {
      symbols,
      start: ctx.start,
      end: ctx.end,
      strategy: strategy.key,
      grid: Object.fromEntries(Object.keys(strategy.params || {}).map((k) => [k, parseValues(shown[k] ?? '')]).filter(([, v]) => (v as number[]).length)),
      instrument: ctx.instrument,
      split_pct: split ?? 70,
      folds: folds ?? 0,
      objective,
      ...(ctx.costPct ? { cost_pct: ctx.costPct } : {}),
    };
    setRunning(true);
    setFailure(null);
    try {
      setResult(await dafri.sweepBacktest(spec));
    } catch (err) {
      setResult(null);
      setFailure(errorMessage(err));
    } finally {
      setRunning(false);
    }
  }

  if (!sweepable) return <p className="hint">选一个带参数的预置策略(均线交叉、RSI、N 日突破)才能扫参数。</p>;
  const best = result?.best ?? null;
  const wf = result?.walk_forward ?? null;
  const corrTone = result?.rank_corr == null ? 'info' : result.rank_corr < 0.3 ? 'warn' : 'ok';
  return (
    <>
      <Group hint="参数只在样本内挑,成绩看样本外;滚动前推每一折只用之前的数据挑参数,连起来的收益才是不偷看未来的数。">
        <GroupRow label="再加几只" sub="逗号分隔,最多共 8 只;得分取平均">
          <Input placeholder="如 MSFT, AMZN" value={extra} onChange={(e) => setExtra(e.target.value)} style={{ width: 240 }} />
        </GroupRow>
        {Object.keys(strategy.params || {}).map((k) => (
          <GroupRow key={k} label={`${strategy.param_labels?.[k] || k} 试哪些值`} sub={k}>
            <Input value={shown[k]} onChange={(e) => setGrid((g) => ({ ...g, [k]: e.target.value }))} style={{ width: 240 }} />
          </GroupRow>
        ))}
        <GroupRow label="样本内占比" sub="%,50–90">
          <InputNumber min={50} max={90} step={5} value={split} onChange={setSplit} />
        </GroupRow>
        <GroupRow label="滚动前推" sub="折数,2–6;0 = 不做">
          <InputNumber min={0} max={6} step={1} value={folds} onChange={setFolds} />
        </GroupRow>
        <GroupRow label="挑参数按">
          <Segmented size="small" value={objective} onChange={(v) => setObjective(v as SweepObjective)}
            options={[{ label: '总收益', value: 'return' }, { label: 'Calmar(年化 ÷ 回撤)', value: 'calmar' }]} />
        </GroupRow>
      </Group>
      <div className="row tight">
        <Button loading={running} onClick={() => void run()} disabled={!ctx.symbol.trim()}>扫参数 · 看样本外</Button>
        <span className="muted">用上面的标的、区间、品种与成交成本</span>
      </div>
      {running ? <Working>正在逐只拉日线、试每一组参数…</Working> : null}
      {failure ? <StatusCard tone="bad" title="扫描失败"><div>{failure}</div></StatusCard> : null}
      {result && !running ? (
        <>
          <StatusCard tone={corrTone} title={`${result.symbols.join('、')} · ${result.start} → ${result.end} · 样本外从 ${result.split_date} 起`}>
            <div className="stat-grid">
              <StatTile label="样本内第一名" value={best ? paramText(best.params) : '—'} />
              <StatTile label="它在样本内" value={pct(best?.is.return_pct)} tone={tone(best?.is.return_pct)} />
              <StatTile label="它在样本外" value={pct(best?.oos.return_pct)} tone={tone(best?.oos.return_pct)} />
              <StatTile label="样本外名次" value={best ? `${best.oos_rank} / ${result.rows.length}` : '—'} />
              <StatTile label="样本内外排名相关" value={result.rank_corr == null ? '—' : String(result.rank_corr)} />
              {wf ? <StatTile label={`滚动前推 ${wf.folds.length} 折`} value={pct(wf.total_return_pct)} tone={tone(wf.total_return_pct)} /> : null}
              {wf ? <StatTile label="同期买入持有" value={pct(wf.bench_return_pct)} /> : null}
            </div>
            <Meta items={[
              `试了 ${result.combos} 组${result.skipped.length ? `,${result.skipped.length} 组不合法跳过` : ''}`,
              result.cost_pct ? `每边成本 ${result.cost_pct}%` : null,
              ...result.notes,
            ]} />
          </StatusCard>
          <Table<SweepRow> className="review-table" size="small" rowKey={(r) => paramText(r.params)} columns={rowCols}
            dataSource={result.rows} pagination={{ pageSize: 10, size: 'small', hideOnSinglePage: true }} />
          {wf ? (
            <Table className="review-table" size="small" rowKey="test_start" pagination={false} dataSource={wf.folds}
              columns={[
                { title: '训练到', dataIndex: 'train_end', key: 'train_end' },
                { title: '测试段', key: 'test', render: (_: unknown, f: { test_start: string; test_end: string }) => `${f.test_start} → ${f.test_end}` },
                { title: '当时选的参数', dataIndex: 'params', key: 'params', render: (p: Record<string, number>) => paramText(p) },
                { title: '测试段收益', dataIndex: 'test_return_pct', key: 'ret', align: 'right', render: (v: number) => <span className={`perf-num ${tone(v)}`}>{pct(v)}</span> },
                { title: '买入持有', dataIndex: 'bench_return_pct', key: 'bench', align: 'right', render: (v: number) => pct(v) },
              ]} />
          ) : null}
        </>
      ) : null}
    </>
  );
}
