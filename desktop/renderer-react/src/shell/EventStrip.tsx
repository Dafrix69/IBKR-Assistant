import { useState } from 'react';
import { Button, Tooltip } from 'antd';
import { EventActions } from '../lib/EventActions';
import { EventList } from '../lib/EventList';
import { countdownText, phaseOf, pinnedEvents, whenText } from '../lib/eventRules';
import { navigate } from '../store/nav';
import { useEvents, type RuleEvent } from '../store/events';

/**
 * 顶栏下面那条常驻的「今日重要事件」:今天(或 18 小时内)要公布的数、正在集体走的板块,一直挂着,直到过期自己消失。
 * 没有事的时候整条收起。「应对」打开对冲助手(只写指令,不发单);「全部」打开两周的清单与自定义事件。
 */
export function EventStrip() {
  const { list, now, moves, cross } = useEvents();
  const [acting, setActing] = useState<RuleEvent | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const enabled = list?.config.enabled ?? true;
  const all: RuleEvent[] = list ? (cross ? [...list.events, cross] : list.events) : [];
  const pinned = list && enabled ? pinnedEvents(all, now) : { events: [] as RuleEvent[], more: 0 };
  const hidden = !enabled || (pinned.events.length === 0 && moves.length === 0);

  return (
    <>
      <div id="event-strip" className="event-strip" hidden={hidden} role="status">
        <span className="event-strip-head" title="今天要公布的重要数据,以及正在集体涨跌的板块。公布过了一阵自己消失;清单与口径在「全部」里">
          今日事件
        </span>
        {moves.map((m) => (
          <Tooltip
            key={`${m.sector}:${m.direction}`}
            title={`${m.total} 只里 ${m.count} 只同向超线,中位 ${m.median > 0 ? '+' : ''}${m.median}%:${m.movers.map((x) => `${x.symbol} ${x.pct > 0 ? '+' : ''}${x.pct}%`).join('、')}`}
          >
            <button type="button" className={`event-item sector ${m.direction}`} onClick={() => navigate('sectors')}>
              <span className="event-dot" />
              <span className="event-title">板块联动:{m.sector} 集体{m.direction === 'down' ? '下跌' : '上涨'}</span>
              <span className="event-meta">{m.count}/{m.total} 只 · 中位 {m.median > 0 ? '+' : ''}{m.median}%</span>
            </button>
          </Tooltip>
        ))}
        {pinned.events.map((e) => {
          const phase = phaseOf(e, now);
          const fact = (e.items ?? []).find((i) => i.forecast || i.previous);
          return (
            <div key={e.id} className={`event-item ${phase} ${e.impact}`}>
              <span className="event-dot" />
              <span className="event-title" title={e.note || (e.items ?? []).map((i) => i.title).join('、') || e.title}>{e.title}</span>
              <span className="event-meta">{whenText(e.at, now)}(美东 {e.time_et}) · {countdownText(e, now)}</span>
              {fact ? <span className="event-fact">预期 {fact.forecast || '—'} · 前值 {fact.previous || '—'}</span> : null}
              {/* 跨市场那条在亚洲开盘之后还有用(A 股比韩股晚半小时),挂着就能应对 */}
              {phase === 'upcoming' || phase === 'soon' || e.kind === 'cross' ? (
                <Button size="small" type="primary" ghost onClick={() => setActing(e)}>应对</Button>
              ) : null}
            </div>
          );
        })}
        {pinned.more > 0 ? <span className="event-more">+{pinned.more}</span> : null}
        <Button size="small" className="event-all" onClick={() => setListOpen(true)}>全部</Button>
      </div>
      {acting ? <EventActions event={acting} onClose={() => setActing(null)} /> : null}
      {listOpen ? <EventList onClose={() => setListOpen(false)} /> : null}
    </>
  );
}
