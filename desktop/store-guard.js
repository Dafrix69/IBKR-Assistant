'use strict';
/**
 * 交易库的恢复(主进程用)。备份是引擎出的(engine-ts/src/storeSafety.ts),恢复在这里做——
 * 换库文件的时候引擎必须是停着的,而能停引擎的只有主进程。
 *
 * 口径:
 *  · 只从库旁边的 backups/ 目录恢复,只认引擎起的那种文件名;界面递过来的只是一个文件名,不是路径。
 *  · 现在这份库不删:改名留在旁边(.before-restore-时间戳 / 打不开的是 .corrupt-时间戳),
 *    连同它的 -wal / -shm 一起挪走——留着它们,新库会被旧的 WAL"回放"成一锅粥。
 *  · 恢复完不动备份本身:还能再恢复一次。
 *
 * 这里是纯文件操作(好测);停引擎、弹确认框、再拉起引擎在 main.js。
 */
const fs = require('node:fs');
const path = require('node:path');

/** 与 engine-ts/src/storeSafety.ts 的 EXIT_STORE 是同一个数(tests/desktop-store-guard.spec.ts 钉着)。 */
const EXIT_STORE = 74;

const BACKUP_NAME = /^trades-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(daily|upgrade|manual)(?:-\d+)?\.db$/;

const REASON_LABEL = { daily: '每日自动', upgrade: '升级前', manual: '手动' };

function backupDir(dbPath) {
  return path.join(path.dirname(dbPath), 'backups');
}

/** 备份目录里认得出来的备份,新的在前。 */
function listBackups(dbPath) {
  let names;
  try {
    names = fs.readdirSync(backupDir(dbPath));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const m = BACKUP_NAME.exec(name);
    if (!m) continue;
    try {
      const bytes = fs.statSync(path.join(backupDir(dbPath), name)).size;
      if (bytes <= 0) continue;
      out.push({ name, reason: m[7], at: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`, bytes });
    } catch {
      /* 读不到就不算 */
    }
  }
  return out.sort((a, b) => (a.at === b.at ? b.name.localeCompare(a.name) : b.at.localeCompare(a.at)));
}

/** 给人看的一行:2026-09-28 09:00 · 每日自动 · 1.2 MB */
function describeBackup(b) {
  const when = new Date(b.at).toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const size = b.bytes >= 1024 * 1024 ? `${(b.bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b.bytes / 1024))} KB`;
  return `${when} · ${REASON_LABEL[b.reason] || b.reason} · ${size}`;
}

/**
 * 从引擎 stderr 的尾巴里找出库打不开的那两行。
 * @returns {{ kind: string, message: string, dbPath: string | null } | null}
 */
function fatalLine(detail) {
  const lines = String(detail || '').split(/\r?\n/);
  let found = null;
  let dbPath = null;
  for (const line of lines) {
    const p = /\[fatal:store:path\]\s*(.+)$/.exec(line);
    if (p) dbPath = p[1].trim();
    const m = /\[fatal:store:(newer|corrupt|locked|unwritable)\]\s*(.*)$/.exec(line);
    if (m) found = { kind: m[1], message: m[2].trim() };
  }
  return found ? { ...found, dbPath } : null;
}

function stamp(epochMs) {
  const d = new Date(epochMs);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 用一份备份换掉现在的库。**调用之前引擎必须已经停了。**
 * @param {string} dbPath
 * @param {string} name   备份的文件名(不是路径)
 * @param {{ now?: number, aside?: 'before-restore' | 'corrupt' }} [opts]
 * @returns {{ restored: string, kept: string | null }} kept:现在这份库挪到了哪
 */
function restoreBackup(dbPath, name, { now = Date.now(), aside = 'before-restore' } = {}) {
  if (typeof name !== 'string' || !BACKUP_NAME.test(name)) throw new Error('这不是一份备份的文件名');
  const source = path.join(backupDir(dbPath), name);
  const stat = fs.statSync(source, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.size <= 0) throw new Error(`找不到这份备份:${name}`);
  // SQLite 文件开头 16 个字节是固定的:不是它就别往库的位置上放
  const head = Buffer.alloc(16);
  const fd = fs.openSync(source, 'r');
  try {
    fs.readSync(fd, head, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (head.toString('latin1') !== 'SQLite format 3\u0000') throw new Error(`这份备份不是一个数据库文件:${name}`);

  let kept = null;
  if (fs.existsSync(dbPath)) {
    kept = `${dbPath}.${aside}-${stamp(now)}`;
    fs.renameSync(dbPath, kept);
  }
  for (const suffix of ['-wal', '-shm']) {
    const side = dbPath + suffix;
    if (!fs.existsSync(side)) continue;
    // 跟着主文件一起挪走;主文件不在时(只剩孤零零的 WAL)直接删
    if (kept) fs.renameSync(side, kept + suffix);
    else fs.rmSync(side, { force: true });
  }
  // 先拷到旁边再 rename:拷到一半断电,库的位置上不会出现半个文件
  const tmp = `${dbPath}.restoring-${process.pid}`;
  fs.copyFileSync(source, tmp);
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* Windows 上尽力而为 */
  }
  fs.renameSync(tmp, dbPath);
  return { restored: name, kept };
}

module.exports = { EXIT_STORE, BACKUP_NAME, backupDir, listBackups, describeBackup, fatalLine, restoreBackup };
