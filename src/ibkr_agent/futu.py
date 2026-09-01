"""富途 OpenD 连接检测与诊断(IBKR 走不通时的备用通道)。

这个模块和 `tws.py` 是一对孪生兄弟,职责、边界、输出结构都刻意保持一致——
界面用同一套卡片渲染两家券商,引擎用同一套流程连两家网关。

边界同样先说清楚:**本模块不接触任何富途账号密码**。富途的账号密码属于 §9.1
的 S0 级,只允许存在于 OpenD 自己的程序里;登录动作由用户在 OpenD 的窗口
(或它的配置文件)里完成。本模块只做三件事:

  1. 检测——OpenD 装没装、在不在跑、API 端口开没开;
  2. 诊断——握手成不成、OpenD 有没有登录成功、账户别名对不对得上;
  3. 拉起——把 OpenD 叫起来,让用户在它自己的窗口里登录。

有一件事和 IBKR 不同,必须单独讲:**实盘下单要一次"交易解锁"**。解锁密码
(的 md5)是 S0 级,只走 Keychain / DPAPI,配置文件里只记它存在哪个条目。
模拟盘不需要解锁——这也是"先跑纸面账户"那条上线路径在富途一侧的对应物。
"""
from __future__ import annotations

import contextlib
import glob
import os
import platform
import subprocess
import sys
from typing import Any, Dict, List, Optional, Sequence

from .config import Settings
from .store import redact_account
# 端口探测与进程检测两家完全一样,没有理由抄第二份:改了 tws 那边的超时策略,
# 富途这边必须跟着改,共用同一份实现是唯一能保证这一点的方式。
from .tws import PortProbe, _process_running, check_alias_mapping, probe_port

# OpenD 的两个默认端口。软件不猜用户改过的端口,配置里的会另外并进来。
# telnet 口只做展示:它是 OpenD 的控制台,不是 API 通道,连它没有意义。
KNOWN_ENDPOINTS: Sequence[Dict[str, Any]] = (
    {"port": 11111, "label": "OpenD API", "kind": "opend", "paper": None},
    {"port": 22222, "label": "OpenD 控制台(telnet,仅供参考)", "kind": "telnet", "paper": None},
)

# 富途和 moomoo 是同一套 OpenD 的两个发行版(国内 / 海外),装哪个都认。
if platform.system() == "Windows":
    # OpenD 是绿色解压包,没有固定安装路径,所以按几个常见落点扫。
    APP_CANDIDATES: Dict[str, Sequence[str]] = {
        "opend": (
            "C:/FutuOpenD*/FutuOpenD.exe",
            "C:/FutuOpenD*/*/FutuOpenD.exe",
            "C:/Program Files/FutuOpenD*/FutuOpenD.exe",
            "C:/Program Files (x86)/FutuOpenD*/FutuOpenD.exe",
            "D:/FutuOpenD*/FutuOpenD.exe",
            "~/FutuOpenD*/FutuOpenD.exe",
            "~/Desktop/FutuOpenD*/FutuOpenD.exe",
            "~/Downloads/FutuOpenD*/FutuOpenD.exe",
            "C:/moomooOpenD*/moomooOpenD.exe",
            "~/moomooOpenD*/moomooOpenD.exe",
            "~/Downloads/moomooOpenD*/moomooOpenD.exe",
            os.path.join(os.environ.get("LOCALAPPDATA", ""), "FutuOpenD", "FutuOpenD.exe"),
        ),
    }
    PROCESS_PATTERNS: Dict[str, str] = {"opend": "FutuOpenD.exe"}
    ALT_PROCESS_PATTERNS: Dict[str, str] = {"opend": "moomooOpenD.exe"}
else:
    APP_CANDIDATES = {
        "opend": (
            "/Applications/FutuOpenD.app",
            "/Applications/FutuOpenD*/FutuOpenD",
            "/Applications/moomooOpenD.app",
            "/Applications/moomooOpenD*/moomooOpenD",
            "~/FutuOpenD*/FutuOpenD",
            "~/Downloads/FutuOpenD*/FutuOpenD",
            "~/Downloads/moomooOpenD*/moomooOpenD",
        ),
    }
    PROCESS_PATTERNS = {"opend": "FutuOpenD"}
    ALT_PROCESS_PATTERNS = {"opend": "moomooOpenD"}

APP_NAME = "富途 OpenD"


# ----------------------------------------------------------------------
# stdout 保护
# ----------------------------------------------------------------------
@contextlib.contextmanager
def quiet_stdout():
    """调用富途 SDK 期间把 stdout 挪开。

    §10.1 的纪律是 **stdout 只跑协议**。futu-api 会往标准输出打连接日志,
    一行非协议输出就能让 Electron 侧的 JSON 解析全线崩掉。rpc.main() 已经
    在进程级把真 stdout 私有化了,这里再包一层是为了 CLI / 测试这些没走
    rpc 入口的场景——两层都廉价,漏一层的代价是界面直接变砖。
    """
    original = sys.stdout
    sys.stdout = sys.stderr
    try:
        yield
    finally:
        sys.stdout = original


def _futu():
    """延迟导入 futu-api。没装就报"怎么装",而不是甩 ImportError。"""
    try:
        with quiet_stdout():
            import futu as mod  # type: ignore
        return mod
    except ImportError as exc:  # pragma: no cover - 取决于用户环境
        raise FutuUnavailable(
            "未安装 futu-api(富途 OpenAPI 的 Python SDK)。"
            "在项目根目录执行 pip install -e \".[futu]\",或 pip install futu-api。"
            "原始报错:%s" % exc
        ) from exc


class FutuUnavailable(RuntimeError):
    """SDK 缺失。单独一个类型,是因为它的处理方式和"连不上"完全不同。"""


def sdk_installed() -> bool:
    """装没装 futu-api。

    用 find_spec 而不是真 import:futu-api 连着 pandas / protobuf,导入一次要
    好几百毫秒,而这个问题每次打开面板都要问一遍。
    """
    import importlib.util

    try:
        return importlib.util.find_spec("futu") is not None
    except (ImportError, ValueError):  # pragma: no cover - 环境损坏时 find_spec 也会抛
        return False


# ----------------------------------------------------------------------
# 端口与应用检测
# ----------------------------------------------------------------------
def scan_ports(settings: Settings, host: str = "127.0.0.1") -> List[Dict[str, Any]]:
    """扫 OpenD 默认端口 + 配置里的富途端口,标出每个端口对应哪条连接。"""
    configured = {c.port: name for name, c in settings.connections_for("futu").items()}
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


def detect_apps() -> List[Dict[str, Any]]:
    apps: List[Dict[str, Any]] = []
    for key, patterns in APP_CANDIDATES.items():
        found: List[str] = []
        for pattern in patterns:
            found.extend(sorted(glob.glob(os.path.expanduser(pattern))))
        running = _process_running(PROCESS_PATTERNS[key]) or _process_running(
            ALT_PROCESS_PATTERNS[key]
        )
        apps.append(
            {
                "key": key,
                "name": APP_NAME,
                "installed": bool(found),
                "paths": found[:5],
                "running": running,
            }
        )
    return apps


def launch_app(key: str) -> Dict[str, Any]:
    """拉起 OpenD。

    和 tws.launch_app 同一条约束:只接受固定键,路径在这一侧解析——绝不让
    界面传路径过来,否则等于给渲染进程开了个"执行任意程序"的通道。
    """
    if key not in APP_CANDIDATES:
        raise ValueError("只支持拉起 opend,收到:%r" % key)
    if platform.system() not in ("Darwin", "Windows"):
        raise RuntimeError("当前平台不支持一键拉起,请手动启动 %s。" % APP_NAME)

    for app in detect_apps():
        if app["key"] != key or not app["paths"]:
            continue
        target = app["paths"][0]
        if platform.system() == "Windows":
            # cwd 设为安装目录:OpenD 按相对路径读 FutuOpenD.xml,换目录起会读不到配置
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
        "没有找到 %s 的安装。请先从富途 OpenAPI 官网下载 OpenD 并解压。" % APP_NAME
    )


# ----------------------------------------------------------------------
# 错误翻译
# ----------------------------------------------------------------------
def explain_connect_error(exc: BaseException, port: int, port_open: bool) -> Dict[str, str]:
    """把连接异常翻成"下一步该做什么",而不是把 traceback 甩给用户。"""
    name = type(exc).__name__
    text = str(exc)
    lowered = text.lower()

    if isinstance(exc, FutuUnavailable):
        return {"reason": text, "hint": "装完 futu-api 后重启引擎再试。", "code": "sdk_missing"}
    if isinstance(exc, ConnectionRefusedError) or "refused" in lowered:
        return {
            "reason": "端口 %d 拒绝连接" % port,
            "hint": "OpenD 没在跑,或它的 API 端口不是 %d。先启动 OpenD 并完成登录,"
                    "再核对 FutuOpenD.xml 里的 api_port。" % port,
            "code": "refused",
        }
    if "timeout" in lowered or "timeout" in name.lower():
        if port_open:
            return {
                "reason": "端口开着,但握手超时",
                "hint": "OpenD 在跑但没应答。多半是它还没登录成功(界面上会显示"
                        "「未登录」),或者开了协议加密而这里没配密钥。",
                "code": "handshake_timeout",
            }
        return {
            "reason": "连接超时",
            "hint": "确认 OpenD 已启动**并完成登录**。停在登录界面时 API 不会响应。",
            "code": "timeout",
        }
    if "rsa" in lowered or "encrypt" in lowered:
        return {
            "reason": text or name,
            "hint": "OpenD 开启了协议加密(RSA),但这里没有配私钥。"
                    "要么在 OpenD 里关掉加密,要么本软件暂不支持加密连接。",
            "code": "encrypted",
        }
    return {"reason": "%s: %s" % (name, text), "hint": "详见引擎日志。", "code": "unknown"}


def _ret_ok(mod, ret) -> bool:
    return ret == mod.RET_OK


# ----------------------------------------------------------------------
# 握手诊断
# ----------------------------------------------------------------------
def diagnose(
    settings: Settings, connection_name: str, timeout: float = 8.0
) -> Dict[str, Any]:
    """真握手一次:连行情、读 OpenD 全局状态与交易账户列表,然后立刻断开。

    结构与 tws.diagnose 的返回值对齐,界面才能用同一套卡片渲染两家券商。
    多出来的三项是富途独有的:
      * `qot_logined` / `trd_logined` —— OpenD 有没有登录成功。端口开着但没登录
        是这条链路上最常见的失败,而它看起来和"连上了"一模一样;
      * `unlock_required` —— 这条连接上有没有实盘账户需要交易解锁。
    """
    cfg = settings.connections_for("futu").get(connection_name)
    if cfg is None:
        raise ValueError("未定义的连接:%s(这里只在富途连接里查找)" % connection_name)

    probe = probe_port(cfg.host, cfg.port)
    result: Dict[str, Any] = {
        "connection": connection_name,
        "broker": "futu",
        "host": cfg.host,
        "port": cfg.port,
        "port_open": probe["open"],
        "port_latency_ms": probe["latency_ms"],
        "connected": False,
        "server_version": None,
        "server_time": None,
        "qot_logined": None,
        "trd_logined": None,
        "managed_accounts": [],
        "accounts": [],
        "unmapped_accounts": [],
        "unlock_required": False,
        "readonly": cfg.readonly,
        "error": None,
        "hint": None,
    }

    if not probe["open"]:
        detail = explain_connect_error(ConnectionRefusedError(probe["error"] or ""), cfg.port, False)
        result["error"] = detail["reason"]
        result["hint"] = detail["hint"]
        result["error_code"] = detail["code"]
        return result

    try:
        mod = _futu()
    except FutuUnavailable as exc:
        detail = explain_connect_error(exc, cfg.port, True)
        result["error"] = detail["reason"]
        result["hint"] = detail["hint"]
        result["error_code"] = detail["code"]
        return result

    quote = None
    try:
        with quiet_stdout():
            quote = mod.OpenQuoteContext(host=cfg.host, port=cfg.port)
            ret, state = quote.get_global_state()
    except Exception as exc:  # noqa: BLE001
        detail = explain_connect_error(exc, cfg.port, True)
        result["error"] = detail["reason"]
        result["hint"] = detail["hint"]
        result["error_code"] = detail["code"]
        _close(quote)
        return result

    if not _ret_ok(mod, ret):
        result["error"] = "读取 OpenD 状态失败:%s" % str(state)[:200]
        result["hint"] = "OpenD 在跑但没能应答。看一眼 OpenD 窗口里的状态行。"
        _close(quote)
        return result

    result["connected"] = True
    state = state if isinstance(state, dict) else {}
    result["server_version"] = state.get("server_ver")
    result["server_time"] = _readable_time(
        state.get("timestamp") or state.get("local_timestamp")
    )
    result["qot_logined"] = _as_bool(state.get("qot_logined"))
    result["trd_logined"] = _as_bool(state.get("trd_logined"))
    result["market_us"] = state.get("market_us")
    _close(quote)

    if result["qot_logined"] is False:
        result["error"] = "OpenD 已启动,但**行情服务未登录**"
        result["hint"] = "在 OpenD 窗口里用你的富途账号登录(或在 FutuOpenD.xml 里配好登录信息后重启它)。"
        return result

    _probe_accounts(settings, cfg, result, mod, timeout)
    return result


def _probe_accounts(settings: Settings, cfg, result: Dict[str, Any], mod, timeout: float) -> None:
    """读交易账户列表并核对别名表。

    这一步和 IBKR 那边的动机完全一样:配置里 `富途模拟 → 1234567` 如果账号写错,
    下单时不会报错,只会静默落到错误账户。所以必须在连接阶段就摆到用户面前。
    """
    futu_cfg = settings.broker.futu
    trd = None
    try:
        with quiet_stdout():
            trd = mod.OpenSecTradeContext(
                filter_trdmarket=getattr(mod.TrdMarket, futu_cfg.trd_market),
                host=cfg.host,
                port=cfg.port,
                security_firm=getattr(mod.SecurityFirm, futu_cfg.security_firm),
            )
            ret, data = trd.get_acc_list()
    except Exception as exc:  # noqa: BLE001 - 交易侧失败不该抹掉行情侧已确认的结果
        result["hint"] = "行情通道正常,交易通道打不开:%s" % str(exc)[:200]
        _close(trd)
        return

    if not _ret_ok(mod, ret):
        result["hint"] = (
            "行情通道正常,但读不到交易账户:%s。"
            "多半是 OpenD 的交易服务没登录(需要在 OpenD 里额外做一次交易登录)。"
            % str(data)[:200]
        )
        _close(trd)
        return

    accounts, envs = _acc_rows(data)
    result["managed_accounts"] = [redact_account(a) for a in accounts]
    rows, unmapped = check_alias_mapping(settings, accounts)
    # 把富途报的真实交易环境贴到每一行上,并当场核对 is_paper。
    # 写反了不会报错,只会让实盘闸门失效——必须在连接阶段就摆出来。
    env_mismatch: List[str] = []
    for row, account in zip(rows, settings.accounts):
        actual = envs.get(account.account_id, "")
        row["trd_env"] = actual or None
        wanted = "SIMULATE" if account.is_paper else "REAL"
        row["env_matches"] = None if not actual else actual == wanted
        if actual and actual != wanted and account.connection == result["connection"]:
            env_mismatch.append(
                "%s(配置写「%s」,富途报「%s」)"
                % (account.alias,
                   "模拟盘" if account.is_paper else "实盘",
                   "模拟盘" if actual == "SIMULATE" else "实盘")
            )
    result["accounts"] = rows
    result["unmapped_accounts"] = unmapped
    result["unlock_required"] = any(
        not a.is_paper for a in settings.accounts if a.connection == result["connection"]
    )

    if unmapped:
        result["hint"] = (
            "这个会话还能管到 %d 个没写进别名表的账号(%s)。"
            "没写进表的账号 LLM 永远指不到,这是设计使然;如果你想用它们,请在配置里补别名。"
            % (len(unmapped), "、".join(unmapped))
        )
    if env_mismatch:
        result["error"] = (
            "这些账户的 is_paper 和富途报的交易环境对不上:%s。"
            "is_paper 决定要不要过实盘闸门,写反了等于把保护关掉——下单会被拒绝。"
            % "、".join(env_mismatch)
        )
        result["hint"] = "请改 config/settings.json 里这些账户的 is_paper。"
        _close(trd)
        return

    missing = [
        r["alias"] for r in rows
        if not r["resolved"] and r["connection"] == result["connection"]
    ]
    if missing:
        result["error"] = (
            "别名 %s 配的账号不在这条连接可管的账号里,继续下单会落到错误账户。"
            % "、".join(missing)
        )
        result["hint"] = "请核对 config/settings.json 里这些别名的 account_id(富途账号是一串数字)。"
    elif result["unlock_required"]:
        result["hint"] = (
            (result["hint"] + " ") if result["hint"] else ""
        ) + "这条连接上有实盘账户:实盘下单前必须先做一次交易解锁(下面的「交易解锁」)。"
    _close(trd)


def _acc_rows(data) -> "tuple[List[str], Dict[str, str]]":
    """从 futu 返回的 DataFrame 里取账号列表与各自的交易环境。

    刻意不 import pandas:SDK 换了返回类型(早期版本回 list[dict])也不会炸,
    拿不到就当成空——诊断本身不该因为取值方式而失败。
    """
    try:
        rows = data.to_dict("records") if hasattr(data, "to_dict") else list(data)
    except Exception:  # noqa: BLE001
        return [], {}
    accounts: List[str] = []
    envs: Dict[str, str] = {}
    for row in rows:
        try:
            acc = str(row.get("acc_id", "")).strip()
        except AttributeError:
            continue
        if not acc or acc.lower() == "nan":
            continue
        accounts.append(acc)
        envs[acc] = str(row.get("trd_env", "") or "").strip().upper()
    return accounts, envs


def _readable_time(value) -> Optional[str]:
    """OpenD 回的是 unix 时间戳字符串。原样显示出来是一串数字,没人看得懂。"""
    if value in (None, ""):
        return None
    try:
        from datetime import datetime

        return datetime.fromtimestamp(float(value)).strftime("%Y-%m-%d %H:%M:%S")
    except (TypeError, ValueError, OSError, OverflowError):
        return str(value)


def _as_bool(value) -> Optional[bool]:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in ("1", "true", "yes"):
        return True
    if text in ("0", "false", "no", ""):
        return False
    return None


def _close(ctx) -> None:
    if ctx is None:
        return
    try:
        with quiet_stdout():
            ctx.close()
    except Exception:  # noqa: BLE001 - 关不掉也不该盖住真正的结论
        pass


# ----------------------------------------------------------------------
# 指引
# ----------------------------------------------------------------------
def connection_guide(settings: Settings) -> List[Dict[str, Any]]:
    """给界面用的分步指引。刻意写死步骤文案,保证和 OpenD 的实际操作一致。"""
    ports = "、".join(str(c.port) for c in settings.connections_for("futu").values()) or "11111"
    return [
        {
            "step": 1,
            "title": "下载并解压 OpenD",
            "detail": "去富途 OpenAPI 官网下载 FutuOpenD(海外版叫 moomooOpenD)。"
                      "它是绿色包,解压到哪都行,但别放在中文或带空格的深层目录里。",
        },
        {
            "step": 2,
            "title": "启动 OpenD 并登录",
            "detail": "在 OpenD 自己的窗口里输入富途账号密码(或在 FutuOpenD.xml 里配好)。"
                      "本软件不接触、也不保存你的富途凭证。没登录成功时 API 不会响应。",
        },
        {
            "step": 3,
            "title": "核对 API 端口",
            "detail": "OpenD 的 api_port 要和本软件配置里的端口一致(当前配置:%s)。"
                      "OpenD 默认 11111;改过就同步改这边。" % ports,
        },
        {
            "step": 4,
            "title": "只信任本机",
            "detail": "OpenD 的 ip 只填 127.0.0.1,不要绑到 0.0.0.0"
                      "(§9.2:API 端口绝不暴露到局域网)。",
        },
        {
            "step": 5,
            "title": "确认行情权限",
            "detail": "富途的美股行情要单独开通:LV1 够用报价与 K 线,多档盘口要 LV2,"
                      "**期权链还要单独的美股期权行情权限**。没权限时报价为空,"
                      "AUTO_MID 定价会直接拒单——这是刻意的,不会拿坏报价去下真单。",
        },
        {
            "step": 6,
            "title": "知道它做不了什么",
            "detail": "富途 OpenAPI **不支持美股指数**(SPX / NDX / VIX / RUT):快照、订阅、"
                      "K 线三条路都会回「暂不支持美股指数」。涉及指数的行情、K 线、条件单会被"
                      "明确拒绝,不会静默换成 ETF——点数和乘数都不一样。另外它没有原生条件单,"
                      "所有条件单由本软件盯盘,软件关掉就不会触发。",
        },
        {
            "step": 7,
            "title": "实盘还要交易解锁",
            "detail": "模拟盘不需要。实盘下单前要用交易密码解锁一次,密码只存 Keychain / DPAPI,"
                      "不写配置文件、不进日志。",
        },
        {
            "step": 8,
            "title": "回到这里点「检测连接」",
            "detail": "检测会真握手一次并读回账户列表,同时核对账户别名与 is_paper 是否"
                      "对得上真实账号——is_paper 写反等于把实盘闸门关掉,必须在这一步暴露。",
        },
    ]
