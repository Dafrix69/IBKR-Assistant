/** 价位提醒:算价位(期权墙 + 趋势位 + 整数关口)、盯穿越、盯上了就自动补价位;
 * 外加「短期内反复碰同一条日均线」——底账每天从日线算一次,盘中拿现价补今天(docs/features/ma-touch.md)。
 *
 * 状态机与价位算法在 alerts.ts、碰均线在 maTouch.ts(都是纯计算);这里是它们的编排:取行情、落库、推事件、按标的退避。
 */
import type { AlertLevel, PriceSample } from "../alerts.js";
import { etNowFromEpoch, nowEt } from "../config.js";
import type {
  AlertsPollResult, AlertsRefreshParams, AlertsRefreshResult, CrossConfirm, LevelState, MaTouchConfig, TouchBook, Watch,
  WatchEvent, WatchLevel,
} from "../contract/alerts.js";
import type { OptionWall } from "../contract/options.js";
import {
  DEFAULT_TOUCH_CONFIG, bookUsable, buildTouchBook, evaluateTouches, normalizeTouchConfig, prevTradingDay,
} from "../maTouch.js";
import { pyRound } from "../py.js";
import { signalFromWatchEvent } from "../signalOutcomes.js";
import { RpcError, errText } from "../rpcError.js";
import { utcIso } from "../tz.js";
import { ServiceBase } from "./host.js";
import type { Rec, ServiceHost } from "./host.js";
import type { MarketDataService } from "./marketData.js";

/** 步长:0 = 自动,正数 = 固定步长(上限同 store.addWatch)。数字串也认。 */
function stepOrRaise(raw: unknown): number {
  const step = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof step !== "number" || !(step >= 0 && step <= 1000)) {
    throw new RpcError(-32602, "整数关口步长必须在 0~1000 之间(0 = 自动)");
  }
  return step;
}

/** 库里读回来的一个价位:类型上是 WatchLevel,运行时照旧逐项兜底(老库、手改过的行)。 */
function storedLevel(l: WatchLevel): AlertLevel {
  const ma = l["ma"];
  const live = ma && Number.isFinite(Number(ma["period"])) && Number.isFinite(Number(ma["prior_sum"]))
    ? { ma: { period: Number(ma["period"]), prior_sum: Number(ma["prior_sum"]) } }
    : {};
  return {
    price: Number(l["price"]),
    label: String(l["label"] ?? ""),
    source: String(l["source"] ?? "round"),
    kind: l["kind"] === "resistance" || l["kind"] === "support" ? l["kind"] : "pivot",
    priority: 0,
    ...live,
  };
}

/**
 * 均线价位的收盘和以碰均线的底账为准——只要底账是上一个交易日收盘的(as_of = prevDay)。
 * 开盘后价位还没轮到重算的那几分钟,底账往往已经补成今天的了:两边各用各的和,同一条线就有了两个位置。
 * 底账旧了、没有这条线,就用价位自己带的那个和。
 */
function withBookSums<L extends WatchLevel>(levels: L[], book: TouchBook | null, prevDay: string): L[] {
  if (!book || book.as_of !== prevDay) return levels;
  return levels.map((l) => {
    const line = l.ma ? book.lines.find((x) => x.period === l.ma?.period) : undefined;
    return line && l.ma ? { ...l, ma: { period: l.ma.period, prior_sum: line.prior_sum } } : l;
  });
}

/** 库里读回来的一个价位状态;待确认的那一笔四样都对才带着(收盘那两样成对才带)。 */
function storedState(v: LevelState): LevelState {
  const out: LevelState = { armed: Boolean(v["armed"] ?? true), last_fired_at: v["last_fired_at"] ?? null };
  const p = v["pending"];
  const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
  if (p && (p["direction"] === "up" || p["direction"] === "down") && num(p["from"]) && num(p["at"]) && num(p["minute"])) {
    out.pending = { direction: p["direction"], from: p["from"], at: p["at"], minute: p["minute"] };
    if (num(p["close"]) && num(p["close_at"])) Object.assign(out.pending, { close: p["close"], close_at: p["close_at"] });
  }
  return out;
}

export class AlertsService extends ServiceBase {
  constructor(host: ServiceHost, private readonly market: MarketDataService) {
    super(host);
  }

  /** 重算某个标的的期权墙、趋势位与价位。两者都是加分项——降级可以,不能悄悄降级。
   *  nowMs 记成 levels_at(价位是什么时候算的);自动算那一轮传它自己的时刻,和判断新旧用的是同一个钟。 */
  async refresh(params: AlertsRefreshParams, nowMs: number = nowEt().epochMs): Promise<AlertsRefreshResult> {
    const { buildLevels, levelDict, trendSnapshot } = await import("../alerts.js");

    const watch = this.engine.store.getWatch(String(params["id"] ?? ""));
    if (watch === null) throw new RpcError(-32602, "没有这个警告");
    const expiry = String(params["expiry"] ?? watch["expiry"] ?? "").trim() || null;
    // 顺带改步长(0 = 自动):这一次按新步长算,和算出来的价位一起落库——现价都取不到的那一次什么都不写,
    // 步长也不该先改掉(界面上那个选择框跟着库走,库里改了、价位没换,两边就对不上)
    const step = params["step"] === undefined ? Number(watch["step"]) : stepOrRaise(params["step"]);

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

    // 今天(美东)那根日线不算完整日线:和碰均线的底账(saveTouchBook)用同一天,两边的收盘和才是同一个数
    const today = nowEt().date;
    const levels = buildLevels(spot, wall, step, undefined, undefined, history, today);
    this.engine.store.updateWatch(watch["id"], {
      step,
      levels: levels.map(levelDict),
      wall,
      expiry: wall?.expiry ?? "",
      last_price: spot,
      levels_at: utcIso(nowMs - (nowMs % 1000)), // 到秒,和库里别的时刻一个写法
    });
    // 日线已经在手上了,碰均线的底账顺手算掉,不再为它单独拉一次
    if (history) this.saveTouchBook(watch["id"], history, today);
    return {
      watch: this.engine.store.getWatch(watch["id"]),
      wall_error: wallError,
      history_error: historyError,
      trend: history ? trendSnapshot(history, spot, undefined, undefined, today) : null,
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

  /** 这只股的价位该算了吗。刚试过的先退避;一条价位都没有就算(开盘前热身的 10 分钟也算);
   *  有价位的只认今天开盘之后算的——均线、52 周位隔夜会变,盘前的现价也不是开盘后的价。
   *  新旧只看 levels_at:updated_at 每一轮 poll 写现价时都会被盖掉,说明不了价位是哪天算的。 */
  private needsLevels(watch: Watch, nowMs: number, openMs: number): boolean {
    if (!watch["enabled"]) return false;
    const tried = this.levelTried.get(String(watch["symbol"]));
    if (tried !== undefined && nowMs - tried < AlertsService.LEVELS_BACKOFF_MS) return false;
    if (!(watch["levels"] ?? []).length) return true;
    // 旧价位等开盘再重算:热身时段算了,09:30 一过它又成了开盘前算的,一天要多打一遍期权链。
    // 休市日 openMs 是无穷大,整天都在这里拦下
    if (nowMs < openMs) return false;
    const at = Date.parse(watch["levels_at"]);
    return !Number.isFinite(at) || at < openMs;
  }

  /** 一轮最多挑 1 只去算(连着券商、在时段内才做)。回算了哪只,这一轮没算回 null。 */
  async tickLevels(nowMs: number, inWindow: boolean): Promise<string | null> {
    if (!inWindow || this.router === null || !this.router.sessions().length) return null;
    const et = etNowFromEpoch(nowMs);
    // 今天美东 09:30 那一刻。周末、假日异动循环不在时段内,走不到这里;万一走到,休市日没有开盘:
    // 有价位的一律不重算,留到下一个交易日开盘后
    const openMs = this.settings.isTradingDay(et.date)
      ? nowMs - (et.seconds - 9.5 * 3600) * 1000
      : Number.POSITIVE_INFINITY;
    const watch = this.engine.store.listWatches().find((w) => this.needsLevels(w, nowMs, openMs));
    if (watch === undefined) return null;
    const symbol = String(watch["symbol"]);
    // 成功失败都先记一次:失败的那只退避 10 分钟再试,不能每 5 秒去打一次期权链
    this.levelTried.set(symbol, nowMs);
    try {
      const out = await this.refresh({ id: watch["id"] }, nowMs);
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

  // ---- 穿越:上一笔价、确认方式 --------------------------------------------
  static readonly CROSS_CONFIRM_PREF = "alerts.cross_confirm";
  /** symbol → 上一轮取到的价。只在内存里:判穿越要的是"紧挨着的上一笔",库里那个 last_price 可能是昨天的、
   *  也可能是引擎重启之前的——隔夜跳空、关了一上午再打开,都不是穿越。接不接得上由 alerts.linkSample 判。 */
  private readonly lastSamples = new Map<string, PriceSample>();

  /** 穿越怎么才算数。没设过、存坏了都是 immediate(跨过就报)。 */
  crossConfirm(): CrossConfirm {
    return this.engine.store.getPref(AlertsService.CROSS_CONFIRM_PREF) === "bar_close" ? "bar_close" : "immediate";
  }

  /** 给界面的盯单:均线价位换成按最近一次取价算的那个值(价位条上画的和判穿越用的是同一条线)。不写库。 */
  async listWatches(): Promise<Watch[]> {
    const { levelPriceAt } = await import("../alerts.js");
    const prevDay = this.prevDay(nowEt().date);
    return this.engine.store.listWatches().map((w) => {
      const spot = w["last_price"];
      if (!spot || !w["levels"].some((l) => l["ma"])) return w;
      const levels = withBookSums(w["levels"], w["touch"], prevDay);
      return { ...w, levels: levels.map((l) => (l["ma"] ? { ...l, price: pyRound(levelPriceAt(l, spot), 4) } : l)) };
    });
  }

  // ---- 短期内反复碰均线 --------------------------------------------------
  static readonly TOUCH_CONFIG_PREF = "alerts.touch_config";
  /** 底账算过(或算失败)的标的按 symbol 退避这么久:只拉一次日线,但拿不到日线的股(没权限、刚上市)
   *  不该每 5 秒去打一次历史数据——IB 是 10 分钟 60 次。 */
  static readonly TOUCH_BACKOFF_MS = 1_800_000;
  private readonly touchTried = new Map<string, number>();
  /** symbol → 本交易日上一轮的价。两轮之间跨过均线也算碰,但只和**同一天**的比:
   *  库里的 last_price 可能是昨天收盘,隔夜跳空跨过均线不是"碰"。 */
  private readonly sessionPrices = new Map<string, { date: string; price: number }>();

  touchConfig(): MaTouchConfig {
    const raw = this.engine.store.getPref(AlertsService.TOUCH_CONFIG_PREF);
    if (raw === null) return structuredClone(DEFAULT_TOUCH_CONFIG);
    try {
      return normalizeTouchConfig(raw, structuredClone(DEFAULT_TOUCH_CONFIG));
    } catch {
      return structuredClone(DEFAULT_TOUCH_CONFIG);
    }
  }

  /** 设置改了:底账口径对不上的会在接下来几轮重算,别让退避把它们拦上半小时。 */
  touchConfigChanged(): void {
    this.touchTried.clear();
  }

  private prevDay(date: string): string {
    return prevTradingDay(date, (d) => this.settings.isTradingDay(d));
  }

  /** 从日线算底账写回库。读「报过哪段」和写回之间没有 await:不会和 poll 里写 fired 的那一下交错。 */
  private saveTouchBook(watchId: string, history: ReadonlyArray<Record<string, unknown>>, today: string): void {
    const latest = this.engine.store.getWatch(watchId);
    if (latest === null) return; // 算的途中被删了
    const book = buildTouchBook(history, today, this.touchConfig(), latest["touch"]?.fired ?? {});
    this.engine.store.updateWatch(watchId, { touch: book });
  }

  /**
   * 一轮最多给 1 只补碰均线的底账(只拉日线,不碰期权链)。价位那一步(tickLevels)这一轮没干活才轮到它,
   * 两样加起来一轮还是最多一次历史请求。底账旧了(不是上一个交易日收盘的)、口径改过、还没有,才算。
   */
  async tickTouch(nowMs: number, inWindow: boolean): Promise<string | null> {
    if (!inWindow || this.router === null || !this.router.sessions().length) return null;
    const config = this.touchConfig();
    if (!config.enabled) return null;
    const et = etNowFromEpoch(nowMs);
    if (!this.settings.isTradingDay(et.date)) return null; // 周末不算:下个交易日盘前再算
    const prevDay = this.prevDay(et.date);
    const watch = this.engine.store.listWatches().find((w) => {
      if (!w["enabled"] || bookUsable(w["touch"], config, prevDay)) return false;
      const tried = this.touchTried.get(String(w["symbol"]));
      return tried === undefined || nowMs - tried >= AlertsService.TOUCH_BACKOFF_MS;
    });
    if (watch === undefined) return null;
    const symbol = String(watch["symbol"]);
    this.touchTried.set(symbol, nowMs);
    try {
      this.saveTouchBook(watch["id"], await this.market.dailyHistory(symbol), et.date);
    } catch {
      // 日线拿不到:这只今天不判碰均线,半小时后再试。价位那边的降级原因照旧由 refresh 报
    }
    return symbol;
  }

  /** 此刻该不该判碰均线:开着、交易日的常规时段(半日市 13:00 收)。盘前盘后的价不算"今天那根"。 */
  private touchSession(): { config: MaTouchConfig; today: string; prevDay: string } | null {
    const config = this.touchConfig();
    if (!config.enabled) return null;
    const et = nowEt();
    if (!this.settings.isTradingDay(et.date)) return null;
    const close = this.settings.early_close_days.includes(et.date) ? 13 * 3600 : 16 * 3600;
    if (et.seconds < 9.5 * 3600 || et.seconds >= close) return null;
    return { config, today: et.date, prevDay: this.prevDay(et.date) };
  }

  /**
   * 一只股这一轮碰没碰均线。报了就把「报过哪段」写回底账,并把同一条均线这一轮的穿越并掉——
   * 第三次碰 20 日线时价格往往也正好穿过 20 日线,同一件事不说两遍。
   *
   * **谁认领是定死的**:这一轮碰均线报了哪条线(来源键 maX),那条线的穿越就归它,哪怕价已经穿到线的另一侧。
   * 成绩单(signalOutcomes)因此一件事只记一笔:碰均线押回头(从哪边来回哪边去),没被认领的穿越押顺势。
   * 碰均线不判的时候(关着、盘前盘后、底账旧了、这一段报过了、次数没凑够)不认领,穿越照自己的规矩报。
   */
  private touchEvents(
    watch: Watch, price: number, crossings: WatchEvent[], session: { config: MaTouchConfig; today: string; prevDay: string },
    at: number, book: TouchBook | null,
  ): { events: WatchEvent[]; book: TouchBook | null } {
    const symbol = String(watch["symbol"]);
    const prev = this.sessionPrices.get(symbol);
    const prevPrice = prev !== undefined && prev.date === session.today ? prev.price : null;
    this.sessionPrices.set(symbol, { date: session.today, price });
    if (!bookUsable(book, session.config, session.prevDay)) return { events: crossings, book: null };
    const { hits, fired } = evaluateTouches(book, session.config, price, prevPrice, session.today);
    if (!hits.length) return { events: crossings, book: null };
    const merged = new Set(hits.map((h) => `ma${h.period}`));
    const touches: WatchEvent[] = hits.map((h) => ({
      symbol,
      trigger: "touch",
      price: h.ma,
      label: h.label,
      source: `ma${h.period}`,
      kind: h.side === "above" ? "support" : "resistance",
      direction: h.direction,
      from: pyRound(prevPrice ?? price, 4),
      to: pyRound(price, 4),
      at,
      text: h.text,
    }));
    return { events: [...crossings.filter((c) => !merged.has(c["source"])), ...touches], book: { ...book, fired } };
  }

  /** 把每个在盯的标的走一遍状态机,触发的价位推成通知。 */
  async poll(): Promise<AlertsPollResult> {
    const { evaluate, levelKey, linkSample, reroundLevels } = await import("../alerts.js");

    const fired: WatchEvent[] = [];
    const checked: AlertsPollResult["checked"] = [];
    const watching = this.engine.store.listWatches().filter((w) => w["enabled"] && w["levels"].length);
    // 一轮的价一次取齐(quotesOf):逐只取每只要等一拍,23 只就是 3.5 秒占着交易道
    const quotes = await this.market.quotesOf(watching.map((w) => w["symbol"]));
    const session = this.touchSession();
    // 这一轮的时刻:事件的 at、冷却、"那一分钟收完没有"、上一笔接不接得上,用的是同一个钟
    const now = nowEt();
    const nowTs = now.epochMs / 1000;
    const confirm = this.crossConfirm();
    const prevDay = this.prevDay(now.date);
    for (const listed of watching) {
      const symbol = listed["symbol"];
      const quote = quotes.get(symbol) ?? null;
      if (quote === null) {
        checked.push({ symbol, price: null });
        continue;
      }
      const price = quote.price;
      // 盯单现读一次:前面等行情那一下,价位可能刚被重算、底账可能刚换成今天的,盯单也可能被删了。
      // 从这里到写回之间没有 await,不会和重算交错
      const watch = this.engine.store.getWatch(listed["id"]);
      if (watch === null || !watch["levels"].length) continue;

      const book = watch["touch"];
      const levels = withBookSums(watch["levels"].map(storedLevel), book, prevDay);
      const states: Record<string, LevelState> = {};
      for (const [k, v] of Object.entries(watch["states"] ?? {})) states[k] = storedState(v);
      // 这个价属于哪一段:券商给了最后成交的时刻就按那一刻认(钟过了 09:30,手上的价可能还是盘前的),没给按此刻认;
      // 指数再加价的出处——期货推算和官方指数是两个数,换出处的那一下不是行情在走
      const when = quote.tradedAt !== null ? etNowFromEpoch(quote.tradedAt * 1000) : now;
      const label = `${when.date}|${this.settings.marketStatus(when)}${quote.source ? `|${quote.source}` : ""}`;
      // 上一笔接得上、而且是这一段里的真价才比穿越;否则这一笔只登记(alerts.linkSample)
      const { sample, prevPrice } = linkSample(
        this.lastSamples.get(symbol), { at: nowTs, price, session: label, tradedAt: quote.tradedAt },
      );
      this.lastSamples.set(symbol, sample);
      const [crossings, nextStates] = evaluate(levels, states, prevPrice, price, nowTs, undefined, undefined, confirm);
      const history: WatchEvent[] = watch["events"] ?? [];
      let events: WatchEvent[] = crossings.map((c) => ({ ...c, symbol, trigger: "cross" as const }));
      let touchBook: TouchBook | null = null;
      // 碰均线同样只拿坐实了的价判:开盘那一笔还没进来时手上是盘前的价,它贴着均线不等于今天碰到了
      if (session !== null && sample.settled) {
        ({ events, book: touchBook } = this.touchEvents(watch, price, events, session, nowTs, book));
      }
      // 碰均线在容差以内就报了,价格往往几轮之后才真穿过那条线:把那条线的穿越落防(等确认的那一笔一起作废),
      // 免得隔几十秒再报一遍。落防不是删掉——离开够远、过了冷却照常重新上膛(alerts.ts 的状态机)
      const touched = new Set(events.filter((e) => e["trigger"] === "touch").map((e) => e["source"]));
      for (const level of levels) {
        if (touched.has(level.source)) nextStates[levelKey(level)] = { armed: false, last_fired_at: nowTs };
      }
      for (const event of events) {
        // 只进通知流(订单看板下面那条),不走系统通知:穿越的"弹"由桌面端的置顶弹窗负责,
        // 两边都弹就是同一件事说两遍(macOS 上尤其明显)
        const title = event["trigger"] === "touch"
          ? `${symbol} 反复碰 ${event["label"]}`
          : `${symbol} ${event["direction"] === "up" ? "上穿" : "下破"}`;
        this.engine.notifier.notify(title, String(event["text"]), "", { os: false });
      }
      // 现价走出了上下两个整数关口之间:这一对跟着换(刚穿过的那个留着,状态按键原样带着)。
      // 放在判完这一轮之后:穿过旧的那个关口先按旧的一对报
      const rerounded = reroundLevels(watch["levels"], price, Number(watch["step"]));
      if (rerounded !== null) {
        const keep = new Set(rerounded.map((l) => levelKey(l)));
        for (const key of Object.keys(nextStates)) if (!keep.has(key)) delete nextStates[key];
      }
      this.engine.store.updateWatch(watch["id"], {
        last_price: price,
        states: nextStates,
        events: [...history, ...events].slice(-50),
        ...(rerounded !== null ? { levels: rerounded } : {}),
        ...(touchBook !== null ? { touch: touchBook } : {}),
      });
      fired.push(...events);
      checked.push({ symbol, price });
    }

    if (fired.length) {
      // 每条发出去的都记一笔,之后按 1 / 5 / 20 天的走势打分(信号成绩单,signalOutcomes.ts)
      this.engine.store.signals.log(fired.map(signalFromWatchEvent));
      this.emit("alerts", { events: fired });
    }
    return { fired, checked };
  }

  /** 这只股不盯价位了:退避与失败原因一起忘掉,重新打开时从头算。 */
  forget(symbol: string): void {
    this.levelTried.delete(symbol);
    this.levelNotes.delete(symbol);
    this.touchTried.delete(symbol);
    this.sessionPrices.delete(symbol);
    this.lastSamples.delete(symbol);
  }
}
