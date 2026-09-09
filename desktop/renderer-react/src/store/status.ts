/**
 * 引擎状态:全站共用的一份快照,5 秒一轮,上一轮没回来绝不叠加
 * (旧界面曾因此在管道里攒出 159 个待处理的 system.status)。
 */
import { useSyncExternalStore } from 'react';
import { dafri, errorMessage, type Account, type Status } from '../bridge';
import { hideBanner, showBanner } from './banner';

type Listener = () => void;

let status: Status | null = null;
let engineOk: boolean | null = null;   // null = 还没问过
let inFlight: Promise<void> | null = null;
let engaged = false;                   // 上一轮的熔断状态,用来只在跳变时说话
let started = false;
const listeners = new Set<Listener>();

function emit() {
  listeners.forEach((l) => l());
}

function subscribe(l: Listener) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/**
 * 拉一次状态。上一轮没回来时**合流到同一个 promise**,不叠加也不空手返回——
 * 发单之后 `await refreshStatus()` 必须等到新数据,否则就绪清单与闸门算的是旧快照。
 */
export function refreshStatus(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      status = await dafri.status();
      engineOk = true;
      announceBreaker(status);
    } catch (err) {
      // 引擎不答话时,红点之外还得说一句:只剩一个 8px 圆点变红,没人知道发生了什么
      engineOk = false;
      showBanner(`引擎无响应:${errorMessage(err)}`, false);
    } finally {
      inFlight = null;
      emit();
    }
  })();
  return inFlight;
}

/** 熔断在跳变时说一次原因(自动跳闸时尤其重要:用户要知道是谁停的、为什么)。 */
function announceBreaker(next: Status): void {
  const now = Boolean(next.breaker?.engaged);
  if (now === engaged) return;
  engaged = now;
  if (now) showBanner(`已熔断:${next.breaker?.reason || '自动执行已停止'}`, false);
  else hideBanner();
}

export function startStatusPolling(): void {
  if (started) return;
  started = true;
  void refreshStatus();
  setInterval(refreshStatus, 5000);
  dafri.on('engine-event', ({ event, data }) => {
    if (event === 'breaker' || event === 'ready' || event === 'settings' || event === 'pending') void refreshStatus();
    // 引擎报上来的错(券商掉线、鉴权失效之类)必须落到界面上,不能只留在主进程日志里
    else if (event === 'error') showBanner(String(data?.message ?? '引擎报告了一个错误'), false);
  });
  dafri.on('engine-exit', ({ detail }) => {
    engineOk = false;
    showBanner(`交易引擎已退出:${detail}。可在「关于」里重启。`, false);
    emit();
  });
  dafri.on('menu', ({ action }) => {
    if (action === 'refresh') void refreshStatus();
  });
}

export function useStatus(): Status | null {
  return useSyncExternalStore(subscribe, () => status);
}

export function useEngineOk(): boolean | null {
  return useSyncExternalStore(subscribe, () => engineOk);
}

export function getStatus(): Status | null {
  return status;
}

/** 网关短名跟着生效的券商走:顶栏写「TWS 已连接」而单子实际从 OpenD 出去,是会出事的。 */
export function gatewayName(st: Status | null = status): string {
  return st && st.broker_provider === 'futu' ? 'OpenD' : 'TWS';
}

/** 当前券商通道下可选的账户:两家都配了别名时,只列生效券商那一家的。 */
export function pickableAccounts(st: Status | null = status): Account[] {
  if (!st || !Array.isArray(st.accounts)) return [];
  const provider = st.broker_provider || 'ibkr';
  return st.accounts.filter((a) => (a.broker || 'ibkr') === provider);
}

export function brokerShortName(st: Status | null = status): string {
  return st && st.broker_provider === 'futu' ? '富途' : 'IBKR';
}
