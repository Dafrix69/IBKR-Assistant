#!/usr/bin/env python3
"""handlers2 簇(transport/handlers/ 的 ideas / review / sectors / quality / events / intel / alerts / backtest / follow / market / screener)的变异检验。
普通模块的轻量版(提速规则):手挑的关键判断(每个文件 ~20 个,写在 tools/mutate_h2_hand/<DOMAIN>.py 的 H 里)+ 一轮机械变异的抽样;幸存者不逐个写理由,
跑完把幸存者列出来一行带过,明显的测试缺口补用例。

只在私有副本里做,绝不动项目里的源码(别的助手、验收、审查随时在编项目,会把变异编进去):
  副本 = ~/Developer/ibkr/work/mut-handlers2/<DOMAIN>/{native, build, desktop/engine-ts/docs/prompts 的符号链接};首次运行先 rsync 一份 native/ 过去、配置编译目录。
每个变异是一处单行改动:写进副本 → 重编对应的测试 → 跑 → 记 caught / survived / build-error;finally 里还原、把文件时间往后拨几秒。
中途被杀时 finally 不会跑:改动前的原文先存进 restore-<DOMAIN>.json,下次启动先按它还原。

  DOMAIN=ideas python3 native/tools/mutate_handlers2.py      # 跑
  CHECK=1 DOMAIN=ideas python3 …                             # 只核对手选锚点(原文在项目文件里恰好出现 nth 次),不编不跑
  LIST=1 …    MAX=…(机械抽样的总数,缺省 120)  ONLY='子串|子串'  OUT=结果.json  RESUME=1  SURVIVORS_FROM=a.json
DOMAIN:small(events intel follow)quality(quality alerts)sectors ideas review market screener backtest
"""
import json
import os
import random
import re
import subprocess
import sys
import time
from collections import Counter

PROJECT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # IBKR-Assistant
DOMAINS = {
    "small": (["events.cpp", "intel.cpp", "follow.cpp"], ["tst_h2_small"]),
    "quality": (["quality.cpp", "alerts.cpp"], ["tst_h2_quality"]),
    "sectors": (["sectors.cpp"], ["tst_h2_sectors"]),
    "ideas": (["ideas.cpp"], ["tst_h2_ideas"]),
    "review": (["review.cpp"], ["tst_h2_review"]),
    "market": (["market.cpp"], ["tst_h2_market"]),
    "screener": (["screener.cpp"], ["tst_h2_screener"]),
    "backtest": (["backtest.cpp"], ["tst_h2_backtest"]),
}
WORK = "/Users/dafrix/Developer/ibkr/work/mut-handlers2"
WORKER = os.environ["DOMAIN"]
ROOT = os.path.join(WORK, WORKER)
NATIVE = os.path.join(ROOT, "native")
B = os.path.join(ROOT, "build")
OUT = os.environ.get("OUT", os.path.join(WORK, f"mutate_{WORKER}.json"))
ENV = dict(os.environ, QT_QPA_PLATFORM="offscreen")
EXE = "engine/transport/handlers/"
FILES, TESTS = DOMAINS[WORKER]
MAP = {f: TESTS for f in FILES}
MAX = int(os.environ.get("MAX", "120"))

# (文件, 原文, 改成, 第几处(缺省必须恰好一处)) —— 手选,写在 tools/mutate_h2_hand/<DOMAIN>.py 的 H 里
H = []
_hand = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mutate_h2_hand", f"{WORKER}.py")
if os.path.exists(_hand):
    _ns = {}
    exec(compile(open(_hand, encoding="utf-8").read(), _hand, "exec"), _ns)
    H = [tuple(x) + (None,) * (4 - len(x)) for x in _ns["H"]]

# 幸存者的理由:(文件, 原文里的片段, 变异后的片段, 理由)。没写的跑完标 UNDOCUMENTED
WHY = []


def why(f, desc):
    for wf, wo, reason in WHY:
        if wf == f and wo in desc:
            return reason
    return None


MECH_RULES = [(" == ", " != "), (" != ", " == "), (" <= ", " < "), (" >= ", " > "), (" < ", " <= "), (" > ", " >= "), (" && ", " || "), (" || ", " && "), (" + ", " - "), (" - ", " + ")]


def mask(line):
    """字符串字面量与行尾注释里的字符换成 x(不动位置),用来找运算符"""
    out, i, q = [], 0, None
    while i < len(line):
        c = line[i]
        if q:
            if c == "\\":
                out.append("xx")
                i += 2
                continue
            if c == q:
                q = None
                out.append(c)
            else:
                out.append("x")
        else:
            if c in "\"'":
                q = c
                out.append(c)
            elif line.startswith("//", i):
                out.append("x" * (len(line) - i))
                break
            else:
                out.append(c)
        i += 1
    return "".join(out)


def mech_candidates():
    cands = []
    for f in FILES:
        path = os.path.join(PROJECT, "native", EXE, f)
        lines = open(path, encoding="utf-8").read().split("\n")
        in_block = False
        for n, line in enumerate(lines):
            st = line.strip()
            if in_block:
                if "*/" in st:
                    in_block = False
                continue
            if st.startswith("/*") and "*/" not in st:
                in_block = True
                continue
            if not st or st.startswith(("//", "#", "/*", "*", "}", "{")) or f.endswith(".h") and not re.search(r"constexpr|inline", st):
                continue
            m = mask(line)
            for a, b in MECH_RULES:
                for mt in re.finditer(re.escape(a), m):
                    cands.append((f, n, line[: mt.start()] + b + line[mt.end():]))
            for mt in re.finditer(r"\b(true|false)\b", m):
                cands.append((f, n, line[: mt.start()] + ("false" if mt.group(1) == "true" else "true") + line[mt.end():]))
            for mt in re.finditer(r"(?<![\w.'])(\d+)(?![\w.'])", m):
                cands.append((f, n, line[: mt.start()] + str(int(mt.group(1)) + 1) + line[mt.end():]))
            if re.match(r"^(throw |[A-Za-z_][\w:>.\-]*(\(|\[| = ))", st) and st.endswith(";") and not re.match(r"^(return|co_return|const|auto|else|QString|std::|OJson|bool|int|double|static|IbContract|OrderIntent|QStringList|SessionPtr|TickerData)\b", st) and "{" not in st:
                cands.append((f, n, re.match(r"\s*", line).group(0) + ";"))
    return cands


def build_list():
    mut = []
    for f, old, new, nth in H:
        mut.append({"kind": "hand", "file": f, "old": old, "new": new, "nth": nth})
    cands = mech_candidates()
    random.Random(0xB20C).shuffle(cands)
    for f, n, newline in cands[: max(0, MAX - len(H))]:
        mut.append({"kind": "mech", "file": f, "line": n, "newline": newline})
    return mut


def tests_for(m):
    return MAP[m["file"]]


def check():
    bad = 0
    for f, old, new, nth in H:
        path = os.path.join(PROJECT, "native", EXE, f)
        n = open(path, encoding="utf-8").read().count(old)
        if (nth is None and n != 1) or (nth is not None and n < nth) or old == new:
            bad += 1
            print(f"bad-anchor({n})", f, old.replace("\n", "\\n")[:100])
    print("hand anchors checked:", len(H), "bad:", bad, " mechanical candidates:", len(mech_candidates()))
    return 1 if bad else 0


def sh(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, errors="replace", **kw)


def setup():
    assert ROOT.startswith(WORK), ROOT
    os.makedirs(ROOT, exist_ok=True)
    for name in ("desktop", "engine-ts", "docs", "prompts"):
        link = os.path.join(ROOT, name)
        if not os.path.lexists(link):
            os.symlink(os.path.join(PROJECT, name), link)
    r = sh(["rsync", "-ai", "--delete", "--exclude=.vscode", "--exclude=build*", os.path.join(PROJECT, "native") + "/", NATIVE + "/"])
    if r.returncode != 0:
        raise SystemExit("rsync failed: " + r.stderr)
    # rsync -a 保留源文件的修改时间:比编过的产物旧的新内容 ninja 会当成没变。凡是这次拷过来的都把时间拨到现在
    now = time.time()
    # 保险:自己的源文件与测试一律拨到现在(上面的判断在 rsync 版本不同时认不出;陈旧产物吃过亏)
    for f in FILES:
        os.utime(os.path.join(NATIVE, EXE, f), (now, now))
    for name in os.listdir(os.path.join(NATIVE, "tests")):
        if name.startswith(("tst_h2_", "h2_world", "svc_world")) and name.endswith((".cpp", ".h")):
            os.utime(os.path.join(NATIVE, "tests", name), (now, now))
    for line in r.stdout.splitlines():
        if line.startswith(">f"):
            path = os.path.join(NATIVE, line.split(" ", 1)[1].strip())
            if os.path.exists(path):
                os.utime(path, (now, now))
    if not os.path.exists(os.path.join(B, "build.ninja")):
        r = sh(["cmake", "-S", NATIVE, "-B", B, "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Debug", "-DCMAKE_C_COMPILER=/Library/Developer/CommandLineTools/usr/bin/clang", "-DCMAKE_CXX_COMPILER=/Library/Developer/CommandLineTools/usr/bin/clang++", "-DCMAKE_OSX_SYSROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk",
                "-DCMAKE_PREFIX_PATH=/opt/homebrew", "-DIBKR_BUILD_UI=OFF"])
        if r.returncode != 0:
            raise SystemExit("configure failed: " + r.stdout + r.stderr)


def build(targets):
    for _ in range(4):
        b = sh(["cmake", "--build", B, "--target", *targets, "-j4"])
        if b.returncode == 0:
            return True
        if "Operation timed out" not in b.stdout + b.stderr:
            return False
        time.sleep(5)
    return False


def run(test):
    r = subprocess.run([os.path.join(B, "tests", test)], capture_output=True, text=True, errors="replace", env=ENV, timeout=900)
    return r.returncode == 0


def bump(path):
    t = time.time() + 3
    os.utime(path, (t, t))


JOURNAL = os.path.join(WORK, f"restore-{WORKER}.json")


def recover():
    if not os.path.exists(JOURNAL):
        return
    with open(JOURNAL, encoding="utf-8") as fh:
        j = json.load(fh)
    with open(j["path"], "w", encoding="utf-8") as fh:
        fh.write(j["orig"])
    bump(j["path"])
    os.remove(JOURNAL)
    print("recovered", j["path"], flush=True)


def apply(orig, m):
    if m["kind"] == "hand":
        old, new, nth = m["old"], m["new"], m["nth"]
        if nth is None:
            if orig.count(old) != 1:
                return None
            return orig.replace(old, new)
        parts = orig.split(old)
        if len(parts) - 1 < nth:
            return None
        return old.join(parts[:nth]) + new + old.join(parts[nth:])
    lines = orig.split("\n")
    if lines[m["line"]] == m["newline"]:
        return None
    lines[m["line"]] = m["newline"]
    return "\n".join(lines)


def describe(m):
    if m["kind"] == "hand":
        return m["old"].replace("\n", " ")[:80] + " => " + m["new"].replace("\n", " ")[:60]
    return f"line {m['line'] + 1}: {m['newline'].strip()[:100]}"


def main():
    if os.environ.get("CHECK"):
        return check()
    muts = build_list()
    only = os.environ.get("ONLY")
    if only:
        muts = [m for m in muts if any(s in describe(m) or s in m["file"] for s in only.split("|"))]
    # 按变异后的那行文字认幸存者(不看行号:代码改过之后行号会挪,机械抽样也会跟着变)
    text_from = os.environ.get("SURVIVORS_BY_TEXT")
    if text_from:
        alive_text = set()
        for r in json.load(open(text_from, encoding="utf-8")):
            if r[3] == "survived":
                t = re.sub(r"^line \d+: ", "", r[2])
                if r[0] == "hand" or t != ";":  # ";"(删一条语句)太泛,认不出是哪一条:那些靠 SURVIVORS_FROM 按行号复跑
                    alive_text.add((r[1], t) if r[0] == "mech" else (r[1], r[2]))
        keep = []
        for m in muts:
            key = (m["file"], re.sub(r"^line \d+: ", "", describe(m))) if m["kind"] == "mech" else (m["file"], describe(m))
            if key in alive_text:
                keep.append(m)
        muts = keep
    prev = os.environ.get("SURVIVORS_FROM")
    if prev:
        alive = set()
        for path in prev.split(","):
            alive |= {(r[1], r[2]) for r in json.load(open(path, encoding="utf-8")) if r[3] == "survived"}
        muts = [m for m in muts if (m["file"], describe(m)) in alive]
    shard = os.environ.get("SHARD")
    if shard:
        i, n = (int(x) for x in shard.split("/"))
        muts = [m for k, m in enumerate(muts) if k % n == i]
    if os.environ.get("LIST"):
        for m in muts:
            print(m["kind"], m["file"], describe(m))
        print(len(muts))
        return 0
    recover()
    setup()
    if not build(TESTS):
        raise SystemExit("baseline build failed")
    for t in TESTS:
        if not run(t):
            raise SystemExit(f"baseline {t} is red")
    results = []
    done = set()
    if os.environ.get("RESUME") and os.path.exists(OUT):
        results = json.load(open(OUT, encoding="utf-8"))
        done = {(r[1], r[2]) for r in results}
    try:
        for m in muts:
            if (m["file"], describe(m)) in done:
                continue
            path = os.path.join(NATIVE, EXE, m["file"])
            assert path.startswith(WORK)
            orig = open(path, encoding="utf-8").read()
            mutated = apply(orig, m)
            if mutated is None:
                results.append([m["kind"], m["file"], describe(m), "bad-anchor"])
                print("bad-anchor", m["file"], describe(m), flush=True)
                continue
            with open(JOURNAL, "w", encoding="utf-8") as fh:
                json.dump({"path": path, "orig": orig}, fh, ensure_ascii=False)
            try:
                with open(path, "w", encoding="utf-8") as fh:
                    fh.write(mutated)
                bump(path)
                ts = tests_for(m)
                if not build(ts):
                    res = "build-error"
                else:
                    res = "caught"
                    for t in ts:
                        if not run(t):
                            break
                    else:
                        res = "survived"
            finally:
                with open(path, "w", encoding="utf-8") as fh:
                    fh.write(orig)
                bump(path)
                os.remove(JOURNAL)
                # 还原后不立刻重编:下一个变异的那次编译会连这个文件一起重编(时间戳比目标新);最后统一编一遍
            reason = why(m["file"], describe(m)) if res == "survived" else None
            results.append([m["kind"], m["file"], describe(m), res, reason])
            print(res, m["kind"], m["file"], describe(m), ("  <= " + reason[:60]) if reason else ("  <= UNDOCUMENTED" if res == "survived" else ""), flush=True)
            with open(OUT, "w", encoding="utf-8") as fh:
                json.dump(results, fh, ensure_ascii=False, indent=1)
    finally:
        build(TESTS)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(results, fh, ensure_ascii=False, indent=1)
    print(dict(Counter(r[3] for r in results)), flush=True)
    undocumented = [r for r in results if r[3] == "survived" and not (len(r) > 4 and r[4])]
    print("UNDOCUMENTED survivors:", len(undocumented), flush=True)
    print("survivors:", [r[2] for r in results if r[3] == "survived"], flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
