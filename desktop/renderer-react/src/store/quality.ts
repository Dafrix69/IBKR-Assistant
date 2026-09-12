/**
 * 优质股追踪:列表、阈值、监控心跳,以及异动提醒的落地(提示音 + 弹窗 + 看板通知流 + 侧栏未读数)。
 *
 * 检测全在引擎里(RpcServer 级循环,5 秒一轮;当日量只跟同一条实时流里的基准比,见 anomaly.ts),
 * 这里不做任何判断,只负责"报出来"。和价位提醒一样,异动的订阅**不挂在当前页上**——切走了还得报。
 * quality.* 全在引擎的本地道(同步 SQLite + 读内存),页面停留时 5 秒重读一次也不碰券商。
 */
import { useSyncExternalStore } from 'react';
import { dafri, errorMessage, type AnomalyEvent, type PopupItem, type QualityConfig, type QualityMonitor, type QualityStock } from '../bridge';
import { toneDirection } from '../lib/alertRules';
import { playAlertTone } from './alerts';
import { showBanner } from './banner';
import { getTab } from './nav';
import { pushNotification } from './notify';
import { showAlertPopup } from './popup';

export const QUALITY_MAX = 30;
const FEED_MAX = 50;

export interface QualitySnapshot {
  stocks: QualityStock[];
  config: QualityConfig | null;
  monitor: QualityMonitor | null;
  /** 最近的异动,新的在前(启动时由各股落库的事件汇成初值) */
  feed: AnomalyEvent[];
  /** 侧栏徽标:还没看过的异动条数 */
  unread: number;
  loaded: boolean;
  max: number;
  /** 最近一次读列表失败的原因('' = 上一次读成功了)。引擎挂了、quality.list 一直报错,
   *  心跳那一行必须看得出来——它只会停在最后一次读到的 monitor 上,自己不会变红。 */
  error: string;
  /** 最近一次成功读到列表的时刻(epoch 毫秒;0 = 一次都没成功过) */
  loadedAt: number;
}

type Listener = () => void;
let snap: QualitySnapshot = { stocks: [], config: null, monitor: null, feed: [], unread: 0, loaded: false, max: QUALITY_MAX, error: '', loadedAt: 0 };
const listeners = new Set<Listener>();
let started = false;
let seeded = false;
let inFlight: Promise<void> | null = null;
let lastLoadError = '';
// 增删改的代数:一次读列表在飞的途中若有人改过,它带回来的就是旧列表,不能拿去覆盖本地
let generation = 0;

function set(part: Partial<QualitySnapshot>) {
  snap = { ...snap, ...part };
  listeners.forEach((l) => l());
}

function subscribe(l: Listener) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function isEvent(e: unknown): e is AnomalyEvent {
  const x = e as Partial<AnomalyEvent> | null;
  return Boolean(x) && typeof x!.id === 'string' && typeof x!.title === 'string';
}

/** 合并进通知流:按 id 去重、新的在前、封顶 50。 */
function mergeFeed(current: AnomalyEvent[], incoming: AnomalyEvent[]): AnomalyEvent[] {
  const seen = new Set<string>();
  const out: AnomalyEvent[] = [];
  for (const e of [...incoming, ...current]) {
    if (!isEvent(e) || seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  out.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  return out.slice(0, FEED_MAX);
}

/** 行回执里可能不带指标(新加的那只还没跑过一轮),补齐成列表里的形状。 */
function normalizeStock(stock: QualityStock): QualityStock {
  return { ...stock, events: Array.isArray(stock.events) ? stock.events : [], metrics: stock.metrics ?? null, metrics_at: stock.metrics_at ?? null };
}

// ---- 读 --------------------------------------------------------------------------

/** 拉一次列表。在飞的那一次没回来就合流,不叠加(页面 5 秒一轮 + 每次异动后补一轮)。 */
export function loadQuality(): Promise<void> {
  if (inFlight) return inFlight;
  const gen = generation;
  inFlight = (async () => {
    let stale = false;
    try {
      const res = await dafri.listQuality();
      const stocks = (Array.isArray(res?.stocks) ? res.stocks : []).map(normalizeStock);
      stale = gen !== generation;
      const part: Partial<QualitySnapshot> = {
        monitor: res?.monitor || null,
        max: Number(res?.max) > 0 ? Number(res.max) : QUALITY_MAX,
        loaded: true,
        error: '',
        loadedAt: Date.now(),
      };
      if (!stale) {
        part.stocks = stocks;
        part.config = res?.config || snap.config;
      }
      if (!seeded) {
        seeded = true;
        // 启动时把各股落库的事件汇成通知流的初值:重启之后"今天报过什么"还在
        part.feed = mergeFeed(snap.feed, stocks.flatMap((s) => s.events));
      }
      set(part);
      lastLoadError = '';
    } catch (err) {
      const msg = errorMessage(err);
      // 页面每 5 秒拉一次:同一个错只说一遍,别一直往上顶横幅
      if (msg !== lastLoadError) showBanner(`读取优质股列表失败:${msg}`, false);
      lastLoadError = msg;
      // 记进快照:界面要因此重画,把心跳那一行从绿色的「监控中」改成读不到的状态。
      // 只记原因,不动 monitor——最后一次读到的那份还得拿来显示"上次什么时候跳的"
      set({ error: msg, loaded: true });
    } finally {
      inFlight = null;
    }
    if (stale) void loadQuality();
  })();
  return inFlight;
}

// ---- 写 --------------------------------------------------------------------------

export async function addQuality(symbol: string, note = ''): Promise<boolean> {
  const s = symbol.trim().toUpperCase();
  if (!s) {
    showBanner('先填一个标的代码', true);
    return false;
  }
  try {
    const res = await dafri.addQuality(s, note.trim().slice(0, 60));
    generation += 1;
    const stock = res?.stock;
    if (stock?.id) set({ stocks: [...snap.stocks.filter((x) => x.id !== stock.id), normalizeStock(stock)] });
    else await loadQuality();
    showBanner(`已加入优质股追踪:${stock?.symbol || s}。盘中每 5 秒检测一轮,放量、急涨急跌会弹窗提醒。`, true);
    return true;
  } catch (err) {
    showBanner(`加入追踪失败:${errorMessage(err)}`, false);
    return false;
  }
}

export async function removeQuality(id: string, symbol: string): Promise<void> {
  const ok = await dafri.confirm({
    title: '不再追踪',
    message: `不再追踪 ${symbol}?`,
    detail: '它的异动记录会一起删掉;占着的那条行情线路会在下一轮释放。',
    confirmLabel: '移除',
  });
  if (!ok) return;
  try {
    await dafri.removeQuality(id);
    generation += 1;
    set({ stocks: snap.stocks.filter((x) => x.id !== id) });
  } catch (err) {
    showBanner(`移除失败:${errorMessage(err)}`, false);
    await loadQuality();   // 以引擎为准
  }
}

/** 启用 / 停用:先改本地(开关立刻跟手),回执回来再以它为准;失败就拨回去。 */
export async function toggleQuality(id: string, enabled: boolean): Promise<void> {
  const before = snap.stocks;
  generation += 1;
  set({ stocks: snap.stocks.map((x) => (x.id === id ? { ...x, enabled: enabled ? 1 : 0 } : x)) });
  try {
    const res = await dafri.updateQuality({ id, enabled });
    generation += 1;
    const stock = res?.stock;
    if (stock?.id) set({ stocks: snap.stocks.map((x) => (x.id === stock.id ? { ...x, ...normalizeStock(stock), metrics: stock.metrics ?? x.metrics, metrics_at: stock.metrics_at ?? x.metrics_at } : x)) });
  } catch (err) {
    set({ stocks: before });
    showBanner(`${enabled ? '启用' : '停用'}失败:${errorMessage(err)}`, false);
  }
}

/**
 * 存阈值:和当前那份合并成完整的一份交给引擎(它校验、越界拒绝并给中文原因)。
 * 存不上就重读——界面上已经改掉的数要退回引擎真正在用的那份,不能让人以为改成了。
 */
export async function saveQualityConfig(partial: Partial<QualityConfig>): Promise<boolean> {
  const base = snap.config;
  if (!base) return false;
  const next: QualityConfig = { ...base, ...partial };
  generation += 1;
  try {
    const res = await dafri.setQualityConfig(next);
    generation += 1;
    set({ config: res?.config || next });
    return true;
  } catch (err) {
    showBanner(`触发条件没存上:${errorMessage(err)}`, false);
    await loadQuality();
    return false;
  }
}

export function markQualitySeen(): void {
  if (snap.unread) set({ unread: 0 });
}

// ---- 异动提醒 ----------------------------------------------------------------------

function toPopupItem(e: AnomalyEvent): PopupItem {
  return {
    id: e.id,
    kind: 'anomaly',
    symbol: e.symbol,
    title: e.title,
    body: e.text,
    tone: e.direction === 'up' ? 'up' : e.direction === 'down' ? 'down' : 'info',
    at: Number(e.at) > 0 ? Number(e.at) * 1000 : Date.now(),
    page: 'quality',
  };
}

/** 一条系统通知的标题与正文:一条就照它自己写,多条合成一条——同一批报两遍就是噪音。 */
function fold(events: AnomalyEvent[]): { title: string; body: string } {
  if (events.length === 1) return { title: events[0].title, body: events[0].text };
  return {
    title: `${events.length} 条异动:${[...new Set(events.map((e) => e.symbol))].join('、')}`,
    body: events.map((e) => e.title).join(';'),
  };
}

/**
 * 弹窗;没收下的那几条退回系统通知。
 * 弹窗关着、通道坏了是"一条都没收下";一批超过弹窗单次上限时它只收前几条,剩下的尾巴同样不能丢——
 * 之前只要弹出来过一条就算成功,超出的那些谁也不管,悄无声息地没了。
 */
async function announce(events: AnomalyEvent[]): Promise<void> {
  const { dropped } = await showAlertPopup(events.map(toPopupItem));
  if (dropped <= 0) return;
  const rest = events.slice(Math.max(0, events.length - dropped));
  const { title, body } = fold(rest);
  try {
    await dafri.notify(title, body);
  } catch (err) {
    console.warn('系统通知失败', err);
  }
}

function onAnomaly(data: unknown): void {
  const raw = (data as { events?: unknown } | null)?.events;
  const known = new Set(snap.feed.map((e) => e.id));
  const fresh = (Array.isArray(raw) ? raw : []).filter((e): e is AnomalyEvent => isEvent(e) && !known.has(e.id));
  if (!fresh.length) return;
  // 人就在这一页、窗口也在前台,等于已经看见了;窗口在后台(正在 TWS 里)就还算没看
  const seeing = getTab() === 'quality' && document.hasFocus();
  set({ feed: mergeFeed(snap.feed, fresh), unread: seeing ? snap.unread : snap.unread + fresh.length });
  // 订单看板底下那条通知流也记一笔:回头翻"刚才报了什么"不用专门切到这一页
  for (const e of fresh) pushNotification(e.title, e.text);
  // 放量(rvol / burst)一律中性的两声:它们的 direction 是引擎顺手带的涨跌方向,只给圆点和色块用
  playAlertTone(toneDirection(fresh));
  void announce(fresh);
  void loadQuality();   // 各股的"最近异动"与指标跟上
}

/** 启动时调一次(main.tsx):读一遍列表,订阅引擎的 anomaly 事件。 */
export function startQualityFeed(): void {
  if (started) return;
  started = true;
  void loadQuality();
  dafri.on('engine-event', ({ event, data }) => {
    if (event === 'anomaly') onAnomaly(data);
    // 引擎重启之后以库里那份为准(阈值、启用状态都可能在别处改过)
    else if (event === 'ready') void loadQuality();
  });
}

export function useQuality(): QualitySnapshot {
  return useSyncExternalStore(subscribe, () => snap);
}

export function useQualityUnread(): number {
  return useSyncExternalStore(subscribe, () => snap.unread);
}
