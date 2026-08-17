"""TWS 检测与诊断。核心是:失败信息要能直接照着做,别名映射错必须当场暴露。"""
from __future__ import annotations

import asyncio
import concurrent.futures
import socket

import pytest

from ibkr_agent import tws


@pytest.fixture
def listening_port():
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    yield server.getsockname()[1]
    server.close()


@pytest.fixture
def closed_port():
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    port = server.getsockname()[1]
    server.close()
    return port


def test_probe_detects_open_port(listening_port):
    result = tws.probe_port("127.0.0.1", listening_port)
    assert result["open"] is True
    assert result["latency_ms"] is not None
    assert result["error"] is None


def test_probe_detects_closed_port(closed_port):
    result = tws.probe_port("127.0.0.1", closed_port, timeout=0.3)
    assert result["open"] is False
    assert result["error"]


def test_scan_covers_standard_ports_and_marks_configured(settings):
    ports = tws.scan_ports(settings)
    numbers = {p["port"] for p in ports}
    assert {7496, 7497, 4001, 4002} <= numbers

    by_port = {p["port"]: p for p in ports}
    assert by_port[7497]["configured_as"] == "paper"
    assert by_port[7496]["configured_as"] == "live"
    assert by_port[4001]["configured_as"] is None


def test_scan_includes_non_standard_configured_ports(settings):
    from conftest import make_settings

    custom = make_settings(
        connections={
            "paper": {"host": "127.0.0.1", "port": 7497, "client_id": 11},
            "odd": {"host": "127.0.0.1", "port": 9999, "client_id": 13},
        }
    )
    ports = {p["port"]: p for p in tws.scan_ports(custom)}
    assert 9999 in ports
    assert ports[9999]["configured_as"] == "odd"


# ---- 报错翻译 -----------------------------------------------------------
def test_refused_error_points_at_a_stopped_tws():
    detail = tws.explain_connect_error(ConnectionRefusedError("refused"), 7497, port_open=False)
    assert detail["code"] == "refused"
    assert "7497" in detail["hint"]


@pytest.mark.parametrize(
    "error",
    [
        TimeoutError("timeout"),
        asyncio.TimeoutError(),            # ib_insync 握手超时实际抛的就是它,且消息为空
        concurrent.futures.TimeoutError(),
        socket.timeout(),
    ],
)
def test_open_port_timeout_points_at_the_api_checkbox(error):
    """端口开着却握手超时——最常见的一种失败,提示必须准确。

    Python 3.9 里 asyncio.TimeoutError 既不是内建 TimeoutError、str() 也是空的,
    只按 isinstance 或消息文本判断都会漏成"未知错误"。
    """
    detail = tws.explain_connect_error(error, 7497, port_open=True)
    assert detail["code"] == "handshake_timeout"
    assert "Enable ActiveX and Socket Clients" in detail["hint"]
    assert "接受传入连接" in detail["hint"]


def test_closed_port_timeout_points_at_login():
    detail = tws.explain_connect_error(TimeoutError("timeout"), 7497, port_open=False)
    assert detail["code"] == "timeout"
    assert "完成登录" in detail["hint"]


def test_known_ibkr_codes_are_translated():
    assert "clientId" in tws.explain_connect_error(Exception("error 326"), 7497, True)["hint"]
    assert "API" in tws.explain_connect_error(Exception("error 502 ..."), 7497, True)["hint"]


# ---- 别名映射 -----------------------------------------------------------
def test_alias_mapping_flags_a_wrong_account_id(settings):
    rows, unmapped = tws.check_alias_mapping(settings, ["DU7654321"])
    by_alias = {r["alias"]: r for r in rows}
    assert by_alias["模拟"]["resolved"] is True
    assert by_alias["主账户"]["resolved"] is False       # 实盘账号不在这条会话里
    assert by_alias["模拟"]["account_masked"] == "DU***321"
    assert unmapped == []


def test_alias_mapping_reports_accounts_missing_from_the_table(settings):
    rows, unmapped = tws.check_alias_mapping(settings, ["DU7654321", "DU1111111"])
    assert unmapped == ["DU***111"]
    assert all("account_id" not in r for r in rows)      # 只掩码,不外泄完整账号


# ---- 拉起程序 -----------------------------------------------------------
def test_launch_rejects_anything_but_the_two_known_keys():
    """界面绝不能传路径过来,否则等于给渲染进程一个执行任意程序的通道。"""
    for bad in ("/Applications/Calculator.app", "../../bin/sh", "", None):
        with pytest.raises(ValueError, match="只支持拉起"):
            tws.launch_app(bad)


def test_detect_apps_shape():
    apps = {a["key"]: a for a in tws.detect_apps()}
    assert set(apps) == {"tws", "gateway"}
    for app in apps.values():
        assert isinstance(app["installed"], bool)
        assert isinstance(app["running"], bool)
        assert isinstance(app["paths"], list)


# ---- 指引 ---------------------------------------------------------------
def test_guide_mentions_the_actual_configured_ports(settings):
    guide = tws.connection_guide(settings)
    text = " ".join(step["detail"] for step in guide)
    assert "7497" in text and "7496" in text
    assert "127.0.0.1" in text
    assert any("不接触" in step["detail"] for step in guide)   # 凭证边界要写在第一步


def test_diagnose_on_a_dead_port_explains_instead_of_raising(settings, closed_port):
    from conftest import make_settings

    dead = make_settings(
        connections={"paper": {"host": "127.0.0.1", "port": closed_port, "client_id": 11}},
        accounts=[
            {"alias": "模拟", "account_id": "DU7654321", "is_paper": True,
             "connection": "paper", "default": True}
        ],
    )
    result = tws.diagnose(dead, "paper")
    assert result["connected"] is False
    assert result["port_open"] is False
    assert result["hint"]
    assert result["port"] == closed_port


def test_diagnose_rejects_unknown_connection(settings):
    with pytest.raises(ValueError, match="未定义的连接"):
        tws.diagnose(settings, "nope")
