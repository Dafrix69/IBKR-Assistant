import { useEffect, useState } from 'react';
import { Button, DatePicker, Input, Select } from 'antd';
import dayjs from 'dayjs';
import { dafri, errorMessage } from '../bridge';
import type { BacktestRunResult, BacktestRunSpec, BacktestStrategy } from '../bridge';
import { BacktestResult } from '../lib/BacktestResult';
import { BT_INST_LABELS } from '../lib/labels';
import { fmtCond, RuleBuilder, type Rules } from '../lib/RuleBuilder';
import { showBanner } from '../store/banner';
import { Group, GroupRow, NumberRow, PageHead, SectionTitle, StatusCard, Working } from '../ui/kit';

// 策略回测:纯计算展示,历史数据来自 TWS。含自定义条件搭建器与随表单实时生成的流程图。

// 形状在引擎契约里(engine-ts/src/contract/backtest.ts),从 bridge 拿。搭建器里的条件用的是「发过去的样子」(用不上的键可以不带);
// 引擎回来的(一句话生成的、回执里的)是补齐成 null 之后的样子,能直接放进搭建器。
type Strategy = BacktestStrategy;

// 默认给一组 RSI 超卖示例,进页面就能看懂结构
const DEFAULT_RULES: Rules = {
  entry: [{ left: { kind: 'indicator', name: 'rsi', period: 14 }, op: '<', right: { kind: 'const', value: 30 } }],
  exit: [{ left: { kind: 'indicator', name: 'rsi', period: 14 }, op: '>', right: { kind: 'const', value: 70 } }],
};


function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// 三块各自一个文件:条件搭建器 lib/RuleBuilder、结果 lib/BacktestResult。这一页只剩选参数 + 跑一次。
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
  const [result, setResult] = useState<BacktestRunResult | null>(null);
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
    const spec: BacktestRunSpec = {
      symbol: sym,
      start,
      end,
      strategy: strategyKey,
      params: Object.fromEntries(Object.entries(params).filter((e): e is [string, number] => e[1] !== null && e[1] !== undefined)),
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


