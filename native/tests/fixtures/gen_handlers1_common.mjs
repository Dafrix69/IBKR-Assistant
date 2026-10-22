// handlers1 簇的生成器共用的小东西:模块加载、持仓行 / 路由器 / 脚本的拼法。
// 用法见各 gen_handlers1_*.mjs:
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_handlers1_tracker.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHandlerMods, runHandlers } from './handlers1_world.mjs';

export const here = dirname(fileURLToPath(import.meta.url));
export const START = Date.parse('2026-09-11T12:00:00-04:00'); // 周五,交易日,美东 12:00
export const SEC = 1000;
export const call = (id, m, a = {}) => ({ op: 'call', id, m, a });

export async function setup() {
  const engine = process.argv[2];
  if (!engine) throw new Error('要给编过的 engine-ts 目录');
  const mods = await loadHandlerMods(engine);
  const tk = await mods.imp('tracker');
  return { mods, tk };
}

export class Builder {
  constructor(mods, tk) {
    this.mods = mods;
    this.tk = tk;
    this.scenarios = [];
  }
  add(name, script) {
    this.scenarios.push({ name, script: { start: START, ...script } });
  }
  /** 正股:模拟账户 100 股 BE,成本 100,现价 120 */
  stock(o = {}) {
    const { tk } = this;
    const symbol = o.symbol ?? 'BE', account = o.account ?? '模拟';
    return {
      key: tk.makeKey(account, symbol, 'STK'), account, symbol, sec_type: 'STK', leg: '', quantity: 100, avg_cost: 100, multiplier: 1, currency: 'USD',
      market_price: 120, market_value: 12000, unrealized_pnl: 2000, contract: { secType: 'STK', symbol }, ...o,
    };
  }
  /** 期权腿(SPX 当日到期的周权) */
  leg(strike, right, qty, avgCost, price, o = {}) {
    const { tk } = this;
    const secType = o.secType ?? 'OPT', symbol = o.symbol ?? 'SPX', account = o.account ?? '模拟';
    const contract = {
      secType, symbol, lastTradeDateOrContractMonth: o.expiry ?? '20260911', strike, right, multiplier: '100', tradingClass: o.tradingClass ?? 'SPXW', ...(o.contract ?? {}),
    };
    const ident = tk.legOf(contract);
    return {
      key: tk.makeKey(account, symbol, secType, ident), account, symbol, sec_type: secType, leg: ident, quantity: qty, avg_cost: avgCost, multiplier: 100, currency: 'USD',
      market_price: price, market_value: null, unrealized_pnl: null, contract, ...(o.row ?? {}),
    };
  }
  /** 多头看涨蝶 7500/7525/7550 */
  fly(o = {}) {
    return [this.leg(7500, 'C', 1, 3000, 35, o), this.leg(7525, 'C', -2, 1200, 18, o), this.leg(7550, 'C', 1, 300, 6, o)];
  }
  bagKey(rows) {
    const bag = this.tk.withCombos(rows).find((r) => r.sec_type === 'BAG');
    if (!bag) throw new Error('没有组合行');
    return bag.key;
  }
  /** router 脚本 */
  router(rows, over = {}) {
    return { sessions: 1, results: { positions: [{ value: rows }] }, ...over };
  }
}

export async function finish(builder, mods, file) {
  const out = [];
  for (const sc of builder.scenarios) {
    const expected = await runHandlers(sc.script, mods);
    out.push({ name: sc.name, script: sc.script, expected });
    if (process.env.H1_SUMMARY) {
      const lines = [];
      for (const st of expected.steps) for (const d of st.done ?? []) {
        const r = d.result;
        lines.push(`${d.id}:${r.error ? `E${r.error.code} ${r.error.message.slice(0, 70)}` : (process.env.H1_VERBOSE ? `ok ${JSON.stringify(r.result).slice(0, Number(process.env.H1_VERBOSE))}` : 'ok')}`);
      }
      console.log(`- ${sc.name}\n    ${lines.join(' | ')}`);
    }
  }
  const text = JSON.stringify({ scenarios: out });
  writeFileSync(join(here, file), text);
  console.log(`${file}: ${out.length} 个场景,${(text.length / 1024).toFixed(0)} KB`);
}
