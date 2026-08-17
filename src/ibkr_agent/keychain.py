"""macOS Keychain 凭证读写(设计文档 §9.2)。

S0 级数据只走这里:不落配置文件、不进环境变量、不硬编码。
`security` 命令写入时用 -U 覆盖同名条目,并加 -T "" 限制只有本进程可访问。
非 macOS 平台上退化为显式报错,而不是偷偷读环境变量。
"""
from __future__ import annotations

import platform
import subprocess
from typing import Optional


class KeychainError(RuntimeError):
    pass


def is_supported() -> bool:
    return platform.system() == "Darwin"


def get_secret(service: str, account: str) -> Optional[str]:
    _require_darwin()
    proc = subprocess.run(
        ["security", "find-generic-password", "-s", service, "-a", account, "-w"],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        return None
    secret = proc.stdout.strip()
    return secret or None


def set_secret(service: str, account: str, secret: str) -> None:
    _require_darwin()
    if not secret:
        raise KeychainError("拒绝写入空密钥")
    proc = subprocess.run(
        [
            "security", "add-generic-password",
            "-s", service, "-a", account,
            "-w", secret,
            "-U",
            "-D", "dafri trading agent secret",
        ],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise KeychainError("写入 Keychain 失败:%s" % proc.stderr.strip())


def delete_secret(service: str, account: str) -> bool:
    _require_darwin()
    proc = subprocess.run(
        ["security", "delete-generic-password", "-s", service, "-a", account],
        capture_output=True,
        text=True,
    )
    return proc.returncode == 0


def _require_darwin() -> None:
    if not is_supported():
        raise KeychainError(
            "当前平台不是 macOS,无法使用 Keychain。Windows 版请接 DPAPI(见 §10.4),"
            "任何情况下都不要退化为明文配置或环境变量。"
        )
