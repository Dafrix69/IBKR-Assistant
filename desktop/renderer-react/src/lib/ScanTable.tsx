/** 扫描页那张合并表:信号格、表本身、行业标签卡。
 *
 * 2026-09-21 从 pages/Screener.tsx 搬出来(函数体逐字未改)。行怎么拼、怎么排在 screenerRows.ts,
 * 这里只管画。
 */
import { useMemo } from 'react';
import { Button, Table, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { CdSignal, CdSignalError, RsResult, RsTagRow } from '../bridge';
import {
  CONFIRM_LABEL, isPending, num, rsCellProps, TF_LABEL,
  type InflState, type ScanRow, type SortState,
} from './screenerRows';

export function SignalCell({ sig, pending }: { sig: CdSignal | CdSignalError | undefined; pending?: boolean }) {
  if (pending) return <span className="sig none">…</span>;
  if (!sig) return <span className="sig none">—</span>;
  if ('error' in sig) {
    return (
      <span className="sig err" title={sig.error}>
        拿不到
      </span>
    );
  }
  if (!sig.signal) {
    return (
      <span className="sig none" title={sig.reason || ''}>
        {sig.bars < 40 ? '数据少' : '无'}
      </span>
    );
  }
  const [p1, p2] = sig.pivots || [];
  const title =
    p1 && p2
      ? `${p1.time} ${p1.price}(DIF ${p1.dif}) → ${p2.time} ${p2.price}(DIF ${p2.dif})\n价差 ${num(sig.price_gap_pct, 2, true)}%,DIF 差 ${num(sig.dif_gap, 4, true)},最新 DIF ${num(sig.dif_last, 3)}` +
        (sig.confirm && sig.confirm.at ? `\n均线穿越:${sig.confirm.at}` : '')
      : undefined;
  // 和 RS 并排之后一格只有一百来像素:胶囊里留「哪种背离、几根前」,第二行是右侧确认(没要求确认就写第二个摆动点的时间),其余进悬停
  const second = sig.confirm ? `MA${sig.confirm.ma} ${CONFIRM_LABEL[sig.confirm.status] || sig.confirm.status}` : p2 ? String(p2.time) : '';
  return (
    <>
      <span className={`sig ${sig.signal}`} title={title}>
        {sig.label}
        <span className="sub">{`${sig.age} 根前`}</span>
      </span>
      {second ? <span className={`sig-detail${sig.confirm?.status === 'confirmed' ? ' ok' : ''}`}>{second}</span> : null}
    </>
  );
}

export function ScanTable({
  rs,
  infl,
  rows,
  sort,
  onSort,
  picked,
  onSymbol,
}: {
  rs: RsResult | null;
  infl: InflState;
  rows: ScanRow[];
  sort: SortState | null;
  onSort: (s: SortState | null) => void;
  picked: string;
  onSymbol: (symbol: string) => void;
}) {
  const columns = useMemo<ColumnsType<ScanRow>>(() => {
    const windows: { n: number; label: string }[] = rs?.windows || [];
    const tfs: string[] = infl?.timeframes || [];
    const perTf = isPending(infl) ? undefined : infl?.per_timeframe;
    const sortable = (key: string) => ({ key, sorter: true, sortOrder: sort?.key === key ? sort.order : null, sortDirections: ['descend', 'ascend'] as ('descend' | 'ascend')[] });
    return [
      ...(rs ? [{ title: '#', dataIndex: 'rank', width: 36, className: 'rank', render: (v: number | null) => (v == null ? '' : String(v)) }] : []),
      {
        title: '标的',
        dataIndex: 'symbol',
        width: 72,
        className: 'sym text',
        render: (s: string) => (
          <Tooltip title="看这只的极值偏离">
            <Button
              type="link"
              size="small"
              className="sym-btn"
              onClick={(e) => {
                e.stopPropagation();
                onSymbol(s);
              }}
            >
              {s}
            </Button>
          </Tooltip>
        ),
      },
      { title: '标签', dataIndex: 'tag', width: 76, className: 'text', render: (tag: string, row: ScanRow) => tag || row.infl?.tag || '' },
      ...(rs
        ? [
            {
              title: '现价',
              dataIndex: 'last',
              width: 76,
              align: 'right' as const,
              render: (v: number | null, row: ScanRow) =>
                row.error ? (
                  <span className="sig err" title={row.error}>
                    拿不到
                  </span>
                ) : (
                  num(v)
                ),
            },
          ]
        : []),
      ...windows.map((w) => ({
        title: <span title={`${w.n} 个交易日`}>{`RS ${w.label}`}</span>,
        ...sortable(`w${w.n}`),
        align: 'right' as const,
        width: 78,
        render: (_: unknown, row: ScanRow) => {
          const cell = row.rs?.[String(w.n)];
          return cell ? `${num(cell.rs_pct, 1, true)}%` : '—';
        },
        onCell: (row: ScanRow) => {
          const cell = row.rs?.[String(w.n)];
          return { ...rsCellProps(cell ? cell.rs_pct : null), title: cell ? `自身 ${num(cell.ret_pct, 2, true)}% · 基准 ${num(cell.bench_pct, 2, true)}%` : undefined };
        },
      })),
      ...(rs
        ? [
            {
              title: '综合',
              dataIndex: 'score',
              ...sortable('score'),
              width: 78,
              align: 'right' as const,
              render: (v: number | null) => (v == null ? '—' : `${num(v, 1, true)}%`),
              onCell: (row: ScanRow) => rsCellProps(row.score),
            },
          ]
        : []),
      ...tfs.map((tf) => {
        const c = perTf?.[tf];
        return {
          title: (
            <span title={c ? `底背离 ${c.bull} 只 · 顶背离 ${c.bear} 只${!isPending(infl) && infl?.ma_period ? ` · 已过 MA${infl.ma_period} 确认 ${c.confirmed} 只` : ''}` : undefined}>
              {TF_LABEL[tf] || tf}
              {c ? <span className="th-sub">{`底 ${c.bull} · 顶 ${c.bear}`}</span> : null}
            </span>
          ),
          key: tf,
          className: 'text',
          render: (_: unknown, row: ScanRow) => <SignalCell sig={row.infl?.signals?.[tf]} pending={isPending(infl)} />,
        };
      }),
      ...(tfs.length
        ? [
            {
              title: <span title="有背离的周期数;括号里是其中已过均线确认的">命中</span>,
              ...sortable('hits'),
              width: 68,
              align: 'right' as const,
              render: (_: unknown, row: ScanRow) => {
                const hit = row.infl;
                return hit?.hits ? `${hit.hits}${hit.confirmed ? ` (✓${hit.confirmed})` : ''}` : '';
              },
            },
          ]
        : []),
    ];
  }, [rs, infl, sort, onSymbol]);

  return (
    <Table<ScanRow>
      className="screen-table"
      size="small"
      rowKey="symbol"
      columns={columns}
      dataSource={rows}
      pagination={false}
      showSorterTooltip={false}
      scroll={{ x: 'max-content', y: 520 }}
      rowClassName={(row) => `scan-row${row.symbol === picked ? ' row-open' : ''}${row.score == null && !row.infl?.hits ? ' dim' : ''}`}
      onRow={(row) => ({ onClick: () => onSymbol(row.symbol) })}
      onChange={(_p, _f, sorter) => {
        const one = Array.isArray(sorter) ? sorter[0] : sorter;
        onSort(one?.order ? { key: String(one.columnKey), order: one.order } : null);
      }}
    />
  );
}

/** 按业务标签汇总的 RS:五个窗口画成一组以 0 为基线的小柱 */
export function TagCards({ result }: { result: RsResult }) {
  const tags: RsTagRow[] = result.tags || [];
  if (!(tags.length > 1 || (tags[0] && tags[0].tag !== '未分类'))) {
    return <p className="hint">成分股还没有业务标签,按标签汇总要先到「板块」页给股票加标签(AI 选股会自动给)。</p>;
  }
  return (
    <div className="rs-tags">
      {tags.map((t) => (
        <div className="rs-tag-card" key={t.tag}>
          <div className="rs-tag-head">
            <span className="rs-tag-name">{`${t.tag} · ${t.count} 只`}</span>
            <span className="rs-tag-score">{t.score == null ? '—' : `${num(t.score, 1, true)}%`}</span>
          </div>
          {/* 向上绿、向下红,高度按幅度(±30% 封顶);数字留在柱子下面 */}
          <div className="rs-bars">
            {(result.windows || []).map((w: any) => {
              const cell = t.rs?.[String(w.n)];
              const v = cell ? Number(cell.median_pct) : null;
              const h = v == null ? 0 : Math.max(2, Math.min(100, (Math.abs(v) / 30) * 100));
              return (
                <span key={w.n} className="rs-bar-col" title={cell ? `${w.label}:中位数 RS ${num(cell.median_pct, 2, true)}%,${cell.beats}/${cell.total} 只跑赢` : undefined}>
                  <span className="rs-bar-box">
                    <i className="rs-bar-half top">{v != null && v >= 0 ? <b className="pos" style={{ height: `${h}%` }} /> : null}</i>
                    <i className="rs-bar-half bottom">{v != null && v < 0 ? <b className="neg" style={{ height: `${h}%` }} /> : null}</i>
                  </span>
                  <em className={v == null ? '' : v >= 0 ? 'pos' : 'neg'}>{v == null ? '—' : num(v, 0, true)}</em>
                  <small>{w.label}</small>
                </span>
              );
            })}
          </div>
          <div className="rs-tag-syms">{(t.symbols || []).join(' · ')}</div>
        </div>
      ))}
    </div>
  );
}
