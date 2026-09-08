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
/** 语法版本:改语法必须升版本,记录里跟着走 */
export const GRAMMAR_VERSION = "shorthand-v3";

type Rec = Record<string, any>;

/** 中文数量词(「两张」「十张」)。十以上没人这么写蝴蝶,不猜。 */
const CN_NUM: Record<string, number> = {
  一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

/** 不带交易语义的口语前后缀,先剥掉再解析。
 * 「买/开/来」这类动词只是"下这单"的意思——方向永远是买入(卖蝴蝶在黑名单拦截)。 */
const FILLERS = [
  "帮我", "给我", "麻烦", "谢谢", "请",
  "尝试下", "尝试", "试下", "试试", "考虑下", "考虑", "看看", "意思下",
  "能不能挂进去", "能不能进去", "能不能接到", "能不能进", "有没有机会接", "有没有机会进",
  "接不到拉倒", "进不去就拉倒", "不要追价哦", "不要追价", "不追价", "便宜的", "彩票单", "彩票",
  "来一个", "来一张", "来个", "来", "买入", "买", "开仓", "开个", "开", "挂个", "挂",
  "今天的", "当日到期", "当日", "今日", "今天", "0dte",
];

/** 翼宽记号:出现它就是这套行话(用户确认:cm 只用于蝴蝶,不写「蝴蝶」二字也认) */
const WING_HINT = /\d\s*cm|翼宽\s*\d|±\s*\d+(?:\.\d+)?\s*点/i;

/** 这句话像不像蝴蝶速记(用于快照抓取与落网观测,不做任何解析承诺)。 */
export function looksLikeShorthand(text: string): boolean {
  const t = (text ?? "").normalize("NFKC");
  return t.includes("蝴蝶") || WING_HINT.test(t);
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
  if (!text.includes("蝴蝶") && !WING_HINT.test(text)) return [];
  const m = text.match(/(?!cm\b|CM\b)[A-Za-z]{2,5}/);
  const token = m ? m[0].toUpperCase() : "SPX";
  return ["CM", "GTC", "CALL", "PUT", "DTE"].includes(token) ? ["SPX"] : [token];
}

/** 严格语法命中 → 与大模型同形的 payload;任何不确定 → null(交给大模型)。 */
export function tryParseShorthand(
  instruction: string,
  snapshot: Record<string, number>,
  moment: EtNow,
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
  let mQty: RegExpMatchArray | null;
  [work, mQty] = take(work, /(\d{1,3})\s*张/);
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

  // 中心:三种显式写法,最多命中一种
  let mC1: RegExpMatchArray | null;
  let mC2: RegExpMatchArray | null;
  let mC3: RegExpMatchArray | null;
  [work, mC1] = take(work, /(\d{4,5}(?:\.\d+)?)\s*(?=蝴蝶)/); // 7515蝴蝶 / 7520 蝴蝶
  [work, mC2] = take(work, /(\d{1,2})\s*(?=蝴蝶)/);            // 15蝴蝶(百位+N)
  [work, mC3] = take(work, /(\d{3,5}(?:\.\d+)?)\s*的/);        // 7520的…蝴蝶
  const hits = [mC1, mC2, mC3].filter((m) => m !== null);
  if (hits.length > 1) return null;
  const centerTail = mC2 !== null ? Number(mC2[1]) : null;
  let centerAbs: number | null = mC2 === null && hits.length ? Number(hits[0]![1]) : null;

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
