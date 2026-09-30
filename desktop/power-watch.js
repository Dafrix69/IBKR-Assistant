'use strict';
/**
 * 电源与睡眠(主进程用)。main.js 只把 powerMonitor 的事件和引擎心跳里"在盯的追踪条数"喂进来,要记什么、要不要提醒在这里定。
 *
 * 用电池时合上笔记本,macOS 直接睡眠:`powerSaveBlocker('prevent-app-suspension')` 挡得住闲置睡眠,挡不住合盖。
 * 睡着以后引擎只在系统几秒钟的维护唤醒里跑一下,本机盯盘等于停了(docs/journal/stale-streams-after-sleep.md)。这里能做的只有两件:
 *
 *  · 睡下、醒来、换电源各记一行日志。事后对得上 `pmset -g log`,导出的诊断信息里就有,不用再去翻系统日志。
 *    维护唤醒每十几分钟一对"醒 / 睡",合盖一夜几十行,量可以接受。
 *  · 用电池、又有追踪在本机盯着时,提醒一次:这时合上盖子,盯盘就停了。合盖本身没有事件可听——睡下去之前应用只收到一个
 *    suspend,那时发的通知要等醒来才看得见——能提前说的只有"现在在用电池"这件事。一段电池期间只提醒一次,接回电源再拔掉算新的一段。
 *
 * 醒来之后"睡了多久、哪些追踪没人盯"由引擎说(engine-ts/src/engine/wakeGuard.ts):盯盘到底停了多久,它看得到,这里看不到。
 */

/** 分钟级的时长,给日志看 */
function minutesText(ms) {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))} 秒`;
  const min = Math.round(ms / 60_000);
  return min < 60 ? `${min} 分钟` : `${Math.floor(min / 60)} 小时 ${min % 60} 分`;
}

function batteryNotice(live) {
  return {
    title: '正在用电池:合上盖子,本机盯盘就停了',
    body:
      `有 ${live} 条追踪在本机盯着。用电池时合上笔记本,电脑会直接睡着,止盈止损、跟踪止损、利润回撤都不再判断。` +
      '要离开请接着电源、别合盖,或者给追踪打开「托管到券商」。',
  };
}

class PowerWatch {
  constructor() {
    /** null = 还不知道 */
    this.onBattery = null;
    this.live = 0;
    /** 这一段电池期间提醒过了 */
    this.warned = false;
    this.suspendedAt = null;
  }

  /**
   * 电源状态或在盯的追踪条数变了(没给的那一项不变)。返回 { log, notify },没有要做的事时两项都是 null。
   * `live` 取引擎心跳的 live_tracks;没连券商时传 0:那时本来就没在盯。
   */
  observe({ onBattery, live } = {}) {
    const out = { log: null, notify: null };
    if (typeof onBattery === 'boolean' && onBattery !== this.onBattery) {
      out.log = this.onBattery === null
        ? `[power] 现在${onBattery ? '用电池' : '接着电源'}`
        : `[power] ${onBattery ? '改用电池' : '接上了电源'}`;
      if (!onBattery) this.warned = false;
      this.onBattery = onBattery;
    }
    if (Number.isFinite(live)) this.live = Math.max(0, Math.trunc(live));
    if (this.onBattery === true && this.live > 0 && !this.warned) {
      this.warned = true;
      out.notify = batteryNotice(this.live);
    }
    return out;
  }

  /** 系统要睡了(powerMonitor 'suspend')。之后进程被冻住,这一行未必来得及落盘,醒来那一行会补上时长。 */
  suspend(now) {
    this.suspendedAt = now;
    const power = this.onBattery === null ? '' : this.onBattery ? ',用电池' : ',接着电源';
    return { log: `[power] 系统睡眠${power};在盯的追踪 ${this.live} 条`, notify: null };
  }

  /** 系统醒了(powerMonitor 'resume';维护唤醒也可能来这一声)。 */
  resume(now) {
    const slept = this.suspendedAt === null ? '' : `,睡了 ${minutesText(now - this.suspendedAt)}`;
    this.suspendedAt = null;
    return { log: `[power] 系统醒来${slept}`, notify: null };
  }
}

module.exports = { PowerWatch, batteryNotice, minutesText };
