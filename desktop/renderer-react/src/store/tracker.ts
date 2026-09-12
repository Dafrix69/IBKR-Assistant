/**
 * 持仓追踪:持仓、追踪设置、每秒盯盘结果、券商托管对账。
 *
 * 两个每秒循环**不看当前在哪一页**——止损要保命,切走了还得盯着。
 * 引擎负责判断与发单,这里只是按秒驱动它并把结果摆出来。
 */
import { create } from 'zustand';
import { dafri, errorMessage } from '../bridge';
import { pushNotification } from './notify';
import { loadRecords } from './records';
import { getStatus } from './status';

export interface Position {
  key: string;
  account: string;
  symbol: string;
  sec_type: string;
  quantity: number;
  avg_cost: number;
  multiplier?: number;
  market_price?: number | null;
  unrealized_pnl?: number | null;
  unrealized_pct?: number | null;
  pnl_source?: string;
  tracked?: boolean;
  contract?: Record<string, unknown>;
  label?: string;
  legs?: string[];
  net_side?: 'credit' | 'debit';
  [key: string]: unknown;
}

export interface TrackTargets {
  take_profit?: number | null;
  stop_loss?: number | null;
  trail_pct?: number | null;
  profit_drawdown_pct?: number | null;
  profit_drawdown_tiers?: unknown;
  /** 标的目标价:止盈价不是人填的,而是每轮按当前波动率现算出来的 */
  spot_target?: number | null;
}

/** 引擎每轮算出来的「标的走到目标价 → 这份持仓值多少 / 赚多少」。 */
export interface SpotTargetRow {
  spot_target: number;
  spot?: number | null;
  /** 现价怎么来的:夜盘按期货推算时写明期货与基差 */
  spot_note?: string;
  price?: number | null;
  pnl?: number | null;
  pnl_pct?: number | null;
  sigma?: number | null;
  /** none 正股 / smile 每条腿各自反解 / net 自身报价反解 / leg 最近腿反解 / clock 模型默认波动率 */
  sigma_source?: string;
  /** smile 档每条腿各自的 σ_剩余(点),键是「行权价+C/P」 */
  leg_sigmas?: Record<string, number>;
  structure?: string;
  reason?: string;
  /** 引擎这一轮只守不挂:还没拿到过市场价 */
  held?: boolean;
  /** 试算时:这个价不比现价更有利,挂上去会立刻成交(设置时会被拒) */
  warning?: string;
}

export interface Track {
  id: string;
  account: string;
  symbol: string;
  sec_type: string;
  contract?: Record<string, unknown>;
  targets?: TrackTargets;
  auto_close?: { enabled?: boolean; order_type?: string; host_at_broker?: boolean; close_fraction_pct?: number };
  enabled: boolean;
  peak?: number | null;
  fired_at?: string | null;
  fired_state?: string;
  [key: string]: unknown;
}

export interface LiveRow {
  id: string;
  state?: string;
  price?: number | null;
  peak?: number | null;
  trail_stop?: number | null;
  unrealized_pnl?: number | null;
  unrealized_pct?: number | null;
  reason?: string;
  stop_effective?: number | null;
  profit_peak?: number | null;
  profit_drawdown_threshold?: number | null;
  profit_trail_stop?: number | null;
  spot_target?: SpotTargetRow | null;
  blocked?: string[];
}

export interface HostedOrder {
  kind: string;
  label: string;
}

/** 引擎里盯盘节拍器的心跳(TradingEngine.trackerHeartbeat)。 */
export interface LoopHeartbeat {
  running: boolean;
  interval_ms: number;
  ticks: number;
  slow_ticks: number;
  last_ms: number | null;
  max_ms: number;
  age_ms: number | null;
  last_error: string;
}

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
  set(part);
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
