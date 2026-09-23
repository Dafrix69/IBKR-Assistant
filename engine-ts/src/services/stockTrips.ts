/** 成交 → 股票持仓段(从空仓到空仓),交易分析页与想法总结共用。
 *
 * 期初仓位靠当前持仓反推(tradereview.md「股票」一节):库里的成交是一天天攒的,最早那笔卖出多半卖的是更早买的货,
 * 不核对持仓就会把它认成做空;反过来,真做空(先卖后买回)也只有核对了持仓才认得出来。
 * 读不到持仓(没连、券商报错)就传 null,stockreview 那头把每一笔标成 opening_assumed,先卖的部分按卖出老仓位算。
 * 持仓 15 秒缓存:只为反推期初仓位,不必每次都问券商。
 */
import { BrokerError } from "../broker.js";
import { ServiceBase } from "./host.js";
import type { Rec } from "./host.js";

export class StockTripsService extends ServiceBase {
  static readonly HOLDINGS_TTL_S = 15.0; // 当前持仓多久重新向券商要一次(只为反推期初仓位)
  private holdingsAt = -Infinity;
  private holdings: Record<string, number> | null = null;

  async trips(): Promise<Rec[]> {
    const sr = await import("../stockreview.js");
    const accounts = this.settings.accounts.map((a) => ({ alias: a.alias, account_id: a.account_id, is_paper: a.is_paper }));
    const router: any = this.router;
    if (router !== null && typeof router.positions === "function" && router.sessions().length) {
      const now = performance.now() / 1000;
      if (now - this.holdingsAt >= StockTripsService.HOLDINGS_TTL_S) {
        try {
          const idOf = new Map(accounts.map((a) => [a.alias, a.account_id]));
          const holdings: Record<string, number> = {};
          for (const row of await router.positions()) {
            if (String(row["sec_type"] ?? "") !== "STK") continue;
            const accountId = idOf.get(String(row["account"] ?? ""));
            if (accountId === undefined) continue;
            const key = sr.holdingKey(accountId, row["symbol"]);
            holdings[key] = (holdings[key] ?? 0) + (Number(row["quantity"]) || 0);
          }
          this.holdings = holdings;
        } catch (exc) {
          if (!(exc instanceof BrokerError)) throw exc;
          this.holdings = null; // 读不到 ≠ 空仓:宁可标"期初未核对",也不拿空表去反推
        }
        this.holdingsAt = now;
      }
    } else {
      this.holdings = null;
      this.holdingsAt = -Infinity;
    }
    return sr.groupStockTrips(this.engine.store.listFills(), accounts, this.holdings);
  }
}
