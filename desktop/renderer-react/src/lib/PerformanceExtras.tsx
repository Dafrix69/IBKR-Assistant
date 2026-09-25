/**
 * 绩效体检页的两节:执行损耗、保护规则建议。
 * 数字与建议全是引擎 review.performance 算的(execQuality.ts / performance.ts 的 protectionAdvice),这里只负责摆;
 * 「按建议填入」是人点了才发 settings.patch,引擎不会自己改设置。
 */
import { useState } from 'react';
import { Button, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { dafri, errorMessage } from '../bridge';
import type { ExecutionRow, ProtectionAdvice, ReviewPerformanceResult, SettingsPatch } from '../bridge';
import { showBanner } from '../store/banner';
import { refreshStatus } from '../store/status';
import { fmtTimeShort } from './format';
import { usd } from './PerformanceParts';
import { Meta, StatTile, StatusCard } from '../ui/kit';

const PATH_LABEL: Record<ExecutionRow['path'], string> = { auto_close: '到价平仓', hosted_sweep: '托管追价' };
const SEC_LABEL: Record<string, string> = { STK: '股票', OPT: '单腿期权', FOP: '期货期权', BAG: '组合' };

const execCols: ColumnsType<ExecutionRow> = [
  { title: '触发', dataIndex: 'at', key: 'at', width: 110, render: (v: string) => fmtTimeShort(v) },
  { title: '标的', dataIndex: 'symbol', key: 'symbol', render: (v: string, r) => `${v} · ${SEC_LABEL[r.sec_type] ?? r.sec_type}${r.paper ? ' · 模拟' : ''}` },
  { title: '路径', dataIndex: 'path', key: 'path', render: (v: ExecutionRow['path']) => PATH_LABEL[v] },
  { title: '触发价 → 成交', key: 'px', align: 'right', render: (_: unknown, r) => `${r.mark} → ${r.fill}` },
  { title: '让出', dataIndex: 'cost_usd', key: 'cost', align: 'right', render: (v: number, r) => `${usd(-v)}(${r.cost_pct}%)` },
];

export function ExecutionSection({ r }: { r: ReviewPerformanceResult }) {
  const e = r.execution;
  if (!e.samples && !e.missing) return null;
  return (
    <StatusCard title={`自动平仓的执行损耗(${e.samples} 笔)`} tone={e.median_pct != null && e.median_pct > 3 ? 'warn' : 'info'}>
      <div className="stat-grid">
        <StatTile label="合计让出" value={usd(e.total_usd == null ? null : -e.total_usd)} tone={e.total_usd != null && e.total_usd > 0 ? 'neg' : ''} />
        <StatTile label="每笔平均" value={usd(e.avg_usd == null ? null : -e.avg_usd)} />
        <StatTile label="占触发价 · 中位数" value={e.median_pct == null ? '—' : `${e.median_pct}%`} />
        <StatTile label="占触发价 · 平均" value={e.avg_pct == null ? '—' : `${e.avg_pct}%`} />
        {e.by_sec_type.map((g) => (
          <StatTile key={g.sec_type} label={`${SEC_LABEL[g.sec_type] ?? g.sec_type} · ${g.samples} 笔`} value={g.median_pct == null ? '—' : `${g.median_pct}%`} />
        ))}
      </div>
      {e.rows.length ? (
        <Table<ExecutionRow> className="review-table" size="small" rowKey={(x) => `${x.at}|${x.symbol}|${x.path}`} columns={execCols}
          dataSource={e.rows} pagination={{ pageSize: 10, size: 'small', hideOnSinglePage: true }} />
      ) : null}
      <Meta
        items={[
          '触发价是那一刻的持仓现价(中间价口径),让出 = 平多头卖低了、平空头买高了的部分。中位数可以填进回测的「每次成交成本」',
          e.missing ? `${e.missing} 条平仓痕算不出:2026-09-26 之前没记触发价,或单子没成交` : null,
        ]}
      />
    </StatusCard>
  );
}

const RULE_LABEL: Record<ProtectionAdvice['rule'], string> = {
  daily_loss: '日内亏损上限', stoploss_guard: '止损护栏', cooldown: '同标的冷却',
};

function adviceText(a: ProtectionAdvice): string {
  if (a.rule === 'daily_loss') return `当天净亏到 $${a.suggested.max_loss_usd} 就停`;
  if (a.rule === 'stoploss_guard') return `${a.suggested.lookback_minutes} 分钟内止损 ${a.suggested.trigger_count} 次 → 暂停 ${a.suggested.pause_minutes} 分钟`;
  return `平仓后 ${a.suggested.minutes} 分钟内不再对同一只下新单`;
}

/** 只发这一条规则的那一段;别的规则、别的设置一个键都不带。 */
function patchOf(a: ProtectionAdvice): SettingsPatch {
  if (a.rule === 'daily_loss') return { protections: { daily_loss: a.suggested } };
  if (a.rule === 'stoploss_guard') return { protections: { stoploss_guard: a.suggested } };
  return { protections: { cooldown: a.suggested } };
}

export function AdviceSection({ r, onApplied }: { r: ReviewPerformanceResult; onApplied: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  if (!r.protection_advice.length) return null;
  async function apply(a: ProtectionAdvice) {
    const ok = await dafri.confirm({
      title: `打开${RULE_LABEL[a.rule]}`,
      message: adviceText(a),
      detail: '只挡新单,永远不挡平仓。之后可以在「设置 → 保护规则」里改或关掉。',
      confirmLabel: '按建议填入',
    });
    if (!ok) return;
    setBusy(a.rule);
    try {
      await dafri.patchSettings(patchOf(a));
      showBanner(`${RULE_LABEL[a.rule]}已打开:${adviceText(a)}`, true);
      await refreshStatus();
      onApplied();
    } catch (err) {
      showBanner(`没填进去(设置未改动):${errorMessage(err)}`, false);
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="perf-findings">
      {r.protection_advice.map((a) => (
        <StatusCard key={a.rule} tone="warn" title={`${RULE_LABEL[a.rule]}:${adviceText(a)}`}
          extra={<Button size="small" loading={busy === a.rule} onClick={() => void apply(a)}>按建议填入</Button>}>
          <div>{a.reason}</div>
          <Meta className="perf-source" items={[`借鉴:${a.source}`]} />
        </StatusCard>
      ))}
    </div>
  );
}
