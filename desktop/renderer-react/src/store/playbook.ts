/**
 * SPX 日内剧本:引擎里自己的循环在取预期波动区间、盯现价过没过线(engine-ts/src/services/playbook.ts),这里只读它的结果。
 *
 * 两路:面板看得见时五秒读一次整份;引擎报出事件(进入 / 失效 / 穿过加速档)时当场推过来,**不看当前在哪一页**——
 * 过线的那一刻人多半不在这一页。声音与弹窗跟「提醒方式」那两个开关走;这里另有一个只管剧本提醒的开关,记在本机。
 */
import { create } from 'zustand';
import { dafri, errorMessage, type PlaybookEvent, type PlaybookSnapshot, type PopupItem } from '../bridge';
import { eventBody, eventTitle, eventTone } from '../lib/playbookFormat';
import { playAlertTone } from './alerts';
import { showAlertPopup } from './popup';

export const PLAYBOOK_REFRESH_MS = 5_000;
const ALERT_KEY = 'dafri-playbook-alert';

export interface PlaybookState {
  snap: PlaybookSnapshot | null;
  /** 最近一次没读成的原因;读成了是 null */
  failure: string | null;
  /** 过线时提醒。偏好记在本机,默认开 */
  alertOn: boolean;
}

const useStore = create<{ playbook: PlaybookState }>(() => ({
  playbook: {
    snap: null,
    failure: null,
    alertOn: ((): boolean => {
      try {
        return localStorage.getItem(ALERT_KEY) !== '0';
      } catch {
        return true;
      }
    })(),
  },
}));

function set(part: Partial<PlaybookState>): void {
  useStore.setState((s) => ({ playbook: { ...s.playbook, ...part } }));
}

export function usePlaybook(): PlaybookState {
  return useStore((s) => s.playbook);
}

let inFlight = false;
let last = 0;
let visible = false;
let started = false;

async function announce(symbol: string, event: PlaybookEvent): Promise<void> {
  const tone = eventTone(event);
  playAlertTone(tone);
  const title = eventTitle(symbol, event);
  const body = eventBody(event);
  const item: PopupItem = {
    id: `playbook:${event.kind}:${event.state}:${event.level}:${event.at}`,
    kind: 'level',
    symbol,
    title,
    body,
    tone,
    at: event.at,
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

export async function loadPlaybook(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    set({ snap: await dafri.playbook(), failure: null });
  } catch (err) {
    set({ failure: errorMessage(err) });
  } finally {
    inFlight = false;
    last = Date.now();
  }
}

function tick(): void {
  if (visible && Date.now() - last >= PLAYBOOK_REFRESH_MS) void loadPlaybook();
}

function onPush(data: { events?: PlaybookEvent[]; snapshot?: PlaybookSnapshot } | null | undefined): void {
  if (!data) return;
  if (data.snapshot) set({ snap: data.snapshot, failure: null });
  if (!useStore.getState().playbook.alertOn) return;
  const symbol = data.snapshot?.symbol ?? 'SPX';
  for (const event of data.events ?? []) void announce(symbol, event);
}

/** 启动时调一次(main.tsx):订阅引擎的 playbook 事件,起面板用的那个轮询 */
export function startPlaybookFeed(): void {
  if (started) return;
  started = true;
  dafri.on('engine-event', ({ event, data }) => {
    if (event === 'playbook') onPush(data);
  });
  setInterval(tick, 1_000);
}

/** 面板挂上 / 卸下时调:看得见才轮询 */
export function setPlaybookVisible(on: boolean): void {
  visible = on;
  if (on) void loadPlaybook();
}

export function setPlaybookAlert(on: boolean): void {
  set({ alertOn: on });
  try {
    localStorage.setItem(ALERT_KEY, on ? '1' : '0');
  } catch {
    /* 预览台的 data: 页面没有 localStorage */
  }
}

/** 开关引擎里的那个循环。返回没改成的原因;改成了是 null */
export async function setPlaybookEnabled(on: boolean): Promise<string | null> {
  try {
    set({ snap: await dafri.setPlaybook(on), failure: null });
    return null;
  } catch (err) {
    return errorMessage(err);
  }
}
