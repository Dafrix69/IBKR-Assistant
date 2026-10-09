/** 账户在手的期权敞口(纯函数):每个账户的最坏亏损合计、每个「账户 + 标的 + 到期」的张数。
 *
 * 校验层的两条累计上限(limits.max_open_risk_usd / max_underlying_contracts)拿它和这一单相加。
 *
 * **最坏亏损不靠认结构**:同一账户、同一标的、同一到期日的期权腿放在一起,直接算到期那一刻的盈亏在哪个价位最差。
 * 到期盈亏对标的价是分段线性的,最差的点只可能在 0、某个行权价、或者往上的无穷远处,所以把这几处都算一遍就是精确的上界:
 *
 *   盈亏(S) = Σ 数量 × 乘数 × 内在价值(S) − Σ 数量 × 每张成本      (数量带符号,卖出为负;成本是券商记的每张成本,含乘数)
 *
 * 认结构的那条路(combos.ts)是给展示与追踪用的,它按净成本的正负分借方贷方、把「两条看跌 + 两条看涨」一律当成一只铁鹰——
 * 两边张数不等的、分腿建起来净成本为正的贷方价差、和别的结构挤在同一天到期的,照那张表算都会少算。
 *
 * | 例 | 最坏亏损 |
 * |---|---|
 * | 买入的单腿、借方价差、买入的蝶 | 付出的成本 |
 * | 贷方价差、铁鹰、铁蝶 | 宽的那一侧 × 乘数 × 张数 − 收到的权利金 |
 * | 卖出的看跌 | 行权价 × 乘数 × 张数 − 收到的权利金 |
 * | 净卖出的看涨(往上没有对冲) | 没有上限:有限的那一段照算,再加 最高行权价 × 乘数 × 净卖出张数,并在 notes 里说明 |
 * | 正股 | 不计:最坏亏多少取决于止损 |
 *
 * 只算同一到期日之内的对冲:日历价差的两条腿不在一个到期日,各算各的(偏大)。这里没有估计、没有参数。
 */
import { withCombos } from "./combos.js";
import { finiteOrNull, pyRound } from "./py.js";

type Row = Record<string, unknown>;

export interface OpenRisk {
  /** 账户别名 → 期权在手的最坏亏损合计(美元) */
  riskUsd: Record<string, number>;
  /** contractsKey(账户, 标的, 到期) → 在手张数:认得出的标准组合按组数,其余按腿的张数 */
  contracts: Record<string, number>;
  /** 其实没有上限的那几样,说给人听 */
  notes: string[];
}

export function contractsKey(account: string, symbol: string, expiry: string): string {
  return `${account}|${String(symbol).toUpperCase()}|${String(expiry).slice(0, 8)}`;
}

const STANDARD = new Set(["vertical", "butterfly", "iron_condor", "iron_butterfly"]);

const contractOf = (row: Row): Row => (row["contract"] ?? {}) as Row;
const num = (v: unknown): number => finiteOrNull(v) ?? 0;
const isOption = (row: Row): boolean => row["sec_type"] === "OPT" || row["sec_type"] === "FOP";

interface Leg { qty: number; mult: number; strike: number; call: boolean; cost: number }

/** 同一到期日的一组腿到期时最坏亏多少。unbounded = 往上没有对冲的净卖出看涨张数(0 = 有上限)。 */
export function worstCaseAtExpiry(legs: readonly Leg[]): { usd: number; unbounded: number } {
  const paid = legs.reduce((sum, l) => sum + l.qty * l.cost, 0);
  const pnlAt = (s: number): number =>
    legs.reduce((sum, l) => sum + l.qty * l.mult * Math.max(0, l.call ? s - l.strike : l.strike - s), 0) - paid;
  const points = [0, ...legs.map((l) => l.strike)];
  const worst = Math.max(0, -Math.min(...points.map(pnlAt)));
  // 最高行权价之上:每涨一点的盈亏 = Σ 看涨腿的数量 × 乘数;是负的就没有上限
  const slope = legs.reduce((sum, l) => (l.call ? sum + l.qty * l.mult : sum), 0);
  if (slope >= 0) return { usd: worst, unbounded: 0 };
  const top = Math.max(...legs.map((l) => l.strike));
  return { usd: worst + -slope * top, unbounded: -legs.reduce((sum, l) => (l.call ? sum + l.qty : sum), 0) };
}

/** 组合行里各腿的张数和组数对得上才按组数记(combos.shapeOf 不查铁鹰两侧相等:2 组看跌价差 + 5 组看涨价差也叫「铁鹰」)。
 *  价差、铁鹰、铁蝶:每条腿都是 1 倍;蝶:1 / 2 / 1。 */
function consistent(row: Row, byKey: Map<string, Row>): boolean {
  const units = Math.abs(num(row["quantity"]));
  const legs = ((row["legs"] ?? []) as string[]).map((k) => byKey.get(k));
  if (!(units > 0) || legs.some((l) => l === undefined)) return false;
  const per = legs.map((l) => Math.abs(num((l as Row)["quantity"])) / units);
  const want = row["kind"] === "butterfly" ? [1, 2, 1] : per.map(() => 1);
  return per.length === want.length && per.every((r, i) => Math.abs(r - (want[i] ?? 0)) < 1e-9);
}

/** rows 是券商持仓行(router.positions() 的原样)。 */
export function openRisk(rows: readonly Row[]): OpenRisk {
  const out: OpenRisk = { riskUsd: {}, contracts: {}, notes: [] };

  // ---- 最坏亏损:按「账户 + 标的 + 到期」把腿放在一起算 ----
  const buckets = new Map<string, { account: string; symbol: string; expiry: string; legs: Leg[] }>();
  for (const row of rows) {
    if (!isOption(row)) continue;
    const c = contractOf(row);
    const qty = num(row["quantity"]);
    const strike = num(c["strike"]);
    const right = String(c["right"] ?? "").slice(0, 1).toUpperCase();
    if (!qty || !(strike > 0) || (right !== "C" && right !== "P")) continue;
    const account = String(row["account"]), symbol = String(row["symbol"]);
    const expiry = String(c["lastTradeDateOrContractMonth"] ?? "").slice(0, 8);
    const key = contractsKey(account, symbol, expiry);
    const bucket = buckets.get(key) ?? { account, symbol, expiry, legs: [] };
    bucket.legs.push({ qty, mult: num(row["multiplier"]) || 100, strike, call: right === "C", cost: Math.abs(num(row["avg_cost"])) });
    buckets.set(key, bucket);
  }
  for (const bucket of buckets.values()) {
    const { usd, unbounded } = worstCaseAtExpiry(bucket.legs);
    out.riskUsd[bucket.account] = pyRound((out.riskUsd[bucket.account] ?? 0) + usd, 2);
    if (unbounded > 0) {
      out.notes.push(
        `${bucket.account} 的 ${bucket.symbol} ${bucket.expiry} 到期有 ${pyRound(unbounded, 4)} 张净卖出的看涨往上没有对冲,亏损没有上限;` +
        "在手风险里这一段按最高行权价 × 乘数 × 张数计。",
      );
    }
  }

  // ---- 张数:认得出的标准组合按组数,其余按腿的张数(偏大的那一侧) ----
  const all = withCombos([...rows]) as Row[];
  const byKey = new Map(all.map((r) => [String(r["key"]), r]));
  const inCombo = new Set<string>();
  const count = (account: string, symbol: string, expiry: string, n: number): void => {
    const key = contractsKey(account, symbol, expiry);
    out.contracts[key] = (out.contracts[key] ?? 0) + n;
  };
  for (const row of all) {
    if (row["sec_type"] !== "BAG" || !STANDARD.has(String(row["kind"] ?? "")) || !consistent(row, byKey)) continue;
    const keys = (row["legs"] ?? []) as string[];
    for (const key of keys) inCombo.add(key);
    const first = byKey.get(keys[0] ?? "") ?? {};
    count(String(row["account"]), String(row["symbol"]), String(contractOf(first)["lastTradeDateOrContractMonth"] ?? ""), Math.abs(num(row["quantity"])));
  }
  for (const row of all) {
    if (!isOption(row) || inCombo.has(String(row["key"])) || !num(row["quantity"])) continue;
    count(String(row["account"]), String(row["symbol"]), String(contractOf(row)["lastTradeDateOrContractMonth"] ?? ""), Math.abs(num(row["quantity"])));
  }
  return out;
}
