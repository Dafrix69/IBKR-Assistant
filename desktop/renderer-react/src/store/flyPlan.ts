/**
 * 蝴蝶测算:表单、最近一次结果、自动刷新。
 *
 * 为什么放在 store:壳一次只挂载一页,状态留在组件里的话,去「持仓追踪」看一眼再回来,填好的一排数字就没了。
 *
 * **自动刷新只在面板看得见的时候跑。** IV 是实时在变的(急涨急跌时尤其),测算开着不刷,屏幕上就是一个过期的数;
 * 但每刷一次引擎要读三条腿的行情(流留着一分钟,见 engine-ts/src/optionMarks.ts),人都不在这一页还刷是白占行情线路。
 * 循环在这里,看不看得见由面板告诉这里(setPlannerVisible)。
 */
import { create } from 'zustand';
import { dafri, errorMessage, type FlyPlanResult, type IvRecorderStatus } from '../bridge';
import { EMPTY_FORM, formProblems, toParams, type FlyForm } from '../lib/flyPlanForm';

export const AUTO_REFRESH_MS = 10_000;

export interface FlyPlanState {
  form: FlyForm;
  busy: boolean;
  result: FlyPlanResult | null;
  failure: string | null;
  /** 结果是按哪一份表单算的:表单改过之后结果还摆着,但要标出"这是改之前的" */
  resultFor: string;
  auto: boolean;
  /** 最近一次算完的时刻(本机时钟) */
  at: number | null;
  /** 当日到期期权 IV 的记录现在是什么状态;还没问到是 null */
  recorder: IvRecorderStatus | null;
}

const useStore = create<{ plan: FlyPlanState }>(() => ({
  plan: { form: EMPTY_FORM, busy: false, result: null, failure: null, resultFor: '', auto: false, at: null, recorder: null },
}));

function set(part: Partial<FlyPlanState>): void {
  useStore.setState((s) => ({ plan: { ...s.plan, ...part } }));
}

export function useFlyPlan(): FlyPlanState {
  return useStore((s) => s.plan);
}

export function formKey(form: FlyForm): string {
  return JSON.stringify(form);
}

export function patchFlyForm(part: Partial<FlyForm>): void {
  set({ form: { ...useStore.getState().plan.form, ...part } });
}

export function resetFlyPlan(): void {
  set({ form: EMPTY_FORM, result: null, failure: null, resultFor: '', auto: false, at: null });
}

/** quiet = 自动刷新那一路:不清掉屏幕上的结果,失败了把自动刷新关掉(不然同一句报错十秒来一次) */
export async function runFlyPlan(quiet = false): Promise<void> {
  const { form, busy } = useStore.getState().plan;
  if (busy) return;
  if (formProblems(form).length) {
    if (quiet) set({ auto: false });
    return;
  }
  const key = formKey(form);
  set({ busy: true, ...(quiet ? {} : { failure: null }) });
  try {
    const result = await dafri.flyPlan(toParams(form));
    set({ result, resultFor: key, failure: null, at: Date.now() });
  } catch (err) {
    set({ failure: errorMessage(err), ...(quiet ? { auto: false } : { result: null, resultFor: '' }) });
  } finally {
    set({ busy: false });
  }
}

// ---- 自动刷新 ----------------------------------------------------------------
let visible = false;
let timer: ReturnType<typeof setInterval> | null = null;

function sync(): void {
  const want = visible && useStore.getState().plan.auto;
  if (want && timer === null) {
    timer = setInterval(() => void runFlyPlan(true), AUTO_REFRESH_MS);
  } else if (!want && timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

export function setFlyAuto(on: boolean): void {
  set({ auto: on });
  sync();
  if (on) void runFlyPlan(true);
}

/** 面板挂上 / 卸下、或者被别的标签盖住时调 */
export function setPlannerVisible(on: boolean): void {
  visible = on;
  sync();
}

// 自动刷新被 runFlyPlan 自己关掉时(失败、表单改坏了)计时器也要跟着停
useStore.subscribe((s, prev) => {
  if (s.plan.auto !== prev.plan.auto) sync();
});

// ---- 当日到期期权 IV 的记录 ----------------------------------------------------
// 记的那一路在引擎里自己跑(连着 IBKR、在常规时段里每五分钟一笔),这里只读状态、拨开关。

export async function loadIvRecorder(): Promise<void> {
  try {
    set({ recorder: await dafri.ivRecorder() });
  } catch {
    /* 引擎还没起来:面板上那一行先不显示,下次进来再问 */
  }
}

export async function setIvRecorder(enabled: boolean): Promise<string | null> {
  try {
    set({ recorder: await dafri.setIvRecorder(enabled) });
    return null;
  } catch (err) {
    return errorMessage(err);
  }
}
