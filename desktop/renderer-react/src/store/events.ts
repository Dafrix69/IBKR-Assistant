/**
 * 重要事件:清单从引擎来(内置日程 + 公开日历 + 自定义),提醒与板块联动在这里判——和关口提醒、异动提醒同一扇弹窗。
 *
 * 三个节拍,都不看当前在哪一页(循环只能在 store 里):
 *  · 清单 5 分钟拉一次(引擎那边日历源 4 小时一拉,这里只是把它拿过来);引擎重启、口径改了、加了自定义事件时当场重拉。
 *  · 15 秒一拍:倒计时跟着走,到了提前提醒的点就弹窗 / 响铃 / 系统通知。报过的记在内存里,每档只报一次。
 *  · 板块联动 60 秒一轮,只在连着券商、美东 04:00 ~ 20:00 里跑:成分股的涨跌幅从异动循环留在引擎里的那一份读(quality.list,本地道),
 *    不另订行情。一个板块的集体涨跌报一次,之后它还在就一直挂着,直到条件消失 30 分钟。
 */
import { create } from 'zustand';
import { dafri, errorMessage, type EconEvent, type EventsConfig, type EventsList, type PopupItem, type Sector } from '../bridge';
import {
  etDateOf, leadBody, leadTitle, leadsDue, sectorMoveBody, sectorMoveTitle, sectorMoves, type SectorMove,
} from '../lib/eventRules';
import { playAlertTone } from './alerts';
import { pushNotification } from './notify';
import { showAlertPopup } from './popup';
import { getStatus } from './status';

export type { EconEvent, EventsConfig, EventsList, SectorMove };

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

export async function loadEvents(force = false): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const list = await dafri.listEvents(force);
    set({ list, failure: null });
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

function checkLeads(now: number): void {
  const { list } = useStore.getState().events;
  if (!list || !list.config.enabled) return;
  for (const due of leadsDue(list.events, now, list.config.lead_minutes, fired)) {
    fired.add(due.key);
    const title = leadTitle(due.event, due.lead);
    const body = leadBody(due.event, due.lead, now);
    void announce({ id: `event:${due.key}`, kind: 'event', symbol: 'SPX', title, body, tone: 'info', at: now, page: 'trade' }, due.lead > 0 ? null : 'down');
  }
}

/** 美东 04:00 ~ 20:00(盘前到盘后)才看板块:别的时候涨跌幅是昨天的 */
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
    const changes: Record<string, number | null> = {};
    for (const stock of quality.stocks) changes[stock.symbol] = stock.metrics?.change_pct ?? null;
    const found = sectorMoves(
      sectors.map((s) => ({ name: s.name, symbols: s.stocks.map((x) => x.symbol) })),
      changes,
      { min_stocks: cfg.sector_min_stocks, share: cfg.sector_share, move_pct: cfg.sector_move_pct },
    );
    const prev = useStore.getState().events.moves;
    const next: EventsState['moves'] = [];
    for (const m of found) {
      const old = prev.find((p) => p.sector === m.sector && p.direction === m.direction);
      next.push({ ...m, since: old?.since ?? now, seenAt: now });
      if (!old) {
        const title = sectorMoveTitle(m);
        const body = sectorMoveBody(m, cfg.sector_move_pct);
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

function tick(): void {
  const now = Date.now();
  set({ now });
  if (now - loadedAt >= LIST_REFRESH_MS) void loadEvents();
  checkLeads(now);
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
