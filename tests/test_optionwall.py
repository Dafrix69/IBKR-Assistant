"""期权墙(optionwall.py)。全部离线合成链,不需要 TWS。

重点还是"不许骗人":数据不够要拒绝、0DTE 要把 OI 的局限说出来、
gamma 在别的价位必须重算而不是拿现价那个凑。
"""
from __future__ import annotations

import json
from datetime import datetime

import pytest

from ibkr_agent.optionwall import (
    MIN_STRIKES, OptionWallError, analyze, bs_gamma, gamma_flip, levels_for_pa,
    max_pain, net_gex_at, to_rows, years_to_expiry, _by_strike,
)


def chain(strikes, call_oi=None, put_oi=None, call_vol=None, put_vol=None, iv=0.2):
    """按行权价列表造一条链。各量缺省给 100,方便只改关心的那一项。"""
    rows = []
    for i, k in enumerate(strikes):
        rows.append({"strike": k, "right": "C", "iv": iv,
                     "oi": (call_oi or {}).get(k, 100), "volume": (call_vol or {}).get(k, 10)})
        rows.append({"strike": k, "right": "P", "iv": iv,
                     "oi": (put_oi or {}).get(k, 100), "volume": (put_vol or {}).get(k, 10)})
    return rows


STRIKES = [5900, 5950, 6000, 6050, 6100, 6150, 6200]
NOW = datetime(2026, 8, 19, 10, 0)


# ---------------------------------------------------------------- 墙
def test_call_wall_is_above_spot_and_put_wall_below():
    rows = chain(STRIKES, call_oi={6150: 9000}, put_oi={5950: 8000})
    result = analyze(rows, spot=6040, expiry="20260918", symbol="SPX", now=NOW)
    assert result["call_wall"]["strike"] == 6150
    assert result["put_wall"]["strike"] == 5950
    assert result["call_wall"]["distance_pct"] > 0
    assert result["put_wall"]["distance_pct"] < 0


def test_walls_ignore_the_biggest_strike_on_the_wrong_side():
    """现价下方那个巨大的 call 持仓不是阻力 —— 它已经在价内了。"""
    rows = chain(STRIKES, call_oi={5900: 99999, 6150: 500})
    result = analyze(rows, spot=6040, expiry="20260918", symbol="SPX", now=NOW)
    assert result["call_wall"]["strike"] == 6150


def test_volume_wall_is_tracked_separately_from_open_interest():
    """OI 和成交量指向不同的价位时,两个都要报,不能合并。"""
    rows = chain(STRIKES, call_oi={6200: 9000}, call_vol={6100: 7000})
    result = analyze(rows, spot=6040, expiry="20260918", symbol="SPX", now=NOW)
    assert result["call_wall"]["strike"] == 6200
    assert result["call_vol_wall"]["strike"] == 6100


# ---------------------------------------------------------------- Max pain
def test_max_pain_sits_where_intrinsic_value_is_smallest():
    # 只在 6000 有持仓 → 痛点必然就是 6000(那里所有合约都归零)
    rows = [
        {"strike": 6000, "right": "C", "oi": 1000, "iv": 0.2},
        {"strike": 6000, "right": "P", "oi": 1000, "iv": 0.2},
    ]
    for k in STRIKES:
        rows.append({"strike": k, "right": "C", "oi": 0, "iv": 0.2})
        rows.append({"strike": k, "right": "P", "oi": 0, "iv": 0.2})
    assert max_pain(_by_strike(to_rows(rows)))["strike"] == 6000


def test_max_pain_needs_enough_strikes():
    grid = _by_strike(to_rows(chain(STRIKES[:2])))
    assert max_pain(grid) is None


# ---------------------------------------------------------------- Gamma
def test_bs_gamma_peaks_at_the_money_and_never_diverges_at_expiry():
    atm = bs_gamma(6000, 6000, 1 / 365.0, 0.2)
    otm = bs_gamma(6000, 6600, 1 / 365.0, 0.2)
    assert atm > otm > 0
    # 到期当天 T→0:必须被下限挡住,不能算出 inf / nan
    same_day = bs_gamma(6000, 6000, 0.0, 0.2)
    assert same_day == same_day and same_day != float("inf") and same_day > 0


def test_net_gex_is_positive_when_calls_dominate_and_negative_when_puts_do():
    """符号约定:假定做市商多头 call、空头 put。这条一旦被改动,结论会整个翻过来。"""
    calls = to_rows([{"strike": 6000, "right": "C", "oi": 1000, "iv": 0.2}])
    puts = to_rows([{"strike": 6000, "right": "P", "oi": 1000, "iv": 0.2}])
    t = 30 / 365.0
    assert net_gex_at(calls, 6000, t) > 0
    assert net_gex_at(puts, 6000, t) < 0


def test_broker_gamma_is_used_at_spot_but_never_at_other_price_levels():
    """券商的模型 gamma 是**在现价算的**;拿去当另一个价位的 gamma 用就是错的。"""
    rows = to_rows([{"strike": 6000, "right": "C", "oi": 1000, "gamma": 0.05, "iv": 0.2}])
    t = 30 / 365.0
    at_spot = net_gex_at(rows, 6000, t, at_current_spot=True)
    recomputed = net_gex_at(rows, 6000, t, at_current_spot=False)
    assert at_spot != recomputed          # 一个用 0.05,另一个用 BS 重算

    # 没有 IV 时,推演到别的价位只能放弃这一条,而不是拿现价的 gamma 顶上
    no_iv = to_rows([{"strike": 6000, "right": "C", "oi": 1000, "gamma": 0.05}])
    assert net_gex_at(no_iv, 6300, t, at_current_spot=False) == 0.0
    assert net_gex_at(no_iv, 6300, t, at_current_spot=True) != 0.0


def test_gamma_flip_returns_none_when_the_profile_never_crosses_zero():
    """全是 call 的链,净 GEX 恒正,没有翻转位 —— 不许外推编一个出来。"""
    rows = to_rows([{"strike": k, "right": "C", "oi": 100, "iv": 0.2} for k in STRIKES])
    assert gamma_flip(rows, STRIKES, 30 / 365.0) is None


def test_gamma_flip_is_found_between_put_heavy_and_call_heavy_zones():
    """下方堆 put、上方堆 call,近月才会出现翻转位。

    期限必须短:30 天 / 20% 波动下,±2.5% 的行权价跨度还不到一个标准差,
    gamma 几乎是平的,持仓多的那一侧会恒压另一侧——那种链本来就没有翻转位。
    """
    rows = to_rows(
        [{"strike": k, "right": "P", "oi": 3000, "iv": 0.2} for k in STRIKES[:3]]
        + [{"strike": k, "right": "C", "oi": 3000, "iv": 0.2} for k in STRIKES[3:]]
    )
    flip = gamma_flip(rows, STRIKES, 1 / 365.0)
    assert flip is not None
    # 翻转位应当落在 put 区与 call 区的交界处附近
    assert STRIKES[2] <= flip <= STRIKES[3]


def test_gamma_flip_is_none_when_gamma_is_too_flat_to_ever_cross():
    """远月 + 窄行权价跨度:gamma 几乎均匀,持仓多的一侧恒赢,没有翻转位。
    这种情况必须返回 None,不许硬凑一个价位出来。"""
    rows = to_rows(
        [{"strike": k, "right": "P", "oi": 3000, "iv": 0.2} for k in STRIKES[:3]]
        + [{"strike": k, "right": "C", "oi": 3000, "iv": 0.2} for k in STRIKES[3:]]
    )
    assert gamma_flip(rows, STRIKES, 30 / 365.0) is None


# ---------------------------------------------------------------- 到期
def test_years_to_expiry_floors_at_one_hour():
    """0DTE 收盘后 T 会变成负数,必须被下限挡住,否则 gamma 直接爆掉。"""
    after_close = years_to_expiry("20260819", datetime(2026, 8, 19, 20, 0))
    assert 0 < after_close <= 1.0 / (365.0 * 24.0) + 1e-12
    a_month = years_to_expiry("20260918", NOW)
    assert 0.07 < a_month < 0.09        # 大约 30 天


# ---------------------------------------------------------------- 总装
def test_analyze_refuses_a_chain_that_is_too_thin():
    with pytest.raises(OptionWallError) as exc:
        analyze(chain(STRIKES[:2]), spot=6040, expiry="20260918", now=NOW)
    assert "行权价" in str(exc.value)


def test_analyze_refuses_without_a_spot_price():
    with pytest.raises(OptionWallError) as exc:
        analyze(chain(STRIKES), spot=0, expiry="20260918", now=NOW)
    assert "现价" in str(exc.value)


def test_zero_dte_says_open_interest_is_nearly_useless():
    """0DTE 合约当天开当天平,OI 反映不了今天的流 —— 这句必须出现在警告里。"""
    result = analyze(chain(STRIKES), spot=6040, expiry="20260819", symbol="SPX", now=NOW)
    assert any("0DTE" in w for w in result["warnings"])
    assert any("成交量墙" in w for w in result["warnings"])


def test_gex_assumption_is_always_disclosed():
    """符号约定是个假设。任何时候都要写在脸上,不许因为"结果好看"就省掉。"""
    result = analyze(chain(STRIKES), spot=6040, expiry="20260918", now=NOW)
    assert any("假设" in w for w in result["warnings"])


def test_result_is_json_serialisable_and_carries_the_strike_grid():
    result = analyze(chain(STRIKES), spot=6040, expiry="20260918", symbol="SPX", now=NOW)
    assert json.loads(json.dumps(result, ensure_ascii=False))["symbol"] == "SPX"
    assert len(result["strikes"]) == len(STRIKES)
    assert set(result["strikes"][0]) >= {"strike", "call_oi", "put_oi", "net_gex"}


def test_levels_put_volume_walls_first_on_expiry_day():
    """0DTE 下成交量墙比 OI 墙可信,给 PA 对照时要排在前面。"""
    rows = chain(STRIKES, call_oi={6200: 9000}, call_vol={6100: 7000})
    same_day = levels_for_pa(analyze(rows, spot=6040, expiry="20260819", now=NOW))
    assert same_day[0]["price"] == 6100

    later = levels_for_pa(analyze(rows, spot=6040, expiry="20260918", now=NOW))
    assert later[0]["price"] == 6200
