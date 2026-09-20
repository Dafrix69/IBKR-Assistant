/**
 * 持仓追踪:持仓、追踪设置、每秒盯盘结果、券商托管对账。
 *
 * 两个每秒循环**不看当前在哪一页**——止损要保命,切走了还得盯着。
 * 引擎负责判断与发单,这里只是按秒驱动它并把结果摆出来。
 */
import { create } from 'zustand';
import {
  dafri, errorMessage,
  type ChaseInfo, type HostedOrderRow, type PositionRow, type SpotTarget, type Targets, type Track,
  type TrackPollRow, type TrackerHeartbeat,
} from '../bridge';
import { pushNotification } from './notify';
import { loadRecords } from './records';
import { getStatus } from './status';

/** 账户里的一份持仓。形状在引擎契约里(engine-ts/src/contract/positions.ts),这里只转出——页面一直叫它 Position。 */
export type Position = PositionRow;



// 追踪行、目标、标的目标价的试算结果:形状在引擎契约里(engine-ts/src/contract/tracker.ts),这里只转出——
// 页面一直从这个文件 import 这几个名字。以前这里手写过一份,enabled 写成了 boolean(tracker.add 的回执里其实是数字 1)。
export type { Track };
/** 库里存的是当时写进去的那份 JSON,老行没有后来才加的键 */
export type TrackTargets = Partial<Targets>;
/** 引擎每轮算出来的「标的走到目标价 → 这份持仓值多少 / 赚多少」。 */
export type SpotTargetRow = SpotTarget;

/** 追价平仓追到哪了(引擎每轮给):轮 = 秒;挂的价只朝成交方向动,让到 floor 为止 */
export type { ChaseInfo };

/** 盯盘一行:引擎给的那一行(契约里的 TrackPollRow),外加这个 store 自己并进去的 `blocked`
 *  ——引擎把被拦下的那几条单列在 blocked 数组里,界面要按行显示,所以在这里合到行上。 */
export type LiveRow = TrackPollRow & { blocked?: string[] };

/** 挂在券商侧的一张托管单 */
export type HostedOrder = HostedOrderRow;

/** 引擎里盯盘节拍器的心跳(TradingEngine.trackerHeartbeat)。 */
export type LoopHeartbeat = TrackerHeartbeat;

export interface TrackerSnapshot {
  positions: Position[];
  positionsError: string | null;
  tracks: Track[];
  rows: Record<string, LiveRow>;
  hosted: Record<string, { orders: HostedOrder[] }>;
  delayed: boolean;
  loop: LoopHeartbeat | null;
}

const useStore = create<{ snap: TrackerSnapshot }>(() => ({
  snap: { positions: [], positionsError: null, tracks: [], rows: {}, hosted: {}, delayed: false, loop: null },
}));

let pollBusy = false;
let reconcileBusy = false;
let rowsSig = '';
let hostedSig = '';
let started = false;

const snapshot = (): TrackerSnapshot => useStore.getState().snap;

function set(part: Partial<TrackerSnapshot>) {
  useStore.setState((s) => ({ snap: { ...s.snap, ...part } }));
}

export async function loadTracker(refreshPositions = true): Promise<void> {
  let tracks: Track[] = [];
  try {
    const res = await dafri.listTrackers();
    tracks = Array.isArray(res?.tracks) ? res.tracks : [];
  } catch {
    tracks = [];
  }
  const part: Partial<TrackerSnapshot> = { tracks };
  // 没连券商时读不到持仓,引擎会直接拒绝:不发这个请求,页面按"连接后才能读到"显示,主进程日志也不必多一条错误
  if (refreshPositions && !getStatus()?.broker_connected) {
    part.positions = [];
    part.positionsError = null;
  } else if (refreshPositions) {
    try {
      const res = await dafri.listPositions();
      part.positions = Array.isArray(res?.positions) ? res.positions : [];
      part.positionsError = null;
    } catch (err) {
      part.positions = [];
      part.positionsError = errorMessage(err);
    }
  }
  if (refreshPositions) positionsSig = ''; // 这里换过持仓了,下一轮 refreshPositions 不能拿旧签名判"没变"
  set(part);
}

/**
 * 持仓页停留期间的现价 / 盈亏刷新,只读持仓、不动追踪列表。
 *
 * IBKR 这条路读的全是引擎里常驻订阅的缓存(持仓快照 + 正股 / 期权腿行情流),走读道、约 100 ms,
 * 一秒一次没有负担;富途每次是一笔真的持仓查询且有频率限制,持仓页按 5 秒一次调。
 * 单轮读不到先留着上一份——一秒一轮时偶发的一次失败不该让整页闪成报错;连着 3 轮都读不到才报,
 * 免得拿旧数冒充实时。
 */
const POSITIONS_FAIL_LIMIT = 3;
let positionsBusy = false;
let positionsFails = 0;
let positionsSig = '';

export async function refreshPositions(): Promise<void> {
  if (positionsBusy || !getStatus()?.broker_connected) return;
  positionsBusy = true;
  try {
    const res = await dafri.listPositions();
    const positions: Position[] = Array.isArray(res?.positions) ? res.positions : [];
    positionsFails = 0;
    // 行情不动的那些轮次不发通知,免得整页每秒重渲染一遍
    const sig = JSON.stringify(positions);
    if (sig !== positionsSig || snapshot().positionsError !== null) {
      positionsSig = sig;
      set({ positions, positionsError: null });
    }
  } catch (err) {
    positionsFails += 1;
    if (positionsFails >= POSITIONS_FAIL_LIMIT) {
      positionsSig = '';
      set({ positions: [], positionsError: errorMessage(err) });
    }
  } finally {
    positionsBusy = false;
  }
}

/** 触发 / 被拦:引擎的节拍器当场推过来("tracker" 事件)。以前靠这里每秒读一次的返回值,
 * 节拍器挪进引擎之后读的是快照,同一次触发可能读到两次、也可能被下一轮盖掉——所以改成听推送。 */
async function onFired(fired: { symbol: string; reason: string }[]): Promise<void> {
  if (!fired.length) return;
  for (const f of fired) pushNotification(`自动平仓:${f.symbol}`, f.reason);
  await Promise.all([loadTracker(true), loadRecords()]);
}

/** 读引擎节拍器最新一轮的盯盘结果(节拍器在引擎里,不靠这里驱动;这里只负责画)。 */
export async function pollTrackers(): Promise<void> {
  if (pollBusy || !getStatus()?.broker_connected || !snapshot().tracks.length) return;
  pollBusy = true;
  try {
    const result = await dafri.pollTrackers();
    const rows: Record<string, LiveRow> = {};
    for (const row of result?.rows || []) rows[row.id] = row;
    const loop: LoopHeartbeat | null = result?.loop ?? null;
    // 节拍器没在跑时(兜底路径)返回值里仍会带触发
    const fired: { symbol: string; reason: string }[] = result?.fired || [];
    if (fired.length) {
      set({ rows, loop });
      await onFired(fired);
      return;
    }
    // 盘口不动的那些轮次不发通知,免得订阅者每秒重渲染一遍
    const sig = JSON.stringify(
      (result?.rows || []).map((r: LiveRow) => [
        r.id, r.state, r.price, r.unrealized_pnl, r.profit_peak,
        r.profit_drawdown_threshold, r.profit_trail_stop, r.stop_effective, r.blocked,
        r.spot_target?.price, r.spot_target?.pnl, r.spot_target?.sigma_source,
        r.sweeping, r.chase?.rounds, r.chase?.limit,
      ]),
    );
    if (sig !== rowsSig) {
      rowsSig = sig;
      set({ rows, loop });
    } else if (loop && (loop.ticks !== snapshot().loop?.ticks || loop.last_error !== snapshot().loop?.last_error)) {
      set({ loop }); // 心跳每轮都变;行没变时只刷心跳
    }
  } catch {
    /* 单轮失败不打断界面;下一轮再来 */
  } finally {
    pollBusy = false;
  }
}

/** 券商托管对账,一秒一轮:该挂的挂上、动态停损随峰值棘轮上移、不该在的撤掉。 */
export async function reconcileHosted(): Promise<void> {
  if (reconcileBusy || !getStatus()?.broker_connected) return;
  if (!snapshot().tracks.some((t) => t.auto_close?.host_at_broker)) return;
  reconcileBusy = true;
  try {
    const result = await dafri.reconcileTrackers();
    const hosted: TrackerSnapshot['hosted'] = {};
    for (const h of result?.hosted || []) hosted[h.id] = { orders: h.orders || [] };
    const delayed = Boolean(result?.quote_maybe_delayed);
    const sig = JSON.stringify([hosted, delayed, result?.blocked || []]);
    if (sig !== hostedSig) {
      hostedSig = sig;
      set({ hosted, delayed });
    }
  } catch {
    /* 单轮失败不打扰;托管单仍在券商侧站岗,下一秒再对 */
  } finally {
    reconcileBusy = false;
  }
}

export function startTrackerLoops(): void {
  if (started) return;
  started = true;
  void loadTracker(false);
  dafri.on('engine-event', ({ event, data }) => {
    if (event !== 'tracker') return;
    void onFired(((data as { fired?: { symbol: string; reason: string }[] })?.fired) || []);
  });
  // 节拍器在引擎里(每秒一轮,判触发 + 托管调价),窗口最小化、切页都不影响执行。
  // 这里一秒读一次它最新一轮的结果,只为把界面画出来——两个请求都在引擎的本地道,即答。
  setInterval(pollTrackers, 1_000);
  setInterval(reconcileHosted, 1_000);
}

export function useTracker(): TrackerSnapshot {
  return useStore((s) => s.snap);
}
