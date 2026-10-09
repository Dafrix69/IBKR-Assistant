/** 新建追踪表单里的「出场细则」:到点平仓、分批止盈、标的止损的确认、止损按哪个价判、止损类的追价节奏。
 *
 * 从 TrackForm.tsx 分出来(那个文件贴着 400 行的预算)。这里只管摆和收;值怎么变成载荷、确认框怎么说在 trackExitForm.ts,
 * 规则本身在引擎。全部是"不填 = 和以前一样",所以默认折着。
 */
import { Button, Checkbox, Input, InputNumber, Select } from 'antd';
import { MAX_TIERS, type ExitFields, type TierField } from './trackExitForm';

const STOP_BASIS_TITLE =
  '止损、跟踪止损、利润回撤拿哪个价判。中间价:持仓的现价(各腿买卖中间价拼出来的)。可成交价:此刻立刻平掉能拿到的价(持有的腿按买价、卖出的腿按卖价)——'
  + '它比中间价低一截,止损线等于"至少卖到这个价";代价是盘口一变宽就可能触发,便宜的蝶更明显。拿不到可成交价的那一秒退回按中间价判。止盈始终看中间价。';

export function TrackExitFields({
  symbol, long, derivative, hosted, value, onChange,
}: {
  symbol: string;
  long: boolean;
  /** 期权或组合:正股没有「可成交价」与追价这几项 */
  derivative: boolean;
  /** 托管到券商开着:分批止盈设不了 */
  hosted: boolean;
  value: ExitFields;
  onChange: (next: ExitFields) => void;
}) {
  const set = (part: Partial<ExitFields>): void => onChange({ ...value, ...part });
  const setTier = (index: number, part: Partial<TierField>): void =>
    set({ tiers: value.tiers.map((t, i) => (i === index ? { ...t, ...part } : t)) });
  const num = (v: number | string | null): number | null => (v === null || v === undefined || v === '' ? null : Number(v));

  return (
    <details className="track-more">
      <summary>更多出场规则(到点平仓、分批止盈、止损的口径与追价)——不填就和以前一样</summary>
      <div className="track-more-grid">
        <label className="track-field" title="下一次到这个钟点(美东)时持仓还在就平,记作到点平仓,不算止损。夜盘里填 03:00 指的是今晚过了零点的 03:00。软件关着不盯。">
          <span>到点平仓(美东 HH:MM)</span>
          <Input placeholder="如 15:45;不填 = 不设" value={value.exitAt} onChange={(e) => set({ exitAt: e.target.value })} />
        </label>
        {derivative ? (
          <label className="track-field" title={`${symbol} 越过标的止损价之后,要在线外连续待满这么多秒才平;中途回到线内就从头数。不填 = 一碰线就平。`}>
            <span>标的止损确认(秒)</span>
            <InputNumber min={0} max={600} step={1} placeholder="不填 = 触线即算" value={value.stopConfirm} onChange={(v) => set({ stopConfirm: num(v) })} />
          </label>
        ) : null}
        {derivative ? (
          <label className="track-field" title={STOP_BASIS_TITLE}>
            <span>止损按哪个价判</span>
            <Select
              value={value.stopBasis}
              onChange={(v) => set({ stopBasis: v })}
              options={[{ value: 'mid', label: '中间价(默认)' }, { value: 'natural', label: '可成交价(各腿买卖价)' }]}
            />
          </label>
        ) : null}
        {derivative ? (
          <label className="track-field" title="跟踪止损与利润回撤的峰值(最有利价)默认每秒都能往上推。组合的现价是几条腿的中间价拼出来的,一条腿的报价晚到半秒、一笔挂得高的卖价,都能把它抬一截又落回——峰值只升不降,之后一比就是一次假回撤。勾上之后峰值要连续两秒都见到才推;代价是晚一秒,真的只出现了一秒的高点也不算。">
            <span>峰值确认</span>
            <Checkbox checked={value.peakConfirm} onChange={(e) => set({ peakConfirm: e.target.checked })}>连续两秒都见到才推</Checkbox>
          </label>
        ) : null}
        {derivative ? (
          <>
            <label className="track-field" title="止损类(止损、跟踪止损、利润回撤、标的止损)触发后,平仓单先在立刻成交价上等几秒再开始让价。不填 = 2 秒(和止盈同一套);0 = 不等。">
              <span>止损追价:先等(秒)</span>
              <InputNumber min={0} max={60} step={1} placeholder="不填 = 2" value={value.chaseGrace} onChange={(v) => set({ chaseGrace: num(v) })} />
            </label>
            <label className="track-field" title="止损类触发后每秒让几跳。不填 = 1 跳(和止盈同一套)。">
              <span>止损追价:每秒让(跳)</span>
              <InputNumber min={1} max={20} step={1} placeholder="不填 = 1" value={value.chaseStep} onChange={(v) => set({ chaseStep: num(v) })} />
            </label>
            <label className="track-field" title="止损类触发后最多让到立刻成交价的百分之几。不填 = 用上面的「追价最多让价 %」。">
              <span>止损追价:最多让价 %</span>
              <InputNumber min={0} max={100} step={1} placeholder="不填 = 同止盈" value={value.chaseMax} onChange={(v) => set({ chaseMax: num(v) })} />
            </label>
          </>
        ) : null}
      </div>
      <div className="track-tiers">
        <div className="muted">
          分批止盈:持仓价到某一档就平掉此刻持仓的一部分(至少 1 张),成交之后接着盯剩下的。
          {long ? '各档的价一档比一档高。' : '各档的价一档比一档低。'}
          {hosted ? ' 托管到券商时设不了。' : ''}
        </div>
        {value.tiers.map((tier, i) => (
          // 档位只有几行、按位置增删,用位置当 key 就够
          <div className="track-tier-row" key={i}>
            <span className="muted">{`第 ${i + 1} 档`}</span>
            <InputNumber min={0} step={0.05} placeholder="持仓价到多少" value={tier.price} disabled={hosted} onChange={(v) => setTier(i, { price: num(v) })} />
            <InputNumber min={1} max={100} step={5} placeholder="平百分之几" value={tier.fraction} disabled={hosted} onChange={(v) => setTier(i, { fraction: num(v) })} />
            <Button size="small" type="text" onClick={() => set({ tiers: value.tiers.filter((_, j) => j !== i) })}>去掉</Button>
          </div>
        ))}
        {value.tiers.length < MAX_TIERS ? (
          <Button size="small" disabled={hosted} onClick={() => set({ tiers: [...value.tiers, { price: null, fraction: null }] })}>
            加一档
          </Button>
        ) : null}
      </div>
    </details>
  );
}
