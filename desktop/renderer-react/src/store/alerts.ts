/**
 * 期权墙 · 价位警告。价位与状态机都在引擎侧,这里只负责显示和触发重算。
 * 唯一特别的地方:警告轮询**不挂在当前页上**——切走了还得报,不然就没用了。
 */
import { create } from 'zustand';
import { dafri, errorMessage, type OptionWall, type PopupItem, type Watch, type WatchEvent, type WatchLevel } from '../bridge';
import { toneDirection } from '../lib/alertRules';
import { showBanner } from './banner';
import { showAlertPopup } from './popup';
import { getStatus } from './status';

// 形状在引擎契约里(engine-ts/src/contract/alerts.ts、options.ts),这里只转出——页面一直从这个文件 import 这几个名字。
// 以前这里手写过一份,猜错了两处:价位的 kind 写成了 'support' | 'resistance' | 'neutral'(引擎给的是 pivot,
// 从来没有 neutral),字段全标成可选(引擎其实每个都给)。
export type { Watch };
export type AlertLevel = WatchLevel;
export type AlertWall = OptionWall;
export type AlertEvent = WatchEvent;

export interface AlertsSnapshot {
  watches: Watch[];
  feed: AlertEvent[];
  busy: string[];
  lastCheck: string;
}

export const ALERT_SOURCE_LABEL: Record<string, string> = {
  call_wall: '持仓墙', put_wall: '持仓墙',
  call_vol_wall: '成交墙', put_vol_wall: '成交墙',
  max_pain: '最大痛点', gamma_flip: 'Gamma 翻转', round: '整数关口',
  ma20: '20日线', ma60: '60日线', ma120: '120日线', ma200: '200日线',
  low_52w: '52周低点', high_52w: '52周高点',
};
// 价位条上的短名:一行里要摆七八个,字要短;完整名进悬停提示
export const ALERT_SOURCE_SHORT: Record<string, string> = {
  call_wall: 'C 墙', put_wall: 'P 墙', call_vol_wall: 'C 成交墙', put_vol_wall: 'P 成交墙',
  max_pain: '痛点', gamma_flip: 'γ 翻转', round: '关口',
  ma20: 'MA20', ma60: 'MA60', ma120: 'MA120', ma200: 'MA200',
  low_52w: '52周低', high_52w: '52周高',
};

const useStore = create<{ snap: AlertsSnapshot; soundOn: boolean }>(() => ({
  snap: { watches: [], feed: [], busy: [], lastCheck: '—' },
  soundOn: ((): boolean => {
    try {
      return localStorage.getItem('dafri-alert-sound') !== '0';
    } catch {
      return true;
    }
  })(),
}));

const busySet = new Set<string>();
let polling = false;
let started = false;

const snapshot = (): AlertsSnapshot => useStore.getState().snap;

function set(part: Partial<AlertsSnapshot>) {
  useStore.setState((s) => ({ snap: { ...s.snap, ...part } }));
}

// ---- 提示音:Web Audio 现场合成,不加载任何音频文件 -----------------------------
// CSP 是 default-src 'none',连 data: 的 <audio> 都会被拦下;现场合成不涉及任何资源请求。
let audioCtx: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (!audioCtx) {
    const Ctor = window.AudioContext;
    if (!Ctor) return null;
    audioCtx = new Ctor();
  }
  // 自动播放策略可能把上下文挂起,每次播放前都试着唤醒
  if (audioCtx.state === 'suspended') void audioCtx.resume();
  return audioCtx;
}

/**
 * 上穿 / 急涨升调、下破 / 急跌降调——不用看屏幕就知道方向;没有方向(放量)是同一个音响两下。
 * 用户原话"声音太小了":峰值从 0.22 提到 0.6,正弦换三角波(泛音多,同样音量听着更亮),
 * 每个音拉长到 0.22 秒、音间 0.24 秒——原来 0.15 秒的短"嘀"在嘈杂环境里一晃就过去了。
 * force:「试听」按钮用,不看开关。
 */
export function playAlertTone(direction: 'up' | 'down' | null | undefined, force = false): void {
  if (!useStore.getState().soundOn && !force) return;
  const ctx = audioContext();
  if (!ctx) return;
  const notes = direction === 'up' ? [587.33, 880.0] : direction === 'down' ? [880.0, 587.33] : [739.99, 739.99];
  notes.forEach((freq, i) => {
    const at = ctx.currentTime + i * 0.24;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, at);
    // 包络必须有:直接开关振荡器会有明显的咔哒声。起音 20ms、顶住到 0.1 秒再收,响度主要靠这段平台
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.6, at + 0.02);
    gain.gain.setValueAtTime(0.6, at + 0.1);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.23);
  });
}

/** 「试听」:降调、升调各一遍,不看开关。 */
export function previewAlertTone(): void {
  playAlertTone('down', true);
  setTimeout(() => playAlertTone('up', true), 650);
}

export function setSoundEnabled(on: boolean): void {
  useStore.setState({ soundOn: on });
  try {
    localStorage.setItem('dafri-alert-sound', on ? '1' : '0');
  } catch {
    /* 同上 */
  }
  if (on) playAlertTone('up');   // 打开时响一声,确认真的能出声
}

export function useSoundEnabled(): boolean {
  return useStore((s) => s.soundOn);
}

function alertTitle(event: AlertEvent): string {
  return `${event.symbol || ''} ${event.direction === 'up' ? '上穿' : '下破'} ${event.price}`;
}

function toPopupItem(event: AlertEvent): PopupItem {
  const symbol = event.symbol || '';
  const at = event.at || Math.floor(Date.now() / 1000);
  return {
    id: `level:${symbol}:${event.price}:${at}`,
    kind: 'level',
    symbol,
    title: alertTitle(event),
    body: event.text || '',
    tone: event.direction === 'up' ? 'up' : event.direction === 'down' ? 'down' : 'info',
    at: at * 1000,
    page: 'sectors',
  };
}

/**
 * 声音 + 弹窗。声音提醒"有事",弹窗告诉你"什么事"——置顶小窗、不抢焦点,和优质股的异动提醒是同一扇窗。
 *
 * 一轮里报出来的一**批**走一次:提示音一批只响一声(峰值提到 0.6 之后,两条提醒各响一遍会叠在一起削顶,
 * 听起来是一声破音),弹窗也一次交过去。弹窗没收下的(关着、通道坏了、超了单次上限)合成一条系统通知。
 */
async function announce(events: AlertEvent[]): Promise<void> {
  if (!events.length) return;
  playAlertTone(toneDirection(events));
  const { dropped } = await showAlertPopup(events.map(toPopupItem));
  if (dropped <= 0) return;
  const rest = events.slice(Math.max(0, events.length - dropped));
  const one = rest.length === 1;
  const title = one ? alertTitle(rest[0]) : `${rest.length} 条价位提醒:${[...new Set(rest.map((e) => e.symbol || ''))].join('、')}`;
  const body = one ? rest[0].text || '' : rest.map(alertTitle).join(';');
  try {
    await dafri.notify(title, body);
  } catch (err) {
    console.warn('系统通知失败', err);
  }
}

// ---- 读写 ----------------------------------------------------------------------
export async function loadAlerts(): Promise<void> {
  try {
    const result = await dafri.listAlerts();
    set({ watches: result?.watches || [] });
  } catch (err) {
    showBanner(`警告列表读取失败:${errorMessage(err)}`, false);
  }
}

/** 建一个提醒并立刻算一次墙,不用再点一下。板块行里的「盯」和提醒区手填标的走同一条路。 */
export async function createWatch(symbol: string, step: number): Promise<boolean> {
  try {
    const { watch } = await dafri.createAlert(symbol, step);
    await loadAlerts();
    if (watch?.id) await refreshWatch(watch.id);
    return true;
  } catch (err) {
    showBanner(`盯 ${symbol} 失败:${errorMessage(err)}`, false);
    return false;
  }
}

export async function refreshWatch(id: string, expiry?: string): Promise<void> {
  busySet.add(id);
  set({ busy: [...busySet] });
  try {
    const result = await dafri.refreshAlert(id, expiry || '');
    await loadAlerts();
    // 期权墙/日线历史失败时降级继续——降级可以,但必须说出来
    if (result?.wall_error) showBanner(`期权墙没算出来,已降级:${result.wall_error}`, true);
    if (result?.history_error) showBanner(`均线/52周位没算出来,已降级:${result.history_error}`, true);
  } catch (err) {
    showBanner(`计算期权墙失败:${errorMessage(err)}`, false);
  } finally {
    busySet.delete(id);
    set({ busy: [...busySet] });
  }
}

export async function deleteWatch(id: string, symbol: string): Promise<void> {
  const ok = await dafri.confirm({
    title: '不再盯',
    message: `不再盯 ${symbol}?`,
    detail: '该标的的价位与触发记录会一起删掉。',
    confirmLabel: '删除',
  });
  if (!ok) return;
  try {
    await dafri.deleteAlert(id);
    await loadAlerts();
  } catch (err) {
    showBanner(`删除失败:${errorMessage(err)}`, false);
  }
}

/** 全局轮询:不管在哪一页都要跑,否则切走就不报了。 */
export async function pollAlerts(): Promise<void> {
  if (polling || !getStatus()?.broker_connected) return;
  if (!snapshot().watches.some((w) => w.enabled && (w.levels || []).length)) return;
  polling = true;
  try {
    const result = await dafri.pollAlerts();
    const fired: AlertEvent[] = result?.fired || [];
    await announce(fired);
    if (fired.length) {
      set({ feed: [...fired, ...snapshot().feed].slice(0, 50) });
      await loadAlerts();
    }
    set({ lastCheck: `上次检查 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}` });
  } catch (err) {
    console.warn('警告轮询失败', err);
  } finally {
    polling = false;
  }
}

export function startAlertsLoop(): void {
  if (started) return;
  started = true;
  void loadAlerts();
  setInterval(pollAlerts, 10_000);
  dafri.on('engine-event', ({ event, data }) => {
    if (event === 'alerts') set({ feed: [...(data?.events || []), ...snapshot().feed].slice(0, 50) });
  });
}

export function useAlerts(): AlertsSnapshot {
  return useStore((s) => s.snap);
}

/** 侧栏徽标:已算出价位、真的在盯的标的数 */
export function useAlertsArmed(): number {
  return useStore((s) => s.snap.watches.reduce((n, w) => n + ((w.levels || []).length ? 1 : 0), 0));
}
