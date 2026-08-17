"""提示词装配与版本管理(设计文档 §2 / §3 / §11)。

提示词是配置不是代码:模板文件放 prompts/ 带版本号,渲染后算 sha256 落库,
出问题能定位到具体哪一版。渲染完还要过两道自检:
  1. 不允许残留未替换的 {{VAR}}(模板漏洞会静默削弱铁律);
  2. 不允许出现任何真实账号(§9.1 的硬架构约束)。
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional

from .config import Settings, to_bj

_PLACEHOLDER_RE = re.compile(r"\{\{[A-Z_]+\}\}")


class PromptError(RuntimeError):
    pass


@dataclass(frozen=True)
class FewShotPair:
    name: str
    user: str
    assistant: Dict[str, Any]


@dataclass(frozen=True)
class PromptBundle:
    version: str
    system_text: str
    user_template: str
    fewshot: List[FewShotPair]

    @property
    def fingerprint(self) -> str:
        payload = self.system_text + "\n--\n" + json.dumps(
            [p.assistant for p in self.fewshot], ensure_ascii=False, sort_keys=True
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def load_prompt_bundle(settings: Settings) -> PromptBundle:
    version = settings.prompt_version
    directory = Path(settings.prompt_dir)
    system_raw = _read(directory / ("system_%s.md" % version))
    user_raw = _read(directory / ("user_message_%s.md" % version))

    fewshot_path = directory / ("fewshot_%s.json" % version)
    fewshot: List[FewShotPair] = []
    if fewshot_path.exists():
        data = json.loads(fewshot_path.read_text(encoding="utf-8"))
        for pair in data.get("pairs", []):
            fewshot.append(
                FewShotPair(name=pair.get("name", ""), user=pair["user"], assistant=pair["assistant"])
            )

    system_text = render_system(system_raw, settings)
    return PromptBundle(
        version=version, system_text=system_text, user_template=user_raw, fewshot=fewshot
    )


def render_system(template: str, settings: Settings) -> str:
    limits = settings.limits
    text = _substitute(
        template,
        {
            "MAX_ORDER_NOTIONAL": _num(limits.max_order_notional),
            "MAX_OPTION_CONTRACTS": str(limits.max_option_contracts),
            "MAX_MKT_SHARES": str(limits.max_mkt_shares),
            "SYMBOL_ALIAS_TABLE": settings.prompt_symbol_table(),
            "ACCOUNT_ALIAS_TABLE": settings.prompt_account_table(),
        },
    )
    _assert_complete(text, "system")
    _assert_no_account_ids(text, settings)
    return text


def render_user(
    bundle: PromptBundle,
    settings: Settings,
    instruction: str,
    now_et: datetime,
    market_status: Optional[str] = None,
    snapshot: Optional[Mapping[str, float]] = None,
) -> str:
    status = market_status or settings.market_status(now_et)
    text = _substitute(
        bundle.user_template,
        {
            "NOW_ET": now_et.strftime("%Y-%m-%d %H:%M"),
            "NOW_BJ": to_bj(now_et).strftime("%Y-%m-%d %H:%M"),
            "MARKET_STATUS": status,
            "MAX_ORDER_NOTIONAL": _num(settings.limits.max_order_notional),
            "MAX_OPTION_CONTRACTS": str(settings.limits.max_option_contracts),
            "MARKET_SNAPSHOT_LINE": _snapshot_line(snapshot),
            "USER_INSTRUCTION": instruction.strip(),
        },
    )
    _assert_complete(text, "user")
    _assert_no_account_ids(text, settings)
    return text


def _snapshot_line(snapshot: Optional[Mapping[str, float]]) -> str:
    """行情快照行。没有快照时整行省略(§3),而不是留一个空标题误导模型。"""
    if not snapshot:
        return ""
    parts = ["%s 现价 %s" % (sym.upper(), _num(price)) for sym, price in snapshot.items()]
    return "\n相关行情快照:" + ";".join(parts) + "\n"


def _substitute(template: str, values: Dict[str, str]) -> str:
    out = template
    for key, value in values.items():
        out = out.replace("{{%s}}" % key, value)
    return out


def _assert_complete(text: str, which: str) -> None:
    leftovers = sorted(set(_PLACEHOLDER_RE.findall(text)))
    if leftovers:
        raise PromptError("%s 提示词存在未替换的模板变量:%s" % (which, ", ".join(leftovers)))


def _assert_no_account_ids(text: str, settings: Settings) -> None:
    """§9.1:真实账号永远不进提示词。这里做最后一道纯代码检查。"""
    for acct in settings.accounts:
        if acct.account_id and acct.account_id in text:
            raise PromptError(
                "提示词中出现了真实账号(别名 %s),违反 S0 数据流向约束,已中止调用。" % acct.alias
            )


def _num(value: float) -> str:
    if float(value).is_integer():
        return str(int(value))
    return ("%f" % value).rstrip("0").rstrip(".")


def _read(path: Path) -> str:
    if not path.exists():
        raise PromptError("提示词文件不存在:%s" % path)
    return path.read_text(encoding="utf-8")
