/** 到期日的空头期权腿在不在实值里(纯函数)。实物交割的期权(个股、ETF)持到收盘会被指派:账户里多出或少掉正股。
 *
 * 这里只回答"哪几条腿、按现在的价到期后正股净变多少",不发单、不建议怎么做。现金结算的指数期权不在这里:
 * 它到期只结一笔现金,没有正股进出。
 */
import type { PositionRow } from "./contract/positions.js";

export interface ExpiringLeg {
  /** 持仓行的 key */
  key: string;
  /** 账户别名 */
  account: string;
  symbol: string;
  label: string;
  /** 带符号的张数:空头为负 */
  quantity: number;
  multiplier: number;
  strike: number;
  right: "C" | "P";
}

export interface ShortItmLeg extends ExpiringLeg {
  /** 实值多少(每股,正数) */
  itm_by: number;
}

export interface AssignmentNotice {
  account: string;
  symbol: string;
  /** 判断用的标的现价;拿不到是 null(那就说不出在不在实值里,只列出今天到期的空头腿) */
  spot: number | null;
  /** spot 有:在实值里的空头腿;spot 没有:今天到期的全部空头腿(itm_by 记 0) */
  legs: ShortItmLeg[];
  /** 按现在的价,到期后这个账户这只标的的正股净变动(股);同一天到期、也在实值里的多头腿会自动行权,已算在内。
   *  spot 没有时是 null */
  net_shares: number | null;
}

const ymd = (raw: unknown): string => String(raw ?? "").trim().slice(0, 8);

/**
 * 今天到期的实物交割期权腿(多头空头都要:净变动要把自动行权的多头腿算进去)。
 * `today` 是美东日历日 YYYYMMDD;`isCashSettled` 认现金结算的标的(配置里的指数)。期货期权、组合行、数量为 0 的不算。
 */
export function expiringOptionLegs(
  rows: readonly PositionRow[], today: string, isCashSettled: (symbol: string) => boolean,
): ExpiringLeg[] {
  const out: ExpiringLeg[] = [];
  for (const row of rows) {
    if (row.sec_type !== "OPT" || !row.quantity || isCashSettled(row.symbol)) continue;
    const c = row.contract;
    if (ymd(c["lastTradeDateOrContractMonth"]) !== today) continue;
    const strike = Number(c["strike"]);
    const right = String(c["right"] ?? "").slice(0, 1).toUpperCase();
    if (!(strike > 0) || (right !== "C" && right !== "P")) continue;
    out.push({
      key: row.key, account: row.account, symbol: row.symbol, label: row.label, quantity: row.quantity,
      multiplier: Number(row.multiplier) > 0 ? Number(row.multiplier) : 100, strike, right,
    });
  }
  return out;
}

/** 实值多少(每股);平值与虚值是 0。 */
export function itmBy(leg: Pick<ExpiringLeg, "strike" | "right">, spot: number): number {
  return Math.max(0, leg.right === "C" ? spot - leg.strike : leg.strike - spot);
}

/**
 * 每个账户、每只标的一条:有空头腿在实值里才出。没有现价的标的,只要有今天到期的空头腿也出一条(spot = null)——
 * 说不出在不在实值里,但人得知道这条腿今天到期。
 * 正股净变动:实值的看涨,持有的行权买进(+)、卖出的被指派卖出(−);看跌反过来。
 */
export function assignmentNotices(legs: readonly ExpiringLeg[], spots: Readonly<Record<string, number | null | undefined>>): AssignmentNotice[] {
  const groups = new Map<string, ExpiringLeg[]>();
  for (const leg of legs) {
    const id = `${leg.account}|${leg.symbol}`;
    groups.set(id, [...(groups.get(id) ?? []), leg]);
  }
  const out: AssignmentNotice[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    if (first === undefined) continue;
    const shorts = group.filter((l) => l.quantity < 0);
    if (!shorts.length) continue;
    const raw = spots[first.symbol];
    const spot = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;
    if (spot === null) {
      out.push({ account: first.account, symbol: first.symbol, spot: null, legs: shorts.map((l) => ({ ...l, itm_by: 0 })), net_shares: null });
      continue;
    }
    const risky = shorts.map((l) => ({ ...l, itm_by: itmBy(l, spot) })).filter((l) => l.itm_by > 0);
    if (!risky.length) continue;
    const net = group.reduce((sum, l) => (itmBy(l, spot) > 0 ? sum + (l.right === "C" ? 1 : -1) * l.quantity * l.multiplier : sum), 0);
    out.push({ account: first.account, symbol: first.symbol, spot, legs: risky, net_shares: net });
  }
  return out;
}

const num = (v: number): string => String(Math.round(v * 100) / 100);

/** 给人看的那一段。 */
export function noticeText(notice: AssignmentNotice): string {
  const legs = notice.legs
    .map((l) => `卖出 ${num(Math.abs(l.quantity))} 张 ${num(l.strike)}${l.right}${notice.spot === null ? "" : `(实值 ${num(l.itm_by)})`}`)
    .join("、");
  if (notice.spot === null || notice.net_shares === null) {
    return `${notice.symbol}(账户 ${notice.account})今天到期的空头腿:${legs}。拿不到正股现价,判断不了在不在实值里;` +
      "这是实物交割的期权,收盘时在实值里就会被指派,请自己看一眼。";
  }
  const net = notice.net_shares;
  const change = net === 0
    ? "正股净变动为 0(同一天到期、也在实值里的多头腿会自动行权,两边相抵)"
    : `这个账户的 ${notice.symbol} 正股净${net > 0 ? "买进" : "卖出"} ${num(Math.abs(net))} 股(同一天到期、也在实值里的多头腿会自动行权,已算在内)`;
  return `${notice.symbol}(账户 ${notice.account})到期日空头腿在实值里,现价 ${num(notice.spot)}:${legs}。` +
    `这是实物交割的期权,持到收盘会被指派;按现在的价,到期后${change}。不想要这个结果就在收盘前处理。`;
}
