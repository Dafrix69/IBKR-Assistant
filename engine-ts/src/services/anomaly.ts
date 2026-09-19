/** 优质股异动监控:5 秒一轮的循环,连同它的样本、指标与心跳。
 *
 * 判定在 anomaly.ts(纯计算);这里是循环本身:读量能流 → 逐只判 → 状态落库 → 有事件就推给界面。
 * 不靠界面驱动——窗口最小化、切到别的页,放量照样当场报。
 */
import {
  DEFAULT_ANOMALY_CONFIG, coerceState, evaluateAnomalies, normalizeAnomalyConfig, pushSample,
} from "../anomaly.js";
import type { AnomalyConfig, AnomalyEvent, AnomalyState, Metrics, Sample } from "../anomaly.js";
import { etNowFromEpoch, nowEt } from "../config.js";
import type { VolumeSnapshot } from "../marketdata.js";
import type { AlertsService } from "./alerts.js";
import { ServiceBase } from "./host.js";
import type { Rec, ServiceHost } from "./host.js";

/** 异动监控对 router 的全部要求。富途的 router 也有这三样,只是 SUPPORTS_VOLUME_QUOTES 为 false。 */
interface VolumeQuoteSource {
  SUPPORTS_VOLUME_QUOTES?: boolean;
  volumeQuotes(symbols: string[]): Promise<Record<string, VolumeSnapshot & { error?: string }>>;
  releaseVolumeStreams(keep: string[]): number;
}

/** settings.marketStatus 的中文时段 → 异动监控的时段标记。 */
function anomalySessionOf(status: string): "rth" | "pre" | "post" | "closed" {
  if (status === "盘中") return "rth";
  if (status === "盘前") return "pre";
  if (status === "盘后") return "post";
  return "closed";
}

/** 键排序后的 JSON:比较"状态变没变"用,不受对象键顺序影响(否则每轮都白写一次库)。 */
function stableJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === "object") {
      const out: Rec = {};
      for (const k of Object.keys(v as Rec).sort()) out[k] = sort((v as Rec)[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value)) ?? "null";
}

/** 内存里最近一轮的指标(给界面画表);取不到行情时记原因。 */
export interface QualityMetricsHit { metrics: Metrics | null; at: string; error: string | null }

export class AnomalyService extends ServiceBase {
  constructor(host: ServiceHost, private readonly alerts: AlertsService) {
    super(host);
  }

  static readonly MAX_QUALITY = 30;
  /** 异动监控一轮的节拍。量能流是常驻的,一轮只是读内存里的最新值,5 秒足够跟上"放量"。 */
  static readonly ANOMALY_TICK_MS = 5000;
  /** 开盘前这么多分钟就把量能流订上:样本热起来,开盘第一轮就能判窗口 */
  static readonly ANOMALY_WARMUP_MINUTES = 10;
  /** 收盘后再留这么多分钟(延迟行情的最后一格要等 15 分钟才到) */
  static readonly ANOMALY_TAIL_MINUTES = 20;
  /** 延迟行情比实时晚这么多分钟 */
  static readonly DELAYED_SHIFT_MINUTES = 15;
  /** 最后一笔成交超过这么久没动:行情冻住了(流被撤、临时休市),本轮不判 */
  static readonly QUOTE_STALE_MS = 15 * 60_000;
  static readonly QUALITY_CONFIG_PREF = "quality.config";

  private anomalyTimer: ReturnType<typeof setTimeout> | null = null;
  /** 循环代数:stop 之后还在路上的那一轮跑完不许再排下一轮,也不许和新起的循环叠成两条。 */
  private anomalyGen = 0;
  /** 所有轮次排成一队:循环自己不会叠,测试 / 手动调 tickOnce 也不会和循环叠。 */
  private anomalyChain: Promise<unknown> = Promise.resolve();
  /** 心跳(与盯盘节拍器同一个口径):没在跑、太久没跳、上一轮报错,界面都要能看见。 */
  private readonly anomalyLoop: Rec = {
    running: false, interval_ms: AnomalyService.ANOMALY_TICK_MS, ticks: 0,
    last_at: null, last_ms: null, last_error: "", delayed: false,
  };
  /** 标的 → 最近 20 分钟的 (时刻, 当日量, 现价) 样本:窗口量 = 当日量之差,只在内存里。 */
  private readonly qualitySamples = new Map<string, Sample[]>();
  /** 标的 → 最近一轮的指标(给界面画表);取不到行情时记原因。 */
  private readonly qualityMetrics = new Map<string, QualityMetricsHit>();

  start(intervalMs: number = AnomalyService.ANOMALY_TICK_MS): void {
    if (this.anomalyLoop["running"]) return;
    const gen = ++this.anomalyGen;
    this.anomalyLoop["running"] = true;
    this.anomalyLoop["interval_ms"] = intervalMs;
    const schedule = (delay: number): void => {
      const timer = setTimeout(() => void loop(), delay);
      // 界面关了、stdin 断了,引擎进程该退就退,不能被这个循环吊着
      timer.unref?.();
      this.anomalyTimer = timer;
    };
    const loop = async (): Promise<void> => {
      const t0 = Date.now();
      await this.tickOnce().catch(() => undefined);
      if (gen !== this.anomalyGen || !this.anomalyLoop["running"]) return;
      // 下一轮在这一轮结束之后排:慢了就紧接着跑,不叠两轮;快了就补足到一个节拍
      schedule(Math.max(0, intervalMs - (Date.now() - t0)));
    };
    schedule(0);
  }

  stop(): void {
    this.anomalyGen += 1;
    this.anomalyLoop["running"] = false;
    if (this.anomalyTimer !== null) clearTimeout(this.anomalyTimer);
    this.anomalyTimer = null;
  }

  /**
   * 一轮异动监控:读一次量能流 → 每只股走一遍 evaluateAnomalies → 状态落库 → 有事件就推给界面。
   * 任何异常都吞掉记进 last_error,不许让循环停下。nowMs 缺省取调用那一刻(测试传固定时刻)。
   */
  tickOnce(nowMs?: number): Promise<Rec> {
    const run = this.anomalyChain.then(() => this.tickInner(nowMs ?? nowEt().epochMs));
    this.anomalyChain = run.catch(() => undefined);
    return run;
  }

  private async tickInner(nowMs: number): Promise<Rec> {
    const state = this.anomalyLoop;
    const t0 = Date.now();
    const prevError = String(state["last_error"] ?? "");
    const out: Rec = { events: [] as AnomalyEvent[], evaluated: [] as string[], skipped: "", levels: null };
    try {
      const router = this.router;
      if (router === null || !router.sessions().length) {
        // 断开之后内存里那份指标就是旧的了:留着界面会把上一次的价当成此刻的
        this.qualityMetrics.clear();
        this.qualitySamples.clear();
        out["skipped"] = "未连接券商";
        state["last_error"] = "";
        return out;
      }

      const et = etNowFromEpoch(nowMs);
      const sessionMinutes = this.settings.early_close_days.includes(et.date) ? 210 : 390;
      // 周末 / 假日的 09:30–16:00 按钟点算也落在"时段内",而流里还是上一个交易日的量价——
      // 周六上午会把周五的全天量当成"开盘一小时就放量 5 倍"报出来。非交易日一律当"已收盘":
      // 指标照算(就是上一个交易日的全天值),不报。
      const minute = this.settings.isTradingDay(et.date) ? (et.seconds - 9.5 * 3600) / 60 : sessionMinutes;
      const inWindow =
        minute >= -AnomalyService.ANOMALY_WARMUP_MINUTES &&
        minute < sessionMinutes + AnomalyService.ANOMALY_TAIL_MINUTES;
      // 「盯价位」开着就该有价位:捎带算 1 只。放在异动那几道闸之前——富途不支持异动、
      // 今天一只优质股都没启用,价位一样要算。
      out["levels"] = await this.alerts.tickLevels(nowMs, inWindow);

      const source = router as unknown as VolumeQuoteSource;
      if (source.SUPPORTS_VOLUME_QUOTES !== true) {
        this.qualityMetrics.clear();
        this.qualitySamples.clear();
        out["skipped"] = "当前券商不支持";
        state["last_error"] = "";
        return out;
      }
      const store = this.engine.store;
      const enabled = store.listQualityStocks().filter((s) => s["enabled"]);
      if (!enabled.length) {
        // 全停了 / 全删了:量能流一条不留,别占着行情线路
        source.releaseVolumeStreams([]);
        this.qualitySamples.clear();
        this.qualityMetrics.clear();
        state["delayed"] = false;
        state["last_error"] = "";
        out["skipped"] = "没有启用的优质股";
        return out;
      }

      // 收盘之后、开盘之前、非交易日:一条也不判,量能流全撤——30 只股就是 30 条行情线路
      // (总额度约 100 条),没有必要整夜整周末占着。开盘前 10 分钟重新订,让样本先热起来。
      if (!inWindow) {
        try {
          source.releaseVolumeStreams([]);
        } catch {
          /* 撤流失败不影响下一轮 */
        }
        this.qualitySamples.clear();
        state["last_error"] = "";
        out["skipped"] = "不在交易时段";
        return out;
      }
      const symbols = enabled.map((s) => String(s["symbol"]));
      let quotes: Record<string, VolumeSnapshot & { error?: string }>;
      try {
        quotes = (await source.volumeQuotes(symbols)) ?? {};
      } catch (exc) {
        state["last_error"] = `取行情失败:${String((exc as Error).message).slice(0, 200)}`;
        return out;
      }
      try {
        source.releaseVolumeStreams(symbols);
      } catch {
        /* 撤流失败不影响这一轮的判定 */
      }

      const config = this.config();
      // 等行情那一两秒里界面可能删了 / 停了某只股:按最新的库来,别给已经删掉的股报异动
      const latest = store.listQualityStocks().filter((s) => s["enabled"]);
      const at = new Date(nowMs).toISOString();
      const errors: string[] = [];
      let delayed = false;
      for (const stock of latest) {
        const symbol = String(stock["symbol"]);
        const snap = quotes[symbol];
        if (snap === undefined) continue;
        try {
          if (snap.error) {
            // 流被拒 / 标的认不出:最后那点数是旧的,拿它判异动会误报
            this.qualityMetrics.set(symbol, { metrics: null, at, error: String(snap.error) });
            continue;
          }
          const samples = pushSample(this.qualitySamples.get(symbol) ?? [], {
            t: nowMs, volume: snap.volume ?? null, last: snap.last ?? null,
          });
          this.qualitySamples.set(symbol, samples);
          // 刚订上的流:tick 23(历史波动率)往往第二轮才到,这一轮用固定阈值报一次会把档位占掉,
          // 之后按 σ 该报的反而报不出来。第一轮一律只算指标。
          const fresh = samples.length < 2;
          // 成交时间戳很久没动:流被别处撤掉、或者交易所临时休市(假期表里没有的那种)。
          // 拿冻住的数判异动会一路误报,这一轮只算指标,并把原因带回界面。
          const lastTradeAt = typeof snap.last_trade_at === "number" && Number.isFinite(snap.last_trade_at)
            ? snap.last_trade_at * 1000
            : null;
          const staleMs = lastTradeAt === null ? 0 : nowMs - lastTradeAt;
          const stale = lastTradeAt !== null && staleMs > AnomalyService.QUOTE_STALE_MS;
          // 延迟行情(没有实时权限的会话)看到的是 15 分钟前的量价:时钟跟着往回拨,
          // 否则开盘竞价那一格会被当成十点的常态、收盘前一刻钟又永远判不到
          const effMinute = snap.delayed === true ? minute - AnomalyService.DELAYED_SHIFT_MINUTES : minute;
          const result = evaluateAnomalies({
            symbol, snap, samples, state: this.storedAnomalyState(stock["states"], et.date),
            nowMs, etDate: et.date, minute: effMinute, sessionMinutes, config,
            suppress: fresh || stale,
          });
          this.qualityMetrics.set(symbol, {
            metrics: result.metrics,
            at,
            error: stale ? '行情已停更 ' + Math.round(staleMs / 60000) + ' 分钟,本轮不判' : null,
          });
          if (result.metrics.delayed || snap.delayed) delayed = true;
          if (result.events.length || stableJson(result.state) !== stableJson(stock["states"])) {
            store.updateQualityStock(String(stock["id"]), {
              states: result.state,
              events: [...((stock["events"] as Rec[]) ?? []), ...result.events].slice(-50),
            });
          }
          (out["events"] as AnomalyEvent[]).push(...result.events);
          (out["evaluated"] as string[]).push(symbol);
        } catch (exc) {
          // 一只股出错不能拖垮其它股
          errors.push(`${symbol}:${String((exc as Error).message).slice(0, 120)}`);
        }
      }
      // 删掉 / 停用的股:样本与指标一起丢,不留在内存里
      const live = new Set(latest.map((s) => String(s["symbol"])));
      for (const key of [...this.qualitySamples.keys()]) if (!live.has(key)) this.qualitySamples.delete(key);
      for (const key of [...this.qualityMetrics.keys()]) if (!live.has(key)) this.qualityMetrics.delete(key);
      state["delayed"] = delayed;
      state["last_error"] = errors.join(";").slice(0, 300);
      // 只推给界面,不走 notifier:那会在 macOS 再弹一次系统通知;看板通知流由界面自己写
      if ((out["events"] as AnomalyEvent[]).length) this.emit("anomaly", { events: out["events"] });
    } catch (exc) {
      state["last_error"] = String((exc as Error).message).slice(0, 200);
    } finally {
      state["ticks"] = Number(state["ticks"]) + 1;
      state["last_at"] = new Date().toISOString();
      state["last_ms"] = Date.now() - t0;
      // 报错只在"变了"的那一轮记一行 stderr:5 秒一轮,TWS 断着的时候不能每轮刷屏(也不进只增不改的审计表)
      const error = String(state["last_error"] ?? "");
      if (error && error !== prevError) process.stderr.write(`[anomaly] ${error}\n`);
    }
    return out;
  }

  /** 库里读回的状态:空的(刚加入)回 null;不是今天的整个作废——换日重置档位,不能把昨天报过的档带进今天。 */
  private storedAnomalyState(raw: unknown, etDate: string): AnomalyState | null {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw) || !Object.keys(raw as Rec).length) return null;
    const date = (raw as Rec)["date"];
    if (typeof date === "string" && date !== etDate) return null;
    return coerceState(raw, etDate);
  }

  /** 当前生效的触发条件。存坏了就按默认跑——监控不能因为一条偏好读不出来就停。 */
  config(): AnomalyConfig {
    const raw = this.engine.store.getPref(AnomalyService.QUALITY_CONFIG_PREF);
    if (raw === null) return structuredClone(DEFAULT_ANOMALY_CONFIG);
    try {
      return normalizeAnomalyConfig(raw, structuredClone(DEFAULT_ANOMALY_CONFIG));
    } catch {
      return structuredClone(DEFAULT_ANOMALY_CONFIG);
    }
  }

  /** 监控状态:连接 / 支持 / 时段现算(本地道,便宜),节拍与报错取循环最近一轮。 */
  monitor(): Rec {
    const s = this.anomalyLoop;
    const router = this.router;
    const connected = Boolean(router && router.sessions().length);
    const supported = router !== null
      ? (router as unknown as VolumeQuoteSource).SUPPORTS_VOLUME_QUOTES === true
      : this.settings.broker.provider !== "futu";
    const session = anomalySessionOf(this.settings.marketStatus(nowEt()));
    let note = "";
    if (!connected) note = "未连接券商";
    else if (!supported) note = "当前券商(富途)暂不支持异动监控";
    else if (session === "closed") note = "休市:开盘后开始检测";
    else if (session === "pre") note = "盘前:开盘后开始检测";
    else if (session === "post") note = "盘后:今日检测已结束";
    else if (s["delayed"]) note = "延迟行情:提醒会晚约 15 分钟";
    return {
      running: s["running"], interval_ms: s["interval_ms"], ticks: s["ticks"],
      last_at: s["last_at"], last_ms: s["last_ms"], last_error: s["last_error"],
      session, connected, supported, note,
    };
  }

  /** 最近一轮给这只股算出来的指标;还没轮到、或已经断开,回 undefined。 */
  metricsOf(symbol: string): QualityMetricsHit | undefined {
    return this.qualityMetrics.get(symbol);
  }

  /** 这只股不盯异动了(关掉 / 停用 / 删了):样本与指标一起丢,留着只会把一段空档算成"窗口"。 */
  forget(symbol: string): void {
    this.qualitySamples.delete(symbol);
    this.qualityMetrics.delete(symbol);
  }
}
