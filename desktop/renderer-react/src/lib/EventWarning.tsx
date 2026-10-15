/** 蝴蝶测算面板顶上的一句提醒:今天还没公布的重要数据——开蝶之前先知道有这件事。 */
import { countdownText, phaseOf, pinnedEvents, whenText } from './eventRules';
import { useEvents } from '../store/events';
import { Notice } from '../ui/kit';

export function EventWarning() {
  const { list, now } = useEvents();
  if (!list || !list.config.enabled) return null;
  const coming = pinnedEvents(list.events, now).events.filter((e) => e.impact === 'high' && ['upcoming', 'soon', 'live'].includes(phaseOf(e, now)));
  if (!coming.length) return null;
  const e = coming[0]!;
  return (
    <Notice tone="warn" className="event-warning" title={`${whenText(e.at, now)} 公布 ${e.title},${countdownText(e, now)}`}>
      公布前后指数常有跳空,当日到期的蝶可能直接穿出翼。{coming.length > 1 ? `之后还有 ${coming.slice(1).map((x) => x.title).join('、')}。` : ''}
    </Notice>
  );
}
