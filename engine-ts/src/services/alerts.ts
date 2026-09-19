/** 价位提醒:算价位(期权墙 + 趋势位 + 整数关口)、盯穿越、盯上了就自动补价位。
 *
 * 状态机与价位算法在 alerts.ts(纯计算);这里是它的编排:取行情、落库、推事件、按标的退避。
 */
import type { AlertLevel } from "../alerts.js";
import { etNowFromEpoch } from "../config.js";
import type {
  AlertsPollResult, AlertsRefreshParams, AlertsRefreshResult, LevelState, Watch, WatchEvent,
} from "../contract/alerts.js";
import type { OptionWall } from "../contract/options.js";
import { RpcError, errText } from "../rpcError.js";
import { ServiceBase } from "./host.js";
import type { Rec, ServiceHost } from "./host.js";
import type { MarketDataService } from "./marketData.js";

export class AlertsService extends ServiceBase {
  constructor(host: ServiceHost, private readonly market: MarketDataService) {
    super(host);
  }

  /** 重算某个标的的期权墙、趋势位与价位。两者都是加分项——降级可以,不能悄悄降级。 */
  async refresh(params: AlertsRefreshParams): Promise<AlertsRefreshResult> {
    const { buildLevels, levelDict, trendSnapshot } = await import("../alerts.js");

    const watch = this.engine.store.getWatch(String(params["id"] ?? ""));
    if (watch === null) throw new RpcError(-32602, "没有这个警告");
    const expiry = String(params["expiry"] ?? watch["expiry"] ?? "").trim() || null;

    let wall: OptionWall | null = null;
    let wallError: string | null = null;
    let spot: number;
    try {
      wall = await this.market.wallFor(watch["symbol"], expiry);
      spot = wall["spot"];
    } catch (exc) {
      wallError =
        exc instanceof RpcError ? exc.message : String((exc as Error).message).slice(0, 300);
      const fallback = await this.market.spotOf(watch["symbol"]);
      if (!fallback) {
        throw new RpcError(
          -32017, `拿不到 ${watch["symbol"]} 的现价,警告无法设置。${wallError}`,
        );
      }
      spot = fallback;
    }

    // 趋势位(均线/52周高低点):历史 K 线拿不到时按老规矩降级继续,原因带回界面
    let history: Rec[] | null = null;
    let historyError: string | null = null;
    try {
      history = await this.market.dailyHistory(watch["symbol"]);
    } catch (exc) {
      historyError =
        exc instanceof RpcError ? exc.message : String((exc as Error).message).slice(0, 300);
    }

    const levels = buildLevels(spot, wall, Number(watch["step"]), undefined, undefined, history);
    this.engine.store.updateWatch(watch["id"], {
      levels: levels.map(levelDict),
      wall,
      expiry: wall?.expiry ?? "",
      last_price: spot,
    });
    return {
      watch: this.engine.store.getWatch(watch["id"]),
      wall_error: wallError,
      history_error: historyError,
      trend: history ? trendSnapshot(history, spot) : null,
    };
  }

  // ---- 价位自动算:盯上了就该有价位 --------------------------------------
  // 以前只有用户点「重算墙」才算,默认开两个开关之后这个洞更明显:新开的盯单价位是空的,
  // 均线也会隔夜变旧。捎带在异动那一轮里做,**不另起循环**。
  /** 算过(或算失败)的标的按 symbol 退避这么久再试:期权链一次几十条行情线路,
   *  IB 的历史数据还有 10 分钟 60 次的限速,一轮连算多只会把额度烧光。 */
  static readonly LEVELS_BACKOFF_MS = 600_000;
  /** symbol → 上一次尝试算价位的时刻(退避用)。 */
  private readonly levelTried = new Map<string, number>();
  /** symbol → 上一次的失败 / 降级原因:降级可以,不能悄悄降级。 */
  private readonly levelNotes = new Map<string, string>();

  /** 这只股的价位该算了吗:没算过、或还是今天开盘前算的(均线、52 周位会隔夜变旧)。刚试过的先退避。 */
  private needsLevels(watch: Watch, nowMs: number, openMs: number): boolean {
    if (!watch["enabled"]) return false;
    const tried = this.levelTried.get(String(watch["symbol"]));
    if (tried !== undefined && nowMs - tried < AlertsService.LEVELS_BACKOFF_MS) return false;
    if (!(watch["levels"] ?? []).length) return true;
    const at = Date.parse(String(watch["updated_at"] ?? ""));
    return !Number.isFinite(at) || at < openMs;
  }

  /** 一轮最多挑 1 只去算(连着券商、在时段内才做)。回算了哪只,这一轮没算回 null。 */
  async tickLevels(nowMs: number, inWindow: boolean): Promise<string | null> {
    if (!inWindow || this.router === null || !this.router.sessions().length) return null;
    const et = etNowFromEpoch(nowMs);
    const openMs = nowMs - (et.seconds - 9.5 * 3600) * 1000; // 今天美东 09:30 那一刻
    const watch = this.engine.store.listWatches().find((w) => this.needsLevels(w, nowMs, openMs));
    if (watch === undefined) return null;
    const symbol = String(watch["symbol"]);
    // 成功失败都先记一次:失败的那只退避 10 分钟再试,不能每 5 秒去打一次期权链
    this.levelTried.set(symbol, nowMs);
    try {
      const out = await this.refresh({ id: watch["id"] });
      // 墙 / 日线取不到时价位照给(只是少了那部分),原因留着给界面显示
      const note = [out["wall_error"], out["history_error"]].filter(Boolean).map(String).join(";");
      if (note) this.levelNotes.set(symbol, note.slice(0, 200));
      else this.levelNotes.delete(symbol);
    } catch (exc) {
      this.levelNotes.set(symbol, errText(exc));
    }
    return symbol;
  }

  /** 价位算到哪一步了:ok = 有价位;pending = 还没算(界面显示「正在算价位…」);
   *  error:<原因> = 上一次算失败或降级了。没开「盯价位」的股没有这一说,回 null。 */
  levelsStatusOf(symbol: string): string | null {
    const watch = this.engine.store.listWatches().find((w) => String(w["symbol"]) === symbol);
    if (watch === undefined) return null;
    const note = this.levelNotes.get(symbol);
    if (note) return `error:${note}`;
    return (watch["levels"] ?? []).length ? "ok" : "pending";
  }

  /** 把每个在盯的标的走一遍状态机,触发的价位推成通知。 */
  async poll(): Promise<AlertsPollResult> {
    const { evaluate } = await import("../alerts.js");

    const fired: WatchEvent[] = [];
    const checked: AlertsPollResult["checked"] = [];
    for (const watch of this.engine.store.listWatches()) {
      if (!watch["enabled"] || !watch["levels"].length) continue;
      const price = await this.market.spotOf(watch["symbol"]);
      if (!price) {
        checked.push({ symbol: watch["symbol"], price: null });
        continue;
      }

      // 价位与状态是库里读回来的 JSON:类型上是 WatchLevel,运行时照旧逐项兜底(老库、手改过的行)
      const levels: AlertLevel[] = watch["levels"].map((l) => ({
        price: Number(l["price"]),
        label: String(l["label"] ?? ""),
        source: String(l["source"] ?? "round"),
        kind: l["kind"] === "resistance" || l["kind"] === "support" ? l["kind"] : "pivot",
        priority: 0,
      }));
      const states: Record<string, LevelState> = {};
      for (const [k, v] of Object.entries(watch["states"] ?? {})) {
        states[k] = {
          armed: Boolean(v["armed"] ?? true),
          last_fired_at: v["last_fired_at"] ?? null,
        };
      }
      const [crossings, nextStates] = evaluate(
        levels, states, watch["last_price"] ?? null, price, Date.now() / 1000,
      );
      const history: WatchEvent[] = watch["events"] ?? [];
      const events: WatchEvent[] = crossings.map((c) => ({ ...c, symbol: watch["symbol"] }));
      for (const event of events) {
        // 只进通知流(订单看板下面那条),不走系统通知:穿越的"弹"由桌面端的置顶弹窗负责,
        // 两边都弹就是同一件事说两遍(macOS 上尤其明显)
        this.engine.notifier.notify(
          `${watch["symbol"]} ${event["direction"] === "up" ? "上穿" : "下破"}`,
          String(event["text"]),
          "",
          { os: false },
        );
      }
      this.engine.store.updateWatch(watch["id"], {
        last_price: price,
        states: nextStates,
        events: [...history, ...events].slice(-50),
      });
      fired.push(...events);
      checked.push({ symbol: watch["symbol"], price });
    }

    if (fired.length) this.emit("alerts", { events: fired });
    return { fired, checked };
  }

  /** 这只股不盯价位了:退避与失败原因一起忘掉,重新打开时从头算。 */
  forget(symbol: string): void {
    this.levelTried.delete(symbol);
    this.levelNotes.delete(symbol);
  }
}
