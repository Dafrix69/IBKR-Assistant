/**
 * 蝴蝶测算:开仓之前问一句「按现在的现价开这只蝶,标的在某个时刻走到某个点位,它值多少、赚多少」。
 *
 * 只算不下单。「写进指令」只是把这只蝶写成一句话放进左边的输入框——发不发、什么时候发,还是那两个按钮和那个确认框的事。
 * 表单与结果在 store/flyPlan(切页回来还在);算法在引擎(engine-ts/src/flyPlan.ts),口径见 docs/features/fly-plan.md。
 */
import { useEffect } from 'react';
import { Button, Input, Segmented, Space, Switch, Tag } from 'antd';
import { etClock, formProblems, instructionFor, minutesFromNow, type FlyForm } from './flyPlanForm';
import { FlyPlanResultView } from './FlyPlanResult';
import type { FlyPlanIvMode } from '../bridge';
import { showBanner } from '../store/banner';
import {
  AUTO_REFRESH_MS, formKey, loadIvRecorder, patchFlyForm, resetFlyPlan, runFlyPlan, setFlyAuto, setIvRecorder, setPlannerVisible, useFlyPlan,
} from '../store/flyPlan';
import { EmptyState, Primer, StatusCard, Working } from '../ui/kit';

const TIME_CHIPS: [string, (now: number) => string][] = [
  ['30 分钟后', (now) => minutesFromNow(now, 30)],
  ['1 小时后', (now) => minutesFromNow(now, 60)],
  ['2 小时后', (now) => minutesFromNow(now, 120)],
  ['15:45', () => '15:45'],
];

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label title={hint}>
      <span>{label}</span>
      {children}
    </label>
  );
}

export function FlyPlanner({ onInstruction }: { onInstruction: (text: string) => void }) {
  const { form, busy, result, failure, resultFor, auto, at, recorder } = useFlyPlan();
  const problems = formProblems(form);
  const touched = Boolean(form.center || form.targetSpot || form.targetTime);
  const stale = Boolean(result) && resultFor !== formKey(form);

  // 自动刷新只在这块面板看得见的时候跑(循环在 store 里)
  useEffect(() => {
    setPlannerVisible(true);
    void loadIvRecorder();
    return () => setPlannerVisible(false);
  }, []);

  async function toggleRecorder(on: boolean) {
    const failed = await setIvRecorder(on);
    if (failed) showBanner(`没改成:${failed}`, false);
  }

  const text = (key: keyof FlyForm, placeholder: string, width = 96) => (
    <Input
      size="small"
      inputMode="decimal"
      style={{ width }}
      value={form[key]}
      placeholder={placeholder}
      onChange={(e) => patchFlyForm({ [key]: e.target.value })}
      onPressEnter={() => void runFlyPlan()}
    />
  );

  function writeInstruction() {
    if (!result) return;
    onInstruction(instructionFor(result, etClock(Date.now()).date));
    showBanner('已写进左边的指令框。先点「解析并校验」核对,再决定发不发。', true);
  }

  return (
    <div className="fly-planner">
      <div className="fly-form">
        <div className="fly-row">
          <Field label="中心行权价">{text('center', '7750')}</Field>
          <Field label="翼宽(点)">{text('width', '25', 72)}</Field>
          <Field label="方向" hint="自动 = 中心在现价上方看涨、下方看跌">
            <Segmented
              size="small"
              value={form.right}
              onChange={(v) => patchFlyForm({ right: v as FlyForm['right'] })}
              options={[{ label: '自动', value: '' }, { label: '看涨', value: 'C' }, { label: '看跌', value: 'P' }]}
            />
          </Field>
          <Field label="张数">{text('quantity', '1', 60)}</Field>
          <Field label="成本(权利金)" hint="你打算付的净权利金;留空 = 此刻的盘口中间价">
            {text('cost', '留空 = 中间价', 112)}
          </Field>
        </div>
        <div className="fly-row">
          <Field label="预计走到(点位)">{text('targetSpot', '7745')}</Field>
          <Field label="预计几点到(美东)" hint="美东时间,24 小时制">
            <Input
              size="small"
              style={{ width: 84 }}
              value={form.targetTime}
              placeholder="14:30"
              onChange={(e) => patchFlyForm({ targetTime: e.target.value })}
              onPressEnter={() => void runFlyPlan()}
            />
          </Field>
          <Space size={4} wrap className="fly-chips">
            {TIME_CHIPS.map(([label, pick]) => (
              <Tag key={label} bordered={false} className="chip-tag" onClick={() => patchFlyForm({ targetTime: pick(Date.now()), targetDate: '' })}>
                {label}
              </Tag>
            ))}
          </Space>
        </div>
        <Primer id="fly-more" summary="更多:日期与到期日、手动现价与 IV、到时的 IV 怎么算">
          <div className="fly-row">
            <Field label="哪一天到" hint="留空 = 今天;今天已收盘就是下一个交易日">
              <Input size="small" style={{ width: 120 }} value={form.targetDate} placeholder="YYYY-MM-DD" onChange={(e) => patchFlyForm({ targetDate: e.target.value })} />
            </Field>
            <Field label="到期日" hint="留空 = 目标那一天(当日到期)">
              <Input size="small" style={{ width: 120 }} value={form.expiry} placeholder="YYYY-MM-DD" onChange={(e) => patchFlyForm({ expiry: e.target.value })} />
            </Field>
            <Field label="现价" hint="留空 = 从券商取。没连券商、或想按另一个现价推演时填">
              {text('spot', '留空 = 实时', 104)}
            </Field>
            <Field label="IV(%)" hint="留空 = 用 IBKR 的模型 IV(每条腿各用各的)。填了就三条腿共用这一个">
              {text('iv', '留空 = 实时', 104)}
            </Field>
          </div>
          <div className="fly-row">
            <Field label="到时的 IV" hint="自动 = 按历史数据校准的模型:跌则 IV 升、涨则 IV 降,再加上日内时段的影响">
              <Segmented
                size="small"
                value={form.ivMode}
                onChange={(v) => patchFlyForm({ ivMode: v as FlyPlanIvMode })}
                options={[{ label: '自动', value: 'auto' }, { label: '不变', value: 'flat' }, { label: '自己填', value: 'shift' }]}
              />
            </Field>
            {form.ivMode === 'shift' ? <Field label="IV 变化(%)">{text('ivShiftPct', '+30', 84)}</Field> : null}
          </div>
          <ul className="hint-list">
            <li>IV 会变:标的跌,IV 升;标的涨,IV 降。「自动」用的是拿两年多历史数据校准的模型,它解释得了 IV 变化的三成左右,所以结果里除了一个数,还有「半数情况下」的区间和各档 IV 下的数。</li>
            <li>现价与 IV 都手动填了,就不取任何行情:没连券商、休市时也能算。</li>
          </ul>
          {recorder ? (
            <div className="fly-recorder">
              <span className="fly-auto" title="连着 IBKR、在常规交易时段里,每五分钟把当日到期的一圈行权价的盘口与 IV 记一笔。只读行情;关掉之后不订任何行情,已经攒下的不删">
                <Switch size="small" checked={recorder.enabled} onChange={(on) => void toggleRecorder(on)} />
                <span>{`记录当日到期期权的 IV(${recorder.symbol})`}</span>
              </span>
              <span className="muted">
                {recorder.samples ? `已攒 ${recorder.days} 天、${recorder.samples} 笔(${recorder.first_date} 起)` : '还没有攒下样本'}
                {recorder.enabled && recorder.idle_reason ? ` · 现在没在记:${recorder.idle_reason}` : ''}
                {recorder.last_error ? ` · 上次出错:${recorder.last_error}` : ''}
              </span>
              <p className="hint">
                现在「到时的 IV」是拿波动率指数校准的,不是期权自己的 IV——过期期权的历史行情哪儿都拿不到,只能从现在起自己记。
                攒够 40 个交易日之后重新校准,估出来比指数那一份准,当日到期的蝶就改用它。样本里只有行情,没有账号与持仓。
              </p>
            </div>
          ) : null}
        </Primer>
        <div className="row">
          <Button type="primary" size="small" loading={busy && !auto} disabled={!touched || problems.length > 0} onClick={() => void runFlyPlan()}>
            测算
          </Button>
          <Button size="small" disabled={!result || stale} title={stale ? '表单改过了,先重新测算' : '把这只蝶写成一句指令,放进左边的输入框(不会发单)'} onClick={writeInstruction}>
            写进指令
          </Button>
          <span className="fly-auto" title={`每 ${AUTO_REFRESH_MS / 1000} 秒按最新的现价与 IV 重算一次;离开这一页就停`}>
            <Switch size="small" checked={auto} disabled={problems.length > 0 || !touched} onChange={(on) => setFlyAuto(on)} />
            <span className="muted">跟着行情刷新</span>
          </span>
          <Button size="small" type="text" onClick={resetFlyPlan}>
            清空
          </Button>
          {at && result ? <span className="muted">{`算于 ${new Date(at).toLocaleTimeString([], { hour12: false })}`}</span> : null}
        </div>
        {touched && problems.length ? <div className="fly-problems">{problems.join(';')}</div> : null}
      </div>

      <div className="fly-output">
        {busy && !result ? (
          <Working>正在取现价与三条腿的行情…</Working>
        ) : failure && !result ? (
          <StatusCard tone="bad" title="算不出来">
            <div>{failure}</div>
          </StatusCard>
        ) : result ? (
          <>
            {failure ? (
              <StatusCard tone="warn" title="刚才那次刷新没成功,下面是上一次的结果">
                <div>{failure}</div>
              </StatusCard>
            ) : null}
            {stale ? <div className="fly-stale">表单改过了,下面是改之前的结果。点「测算」重算。</div> : null}
            <FlyPlanResultView r={result} stale={stale} />
          </>
        ) : (
          <EmptyState>填上这只蝶、预计走到哪儿、几点到,点「测算」</EmptyState>
        )}
      </div>
    </div>
  );
}
