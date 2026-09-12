/**
 * 股票池身上的两个开关:「盯价位」与「盯异动」。
 *
 * 统一后的模型:一只股登记一次(板块成分股 = 股票池),`alert_watches` 有这一行 ⟺ 盯价位开,
 * `quality_stocks` 有这一行 ⟺ 盯异动开。两张表还是各存各的状态(价位 / 墙 / 触发记录;档位 / 滞回 / 异动记录),
 * 但**成员身份只由池子说了算**,所以界面上只有这两个开关,没有第三个"加入 / 移出"的动作。
 *
 * 这里只做三件事:调 `pool.set_watch`、把回执里**没做成的那一路如实说出来**(上限、指数不能盯异动),
 * 然后重读两张表——开关的真值以引擎为准,不做乐观改写:30 只上限就在这条路上,
 * 先把开关拨开再被引擎拒掉,人会以为真开了。
 */
import { dafri, errorMessage, type PoolWatch, type PoolWatchPatch } from '../bridge';
import { loadAlerts } from './alerts';
import { showBanner } from './banner';
import { loadQuality } from './quality';

function cleanList(v: unknown): string[] {
  return (Array.isArray(v) ? v : []).map((x) => String(x ?? '').trim()).filter(Boolean);
}

/**
 * 回执里没做成的那几路:照引擎的原话说,不改写成"成功了"。
 * 一次 AI 选股十几只很容易吃满 30 只上限,这几句话是用户唯一能知道"哪几只没开上"的地方。
 */
export function reportSkipped(prefix: string, skipped: unknown): boolean {
  const reasons = cleanList(skipped);
  if (!reasons.length) return false;
  showBanner(`${prefix}${reasons.join(';')}`, true);
  return true;
}

/** 成分股被移出池子后连带删掉的 watch / quality 行:界面要说人话,不能悄悄消失。 */
export function reportDropped(dropped: unknown): void {
  const symbols = cleanList(dropped);
  if (!symbols.length) return;
  showBanner(`${symbols.join('、')} 已不在任何板块里,顺带把它的价位与异动监控一起撤了。`, true);
}

/** 加进板块 / AI 选股之后的默认开关回执:两个开关都开,开不上的照原话说。 */
export function reportPoolWatch(watch: unknown): void {
  const w = watch as Partial<PoolWatch> | null | undefined;
  if (!w) return;
  reportSkipped(w.symbol ? `${w.symbol}:` : '', w.skipped);
}

/**
 * 拨一个开关。`patch` 只带要改的那一路(另一路原样不动)。
 * 回执里的 skipped 如实报;之后重读价位与异动两张表,行上的开关、量比、价位条跟着引擎走。
 */
export async function setPoolWatch(symbol: string, patch: PoolWatchPatch): Promise<PoolWatch | null> {
  const s = symbol.trim().toUpperCase();
  if (!s) return null;
  const what = patch.price !== undefined ? '价位' : '异动';
  try {
    const res = await dafri.setPoolWatch(s, patch);
    reportSkipped(`${s}:`, res?.skipped);
    await Promise.all([loadAlerts(), loadQuality()]);
    return res || null;
  } catch (err) {
    showBanner(`${s} 的「${what}」没拨动:${errorMessage(err)}`, false);
    // 失败后也重读:开关要退回引擎里真正的状态,不能停在人以为拨过去的那一侧
    await Promise.all([loadAlerts(), loadQuality()]);
    return null;
  }
}
