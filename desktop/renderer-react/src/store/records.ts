/**
 * 交易记录列表:记录页与订单看板共用一份。引擎的 pending 事件、旧页面发单后调 loadRecords,
 * 都会刷新这一份。
 */
import { create } from 'zustand';
import { dafri, errorMessage } from '../bridge';
import type { TradeRecordSummary } from '../bridge';

/** 以前这里手抄了一份(带着 [key: string]: unknown 的口子,字段名写错编译期查不出来)。
 *  现在就是引擎契约里的那 20 项(engine-ts/src/contract/records.ts)。 */
export type RecordSummary = TradeRecordSummary;

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
