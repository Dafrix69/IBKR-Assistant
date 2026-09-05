"""本地速记解析:用户的固定蝴蝶行话不必等大模型,微秒级出单。

「1.8 挂15蝴蝶 15CM」这类指令的语义是**定死的**(用户逐条确认过):

  * 首/尾孤立数字(1.8)= 净权利金上限 → LMT;没有 → AUTO_MID(与提示词同一例外);
    也接受「权利金不超过/上限/不高于 N」的完整说法;
  * 「挂」= 挂限价单,当日有效(DAY);
  * 「N蝴蝶」当 N ≤ 99 = 中心行权价取 **现价的百位 + N**(SPX 6907 → 6915);
  * 「N cm」/「翼宽 N」/「±N点」= 翼宽 N 点;
  * 看涨/看跌不写时按提示词既有规则推断:中心高于现价 → 看涨,低于 → 看跌;
  * 未写标的默认 SPX、未写张数默认 1 张、未写到期日默认当日(0DTE)——全部加 warning。

设计红线只有一条:**绝不猜**。整条指令必须被这套语法完整覆盖(逐 token 消费,
消费完不许有任何剩余成分),否则返回 None 交给大模型——半懂不懂地本地下单,
比慢一秒危险一万倍。两道数字守卫同理:权利金必须小于翼宽(否则必然读错了数);
中心与现价偏离超过 20% 视为写漏了标的(230的蝴蝶配默认 SPX 就是这种事故)。
产出的 payload 与大模型同形,走同一套 schema 校验、硬校验闸门与执行路径;
记录里 model 标为 local-shorthand,肉眼可辨。
"""
from __future__ import annotations

import math
import re
import unicodedata
from datetime import datetime, timedelta
from typing import Any, Dict, List, Mapping, Optional, Tuple

#: 记录里的"模型名":一眼能看出这单没经过大模型
LOCAL_MODEL = "local-shorthand"
#: 语法版本:改语法必须升版本,记录里跟着走
GRAMMAR_VERSION = "shorthand-v2"

#: 中文数量词(「两张」「十张」)。十以上没人这么写蝴蝶,不猜。
_CN_NUM = {"一": 1, "两": 2, "二": 2, "三": 3, "四": 4, "五": 5,
           "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}

#: 不带交易语义的口语前后缀,先剥掉再解析。
#: 「买/开/来」这类动词只是"下这单"的意思——方向永远是买入(卖蝴蝶在黑名单拦截)。
_FILLERS = (
    "帮我", "给我", "麻烦", "谢谢", "请",
    "尝试下", "尝试", "试下", "试试", "考虑下", "考虑", "看看", "意思下",
    "能不能挂进去", "能不能进去", "能不能接到", "能不能进", "有没有机会接", "有没有机会进",
    "接不到拉倒", "进不去就拉倒", "不要追价哦", "不要追价", "不追价", "便宜的", "彩票单", "彩票",
    "来一个", "来一张", "来个", "来", "买入", "买", "开仓", "开个", "开", "挂个", "挂",
    "今天的", "当日到期", "当日", "今日", "今天", "0dte",
)


#: 翼宽记号:出现它就是这套行话(用户确认:cm 只用于蝴蝶,不写「蝴蝶」二字也认)
_WING_HINT = re.compile(r"\d\s*cm|翼宽\s*\d|±\s*\d+(?:\.\d+)?\s*点", re.I)


def looks_like_shorthand(text: str) -> bool:
    """这句话像不像蝴蝶速记(用于快照抓取与落网观测,不做任何解析承诺)。"""
    t = unicodedata.normalize("NFKC", text or "")
    return "蝴蝶" in t or bool(_WING_HINT.search(t))


def _fmt(value: float) -> str:
    """数字的展示格式(与 %g 一致):7520.0 → '7520',6907.35 → '6907.35'。"""
    return "%g" % value


def _take(work: str, pattern: str, flags: int = 0) -> Tuple[str, Optional[re.Match]]:
    """消费第一处匹配(从工作串里删掉),返回(新串, match)。"""
    m = re.search(pattern, work, flags)
    if m is None:
        return work, None
    return work[: m.start()] + " " + work[m.end():], m


def shorthand_symbols(instruction: str) -> List[str]:
    """这条指令若走本地速记,需要谁的现价。引擎把它并进快照抓取列表。"""
    text = unicodedata.normalize("NFKC", instruction or "")
    if "蝴蝶" not in text and not _WING_HINT.search(text):
        return []
    m = re.search(r"(?!cm\b|CM\b)[A-Za-z]{2,5}", text)
    token = m.group(0).upper() if m else "SPX"
    return [token] if token not in ("CM", "GTC", "CALL", "PUT", "DTE") else ["SPX"]


def try_parse_shorthand(
    instruction: str,
    snapshot: Mapping[str, float],
    moment: datetime,
) -> Optional[Dict[str, Any]]:
    """严格语法命中 → 与大模型同形的 payload;任何不确定 → None(交给大模型)。"""
    # 全角数字/字母/标点统一成半角(中文输入法常见),CJK 本身不受影响
    text = unicodedata.normalize("NFKC", (instruction or "")).strip()
    if not text or len(text) > 80:
        return None
    has_butterfly_word = "蝴蝶" in text
    if not has_butterfly_word and not _WING_HINT.search(text):
        return None
    # 出现这些词说明还有别的语义(触发条件/卖出/多单拼接),本地不接
    if re.search(
        r"[;;\n]|时候|时,|的时候|涨到|跌到|突破|跌破|卖|做空|平仓|取消|理由"
        r"|止盈|止损|接货|加仓|撤单|日历|spread|正股|海鸥|或者|如果|守不住|翻倍",
        text, re.I,
    ):
        return None

    work = text
    warnings: List[str] = []

    work, m_gtc = _take(work, r"GTC|一直有效", re.I)
    tif = "GTC" if m_gtc else "DAY"

    # 盘外标志。SPX 期权在美东 20:15–次日 09:25 的隔夜段是能交易的,但订单不带
    # outsideRth 时 IBKR 只会把它挂着、到常规时段才送交易所(实测 TWS 原话:
    # "您的委托单在 08:30:00 美国/中部前不会被下达交易所")。默认仍是 False——
    # 隔夜流动性薄,要在那个时段成交必须是**明说**的决定。
    work, m_orth = _take(work, r"盘外|隔夜|夜盘|盘前|盘后")
    outside_rth = m_orth is not None

    work, m_tomorrow = _take(work, r"明天的|明天|明日")

    work, m_right = _take(work, r"看涨|看跌|call|put", re.I)
    explicit_right: Optional[str] = None
    if m_right:
        token = m_right.group(0).lower()
        explicit_right = "C" if token in ("看涨", "call") else "P"

    # 翼宽(必填):N cm / 翼宽 N(点) / ±N点
    work, m_wing = _take(work, r"(\d+(?:\.\d+)?)\s*cm", re.I)
    if m_wing is None:
        work, m_wing = _take(work, r"翼宽\s*(\d+(?:\.\d+)?)\s*点?")
    if m_wing is None:
        work, m_wing = _take(work, r"±\s*(\d+(?:\.\d+)?)\s*点")
    if m_wing is None:
        return None
    wing = float(m_wing.group(1))
    if not (0 < wing <= 500):
        return None

    # 张数:「N张」或中文数量词。先剥动词再取(「买一张」→「一张」)
    for filler in _FILLERS:
        work = work.replace(filler, " ")
    work = re.sub(r"0dte", " ", work, flags=re.I)
    work, m_qty = _take(work, r"(\d{1,3})\s*张")
    qty: Optional[int] = int(m_qty.group(1)) if m_qty else None
    if qty is None:
        work, m_cn = _take(work, r"([一两二三四五六七八九十])\s*张")
        if m_cn:
            qty = _CN_NUM[m_cn.group(1)]
    if qty is None:
        qty = 1
        warnings.append("未写张数,已按默认 1 张处理")
    if not (1 <= qty <= 999):
        return None

    # 中心:三种显式写法,最多命中一种
    center_abs: Optional[float] = None
    center_tail: Optional[int] = None
    work, m_c1 = _take(work, r"(\d{4,5}(?:\.\d+)?)\s*(?=蝴蝶)")  # 7515蝴蝶 / 7520 蝴蝶
    work, m_c2 = _take(work, r"(\d{1,2})\s*(?=蝴蝶)")            # 15蝴蝶(百位+N)
    work, m_c3 = _take(work, r"(\d{3,5}(?:\.\d+)?)\s*的")        # 7520的…蝴蝶
    hits = [m for m in (m_c1, m_c2, m_c3) if m is not None]
    if len(hits) > 1:
        return None
    if m_c2 is not None:
        center_tail = int(m_c2.group(1))
    elif hits:
        center_abs = float(hits[0].group(1))

    # 标的:一个字母 token;没有 → SPX
    # 只认 2-5 个字母:杂散的单字母(消息结尾误触)不当 ticker,交给大模型
    work, m_sym = _take(work, r"[A-Za-z]{2,5}")
    symbol = m_sym.group(0).upper() if m_sym else "SPX"
    if m_sym is None:
        warnings.append("未写标的,默认按 SPX 处理")
    if re.search(r"[A-Za-z]", work):
        return None  # 第二个字母 token:不是这套语法

    # 权利金的完整说法:「权利金不超过/上限/不高于 N」
    work, m_prem = _take(work, r"权利金\s*(?:不超过|不高于|上限)?\s*(\d+(?:\.\d+)?)")
    if m_prem is None:
        work, m_prem = _take(work, r"(\d+(?:\.\d+)?)\s*(?:块钱|块|刀|美元|美金)")
    keyword_premium = float(m_prem.group(1)) if m_prem else None

    # 残余填充词、语气词与标点(全角标点已被 NFKC 归一成半角)
    work = re.sub(r"蝴蝶|[的吧哦呢啦呀嘛了个]|[,。、~!?():;]|\s+", " ", work)

    # 剩下的孤立数字分类:
    #   有显式中心 → 至多 1 个(权利金);
    #   无显式中心 → 恰好 1 个"行权价量级"的大数(≥1000 且 > 2×翼宽)作中心,
    #                另至多 1 个小数作权利金;其他任何组合都说不清,交给大模型。
    numbers = [float(x) for x in re.findall(r"\d+(?:\.\d+)?", work)]
    work = re.sub(r"\d+(?:\.\d+)?", " ", work)
    if work.strip():
        return None  # 还有没消费掉的成分:交给大模型
    premium: Optional[float] = keyword_premium
    if center_abs is None and center_tail is None:
        bigs = [x for x in numbers if x >= 1000 and x > 2 * wing]
        smalls = [x for x in numbers if x not in bigs]
        if len(bigs) != 1 or len(smalls) > 1:
            return None
        center_abs = bigs[0]
        if smalls:
            if premium is not None:
                return None  # 关键词权利金 + 孤立数字:两个权利金说不清
            premium = smalls[0]
    else:
        if len(numbers) > 1:
            return None
        if numbers:
            if premium is not None:
                return None
            premium = numbers[0]
    if premium is not None and not (0 < premium < wing):
        return None  # 借方蝴蝶权利金必然小于翼宽,超出即读错了数

    # 到期:默认当日(0DTE);「明天」= 下一交易日(只跳周末,节假日下单时会被拒)
    if m_tomorrow:
        day = moment + timedelta(days=1)
        while day.weekday() >= 5:
            day += timedelta(days=1)
        expiry = day.strftime("%Y%m%d")
        expiry_label = "%s 到期" % day.strftime("%Y-%m-%d")
        warnings.append("「明天」按下一交易日 %s 处理" % day.strftime("%Y-%m-%d"))
    else:
        if moment.weekday() >= 5:
            return None
        expiry = moment.strftime("%Y%m%d")
        expiry_label = "%s 当日到期" % moment.strftime("%Y-%m-%d")
        warnings.append("未写到期日,已按默认当日到期处理")

    # 中心与方向都可能要现价
    spot = snapshot.get(symbol)
    spot = float(spot) if spot is not None and math.isfinite(float(spot)) else None
    if center_tail is not None:
        if spot is None:
            return None
        center = math.floor(spot / 100.0) * 100.0 + center_tail
        warnings.append(
            "「%d蝴蝶」按中心 %s(现价百位+%d)理解" % (center_tail, _fmt(center), center_tail)
        )
    else:
        center = float(center_abs)  # type: ignore[arg-type]
    if not (center > wing):
        return None
    # 中心与现价偏离超过 20%:多半是写漏了标的(230的蝴蝶配默认 SPX),不猜
    if spot is not None and abs(center - spot) / spot > 0.2:
        return None

    if explicit_right is not None:
        right = explicit_right
    else:
        if spot is None:
            return None
        if center > spot:
            right = "C"
            warnings.append("中心 %s 高于现价 %s,推断为看涨蝴蝶" % (_fmt(center), _fmt(spot)))
        elif center < spot:
            right = "P"
            warnings.append("中心 %s 低于现价 %s,推断为看跌蝴蝶" % (_fmt(center), _fmt(spot)))
        else:
            right = "C"
            warnings.append("中心 %s 等于现价,默认按看涨蝴蝶处理" % _fmt(center))

    if not has_butterfly_word:
        warnings.append("未写「蝴蝶」,按 cm 行话默认为蝴蝶组合")
    if premium is None:
        warnings.append(
            "未指定净权利金上限,将在下单时按盘口中间价定价(AUTO_MID);若成交成本敏感,请写明如'权利金不超过 3'"
        )
    warnings.append("本地速记解析(未经大模型),语法 %s" % GRAMMAR_VERSION)

    trading_class = "SPXW" if symbol == "SPX" else None
    strikes = [center - wing, center, center + wing]

    def leg(action: str, ratio: int, strike: float) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "action": action, "ratio": ratio,
            "lastTradeDateOrContractMonth": expiry,
            "strike": strike, "right": right,
        }
        if trading_class:
            out["tradingClass"] = trading_class
        return out

    side = "看涨" if right == "C" else "看跌"
    price_text = (
        "净权利金上限 %s" % _fmt(premium) if premium is not None
        else "净权利金按下单时盘口中间价确定"
    )
    order: Dict[str, Any] = {
        "action": "BUY",
        "orderType": "LMT",
        "totalQuantity": qty,
        "price_mode": "EXPLICIT" if premium is not None else "AUTO_MID",
        "lmtPrice": premium,
        "tif": tif,
        "outsideRth": outside_rth,
    }
    payload = {
        "orders": [{
            "intent_summary": "买入 %d 张 %s的 %s %s/%s/%s %s蝴蝶(翼宽 %s 点),%s" % (
                qty, expiry_label, symbol,
                _fmt(strikes[0]), _fmt(strikes[1]), _fmt(strikes[2]),
                side, _fmt(wing), price_text,
            ),
            "contract": {
                "secType": "BAG", "symbol": symbol, "exchange": "SMART",
                "currency": "USD", "combo_strategy": "BUTTERFLY",
                "legs": [leg("BUY", 1, strikes[0]), leg("SELL", 2, strikes[1]),
                         leg("BUY", 1, strikes[2])],
            },
            "execution_type": "IMMEDIATE",
            "trigger": None,
            "account": "DEFAULT",
            "order": order,
            "reason": "本地速记解析",
            "confidence": 1.0,
            "warnings": warnings,
        }],
        "rejections": [],
    }
    return payload
