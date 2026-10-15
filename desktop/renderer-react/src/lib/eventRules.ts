/**
 * 重要事件的判定:哪些事今天该挂在顶上、过没过期、倒计时怎么说、该不该提前提醒、板块是不是在集体走、对冲指令怎么写。
 *
 * 单独放成一个**不 import 任何东西、不碰 DOM 的纯模块**,引擎那套 vitest 直接跑它(desktop-event-rules.spec)。
 * 轮询与发提醒在 store/events;口径见 docs/features/events.md。
 */

export const ET = 'America/New_York';

/** 事件在清单里的样子(和引擎契约 EconEvent 同形,这里只认用得到的字段) */
export interface RuleEvent {
  id: string;
  kind: string;
  title: string;
  /** 公布时刻(epoch 毫秒) */
  at: number;
  date_et: string;
  time_et: string;
  impact: 'high' | 'medium';
  source: 'builtin' | 'feed' | 'custom';
  linger_min: number;
  items?: Array<{ title: string; forecast: string; previous: string }>;
  note?: string;
  /** 跨市场跟跌套利(kind = cross)才有:美股涨跌、没跟上的市场、可做的 ETF。形状同引擎契约 CrossMarketDetail */
  cross?: {
    direction: 'up' | 'down';
    us_pct: number;
    markets: Array<{
      key: string; name: string; symbol: string; etf_pct: number; gap: number; open_at: number;
      instruments: Array<{ symbol: string; change_pct: number | null; last: number | null }>;
    }>;
  };
}

/** 公布前一小时起算"快到了";公布后一刻钟内算"正在公布";之后到过期之前是"刚公布" */
export const SOON_MIN = 60;
export const LIVE_MIN = 15;
/** 不是今天的事也提前挂出来的窗口:北京时间晚上看到明早美东开盘前的数(18 小时盖得住隔夜) */
export const PIN_AHEAD_MS = 18 * 60 * 60_000;
/** 顶上最多挂几条,其余折成「+N」 */
export const PIN_MAX = 3;

export type EventPhase = 'upcoming' | 'soon' | 'live' | 'after' | 'expired';

export function expiresAt(e: Pick<RuleEvent, 'at' | 'linger_min'>): number {
  return e.at + e.linger_min * 60_000;
}

export function phaseOf(e: Pick<RuleEvent, 'at' | 'linger_min'>, now: number): EventPhase {
  if (now >= expiresAt(e)) return 'expired';
  if (now >= e.at + LIVE_MIN * 60_000) return 'after';
  if (now >= e.at) return 'live';
  if (now >= e.at - SOON_MIN * 60_000) return 'soon';
  return 'upcoming';
}

/** 美东的日历日 */
export function etDateOf(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString('en-CA', { timeZone: ET });
}

/**
 * 今天该挂在顶上的:没过期,而且是美东今天的事、或 18 小时之内要来的事。按时间排,只给前几条,其余报个数。
 * 中等影响的只在真的快到了(一小时内)才上顶,高影响的整天挂着——顶上的位置是给会让指数跳空的事的。跨市场(P0)只要没过期就挂。
 */
export function pinnedEvents<E extends RuleEvent>(events: E[], now: number): { events: E[]; more: number } {
  const today = etDateOf(now);
  const live = events
    .filter((e) => {
      const phase = phaseOf(e, now);
      if (phase === 'expired') return false;
      // 跨市场跟跌(P0)从美股盘中就挂着,周五的要挂到周一开盘:不受"今天的"那条限制
      if (e.kind === 'cross') return true;
      if (!(e.date_et === today || e.at - now <= PIN_AHEAD_MS)) return false;
      return e.impact === 'high' || phase !== 'upcoming';
    })
    .sort((a, b) => a.at - b.at);
  return { events: live.slice(0, PIN_MAX), more: Math.max(0, live.length - PIN_MAX) };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 倒计时的一句话 */
export function countdownText(e: Pick<RuleEvent, 'at' | 'linger_min'>, now: number): string {
  const phase = phaseOf(e, now);
  if (phase === 'expired') return '已过去';
  if (phase === 'live') return '正在公布';
  if (phase === 'after') return `已公布 ${Math.floor((now - e.at) / 60_000)} 分钟`;
  const mins = Math.ceil((e.at - now) / 60_000);
  if (mins < 60) return `还有 ${mins} 分钟`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h >= 24) {
    const d = Math.floor(h / 24);
    return `还有 ${d} 天 ${h % 24} 小时`;
  }
  return m ? `还有 ${h} 小时 ${pad2(m)} 分` : `还有 ${h} 小时`;
}

/** 本机时间的钟点与"哪一天":今天 20:30 / 明天 20:30 / 周五 20:30 / 10-28 20:30。tz 不给就用本机的 */
export function whenText(at: number, now: number, tz?: string): string {
  const zone = tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const day = (t: number): string => new Date(t).toLocaleDateString('en-CA', { timeZone: zone });
  const clock = new Date(at).toLocaleTimeString('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false });
  const target = day(at);
  const today = day(now);
  if (target === today) return `今天 ${clock}`;
  const diffDays = Math.round((Date.parse(`${target}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (diffDays === 1) return `明天 ${clock}`;
  if (diffDays === -1) return `昨天 ${clock}`;
  if (diffDays > 1 && diffDays < 7) {
    const dow = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(`${target}T12:00:00Z`).getUTCDay()] ?? '';
    return `${dow} ${clock}`;
  }
  return `${target.slice(5)} ${clock}`;
}

// ---- 提前提醒 ----------------------------------------------------------------

/** 一次该报的提醒:lead = 提前几分钟(0 = 公布那一刻) */
export interface LeadDue<E extends RuleEvent = RuleEvent> {
  key: string;
  lead: number;
  event: E;
}

/** 提醒的窗口:到点之后这么久之内都算"刚到点"(循环 15 秒一拍,电脑刚醒也追得上一拍),过了就不补——人已经错过了,再响就是打扰 */
export const LEAD_WINDOW_MS = 90_000;

/**
 * 此刻该报哪几条提前提醒:每一档只在到点后的窗口里报,报过的(fired)不再报。中等影响的只报公布那一刻。
 * 纯函数:报过的集合由调用方拿着。
 */
export function leadsDue<E extends RuleEvent>(events: E[], now: number, leads: number[], fired: ReadonlySet<string>): LeadDue<E>[] {
  const out: LeadDue<E>[] = [];
  const steps = [...new Set([0, ...leads.filter((l) => l > 0)])];
  for (const e of events) {
    for (const lead of steps) {
      if (lead > 0 && e.impact !== 'high') continue;
      const due = e.at - lead * 60_000;
      if (now < due || now >= due + LEAD_WINDOW_MS) continue;
      const key = `${e.id}:${lead}`;
      if (fired.has(key)) continue;
      out.push({ key, lead, event: e });
    }
  }
  return out;
}

export function leadTitle(e: RuleEvent, lead: number): string {
  return lead > 0 ? `${lead} 分钟后公布 ${e.title}` : `正在公布 ${e.title}`;
}

export function leadBody(e: RuleEvent, lead: number, now: number, tz?: string): string {
  const head = `${whenText(e.at, now, tz)}(美东 ${e.time_et})`;
  const facts = (e.items ?? [])
    .filter((i) => i.forecast || i.previous)
    .slice(0, 2)
    .map((i) => `${i.title}:预期 ${i.forecast || '—'},前值 ${i.previous || '—'}`);
  const tail = lead > 0 ? '公布前后指数常有跳空:当日到期的蝶可能直接穿出翼,要对冲或减仓趁现在。' : '盯住现价与持仓;追踪的止损照常。';
  return [head, ...facts, e.note ?? '', tail].filter(Boolean).join(' · ');
}

// ---- 板块联动 ----------------------------------------------------------------

export interface SectorMove {
  sector: string;
  direction: 'up' | 'down';
  /** 同向超线的只数 / 有行情的只数 */
  count: number;
  total: number;
  /** 全板块涨跌幅的中位数(%) */
  median: number;
  /** 走得最远的几只(按幅度) */
  movers: Array<{ symbol: string; pct: number }>;
}

export interface SectorRule {
  min_stocks: number;
  share: number;
  move_pct: number;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/**
 * 板块是不是在集体走:有行情的成分股不少于 min_stocks,其中同向超过 move_pct 的不少于 share 那么多。
 * 一只股把板块带崩(CRWV 发债那种)时,别的成分股不会一只不动——整个板块一起超线才算,单只的急跌归异动提醒管。
 * 两个方向都看;同一个板块只报占多数的那个方向。
 */
export function sectorMoves(
  sectors: Array<{ name: string; symbols: string[] }>,
  changes: Record<string, number | null | undefined>,
  rule: SectorRule,
): SectorMove[] {
  const out: SectorMove[] = [];
  for (const sector of sectors) {
    const quoted = [...new Set(sector.symbols)]
      .map((symbol) => ({ symbol, pct: changes[symbol] }))
      .filter((x): x is { symbol: string; pct: number } => typeof x.pct === 'number' && Number.isFinite(x.pct));
    if (quoted.length < rule.min_stocks) continue;
    const need = Math.max(rule.min_stocks, Math.ceil(quoted.length * rule.share));
    const down = quoted.filter((x) => x.pct <= -rule.move_pct);
    const up = quoted.filter((x) => x.pct >= rule.move_pct);
    const pick = down.length >= need && down.length >= up.length ? { direction: 'down' as const, hit: down }
      : up.length >= need ? { direction: 'up' as const, hit: up } : null;
    if (!pick) continue;
    out.push({
      sector: sector.name,
      direction: pick.direction,
      count: pick.hit.length,
      total: quoted.length,
      median: Math.round(median(quoted.map((x) => x.pct)) * 100) / 100,
      movers: [...pick.hit].sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)).slice(0, 5),
    });
  }
  return out;
}

export function sectorMoveTitle(m: SectorMove): string {
  return `板块联动:${m.sector} 集体${m.direction === 'down' ? '下跌' : '上涨'}`;
}

export function sectorMoveBody(m: SectorMove, movePct: number): string {
  const sign = (p: number): string => `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p).toFixed(1)}%`;
  const list = m.movers.map((x) => `${x.symbol} ${sign(x.pct)}`).join('、');
  return `${m.total} 只里 ${m.count} 只${m.direction === 'down' ? '跌' : '涨'}超 ${movePct}%,中位 ${sign(m.median)}:${list}。一只股的消息把整个板块带着走时,持仓里同板块的都要看。`;
}

// ---- 对冲指令 ----------------------------------------------------------------

export type HedgeKind = 'put_spread' | 'bear_call' | 'short_stock';

export interface HedgeSpec {
  symbol: string;
  spot: number | null;
  kind: HedgeKind;
  /** 卖空正股 / ETF:限价(正股的限价单必须有价,助手不知道盘口,由人填)与此刻是不是常规时段之外(要加「盘外」) */
  price?: number | null;
  outside?: boolean;
  /** 两个行权价隔多少点 */
  width: number;
  qty: number;
  /** 到期日 YYYY-MM-DD(美东) */
  expiry: string;
  /** 美东今天 */
  todayEt: string;
  reason: string;
}

const INDEX = new Set(['SPX', 'SPXW', 'NDX', 'RUT', 'VIX', 'DJX']);

/** 行权价的档距:指数 5 点;正股按价位粗分(用户照样能改) */
export function strikeStep(symbol: string, spot: number): number {
  if (INDEX.has(symbol.toUpperCase())) return 5;
  if (spot >= 100) return 5;
  if (spot >= 25) return 1;
  return 0.5;
}

function plain(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/**
 * 把一句对冲指令写出来。两种结构都是解析器认得的写法(prompts/system 的价差规则;SPX 当日 bear call 走本地速记):
 *  · 买 put 价差(借方):买现价下方最近一档的 put、卖再低 width 的 put。最大亏损 = 付出的权利金;指数跌穿低腿时赚满 width − 权利金。
 *  · 卖 call 价差(贷方 bear call):卖现价上方最近一档的 call、买再高 width 的 call。收权利金;指数涨穿高腿时亏 width − 权利金。
 * 不写权利金:两种都是组合(BAG),解析器按 AUTO_MID 挂盘口中间价。
 */
export function hedgeInstruction(spec: HedgeSpec): { text: string; legs: string; problem: string | null } {
  const symbol = spec.symbol.trim().toUpperCase();
  if (!symbol) return { text: '', legs: '', problem: '先填标的' };
  if (spec.kind === 'short_stock') return shortStockInstruction(symbol, spec);
  if (spec.spot === null || !Number.isFinite(spec.spot) || spec.spot <= 0) return { text: '', legs: '', problem: '没有现价:连上券商,或自己填一个' };
  if (!(spec.width > 0)) return { text: '', legs: '', problem: '宽度要大于 0' };
  if (!(spec.qty >= 1) || spec.qty !== Math.round(spec.qty)) return { text: '', legs: '', problem: '张数要是正整数' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(spec.expiry)) return { text: '', legs: '', problem: '到期日要写成 YYYY-MM-DD' };
  if (spec.expiry < spec.todayEt) return { text: '', legs: '', problem: '到期日已经过了' };
  const step = strikeStep(symbol, spec.spot);
  const expiryPhrase = spec.expiry === spec.todayEt ? '今天的' : `${spec.expiry} 到期的`;
  const qtyPhrase = spec.qty === 1 ? '一张' : `${spec.qty} 张`;
  const reason = spec.reason.trim() ? `,理由:${spec.reason.trim()}` : '';
  if (spec.kind === 'put_spread') {
    const long = Math.floor(spec.spot / step) * step;
    const short = long - spec.width;
    if (short <= 0) return { text: '', legs: '', problem: '宽度比现价还大' };
    return {
      text: `开${qtyPhrase} ${symbol} ${expiryPhrase} ${plain(short)} ${plain(long)} put spread${reason}`,
      legs: `买 ${plain(long)} put、卖 ${plain(short)} put,${spec.qty} 张;最大亏损 = 付出的权利金`,
      problem: null,
    };
  }
  let short = Math.ceil(spec.spot / step) * step;
  if (short === spec.spot) short += step;
  const long = short + spec.width;
  // SPX 当日一张:本地速记认得(「7725 7750 bear call」),不经过大模型
  const local = symbol === 'SPX' && spec.expiry === spec.todayEt && spec.qty === 1;
  return {
    text: local
      ? `${plain(short)} ${plain(long)} bear call`
      : `卖出${qtyPhrase} ${symbol} ${expiryPhrase} ${plain(short)} ${plain(long)} call spread${reason}`,
    legs: `卖 ${plain(short)} call、买 ${plain(long)} call,${spec.qty} 张;收权利金,最大亏损 = ${plain(spec.width)} 点 − 权利金`,
    problem: null,
  };
}

/**
 * 卖空正股 / ETF(跨市场那条用:做空 KORU、EWY、ASHR 这类)。正股的限价单必须写价,市价单在常规时段之外会被拒,
 * 所以一律写限价;常规时段之外加「盘外」(指令规则:盘前盘后要成交得写明,且必须是限价)。卖出没有持仓的股就是卖空,由券商的融券决定成不成交。
 */
function shortStockInstruction(symbol: string, spec: HedgeSpec): { text: string; legs: string; problem: string | null } {
  if (!(spec.qty >= 1) || spec.qty !== Math.round(spec.qty)) return { text: '', legs: '', problem: '股数要是正整数' };
  const price = spec.price ?? null;
  if (price === null || !Number.isFinite(price) || price <= 0) return { text: '', legs: '', problem: '卖空要写限价:看一眼 TWS 里的盘口填进来' };
  const reason = spec.reason.trim() ? `,理由:${spec.reason.trim()}` : '';
  return {
    text: `${spec.outside ? '盘外 ' : ''}限价 ${plain(price)} 卖出 ${spec.qty} 股 ${symbol}${reason}`,
    legs: `卖空 ${spec.qty} 股 ${symbol} @ ${plain(price)}${spec.outside ? ',盘外限价' : ''};亏损没有上限,3 倍 ETF 一天能走 10% 以上`,
    problem: null,
  };
}

/** 对冲默认到哪天到期:事件那天(事件在今天之后时),不早于今天 */
export function hedgeExpiryFor(e: Pick<RuleEvent, 'date_et'>, todayEt: string): string {
  return e.date_et > todayEt ? e.date_et : todayEt;
}
