import { useEffect, useMemo, useState } from 'react';
import { Button, Input, InputNumber, Segmented, Select, Table, Tag, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { LeftOutlined, RightOutlined } from '@ant-design/icons';
import { dafri, errorMessage } from '../bridge';
import { CanvasChart } from '../lib/Chart';
import { fmtTimeShort } from '../lib/format';
import { showBanner } from '../store/banner';
import { setSubtab, useSubtab } from '../store/nav';
import { loadSectors, useSectors } from '../store/sectors';
import { EmptyState, Meta, PageHead, Primer, StatTile, StatusCard } from '../ui/kit';

// 扫描:RS 强度 / 拐点筛选 / 极值偏离。数字全由引擎纯函数算(screener.ts,黄金对拍);这里只管选项与展示。

const TF_LABEL: Record<string, string> = { '1w': '周线', '1d': '日线', '1h': '1 小时', '30m': '30 分', '15m': '15 分' };
const TF_OPTIONS = Object.entries(TF_LABEL).map(([value, label]) => ({ value, label }));
const SECTOR_KEY = 'dafri-screener-sector';
const SUBTABS = [
  { value: 'rs', label: 'RS 强度' },
  { value: 'inflection', label: '拐点筛选' },
  { value: 'deviation', label: '极值偏离' },
];

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

export function ScreenerPage() {
  const sub = useSubtab('screener', 'rs');
  const sectors = useSectors();
  const [sector, setSector] = useState(() => {
    try {
      return localStorage.getItem(SECTOR_KEY) || 'all';
    } catch {
      return 'all';
    }
  });
  // 极值偏离页"逐只翻看"的当前标的;RS / 拐点表里点标的会跳过来
  const [devSymbol, setDevSymbol] = useState('');

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
  function jumpToDeviation(symbol: string) {
    setDevSymbol(symbol);
    setSubtab('screener', 'deviation');
  }

  return (
    <section className="tab-panel active" id="page-screener">
      <PageHead title="扫描" extra={<Segmented options={SUBTABS} value={sub} onChange={(v) => setSubtab('screener', String(v))} />} />
      {sub === 'rs' ? <RsPanel sector={sectorValue} sectorOptions={sectorOptions} onSector={pickSectorPool} onSymbol={jumpToDeviation} /> : null}
      {sub === 'inflection' ? <InflectionPanel sector={sectorValue} sectorOptions={sectorOptions} onSector={pickSectorPool} onSymbol={jumpToDeviation} /> : null}
      {sub === 'deviation' ? (
        <DeviationPanel sector={sectorValue} sectorOptions={sectorOptions} onSector={pickSectorPool} symbol={devSymbol} onSymbol={setDevSymbol} />
      ) : null}
    </section>
  );
}

interface PoolProps {
  sector: string;
  sectorOptions: { value: string; label: string }[];
  onSector: (id: string) => void;
  onSymbol: (symbol: string) => void;
}

function SymbolLink({ symbol, onClick }: { symbol: string; onClick: (s: string) => void }) {
  return (
    <Tooltip title="到极值偏离页复盘这只">
      <Button type="link" size="small" className="sym-btn" onClick={() => onClick(symbol)}>
        {symbol}
      </Button>
    </Tooltip>
  );
}

// ---- RS 强度 ------------------------------------------------------------

function RsPanel({ sector, sectorOptions, onSector, onSymbol }: PoolProps) {
  const [benchmark, setBenchmark] = useState<'SPY' | 'QQQ'>('SPY');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [statusText, setStatusText] = useState('—');

  async function run() {
    if (busy) return;
    setBusy(true);
    setStatusText('正在拉日线并计算…(一个 30 只的板块约 10~30 秒)');
    try {
      const r = await dafri.screenerRs({ sector, benchmark });
      setResult(r);
      setStatusText(`${r.sector} · 对 ${r.benchmark}(${num(r.bench_last)}) · ${r.counted}/${r.total} 只有分 · ${fmtTimeShort(r.fetched_at)}`);
    } catch (err) {
      setStatusText('—');
      showBanner(`RS 扫描失败:${errorMessage(err)}`, false);
    } finally {
      setBusy(false);
    }
  }

  const columns = useMemo<ColumnsType<any>>(() => {
    if (!result) return [];
    const windows: { n: number; label: string }[] = result.windows || [];
    return [
      { title: '#', dataIndex: 'rank', width: 40, className: 'rank', render: (v: number | null) => (v == null ? '' : String(v)) },
      { title: '标的', dataIndex: 'symbol', width: 90, className: 'sym text', render: (s: string) => <SymbolLink symbol={s} onClick={onSymbol} /> },
      { title: '标签', dataIndex: 'tag', width: 90, className: 'text' },
      { title: '现价', dataIndex: 'last', width: 90, align: 'right', render: (v: number | null, row: any) => (row.error ? row.error : num(v)) },
      ...windows.map((w) => ({
        title: <span title={`${w.n} 个交易日`}>{`RS ${w.label}`}</span>,
        key: `w${w.n}`,
        align: 'right' as const,
        width: 92,
        render: (_: unknown, row: any) => {
          const cell = row.rs?.[String(w.n)];
          return cell ? `${num(cell.rs_pct, 1, true)}%` : '—';
        },
        onCell: (row: any) => {
          const cell = row.rs?.[String(w.n)];
          return { ...rsCellProps(cell ? cell.rs_pct : null), title: cell ? `自身 ${num(cell.ret_pct, 2, true)}% · 基准 ${num(cell.bench_pct, 2, true)}%` : undefined };
        },
      })),
      {
        title: '综合',
        dataIndex: 'score',
        width: 92,
        align: 'right',
        render: (v: number | null) => (v == null ? '—' : `${num(v, 1, true)}%`),
        onCell: (row: any) => rsCellProps(row.score),
      },
    ];
  }, [result, onSymbol]);

  const tags: any[] = result?.tags || [];
  const showTags = tags.length > 1 || (tags[0] && tags[0].tag !== '未分类');

  return (
    <section className="sub-panel active" id="panel-rs">
      <div className="sub-head">
        <span className="muted">{statusText}</span>
      </div>
      <div className="row tight">
        <Select className="grow" value={sector} options={sectorOptions} onChange={onSector} aria-label="股票池" />
        <Segmented size="small" options={['SPY', 'QQQ']} value={benchmark} onChange={(v) => setBenchmark(v as 'SPY' | 'QQQ')} />
        <Button type="primary" id="btn-rs-run" loading={busy} onClick={() => void run()}>
          扫描
        </Button>
      </div>
      <Primer id="intro-rs" intro summary="RS 是怎么算的">
        <p className="hint">
          每个区间(1 周 / 1 月 / 1 季 / 半年 / 1 年,按交易日)算成员收益与基准收益,
          <strong>RS = (1 + 成员收益) ÷ (1 + 基准收益) − 1</strong>,就是"跑赢基准多少"。综合分是各区间 RS 的平均;
          按成分股的<strong>业务标签</strong>汇总时取中位数(抗一只妖股),并数跑赢家数。
          标签在「板块」页的成分股行上点击即可改。日线来自券商,10 分钟内重复扫描不重新拉取。
        </p>
      </Primer>
      {result ? (
        showTags ? (
          <div className="rs-tags">
            {tags.map((t) => (
              <div className="rs-tag-card" key={t.tag}>
                <div className="rs-tag-head">
                  <span className="rs-tag-name">{`${t.tag} · ${t.count} 只`}</span>
                  <span className="rs-tag-score">{t.score == null ? '—' : `${num(t.score, 1, true)}%`}</span>
                </div>
                <div className="rs-tag-row">
                  {(result.windows || []).map((w: any) => {
                    const cell = t.rs?.[String(w.n)];
                    if (!cell) return <span key={w.n}>{`${w.label} —`}</span>;
                    return (
                      <span
                        key={w.n}
                        className={`rs-cell ${cell.median_pct >= 0 ? 'pos' : 'neg'}`}
                        style={{ ['--heat' as string]: heat(cell.median_pct) }}
                        title={`${w.label}:中位数 RS ${num(cell.median_pct, 2, true)}%,${cell.beats}/${cell.total} 只跑赢`}
                      >
                        {`${w.label} ${num(cell.median_pct, 0, true)}`}
                      </span>
                    );
                  })}
                </div>
                <div className="rs-tag-syms">{(t.symbols || []).join(' · ')}</div>
              </div>
            ))}
          </div>
        ) : (
          <p className="hint">成分股还没有业务标签,按标签汇总要先到「板块」页给股票加标签(AI 选股会自动给)。</p>
        )
      ) : null}
      {result ? (
        <>
          <Table
            className="screen-table"
            size="small"
            rowKey="symbol"
            columns={columns}
            dataSource={result.rows || []}
            pagination={false}
            scroll={{ y: 520 }}
            rowClassName={(row) => (row.score == null ? 'dim' : '')}
          />
          <Meta items={['RS = (1 + 成员收益) ÷ (1 + 基准收益) − 1,按各自日线算,基准按日期对齐;仅供研究,不构成投资建议']} />
        </>
      ) : (
        <EmptyState>选一个股票池,点「扫描」。</EmptyState>
      )}
    </section>
  );
}

// ---- 拐点筛选 ------------------------------------------------------------

const CONFIRM_LABEL: Record<string, string> = { confirmed: '已确认', waiting: '等确认', failed: '作废', 'n/a': '无均线' };

function SignalCell({ sig }: { sig: any }) {
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
  const bits = [`${sig.age} 根前`];
  if (sig.confirm) bits.push(`MA${sig.confirm.ma} ${CONFIRM_LABEL[sig.confirm.status] || sig.confirm.status}`);
  const [p1, p2] = sig.pivots || [];
  const title =
    p1 && p2
      ? `${p1.time} ${p1.price}(DIF ${p1.dif}) → ${p2.time} ${p2.price}(DIF ${p2.dif})\n价差 ${num(sig.price_gap_pct, 2, true)}%,DIF 差 ${num(sig.dif_gap, 4, true)}` +
        (sig.confirm && sig.confirm.at ? `\n均线穿越:${sig.confirm.at}` : '')
      : undefined;
  return (
    <>
      <span className={`sig ${sig.signal}`} title={title}>
        {sig.label}
        <span className="sub">{bits.join(' · ')}</span>
      </span>
      {p2 ? <span className="sig-detail">{`${p2.time} · DIF ${num(sig.dif_last, 3)}`}</span> : null}
    </>
  );
}

function InflectionPanel({ sector, sectorOptions, onSector, onSymbol }: PoolProps) {
  const [timeframes, setTimeframes] = useState<string[]>(['1w', '1d']);
  const [ma, setMa] = useState<number | null>(20);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [statusText, setStatusText] = useState('—');

  async function run() {
    if (busy) return;
    if (!timeframes.length) {
      showBanner('至少选一个 K 线周期', true);
      return;
    }
    setBusy(true);
    setStatusText(timeframes.some((tf) => tf !== '1d' && tf !== '1w') ? '正在逐只拉 K 线…日内周期受券商节流,可能要一两分钟' : '正在拉日线并计算…');
    try {
      const r = await dafri.screenerInflection({ sector, timeframes, ma_period: ma || null });
      setResult(r);
      const summary = (r.timeframes || [])
        .map((tf: string) => {
          const c = r.per_timeframe[tf];
          return `${TF_LABEL[tf] || tf} 底 ${c.bull} / 顶 ${c.bear}${r.ma_period ? ` / 确认 ${c.confirmed}` : ''}`;
        })
        .join(' · ');
      setStatusText(`${r.sector} · ${r.hit_count}/${r.total} 只有背离 · ${summary} · ${fmtTimeShort(r.fetched_at)}`);
    } catch (err) {
      setStatusText('—');
      showBanner(`拐点筛选失败:${errorMessage(err)}`, false);
    } finally {
      setBusy(false);
    }
  }

  const columns = useMemo<ColumnsType<any>>(() => {
    if (!result) return [];
    return [
      { title: '标的', dataIndex: 'symbol', width: 90, className: 'sym text', render: (s: string) => <SymbolLink symbol={s} onClick={onSymbol} /> },
      { title: '标签', dataIndex: 'tag', width: 90, className: 'text' },
      ...(result.timeframes || []).map((tf: string) => ({
        title: TF_LABEL[tf] || tf,
        key: tf,
        className: 'text',
        render: (_: unknown, row: any) => <SignalCell sig={row.signals?.[tf]} />,
      })),
      {
        title: '命中',
        dataIndex: 'hits',
        width: 80,
        align: 'right',
        render: (hits: number, row: any) => (hits ? `${hits}${row.confirmed ? ` (✓${row.confirmed})` : ''}` : ''),
      },
    ];
  }, [result, onSymbol]);

  return (
    <section className="sub-panel active" id="panel-inflection">
      <div className="sub-head">
        <span className="muted">{statusText}</span>
      </div>
      <div className="row tight">
        <Select className="grow" value={sector} options={sectorOptions} onChange={onSector} aria-label="股票池" />
        <span className="tf-picks" role="group" aria-label="K 线周期(可多选)">
          {TF_OPTIONS.map((o) => (
            <Tag.CheckableTag
              key={o.value}
              checked={timeframes.includes(o.value)}
              onChange={(on) => setTimeframes((tfs) => (on ? [...tfs, o.value] : tfs.filter((t) => t !== o.value)))}
            >
              {o.label}
            </Tag.CheckableTag>
          ))}
        </span>
        <Tooltip title="右侧确认均线周期,0 = 不要求确认">
          <InputNumber className="narrow" min={0} max={250} step={1} value={ma} onChange={(v) => setMa(v == null ? null : Number(v))} aria-label="右侧确认均线周期(0 = 不要求)" />
        </Tooltip>
        <Button type="primary" id="btn-infl-run" loading={busy} onClick={() => void run()}>
          扫描
        </Button>
      </div>
      <Primer id="intro-infl" intro summary="什么算拐点">
        <p className="hint">
          <strong>CD 背离</strong>:CD 指 MACD 快线 DIF(EMA12 − EMA26)。价格创更低的低点、DIF 却抬高 = 底背离;
          价格创新高、DIF 却走低 = 顶背离;经典口径要求两个点的 DIF 在零轴同一侧。这是<strong>左侧</strong>信号——
          拐点还没确认,所以可选<strong>右侧均线确认</strong>:背离之后收盘穿过指定均线且仍站在那一侧才算「已确认」,
          穿过又回去算「作废」。周线由日线重采样;日内周期走 K线 PA 的节流缓存,一次最多 40 个(标的 × 周期)。
        </p>
      </Primer>
      {result ? (
        <>
          <Table
            className="screen-table"
            size="small"
            rowKey="symbol"
            columns={columns}
            dataSource={result.rows || []}
            pagination={false}
            scroll={{ y: 520 }}
            rowClassName={(row) => (row.hits ? '' : 'dim')}
          />
          <Meta items={['左侧信号:背离 ≠ 反转,只是动能与价格不一致;右侧确认才是价格真的过了均线。仅供研究,不构成投资建议']} />
        </>
      ) : (
        <EmptyState>选一个股票池和周期,点「扫描」。</EmptyState>
      )}
    </section>
  );
}

// ---- 极值偏离 ------------------------------------------------------------

function DeviationPanel({ sector, sectorOptions, onSector, symbol, onSymbol }: Omit<PoolProps, 'onSymbol'> & { symbol: string; onSymbol: (s: string) => void }) {
  const sectors = useSectors();
  const [free, setFree] = useState('');
  const [timeframe, setTimeframe] = useState('1d');
  const [period, setPeriod] = useState<number | null>(20);
  const [lookback, setLookback] = useState<number | null>(120);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [statusText, setStatusText] = useState('—');

  // 股票池:选中的板块(或全部)的成分股去重
  const list = useMemo(() => {
    const chosen = sector === 'all' ? sectors : sectors.filter((s) => s.id === sector);
    const seen = new Set<string>();
    const out: { symbol: string; company?: string }[] = [];
    for (const s of chosen) {
      for (const stock of s.stocks) {
        if (stock.symbol && !seen.has(stock.symbol)) {
          seen.add(stock.symbol);
          out.push(stock);
        }
      }
    }
    return out;
  }, [sectors, sector]);
  const symbols = list.map((s) => s.symbol);
  const current = symbol || symbols[0] || '';
  const idx = symbols.indexOf(current);
  const pos = symbols.length
    ? idx >= 0
      ? `第 ${idx + 1} / ${symbols.length} 只 · 逐只翻看`
      : `${current || '—'}(手输,不在股票池里)`
    : '股票池是空的:先到「板块」页加成分股,或在右边手输标的';

  async function run(target?: string) {
    if (busy) return;
    const chosen = (target || free.trim().toUpperCase() || current).trim();
    if (!chosen) {
      showBanner('先选或手输一个标的', true);
      return;
    }
    onSymbol(chosen);
    setBusy(true);
    setStatusText(`正在拉 ${chosen} 的 K 线…`);
    try {
      const r = await dafri.screenerDeviation({ symbol: chosen, timeframe, period: period || 20, lookback: lookback || 120 });
      setResult(r);
      setStatusText(`${r.symbol} · ${TF_LABEL[r.timeframe] || r.timeframe} · ${r.bars} 根 · ${fmtTimeShort(r.fetched_at)}`);
    } catch (err) {
      setStatusText('—');
      showBanner(`极值偏离失败:${errorMessage(err)}`, false);
    } finally {
      setBusy(false);
    }
  }

  function step(delta: number) {
    if (!symbols.length) return;
    let i = symbols.indexOf(current);
    i = i < 0 ? 0 : (i + delta + symbols.length) % symbols.length;
    setFree('');
    void run(symbols[i]);
  }

  const charts = useMemo(() => {
    if (!result?.last) return null;
    const times = result.series.map((s: any) => s.time);
    return {
      dev: {
        ariaLabel: '偏离 z 分数',
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
    <section className="sub-panel active" id="panel-deviation">
      <div className="sub-head">
        <span className="muted">{statusText}</span>
      </div>
      <div className="row tight">
        <Select value={sector} options={sectorOptions} onChange={onSector} aria-label="股票池" style={{ minWidth: 150 }} />
        <Select
          value={idx >= 0 ? current : undefined}
          placeholder="标的"
          options={list.map((s) => ({ value: s.symbol, label: s.company ? `${s.symbol} · ${s.company}` : s.symbol }))}
          onChange={(v) => {
            setFree('');
            onSymbol(String(v));
          }}
          aria-label="标的"
          style={{ minWidth: 170 }}
        />
        <Input className="narrow" placeholder="或手输" maxLength={12} value={free} onChange={(e) => setFree(e.target.value)} onPressEnter={() => void run()} aria-label="手输标的" />
        <Select value={timeframe} options={TF_OPTIONS} onChange={setTimeframe} aria-label="K 线周期" style={{ width: 100 }} />
        <Tooltip title="偏离用的均线周期">
          <InputNumber className="narrow" min={2} max={250} step={1} value={period} onChange={(v) => setPeriod(v == null ? null : Number(v))} aria-label="均线周期" />
        </Tooltip>
        <Tooltip title="折 z 分数用的历史根数">
          <InputNumber className="narrow" min={10} max={500} step={10} value={lookback} onChange={(v) => setLookback(v == null ? null : Number(v))} aria-label="z 分数历史长度" />
        </Tooltip>
        <Button type="primary" id="btn-dev-run" loading={busy} onClick={() => void run()}>
          复盘
        </Button>
      </div>
      <div className="row tight">
        <Button size="small" icon={<LeftOutlined />} aria-label="上一只" title="上一只" onClick={() => step(-1)} />
        <Button size="small" icon={<RightOutlined />} aria-label="下一只" title="下一只" onClick={() => step(1)} />
        <span className="muted">{pos}</span>
      </div>
      <Primer id="intro-dev" intro summary="买卖压力与偏离怎么算">
        <p className="hint">
          <strong>修正版买卖压力</strong>:收盘在当根<strong>真实区间</strong>(把前收盘算进高低点,跳空也量得出)里的位置,
          折成 −1 … +1,按相对成交量加权(当根量 ÷ 前 20 根均量,封顶 3 倍),再做 5 根 EMA 平滑。
          <strong>偏离程度</strong>:收盘相对均线的百分比,对近段历史折 <strong>z 分数</strong>——同样偏离 8%,
          对日常波动 1% 的股是极值,对波动 5% 的不算;|z| ≥ 2 标为极值。只陈述数字,不给操作建议。
        </p>
      </Primer>
      {!result ? (
        <EmptyState>选一只股,点「复盘」。</EmptyState>
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
