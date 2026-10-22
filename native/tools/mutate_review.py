#!/usr/bin/env python3
"""review 这一簇(analysis/tradereview 等)的变异检验:补测"合约与腿都没有 multiplier 时按默认 100"那一处。

每个变异是一处单行改动:写进去 → 重编 tst_tradereview → 跑 → 记 caught / survived;finally 里还原、把文件时间往后拨几秒
(ninja 按秒比时间戳)、重编。最后再跑一遍,保证留下的二进制是原样代码编的、而且是绿的。

  python3 native/tools/mutate_review.py
  BUILD=编译目录(默认 ~/Developer/ibkr/work/build-review)

中途被杀时 finally 不会跑:原文先存进 tools/.mutate_review.restore.json,下次启动先按它还原;正常跑完删掉它。
"""
import json
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
B = os.environ.get("BUILD", "/Users/dafrix/Developer/ibkr/work/build-review")
ENV = dict(os.environ, QT_QPA_PLATFORM="offscreen")
TARGET = "tst_tradereview"
FILE = os.path.join(ROOT, "engine", "analysis", "tradereview.cpp")
RESTORE = os.path.join(ROOT, "tools", ".mutate_review.restore.json")

MUTS = [
    # 默认 100 换成 10:合约与腿都没有 multiplier 的 BAG 才看得出来(TS tradereview.ts:72,进 pnlAt 与平仓盈亏)
    (": m2 && *m2 != 0 ? *m2 : 100.0;", ": m2 && *m2 != 0 ? *m2 : 10.0;"),
    # 默认 100 整个退到腿上的值:腿也没有时是 NaN 之外的 0
    (": m2 && *m2 != 0 ? *m2 : 100.0;", ": m2 ? *m2 : 100.0;"),
]


def build():
    return subprocess.run(["cmake", "--build", B, "--target", TARGET, "-j4"], capture_output=True, text=True).returncode == 0


def test():
    try:
        return subprocess.run([os.path.join(B, "tests", TARGET)], capture_output=True, text=True, env=ENV, timeout=600).returncode == 0
    except subprocess.TimeoutExpired:
        return False


def write(text):
    with open(FILE, "w", encoding="utf-8") as f:
        f.write(text)
    later = time.time() + 2
    os.utime(FILE, (later, later))


def main():
    if os.path.exists(RESTORE):
        with open(RESTORE, encoding="utf-8") as f:
            write(json.load(f)["text"])
        os.remove(RESTORE)
    with open(FILE, encoding="utf-8") as f:
        orig = f.read()
    for old, _ in MUTS:
        if orig.count(old) != 1:
            sys.exit(f"不唯一或没有({orig.count(old)}):{old!r}")
    with open(RESTORE, "w", encoding="utf-8") as f:
        json.dump({"text": orig}, f)
    caught = survived = broken = 0
    try:
        for i, (old, new) in enumerate(MUTS):
            try:
                write(orig.replace(old, new))
                if not build():
                    broken += 1
                    print(f"[{i}] 编不过 {new!r}", flush=True)
                elif test():
                    survived += 1
                    print(f"[{i}] 活下来 {old!r} -> {new!r}", flush=True)
                else:
                    caught += 1
                    print(f"[{i}] 咬住 {new!r}", flush=True)
            finally:
                write(orig)
                build()
    finally:
        write(orig)
        os.remove(RESTORE)
    ok = build() and test()
    print(f"{len(MUTS)} 个变异:咬住 {caught},活下来 {survived},编不过 {broken};还原后重编并跑绿:{ok}")
    sys.exit(0 if survived == 0 and broken == 0 and ok else 1)


if __name__ == "__main__":
    main()
