/**
 * 交易指令页的「发单账户」勾选 → 这一次实际发到哪几个账户。
 *
 * 不 import 任何东西:store/trade.ts 用它,engine-ts 的测试直接跑它(tests/desktop-trade-page.spec.ts)。
 *
 *  · 只有一个可用账户:勾选控件根本不出现,就发这一个。存过的勾选指向别的账户也一样——
 *    否则用户看不见、也改不了那份勾选,每次发送都是「请至少勾选一个发单账户」;
 *  · 没存过勾选:默认账户(都没标默认就取第一个),和没有这个控件时一样;
 *  · 存过的勾选一个都不在可用账户里了(改了别名、换了券商、删了账户):当成没勾过,回到默认账户;
 *  · 两个以上账户、用户自己把勾全去掉了:那是他看得见、点得回来的选择,照样回空,页面会写「未勾选账户,无法发单」。
 *
 * 回退只影响这一次算出来的结果,不写回本机存的那份勾选:账户配置改回来,存着的那份照旧生效。
 */
export interface PickableAccount {
  alias: string;
  default?: boolean;
}

export function pickAccounts(usable: readonly PickableAccount[], saved: readonly string[] | null): string[] {
  const fallback = usable.find((a) => a.default) ?? usable[0];
  if (fallback === undefined) return [];
  if (usable.length === 1 || saved === null) return [fallback.alias];
  const aliases = new Set(usable.map((a) => a.alias));
  const kept = saved.filter((alias) => aliases.has(alias));
  return kept.length || !saved.length ? kept : [fallback.alias];
}
