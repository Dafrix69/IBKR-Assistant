/** 交易库的恢复(desktop/store-guard.js)。
 *
 * 钉的是:只从 backups/ 里、只按引擎起的那种文件名恢复;现在这份库连同 WAL 一起挪走而不是删掉;
 * 恢复出来的库引擎打得开、内容是备份那一刻的;引擎打的那两行(库路径 + 原因)桌面端认得出来。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TradeStore } from "../src/store.js";
import { EXIT_STORE, backupDir, listBackups as engineList, resetIntegrityCache } from "../src/storeSafety.js";

const DESKTOP = path.resolve(__dirname, "..", "..", "desktop");
const require = createRequire(import.meta.url);

interface Info { name: string; reason: string; at: string; bytes: number }
interface Guard {
  EXIT_STORE: number;
  backupDir(dbPath: string): string;
  listBackups(dbPath: string): Info[];
  describeBackup(b: Info): string;
  fatalLine(detail: string): { kind: string; message: string; dbPath: string | null } | null;
  restoreBackup(dbPath: string, name: string, opts?: { now?: number; aside?: string }): { restored: string; kept: string | null };
}
const guard = require(path.join(DESKTOP, "store-guard.js")) as Guard;

let dir = "";
let dbPath = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "dafri-restore-"));
  dbPath = path.join(dir, "trades.db");
  resetIntegrityCache();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** 库里先有一条想法 → 备份 → 再加一条。返回备份的文件名。 */
function seed(): string {
  const store = new TradeStore(dbPath, { safety: true });
  store.addIdea("备份之前写的", []);
  const name = store.backupNow("manual").name;
  store.addIdea("备份之后写的", []);
  store.close();
  return name;
}

describe("两头说的是同一回事", () => {
  it("退出码、备份目录、备份清单:引擎和桌面端一致", () => {
    expect(guard.EXIT_STORE).toBe(EXIT_STORE);
    expect(guard.backupDir(dbPath)).toBe(backupDir(dbPath));
    seed();
    expect(guard.listBackups(dbPath)).toEqual(engineList(dbPath));
  });

  it("引擎 rpc 入口打的那两行,桌面端认得出来", () => {
    const tail = `[engine] 启动引擎\n[fatal:store:path] ${dbPath}\n[fatal:store:corrupt] 交易库文件已损坏,读不出来(file is not a database)。可以从备份恢复。`;
    expect(guard.fatalLine(tail)).toEqual({
      kind: "corrupt", dbPath,
      message: "交易库文件已损坏,读不出来(file is not a database)。可以从备份恢复。",
    });
    expect(guard.fatalLine("[fatal:store:newer] 交易库是更新版本的软件写的")).toMatchObject({ kind: "newer", dbPath: null });
    expect(guard.fatalLine("SqliteError: disk I/O error")).toBeNull();
  });
});

describe("恢复", () => {
  it("恢复到备份那一刻;现在这份库挪到旁边,没有删", () => {
    const name = seed();
    const done = guard.restoreBackup(dbPath, name, { now: new Date(2026, 8, 28, 10, 0, 0).getTime() });
    expect(done).toEqual({ restored: name, kept: `${dbPath}.before-restore-20260928-100000` });

    const restored = new TradeStore(dbPath, { safety: true });
    expect(restored.listIdeas(null, 10).map((i) => i["text"])).toEqual(["备份之前写的"]);
    restored.close();

    const kept = new TradeStore(String(done.kept));
    expect(kept.listIdeas(null, 10)).toHaveLength(2);
    kept.close();
    // 备份本身还在:还能再恢复一次
    expect(guard.listBackups(dbPath).some((b) => b.name === name)).toBe(true);
    expect(readdirSync(dir).filter((f) => f.includes(".restoring-"))).toEqual([]);
  });

  it("旧库的 WAL / SHM 跟着一起挪走,不留在新库旁边", () => {
    const name = seed();
    writeFileSync(`${dbPath}-wal`, "旧的 WAL");
    writeFileSync(`${dbPath}-shm`, "旧的 SHM");
    const done = guard.restoreBackup(dbPath, name);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    expect(existsSync(`${done.kept}-wal`)).toBe(true);
    expect(existsSync(`${done.kept}-shm`)).toBe(true);
  });

  it("库本身坏了:坏的那份改名成 .corrupt-…,恢复出来的能打开", () => {
    const name = seed();
    writeFileSync(dbPath, "坏掉了".repeat(300));
    const done = guard.restoreBackup(dbPath, name, { aside: "corrupt", now: new Date(2026, 8, 28, 10, 0, 0).getTime() });
    expect(done.kept).toBe(`${dbPath}.corrupt-20260928-100000`);
    const restored = new TradeStore(dbPath, { safety: true });
    expect(restored.listIdeas(null, 10)).toHaveLength(1);
    restored.close();
  });

  it("库文件不见了也能恢复", () => {
    const name = seed();
    rmSync(dbPath);
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    expect(guard.restoreBackup(dbPath, name).kept).toBeNull();
    expect(existsSync(dbPath)).toBe(true);
  });

  it("只认备份的文件名:路径、别的文件、不存在的,一律拒,库原封不动", () => {
    const name = seed();
    const before = readdirSync(dir).sort();
    for (const bad of ["../trades.db", `../backups/${name}`, "/etc/passwd", "trades.db", "我自己拷的.db", "trades-20260101-000000-manual.db", "", name.replace(".db", ".db-wal")]) {
      expect(() => guard.restoreBackup(dbPath, bad), bad).toThrow(/不是一份备份的文件名|找不到这份备份/);
    }
    expect(() => guard.restoreBackup(dbPath, undefined as never)).toThrow(/不是一份备份的文件名/);
    expect(readdirSync(dir).sort()).toEqual(before);
  });

  it("名字对、内容不是数据库:拒,库原封不动", () => {
    seed();
    mkdirSync(guard.backupDir(dbPath), { recursive: true });
    writeFileSync(path.join(guard.backupDir(dbPath), "trades-20260101-000000-manual.db"), "不是数据库".repeat(100));
    expect(() => guard.restoreBackup(dbPath, "trades-20260101-000000-manual.db")).toThrow(/不是一个数据库文件/);
    const store = new TradeStore(dbPath);
    expect(store.listIdeas(null, 10)).toHaveLength(2);
    store.close();
  });

  it("describeBackup:一行人话", () => {
    expect(guard.describeBackup({ name: "x", reason: "daily", at: "2026-09-28T01:00:00Z", bytes: 1_843_200 })).toMatch(/每日自动 · 1\.8 MB$/);
    expect(guard.describeBackup({ name: "x", reason: "upgrade", at: "2026-09-28T01:00:00Z", bytes: 2048 })).toMatch(/升级前 · 2 KB$/);
  });
});
