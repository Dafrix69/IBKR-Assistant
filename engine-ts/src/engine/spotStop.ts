/** 标的止损价:这一轮的标的现价从哪来。
 *
 * 判定是纯函数(trackerSpotStop.ts),这里只管取价——盯盘(engine.pollTrackers)与设置时的校验
 * (rpc/handlers/tracker.ts)用同一个取法,免得一头拿昨收设得上、另一头拿现价当场触发。
 */
import type { SpotStop, SpotTarget, Targets } from "../contract/tracker.js";
import { finiteOrNull } from "../py.js";
import * as tk from "../tracker.js";

/** 取标的现价要用到的 router 那一面。 */
export interface SpotRouter {
  indexPrice(symbol: string): Promise<number | null>;
  /** 最近一次 indexPrice 的来源(官方指数 / 期货推算 / 推算失败退回的昨收);没有就是 null */
  spotInfo?(symbol: string): Record<string, unknown> | null;
  /** 常驻报价流(价位提醒也走它):只回成交价或标记价,不回昨收。没有这一路的券商(测试里的假券商)退到 indexPrice */
  streamQuotes?(symbols: string[]): Promise<Record<string, Record<string, unknown>>>;
}

/**
 * 一只正股(或个股期权的标的)此刻的价:走常驻报价流,和价位提醒看的是同一个数(穿越与止损不会各看各的)。
 * 那一路只回成交价或标记价,没有就是 null、这一轮不判——**不拿昨收冒充现价**:以前走 indexPrice,它的读价退路里有昨收,
 * 夜里拿一个不会动的数判止损,那条线要么永远不触发、要么一开盘按跳空触发。行情失败不炸掉这一轮。
 */
export async function stockSpot(router: SpotRouter, symbol: string): Promise<number | null> {
  try {
    if (typeof router.streamQuotes !== "function") return finiteOrNull(await router.indexPrice(symbol));
    const last = finiteOrNull((await router.streamQuotes([symbol]))?.[symbol]?.["last"]);
    return last !== null && last > 0 ? last : null;
  } catch {
    return null;
  }
}

/**
 * 标的现价与它的来历,口径和标的目标价(engine.applySpotTarget)一致:行情失败不炸掉这一轮,当成拿不到;
 * 夜盘推算失败时 indexPrice 退回的是昨收(index_stale),它不会动,同样当成拿不到。
 * 不是指数的标的(个股期权)走 stockSpot:报价流只认成交价,没有昨收这条退路。
 */
export async function underlyingSpot(
  router: SpotRouter, symbol: string, index = true,
): Promise<{ spot: number | null; note: string }> {
  if (!index) return { spot: await stockSpot(router, symbol), note: "" };
  let spot: number | null = null;
  try {
    spot = await router.indexPrice(symbol);
  } catch {
    spot = null;
  }
  const info = router.spotInfo?.(symbol) ?? null;
  if (info?.["source"] === "index_stale") spot = null;
  return { spot: finiteOrNull(spot), note: String(info?.["note"] ?? "") };
}

/**
 * 这一轮的标的止损判定;没设回 null。这一轮算过标的目标价的,沿用它取到的那个现价
 * (同一轮里止盈与止损看同一个数),否则自己取一次。
 */
export async function spotStopFor(
  router: SpotRouter, symbol: string, targets: Targets, target: SpotTarget | null, index = true,
): Promise<SpotStop | null> {
  if (!tk.hasSpotStop(targets)) return null;
  const { spot, note } = target !== null
    ? { spot: target.spot, note: target.spot_note }
    : await underlyingSpot(router, symbol, index);
  return tk.spotStop(targets, symbol, spot, note);
}
