/**
 * 仓位计算器:固定风险比例(先定这一笔最多亏账户的百分之几,再倒推做几份)。
 * 权益与比例记在本机(只是方便下次不用重填,不是交易状态);算法在 lib/sizing.ts。
 * 只算不下单:结果是一个数,要不要照它做由人决定。
 */
import { useState } from 'react';
import { InputNumber } from 'antd';
import { sizePosition } from './sizing';
import { fmtMoney } from './format';
import { Meta, StatTile, StatusCard } from '../ui/kit';

const EQUITY_KEY = 'dafri-sizer-equity';
const PCT_KEY = 'dafri-sizer-pct';

function readNum(key: string, fallback: number | null): number | null {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}
function writeNum(key: string, v: number | null): void {
  try {
    if (v === null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(v));
  } catch {
    /* 预览台的 data: 页面没有 localStorage */
  }
}

/** `typicalRisk`:账本里风险固定那些交易的每份风险中位数,给"每份最大亏损"一个起手值;`losingStreak`:历史最大连亏。 */
export function PositionSizer({ typicalRisk, losingStreak }: { typicalRisk: number | null; losingStreak: number }) {
  const [equity, setEquity] = useState<number | null>(() => readNum(EQUITY_KEY, null));
  const [pct, setPct] = useState<number | null>(() => readNum(PCT_KEY, 1));
  const [unit, setUnit] = useState<number | null>(typicalRisk);
  const r = sizePosition({ equity, riskPct: pct, unitRisk: unit, losingStreak: Math.max(losingStreak, 1) });
  const tooHot = pct !== null && pct > 2;

  return (
    <StatusCard title="仓位计算器 · 固定风险比例" tone={tooHot ? 'warn' : 'info'}>
      <div className="sizer-inputs">
        <label>
          <span>账户权益(美元)</span>
          <InputNumber min={0} step={1000} value={equity} onChange={(v) => { const n = v === null ? null : Number(v); setEquity(n); writeNum(EQUITY_KEY, n); }} placeholder="例如 50000" />
        </label>
        <label>
          <span>单笔风险(%)</span>
          <InputNumber min={0.1} max={10} step={0.25} value={pct} onChange={(v) => { const n = v === null ? null : Number(v); setPct(n); writeNum(PCT_KEY, n); }} />
        </label>
        <label>
          <span>每份最大亏损(美元)</span>
          <InputNumber min={0} step={10} value={unit} onChange={(v) => setUnit(v === null ? null : Number(v))} placeholder="蝶 = 权利金 × 100" />
        </label>
      </div>
      {r ? (
        <div className="stat-grid">
          <StatTile label="这一笔的风险预算" value={`$${fmtMoney(r.budget)}`} />
          <StatTile label="可做份数" value={String(r.units)} tone={r.units ? '' : 'neg'} />
          <StatTile label="取整后实际风险" value={`$${fmtMoney(r.actualRisk)} · ${r.actualPct.toFixed(2)}%`} />
          {r.streakDrawdownPct !== null ? (
            <StatTile label={`连亏 ${Math.max(losingStreak, 1)} 笔后的回撤`} value={`${r.streakDrawdownPct.toFixed(1)}%`} tone={r.streakDrawdownPct >= 20 ? 'neg' : ''} />
          ) : null}
        </div>
      ) : (
        <p className="hint">填上账户权益、单笔风险与每份最大亏损,就能算出做几份。</p>
      )}
      <Meta
        items={[
          '冠军们的单笔风险多在账户的 0.5%–2%:Minervini 主张每笔最多亏 1.25%–2.5%,连亏时再往下调',
          tooHot ? '单笔风险超过 2%:历史最大连亏再来一次,回撤会很深' : null,
          r && !r.units ? '预算连一份都不够:要么换更便宜的结构,要么这一笔不做' : null,
        ]}
      />
    </StatusCard>
  );
}
