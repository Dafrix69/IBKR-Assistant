/** 本机 JSON-RPC 服务(§10.1)。
 *
 * stdio 上的换行分隔 JSON-RPC 2.0;stdout 只跑协议,日志一律走 stderr。
 * 这个文件只管三件事:**传输**(读行、三条道的调度、回执与事件)、**生命周期**(配置、券商 router、
 * 引擎的建与丢)、**装配**(把 services/ 与各域的 handler 接起来,合成一张方法表)。
 * 业务不写在这里:一个方法属于哪个域,就去 handlers/<域>.ts;带状态的循环与缓存在 services/。
 */
import * as path from "node:path";
import * as readline from "node:readline";

import { LLMConfig, Settings, loadSettings } from "../config.js";
import { TradingEngine } from "../engine.js";
import { KillSwitch } from "../killswitch.js";
import { publicIndexPrice } from "../macro.js";
import { Notifier } from "../notify.js";
import { buildParser, guardAccountIds } from "../providers.js";
import { RpcError } from "../rpcError.js";
import { AlertsService } from "../services/alerts.js";
import { AnomalyService } from "../services/anomaly.js";
import { BrokerLinkService } from "../services/brokerLink.js";
import { FlyPlannerService } from "../services/flyPlanner.js";
import { IvRecorderService } from "../services/ivRecorder.js";
import type { Router } from "../services/host.js";
import { MarketDataService } from "../services/marketData.js";
import { PoolService } from "../services/pool.js";
import { StockTripsService } from "../services/stockTrips.js";
import { IdeaSemanticService } from "../services/ideaSemantic.js";
import { SimilarContextService } from "../services/similarContext.js";
import { TradeHistoryService } from "../services/tradeHistory.js";
import { TradeStore } from "../store.js";
import { PROTOCOL_VERSION } from "./context.js";
import type { HandlerBase, MethodTable, Rec, RpcContext } from "./context.js";
import { SystemHandlers } from "./handlers/system.js";
import { TradingHandlers } from "./handlers/trading.js";
import { IdeasHandlers } from "./handlers/ideas.js";
import { SectorsHandlers } from "./handlers/sectors.js";
import { ScreenerHandlers } from "./handlers/screener.js";
import { BacktestHandlers } from "./handlers/backtest.js";
import { MarketHandlers } from "./handlers/market.js";
import { AlertsHandlers } from "./handlers/alerts.js";
import { QualityHandlers } from "./handlers/quality.js";
import { ReviewHandlers } from "./handlers/review.js";
import { TrackerHandlers } from "./handlers/tracker.js";
import { ConnectionHandlers } from "./handlers/connection.js";
import { SettingsHandlers } from "./handlers/settings.js";

export class RpcServer implements RpcContext {
  settingsPath: string | null;
  settings: Settings;
  router: Router | null = null;
  private engineInstance: TradingEngine | null = null;
  /** 最近一个被换下来的引擎(见 retireEngine):新引擎接它的回报账,第一轮托管对账之前借它的托管缓存认旧单。 */
  private retiredEngine: TradingEngine | null = null;
  /** 追踪相关操作的共享锁(跨引擎实例同一把):每一轮盯盘、建 / 改 / 删追踪、立即平仓排成一队。 */
  private trackerChain: Promise<unknown> = Promise.resolve();
  readonly trackerLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = this.trackerChain.then(fn, fn);
    this.trackerChain = run.then(() => undefined, () => undefined);
    return run;
  };
  private readonly out: (line: string) => void;
  /** 测试可注入的解析器工厂。真的那一个带着账号闸(guardAccountIds):每一次外发都查一遍真实账号。 */
  parserFactory: (cfg: LLMConfig) => any = (cfg) => guardAccountIds(buildParser(cfg), () => this.settings.accounts);

  // 带状态的编排:缓存、循环、迁移标记都在它们身上,server 自己不留业务状态
  readonly market: MarketDataService;
  readonly alerts: AlertsService;
  readonly anomaly: AnomalyService;
  readonly pool: PoolService;
  readonly stockTrips: StockTripsService;
  readonly tradeHistory: TradeHistoryService;
  readonly similarContext: SimilarContextService;
  readonly ideaSemantic: IdeaSemanticService;
  readonly brokerLink: BrokerLinkService;
  readonly flyPlanner: FlyPlannerService;
  readonly ivRecorder: IvRecorderService;
  /** 各域的 handler。方法表在构造时合成一张,之后不变。 */
  readonly domains: {
    system: SystemHandlers;
    trading: TradingHandlers;
    ideas: IdeasHandlers;
    sectors: SectorsHandlers;
    screener: ScreenerHandlers;
    backtest: BacktestHandlers;
    market: MarketHandlers;
    alerts: AlertsHandlers;
    quality: QualityHandlers;
    review: ReviewHandlers;
    tracker: TrackerHandlers;
    connection: ConnectionHandlers;
    settings: SettingsHandlers;
  };
  private readonly table: MethodTable;

  constructor(settingsPath?: string | null, out?: (line: string) => void) {
    this.settingsPath = settingsPath ?? null;
    this.settings = loadSettings(settingsPath ?? undefined);
    this.out = out ?? ((line) => process.stdout.write(line + "\n"));
    this.market = new MarketDataService(this);
    this.alerts = new AlertsService(this, this.market);
    this.anomaly = new AnomalyService(this, this.alerts);
    this.pool = new PoolService(this, this.alerts, this.anomaly);
    this.stockTrips = new StockTripsService(this);
    this.tradeHistory = new TradeHistoryService(this, this.market, this.stockTrips);
    this.similarContext = new SimilarContextService(this, this.market);
    this.ideaSemantic = new IdeaSemanticService(this);
    this.brokerLink = new BrokerLinkService(this);
    this.flyPlanner = new FlyPlannerService(this);
    // 记 IV 用的是测算那批自己的行情流;测算读到行情时也顺带记一笔
    this.ivRecorder = new IvRecorderService(this, this.flyPlanner.marks);
    this.flyPlanner.onMarks = (sample) => this.ivRecorder.recordPlan(sample);
    this.domains = {
      system: new SystemHandlers(this),
      trading: new TradingHandlers(this),
      ideas: new IdeasHandlers(this),
      sectors: new SectorsHandlers(this),
      screener: new ScreenerHandlers(this),
      backtest: new BacktestHandlers(this),
      market: new MarketHandlers(this),
      alerts: new AlertsHandlers(this),
      quality: new QualityHandlers(this),
      review: new ReviewHandlers(this),
      tracker: new TrackerHandlers(this),
      connection: new ConnectionHandlers(this),
      settings: new SettingsHandlers(this),
    };
    // 无原型的表:请求里的 method 是外来字符串,"constructor" / "toString" 不该从 Object.prototype 上捞到东西
    const table: MethodTable = Object.create(null);
    for (const domain of Object.values(this.domains) as HandlerBase[]) {
      for (const [name, fn] of Object.entries(domain.methods())) {
        if (name in table) throw new Error(`RPC 方法重复登记:${name}`);
        table[name] = fn;
      }
    }
    this.table = table;
  }

  // ---- 生命周期 --------------------------------------------------------
  get engine(): TradingEngine {
    if (this.engineInstance === null) {
      const notifier = new Notifier(true, [
        (title, subtitle, body) => this.emit("notification", { title, subtitle, body }),
      ]);
      this.engineInstance = new TradingEngine({
        settings: this.settings,
        parser: this.parserFactory(this.settings.llm),
        store: new TradeStore(this.settings.db_path, { safety: true }),
        notifier,
        killswitch: new KillSwitch(
          path.join(path.dirname(this.settings.db_path), "breaker.json"),
          this.settings.policies.consecutive_failure_breaker,
        ),
        router: this.router,
      });
      const previous = this.retiredEngine;
      if (previous !== null && previous.router === this.engineInstance.router) {
        RpcServer.inheritLedgers(previous, this.engineInstance);
      }
      this.engineInstance.sharedTrackerLock = this.trackerLock;
      // 触发了、或者到价却发不出去,当场推给界面——不能等界面下一次来读
      this.engineInstance.onTrackerTick = (poll) => {
        if ((poll["fired"] as Rec[]).length || (poll["blocked"] as Rec[]).length) this.emit("tracker", poll);
      };
      // 连着券商就起节拍器:建追踪、调价都靠它,不靠界面驱动
      if (this.router !== null) this.engineInstance.startTrackerLoop();
    }
    return this.engineInstance;
  }

  /** 丢掉当前引擎(配置变了 / 连接变了):先停它的节拍器,否则旧实例会和新实例各跑一个循环;
   *  再让它把会话回报转给以后的引擎(retireEngine),否则新引擎听不见券商。 */
  dropEngine(): void {
    const old = this.engineInstance;
    this.engineInstance = null;
    if (old === null) return;
    old.stopTrackerLoop();
    this.retireEngine(old);
  }

  /** 配置变了就整体重建:限额、别名表都会进提示词,必须一起换掉。
   *  连着券商就当场重建:节拍器随引擎一起起——以前要等界面下一次来要引擎,那几秒里没人盯盘、没人调托管单。 */
  reload(): void {
    this.settings = loadSettings(this.settingsPath ?? undefined);
    this.dropEngine();
    if (this.router !== null) void this.engine;
  }

  /**
   * 换下来的引擎把会话回报转给**现在的**引擎。
   *
   * 会话上的回报监听是某一个引擎挂的(engine.wireSession:闭包里调的是 `那个实例.onOrderStatus(...)`),
   * 会话打着 _dafriWired 不许重挂;router.sessionHook 调的也是 `那个实例.wireSession(...)`。所以引擎一重建,
   * 新引擎就听不见券商了——2026-09-27 审出:在「设置」里动一下任何一项,托管止损被拒照样显示「已托管」,
   * 止盈成交了追踪不落闩,部分成交的数量它也不知道。
   * 做法:把旧实例上接回报的这几只手换成"现取 this.engine 再转过去"。会话上还是原来那一套监听(不重复挂),
   * 之后才连上的会话经 sessionHook 挂到现在的引擎上;再换一次引擎,也总是转给那时的"现在"。
   * 这依赖 engine.wireSession 的闭包按名字调实例方法——tests/fix-callbacks-rewire.spec.ts 钉着。
   */
  private retireEngine(old: TradingEngine): void {
    this.retiredEngine = old;
    old.onOrderStatus = (trade) => this.deliverOrderStatus(trade);
    old.onExecDetails = (trade, fill) => this.engine.onExecDetails(trade, fill);
    old.onCommission = (trade, fill, report) => this.engine.onCommission(trade, fill, report);
    old.onIbError = (reqId, code, message) => this.engine.onIbError(reqId, code, message);
    old.wireSession = (session) => this.engine.wireSession(session);
  }

  /** 状态回报交给现在的引擎。它第一轮托管对账(按 orderRef 认领)之前还不认得上一个引擎挂出去的托管单:
   *  这时来的成交再让上一个引擎的托管缓存过一手,追踪照样落闩——否则那一轮会当成"没挂"再挂一张。 */
  private deliverOrderStatus(trade: Parameters<TradingEngine["onOrderStatus"]>[0]): void {
    const live = this.engine;
    live.onOrderStatus(trade);
    const previous = this.retiredEngine;
    if (previous !== null && previous !== live && live.trackerLoop["hosted"] === null) {
      previous.hostedOrders.onStatus(trade);
    }
  }

  /** 新引擎接着记旧引擎的回报账:orderIndex(旧引擎发出去的单,回报才认得出记录)、终态与 exec_id 去重
   *  (券商重推时不落第二次,手续费与已实现盈亏才不翻倍)、还没对上的回报与早到的错误。
   *  只在同一个 router 上接——换了 router 就是换了券商连接,旧的订单号不作数。 */
  private static inheritLedgers(from: TradingEngine, to: TradingEngine): void {
    for (const [id, recordId] of from.orderIndex) if (!to.orderIndex.has(id)) to.orderIndex.set(id, recordId);
    for (const recordId of from.finalized) to.finalized.add(recordId);
    for (const execId of from.seenFills) to.seenFills.add(execId);
    for (const execId of from.seenCommissions) to.seenCommissions.add(execId);
    for (const [id, early] of from.earlyOrderErrors) if (!to.earlyOrderErrors.has(id)) to.earlyOrderErrors.set(id, early);
    for (const [id, sent] of from.sentOrders) if (!to.sentOrders.has(id)) to.sentOrders.set(id, sent);
    to.unmatchedEvents.push(...from.unmatchedEvents);
  }

  get engineBuilt(): TradingEngine | null {
    return this.engineInstance;
  }

  // ---- 协议 -----------------------------------------------------------
  // 界面每几秒自动打一次的周期轮询(对应 Python _LOW_PRIORITY_METHODS)。
  // 引擎仍是顺序执行,这里只做"插队":用户亲手发的请求先于轮询处理,
  // 否则「解析并校验」会排在 macro.board / tracker.reconcile 后面。
  static readonly LOW_PRIORITY_METHODS = new Set([
    "system.status", "macro.board", "alerts.poll",
    "pending.poll", "positions.list", "sectors.quotes", "pa.analyze", "book.snapshot",
  ]);
  // 三条道(2026-09-08,用户反馈"移除板块成分股太慢"):
  //  · 本地道:同步的本地库 / 配置读写,来了就答,不排队——删一行成分股是一次 SQLite 写,
  //    没道理排在等网络的行情请求后面。
  //  · 读道:只读的行情 / 探测 / 纯计算,最多 READ_CONCURRENCY 个并发;彼此独立,也不碰下单状态。
  //  · 交易道(其余):严格顺序,用户请求插到周期轮询前面。下单、熔断、连接切换、追踪轮询都在这里。
  // 单线程不是瓶颈,"一次只处理一个"才是;真正需要顺序的只有交易道。
  static readonly LOCAL_METHODS = new Set([
    "system.status",
    "sectors.list", "sectors.add", "sectors.delete", "sectors.add_stock", "sectors.remove_stock", "sectors.set_tag",
    "ideas.list", "ideas.add", "ideas.update", "ideas.digests", "ideas.search",
    "records.list", "records.get", "settings.get", "breaker.state", "alerts.list", "tracker.list",
    // 碰均线的设置:一次 app_prefs 写,底账按新口径重算是 tickTouch 的事
    "alerts.set_touch_config",
    "llm.catalog", "broker.catalog",
    // 盯盘与托管对账的节拍器在引擎里(TradingEngine.startTrackerLoop),这两个请求只是读它最新
    // 一轮的结果——不该排在下单、大模型解析后面等。以前它们在交易道上排低优先级。
    "tracker.poll", "tracker.reconcile",
    // 优质股追踪:同步 SQLite + 读异动循环留在内存里的指标,取行情是循环自己的事(startAnomalyLoop)
    "quality.list", "quality.add", "quality.update", "quality.remove", "quality.set_config",
    // 备份清单是读一个目录;出一份备份是一条 VACUUM INTO(几十毫秒到一两秒),不该排在下单、解析后面
    "data.backups", "data.backup",
    // 股票池上的两个开关:建 / 删两张表里的一行,同步 SQLite,价位与行情都是别的循环的事
    "pool.set_watch",
    // IV 记录的状态与开关:数一下目录里的文件、写一行偏好;记的那一路是引擎里自己的循环
    "options.iv_recorder", "options.iv_recorder_set",
  ]);
  static readonly READ_METHODS = new Set([
    "positions.list", "sectors.quotes", "pa.analyze", "book.snapshot", "options.wall", "macro.board",
    "screener.rs", "screener.inflection", "screener.deviation", "backtest.run", "backtest.strategies", "backtest.sweep",
    "pa.timeframes", "tws.scan", "tws.diagnose", "futu.scan", "futu.diagnose",
    "tracker.target_preview",
    // 下单页的历史相似交易:读本地库,过期蝴蝶的结算价可能要取一次日线,放读道不挡下单
    "ideas.similar_trades",
    // 绩效体检:读本地库算账,过期蝴蝶的结算价可能要取一次日线,同上
    "review.performance",
    // 信号成绩单:读本地库的信号日志,逐只取日线(10 分钟缓存),纯计算
    "review.signals",
    // 强势股筛选:和 screener.rs 一样逐只拉日线(10 分钟缓存),纯计算
    "screener.leaders",
    // 蝴蝶测算:取现价与三条腿的盘口 / IV(自己的行情流,不碰盯盘的),纯计算。开着自动刷新时十秒一次,不该排在交易道上
    "options.fly_plan",
  ]);
  static readonly READ_CONCURRENCY = 4;
  static readonly SLOW_MS = 1000; // 超过这个时长的请求记到 stderr

  async serve(input: NodeJS.ReadableStream = process.stdin): Promise<number> {
    this.emit("ready", { protocol: PROTOCOL_VERSION, config: String(this.settings.source_path) });
    // 优质股异动监控在引擎里按节拍跑,不靠界面驱动:窗口最小化、切到别的页,放量照样当场报
    this.anomaly.start();
    // 当日到期期权 IV 的记录同理:在引擎里按节拍跑,连着 IBKR、在常规时段里才真的去记
    this.ivRecorder.start();
    // 预热 SPX 公开现价:本地速记「15蝴蝶」的中心要靠它算,冷取一次约 0.7 秒(实测 790 ms)。
    // 启动就取、之后每 4 分钟后台刷一次(缓存 10 分钟内"旧值先给、后台换新"),让这条 2 毫秒的路径
    // 不因为"第一次"或"十分钟没人用"变成 700 毫秒。取不到就算了,速记自己还会再取。
    const warmSpot = (): void => { publicIndexPrice("SPX").catch(() => null); };
    warmSpot();
    setInterval(warmSpot, 4 * 60 * 1000).unref();
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    const BAD: Rec = { __bad_json__: true };
    const normal: Rec[] = [];
    const low: Rec[] = [];
    const reads: Rec[] = [];
    let readsInFlight = 0;
    let detached = 0; // 本地道 + 读道里还没答完的请求数:EOF 后要等它们答完再退出
    let closed = false;
    let wake: (() => void) | null = null;
    const kick = (): void => {
      if (wake) {
        const w = wake;
        wake = null;
        w();
      }
    };
    const runDetached = (request: Rec): void => {
      detached += 1;
      void this.handle(request).finally(() => {
        detached -= 1;
        kick();
      });
    };
    const pumpReads = (): void => {
      while (readsInFlight < RpcServer.READ_CONCURRENCY && reads.length) {
        const next = reads.shift()!;
        readsInFlight += 1;
        detached += 1;
        void this.handle(next).finally(() => {
          readsInFlight -= 1;
          detached -= 1;
          pumpReads();
          kick();
        });
      }
    };
    rl.on("line", (rawLine: string) => {
      const line = rawLine.trim();
      if (!line) return;
      let request: Rec;
      try {
        request = JSON.parse(line);
      } catch {
        normal.push(BAD);
        kick();
        return;
      }
      const method = String(request["method"] ?? "");
      if (RpcServer.LOCAL_METHODS.has(method)) {
        runDetached(request); // 本地道:来了就答
        return;
      }
      if (RpcServer.READ_METHODS.has(method)) {
        reads.push(request); // 读道:有限并发
        pumpReads();
        return;
      }
      (RpcServer.LOW_PRIORITY_METHODS.has(method) ? low : normal).push(request); // 交易道:严格顺序
      kick();
    });
    rl.on("close", () => {
      closed = true;
      kick();
    });

    for (;;) {
      const request = normal.shift() ?? low.shift();
      if (request === undefined) {
        if (closed && detached === 0) break; // EOF、队列已空、在途请求都答完了,才退出
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      if (request === BAD) {
        this.write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "无法解析的 JSON" } });
        continue;
      }
      await this.handle(request);
    }
    this.anomaly.stop();
    this.ivRecorder.stop();
    this.flyPlanner.marks.close();
    this.brokerLink.stop();
    return 0;
  }

  async handle(request: Rec): Promise<Rec> {
    const started = performance.now();
    try {
      return await this.handleInner(request);
    } finally {
      const elapsed = performance.now() - started;
      if (elapsed >= RpcServer.SLOW_MS) {
        process.stderr.write(`[rpc] 慢请求 ${String(request["method"] ?? "")} ${Math.round(elapsed)} ms\n`);
      }
    }
  }

  /** 直接调一个方法:不包 JSON-RPC 信封、不写 stdout,失败原样抛(RpcError 带码)。 */
  async call(method: string, params: Rec = {}): Promise<Rec> {
    const handler = this.methods()[method];
    if (typeof handler !== "function") throw new RpcError(-32601, `未知方法:${method}`);
    return handler(params);
  }

  private async handleInner(request: Rec): Promise<Rec> {
    const requestId = request["id"] ?? null;
    const method = String(request["method"] ?? "");
    const params: Rec = request["params"] ?? {};
    let message: Rec;
    try {
      const result = await this.call(method, params);
      message = { jsonrpc: "2.0", id: requestId, result };
    } catch (exc) {
      if (exc instanceof RpcError) {
        message = { jsonrpc: "2.0", id: requestId, error: { code: exc.code, message: exc.message } };
      } else {
        process.stderr.write(String((exc as Error).stack ?? exc) + "\n");
        message = {
          jsonrpc: "2.0",
          id: requestId,
          error: {
            code: -32000,
            message: `${(exc as Error).constructor.name}: ${(exc as Error).message}`,
          },
        };
      }
    }
    this.write(message);
    return message;
  }

  private write(message: Rec): void {
    this.out(JSON.stringify(message));
  }

  emit(event: string, payload: Rec): void {
    this.write({ jsonrpc: "2.0", method: "event", params: { event, data: payload } });
  }

  // ---- 方法表 ---------------------------------------------------------
  /** 全部方法名(排好序):白名单测试拿它和桌面端的 ALLOWED_RPC 对。 */
  methodNames(): string[] {
    return Object.keys(this.table).sort();
  }

  private methods(): MethodTable {
    return this.table;
  }
}

/** stdio 入口:stdout 只跑协议——先把真 stdout 私有化,console.log 全走 stderr。 */
export async function main(settingsPath?: string | null): Promise<number> {
  const realWrite = process.stdout.write.bind(process.stdout);
  // 任何依赖的 console.log 都落到 stderr(§10.1)
  console.log = (...args: unknown[]) => console.error(...args);
  const server = new RpcServer(settingsPath, (line) => realWrite(line + "\n"));
  // 先把交易库开一遍:打不开(坏了、被占着、写不进去、比软件新)就在这里当场说清楚并退出(cli.ts 接 StoreOpenError)。
  // 库是懒建的——不先开这一遍,引擎会"正常启动",然后每一个请求都回一句 SqliteError
  new TradeStore(server.settings.db_path, { safety: true }).close();
  const done = server.serve(); // ready 已经同步发出
  // 启动即连券商(broker.auto_connect)。只在这个真正的入口里起:测试里直接 serve() 的那几条不许连真券商
  server.brokerLink.start();
  return done;
}
