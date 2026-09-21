import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, InputNumber, Segmented, Select } from 'antd';
import { dafri, errorMessage } from '../bridge';
import type { ReviewAnalyzeResult, ReviewCandidate, StockCandidate } from '../bridge';
import { fmtTimeShort } from '../lib/format';
import { FINAL_STATUS_LABEL, REVIEW_KIND } from '../lib/labels';
import { ReviewResult, StockResult } from '../lib/ReviewResult';
import { showBanner } from '../store/banner';
import { takeReviewRequest, useReviewRequest } from '../store/review';
import { EmptyState, Group, PageHead, Primer, StatusCard, SwitchRow, Working } from '../ui/kit';

// 交易分析:蝴蝶复盘(含止盈策略回放)与股票复盘。数字全来自引擎的 review.analyze;这里只负责摆。

const KIND_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'butterfly', label: '蝴蝶' },
  { value: 'stock', label: '股票' },
];
const TF_OPTIONS = [
  { value: 'auto', label: '自动周期' },
  { value: '1m', label: '1 分钟' },
  { value: '5m', label: '5 分钟' },
  { value: '15m', label: '15 分钟' },
  { value: '1h', label: '1 小时' },
  { value: '1d', label: '日线' },
];

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 同上 */
  }
}

/** 股票:一段持仓(从空仓到空仓)一行。没有建仓成交的(建仓早于已同步的成交)只写出场那一侧。 */
function stockLabel(c: StockCandidate): string {
  const when = fmtTimeShort(c.created_at);
  const long = c.side === 'LONG';
  const acct = c.account ? ` · ${c.account}` : '';
  const flag = c.opening_assumed ? ' · 期初持仓未核对' : '';
  if (c.carried && !c.entry_qty) {
    // 没连券商时"卖的是老仓位"是推断(卖出不读成卖空),照样标出来;连上之后按真实持仓重算
    const why = c.opening_assumed ? '按卖出更早买的货算' : '建仓早于已同步的成交';
    return `${when} · ${long ? '卖出' : '买回'} ${c.exit_qty} 股 ${c.symbol} @ ${c.avg_exit ?? '—'} · ${why}${acct} · IBKR 成交${flag}`;
  }
  const head = `${when} ${long ? '买' : '卖空'} ${c.qty} 股 ${c.symbol} @ ${c.avg_entry ?? '—'}`;
  if (c.status === 'closed') {
    const pnl = c.pnl == null ? '' : ` · 盈亏 ${c.pnl > 0 ? '+' : ''}${c.pnl}`;
    return `${head} → ${fmtTimeShort(c.closed_at)} 平 @ ${c.avg_exit ?? '—'}${pnl}${acct} · IBKR 成交${flag}`;
  }
  const trimmed = c.exit_qty ? ` · 已减 ${c.exit_qty} 股 @ ${c.avg_exit ?? '—'}` : '';
  return `${head}${trimmed}${acct} · IBKR 成交 · 持仓中 ${c.open_qty} 股${flag}`;
}

function candidateLabel(c: ReviewCandidate): string {
  if (c.kind === 'stock') return stockLabel(c);
  const when = fmtTimeShort(c.created_at);
  const strikes = (c.strikes || []).map((s: unknown) => String(s)).join('/');
  const state =
    c.source === 'ibkr' ? 'IBKR 成交' : c.filled ? '已成交' : c.final_status ? FINAL_STATUS_LABEL[c.final_status] || c.final_status : c.status || '本地 · 未成交';
  const price = c.price == null ? '' : ` @ ${c.price}${c.price_estimated ? '(限价)' : ''}`;
  const acct = c.account ? ` · ${c.account}` : '';
  if (c.exit) {
    const pnl = c.exit.pnl == null ? '' : ` · 盈亏 ${c.exit.pnl > 0 ? '+' : ''}${c.exit.pnl}`;
    return `${when} ${c.action === 'BUY' ? '买' : '卖'} @ ${c.price ?? '—'} → ${fmtTimeShort(c.exit.time)} 平 @ ${c.exit.price ?? '—'}${pnl} · ${c.qty} 张 ${c.symbol} ${strikes} ${c.right}蝴蝶 · 到期 ${c.expiry}${acct} · ${state}`;
  }
  return `${when} · ${c.action === 'BUY' ? '买' : '卖'} ${c.qty} ${c.symbol} ${strikes} ${c.right}蝴蝶 · 到期 ${c.expiry}${price}${acct} · ${state} · 未平仓 / 到期`;
}

export function ReviewPage() {
  const [candidates, setCandidates] = useState<any[]>([]);
  const [selected, setSelected] = useState(() => read('dafri-review-record') || '');
  const [timeframe, setTimeframe] = useState(() => read('dafri-review-timeframe') || 'auto');
  const [em, setEm] = useState<number | null>(() => Number(read('dafri-review-em')) || 36);
  const [includeLocal, setIncludeLocal] = useState(false);
  const [kind, setKind] = useState(() => read('dafri-review-kind') || 'all');
  const [freshness, setFreshness] = useState('—');
  const [available, setAvailable] = useState<boolean | null>(null);
  const [data, setData] = useState<ReviewAnalyzeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const requestSeq = useReviewRequest();

  /** keep:从交易记录跳过来时要保住的那一张,别被"选中第一条"的兜底顶掉。 */
  const loadCandidates = useCallback(async (local: boolean, keep?: string) => {
    try {
      const result = await dafri.reviewCandidates(200, local);
      const list: ReviewCandidate[] = result?.candidates || [];
      setCandidates(list);
      setAvailable(Boolean(result?.ibkr_available));
      const bits: string[] = [];
      if (result?.ibkr_available) bits.push(result.synced == null ? '已连 TWS' : `本次新增 ${result.synced} 笔成交`);
      else bits.push('未连 TWS,只看本地累积的成交');
      bits.push(`库内成交 ${result?.fills_stored ?? 0} 笔`);
      setFreshness((f) => (f === '—' || f.startsWith('已连') || f.startsWith('未连') || f.startsWith('本次') ? bits.join(' · ') : f));
      setSelected((s) => {
        const want = keep ?? s;
        return list.some((c) => c.id === want) ? want : list[0]?.id || '';
      });
      return list;
    } catch (err) {
      showBanner(`读取成交明细失败:${errorMessage(err)}`, false);
      return [];
    }
  }, []);

  const run = useCallback(
    async (id: string) => {
      if (!id) {
        showBanner('先选一笔交易', true);
        return;
      }
      write('dafri-review-record', id);
      write('dafri-review-timeframe', timeframe);
      write('dafri-review-em', String(em || 36));
      setLoading(true);
      try {
        const r = await dafri.reviewAnalyze({ id, timeframe, exit: { em: em || 36 } });
        setData(r);
        setError(null);
        setFreshness(`${r.timeframe_label} · ${r.series.bars.length} 根 · ${REVIEW_KIND[r.outcome.kind] || ''}`);
      } catch (err) {
        setData(null);
        setError(errorMessage(err));
      } finally {
        setLoading(false);
      }
    },
    [timeframe, em],
  );

  useEffect(() => {
    void loadCandidates(includeLocal);
  }, [includeLocal, loadCandidates]);

  // 从交易记录详情跳过来:选中那一张并直接分析。
  // 它可能是本地校验过、没在券商成交的那种——默认的候选列表里没有它,得把「附带本地未成交的记录」打开,
  // 否则下拉框会退回到第一条 IBKR 成交,而下面的图和结论却是点进来的那一张,两者对不上。
  useEffect(() => {
    if (!requestSeq) return;
    const id = takeReviewRequest();
    if (!id) return;
    setSelected(id);
    void (async () => {
      const list = await loadCandidates(includeLocal, id);
      if (!includeLocal && !list.some((c) => c.id === id)) {
        setIncludeLocal(true);
        await loadCandidates(true, id);
      }
      await run(id);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestSeq]);

  const shown = useMemo(() => (kind === 'all' ? candidates : candidates.filter((c) => (c.kind || 'butterfly') === kind)), [candidates, kind]);
  const selectedKind = candidates.find((c) => c.id === selected)?.kind || 'butterfly';
  // 换了筛选之后选中的那笔不在列表里了:退到列表第一笔,别让下拉框显示一个看不见的 id
  useEffect(() => {
    if (shown.length && !shown.some((c) => c.id === selected)) setSelected(shown[0].id);
  }, [shown, selected]);

  const what = kind === 'stock' ? '股票交易' : kind === 'butterfly' ? '蝴蝶' : '蝴蝶或股票交易';
  const emptyOption =
    available === null ? '加载中…' : available ? `今天的成交里没有${what}(TWS 只给当天的;更早的要在连着时同步过才有)` : '还没有同步到任何 IBKR 成交:先连接 TWS 再点「同步成交」';

  return (
    <section className="tab-panel active" id="page-review">
      <PageHead title="交易分析" extra={<span className="muted">{freshness}</span>} />
      <div className="row tight">
        <Segmented
          size="small"
          options={KIND_OPTIONS}
          value={kind}
          onChange={(v) => {
            setKind(String(v));
            write('dafri-review-kind', String(v));
          }}
          aria-label="交易类型"
        />
        <Select
          className="grow"
          value={shown.some((c) => c.id === selected) ? selected : undefined}
          placeholder={emptyOption}
          options={shown.map((c) => ({ value: c.id, label: candidateLabel(c) }))}
          onChange={(v) => {
            setSelected(v);
            write('dafri-review-record', v);
          }}
          aria-label="选择一笔交易"
        />
        <Select value={timeframe} options={TF_OPTIONS} onChange={setTimeframe} style={{ width: 110 }} aria-label="K 线周期" />
        <label className="row tight m0" title="当日 0DTE 隐含日内波动(点):策略文档要求每日从 ATM straddle 取,EM = straddle × 0.85;默认 36。只用于蝴蝶的止盈策略回放,股票用不到">
          <span className="muted">EM</span>
          <InputNumber min={1} max={500} step={0.5} value={em} disabled={selectedKind === 'stock'} onChange={(v) => setEm(v == null ? null : Number(v))} style={{ width: 72 }} aria-label="隐含日内波动 EM" />
        </label>
        <Button size="small" type="text" title="向 TWS 重新拉取成交明细并刷新列表" onClick={() => void loadCandidates(includeLocal)}>
          同步成交
        </Button>
        <Button type="primary" id="btn-review-run" loading={loading} onClick={() => void run(selected)}>
          分析
        </Button>
      </div>
      <Group>
        <SwitchRow label="附带本地未成交的记录" sub="默认只列 IBKR 真实成交过的蝴蝶;打开后把本地校验过但没成交的也列出来(按限价估算)" checked={includeLocal} onChange={setIncludeLocal} />
      </Group>
      <Primer id="intro-review" intro summary="数据来源、结论规则与止盈策略">
        <p className="hint">
          列表来自 <strong>IBKR 的成交明细</strong>:引擎从 TWS 拉取逐笔成交,按订单把三条腿合成一张蝴蝶,并存进本地库累积
          (TWS 的接口只给当天的成交,所以历史靠每次连着时同步来的那些)。<strong>股票</strong>按"从空仓到空仓"的一段持仓算一笔:中途加仓、分批卖出都在这一笔里,
          成本按移动平均;期初仓位用当前持仓反推,卖的是更早买的货就只复盘出场、不编成本。股票的结论看的是进场 / 出场落在持有期区间的什么位置、
          最大浮盈浮亏与兑现了多少、卖出之后又走了多远。<strong>蝴蝶</strong>选一张后拉取标的在<strong>开仓前后到平仓 / 到期</strong>的 K 线,
          画出三条行权价与盈利区,并按规则给出结论:开仓位置、开仓前后走势、持有期间离中心多远、曾经的机会、结局与方向对错。
          理论价值按<strong>到期内在价值</strong>算(是下界,不是当时能卖到的价)。平仓按同一张蝴蝶的反向成交认定,没有就按到期结算。
          K 线走 TWS 历史数据,需连接引擎。<strong>止盈策略</strong>按《SPX 0DTE 蝶式止盈策略 v2.0》回放:蝶价走势取 IBKR 组合分钟中间价,
          标出 1.35×D / 1.70×D 两档止盈、0.5×D 止损与预计盈利,SPX 图上标出 ±0.45W / ±0.55W / ±0.8W 临界线,并逐分钟回放策略会在哪里出手、与实际结果对比。
        </p>
      </Primer>
      <div id="review-result" className="cards">
        {loading ? (
          <Working>正在拉取 K 线并复盘…</Working>
        ) : error ? (
          <StatusCard tone="bad" title="分析失败">
            <div>{error}</div>
          </StatusCard>
        ) : !data ? (
          <EmptyState>选一笔交易后点「分析」。</EmptyState>
        ) : data.kind === 'stock' ? (
          <StockResult r={data} />
        ) : (
          <ReviewResult r={data} />
        )}
      </div>
    </section>
  );
}

