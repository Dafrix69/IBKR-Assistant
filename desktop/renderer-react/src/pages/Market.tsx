import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Descriptions, Input, Select, Space } from 'antd';
import { dafri, errorMessage } from '../bridge';
import type { BookLevel, BookSnapshot } from '../bridge';
import type { PaAnalyzeResult, PaComment, PaEvent, PaEvidence, PaLevel, PaPattern, PaSwing } from '../bridge';

/** 盘口墙上的一格:要么是引擎给的那份盘口,要么是这一次读取失败留下的一句话。 */
type BookCell = BookSnapshot | { error: string };
import { CanvasChart } from '../lib/Chart';
import { paSpec } from '../lib/chart/paSpec';
import { fmtMoney } from '../lib/format';
import { showBanner } from '../store/banner';
import { useStatus } from '../store/status';
import { EmptyState, Group, Meta, PageHead, Primer, SectionTitle, StatusCard, SwitchRow, Working, type Tone } from '../ui/kit';

// 行情:一页看一个标的——K 线 + 价格行为读盘(判断由引擎算、权重公开),图下面就是它的盘口(深度梯子,只读);
// 页面下半是「关注的盘口」,同时盯几个标的的价差与深度,点代码就把它换成上面正在看的那个。
// 原来是「K线 PA / 订单簿」两个子页、各填各的标的;看图的人下一眼要看的就是这只票的盘口,分两页等于同一个代码敲两遍。

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

export function MarketPage() {
  const books = useBooks();
  // 盘口墙上点了哪个代码:带序号,同一个代码连点两次也算两次
  const [pick, setPick] = useState<{ symbol: string; seq: number } | null>(null);
  return (
    <section className="tab-panel active" id="page-market">
      <PageHead title="行情" />
      <PaPanel books={books} pick={pick} />
      <BookWall books={books} onAnalyze={(symbol) => setPick((p) => ({ symbol, seq: (p?.seq || 0) + 1 }))} />
    </section>
  );
}

// ---- K线 PA -------------------------------------------------------------------
// 方向判断全部在引擎侧纯代码算完,这里只负责画;界面不做任何二次判断,免得图上写的和引擎算的对不上。

const PA_BIAS_KIND: Record<string, Tone> = { bullish: 'ok', lean_bull: 'ok', bearish: 'bad', lean_bear: 'bad', neutral: 'warn' };
const PA_SIDE_LABEL: Record<string, string> = { bull: '看涨', bear: '看跌', neutral: '中性' };

function paFreshness(r: PaAnalyzeResult): string {
  if (!r) return '—';
  const parts = [`最后一根 ${r.last_bar}`];
  if (r.age_seconds != null) {
    const mins = Math.round(r.age_seconds / 60);
    parts.push(mins < 1 ? '刚刚' : `${mins} 分钟前`);
  }
  parts.push(`${r.bar_count} 根`);
  if (!r.rth) parts.push('含盘前盘后');
  if (r.cached) parts.push('引擎缓存');
  return parts.join(' · ');
}

/** K 线图。每 20 秒的自动刷新走 update 而不是重建,用户缩放 / 平移到的位置不会被刷掉;主图开滚轮缩放。 */
function PaChart({ result }: { result: PaAnalyzeResult }) {
  const spec = useMemo(() => paSpec(result), [result]);
  return <CanvasChart className="pa-chart-wrap" spec={spec} wheel />;
}

/**
 * 引擎的 readout 是一组"字段:结论"的句子。九行散文扫不动;拆成两列,字段名进左列二级色。
 * 首句是总括,原样留着;拆不开的行也原样留着——界面不替引擎改写结论。
 */
function Readout({ lines }: { lines: string[] }) {
  const prose: string[] = [];
  const pairs: [string, string][] = [];
  lines.forEach((line, i) => {
    const m = /^([^:：]{1,12})[:：]\s*(.+)$/.exec(String(line));
    if (i === 0 || !m) prose.push(line);
    else pairs.push([m[1].trim(), m[2].trim()]);
  });
  return (
    <div className="pa-readout">
      {prose.map((p, i) => (
        <div className="reason" key={i}>
          {p}
        </div>
      ))}
      {pairs.length ? <Descriptions className="pa-readout-grid" size="small" column={1} colon={false} items={pairs.map(([k, v]) => ({ key: k, label: k, children: v }))} /> : null}
    </div>
  );
}

function PaPanel({ books, pick }: { books: Books; pick: { symbol: string; seq: number } | null }) {
  const status = useStatus();
  const connected = Boolean(status?.broker_connected);
  const [timeframes, setTimeframes] = useState<{ key: string; label: string }[]>([]);
  const [symbol, setSymbol] = useState(() => read('dafri-pa-symbol') || '');
  const [timeframe, setTimeframe] = useState(() => read('dafri-pa-timeframe') || '5m');
  const [rth, setRth] = useState(() => read('dafri-pa-rth') === '1');
  const [data, setData] = useState<PaAnalyzeResult | null>(null);
  // 模型的解读 + 是哪个模型给的(界面自己拼的一项)
  const [comment, setComment] = useState<(PaComment & { model: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [commenting, setCommenting] = useState(false);
  // 自动刷新只用已存下的参数,不读输入框——用户正在改标的时不该被打断
  const spec = useRef({ symbol: symbol, timeframe, rth });
  // 上一轮还没回来就跳过这一轮:引擎侧是串行的,叠加请求只会在管道里排队
  const inFlight = useRef(false);

  useEffect(() => {
    dafri
      .paTimeframes()
      .then((r) => setTimeframes(r?.timeframes || []))
      .catch((err) => showBanner(`K 线周期表读取失败:${errorMessage(err)}`, false));
  }, []);

  const fetchPa = useCallback(async (force: boolean) => {
    const s = spec.current;
    // 防重入放在这里而不是定时器的依赖里:放依赖里的话,每取一次数就要拆掉重建一次定时器,
    // 周期会漂成「20 秒 + 一次取数的时间」
    if (!s.symbol || inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const next = await dafri.paAnalyze({ ...s, force });
      // 换了标的或周期就丢掉上一次的 AI 解读,免得张冠李戴
      setData((prev) => {
        if (!prev || prev.symbol !== next.symbol || prev.timeframe !== next.timeframe) setComment(null);
        return next;
      });
      setError(null);
    } catch (err) {
      setData(null);
      setComment(null);
      setError(errorMessage(err));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  // 手动触发:先把输入同步进 spec,再走同一条取数路径
  async function run(next?: { symbol?: string; timeframe?: string; rth?: boolean }) {
    const sym = (next?.symbol ?? symbol).trim().toUpperCase();
    if (!sym) {
      showBanner('先填一个标的代码', true);
      return;
    }
    const tf = next?.timeframe ?? timeframe;
    const r = next?.rth ?? rth;
    setSymbol(sym);
    spec.current = { symbol: sym, timeframe: tf, rth: r };
    write('dafri-pa-symbol', sym);
    write('dafri-pa-timeframe', tf);
    write('dafri-pa-rth', r ? '1' : '0');
    setComment(null);
    await fetchPa(true);
  }

  // 已连网关时每 20 秒自动刷新
  useEffect(() => {
    const t = setInterval(() => {
      if (connected) void fetchPa(false);
    }, 20_000);
    return () => clearInterval(t);
  }, [connected, fetchPa]);

  // 盘口墙上点了代码:换成它来分析,并回到页面上方看图
  const runRef = useRef(run);
  runRef.current = run;
  const head = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!pick) return;
    void runRef.current({ symbol: pick.symbol });
    // 滚内容区而不是 scrollIntoView:页头是贴顶的,对齐到面板顶会把输入行压在页头底下
    const content = head.current?.closest('.content');
    if (content) content.scrollTop = 0;
  }, [pick]);

  // 图出来了就跟着读它的盘口;之后的 20 秒刷新由盘口那边的定时器一起带
  const shown = data?.symbol ? String(data.symbol) : '';
  const { focus } = books;
  useEffect(() => focus(shown), [focus, shown]);

  async function doComment() {
    if (!spec.current.symbol) return;
    setCommenting(true);
    try {
      const result = await dafri.paComment({ ...spec.current, force: false });
      setData(result.analysis);
      setComment({ ...result.comment, model: result.model });
    } catch (err) {
      showBanner(`AI 解读失败:${errorMessage(err)}`, false);
    } finally {
      setCommenting(false);
    }
  }

  const r = data;
  return (
    <section className="sub-panel active" id="panel-pa" ref={head}>
      <div className="sub-head">
        <span className="muted">{loading ? '读取中…' : data ? paFreshness(data) : ''}</span>
      </div>
      <div className="row tight">
        <Input id="pa-symbol" className="grow" placeholder="标的,如 NVDA、SPY、SPX" maxLength={12} value={symbol} onChange={(e) => setSymbol(e.target.value)} onPressEnter={() => void run()} />
        <Select
          value={timeframes.some((t) => t.key === timeframe) ? timeframe : undefined}
          options={timeframes.map((t) => ({ value: t.key, label: t.label }))}
          onChange={(v) => {
            setTimeframe(v);
            void run({ timeframe: v });
          }}
          style={{ width: 110 }}
          aria-label="K 线周期"
        />
        <Button type="primary" id="btn-pa-run" loading={loading} onClick={() => void run()}>
          分析
        </Button>
      </div>
      <Group>
        <SwitchRow
          label="只看正常交易时段"
          sub="默认含盘前盘后;打开只取 09:30–16:00"
          checked={rth}
          onChange={(v) => {
            setRth(v);
            void run({ rth: v });
          }}
        />
      </Group>
      <Primer id="intro-pa" intro summary="数据来源与判断方式">
        <p className="hint">
          K 线走 TWS 历史数据接口,需行情权限;仅延迟权限也能出图,最后一根约落后 15 分钟,
          新鲜度见标题右侧,超 30 分钟会告警。方向判断<strong>全部由规则计算</strong>,权重公开在「判断依据」里;
          「AI 解读」只叙述这些事实,不看图。图下面是同一标的的盘口,只读展示、不参与定价与下单,
          无 Level 2 订阅时只有一档;指数没有盘口,看对应 ETF。已连网关时 K 线与盘口每 20 秒自动刷新。
          <strong>仅供研究参考,不接下单链路。</strong>
        </p>
      </Primer>
      <div id="pa-result" className="cards">
        {error ? (
          <EmptyState>{error}</EmptyState>
        ) : !r ? (
          loading ? (
            <Working>正在取 K 线…</Working>
          ) : (
            <EmptyState>输入标的后点「分析」。</EmptyState>
          )
        ) : (
          <>
            <StatusCard tone={PA_BIAS_KIND[r.bias] || 'info'} title={`${r.symbol} ${r.timeframe_label} · ${r.bias_label}`}>
              <div className="row tight">
                <span className={`pa-score ${r.score > 0 ? 'up' : r.score < 0 ? 'down' : 'flat'}`}>{`${r.score > 0 ? '+' : ''}${r.score}`}</span>
                <span className="muted">{`打分区间 −100 ~ +100 · 置信度 ${r.confidence}`}</span>
              </div>
              <Readout lines={r.readout || []} />
            </StatusCard>
            <StatusCard title={`K 线(${r.timeframe_label})`}>{(r.bars || []).length ? <PaChart result={r} /> : null}</StatusCard>
            <StatusCard
              id="pa-book"
              title={`盘口 · ${shown}`}
              extra={
                <Space size={4}>
                  <Button size="small" loading={books.loading.has(shown)} onClick={() => void books.load(shown)}>
                    刷新
                  </Button>
                  {books.symbols.includes(shown) ? (
                    <span className="muted">已关注</span>
                  ) : (
                    <Button size="small" type="text" onClick={() => void books.add(shown)}>
                      加入关注
                    </Button>
                  )}
                </Space>
              }
            >
              <BookBody snapshot={books.data[shown]} loading={books.loading.has(shown)} />
            </StatusCard>
            <StatusCard title="判断依据(加权求和,正=看涨)">
              {(r.evidence || []).map((item: PaEvidence, i: number) => (
                <div className="pa-ev" key={i}>
                  <span className="pa-ev-label">{item.label}</span>
                  <span className="pa-ev-detail">{item.detail}</span>
                  <span className={`pa-ev-w ${item.weight > 0 ? 'up' : item.weight < 0 ? 'down' : 'flat'}`}>{`${item.weight > 0 ? '+' : ''}${item.weight}`}</span>
                </div>
              ))}
              <div className="reason">权重固定在引擎里,不随行情浮动;不认同某条,可从总分中减去再看结论。</div>
            </StatusCard>
            <StatusCard title={`结构:${r.trend_label}`}>
              {(r.swings || []).length ? <div className="reason">{`摆动序列(旧→新):${r.swings.map((s: PaSwing) => `${s.label}@${s.price}`).join(' → ')}`}</div> : null}
              {(r.events || []).slice(-3).map((ev: PaEvent, i: number) => (
                <div className="reason" key={i}>{`${ev.kind === 'CHoCH' ? '⚠ ' : ''}${ev.text}`}</div>
              ))}
              {(r.levels || []).map((level: PaLevel, i: number) => (
                <div className="pa-lv" key={i}>
                  <span className={`status ${level.side === 'resistance' ? 'rejected' : 'filled'}`}>{level.side === 'resistance' ? '阻力' : '支撑'}</span>
                  <span className="pa-lv-price">{String(level.price)}</span>
                  <span className="muted">{`${level.touches} 次触碰 · ${level.swings} 个摆动点 · 距现价 ${level.distance_pct > 0 ? '+' : ''}${level.distance_pct}%`}</span>
                </div>
              ))}
            </StatusCard>
            <FlowCard r={r} />
            <StatusCard tone="warn" title="关键价位">
              {r.plan?.confirm ? <div className="reason">{`确认条件:${r.plan.confirm}`}</div> : null}
              {r.plan?.invalidation?.why ? <div className="reason">{`失效条件:${r.plan.invalidation.why}`}</div> : null}
              {(r.plan?.watch || []).map((w: string, i: number) => (
                <div className="reason" key={i}>{`观察点:${w}`}</div>
              ))}
              {r.plan?.atr_note ? <div className="reason">{r.plan.atr_note}</div> : null}
              <Meta items={['以上只是价位与条件,不是建议;本页不接下单链路,仅供研究参考。']} />
            </StatusCard>
            {r.htf ? (
              <StatusCard tone={r.agreement?.state === 'aligned' ? 'ok' : r.agreement?.state === 'conflict' ? 'bad' : 'warn'} title={`高周期 ${r.htf.timeframe_label}:${r.htf.bias_label}`}>
                <div className="reason">{r.htf.trend_label}</div>
                {r.htf.last_event ? <div className="reason">{r.htf.last_event}</div> : null}
                <div className="reason">{`支撑 ${r.htf.support == null ? '该样本内无' : r.htf.support} / 阻力 ${r.htf.resistance == null ? '该样本内无' : r.htf.resistance}`}</div>
                {r.agreement?.text ? <div className="reason">{r.agreement.text}</div> : null}
              </StatusCard>
            ) : null}
            {(r.warnings || []).length ? (
              <StatusCard tone="bad" title="这次分析的局限">
                <ul>
                  {r.warnings.map((w: string, i: number) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </StatusCard>
            ) : null}
            <StatusCard
              title="AI 解读(可选)"
              extra={
                <Button size="small" loading={commenting} onClick={() => void doComment()}>
                  {commenting ? '解读中…' : comment ? '重新解读' : 'AI 解读'}
                </Button>
              }
            >
              <div className="reason">模型只拿到上面算好的事实,看不到原始 K 线;它只负责把事实串成叙述。</div>
              {comment ? (
                <>
                  <div className="card-title">{comment.summary}</div>
                  {comment.reading ? <div>{comment.reading}</div> : null}
                  {(comment.watch || []).length ? (
                    <>
                      <div className="reason">盯:</div>
                      <ul>
                        {comment.watch.map((line: string, i: number) => (
                          <li key={i}>{line}</li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                  {(comment.risks || []).length ? (
                    <>
                      <div className="reason">可能错在:</div>
                      <ul>
                        {comment.risks.map((line: string, i: number) => (
                          <li key={i}>{line}</li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                  <Meta items={[`模型 ${comment.model || '—'} · 仅供研究参考,不构成投资建议`]} />
                </>
              ) : null}
            </StatusCard>
          </>
        )}
      </div>
      <Primer id="pa-legend-primer" summary="图上画的是什么">
        <ul className="hint-list">
          <li>蜡烛按涨跌着色(可在「设置 → 涨跌配色」切换红涨绿跌);量能柱同色,按 95 分位归一化,开盘第一根巨量不会把其余压成一条线。</li>
          <li>MA5 / MA10 / MA20 是引擎算的收盘价简单均线,只作图,不进打分;左上角显示最后一根(或光标所在那根)的均线值。</li>
          <li>虚线是关键位:支撑用涨色、阻力用跌色;价格标签放在右侧价格轴上,挤在一起时会被推开并画引线回到真实价位。</li>
          <li>半透明色块是未回补的 FVG(缺口),灰色虚线框是订单块;它们从产生那根 K 线画到最后一根,不铺到轴上。</li>
          <li>点 + 小字是最近的摆动点(HH / HL / LH / LL);蓝色点线是现价。鼠标悬停显示十字光标与那一根的开高低收量。</li>
          <li>滚轮缩放、按住拖动平移,拖价格轴或时间轴也能缩放;双击轴复位。每 20 秒的自动刷新不会把缩放到的位置刷掉。</li>
        </ul>
      </Primer>
    </section>
  );
}

function FlowCard({ r }: { r: PaAnalyzeResult }) {
  const rows: string[] = [];
  for (const gap of r.fvgs || []) rows.push(`未回补 FVG(${PA_SIDE_LABEL[gap.side]})${gap.bottom} ~ ${gap.top},${gap.time} 留下,已回补 ${gap.filled_pct}%`);
  if (r.order_block) {
    const ob = r.order_block;
    rows.push(`订单块(${PA_SIDE_LABEL[ob.side]})${ob.bottom} ~ ${ob.top},${ob.time},${ob.mitigated ? '已被回踩' : '尚未回踩'}`);
  }
  for (const sweep of r.sweeps || []) rows.push(sweep.text);
  for (const eq of r.equal_levels || []) rows.push(eq.text);
  for (const p of (r.patterns || []).filter((p: PaPattern) => p.bars_ago <= 2)) rows.push(`${p.name}(${p.bars_ago} 根前):${p.note}`);
  return (
    <StatusCard title="流动性与形态">
      {rows.length ? rows.map((t, i) => <div className="reason" key={i}>{t}</div>) : <div className="reason">这一段没有留下未回补缺口、扫单或明显形态。</div>}
    </StatusCard>
  );
}


// ---- 盘口(只读展示)--------------------------------------------------------------
// 一份状态两处用:上面那张「盘口 · 标的」和下面的盘口墙读的是同一个快照表,同一个标的不会取两遍。

function readSymbols(): string[] {
  try {
    const raw = JSON.parse(read('dafri-book-symbols') || '[]');
    return Array.isArray(raw) ? raw.map(String) : [];
  } catch {
    return [];
  }
}

interface Books {
  symbols: string[];
  data: Record<string, any>;
  loading: Set<string>;
  load: (symbol: string) => Promise<void>;
  refreshAll: () => Promise<void>;
  add: (raw: string) => Promise<boolean>;
  remove: (symbol: string) => void;
  /** 上面正在看的标的:不在关注里也跟着一起刷新;传空串就是不看了 */
  focus: (symbol: string) => void;
}

function useBooks(): Books {
  const status = useStatus();
  const connected = Boolean(status?.broker_connected);
  const [symbols, setSymbols] = useState<string[]>(readSymbols);
  const [data, setData] = useState<Record<string, BookCell | undefined>>({});
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const symbolsRef = useRef(symbols);
  symbolsRef.current = symbols;
  const focused = useRef('');

  const load = useCallback(async (symbol: string) => {
    setLoading((s) => new Set(s).add(symbol));
    try {
      const snap = await dafri.orderBook(symbol);
      setData((d) => ({ ...d, [symbol]: snap }));
    } catch (err) {
      setData((d) => ({ ...d, [symbol]: { error: errorMessage(err) } }));
    } finally {
      setLoading((s) => {
        const n = new Set(s);
        n.delete(symbol);
        return n;
      });
    }
  }, []);

  // 逐个刷:十几个盘口同时压给引擎只会在读通道里排队;正在看的那个排最前
  const refreshAll = useCallback(async () => {
    const all = [focused.current, ...symbolsRef.current].filter(Boolean);
    for (const symbol of [...new Set(all)]) await load(symbol);
  }, [load]);

  // 已连 TWS 时每 20 秒自动刷新
  useEffect(() => {
    const t = setInterval(() => {
      if (connected) void refreshAll();
    }, 20_000);
    return () => clearInterval(t);
  }, [connected, refreshAll]);

  const focus = useCallback(
    (symbol: string) => {
      if (focused.current === symbol) return;
      focused.current = symbol;
      if (symbol) void load(symbol);
    },
    [load],
  );

  function persist(next: string[]) {
    setSymbols(next);
    write('dafri-book-symbols', JSON.stringify(next));
  }

  async function add(raw: string): Promise<boolean> {
    const symbol = raw.trim().toUpperCase();
    if (!symbol) return false;
    if (symbols.includes(symbol)) return true;
    if (symbols.length >= 12) {
      showBanner('盘口最多同时关注 12 个标的', true);
      return false;
    }
    persist([...symbols, symbol]);
    // 上面正在看的就是它:快照已经有了,不用再取一遍
    const cell = data[symbol];
    if (!cell || 'error' in cell) await load(symbol);
    return true;
  }

  function remove(symbol: string) {
    persist(symbols.filter((s) => s !== symbol));
    // 上面那张盘口还在用这份快照
    if (symbol === focused.current) return;
    setData((d) => {
      const n = { ...d };
      delete n[symbol];
      return n;
    });
  }

  return { symbols, data, loading, load, refreshAll, add, remove, focus };
}

function BookWall({ books, onAnalyze }: { books: Books; onAnalyze: (symbol: string) => void }) {
  const { symbols } = books;
  const [input, setInput] = useState('');

  async function add() {
    if (await books.add(input)) setInput('');
  }

  return (
    <section className="sub-panel active" id="panel-book">
      <SectionTitle count={symbols.length}>关注的盘口</SectionTitle>
      <div className="row tight">
        <Input id="book-symbol" className="grow" placeholder="再盯一个盘口,如 SPY、NVDA(指数请用对应 ETF)" maxLength={12} value={input} onChange={(e) => setInput(e.target.value)} onPressEnter={() => void add()} />
        <Button id="btn-book-load" onClick={() => void add()}>
          添加
        </Button>
        <Button type="text" disabled={!symbols.length} onClick={() => void books.refreshAll()}>
          全部刷新
        </Button>
      </div>
      <div className="sector-grid">
        {!symbols.length ? (
          <EmptyState>还没有关注的盘口。上面加一个,或在正在看的那张盘口上点「加入关注」。</EmptyState>
        ) : (
          symbols.map((symbol) => (
            <BookCard
              key={symbol}
              symbol={symbol}
              snapshot={books.data[symbol]}
              loading={books.loading.has(symbol)}
              onAnalyze={() => onAnalyze(symbol)}
              onRefresh={() => void books.load(symbol)}
              onRemove={() => books.remove(symbol)}
            />
          ))
        )}
      </div>
      {/* 还没关注任何标的时,读盘常识正是这一刻要看的东西;加了标的它就该让路 */}
      <Primer id="book-primer" summary="读盘常识" defaultOpen={!symbols.length}>
        <div className="cards">
          <StatusCard title="订单簿是什么">
            <div>
              未成交限价单按价格聚合:买单从高到低,卖单从低到高。买一与卖一之差是<strong>价差</strong>,各价位挂单量是<strong>深度</strong>。一档(L1)只看买一/卖一;Level 2 看多档,需单独订阅。
            </div>
          </StatusCard>
          <StatusCard title="怎么读">
            <div>价差窄、深度厚 = 流动性好、滑点小;价差宽、深度薄时大单会吃穿多档。某价位的异常大单可能是支撑/压力,也可能是随时撤掉的诱导单:挂单不等于成交。盘前盘后深度明显变薄。</div>
          </StatusCard>
          <StatusCard tone="warn" title="对本系统的意义">
            <div>
              AUTO_MID 按盘口中间价 ±滑点上限定价:价差 10 美分的票,上限 0.10 合理;价差 2 美元的期权组合则可能永远不成交。下条件单前先看价差,再定净权利金上限或滑点。期权盘口普遍比正股宽一个数量级。
            </div>
          </StatusCard>
        </div>
      </Primer>
    </section>
  );
}

function BookCard({ symbol, snapshot, loading, onAnalyze, onRefresh, onRemove }: { symbol: string; snapshot: any; loading: boolean; onAnalyze: () => void; onRefresh: () => void; onRemove: () => void }) {
  return (
    <Card
      size="small"
      className="sector-card"
      title={
        <button type="button" className="record-sym book-sym" title="看它的 K 线" onClick={onAnalyze}>
          {symbol}
        </button>
      }
      extra={
        <Space size={4}>
          <Button size="small" loading={loading} onClick={onRefresh}>
            {loading ? '读取中…' : '刷新'}
          </Button>
          <Button size="small" type="text" onClick={onRemove}>
            移除
          </Button>
        </Space>
      }
    >
      <BookBody snapshot={snapshot} loading={loading} />
    </Card>
  );
}

/** 一个标的的盘口:一档摘要 + 买卖各五档的深度梯子。上面的「盘口 · 标的」与盘口墙的卡片共用。
 *  形状在引擎契约里(engine-ts/src/contract/book.ts);读取失败时这一格存的是 { error },所以多带一个 error。 */
function BookBody({ snapshot, loading }: { snapshot: BookCell | null; loading: boolean }) {
  if (!snapshot) return <p className="muted">{loading ? '正在读取盘口…' : '点「刷新」读取盘口。'}</p>;
  if ('error' in snapshot) return <EmptyState compact>{snapshot.error}</EmptyState>;
  // l1 / liquidity 契约保证有(引擎那头两家适配层都是先摆好这两项再往里填),不再 `|| {}` 兜一层
  const l1 = snapshot.l1;
  const liq = snapshot.liquidity;
  const hasDepth = snapshot.bids.length || snapshot.asks.length;
  return (
    <>
      <Meta
        items={[
          l1.last != null ? `最新 ${fmtMoney(l1.last)}` : null,
          l1.spread != null ? `价差 ${l1.spread}(${l1.spread_bps} bps)` : null,
          liq.spread_grade ? `流动性 ${liq.spread_grade}` : null,
          liq.bid_depth != null ? `深度 买${liq.bid_depth} / 卖${liq.ask_depth}` : null,
          liq.imbalance_pct != null ? `失衡 ${liq.imbalance_pct >= 0 ? '买盘厚' : '卖盘厚'} ${Math.abs(liq.imbalance_pct)}%${liq.l1_only ? '(仅一档)' : ''}` : null,
        ]}
      />
      <div className="row tight book-l1">
        <span className="status filled">{`买一 ${l1.bid != null ? fmtMoney(l1.bid) : '—'}${l1.bid_size ? ` ×${l1.bid_size}` : ''}`}</span>
        <span className="status rejected">{`卖一 ${l1.ask != null ? fmtMoney(l1.ask) : '—'}${l1.ask_size ? ` ×${l1.ask_size}` : ''}`}</span>
      </div>
      {hasDepth ? (
        <div className="book-grid">
          <BookSide title="买盘" levels={(snapshot.bids || []).slice(0, 5)} side="bid" />
          <BookSide title="卖盘" levels={(snapshot.asks || []).slice(0, 5)} side="ask" />
        </div>
      ) : null}
      {snapshot.note ? <div className="stock-sub">{snapshot.note}</div> : null}
    </>
  );
}

function BookSide({ title, levels, side }: { title: string; levels: BookLevel[]; side: 'bid' | 'ask' }) {
  const maxSize = Math.max(...levels.map((l) => l.size), 1);
  return (
    <div>
      <div className="muted">{title}</div>
      {levels.map((level, i) => (
        <div className="book-row" key={i}>
          <div className={`book-bar ${side}`} style={{ width: `${Math.max((level.size / maxSize) * 100, 2)}%` }} />
          <span className="book-price">{fmtMoney(level.price)}</span>
          <span className="book-size">{String(level.size)}</span>
        </div>
      ))}
    </div>
  );
}
