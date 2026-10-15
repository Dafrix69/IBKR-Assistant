/**
 * 信息链路的时间线(情报页与标的档案共用):一条一行,左边种类的图标,中间原文与说明,标的是可以点的胶囊(点开它的档案)。
 * 消息像单子时有「写进指令框」:只写、不发——发不发、什么时候发,还是「解析并校验」「发送」那两个按钮和那个确认框的事。
 */
import { Button, Tooltip } from 'antd';
import type { IntelItem } from '../bridge';
import { groupByDay, KIND_ICON, KIND_LABEL, KIND_TINT, moveText, moveTone, relTime, sourceLabel } from './intelRules';
import { outcomeTone, OUTCOME_LABEL } from './followForm';
import { showBanner } from '../store/banner';
import { openDossier } from '../store/intel';
import { navigate } from '../store/nav';
import { appendInstruction, setTradePane } from '../store/trade';
import { IconTile, Pill } from '../ui/graphics';
import { EmptyState } from '../ui/kit';

const OUTCOME_TINT = { success: 'green', default: 'gray', warning: 'orange', error: 'red' } as const;

function writeInstruction(text: string): void {
  appendInstruction(text);
  setTradePane('result');
  navigate('trade');
  showBanner('已写进指令框。先点「解析并校验」核对腿与权利金,再决定发不发。', true);
}

function SymbolChips({ item, current }: { item: IntelItem; current?: string }) {
  if (!item.symbols.length && !item.guesses.length) return null;
  return (
    <span className="intel-syms">
      {item.symbols.map((s) => (
        <button
          type="button"
          key={s}
          className={`intel-sym${item.held.includes(s) ? ' held' : ''}${s === current ? ' current' : ''}`}
          title={item.held.includes(s) ? `${s}:持仓中,点开档案` : `点开 ${s} 的档案`}
          onClick={() => openDossier(s)}
        >
          {s}
        </button>
      ))}
      {item.guesses.map((s) => (
        <Tooltip key={`g:${s}`} title="像代码,但不在持仓、股票池、板块、提醒里:只作参考,点了照样能查">
          <button type="button" className="intel-sym guess" onClick={() => openDossier(s)}>{s}?</button>
        </Tooltip>
      ))}
    </span>
  );
}

function Row({ item, now, current }: { item: IntelItem; now: number; current?: string }) {
  const tone = moveTone(item.move);
  return (
    <li className={`intel-row kind-${item.kind} tone-${item.tone}${item.held.length ? ' held' : ''}`}>
      <IconTile icon={KIND_ICON[item.kind]} tint={KIND_TINT[item.kind]} size={26} variant="soft" className="intel-icon" />
      <div className="intel-main">
        <div className="intel-top">
          <span className="intel-kind">{KIND_LABEL[item.kind]}</span>
          <span className="intel-source" title={item.trusted ? '信任名单里的发送者' : undefined}>
            {sourceLabel(item)}
            {item.trusted ? <i className="intel-trusted" aria-label="信任" /> : null}
          </span>
          <SymbolChips item={item} current={current} />
          <span className="intel-time" title={new Date(item.at).toLocaleString('zh-CN', { hour12: false })}>{relTime(item.at, now)}</span>
        </div>
        <div className="intel-title">{item.title}</div>
        {item.body || item.move || item.outcome ? (
          <div className="intel-foot">
            {item.outcome ? <Pill tint={OUTCOME_TINT[outcomeTone(item.outcome)]}>{OUTCOME_LABEL[item.outcome]}</Pill> : null}
            {item.move ? <span className={`intel-move ${tone}`}>{moveText(item.move)}</span> : null}
            {item.body && item.kind !== 'message' && item.kind !== 'idea' ? <span className="intel-body">{item.body}</span> : null}
            {item.body && item.kind === 'message' && item.outcome ? <span className="intel-body">{item.body.replace(/^[^:]*:/, '')}</span> : null}
            {item.instruction ? (
              <Button size="small" className="intel-write" onClick={() => writeInstruction(item.instruction ?? '')}>写进指令框</Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

export function IntelTimeline({ items, now, current, empty }: { items: IntelItem[]; now: number; current?: string; empty?: string }) {
  if (!items.length) return <EmptyState>{empty ?? '还没有可看的消息、信号或事件'}</EmptyState>;
  return (
    <div className="intel-timeline">
      {groupByDay(items, now).map((g) => (
        <section key={g.label} className="intel-day">
          <h4 className="intel-day-label">{g.label}<span>{g.items.length}</span></h4>
          <ul className="intel-list">
            {g.items.map((item) => <Row key={item.id} item={item} now={now} current={current} />)}
          </ul>
        </section>
      ))}
    </div>
  );
}
