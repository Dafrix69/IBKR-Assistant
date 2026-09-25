import { useCallback, useEffect, useState } from 'react';
import { Button, Segmented, Select } from 'antd';
import { dafri, errorMessage } from '../bridge';
import type { PerformanceKind, PerformanceScope, ReviewPerformanceResult } from '../bridge';
import { EquitySection, FindingsSection, GroupsSection, LedgerSection, StatsSection } from '../lib/PerformanceParts';
import { AdviceSection, ExecutionSection } from '../lib/PerformanceExtras';
import { SignalScorecard } from '../lib/SignalScorecard';
import { PositionSizer } from '../lib/PositionSizer';
import { EmptyState, Notice, PageHead, Primer, SectionTitle, Working } from '../ui/kit';

// 绩效体检:已了结交易的美元账本 → 冠军交易员天天盯的那几个数 → 行为上的毛病。
// 数字与结论全来自引擎的 review.performance(performance.ts,离线规则、不调模型);这里只负责选范围和摆。

const SCOPE_OPTIONS: { label: string; value: PerformanceScope }[] = [
  { label: '全部', value: 'all' },
  { label: '实盘', value: 'live' },
  { label: '模拟', value: 'paper' },
];
const KIND_OPTIONS: { label: string; value: PerformanceKind }[] = [
  { label: '全部品种', value: 'all' },
  { label: '蝴蝶', value: 'butterfly' },
  { label: '股票', value: 'stock' },
  { label: '期权(导入)', value: 'option' },
];
const DAY_OPTIONS = [
  { label: '全部时间', value: 0 },
  { label: '最近 30 天', value: 30 },
  { label: '最近 90 天', value: 90 },
  { label: '最近半年', value: 180 },
  { label: '最近一年', value: 365 },
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
    /* 预览台的 data: 页面没有 localStorage */
  }
}

const asScope = (v: string | null): PerformanceScope => (v === 'live' || v === 'paper' ? v : 'all');
const asKind = (v: string | null): PerformanceKind => (v === 'butterfly' || v === 'stock' || v === 'option' ? v : 'all');

/** 账本里风险固定那些交易的每份风险中位数:给仓位计算器一个起手值(蝶的权利金 × 100)。 */
function typicalUnitRisk(r: ReviewPerformanceResult | null): number | null {
  const risks = (r?.trades || []).filter((t) => t.risk != null && t.kind === 'butterfly').map((t) => t.risk as number).sort((a, b) => a - b);
  return risks.length ? risks[Math.floor(risks.length / 2)] : null;
}

export function PerformancePage() {
  const [scope, setScope] = useState<PerformanceScope>(() => asScope(read('dafri-perf-scope')));
  const [kind, setKind] = useState<PerformanceKind>(() => asKind(read('dafri-perf-kind')));
  const [days, setDays] = useState<number>(() => Number(read('dafri-perf-days')) || 0);
  const [data, setData] = useState<ReviewPerformanceResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const spec = { scope, kind, ...(days ? { days } : {}) };
      setData(await dafri.reviewPerformance(spec));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [scope, kind, days]);

  useEffect(() => {
    void load();
  }, [load]);

  const extra = (
    <div className="head-actions">
      <Segmented size="small" options={SCOPE_OPTIONS} value={scope} onChange={(v) => { setScope(v as PerformanceScope); write('dafri-perf-scope', String(v)); }} />
      <Select size="small" options={KIND_OPTIONS} value={kind} style={{ width: 120 }} onChange={(v) => { setKind(v); write('dafri-perf-kind', v); }} />
      <Select size="small" options={DAY_OPTIONS} value={days} style={{ width: 110 }} onChange={(v) => { setDays(v); write('dafri-perf-days', String(v)); }} />
      <Button size="small" onClick={() => void load()} loading={loading}>
        重新计算
      </Button>
    </div>
  );

  return (
    <section className="tab-panel active" id="page-performance">
      <PageHead title="绩效体检" extra={extra} />
      <Primer id="performance" intro summary="冠军们天天盯的几个数:胜率 × 盈亏比 = 期望值,再看回撤与行为。">
        <p>
          账本是交易分析页的同一批真实成交(蝴蝶、股票持仓段)加上导入的 Flex 期权仓位,只算已经了结的。数字与结论都由本机代码算,不调模型、不外发。
        </p>
        <p>
          规则借鉴自实盘比赛的优胜者与他们的教练:Van Tharp 的期望值与 R 倍数,Mark Minervini(美国投资锦标赛 1997、2021 冠军)的"小亏就走"与渐进式仓位,
          Andrea Unger(四届 World Cup 期货冠军)的时段过滤,Kevin Davey 的"样本够多才谈优势",以及期货实盘大赛把回撤算进排名的做法。
          它们只描述已经发生的事与一条可以对照的规矩,不是买卖建议。
        </p>
      </Primer>

      {error ? <Notice tone="bad" title="算不出来">{error}</Notice> : null}
      {loading && !data ? <Working>正在翻账本…</Working> : null}
      {data && !data.stats.trades ? (
        <EmptyState>这个范围里还没有已了结的交易。连上 TWS 打开一次「交易分析」同步成交,或用命令行导入 Flex 期权仓位。</EmptyState>
      ) : null}
      {data && data.stats.trades ? (
        <>
          <SectionTitle count={data.findings.length}>体检结论</SectionTitle>
          <FindingsSection findings={data.findings} />
          {data.protection_advice.length ? <SectionTitle count={data.protection_advice.length}>保护规则建议</SectionTitle> : null}
          <AdviceSection r={data} onApplied={() => void load()} />
          <SectionTitle>核心数字</SectionTitle>
          <StatsSection r={data} />
          <EquitySection r={data} />
          <GroupsSection r={data} />
          <ExecutionSection r={data} />
          <SectionTitle>下一笔做多大</SectionTitle>
          <PositionSizer key={String(typicalUnitRisk(data))} typicalRisk={typicalUnitRisk(data)} losingStreak={data.stats.max_consecutive_losses} />
          <SectionTitle>明细</SectionTitle>
          <LedgerSection r={data} />
        </>
      ) : null}
      <SectionTitle>信号成绩单</SectionTitle>
      <SignalScorecard days={days} />
    </section>
  );
}
