/**
 * 「全部」:从昨天到两周后的重要事件,按天分组;自己记的事件在这里加、删(CRWV 发债、某只股财报这种日历源上没有的)。
 * 口径(提前几分钟、要不要中等影响的、板块联动的线)在「设置 → 重要事件」。
 */
import { useState } from 'react';
import { Button, Drawer, Input, Space } from 'antd';
import { countdownText, phaseOf, starText, whenText } from './eventRules';
import { showBanner } from '../store/banner';
import { addCustomEvent, loadEvents, removeCustomEvent, useEvents, type EconEvent } from '../store/events';
import { navigate } from '../store/nav';
import { EmptyState, Notice } from '../ui/kit';

const SOURCE_LABEL: Record<EconEvent['source'], string> = { builtin: '官方日程', feed: '公开日历', custom: '自己记的' };

function groupByDay(events: EconEvent[]): Array<[string, EconEvent[]]> {
  const map = new Map<string, EconEvent[]>();
  for (const e of events) {
    const list = map.get(e.date_et) ?? [];
    list.push(e);
    map.set(e.date_et, list);
  }
  return [...map.entries()];
}

export function EventList({ onClose }: { onClose: () => void }) {
  const { list, now, failure } = useEvents();
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('08:30');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function add() {
    setBusy(true);
    const problem = await addCustomEvent({ title, date_et: date.trim(), time_et: time.trim(), note: note.trim() });
    setBusy(false);
    if (problem) {
      showBanner(`没记上:${problem}`, false);
      return;
    }
    setTitle('');
    setNote('');
    showBanner('记上了。到时候和官方日程一样挂在顶上、提前提醒。', true);
  }

  async function remove(e: EconEvent) {
    const problem = await removeCustomEvent(e.id);
    if (problem) showBanner(`没删掉:${problem}`, false);
  }

  const feed = list?.feed;
  return (
    <Drawer open title="重要事件" onClose={onClose} width={520} destroyOnHidden>
      <div className="event-list">
        <div className="event-list-status muted">
          {feed?.error ? `公开日历没拉到:${feed.error};内置日程照样有。` : feed?.at ? `公开日历更新于 ${new Date(feed.at).toLocaleTimeString('zh-CN', { hour12: false })}(本周 ${feed.count} 条)。` : list?.config.feed ? '公开日历还没拉到。' : '公开日历已关,只有内置日程与自己记的。'}
          {failure ? ` 清单没拉到:${failure}` : ''}
          <Space size={4} style={{ marginLeft: 8 }}>
            <Button size="small" onClick={() => void loadEvents(true)}>刷新</Button>
            <Button size="small" onClick={() => { onClose(); navigate('settings'); }}>口径…</Button>
          </Space>
        </div>
        {list?.config.enabled === false ? <Notice tone="warn">「重要事件」已关(设置 → 重要事件),顶上不挂、不提醒。</Notice> : null}
        {!list || list.events.length === 0 ? (
          <EmptyState compact>两周内没有登记的事件。</EmptyState>
        ) : (
          groupByDay(list.events).map(([day, events]) => (
            <section key={day} className="event-day">
              <h4>{day}(美东)</h4>
              {events.map((e) => {
                const phase = phaseOf(e, now);
                return (
                  <div key={e.id} className={`event-row ${phase}`}>
                    <span className="event-row-when">{whenText(e.at, now)}</span>
                    <span className="event-row-title">
                      {e.title}
                      <span className="event-stars"> {starText(e.stars)}</span>
                      <span className="muted"> {SOURCE_LABEL[e.source]}</span>
                    </span>
                    <span className="event-row-count muted">{countdownText(e, now)}</span>
                    {e.items?.length ? (
                      <ul className="event-row-items muted">
                        {e.items.map((i) => (
                          <li key={i.title}>{i.title}{i.forecast || i.previous ? `:预期 ${i.forecast || '—'},前值 ${i.previous || '—'}` : ''}</li>
                        ))}
                      </ul>
                    ) : null}
                    {e.note ? <p className="muted">{e.note}</p> : null}
                    {e.source === 'custom' ? <Button size="small" danger onClick={() => void remove(e)}>删除</Button> : null}
                  </div>
                );
              })}
            </section>
          ))
        )}
        <section className="event-add">
          <h4>自己记一条</h4>
          <p className="muted">日历源上没有的:某只股发债、财报、听证会。时间写美东的。</p>
          <div className="fly-row">
            <label><span>名字</span><Input size="small" style={{ width: 160 }} value={title} placeholder="CRWV 发债" onChange={(e) => setTitle(e.target.value)} /></label>
            <label><span>日期</span><Input size="small" style={{ width: 116 }} value={date} placeholder="2026-10-14" onChange={(e) => setDate(e.target.value)} /></label>
            <label><span>美东钟点</span><Input size="small" style={{ width: 72 }} value={time} onChange={(e) => setTime(e.target.value)} /></label>
          </div>
          <div className="fly-row">
            <label className="event-add-note"><span>备注</span><Input size="small" value={note} placeholder="数据中心板块都要看" onChange={(e) => setNote(e.target.value)} /></label>
            <Button size="small" type="primary" loading={busy} disabled={!title.trim() || !date.trim()} onClick={() => void add()}>记上</Button>
          </div>
        </section>
      </div>
    </Drawer>
  );
}
