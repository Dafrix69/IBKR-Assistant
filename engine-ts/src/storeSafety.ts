/** 交易库的保险:结构版本号、完整性检查、自动备份、打不开时的人话(store.ts 打开库时调)。
 *
 * 为什么要有:库里有些东西丢了就再也拿不回来——IBKR 只给当天的成交,`broker_fills` 是一天一天攒出来的;
 * 追踪表里记着哪张止损已经触发过。而在这之前,库没有版本号(老版本打开新库不会察觉)、没有备份
 * (迁移会整表重建 `position_tracks`,之前不留底)、打不开时每个 RPC 回一句英文的 SqliteError。
 *
 * 口径:
 *  · 版本号存在 `PRAGMA user_version`。库比这个版本的软件新 → 拒绝打开(老软件不认识新结构,硬开可能写坏);
 *    库比软件旧 → 先备份,再迁移,最后盖上新版本号。版本号 0 = 还没有版本号那时候的库,当作最旧。
 *  · 备份用 `VACUUM INTO`:一条语句出一份一致的快照,WAL 里还没并回去的内容也在里面,不用停库。
 *    放在库旁边的 backups/ 目录,文件名 `trades-年月日-时分秒-原因.db`。
 *  · 三种原因各留各的份数:daily(每天第一次打开时,留 7 份)、upgrade(升级迁移之前,留 3 份)、
 *    manual(用户点的、恢复之前自动留的,留 5 份)。
 *  · 备份失败不挡开库:磁盘满了不该连带着让持仓追踪停掉。它只往 stderr 记一句。
 *  · 完整性检查(`PRAGMA quick_check`)每个进程对每个库只做一次:引擎每改一次设置就重建一次 store。
 *
 * 只有真应用走这一套(TradeStore 的 safety 选项):测试和黄金基线开的库不建备份目录、不盖版本号。
 */
import type Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";

import type { BackupInfo, BackupReason } from "./contract/settings.js";

/** 库的结构版本。改了表结构(加列以外的)就加一,并在 store.ts 的 migrate 里写对应的迁移。 */
export const SCHEMA_VERSION = 1;

/** 引擎因为库打不开而退出时用的退出码(sysexits.h 的 EX_IOERR)。桌面端认它,同 EXIT_CONFIG。 */
export const EXIT_STORE = 74;

export type StoreOpenKind = "newer" | "corrupt" | "locked" | "unwritable";

/** 库打不开。message 是给用户看的一句话。 */
export class StoreOpenError extends Error {
  readonly kind: StoreOpenKind;
  readonly dbPath: string;

  constructor(kind: StoreOpenKind, dbPath: string, message: string) {
    super(message);
    this.name = "StoreOpenError";
    this.kind = kind;
    this.dbPath = dbPath;
  }
}

/** 把打开库时抛出来的东西认成 StoreOpenError;认不出来的(代码自己的错)原样还回去。 */
export function describeOpenFailure(exc: unknown, dbPath: string): unknown {
  if (exc instanceof StoreOpenError) return exc;
  const code = String((exc as { code?: unknown } | null)?.code ?? "");
  const detail = String((exc as Error | null)?.message ?? exc);
  if (code === "SQLITE_NOTADB" || code.startsWith("SQLITE_CORRUPT")) {
    return new StoreOpenError("corrupt", dbPath, `交易库文件已损坏,读不出来(${detail})。可以从备份恢复。`);
  }
  if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")) {
    return new StoreOpenError("locked", dbPath, "交易库正被另一个程序占用(多半是另一个 IBKR-Assistant 还没退干净)。请先退出它再试。");
  }
  if (
    code.startsWith("SQLITE_CANTOPEN") || code.startsWith("SQLITE_READONLY") || code.startsWith("SQLITE_IOERR") ||
    code === "SQLITE_FULL" || ["EACCES", "EPERM", "EROFS", "ENOSPC", "ENOTDIR"].includes(code)
  ) {
    return new StoreOpenError("unwritable", dbPath, `交易库所在的位置写不进去(${detail})。请检查文件夹权限与磁盘剩余空间。`);
  }
  return exc;
}

// ---- 备份 ---------------------------------------------------------------

const KEEP: Record<BackupReason, number> = { daily: 7, upgrade: 3, manual: 5 };
const NAME = /^trades-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(daily|upgrade|manual)(?:-\d+)?\.db$/;
/** 两份 daily 之间至少隔这么久:按"每天第一次打开"算,又不至于半夜重启一次就多出一份 */
const DAILY_GAP_MS = 20 * 3600 * 1000;

export function backupDir(dbPath: string): string {
  return path.join(path.dirname(dbPath), "backups");
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 文件名里的时间用 UTC:同一份库换个时区打开,备份的先后次序不变。 */
function stampOf(epochMs: number): string {
  const d = new Date(epochMs);
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `-${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`
  );
}

/** 备份目录里认得出来的备份,新的在前。目录不在就是空的。 */
export function listBackups(dbPath: string): BackupInfo[] {
  const dir = backupDir(dbPath);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: BackupInfo[] = [];
  for (const name of names) {
    const m = NAME.exec(name);
    if (!m) continue;
    let bytes = 0;
    try {
      bytes = fs.statSync(path.join(dir, name)).size;
    } catch {
      continue;
    }
    out.push({
      name,
      reason: m[7] as BackupReason,
      at: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`,
      bytes,
    });
  }
  return out.sort((a, b) => (a.at === b.at ? b.name.localeCompare(a.name) : b.at.localeCompare(a.at)));
}

/** 每种原因只留最新的那几份。 */
export function pruneBackups(dbPath: string): string[] {
  const removed: string[] = [];
  const seen: Record<BackupReason, number> = { daily: 0, upgrade: 0, manual: 0 };
  for (const b of listBackups(dbPath)) {
    seen[b.reason] += 1;
    if (seen[b.reason] <= KEEP[b.reason]) continue;
    try {
      fs.rmSync(path.join(backupDir(dbPath), b.name), { force: true });
      removed.push(b.name);
    } catch {
      /* 删不掉就留着,下次再试 */
    }
  }
  return removed;
}

/** 出一份快照。抛出来的是原始错误:要不要因此停下由调用方定。 */
export function createBackup(db: Database.Database, dbPath: string, reason: BackupReason, nowMs: number = Date.now()): BackupInfo {
  const dir = backupDir(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  const base = `trades-${stampOf(nowMs)}-${reason}`;
  let name = `${base}.db`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i += 1) name = `${base}-${i}.db`; // 同一秒里的第二份
  const target = path.join(dir, name);
  db.prepare("VACUUM INTO ?").run(target);
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // Windows 上尽力而为
  }
  pruneBackups(dbPath);
  const found = listBackups(dbPath).find((b) => b.name === name);
  if (!found) throw new Error(`备份写出来了却找不到:${target}`);
  return found;
}

// ---- 打开库时 -----------------------------------------------------------

const checkedThisProcess = new Set<string>();

function logStderr(text: string): void {
  process.stderr.write(`[store] ${text}\n`);
}

/** 建表 / 迁移**之前**调:拒绝比软件新的库、查完整性、该备份的先备份。fresh = 这个库文件是刚建的。 */
export function guardOnOpen(db: Database.Database, dbPath: string, fresh: boolean, nowMs: number = Date.now()): void {
  const version = Number(db.pragma("user_version", { simple: true })) || 0;
  if (version > SCHEMA_VERSION) {
    throw new StoreOpenError(
      "newer", dbPath,
      `交易库是更新版本的软件写的(库的结构版本 ${version},这个版本的软件只认到 ${SCHEMA_VERSION})。` +
      "请升级到最新版本再打开;硬开可能把库写坏。",
    );
  }
  if (fresh) return;
  if (!checkedThisProcess.has(dbPath)) {
    const rows = db.pragma("quick_check") as Array<Record<string, unknown>>;
    const verdict = rows.map((r) => String(Object.values(r)[0] ?? "")).filter((s) => s !== "ok");
    if (verdict.length) {
      throw new StoreOpenError(
        "corrupt", dbPath,
        `交易库没有通过完整性检查(${verdict.slice(0, 3).join(";")})。可以从备份恢复。`,
      );
    }
    checkedThisProcess.add(dbPath);
  }
  try {
    if (version < SCHEMA_VERSION) {
      const b = createBackup(db, dbPath, "upgrade", nowMs);
      logStderr(`升级前已备份:${b.name}`);
      return;
    }
    const lastDaily = listBackups(dbPath).find((b) => b.reason === "daily");
    if (!lastDaily || nowMs - Date.parse(lastDaily.at) >= DAILY_GAP_MS) {
      const b = createBackup(db, dbPath, "daily", nowMs);
      logStderr(`每日备份:${b.name}`);
    }
  } catch (exc) {
    logStderr(`备份没有成功(不影响使用):${(exc as Error).message}`);
  }
}

/** 建表 / 迁移**之后**调:盖上这个版本的结构版本号。 */
export function stampVersion(db: Database.Database): void {
  const version = Number(db.pragma("user_version", { simple: true })) || 0;
  if (version !== SCHEMA_VERSION) db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

/** 测试用:忘掉"这个库这个进程里查过了"。 */
export function resetIntegrityCache(): void {
  checkedThisProcess.clear();
}
