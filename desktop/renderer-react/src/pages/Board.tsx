import { useEffect } from 'react';
import { Button } from 'antd';
import { fmtMoney, fmtTimeShort } from '../lib/format';
import { TRIGGER_OP_LABEL } from '../lib/labels';
import { OrderStages, SidePill, StatusPill, statusBucket } from '../lib/OrderStatus';
import { useFeed } from '../store/notify';
import { loadPending, usePending, usePendingError } from '../store/pending';
import { loadRecords, useRecords, useRecordsError } from '../store/records';
import { refreshStatus } from '../store/status';
import { StagePath, SymBadge, Widget } from '../ui/graphics';
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
      {/* 一眼看完今天的单:排着几张、路上几张、成了几张、砸了几张 */}
      <div className="widget-row">
        <Widget icon="sf-hourglass" tint="orange" value={pending.length} label="排队等待触发" />
        <Widget icon="sf-paperplane" tint="blue" value={live.filter((r) => statusBucket(r) === 'working').length} label="在途" />
        <Widget icon="sf-check" tint="green" value={live.filter((r) => statusBucket(r) === 'filled').length} label="已成交" />
        <Widget icon="sf-xmark" tint="red" value={records.filter((r) => statusBucket(r) === 'failed').length} label="被拒 / 出错" />
      </div>
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
                <StatusCard key={item.record_id}>
                  <div className="order-card-head">
                    <SymBadge symbol={item.symbol || ''} tint="orange" />
                    <div className="order-card-main">
                      <div className="order-card-title">{item.intent_summary}</div>
                      <Meta items={[`账户 ${item.account}`, `入队 ${fmtTimeShort(item.created_at)}`]} />
                    </div>
                  </div>
                  <div className="order-card-foot">
                    {/* 比较符是协议里的取值,摆给人看要用数学符号(和记录详情里的翻译口径一致) */}
                    <span className="trigger-chip">
                      {item.symbol} {TRIGGER_OP_LABEL[item.operator || ''] || item.operator} <b>{item.value}</b>
                    </span>
                    <StagePath stages={['排队', '触发', '提交', '成交']} current={0} tone="orange" />
                  </div>
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
                <StatusCard key={r.id}>
                  <div className="order-card-head">
                    <SymBadge symbol={r.symbol || ''} tint={r.action === 'SELL' ? 'down' : 'up'} />
                    <div className="order-card-main">
                      <div className="order-card-title">{r.intent_summary || r.raw_instruction}</div>
                      <Meta items={[`${r.quantity ?? ''} ${r.symbol}`, `账户 ${r.account}`, r.avg_fill_price ? <span className="strong">{`均价 ${fmtMoney(r.avg_fill_price)}`}</span> : null]} />
                    </div>
                    <SidePill action={r.action} />
                  </div>
                  <div className="order-card-foot">
                    <OrderStages record={r} />
                    <StatusPill record={r} />
                  </div>
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
