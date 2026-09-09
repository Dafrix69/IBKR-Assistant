/**
 * 持仓追踪:持仓、追踪设置、每秒盯盘结果、券商托管对账。
 *
 * 两个每秒循环**不看当前在哪一页**——止损要保命,切走了还得盯着。
 * 引擎负责判断与发单,这里只是按秒驱动它并把结果摆出来。
 */
import { useSyncExternalStore } from 'react';
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
  blocked?: string[];
}

export interface HostedOrder {
  kind: string;
  label: string;
}

export interface TrackerSnapshot {
  positions: Position[];
  positionsError: string | null;
  tracks: Track[];
  rows: Record<string, LiveRow>;
  hosted: Record<string, { orders: HostedOrder[] }>;
  delayed: boolean;
}

type Listener = () => void;
let snap: TrackerSnapshot = { positions: [], positionsError: null, tracks: [], rows: {}, hosted: {}, delayed: false };
let pollBusy = false;
let reconcileBusy = false;
let rowsSig = '';
let hostedSig = '';
let started = false;
const listeners = new Set<Listener>();

function set(part: Partial<TrackerSnapshot>) {
  snap = { ...snap, ...part };
  listeners.forEach((l) => l());
}

function subscribe(l: Listener) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
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

/** 盯盘一轮:引擎算,这里驱动。触发了就通知、刷新持仓与记录。 */
export async function pollTrackers(): Promise<void> {
  if (pollBusy || !getStatus()?.broker_connected || !snap.tracks.length) return;
  pollBusy = true;
  try {
    const result = await dafri.pollTrackers();
    const rows: Record<string, LiveRow> = {};
    for (const row of result?.rows || []) rows[row.id] = row;
    const fired: { symbol: string; reason: string }[] = result?.fired || [];
    if (fired.length) {
      for (const f of fired) pushNotification(`自动平仓:${f.symbol}`, f.reason);
      set({ rows });
      await Promise.all([loadTracker(true), loadRecords()]);
      return;
    }
    // 盘口不动的那些轮次不发通知,免得订阅者每秒重渲染一遍
    const sig = JSON.stringify(
      (result?.rows || []).map((r: LiveRow) => [
        r.id, r.state, r.price, r.unrealized_pnl, r.profit_peak,
        r.profit_drawdown_threshold, r.profit_trail_stop, r.stop_effective, r.blocked,
      ]),
    );
    if (sig !== rowsSig) {
      rowsSig = sig;
      set({ rows });
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
  if (!snap.tracks.some((t) => t.auto_close?.host_at_broker)) return;
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
  // 1 秒一轮:0DTE 蝶的价格几秒就能走完一个档位,8 秒的判断间隔会让"回撤 30% 就平"
  // 变成"回撤到 45% 才发现"。有 busy 防重入、没有追踪时直接跳过,不会把 RPC 压垮。
  setInterval(pollTrackers, 1_000);
  setInterval(reconcileHosted, 1_000);
}

export function useTracker(): TrackerSnapshot {
  return useSyncExternalStore(subscribe, () => snap);
}
