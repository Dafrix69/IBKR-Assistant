/** 一条交易记录的详情。记录是这个软件的核心产物,它的详情该像一份单据。
 *
 * 2026-09-21 从 pages/Records.tsx 搬出来(函数体逐字未改)。
 * 真账号不在这里:引擎那头已经换成了打码后的 account_masked(见 contract/records.ts)。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Button, Collapse, Descriptions, Table, Timeline } from 'antd';
import { dafri, errorMessage } from '../bridge';
import type { RecordFill, RecordIbkr, RecordLlm, RecordStatusEvent, TradeRecord } from '../bridge';
import { fmtExpiry, fmtMoney, fmtTime, fmtTimeShort } from './format';
import {
  ACTION_LABEL,
  COMBO_LABEL,
  LIVE_STATUS_LABEL,
  ORDER_TYPE_LABEL,
  PRICE_MODE_LABEL,
  SEC_TYPE_LABEL,
  TIF_LABEL,
  say,
} from './labels';
import { OrderTicket, ticketFromRecord } from './OrderTicket';
import { OrderStages, StatusPill } from './OrderStatus';
import { openReviewFor } from '../store/review';
import { EmptyState, LoadingBlock } from '../ui/kit';

type Row = [string, unknown];

function Section({ title, rows }: { title: string; rows: Row[] }) {
  // 空的小节直接不画——留一堆"—"只会让人以为坏了
  const live = rows.filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!live.length) return null;
  return (
    <div className="detail-section">
      <h4>{title}</h4>
      <Descriptions size="small" column={1} colon={false} items={live.map(([k, v]) => ({ key: k, label: k, children: String(v) }))} />
    </div>
  );
}

export function RecordDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const [record, setRecord] = useState<any>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'gone' | 'error'>('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    dafri
      .getRecord(id)
      .then((res) => {
        if (cancelled) return;
        if (!res?.record) {
          setState('gone');
          return;
        }
        setRecord(res.record);
        setState('ok');
      })
      .catch((err) => {
        if (cancelled) return;
        setError(errorMessage(err));
        setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  let body: ReactNode;
  if (state === 'loading') body = <LoadingBlock rows={4} />;
  else if (state === 'gone') body = <EmptyState>这条记录已经不在了</EmptyState>;
  else if (state === 'error') body = <EmptyState>读取失败:{error}</EmptyState>;
  else body = <DetailBody record={record} onClose={onClose} />;

  return (
    <div className="detail" id="record-detail">
      {body}
    </div>
  );
}

function DetailBody({ record, onClose }: { record: TradeRecord; onClose: () => void }) {
  // 这四处兜底成空对象之后编译器就只认得 `{}` 了,所以各标一个类型(值一个字没动)。
  // contract / order 在契约里本来就是松散的 JSON(券商那边的结构),所以是 Record。
  const c: Record<string, unknown> = record.contract || {};
  const o: Record<string, unknown> = record.order || {};
  const ib: Partial<RecordIbkr> = record.ibkr || {};
  const llm: RecordLlm = record.llm || {};
  const timeline: RecordStatusEvent[] = ib.status_timeline || [];
  const fills: RecordFill[] = ib.fills || [];
  const ticket = ticketFromRecord(c, o, record.trigger);

  return (
    <>
      <div className="detail-head">
        <strong>{`${c.symbol || '—'} · ${ACTION_LABEL[String(o.action ?? '')] || o.action || ''} ${o.totalQuantity ?? ''}`}</strong>
        <StatusPill record={record} fallback="进行中" />
        <span className="detail-actions">
          {c.combo_strategy === 'BUTTERFLY' ? (
            <Button size="small" onClick={() => openReviewFor(record.id ?? '')}>
              分析这笔交易
            </Button>
          ) : null}
          <Button size="small" type="text" onClick={onClose}>
            收起
          </Button>
        </span>
      </div>

      {/* 单据的上半张是画出来的:票据 + 走到哪一步;下面的逐项明细照旧留着,核对时要看的是字 */}
      {ticket ? (
        <div className="detail-ticket">
          <OrderTicket ticket={ticket} />
          <OrderStages record={record} />
        </div>
      ) : null}

      {record.error_detail ? <Alert type="error" showIcon message="失败原因" description={String(record.error_detail)} style={{ marginTop: 10 }} /> : null}

      <Section
        title="这笔单"
        rows={[
          ['意图', llm.intent_summary],
          ['原指令', (record.input || {}).raw_instruction],
          ['理由', (record.input || {}).reason],
          ['账户', `${(record.account || {}).alias || ''} ${(record.account || {}).account_masked || ''}`.trim()],
          ['提交时间', fmtTime(record.created_at)],
        ]}
      />
      <Section
        title="合约"
        rows={[
          ['类型', say(SEC_TYPE_LABEL, c.secType)],
          ['标的', c.symbol],
          ['到期日', fmtExpiry(c.lastTradeDateOrContractMonth)],
          ['行权价', c.strike],
          ['方向', c.right === 'C' ? '看涨 Call' : c.right === 'P' ? '看跌 Put' : null],
          ['组合', say(COMBO_LABEL, c.combo_strategy)],
          ['腿数', Array.isArray(c.legs) ? c.legs.length : null],
        ]}
      />
      <Section
        title="订单"
        rows={[
          ['买卖', say(ACTION_LABEL, o.action)],
          ['类型', say(ORDER_TYPE_LABEL, o.orderType)],
          ['数量', o.totalQuantity],
          ['限价', o.lmtPrice],
          ['触发价', o.auxPrice],
          ['定价方式', say(PRICE_MODE_LABEL, o.price_mode)],
          ['有效期', say(TIF_LABEL, o.tif)],
          ['盘前盘后', o.outsideRth === undefined ? null : o.outsideRth ? '允许' : '不允许'],
          ['券商单号', ib.order_id],
        ]}
      />
      <Section
        title="成交"
        rows={[
          ['均价', ib.avg_fill_price != null ? fmtMoney(ib.avg_fill_price) : null],
          ['手续费', ib.total_commission != null ? fmtMoney(ib.total_commission) : null],
          ['已实现盈亏', ib.realized_pnl != null ? fmtMoney(ib.realized_pnl) : null],
        ]}
      />
      <Section
        title="模型"
        rows={[
          ['模型', llm.model],
          ['提示词版本', llm.prompt_version],
          ['置信度', llm.confidence],
          ['token', llm.usage ? `入 ${llm.usage.input_tokens ?? '?'} / 出 ${llm.usage.output_tokens ?? '?'}` : null],
        ]}
      />

      {timeline.length ? (
        <div className="detail-section">
          <h4>状态时间线</h4>
          <Timeline
            items={timeline.map((step, i) => ({
              key: i,
              children: (
                <span className="timeline-item">
                  <b>{LIVE_STATUS_LABEL[step.status || ''] || step.status || '—'}</b>
                  <span>{fmtTime(step.at)}</span>
                </span>
              ),
            }))}
          />
        </div>
      ) : null}

      {fills.length ? (
        <div className="detail-section">
          <h4>{`成交明细(${fills.length} 笔)`}</h4>
          <Table
            size="small"
            pagination={false}
            rowKey={(f) => f.exec_id || `${f.time}-${f.price}`}
            dataSource={fills}
            columns={[
              { title: '时间', dataIndex: 'time', render: (v: string) => fmtTimeShort(v) },
              { title: '数量', dataIndex: 'qty', align: 'right', render: (v: number) => String(v ?? '—') },
              { title: '价格', dataIndex: 'price', align: 'right', render: (v: number) => (v != null ? fmtMoney(v) : '—') },
              { title: '手续费', dataIndex: 'commission', align: 'right', render: (v: number) => (v != null ? fmtMoney(v) : '—') },
            ]}
          />
        </div>
      ) : null}

      {(record.post_warnings || []).map((w: { message?: string }, i: number) => (
        <Alert key={i} type="warning" showIcon message="提醒" description={w.message || ''} style={{ marginTop: 10 }} />
      ))}

      {/* 原始 JSON 不删,只是收起来:这个项目在意可审计性,那份原文要留得住 */}
      <Collapse
        ghost
        size="small"
        className="detail-raw"
        items={[{ key: 'raw', label: '原始记录(JSON)', children: <pre>{JSON.stringify(record, null, 2)}</pre> }]}
      />
    </>
  );
}
