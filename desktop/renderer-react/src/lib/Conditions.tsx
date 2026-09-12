/**
 * 异动的「触发条件」(阈值)。原来在 pages/Quality.tsx 里,那一页并进板块页之后整段搬到这里,判断没改。
 *
 * 阈值:改完 600ms 防抖再存——InputNumber 每敲一个字符就 onChange,逐字存会把"2.5"存成"2"再存成"2.5"。
 * 档位只让人填第一档,后面按比例自动排:三档各填各的,很容易填出不升序的一组,还得再解释为什么被拒。
 */
import { useEffect, useRef, useState } from 'react';
import { Segmented } from 'antd';
import type { QualityConfig } from '../bridge';
import { round2 } from './anomalyFormat';
import { saveQualityConfig } from '../store/quality';
import { EmptyState, Group, GroupRow, NumberRow } from '../ui/kit';

const WINDOW_OPTIONS = [
  { value: 3, label: '3 分钟' },
  { value: 5, label: '5 分钟' },
  { value: 10, label: '10 分钟' },
];

export function Conditions({ config }: { config: QualityConfig | null }) {
  const [draft, setDraft] = useState<QualityConfig | null>(config);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef<Partial<QualityConfig>>({});

  // 引擎那份变了(保存回执 / 别处改过 / 存失败后重读),且本地没有待存的改动,就跟上
  useEffect(() => {
    if (!pending.current) setDraft(config);
  }, [config]);

  // 离开页面时还有没存的改动:立刻存,不丢
  useEffect(
    () => () => {
      if (pending.current) {
        clearTimeout(pending.current);
        pending.current = null;
        const part = dirty.current;
        dirty.current = {};
        void saveQualityConfig(part);
      }
    },
    [],
  );

  function patch(part: Partial<QualityConfig>) {
    setDraft((d) => (d ? { ...d, ...part } : d));
    dirty.current = { ...dirty.current, ...part };
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => {
      pending.current = null;
      const toSave = dirty.current;
      dirty.current = {};
      void saveQualityConfig(toSave);
    }, 600);
  }

  if (!draft) return <EmptyState compact>阈值还没读到。</EmptyState>;
  const rvol0 = draft.rvol_tiers[0] ?? 2;
  const day0 = draft.day_sigma_tiers[0] ?? 2;
  const W = draft.window_min;
  return (
    <Group className="quality-conditions" hint="改完自动保存,下一轮(5 秒内)生效;今天已经报过的档不会重报。">
      <NumberRow
        key="rvol"
        label="全天放量:起报倍数"
        sub={`三档 ${draft.rvol_tiers.map((t) => `${t}×`).join(' / ')},后两档按 1.5 倍、2.5 倍自动排;每档一天报一次`}
        min={1.2}
        max={20}
        step={0.5}
        value={rvol0}
        onChange={(v) => {
          if (v == null || !(v >= 1.2)) return;
          const a = round2(Math.min(20, v));
          patch({ rvol_tiers: [a, round2(a * 1.5), round2(a * 2.5)] });
        }}
      />
      <NumberRow
        key="burst"
        label={`${W} 分钟放量:倍数`}
        sub={`近 ${W} 分钟成交量是同时段常态的几倍就报;回落到一半以下并过了冷却才会再报`}
        min={1.5}
        max={50}
        step={0.5}
        value={draft.burst_ratio}
        onChange={(v) => {
          if (v == null || !(v >= 1.5)) return;
          patch({ burst_ratio: round2(Math.min(50, v)) });
        }}
      />
      <GroupRow key="window" label="短时窗口" sub="放量与急涨急跌看的是最近多久">
        <Segmented size="small" options={WINDOW_OPTIONS} value={W} onChange={(v) => patch({ window_min: Number(v) })} />
      </GroupRow>
      <NumberRow
        key="spike"
        label={`${W} 分钟急涨急跌:几个 σ`}
        sub={`且不低于 ${draft.spike_min_pct}%;没有历史波动率的股按固定 ${draft.spike_fixed_pct}%`}
        min={1.5}
        max={20}
        step={0.5}
        value={draft.spike_sigma}
        onChange={(v) => {
          if (v == null || !(v >= 1.5)) return;
          patch({ spike_sigma: round2(Math.min(20, v)) });
        }}
      />
      <NumberRow
        key="day"
        label="大涨大跌:起报 σ"
        sub={`三档 ${draft.day_sigma_tiers.map((t) => `${t}σ`).join(' / ')}(日 σ),后两档 +1σ、+2σ;没有历史波动率时按 ${draft.day_fixed_tiers.map((t) => `${t}%`).join(' / ')}`}
        min={0.5}
        max={18}
        step={0.5}
        value={day0}
        onChange={(v) => {
          if (v == null || !(v >= 0.5)) return;
          const a = round2(Math.min(18, v));
          patch({ day_sigma_tiers: [a, round2(a + 1), round2(a + 2)] });
        }}
      />
      <NumberRow
        key="cooldown"
        label="冷却(分钟)"
        sub="短时放量 / 急涨急跌报过之后,至少隔这么久才会再报同一类"
        min={1}
        max={240}
        step={1}
        value={draft.cooldown_min}
        onChange={(v) => {
          if (v == null || !(v >= 1)) return;
          patch({ cooldown_min: Math.round(Math.min(240, v)) });
        }}
      />
    </Group>
  );
}
