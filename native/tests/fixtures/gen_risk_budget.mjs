// 生成 risk-budget.json:engine-ts/src/riskBudget.ts 的 riskBudgetWarning(原模块现跑)在开关、账户、品种、比例边界上的输出。
//   node native/tests/fixtures/gen_risk_budget.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const rb = await import(pathToFileURL(join(engine, 'dist/src/riskBudget.js')).href);
const cfgs = [
  { enabled: true, equity_usd: { 模拟: 50000, 主账户: 0, 小号: 1234.56 }, max_risk_pct: 1, max_position_pct: 20 },
  { enabled: false, equity_usd: { 模拟: 50000 }, max_risk_pct: 1, max_position_pct: 20 },
  { enabled: true, equity_usd: { 模拟: 30000 }, max_risk_pct: 0.5, max_position_pct: 33.35 },
];
const cases = [];
for (const [ci, cfg] of cfgs.entries()) {
  for (const alias of ['模拟', '主账户', '小号', '没有']) {
    for (const sec of ['STK', 'OPT', 'BAG']) {
      for (const exposure of [0, -5, NaN, 100, 500, 499.99, 500.01, 10000, 10005, 16675, 16680, 123.456, 1e6]) {
        cases.push({ ci, alias, sec, exposure: Number.isNaN(exposure) ? 'NaN' : exposure, out: rb.riskBudgetWarning(cfg, alias, sec, exposure) });
      }
    }
  }
}
writeFileSync(join(here, 'risk-budget.json'), JSON.stringify({ generator: 'native/tests/fixtures/gen_risk_budget.mjs', cfgs, cases }, null, 1) + '\n');
console.log(`risk-budget.json:${cases.length} 个`);
