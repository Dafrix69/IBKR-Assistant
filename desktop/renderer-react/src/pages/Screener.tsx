import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, InputNumber, Segmented, Select, Table, Tag, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { LeftOutlined, RightOutlined } from '@ant-design/icons';
import { dafri, errorMessage } from '../bridge';
import { CanvasChart, type ChartSpec } from '../lib/Chart';
import { fmtTimeShort } from '../lib/format';
import { showBanner } from '../store/banner';
import { loadSectors, useSectors } from '../store/sectors';
import { EmptyState, Meta, PageHead, Primer, SectionTitle, StatTile, StatusCard, Working } from '../ui/kit';

// 扫描:一个股票池、一次扫描、一张表——每只股一行,RS 强度与各周期的 CD 背离并排;点哪一行,下面就是它的极值偏离。
// 原来是三个子页(RS 强度 / 拐点筛选 / 极值偏离):同一个池子要选三遍、扫两遍,两张表的行还是同一批股。
// 数字全由引擎纯函数算(screener.ts,黄金对拍);这里只管选项、合并与展示。

const TF_LABEL: Record<string, string> = { '1w': '周线', '1d': '日线', '1h': '1 小时', '30m': '30 分', '15m': '15 分' };
const TF_OPTIONS = Object.entries(TF_LABEL).map(([value, label]) => ({ value, label }));
const SECTOR_KEY = 'dafri-screener-sector';

function num(v: unknown, digits = 2, sign = false): string {
  if (v == null || Number.isNaN(Number(v))) return '—';
  const n = Number(v);
  const text = n.toFixed(digits);
  return sign && n > 0 ? `+${text}` : text;
}

function heat(v: number): string {
  return String(Math.min(40, Math.abs(v) * 1.6).toFixed(0));
}

/** RS 单元格:正绿负红,越大底色越深(--heat 由 styles.css 折成透明度) */
function rsCellProps(value: number | null | undefined) {
  if (value == null) return { className: 'rs-cell dim' };
  return { className: `rs-cell ${value >= 0 ? 'pos' : 'neg'}`, style: { ['--heat' as string]: heat(value) } };
}

interface PoolStock {
  symbol: string;
  company?: string;
}

export function ScreenerPage() {
  const sectors = useSectors();
  const [sector, setSector] = useState(() => {
    try {
      return localStorage.getItem(SECTOR_KEY) || 'all';
    } catch {
      return 'all';
    }
  });
  const [sort, setSort] = useState<SortState | null>(null);
  const detailRef = useRef<HTMLElement>(null);

  // 进页时重读板块(板块页刚加的股要立刻可选)
  useEffect(() => {
    void loadSectors();
  }, []);

  const sectorValue = sectors.some((s) => s.id === sector) ? sector : 'all';
  function pickSectorPool(id: string) {
    setSector(id);
    try {
      localStorage.setItem(SECTOR_KEY, id);
    } catch {
      /* 记不住就算了 */
    }
  }
  const sectorOptions = [
    { value: 'all', label: '全部板块' },
    ...sectors.map((s) => ({ value: s.id, label: `${s.name}(${s.stocks.length})` })),
  ];

  const dev = useDeviation();
  const scan = useScan(sectorValue, dev.reviewIfUntouched);

  const rows = useMemo(() => mergeRows(scan.rs, scan.infl), [scan.rs, scan.infl]);
  const sorted = useMemo(() => sortRows(rows, sort), [rows, sort]);

  // 股票池:选中的板块(或全部)的成分股去重
  const pool = useMemo(() => {
    const chosen = sectorValue === 'all' ? sectors : sectors.filter((s) => s.id === sectorValue);
    const seen = new Set<string>();
    const out: PoolStock[] = [];
    for (const s of chosen) {
      for (const stock of s.stocks) {
        if (stock.symbol && !seen.has(stock.symbol)) {
          seen.add(stock.symbol);
          out.push(stock);
        }
      }
    }
    return out;
  }, [sectors, sectorValue]);
  // 逐只翻看的顺序:扫过就跟着表走(表头排过序也跟),没扫过按股票池里的顺序
  const order = useMemo(() => (sorted.length ? sorted.map((r) => r.symbol) : pool.map((s) => s.symbol)), [sorted, pool]);

  function drill(symbol: string) {
    void dev.review(symbol);
    // 复盘在表的下面,不滚过去的话点了像没反应
    detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const tfs = TF_OPTIONS.map((o) => o.value).filter((tf) => scan.timeframes.includes(tf));

  return (
    <section className="tab-panel active" id="page-screener">
      <PageHead title="扫描" />
      <div className="sub-head">{scan.busy ? <Working>{scan.progress}</Working> : <span className="muted">{scan.summary}</span>}</div>
      <div className="row tight scan-bar">
        <Select className="grow" value={sectorValue} options={sectorOptions} onChange={pickSectorPool} aria-label="股票池" />
        <Tooltip title="RS 强度的基准">
          <Segmented size="small" options={['SPY', 'QQQ']} value={scan.benchmark} onChange={(v) => scan.setBenchmark(v as 'SPY' | 'QQQ')} />
        </Tooltip>
        <Tooltip title="找 CD 背离的 K 线周期,可多选;一个都不选就只算 RS">
          <span className="tf-picks" role="group" aria-label="找背离的 K 线周期(可多选)">
            {TF_OPTIONS.map((o) => (
              <Tag.CheckableTag
                key={o.value}
                checked={tfs.includes(o.value)}
                onChange={(on) => scan.setTimeframes((prev) => (on ? [...prev, o.value] : prev.filter((t) => t !== o.value)))}
              >
                {o.label}
              </Tag.CheckableTag>
            ))}
          </span>
        </Tooltip>
        <Tooltip title="背离的右侧确认均线周期,0 = 不要求确认">
          <InputNumber className="narrow" min={0} max={250} step={1} value={scan.ma} onChange={(v) => scan.setMa(v == null ? null : Number(v))} aria-label="右侧确认均线周期(0 = 不要求)" />
        </Tooltip>
        <Button type="primary" id="btn-scan-run" loading={scan.busy} onClick={() => void scan.run()}>
          扫描
        </Button>
      </div>
      <Primer id="intro-scan" intro summary="这一页的数字怎么算">
        <ul className="hint-list">
          <li>
            <b>RS 强度</b>:每个区间(1 周 / 1 月 / 1 季 / 半年 / 1 年,按交易日)算成员收益与基准收益,
            <b>RS = (1 + 成员收益) ÷ (1 + 基准收益) − 1</b>,就是"跑赢基准多少"。综合分是各区间 RS 的平均;
            按成分股的<b>业务标签</b>汇总时取中位数(抗一只妖股),并数跑赢家数。标签在「板块」页的成分股行上点击即可改。
            日线来自券商,10 分钟内重复扫描不重新拉取。
          </li>
          <li>
            <b>拐点(CD 背离)</b>:CD 指 MACD 快线 DIF(EMA12 − EMA26)。价格创更低的低点、DIF 却抬高 = 底背离;
            价格创新高、DIF 却走低 = 顶背离;经典口径要求两个点的 DIF 在零轴同一侧。这是<b>左侧</b>信号——拐点还没确认,
            所以可选<b>右侧均线确认</b>:背离之后收盘穿过指定均线且仍站在那一侧才算「已确认」,穿过又回去算「作废」。
            周线由日线重采样;日内周期走行情页 K 线的节流缓存,一次最多 40 个(标的 × 周期)。
          </li>
          <li>
            <b>极值偏离</b>(点表里的一行):<b>修正版买卖压力</b>是收盘在当根<b>真实区间</b>(把前收盘算进高低点,跳空也量得出)里的位置,
            折成 −1 … +1,按相对成交量加权(当根量 ÷ 前 20 根均量,封顶 3 倍),再做 5 根 EMA 平滑。
            <b>偏离程度</b>是收盘相对均线的百分比,对近段历史折 <b>z 分数</b>——同样偏离 8%,对日常波动 1% 的股是极值,
            对波动 5% 的不算;|z| ≥ 2 标为极值。只陈述数字,不给操作建议。
          </li>
        </ul>
      </Primer>
      {rows.length ? (
        <>
          {scan.rs ? <TagCards result={scan.rs} /> : null}
          <ScanTable rs={scan.rs} infl={scan.infl} rows={sorted} sort={sort} onSort={setSort} picked={dev.symbol} onSymbol={drill} />
          <Meta
            items={[
              scan.rs ? 'RS = (1 + 成员收益) ÷ (1 + 基准收益) − 1,按各自日线算,基准按日期对齐' : null,
              scan.infl ? '背离 ≠ 反转,只是动能与价格不一致;右侧确认才是价格真的过了均线' : null,
              '仅供研究,不构成投资建议',
            ]}
          />
        </>
      ) : scan.busy ? null : (
        <EmptyState>选一个股票池,点「扫描」:每只股一行,RS 强度与各周期的背离并排。</EmptyState>
      )}
      <DeviationSection dev={dev} pool={pool} order={order} innerRef={detailRef} />
    </section>
  );
}

// ---- 一次扫描:先 RS 后背离 ------------------------------------------------

function useScan(sector: string, onFirstRow: (symbol: string) => void) {
  const [benchmark, setBenchmark] = useState<'SPY' | 'QQQ'>('SPY');
  const [timeframes, setTimeframes] = useState<string[]>(['1w', '1d']);
  const [ma, setMa] = useState<number | null>(20);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [rs, setRs] = useState<any>(null);
  const [infl, setInfl] = useState<any>(null);

  async function run() {
    if (busy) return;
    const tfs = TF_OPTIONS.map((o) => o.value).filter((tf) => timeframes.includes(tf));
    // 背离结果没回来之前,表里先把这几列占住(格子里是「…」),免得 RS 出来后表再跳一次宽度
    const pending = tfs.length ? { pending: true, timeframes: tfs, rows: [] } : null;
    setBusy(true);
    setProgress('正在拉日线算 RS…(一个 30 只的板块约 10~30 秒)');
    let first = '';
    let rsError = '';
    // 先 RS 后背离、不并发:两边要的是同一批日线,RS 拉完进了 10 分钟缓存,周线 / 日线的背离就不用再拉一遍
    try {
      const r = await dafri.screenerRs({ sector, benchmark });
      setRs(r);
      first = r.rows?.[0]?.symbol || '';
    } catch (err) {
      setRs(null);
      rsError = errorMessage(err);
    }
    setInfl(pending);
    if (first) onFirstRow(first);
    if (tfs.length) {
      setProgress(tfs.some((tf) => tf !== '1d' && tf !== '1w') ? '正在逐只拉 K 线找背离…日内周期受券商节流,可能要一两分钟' : '正在找背离…');
      try {
        const r = await dafri.screenerInflection({ sector, timeframes: tfs, ma_period: ma || null });
        setInfl(r);
        if (!first && r.rows?.[0]?.symbol) onFirstRow(r.rows[0].symbol);
        if (rsError) showBanner(`RS 强度没算出来:${rsError}`, false);
      } catch (err) {
        setInfl(null);
        const message = errorMessage(err);
        // 池子是空的、没连券商:两步是同一个原因,说一遍就够
        if (rsError && rsError !== message) showBanner(`RS 强度没算出来:${rsError}`, false);
        showBanner(rsError ? `扫描失败:${message}` : `背离没找成:${message}`, false);
      }
    } else if (rsError) {
      showBanner(`扫描失败:${rsError}`, false);
    }
    setProgress('');
    setBusy(false);
  }

  const summary = useMemo(() => {
    const bits: string[] = [];
    if (rs) bits.push(rs.sector, `对 ${rs.benchmark}(${num(rs.bench_last)})`, `${rs.counted}/${rs.total} 只有分`);
    if (infl && !infl.pending) {
      if (!rs) bits.push(infl.sector);
      bits.push(`${infl.hit_count}/${infl.total} 只有背离`);
    }
    const at = (infl && !infl.pending && infl.fetched_at) || rs?.fetched_at;
    if (at) bits.push(fmtTimeShort(at));
    return bits.join(' · ') || '—';
  }, [rs, infl]);

  return { benchmark, setBenchmark, timeframes, setTimeframes, ma, setMa, busy, progress, rs, infl, summary, run };
}

// ---- 合并的表 --------------------------------------------------------------

interface ScanRow {
  symbol: string;
  tag: string;
  last: number | null;
  error: string | null;
  rank: number | null;
  score: number | null;
  rs: Record<string, any>;
  /** 拐点筛选里这只股的那一行;没扫背离(或还没回来)就没有 */
  infl?: any;
}

interface SortState {
  key: string;
  order: 'ascend' | 'descend';
}

/** RS 的行打底(引擎已按综合分排好),背离按标的并进来;只有背离那边有的股接在后面。 */
function mergeRows(rs: any, infl: any): ScanRow[] {
  const bySymbol = new Map<string, ScanRow>();
  for (const r of rs?.rows || []) bySymbol.set(r.symbol, { ...r });
  for (const r of infl?.rows || []) {
    const base = bySymbol.get(r.symbol);
    if (base) base.infl = r;
    else bySymbol.set(r.symbol, { symbol: r.symbol, tag: r.tag, last: null, error: null, rank: null, score: null, rs: {}, infl: r });
  }
  return [...bySymbol.values()];
}

function sortValue(row: ScanRow, key: string): number | null {
  if (key === 'score') return row.score;
  // 命中相同的,已确认的排前面(和引擎原来给拐点表排的顺序一致)
  if (key === 'hits') return row.infl ? row.infl.hits * 100 + (row.infl.confirmed || 0) : null;
  const cell = row.rs?.[key.slice(1)];
  return cell ? cell.rs_pct : null;
}

/** 没数的行不管升序降序都沉底;排序是稳定的,并列的保持综合分的先后。 */
function sortRows(rows: ScanRow[], sort: SortState | null): ScanRow[] {
  if (!sort) return rows;
  const dir = sort.order === 'ascend' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = sortValue(a, sort.key);
    const vb = sortValue(b, sort.key);
    if (va == null || vb == null) return va == null ? (vb == null ? 0 : 1) : -1;
    return (va - vb) * dir;
  });
}

const CONFIRM_LABEL: Record<string, string> = { confirmed: '已确认', waiting: '等确认', failed: '作废', 'n/a': '无均线' };

function SignalCell({ sig, pending }: { sig: any; pending?: boolean }) {
  if (pending) return <span className="sig none">…</span>;
  if (!sig) return <span className="sig none">—</span>;
  if (sig.error) {
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

function ScanTable({
  rs,
  infl,
  rows,
  sort,
  onSort,
  picked,
  onSymbol,
}: {
  rs: any;
  infl: any;
  rows: ScanRow[];
  sort: SortState | null;
  onSort: (s: SortState | null) => void;
  picked: string;
  onSymbol: (symbol: string) => void;
}) {
  const columns = useMemo<ColumnsType<ScanRow>>(() => {
    const windows: { n: number; label: string }[] = rs?.windows || [];
    const tfs: string[] = infl?.timeframes || [];
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
        const c = infl.per_timeframe?.[tf];
        return {
          title: (
            <span title={c ? `底背离 ${c.bull} 只 · 顶背离 ${c.bear} 只${infl.ma_period ? ` · 已过 MA${infl.ma_period} 确认 ${c.confirmed} 只` : ''}` : undefined}>
              {TF_LABEL[tf] || tf}
              {c ? <span className="th-sub">{`底 ${c.bull} · 顶 ${c.bear}`}</span> : null}
            </span>
          ),
          key: tf,
          className: 'text',
          render: (_: unknown, row: ScanRow) => <SignalCell sig={row.infl?.signals?.[tf]} pending={infl.pending} />,
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
function TagCards({ result }: { result: any }) {
  const tags: any[] = result.tags || [];
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

// ---- 单只:极值偏离 --------------------------------------------------------

function useDeviation() {
  const [symbol, setSymbol] = useState('');
  const [free, setFree] = useState('');
  const [timeframe, setTimeframe] = useState('1d');
  const [period, setPeriod] = useState<number | null>(20);
  const [lookback, setLookback] = useState<number | null>(120);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [status, setStatus] = useState('');
  // 连着点几行时只认最后一次:前面的回包到了也不落地
  const seq = useRef(0);
  // 扫描要跑几十秒,它收尾时调进来的 review 是几十秒前那次渲染的;参数从这里读才是现在的
  const latest = useRef({ free, timeframe, period, lookback });
  latest.current = { free, timeframe, period, lookback };

  async function review(target: string) {
    const chosen = target.trim().toUpperCase();
    if (!chosen) {
      showBanner('先选或手输一个标的', true);
      return;
    }
    const now = latest.current;
    const mine = ++seq.current;
    if (chosen !== now.free.trim().toUpperCase()) setFree('');
    setSymbol(chosen);
    setBusy(true);
    setStatus(`正在拉 ${chosen} 的 K 线…`);
    try {
      const r = await dafri.screenerDeviation({ symbol: chosen, timeframe: now.timeframe, period: now.period || 20, lookback: now.lookback || 120 });
      if (mine !== seq.current) return;
      setResult(r);
      setStatus(`${TF_LABEL[r.timeframe] || r.timeframe} · ${r.bars} 根 · ${fmtTimeShort(r.fetched_at)}`);
    } catch (err) {
      if (mine !== seq.current) return;
      // 上一只的数字不能留在新选的这只名下
      setResult(null);
      setStatus('');
      showBanner(`极值偏离失败:${errorMessage(err)}`, false);
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  }

  /** 扫描出结果后顺手复盘榜首那只;人已经自己点过就不抢 */
  function reviewIfUntouched(target: string) {
    if (seq.current === 0) void review(target);
  }

  return { symbol, free, setFree, timeframe, setTimeframe, period, setPeriod, lookback, setLookback, busy, result, status, review, reviewIfUntouched };
}

function DeviationSection({ dev, pool, order, innerRef }: { dev: ReturnType<typeof useDeviation>; pool: PoolStock[]; order: string[]; innerRef: React.Ref<HTMLElement> }) {
  const { result } = dev;
  const current = dev.symbol || order[0] || '';
  const idx = order.indexOf(current);
  const pos = order.length && idx >= 0 ? `第 ${idx + 1} / ${order.length} 只` : '';

  function step(delta: number) {
    if (!order.length) return;
    const i = idx < 0 ? 0 : (idx + delta + order.length) % order.length;
    void dev.review(order[i] || '');
  }

  const charts = useMemo((): { dev: ChartSpec; pressure: ChartSpec } | null => {
    if (!result?.last) return null;
    const times = result.series.map((s: any) => s.time);
    // 翻到下一只或改了参数,两张图重新铺满;不写的话标题和第一根日期都一样,会沿用上一只的缩放
    const viewKey = `${result.symbol}|${result.timeframe}|${result.period}|${result.lookback}`;
    return {
      dev: {
        ariaLabel: '偏离 z 分数',
        viewKey,
        times,
        lines: [{ values: result.series.map((s: any) => s.z), color: 'blue', width: 1.5, label: 'z' }],
        hlines: [
          { price: 0, color: 'label', dash: [3, 3], alpha: 0.3, tag: false },
          { price: result.z_extreme, color: 'down', dash: [2, 3], alpha: 0.6, label: `+${result.z_extreme}σ 上方极值` },
          { price: -result.z_extreme, color: 'up', dash: [2, 3], alpha: 0.6, label: `−${result.z_extreme}σ 下方极值` },
        ],
        legend: [['—', 'blue', 'z 分数'], ['╌', 'down', '上方极值'], ['╌', 'up', '下方极值']],
        decimals: 2,
        volume: false,
      },
      pressure: {
        ariaLabel: '买卖压力',
        viewKey,
        times,
        lines: [
          { values: result.series.map((s: any) => s.pressure), color: 'orange', width: 1.5, label: '压力' },
          { values: result.series.map((s: any) => (s.buy_pct == null ? null : s.buy_pct / 50 - 1)), color: 'label2', alpha: 0.4, label: '单根原始' },
        ],
        hlines: [{ price: 0, color: 'label', dash: [3, 3], alpha: 0.3, tag: false }],
        legend: [['—', 'orange', '修正版压力'], ['—', 'label2', '单根原始位置']],
        decimals: 2,
        volume: false,
      },
    };
  }, [result]);

  const last = result?.last;
  const tone = result?.extreme === 'overbought' ? 'hot' : result?.extreme === 'oversold' ? 'cold' : '';
  const w = result?.window;

  return (
    <section className="scan-detail" id="panel-deviation" ref={innerRef}>
      <div className="scan-detail-head">
        <SectionTitle>
          极值偏离
          {result ? <span className="scan-detail-sym">{result.symbol}</span> : null}
        </SectionTitle>
        <span className="scan-detail-step">
          <span className="muted">{[dev.status, pos].filter(Boolean).join(' · ')}</span>
          <Button size="small" icon={<LeftOutlined />} aria-label="上一只" title="上一只" disabled={!order.length} onClick={() => step(-1)} />
          <Button size="small" icon={<RightOutlined />} aria-label="下一只" title="下一只" disabled={!order.length} onClick={() => step(1)} />
        </span>
      </div>
      <div className="row tight scan-bar">
        <Select
          className="grow"
          value={pool.some((s) => s.symbol === current) ? current : undefined}
          placeholder={dev.symbol || '标的'}
          options={pool.map((s) => ({ value: s.symbol, label: s.company ? `${s.symbol} · ${s.company}` : s.symbol }))}
          onChange={(v) => void dev.review(String(v))}
          aria-label="标的"
        />
        <Input
          className="narrow"
          placeholder="或手输"
          maxLength={12}
          value={dev.free}
          onChange={(e) => dev.setFree(e.target.value)}
          onPressEnter={() => void dev.review(dev.free || current)}
          aria-label="手输标的"
        />
        <Select value={dev.timeframe} options={TF_OPTIONS} onChange={dev.setTimeframe} aria-label="K 线周期" style={{ width: 100 }} />
        <Tooltip title="偏离用的均线周期">
          <InputNumber className="narrow" min={2} max={250} step={1} value={dev.period} onChange={(v) => dev.setPeriod(v == null ? null : Number(v))} aria-label="均线周期" />
        </Tooltip>
        <Tooltip title="折 z 分数用的历史根数">
          <InputNumber className="narrow" min={10} max={500} step={10} value={dev.lookback} onChange={(v) => dev.setLookback(v == null ? null : Number(v))} aria-label="z 分数历史长度" />
        </Tooltip>
        <Button id="btn-dev-run" loading={dev.busy} onClick={() => void dev.review(dev.free || current)}>
          复盘
        </Button>
      </div>
      {!result ? (
        dev.busy ? null : (
          <EmptyState>{order.length ? '点上面表里的一行,或在这里选一只、手输一个代码。' : '股票池是空的:先到「板块」页加成分股,或手输一个代码。'}</EmptyState>
        )
      ) : !last ? (
        <StatusCard tone="warn" title="数据不够">
          <div className="muted">{(result.readout || []).join(' ')}</div>
        </StatusCard>
      ) : (
        <div className="cards">
          <div className="stat-grid">
            <StatTile mono label={`偏离 MA${result.period}`} value={`${num(last.dev_pct, 2, true)}%`} tone={tone} />
            <StatTile mono label={`z 分数(近 ${result.lookback} 根)`} value={last.z == null ? '—' : num(last.z, 2, true)} tone={tone} />
            <StatTile mono label="历史分位" value={last.rank_pct == null ? '—' : `${num(last.rank_pct, 0)}%`} />
            <StatTile mono label="修正版买卖压力" value={num(last.pressure, 3, true)} tone={last.pressure > 0.3 ? 'cold' : last.pressure < -0.3 ? 'hot' : ''} />
            <StatTile mono label="收盘在真实区间" value={`${num(last.buy_pct, 0)}%`} />
            <StatTile mono label="相对量" value={last.volume_ratio == null ? '—' : `${num(last.volume_ratio, 2)}×`} />
          </div>
          <StatusCard tone={result.extreme ? 'warn' : 'ok'} title={result.extreme_label}>
            <ul className="dev-readout">
              {(result.readout || []).map((line: string, i: number) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          </StatusCard>
          {charts ? (
            <>
              <StatusCard title={`偏离程度(收盘相对 MA${result.period},z 分数)`}>
                <CanvasChart size="short" spec={charts.dev} />
              </StatusCard>
              <StatusCard title="修正版买卖压力(−1 全卖压 … +1 全买压,量加权 + 平滑)">
                <CanvasChart size="short" spec={charts.pressure} />
              </StatusCard>
            </>
          ) : null}
          {w ? (
            <Meta
              items={[
                `本段偏离 最大 ${num(w.dev_max.dev_pct, 2, true)}%(${w.dev_max.time}) · 最小 ${num(w.dev_min.dev_pct, 2, true)}%(${w.dev_min.time}) · ` +
                  `压力 最高 ${num(w.pressure_max.pressure, 2, true)}(${w.pressure_max.time}) · 最低 ${num(w.pressure_min.pressure, 2, true)}(${w.pressure_min.time})`,
              ]}
            />
          ) : null}
        </div>
      )}
    </section>
  );
}
