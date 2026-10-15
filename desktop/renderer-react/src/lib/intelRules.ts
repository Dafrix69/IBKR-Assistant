/**
 * 信息链路的界面规则(docs/features/intel.md):时间线上一条怎么摆、怎么筛、提到持仓时弹什么。纯函数,引擎那边的测试直接跑。
 * 形状来自引擎契约(engine-ts/src/contract/intel.ts);这里不认标的——认标的在引擎(symbolMentions.ts)。
 */
import type { IntelItem, IntelKind, IntelMove, PopupItem } from '../bridge';

export const KIND_LABEL: Record<IntelKind, string> = { message: '消息', signal: '信号', event: '事件', order: '单子', idea: '想法' };
export const KIND_ICON: Record<IntelKind, string> = { message: 'sf-antenna', signal: 'sf-bell', event: 'sf-clock', order: 'sf-paperplane', idea: 'sf-bulb' };
export const KIND_TINT: Record<IntelKind, 'blue' | 'orange' | 'purple' | 'green' | 'yellow'> = {
  message: 'blue', signal: 'orange', event: 'purple', order: 'green', idea: 'yellow',
};
export const KIND_ORDER: IntelKind[] = ['message', 'signal', 'event', 'order', 'idea'];

/** 时间线上「来源」那一格:消息是发送者、单子是账户别名,照原样;信号、事件、想法的来源是代号,换成人话。 */
const SOURCE_LABEL: Partial<Record<IntelKind, Record<string, string>>> = {
  signal: { cross: '价位穿越', touch: '碰均线', spike: '急涨急跌', day_move: '大涨大跌', rvol: '全天放量', burst: '窗口放量', leaders: '强势股', pa: 'K线 PA' },
  event: {
    cpi: 'CPI', ppi: 'PPI', nfp: '非农', fomc: 'FOMC', fomc_minutes: '会议纪要', pce: 'PCE', gdp: 'GDP', retail: '零售', claims: '初请',
    fed_speech: '美联储讲话', ism: 'ISM', other: '宏观', custom: '自己记的', cross: '跨市场',
  },
  idea: { active: '进行中', done: '已完成', archived: '已归档' },
};

export function sourceLabel(item: Pick<IntelItem, 'kind' | 'source'>): string {
  return SOURCE_LABEL[item.kind]?.[item.source] ?? item.source;
}

/** 多久之前 / 之后:一分钟内「刚刚」,一小时内「N 分钟前」,一天内「N 小时前」,再往前写月-日 时:分(本机时区)。 */
export function relTime(at: number, now: number): string {
  const d = now - at;
  const abs = Math.abs(d);
  const after = d < 0;
  if (abs < 60_000) return after ? '马上' : '刚刚';
  if (abs < 3600_000) return `${Math.round(abs / 60_000)} 分钟${after ? '后' : '前'}`;
  if (abs < 24 * 3600_000) return `${Math.round(abs / 3600_000)} 小时${after ? '后' : '前'}`;
  const t = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

const fmtPrice = (v: number): string => (Math.abs(v) >= 1000 ? v.toFixed(1) : v.toFixed(2)).replace(/\.0+$/, '');

/** 消息提到时与此刻的价:「SPX 提到时 7700 → 此刻 7712.5(+0.16%)」;此刻没有价就只写提到时。 */
export function moveText(move: IntelMove): string {
  const then = `${move.symbol} 提到时 ${fmtPrice(move.then)}`;
  if (move.now === null || move.pct === null) return then;
  const sign = move.pct > 0 ? '+' : '';
  return `${then} → 此刻 ${fmtPrice(move.now)}(${sign}${move.pct.toFixed(2)}%)`;
}

export function moveTone(move: IntelMove | undefined): 'up' | 'down' | '' {
  if (!move || move.pct === null || move.pct === 0) return '';
  return move.pct > 0 ? 'up' : 'down';
}

export interface IntelFilter {
  kinds: IntelKind[];
  heldOnly: boolean;
  /** 关键字:标的代码或原文里的字 */
  query: string;
}

export const EMPTY_FILTER: IntelFilter = { kinds: [], heldOnly: false, query: '' };

/** 界面上再筛一遍(引擎已经按种类与持仓筛过;关键字在这里筛,打字不必每个键都问一次引擎)。 */
export function filterItems(items: readonly IntelItem[], filter: IntelFilter): IntelItem[] {
  const q = filter.query.trim().toLowerCase();
  const kinds = filter.kinds.length ? new Set(filter.kinds) : null;
  return items.filter((i) => {
    if (kinds && !kinds.has(i.kind)) return false;
    if (filter.heldOnly && i.held.length === 0) return false;
    if (!q) return true;
    if (i.symbols.some((s) => s.toLowerCase() === q)) return true;
    return `${i.title} ${i.body} ${i.source} ${i.symbols.join(' ')}`.toLowerCase().includes(q);
  });
}

/** 时间线上这几天各有几条:按本机日历日分组,新的在前。 */
export function groupByDay(items: readonly IntelItem[], now: number): Array<{ label: string; items: IntelItem[] }> {
  const key = (t: number) => new Date(t).toDateString();
  const today = key(now);
  const yesterday = key(now - 24 * 3600_000);
  const tomorrow = key(now + 24 * 3600_000);
  const out: Array<{ label: string; items: IntelItem[] }> = [];
  for (const item of items) {
    const k = key(item.at);
    const label = k === today ? '今天' : k === yesterday ? '昨天' : k === tomorrow ? '明天' : new Date(item.at).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
    const last = out[out.length - 1];
    if (last && last.label === label) last.items.push(item);
    else out.push({ label, items: [item] });
  }
  return out;
}

/** 这批里各标的被提到几次(不含 guess),多的在前:页头那一排「热门」。 */
export function hotSymbols(items: readonly IntelItem[], max = 8): Array<{ symbol: string; n: number; held: boolean }> {
  const counts = new Map<string, { n: number; held: boolean }>();
  for (const i of items) {
    for (const s of i.symbols) {
      const c = counts.get(s) ?? { n: 0, held: false };
      c.n += 1;
      if (i.held.includes(s)) c.held = true;
      counts.set(s, c);
    }
  }
  return [...counts.entries()].map(([symbol, c]) => ({ symbol, ...c })).sort((a, b) => b.n - a.n || a.symbol.localeCompare(b.symbol)).slice(0, max);
}

/** 引擎推来的 held_mention(信任的人提到了自己持仓的票)→ 弹窗的一条。 */
export interface HeldMention {
  message_id: string;
  at: number;
  author_name: string;
  text: string;
  symbols: string[];
  prices: Record<string, number>;
}

export function isHeldMention(data: unknown): data is HeldMention {
  const d = data as Partial<HeldMention> | null;
  return Boolean(d && typeof d.message_id === 'string' && Array.isArray(d.symbols) && d.symbols.length && typeof d.text === 'string');
}

export function heldMentionPopup(m: HeldMention): PopupItem {
  const symbol = m.symbols[0] ?? '';
  const price = m.prices[symbol];
  return {
    id: `intel:${m.message_id}`,
    kind: 'event',
    symbol,
    title: `${m.symbols.join('、')} 被提到(持仓)`,
    body: `${m.author_name || '频道'}:${m.text}${typeof price === 'number' ? `(当时 ${symbol} ${fmtPrice(price)})` : ''}`.slice(0, 230),
    tone: 'info',
    at: Number.isFinite(m.at) ? m.at : Date.now(),
    page: 'intel',
  };
}

/** ⌘K 里敲的字 → 标的代码;不像代码的回 null。中文名留给引擎认:这里只收拉丁字母。 */
export function lookupSymbol(raw: string): string | null {
  const s = raw.trim().replace(/^\$/, '').toUpperCase();
  return /^[A-Z][A-Z0-9.]{0,9}$/.test(s) ? s : null;
}
