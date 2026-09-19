/** 股票池:一只股身上的两个开关(盯价位 / 盯异动),以及把旧库并成一个池子的一次性迁移。
 *
 * 同一只股以前被登记三份(sectors.stocks / alert_watches / quality_stocks)。统一后:
 * **板块成分股 = 股票池,一只股只登记一次**;alert_watches 有这一行 ⟺「盯价位」开,
 * quality_stocks 有这一行 ⟺「盯异动」开。两张表继续存各自的状态(价位/墙/触发;档位/滞回/异动),
 * 但成员身份只由池子说了算——池子里没有的股不该在这两张表里留行。
 */
import { errText } from "../rpcError.js";
import type { AlertsService } from "./alerts.js";
import { AnomalyService } from "./anomaly.js";
import { ServiceBase } from "./host.js";
import type { Rec, ServiceHost } from "./host.js";

export class PoolService extends ServiceBase {
  constructor(
    host: ServiceHost, private readonly alerts: AlertsService, private readonly anomaly: AnomalyService,
  ) {
    super(host);
  }

  /** 盯价位的上限,和异动同一个数:每只股盘中都要取价,行情线路总共约 100 条。 */
  static readonly MAX_WATCH = 30;
  /** 新股进池子时的默认:两个开关都开(用户定的)。 */
  static readonly POOL_DEFAULTS: { price: boolean; anomaly: boolean } = { price: true, anomaly: true };
  /** 新建价位提醒的整数关口步长,与 alerts.create 的缺省一致(alerts.DEFAULT_STEP)。 */
  static readonly DEFAULT_WATCH_STEP = 5.0;
  /** 一次性迁移的标记键。 */
  static readonly POOL_MIGRATED_PREF = "pool.migrated_v1";
  /** 孤儿股(有开关却不在任何板块)并进这个板块。它只是一个普通板块,没有特殊语义。 */
  static readonly POOL_DEFAULT_SECTOR = "自选";
  private poolMigrated = false;

  /**
   * 开 / 关一只股身上的价位与异动。只动传进来的那个;已经是那个状态就当没事(幂等)。
   * 上限、指数这类"没给你开"的原因一律进 skipped 如实回报——不静默丢,界面要能说人话。
   */
  setWatch(symbol: string, patch: { price?: boolean; anomaly?: boolean }, note = ""): Rec {
    // 迁移必须排在任何一次开关变化之前:否则用户刚关掉的开关,会被随后才跑的迁移又打开
    // (迁移自己也走这里,靠 poolMigrated 标记直接返回,不会递归)
    this.ensureMigrated();
    const store = this.engine.store;
    const skipped: string[] = [];
    const watch = store.listWatches().find((w) => String(w["symbol"]) === symbol) ?? null;
    const quality = store.listQualityStocks().find((q) => String(q["symbol"]) === symbol) ?? null;
    let priceOn = watch !== null;
    let anomalyOn = quality !== null;

    if (patch.price === true && watch === null) {
      if (store.listWatches().length >= PoolService.MAX_WATCH) {
        skipped.push(`价位已达 ${PoolService.MAX_WATCH} 只上限,${symbol} 没打开`);
      } else {
        try {
          store.addWatch(symbol, PoolService.DEFAULT_WATCH_STEP);
          store.audit("ui", "pool_watch_on", { symbol, which: "price" });
          priceOn = true;
        } catch (exc) {
          skipped.push(errText(exc));
        }
      }
    } else if (patch.price === false && watch !== null) {
      store.deleteWatch(String(watch["id"]));
      store.audit("ui", "pool_watch_off", { symbol, which: "price" });
      this.alerts.forget(symbol);
      priceOn = false;
    }

    if (patch.anomaly === true && quality === null) {
      if (this.settings.indexConfig(symbol)) {
        // 指数不是可交易合约,量能流按正股去订一定订不上(quality.add 拒的也是这个原因)
        skipped.push(`${symbol} 是指数,异动监控只支持个股 / ETF`);
      } else if (store.listQualityStocks().length >= AnomalyService.MAX_QUALITY) {
        skipped.push(`异动已达 ${AnomalyService.MAX_QUALITY} 只上限,${symbol} 没打开`);
      } else {
        try {
          store.addQualityStock(symbol, note);
          store.audit("ui", "pool_watch_on", { symbol, which: "anomaly" });
          anomalyOn = true;
        } catch (exc) {
          skipped.push(errText(exc));
        }
      }
    } else if (patch.anomaly === false && quality !== null) {
      store.deleteQualityStock(String(quality["id"]));
      store.audit("ui", "pool_watch_off", { symbol, which: "anomaly" });
      // 关掉期间的样本等到重新打开时早过时了,留着只会把一段空档算成"窗口"
      this.anomaly.forget(symbol);
      anomalyOn = false;
    }
    return { symbol, price_on: priceOn, anomaly_on: anomalyOn, skipped };
  }

  /** 保证这只股在池子里:不在任何板块就并进「自选」(没有就建)。返回并入的板块名,本来就在回 null。 */
  ensureInPool(symbol: string, company = ""): string | null {
    const store = this.engine.store;
    if (store.symbolsInSectors().has(symbol)) return null;
    const sector =
      store.listSectors().find((s) => String(s["name"]) === PoolService.POOL_DEFAULT_SECTOR) ??
      store.addSector(PoolService.POOL_DEFAULT_SECTOR);
    const stocks = [
      ...((sector["stocks"] as Rec[]) ?? []),
      { symbol, company: company.slice(0, 60), reason: "手动加入", tag: "" },
    ];
    store.setSectorStocks(String(sector["id"]), stocks);
    return String(sector["name"]);
  }

  /** 移出池子之后的连带清理:这几只股要是不在任何板块里了,身上的两个开关也该没了。 */
  dropWatches(symbols: string[]): string[] {
    this.ensureMigrated(); // 同上:先把旧库并成池子,再谈谁该被清掉
    const store = this.engine.store;
    const inPool = store.symbolsInSectors();
    const dropped: string[] = [];
    for (const raw of symbols) {
      const symbol = String(raw ?? "").trim().toUpperCase();
      if (!symbol || inPool.has(symbol) || dropped.includes(symbol)) continue;
      const had =
        store.listWatches().some((w) => String(w["symbol"]) === symbol) ||
        store.listQualityStocks().some((q) => String(q["symbol"]) === symbol);
      if (!had) continue;
      this.setWatch(symbol, { price: false, anomaly: false });
      dropped.push(symbol);
    }
    return dropped;
  }

  /**
   * 一次性迁移(标记存在 app_prefs 的 pool.migrated_v1):把"三张表各记一份"的旧库并成一个池子。
   *  1. alert_watches / quality_stocks 里不在任何板块的股 → 并进「自选」;
   *  2. 池子里的每只股按新默认补齐两个开关(受上限;超出的跳过并记 audit);
   *  3. 写标记。**只跑一次**——否则用户后来手动关掉的开关,下次启动又被打开。
   * 第一次读 quality / alerts / sectors 时顺手跑;失败也不重试(半途出错时重跑同样会翻开关)。
   */
  ensureMigrated(): void {
    if (this.poolMigrated) return;
    this.poolMigrated = true;
    const store = this.engine.store;
    if (store.getPref(PoolService.POOL_MIGRATED_PREF) !== null) return;
    try {
      const inPool = store.symbolsInSectors();
      const orphans: string[] = [];
      for (const row of [...store.listWatches(), ...store.listQualityStocks()]) {
        const symbol = String(row["symbol"] ?? "").trim().toUpperCase();
        if (!symbol || inPool.has(symbol) || orphans.includes(symbol)) continue;
        orphans.push(symbol);
      }
      if (orphans.length) {
        const sector =
          store.listSectors().find((s) => String(s["name"]) === PoolService.POOL_DEFAULT_SECTOR) ??
          store.addSector(PoolService.POOL_DEFAULT_SECTOR);
        // 这里不按"单个板块最多 30 只"截断:截掉的那几只会留着两张表的行却不在池子里,
        // 反而成了新的孤儿——迁移的本分是一只不落地搬过来。
        store.setSectorStocks(String(sector["id"]), [
          ...((sector["stocks"] as Rec[]) ?? []),
          ...orphans.map((symbol) => ({ symbol, company: "", reason: "迁移并入", tag: "" })),
        ]);
      }
      const skipped: string[] = [];
      let armed = 0;
      for (const symbol of store.symbolsInSectors()) {
        const out = this.setWatch(symbol, PoolService.POOL_DEFAULTS);
        skipped.push(...(out["skipped"] as string[]));
        if (out["price_on"] || out["anomaly_on"]) armed += 1;
      }
      store.audit("ui", "pool_migrate_v1", { orphans, armed, skipped });
    } catch (exc) {
      // 迁移失败不该挡住这次读取:标记照写(见上:重跑会把用户关掉的开关再打开)
      process.stderr.write(`[pool] 迁移失败:${errText(exc)}\n`);
    } finally {
      store.setPref(PoolService.POOL_MIGRATED_PREF, { at: new Date().toISOString() });
    }
  }
}
