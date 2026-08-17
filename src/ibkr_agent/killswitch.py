"""全局熔断开关(设计文档 §9.7)。

用文件做状态,理由很实际:Electron 主进程、CLI、Python 引擎三方都要能看到
同一个开关,而且软件崩溃重启后熔断状态必须还在——放内存里做不到这两点。
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional


@dataclass
class BreakerState:
    engaged: bool
    reason: str = ""
    at: str = ""
    consecutive_failures: int = 0


class KillSwitch:
    def __init__(self, path: Path, threshold: int = 3):
        self.path = Path(path).expanduser()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.threshold = max(1, threshold)

    # ---- 状态 -----------------------------------------------------------
    def state(self) -> BreakerState:
        if not self.path.exists():
            return BreakerState(engaged=False)
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            # 状态文件坏了 → 按已熔断处理,宁可停,不可乱下单
            return BreakerState(engaged=True, reason="熔断状态文件损坏,已按安全侧处理")
        return BreakerState(
            engaged=bool(raw.get("engaged")),
            reason=raw.get("reason", ""),
            at=raw.get("at", ""),
            consecutive_failures=int(raw.get("consecutive_failures", 0)),
        )

    def is_engaged(self) -> bool:
        return self.state().engaged

    def engage(self, reason: str) -> BreakerState:
        state = self.state()
        new = BreakerState(
            engaged=True,
            reason=reason,
            at=datetime.now().astimezone().isoformat(timespec="seconds"),
            consecutive_failures=state.consecutive_failures,
        )
        self._write(new)
        return new

    def release(self, actor: str = "user") -> BreakerState:
        new = BreakerState(
            engaged=False,
            reason="由 %s 手动解除" % actor,
            at=datetime.now().astimezone().isoformat(timespec="seconds"),
            consecutive_failures=0,
        )
        self._write(new)
        return new

    # ---- 连续失败自动熔断 -------------------------------------------------
    def record_success(self) -> None:
        state = self.state()
        if state.consecutive_failures:
            state.consecutive_failures = 0
            self._write(state)

    def record_failure(self, reason: str) -> Optional[BreakerState]:
        state = self.state()
        state.consecutive_failures += 1
        if state.consecutive_failures >= self.threshold and not state.engaged:
            return self.engage(
                "连续 %d 次失败后自动熔断(最近一次:%s)" % (state.consecutive_failures, reason)
            )
        self._write(state)
        return None

    def _write(self, state: BreakerState) -> None:
        self.path.write_text(
            json.dumps(
                {
                    "engaged": state.engaged,
                    "reason": state.reason,
                    "at": state.at,
                    "consecutive_failures": state.consecutive_failures,
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
