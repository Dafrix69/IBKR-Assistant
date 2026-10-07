/** 本地速记解析(对应 Python shorthand.py,语法 v2):固定蝴蝶行话跳过大模型。
 *
 * 语义(用户逐条确认):首/尾孤立数字=净权利金上限→LMT(没有→AUTO_MID),
 * 也接受「权利金不超过/上限/不高于 N」;「挂」=当日限价;
 * 「N蝴蝶」(N≤99)=中心取现价百位+N;「N cm」/「翼宽 N」/「±N点」=翼宽 N 点;
 * 看涨/看跌不写时按提示词既有规则由中心与现价的相对位置推断;
 * 默认 SPX / 1 张 / 当日到期,全部加 warning。
 *
 * 红线只有一条:**绝不猜**。整条指令必须被语法完整覆盖(逐 token 消费,消费完
 * 不许有剩余成分),否则返回 null 交给大模型。两道数字守卫同理:权利金必须小于
 * 翼宽;中心与现价偏离超过 20% 视为写漏了标的。产出与 LLM 同形,走同一套校验。
 */
import type { EtNow } from "./config.js";
import { pyG } from "./py.js";
import { dateOrdinal, ordinalToDate, weekdayOfDate } from "./tz.js";

/** 记录里的"模型名":一眼能看出这单没经过大模型 */
export const LOCAL_MODEL = "local-shorthand";
/** 语法版本:改语法必须升版本,记录里跟着走。
 * v4(2026-09-27):中心与张数的数字左边加边界,三位数中心(「580蝴蝶」)不再被拆成"权利金 5 + 80蝴蝶",
 * 改为交给大模型——语法只收窄,没有新写法。
 * v5(2026-10-08):闲字表补了 Charlie 的频道里真实出现过的几种语气词(「一下」「试一下」「试试看」「赌博小彩票」「好贵」),
 * 都不带交易语义;其余没有变——不认识的词仍然交给大模型。
 * v6(2026-10-08):新增贷方垂直价差(「7770 7775 bear call -2 -2.5」「00 95 bull put 试下 -2」),见 parseCreditSpread;
 * 蝴蝶的语法没有变。 */
export const GRAMMAR_VERSION = "shorthand-v6";

type Rec = Record<string, any>;

/** 中文数量词(「两张」「十张」)。十以上没人这么写蝴蝶,不猜。 */
const CN_NUM: Record<string, number> = {
  一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

/** 不带交易语义的口语前后缀,先剥掉再解析。
 * 「买/开/来」这类动词只是"下这单"的意思——方向永远是买入(卖蝴蝶在黑名单拦截)。 */
const FILLERS = [
  "帮我", "给我", "麻烦", "谢谢", "请",
  "尝试一下", "尝试下", "尝试", "试一下", "试试看", "试下", "试试", "考虑下", "考虑", "看看", "意思下", "一下", "好贵",
  "能不能挂进去", "能不能进去", "能不能接到", "能不能进", "有没有机会接", "有没有机会进",
  "接不到拉倒", "进不去就拉倒", "不要追价哦", "不要追价", "不追价", "便宜的", "赌博小彩票", "小彩票", "赌博", "彩票单", "彩票",
  "来一个", "来一张", "来个", "来", "买入", "买", "开仓", "开个", "开", "挂个", "挂",
  "今天的", "当日到期", "当日", "今日", "今天", "0dte",
];

/** 翼宽记号:出现它就是这套行话(用户确认:cm 只用于蝴蝶,不写「蝴蝶」二字也认) */
const WING_HINT = /\d\s*cm|翼宽\s*\d|±\s*\d+(?:\.\d+)?\s*点/i;

/** 贷方价差的类型词,必须写全:bull put(卖高买低的 put)/ bear call(卖低买高的 call),后面跟不跟 spread 都行。
 *  只写 bull / bear、只写缩写(BPS、BCS)的不认:是借方还是贷方、put 还是 call,说不清。 */
const SPREAD_TYPE = /(?<![A-Za-z])(bull\s*put|bear\s*call)(?:\s*spread)?(?![A-Za-z])/i;

/** 这句话像不像本地速记(用于快照抓取与落网观测,不做任何解析承诺)。 */
export function looksLikeShorthand(text: string): boolean {
  const t = (text ?? "").normalize("NFKC");
  return t.includes("蝴蝶") || WING_HINT.test(t) || SPREAD_TYPE.test(t);
}

/** 价差的样子:两个挨着的行权价,后面跟一个负的权利金(「75 70 -2」「7860 7865 -2 -2.5」)。只用来认"像不像",不解析。 */
const SPREAD_SHAPE = /(?<![\d.])\d{2,5}\s*[\s/-]\s*\d{2,5}(?![\d.]).*(?<![\d.])-\s*\d/;

/**
 * 这句话有没有一张单子的骨架:蝴蝶的翼宽记号、贷方价差的类型词,或价差的样子。跟单拿它分"单子"与"闲聊"——
 * 光有「蝴蝶」两个字不算(「蝴蝶先走一下」「蝴蝶止损了哦」是评论),没有翼宽的蝴蝶本来也解析不出来。
 */
export function looksLikeOrder(text: string): boolean {
  const t = (text ?? "").normalize("NFKC");
  return WING_HINT.test(t) || SPREAD_TYPE.test(t) || SPREAD_SHAPE.test(t);
}

/** 长得像贷方价差(两个行权价 + 负的权利金),却没写 bull put / bear call:方向说不清,本地语法不接。 */
export function spreadWithoutType(text: string): boolean {
  const t = (text ?? "").normalize("NFKC");
  return SPREAD_SHAPE.test(t) && !SPREAD_TYPE.test(t) && !WING_HINT.test(t);
}

function fmt(value: number): string {
  return pyG(value);
}

function take(work: string, pattern: RegExp): [string, RegExpMatchArray | null] {
  const m = work.match(pattern);
  if (m === null || m.index === undefined) return [work, null];
  return [work.slice(0, m.index) + " " + work.slice(m.index + m[0].length), m];
}

/** 这条指令若走本地速记,需要谁的现价。引擎把它并进快照抓取列表。 */
export function shorthandSymbols(instruction: string): string[] {
  const text = (instruction ?? "").normalize("NFKC");
  if (!looksLikeShorthand(text)) return [];
  // 价差的类型词(bull put / bear call)不是标的:先摘掉再找字母 token
  const m = text.replace(SPREAD_TYPE, " ").match(/(?!cm\b|CM\b)[A-Za-z]{2,5}/);
  const token = m ? m[0].toUpperCase() : "SPX";
  return ["CM", "GTC", "CALL", "PUT", "DTE"].includes(token) ? ["SPX"] : [token];
}

/** 解析的同时顺带告诉调用方的事;调用方不传就不填。 */
export interface ShorthandMeta {
  /** 中心写的是「N蝴蝶」(现价的百位 + N)这种相对写法,而不是写明的行权价。
   *  现价在两个百位之间时它说不清是哪一个百位:手动下单有人看摘要,跟单没有(见 follow.ts 的 relativeCenterProblem)。 */
  relativeCenter: boolean;
}

/** 严格语法命中 → 与大模型同形的 payload;任何不确定 → null(交给大模型)。 */
export function tryParseShorthand(
  instruction: string,
  snapshot: Record<string, number>,
  moment: EtNow,
  meta?: ShorthandMeta,
): Rec | null {
  // 全角数字/字母/标点统一成半角(中文输入法常见),CJK 本身不受影响
  const full = (instruction ?? "").normalize("NFKC").trim();
  // 尾巴上的「理由:…」是给复盘看的,不参与语法:先摘下来,原文进 reason(对应 Python)。
  // v2 曾把带理由的整句交给大模型"连理由一起入库",实测大模型看不懂这套行话,
  // 花 3~4 秒换来一个 UNCLEAR——界面上的「补理由」按钮正好把用户推进这条死路。
  let reason = "本地速记解析";
  let text = full;
  const mReason = full.match(/[,,。;;\s]*理由\s*:?\s*(.*)$/);
  if (mReason && mReason.index !== undefined) {
    const reasonText = mReason[1]!.trim();
    if (!reasonText) return null; // 「理由:」后面是空的:说不清,交给大模型
    reason = reasonText;
    text = full.slice(0, mReason.index).trim();
  }
  if (!text || text.length > 80) return null;
  if (SPREAD_TYPE.test(text)) {
    // 贷方价差是另一套语法;相对写法在百位边上的事它自己管(取最近的一组,说不清就不接)
    if (meta !== undefined) meta.relativeCenter = false;
    return parseCreditSpread(full, text, reason, snapshot, moment);
  }
  const hasButterflyWord = text.includes("蝴蝶");
  if (!hasButterflyWord && !WING_HINT.test(text)) return null;
  // 出现这些词说明还有别的语义(触发条件/卖出/多单拼接),本地不接
  if (
    /[;;\n]|时候|时,|的时候|涨到|跌到|突破|跌破|卖|做空|平仓|取消|理由|止盈|止损|接货|加仓|撤单|日历|spread|正股|海鸥|或者|如果|守不住|翻倍/i
      .test(text)
  ) {
    return null;
  }

  let work = text;
  const warnings: string[] = [];

  let mGtc: RegExpMatchArray | null;
  [work, mGtc] = take(work, /GTC|一直有效/i);
  const tif = mGtc ? "GTC" : "DAY";

  // 盘外标志。SPX 期权在美东 20:15–次日 09:25 的隔夜段能交易,但订单不带 outsideRth 时
  // IBKR 只会把它挂着、到常规时段才送交易所(实测 TWS 原话:"您的委托单在 08:30:00
  // 美国/中部前不会被下达交易所")。默认仍是 false——隔夜流动性薄,要在那个时段成交
  // 必须是**明说**的决定。
  let mOrth: RegExpMatchArray | null;
  [work, mOrth] = take(work, /盘外|隔夜|夜盘|盘前|盘后/);
  const outsideRth = mOrth !== null;

  let mTomorrow: RegExpMatchArray | null;
  [work, mTomorrow] = take(work, /明天的|明天|明日/);

  let mRight: RegExpMatchArray | null;
  [work, mRight] = take(work, /看涨|看跌|call|put/i);
  let explicitRight: string | null = null;
  if (mRight) {
    const token = mRight[0].toLowerCase();
    explicitRight = token === "看涨" || token === "call" ? "C" : "P";
  }

  // 翼宽(必填):N cm / 翼宽 N(点) / ±N点
  let mWing: RegExpMatchArray | null;
  [work, mWing] = take(work, /(\d+(?:\.\d+)?)\s*cm/i);
  if (mWing === null) [work, mWing] = take(work, /翼宽\s*(\d+(?:\.\d+)?)\s*点?/);
  if (mWing === null) [work, mWing] = take(work, /±\s*(\d+(?:\.\d+)?)\s*点/);
  if (mWing === null) return null;
  const wing = Number(mWing[1]);
  if (!(wing > 0 && wing <= 500)) return null;

  // 张数:「N张」或中文数量词。先剥动词再取(「买一张」→「一张」)
  for (const filler of FILLERS) {
    work = work.split(filler).join(" ");
  }
  work = work.replace(/0dte/gi, " ");
  // 左边界:数字不能从更长的数字中间截。没有它,「1500张」会取成 500 张、剩下的 1 又被当成权利金
  let mQty: RegExpMatchArray | null;
  [work, mQty] = take(work, /(?<![\d.])(\d{1,3})\s*张/);
  let qty: number | null = mQty ? Number(mQty[1]) : null;
  if (qty === null) {
    let mCn: RegExpMatchArray | null;
    [work, mCn] = take(work, /([一两二三四五六七八九十])\s*张/);
    if (mCn) qty = CN_NUM[mCn[1]!]!;
  }
  if (qty === null) {
    qty = 1;
    warnings.push("未写张数,已按默认 1 张处理");
  }
  if (!(qty >= 1 && qty <= 999)) return null;

  // 中心:三种显式写法,最多命中一种。
  // 三条都要左边界 (?<![\d.]):数字只能整段认,不能从中间截。没有它,「580蝴蝶」被 mC2 截成
  // 「80蝴蝶」(现价百位 + 80),剩下的 5 又落进"孤立数字 = 权利金上限"——QQQ 在 612 时成了
  // 670/680/690 看涨蝶、限价 5(2026-09-27 审计 V3)。三位数中心不带「的」说不清是绝对价还是
  // "百位 + N",这里三条都不命中,剩下的 580 也不够"行权价量级",整条交给大模型。
  let mC1: RegExpMatchArray | null;
  let mC2: RegExpMatchArray | null;
  let mC3: RegExpMatchArray | null;
  [work, mC1] = take(work, /(?<![\d.])(\d{4,5}(?:\.\d+)?)\s*(?=蝴蝶)/); // 7515蝴蝶 / 7520 蝴蝶
  [work, mC2] = take(work, /(?<![\d.])(\d{1,2})\s*(?=蝴蝶)/);            // 15蝴蝶(百位+N)
  [work, mC3] = take(work, /(?<![\d.])(\d{3,5}(?:\.\d+)?)\s*的/);        // 7520的…蝴蝶
  const hits = [mC1, mC2, mC3].filter((m) => m !== null);
  if (hits.length > 1) return null;
  const centerTail = mC2 !== null ? Number(mC2[1]) : null;
  let centerAbs: number | null = mC2 === null && hits.length ? Number(hits[0]![1]) : null;
  if (meta !== undefined) meta.relativeCenter = centerTail !== null;

  // 标的:一个字母 token;没有 → SPX
  // 只认 2-5 个字母:杂散的单字母(消息结尾误触)不当 ticker,交给大模型
  let mSym: RegExpMatchArray | null;
  [work, mSym] = take(work, /[A-Za-z]{2,5}/);
  const symbol = mSym ? mSym[0].toUpperCase() : "SPX";
  if (mSym === null) warnings.push("未写标的,默认按 SPX 处理");
  if (/[A-Za-z]/.test(work)) return null; // 第二个字母 token:不是这套语法

  // 权利金的完整说法:「权利金不超过/上限/不高于 N」
  let mPrem: RegExpMatchArray | null;
  [work, mPrem] = take(work, /权利金\s*(?:不超过|不高于|上限)?\s*(\d+(?:\.\d+)?)/);
  if (mPrem === null) [work, mPrem] = take(work, /(\d+(?:\.\d+)?)\s*(?:块钱|块|刀|美元|美金)/);
  const keywordPremium = mPrem ? Number(mPrem[1]) : null;

  // 残余填充词、语气词与标点(全角标点已被 NFKC 归一成半角)
  work = work.replace(/蝴蝶|[的吧哦呢啦呀嘛了个]|[,。、~!?():;]|\s+/g, " ");

  // 剩下的孤立数字分类:
  //   有显式中心 → 至多 1 个(权利金);
  //   无显式中心 → 恰好 1 个"行权价量级"的大数(≥1000 且 > 2×翼宽)作中心,
  //                另至多 1 个小数作权利金;其他任何组合都说不清,交给大模型。
  const numbers = (work.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  work = work.replace(/\d+(?:\.\d+)?/g, " ");
  if (work.trim()) return null; // 还有没消费掉的成分:交给大模型
  let premium: number | null = keywordPremium;
  if (centerAbs === null && centerTail === null) {
    const bigs = numbers.filter((x) => x >= 1000 && x > 2 * wing);
    const smalls = numbers.filter((x) => !(x >= 1000 && x > 2 * wing));
    if (bigs.length !== 1 || smalls.length > 1) return null;
    centerAbs = bigs[0]!;
    if (smalls.length) {
      if (premium !== null) return null; // 关键词权利金 + 孤立数字:两个权利金说不清
      premium = smalls[0]!;
    }
  } else {
    if (numbers.length > 1) return null;
    if (numbers.length) {
      if (premium !== null) return null;
      premium = numbers[0]!;
    }
  }
  if (premium !== null && !(premium > 0 && premium < wing)) return null; // 权利金必然小于翼宽

  // 到期:默认当日(0DTE);「明天」= 下一交易日(只跳周末,节假日下单时会被拒)
  let expiry: string;
  let expiryLabel: string;
  if (mTomorrow) {
    let ordinal = dateOrdinal(moment.date) + 1;
    while (weekdayOfDate(ordinalToDate(ordinal)) >= 5) ordinal += 1;
    const day = ordinalToDate(ordinal);
    expiry = day.replace(/-/g, "");
    expiryLabel = `${day} 到期`;
    warnings.push(`「明天」按下一交易日 ${day} 处理`);
  } else {
    if (weekdayOfDate(moment.date) >= 5) {
      // 周末:默认"当日到期"的合约不存在。这条原来回落给大模型,而大模型也只会以"不是交易日"拒——
      // 白等 3~5 秒。本地直接拒,2 毫秒,话也说得更清楚:要下周一的写「明天」。(对应 Python _weekend_rejection)
      const dayName = weekdayOfDate(moment.date) === 5 ? "周六" : "周日";
      return {
        orders: [],
        rejections: [{
          original_text: full,
          code: "UNSUPPORTED",
          message: `今天(${dayName})不是交易日,默认当日到期的蝴蝶无法下单;要下周一的写「明天」,或写明到期日。`,
        }],
      };
    }
    expiry = moment.date.replace(/-/g, "");
    expiryLabel = `${moment.date} 当日到期`;
    warnings.push("未写到期日,已按默认当日到期处理");
  }

  // 中心与方向都可能要现价
  const rawSpot = snapshot[symbol];
  const spot = rawSpot !== undefined && Number.isFinite(Number(rawSpot)) ? Number(rawSpot) : null;
  let center: number;
  if (centerTail !== null) {
    if (spot === null) return null;
    center = Math.floor(spot / 100.0) * 100.0 + centerTail;
    warnings.push(`「${centerTail}蝴蝶」按中心 ${fmt(center)}(现价百位+${centerTail})理解`);
  } else {
    center = centerAbs!;
  }
  if (!(center > wing)) return null;
  // 中心与现价偏离超过 20%:多半是写漏了标的(230的蝴蝶配默认 SPX),不猜
  if (spot !== null && Math.abs(center - spot) / spot > 0.2) return null;

  let right: string;
  if (explicitRight !== null) {
    right = explicitRight;
  } else {
    if (spot === null) return null;
    if (center > spot) {
      right = "C";
      warnings.push(`中心 ${fmt(center)} 高于现价 ${fmt(spot)},推断为看涨蝴蝶`);
    } else if (center < spot) {
      right = "P";
      warnings.push(`中心 ${fmt(center)} 低于现价 ${fmt(spot)},推断为看跌蝴蝶`);
    } else {
      right = "C";
      warnings.push(`中心 ${fmt(center)} 等于现价,默认按看涨蝴蝶处理`);
    }
  }

  if (!hasButterflyWord) {
    warnings.push("未写「蝴蝶」,按 cm 行话默认为蝴蝶组合");
  }
  if (premium === null) {
    warnings.push(
      "未指定净权利金上限,将在下单时按盘口中间价定价(AUTO_MID);若成交成本敏感,请写明如'权利金不超过 3'",
    );
  }
  warnings.push(`本地速记解析(未经大模型),语法 ${GRAMMAR_VERSION}`);

  const tradingClass = symbol === "SPX" ? "SPXW" : null;
  const strikes = [center - wing, center, center + wing];

  const leg = (action: string, ratio: number, strike: number): Rec => {
    const out: Rec = {
      action, ratio,
      lastTradeDateOrContractMonth: expiry,
      strike, right,
    };
    if (tradingClass) out["tradingClass"] = tradingClass;
    return out;
  };

  const side = right === "C" ? "看涨" : "看跌";
  const priceText =
    premium !== null ? `净权利金上限 ${fmt(premium)}` : "净权利金按下单时盘口中间价确定";
  return {
    orders: [{
      intent_summary:
        `买入 ${qty} 张 ${expiryLabel}的 ${symbol} ` +
        `${fmt(strikes[0]!)}/${fmt(strikes[1]!)}/${fmt(strikes[2]!)} ${side}蝴蝶` +
        `(翼宽 ${fmt(wing)} 点),${priceText}`,
      contract: {
        secType: "BAG", symbol, exchange: "SMART",
        currency: "USD", combo_strategy: "BUTTERFLY",
        legs: [leg("BUY", 1, strikes[0]!), leg("SELL", 2, strikes[1]!),
               leg("BUY", 1, strikes[2]!)],
      },
      execution_type: "IMMEDIATE",
      trigger: null,
      account: "DEFAULT",
      order: {
        action: "BUY",
        orderType: "LMT",
        totalQuantity: qty,
        price_mode: premium !== null ? "EXPLICIT" : "AUTO_MID",
        lmtPrice: premium,
        tif,
        outsideRth,
      },
      reason,
      confidence: 1.0,
      warnings,
    }],
    rejections: [],
  };
}

// ---------------------------------------------------------------- 贷方垂直价差
/** 价差行话里多出来的几个闲字。只在价差语法里剥,不放宽蝴蝶的。长的在前。 */
const SPREAD_FILLERS = ["这个区间", "区间", "收租", "左右", "挂单下", "挂单", "可以"];
/** 出现这些词说明还有别的语义(条件、平仓、移仓、另一种结构),本地不接 */
const SPREAD_BLOCK =
  /[;;\n]|时候|时,|涨到|跌到|突破|跌破|破了|站稳|卖|做空|平仓|取消|理由|止盈|止损|接货|加仓|撤单|上移|下移|日历|正股|海鸥|或者|如果|守不住|翻倍|蝴蝶/;
/** 两位数的行权价是相对写法(现价的百位 + N):取离现价最近的一组。最近的那组离现价这么远或更远,就说不清是哪个百位。 */
const RELATIVE_STRIKE_MAX_POINTS = 50;

/**
 * 贷方垂直价差(Charlie 叫「收租」):两个行权价 + 类型词 + 负的权利金。
 *
 *   7770 7775 bear call 挂个-2-2.5      卖 7770C、买 7775C,收 2.5
 *   00 95 bull put 试下 -2 -2.5         现价 7712 → 卖 7700P、买 7695P,收 2.5
 *   7700 7695 挂个-2试试 BULL PUT       卖 7700P、买 7695P,收 2
 *
 * 规则:
 * * 类型词决定结构,两个行权价谁写在前面无所谓:bull put 卖高买低,bear call 卖低买高。
 * * 权利金必须写、必须是负数(收);写的是区间(「-2 -2.5」「-2到-2.5」)时按收得多的一头挂单——
 *   可能成交不了,但不会比写的差。没写权利金的不接(不用 AUTO_MID 替人定价)。
 * * 行权价要么都写全(三到五位),要么都是两位数的相对写法;混着写、差 50 点(说不清谁高谁低)的不接。
 * * 和蝴蝶一样:整句必须被语法完整覆盖,任何剩余成分 → null。
 */
function parseCreditSpread(
  full: string, text: string, reason: string, snapshot: Record<string, number>, moment: EtNow,
): Rec | null {
  if (SPREAD_BLOCK.test(text) || WING_HINT.test(text)) return null;
  let work = text;
  const warnings: string[] = [];

  let mType: RegExpMatchArray | null;
  [work, mType] = take(work, SPREAD_TYPE);
  if (mType === null || SPREAD_TYPE.test(work)) return null; // 两个类型词:是两张单
  const bullPut = /bull/i.test(mType[1]!);

  let mGtc: RegExpMatchArray | null;
  [work, mGtc] = take(work, /GTC|一直有效/i);
  const tif = mGtc ? "GTC" : "DAY";
  let mOrth: RegExpMatchArray | null;
  [work, mOrth] = take(work, /盘外|隔夜|夜盘|盘前|盘后/);
  const outsideRth = mOrth !== null;
  let mTomorrow: RegExpMatchArray | null;
  [work, mTomorrow] = take(work, /明天的|明天|明日/);

  // 收到的权利金:负数,一个或一个区间。第一个负号左边不能是数字——「7770-7775」里的横线是分隔,不是负号
  let mCredit: RegExpMatchArray | null;
  [work, mCredit] = take(work, /(?<![\d.])-\s*(\d+(?:\.\d+)?)(?:\s*(?:到|至|~|-)?\s*-\s*(\d+(?:\.\d+)?))?/);
  if (mCredit === null) return null;                 // 没写价格:不猜
  if (/(?<![\d.])-\s*\d/.test(work)) return null;   // 还有一个负数:说不清哪个是价格
  const quoted = [Number(mCredit[1])];
  if (mCredit[2] !== undefined) quoted.push(Number(mCredit[2]));
  const credit = Math.max(...quoted);

  for (const filler of [...SPREAD_FILLERS, ...FILLERS]) {
    work = work.split(filler).join(" ");
  }
  work = work.replace(/0dte/gi, " ");

  let mQty: RegExpMatchArray | null;
  [work, mQty] = take(work, /(?<![\d.])(\d{1,3})\s*张/);
  let qty: number | null = mQty ? Number(mQty[1]) : null;
  if (qty === null) {
    let mCn: RegExpMatchArray | null;
    [work, mCn] = take(work, /([一两二三四五六七八九十])\s*张/);
    if (mCn) qty = CN_NUM[mCn[1]!]!;
  }
  if (qty === null) {
    qty = 1;
    warnings.push("未写张数,已按默认 1 张处理");
  }
  if (!(qty >= 1 && qty <= 999)) return null;

  let mSym: RegExpMatchArray | null;
  [work, mSym] = take(work, /[A-Za-z]{2,5}/);
  const symbol = mSym ? mSym[0].toUpperCase() : "SPX";
  if (mSym === null) warnings.push("未写标的,默认按 SPX 处理");
  if (/[A-Za-z]/.test(work)) return null;

  // 语气词、标点、行权价之间的分隔(「7770/7775」「7770-7775」「-2 到 -2.5」里剩下的「到」)
  work = work.replace(/[的吧哦呢啦呀嘛了个到至]|[,。、~!?():;/-]|\s+/g, " ");
  const tokens = work.match(/\d+(?:\.\d+)?/g) ?? [];
  work = work.replace(/\d+(?:\.\d+)?/g, " ");
  if (work.trim() || tokens.length !== 2) return null; // 恰好两个行权价,别的什么都不剩

  const rawSpot = snapshot[symbol];
  const spot = rawSpot !== undefined && Number.isFinite(Number(rawSpot)) ? Number(rawSpot) : null;
  const relative = tokens.every((t) => /^\d{1,2}$/.test(t));
  const absolute = tokens.every((t) => /^\d{3,5}(?:\.\d+)?$/.test(t));
  let lo: number;
  let hi: number;
  if (relative) {
    if (spot === null) return null;
    const a = Number(tokens[0]);
    const b = Number(tokens[1]);
    // 第二个比第一个高多少:取 (−50, 50] 里的那个解(「00 95」是低 5 点,不是高 95 点)
    const diff = ((b - a + 150) % 100) - 50;
    if (diff === 0 || Math.abs(diff) === 50) return null;
    const base = Math.floor(spot / 100.0) * 100.0;
    let first = Number.NaN;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const shift of [-100, 0, 100]) {
      const candidate = base + shift + a;
      const dist = Math.abs(candidate + diff / 2 - spot);
      if (dist < bestDist) {
        bestDist = dist;
        first = candidate;
      }
    }
    if (!(bestDist < RELATIVE_STRIKE_MAX_POINTS)) return null;
    lo = Math.min(first, first + diff);
    hi = Math.max(first, first + diff);
    warnings.push(`「${tokens[0]} ${tokens[1]}」按 ${fmt(first)}/${fmt(first + diff)} 理解(离现价 ${fmt(spot)} 最近的一组)`);
  } else if (absolute) {
    lo = Math.min(Number(tokens[0]), Number(tokens[1]));
    hi = Math.max(Number(tokens[0]), Number(tokens[1]));
    // 和蝴蝶同一条:离现价超过 20% 多半是写漏了标的
    if (spot !== null && Math.abs((lo + hi) / 2 - spot) / spot > 0.2) return null;
  } else {
    return null; // 一个写全、一个两位数:说不清
  }
  const width = hi - lo;
  if (!(width > 0 && width <= 500)) return null;
  if (!(credit > 0 && credit < width)) return null; // 收的不可能多过宽度

  let expiry: string;
  let expiryLabel: string;
  if (mTomorrow) {
    let ordinal = dateOrdinal(moment.date) + 1;
    while (weekdayOfDate(ordinalToDate(ordinal)) >= 5) ordinal += 1;
    const day = ordinalToDate(ordinal);
    expiry = day.replace(/-/g, "");
    expiryLabel = `${day} 到期`;
    warnings.push(`「明天」按下一交易日 ${day} 处理`);
  } else {
    if (weekdayOfDate(moment.date) >= 5) {
      const dayName = weekdayOfDate(moment.date) === 5 ? "周六" : "周日";
      return {
        orders: [],
        rejections: [{
          original_text: full,
          code: "UNSUPPORTED",
          message: `今天(${dayName})不是交易日,默认当日到期的价差无法下单;要下周一的写「明天」,或写明到期日。`,
        }],
      };
    }
    expiry = moment.date.replace(/-/g, "");
    expiryLabel = `${moment.date} 当日到期`;
    warnings.push("未写到期日,已按默认当日到期处理");
  }

  if (quoted.length === 2 && quoted[0] !== quoted[1]) {
    warnings.push(
      `权利金写的是区间 ${fmt(Math.min(...quoted))}–${fmt(Math.max(...quoted))},按收得多的一头 ${fmt(credit)} 挂单(可能成交不了,不会比写的差)`,
    );
  }
  warnings.push(`本地速记解析(未经大模型),语法 ${GRAMMAR_VERSION}`);

  const right = bullPut ? "P" : "C";
  // bull put:卖高买低;bear call:卖低买高。都是卖出离现价近的那条、买入远的那条做保护
  const sellStrike = bullPut ? hi : lo;
  const buyStrike = bullPut ? lo : hi;
  const tradingClass = symbol === "SPX" ? "SPXW" : null;
  const leg = (action: string, strike: number): Rec => {
    const out: Rec = { action, ratio: 1, lastTradeDateOrContractMonth: expiry, strike, right };
    if (tradingClass) out["tradingClass"] = tradingClass;
    return out;
  };
  return {
    orders: [{
      intent_summary:
        `卖出(贷方)${qty} 张 ${expiryLabel}的 ${symbol} ${fmt(lo)}/${fmt(hi)} ${bullPut ? "看跌" : "看涨"}贷方价差` +
        `(卖 ${fmt(sellStrike)}${right}、买 ${fmt(buyStrike)}${right},宽 ${fmt(width)} 点),净权利金不低于 ${fmt(credit)}`,
      contract: {
        secType: "BAG", symbol, exchange: "SMART",
        currency: "USD", combo_strategy: "VERTICAL",
        legs: [leg("BUY", buyStrike), leg("SELL", sellStrike)],
      },
      execution_type: "IMMEDIATE",
      trigger: null,
      account: "DEFAULT",
      order: {
        action: "SELL",
        orderType: "LMT",
        totalQuantity: qty,
        price_mode: "EXPLICIT",
        lmtPrice: credit,
        tif,
        outsideRth,
      },
      reason,
      confidence: 1.0,
      warnings,
    }],
    rejections: [],
  };
}
