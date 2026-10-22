#!/usr/bin/env python3
"""intel 这一簇(analysis/econ_calendar、idea_retrieval、open_risk 等)验收补的几个变异体的检验。

每个变异是一处单行改动:写进去 → 重编那个测试 → 跑 → 记 caught / survived;finally 里还原、把文件时间往后拨几秒
(ninja 按秒比时间戳)、重编,保证留下的二进制是原样代码编的。

  python3 native/tools/mutate_intel.py
  BUILD=编译目录(默认 ~/Developer/ibkr/work/build-intel)

中途被杀时 finally 不会跑:改动前的原文先存进 tools/.mutate_intel.restore.json,下次启动先按它还原;正常跑完删掉它。
"""
import json
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
B = os.environ.get("BUILD", "/Users/dafrix/Developer/ibkr/work/build-intel")
ENV = dict(os.environ, QT_QPA_PLATFORM="offscreen")
RESTORE = os.path.join(ROOT, "tools", ".mutate_intel.restore.json")
A = os.path.join(ROOT, "engine", "analysis")

# (文件, 测试, 原文, 改成) —— 原文在文件里必须恰好出现一次
MUTANTS = [
    ("econ_calendar.cpp", "tst_econ_calendar", "g.stars = jm::max(g.stars, stars);", "g.stars = stars;"),
    ("idea_retrieval.cpp", "tst_idea_retrieval", "if (budget <= 0 || candidates.isEmpty()) return {};", "if (budget < 0 || candidates.isEmpty()) return {};"),
    ("open_risk.cpp", "tst_open_risk", "if (!(std::fabs(per[i] - want[i]) < 1e-9)) return false;", "if (!(std::fabs(per[i] - want[i]) < 1e-8)) return false;"),
    ("open_risk.cpp", "tst_open_risk", "if (!(std::fabs(per[i] - want[i]) < 1e-9)) return false;", "if (!(std::fabs(per[i] - want[i]) < 1e-11)) return false;"),
]


def build(target):
    r = subprocess.run(["cmake", "--build", B, "--target", target, "-j4"], capture_output=True, text=True)
    return r.returncode == 0


def run(target):
    try:
        r = subprocess.run([os.path.join(B, "tests", target)], capture_output=True, text=True, env=ENV, timeout=600)
    except subprocess.TimeoutExpired:
        return False
    return r.returncode == 0


def write(path, text):
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    t = time.time() + 2  # ninja 按秒比时间戳:往后拨,保证重编
    os.utime(path, (t, t))


def restore_leftover():
    if not os.path.exists(RESTORE):
        return
    for path, text in json.load(open(RESTORE, encoding="utf-8")).items():
        write(path, text)
    os.remove(RESTORE)


def main():
    restore_leftover()
    results = []
    for name, target, old, new in MUTANTS:
        path = os.path.join(A, name)
        orig = open(path, encoding="utf-8").read()
        if orig.count(old) != 1:
            results.append((name, old, new, "bad_spec(%d)" % orig.count(old)))
            continue
        json.dump({path: orig}, open(RESTORE, "w", encoding="utf-8"))
        try:
            write(path, orig.replace(old, new))
            res = "compile_error" if not build(target) else ("survived" if run(target) else "caught")
        finally:
            write(path, orig)
            os.remove(RESTORE)
            ok = build(target) and run(target)
        results.append((name, old, new, res if ok else res + " (restore build FAILED)"))
        print(f"{res:9} {name}: {old!r} -> {new!r}", flush=True)
    caught = sum(1 for r in results if r[3] == "caught")
    print(f"TOTAL {len(results)} caught {caught}")
    return 0 if caught == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
