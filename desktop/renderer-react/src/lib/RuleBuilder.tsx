/** 自定义回测策略:图形化的条件搭建器,以及把搭好的条件写成一句话。
 *
 * 2026-09-21 从 pages/Backtest.tsx 搬出来(函数体逐字未改)。
 * 条件的形状在引擎契约里(contract/backtest.ts 的 RuleOperandInput / RuleConditionInput);
 * 一句话 → 条件那条路走 backtest.parse_rules,模型的回答过了复验才回来,不在这一层。
 */
import { useState } from 'react';
import { Button, Input, InputNumber, Select, Space } from 'antd';
import { dafri, errorMessage } from '../bridge';
import type { CustomRulesInput, RuleConditionInput, RuleOperandInput } from '../bridge';
import { showBanner } from '../store/banner';

type Operand = RuleOperandInput;
type Condition = RuleConditionInput;
/** 搭好之后交给引擎的那一份:每一组条件都在(Required),缺的那几组是空数组 */
export type Rules = Required<CustomRulesInput>;

/** 能拿来比的那几样、哪几样要填周期、以及可选的比较运算。只有搭建器用。 */
const BT_INDICATORS: [string, string][] = [
  ['close', '收盘价'], ['open', '开盘价'], ['high', '最高价'], ['low', '最低价'],
  ['sma', 'SMA均线'], ['ema', 'EMA均线'], ['rsi', 'RSI'],
  ['highest', '前N日最高'], ['lowest', '前N日最低'], ['change_pct', 'N日涨跌幅%'],
  ['const', '常数'],
];
const BT_NEEDS_PERIOD = new Set(['sma', 'ema', 'rsi', 'highest', 'lowest', 'change_pct']);
const BT_OPS: [string, string][] = [['>', '>'], ['<', '<'], ['>=', '≥'], ['<=', '≤'], ['cross_up', '上穿'], ['cross_down', '下穿']];

function fmtOperand(o: Operand): string {
  return o.kind === 'const'
    ? String(o.value)
    : `${(BT_INDICATORS.find(([k]) => k === o.name) || [o.name, o.name])[1]}${o.period ? `(${o.period})` : ''}`;
}
export function fmtCond(c: Condition): string {
  return `${fmtOperand(c.left)} ${(BT_OPS.find(([k]) => k === c.op) || [c.op, c.op])[1]} ${fmtOperand(c.right)}`;
}

export function RuleBuilder({ rules, onChange }: { rules: Rules; onChange: (r: Rules) => void }) {
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
