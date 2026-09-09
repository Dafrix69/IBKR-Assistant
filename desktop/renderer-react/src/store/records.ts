/**
 * 交易记录列表:记录页与订单看板共用一份。引擎的 pending 事件、旧页面发单后调 loadRecords,
 * 都会刷新这一份。
 */
import { useSyncExternalStore } from 'react';
import { dafri, errorMessage } from '../bridge';

export interface RecordSummary {
  id: string;
  symbol?: string;
  action?: string;
  quantity?: number;
  account?: string;
  account_masked?: string;
  is_paper?: boolean;
  status?: string | null;
  final_status?: string | null;
  created_at?: string;
  intent_summary?: string;
  reason?: string;
  raw_instruction?: string;
  notional_estimate?: number;
  [key: string]: unknown;
}

type Listener = () => void;
let records: RecordSummary[] = [];
let error: string | null = null;
let inFlight = false;
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

export async function loadRecords(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const res = await dafri.listRecords(60);
    records = Array.isArray(res?.records) ? res.records : [];
    error = null;
  } catch (err) {
    error = errorMessage(err);
  } finally {
    inFlight = false;
    emit();
  }
}

export function startRecordsFeed(): void {
  if (started) return;
  started = true;
  void loadRecords();
  dafri.on('engine-event', ({ event }) => {
    if (event === 'pending') void loadRecords();
  });
  dafri.on('menu', ({ action }) => {
    if (action === 'refresh') void loadRecords();
  });
}

export function useRecords(): RecordSummary[] {
  return useSyncExternalStore(subscribe, () => records);
}

export function useRecordsError(): string | null {
  return useSyncExternalStore(subscribe, () => error);
}
