'use strict';
/**
 * 盯盘时合盖不睡(macOS,主进程用)。main.js 只负责读 `pmset -g`、弹系统的管理员授权框去改、把结果喂回来;
 * 什么时候关掉合盖睡眠、什么时候恢复、被拒了之后还问不问,都在这里定。
 *
 * 合上笔记本盖子,macOS 直接睡眠(插着电源也一样,pmset 日志里是 'Clamshell Sleep'),本机盯盘全停。
 * 应用自己的 powerSaveBlocker 只挡得住闲置睡眠;挡合盖只有 `pmset -a disablesleep 1` 一条路,要管理员权限、整机生效。
 *
 *  · 默认打开:有追踪在本机盯着、合盖睡眠还开着,就弹一次系统授权框把它关掉。授权框是 macOS 自己的,密码不经过应用。
 *  · 只恢复自己关掉的那一次(owned)。用户自己在终端里关的,应用不碰。
 *  · 没有追踪在盯满 10 分钟、在菜单里关掉这一项、退出应用时,恢复合盖睡眠。追踪一会儿有一会儿没(删了重建、
 *    平仓后马上开下一只)不来回弹框。
 *  · 授权框被取消:这一段盯盘期间不再问(盯的条数回到 0 再起来算新的一段)。恢复被取消:退出之前不再问。
 *  · owned 落盘(userData/lid-guard.json):应用崩了重开,还认得那是自己关的,没追踪在盯了照样恢复。
 */
const fs = require('node:fs');

/** 没有追踪在盯满这么久才恢复合盖睡眠 */
const OFF_DELAY_MS = 10 * 60_000;

const PROMPT = 'IBKR-Assistant 要在盯盘期间阻止合盖睡眠:合上盖子时持仓追踪照常运行。';

/** `pmset -g` 的输出里读 SleepDisabled。读不出来回 null(按不知道处理,什么都不做)。 */
function parseSleepDisabled(text) {
  const m = /^\s*SleepDisabled\s+(\d)/m.exec(String(text || ''));
  return m ? m[1] !== '0' : null;
}

/** 交给 osascript 的那一句:由 macOS 弹管理员授权框,再跑 pmset。 */
function pmsetScript(on) {
  return `do shell script "/usr/bin/pmset -a disablesleep ${on ? 1 : 0}" with administrator privileges with prompt "${PROMPT}"`;
}

/** osascript 的失败里认出"用户点了取消"(-128)。 */
function isCancelled(err) {
  const text = `${(err && err.stderr) || ''} ${(err && err.message) || ''}`;
  return /-128|User cancell?ed|用户已取消/.test(text);
}

function loadState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { enabled: raw.enabled !== false, owned: raw.owned === true };
  } catch {
    return { enabled: true, owned: false };
  }
}

function saveState(file, state) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ enabled: Boolean(state.enabled), owned: Boolean(state.owned) }, null, 2));
  fs.renameSync(tmp, file);
}

const NONE = Object.freeze({ set: null, log: null, notify: null });

class LidGuard {
  constructor({ enabled = true, owned = false } = {}) {
    this.enabled = enabled;
    this.owned = owned;
    /** null = 还没读到 */
    this.sleepDisabled = null;
    this.live = 0;
    this.idleSince = null;
    /** 这一段盯盘期间授权框被取消过 */
    this.declined = false;
    /** 恢复被取消过:退出之前不再问 */
    this.restoreDeclined = false;
    /** 有一次授权框在等回应 */
    this.busy = false;
  }

  /** 要不要去读 `pmset -g`:没追踪在盯、也不是自己关的,就不用每 10 秒跑一次(这时 observe 也不会要求改) */
  wantsReading(live) {
    return (this.enabled && live > 0) || this.owned;
  }

  /**
   * 心跳每一问之后。live = 在盯的追踪条数;sleepDisabled = 刚读到的 SleepDisabled(没读就不给)。
   * 返回 { set: true | false | null, log, notify }:set 不为 null 时由调用方去改,改完调 done()。
   */
  observe({ live, sleepDisabled, now }) {
    if (Number.isFinite(live)) {
      const next = Math.max(0, Math.trunc(live));
      if (next === 0 && this.live > 0) this.declined = false; // 这一段盯完了,下一段重新问
      this.live = next;
    }
    if (this.live > 0) this.idleSince = null;
    else if (this.idleSince === null) this.idleSince = now;
    if (typeof sleepDisabled === 'boolean') {
      this.sleepDisabled = sleepDisabled;
      // 自己关的被人在终端里恢复了:那是人的意思,不再算自己的,这一段也不再去关
      if (!sleepDisabled && this.owned) {
        this.owned = false;
        this.declined = true;
      }
    }
    if (this.busy || this.sleepDisabled === null) return NONE;
    if (this.enabled && this.live > 0 && !this.sleepDisabled && !this.declined) {
      this.busy = true;
      return { set: true, log: `[power] 有 ${this.live} 条追踪在盯,请求关掉合盖睡眠`, notify: null };
    }
    if (this.owned && this.sleepDisabled && !this.restoreDeclined) {
      const idleLongEnough = this.live === 0 && this.idleSince !== null && now - this.idleSince >= OFF_DELAY_MS;
      if (!this.enabled || idleLongEnough) {
        this.busy = true;
        return { set: false, log: `[power] ${this.enabled ? '没有追踪在盯满 10 分钟' : '「盯盘时合盖不睡」已关'},请求恢复合盖睡眠`, notify: null };
      }
    }
    return NONE;
  }

  /** 退出应用之前:自己关掉的要恢复 */
  quitAction() {
    if (this.busy || !this.owned || this.sleepDisabled === false) return NONE;
    this.busy = true;
    return { set: false, log: '[power] 退出应用,请求恢复合盖睡眠', notify: null };
  }

  /** 菜单里勾上 / 去掉。之后紧跟一次 observe() 就会去改。 */
  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    this.declined = false;
    this.restoreDeclined = false;
  }

  /** 改的结果。outcome = 'ok' | 'cancelled' | 'failed' */
  done(on, outcome, detail = '') {
    this.busy = false;
    if (on) {
      if (outcome === 'ok') {
        this.owned = true;
        this.sleepDisabled = true;
        return {
          set: null,
          log: '[power] 已关掉合盖睡眠(盯盘期间)',
          notify: {
            title: '盯盘期间合盖不睡',
            body:
              `有 ${this.live} 条追踪在本机盯着,合上盖子也照常盯。机器会一直跑:别放进包里,用电池时电会耗光。` +
              '没有追踪在盯满 10 分钟、或退出应用时,恢复合盖睡眠。',
          },
        };
      }
      this.declined = true;
      return {
        set: null,
        log: `[power] 关掉合盖睡眠没成:${outcome === 'cancelled' ? '授权框被取消' : detail || '执行失败'}`,
        notify: {
          title: '合上盖子,本机盯盘仍会停',
          body:
            '没有关掉合盖睡眠,这一段盯盘期间不再问。要离开请别合盖,或者给追踪打开「托管到券商」;' +
            '不想再被问,在菜单「交易 → 盯盘时合盖不睡」里关掉这一项。',
        },
      };
    }
    if (outcome === 'ok') {
      this.owned = false;
      this.sleepDisabled = false;
      return { set: null, log: '[power] 已恢复合盖睡眠', notify: null };
    }
    this.restoreDeclined = true;
    return {
      set: null,
      log: `[power] 恢复合盖睡眠没成:${outcome === 'cancelled' ? '授权框被取消' : detail || '执行失败'}`,
      notify: {
        title: '合盖睡眠还关着',
        body: '合上盖子电脑不会睡。要恢复,在终端里运行 sudo pmset -a disablesleep 0,或者退出应用时在授权框里允许。',
      },
    };
  }

  state() {
    return { enabled: this.enabled, owned: this.owned };
  }
}

module.exports = { LidGuard, OFF_DELAY_MS, parseSleepDisabled, pmsetScript, isCancelled, loadState, saveState };
