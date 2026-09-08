"""0DTE 蝶式止盈策略(flyexit):方差时间表、模型价、点位与逐分钟回放。全部脱机。"""
from __future__ import annotations

import math

from ibkr_agent import flyexit as fx

PROFILE = {"symbol": "SPX", "right": "C", "lower": 7720.0, "center": 7740.0, "upper": 7760.0,
           "width": 20.0, "width_upper": 20.0, "action": "BUY", "qty": 3, "multiplier": 100.0, "debit": 6.0}


def bars(closes, start="10:00", day="2026-09-03", step=1):
    h, m = (int(x) for x in start.split(":"))
    out = []
    for c in closes:
        out.append({"time": "%s %02d:%02d" % (day, h, m), "open": c, "high": c + 0.5, "low": c - 0.5, "close": c})
        m += step
        while m >= 60:
            h, m = h + 1, m - 60
    return out


# ---- 方差与阶段 -----------------------------------------------------------
def test_variance_schedule_matches_the_document():
    assert fx.remaining_variance(fx.minutes_of("09:30")) == 1.0
    assert fx.remaining_variance(fx.minutes_of("10:30")) == 0.76
    assert fx.remaining_variance(fx.minutes_of("13:30")) == 0.46
    assert fx.remaining_variance(fx.minutes_of("15:30")) == 0.17
    assert fx.remaining_variance(fx.minutes_of("16:00")) == 0.0
    assert fx.sigma_remaining(36, fx.minutes_of("15:00")) == round(36 * math.sqrt(0.28), 4)


def test_phase_switch_is_about_15_25_for_w25_em36():
    params = fx.params_from({"em": 36})
    sw = fx.switch_minute(25.0, params)
    assert "15:20" <= fx.fmt_minute(sw) <= "15:30"          # 文档:约 15:25
    assert fx.phase_at(fx.minutes_of("11:00"), 25.0, params) == "A"
    assert fx.phase_at(fx.minutes_of("14:30"), 25.0, params) == "B"
    assert fx.phase_at(fx.minutes_of("15:45"), 25.0, params) == "C"
    # EM 越高切换越晚;翼越宽切换越早
    assert fx.switch_minute(25.0, fx.params_from({"em": 50})) > sw
    assert fx.switch_minute(40.0, params) < sw


def test_params_ignore_garbage_and_keep_defaults():
    p = fx.params_from({"em": "abc", "tp1": None, "stop": -1, "nonsense": 3, "cutoff_a": "13:30"})
    assert p["em"] == 36.0 and p["tp1"] is None and p["stop"] == 0.5 and p["cutoff_a"] == "13:30"
    assert p["trail"] == 0.30 and p["trail_late"] == "15:00"
    # 固定档位默认关掉,传正数才启用;两个钟点参数都按字符串收
    p2 = fx.params_from({"tp1": 1.35, "tp2": 1.7, "trail_late": "15:30"})
    assert p2["tp1"] == 1.35 and p2["tp2"] == 1.7 and p2["trail_late"] == "15:30"


# ---- 回撤档位 -----------------------------------------------------------
def test_trail_pct_tightens_as_profit_approaches_the_wing():
    p = fx.params_from(None)
    d, noon, late = 2.25, fx.minutes_of("11:00"), fx.minutes_of("15:30")
    assert fx.trail_pct(0.5, d, noon, p) == 0.40          # 浮盈 < 1×D:噪声区,放宽
    assert fx.trail_pct(3.0, d, noon, p) == 0.30          # 1×D–3×D:中档
    assert fx.trail_pct(7.0, d, noon, p) == 0.20          # ≥ 3×D:逼近天花板,收紧
    assert fx.trail_pct(7.0, d, late, p) == 0.10          # 尾盘再乘 0.5
    # 触发价 = D + 高水位浮盈 × (1 − 档位)
    assert fx.trail_stop(5.75, d, noon, p) == 6.275
    assert fx.trail_stop(5.75, d, late, p) == 7.1375


# ---- 模型价 -------------------------------------------------------------
def test_model_price_is_the_tent_at_expiry_and_the_document_atm_value_at_open():
    assert fx.model_price(PROFILE, 7740, 0.0) == 20.0
    assert fx.model_price(PROFILE, 7700, 0.0) == 0.0
    atm = dict(PROFILE, lower=7606.0, center=7631.0, upper=7656.0, width=25.0, width_upper=25.0)
    assert abs(fx.model_price(atm, 7631, 36.0) - 6.66) < 0.05      # 文档 §3 表:09:30 平价蝶 6.66
    assert abs(fx.model_price(atm, 7631, 14.8) - 13.72) < 0.05     # 15:30
    put = dict(atm, right="P")
    assert abs(fx.model_price(put, 7631, 36.0) - fx.model_price(atm, 7631, 36.0)) < 1e-6


# ---- 点位 ---------------------------------------------------------------
def test_levels_and_expected_pnl():
    lv = {l["kind"]: l for l in fx.levels(PROFILE, fx.params_from(None))}
    assert set(lv) == {"trail_arm", "stop"}              # 固定档位默认关掉,不画线
    assert lv["stop"]["price"] == 3.0 and lv["stop"]["expected_pnl"] == -900.0
    assert lv["trail_arm"]["price"] == 7.8 and lv["trail_arm"]["expected_pnl"] is None
    # 显式传 tp1/tp2 恢复 v2.0 的分批档位
    lv2 = {l["kind"]: l for l in fx.levels(PROFILE, fx.params_from({"tp1": 1.35, "tp2": 1.7}))}
    assert lv2["tp1"]["price"] == 8.1 and lv2["tp1"]["tranche_qty"] == 1 and lv2["tp1"]["expected_pnl"] == 210.0
    assert lv2["tp2"]["price"] == 10.2 and lv2["tp2"]["expected_pnl"] == 420.0
    assert fx.tranche_sizes(1) == [1, 0] and fx.tranche_sizes(2) == [1, 1] and fx.tranche_sizes(7) == [2, 2]


def test_zones_are_symmetric_around_center():
    z = {x["kind"]: x for x in fx.zones(PROFILE, fx.params_from(None))}
    assert (z["hold"]["low"], z["hold"]["high"]) == (7731.0, 7749.0)
    assert (z["half"]["low"], z["half"]["high"]) == (7729.0, 7751.0)
    assert (z["stop"]["low"], z["stop"]["high"]) == (7724.0, 7756.0)


# ---- 回放 ---------------------------------------------------------------
def test_stage_a_scales_out_in_thirds_and_caps_at_1400():
    """v2.0 的固定档位:默认关掉了,显式传 tp1/tp2 仍要按老样子分批。"""
    spx = bars([7740.0] * 300, start="10:00")                   # 一直在中心
    fly = bars([6.0, 7.0, 8.2, 9.0, 10.3] + [9.0] * 295, start="10:00")
    sim = fx.simulate(PROFILE, "2026-09-03 10:00", spx, fly, fx.params_from({"tp1": 1.35, "tp2": 1.7}))
    rules = [(e["time"][11:], e["qty"], e["price"], e["rule"][:3]) for e in sim["events"]]
    assert rules[0] == ("10:02", 1, 8.2, "第一档")
    assert rules[1] == ("10:04", 1, 10.3, "第二档")
    assert sim["events"][1]["remaining"] == 1 and len(sim["events"]) == 3        # 剩 1/3 留到数据尽头
    assert sim["events"][2]["source"] == "mark"
    assert sim["totals"]["strategy"] == 220.0 + 430.0 + 300.0                    # 最后一张按最后价估值


def test_trailing_exit_runs_in_stage_a_and_beats_the_old_fixed_tier():
    """用户 2026-09-03 那张单的形状:D=2.25、W=20,蝶价 2.25 → 8 → 回落。

    v2.0 的 1.35×D 会在 3.04 就全清(1 张凑不出三批);v2.1 把高水位让掉 30% 再走。
    """
    P = dict(PROFILE, debit=2.25, qty=1)
    fly = [2.25, 2.6, 3.3, 4.1, 5.0, 6.2, 7.2, 8.0, 7.4, 6.6, 6.2, 5.6]
    spx = [7726, 7728, 7731, 7733, 7735, 7737, 7739, 7740, 7739, 7737, 7735, 7733]
    sim = fx.simulate(P, "2026-09-03 11:00", bars(spx, start="11:00"), bars(fly, start="11:00"),
                      fx.params_from(None))
    assert len(sim["events"]) == 1
    ev = sim["events"][0]
    assert ev["rule"].startswith("回撤追踪") and ev["time"][11:] == "11:10"
    assert ev["price"] == 6.2 and ev["qty"] == 1 and ev["pnl"] == 395.0
    assert sim["totals"]["profit_peak"] == 5.75                 # 8.00 − 2.25
    # 高水位落在 1×D–3×D 档:让 30%,触发价 2.25 + 5.75×0.7
    assert sim["series"][7]["trail_stop"] == 6.275
    assert sim["series"][0]["trail_stop"] is None               # 还没到 1.3×D,没激活
    # 同一段行情走 v2.0 的固定档位:3.04 就清光,只拿到零头
    old = fx.simulate(P, "2026-09-03 11:00", bars(spx, start="11:00"), bars(fly, start="11:00"),
                      fx.params_from({"tp1": 1.35, "tp2": 1.7}))
    assert old["events"][0]["price"] == 3.3 and old["totals"]["strategy"] == 105.0


def test_trailing_has_a_floor_and_halves_late_in_the_day():
    P = dict(PROFILE, debit=2.25, qty=1)
    # 浮盈刚过激活线就抖动:回吐 0.15 点 < trail_floor 0.20,不许触发
    fly, spx = [2.25, 3.0, 2.85, 2.9], [7740.0] * 4
    sim = fx.simulate(P, "2026-09-03 11:00", bars(spx, start="11:00"), bars(fly, start="11:00"),
                      fx.params_from(None))
    assert not any("回撤追踪" in e["rule"] for e in sim["events"])  # 0.15 × 100 = 15 美元,是价差不是信号
    assert sim["events"][-1]["source"] == "mark"                 # 数据到尽头,仓位还在
    # 同样的形状放大到 0.30 点回吐(> 地板,且 > 0.75 × 40%),就该走
    sim2 = fx.simulate(P, "2026-09-03 11:00", bars([7740.0] * 4, start="11:00"),
                       bars([2.25, 3.0, 2.7, 2.7], start="11:00"), fx.params_from(None))
    assert sim2["events"] and sim2["events"][0]["price"] == 2.7
    # 15:00 之后档位减半:同样的浮盈,更早出手
    p = fx.params_from(None)
    assert fx.trail_pct(3.0, 2.25, fx.minutes_of("14:59"), p) == 0.30
    assert fx.trail_pct(3.0, 2.25, fx.minutes_of("15:00"), p) == 0.15


def test_stop_loss_on_price_fires_any_time():
    spx = bars([7740.0] * 10, start="10:00")
    fly = bars([6.0, 5.0, 2.9, 2.0], start="10:00")
    sim = fx.simulate(PROFILE, "2026-09-03 10:00", spx, fly, fx.params_from(None))
    assert len(sim["events"]) == 1 and sim["events"][0]["rule"].startswith("止损:蝶价")
    assert sim["events"][0]["qty"] == 3 and sim["events"][0]["price"] == 2.9


def test_position_stop_needs_leaving_the_zone():
    """位置止损说的是"出界":开仓时就在 0.8W 之外的远端蝶不能一进场就被止损。"""
    spx = bars([7700.0] * 10, start="10:00")                       # 距中心 40 > 0.8W = 16
    fly = bars([2.0] * 10, start="10:00")
    otm = dict(PROFILE, debit=2.0, qty=1)
    sim = fx.simulate(otm, "2026-09-03 10:00", spx, fly, fx.params_from(None))
    assert sim["entry_outside"] is True
    assert not any("止损" in e["rule"] for e in sim["events"])
    # 进过界再出界才止损
    spx2 = bars([7740.0, 7740.0, 7760.0], start="10:00")
    fly2 = bars([6.0, 6.0, 4.0], start="10:00")
    sim2 = fx.simulate(PROFILE, "2026-09-03 10:00", spx2, fly2, fx.params_from(None))
    assert sim2["events"][0]["rule"].startswith("止损:|S−K|")


def test_otm_butterfly_scales_out_when_price_enters_the_band():
    spx = bars([7700.0, 7715.0, 7732.0, 7735.0], start="10:00")
    fly = bars([2.0, 2.2, 2.6, 2.7], start="10:00")
    otm = dict(PROFILE, debit=2.0)
    sim = fx.simulate(otm, "2026-09-03 10:00", spx, fly, fx.params_from(None))
    assert sim["events"][0]["rule"].startswith("OTM 蝶") and sim["events"][0]["time"][11:] == "10:02"
    assert sim["events"][0]["qty"] == 1


def test_stage_b_clears_out_of_zone_and_trails_inside():
    params = fx.params_from(None)
    # 14:00 起:第一分钟在界内 → 留仓压到 1/3;之后出界 → 全清
    spx = bars([7740.0, 7740.0, 7752.0], start="14:00")
    fly = bars([8.0, 8.0, 5.0], start="14:00")
    sim = fx.simulate(PROFILE, "2026-09-03 14:00", spx, fly, params)
    assert sim["events"][0]["rule"].startswith("进入 14:00 过渡") and sim["events"][0]["qty"] == 2
    assert sim["events"][1]["rule"].startswith("阶段 B:|S−K|") and sim["events"][1]["remaining"] == 0
    # 界内:14:00 压到 1/3 后,浮盈 ≥ 1.3D 启用回撤追踪,从高水位回撤 25% 清仓
    spx = bars([7740.0] * 6, start="14:00")
    fly = bars([6.0, 7.9, 9.0, 8.0, 6.7, 6.0], start="14:00")
    sim = fx.simulate(PROFILE, "2026-09-03 14:00", spx, fly, params)
    assert sim["events"][0]["qty"] == 2 and sim["events"][0]["remaining"] == 1
    trail = [e for e in sim["events"] if "回撤" in e["rule"]]
    assert trail and trail[0]["time"][11:] == "14:04" and trail[0]["price"] == 6.7 and trail[0]["qty"] == 1


def test_stage_c_holds_inside_halves_in_the_band_and_dumps_outside():
    params = fx.params_from({"em": 36})
    start = fx.fmt_minute(fx.switch_minute(20.0, params))
    spx = bars([7740.0, 7750.0, 7752.0], start=start)      # 界内 → 0.45W–0.55W → 更远
    fly = bars([12.0, 9.0, 7.0], start=start)
    sim = fx.simulate(PROFILE, "2026-09-03 " + start, spx, fly, params)
    assert sim["events"][0]["rule"].startswith("阶段 C:|S−K| = 10.0 在") and sim["events"][0]["qty"] == 2
    assert sim["events"][1]["rule"].startswith("阶段 C:|S−K| = 12.0 >") and sim["events"][1]["remaining"] == 0


def test_settlement_uses_intrinsic_value_at_the_close():
    spx = bars([7745.0] * 6, start="15:56")               # 15:56 … 16:01
    sim = fx.simulate(dict(PROFILE, qty=1), "2026-09-03 15:56", spx, [], fx.params_from(None))
    last = sim["events"][-1]
    assert last["source"] == "settle" and last["price"] == 15.0 and last["pnl"] == 900.0
    assert sim["totals"]["hold_to_settle"] == 900.0
    assert sim["totals"]["model_minutes"] > 0            # 没给蝶价,全用模型价


def test_short_butterfly_and_missing_debit_are_not_applicable():
    assert fx.simulate(dict(PROFILE, action="SELL"), "2026-09-03 10:00", bars([7740.0]), [], fx.params_from(None))["applicable"] is False
    assert fx.simulate(dict(PROFILE, debit=None), "2026-09-03 10:00", bars([7740.0]), [], fx.params_from(None))["applicable"] is False


def test_plan_bundles_levels_zones_phases_and_notes():
    spx = bars([7740.0] * 5, start="10:00")
    p = fx.plan(PROFILE, "2026-09-03 10:00", spx, [], {"em": 40}, {"kind": "closed", "price": 9.0, "pnl": 900.0})
    assert p["params"]["em"] == 40.0 and p["phases"]["a_until"] == "14:00"
    assert {l["kind"] for l in p["levels"]} == {"trail_arm", "stop"}
    assert any("浮盈回撤追踪" in n for n in p["notes"]) and any("固定倍数档位已关闭" in n for n in p["notes"])
    assert p["actual_exit_mult"] == 1.5
    assert any("模型价" in n for n in p["notes"])
