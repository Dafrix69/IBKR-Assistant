/** 券商连接的生命周期:连、断、启动时自动连、从没连上的连接定时再试,以及掉线 / 重连的提醒。
 *
 * 追踪止盈止损要全天有效,而会让它停摆的恰恰都是**没人在场**的时候:
 *  · 电脑重启、应用被重新拉起、引擎崩了被主进程拉起来——以前连券商只能靠人点「连接」,
 *    没人点,节拍器就一直不跑(2026-09-26 实测:开机后 TWS 起来了,应用也开了,一条追踪都没人盯);
 *  · TWS 比应用晚开——点过一次「连接」失败之后,不会再试;
 *  · TWS 自己重启 / 与 IBKR 服务器闪断——会话层自己重连(ibSession 的 IB_RECONNECT_MS),这里只负责
 *    告诉用户"这段时间没在盯",连回来了再说一声。
 *
 * 已经连上过的连接断了归会话层重连,这里不插手(两边同时重连会抢同一个 client id);这里只重试
 * **本 router 上从没连上过**的那几条。用户点了「断开」或换了券商,就不再自动连。
 */
import { BrokerError, BrokerRouter } from "../broker.js";
import type { BrokerConnectResult } from "../contract/index.js";
import { FutuRouter } from "../futuBroker.js";
import { logStderr } from "../ibLink.js";
import type { Router, ServiceHost } from "./host.js";

/** 连接服务要的宿主那一面:比 ServiceHost 多两样——能换 router、能丢引擎。 */
export interface BrokerLinkHost extends ServiceHost {
  router: Router | null;
  dropEngine(): void;
}

export class BrokerLinkService {
  /** 从没连上的连接隔多久再试一次。连不上时一次尝试最多 10 秒(会话层的握手超时)。 */
  static readonly RETRY_MS = 30_000;

  /** 用户要不要连着:启动时按 broker.auto_connect,点「连接」置真,点「断开」/ 换券商置假 */
  private wanted = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private retrying = false;
  /** 在当前这个 router 上连上过的连接名(换了 router 就清):这些断了归会话层自己重连 */
  private readonly seen = new Set<string>();
  private seenRouter: Router | null = null;
  /** 连接动作排成一队:启动自动连还在握手(最长 10 秒)时用户点了「连接」,两边各建一个会话会抢同一个 client id */
  private chain: Promise<unknown> = Promise.resolve();

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  constructor(private readonly host: BrokerLinkHost) {}

  /** 引擎启动时调一次(只在真正的 stdio 入口里调,测试里的 serve() 不碰它——测试不许连真券商)。 */
  start(): void {
    if (!this.host.settings.broker.auto_connect) return;
    logStderr("[link] 启动即连券商(broker.auto_connect)");
    this.wanted = true;
    this.ensureTimer();
    void this.retryOnce();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** 按配置里生效的那家券商建 router(全系统唯一需要分支的地方)。 */
  makeRouter(): Router {
    if (this.host.settings.broker.provider === "futu") return new FutuRouter(this.host.settings);
    return new BrokerRouter(this.host.settings);
  }

  /** 「连接」:连上指定的(默认全部)连接,并让引擎带上 router 重建。界面的按钮与启动自动连走同一条路。 */
  connect(names?: string[]): Promise<BrokerConnectResult> {
    return this.serial(() => this.connectNow(names));
  }

  private async connectNow(names?: string[]): Promise<BrokerConnectResult> {
    const provider = this.host.settings.broker.provider;
    if (this.host.router !== null && this.host.router.BROKER !== provider) {
      // 配置里换过券商:旧 router 说的是另一家的协议,先断干净再重建
      await this.host.router.disconnectAll();
      this.host.router = null;
    }
    if (this.host.router === null) this.host.router = this.makeRouter();
    const router = this.host.router;
    this.watch(router);
    const connected: string[] = [];
    const failed: Record<string, string> = {};
    for (const name of names ?? Object.keys(this.host.settings.connectionsFor(provider)).sort()) {
      try {
        await router.connect(name);
        connected.push(name);
        this.seen.add(name);
      } catch (exc) {
        if (exc instanceof BrokerError) failed[name] = exc.message;
        else throw exc;
      }
    }
    // 夜盘:连上就在后台把期货推算暖起来,免得第一笔速记单拿昨收去推断看涨看跌
    if (connected.length) (router as { warmIndexFutures?: () => void }).warmIndexFutures?.();
    // 立刻把引擎建起来:节拍器随引擎一起起,盯盘不等界面来第一次请求
    if (connected.length) void this.host.engine;
    this.host.dropEngine(); // 让引擎带上 router 重建
    const attached = this.host.engine.attachListeners();
    this.host.engine.store.audit("ui", "broker_connect", {
      provider, connected, failed: Object.keys(failed),
    });
    this.wanted = true;
    this.ensureTimer();
    return { provider, connected, failed, listeners: attached };
  }

  /** 「断开」:用户明确不要连着了,之后不再自动连。 */
  disconnect(): Promise<void> {
    this.wanted = false;
    return this.serial(async () => {
      if (this.host.router) await this.host.router.disconnectAll();
      this.host.router = null;
      this.host.dropEngine();
    });
  }

  /** 换券商:旧连接已经断干净,等用户在新那家上点「连接」。 */
  forget(): void {
    this.wanted = false;
  }

  /** 一次重试:把配置里有、这个 router 上从没连上过的连接再连一遍。 */
  async retryOnce(): Promise<void> {
    if (!this.wanted || this.retrying) return;
    this.retrying = true;
    try {
      const router = this.host.router;
      const provider = this.host.settings.broker.provider;
      const names = Object.keys(this.host.settings.connectionsFor(provider)).sort();
      if (router === null || router.BROKER !== provider) {
        const result = await this.serial(() => this.connectNow(names));
        if (result.connected.length) logStderr(`[link] 已连上:${result.connected.join("、")}`);
        return;
      }
      if (router !== this.seenRouter) this.watch(router);
      for (const name of names) {
        if (this.seen.has(name)) continue;
        try {
          // router 上已经挂着 sessionHook(引擎的 attachListeners),新会话的回报监听会自动接上,不用重建引擎
          if (!this.wanted || this.host.router !== router) return; // 排队期间用户点了断开 / 换了 router
          await this.serial(async () => { await router.connect(name); });
          this.seen.add(name);
          logStderr(`[link] 已连上:${name}`);
          this.host.engine.notifier.notify("券商已连上", `连接 ${name} 已连上,这条连接上账户的追踪开始盯盘。`);
          this.host.engine.store.audit("engine", "broker_link_retry", { connection: name, ok: true });
        } catch (exc) {
          if (!(exc instanceof BrokerError)) throw exc;
        }
      }
    } catch (exc) {
      logStderr(`[link] 自动连接出错:${String((exc as Error).message).slice(0, 200)}`);
    } finally {
      this.retrying = false;
    }
  }

  private ensureTimer(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.retryOnce(), BrokerLinkService.RETRY_MS);
    this.timer.unref?.(); // 引擎进程该退就退,不被重试循环吊着
  }

  /** 认一个新 router:清掉"连上过"的记账,挂上掉线 / 重连的提醒。 */
  private watch(router: Router): void {
    if (router === this.seenRouter) return;
    this.seenRouter = router;
    this.seen.clear();
    for (const name of router.connectedNames()) this.seen.add(name);
    if (router instanceof BrokerRouter) router.linkHook = (name, up) => this.onLink(name, up);
  }

  /** 掉线 / 重连回来:当场说。掉线那段时间追踪读不到持仓与报价,既不判断也不发单——用户得知道。 */
  private onLink(name: string, up: boolean): void {
    logStderr(`[link] 连接 ${name} ${up ? "已自动重连" : "断开,正在自动重连"}`);
    try {
      const engine = this.host.engine;
      engine.store.audit("engine", up ? "broker_link_up" : "broker_link_down", { connection: name });
      if (up) {
        engine.reconcileSoon(); // 断线期间单子可能成交或被撤了:下一轮就对账,不等满一分钟
        engine.notifier.notify("券商已重新连上", `连接 ${name} 已自动重连,追踪恢复盯盘。`);
      } else {
        engine.notifier.warning(
          `与 TWS 的连接 ${name} 断开了,正在自动重连。断开期间这条连接上的追踪读不到持仓与报价,` +
          "不会判断、也不会发单;托管到券商的止盈止损单不受影响。",
        );
      }
      this.host.emit("broker_link", { connection: name, up });
    } catch {
      /* 提醒失败不影响重连本身 */
    }
  }
}
