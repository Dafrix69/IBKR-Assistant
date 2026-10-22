/**
 * 重要事件:清单从引擎来(内置日程 + 公开日历 + 自定义),提醒与板块联动在这里判——和关口提醒、异动提醒同一扇弹窗。
 *
 * 三个节拍,都不看当前在哪一页(循环只能在 store 里):
 *  · 清单 5 分钟拉一次(引擎那边日历源 4 小时一拉,这里只是把它拿过来);引擎重启、口径改了、加了自定义事件时当场重拉。
 *  · 15 秒一拍:倒计时跟着走,到了提前提醒的点就弹窗 / 响铃 / 系统通知。报过的记在内存里,每档只报一次。
 *  · 板块联动 60 秒一轮,只在连着券商、美东 04:00 ~ 20:00 里问:成分股的涨跌幅从异动循环留在引擎里的那一份读(quality.list,本地道),
 *    不另订行情,只认 3 分钟之内算出来的(异动循环只在 09:20 ~ 16:20 算,别的时候是旧数)。一个板块的集体涨跌报一次,
 *    之后它还在就一直挂着,直到条件消失 30 分钟。09:20 ~ 09:30 看到的是盘前的涨跌:集体拉涨换成"开盘后大概率回吐"的说法,
 *    记下盘前的中位,10:00 ~ 10:30 之间再看一次,回吐了还是守住了都报一句。
 *  · 时段提醒跟着 15 秒那一拍:欧盘开收、美股开盘前、最后一小时,各按当地钟点(eventRules.SESSION_MARKS),总开关关了不报。
 */
import { create } from 'zustand';
import { dafri, errorMessage, type EconEvent, type EventsConfig, type EventsList, type PopupItem, type Sector } from '../bridge';
import {
  etDateOf, etMinuteOf, FADE_CHECK_FROM, FADE_CHECK_UNTIL, fadeBody, fadeTitle, fadeVerdict, freshChanges, isPremarket, leadBody, leadTitle,
  leadsDue, sectorMedian, sectorMoveBody, sectorMoveTitle, sectorMoves, sessionMarkBody, sessionMarksDue, type RuleEvent, type SectorMove,
} from '../lib/eventRules';
import { playAlertTone } from './alerts';
import { pushNotification } from './notify';
import { showAlertPopup } from './popup';
import { getStatus } from './status';

export type { EconEvent, EventsConfig, EventsList, RuleEvent, SectorMove };

export const LIST_REFRESH_MS = 5 * 60_000;
export const TICK_MS = 15_000;
export const SECTOR_SWEEP_MS = 60_000;
export const SECTORS_REFRESH_MS = 10 * 60_000;
/** 板块联动消失之后还挂多久 */
export const SECTOR_LINGER_MS = 30 * 60_000;

export interface EventsState {
  list: EventsList | null;
  /** 最近一次没拉到清单的原因 */
  failure: string | null;
  /** 时钟:每拍更新一次,倒计时与挂顶都按它算(组件不自己 setInterval) */
  now: number;
  /** 正在集体走的板块,以及它们最后一次满足条件的时刻 */
  moves: Array<SectorMove & { since: number; seenAt: number }>;
}

const useStore = create<{ events: EventsState }>(() => ({
  events: { list: null, failure: null, now: Date.now(), moves: [] },
}));

function set(part: Partial<EventsState>): void {
  useStore.setState((s) => ({ events: { ...s.events, ...part } }));
}

export function useEvents(): EventsState {
  return useStore((s) => s.events);
}

export function getEventsConfig(): EventsConfig | null {
  return useStore.getState().events.list?.config ?? null;
}

let inFlight = false;
let loadedAt = 0;
let started = false;
const fired = new Set<string>();
let sectors: Sector[] = [];
let sectorsAt = 0;
let sweepAt = 0;
let sweeping = false;
/** 盘前集体拉涨的板块:美东日期 + 板块 → 开盘前最后看到的中位与成分股(10:00 那一眼要用) */
const premarketRallies = new Map<string, { date: string; sector: string; median: number; symbols: string[] }>();

export async function loadEvents(force = false): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const list = await dafri.listEvents(force);
    const before = useStore.getState().events.list?.cross?.id ?? null;
    set({ list, failure: null });
    // 跨市场跟跌(P0):引擎在美股盘中判出来一条新的,当场弹窗响铃;之后由挂顶与提前提醒接手
    const cross = list.cross;
    if (cross && cross.id !== before && !fired.has(`${cross.id}:new`)) {
      fired.add(`${cross.id}:new`);
      const direction = cross.cross?.direction ?? 'down';
      void announce({ id: `event:${cross.id}`, kind: 'event', symbol: cross.cross?.markets[0]?.symbol ?? '', title: `P0 ${cross.title}`, body: leadBody(cross, 0, Date.now()), tone: direction, at: Date.now(), page: 'trade' }, direction);
    }
  } catch (err) {
    set({ failure: errorMessage(err) });
  } finally {
    inFlight = false;
    loadedAt = Date.now();
  }
}

async function announce(item: PopupItem, direction: 'up' | 'down' | null): Promise<void> {
  playAlertTone(direction);
  pushNotification(item.title, item.body);
  const { dropped } = await showAlertPopup([item]);
  if (dropped <= 0) return;
  try {
    await dafri.notify(item.title, item.body ?? '');
  } catch (err) {
    console.warn('系统通知失败', err);
  }
}

/** 清单里的事 + 跨市场那一条(有的话):挂顶与提前提醒都看这一份 */
export function allEvents(): RuleEvent[] {
  const list = useStore.getState().events.list;
  const base: RuleEvent[] = list?.events ?? [];
  return list?.cross ? [...base, list.cross] : base;
}

function checkLeads(now: number): void {
  const { list } = useStore.getState().events;
  if (!list || !list.config.enabled) return;
  for (const due of leadsDue(allEvents(), now, list.config.lead_minutes, fired)) {
    fired.add(due.key);
    const title = leadTitle(due.event, due.lead);
    const body = leadBody(due.event, due.lead, now);
    void announce({ id: `event:${due.key}`, kind: 'event', symbol: 'SPX', title, body, tone: 'info', at: now, page: 'trade' }, due.lead > 0 ? null : 'down');
  }
}

/** 美东 04:00 ~ 20:00 才去问;真正有没有数看 freshChanges:异动循环只在 09:20 ~ 16:20 算涨跌幅,别的时候手里是最后一轮的旧数 */
function inSession(now: number): boolean {
  const hour = Number(new Date(now).toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }));
  return hour >= 4 && hour < 20;
}

async function sweepSectors(now: number): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    if (now - sectorsAt >= SECTORS_REFRESH_MS) {
      const res = await dafri.listSectors();
      sectors = Array.isArray(res?.sectors) ? res.sectors : [];
      sectorsAt = now;
    }
    const cfg = getEventsConfig();
    if (!cfg || !sectors.some((s) => s.stocks.length >= cfg.sector_min_stocks)) return;
    const quality = await dafri.listQuality();
    const changes = freshChanges(quality.stocks.map((s) => ({ symbol: s.symbol, change_pct: s.metrics?.change_pct, at: s.metrics_at })), now);
    const found = sectorMoves(
      sectors.map((s) => ({ name: s.name, symbols: s.stocks.map((x) => x.symbol) })),
      changes,
      { min_stocks: cfg.sector_min_stocks, share: cfg.sector_share, move_pct: cfg.sector_move_pct },
    );
    const premarket = isPremarket(now);
    const today = etDateOf(now);
    for (const m of found) {
      if (!premarket || m.direction !== 'up') continue;
      const symbols = sectors.find((s) => s.name === m.sector)?.stocks.map((x) => x.symbol) ?? [];
      premarketRallies.set(`${today}:${m.sector}`, { date: today, sector: m.sector, median: m.median, symbols });
    }
    checkFades(now, changes, cfg.sector_min_stocks);
    const prev = useStore.getState().events.moves;
    const next: EventsState['moves'] = [];
    for (const m of found) {
      const old = prev.find((p) => p.sector === m.sector && p.direction === m.direction);
      next.push({ ...m, since: old?.since ?? now, seenAt: now });
      if (!old) {
        const title = sectorMoveTitle(m, premarket);
        const body = sectorMoveBody(m, cfg.sector_move_pct, premarket);
        void announce({ id: `sector:${m.sector}:${m.direction}:${now}`, kind: 'event', symbol: m.movers[0]?.symbol ?? '', title, body, tone: m.direction, at: now, page: 'sectors' }, m.direction);
      }
    }
    // 条件消失的还挂一会儿:人回来还看得见刚才发生了什么
    for (const p of prev) {
      if (!next.some((n) => n.sector === p.sector && n.direction === p.direction) && now - p.seenAt < SECTOR_LINGER_MS) next.push(p);
    }
    set({ moves: next });
  } catch (err) {
    console.warn('板块联动检查失败', err);
  } finally {
    sweeping = false;
  }
}

/** 盘前拉涨的板块在 10:00 ~ 10:30 之间看一次:中位掉了一半以上算回吐。过了窗口、不是今天的直接丢 */
function checkFades(now: number, changes: Record<string, number | null>, minStocks: number): void {
  const minute = etMinuteOf(now);
  if (minute < FADE_CHECK_FROM) return;
  const today = etDateOf(now);
  for (const [key, r] of premarketRallies) {
    if (r.date !== today || minute >= FADE_CHECK_UNTIL) {
      premarketRallies.delete(key);
      continue;
    }
    const current = sectorMedian(r.symbols, changes, minStocks);
    if (current === null) continue; // 这一轮行情不够,下一轮再看
    premarketRallies.delete(key);
    const verdict = fadeVerdict(r.median, current);
    void announce({
      id: `fade:${key}`, kind: 'event', symbol: r.symbols[0] ?? '', title: fadeTitle(r.sector, verdict), body: fadeBody(r.median, current, verdict),
      tone: verdict === 'faded' ? 'down' : 'up', at: now, page: 'sectors',
    }, null);
  }
}

/** 欧盘开收、美股开盘前、最后一小时:美股的钟点只在美股开着(盘前 / 盘中)时报 */
function checkSessionMarks(now: number): void {
  const cfg = getEventsConfig();
  if (!cfg?.enabled) return;
  const market = getStatus()?.market_status ?? '';
  for (const due of sessionMarksDue(now, fired, market === '盘前' || market === '盘中')) {
    fired.add(due.key);
    void announce({ id: `event:${due.key}`, kind: 'event', symbol: 'SPX', title: due.mark.title, body: sessionMarkBody(due.mark, now), tone: 'info', at: now, page: 'trade' }, null);
  }
}

function tick(): void {
  const now = Date.now();
  set({ now });
  // 跨市场的窗口里(美股盘中到 A 股开盘后一小时)一分钟问一次:差距在盘中随时会出现;平时五分钟
  const every = useStore.getState().events.list?.cross_status.in_window ? SECTOR_SWEEP_MS : LIST_REFRESH_MS;
  if (now - loadedAt >= every) void loadEvents();
  checkLeads(now);
  checkSessionMarks(now);
  const cfg = getEventsConfig();
  if (cfg?.enabled && getStatus()?.broker_connected && inSession(now) && now - sweepAt >= SECTOR_SWEEP_MS) {
    sweepAt = now;
    void sweepSectors(now);
  }
}

export function startEventsLoop(): void {
  if (started) return;
  started = true;
  void loadEvents();
  setInterval(tick, TICK_MS);
  dafri.on('engine-event', ({ event }) => {
    if (event === 'ready') void loadEvents(); // 引擎重启:日历源的缓存没了,清单重拉
  });
}

/** 改口径:一次只改一两项,引擎在当前那份上合并;改完清单重拉(中等影响的开关会改清单) */
export async function saveEventsConfig(part: Partial<EventsConfig>): Promise<string | null> {
  try {
    const { config } = await dafri.setEventsConfig(part);
    const { list } = useStore.getState().events;
    if (list) set({ list: { ...list, config } });
    loadedAt = 0;
    void loadEvents();
    return null;
  } catch (err) {
    return errorMessage(err);
  }
}

export async function addCustomEvent(spec: { title: string; date_et: string; time_et: string; note?: string }): Promise<string | null> {
  try {
    await dafri.addEvent(spec);
    loadedAt = 0;
    await loadEvents();
    return null;
  } catch (err) {
    return errorMessage(err);
  }
}

export async function removeCustomEvent(id: string): Promise<string | null> {
  try {
    await dafri.removeEvent(id);
    loadedAt = 0;
    await loadEvents();
    return null;
  } catch (err) {
    return errorMessage(err);
  }
}

/** 美东今天(给对冲的到期日用) */
export function etToday(now = Date.now()): string {
  return etDateOf(now);
}
