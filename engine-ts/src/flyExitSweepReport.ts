/** 蝶式出场参数扫描的报告:把结果与统计写成给人读的几段话(纯函数,回一行一行的文字)。
 *
 * 规矩只有一条:**每一个口径都写在数字旁边**——人群怎么限的、按什么价成交、扣没扣佣金、一共试了几组。
 * "比现行参数好"这句话只在 flyExitSweepStats.verdictOf 给出 better 时才出现;别的时候写的是"下不了结论"或"数据分不开",
 * 并且写明还差什么。
 */
import type { FamilyResult, SweepResult } from "./flyExitSweepSpec.js";
import { CHECK_COARSE, CHECK_HALVES, CHECK_TERMINAL } from "./flyExitSweepStats.js";
import type { FamilySummary, Interval, Objective, SetStat, Summary } from "./flyExitSweepStats.js";

const signed = (v: number | null | undefined, digits: number): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const text = Math.abs(v).toFixed(digits);
  return `${v < 0 && Number(text) !== 0 ? "-" : "+"}${text}`;
};
const DIGITS: Record<Objective, number> = { r: 3, usd: 1 };
const UNIT: Record<Objective, string> = { r: "R", usd: "$" };
const interval = (ci: Interval | null, digits: number): string =>
  (ci === null ? "给不出" : `[${ci[0] === null ? "无界" : signed(ci[0], digits)}, ${ci[1] === null ? "无界" : signed(ci[1], digits)}]`);
const pct = (v: number): string => `${Math.round(v * 100)}%`;
const orAny = (v: string | number | null): string => (v === null ? "不限" : String(v));
const listOr = (v: ReadonlyArray<string | number> | null): string => (v === null || !v.length ? "不限" : v.join(","));

const KIND_LABEL: Record<string, string> = {
  profit_trail: "利润回撤", stop_loss: "止损", time_exit: "到点", take_profit: "止盈",
  day_end: "拿到最后一笔", settle: "拿到收盘结算", unfilled: "触发了但一直卖不掉",
};

/** 显示宽度:中文与全角符号算两格,表格才对得齐 */
const width = (text: string): number => [...text].reduce((n, ch) => n + ((ch.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1), 0);
const padEnd = (text: string, n: number): string => text + " ".repeat(Math.max(0, n - width(text)));
const padStart = (text: string, n: number): string => " ".repeat(Math.max(0, n - width(text))) + text;

function populationLines(r: SweepResult): string[] {
  const p = r.population;
  if (r.from_entries) return ["入场:只算给进来的那几笔真实入场(--entries),不枚举;样本来源 --by " + p.by];
  const free = p.entry_from === null && p.entry_to === null && p.wings === null && p.rights === null &&
    p.debit_min === null && p.debit_max === null && p.dist_min === null && p.dist_max === null;
  return [
    "入场人群(每一项都是参数,没给就是不限):",
    `  样本来源 --by ${p.by};入场时刻 --entry-from ${orAny(p.entry_from)} --entry-to ${orAny(p.entry_to)}(美东)`,
    `  翼宽 --wings ${listOr(p.wings)};看涨 / 看跌 --right ${listOr(p.rights)}`,
    `  入场价 D(点)--debit-min ${orAny(p.debit_min)} --debit-max ${orAny(p.debit_max)}`,
    `  中心在现价虚值一侧多少点 --dist-min ${orAny(p.dist_min)} --dist-max ${orAny(p.dist_max)}(看涨 = 中心 − 现价,看跌 = 现价 − 中心)`,
    ...(free ? ["  一项都没限:下面是记下来的行权价上摆得出的全部蝶、全部入场时刻,不是你做的那一种。"] : []),
  ];
}

function fillLines(r: SweepResult): string[] {
  const f = r.fill;
  const terminal = f.terminal === "natural"
    ? "按当天最后一笔的立刻成交价了结(--terminal natural)。比真留到结算保守:尾盘价差宽,对拿得久的参数组不利"
    : `记到了收盘的那些天(最后一笔离收盘不超过 ${f.settle_within_min} 分钟)按最后一笔现价的内在价值结算(--terminal settle)。` +
      "那一笔现价不是结算价,差着最后几分钟;没记到收盘的天仍按最后一笔的立刻成交价";
  return [
    "成交口径:",
    `  入场:中间价 + ${pct(f.entry_spread_share)} ×(立刻买得到的价 − 中间价),朝多付的一侧取到组合的跳动上(--entry-spread-share ${f.entry_spread_share};` +
      "1 = 两翼按卖价、中心按买价)",
    "  出场:触发的那一笔按各腿买卖价合成的立刻成交价(两翼按买价卖、中心按卖价买回);那一笔拿不到就等下一笔",
    `  一直没出场的:${terminal}`,
    f.commission === null
      ? "  佣金:没给(--commission)。下面的数都是**扣佣金之前**的;追踪的成本也按不含佣金算——实盘的成本含佣金,$100 / $200 那两条线在实盘到得略晚"
      : `  佣金:每张每边 $${f.commission}(--commission);一组蝶 4 张,进出各算一次,结算与归零作废不收;追踪的成本里含入场的那 4 张(和实盘组合行的成本同一个口径)`,
    `  止损类按${f.stop_basis === "natural" ? "立刻成交价" : "中间价"}判(--stop-basis ${f.stop_basis});每个情景 ${f.qty} 组(--qty);乘数 ${f.multiplier}`,
    `  判断间隔:每 ${r.stride} 笔样本判一次(--stride ${r.stride})`,
  ];
}

function scenarioLines(r: SweepResult): string[] {
  const counts = r.live.scenarios;
  const bag = (b: Record<string, number>): string => Object.entries(b).map(([k, v]) => `${k} ${v}`).join("、");
  const out = [`情景:${r.scenarios} 个,分在 ${r.live.days.length} 天` +
    (counts.length ? `(每天 ${Math.min(...counts)}–${Math.max(...counts)} 个)` : "")];
  if (r.debit !== null) out.push(`  入场价 D 最小 / 中位 / 最大:${r.debit.min} / ${r.debit.median} / ${r.debit.max} 点`);
  const wings = Object.entries(r.wings);
  if (wings.length) out.push(`  用到的蝶(翼宽 → 只·天):${wings.map(([w, n]) => `${w} → ${n}`).join("、")}`);
  if (Object.keys(r.skipped).length) out.push(`  没要的情景:${bag(r.skipped)}`);
  if (Object.keys(r.filtered).length) out.push(`  人群限定筛掉的:${bag(r.filtered)}`);
  if (r.no_decision.total) {
    out.push(`  缺报价、那一笔没判断的:${r.no_decision.missing} / ${r.no_decision.total} 笔` +
      `(${(100 * r.no_decision.missing / r.no_decision.total).toFixed(1)}%)`);
  }
  if (r.short_days) out.push(`  有 ${r.short_days} 天最后一笔离收盘超过 ${r.fill.settle_within_min} 分钟(没记到收盘):那些天"拿到最后"的情景停在数据断掉的地方`);
  if (r.data.not_same_day) out.push(`  有 ${r.data.not_same_day} 笔样本不是当日到期的,没用`);
  if (r.data.other_symbol) out.push(`  有 ${r.data.other_symbol} 笔样本是别的标的的,没用`);
  return out;
}

function tableLines(f: FamilyResult, s: FamilySummary): string[] {
  const main = s.objective, other: Objective = main === "r" ? "usd" : "r";
  const level = pct(s.primary.level);
  const head = [
    "#", "参数组", `平均${UNIT[main]}`, `平均${UNIT[other]}`, `Δ${UNIT[main]}`, `单看的 ${level} 区间`, `算上挑选的 ${level} 区间`,
    "不靠假设的下界", "赢/输/平(天)",
  ];
  const rows = f.labels.map((label, i): string[] => {
    const a: SetStat | undefined = s.primary.sets[i], b = s.secondary.sets[i];
    if (a === undefined) return [];
    if (i === 0) return ["0", label, signed(a.mean, DIGITS[main]), signed(b?.mean, DIGITS[other]), "—", "—", "—", "—", "—"];
    const days = s.primary.days;
    const why = !days ? "—" : a.ties === days ? "每天都与参照组相同" : a.eligible ? null
      : a.ties ? `只有 ${days - a.ties} 天不同,给不出` : `只有 ${days} 天,给不出`;
    return [
      String(i), label, signed(a.mean, DIGITS[main]), signed(b?.mean, DIGITS[other]), signed(a.diff, DIGITS[main]),
      why ?? interval(a.ci, DIGITS[main]), why === null ? interval(a.band, DIGITS[main]) : "—",
      a.exact === null || a.ties === days ? "—" : signed(a.exact[0], DIGITS[main]), `${a.wins}/${a.losses}/${a.ties}`,
    ];
  }).filter((row) => row.length);
  const widths = head.map((h, c) => Math.max(width(h), ...rows.map((row) => width(row[c] ?? ""))));
  const line = (cells: string[]): string =>
    "  " + cells.map((cell, c) => (c === 1 ? padEnd(cell, widths[c] ?? 0) : padStart(cell, widths[c] ?? 0))).join("  ");
  return [
    line(head), ...rows.map(line),
    "  两个区间只说见过的这些天(在天上重抽,近似;天数少、差值偏或稀时偏窄),不拿它们下结论;「不靠假设的下界」对任何分布都成立,结论只看它。",
  ];
}

/** 不靠假设的下界用的那个上限是怎么来的 */
function capLine(s: FamilySummary, r: SweepResult): string[] {
  const cap = r.loss_cap, fee = r.fill.commission;
  if (cap === null) return [];
  const usd = `翼宽 ${cap.wing} × 乘数 ${r.fill.multiplier}${fee === null ? "" : " + 一次出场的佣金"} = $${cap.usd}`;
  if (s.objective === "usd") return [`合约条款给的上限:一个情景里一组参数最多比另一组多亏 ${usd}(一边卖在翼宽、另一边归零)。`];
  const fromFlag = !r.from_entries && r.population.debit_min !== null && r.population.debit_min >= cap.debit_floor;
  const floor = fromFlag
    ? `入场价的下限 ${cap.debit_floor}(--debit-min)`
    : `入场价的下限按组合的一跳 ${cap.debit_floor} 算(没给 --debit-min,或是真实入场):上限大到几乎下不了结论,给 --debit-min 或改用 --objective usd`;
  return [`合约条款给的上限:一个情景里一组参数最多比另一组多亏 ${usd},折成 R 是 ÷(入场价的下限 × 乘数)= ${cap.r.toFixed(1)}R。${floor}。`];
}

function kindLines(f: FamilyResult): string[] {
  if (!f.days.length) return [];
  const refused = f.stop_refused.flatMap((n, i) => (n ? [`${i} → ${n}`] : []));
  return [
    "出场方式(情景数):",
    ...f.kinds.map((bag, i) => `  ${i} ${Object.entries(bag).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${KIND_LABEL[k] ?? k} ${n}`).join(" · ")}`),
    ...(refused.length ? [`  止损设不上的情景(组 → 个):${refused.join("、")}。入场那一刻中间价已经不高于止损价` +
      (f.family === "live" ? ",实盘建追踪时会被拒" : ",回放会在入场那一笔就止损(那是入场价差造出来的)") + ";这些情景按不设止损算"] : []),
  ];
}

function verdictLines(f: FamilyResult, s: FamilySummary, r: SweepResult): string[] {
  const v = s.verdict, a = s.primary, d = DIGITS[s.objective], u = UNIT[s.objective];
  const level = pct(a.level), tried = f.labels.length - 1;
  const name = (i: number | null): string => (i === null ? "" : `「${f.labels[i] ?? ""}」`);
  const money = (x: number | null | undefined): string => (x === null || x === undefined ? "—" : `${u === "$" ? "$" : ""}${Math.abs(x).toFixed(d)}${u === "R" ? "R" : ""}`);
  const stat = v.set === null ? undefined : a.sets[v.set];
  const out = [`结论(一共试了 ${tried} 组;置信水平 ${level},每一头的 α 按组数平分):`];
  if (v.state === "nothing_to_compare") {
    out.push(tried === 0 ? "  只有参照组,没有可比的。用 --arm / --tighten / --grid 等给出要比的参数。" : "  没有一天有情景,什么也说不了。");
    return out;
  }
  const band = stat?.band ?? null;
  const seenDays = `Δ${u} ${signed(stat?.diff, d)},${band === null ? "给不出区间" : `算上挑选的 ${level} 区间 ${interval(band, d)}`}`;
  const proven = `不靠分布假设的下界 ${signed(stat?.exact?.[0], d)}(没见过的那种天按合约上限 ${money(a.cap)} 算进去了)`;
  if (v.state === "better") {
    out.push(`  ${name(v.set)}比现行参数好:${seenDays};${proven},${a.days} 天。`);
    out.push(`  三样检查它也都还领先:${CHECK_COARSE}、${CHECK_TERMINAL}、${CHECK_HALVES}。`);
  } else if (v.state === "fragile") {
    out.push(`  ${name(v.set)}的下界在 0 之上(${seenDays};${proven},${a.days} 天),**但「${v.failed.join("」「")}」之后它不再领先**。`);
    out.push("  这个差别取决于数据里没有的东西(两笔样本之间怎么走、最后几分钟怎么结、是不是只有一半的天撑着),不能当作结论,不要据此改参数。");
  } else if (v.state === "unproven") {
    out.push(`  **下不了结论**(${a.days} 天)。在见过的这些天上${name(v.set)}领先:${seenDays}——这只说见过的这类天,不是结论。`);
    if (stat?.unseen !== null && stat?.unseen !== undefined) {
      out.push(`  为什么不够:${a.days} 天排除不了出现概率不到 ${(100 * stat.unseen).toFixed(1)}% 的那种天(比见过的最差的一天还差);` +
        `合约条款允许它在那种天里一天平均比现行的多亏 ${money(a.cap)}。`);
      out.push((stat.seen ?? 0) > 0
        ? `  见过的这部分的下界是 ${signed(stat.seen, d)}:没见过的那种天里只要多亏到 ${money(stat.breakeven)},领先就没了;` +
          `见过的这部分照现在的样子不变,要约 ${stat.days_needed} 天才排除得了。`
        : `  而且见过的这部分自己的下界还不是正的(${signed(stat.seen, d)}):把最好的那几天换成最差的一天,领先就没了。`);
    } else {
      out.push("  不知道一天最多能差多少(没有情景给出翼宽),不靠假设的下界给不出。");
    }
  } else {
    out.push(`  数据分不开这几组与现行参数(${a.days} 天)。` + ((stat?.diff ?? 0) > 0
      ? `均值最高的是${name(v.set)}:${seenDays}${band === null ? "" : ",含 0"}。`
      : `没有一组的均值高过现行参数;最接近的是${name(v.set)}:${seenDays}。`));
    if (!a.eligible) out.push("  没有一组给得出重抽的区间:天数太少,或各组与参照组不同的天太少,估不出标准误。");
  }
  if (a.min_days !== null && a.days < a.min_days) {
    out.push(`  这个置信水平、这几组下,少于 ${a.min_days} 天数据再好也下不了结论(那时没见过的那种天还可能占一半以上)。`);
  }
  const also = (v.state === "better" || v.state === "fragile" ? a.better : a.ahead).filter((i) => i !== v.set);
  if (also.length && v.state !== "not_separated") {
    out.push(`  ${v.state === "unproven" ? "见过的这些天上同样领先的还有" : "下界同样在 0 之上的还有"}(按差值从大到小):${also.map(name).join("、")}。`);
  }
  if (a.worse.length) out.push(`  反过来,现行的比它好(不靠假设的上界在 0 之下)的:${a.worse.map(name).join("、")}。`);
  const behind = a.behind.filter((i) => !a.worse.includes(i));
  if (behind.length) out.push(`  见过的这些天上落后于现行参数的(同样不是结论):${behind.map(name).join("、")}。`);
  if (v.set !== null) {
    const alt = r.fill.terminal === "natural" ? "按最后一笔现价的内在价值结算" : "按最后一笔的立刻成交价了结";
    const halves = stat?.halves ?? [null, null];
    out.push(`  换口径看${name(v.set)}:${CHECK_COARSE} Δ${u} ${signed(s.coarse[v.set], d)};一直没出场的改成${alt} Δ${u} ${signed(s.alt_terminal[v.set], d)};` +
      `单数天 Δ${u} ${signed(halves[0], d)}、双数天 Δ${u} ${signed(halves[1], d)}`);
  }
  out.push("对半检验(在一半的天上挑,拿另一半打分;挑的时候没看过打分的那一半。给人看的,进结论的是上面「单数天、双数天」那两个数):");
  for (const half of a.split) {
    const from = half.picked_on === "odd" ? "单数天" : "双数天", to = half.picked_on === "odd" ? "双数天" : "单数天";
    out.push(half.picked === null
      ? `  ${from}上没有哪一组的均值高过参照组。`
      : `  ${from}上最好的是${name(half.picked)}(那一半 Δ${u} ${signed(half.in_sample, d)});放到${to}:Δ${u} ${signed(half.held_out, d)}` +
        `(${half.held_out_days} 天,赢 ${half.wins} 输 ${half.losses}),单看的 ${level} 区间 ${interval(half.ci, d)}`);
  }
  return out;
}

function familyLines(title: string, intro: string[], f: FamilyResult, s: FamilySummary, r: SweepResult): string[] {
  const objective = s.objective === "r"
    ? "平均 R(每个情景的盈亏 ÷ 付出的权利金)" : "平均每组盈亏(美元)";
  return [
    "", `━━ ${title} ━━`, ...intro,
    `目标:${objective};先按天平均,天与天等权(--objective ${s.objective})。${f.days.length} 天、${f.labels.length} 组(含参照组)`,
    ...tableLines(f, s), ...capLine(s, r), ...kindLines(f), ...verdictLines(f, s, r),
  ];
}

export function formatReport(result: SweepResult, summary: Summary): string[] {
  const d = result.data;
  const out = [
    "蝶式出场参数扫描(离线;只用记下来的腿盘口,没有模型价)",
    `数据:${result.symbol ?? "(没指定标的)"},${d.days} 天${d.first === null ? "" : `(${d.first} → ${d.last})`},${d.samples} 笔样本,用了 ${d.used} 笔`,
    ...populationLines(result), ...fillLines(result), ...scenarioLines(result),
    `统计:置信水平 ${pct(summary.level)}(--level)、在天上重抽 ${summary.draws} 次(--draws)、种子 ${summary.seed}(--seed)`,
  ];
  const ref = result.live.params[0] ?? {};
  const liveIntro =
    `参照组(蝶式预设现在的值,从 flyexit 读):起算 $${ref["arm_usd"]} · 收紧 $${ref["tighten_usd"]} · 档位 ${ref["loose_pct"]}/${ref["mid_pct"]}/${ref["tight_pct"]}` +
    `(第三档 ${ref["tight_at"]}×成本起)· ${ref["late_after"]} 后 ×${ref["late_factor"]} · 最少回吐 ${ref["floor"]}` +
    ` · ${ref["stop_mult"] === null ? "不设止损" : `止损 ${ref["stop_mult"]}×D`} · ${ref["exit_at"] === null ? "不设到点" : `${ref["exit_at"]} 平`}`;
  out.push(...familyLines("实盘的蝶式预设(tracker.evaluate)", [liveIntro], result.live, summary.live, result));
  if (result.replay !== null && summary.replay !== null) {
    const em = result.replay.em;
    const replayIntro = [
      "参照组:flyexit.DEFAULTS 现在的值(止损、激活线、档位、区间、阶段切换),EM 除外",
      `EM(常规时段全天一个标准差,点):${em === null ? "没有一天取得到" : `最小 / 中位 / 最大 ${em.min} / ${em.median} / ${em.max}`};` +
        `有 ${result.replay.days_without_em} 天没做回放(取不到平值跨式,或是提前收盘日)`,
    ];
    out.push(...familyLines("交易分析的回放策略(flyexit.simulate)", replayIntro, result.replay, summary.replay, result));
  }
  out.push(
    "", "读这份报告之前:",
    "  · 判断只发生在记下来的那几笔上。两笔之间价走到过哪里不知道:真实的峰值只会比这里的高,触发只会比这里的早。",
    "  · 用的是报出来的买卖价,不是成交价;组合单实际常常成交在比各腿买卖价合成的更好的位置。",
    "  · 入场是假想的(每一笔样本、每一只摆得出的蝶),不是你的入场;要看自己的单,用 --entries。",
    "  · 只有一个标的、只有记下来的这段日子。",
    "  · 多数天略好、偶尔大亏的那种改动(比如去掉止损),样本里还没碰上大亏的那种天时会显得更好:表里那两个区间会被它骗,所以结论只看「不靠假设的下界」。",
    "  · 那个下界靠两条:天与天互不相关、来自同一个分布;一天最多差出合约的上限。行情换了一种状态,前一条就不成立。",
    "  · α 只在这一次跑里试的这几组之间平分。换着人群限定、成交口径反复跑,挑结论好看的那一次,它就不作数了。",
    "  · 实盘推峰值要连续两轮(两秒)都见到,这里每一笔样本都算数;实盘的追价、部分成交、托管单这里都没有。",
  );
  return out;
}
