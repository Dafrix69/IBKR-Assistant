import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Input, Segmented, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { dafri, errorMessage } from '../bridge';
import { fmtMoney, fmtTime, fmtTimeShort } from '../lib/format';
import { statusLabel } from '../lib/labels';
import { BUCKET_LABEL, BUCKET_TINT, SidePill, StatusPill, statusBucket, type StatusBucket } from '../lib/OrderStatus';
import { RecordDetail } from '../lib/RecordDetail';
import { showBanner } from '../store/banner';
import { loadRecords, useRecords, useRecordsError, type RecordSummary } from '../store/records';
import { SegBar, SymBadge } from '../ui/graphics';
import { EmptyState, PageHead } from '../ui/kit';

// 状态筛选的分档。刻意不按 final_status 的枚举一一列出——用户想的是
// "成了 / 还挂着 / 没发出去",不是 rejected_by_validator 和 rejected_by_llm 的区别。
const FILTERS: { key: string; label: string; match: (r: RecordSummary) => boolean }[] = [
  { key: 'all', label: '全部', match: () => true },
  { key: 'filled', label: '已成交', match: (r) => r.final_status === 'filled' || r.final_status === 'partially_filled' },
  { key: 'live', label: '进行中', match: (r) => !r.final_status && r.status !== 'ValidatedOnly' && r.status !== 'NotAtBroker' },
  { key: 'stale', label: '去向不明', match: (r) => !r.final_status && r.status === 'NotAtBroker' },
  { key: 'draft', label: '未发送', match: (r) => !r.final_status && r.status === 'ValidatedOnly' },
  { key: 'rejected', label: '被拒', match: (r) => String(r.final_status || '').startsWith('rejected') },
  { key: 'failed', label: '出错', match: (r) => r.final_status === 'ibkr_error' || r.final_status === 'halted_by_breaker' },
];

const BUCKETS: StatusBucket[] = ['filled', 'working', 'draft', 'failed', 'halted', 'stale', 'closed'];

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
  const mix = useMemo(() => {
    const out: Partial<Record<StatusBucket, number>> = {};
    for (const r of byKeyword) out[statusBucket(r)] = (out[statusBucket(r)] || 0) + 1;
    return out;
  }, [byKeyword]);
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
      width: 150,
      sorter: (a, b) => String(a.symbol || '').localeCompare(String(b.symbol || '')),
      render: (_: unknown, r) => (
        <span className="record-sym-cell">
          <SymBadge small symbol={r.symbol || '—'} tint={r.action === 'SELL' ? 'down' : r.action === 'BUY' ? 'up' : 'gray'} />
          <SidePill action={r.action} />
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
      width: 112,
      sorter: (a, b) => statusLabel(a, '进行中').localeCompare(statusLabel(b, '进行中')),
      render: (_: unknown, r) => <StatusPill record={r} fallback="进行中" />,
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

      {/* 这一批记录的去向:一根分段条 + 图例。数的是关键词过滤之后的集合,和下面筛选条的条数同一口径 */}
      {byKeyword.length ? (
        <div className="status-mix">
          <SegBar parts={BUCKETS.map((b) => ({ key: b, value: mix[b] || 0, tint: BUCKET_TINT[b], label: BUCKET_LABEL[b] }))} />
          <div className="status-mix-legend">
            {BUCKETS.filter((b) => mix[b]).map((b) => (
              <span key={b}>
                <i style={{ background: `var(--${BUCKET_TINT[b]})` }} />
                {BUCKET_LABEL[b]}
                <b>{mix[b]}</b>
              </span>
            ))}
          </div>
        </div>
      ) : null}

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

