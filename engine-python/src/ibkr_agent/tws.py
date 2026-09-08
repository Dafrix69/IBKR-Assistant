"""TWS / IB Gateway 连接检测与诊断。

边界先说清楚:**本模块不接触任何 IBKR 凭证**。IBKR 的账号密码属于 §9.1 的 S0 级,
只允许存在于 IBKR 自己的程序里。登录动作由用户在 TWS / IB Gateway 的窗口里完成,
本软件只做三件事:

  1. 检测——端口开没开、程序装没装、在不在跑;
  2. 诊断——握手成不成、失败的话具体卡在哪一步,给出能照着做的下一步;
  3. 拉起——用 `open -a` 把 TWS 叫起来,让用户在它自己的窗口里登录。

诊断结果里还包含一项别人容易忽略但很要命的检查:**配置里的账户别名,是否真的
对得上这个会话能管的账号**。对不上就说明别名表写错了,继续下单会落到错误账户。
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import glob
import os
import platform
import socket
import subprocess
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional, Sequence

from .config import Settings
from .store import redact_account

# IBKR 的四个标准端口。软件不猜用户改过的端口,配置里的会另外并进来。
KNOWN_ENDPOINTS: Sequence[Dict[str, Any]] = (
    {"port": 7496, "label": "TWS 实盘", "kind": "tws", "paper": False},
    {"port": 7497, "label": "TWS 模拟", "kind": "tws", "paper": True},
    {"port": 4001, "label": "IB Gateway 实盘", "kind": "gateway", "paper": False},
    {"port": 4002, "label": "IB Gateway 模拟", "kind": "gateway", "paper": True},
)

if platform.system() == "Windows":
    # IBKR 的 Windows 安装器默认装到 C:\Jts(可选装到用户目录);
    # 新版把主程序放根目录,旧版按版本号分子目录,两种布局都扫。
    APP_CANDIDATES: Dict[str, Sequence[str]] = {
        "tws": (
            "C:/Jts/tws.exe",
            "C:/Jts/*/tws.exe",
            "~/Jts/tws.exe",
            "~/Jts/*/tws.exe",
            os.path.join(os.environ.get("LOCALAPPDATA", ""), "Jts", "tws.exe"),
        ),
        "gateway": (
            "C:/Jts/ibgateway/*/ibgateway.exe",
            "C:/Jts/ibgateway.exe",
            "~/Jts/ibgateway/*/ibgateway.exe",
            os.path.join(os.environ.get("LOCALAPPDATA", ""), "Jts", "ibgateway", "*", "ibgateway.exe"),
        ),
    }
    PROCESS_PATTERNS: Dict[str, str] = {
        "tws": "tws.exe",
        "gateway": "ibgateway.exe",
    }
else:
    APP_CANDIDATES = {
        "tws": (
            "/Applications/Trader Workstation.app",
            "/Applications/Trader Workstation */Trader Workstation *.app",
            "~/Applications/Trader Workstation.app",
            "~/Applications/Trader Workstation */Trader Workstation *.app",
        ),
        "gateway": (
            "/Applications/IB Gateway.app",
            "/Applications/IB Gateway */IB Gateway *.app",
            "~/Applications/IB Gateway.app",
            "~/Applications/IB Gateway */IB Gateway *.app",
        ),
    }
    PROCESS_PATTERNS = {
        "tws": "Trader Workstation",
        "gateway": "ibgateway",
    }


@dataclass
class PortProbe:
    port: int
    label: str
    kind: str
    paper: Optional[bool]
    open: bool
    latency_ms: Optional[int] = None
    error: Optional[str] = None
    configured_as: Optional[str] = None   # 这个端口对应配置里的哪条连接

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def probe_port(host: str = "127.0.0.1", port: int = 7497, timeout: float = 0.6) -> Dict[str, Any]:
    """纯 TCP 探测:只看端口通不通,不发任何 IBKR 协议帧,不会打扰已有会话。"""
    started = time.monotonic()
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return {"open": True, "latency_ms": int((time.monotonic() - started) * 1000), "error": None}
    except socket.timeout:
        return {"open": False, "latency_ms": None, "error": "连接超时"}
    except ConnectionRefusedError:
        return {"open": False, "latency_ms": None, "error": "端口未监听"}
    except OSError as exc:
        return {"open": False, "latency_ms": None, "error": str(exc)}


def scan_ports(settings: Settings, host: str = "127.0.0.1") -> List[Dict[str, Any]]:
    """扫标准端口 + 配置里出现的端口,标出每个端口对应哪条连接。"""
    configured = {c.port: name for name, c in settings.connections_for("ibkr").items()}
    entries: List[Dict[str, Any]] = [dict(e) for e in KNOWN_ENDPOINTS]
    known_ports = {e["port"] for e in entries}
    for port, name in sorted(configured.items()):
        if port not in known_ports:
            entries.append(
                {"port": port, "label": "自定义端口(连接 %s)" % name, "kind": "custom", "paper": None}
            )

    results: List[Dict[str, Any]] = []
    for entry in entries:
        probe = probe_port(host, entry["port"])
        results.append(
            PortProbe(
                port=entry["port"],
                label=entry["label"],
                kind=entry["kind"],
                paper=entry["paper"],
                open=probe["open"],
                latency_ms=probe["latency_ms"],
                error=probe["error"],
                configured_as=configured.get(entry["port"]),
            ).to_dict()
        )
    return results


# ----------------------------------------------------------------------
# 应用检测与拉起
# ----------------------------------------------------------------------
def detect_apps() -> List[Dict[str, Any]]:
    apps: List[Dict[str, Any]] = []
    for key, patterns in APP_CANDIDATES.items():
        found: List[str] = []
        for pattern in patterns:
            found.extend(sorted(glob.glob(os.path.expanduser(pattern))))
        apps.append(
            {
                "key": key,
                "name": "Trader Workstation" if key == "tws" else "IB Gateway",
                "installed": bool(found),
                "paths": found[:5],
                "running": _process_running(PROCESS_PATTERNS[key]),
            }
        )
    return apps


def _process_running(pattern: str) -> bool:
    if platform.system() == "Windows":
        try:
            proc = subprocess.run(
                ["tasklist", "/FI", "IMAGENAME eq %s" % pattern, "/NH", "/FO", "CSV"],
                capture_output=True, text=True, timeout=5,
            )
        except (OSError, subprocess.SubprocessError):
            return False
        return proc.returncode == 0 and pattern.lower() in proc.stdout.lower()
    if platform.system() not in ("Darwin", "Linux"):
        return False
    try:
        proc = subprocess.run(["pgrep", "-f", pattern], capture_output=True, text=True, timeout=3)
    except (OSError, subprocess.SubprocessError):
        return False
    return proc.returncode == 0 and bool(proc.stdout.strip())


def launch_app(key: str) -> Dict[str, Any]:
    """拉起 TWS / Gateway。

    只接受 'tws' / 'gateway' 两个固定键,路径在这一侧解析——绝不让界面传路径过来,
    否则就等于给了渲染进程一个"执行任意程序"的通道。
    """
    if key not in APP_CANDIDATES:
        raise ValueError("只支持拉起 tws 或 gateway,收到:%r" % key)
    if platform.system() not in ("Darwin", "Windows"):
        raise RuntimeError("当前平台不支持一键拉起,请手动启动 TWS / IB Gateway。")

    for app in detect_apps():
        if app["key"] != key or not app["paths"]:
            continue
        target = app["paths"][0]
        if platform.system() == "Windows":
            # cwd 设为安装目录:TWS 启动器按相对路径找 jars/ 与 jts.ini
            subprocess.Popen(
                [target], cwd=os.path.dirname(target),
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS,
                close_fds=True,
            )
        else:
            proc = subprocess.run(["open", "-a", target], capture_output=True, text=True)
            if proc.returncode != 0:
                raise RuntimeError("启动失败:%s" % (proc.stderr.strip() or "未知错误"))
        return {"launched": True, "path": target}
    raise FileNotFoundError(
        "没有找到 %s 的安装。请先从 IBKR 官网下载安装。"
        % ("Trader Workstation" if key == "tws" else "IB Gateway")
    )


# ----------------------------------------------------------------------
# 握手诊断
# ----------------------------------------------------------------------
_TIMEOUT_TYPES = tuple(
    {TimeoutError, socket.timeout, asyncio.TimeoutError, concurrent.futures.TimeoutError}
)

IBKR_ERROR_HINTS: Dict[int, str] = {
    326: "clientId 已被占用。换一个 clientId,或关掉正在用同一 ID 的程序。",
    502: "无法连接到 TWS。多半是 API 没启用:TWS → Configure → API → Settings,"
         "勾上「Enable ActiveX and Socket Clients」,并确认 Socket port 与这里一致。",
    504: "未连接。请确认 TWS 已完成登录(登录界面停着是连不上的)。",
    1100: "与 IBKR 的连接已断开,TWS 正在重连。",
    2110: "与 IBKR 的连接暂时中断,TWS 会自动恢复。",
}


def explain_connect_error(exc: BaseException, port: int, port_open: bool) -> Dict[str, str]:
    """把连接异常翻成"下一步该做什么",而不是把 traceback 甩给用户。"""
    name = type(exc).__name__
    text = str(exc)

    for code, hint in IBKR_ERROR_HINTS.items():
        if str(code) in text:
            return {"reason": text or name, "hint": hint, "code": str(code)}

    if isinstance(exc, ConnectionRefusedError) or "refused" in text.lower():
        return {
            "reason": "端口 %d 拒绝连接" % port,
            "hint": "TWS / IB Gateway 没有在跑,或者它的 API 端口不是 %d。"
                    "先启动并登录 TWS,再在 Configure → API → Settings 里核对 Socket port。" % port,
            "code": "refused",
        }
    # 注意:Python 3.9 里 asyncio.TimeoutError 不是内建 TimeoutError,而且 str() 是空的
    # ——ib_insync 握手超时抛的正是它。只靠 isinstance 或消息文本都会漏,所以连类名一起认。
    if isinstance(exc, _TIMEOUT_TYPES) or "timeout" in text.lower() or "timeout" in name.lower():
        if port_open:
            return {
                "reason": "端口开着,但握手超时",
                "hint": "程序在跑,API 没放行。两种常见情况:①「Enable ActiveX and Socket Clients」"
                        "没勾;② TWS 弹出了「接受传入连接」的确认框,正等你点「Yes」。",
                "code": "handshake_timeout",
            }
        return {
            "reason": "连接超时",
            "hint": "确认 TWS / IB Gateway 已启动并**完成登录**,停在登录界面时 API 不会响应。",
            "code": "timeout",
        }
    return {"reason": "%s: %s" % (name, text), "hint": "详见引擎日志。", "code": "unknown"}


def check_alias_mapping(
    settings: Settings, managed_accounts: Sequence[str]
) -> "tuple[List[Dict[str, Any]], List[str]]":
    """核对别名表和这个会话真正能管的账号。

    对不上就说明别名表写错了——这种错误不会在下单时报错,只会静默落到错误账户,
    所以必须在连接阶段就摆到用户面前。
    """
    managed = {a for a in managed_accounts if a}
    rows: List[Dict[str, Any]] = []
    for account in settings.accounts:
        rows.append(
            {
                "alias": account.alias,
                "account_masked": redact_account(account.account_id),
                "is_paper": account.is_paper,
                "connection": account.connection,
                "resolved": account.account_id in managed,
                "default": account.default,
            }
        )
    unmapped = sorted(managed - {a.account_id for a in settings.accounts})
    return rows, [redact_account(a) for a in unmapped]


def diagnose(
    settings: Settings, connection_name: str, client_id: Optional[int] = None, timeout: float = 8.0
) -> Dict[str, Any]:
    """真握手一次:连上、读服务器版本与账户列表、立刻断开。

    用一个偏移过的 clientId,避免和正在下单的那条连接抢 ID(IBKR 会报 326)。
    """
    cfg = settings.connections_for("ibkr").get(connection_name)
    if cfg is None:
        raise ValueError("未定义的连接:%s(这里只在 IBKR 连接里查找)" % connection_name)

    probe = probe_port(cfg.host, cfg.port)
    result: Dict[str, Any] = {
        "connection": connection_name,
        "host": cfg.host,
        "port": cfg.port,
        "port_open": probe["open"],
        "port_latency_ms": probe["latency_ms"],
        "connected": False,
        "server_version": None,
        "server_time": None,
        "managed_accounts": [],
        "accounts": [],
        "unmapped_accounts": [],
        "readonly": cfg.readonly,
        "client_id": client_id if client_id is not None else cfg.client_id + 90,
        "error": None,
        "hint": None,
    }

    if not probe["open"]:
        detail = explain_connect_error(ConnectionRefusedError(probe["error"] or ""), cfg.port, False)
        result["error"] = detail["reason"]
        result["hint"] = detail["hint"]
        return result

    try:
        from .broker import _ib

        mod = _ib()
    except Exception as exc:  # noqa: BLE001
        result["error"] = "未安装 ib_async / ib_insync:%s" % exc
        result["hint"] = "在项目根目录执行 pip install -e \".[broker]\""
        return result

    ib = mod.IB()
    try:
        ib.connect(
            cfg.host, cfg.port, clientId=result["client_id"], readonly=True, timeout=timeout
        )
    except Exception as exc:  # noqa: BLE001
        detail = explain_connect_error(exc, cfg.port, True)
        result["error"] = detail["reason"]
        result["hint"] = detail["hint"]
        result["error_code"] = detail["code"]
        return result

    try:
        result["connected"] = True
        result["server_version"] = ib.client.serverVersion()
        try:
            result["server_time"] = str(ib.reqCurrentTime())
        except Exception:  # noqa: BLE001 - 版本差异,不影响判断连通性
            result["server_time"] = None
        accounts = list(ib.managedAccounts() or [])
        result["managed_accounts"] = [redact_account(a) for a in accounts]
        rows, unmapped = check_alias_mapping(settings, accounts)
        result["accounts"] = rows
        result["unmapped_accounts"] = unmapped
        if unmapped:
            result["hint"] = (
                "这个会话还能管到 %d 个没写进别名表的账号(%s)。"
                "没写进表的账号 LLM 永远指不到,这是设计使然;如果你想用它们,请在配置里补别名。"
                % (len(unmapped), "、".join(unmapped))
            )
        missing = [r["alias"] for r in rows if not r["resolved"] and r["connection"] == connection_name]
        if missing:
            result["error"] = (
                "别名 %s 配的账号不在这条连接可管的账号里,继续下单会落到错误账户。"
                % "、".join(missing)
            )
            result["hint"] = "请核对 config/settings.json 里这些别名的 account_id。"
    finally:
        try:
            ib.disconnect()
        except Exception:  # noqa: BLE001
            pass
    return result


def connection_guide(settings: Settings) -> List[Dict[str, Any]]:
    """给界面用的分步指引。刻意写死步骤文案,保证和 TWS 的菜单路径一致。"""
    ports = "、".join(str(c.port) for c in settings.connections_for("ibkr").values()) or "7497"
    return [
        {
            "step": 1,
            "title": "启动 TWS 或 IB Gateway 并登录",
            "detail": "在 IBKR 自己的窗口里输入账号密码。本软件不接触、也不保存你的 IBKR 凭证。"
                      "停在登录界面时 API 不会响应。",
        },
        {
            "step": 2,
            "title": "打开 API 开关",
            "detail": "TWS:Configure(齿轮)→ API → Settings,勾选「Enable ActiveX and Socket Clients」。"
                      "IB Gateway:Configure → Settings → API → Settings。",
        },
        {
            "step": 3,
            "title": "核对 Socket port",
            "detail": "同一页的「Socket port」要和本软件配置里的端口一致(当前配置:%s)。"
                      "IBKR 默认:TWS 实盘 7496 / 模拟 7497,Gateway 实盘 4001 / 模拟 4002。" % ports,
        },
        {
            "step": 4,
            "title": "只信任本机",
            "detail": "同一页「Trusted IPs」只留 127.0.0.1,不要勾「Allow connections from localhost only」"
                      "以外的放行(§9.2:API 端口绝不暴露到局域网)。",
        },
        {
            "step": 5,
            "title": "第一次连接时点「Yes」",
            "detail": "TWS 会弹出「Accept incoming connection attempt?」,点 Yes。"
                      "不点的话这里会一直显示握手超时。",
        },
        {
            "step": 6,
            "title": "回到这里点「检测连接」",
            "detail": "检测会真握手一次并读回账户列表,同时核对你的账户别名是否对得上真实账号。",
        },
    ]
