/**
 * 顶栏宏观行情带(公开数据,只读展示,不参与定价)。
 * 连了 TWS 才值得秒级:那时 6 格走常驻流式订阅,读一次几乎不花时间;
 * 没连时 8 格全走公开数据源,那个端点本身就不是秒级更新的,刷快了只是反复拿同一个值,还会把自己的 IP 打进限流。
 */
import { create } from 'zustand';
import { dafri } from '../bridge';
import { getStatus } from './status';

export interface MacroRow {
  key: string;
  label: string;
  instrument?: string;
  last?: number | null;
  change_pct?: number | null;
  source?: string;
  fmt?: 'pct' | 'plain' | string;
  stale?: boolean;
}

const useStore = create<{ rows: MacroRow[]; trails: Record<string, number[]> }>(() => ({ rows: [], trails: {} }));
/** 每格留本次开机以来的最近 90 个不同读数,给行情带画迷你走势;只在内存里,不落盘。 */
const TRAIL_MAX = 90;
function extendTrails(prev: Record<string, number[]>, rows: MacroRow[]): Record<string, number[]> {
  let next = prev;
  for (const row of rows) {
    if (row.last == null || !Number.isFinite(row.last) || row.stale) continue;
    const trail = prev[row.key] || [];
    if (trail[trail.length - 1] === row.last) continue;
    if (next === prev) next = { ...prev };
    next[row.key] = [...trail, row.last].slice(-TRAIL_MAX);
  }
  return next;
}
let inFlight = false;
let last = 0;
let started = false;

export async function loadMacroBoard(force = false): Promise<void> {
  // 引擎 sidecar 是串行的:上一轮没回来就再发,只会排队并把 PA 那边一起拖慢
  if (inFlight) return;
  inFlight = true;
  try {
    const board = await dafri.macroBoard(force);
    const rows = board?.rows || [];
    useStore.setState((s) => ({ rows, trails: extendTrails(s.trails, rows) }));
  } catch (err) {
    console.warn('宏观行情读取失败', err);
  } finally {
    inFlight = false;
    last = Date.now();
  }
}

export function startMacroLoop(): void {
  if (started) return;
  started = true;
  void loadMacroBoard();
  setInterval(() => {
    const every = getStatus()?.broker_connected ? 2_000 : 60_000;
    if (Date.now() - last >= every) void loadMacroBoard();
  }, 1_000);
}

export function useMacroRows(): MacroRow[] {
  return useStore((s) => s.rows);
}

export function useMacroTrails(): Record<string, number[]> {
  return useStore((s) => s.trails);
}
