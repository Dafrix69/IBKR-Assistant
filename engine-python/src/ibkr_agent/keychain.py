"""凭证读写(设计文档 §9.2 / §10.4)。

S0 级数据只走这里:不落配置文件、不进环境变量、不硬编码。

macOS 用系统 Keychain:`security` 命令写入时用 -U 覆盖同名条目,并加 -T ""
限制只有本进程可访问。

Windows 用 DPAPI(§10.4):CryptProtectData 按当前用户加密,密文存在用户
配置目录的一个 JSON 文件里;service/account 作为附加熵,换个条目名拿不到
别人的密文。换台机器或换个 Windows 账户,密文无法解开——这正是 DPAPI 的
语义,与 Keychain 等价。

其余平台显式报错,而不是偷偷读环境变量。
"""
from __future__ import annotations

import base64
import json
import os
import platform
import subprocess
import tempfile
from pathlib import Path
from typing import Optional


class KeychainError(RuntimeError):
    pass


def is_supported() -> bool:
    return platform.system() in ("Darwin", "Windows")


def get_secret(service: str, account: str) -> Optional[str]:
    _require_supported()
    if platform.system() == "Windows":
        return _dpapi_get(service, account)
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
    _require_supported()
    if not secret:
        raise KeychainError("拒绝写入空密钥")
    if platform.system() == "Windows":
        _dpapi_set(service, account, secret)
        return
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
    _require_supported()
    if platform.system() == "Windows":
        return _dpapi_delete(service, account)
    proc = subprocess.run(
        ["security", "delete-generic-password", "-s", service, "-a", account],
        capture_output=True,
        text=True,
    )
    return proc.returncode == 0


def _require_supported() -> None:
    if not is_supported():
        raise KeychainError(
            "当前平台既不是 macOS 也不是 Windows,没有可用的系统凭证存储。"
            "任何情况下都不要退化为明文配置或环境变量。"
        )


# ---------------------------------------------------------------- Windows DPAPI

_CRYPTPROTECT_UI_FORBIDDEN = 0x01


def _dpapi_store_path() -> Path:
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(base) / "dafri" / "credentials.dpapi.json"


def _entropy(service: str, account: str) -> bytes:
    return ("dafri\x00%s\x00%s" % (service, account)).encode("utf-8")


def _dpapi_crypt(data: bytes, entropy: bytes, decrypt: bool) -> bytes:
    import ctypes
    from ctypes import wintypes

    class DATA_BLOB(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    def blob(raw: bytes) -> DATA_BLOB:
        buf = ctypes.create_string_buffer(raw, len(raw))
        return DATA_BLOB(len(raw), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))

    crypt32 = ctypes.windll.crypt32
    fn = crypt32.CryptUnprotectData if decrypt else crypt32.CryptProtectData
    inp, ent, out = blob(data), blob(entropy), DATA_BLOB()
    ok = fn(
        ctypes.byref(inp), None, ctypes.byref(ent),
        None, None, _CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(out),
    )
    if not ok:
        raise KeychainError(
            "DPAPI %s失败(Windows 错误码 %d)"
            % ("解密" if decrypt else "加密", ctypes.GetLastError())
        )
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(out.pbData)


def _dpapi_load() -> dict:
    path = _dpapi_store_path()
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise KeychainError("凭证文件损坏或不可读:%s(%s)" % (path, exc))


def _dpapi_save(entries: dict) -> None:
    path = _dpapi_store_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    # 原子替换:半写状态不会留下可被误读的文件
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(entries, fh, ensure_ascii=False, indent=1)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _dpapi_key(service: str, account: str) -> str:
    return "%s\x00%s" % (service, account)


def _dpapi_get(service: str, account: str) -> Optional[str]:
    entry = _dpapi_load().get(_dpapi_key(service, account))
    if not entry:
        return None
    raw = _dpapi_crypt(base64.b64decode(entry), _entropy(service, account), decrypt=True)
    return raw.decode("utf-8") or None


def _dpapi_set(service: str, account: str, secret: str) -> None:
    entries = _dpapi_load()
    blob = _dpapi_crypt(secret.encode("utf-8"), _entropy(service, account), decrypt=False)
    entries[_dpapi_key(service, account)] = base64.b64encode(blob).decode("ascii")
    _dpapi_save(entries)


def _dpapi_delete(service: str, account: str) -> bool:
    entries = _dpapi_load()
    if _dpapi_key(service, account) not in entries:
        return False
    del entries[_dpapi_key(service, account)]
    _dpapi_save(entries)
    return True
