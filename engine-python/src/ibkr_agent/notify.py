"""用户通知(设计文档 §5.6:所有 rejection / warning / 成交都要推给用户)。

通知内容属于 S1,只留在本机:走 macOS 通知中心,不经任何网络。账号一律脱敏。
"""
from __future__ import annotations

import platform
import shutil
import subprocess
from typing import Callable, List, Optional

Sink = Callable[[str, str, str], None]  # (title, subtitle, body)


class Notifier:
    def __init__(self, enabled: bool = True, extra_sinks: Optional[List[Sink]] = None):
        self.enabled = enabled
        self.sinks: List[Sink] = list(extra_sinks or [])
        self.history: List[tuple] = []

    def notify(self, title: str, body: str, subtitle: str = "") -> None:
        self.history.append((title, subtitle, body))
        for sink in self.sinks:
            sink(title, subtitle, body)
        if not self.enabled:
            return
        if platform.system() != "Darwin":
            print("[通知] %s | %s | %s" % (title, subtitle, body))
            return
        if shutil.which("terminal-notifier"):
            subprocess.run(
                ["terminal-notifier", "-title", title, "-subtitle", subtitle, "-message", body],
                capture_output=True,
            )
            return
        script = 'display notification %s with title %s subtitle %s' % (
            _quote(body),
            _quote(title),
            _quote(subtitle or " "),
        )
        subprocess.run(["osascript", "-e", script], capture_output=True)

    # 便捷封装,统一措辞,方便日后改成 UI 卡片
    def rejection(self, code: str, message: str) -> None:
        self.notify("指令被拒绝", message, subtitle=code)

    def warning(self, message: str) -> None:
        self.notify("下单提醒", message, subtitle="warning")

    def fill(self, symbol: str, action: str, qty: float, price: float, account: str) -> None:
        self.notify(
            "成交回报",
            "%s %s %g @ %.4f" % (action, symbol, qty, price),
            subtitle="账户 %s" % account,
        )

    def breaker(self, reason: str) -> None:
        self.notify("已熔断:自动执行暂停", reason, subtitle="circuit breaker")


def _quote(text: str) -> str:
    """AppleScript 字符串字面量转义,防止通知内容里的引号变成脚本注入。"""
    return '"%s"' % text.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")
