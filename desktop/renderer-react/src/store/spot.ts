/**
 * 蝴蝶测算面板顶上那一行实时 SPX,以及它走到 25 的整数倍时的提醒。
 *
 * 现价和测算用的是同一路(引擎的 options.spot:常规时段是指数本身,之外按期货推算),不是顶栏行情带那一格——
 * 那一格夜盘停在昨收上。
 *
 * **提醒的轮询不挂在面板上**:走到关口正是该回来测算的时候,人多半不在这一页。连着券商、提醒开着就两秒问一次;
 * 提醒关着时只在面板看得见的时候问。引擎那边读的是常驻行情流里的那一笔,不另订行情。
 * 穿没穿过关口的判定在 lib/spotLevels(纯函数);声音与弹窗跟「提醒方式」那两个开关走,和价位提醒是同一扇窗。
 */
import { create } from 'zustand';
import { dafri, errorMessage, type OptionsSpot, type PopupItem } from '../bridge';
import { EMPTY_WATCH, levelHitBody, levelHitTitle, stepLevelWatch, type LevelHit, type LevelWatchState } from '../lib/spotLevels';
import { playAlertTone } from './alerts';
import { showAlertPopup } from './popup';
import { getStatus } from './status';

export const SPOT_SYMBOL = 'SPX';
export const SPOT_REFRESH_MS = 2_000;
const ALERT_KEY = 'dafri-spot-level-alert';

export interface SpotState {
  /** 最近一次问到的;没连券商、还没问到是 null */
  quote: OptionsSpot | null;
  /** 最近一次没问成的原因(引擎不答话);问成了是 null */
  failure: string | null;
  /** 走到关口时提醒。偏好记在本机,默认开 */
  alertOn: boolean;
  /** 本次开机以来最近一次报的关口 */
  lastHit: LevelHit | null;
}

const useStore = create<{ spot: SpotState }>(() => ({
  spot: {
    quote: null,
    failure: null,
    alertOn: ((): boolean => {
      try {
        return localStorage.getItem(ALERT_KEY) !== '0';
      } catch {
        return true;
      }
    })(),
    lastHit: null,
  },
}));

function set(part: Partial<SpotState>): void {
  useStore.setState((s) => ({ spot: { ...s.spot, ...part } }));
}

export function useSpot(): SpotState {
  return useStore((s) => s.spot);
}

let watch: LevelWatchState = EMPTY_WATCH;
let inFlight = false;
let last = 0;
let visible = false;
let started = false;

async function announce(hit: LevelHit): Promise<void> {
  playAlertTone(hit.direction);
  const title = levelHitTitle(SPOT_SYMBOL, hit);
  const body = levelHitBody(hit);
  const item: PopupItem = {
    id: `spot:${SPOT_SYMBOL}:${hit.level}:${hit.at}`,
    kind: 'level',
    symbol: SPOT_SYMBOL,
    title,
    body,
    tone: hit.direction,
    at: hit.at,
    page: 'trade',
  };
  const { dropped } = await showAlertPopup([item]);
  if (dropped <= 0) return;
  try {
    await dafri.notify(title, body);
  } catch (err) {
    console.warn('系统通知失败', err);
  }
}

export async function loadSpot(): Promise<void> {
  // 引擎的读道有并发上限:上一轮没回来就不再发
  if (inFlight) return;
  inFlight = true;
  try {
    const quote = await dafri.indexSpot(SPOT_SYMBOL);
    set({ quote, failure: null });
    if (!useStore.getState().spot.alertOn) return;
    const next = stepLevelWatch(watch, quote);
    watch = next.state;
    if (next.hit) {
      set({ lastHit: next.hit });
      void announce(next.hit);
    }
  } catch (err) {
    set({ quote: null, failure: errorMessage(err) });
  } finally {
    inFlight = false;
    last = Date.now();
  }
}

function tick(): void {
  const { quote, failure, alertOn } = useStore.getState().spot;
  if (!getStatus()?.broker_connected) {
    // 断开之后不留着一个不会再动的数
    if (quote !== null || failure !== null) set({ quote: null, failure: null });
    return;
  }
  if (!alertOn && !visible) return;
  if (Date.now() - last >= SPOT_REFRESH_MS) void loadSpot();
}

export function startSpotLoop(): void {
  if (started) return;
  started = true;
  setInterval(tick, 1_000);
}

/** 面板挂上 / 卸下时调:提醒关着的时候,只有看得见才问现价 */
export function setSpotVisible(on: boolean): void {
  visible = on;
  if (on) tick();
}

export function setSpotAlert(on: boolean): void {
  // 关掉期间走过哪儿没人看着:重新打开后的第一笔只登记
  watch = EMPTY_WATCH;
  set({ alertOn: on });
  try {
    localStorage.setItem(ALERT_KEY, on ? '1' : '0');
  } catch {
    /* 预览台的 data: 页面没有 localStorage */
  }
  if (on) tick();
}
