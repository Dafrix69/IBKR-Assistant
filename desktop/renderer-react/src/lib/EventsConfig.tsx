/**
 * 「重要事件」的口径(设置页):开不开、拉不拉公开日历、要不要中等影响的、提前几分钟、板块联动的线。
 * 存在引擎的偏好表里(events.set_config),越界由引擎拒绝并给中文原因。数字改完 600ms 防抖再存,同 TouchConfig。
 */
import { useEffect, useRef, useState } from 'react';
import { showBanner } from '../store/banner';
import { saveEventsConfig, useEvents, type EventsConfig as Config } from '../store/events';
import { EmptyState, Group, NumberRow, SwitchRow } from '../ui/kit';

export function EventsConfig() {
  const { list } = useEvents();
  const config = list?.config ?? null;
  const [draft, setDraft] = useState<Config | null>(config);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef<Partial<Config>>({});

  useEffect(() => {
    if (!pending.current) setDraft(config);
  }, [config]);

  useEffect(
    () => () => {
      if (pending.current) {
        clearTimeout(pending.current);
        pending.current = null;
        const part = dirty.current;
        dirty.current = {};
        void save(part);
      }
    },
    [],
  );

  async function save(part: Partial<Config>) {
    const problem = await saveEventsConfig(part);
    if (problem) showBanner(`没改成:${problem}`, false);
  }

  function patch(part: Partial<Config>, now = false) {
    setDraft((d) => (d ? { ...d, ...part } : d));
    dirty.current = { ...dirty.current, ...part };
    if (pending.current) clearTimeout(pending.current);
    const flush = () => {
      pending.current = null;
      const toSave = dirty.current;
      dirty.current = {};
      void save(toSave);
    };
    if (now) flush();
    else pending.current = setTimeout(flush, 600);
  }

  if (!draft) return <EmptyState compact>设置还没读到。</EmptyState>;
  const lead1 = draft.lead_minutes[0] ?? null;
  const lead2 = draft.lead_minutes[1] ?? null;
  const setLeads = (a: number | null, b: number | null) => patch({ lead_minutes: [a, b].filter((x): x is number => x !== null) });

  return (
    <Group hint="今天要公布的数(CPI、非农、FOMC…)一直挂在顶栏下面,直到公布过了一阵;公布前弹窗提醒,「应对」能把一句对冲指令写进指令框。板块联动:一个板块里多数成分股同向走出一大截时也挂上去。">
      <SwitchRow icon="sf-bell" tint="orange" label="重要事件" sub="关了就不挂、不提醒、不拉日历" checked={draft.enabled} onChange={(v) => patch({ enabled: v }, true)} />
      <SwitchRow icon="sf-scan" tint="blue" label="公开日历" sub="Forex Factory 的本周日历(faireconomy.media),几小时拉一次;关了只剩内置的官方日程(CPI、PPI、非农、FOMC、PCE、GDP)" checked={draft.feed} disabled={!draft.enabled} onChange={(v) => patch({ feed: v }, true)} />
      <SwitchRow icon="sf-layers" tint="gray" label="中等影响的也算" sub="初请失业金、费城联储这类;只在公布前一小时内上顶,提前提醒只报公布那一刻" checked={draft.medium} disabled={!draft.enabled} onChange={(v) => patch({ medium: v }, true)} />
      <NumberRow icon="sf-clock" tint="orange" label="第一次提前提醒" sub="分钟;空着 = 不要这一档" min={1} max={1440} step={5} placeholder="不要" value={lead1} disabled={!draft.enabled} onChange={(v) => setLeads(v, lead2)} />
      <NumberRow icon="sf-clock" tint="orange" label="第二次提前提醒" sub="分钟" min={1} max={1440} step={5} placeholder="不要" value={lead2} disabled={!draft.enabled} onChange={(v) => setLeads(lead1, v)} />
      <NumberRow icon="sf-updown" tint="red" label="板块联动:涨跌幅" sub="% 较昨收,同向超过它才算" min={0.5} max={50} step={0.5} value={draft.sector_move_pct} disabled={!draft.enabled} onChange={(v) => { if (v !== null) patch({ sector_move_pct: v }); }} />
      <NumberRow icon="sf-layers" tint="red" label="板块联动:比例" sub="% 的成分股同向超线" min={30} max={100} step={10} value={Math.round(draft.sector_share * 100)} disabled={!draft.enabled} onChange={(v) => { if (v !== null) patch({ sector_share: v / 100 }); }} />
      <NumberRow icon="sf-layers" tint="red" label="板块联动:最少只数" sub="有行情的成分股少于它的板块不看" min={2} max={30} step={1} value={draft.sector_min_stocks} disabled={!draft.enabled} onChange={(v) => { if (v !== null) patch({ sector_min_stocks: v }); }} />
    </Group>
  );
}
