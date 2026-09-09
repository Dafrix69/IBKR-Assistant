import { useEffect } from 'react';
import { Button } from 'antd';
import { fmtMoney, fmtTimeShort } from '../lib/format';
import { ACTION_LABEL, TRIGGER_OP_LABEL, statusLabel } from '../lib/labels';
import { useFeed } from '../store/notify';
import { loadPending, usePending, usePendingError } from '../store/pending';
import { loadRecords, useRecords, useRecordsError } from '../store/records';
import { refreshStatus } from '../store/status';
import { EmptyState, Feed, Meta, PageHead, SectionTitle, StatusCard } from '../ui/kit';

/** 订单看板:「排队等待触发」与「已提交」分列(§8.2b),下方是实时通知流。 */
export function BoardPage() {
  const pending = usePending();
  const pendingError = usePendingError();
  const records = useRecords();
  const recordsError = useRecordsError();
  const feed = useFeed();

  // 进页即刷,停留期间 15 秒一轮
  useEffect(() => {
    void loadPending();
    void loadRecords();
    const t = setInterval(() => {
      void loadPending();
      void loadRecords();
    }, 15_000);
    return () => clearInterval(t);
  }, []);

  const live = records.filter((r) => r.status && !r.rejection).slice(0, 8);

  return (
    <section className="tab-panel active" id="page-board">
      <PageHead
        title="订单看板"
        extra={
          <Button
            size="small"
            type="text"
            onClick={() => {
              void refreshStatus();
              void loadRecords();
              void loadPending();
            }}
          >
            刷新
          </Button>
        }
      />
      <div className="board-grid">
        <div>
          <SectionTitle count={pending.length}>排队等待触发</SectionTitle>
          <div className="cards">
            {pendingError ? (
              <EmptyState>读取失败:{pendingError}</EmptyState>
            ) : !pending.length ? (
              <EmptyState>没有等待触发的条件单。</EmptyState>
            ) : (
              pending.map((item) => (
                <StatusCard key={item.record_id} title={item.intent_summary}>
                  {/* 比较符是协议里的取值,摆给人看要用数学符号(和记录详情里的翻译口径一致) */}
                  <Meta items={[`${item.symbol} ${TRIGGER_OP_LABEL[item.operator || ''] || item.operator} ${item.value}`, `账户 ${item.account}`, `入队 ${fmtTimeShort(item.created_at)}`]} />
                </StatusCard>
              ))
            )}
          </div>
        </div>
        <div>
          <SectionTitle count={live.length}>已提交 / 近期</SectionTitle>
          <div className="cards">
            {recordsError ? (
              <EmptyState>读取失败:{recordsError}</EmptyState>
            ) : !live.length ? (
              <EmptyState>今天还没有提交过订单。</EmptyState>
            ) : (
              live.map((r) => (
                <StatusCard key={r.id} tone={r.final_status === 'filled' ? 'ok' : r.final_status ? 'warn' : 'info'} title={r.intent_summary || r.raw_instruction}>
                  <Meta
                    items={[
                      `${ACTION_LABEL[r.action || ''] || r.action || ''} ${r.quantity ?? ''} ${r.symbol}`,
                      `账户 ${r.account}`,
                      statusLabel(r, '—'),
                      r.avg_fill_price ? `均价 ${fmtMoney(r.avg_fill_price)}` : null,
                    ]}
                  />
                </StatusCard>
              ))
            )}
          </div>
        </div>
      </div>
      <SectionTitle>通知</SectionTitle>
      <Feed items={feed} empty="暂无通知" />
    </section>
  );
}
