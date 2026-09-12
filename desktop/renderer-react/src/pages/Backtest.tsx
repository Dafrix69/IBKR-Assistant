import { useEffect, useMemo, useState } from 'react';
import { Button, DatePicker, Input, InputNumber, List, Select, Space } from 'antd';
import dayjs from 'dayjs';
import { dafri, errorMessage } from '../bridge';
import { CanvasChart, type ChartSpec } from '../lib/Chart';
import type { SpecMarker } from '../lib/chart/spec';
import { fmtMoney } from '../lib/format';
import { showBanner } from '../store/banner';
import { Group, GroupRow, Meta, NumberRow, PageHead, SectionTitle, StatTile, StatusCard, Working } from '../ui/kit';

// 策略回测:纯计算展示,历史数据来自 TWS。含自定义条件搭建器与随表单实时生成的流程图。

interface Operand {
  kind: 'indicator' | 'const';
  name?: string;
  period?: number;
  value?: number;
}
interface Condition {
  left: Operand;
  op: string;
  right: Operand;
}
interface Rules {
  entry: Condition[];
  exit: Condition[];
}
interface Strategy {
  key: string;
  label: string;
  desc?: string;
  params?: Record<string, number>;
  param_labels?: Record<string, string>;
}

const BT_INDICATORS: [string, string][] = [
  ['close', '收盘价'], ['open', '开盘价'], ['high', '最高价'], ['low', '最低价'],
  ['sma', 'SMA均线'], ['ema', 'EMA均线'], ['rsi', 'RSI'],
  ['highest', '前N日最高'], ['lowest', '前N日最低'], ['change_pct', 'N日涨跌幅%'],
  ['const', '常数'],
];
const BT_NEEDS_PERIOD = new Set(['sma', 'ema', 'rsi', 'highest', 'lowest', 'change_pct']);
const BT_OPS: [string, string][] = [['>', '>'], ['<', '<'], ['>=', '≥'], ['<=', '≤'], ['cross_up', '上穿'], ['cross_down', '下穿']];
const BT_INST_LABELS: Record<string, string> = {
  stock: '正股', call: '买入看涨期权', put: '买入看跌期权',
  call_spread: '看涨借方价差', put_spread: '看跌借方价差', butterfly: '买入蝴蝶',
};
// 默认给一组 RSI 超卖示例,进页面就能看懂结构
const DEFAULT_RULES: Rules = {
  entry: [{ left: { kind: 'indicator', name: 'rsi', period: 14 }, op: '<', right: { kind: 'const', value: 30 } }],
  exit: [{ left: { kind: 'indicator', name: 'rsi', period: 14 }, op: '>', right: { kind: 'const', value: 70 } }],
};

function fmtOperand(o: Operand): string {
  return o.kind === 'const'
    ? String(o.value)
    : `${(BT_INDICATORS.find(([k]) => k === o.name) || [o.name, o.name])[1]}${o.period ? `(${o.period})` : ''}`;
}
function fmtCond(c: Condition): string {
  return `${fmtOperand(c.left)} ${(BT_OPS.find(([k]) => k === c.op) || [c.op, c.op])[1]} ${fmtOperand(c.right)}`;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function BacktestPage() {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [symbol, setSymbol] = useState('');
  const [start, setStart] = useState(() => isoDate(new Date(Date.now() - 365 * 86400e3)));
  const [end, setEnd] = useState(() => isoDate(new Date()));
  const [strategyKey, setStrategyKey] = useState<string>('');
  const [params, setParams] = useState<Record<string, number | null>>({});
  const [rules, setRules] = useState<Rules>(DEFAULT_RULES);
  const [instType, setInstType] = useState('stock');
  const [inst, setInst] = useState({ dte: 30 as number | null, offset: 0 as number | null, width: 2 as number | null, risk: 10 as number | null });
  const [result, setResult] = useState<any>(null);
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    dafri
      .backtestStrategies()
      .then(({ strategies: list }) => {
        setStrategies(list || []);
        if (list?.length) setStrategyKey((k) => k || list[0].key);
      })
      .catch((err) => showBanner(`读取策略目录失败:${errorMessage(err)}`, false));
  }, []);

  const strategy = strategies.find((s) => s.key === strategyKey) || null;
  // 换策略时把它的默认参数摆出来
  useEffect(() => {
    if (!strategy || strategy.key === 'custom') return;
    setParams(Object.fromEntries(Object.entries(strategy.params || {}).map(([k, v]) => [k, v])));
  }, [strategy]);

  const isOption = instType !== 'stock';

  async function run() {
    const sym = symbol.trim().toUpperCase();
    if (!sym || !start || !end) {
      showBanner('请填写标的与起止日期', true);
      return;
    }
    const spec: Record<string, unknown> = {
      symbol: sym,
      start,
      end,
      strategy: strategyKey,
      params: Object.fromEntries(Object.entries(params).filter(([, v]) => v !== null && v !== undefined)),
    };
    if (strategyKey === 'custom') spec.rules = rules;
    spec.instrument = !isOption
      ? { type: 'stock' }
      : { type: instType, dte: inst.dte || 30, offset_pct: inst.offset || 0, width_pct: inst.width || 2, risk_pct: inst.risk || 10 };
    setRunning(true);
    setFailure(null);
    try {
      setResult(await dafri.runBacktest(spec));
    } catch (err) {
      setResult(null);
      setFailure(errorMessage(err));
    } finally {
      setRunning(false);
    }
  }

  // ---- 流程图文案 ----
  const entryText = strategy?.key === 'custom' ? rules.entry.map(fmtCond).join(' 且 ') || '(未设置)' : strategy?.desc || '';
  const exitText = strategy?.key === 'custom' ? (rules.exit.length ? rules.exit.map(fmtCond).join(' 且 ') : null) : strategy?.key === 'buy_hold' ? null : '策略离场信号触发';
  const buyBody = isOption ? `${BT_INST_LABELS[instType]} · DTE ${inst.dte} · 偏移 ${inst.offset}% · 投入 ${inst.risk}% 净值` : '全仓买入正股(收盘价成交)';

  return (
    <section className="tab-panel active" id="page-backtest">
      <PageHead title="回测" extra={<span className="muted">日线 · 收盘成交 · 全仓进出</span>} />
      <Group hint={strategy?.desc}>
        <GroupRow label="标的">
          <Input id="bt-symbol" placeholder="如 NVDA、SPX" maxLength={12} value={symbol} onChange={(e) => setSymbol(e.target.value)} style={{ width: 190 }} />
        </GroupRow>
        <GroupRow label="区间" sub="日线,含首尾">
          {/* 日期用 AntD 的范围选择器:一个控件选起止,预设一年 / 半年 / 一季 */}
          <DatePicker.RangePicker
            allowClear={false}
            value={[dayjs(start), dayjs(end)]}
            maxDate={dayjs()}
            presets={[
              { label: '近一年', value: [dayjs().subtract(1, 'year'), dayjs()] },
              { label: '近半年', value: [dayjs().subtract(6, 'month'), dayjs()] },
              { label: '近一季', value: [dayjs().subtract(3, 'month'), dayjs()] },
              { label: '近三年', value: [dayjs().subtract(3, 'year'), dayjs()] },
            ]}
            onChange={(range) => {
              if (!range || !range[0] || !range[1]) return;
              setStart(range[0].format('YYYY-MM-DD'));
              setEnd(range[1].format('YYYY-MM-DD'));
            }}
            style={{ width: 300 }}
          />
        </GroupRow>
        <GroupRow label="策略">
          <Select value={strategyKey || undefined} options={strategies.map((s) => ({ value: s.key, label: s.label }))} onChange={setStrategyKey} style={{ width: 320, maxWidth: '100%' }} />
        </GroupRow>
        {strategy?.key === 'custom' ? (
          <GroupRow stacked>
            <RuleBuilder rules={rules} onChange={setRules} />
          </GroupRow>
        ) : null}
        {strategy && strategy.key !== 'custom'
          ? Object.entries(strategy.params || {}).map(([key]) => {
              const label = strategy.param_labels?.[key];
              // 认得出就用中文名,认不出退回原名——总比显示 "参数 buy_below" 强
              return <NumberRow key={key} label={label || key} sub={label ? key : undefined} value={params[key] ?? null} onChange={(v) => setParams((p) => ({ ...p, [key]: v }))} />;
            })
          : null}
        <GroupRow label="交易品种">
          <Select value={instType} options={Object.entries(BT_INST_LABELS).map(([value, label]) => ({ value, label }))} onChange={setInstType} style={{ width: 320, maxWidth: '100%' }} />
        </GroupRow>
        {isOption ? <NumberRow label="到期天数" sub="DTE" min={1} max={365} step={1} value={inst.dte} onChange={(v) => setInst((i) => ({ ...i, dte: v }))} /> : null}
        {isOption ? <NumberRow label="行权价偏移" sub="% 相对入场价" min={-30} max={30} step={0.5} value={inst.offset} onChange={(v) => setInst((i) => ({ ...i, offset: v }))} /> : null}
        {isOption ? <NumberRow label="宽度 / 翼宽" sub="% 相对入场价" min={0.5} max={20} step={0.5} value={inst.width} onChange={(v) => setInst((i) => ({ ...i, width: v }))} /> : null}
        {isOption ? <NumberRow label="单笔投入" sub="% 净值" min={1} max={100} step={1} value={inst.risk} onChange={(v) => setInst((i) => ({ ...i, risk: v }))} /> : null}
      </Group>
      {isOption ? (
        <p className="hint">
          期权按标的历史走势 + Black-Scholes 理论价模拟(近 20 日已实现波动率,r=0,无偏度与价差);
          信号出场按模型价,到期按内在价值结算,信号持续则续仓。仅用于比较相对优劣。
        </p>
      ) : null}

      <SectionTitle>策略流程</SectionTitle>
      {strategy ? (
        <div className="flow">
          <div className="flow-row">
            <FlowCard kind="start" title="开始" body="每根日线收盘评估" />
            <span className="flow-arrow">→</span>
            <FlowCard kind="cond" title="持仓是否为空?" body="持有数量 = 0?" />
            <span className="flow-arrow">—是→</span>
            <FlowCard kind="cond" title="入场条件是否满足?" body={entryText} />
            <span className="flow-arrow">—是→</span>
            <FlowCard kind="action" title="开仓" body={buyBody} />
          </div>
          <div className="flow-row">
            <span className="flow-arrow">　　　　└—否→</span>
            {exitText ? (
              <>
                <FlowCard kind="cond" title="出场条件是否满足?" body={exitText} />
                <span className="flow-arrow">—是→</span>
                <FlowCard kind="action" title="平仓" body={isOption ? '按模型价卖出;到期按内在价值结算' : '全仓卖出(收盘价成交)'} />
              </>
            ) : (
              <FlowCard kind="action" title="继续持有" body={isOption ? '持有至到期,按内在价值结算' : '持有到区间结束'} />
            )}
          </div>
        </div>
      ) : null}
      <div className="row tight">
        <Button type="primary" id="btn-bt-run" loading={running} onClick={() => void run()}>
          运行回测
        </Button>
        <span className="muted">数据来自 TWS,需先连接引擎 · 仅供研究参考</span>
      </div>
      <div id="bt-result">
        {running ? <Working>正在拉取历史数据并回测…</Working> : null}
        {failure ? (
          <StatusCard tone="bad" title="回测失败">
            <div>{failure}</div>
          </StatusCard>
        ) : null}
        {result && !running ? <BacktestResult r={result} strategyLabel={strategy?.label} /> : null}
      </div>
    </section>
  );
}

function FlowCard({ kind, title, body }: { kind: string; title: string; body?: string }) {
  return (
    <div className={`flow-card ${kind}`}>
      <div className="flow-title">{title}</div>
      {body ? <div className="flow-body">{body}</div> : null}
    </div>
  );
}

// ---- 自定义策略:图形化条件搭建器 + 文字生成 ----------------------------

function RuleBuilder({ rules, onChange }: { rules: Rules; onChange: (r: Rules) => void }) {
  const [text, setText] = useState('');
  const [generating, setGenerating] = useState(false);

  // 文字输入:自然语言 → 条件(由外接大模型转换,结构再过软件层校验)
  async function generate() {
    const t = text.trim();
    if (!t) return;
    setGenerating(true);
    try {
      const { rules: next } = await dafri.parseBacktestRules(t);
      onChange(next);
    } catch (err) {
      showBanner(`条件生成失败:${errorMessage(err)}`, false);
    } finally {
      setGenerating(false);
    }
  }

  const update = (kind: 'entry' | 'exit', list: Condition[]) => onChange({ ...rules, [kind]: list });

  return (
    <div className="rule-builder">
      <div className="row tight">
        <Input className="grow" placeholder="用文字描述,如:RSI跌破30且收盘价高于200日均线时买入,RSI回到70卖出" maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} onPressEnter={() => void generate()} />
        <Button size="small" type="primary" loading={generating} onClick={() => void generate()}>
          {generating ? '生成中…' : 'AI 生成条件'}
        </Button>
      </div>
      <RuleSection title="入场条件(全部满足才买入)" conditions={rules.entry} onChange={(l) => update('entry', l)} />
      <RuleSection title="出场条件(全部满足才卖出;留空 = 持有到区间结束)" conditions={rules.exit} onChange={(l) => update('exit', l)} />
    </div>
  );
}

function RuleSection({ title, conditions, onChange }: { title: string; conditions: Condition[]; onChange: (list: Condition[]) => void }) {
  const setAt = (i: number, cond: Condition) => onChange(conditions.map((c, k) => (k === i ? cond : c)));
  return (
    <div className="rule-group">
      <div className="muted">{title}</div>
      {conditions.map((cond, i) => (
        <Space size={6} wrap className="rule-row" key={i}>
          <OperandEditor operand={cond.left} onChange={(o) => setAt(i, { ...cond, left: o })} />
          <Select value={cond.op} options={BT_OPS.map(([value, label]) => ({ value, label }))} onChange={(op) => setAt(i, { ...cond, op })} style={{ width: 90 }} />
          <OperandEditor operand={cond.right} onChange={(o) => setAt(i, { ...cond, right: o })} />
          <Button size="small" type="text" onClick={() => onChange(conditions.filter((_, k) => k !== i))}>
            ✕
          </Button>
        </Space>
      ))}
      <Button size="small" onClick={() => onChange([...conditions, { left: { kind: 'indicator', name: 'close' }, op: '>', right: { kind: 'indicator', name: 'sma', period: 50 } }])}>
        + 添加条件
      </Button>
    </div>
  );
}

function OperandEditor({ operand, onChange }: { operand: Operand; onChange: (o: Operand) => void }) {
  const choice = operand.kind === 'const' ? 'const' : operand.name || 'close';
  const needsNum = choice === 'const' || BT_NEEDS_PERIOD.has(choice);
  function pick(next: string) {
    if (next === 'const') onChange({ kind: 'const', value: operand.value });
    else onChange({ kind: 'indicator', name: next, ...(BT_NEEDS_PERIOD.has(next) ? { period: operand.period || 20 } : {}) });
  }
  return (
    <Space size={6}>
      <Select value={choice} options={BT_INDICATORS.map(([value, label]) => ({ value, label }))} onChange={pick} style={{ width: 130 }} />
      {needsNum ? (
        <InputNumber
          placeholder={choice === 'const' ? '数值' : '周期'}
          value={choice === 'const' ? operand.value ?? null : operand.period ?? null}
          onChange={(v) => {
            const n = v == null ? undefined : Number(v);
            onChange(choice === 'const' ? { ...operand, value: n } : { ...operand, period: n });
          }}
          style={{ width: 76 }}
        />
      ) : null}
    </Space>
  );
}

// ---- 结果 ----------------------------------------------------------------

function BacktestResult({ r, strategyLabel }: { r: any; strategyLabel?: string }) {
  const beat = r.total_return_pct - r.buy_hold_return_pct;
  const instLabel = r.instrument && r.instrument.type !== 'stock' ? ` · ${BT_INST_LABELS[r.instrument.type] || r.instrument.type}(DTE ${r.instrument.dte},投入 ${r.instrument.risk_pct}%)` : '';
  // 兜底的空数组也要稳定:图表按 spec 的引用决定要不要重新灌数据
  const curve = useMemo((): { date: string; equity: number; bench: number }[] => r.curve || [], [r.curve]);
  const trades = useMemo((): any[] => r.trade_list || [], [r.trade_list]);

  // 换了标的 / 策略 / 品种再跑一次,视图重新铺满,不沿用上一次的缩放
  const viewKey = `${r.symbol}|${r.strategy}|${r.instrument?.type ?? 'stock'}|${r.start}|${r.end}`;
  const chart = useMemo((): ChartSpec | null => {
    if (curve.length < 2) return null;
    const times = curve.map((pt) => pt.date);
    const at = new Map(times.map((t, i) => [t, i]));
    const markers: SpecMarker[] = [];
    for (const t of trades) {
      if (at.has(t.entry_date)) markers.push({ time: t.entry_date, price: curve[at.get(t.entry_date)!].equity, shape: 'tri-up', color: 'up', fit: false });
      if (t.exit_date && at.has(t.exit_date)) markers.push({ time: t.exit_date, price: curve[at.get(t.exit_date)!].equity, shape: 'tri-down', color: 'down', fit: false });
    }
    return {
      ariaLabel: '净值曲线',
      viewKey,
      times,
      lines: [
        { values: curve.map((pt) => pt.bench), color: 'label2', alpha: 0.6, label: '买入持有' },
        { values: curve.map((pt) => pt.equity), color: 'blue', width: 1.5, label: '策略' },
      ],
      hlines: [{ price: 1, color: 'label', dash: [3, 3], alpha: 0.25, tag: false }],
      markers,
      legend: [['—', 'blue', '策略'], ['—', 'label2', '买入持有'], ['▲', 'up', '买入'], ['▼', 'down', '卖出'], ['╌', 'label2', '起点 1.0']],
      decimals: 3,
    };
  }, [curve, trades, viewKey]);

  const sign = (v: number) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');

  return (
    <>
      <StatusCard tone={beat >= 0 ? 'ok' : 'warn'} title={`${r.symbol} · ${strategyLabel || r.strategy}${instLabel} · ${r.start} ~ ${r.end}(${r.bars} 根日线)`}>
        <div className="stat-grid">
          <StatTile label="策略收益" value={`${r.total_return_pct}%`} tone={sign(r.total_return_pct)} />
          <StatTile label="买入持有" value={`${r.buy_hold_return_pct}%`} tone={sign(r.buy_hold_return_pct)} />
          <StatTile label="超额" value={`${beat >= 0 ? '+' : ''}${beat.toFixed(2)}%`} tone={sign(beat)} />
          <StatTile label="年化" value={`${r.annualized_pct}%`} />
          <StatTile label="最大回撤" value={`${r.max_drawdown_pct}%`} tone="neg" />
          <StatTile label="交易次数" value={String(r.trades)} />
          {r.win_rate_pct != null ? <StatTile label="胜率" value={`${r.win_rate_pct}%`} /> : null}
          <StatTile label="持仓时间占比" value={`${r.exposure_pct}%`} />
        </div>
      </StatusCard>
      {r.rules ? (
        <StatusCard title="本次使用的条件">
          <div>{`入场:${r.rules.entry.map(fmtCond).join(' 且 ')}`}</div>
          <div>{r.rules.exit.length ? `出场:${r.rules.exit.map(fmtCond).join(' 且 ')}` : '出场:持有到区间结束'}</div>
        </StatusCard>
      ) : null}
      <StatusCard title="净值曲线(起点 = 1.0)">
        {chart ? (
          <>
            <CanvasChart size="short" spec={chart} />
            <Meta items={[`${curve[0].date} → ${curve[curve.length - 1].date} · 期末净值 策略 ${curve[curve.length - 1].equity} / 基准 ${curve[curve.length - 1].bench}`]} />
          </>
        ) : null}
      </StatusCard>
      {trades.length && r.strategy !== 'buy_hold' ? (
        <StatusCard title={`交易明细(${trades.length})`}>
          <List
            size="small"
            className="trade-list"
            dataSource={trades}
            renderItem={(t, i) => (
              <List.Item key={i} className="stock-row">
                <span className="stock-sub">{`${t.entry_date} → ${t.exit_date || '持有中'}`}</span>
                <span className="stock-price">{`${fmtMoney(t.entry_price)} → ${fmtMoney(t.exit_price)}`}</span>
                <span className={`status ${t.return_pct >= 0 ? 'filled' : 'rejected'}`}>{`${t.return_pct >= 0 ? '+' : ''}${t.return_pct}%`}</span>
              </List.Item>
            )}
          />
        </StatusCard>
      ) : null}
      <StatusCard tone="warn" title="注意">
        <div>收盘价成交、未计滑点与成本、单标的全仓。历史收益不代表未来;参数越漂亮越要怀疑过拟合。</div>
      </StatusCard>
    </>
  );
}
