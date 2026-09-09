/**
 * 期权墙 · 价位警告。价位与状态机都在引擎侧,这里只负责显示和触发重算。
 * 唯一特别的地方:警告轮询**不挂在当前页上**——切走了还得报,不然就没用了。
 */
import { useSyncExternalStore } from 'react';
import { dafri, errorMessage } from '../bridge';
import { showBanner } from './banner';
import { getStatus } from './status';

export interface AlertLevel {
  price: number;
  label?: string;
  source: string;
  kind: 'support' | 'resistance' | 'neutral' | string;
  state?: unknown;
}

export interface AlertWall {
  net_gex: number;
  regime: string;
  max_pain?: { strike: number } | null;
  pc_ratio_oi?: number | null;
  days_to_expiry?: number;
  spot_source?: string;
}

export interface AlertEvent {
  at?: number;
  symbol?: string;
  text?: string;
  direction?: 'up' | 'down';
  price?: number;
}

export interface Watch {
  id: string;
  symbol: string;
  step: number;
  enabled: number | boolean;
  last_price?: number | null;
  expiry?: string;
  wall?: AlertWall | null;
  levels?: AlertLevel[];
  events?: AlertEvent[];
}

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

type Listener = () => void;
let snap: AlertsSnapshot = { watches: [], feed: [], busy: [], lastCheck: '—' };
const busySet = new Set<string>();
let polling = false;
let started = false;
const listeners = new Set<Listener>();

function set(part: Partial<AlertsSnapshot>) {
  snap = { ...snap, ...part };
  listeners.forEach((l) => l());
}

function subscribe(l: Listener) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

// ---- 提示音:Web Audio 现场合成,不加载任何音频文件 -----------------------------
// CSP 是 default-src 'none',连 data: 的 <audio> 都会被拦下;现场合成不涉及任何资源请求。
let audioCtx: AudioContext | null = null;
let soundOn = ((): boolean => {
  try {
    return localStorage.getItem('dafri-alert-sound') !== '0';
  } catch {
    return true;
  }
})();
const soundListeners = new Set<Listener>();

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

/** 上穿升调、下破降调——不用看屏幕就知道方向。 */
export function playAlertTone(direction: 'up' | 'down' | undefined): void {
  if (!soundOn) return;
  const ctx = audioContext();
  if (!ctx) return;
  const notes = direction === 'up' ? [587.33, 880.0] : [880.0, 587.33];
  notes.forEach((freq, i) => {
    const at = ctx.currentTime + i * 0.16;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, at);
    // 包络必须有:直接开关振荡器会有明显的咔哒声
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.22, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.15);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.18);
  });
}

export function setSoundEnabled(on: boolean): void {
  soundOn = on;
  try {
    localStorage.setItem('dafri-alert-sound', on ? '1' : '0');
  } catch {
    /* 同上 */
  }
  soundListeners.forEach((l) => l());
  if (on) playAlertTone('up');   // 打开时响一声,确认真的能出声
}

export function useSoundEnabled(): boolean {
  return useSyncExternalStore(
    (l) => {
      soundListeners.add(l);
      return () => {
        soundListeners.delete(l);
      };
    },
    () => soundOn,
  );
}

/** 声音 + 系统通知。两条都走:声音提醒"有事",通知告诉你"什么事"。 */
async function announce(event: AlertEvent): Promise<void> {
  playAlertTone(event.direction);
  try {
    await dafri.notify(`${event.symbol || ''} ${event.direction === 'up' ? '上穿' : '下破'} ${event.price}`, event.text || '');
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
  if (!snap.watches.some((w) => w.enabled && (w.levels || []).length)) return;
  polling = true;
  try {
    const result = await dafri.pollAlerts();
    const fired: AlertEvent[] = result?.fired || [];
    for (const event of fired) await announce(event);
    if (fired.length) {
      set({ feed: [...fired, ...snap.feed].slice(0, 50) });
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
    if (event === 'alerts') set({ feed: [...(data?.events || []), ...snap.feed].slice(0, 50) });
  });
}

export function useAlerts(): AlertsSnapshot {
  return useSyncExternalStore(subscribe, () => snap);
}

/** 侧栏徽标:已算出价位、真的在盯的标的数 */
export function useAlertsArmed(): number {
  return useSyncExternalStore(subscribe, () => snap.watches.reduce((n, w) => n + ((w.levels || []).length ? 1 : 0), 0));
}
