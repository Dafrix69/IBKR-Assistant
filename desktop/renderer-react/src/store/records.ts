/**
 * 交易记录列表:记录页与订单看板共用一份。引擎的 pending 事件、旧页面发单后调 loadRecords,
 * 都会刷新这一份。
 */
import { create } from 'zustand';
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

const useStore = create<{
  records: RecordSummary[];
  error: string | null;
}>(() => ({ records: [], error: null }));

let inFlight = false;
let started = false;

export async function loadRecords(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const res = await dafri.listRecords(60);
    useStore.setState({ records: Array.isArray(res?.records) ? res.records : [], error: null });
  } catch (err) {
    useStore.setState({ error: errorMessage(err) });
  } finally {
    inFlight = false;
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
  return useStore((s) => s.records);
}

export function useRecordsError(): string | null {
  return useStore((s) => s.error);
}
