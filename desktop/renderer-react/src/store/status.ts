/**
 * 引擎状态:全站共用的一份快照,5 秒一轮,上一轮没回来绝不叠加
 * (旧界面曾因此在管道里攒出 159 个待处理的 system.status)。
 */
import { create } from 'zustand';
import { dafri, errorMessage, type Account, type Status } from '../bridge';
import { hideBanner, showBanner } from './banner';

const useStore = create<{
  status: Status | null;
  engineOk: boolean | null;   // null = 还没问过
}>(() => ({ status: null, engineOk: null }));

let inFlight: Promise<void> | null = null;
let engaged = false;                   // 上一轮的熔断状态,用来只在跳变时说话
let started = false;

/**
 * 拉一次状态。上一轮没回来时**合流到同一个 promise**,不叠加也不空手返回——
 * 发单之后 `await refreshStatus()` 必须等到新数据,否则就绪清单与闸门算的是旧快照。
 */
export function refreshStatus(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const status = await dafri.status();
      useStore.setState({ status, engineOk: true });
      announceBreaker(status);
    } catch (err) {
      // 引擎不答话时,红点之外还得说一句:只剩一个 8px 圆点变红,没人知道发生了什么
      useStore.setState({ engineOk: false });
      showBanner(`引擎无响应:${errorMessage(err)}`, false);
    } finally {
      inFlight = null;
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
    if (event === 'breaker' || event === 'ready' || event === 'settings' || event === 'pending' || event === 'broker_link') {
      void refreshStatus(); // broker_link:与 TWS 断开 / 自动连回,顶栏的连接状态当场跟着变
    }
    // 引擎报上来的错(券商掉线、鉴权失效之类)必须落到界面上,不能只留在主进程日志里
    else if (event === 'error') showBanner(String(data?.message ?? '引擎报告了一个错误'), false);
  });
  dafri.on('engine-exit', ({ detail }) => {
    useStore.setState({ engineOk: false });
    showBanner(`交易引擎已退出:${detail}。正在自动重启,重启后自动连回券商;也可在「关于」里手动重启。`, false);
  });
  dafri.on('menu', ({ action }) => {
    if (action === 'refresh') void refreshStatus();
  });
}

export function useStatus(): Status | null {
  return useStore((s) => s.status);
}

export function useEngineOk(): boolean | null {
  return useStore((s) => s.engineOk);
}

export function getStatus(): Status | null {
  return useStore.getState().status;
}

/** 网关短名跟着生效的券商走:顶栏写「TWS 已连接」而单子实际从 OpenD 出去,是会出事的。 */
export function gatewayName(st: Status | null = getStatus()): string {
  return st && st.broker_provider === 'futu' ? 'OpenD' : 'TWS';
}

/** 当前券商通道下可选的账户:两家都配了别名时,只列生效券商那一家的。 */
export function pickableAccounts(st: Status | null = getStatus()): Account[] {
  if (!st || !Array.isArray(st.accounts)) return [];
  const provider = st.broker_provider || 'ibkr';
  return st.accounts.filter((a) => (a.broker || 'ibkr') === provider);
}

export function brokerShortName(st: Status | null = getStatus()): string {
  return st && st.broker_provider === 'futu' ? '富途' : 'IBKR';
}
