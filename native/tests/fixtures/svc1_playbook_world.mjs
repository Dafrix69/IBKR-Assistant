// 日内剧本(playbook)对拍用的假件的 JS 一半:假 IB 会话(managedAccounts / qualifyContracts / historicalData)、假盘口读取(marks.read)、
// 按日期答日线收盘的 router.historicalBars、以及剧本专用的几个步(files / logwrite / chmod / restart)。C++ 一半在 tests/svc1_playbook_world.h,
// 两边一句对一句,改一边就要改另一边。公共的世界(钟、计时器、日志、队列)在 svc1_world.mjs。
//
// ---- 约定
//  · 假会话的答案队列(条目格式同 svc1_world.mjs:{ok, delay?} | {err:{kind,message}, delay?},用完重复最后一个):
//      session.managed            managedAccounts() 的同步答案,缺省 ok ["DU7654321"];日志 session.managedAccounts
//      session.qualify            qualifyContracts(合约们, 超时):ok = true(写回 conId:指数 416904,期权 900000 + 行权价*2 + (C?1:0))
//                                 | 数字(把这个数写回每张合约)| 其它(false / null:conId 保持 0);缺省 ok true。日志 session.qualifyContracts [合约们, 超时]
//      session.historicalData|<键> 键 = 指数的代码(SPX),期权是 "<到期> <行权价><C|P>";没有就 |*;缺省 ok []。ok = 分钟线数组 {date, open, high, low, close}。
//                                 日志 session.historicalData [合约, {endDateTime, durationStr, barSizeSetting, whatToShow, useRTH}]
//  · 假盘口读取 marks.read:缺省 ok [];ok = [{strike, right, bid, ask, iv, error}…]。日志 marks.read [腿们, delayedOk, silentLimitMs]
//  · router.historicalBars|<start> 没有就 |*,缺省 ok [];日志 router.historicalBars [代码, start, end]
//  · 合约在日志里的样子同 broker_world.mjs 的 norm()(conId 为 0 也写)。
//  · 步:{op:"files", namesOnly?} → rec.files = [{name, text}…](namesOnly:只有名字);{op:"logwrite", date | dates, lines} 往 <库目录>/playbook/<date>.jsonl 追加
//    (字符串原样一行,对象 JSON.stringify);{op:"chmod", path, mode};{op:"restart"} 停掉旧的服务、按同一个宿主新建一个(接着用同一份底账)。
import { appendFileSync, chmodSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { norm } from './broker_world.mjs';
import { BASE_CONFIG, clone, dec, deepMerge, makeError, nextFor } from './svc1_world.mjs';

/** 当前虚拟钟下的 Settings:脚本自带的 base(没有就是基础配置)+ 脚本补丁 + 步里的补丁 + 临时库路径 */
export function makeSettings(config, world, patch) {
  const raw = deepMerge(deepMerge(world.script.base ?? BASE_CONFIG, world.script.settings ?? {}), patch ?? {});
  raw.storage = { db_path: world.dir + (world.script.dbPath ?? '/t.db') };
  return config.fromDict(JSON.parse(JSON.stringify(raw)));
}

export function makeSession(world, mods) {
  return {
    managedAccounts() {
      world.rec('session.managedAccounts', []);
      const e = world.next('session.managed', { ok: ['DU7654321'] });
      if (e.err !== undefined) throw makeError(e.err, mods);
      return clone(dec(e.ok));
    },
    qualifyContracts(contracts, timeoutMs) {
      world.rec('session.qualifyContracts', [contracts.map(norm), timeoutMs]);
      return world.answer(world.next('session.qualify', { ok: true }), mods).then((ok) => {
        for (const c of contracts) {
          if (ok === true) c.conId = c.secType === 'IND' ? 416904 : 900000 + Number(c.strike) * 2 + (c.right === 'C' ? 1 : 0);
          else if (typeof ok === 'number') c.conId = ok;
        }
      });
    },
    historicalData(contract, opts) {
      world.rec('session.historicalData', [norm(contract), opts]);
      const key = contract.secType === 'IND' ? contract.symbol : `${contract.lastTradeDateOrContractMonth} ${contract.strike}${contract.right}`;
      const entry = world.queues.has(`session.historicalData|${key}`) ? world.next(`session.historicalData|${key}`, { ok: [] })
        : world.next('session.historicalData|*', { ok: [] });
      return world.answer(entry, mods);
    },
  };
}

export function makeMarks(world, mods) {
  return {
    read(_session, legs, delayedOk, silentLimitMs) {
      world.rec('marks.read', [legs, delayedOk, silentLimitMs]);
      return world.answer(world.next('marks.read', { ok: [] }), mods);
    },
  };
}

/** makeRouter 造出来的 router,historicalBars 换成按 start 日期取队列的 */
export function patchRouter(world, mods, router) {
  router.historicalBars = (symbol, start, end) => {
    world.rec('router.historicalBars', [symbol, start, end]);
    return world.answer(nextFor(world, 'router.historicalBars', start, { ok: [] }), mods);
  };
  return router;
}

/** 剧本专用的步 */
export function makeExtraOps(world, restart) {
  const dir = () => join(world.dir, 'playbook');
  return {
    files(step, rec) {
      let names = [];
      try { names = readdirSync(dir()).sort(); } catch { /* 目录还没有 */ }
      rec.files = world.clean(names.map((name) => (step.namesOnly ? { name } : { name, text: readFileSync(join(dir(), name), 'utf8') })));
    },
    logwrite(step) {
      mkdirSync(dir(), { recursive: true });
      for (const date of step.dates ?? [step.date]) {
        for (const line of step.lines) {
          appendFileSync(join(dir(), `${date}.jsonl`), `${typeof line === 'string' ? line : JSON.stringify(line)}\n`, 'utf8');
        }
      }
    },
    chmod(step) { chmodSync(join(world.dir, step.path), step.mode); },
    restart() { restart(); },
  };
}
