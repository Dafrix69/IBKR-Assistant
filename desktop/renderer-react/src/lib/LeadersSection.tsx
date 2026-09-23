/**
 * 扫描页的「强势股筛选」一节:Minervini 趋势模板 8 条 + VCP + IBD 式 RS 评级,外加大盘方向(派发日)。
 * 数字与判断全是引擎 screener.leaders 算的(leaders.ts,离线规则、不调模型);这里只选范围、摆表。
 * 和上面那张 RS / 背离表用同一个股票池与基准;日线走同一条 10 分钟缓存,先扫过 RS 就不再拉。
 */
import { useMemo, useState } from 'react';
import { Button, Segmented, Table, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { dafri, errorMessage } from '../bridge';
import type { LeaderRow, LeadersResult, MarketRegime, TrendCheck, VcpResult } from '../bridge';
import { fmtTimeShort } from './format';
import { EmptyState, Meta, Notice, Primer, SectionTitle, Working, type Tone } from '../ui/kit';

type Filter = 'all' | 'stage2' | 'vcp';

const MARKET_TONE: Record<MarketRegime['state'], Tone> = { uptrend: 'ok', pressure: 'warn', correction: 'bad', unknown: 'info' };
const VCP_LABEL: Record<VcpResult['status'], string> = {
  breakout: '放量突破', weak_breakout: '突破量不足', near_pivot: '临近枢轴', forming: '收缩中', none: '—',
};

function signed(v: number | null | undefined, digits = 1): string {
  if (v == null) return '—';
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}`;
}

/** 8 个小点:过 / 没过 / 判断不了。悬停看每一条用到的数。 */
function Checks({ checks }: { checks: TrendCheck[] }) {
  if (!checks.length) return <span className="muted">—</span>;
  const tip = (
    <ul className="tt-tip">
      {checks.map((c) => (
        <li key={c.key}>
          {c.ok === true ? '✓' : c.ok === false ? '✗' : '?'} {c.label}:{c.detail}
        </li>
      ))}
    </ul>
  );
  return (
    <Tooltip title={tip} overlayClassName="tt-tooltip">
      <span className="tt-dots" aria-label={`趋势模板过了 ${checks.filter((c) => c.ok).length} 条`}>
        {checks.map((c) => (
          <i key={c.key} className={c.ok === true ? 'ok' : c.ok === false ? 'no' : 'na'} />
        ))}
      </span>
    </Tooltip>
  );
}

function VcpCell({ v }: { v: VcpResult }) {
  if (!v.found) return <span className="muted" title={v.reason}>{v.depths.length ? `不成形(${v.depths.join('→')}%)` : '—'}</span>;
  const title = [`回撤 ${v.depths.join(' → ')}%`, `枢轴 ${v.pivot}`, `离枢轴 ${signed(v.distance_pct, 2)}%`,
    v.volume_dryup == null ? '' : v.volume_dryup ? '最后一次收缩缩量' : '最后一次收缩没有缩量', v.reason].filter(Boolean).join('\n');
  return (
    <span title={title}>
      <span className={`sig ${v.status === 'breakout' || v.status === 'near_pivot' ? 'bull' : 'none'}`}>{VCP_LABEL[v.status]}</span>
      <span className="sig-detail">{`${v.depths.join('→')}% · 枢轴 ${v.pivot}`}</span>
    </span>
  );
}

function columns(onSymbol: (s: string) => void): ColumnsType<LeaderRow> {
  return [
    {
      title: '代码', key: 'symbol', className: 'sym',
      render: (_, r) => (
        <Button type="link" className="sym-btn" onClick={(e) => { e.stopPropagation(); onSymbol(r.symbol); }} title={r.company || r.tag}>
          {r.symbol}
        </Button>
      ),
    },
    { title: '趋势模板', key: 'tt', render: (_, r) => (r.error ? <span className="sig err" title={r.error}>拿不到</span> : <><Checks checks={r.checks} /> <span className="tt-count">{`${r.passed}/8`}</span></>) },
    { title: 'RS 评级', dataIndex: 'rs_rating', key: 'rs', align: 'right', render: (v: number | null) => v ?? '—' },
    { title: '比基准', dataIndex: 'rs_vs_bench', key: 'vs', align: 'right', render: (v: number | null) => (v == null ? '—' : <span className={v > 0 ? 'perf-num pos' : 'perf-num neg'}>{signed(v)}</span>) },
    { title: '离高点', dataIndex: 'pct_from_high', key: 'hi', align: 'right', render: (v: number | null) => (v == null ? '—' : `${v.toFixed(1)}%`) },
    { title: 'VCP', key: 'vcp', render: (_, r) => <VcpCell v={r.vcp} /> },
    { title: '量比', dataIndex: 'volume_ratio', key: 'vol', align: 'right', render: (v: number | null, r) => (v == null ? '—' : `${v.toFixed(2)}${r.new_high_volume ? ' · 放量新高' : ''}`) },
    { title: '结论', dataIndex: 'verdict', key: 'verdict', ellipsis: true },
  ];
}

export function LeadersSection({ sector, benchmark, onSymbol }: { sector: string; benchmark: 'SPY' | 'QQQ'; onSymbol: (symbol: string) => void }) {
  const [data, setData] = useState<LeadersResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  async function run() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setData(await dafri.screenerLeaders({ sector, benchmark }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const rows = useMemo(() => {
    const all = data?.rows || [];
    return filter === 'stage2' ? all.filter((r) => r.stage2) : filter === 'vcp' ? all.filter((r) => r.vcp.found) : all;
  }, [data, filter]);
  const cols = useMemo(() => columns(onSymbol), [onSymbol]);

  return (
    <section className="leaders">
      <SectionTitle>强势股筛选 · 趋势模板 + VCP</SectionTitle>
      <div className="row tight scan-bar">
        <Button type="primary" id="btn-leaders-run" loading={busy} onClick={() => void run()}>
          筛选强势股
        </Button>
        {data ? (
          <Segmented
            size="small"
            value={filter}
            onChange={(v) => setFilter(v as Filter)}
            options={[
              { label: `全部 ${data.total}`, value: 'all' },
              { label: `8 条全过 ${data.stage2_count}`, value: 'stage2' },
              { label: `有 VCP ${data.vcp_count}`, value: 'vcp' },
            ]}
          />
        ) : null}
        {data ? <span className="muted">{`${data.sector} · 对 ${data.benchmark} · ${fmtTimeShort(data.fetched_at)}`}</span> : null}
      </div>
      <Primer id="intro-leaders" intro summary="这些规则从哪来、怎么算">
        <ul className="hint-list">
          <li>
            <b>趋势模板</b>(Mark Minervini,美国投资锦标赛 1997、2021 冠军):价在 150 / 200 日线上、150 日线在 200 日线上、200 日线上行至少 1 个月、
            50 日线在两者之上、价在 50 日线上、比 52 周低点高 30% 以上、离 52 周高点 25% 以内、RS 评级 ≥ 70。<b>8 条全过才算第二阶段上升趋势</b>,一条不过就淘汰。
          </li>
          <li>
            <b>VCP 波动收缩</b>:从基底最高点起,每次回撤比上一次浅(例如 20% → 10% → 5%),最后一次缩量;放量(≥ 50 日均量 1.4 倍)越过枢轴——最后一次收缩开始时的高点——才是他的买点。
          </li>
          <li>
            <b>RS 评级</b>(William O'Neil / IBD,David Ryan 靠这套三连冠美国投资锦标赛):近 3 个月涨幅占 40%、前三个季度各 20%,在这次扫的池子里排百分位。池子越大越有意义。
          </li>
          <li>
            <b>大盘方向</b>(CAN SLIM 的 M):基准跌 ≥ 0.2% 且量比前一天大算一个派发日,25 个交易日内累积 4 个以上是承压、跌破 200 日线是调整。O'Neil:四只股票有三只跟着大盘走。
          </li>
          <li>只用券商日线;CAN SLIM 里要财报与机构持仓的 C / A / I 没算。只陈述规则过没过,不构成投资建议。</li>
        </ul>
      </Primer>
      {error ? <Notice tone="bad" title="强势股没筛成">{error}</Notice> : null}
      {busy && !data ? <Working>正在拉日线按趋势模板逐只检查…</Working> : null}
      {data ? (
        <>
          <Notice tone={MARKET_TONE[data.market.state]} title={`大盘:${data.market.label}`}>
            {data.market.text}
            {data.market.distribution_dates.length ? ` 派发日:${data.market.distribution_dates.join('、')}。` : ''}
          </Notice>
          {rows.length ? (
            <Table<LeaderRow>
              className="screen-table leaders-table"
              size="small"
              rowKey="symbol"
              columns={cols}
              dataSource={rows}
              pagination={false}
              scroll={{ x: 'max-content' }}
              rowClassName={() => 'scan-row'}
              onRow={(r) => ({ onClick: () => onSymbol(r.symbol) })}
            />
          ) : (
            <EmptyState compact>这个筛选下没有股票。</EmptyState>
          )}
          <Meta items={data.notes} />
        </>
      ) : null}
    </section>
  );
}
