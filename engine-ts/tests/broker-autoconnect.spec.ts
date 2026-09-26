/** 启动即连券商、从没连上的连接定时再试、掉线 / 重连当场提醒(services/brokerLink.ts)。
 *
 * 2026-09-26:电脑 00:00 关机、01:32 开机,TWS 01:39 起来了,应用也重新开了——但连券商只能靠人点「连接」,
 * 没人点,节拍器就一直没跑,一条追踪都没人盯。全天有效的前提是"没人在场也会自己连上"。
 *
 * 会话工厂是假的,按端口发会话,不开任何 socket(本机实盘 TWS 就开在 7496,测试绝不能碰它)。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BrokerRouter } from "../src/broker.js";
import type { IbSession } from "../src/broker.js";
import type { Settings } from "../src/config.js";
import { TradingEngine } from "../src/engine.js";
import { Notifier } from "../src/notify.js";
import { BrokerLinkService } from "../src/services/brokerLink.js";
import type { BrokerLinkHost } from "../src/services/brokerLink.js";
import type { Router } from "../src/services/host.js";
import { TradeStore } from "../src/store.js";
import { loadGolden, makeSettings } from "./util.js";

const g = loadGolden("config");
type Rec = Record<string, any>;

class StubSession {
  connected = true;
  linkCbs: Array<(up: boolean) => void> = [];
  constructor(readonly managed: string[]) {}
  isConnected(): boolean { return this.connected; }
  disconnect(): void { this.connected = false; }
  managedAccounts(): string[] { return this.managed; }
  async portfolio(): Promise<Rec[]> { return []; }
  async positions(): Promise<Rec[]> { return []; }
  onConnectivity(): void { /* 不关心 */ }
  onLink(cb: (up: boolean) => void): void { this.linkCbs.push(cb); }
  reqMarketDataType(): void { /* 不关心 */ }
  setBaselineMarketDataType(): void { /* 不关心 */ }
}

/** 假"本机":哪几个端口上有 TWS、每个端口被连了几次 */
class FakeMachine {
  up = new Set<number>();
  attempts: Record<number, number> = {};
  sessions: Record<number, StubSession> = {};
  factory = async (cfg: { port: number }): Promise<IbSession> => {
    this.attempts[cfg.port] = (this.attempts[cfg.port] ?? 0) + 1;
    if (!this.up.has(cfg.port)) throw new Error("connect ECONNREFUSED");
    const s = new StubSession([cfg.port === 7497 ? "DU7654321" : "U1234567"]);
    this.sessions[cfg.port] = s;
    return s as unknown as IbSession;
  };
}

class FakeHost implements BrokerLinkHost {
  router: Router | null = null;
  drops = 0;
  events: Array<[string, Rec]> = [];
  notes: string[] = [];
  private built: TradingEngine | null = null;
  constructor(readonly settings: Settings) {}
  get engine(): TradingEngine {
    if (this.built === null) {
      const notifier = new Notifier(false, [(title, _sub, body) => this.notes.push(`${title}|${body}`)]);
      this.built = new TradingEngine({
        settings: this.settings, parser: {} as any, store: new TradeStore(this.settings.db_path),
        notifier, router: this.router as any,
      });
    }
    return this.built;
  }
  dropEngine(): void {
    this.drops += 1;
    this.built = null;
  }
  emit(event: string, payload: Rec): void { this.events.push([event, payload]); }
}

const services: BrokerLinkService[] = [];
afterEach(() => { for (const s of services.splice(0)) s.stop(); });

function setup(broker: Rec = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "dafri-link-"));
  const settings = makeSettings(g.base_config, { storage: { db_path: path.join(dir, "link.db") }, broker });
  const machine = new FakeMachine();
  const host = new FakeHost(settings);
  const link = new BrokerLinkService(host);
  link.makeRouter = () => new BrokerRouter(settings, machine.factory as any);
  services.push(link);
  return { settings, machine, host, link };
}

/** start() 里的第一次连接是后台跑的:等它落定 */
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("启动即连券商", () => {
  it("默认开:引擎一起来就把配置里的连接全连一遍;连上的那条上建好引擎", async () => {
    const { machine, host, link, settings } = setup();
    expect(settings.broker.auto_connect).toBe(true);
    machine.up.add(7497); // 只有模拟盘的 TWS 开着
    link.start();
    await settle();
    expect(host.router).not.toBeNull();
    expect(host.router!.connectedNames()).toEqual(["paper"]);
    expect(machine.attempts).toEqual({ 7496: 1, 7497: 1 });
    expect(host.engine.router).toBe(host.router);
  });

  it("关掉(broker.auto_connect=false):启动时不连,等人点", async () => {
    const { machine, host, link } = setup({ auto_connect: false });
    machine.up.add(7497);
    link.start();
    await settle();
    expect(host.router).toBeNull();
    expect(machine.attempts).toEqual({});
    await link.retryOnce();
    expect(machine.attempts).toEqual({});
  });

  it("TWS 比应用晚开:之后每一次重试把没连上的补上,不重建引擎(内存里的托管单 / 追价状态都还在)", async () => {
    const { machine, host, link } = setup();
    link.start();
    await settle();
    expect(host.router!.connectedNames()).toEqual([]); // 两台都没开
    const engine = host.engine;
    const drops = host.drops;

    machine.up.add(7496); // 实盘那台起来了
    await link.retryOnce();
    expect(host.router!.connectedNames()).toEqual(["live"]);
    expect(host.drops).toBe(drops);
    expect(host.engine).toBe(engine);
    expect(host.notes.some((n) => n.startsWith("券商已连上"))).toBe(true);

    machine.up.add(7497);
    await link.retryOnce();
    expect(host.router!.connectedNames()).toEqual(["live", "paper"]);
  });

  it("连上过又断了的,归会话层自己重连:这里不去抢(两边一起连会抢同一个 client id)", async () => {
    const { machine, link } = setup();
    machine.up.add(7497);
    link.start();
    await settle();
    machine.sessions[7497]!.connected = false; // 掉线,会话层正在重连
    const before = machine.attempts[7497];
    await link.retryOnce();
    expect(machine.attempts[7497]).toBe(before);
  });

  it("用户点了「断开」:之后不再自动连", async () => {
    const { machine, host, link } = setup();
    machine.up.add(7497);
    link.start();
    await settle();
    await link.disconnect();
    expect(host.router).toBeNull();
    const attempts = { ...machine.attempts };
    await link.retryOnce();
    expect(machine.attempts).toEqual(attempts);
  });

  it("掉线 / 重连回来:当场提醒、留痕、推给界面", async () => {
    const { machine, host, link } = setup();
    machine.up.add(7497);
    link.start();
    await settle();
    const s = machine.sessions[7497]!;
    for (const cb of s.linkCbs) cb(false);
    for (const cb of s.linkCbs) cb(true);
    expect(host.events.filter(([e]) => e === "broker_link").map(([, p]) => p)).toEqual([
      { connection: "paper", up: false }, { connection: "paper", up: true },
    ]);
    expect(host.notes.some((n) => n.includes("断开了") && n.includes("不会判断、也不会发单"))).toBe(true);
    expect(host.notes.some((n) => n.startsWith("券商已重新连上"))).toBe(true);
    const db = (host.engine.store as any).db;
    const actions = db.prepare("SELECT action FROM audit_log ORDER BY seq").all().map((r: Rec) => r["action"]);
    expect(actions).toEqual(expect.arrayContaining(["broker_link_down", "broker_link_up"]));
  });
});
