/**
 * 新版本检查。请求在主进程里发(desktop/update-check.js),这里只管什么时候问、问到了怎么摆。
 *
 * - 自动检查默认开:启动 30 秒后问一次(不和启动时的连接、行情抢),之后每 12 小时一次。
 *   「关于」页可以关掉;关掉之后只有手动点「检查更新」才会去问。开发态(npm start)不自动问。
 * - 顶栏的「新版本」提示可以按版本号忽略:忽略了 0.5.2,等 0.5.3 出来才再亮。
 * - 检查失败不打扰人:自动检查失败只记在这里,「关于」页看得到;不弹横幅、不影响任何交易功能。
 */
import { create } from 'zustand';
import { dafri, errorMessage, type UpdateInfo } from '../bridge';

const AUTO_KEY = 'dafri-update-auto';
const DISMISS_KEY = 'dafri-update-dismissed';
const FIRST_DELAY_MS = 30_000;
const INTERVAL_MS = 12 * 60 * 60 * 1000;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 预览台的 data: 页面没有 localStorage */
  }
}

export interface UpdateState {
  info: UpdateInfo | null;
  checking: boolean;
  error: string | null;
  auto: boolean;
  dismissed: string;
}

const useStore = create<UpdateState>(() => ({
  info: null,
  checking: false,
  error: null,
  auto: read(AUTO_KEY) !== '0',
  dismissed: read(DISMISS_KEY) || '',
}));

let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;

export async function checkUpdate(force = false): Promise<void> {
  if (useStore.getState().checking) return;
  useStore.setState({ checking: true });
  try {
    const info = await dafri.checkUpdate(force);
    useStore.setState({ info, error: null });
  } catch (err) {
    useStore.setState({ error: errorMessage(err) });
  } finally {
    useStore.setState({ checking: false });
  }
}

function schedule(delay: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    if (!useStore.getState().auto) return;
    void checkUpdate().finally(() => schedule(INTERVAL_MS));
  }, delay);
}

export function startUpdateChecks(): void {
  if (started) return;
  started = true;
  void dafri
    .appInfo()
    .then((app) => {
      if (app.dev === true) return;
      if (useStore.getState().auto) schedule(FIRST_DELAY_MS);
    })
    .catch(() => {
      /* 拿不到应用信息就不自动问,手动检查照常可用 */
    });
}

export function setAutoUpdateCheck(on: boolean): void {
  write(AUTO_KEY, on ? '1' : '0');
  useStore.setState({ auto: on });
  if (on) schedule(FIRST_DELAY_MS);
  else if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/** 顶栏提示按版本号忽略:这一版不再提示,更新的版本出来照样亮。 */
export function dismissUpdate(version: string): void {
  write(DISMISS_KEY, version);
  useStore.setState({ dismissed: version });
}

export function useUpdate(): UpdateState {
  return useStore();
}

/** 顶栏要不要亮「新版本」:有更新的正式版,且用户没忽略这一版。 */
export function useUpdateBadge(): UpdateInfo | null {
  return useStore((s) => (s.info?.newer && s.info.latest && s.info.latest !== s.dismissed ? s.info : null));
}
