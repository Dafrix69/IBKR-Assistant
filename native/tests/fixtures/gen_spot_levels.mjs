// 生成 spot-levels.json:SPX 走到 25 的整数倍时的提醒判定(desktop/renderer-react/src/lib/spotLevels.ts)现算的结果,
// C++ 的 shell/spot_levels 逐条对。每个序列从空状态起一笔一笔喂,记下每一步的状态与报出来的关口。
//   node native/tests/fixtures/gen_spot_levels.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const S = await import(join(here, '..', '..', '..', 'desktop/renderer-react/src/lib/spotLevels.ts'));
const q = (price, at, source = 'quote') => ({ price, source, at });
const T0 = 1_760_000_000_000;
const sequences = {
  firstOnlyRegisters: [q(7712, T0)],
  upThroughOne: [q(7712, T0), q(7726, T0 + 2000)],
  touchCounts: [q(7712, T0), q(7725, T0 + 2000)],
  downThroughOne: [q(7712, T0), q(7699.5, T0 + 2000)],
  downTouch: [q(7712, T0), q(7700, T0 + 2000)],
  jumpTwo: [q(7690, T0), q(7752, T0 + 2000)],
  jumpTwoDown: [q(7760, T0), q(7698, T0 + 2000)],
  rubOnLevel: [q(7720, T0), q(7726, T0 + 2000), q(7724, T0 + 4000), q(7726, T0 + 6000), q(7711, T0 + 8000), q(7726, T0 + 10000)],
  leaveHalfStepThenBack: [q(7720, T0), q(7726, T0 + 2000), q(7737.5, T0 + 4000), q(7724, T0 + 6000), q(7712.4, T0 + 8000), q(7725.1, T0 + 10000)],
  gapTooLong: [q(7712, T0), q(7730, T0 + 30_001), q(7751, T0 + 32_000)],
  gapExactly: [q(7712, T0), q(7730, T0 + 30_000)],
  sourceSwitch: [q(7712, T0), q(7730, T0 + 2000, 'futures'), q(7751, T0 + 4000, 'futures')],
  unusableKeepsState: [q(7712, T0), q(null, T0 + 2000), q(7730, T0 + 4000, 'stale'), q(0, T0 + 5000), q(7726, T0 + 6000)],
  unusableThenGap: [q(7712, T0), q(7780, T0 + 10_000, 'none'), q(7726, T0 + 40_000)],
  backwardsTime: [q(7712, T0), q(7730, T0 - 1)],
  samePrice: [q(7725, T0), q(7725, T0 + 2000)],
  nanPrice: [q(7712, T0), q(NaN, T0 + 2000), q(7726, T0 + 4000)],
  fractional: [q(7724.99, T0), q(7725.0000001, T0 + 2000), q(7699.999, T0 + 4000)],
};
const out = { generator: 'native/tests/fixtures/gen_spot_levels.mjs', step: S.LEVEL_STEP, gapMs: S.GAP_MS, sequences: {}, near: [], text: [] };
for (const [name, samples] of Object.entries(sequences)) {
  let state = S.EMPTY_WATCH;
  const steps = [];
  for (const sample of samples) {
    const next = S.stepLevelWatch(state, sample);
    state = next.state;
    steps.push({ sample: { ...sample, price: Number.isNaN(sample.price) ? 'NaN' : sample.price }, state, hit: next.hit });
  }
  out.sequences[name] = steps;
}
for (const p of [7712.4, 7725, 7699.99, 25, 0.5]) out.near.push({ price: p, out: S.nearLevels(p) });
for (const hit of [{ level: 7725, direction: 'up', price: 7726.333, source: 'quote', at: 1, skipped: 0 }, { level: 7700, direction: 'down', price: 7698.005, source: 'futures', at: 1, skipped: 1 },
  { level: 7750, direction: 'up', price: 7750, source: 'futures', at: 1, skipped: 0 }])
  out.text.push({ hit, title: S.levelHitTitle('SPX', hit), body: S.levelHitBody(hit) });
writeFileSync(join(here, 'spot-levels.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`spot-levels.json: ${Object.keys(out.sequences).length} sequences`);
