"""券商成交明细 → 交易记录:把 IBKR 报回来的逐腿成交按订单合成一张蝴蝶。

交易分析看的应该是**真实成交过的交易**,不是本地记录里那些校验过但没发出去、或发出去
没成交的单。IBKR 的 `reqExecutions` 给的是逐笔成交:一张蝴蝶组合单会报回 1 条 BAG 行
(净价、方向、张数)+ 3 条腿行(各自的行权价、方向、数量、价格),同一订单的行共用
permId。这里把它们合回一张蝴蝶,产出和本地交易记录同形的 dict,交易复盘(tradereview)
不用知道数据从哪来。

口径:
* **净权利金优先用 BAG 行的价格**(那是券商撮合的净价);没有 BAG 行(比如逐腿成交
  的组合)才从腿上算:Σ(买入腿 价×比例) − Σ(卖出腿 价×比例),取绝对值,方向看翼。
* 同一条腿分几笔成交的,按数量加权平均;时间取最早那笔。
* 只认 1:2:1、同到期、同方向的三腿;别的组合(价差、铁鹰、单腿)一律跳过,不猜。
* 账号不在别名表里的成交也保留(别名用脱敏账号),用户要看的是"我账户里发生过什么"。
"""
from __future__ import annotations

import math
import re
from typing import Any, Dict, Iterable, List, Optional, Sequence

FILL_SOURCE = "ibkr"


def _num(value: Any) -> Optional[float]:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def _mask(account_id: str) -> str:
    s = str(account_id or "")
    return s if len(s) <= 5 else s[:2] + "***" + s[-3:]


def fmt_expiry(raw: Any) -> str:
    s = str(raw or "")
    if re.fullmatch(r"\d{8}", s):
        return "%s-%s-%s" % (s[:4], s[4:6], s[6:8])
    return s


def _fmt(v: float) -> str:
    return ("%.4f" % v).rstrip("0").rstrip(".")


def group_key(fill: Dict[str, Any]) -> str:
    """同一订单的成交行共用 permId;拿不到就退到 orderId + 首笔 execId。"""
    perm = fill.get("perm_id")
    if perm:
        return "p%s" % int(perm)
    order = fill.get("order_id")
    if order:
        return "o%s" % int(order)
    return "e%s" % str(fill.get("exec_id") or "")


def group_butterflies(
    fills: Iterable[Dict[str, Any]], accounts: Sequence[Dict[str, Any]] = ()
) -> List[Dict[str, Any]]:
    """成交行(router.executions() / store.list_fills() 的形状)→ 蝴蝶交易记录,按时间升序。"""
    alias_of = {str(a.get("account_id") or ""): a for a in accounts}
    groups: Dict[str, List[Dict[str, Any]]] = {}
    for fill in fills:
        contract = fill.get("contract") or {}
        if contract.get("secType") not in ("BAG", "OPT", "FOP"):
            continue
        key = "%s|%s" % (str(fill.get("account_id") or ""), group_key(fill))
        groups.setdefault(key, []).append(fill)

    out: List[Dict[str, Any]] = []
    for key, rows in groups.items():
        record = _butterfly_from_rows(rows, alias_of)
        if record is not None:
            out.append(record)
    out.sort(key=lambda r: (r["created_at"], r["id"]))
    return out


def _butterfly_from_rows(rows: List[Dict[str, Any]], alias_of: Dict[str, Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    legs: Dict[tuple, Dict[str, Any]] = {}
    bags: List[Dict[str, Any]] = []
    for row in rows:
        c = row.get("contract") or {}
        shares = _num(row.get("shares")) or 0.0
        price = _num(row.get("price"))
        if shares <= 0 or price is None:
            continue
        if c.get("secType") == "BAG":
            bags.append(row)
            continue
        strike = _num(c.get("strike"))
        if strike is None:
            continue
        k = (strike, str(c.get("right") or ""), str(c.get("expiry") or ""))
        leg = legs.setdefault(k, {"bot": 0.0, "sld": 0.0, "value": 0.0, "shares": 0.0,
                                  "times": [], "commission": 0.0, "has_comm": False, "contract": c})
        if str(row.get("side") or "").upper() in ("BOT", "BUY"):
            leg["bot"] += shares
        else:
            leg["sld"] += shares
        leg["value"] += price * shares
        leg["shares"] += shares
        leg["times"].append(str(row.get("time") or ""))
        comm = _num(row.get("commission"))
        if comm is not None:
            leg["commission"] += comm
            leg["has_comm"] = True
    if len(legs) != 3:
        return None
    keys = sorted(legs)
    if len({k[1] for k in keys}) != 1 or len({k[2] for k in keys}) != 1:
        return None

    sized = []
    for k in keys:
        leg = legs[k]
        net = leg["bot"] - leg["sld"]
        if abs(net) < 1e-9:
            return None
        sized.append((k, "BUY" if net > 0 else "SELL", abs(net), leg))
    qty_f = min(s[2] for s in sized)
    ratios = [int(round(s[2] / qty_f)) for s in sized]
    if ratios != [1, 2, 1]:
        return None
    (k1, a1, _, l1), (k2, a2, _, l2), (k3, a3, _, l3) = sized
    if a1 != a3 or a2 == a1:
        return None
    qty = int(round(qty_f))
    if qty <= 0:
        return None

    contract0 = l1["contract"]
    multiplier = _num(contract0.get("multiplier")) or 100.0
    right, expiry_raw = k1[1], k1[2]
    symbol = str(contract0.get("symbol") or "")
    leg_price = lambda l: l["value"] / l["shares"]      # noqa: E731 - 数量加权均价

    if bags:
        bag_shares = sum(_num(b.get("shares")) or 0.0 for b in bags)
        net = sum((_num(b.get("price")) or 0.0) * (_num(b.get("shares")) or 0.0) for b in bags) / bag_shares
        premium = round(abs(net), 4)
    else:
        signed = 0.0
        for (k, action, _, leg), ratio in zip(sized, ratios):
            signed += (1.0 if action == "BUY" else -1.0) * leg_price(leg) * ratio
        premium = round(abs(signed), 4)

    times = sorted(t for s in sized for t in s[3]["times"] if t)
    first_time = times[0] if times else ""
    account_id = str((rows[0] or {}).get("account_id") or "")
    acct = alias_of.get(account_id)
    alias = str(acct.get("alias")) if acct else "未配置账户 " + _mask(account_id)
    is_paper = bool(acct.get("is_paper")) if acct else account_id.upper().startswith("DU")

    commission = None
    if any(s[3]["has_comm"] for s in sized):
        commission = round(sum(s[3]["commission"] for s in sized), 4)

    if bags:
        fills_out = [{"time": str(b.get("time") or first_time), "price": _num(b.get("price")),
                      "qty": _num(b.get("shares")), "exec_id": str(b.get("exec_id") or "")} for b in bags]
    else:
        fills_out = [{"time": first_time, "price": premium, "qty": qty, "exec_id": "(合成)"}]

    verb = "买入" if a1 == "BUY" else "卖出"
    right_label = "看跌" if right == "P" else "看涨"
    width = round(k2[0] - k1[0], 4)
    summary = "%s %d 张 %s %s/%s/%s %s蝴蝶(翼宽 %s)@ %s" % (
        verb, qty, symbol, _fmt(k1[0]), _fmt(k2[0]), _fmt(k3[0]), right_label, _fmt(width), _fmt(premium))
    perm = rows[0].get("perm_id") or None
    rid = "ib:%s" % (int(perm) if perm else group_key(rows[0]))

    legs_out = []
    for (k, action, _, leg), ratio in zip(sized, ratios):
        c = leg["contract"]
        legs_out.append({
            "action": action, "ratio": ratio, "strike": k[0], "right": right,
            "lastTradeDateOrContractMonth": expiry_raw,
            "tradingClass": str(c.get("tradingClass") or ""),
            "multiplier": str(int(multiplier)) if float(multiplier).is_integer() else str(multiplier),
            "conId": c.get("conId"),
            "fill_price": round(leg_price(leg), 4),
        })
    return {
        "id": rid,
        "source": FILL_SOURCE,
        "created_at": first_time,
        "contract": {
            "secType": "BAG", "symbol": symbol, "exchange": "SMART",
            "currency": str(contract0.get("currency") or "USD"),
            "combo_strategy": "BUTTERFLY", "multiplier": legs_out[0]["multiplier"], "legs": legs_out,
        },
        "order": {"action": a1, "totalQuantity": qty, "orderType": "", "lmtPrice": None,
                  "price_mode": "EXPLICIT", "tif": "", "outsideRth": False},
        "ibkr": {"avg_fill_price": premium, "fills": fills_out, "perm_id": perm,
                 "order_id": rows[0].get("order_id") or None, "total_commission": commission,
                 "status_timeline": [{"status": "Filled", "at": first_time}]},
        "final_status": "filled",
        "account": {"alias": alias, "account_id": account_id, "is_paper": is_paper},
        "llm": {"intent_summary": summary},
        "input": {"raw_instruction": "", "reason": "券商成交记录", "input_channel": FILL_SOURCE},
        "execution_type": "IMMEDIATE",
        "expiry": fmt_expiry(expiry_raw),
    }
