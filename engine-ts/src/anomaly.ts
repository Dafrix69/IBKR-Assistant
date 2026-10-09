/** 优质股异动检测 —— 纯计算 + 状态机:不碰 I/O,不读时钟(时刻一律由调用方给)。
 *
 * 数据只认 TWS 同一条实时流:当日量(tick 8)、90 日日均量(tick 21)、30 日历史波动率(tick 23)、
 * 近 3/5/10 分钟量(tick 63~65)。2026-09-11 盘中真机核对过:同一时刻流里的当日量比当日 5 分钟线
 * 合计多出 19%~36%(历史 TRADES 线滤掉了部分成交类型)——所以当日量只跟同一条流里的基准比,
 * 绝不拿历史 K 线算出来的均量去除,否则每只股天天都"放量"。
 *
 * 和价位提醒一样,难的不是"判出异动",是"不要刷屏":
 *  · 全天量比、大涨大跌按档报,每档一天一次,换日重置;
 *  · 窗口放量、急涨急跌走滞回 + 冷却:报一次 → 落防 → 回落到阈值一半以下且过了冷却 → 重新上膛。
 */
import { OPEN_MINUTE, remainingShare } from "./flyCalibration.js";
import { FLY_IV_MODEL } from "./flyIvModel.js";
import { fmtF, fmtSF, pyRound } from "./py.js";
// 量价快照的形状搬到了 marketdata.ts(券商适配层填它,这里读它);转出以保持老的 import 路径。
export type { VolumeSnapshot } from "./marketdata.js";
import type { VolumeSnapshot } from "./marketdata.js";

// 对外的四个形状(触发条件、指标、事件)定义在 contract/quality.ts——引擎与界面共用一份;这里转出,老的 import 不用改。
export type { AnomalyConfig, AnomalyEvent, AnomalyKind, AnomalyMetrics as Metrics } from "./contract/quality.js";
import type { AnomalyConfig, AnomalyEvent, AnomalyMetrics as Metrics } from "./contract/quality.js";

export class AnomalyError extends Error {}

// ---------------------------------------------------------------- 配置

export const DEFAULT_ANOMALY_CONFIG: AnomalyConfig = {
  rvol_tiers: [2, 3, 5],
  burst_ratio: 4,
  window_min: 5,
  spike_sigma: 4,
  spike_min_pct: 1.0,
  spike_fixed_pct: 1.5,
  day_sigma_tiers: [2, 3, 4],
  day_fixed_tiers: [3, 5, 8],
  cooldown_min: 10,
  market_adjust: false,
};

const WINDOW_CHOICES: readonly number[] = [3, 5, 10];
const MAX_TIERS = 5;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 界面传来的数:数字或数字串都认;布尔、空串、NaN 一律不认(Number(true) === 1 会把开关当成阈值)。 */
function numberOf(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function shown(v: unknown): string {
  let s: string;
  try {
    s = typeof v === "string" ? v : JSON.stringify(v) ?? String(v);
  } catch {
    s = String(v);
  }
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

function scalarField(
  raw: Record<string, unknown>, key: keyof AnomalyConfig, fallback: number,
  lo: number, hi: number, what: string, range: string,
): number {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  const n = numberOf(value);
  if (n === null || n < lo || n > hi) throw new AnomalyError(`${what}要在 ${range} 之间(收到 ${shown(value)})`);
  return pyRound(n, 4);
}

function tiersField(
  raw: Record<string, unknown>, key: keyof AnomalyConfig, fallback: number[],
  lo: number, hi: number, what: string, range: string,
): number[] {
  const value = raw[key];
  if (value === undefined || value === null) return [...fallback];
  const why = `${what}要 1~${MAX_TIERS} 个、每个在 ${range} 之间(收到 ${shown(value)})`;
  if (!Array.isArray(value) || value.length === 0) throw new AnomalyError(why);
  const out: number[] = [];
  for (const item of value) {
    const n = numberOf(item);
    if (n === null || n < lo || n > hi) throw new AnomalyError(why);
    const r = pyRound(n, 4);
    if (!out.includes(r)) out.push(r);
  }
  // 档序号(day_up_fired 之类)按升序解释,乱序传进来先排好,不能让"第 1 档"变成最高那档
  out.sort((a, b) => a - b);
  if (out.length > MAX_TIERS) throw new AnomalyError(why);
  return out;
}

/** 校验并与 base 合并;越界抛 AnomalyError(中文信息)。未知键忽略,缺的键(或 null)取 base。 */
export function normalizeAnomalyConfig(raw: unknown, base: AnomalyConfig = DEFAULT_ANOMALY_CONFIG): AnomalyConfig {
  const out: AnomalyConfig = {
    ...base,
    rvol_tiers: [...base.rvol_tiers],
    day_sigma_tiers: [...base.day_sigma_tiers],
    day_fixed_tiers: [...base.day_fixed_tiers],
  };
  if (raw === undefined || raw === null) return out;
  if (!isRecord(raw)) throw new AnomalyError("触发条件的格式不对,应是一组键值");

  out.rvol_tiers = tiersField(raw, "rvol_tiers", out.rvol_tiers, 1.2, 50, "全天量比档位", "1.2~50 倍");
  out.burst_ratio = scalarField(raw, "burst_ratio", out.burst_ratio, 1.5, 50, "窗口量比阈值", "1.5~50 倍");
  const window = raw["window_min"];
  if (window !== undefined && window !== null) {
    const n = numberOf(window);
    if (n === null || !WINDOW_CHOICES.includes(n)) {
      throw new AnomalyError(`窗口只能是 3 / 5 / 10 分钟(收到 ${shown(window)})`);
    }
    out.window_min = n;
  }
  out.spike_sigma = scalarField(raw, "spike_sigma", out.spike_sigma, 1.5, 20, "急涨急跌的 σ 倍数", "1.5~20");
  out.spike_min_pct = scalarField(raw, "spike_min_pct", out.spike_min_pct, 0.1, 20, "急涨急跌的最低幅度", "0.1%~20%");
  out.spike_fixed_pct = scalarField(
    raw, "spike_fixed_pct", out.spike_fixed_pct, 0.2, 30, "无历史波动率时的急涨急跌阈值", "0.2%~30%",
  );
  out.day_sigma_tiers = tiersField(raw, "day_sigma_tiers", out.day_sigma_tiers, 0.5, 20, "大涨大跌的 σ 档位", "0.5~20");
  out.day_fixed_tiers = tiersField(
    raw, "day_fixed_tiers", out.day_fixed_tiers, 0.5, 50, "无历史波动率时的大涨大跌档位", "0.5%~50%",
  );
  out.cooldown_min = scalarField(raw, "cooldown_min", out.cooldown_min, 1, 240, "冷却时间", "1~240 分钟");
  const adjust = raw["market_adjust"];
  if (adjust !== undefined && adjust !== null) {
    if (typeof adjust !== "boolean") throw new AnomalyError(`「扣掉大盘」的开关要是 true / false(收到 ${shown(adjust)})`);
    out.market_adjust = adjust;
  }
  return out;
}

// ---------------------------------------------------------------- 日内成交量曲线
/** 美股常规时段每 5 分钟的成交量占比(24 只大盘/高波动股 × 20 日 = 480 个股日的均值,IB 5 分钟线)。
 * 第 0 格含开盘集合竞价,最后一格(15:55–16:00)含收盘集合竞价(IB 把 16:00 的收盘价量记在这格)。 */
export const SLOT_FRACTIONS: readonly number[] = [
  0.06609, 0.0305, 0.02611, 0.02475, 0.02228, 0.01943, 0.02086, 0.018, 0.01844, 0.01797, 0.01673, 0.01528,
  0.01538, 0.01421, 0.01311, 0.01361, 0.01279, 0.01313, 0.01381, 0.01259, 0.01186, 0.01146, 0.01123, 0.01145,
  0.01111, 0.01054, 0.00978, 0.00996, 0.01019, 0.00907, 0.00969, 0.0089, 0.00848, 0.00862, 0.00845, 0.00827,
  0.00847, 0.00769, 0.00764, 0.00777, 0.00738, 0.0075, 0.00787, 0.00751, 0.00702, 0.00713, 0.00723, 0.00691,
  0.00747, 0.00719, 0.00689, 0.0069, 0.00689, 0.00695, 0.00828, 0.00798, 0.00736, 0.00749, 0.00729, 0.00709,
  0.00793, 0.00772, 0.00758, 0.00877, 0.00844, 0.00802, 0.00934, 0.00903, 0.00924, 0.00983, 0.00986, 0.01032,
  0.01253, 0.01187, 0.01316, 0.01577, 0.0259, 0.0727,
];
export const RTH_MINUTES = 390;
/** 最后一格混着收盘竞价,放量类信号 15:55 之后不判 */
export const VOLUME_END_MINUTE = 385;
/** 全天量比 09:45 之后才判:早盘分母太小,开盘竞价一笔就能顶出好几倍 */
export const RVOL_MIN_MINUTE = 15;
/** 窗口起点要在 09:31 之后(避开开盘竞价那一笔)。实际判定是 minute − window_min ≥ 1,默认 5 分钟窗口即第 6 分钟 */
export const BURST_MIN_MINUTE = 6;
/** 开盘前 15 分钟波动天然大,σ 按全天平均算会刷屏 */
export const SPIKE_MIN_MINUTE = 15;

/** 没有均量时按当日节奏估窗口常态,至少要开盘 30 分钟:再早的"节奏"就是开盘竞价那一笔 */
const SESSION_PACE_MIN_MINUTE = 30;
/** 窗口起点样本最多比理想时刻早 90 秒;再旧就不是"近 W 分钟"了(循环卡住过、刚加进追踪) */
const WINDOW_STALE_MS = 90_000;
const SAMPLE_KEEP_MS = 20 * 60_000;
/** 窗口里至少要有这么多步(相邻两个样本之间算一步)才判得出"是不是一笔大单":只有一两步时,
 * 一笔补报的大宗和五分钟的持续放量在数字上长得一模一样。引擎 5 秒一轮,正常一个窗口有六十步。 */
export const MIN_BURST_STEPS = 4;
/** 阈值比较的浮点余量:正好 3.0 倍不能因为 2.9999999999999996 漏报 */
const EPS = 1e-9;

const SLOT_MINUTES = 5;
// 原表四舍五入到 5 位小数,和是 1.00004;按和归一,收盘那一刻正好是 1
const SLOT_TOTAL = SLOT_FRACTIONS.reduce((a, b) => a + b, 0);
const SLOT_CUM: readonly number[] = (() => {
  const out = [0];
  let acc = 0;
  for (const f of SLOT_FRACTIONS) {
    acc += f;
    out.push(acc / SLOT_TOTAL);
  }
  out[out.length - 1] = 1;
  return out;
})();

function sessionOf(sessionMinutes: unknown): number {
  return typeof sessionMinutes === "number" && Number.isFinite(sessionMinutes) && sessionMinutes > 0
    ? sessionMinutes
    : RTH_MINUTES;
}

/** 开盘后 minute 分钟(可带小数)的累计成交量占比。sessionMinutes < 390(半日市)时整条曲线按比例压缩——
 * 半日市一样是开盘竞价开头、收盘竞价收尾,只是中间短。格内线性插值;minute ≤ 0 → 0;≥ session → 1。 */
export function cumVolumeFraction(minute: number, sessionMinutes: number = RTH_MINUTES): number {
  const session = sessionOf(sessionMinutes);
  if (!(minute > 0)) return 0; // 连 NaN 一起挡掉
  if (minute >= session) return 1;
  const m = (minute * RTH_MINUTES) / session;
  const slot = Math.min(SLOT_FRACTIONS.length - 1, Math.floor(m / SLOT_MINUTES));
  const within = (m - slot * SLOT_MINUTES) / SLOT_MINUTES;
  return SLOT_CUM[slot]! + (SLOT_FRACTIONS[slot]! / SLOT_TOTAL) * within;
}

// ---------------------------------------------------------------- 日内方差曲线
/**
 * 开盘后 fromMinute ~ toMinute 这一段占常规时段方差的几成(开盘前、收盘后的部分不算)。
 *
 * 用的是蝴蝶测算校准出来的那一份(FLY_IV_MODEL.variance_weights:13 个半小时桶,桶内按匀速):
 * 开盘头半小时占 15%、午间每半小时约 5%、最后半小时 10%。**它是拿 SPY 估的**,个股的日内形状同样是两头高中间低,
 * 但没有逐只校准过。上面那条 SLOT_FRACTIONS 是成交量的分布,不是波动的,不能拿来缩放 σ。
 * 半日市按同一个钟点取(校准样本里没有半日市):13:00 收盘前那半小时按平常午后的份额算,不按收盘前的。
 */
export function varianceShare(fromMinute: number, toMinute: number): number {
  const weights = FLY_IV_MODEL.variance_weights;
  const share = remainingShare(weights, OPEN_MINUTE + fromMinute) - remainingShare(weights, OPEN_MINUTE + toMinute);
  return share > 0 ? share : 0; // 连 NaN 一起挡掉
}

// ---------------------------------------------------------------- 快照与样本

/** t = epoch ms */
export interface Sample {
  t: number;
  volume: number | null;
  last: number | null;
}

function finiteNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function positive(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/** 追加样本并裁掉最新样本 keepMs 之前的(默认 20 分钟);保持 t 升序;同 t 覆盖。返回新数组,不改入参。 */
export function pushSample(samples: Sample[], s: Sample, keepMs: number = SAMPLE_KEEP_MS): Sample[] {
  const list = (Array.isArray(samples) ? samples : []).filter(
    (x) => x && typeof x.t === "number" && Number.isFinite(x.t),
  );
  if (!s || typeof s.t !== "number" || !Number.isFinite(s.t)) return list;
  const sample: Sample = { t: s.t, volume: finiteNum(s.volume), last: finiteNum(s.last) };
  const out = list.filter((x) => x.t !== sample.t);
  out.push(sample);
  out.sort((a, b) => a.t - b.t);
  const keep = typeof keepMs === "number" && Number.isFinite(keepMs) && keepMs >= 0 ? keepMs : SAMPLE_KEEP_MS;
  const newest = out[out.length - 1]!.t;
  return out.filter((x) => x.t >= newest - keep);
}

// ---------------------------------------------------------------- 状态
/** 秒 */
export interface SignalArm {
  armed: boolean;
  last_fired_at: number | null;
}

export interface AnomalyState {
  /** 美东日期;换日即重置档位 */
  date: string;
  /** 今天已报过的最高 rvol 档(倍数值,0 = 没报过) */
  rvol_fired: number;
  /** 今天向上已报过的最高档**序号**(1 起;0 = 没报过)——序号而非数值:日内 hist_vol 可能晚到,基准会从固定切到 σ */
  day_up_fired: number;
  day_down_fired: number;
  /** 今天见过的最大一步,折成日均量的几分之几(不带单位,量与均量同乘 100 结果不变)。全天量比要去掉它再比档——
   * 09:45 刚开闸时 cum 只有 0.12,一笔占日均量 12% 的大宗就能把量比顶高一整倍。
   * 跟着整份状态存进 quality_stocks.states,重启不丢;美东换日随档位一起清零。 */
  max_step_share: number;
  burst: SignalArm;
  spike: SignalArm;
}

export function freshState(date: string): AnomalyState {
  return {
    date,
    rvol_fired: 0,
    day_up_fired: 0,
    day_down_fired: 0,
    max_step_share: 0,
    burst: { armed: true, last_fired_at: null },
    spike: { armed: true, last_fired_at: null },
  };
}

function coerceArm(raw: unknown): SignalArm {
  if (!isRecord(raw)) return { armed: true, last_fired_at: null };
  return {
    armed: typeof raw["armed"] === "boolean" ? raw["armed"] : true,
    last_fired_at: finiteNum(raw["last_fired_at"]),
  };
}

function nonNegative(v: unknown): number {
  const n = finiteNum(v);
  return n !== null && n > 0 ? n : 0;
}

/** 从数据库里读回的任意 JSON 恢复状态(字段缺失/类型不对就取默认),不抛异常。
 * 只做类型纠正,不做"换日"判断——那是 evaluateAnomalies 的事,这里保留原日期让它去比。 */
export function coerceState(raw: unknown, date: string): AnomalyState {
  let obj = raw;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      obj = null;
    }
  }
  if (!isRecord(obj)) return freshState(date);
  const d = obj["date"];
  return {
    date: typeof d === "string" && d !== "" ? d : date,
    rvol_fired: nonNegative(obj["rvol_fired"]),
    day_up_fired: Math.floor(nonNegative(obj["day_up_fired"])),
    day_down_fired: Math.floor(nonNegative(obj["day_down_fired"])),
    max_step_share: nonNegative(obj["max_step_share"]),
    burst: coerceArm(obj["burst"]),
    spike: coerceArm(obj["spike"]),
  };
}

// ---------------------------------------------------------------- 判定


function streamWindowVolume(snap: VolumeSnapshot, windowMin: number): number | null {
  const v = windowMin === 3 ? snap.vol_3m : windowMin === 5 ? snap.vol_5m : windowMin === 10 ? snap.vol_10m : null;
  const n = finiteNum(v);
  return n !== null && n >= 0 ? n : null;
}

/** 窗口起点:t ≤ now − W 的最新一条,且不能比理想时刻早 90 秒以上。 */
function windowAnchor(samples: Sample[] | null | undefined, nowMs: number, windowMin: number): Sample | null {
  const target = nowMs - windowMin * 60_000;
  let best: Sample | null = null;
  for (const s of Array.isArray(samples) ? samples : []) {
    if (!s || typeof s.t !== "number" || !Number.isFinite(s.t) || s.t > target) continue;
    if (best === null || s.t > best.t) best = s;
  }
  return best !== null && best.t >= target - WINDOW_STALE_MS ? best : null;
}

/** 样本序列在近 windowMin 分钟里的涨跌幅(%)。起点规则同个股的窗口(windowAnchor);凑不出窗口回 null。 */
export function windowReturnPct(samples: Sample[] | null | undefined, nowMs: number, windowMin: number): number | null {
  const s0 = windowAnchor(samples, nowMs, windowMin);
  const from = s0 !== null ? positive(s0.last) : null;
  let last: number | null = null;
  for (const s of Array.isArray(samples) ? samples : []) if (s && s.t === nowMs) last = positive(s.last);
  return from !== null && last !== null ? (last / from - 1) * 100 : null;
}

/** 大盘(标普 500 指数)同期的涨跌 %,由调用方给:change_pct = 较昨收,ret_window_pct = 近 W 分钟。没有的给 null。 */
export interface MarketMove {
  change_pct: number | null;
  ret_window_pct: number | null;
}

/**
 * 一段涨跌算多大(%,不带符号)。adjust 关着、或者没有大盘参照:就是它自己的幅度。
 * 开着:扣掉大盘之后还算数的幅度。扣法是事件研究里的"市场调整收益":个股涨跌 − 大盘同期涨跌,
 * 不估 beta(等于按 beta = 1)——beta 要每只股自己的日线才估得出,这条流里没有。
 * 两个口径都得够:自己的涨跌、扣完之后的涨跌,取小的那个;扣完反了向(大盘走得比它还多)就是 0。
 */
function moveSize(own: number, market: number | null, adjust: boolean): number {
  if (!adjust || market === null) return Math.abs(own);
  const rel = own - market;
  return rel * own <= 0 ? 0 : Math.min(Math.abs(own), Math.abs(rel));
}

/** 提醒里交代大盘的那半句:有参照就写;幅度是按扣完之后算的,把扣完的数也写出来。
 *  开着「扣掉大盘」却没有参照(没有指数行情权限、流冻住了、这只是延迟行情):照自己的幅度判了,得说出来。 */
function marketNote(own: number, market: number | null, size: number, adjust: boolean): string {
  if (market === null) return adjust ? ",无大盘参照、未扣" : "";
  const net = size < Math.abs(own) - EPS ? `、扣掉后 ${signedPct(own - market, 2)}%` : "";
  return `,标普同期 ${signedPct(market, 2)}%${net}`;
}

/** 光是开盘那一下(开盘价较昨收)就够这一档:写明是跳空,不是盘中一路走出来的。open 得是**今天的**开盘价(见 evaluateAnomalies 的 snap)。 */
function gapNote(open: number | null, close: number | null, changePct: number, threshold: number): string {
  const gapPct = open !== null && close !== null ? (open / close - 1) * 100 : null;
  return gapPct !== null && gapPct * changePct > 0 && Math.abs(gapPct) >= threshold - EPS
    ? `(开盘跳空 ${signedPct(gapPct, 2)}%)`
    : "";
}

/**
 * 窗口(起点之后到此刻)里相邻样本之间的增量:一共几步、最大的一步多大。
 *
 * 为什么要看最大一步:IB 会把大宗 / 暗池成交整笔补报进当日量。2026-09-11 真机,GOOG 5 秒里
 * 当日量一下 +65.9 万股(那天一步的中位数是 554 股),价格一动没动——按窗口总量算就是
 * "5 分钟放量 5.3×",弹出来却什么都没发生。去掉这一步还够倍数,才是真的持续放量。
 */
function windowSteps(samples: Sample[] | null | undefined, fromT: number, nowMs: number): { steps: number; largest: number } {
  const inWindow = (Array.isArray(samples) ? samples : [])
    .filter((s) => s && typeof s.t === "number" && s.t >= fromT && s.t <= nowMs && finiteNum(s.volume) !== null)
    .sort((a, b) => a.t - b.t);
  let steps = 0;
  let largest = 0;
  for (let i = 1; i < inWindow.length; i += 1) {
    const d = (inWindow[i]!.volume as number) - (inWindow[i - 1]!.volume as number);
    if (d < 0) continue; // 流重订 / 口径跳变,这一步不算
    steps += 1;
    if (d > largest) largest = d;
  }
  return { steps, largest };
}

/** 最近这一步的量增(当前当日量 − 上一条样本的当日量)。负数(流重订)与缺数一律不算。 */
function latestStep(samples: Sample[] | null | undefined, volume: number | null): number | null {
  if (volume === null) return null;
  const list = (Array.isArray(samples) ? samples : []).filter((s) => s && typeof s.t === "number" && finiteNum(s.volume) !== null);
  if (list.length < 2) return null;
  list.sort((a, b) => a.t - b.t);
  const prev = finiteNum(list[list.length - 2]!.volume);
  if (prev === null) return null;
  const d = volume - prev;
  return d >= 0 ? d : null;
}

function cooled(arm: SignalArm, nowS: number, cooldownMin: number): boolean {
  return arm.last_fired_at === null || nowS - arm.last_fired_at >= cooldownMin * 60;
}

/** 满足 x ≥ 阈值的最高档序号(1 起,0 = 一档都不到)。 */
function highestTier(thresholds: number[], x: number): number {
  let best = 0;
  thresholds.forEach((t, i) => {
    if (x >= t - EPS) best = Math.max(best, i + 1);
  });
  return best;
}

function r4(x: number | null): number | null {
  return x === null ? null : pyRound(x, 4);
}

function directionOf(x: number | null): "up" | "down" | null {
  if (x === null) return null;
  return x > 0 ? "up" : x < 0 ? "down" : null;
}

// ---- 文案:倍数 1 位小数、% 带符号(标题 1 位、正文 2 位)、价格与阈值去掉尾零
const MINUS = "−"; // U+2212:和标题示例同一个减号,比连字符在中文里更好认

function signedPct(x: number, nd: number): string {
  const s = fmtSF(x, nd);
  return s.startsWith("-") ? MINUS + s.slice(1) : s;
}

function times(x: number): string {
  return fmtF(x, 1);
}

function strip(x: number, nd: number): string {
  return fmtF(x, nd).replace(/0+$/, "").replace(/\.$/, "");
}

function priceText(x: number | null): string {
  return x === null ? "—" : strip(x, 4);
}

/** 一只股一轮的判定。samples 升序且已含本轮样本;minute 是开盘后分钟数(可小数),
 * 不在 [0, session) 里时只算指标不报。休市日(周末/假日)由调用方把 minute 放到区间外——这里不认日历。 */
export function evaluateAnomalies(args: {
  symbol: string;
  /** snap.open 只拿来写「开盘跳空」那半句,得是今天的开盘价:流里那个字段开盘前是昨天的,调用方认出是今天的才给,认不出给 null */
  snap: VolumeSnapshot;
  samples: Sample[];
  state: AnomalyState | null;
  nowMs: number;
  etDate: string;
  minute: number;
  sessionMinutes?: number;
  config: AnomalyConfig;
  /** 只算指标、这一轮不报也不动状态:刚订上的流(tick 23 历史波动率往往要等第二轮才到,
   * 拿固定阈值先报一次会把档位占掉)、或者行情已经不新鲜时,由调用方打开 */
  suppress?: boolean;
  /** 大盘同期的涨跌;取不到、或者和这只股对不上钟点(它是延迟行情)就不给 */
  market?: MarketMove | null;
  /** 这只股今天的常规时段开出来没有(调用方看到它在时段里成交过 / 动过 / 正式开盘价到了)。false = 大涨大跌先不判:
   * 钟过了 09:30、开盘那一笔还没进来时,手上的现价是盘前的,拿它较昨收报一次会把当天这一档占掉。不给当作开了 */
  opened?: boolean;
}): { events: AnomalyEvent[]; state: AnomalyState; metrics: Metrics } {
  const cfg = args.config;
  const symbol = args.symbol;
  const snap: VolumeSnapshot = args.snap ?? { last: null, close: null, volume: null, avg_volume: null, hist_vol: null };
  const nowMs = args.nowMs;
  const nowS = Math.round(nowMs / 1000);
  const session = sessionOf(args.sessionMinutes);
  const scale = session / RTH_MINUTES; // 半日市:以 390 为基准的时刻常数按比例压缩
  const minute = finiteNum(args.minute);
  const W = cfg.window_min;

  // 换日即重置:档位按天报,滞回也不该隔夜带着(coerceState 顺便复制一份,不改调用方的对象)
  const prev = args.state == null ? null : coerceState(args.state, args.etDate);
  const state = prev !== null && prev.date === args.etDate ? prev : freshState(args.etDate);

  const last = positive(snap.last);
  const close = positive(snap.close);
  const volume = positive(snap.volume);
  const avgVolume = positive(snap.avg_volume);
  // 年化、小数(0.32 = 32%):单位在 VolumeSnapshot 上写死,填它的一方负责换算。这里不猜——
  // 妖股的 30 日历史波动率真有 500% 以上的,按"太大了一定是百分数"除以 100 会把它的 σ 缩成百分之一
  const histVol = positive(snap.hist_vol);
  const changePct = last !== null && close !== null ? (last / close - 1) * 100 : null;

  const suppress = args.suppress === true;
  const inSession = !suppress && minute !== null && minute >= 0 && minute < session;
  const volumeEnd = VOLUME_END_MINUTE * scale;
  // 开盘那几道闸不跟着半日市压缩:开盘竞价、头一刻钟的波动都是按真实分钟走的,
  // 压缩成 8 分钟只会让半日市的早盘刷屏(收盘侧的 volumeEnd 才该压缩)
  const rvolMin = RVOL_MIN_MINUTE;

  // ---- 全天量比:分母是"90 日日均量 × 到此刻为止常态该走完的比例",早盘之前不算(分母太小,数字没意义)
  let rvol: number | null = null;
  if (avgVolume !== null && volume !== null && minute !== null && minute >= rvolMin) {
    const share = cumVolumeFraction(minute, session);
    if (share > 0) rvol = volume / (avgVolume * share);
  }

  // 当天最大一步:样本里最近这一步与状态里记着的比一比(样本只留 20 分钟,历史靠状态带着走)
  const lastStep = latestStep(args.samples, volume);
  if (!suppress && lastStep !== null && avgVolume !== null) {
    const share = lastStep / avgVolume;
    if (share > state.max_step_share) state.max_step_share = pyRound(share, 6); // 量同乘 100 也要得到同一个数
  }
  // 去掉那一笔大宗之后的全天量比:一笔特别大的补报不该顶出一整档。
  // rvol = 量/(均量×cum),所以减掉一步就是减掉 (那一步/均量)/cum,不需要再碰原始量
  const cumNow = minute !== null ? cumVolumeFraction(minute, session) : 0;
  const rvolExBlock =
    rvol !== null && state.max_step_share > 0 && cumNow > 0 ? rvol - state.max_step_share / cumNow : rvol;

  // ---- 窗口:量优先用自己的样本差(和当日量同一口径),没有才退回流里的近 W 分钟量
  const s0 = windowAnchor(args.samples, nowMs, W);
  const windowReady = s0 !== null;
  let windowVolume: number | null = null;
  let spanMin: number | null = null;
  // 只有样本算出来的窗口才判得了"是不是一笔大单";流里的短时量只给指标、不报警(见 windowSteps)
  let fromSamples = false;
  if (s0 !== null && volume !== null) {
    const base = finiteNum(s0.volume);
    // 负数只可能是流重订 / 口径跳变,当它无效
    if (base !== null && volume - base >= 0) {
      windowVolume = volume - base;
      spanMin = (nowMs - s0.t) / 60_000;
      fromSamples = true;
    }
  }
  if (windowVolume === null) {
    const streamed = streamWindowVolume(snap, W);
    if (streamed !== null) {
      windowVolume = streamed;
      spanMin = W;
    }
  }

  let burst: number | null = null;
  let basisVolume: "avg_volume" | "session_pace" | null = null;
  let windowNormal: number | null = null;
  if (windowVolume !== null && spanMin !== null && minute !== null) {
    const share = cumVolumeFraction(minute, session) - cumVolumeFraction(minute - spanMin, session);
    let normal: number | null = null;
    let basis: "avg_volume" | "session_pace" | null = null;
    if (avgVolume !== null) {
      normal = avgVolume * share;
      basis = "avg_volume";
    } else if (minute >= SESSION_PACE_MIN_MINUTE * scale && volume !== null) {
      // 没有均量:按今天到此刻的节奏推一个全天量。放量本身会抬高节奏,只会少报不会多报
      const soFar = cumVolumeFraction(minute, session);
      if (soFar > 0) {
        normal = (volume / soFar) * share;
        basis = "session_pace";
      }
    }
    if (normal !== null && normal > 0) {
      burst = windowVolume / normal;
      basisVolume = basis;
      windowNormal = normal;
    }
  }
  // 大单占比 = 窗口里最大一步 / 窗口量;"去掉最大一步还剩几倍"才是报不报的依据
  const stepInfo = fromSamples && s0 !== null ? windowSteps(args.samples, s0.t, nowMs) : null;
  const blockShare = stepInfo !== null && windowVolume !== null && windowVolume > 0 ? stepInfo.largest / windowVolume : null;
  const sustained =
    stepInfo !== null && stepInfo.steps >= MIN_BURST_STEPS && windowNormal !== null && windowVolume !== null
      ? (windowVolume - stepInfo.largest) / windowNormal
      : null;

  // 涨跌幅只能用自己的样本:流里没有"W 分钟前的价"
  const s0Last = s0 !== null ? positive(s0.last) : null;
  const retPct = s0Last !== null && last !== null ? (last / s0Last - 1) * 100 : null;
  const retSpan = s0 !== null ? (nowMs - s0.t) / 60_000 : W;
  // 日 σ:30 日收盘对收盘的历史波动率折到一天(含隔夜缺口——大涨大跌比的也是较昨收,口径对得上)。
  // 窗口 σ:日 σ × √(这一段占常规时段方差的几成),份额取校准过的日内方差曲线,不按"每分钟一样多"摊。
  // 隔夜那一份没有拆出去(要每只股自己的开盘价序列才估得出),窗口 σ 因此偏大、偏少报。
  const sigmaDayPct = histVol !== null ? (histVol / Math.sqrt(252)) * 100 : null;
  const windowShare = minute !== null ? varianceShare(minute - retSpan, minute) : 0;
  const sigmaWindowPct = sigmaDayPct !== null && windowShare > 0 ? sigmaDayPct * Math.sqrt(windowShare) : null;
  const basisSigma: "hist_vol" | "fixed" = histVol !== null ? "hist_vol" : "fixed";

  // 大盘同期:关着「扣掉大盘」时只写进提醒的那句话;开着时幅度按扣完之后的算(moveSize)
  const marketWindow = finiteNum(args.market?.ret_window_pct);
  const marketDay = finiteNum(args.market?.change_pct);

  const events: AnomalyEvent[] = [];
  const emit = (e: Omit<AnomalyEvent, "id" | "at" | "symbol" | "price" | "change_pct">): void => {
    events.push({
      id: `${symbol}:${e.kind}:${e.direction ?? "-"}:${e.tier ?? "-"}:${nowS}`,
      at: nowS,
      symbol,
      kind: e.kind,
      direction: e.direction,
      value: e.value,
      threshold: e.threshold,
      tier: e.tier,
      sigma: e.sigma,
      price: last,
      change_pct: r4(changePct),
      basis: e.basis,
      title: e.title,
      text: e.text,
    });
  };

  // ---- rvol:一次跨多档只报最高那档,档位按倍数值记(改了档位配置也不会把已报过的更低档再报一遍)
  if (rvol !== null && inSession && minute! >= rvolMin && minute! < volumeEnd) {
    let tier: number | null = null;
    for (const t of cfg.rvol_tiers) {
      // 两个口径都得够:含大单的量比 rvol、去掉当天最大一步的 rvolExBlock
      if (rvol >= t - EPS && (rvolExBlock ?? rvol) >= t - EPS && t > state.rvol_fired && (tier === null || t > tier)) tier = t;
    }
    if (tier !== null) {
      state.rvol_fired = tier;
      const chg = changePct !== null ? `(${signedPct(changePct, 2)}%)` : "";
      // 方向只是标签,取量所在的那一段的涨跌:全天的量配当日涨跌(下面窗口的量配窗口涨跌)
      emit({
        kind: "rvol", direction: directionOf(changePct), value: r4(rvol)!, threshold: tier, tier, sigma: null,
        basis: "avg_volume",
        title: `${symbol} 放量 ${times(rvol)}×`,
        text: `当日成交量已达同时段常态的 ${times(rvol)}×(第 ${strip(tier, 4)}× 档),现价 ${priceText(last)}${chg}`,
      });
    }
  }

  // ---- burst:窗口起点得在开盘竞价那一笔之后;滞回 + 冷却;去掉最大一步还够倍数(不是一笔大单)才报
  if (burst !== null && inSession && minute! - W >= 1 && minute! < volumeEnd) {
    const arm = state.burst;
    if (!arm.armed && burst < cfg.burst_ratio / 2 && cooled(arm, nowS, cfg.cooldown_min)) {
      state.burst = { armed: true, last_fired_at: arm.last_fired_at };
    }
    if (state.burst.armed && burst >= cfg.burst_ratio - EPS && sustained !== null && sustained >= cfg.burst_ratio - EPS) {
      state.burst = { armed: false, last_fired_at: nowS };
      const ret = retPct !== null ? `,${W} 分钟 ${signedPct(retPct, 2)}%` : "";
      const pace = basisVolume === "session_pace" ? "(无均量数据,按当日节奏估)" : "";
      emit({
        kind: "burst", direction: directionOf(retPct), value: r4(burst)!, threshold: cfg.burst_ratio, tier: null,
        sigma: null, basis: basisVolume!,
        title: `${symbol} ${W}分钟放量 ${times(burst)}×`,
        text: `近 ${W} 分钟成交量是同时段常态的 ${times(burst)}×${ret},现价 ${priceText(last)}${pace}`,
      });
    }
  }

  // ---- spike:阈值 = max(k × 窗口 σ, 最低幅度);没有历史波动率就用固定 %。价格信号不受 15:55 限制
  const spikeThreshold =
    sigmaWindowPct !== null ? Math.max(cfg.spike_sigma * sigmaWindowPct, cfg.spike_min_pct) : cfg.spike_fixed_pct;
  if (retPct !== null && inSession && minute! >= SPIKE_MIN_MINUTE) {
    const size = moveSize(retPct, marketWindow, cfg.market_adjust);
    const arm = state.spike;
    if (!arm.armed && size < spikeThreshold / 2 && cooled(arm, nowS, cfg.cooldown_min)) {
      state.spike = { armed: true, last_fired_at: arm.last_fired_at };
    }
    if (state.spike.armed && size >= spikeThreshold - EPS) {
      state.spike = { armed: false, last_fired_at: nowS };
      const up = retPct > 0;
      const thr = strip(spikeThreshold, 2);
      const how = sigmaWindowPct !== null
        ? `,约 ${times(size / sigmaWindowPct)}σ(阈值 ${thr}%)`
        : `(无历史波动率,按固定 ${thr}%)`;
      emit({
        kind: "spike", direction: up ? "up" : "down", value: r4(retPct)!, threshold: r4(spikeThreshold)!, tier: null,
        sigma: sigmaWindowPct !== null ? r4(size / sigmaWindowPct) : null, basis: basisSigma,
        title: `${symbol} ${W}分钟${up ? "急涨" : "急跌"} ${signedPct(retPct, 1)}%`,
        text: `${W} 分钟 ${signedPct(retPct, 2)}%${marketNote(retPct, marketWindow, size, cfg.market_adjust)}${how},现价 ${priceText(last)}`,
      });
    }
  }

  // ---- day_move:这只股今天开出来之后任意时刻都判(开盘第一分钟就判——跳空就是这个);上下各记各的档序号。
  // 跳空值得报一次,也只报一次:档序号按方向记在状态里(跟着落库,重启不丢),回补之后再回到同一档不重报,
  // 之后只有走到更高一档才再报。
  if (changePct !== null && inSession && args.opened !== false) {
    const thresholds = sigmaDayPct !== null ? cfg.day_sigma_tiers.map((k) => k * sigmaDayPct) : [...cfg.day_fixed_tiers];
    const size = moveSize(changePct, marketDay, cfg.market_adjust);
    const tier = highestTier(thresholds, size);
    const up = changePct > 0;
    const fired = up ? state.day_up_fired : state.day_down_fired;
    if (changePct !== 0 && tier > fired) {
      if (up) state.day_up_fired = tier;
      else state.day_down_fired = tier;
      const threshold = thresholds[tier - 1]!;
      const thr = strip(threshold, 2);
      const how = sigmaDayPct !== null
        ? `,约 ${times(size / sigmaDayPct)}σ(第 ${tier} 档,阈值 ${thr}%)`
        : `(第 ${tier} 档,阈值 ${thr}%)`;
      const gap = gapNote(positive(snap.open), close, changePct, threshold);
      emit({
        kind: "day_move", direction: up ? "up" : "down", value: r4(changePct)!, threshold: r4(threshold)!, tier,
        sigma: sigmaDayPct !== null ? r4(size / sigmaDayPct) : null, basis: basisSigma,
        title: `${symbol} ${up ? "大涨" : "大跌"} ${signedPct(changePct, 1)}%`,
        text: `较昨收 ${signedPct(changePct, 2)}%${gap}${marketNote(changePct, marketDay, size, cfg.market_adjust)}${how},现价 ${priceText(last)}`,
      });
    }
  }

  const metrics: Metrics = {
    last,
    change_pct: r4(changePct),
    rvol: r4(rvol),
    burst: r4(burst),
    block_share: r4(blockShare),
    ret_window_pct: r4(retPct),
    sigma_window_pct: r4(sigmaWindowPct),
    sigma_day_pct: r4(sigmaDayPct),
    basis_volume: basisVolume,
    basis_sigma: basisSigma,
    window_ready: windowReady,
    delayed: snap.delayed === true,
  };
  return { events, state, metrics };
}
