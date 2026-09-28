/** 交易库的保险(storeSafety.ts):结构版本号、完整性检查、自动备份、打不开时的人话。
 *
 * 库里有丢了就拿不回来的东西(IBKR 只给当天的成交)。这里钉:
 *  · 升级迁移之前、每天第一次打开时,各自动留一份备份;备份是一份能打开、内容齐全的库;
 *  · 每种原因只留最新的几份;
 *  · 比软件新的库、坏掉的库:拒绝打开,抛的是一句人话(StoreOpenError),不是 SqliteError;
 *  · 不带 safety 开的库(测试、黄金基线)一样都不做——不建备份目录、不盖版本号;
 *  · 引擎的 rpc 入口遇到打不开的库:退出码 EXIT_STORE,stderr 末两行是库路径与那句人话。
 * 全部离线,只碰临时目录。
 */
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main as cliMain } from "../src/cli.js";
import { RpcServer } from "../src/rpc.js";
import { TradeStore } from "../src/store.js";
import {
  EXIT_STORE, SCHEMA_VERSION, StoreOpenError, backupDir, createBackup, guardOnOpen, listBackups, pruneBackups,
  resetIntegrityCache,
} from "../src/storeSafety.js";

const BASE = readFileSync(path.resolve(__dirname, "..", "baseline", "rpc", "base_config.json"), "utf-8");
const DAY = 24 * 3600 * 1000;
const T0 = Date.parse("2026-09-28T01:00:00Z");

let dir = "";
let dbPath = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "dafri-safety-"));
  dbPath = path.join(dir, "trades.db");
  resetIntegrityCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 上文件可能还被占着(SQLite、刚退出的子进程):临时目录留给系统清 */
  }
});

function userVersion(file: string): number {
  const db = new Database(file, { readonly: true });
  try {
    return Number(db.pragma("user_version", { simple: true }));
  } finally {
    db.close();
  }
}

function openError(fn: () => unknown): StoreOpenError {
  try {
    fn();
  } catch (exc) {
    return exc as StoreOpenError;
  }
  throw new Error("本该打不开");
}

/** 一个"老版本软件留下的库":有数据、没有版本号、没有备份。 */
function legacyDb(): void {
  const store = new TradeStore(dbPath);
  store.addIdea("回调到位就买", ["AAPL"]);
  store.rememberFills([{ exec_id: "e1", account_id: "DU1", perm_id: "1", time: "2026-09-25T14:00:00Z", price: 1.5 }]);
  store.close();
}

describe("不带 safety:什么都不做(测试与黄金基线开库的方式)", () => {
  it("不建备份目录、不盖版本号", () => {
    legacyDb();
    new TradeStore(dbPath).close();
    expect(existsSync(backupDir(dbPath))).toBe(false);
    expect(userVersion(dbPath)).toBe(0);
  });
});

describe("带 safety 开库", () => {
  it("全新的库:盖上版本号,不出备份(没有东西可备)", () => {
    new TradeStore(dbPath, { safety: true }).close();
    expect(userVersion(dbPath)).toBe(SCHEMA_VERSION);
    expect(listBackups(dbPath)).toEqual([]);
  });

  it("老库第一次被新版本打开:先留一份 upgrade 备份,再盖版本号;备份里数据齐全、还是老版本号", () => {
    legacyDb();
    new TradeStore(dbPath, { safety: true }).close();
    expect(userVersion(dbPath)).toBe(SCHEMA_VERSION);
    const backups = listBackups(dbPath);
    expect(backups.map((b) => b.reason)).toEqual(["upgrade"]);
    const file = path.join(backupDir(dbPath), backups[0]!.name);
    expect(backups[0]!.bytes).toBeGreaterThan(0);
    expect(userVersion(file)).toBe(0); // 迁移之前的样子
    const copy = new TradeStore(file);
    expect(copy.listIdeas(null, 10).map((i) => i["text"])).toEqual(["回调到位就买"]);
    expect(copy.listFills()).toHaveLength(1);
    copy.close();
  });

  it("每天第一次打开留一份 daily;同一天再开不重复留", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    new TradeStore(dbPath, { safety: true }).close(); // 全新
    new TradeStore(dbPath, { safety: true }).close(); // 第二次:已有库、还没有 daily
    expect(listBackups(dbPath).map((b) => b.reason)).toEqual(["daily"]);
    vi.setSystemTime(T0 + 3 * 3600 * 1000);
    new TradeStore(dbPath, { safety: true }).close();
    expect(listBackups(dbPath)).toHaveLength(1);
    vi.setSystemTime(T0 + DAY);
    new TradeStore(dbPath, { safety: true }).close();
    expect(listBackups(dbPath).map((b) => b.at)).toEqual(["2026-09-29T01:00:00Z", "2026-09-28T01:00:00Z"]);
  });

  it("备份目录写不进去:照样开得了库(磁盘满了不该连带着停掉追踪)", () => {
    legacyDb();
    writeFileSync(backupDir(dbPath), "这里本该是个目录"); // 占住这个名字
    const lines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { lines.push(String(chunk)); return true; });
    const store = new TradeStore(dbPath, { safety: true });
    expect(store.listFills()).toHaveLength(1);
    store.close();
    expect(lines.join("")).toMatch(/备份没有成功/);
    expect(userVersion(dbPath)).toBe(SCHEMA_VERSION);
  });

  it("比软件新的库:拒绝打开,库原封不动", () => {
    legacyDb();
    const raw = new Database(dbPath);
    raw.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    const err = openError(() => new TradeStore(dbPath, { safety: true }));
    expect(err).toBeInstanceOf(StoreOpenError);
    expect(err.kind).toBe("newer");
    expect(err.message).toMatch(/更新版本的软件写的/);
    expect(err.dbPath).toBe(dbPath);
    expect(userVersion(dbPath)).toBe(SCHEMA_VERSION + 1);
    expect(listBackups(dbPath)).toEqual([]);
  });

  it("不是数据库的文件:corrupt,一句人话", () => {
    writeFileSync(dbPath, "这不是一个数据库文件".repeat(200));
    const err = openError(() => new TradeStore(dbPath, { safety: true }));
    expect(err).toBeInstanceOf(StoreOpenError);
    expect(err.kind).toBe("corrupt");
    expect(err.message).toMatch(/已损坏/);
  });

  it("不带 safety 时坏库抛的还是原来的错(不改老行为)", () => {
    writeFileSync(dbPath, "这不是一个数据库文件".repeat(200));
    const err = openError(() => new TradeStore(dbPath));
    expect(err).not.toBeInstanceOf(StoreOpenError);
  });

  it("完整性检查没过:corrupt,并且不去备份一个坏库", () => {
    legacyDb();
    const db = new Database(dbPath);
    const original = db.pragma.bind(db);
    vi.spyOn(db, "pragma").mockImplementation(((source: string, options?: never) =>
      source === "quick_check" ? [{ quick_check: "row 3 missing from index idx_fills_time" }] : original(source, options)) as never);
    const err = openError(() => guardOnOpen(db, dbPath, false, T0));
    db.close();
    expect(err.kind).toBe("corrupt");
    expect(err.message).toMatch(/没有通过完整性检查.*row 3 missing/);
    expect(listBackups(dbPath)).toEqual([]);
  });
});

describe("备份与清理", () => {
  it("每种原因只留最新的几份:daily 7、upgrade 3、manual 5", () => {
    legacyDb();
    const db = new Database(dbPath);
    for (let i = 0; i < 10; i += 1) createBackup(db, dbPath, "daily", T0 + i * DAY);
    for (let i = 0; i < 5; i += 1) createBackup(db, dbPath, "upgrade", T0 + i * DAY + 1000);
    for (let i = 0; i < 7; i += 1) createBackup(db, dbPath, "manual", T0 + i * DAY + 2000);
    db.close();
    const all = listBackups(dbPath);
    const count = (r: string): number => all.filter((b) => b.reason === r).length;
    expect([count("daily"), count("upgrade"), count("manual")]).toEqual([7, 3, 5]);
    // 留下的是最新的
    expect(all.filter((b) => b.reason === "daily").at(-1)?.at).toBe("2026-10-01T01:00:00Z");
    expect(all[0]!.at >= all.at(-1)!.at).toBe(true);
  });

  it("同一秒里出两份:不互相覆盖", () => {
    legacyDb();
    const db = new Database(dbPath);
    const a = createBackup(db, dbPath, "manual", T0);
    const b = createBackup(db, dbPath, "manual", T0);
    db.close();
    expect(a.name).toBe("trades-20260928-010000-manual.db");
    expect(b.name).toBe("trades-20260928-010000-manual-2.db");
    expect(listBackups(dbPath)).toHaveLength(2);
  });

  it("目录里别的文件不认、也不删", () => {
    legacyDb();
    const db = new Database(dbPath);
    createBackup(db, dbPath, "manual", T0);
    db.close();
    writeFileSync(path.join(backupDir(dbPath), "我自己拷的.db"), "x");
    writeFileSync(path.join(backupDir(dbPath), "trades-20260928-010000-manual.db-journal"), "x");
    expect(listBackups(dbPath).map((b) => b.name)).toEqual(["trades-20260928-010000-manual.db"]);
    pruneBackups(dbPath);
    expect(readdirSync(backupDir(dbPath)).sort()).toEqual([
      "trades-20260928-010000-manual.db", "trades-20260928-010000-manual.db-journal", "我自己拷的.db",
    ]);
  });

  it("WAL 里还没并回去的内容也在备份里", () => {
    const store = new TradeStore(dbPath, { safety: true });
    store.addIdea("刚写的,还在 WAL 里", []);
    const info = store.backupNow("manual");
    const copy = new TradeStore(path.join(backupDir(dbPath), info.name));
    expect(copy.listIdeas(null, 10)).toHaveLength(1);
    copy.close();
    store.close();
  });
});

describe("RPC:data.backups / data.backup", () => {
  it("清单、立即备份、审计留痕", async () => {
    const settingsPath = path.join(dir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ ...JSON.parse(BASE), storage: { db_path: dbPath } }));
    const server = new RpcServer(settingsPath, () => undefined);
    const before = await server.call("data.backups");
    expect(before).toMatchObject({ db_path: dbPath, dir: backupDir(dbPath), schema_version: SCHEMA_VERSION, backups: [] });
    const made = await server.call("data.backup");
    expect(made["backup"]).toMatchObject({ reason: "manual" });
    const after = await server.call("data.backups");
    expect(after["backups"]).toHaveLength(1);
    expect(after["backups"][0].name).toBe(made["backup"].name);
    const audit = server.engine.store.exportAll()["audit_log"] as Array<Record<string, unknown>>;
    expect(audit.some((row) => row["action"] === "backup")).toBe(true);
    server.engine.stopTrackerLoop();
    server.engine.store.close();
  });

  it("两个方法都在本地道:不排在下单与解析后面", () => {
    expect(RpcServer.LOCAL_METHODS.has("data.backups")).toBe(true);
    expect(RpcServer.LOCAL_METHODS.has("data.backup")).toBe(true);
  });
});

describe("引擎的 rpc 入口:交易库打不开", () => {
  it("退出码 EXIT_STORE;stderr 末两行是库路径与一句人话,没有调用栈", async () => {
    writeFileSync(dbPath, "坏掉的库".repeat(500));
    const settingsPath = path.join(dir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ ...JSON.parse(BASE), storage: { db_path: dbPath } }));
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
    const code = await cliMain(["rpc", "--config", settingsPath]);
    expect(code).toBe(EXIT_STORE);
    expect(EXIT_STORE).toBe(74);
    expect(lines).toEqual([
      `[fatal:store:path] ${dbPath}`,
      expect.stringMatching(/^\[fatal:store:corrupt\] 交易库文件已损坏/),
    ]);
  });
});
