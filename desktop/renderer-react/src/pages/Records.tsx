import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert, Button, Collapse, Descriptions, Input, Segmented, Table, Timeline } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { dafri, errorMessage } from '../bridge';
import { fmtExpiry, fmtMoney, fmtTime, fmtTimeShort } from '../lib/format';
import { openReviewFor } from '../store/review';
import {
  ACTION_LABEL,
  COMBO_LABEL,
  LIVE_STATUS_LABEL,
  ORDER_TYPE_LABEL,
  PRICE_MODE_LABEL,
  SEC_TYPE_LABEL,
  TIF_LABEL,
  say,
  statusLabel,
  statusTone,
} from '../lib/labels';
import { showBanner } from '../store/banner';
import { loadRecords, useRecords, useRecordsError, type RecordSummary } from '../store/records';
import { EmptyState, LoadingBlock, PageHead } from '../ui/kit';

// 状态筛选的分档。刻意不按 final_status 的枚举一一列出——用户想的是
// "成了 / 还挂着 / 没发出去",不是 rejected_by_validator 和 rejected_by_llm 的区别。
const FILTERS: { key: string; label: string; match: (r: RecordSummary) => boolean }[] = [
  { key: 'all', label: '全部', match: () => true },
  { key: 'filled', label: '已成交', match: (r) => r.final_status === 'filled' || r.final_status === 'partially_filled' },
  { key: 'live', label: '进行中', match: (r) => !r.final_status },
  { key: 'rejected', label: '被拒', match: (r) => String(r.final_status || '').startsWith('rejected') },
  { key: 'failed', label: '出错', match: (r) => r.final_status === 'ibkr_error' || r.final_status === 'halted_by_breaker' },
];

type Density = 'cozy' | 'compact';

function readDensity(): Density {
  try {
    return localStorage.getItem('dafri-record-density') === 'compact' ? 'compact' : 'cozy';
  } catch {
    return 'cozy';
  }
}

export function RecordsPage() {
  const records = useRecords();
  const loadError = useRecordsError();
  const [filter, setFilter] = useState('all');
  const [keyword, setKeyword] = useState('');
  const [density, setDensity] = useState<Density>(readDensity);
  const [openId, setOpenId] = useState<string | null>(null);

  // 进页即刷,停留期间 15 秒一轮(和旧界面的自动刷新同一节奏)
  useEffect(() => {
    void loadRecords();
    const t = setInterval(loadRecords, 15_000);
    return () => clearInterval(t);
  }, []);

  // Esc 收起打开的详情
  useEffect(() => {
    if (!openId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpenId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openId]);

  // 每档的条数按**关键词过滤之后**的集合算,否则筛选条会承诺一些点不出来的结果
  const byKeyword = useMemo(() => {
    const k = keyword.trim().toLowerCase();
    if (!k) return records;
    return records.filter((r) =>
      [r.symbol, r.reason, r.final_status, r.intent_summary, r.raw_instruction, r.account]
        .filter(Boolean)
        .some((f) => String(f).toLowerCase().includes(k)),
    );
  }, [records, keyword]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.key, byKeyword.filter(f.match).length])), [byKeyword]);
  const active = FILTERS.find((f) => f.key === filter) || FILTERS[0];
  const rows = useMemo(() => byKeyword.filter(active.match), [byKeyword, active]);

  function pickDensity(v: Density) {
    setDensity(v);
    try {
      localStorage.setItem('dafri-record-density', v);
    } catch {
      /* 同上 */
    }
  }

  async function exportAll() {
    try {
      const target = await dafri.pickExportPath();
      if (!target) return;
      const result = await dafri.exportData(target);
      showBanner(`已导出 ${result.records} 条记录到 ${result.path}`, true);
    } catch (err) {
      showBanner(`导出失败:${errorMessage(err)}`, false);
    }
  }

  const columns: ColumnsType<RecordSummary> = [
    {
      title: '时间',
      dataIndex: 'created_at',
      width: 96,
      sorter: (a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')),
      defaultSortOrder: 'descend',
      render: (v: string) => <span title={fmtTime(v)}>{fmtTimeShort(v)}</span>,
    },
    {
      title: '标的',
      dataIndex: 'symbol',
      width: 130,
      sorter: (a, b) => String(a.symbol || '').localeCompare(String(b.symbol || '')),
      render: (_: unknown, r) => (
        <span className="record-sym">
          {r.symbol || '—'}
          {r.action ? <span className={`side ${r.action === 'BUY' ? 'buy' : 'sell'}`}>{ACTION_LABEL[r.action] || r.action}</span> : null}
        </span>
      ),
    },
    {
      title: '意图',
      dataIndex: 'intent_summary',
      ellipsis: true,
      render: (_: unknown, r) => {
        const text = r.intent_summary || r.raw_instruction || '';
        return (
          <span title={text}>
            {text}
            {r.reason ? <span className="reason">{r.reason}</span> : null}
          </span>
        );
      },
    },
    {
      title: '账户',
      dataIndex: 'account',
      width: 150,
      ellipsis: true,
      render: (_: unknown, r) =>
        r.account ? <span className={`tag ${r.is_paper ? 'paper' : 'live'}`}>{`${r.account} ${r.account_masked || ''}`}</span> : null,
    },
    {
      title: '金额',
      dataIndex: 'notional_estimate',
      width: 110,
      align: 'right',
      render: (v: number | undefined) => (v ? `≈ ${fmtMoney(v)}` : ''),
    },
    {
      title: '状态',
      dataIndex: 'final_status',
      width: 92,
      sorter: (a, b) => statusLabel(a, '进行中').localeCompare(statusLabel(b, '进行中')),
      render: (_: unknown, r) => <span className={`status ${statusTone(r)}`}>{statusLabel(r, '进行中')}</span>,
    },
  ];

  return (
    <section className="tab-panel active" id="page-records">
      <PageHead
        title="交易记录"
        extra={
          <span className="row tight m0">
            <Segmented
              size="small"
              options={[
                { label: '舒适', value: 'cozy' },
                { label: '紧凑', value: 'compact' },
              ]}
              value={density}
              onChange={(v) => pickDensity(v as Density)}
            />
            <Button size="small" onClick={() => void exportAll()}>
              导出
            </Button>
          </span>
        }
      />

      <div className="row tight">
        <Segmented
          size="small"
          options={FILTERS.map((f) => ({
            value: f.key,
            label: (
              <span>
                {f.label}
                <span className="n">{counts[f.key] || 0}</span>
              </span>
            ),
            // 一条都没有的档位点了也是空的,先拦住——省掉一次白点
            disabled: f.key !== 'all' && !(counts[f.key] || 0),
          }))}
          value={filter}
          onChange={(v) => setFilter(String(v))}
        />
        <Input.Search
          className="grow"
          allowClear
          placeholder="按标的 / 原因 / 指令内容筛选"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
      </div>

      {loadError ? <Alert type="error" showIcon message={`读取失败:${loadError}`} style={{ marginBottom: 10 }} /> : null}

      <Table<RecordSummary>
        className="records-table"
        rowKey="id"
        size={density === 'compact' ? 'small' : 'middle'}
        columns={columns}
        dataSource={rows}
        pagination={false}
        showSorterTooltip={false}
        locale={{ emptyText: <EmptyState>{keyword || filter !== 'all' ? '没有符合条件的记录。' : '暂无记录。'}</EmptyState> }}
        rowClassName={(r) => (r.id === openId ? 'row-open' : '')}
        onRow={(r) => ({
          tabIndex: 0,
          onClick: () => setOpenId(r.id),
          onKeyDown: (e) => {
            if (e.key === 'Enter') setOpenId(r.id);
          },
        })}
      />

      {openId ? <RecordDetail id={openId} onClose={() => setOpenId(null)} /> : null}
    </section>
  );
}

// ---- 详情:记录是这个软件的核心产物,它的详情该像一份单据 ----------------------------

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

function RecordDetail({ id, onClose }: { id: string; onClose: () => void }) {
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

function DetailBody({ record, onClose }: { record: any; onClose: () => void }) {
  const c = record.contract || {};
  const o = record.order || {};
  const ib = record.ibkr || {};
  const llm = record.llm || {};
  const timeline: { status?: string; at?: string }[] = ib.status_timeline || [];
  const fills: { exec_id?: string; time?: string; qty?: number; price?: number; commission?: number }[] = ib.fills || [];
  const tone = statusTone(record);
  const status = record.final_status ? statusLabel(record, '进行中') : '进行中';

  return (
    <>
      <div className="detail-head">
        <strong>{`${c.symbol || '—'} · ${ACTION_LABEL[o.action] || o.action || ''} ${o.totalQuantity ?? ''}`}</strong>
        <span className={`status ${tone}`}>{status}</span>
        <span className="detail-actions">
          {c.combo_strategy === 'BUTTERFLY' ? (
            <Button size="small" onClick={() => openReviewFor(record.id)}>
              分析这笔交易
            </Button>
          ) : null}
          <Button size="small" type="text" onClick={onClose}>
            收起
          </Button>
        </span>
      </div>

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
          ['腿数', c.legs ? c.legs.length : null],
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
