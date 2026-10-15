/** 重要事件的日历:内置的官方发布日程、公开日历源的解析与合并(纯计算,不联网、不读库)。
 *
 * 为什么要内置一张表:公开日历源只给**本周**,而「下周三有 FOMC」这种事得提前知道;官方日程(BLS、美联储、BEA)
 * 一年前就公布了,抄进来之后断网也有。表里只有真正会让指数跳空的几项:CPI、PPI、非农、FOMC 决议、PCE、GDP 初值;
 * 初请失业金每周四一次,按规则生成(周四是联邦假日就提前到周三)。讲话、零售、ISM 这些靠日历源补,用户自己要盯的(某只股发债、财报)自己记。
 *
 * 口径:
 *  · 时刻一律按美东墙钟换成 epoch(tz.wallToEpoch 管夏令时),界面再换成本机时间显示——用户在北京,CPI 的 08:30 是晚上 20:30。
 *  · 日历源上同一时刻、同一家族的几条(CPI m/m、Core CPI y/y…)合成一条事件,原文条目全部带上。
 *  · 内置日程与日历源撞上同一天同一家族时以日历源为准(它带预期与前值),名字沿用内置的(带参考月)。
 *  · 公布之后还挂多久:数据类 90 分钟(开盘前公布的数,开盘后一小时才算消化完);FOMC 决议 150 分钟(14:00 声明、14:30 发布会);
 *    讲话 60 分钟。这些是估的,不是量出来的;用户可以在自定义事件上自己填。
 *  · 星级 1 ~ 5:用户要的是「金十四星以上」。金十的日历要登录、条款不许未经授权的商业使用,所以不抓它,
 *    按同样的分档自己定(STARS):家族定死的按家族,日历源上认不出家族的按它的影响档位(High 4、Medium 3、Low 2)。
 */
import type { EconEvent, EventImpact, EventKind, EventsConfig } from "./contract/events.js";
import { ET, wallToEpoch, weekdayOfDate } from "./tz.js";

export const DEFAULT_EVENTS_CONFIG: EventsConfig = {
  enabled: true,
  feed: true,
  min_stars: 4,
  lead_minutes: [60, 15],
  sector_min_stocks: 3,
  sector_share: 0.6,
  sector_move_pct: 3,
  cross_market: true,
  cross_market_pct: 1.5,
  cross_lag_pct: 1,
};

/** 过了公布时刻还挂多久(分钟),按家族 */
export const LINGER_MIN: Record<EventKind, number> = {
  cpi: 90, ppi: 90, nfp: 90, fomc: 150, fomc_minutes: 60, pce: 90, gdp: 90, retail: 90, claims: 60, fed_speech: 60, ism: 60,
  jolts: 60, adp: 60, other: 60, custom: 90, cross: 60,
};

/**
 * 家族定死的星级(null = 看日历源的影响档位)。仿照金十的分档:5 星是会让指数当场跳空的(CPI、非农、FOMC 决议),
 * 4 星是常让指数动一下的(PPI、零售、初请、PCE、GDP、ISM、JOLTS、ADP、FOMC 纪要)。联储主席讲话 5 星,别的官员看档位。
 */
export const STARS: Record<EventKind, number | null> = {
  cpi: 5, nfp: 5, fomc: 5, ppi: 4, pce: 4, gdp: 4, retail: 4, claims: 4, ism: 4, jolts: 4, adp: 4, fomc_minutes: 4,
  fed_speech: null, other: null, custom: 4, cross: 5,
};

/** stars → impact:4 星以上整天挂着、提前提醒 */
export function impactOfStars(stars: number): EventImpact {
  return stars >= 4 ? "high" : "medium";
}

export const KIND_LABEL: Record<EventKind, string> = {
  cpi: "CPI", ppi: "PPI", nfp: "非农就业", fomc: "FOMC 利率决议", fomc_minutes: "FOMC 会议纪要", pce: "PCE 物价",
  gdp: "GDP", retail: "零售销售", claims: "初请失业金", fed_speech: "美联储讲话", ism: "ISM 指数", jolts: "JOLTS 职位空缺",
  adp: "ADP 就业", other: "", custom: "", cross: "跨市场",
};

interface Release {
  kind: EventKind;
  date: string;
  /** 美东 HH:MM */
  time: string;
  title: string;
}

const CN_MONTH = (m: number): string => `${m}月`;

/** 按月公布的数据:参考月 = 公布月的上一个月(CPI 11 月 10 日公布的是 10 月的) */
function monthly(kind: EventKind, dates: string[], time = "08:30"): Release[] {
  return dates.map((date) => {
    const month = Number(date.slice(5, 7));
    const ref = month === 1 ? 12 : month - 1;
    return { kind, date, time, title: `${KIND_LABEL[kind]}(${CN_MONTH(ref)})` };
  });
}

/**
 * 官方发布日程(抄录时间 2026-10-15):
 *  · CPI / PPI / 非农:BLS「Schedule of Releases」(bls.gov/schedule/news_release/{cpi,ppi,empsit}.htm),2026-10 ~ 2027-12。
 *  · FOMC:federalreserve.gov/monetarypolicy/fomccalendars.htm 的 2026、2027 两张表;决议在会议第二天 14:00,带 * 的那几次有经济预测。
 *  · PCE(Personal Income and Outlays)/ GDP 初值:bea.gov/news/schedule 与 next-year,2026-10 ~ 2027-12。
 * 2026-10-14 的 CPI 与 10-15 的 PPI 是从日历源上核对的(那一周的实际条目)。
 * 表只增不改;官方改期的以日历源为准(同一周里它会覆盖)。
 */
export const BUILTIN_RELEASES: readonly Release[] = [
  ...monthly("cpi", [
    "2026-10-14", "2026-11-10", "2026-12-10",
    "2027-01-13", "2027-02-11", "2027-03-10", "2027-04-13", "2027-05-12", "2027-06-10",
    "2027-07-14", "2027-08-11", "2027-09-14", "2027-10-14", "2027-11-10", "2027-12-10",
  ]),
  ...monthly("ppi", [
    "2026-10-15", "2026-11-13", "2026-12-15",
    "2027-01-14", "2027-02-12", "2027-03-12", "2027-04-14", "2027-05-13", "2027-06-11",
    "2027-07-15", "2027-08-10", "2027-09-10", "2027-10-15", "2027-11-12", "2027-12-15",
  ]),
  ...monthly("nfp", [
    "2026-11-06", "2026-12-04",
    "2027-01-08", "2027-02-05", "2027-03-05", "2027-04-02", "2027-05-07", "2027-06-04",
    "2027-07-02", "2027-08-06", "2027-09-03", "2027-10-08", "2027-11-05", "2027-12-03",
  ]),
  ...monthly("pce", [
    "2026-10-29", "2026-11-25", "2026-12-23",
    "2027-01-28", "2027-02-25", "2027-03-31", "2027-04-29", "2027-05-27", "2027-06-25",
    "2027-07-29", "2027-08-25", "2027-09-30", "2027-10-28", "2027-11-24", "2027-12-22",
  ]),
  { kind: "gdp", date: "2026-10-29", time: "08:30", title: "GDP 初值(三季度)" },
  { kind: "gdp", date: "2027-01-28", time: "08:30", title: "GDP 初值(四季度)" },
  { kind: "gdp", date: "2027-04-29", time: "08:30", title: "GDP 初值(一季度)" },
  { kind: "gdp", date: "2027-07-29", time: "08:30", title: "GDP 初值(二季度)" },
  { kind: "gdp", date: "2027-10-28", time: "08:30", title: "GDP 初值(三季度)" },
  { kind: "fomc", date: "2026-10-28", time: "14:00", title: "FOMC 利率决议" },
  { kind: "fomc", date: "2026-12-09", time: "14:00", title: "FOMC 利率决议(含经济预测)" },
  { kind: "fomc", date: "2027-01-27", time: "14:00", title: "FOMC 利率决议" },
  { kind: "fomc", date: "2027-03-17", time: "14:00", title: "FOMC 利率决议(含经济预测)" },
  { kind: "fomc", date: "2027-04-28", time: "14:00", title: "FOMC 利率决议" },
  { kind: "fomc", date: "2027-06-09", time: "14:00", title: "FOMC 利率决议(含经济预测)" },
  { kind: "fomc", date: "2027-07-28", time: "14:00", title: "FOMC 利率决议" },
  { kind: "fomc", date: "2027-09-15", time: "14:00", title: "FOMC 利率决议(含经济预测)" },
  { kind: "fomc", date: "2027-10-27", time: "14:00", title: "FOMC 利率决议" },
  { kind: "fomc", date: "2027-12-08", time: "14:00", title: "FOMC 利率决议(含经济预测)" },
];

/** 美东的日期 + 钟点 → epoch 毫秒;格式不对回 null。 */
export function etEpoch(date: string, time: string): number | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!d || !t) return null;
  const parts = {
    year: Number(d[1]), month: Number(d[2]), day: Number(d[3]), hour: Number(t[1]), minute: Number(t[2]), second: 0,
  };
  if (parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31 || parts.hour > 23 || parts.minute > 59) return null;
  // 不存在的日期(2 月 30 日)会被 Date 顺延:换回来对不上就是坏日期
  const epoch = wallToEpoch(parts, ET);
  const check = new Date(epoch).toLocaleDateString("en-CA", { timeZone: ET });
  return check === date ? epoch : null;
}

function builtinEvent(r: Release): EconEvent {
  const at = etEpoch(r.date, r.time);
  if (at === null) throw new Error(`内置日程里有坏日期:${r.kind} ${r.date} ${r.time}`);
  const stars = STARS[r.kind] ?? 4;
  return {
    id: `builtin:${r.kind}:${r.date}`, kind: r.kind, title: r.title, at, date_et: r.date, time_et: r.time,
    stars, impact: impactOfStars(stars), source: "builtin", linger_min: LINGER_MIN[r.kind],
  };
}

const DAY_MS = 86_400_000;
const ymd = (t: number): string => new Date(t).toISOString().slice(0, 10);

/**
 * 周四是不是联邦假日(劳工部那一周的初请就提前到周三公布):元旦、六月节(2021 起)、独立日、退伍军人节、感恩节、圣诞。
 * 落在周四的只有这几个会碰上;观察日挪到周五的那种(元旦落周六)不影响周四。
 */
export function thursdayIsFederalHoliday(date: string): boolean {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  if (m === 1 && d === 1) return true;
  if (m === 6 && d === 19 && y >= 2021) return true;
  if (m === 7 && d === 4) return true;
  if (m === 11 && d === 11) return true;
  if (m === 11 && d >= 22 && d <= 28) return true; // 十一月第四个周四 = 感恩节
  if (m === 12 && d === 25) return true;
  return false;
}

/** [from, to] 之间每周的初请失业金:周四 08:30 美东;那个周四是联邦假日就是周三。标题带它统计的那一周(截至上周六)。 */
export function claimsReleases(from: number, to: number): Release[] {
  const out: Release[] = [];
  // 从 from 那天往前退到周四,一周一周往后走;多走一周,周三公布的那种也盖住
  let t = Date.parse(`${ymd(from - 7 * DAY_MS)}T12:00:00Z`);
  while (new Date(t).getUTCDay() !== 4) t += DAY_MS;
  for (; t <= to + 7 * DAY_MS; t += 7 * DAY_MS) {
    const thursday = ymd(t);
    const date = thursdayIsFederalHoliday(thursday) ? ymd(t - DAY_MS) : thursday;
    const weekEnd = ymd(t - 5 * DAY_MS).slice(5);
    out.push({ kind: "claims", date, time: "08:30", title: `初请失业金(截至 ${weekEnd} 当周)` });
  }
  return out;
}

/** 内置日程里落在 [from, to](epoch 毫秒,含)之间的事件:抄下来的那张表 + 按规则生成的每周初请。 */
export function builtinEvents(from: number, to: number): EconEvent[] {
  const out: EconEvent[] = [];
  for (const r of [...BUILTIN_RELEASES, ...claimsReleases(from, to)]) {
    const e = builtinEvent(r);
    if (e.at >= from && e.at <= to) out.push(e);
  }
  return out.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------- 公开日历源(Forex Factory 本周 JSON)

/** 日历源上一条的样子(字段名是它的) */
export interface FeedRow {
  title: string;
  country: string;
  /** ISO 带时区偏移:2026-10-14T08:30:00-04:00 */
  date: string;
  /** High / Medium / Low / Holiday */
  impact: string;
  forecast: string;
  previous: string;
}

/** 英文标题 → 家族。顺序有讲究:「FOMC Press Conference」先于讲话;「Core PCE」先于 other。 */
const FAMILY_RULES: Array<[RegExp, EventKind]> = [
  [/\bCPI\b/i, "cpi"],
  [/\bPPI\b/i, "ppi"],
  // ADP 的标题里也有 Non-Farm,得排在非农前面
  [/\bADP\b/i, "adp"],
  [/JOLTS|Job Openings/i, "jolts"],
  [/Non-?Farm|Unemployment Rate|Average Hourly Earnings/i, "nfp"],
  [/FOMC Meeting Minutes/i, "fomc_minutes"],
  [/FOMC Statement|Federal Funds Rate|FOMC Press Conference|FOMC Economic Projections/i, "fomc"],
  [/Core PCE|Personal Income|Personal Spending/i, "pce"],
  [/\bGDP\b/i, "gdp"],
  [/Retail Sales/i, "retail"],
  [/Unemployment Claims/i, "claims"],
  [/Fed Chair|Fed Chairman|FOMC Member .* Speaks|Fed .* Speaks/i, "fed_speech"],
  [/\bISM\b/i, "ism"],
];

export function familyOf(title: string): EventKind {
  for (const [re, kind] of FAMILY_RULES) if (re.test(title)) return kind;
  return "other";
}

function speaker(title: string): string {
  const m = /(?:Chair(?:man)?|Member|Governor)\s+([A-Z][\w'.-]+)\s+(?:Speaks|Testifies)/i.exec(title);
  return m?.[1] ?? "";
}

function feedTitle(kind: EventKind, rows: FeedRow[]): string {
  const first = rows[0]?.title ?? "";
  if (kind === "fed_speech") {
    const who = speaker(first);
    return who ? `美联储讲话(${who})` : "美联储讲话";
  }
  if (kind === "other") return first;
  return KIND_LABEL[kind];
}

/** 日历源的影响档位 → 星级:High 4、Medium 3、Low 2;Holiday 与认不出的不要 */
function starsOfImpact(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (s === "high") return 4;
  if (s === "medium") return 3;
  if (s === "low") return 2;
  return null;
}

/** 一条日历源事件的星级:家族定死的用家族的;联储主席讲话 5 星;别的看档位 */
export function starsFor(kind: EventKind, title: string, feedStars: number): number {
  const fixed = STARS[kind];
  if (fixed !== null) return fixed;
  if (kind === "fed_speech" && /Fed Chair|Fed Chairman/i.test(title)) return 5;
  return feedStars;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function etDateOf(epoch: number): string {
  return new Date(epoch).toLocaleDateString("en-CA", { timeZone: ET });
}

function etTimeOf(epoch: number): string {
  return new Date(epoch).toLocaleTimeString("en-GB", { timeZone: ET, hour: "2-digit", minute: "2-digit", hour12: false });
}

/**
 * 日历源的载荷 → 事件。只要美国(USD)的;同一时刻同一家族合成一条(other 按原文标题分),星级取这一组里最高的。
 * 不在这里按星级筛:筛在合并之后(services/events),这样改了「最低星级」不用重新解析。
 * 载荷形状不对就当空的:日历源挂了不该把提醒整个弄挂。
 */
export function parseFeed(payload: unknown): EconEvent[] {
  if (!Array.isArray(payload)) return [];
  const groups = new Map<string, { kind: EventKind; at: number; stars: number; rows: FeedRow[] }>();
  for (const raw of payload) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Partial<FeedRow>;
    if (String(row.country ?? "").toUpperCase() !== "USD") continue;
    const feedStars = starsOfImpact(String(row.impact ?? ""));
    if (feedStars === null) continue;
    const title = String(row.title ?? "").trim();
    if (!title) continue;
    const at = num(Date.parse(String(row.date ?? "")));
    if (at === null) continue;
    const kind = familyOf(title);
    const stars = starsFor(kind, title, feedStars);
    const key = `${kind === "other" ? title : kind}@${at}`;
    const clean: FeedRow = {
      title, country: "USD", date: String(row.date), impact: String(row.impact),
      forecast: String(row.forecast ?? "").trim(), previous: String(row.previous ?? "").trim(),
    };
    const g = groups.get(key);
    if (g) {
      g.rows.push(clean);
      g.stars = Math.max(g.stars, stars); // 同一组里有一条星级高,整条就按它
    } else {
      groups.set(key, { kind, at, stars, rows: [clean] });
    }
  }
  const out: EconEvent[] = [];
  for (const g of groups.values()) {
    out.push({
      id: `feed:${g.kind === "other" ? slug(g.rows[0]?.title ?? "") : g.kind}:${g.at}`,
      kind: g.kind, title: feedTitle(g.kind, g.rows), at: g.at, date_et: etDateOf(g.at), time_et: etTimeOf(g.at),
      stars: g.stars, impact: impactOfStars(g.stars), source: "feed", linger_min: LINGER_MIN[g.kind],
      items: g.rows.map((r) => ({ title: r.title, forecast: r.forecast, previous: r.previous })),
    });
  }
  return out.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "event";
}

/**
 * 三路合并:内置 + 日历源 + 自定义。内置与日历源撞上同一天同一家族时,日历源那条顶上去(带预期前值),
 * 但名字用内置的(带参考月)、id 用内置的(界面上静音过的还认得)。
 */
export function mergeEvents(builtin: EconEvent[], feed: EconEvent[], custom: EconEvent[]): EconEvent[] {
  const byKey = new Map<string, EconEvent>();
  for (const e of builtin) byKey.set(`${e.kind}@${e.date_et}`, e);
  const out: EconEvent[] = [];
  const replaced = new Set<string>();
  for (const f of feed) {
    const key = `${f.kind}@${f.date_et}`;
    const b = f.kind === "other" ? undefined : byKey.get(key);
    if (b) {
      replaced.add(key);
      const stars = Math.max(f.stars, b.stars);
      out.push({ ...f, id: b.id, title: b.title, linger_min: b.linger_min, stars, impact: impactOfStars(stars) });
    } else {
      out.push(f);
    }
  }
  for (const b of builtin) if (!replaced.has(`${b.kind}@${b.date_et}`)) out.push(b);
  out.push(...custom);
  return out.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

/** 公布过了这么久就不再是"今天的事"了 */
export function expiresAt(e: EconEvent): number {
  return e.at + e.linger_min * 60_000;
}

/** 内置日程自检:日期合法、落在工作日(周末公布的数不存在)、同一家族同一天不重复。给测试与启动自检用。 */
export function builtinProblems(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of BUILTIN_RELEASES) {
    const key = `${r.kind}@${r.date}`;
    if (seen.has(key)) out.push(`重复:${key}`);
    seen.add(key);
    if (etEpoch(r.date, r.time) === null) out.push(`坏日期:${key} ${r.time}`);
    const dow = weekdayOfDate(r.date);
    if (dow === 0 || dow === 6) out.push(`落在周末:${key}`);
  }
  return out;
}

// ---------------------------------------------------------------- 口径的校验

export class EventsConfigError extends Error {}

function numberOf(raw: unknown, name: string): number {
  const v = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new EventsConfigError(`${name}必须是数字`);
  return v;
}

/** 界面一次只改一两项:在当前生效的那份上合并;越界的当场拒,给中文原因。 */
export function normalizeEventsConfig(input: unknown, base: EventsConfig = DEFAULT_EVENTS_CONFIG): EventsConfig {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out: EventsConfig = { ...base, lead_minutes: [...base.lead_minutes] };
  for (const key of ["enabled", "feed", "cross_market"] as const) {
    if (raw[key] !== undefined) out[key] = Boolean(raw[key]);
  }
  // 老口径:「中等影响的也算」开着 = 三星起
  if (raw["min_stars"] === undefined && raw["medium"] === true) out.min_stars = 3;
  if (raw["min_stars"] !== undefined) {
    const n = numberOf(raw["min_stars"], "最低星级");
    if (n < 1 || n > 5 || n !== Math.round(n)) throw new EventsConfigError("最低星级必须是 1 ~ 5 的整数");
    out.min_stars = n;
  }
  if (raw["lead_minutes"] !== undefined) {
    const list = raw["lead_minutes"];
    if (!Array.isArray(list) || list.length > 4) throw new EventsConfigError("提前提醒最多 4 档");
    const mins = list.map((x) => numberOf(x, "提前提醒的分钟数"));
    if (mins.some((m) => m < 1 || m > 24 * 60 || m !== Math.round(m))) throw new EventsConfigError("提前提醒的分钟数必须是 1 ~ 1440 的整数");
    out.lead_minutes = [...new Set(mins)].sort((a, b) => b - a);
  }
  if (raw["sector_min_stocks"] !== undefined) {
    const n = numberOf(raw["sector_min_stocks"], "板块联动的最少只数");
    if (n < 2 || n > 30 || n !== Math.round(n)) throw new EventsConfigError("板块联动的最少只数必须是 2 ~ 30 的整数");
    out.sector_min_stocks = n;
  }
  if (raw["sector_share"] !== undefined) {
    const s = numberOf(raw["sector_share"], "板块联动的比例");
    if (s < 0.3 || s > 1) throw new EventsConfigError("板块联动的比例必须在 0.3 ~ 1 之间");
    out.sector_share = s;
  }
  if (raw["sector_move_pct"] !== undefined) {
    const p = numberOf(raw["sector_move_pct"], "板块联动的涨跌幅");
    if (p < 0.5 || p > 50) throw new EventsConfigError("板块联动的涨跌幅必须在 0.5% ~ 50% 之间");
    out.sector_move_pct = p;
  }
  if (raw["cross_market_pct"] !== undefined) {
    const p = numberOf(raw["cross_market_pct"], "跨市场的涨跌幅");
    if (p < 0.3 || p > 10) throw new EventsConfigError("跨市场的涨跌幅必须在 0.3% ~ 10% 之间");
    out.cross_market_pct = p;
  }
  if (raw["cross_lag_pct"] !== undefined) {
    const p = numberOf(raw["cross_lag_pct"], "跨市场的差距");
    if (p < 0.2 || p > 10) throw new EventsConfigError("跨市场的差距必须在 0.2 ~ 10 个点之间");
    out.cross_lag_pct = p;
  }
  return out;
}
