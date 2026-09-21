import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, InputNumber, Segmented, Select, Tag, Tooltip } from 'antd';
import { dafri, errorMessage } from '../bridge';
import type { RsResult } from '../bridge';
import { DeviationSection, useDeviation } from '../lib/DeviationSection';
import { fmtTimeShort } from '../lib/format';
import { ScanTable, TagCards } from '../lib/ScanTable';
import {
  isPending, mergeRows, num, sortRows, TF_OPTIONS,
  type InflState, type PoolStock, type SortState,
} from '../lib/screenerRows';
import { showBanner } from '../store/banner';
import { loadSectors, useSectors } from '../store/sectors';
import { EmptyState, Meta, PageHead, Primer, Working } from '../ui/kit';

// 扫描:一个股票池、一次扫描、一张表——每只股一行,RS 强度与各周期的 CD 背离并排;点哪一行,下面就是它的极值偏离。
// 原来是三个子页(RS 强度 / 拐点筛选 / 极值偏离):同一个池子要选三遍、扫两遍,两张表的行还是同一批股。
// 数字全由引擎纯函数算(screener.ts,黄金对拍);这里只管选项、合并与展示。

const SECTOR_KEY = 'dafri-screener-sector';




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
  const [rs, setRs] = useState<RsResult | null>(null);
  const [infl, setInfl] = useState<InflState>(null);

  async function run() {
    if (busy) return;
    const tfs = TF_OPTIONS.map((o) => o.value).filter((tf) => timeframes.includes(tf));
    // 背离结果没回来之前,表里先把这几列占住(格子里是「…」),免得 RS 出来后表再跳一次宽度
    const pending: InflState = tfs.length ? { pending: true, timeframes: tfs } : null;
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
    if (infl && !isPending(infl)) {
      if (!rs) bits.push(infl.sector);
      bits.push(`${infl.hit_count}/${infl.total} 只有背离`);
    }
    const at = (infl && !isPending(infl) && infl.fetched_at) || rs?.fetched_at;
    if (at) bits.push(fmtTimeShort(at));
    return bits.join(' · ') || '—';
  }, [rs, infl]);

  return { benchmark, setBenchmark, timeframes, setTimeframes, ma, setMa, busy, progress, rs, infl, summary, run };
}


