/**
 * 订单状态的图形口径:看板与记录页共用——同一笔单在两页上必须是同一种颜色、同一段路径。
 *
 *   StatusPill   状态胶囊:成了绿、在途蓝、被拒 / 报错红、撤了 / 没触发灰、熔断橙
 *   OrderStages  阶段路径:校验 → 提交 → 成交;没走完的那一步停在哪就亮在哪,被拒的整条变红
 *   SidePill     买 / 卖:跟着「涨跌配色」走
 */
import { Pill, StagePath, type Tint } from '../ui/graphics';
import { ACTION_LABEL, statusLabel, type StatusLike } from './labels';

export type StatusBucket = 'filled' | 'working' | 'failed' | 'closed' | 'halted' | 'draft' | 'stale';

export function statusBucket(r: StatusLike): StatusBucket {
  const f = String(r.final_status || '');
  if (f === 'filled') return 'filled';
  if (f === 'halted_by_breaker') return 'halted';
  if (f.startsWith('rejected') || f === 'ibkr_error') return 'failed';
  if (f === 'cancelled' || f === 'expired_untriggered') return 'closed';
  if (f === 'partially_filled') return 'working';
  const s = String(r.status || '');
  // 通过校验却没发出去的单不是"在途":把它算进蓝色会让人以为券商那边还挂着几十张单
  if (s === 'ValidatedOnly') return 'draft';
  // 对账查不到的单也不是"在途":券商那边没有它,再显示成蓝色就是让人等一个不会来的回报
  if (s === 'NotAtBroker') return 'stale';
  if (s === 'Filled') return 'filled';
  if (s === 'Inactive') return 'failed';
  if (s === 'Cancelled' || s === 'ApiCancelled') return 'closed';
  return 'working';
}

export const BUCKET_TINT: Record<StatusBucket, Tint> = { filled: 'green', working: 'blue', failed: 'red', closed: 'gray', halted: 'orange', draft: 'gray', stale: 'yellow' };
export const BUCKET_LABEL: Record<StatusBucket, string> = { filled: '已成交', working: '进行中', failed: '被拒 / 出错', closed: '已撤 / 未触发', halted: '熔断拦下', draft: '仅校验未发送', stale: '去向不明' };

export function StatusPill({ record, fallback = '—' }: { record: StatusLike; fallback?: string }) {
  return (
    <Pill dot tint={BUCKET_TINT[statusBucket(record)]}>
      {statusLabel(record, fallback)}
    </Pill>
  );
}

export function SidePill({ action }: { action?: string | null }) {
  if (!action) return null;
  const buy = action === 'BUY';
  return (
    <Pill tint={buy ? 'up' : 'down'} icon={<i className={`tri ${buy ? 'up' : 'down'}`} />}>
      {ACTION_LABEL[action] || action}
    </Pill>
  );
}

const STAGES = ['校验', '提交', '成交'];

export function OrderStages({ record }: { record: StatusLike }) {
  const bucket = statusBucket(record);
  const f = String(record.final_status || '');
  // 走到第几步:被校验 / 模型拒的停在第 0 步;券商报错、熔断停在提交;在途的停在成交之前
  let current = 1;
  if (bucket === 'filled') current = 3;
  else if (f.startsWith('rejected')) current = 0;
  else if (bucket === 'draft') current = 1;
  // 对账查不到的单确实提交过,路径停在"提交"那一步——它没成交,也没人再推它往前走
  else if ((bucket === 'working' || bucket === 'stale') && record.status) current = 2;
  return <StagePath stages={STAGES} current={current} tone={BUCKET_TINT[bucket]} />;
}
