/** 本地速记这一步:「这条指令能不能不经大模型就出 payload」。
 *
 * 2026-09-27 从 engine.handleInstruction 整块搬出来(函数体逐字未改,只把 this.xxx 换成 host.xxx):
 * handleInstruction 265 行,超了 150 行的函数预算;而这一块自成一件事——抓现价(券商 → 公开源)、
 * 按固定行话解析、没接住就留一条观测。它会往调用方传进来的 snap 里补现价,之后的大模型提示词与校验
 * 用的是同一份快照,所以 snap 是按引用改的,不是拷贝。
 */
import type { EtNow } from "../config.js";
import { publicIndexPrice } from "../macro.js";
import { pyRound } from "../py.js";
import { looksLikeShorthand, shorthandSymbols, tryParseShorthand } from "../shorthand.js";
import type { ShorthandMeta } from "../shorthand.js";
import type { Rec, TradeStore } from "../store.js";

/** 这一步要用到的引擎那一面(TradingEngine 即符合)。 */
export interface ShorthandHost {
  readonly router: {
    indexPrice(symbol: string): Promise<number | null>;
    spotInfo?(symbol: string): Rec | null;
  } | null;
  /** 速记解析的公开源现价注入点(测试替身用;null = macro.publicIndexPrice)。 */
  readonly publicPriceFn: ((symbol: string) => Promise<number | null>) | null;
  readonly store: TradeStore;
}

/**
 * 本地速记优先:用户的固定行话(如「1.8 挂15蝴蝶 15CM」)不必等大模型,
 * 微秒级出与 LLM 同形的 payload,走完全相同的校验与执行路径。
 * 本地解析抛任何异常都静默回落到 LLM——快是锦上添花,不能成为新的故障点。
 * 回 null = 交给大模型。
 */
export async function tryLocalShorthand(
  host: ShorthandHost, instruction: string, snap: Record<string, number>, at: EtNow, meta?: ShorthandMeta,
): Promise<Rec | null> {
  let localPayload: Rec | null = null;
  let shorthandNote: string | null = null;
  try {
    if (looksLikeShorthand(instruction)) {
      // 没连券商时快照里没有现价,「15蝴蝶」的中心算不出来——
      // 用宏观行情带同款公开源兜底(^GSPC 就是 SPX 本尊,分钟级延迟)。
      const fetchSpot = host.publicPriceFn ?? publicIndexPrice;
      for (const sym of shorthandSymbols(instruction)) {
        // 「50蝴蝶」没写标的,上面的快照抽不到 SPX:先问券商(夜盘走期货推算),拿不到才退公开源。
        // 以前直接退公开源——那也是指数本身,夜盘一样是昨收,拿它推断看涨看跌会翻转
        // (2026-09-10 02:40 真机:昨收 7636.36 推成看涨,ES 推算的真实现价 7658 该是看跌)。
        if ((snap[sym] === undefined || snap[sym] === null) && host.router !== null) {
          try {
            const price = await host.router.indexPrice(sym);
            if (price !== null) snap[sym] = price;
          } catch {
            /* 券商取价失败:照旧退公开源 */
          }
        }
        if (snap[sym] === undefined || snap[sym] === null) {
          const price = await fetchSpot(sym);
          if (price !== null) {
            snap[sym] = price;
            shorthandNote = "现价来自公开数据源(可能延迟数分钟),请核对中心行权价与方向";
          }
        }
        // 现价不是官方指数实时价时要说出来:推算的写明怎么推的,昨收的明说是昨收
        const info = host.router?.spotInfo?.(sym) ?? null;
        if (!shorthandNote && info?.["source"] === "futures") {
          shorthandNote = `现价 ${pyRound(Number(info["price"]), 2)}:${String(info["note"])}`;
        } else if (!shorthandNote && info?.["source"] === "index_stale") {
          shorthandNote = `${String(info["note"])}——请核对中心行权价与看涨看跌`;
        }
      }
    }
    localPayload = tryParseShorthand(instruction, snap, at, meta);
    if (localPayload !== null && shorthandNote) {
      for (const item of localPayload["orders"] as Rec[]) {
        (item["warnings"] as string[]).push(shorthandNote);
      }
    }
  } catch {
    localPayload = null;
  }

  if (localPayload === null && looksLikeShorthand(instruction)) {
    // 观测点:哪条蝴蝶写法没被本地语法接住(落到大模型)。
    // 不影响任何行为,只为日后照着真实落网样本扩语法。
    host.store.audit("engine", "shorthand_fallback", { instruction: instruction.slice(0, 120) });
  }
  return localPayload;
}
