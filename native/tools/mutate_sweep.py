#!/usr/bin/env python3
"""sweep 这一簇(analysis/fly_exit_sweep*、util/discord_gateway*)的变异检验。

只在私有副本里跑(qt-port-brief 第 3 条):
  rsync -a --delete --exclude .vscode native/ /Users/dafrix/Developer/ibkr/work/mut-sweep/<w>/native/
  (旁边放 desktop、engine-ts、docs、prompts 的符号链接;在 <w>/build 里 configure:
   cmake -S native -B build -G Ninja -DCMAKE_BUILD_TYPE=Debug -DIBKR_BUILD_UI=OFF -DCMAKE_CXX_COMPILER=… -DCMAKE_PREFIX_PATH=/opt/homebrew)
再跑副本里的这份脚本。脚本改的是它自己所在的那份 native/;在项目里(路径里没有 /work/mut-)直接跑会当场拒。

变异不是手挑的,是按行机械生成的(--list 只数不跑):关系运算符(< <= > >= == !=)、逻辑(&& ||)、算术(+ - * /、+= -=)、去掉一个 `!`、
true ↔ false、数字字面量(≥ 2 的整数 +1、小数 ×1.5)、删掉 continue / break / bump(…) / `+= 1;`。字符串字面量与注释里的不动。
每个变异:写进去 → 重编对应的测试 → 跑 → 记 caught / SURVIVED / NOBUILD / TIMEOUT(算 caught);finally 里还原、把文件时间往后拨几秒
(ninja 按秒比时间戳)、重编。被杀在半路时,下次启动先按 tools/.mutate_sweep.restore.json 把原文写回去。

  python3 native/tools/mutate_sweep.py --list
  FILES=fly_exit_sweep.cpp SHARD=0/2 OUT=…/out.json python3 native/tools/mutate_sweep.py      # 只跑这几个文件的第 0 片(共 2 片)
  RERUN=上次的结果.json OUT=复查.json python3 native/tools/mutate_sweep.py                      # 只复查上次活下来的
  ONLY='子串|子串' …                                                                           # 只跑"原文行"里含这些子串的
"""
import json
import os
import re
import subprocess
import sys
import time
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
B = os.environ.get("BUILD", os.path.join(os.path.dirname(ROOT), "build"))
OUT = os.environ.get("OUT", os.path.join(os.path.dirname(ROOT), "mutate_sweep.json"))
RESTORE = os.path.join(ROOT, "tools", ".mutate_sweep.restore.json")
ENV = dict(os.environ, QT_QPA_PLATFORM="offscreen")
TIMEOUT = int(os.environ.get("MUTANT_TIMEOUT", "90"))

# 文件 → (相对路径, 先后要跑的测试)。后面的测试只在前面的都没咬住时才跑
FILES = {
    "fly_exit_sweep_spec.cpp": ("engine/analysis/", ["tst_fly_exit_sweep_spec", "tst_fly_exit_sweep"]),
    "fly_exit_sweep.cpp": ("engine/analysis/", ["tst_fly_exit_sweep"]),
    "fly_exit_sweep_stats.cpp": ("engine/analysis/", ["tst_fly_exit_sweep_stats"]),
    "fly_exit_sweep_report.cpp": ("engine/analysis/", ["tst_fly_exit_sweep_report"]),
    "discord_gateway.cpp": ("engine/util/", ["tst_discord_gateway"]),
    "discord_gateway_ws.cpp": ("engine/util/", ["tst_discord_gateway"]),
}

STR = re.compile(r'u?"(?:[^"\\]|\\.)*"(?:_s)?|\'(?:[^\'\\]|\\.)\'')


def mask(line):
    """字符串字面量与行尾注释换成占位符(等长),机械变异碰不到它们"""
    out = STR.sub(lambda m: "\x01" * len(m.group(0)), line)
    cut = out.find("//")
    if cut >= 0:
        out = out[:cut] + "\x01" * (len(out) - cut)
    return out


def candidates(path):
    """[(行号, 起, 止, 新文本, 说明)]"""
    lines = open(path).read().split("\n")
    out = []
    in_block = False
    for n, line in enumerate(lines):
        s = line.strip()
        if in_block:
            if "*/" in s:
                in_block = False
            continue
        if s.startswith("/*"):
            in_block = "*/" not in s
            continue
        if not s or s.startswith("//") or s.startswith("#") or s.startswith("using ") or s.startswith("namespace") or "static_assert" in s:
            continue
        m = mask(line)

        def add(rx, repl, why, flags=0):
            for mm in re.finditer(rx, m, flags):
                out.append((n, mm.start(), mm.end(), repl(mm) if callable(repl) else repl, why))

        add(r"(?<![<>=!])<=(?![=>])", "<", "<= → <")
        add(r"(?<![<>=!\-])>=(?![=])", ">", ">= → >")
        add(r"(?<=\s)<(?=\s)", "<=", "< → <=")
        add(r"(?<=\s)>(?=\s)", ">=", "> → >=")
        add(r"(?<=\s)==(?=\s)", "!=", "== → !=")
        add(r"(?<=\s)!=(?=\s)", "==", "!= → ==")
        add(r"(?<=\s)&&(?=\s)", "||", "&& → ||")
        add(r"(?<=\s)\|\|(?=\s)", "&&", "|| → &&")
        add(r"(?<=\s)\+(?=\s)", "-", "+ → -")
        add(r"(?<=\s)-(?=\s)", "+", "- → +")
        add(r"(?<=\s)\*(?=\s)", "/", "* → /")
        add(r"(?<=\s)/(?=\s)", "*", "/ → *")
        add(r"(?<=\s)\+=(?=\s)", "-=", "+= → -=")
        add(r"(?<=\s)-=(?=\s)", "+=", "-= → +=")
        add(r"(?<![=!<>&|])!(?=[A-Za-z_(])", "", "去掉 !")
        add(r"\btrue\b", "false", "true → false")
        add(r"\bfalse\b", "true", "false → true")
        add(r"\bcontinue;", ";", "删 continue")
        add(r"\bbreak;", ";", "删 break")
        # 数字字面量(不碰 0 和 1、下标里的数留给上面的运算符)
        for mm in re.finditer(r"(?<![\w.'\x01])(\d+\.\d+(?:e-?\d+)?|\d+e-?\d+|\d+)(?![\w.'\x01])", m):
            tok = mm.group(1)
            try:
                v = float(tok)
            except ValueError:
                continue
            if v in (0.0, 1.0):
                continue
            new = str(int(v) + 1) if re.fullmatch(r"\d+", tok) else repr(v * 1.5)
            out.append((n, mm.start(1), mm.end(1), new, f"{tok} → {new}"))
        # 整条语句
        t = s
        if re.match(r"^(bump\(|\w[\w\.\[\]>\-]*\s*\+=\s*1;)", t) and t.endswith(";"):
            a = len(line) - len(line.lstrip())
            out.append((n, a, len(line), ";", "删语句"))
    return lines, out


def build(target):
    r = subprocess.run(["cmake", "--build", B, "--target", target, "-j3"], capture_output=True, text=True)
    return r.returncode == 0


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


def run_tests(tests):
    """每个测试先重编再跑(同一份库,链接各一次);返回 (状态, 咬住它的测试)"""
    for t in tests:
        if not build(t):
            return "NOBUILD", t
        exe = os.path.join(B, "tests", t)
        try:
            r = subprocess.run([exe], capture_output=True, text=True, env=ENV, timeout=TIMEOUT)
        except subprocess.TimeoutExpired:
            return "TIMEOUT", t
        if r.returncode != 0:
            return "caught", t
    return "SURVIVED", ""


def main():
    if "--list" not in sys.argv and "/work/mut-" not in ROOT:
        sys.exit("只在私有副本里跑(work/mut-<簇>/…):在项目里直接跑会被别的助手与验收编进去。")
    names = [n for n in os.environ.get("FILES", "").split(",") if n] or list(FILES)
    only = [s for s in os.environ.get("ONLY", "").split("|") if s]
    todo = []
    for name in names:
        rel, tests = FILES[name]
        path = os.path.join(ROOT, rel, name)
        lines, cands = candidates(path)
        for (n, a, b, new, why) in cands:
            orig = lines[n]
            if only and not any(s in orig for s in only):
                continue
            todo.append((name, path, tests, n, a, b, new, why))
    if "--list" in sys.argv:
        per = Counter(t[0] for t in todo)
        for k, v in per.items():
            print(k, v)
        print("共", len(todo))
        return
    rerun = os.environ.get("RERUN")
    if rerun:
        # 代码改过之后行号会动:按"原文行 + 改法 + 新文本"认,不按行号
        keep = {(r["file"], r["orig"], r["why"], r["new"]) for r in json.load(open(rerun)) if r["status"] in ("SURVIVED", "TIMEOUT")}
        todo = [t for t in todo if (t[0], open(t[1]).read().split("\n")[t[3]].strip()[:160], t[7], t[6]) in keep]
    shard = os.environ.get("SHARD")
    if shard:
        i, n = (int(x) for x in shard.split("/"))
        todo = [t for k, t in enumerate(todo) if k % n == i]
    restore_leftover()
    originals = {t[1]: open(t[1]).read() for t in todo}
    json.dump(originals, open(RESTORE, "w"))
    results = []
    done = 0
    try:
        for (name, path, tests, n, a, b, new, why) in todo:
            orig = originals[path]
            lines = orig.split("\n")
            line = lines[n]
            lines[n] = line[:a] + new + line[b:]
            mutated = "\n".join(lines)
            rec = {"file": name, "line": n + 1, "col": a, "new": new, "why": why, "orig": line.strip()[:160], "mut": lines[n].strip()[:160]}
            open(path, "w").write(mutated)
            touch(path)
            status, by = run_tests(tests)
            rec["status"] = status
            rec["by"] = by
            open(path, "w").write(orig)
            touch(path)
            results.append(rec)
            done += 1
            if done % 10 == 0:
                json.dump(results, open(OUT, "w"), ensure_ascii=False)
                print(done, "/", len(todo), Counter(r["status"] for r in results), flush=True)
    finally:
        for path, text in originals.items():
            open(path, "w").write(text)
            touch(path)
        if os.path.exists(RESTORE):
            os.remove(RESTORE)
        for t in {t for (_n, _p, tests, *_r) in todo for t in tests}:
            build(t)
    json.dump(results, open(OUT, "w"), ensure_ascii=False)
    print(Counter(r["status"] for r in results))
    for r in results:
        if r["status"] in ("SURVIVED", "NOBUILD"):
            print(r["status"], r["file"], r["line"], r["why"], "|", r["orig"], "=>", r["mut"])


if __name__ == "__main__":
    main()
