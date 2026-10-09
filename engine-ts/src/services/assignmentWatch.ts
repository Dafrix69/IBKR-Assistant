/** 到期日空头腿的指派提醒(docs/features/assignment-alert.md):收盘前那一段,账户里今天到期、实物交割的空头期权腿
 *  在实值里就提醒一次。只提醒,不发单——平掉一条空头腿可能把一个价差拆成裸腿,这个决定留给人。
 *
 * 判断在 assignmentRisk.ts(纯函数);这里管节拍、去哪读持仓与现价、同一条腿一天只说一次。
 */
import { nowEt } from "../config.js";
import type { EtNow } from "../config.js";
import { assignmentNotices, expiringOptionLegs, noticeText } from "../assignmentRisk.js";
import type { PositionRow } from "../contract/positions.js";
import { ServiceBase } from "./host.js";

/** 提醒要用的两样;富途的 router 没有常驻报价流时现价按拿不到算。 */
interface WatchSource {
  sessions(): unknown[];
  positions(): Promise<PositionRow[]>;
  streamQuotes?: (symbols: string[]) => Promise<Record<string, { last?: unknown }>>;
}

export class AssignmentWatchService extends ServiceBase {
  /** 多久看一次 */
  static readonly TICK_MS = 60_000;
  /** 收盘前多少分钟开始看:够人反应、又不至于一早就拿一个还会变的价来吵。这是提醒的时点,不进任何价格与盈亏 */
  static readonly LEAD_MINUTES = 30;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private gen = 0;
  private running = false;
  /** 今天已经说过的腿(`日期|持仓 key|有没有现价`);换了一天就清 */
  private readonly told = new Set<string>();
  private toldDate = "";

  start(tickMs: number = AssignmentWatchService.TICK_MS): void {
    if (this.running) return;
    const gen = ++this.gen;
    this.running = true;
    const schedule = (): void => {
      const timer = setTimeout(() => void loop(), tickMs);
      timer.unref?.();
      this.timer = timer;
    };
    const loop = async (): Promise<void> => {
      await this.tickOnce().catch(() => undefined);
      if (gen !== this.gen || !this.running) return;
      schedule();
    };
    schedule();
  }

  stop(): void {
    this.gen += 1;
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** 这一刻在不在"收盘前那一段"里(提前收盘日按 13:00 收)。 */
  inWindow(at: EtNow): boolean {
    const close = this.settings.early_close_days.includes(at.date) ? 13 * 60 : 16 * 60;
    return at.minutes >= close - AssignmentWatchService.LEAD_MINUTES && at.minutes < close;
  }

  /** 一轮:返回这一轮发了几条提醒。不在时段里、没连券商、读不到持仓都是 0。 */
  async tickOnce(at: EtNow = nowEt()): Promise<number> {
    if (!this.inWindow(at)) return 0;
    const router = this.router as unknown as WatchSource | null;
    if (router === null || !router.sessions().length) return 0;
    let rows: PositionRow[];
    try {
      rows = await router.positions();
    } catch {
      return 0; // 读不到持仓:下一轮再看
    }
    const legs = expiringOptionLegs(rows, at.date.replaceAll("-", ""), (symbol) => this.settings.indexConfig(symbol) !== null);
    const symbols = [...new Set(legs.filter((l) => l.quantity < 0).map((l) => l.symbol))];
    if (!symbols.length) return 0;
    const spots: Record<string, number | null> = {};
    try {
      const quotes = typeof router.streamQuotes === "function" ? await router.streamQuotes(symbols) : {};
      for (const symbol of symbols) {
        const last = Number(quotes[symbol]?.last);
        spots[symbol] = Number.isFinite(last) && last > 0 ? last : null;
      }
    } catch {
      /* 拿不到现价:照样提醒"今天到期,自己看一眼" */
    }
    if (this.toldDate !== at.date) {
      this.told.clear();
      this.toldDate = at.date;
    }
    let sent = 0;
    for (const notice of assignmentNotices(legs, spots)) {
      // 同一条腿:没有现价时说一次,有了现价、在实值里再说一次;之后不重复
      const fresh = notice.legs.filter((l) => !this.told.has(`${l.key}|${notice.spot === null ? "blind" : "itm"}`));
      if (!fresh.length) continue;
      for (const leg of notice.legs) this.told.add(`${leg.key}|${notice.spot === null ? "blind" : "itm"}`);
      const text = noticeText(notice);
      this.engine.store.audit("engine", "assignment_risk", {
        account: notice.account, symbol: notice.symbol, spot: notice.spot, net_shares: notice.net_shares,
        legs: notice.legs.map((l) => ({ strike: l.strike, right: l.right, quantity: l.quantity, itm_by: l.itm_by })),
      });
      try {
        this.engine.notifier.notify("到期日:空头腿可能被指派", text, notice.symbol);
      } catch {
        /* 通知发不出去不影响下一条 */
      }
      this.emit("assignment_risk", { account: notice.account, symbol: notice.symbol, text });
      sent += 1;
    }
    return sent;
  }
}
