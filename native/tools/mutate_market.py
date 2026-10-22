#!/usr/bin/env python3
"""market 这一簇(ma_touch / alerts / anomaly …)的变异检验:验收点名的边界变异要被测试咬住。

每个变异是一处单行改动:写进去 → 重编那个测试 → 跑 → 记 caught / survived;finally 里还原、把文件时间往后拨几秒
(ninja 按秒比时间戳)、重编,保证留下的二进制是原样代码编的。

  python3 native/tools/mutate_market.py
  ONLY='子串|子串' python3 native/tools/mutate_market.py   # 只跑 old 里含这些子串的
  BUILD=编译目录(默认 ~/Developer/ibkr/work/build-market)

中途被杀时 finally 不会跑:改动前的原文先存进 tools/.mutate_market.restore.json,下次启动先按它还原;正常跑完删掉它。
"""
import json
import os
import subprocess
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
B = os.environ.get("BUILD", "/Users/dafrix/Developer/ibkr/work/build-market")
ENV = dict(os.environ, QT_QPA_PLATFORM="offscreen")
A = os.path.join(ROOT, "engine", "analysis") + "/"
RESTORE = os.path.join(ROOT, "tools", ".mutate_market.restore.json")

# (文件, 测试, 原文, 改成) —— 原文在文件里必须恰好出现一次
M = [
    # 待确认的穿越:下一次取价正好隔 cooldown 秒还算连着
    ("alerts.cpp", "tst_alerts", "if (!(since >= 0 && since <= cooldown)) {", "if (!(since >= 0 && since < cooldown)) {"),
    # 上一轮的价正好压在均线上:乘积是 0,算跨过
    ("ma_touch.cpp", "tst_ma_touch", "crossed = (*prevPrice - maPrev) * (price - ma) <= 0;", "crossed = (*prevPrice - maPrev) * (price - ma) < 0;"),
    # 当日量比窗口起点还少(流重订):样本差不用,退回流里的近 W 分钟量
    ("anomaly.cpp", "tst_anomaly", "if (base && *volume - *base >= 0) {", "if (base) {"),
    ("anomaly.cpp", "tst_anomaly", "if (base && *volume - *base >= 0) {", "if (base && *volume - *base > 0) {"),
]


def build(target):
    return subprocess.run(["cmake", "--build", B, "--target", target, "-j4"], capture_output=True, text=True).returncode == 0


def touch(path):
    t = time.time() + 3
    os.utime(path, (t, t))


def restore_leftover():
    if not os.path.exists(RESTORE):
        return
    for path, text in json.load(open(RESTORE)).items():
        open(path, "w").write(text)
        touch(path)
    os.remove(RESTORE)


def main():
    restore_leftover()
    only = [s for s in os.environ.get("ONLY", "").split("|") if s]
    todo = [m for m in M if not only or any(s in m[2] for s in only)]
    originals = {A + f: open(A + f).read() for f in {m[0] for m in todo}}
    json.dump(originals, open(RESTORE, "w"))
    results = []
    try:
        for f, test, old, new in todo:
            path = A + f
            orig = originals[path]
            if orig.count(old) != 1:
                results.append(("BADSPEC", f, old))
                continue
            open(path, "w").write(orig.replace(old, new))
            touch(path)
            if not build(test):
                results.append(("NOBUILD", f, old))
            else:
                r = subprocess.run([os.path.join(B, "tests", test)], capture_output=True, text=True, env=ENV, timeout=1800)
                results.append(("caught" if r.returncode != 0 else "SURVIVED", f, old + "  =>  " + new))
            open(path, "w").write(orig)
            touch(path)
    finally:
        for path, text in originals.items():
            open(path, "w").write(text)
            touch(path)
        ok = all(build(t) for t in sorted({m[1] for m in todo}))
        os.remove(RESTORE)
        print("restored, rebuild", "ok" if ok else "FAILED")
    for r in results:
        print(*r)
    print("caught", sum(r[0] == "caught" for r in results), "of", len(results))


if __name__ == "__main__":
    main()
