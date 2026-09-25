/**
 * 「反复碰均线」的口径:哪几条日均线、几个交易日内、第几次起报、离多近算碰。判定全在引擎(maTouch.ts),
 * 这里只给数;越界由引擎拒绝并给中文原因(「10 个交易日里最多只能分出 5 段」这种话界面自己说不全)。
 *
 * 数字改完 600ms 防抖再存,同 Conditions.tsx:InputNumber 每敲一个字符就 onChange,逐字存会把"12"先存成"1"被拒。
 */
import { useEffect, useRef, useState } from 'react';
import { Select } from 'antd';
import type { MaTouchConfig } from '../bridge';
import { saveTouchConfig } from '../store/alerts';
import { EmptyState, Group, GroupRow, NumberRow, SwitchRow } from '../ui/kit';

const PERIOD_OPTIONS = [5, 10, 20, 30, 50, 60, 120, 200, 250].map((p) => ({ value: String(p), label: `${p} 日` }));

export function TouchConfig({ config }: { config: MaTouchConfig | null }) {
  const [draft, setDraft] = useState<MaTouchConfig | null>(config);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef<Partial<MaTouchConfig>>({});

  // 引擎那份变了(保存回执 / 存失败后重读),且本地没有待存的改动,就跟上
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
        void saveTouchConfig(part);
      }
    },
    [],
  );

  function patch(part: Partial<MaTouchConfig>, now = false) {
    setDraft((d) => (d ? { ...d, ...part } : d));
    dirty.current = { ...dirty.current, ...part };
    if (pending.current) clearTimeout(pending.current);
    const flush = () => {
      pending.current = null;
      const toSave = dirty.current;
      dirty.current = {};
      void saveTouchConfig(toSave);
    };
    if (now) flush();
    else pending.current = setTimeout(flush, 600);
  }

  if (!draft) return <EmptyState compact>设置还没读到。</EmptyState>;
  const N = draft.window_days;
  const most = Math.ceil(N / 2);
  return (
    <Group
      className="touch-conditions"
      hint={`连着几天贴着线走只算一次;两段之间至少隔一天没碰,所以 ${N} 个交易日里最多分出 ${most} 段。改完自动保存,各股的底账在接下来几分钟里按新口径重算。`}
    >
      <SwitchRow
        key="enabled"
        label="短期内反复碰同一条均线时提醒"
        sub="只在常规时段判;同一段触碰只报一次,和同一条均线的穿越并成一条"
        checked={draft.enabled}
        onChange={(v) => patch({ enabled: v }, true)}
      />
      <GroupRow key="periods" label="看哪几条日均线" sub="最多 6 条;价位条上画的是 20 / 60 / 120 / 200">
        <Select
          mode="tags"
          size="small"
          style={{ minWidth: 220 }}
          options={PERIOD_OPTIONS}
          value={draft.periods.map(String)}
          disabled={!draft.enabled}
          onChange={(vals: string[]) => {
            const periods = vals.map(Number);
            if (periods.length) patch({ periods }, true);
          }}
        />
      </GroupRow>
      <NumberRow
        key="window"
        label="「短期内」:最近几个交易日"
        sub="含今天"
        min={3}
        max={30}
        step={1}
        value={N}
        disabled={!draft.enabled}
        onChange={(v) => {
          if (v == null || !(v >= 3)) return;
          const w = Math.round(Math.min(30, v));
          // 窗口缩短之后起报次数可能凑不够了(引擎会拒):跟着压到能凑够的最大值,不让人多碰一次钉子
          const cap = Math.ceil(w / 2);
          patch(draft.min_touches > cap ? { window_days: w, min_touches: cap } : { window_days: w });
        }}
      />
      <NumberRow
        key="touches"
        label="第几次碰到开始报"
        sub={`${N} 个交易日里第 ${draft.min_touches} 段触碰时报;再碰出新的一段会再报一次`}
        min={2}
        max={most}
        step={1}
        value={draft.min_touches}
        disabled={!draft.enabled}
        onChange={(v) => {
          if (v == null || !(v >= 2)) return;
          patch({ min_touches: Math.round(Math.min(10, v)) });
        }}
      />
      <NumberRow
        key="band"
        label="离均线多近算碰到(%)"
        sub="那天的最高 / 最低价进到均线上下这个范围以内;盘中看现价,两轮之间跨过去也算"
        min={0}
        max={2}
        step={0.1}
        value={draft.band_pct}
        disabled={!draft.enabled}
        onChange={(v) => {
          if (v == null || !(v >= 0)) return;
          patch({ band_pct: Math.round(Math.min(2, v) * 100) / 100 });
        }}
      />
    </Group>
  );
}
