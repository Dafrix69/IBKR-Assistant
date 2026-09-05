"""组合平仓单的真机预演——**只读,绝不发单**。

平组合这条路(反转每条腿 → BAG 限价单)在纯函数层已经被单测与黄金对拍锁住了,但有两件事
只有连上 TWS 才能知道:

  1. **腿 qualify 得到 conId 吗。** BAG 的每条腿都要先换成带 conId 的合约,IBKR 才认。
     tradingClass、exchange、multiplier 任何一项对不上,拿到的就是 200「未找到证券定义」。
  2. **组合净价拿不拿得到。** 拿不到现价就算不出限价,平仓单根本发不出去(引擎会拒)。

这个脚本把这两件事验证完,再把**将要发出去的那张单**原样打印出来,然后停在这里。
它不调用 place(),也不碰任何写入路径——看完了单子长什么样,再由你决定要不要在界面上开
「到价自动平仓」。

用法(TWS 要在跑,纸面端口默认 7497):

    trade\\.venv\\Scripts\\python trade\\scripts\\preview_combo_close.py
    trade\\.venv\\Scripts\\python trade\\scripts\\preview_combo_close.py --account 模拟
"""
from __future__ import annotations

import argparse
import io
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from ibkr_agent import tracker as tk                     # noqa: E402
from ibkr_agent.cli import build_router                  # noqa: E402
from ibkr_agent.config import load_settings              # noqa: E402
from ibkr_agent.models import parse_llm_payload          # noqa: E402

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")


def probe_qualify(settings, router, args) -> int:
    """不用持仓验 BAG 合约:按给定行权价拼一张**平仓方向**的蝶,拿去 IBKR qualify。

    这一步验的正是最容易出错的地方——腿的 tradingClass / exchange / 到期日对不上时,
    IBKR 回的是 200「未找到证券定义」,而那要等到真的发单才暴露。qualify 只查合约定义,
    不下单、不订阅行情。
    """
    try:
        symbol, expiry, strikes_raw = args.probe.split(":")
        strikes = [float(x) for x in strikes_raw.split(",")]
    except ValueError:
        print("--probe 的格式是 SYMBOL:EXPIRY:K1,K2,K3,例 SPX:20260904:7720,7740,7760")
        return 2
    if len(strikes) != 3:
        print("蝶式要正好 3 个行权价(低翼、中心、高翼)。")
        return 2

    acct = settings.account_by_alias(args.account) if args.account else settings.default_account()
    if acct is None:
        print("找不到账户;用 --account 指定一个配置里的别名。")
        return 2
    print("探测账户 %s(%s)" % (acct.alias, "纸面" if acct.is_paper else "实盘"))

    # 持仓是 +1/−2/+1 的买入蝶 → 平仓方向就是 SELL 1 / BUY 2 / SELL 1
    fake_contract = {
        "secType": "BAG", "symbol": symbol, "exchange": "SMART", "currency": "USD",
        "multiplier": "100", "combo_strategy": "BUTTERFLY",
        "legs": [
            {"lastTradeDateOrContractMonth": expiry, "strike": strikes[0],
             "right": args.probe_right, "ratio": 1.0},
            {"lastTradeDateOrContractMonth": expiry, "strike": strikes[1],
             "right": args.probe_right, "ratio": -2.0},
            {"lastTradeDateOrContractMonth": expiry, "strike": strikes[2],
             "right": args.probe_right, "ratio": 1.0},
        ],
    }
    closing = tk.close_bag_contract(fake_contract)
    print("平仓方向的腿:")
    for leg in closing["legs"]:
        print("    %-4s %d × %s %g%s" % (leg["action"], leg["ratio"],
                                         leg["lastTradeDateOrContractMonth"],
                                         leg["strike"], leg["right"]))

    payload = {
        "intent_summary": "探测用:平掉 %s %s 蝶" % (symbol, expiry),
        "contract": closing, "execution_type": "IMMEDIATE", "trigger": None,
        "account": acct.alias,
        "order": {"action": "SELL", "orderType": "LMT", "totalQuantity": 1,
                  "price_mode": "EXPLICIT", "tif": "DAY", "lmtPrice": 1.0, "outsideRth": False},
        "reason": "qualify 探测", "confidence": 1.0, "warnings": [],
    }
    parsed = parse_llm_payload({"orders": [payload], "rejections": []})
    if not parsed.orders:
        print("✗ 探测单没过 schema:%s" % "; ".join(parsed.schema_errors))
        return 1

    try:
        bag = router.qualify(parsed.orders[0].contract, acct)
    except Exception as exc:                              # noqa: BLE001 - 预演脚本,如实报告
        msg = str(exc)
        print("✗ BAG qualify 失败:%s" % msg[:400])
        # 两种失败长得很像但原因完全不同,别让人往错的方向查
        if "找不到对应会话" in msg or "不管理该账户" in msg:
            print("  这是**账户路由**没通,不是合约的问题:TWS 当前登录的账户里没有这个账号。"
                  "换 --account,或把对应的 TWS 实例起起来。")
        else:
            print("  腿的 tradingClass / exchange / 到期日有一项对不上,真发单会被 200 拒。")
        return 1
    legs = getattr(bag, "comboLegs", None) or []
    print("✓ BAG qualify 通过,%d 条腿都拿到 conId:" % len(legs))
    for leg in legs:
        print("    conId=%s ratio=%s action=%s exchange=%s"
              % (leg.conId, leg.ratio, leg.action, leg.exchange))
    if args.whatif:
        rc = _whatif(router, acct, bag, parsed.orders[0])
        if rc:
            return rc

    print("\n合约层没问题。剩下要在有真实持仓时验的只有:组合净价拿不拿得到,以及真正发一次单。")
    print("这个脚本没有发出任何订单。")
    return 0


def _whatif(router, acct, bag, parsed_order) -> int:
    """IBKR 的 whatIf 预检:把订单发给 TWS 算保证金,**但不产生订单**。

    验的是 qualify 验不出的那一层——价格档位不合法(错误 110)、账户没有该产品权限、
    保证金不足。这三样都要等到真发单那一刻才暴露,而那时已经晚了。

    `whatIf=True` 在这里是硬编码并当场断言的:这个标志是"预检"和"真下单"之间唯一的
    区别,不能让它取决于任何外部输入。
    """
    from ibkr_agent.broker import bag_signed_limit, build_ib_order

    print("")
    print("--- whatIf 预检(不产生订单)---")
    signed = bag_signed_limit(parsed_order.order.action, parsed_order.order.lmtPrice)
    try:
        order = build_ib_order(parsed_order.order, acct.account_id,
                               limit_override=signed, action_override="BUY")
    except Exception as exc:                              # noqa: BLE001
        print("✗ 构造 IBKR 订单失败:%s" % str(exc)[:300])
        return 1
    order.whatIf = True
    assert order.whatIf is True, "whatIf 标志没设上,拒绝继续——这一步只做预检"
    print("  提交形态:BAG BUY,带符号净价 %+.4f,数量 %s,whatIf=%s"
          % (signed, order.totalQuantity, order.whatIf))

    try:
        ib = router.for_account(acct)
        state = ib.whatIfOrder(bag, order)
    except Exception as exc:                              # noqa: BLE001
        print("✗ whatIf 被拒:%s" % str(exc)[:400])
        print("  这一层拒绝通常是价格档位(110)、产品权限或保证金——真发单会撞同一堵墙。")
        return 1
    if state is None:
        print("✗ whatIf 没有回结果(TWS 可能没算出来)。")
        return 1

    fields = [("初始保证金", "initMarginChange"), ("维持保证金", "maintMarginChange"),
              ("权益变化", "equityWithLoanChange"), ("佣金", "commission"),
              ("佣金货币", "commissionCurrency"), ("警告", "warningText")]
    print("  ✓ TWS 接受了这张单的结构,返回:")
    for label, attr in fields:
        value = getattr(state, attr, None)
        if value not in (None, "", "1.7976931348623157E308"):
            print("      %-10s %s" % (label, value))
    print("  (whatIf 单不进订单簿、不成交——账户里不会多出任何东西)")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="组合平仓单预演(只读)")
    ap.add_argument("--config", default=str(ROOT / "config" / "settings.json"))
    ap.add_argument("--account", default=None, help="只看这个账户别名")
    ap.add_argument("--slippage", type=float, default=5.0, help="限价让价百分比,默认 5")
    ap.add_argument("--probe", metavar="SYMBOL:EXPIRY:K1,K2,K3",
                    help="不用持仓也能验 qualify:给一组行权价,构造平仓方向的 BAG 去 IBKR 确认 "
                         "conId。例 SPX:20260904:7720,7740,7760")
    ap.add_argument("--probe-right", default="C", choices=("C", "P"), help="探测用的期权方向")
    ap.add_argument("--whatif", action="store_true",
                    help="除 qualify 外再做一次 IBKR 的 whatIf 预检(返回保证金预估,**不产生订单**)。"
                         "它能验出 qualify 验不出的那层:价格档位(错误 110)、账户权限、保证金。")
    ap.add_argument("--place-real-close", action="store_true",
                    help="【会真的发单】走完整生产路径平掉一只组合:建临时追踪 → poll_trackers "
                         "→ 过闸门 → 发 BAG 限价单 → 收回报 → 落库。只允许纸面账户。"
                         "这是真机核对的最后一步,加这个标志等于你授权发这一单。")
    args = ap.parse_args()

    settings = load_settings(Path(args.config))
    router = build_router(settings)

    # 主动连一遍所有配置的连接,并报告每条会话**实际管着哪些账号**。
    # 配置里的 账户→连接 映射是静态的:TWS 同一时刻只登录一个账户,用户切换登录之后
    # "7497 = 纸面"这种假设就不再成立(见 broker.for_account)。所以这里以 managedAccounts
    # 为准,把实况打出来——在实盘还是模拟上预演,这件事不能靠猜。
    for name in sorted(getattr(router, "connections", {}) or {}):
        try:
            ib = router.connect(name)
        except Exception as exc:                          # noqa: BLE001 - 连不上是常态,如实报告
            print("连接 %-6s ✗ %s" % (name, str(exc)[:160]))
            continue
        managed = list(getattr(ib, "managedAccounts", lambda: [])() or [])
        kinds = []
        for acct_id in managed:
            match = next((a for a in settings.accounts if a.account_id == acct_id), None)
            kinds.append("%s(%s)" % (acct_id, "纸面" if (match and match.is_paper)
                                     else "实盘" if match else "不在配置里"))
        print("连接 %-6s ✓ 管着:%s" % (name, "、".join(kinds) or "(没报账号)"))

    if not router.sessions():
        print("没有连上任何券商会话。先在界面上连接 TWS,或确认 OpenD/TWS 在跑。")
        return 2
    print()

    if args.probe:
        return probe_qualify(settings, router, args)

    rows = tk.with_combos(router.positions() or [])
    combos = [r for r in rows if r["sec_type"] == "BAG"]
    if args.account:
        combos = [r for r in combos if r["account"] == args.account]
    if not combos:
        print("账户里没有可识别的组合持仓(蝴蝶/价差/铁鹰)。先建一个再来预演。")
        return 1

    for raw in combos:
        acct = settings.account_by_alias(raw["account"])
        paper = "纸面" if (acct and acct.is_paper) else "实盘"
        print("=" * 78)
        print("组合  %s  [%s · %s]" % (raw["label"], raw["account"], paper))
        print("  每组净成本 %.4f   现价 %s   组数 %+g   方向 %s"
              % (raw["avg_cost"],
                 "拿不到" if raw["market_price"] is None else "%.4f" % raw["market_price"],
                 raw["quantity"], raw["net_side"]))

        if raw["market_price"] is None:
            print("  ✗ 拿不到组合净价——限价算不出来,这张单发不出去(引擎会拒,不会退成市价)。")
            continue

        position = tk.Position(
            account=raw["account"], symbol=raw["symbol"], sec_type=raw["sec_type"],
            quantity=raw["quantity"], avg_cost=raw["avg_cost"],
            multiplier=raw["multiplier"], currency=raw["currency"],
            market_price=raw["market_price"],
        )
        auto = tk.AutoClose(enabled=True, order_type="LMT", slippage_pct=args.slippage)
        try:
            payload = tk.build_close_order(
                position, auto, raw["market_price"], tk.STATE_PROFIT_TRAIL, raw["contract"])
        except tk.TrackerError as exc:
            print("  ✗ 拼不出平仓单:%s" % exc)
            continue

        parsed = parse_llm_payload({"orders": [payload], "rejections": []})
        if not parsed.orders:
            print("  ✗ 平仓单没过 schema:%s" % "; ".join(parsed.schema_errors))
            continue
        order = parsed.orders[0]

        print("  将要发出的单(用户口径):")
        print("    %s" % payload["intent_summary"])
        for leg in payload["contract"]["legs"]:
            print("      %-4s %d × %s %g%s" % (leg["action"], leg["ratio"],
                                               leg["lastTradeDateOrContractMonth"],
                                               leg["strike"], leg["right"]))
        from ibkr_agent.broker import bag_signed_limit
        signed = bag_signed_limit(order.order.action, order.order.lmtPrice)
        print("    提交给 IBKR:BAG 以 BUY 提交,带符号净价 %+.4f(%s)"
              % (signed, "收权利金" if signed < 0 else "付权利金"))

        # 唯一一次真的碰券商:确认每条腿都能 qualify 出 conId
        if acct is None:
            print("  ! 账户别名 %s 不在配置里,跳过 qualify。" % raw["account"])
            continue
        try:
            bag = router.qualify(order.contract, acct)
        except Exception as exc:                          # noqa: BLE001 - 预演脚本,如实报告
            print("  ✗ BAG qualify 失败:%s" % str(exc)[:300])
            print("    (这一步失败说明腿的 tradingClass / exchange / 到期日对不上,单子发出去也会被 200 拒)")
            continue
        legs = getattr(bag, "comboLegs", None) or []
        print("  ✓ BAG qualify 通过,%d 条腿都拿到 conId:" % len(legs))
        for leg in legs:
            print("      conId=%s ratio=%s action=%s exchange=%s"
                  % (leg.conId, leg.ratio, leg.action, leg.exchange))

        # 闸门:真到价的时候会不会被拦
        blockers = tk.close_blockers(
            auto=auto, position=position,
            account_is_paper=bool(acct.is_paper),
            auto_execute=settings.policies.auto_execute,
            allow_live_trading=settings.policies.allow_live_trading,
            breaker_engaged=False,
            market_status=settings.market_status(),
            outside_rth=True,
            already_fired=False,
            combo_live_ok=settings.policies.allow_combo_live,
        )
        print("  闸门:%s" % ("全部通过,到价就会发这张单" if not blockers else "、".join(blockers)))

    if args.place_real_close:
        return _place_real_close(settings, router, combos[0], args)

    print("=" * 78)
    print("预演结束。这个脚本没有发出任何订单。")
    if combos:
        print("要走完最后一步(真发一单、收回报、落库),加 --place-real-close。")
    return 0


def _place_real_close(settings, router, raw, args) -> int:
    """真机核对的最后一步:**真的发一张平仓单**,走完整生产路径。

    走的不是捷径——建一条临时追踪、跑 `engine.poll_trackers()`、过一遍所有闸门,
    和盘中自动平仓完全同一条路。止盈价设在现价的不利侧一点点,让它当轮必触发。

    两道硬保险:
      * **只允许纸面账户**。实盘一律拒,与 `allow_combo_live` 无关——这个脚本
        存在的意义是核对,核对不该在实盘上做第一次。
      * 跑完删掉临时追踪,不在库里留下一条谁也不认识的记录。
    """
    from ibkr_agent.config import now_et
    from ibkr_agent.engine import TradingEngine
    from ibkr_agent.notify import Notifier
    from ibkr_agent.store import TradeStore

    acct = settings.account_by_alias(raw["account"])
    if acct is None or not acct.is_paper:
        print("✗ --place-real-close 只允许纸面账户;当前是 %s。"
              % (raw["account"] if acct is None else ("实盘 " + acct.alias)))
        return 2
    if raw["market_price"] is None:
        print("✗ 拿不到组合净价,发不出限价单。")
        return 1

    print("=" * 78)
    print("【真发单】走完整生产路径平掉:%s(%s · 纸面)" % (raw["label"], raw["account"]))
    print("  当前净价 %.4f,每组净成本 %.4f,组数 %+g" % (
        raw["market_price"], raw["avg_cost"], raw["quantity"]))

    store = TradeStore(settings.db_path)
    engine = TradingEngine(settings, parser=object(), store=store,
                           notifier=Notifier(enabled=False), router=router)
    # 止盈价放在现价的"已越过"一侧:多头组合设低一点,空头设高一点 → 当轮必触发
    price = float(raw["market_price"])
    take = round(price * (0.5 if raw["quantity"] > 0 else 1.5), 4)
    track = store.add_track({
        "account": raw["account"], "symbol": raw["symbol"], "sec_type": raw["sec_type"],
        "leg": raw.get("leg") or "", "contract": raw["contract"],
        "targets": {"take_profit": take},
        "auto_close": {"enabled": True, "order_type": "LMT", "slippage_pct": args.slippage},
        "peak": None,
    })
    print("  临时追踪已建(止盈 %.4f,必触发);现在跑一轮 poll_trackers……" % take)
    try:
        out = engine.poll_trackers(now_et())
        if out["blocked"]:
            print("✗ 被闸门拦住:%s" % "、".join(out["blocked"][0]["blockers"]))
            return 1
        if not out["fired"]:
            row = next((r for r in out["rows"] if r["id"] == track["id"]), {})
            print("✗ 没有触发。状态=%s 理由=%s" % (row.get("state"), row.get("reason")))
            return 1
        fired = out["fired"][0]
        print("  ✓ 已发单:record=%s order_id=%s" % (fired["record_id"], fired["order_id"]))
        print("    理由:%s" % fired["reason"])

        # 等回报落库:成交是异步的,给券商与事件循环一点时间
        import time
        record = None
        for _ in range(20):
            for session in router.sessions():
                try:
                    session.sleep(0.5)
                except Exception:  # noqa: BLE001
                    time.sleep(0.5)
            record = store.get_record(fired["record_id"])
            if record and record.get("final_status"):
                break
        if record is None:
            print("✗ 记录不见了?")
            return 1
        ib = record.get("ibkr") or {}
        print("  终态      :", record.get("final_status") or "(还没落终态)")
        print("  状态轨迹  :", [s["status"] for s in ib.get("status_timeline") or []])
        print("  成交条数  :", len(ib.get("fills") or []))
        for f in (ib.get("fills") or [])[:6]:
            print("      %s %g @ %.4f" % (f.get("exec_id"), f.get("qty") or 0, f.get("price") or 0))
        if ib.get("avg_fill_price") is not None:
            print("  成交均价  :", ib["avg_fill_price"])
        print("")
        print("  再跑一轮看收尾(持仓应当已经没了,追踪应当停止):")
        follow = engine.poll_trackers(now_et())
        row = next((r for r in follow["rows"] if r["id"] == track["id"]), {})
        print("    状态=%s reason=%s fired=%d" % (row.get("state"), row.get("reason"),
                                                  len(follow["fired"])))
        return 0
    finally:
        store.delete_track(track["id"])
        print("  (临时追踪已删除;成交记录保留在交易记录里)")


if __name__ == "__main__":
    raise SystemExit(main())
