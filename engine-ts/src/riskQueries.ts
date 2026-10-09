/** 校验与保护规则要从库里现算的三样:最近提交过的订单(重复单防抖)、最近的平仓(止损护栏与冷却)、
 * 已实现盈亏(回撤护栏与日内亏损上限)。从 store.ts 搬出来,口径未变;多带的字段见各自的注释。
 * 只读:这里一行都不写库。
 */
import type Database from "better-sqlite3";

import type { RecentOrder } from "./models.js";

type Row = Record<string, unknown>;

/** 一次平仓(audit_log 里引擎写的 auto_close / hosted_sweep / hosted_fill)。 */
export interface CloseRow {
  atMs: number;
  symbol: string;
  /** tracker 的 STATE_*(可能带 sweep: 前缀) */
  state: string;
  /** 平掉的那份持仓的腿身份(到期|各腿);正股是空串。带这一项之前留下的痕读出来也是空串 */
  leg: string;
}

/** 今天发出去(或进了盯盘队列)、还没有终态的一张指令单。 */
export interface WorkingOrder {
  /** 账户别名 */
  alias: string;
  contract: Row;
  order: Row;
  /** 校验时算的名义金额 / 最坏亏损(美元) */
  notional: number;
}

function parse(text: string): Row | null {
  try {
    const out: unknown = JSON.parse(text);
    return out !== null && typeof out === "object" ? out as Row : null;
  } catch {
    return null;
  }
}

export class RiskQueries {
  constructor(private readonly db: Database.Database) {}

  /** 重复防抖候选集:只统计真正提交过或进过盯盘队列的记录(ValidatedOnly 不算)。
   * 时间过滤在代码里做,不在 SQL 里做字符串比较——混合时区偏移下字典序不是时间序。
   * 带上那张单的限价与终态:重复单防抖要分清"它还挂着"和"它已经了结、这次是换了个价再来"。 */
  recentOrderDetails(windowMinutes: number, nowMs: number): Array<Required<RecentOrder>> {
    const windowMs = windowMinutes * 60_000;
    const rows = this.db
      .prepare(
        "SELECT signature, quantity, created_at, record_json," +
        " (SELECT f.payload FROM record_events f WHERE f.record_id = t.id AND f.kind = 'final'" +
        "   ORDER BY f.seq DESC LIMIT 1) AS final" +
        " FROM trade_records t" +
        " WHERE signature != ''" +
        " AND EXISTS (" +
        "   SELECT 1 FROM record_events e" +
        "   WHERE e.record_id = t.id AND (e.kind = 'submit_intent'" +
        "     OR (e.kind = 'status' AND e.payload NOT LIKE '%ValidatedOnly%'))" +
        " )" +
        " ORDER BY rowid DESC LIMIT 1000",
      )
      .all() as Array<{ signature: string; quantity: number; created_at: string; record_json: string; final: string | null }>;
    const out: Array<Required<RecentOrder>> = [];
    for (const row of rows) {
      // Date.parse:带偏移的 ISO 直接换算;naive 字符串按本机时区解释,
      // 与 Python 版"老记录若是 naive 按本机时钟补全"的语义一致
      const created = Date.parse(row.created_at);
      if (Number.isNaN(created)) continue;
      const delta = nowMs - created;
      if (delta > windowMs || delta < -windowMs) continue;
      const order = (parse(row.record_json)?.["order"] ?? {}) as Row;
      const limit = Number(order["lmtPrice"]);
      out.push({
        signature: row.signature, quantity: row.quantity, createdAtMs: created,
        limitPrice: order["lmtPrice"] === null || order["lmtPrice"] === undefined || !Number.isFinite(limit) ? null : limit,
        // 没有终态事件 = 还在途;终态事件读不出状态的按"有终态但不知道是哪种"记成空串
        finalStatus: row.final === null ? null : String(parse(row.final)?.["final_status"] ?? ""),
      });
    }
    return out;
  }

  /**
   * `sinceMs` 起提交过或进了盯盘队列、**还没有终态**的指令单(账户在手的两条累计上限要把它们算进去:挂着没成交的单、
   * 排队中的条件单,持仓里都还看不见)。持仓追踪发的平仓单不在里面——它们没有指纹。部分成交的整张都算:
   * 成交的那一部分同时也在持仓里,所以偏大,不会偏小。
   */
  workingOrders(sinceMs: number, nowMs: number): WorkingOrder[] {
    const rows = this.db
      .prepare(
        "SELECT created_at, record_json FROM trade_records t" +
        " WHERE signature != ''" +
        " AND NOT EXISTS (SELECT 1 FROM record_events f WHERE f.record_id = t.id AND f.kind = 'final')" +
        " AND EXISTS (" +
        "   SELECT 1 FROM record_events e" +
        "   WHERE e.record_id = t.id AND (e.kind = 'submit_intent'" +
        "     OR (e.kind = 'status' AND e.payload NOT LIKE '%ValidatedOnly%'))" +
        " )" +
        " ORDER BY rowid DESC LIMIT 1000",
      )
      .all() as Array<{ created_at: string; record_json: string }>;
    const out: WorkingOrder[] = [];
    for (const row of rows) {
      const created = Date.parse(row.created_at);
      if (Number.isNaN(created) || created < sinceMs || created > nowMs) continue;
      const record = parse(row.record_json);
      const alias = String(((record?.["account"] ?? {}) as Row)["alias"] ?? "");
      const contract = record?.["contract"], order = record?.["order"];
      if (!alias || contract === null || typeof contract !== "object" || order === null || typeof order !== "object") continue;
      const notional = Number(record?.["notional_estimate"]);
      out.push({ alias, contract: contract as Row, order: order as Row, notional: Number.isFinite(notional) ? notional : 0 });
    }
    return out;
  }

  /** `sinceMs` 起记下的「这个账户今天到过日内亏损上限」(engine/accountGuard.ts 写的 daily_loss_trip)。 */
  dailyLossTrips(sinceMs: number, nowMs: number): Array<{ alias: string; reason: string; untilMs: number }> {
    const rows = this.db
      .prepare("SELECT at, detail FROM audit_log WHERE actor='engine' AND action='daily_loss_trip' ORDER BY seq DESC LIMIT 200")
      .all() as Array<{ at: string; detail: string }>;
    const out: Array<{ alias: string; reason: string; untilMs: number }> = [];
    for (const row of rows) {
      const at = Date.parse(row.at);
      if (Number.isNaN(at) || at < sinceMs || at > nowMs) continue;
      const detail = parse(row.detail);
      const alias = String(detail?.["alias"] ?? ""), untilMs = Number(detail?.["until_ms"]);
      if (alias && Number.isFinite(untilMs)) out.push({ alias, reason: String(detail?.["reason"] ?? ""), untilMs });
    }
    return out;
  }

  /** 同上,只留老的三项(黄金基线钉着这个形状)。 */
  recentOrders(windowMinutes: number, nowMs: number): RecentOrder[] {
    return this.recentOrderDetails(windowMinutes, nowMs)
      .map(({ signature, quantity, createdAtMs }) => ({ signature, quantity, createdAtMs }));
  }

  /** 窗口内的平仓事件(保护规则用,见 protections.ts)。
   * 取的是 audit_log 里 engine 写的 auto_close / hosted_sweep:两条平仓路径各一个,都是只增的。
   * position_tracks 的 fired_state 不行——它一行一个持仓、就地更新,同一只标的平第二次就把第一次盖掉了。 */
  recentCloses(sinceMs: number, nowMs: number): CloseRow[] {
    const rows = this.db
      .prepare(
        "SELECT at, detail FROM audit_log" +
        // hosted_fill:券商侧自己触发的托管单成交(engine/hosted.ts)。股票最主要的止损路径就是它,以前不算
        " WHERE actor='engine' AND action IN ('auto_close','hosted_sweep','hosted_fill')" +
        " ORDER BY seq DESC LIMIT 2000",
      )
      .all() as Array<{ at: string; detail: string }>;
    const out: CloseRow[] = [];
    for (const row of rows) {
      const at = Date.parse(row.at);
      if (Number.isNaN(at) || at <= sinceMs || at > nowMs) continue;
      const detail = parse(row.detail);
      if (detail === null) continue;
      out.push({
        atMs: at,
        symbol: String(detail["symbol"] ?? ""),
        state: String(detail["state"] ?? ""),
        leg: String(detail["leg"] ?? ""),
      });
    }
    return out;
  }

  /** 窗口内的已实现盈亏(保护规则的回撤护栏用)。券商的佣金回报里带 realizedPNL,
   * 平仓那一笔才有值——这是全仓库唯一"券商认的"盈亏口径(见 tracker.md 盈亏以券商报的为准)。
   *
   * 同一 exec_id 只算**先到的那一条**,与 foldEvents 同口径。库里真有重复(2026-09-10 模拟盘 #89 一条佣金落了
   * 三次;引擎一重建 seenCommissions 就空了,交易分析一同步当天的佣金回报又会重推一遍),而这里以前逐行相加:
   * 亏 300 按 600 算,日内亏损上限被假触发,当天所有新单都被拦(2026-09-27 审计 H4)。
   * 先去重再按窗口筛:昨天落过、今天又被重推的那笔不许算进今天。没有 exec_id 的认不出是不是同一笔,照旧都算。 */
  realizedPnlEvents(sinceMs: number, nowMs: number): Array<{ atMs: number; pnl: number }> {
    const rows = this.db
      .prepare(
        "SELECT at, payload FROM record_events WHERE kind='commission' ORDER BY seq DESC LIMIT 2000",
      )
      .all() as Array<{ at: string; payload: string }>;
    const anonymous: Array<{ atMs: number; pnl: number }> = [];
    // 行是新的在前:同一 exec_id 后读到的更早,覆盖下来,留下的就是先到的那条
    const firstByExec = new Map<string, { atMs: number; pnl: number }>();
    for (const row of rows) {
      const at = Date.parse(row.at);
      if (Number.isNaN(at)) continue;
      const payload = parse(row.payload);
      if (payload === null) continue;
      const item = { atMs: at, pnl: Number(payload["realized_pnl"]) };
      const execId = String(payload["exec_id"] ?? "");
      if (execId) firstByExec.set(execId, item);
      else anonymous.push(item);
    }
    // IBKR 对开仓的佣金回报给一个哨兵大数(1.7976931348623157e308),不是真盈亏
    return [...anonymous, ...firstByExec.values()].filter((p) =>
      p.atMs > sinceMs && p.atMs <= nowMs && Number.isFinite(p.pnl) && Math.abs(p.pnl) < 1e307);
  }
}
