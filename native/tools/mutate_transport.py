#!/usr/bin/env python3
"""transport 簇(transport/rpc_server、context、cli、orchestrate/host、util/zod 与 ordered_json 里这一轮改的部分、contract/kit)的变异检验。

机制同 mutate_contract.py(逐行机械地改条件 / 边界 / 运算符 / 常量 / 字符串字面量 / 删一句),每个变异:写进去 → 重编对应的测试 → 跑 → 记
caught / survived / build-error;finally 里还原、把文件时间往后拨几秒、重编。只在私有副本里改(brief 第 3 条):
每个 WORKER 一份 work/mut-transport/<w>/native(旁边 desktop / engine-ts / docs / prompts 是符号链接,run_worker.sh 建)。

  a  transport/rpc_server.cpp                                → tst_rpc_server、tst_rpc
  b  transport/context.cpp、orchestrate/host.cpp、context.h 里的 SerialLock → tst_rpc_context
  c  transport/cli.cpp                                       → tst_cli
  d  util/zod.cpp                                            → tst_zod_gaps、tst_contract、tst_models
  e  util/ordered_json.cpp 里的 number() 与深度上限          → tst_zod_gaps、tst_rpc_server
  f  contract/kit.cpp                                        → tst_contract、tst_zod_gaps、tst_rpc_context

  WORKER=a python3 native/tools/mutate_transport.py           # 全部
  ONLY='子串|子串' …                                           # 只跑改动前的那一行含这些子串的
  RERUN=上一次的结果.json …                                    # 只重跑上一次没咬住的
  LIST=1 …                                                    # 只列出变异,不跑

中途被杀(重启、kill -9)时 finally 不会跑:改动前的原文先存进 <native>/tools/.mutate_transport.<w>.restore.json,下次启动先按它还原。
"""
import json
import os
import re
import subprocess
import sys
import time
from collections import Counter

W = os.environ.get("WORKER", "a")
BASE = os.environ.get("BASE", "/Users/dafrix/Developer/ibkr/work/mut-transport")
ROOT = os.environ.get("NATIVE", f"{BASE}/{W}/native")
B = os.environ.get("BUILD", f"{BASE}/{W}/build")
OUT = os.environ.get("OUT", os.path.join(B, f"mutate_transport.{W}.json"))
ENV = dict(os.environ, QT_QPA_PLATFORM="offscreen")
# 文件(可带行区间 "path:from-to":改的是共享文件里这一轮动的那一段) → 测试(按这个先后跑,任何一个红了就算咬住)
GROUPS = {
    "a": (["engine/transport/rpc_server.cpp"], ["tst_rpc_server", "tst_rpc"]),
    "b": (["engine/transport/context.cpp", "engine/orchestrate/host.cpp", "engine/transport/context.h:30-75"], ["tst_rpc_context"]),
    "c": (["engine/transport/cli.cpp"], ["tst_cli"]),
    "d": (["engine/util/zod.cpp"], ["tst_zod_gaps", "tst_contract", "tst_models"]),
    "e": (["engine/util/ordered_json.cpp:150-175", "engine/util/ordered_json.cpp:205-245"], ["tst_zod_gaps", "tst_rpc_server"]),
    "f": (["engine/contract/kit.cpp"], ["tst_contract", "tst_zod_gaps", "tst_rpc_context"]),
}
FILES, TESTS = GROUPS[W]
JOURNAL = os.path.join(ROOT, "tools", f".mutate_transport.{W}.restore.json")


def code_part(line):
    """去掉行尾的 // 注释(不碰字符串里的 //)"""
    q = None
    i = 0
    while i < len(line):
        c = line[i]
        if q:
            if c == "\\":
                i += 1
            elif c == q:
                q = None
        elif c in "\"'":
            q = c
        elif c == "/" and line[i : i + 2] == "//":
            return line[:i], line[i:]
        i += 1
    return line, ""


def sub_each(code, pattern, repl, limit=12):
    """pattern 每一处各替换一次,返回 [(新代码, 说明)]"""
    out = []
    for m in list(re.finditer(pattern, code))[:limit]:
        out.append((code[: m.start()] + m.expand(repl) + code[m.end() :], f"{m.group(0).strip()[:24]}→{m.expand(repl).strip()[:24]}"))
    return out


SWAP = {"str()": "num()", "num()": "str()", "boolean()": "str()", "unknown()": "str()", "zod::string()": "zod::number()", "zod::number()": "zod::string()", "zod::boolean()": "zod::string()"}


def line_mutants(code):
    res = []
    for pat, rep in [(r" == ", " != "), (r" != ", " == "), (r" <= ", " < "), (r" >= ", " > "), (r" < ", " <= "), (r" > ", " >= "), (r" && ", " || "), (r" \|\| ", " && "),
                     (r"\btrue\b", "false"), (r"\bfalse\b", "true"), (r" \+ ", " - "), (r" - ", " + "), (r" \* ", " / "), (r" / ", " * ")]:
        res += sub_each(code, pat, rep)
    # 取反:去掉 ! (不碰 !=)
    res += sub_each(code, r"!(?!=)(?=[\w(*])", "")
    # 整数常量(不在字符串里的独立数字,且前面不是字母 / 点 / 引号)
    for m in list(re.finditer(r"(?<![\w.\"'%])(\d+)(?![\w.\"'])", code))[:4]:
        n = int(m.group(1))
        res.append((code[: m.start()] + str(n + 1) + code[m.end() :], f"{n}→{n + 1}"))
        if n > 0:
            res.append((code[: m.start()] + str(n - 1) + code[m.end() :], f"{n}→{n - 1}"))
    # 控制流
    if re.fullmatch(r"\s*(continue|break);\s*", code) or re.search(r"\b(continue|break);\s*$", code):
        res.append((re.sub(r"\b(continue|break);", ";", code), "去掉 continue/break"))
    # 方法链
    for call in ["->strict()", "->partial()", "->nullable()", "->optional()"]:
        if call in code:
            res.append((code.replace(call, "", 1), f"去掉 {call}"))
    for m in list(re.finditer(r"\boptional\(", code))[:3]:
        res.append((code[: m.start()] + "(" + code[m.end() :], "去掉 optional("))
    for a, b in SWAP.items():
        for m in list(re.finditer(r"(?<![\w:])" + re.escape(a), code))[:8]:
            res.append((code[: m.start()] + b + code[m.end() :], f"{a}→{b}"))
        if a.startswith("zod::"):
            for m in list(re.finditer(re.escape(a), code))[:8]:
                res.append((code[: m.start()] + b + code[m.end() :], f"{a}→{b}"))
    res += sub_each(code, r"numOrStr\(\)", "num()", 2)
    # 类型放宽:schema 树的每一个叶子(基本类型 / 数字串联合 / 别名)各换成 unknown(),与再各加一次 nullable
    for tok in [r"(?<![\w:])str\(\)", r"(?<![\w:])num\(\)", r"(?<![\w:])boolean\(\)", r"numberField\(\)", r"numOrStr\(\)", r"numStrNull\(\)",
                r"ideasLimit\(\)", r"screenerNumberField\(\)", r"zod::string\(\)", r"zod::number\(\)", r"zod::boolean\(\)"]:
        res += [(c, f"放宽 {w}") for c, w in sub_each(code, tok, "zod::unknown()", 30)]
    for tok in [r"(?<![\w:])str\(\)", r"(?<![\w:])num\(\)", r"(?<![\w:])boolean\(\)"]:
        res += [(c, f"可空 {w}") for c, w in sub_each(code, tok, "optional(zod::unknown()->nullable())" if False else "zod::unknown()->nullable()", 30)]
    for tok in [r"zod::number\(\)(?!->)", r"zod::string\(\)(?!->)"]:
        res += [(c, f"可空 {w}") for c, w in sub_each(code, tok, r"\g<0>->nullable()", 30)]
    # 字符串字面量:少最后一个字(u"…"_s 与普通 "…")
    for m in list(re.finditer(r'u?"((?:[^"\\]|\\.)+)"(_s)?', code))[:10]:
        body = m.group(1)
        if len(body) >= 2 and not body.startswith("%"):
            cut = body[:-1] if not body.endswith("\\") else body
            res.append((code[: m.start(1)] + cut + code[m.end(1) :], f"字面量「{body[:20]}」少一字"))
    return res


def statement_deletions(line, code):
    s = code.strip()
    if not s.endswith(";") or s.startswith(("return", "using", "const ", "static ", "namespace", "template")) or re.match(r"^(auto|QString|OJson|double|bool|int|std::\w+|zod::\w+|qsizetype)\b[\w:<>,\s&*]*\s\w+\s*(=|\{|\()", s):
        return []
    if re.match(r"^(if|for|while|else|switch|case|default)\b", s) and "{" in s:
        return []
    return [(line[: len(line) - len(line.lstrip())] + ";" + code[len(code.rstrip()) :] if False else re.sub(r"\S.*", ";", code, count=1), "删掉这一句")]


def shape_field_deletion(code):
    # schemas.cpp:字段 {u"名字"_s, …}(一行一个、或一行里好几个):逐个删掉(含 enumOf 里的 {u"a"_s, u"b"_s} 的取值)
    out = []
    if re.match(r'^\s*\{u"[\w]+"_s, .*\},\s*$', code) and code.count("{") == code.count("}"):
        out.append(("", "删掉这个字段"))
    for m in re.finditer(r'\{u"[\w.]+"_s, ', code):
        depth, j = 0, m.start()
        while j < len(code):
            depth += code[j] == "{"
            depth -= code[j] == "}"
            if depth == 0:
                break
            j += 1
        if j >= len(code) or m.start() == 0:
            continue
        seg_end = j + 1
        tail = code[seg_end:]
        # 连着的逗号一起删
        cut_end = seg_end + (2 if tail.startswith(", ") else 0)
        if code[:m.start()].rstrip().endswith(",") and cut_end == seg_end:
            start = len(code[:m.start()].rstrip()) - 1
            out.append((code[:start] + code[seg_end:], f"删掉字段 {m.group(0)[2:-3]}"))
        else:
            out.append((code[:m.start()] + code[cut_end:], f"删掉字段 {m.group(0)[2:-3]}"))
    return out


def generate(path):
    text = open(path, encoding="utf-8").read()
    lines = text.split("\n")
    muts = []
    in_block = False
    for i, line in enumerate(lines):
        s = line.strip()
        if in_block:
            in_block = "*/" not in s
            continue
        if s.startswith("/*"):
            in_block = "*/" not in s
            continue
        if not s or s.startswith(("//", "#", "using ", "namespace ", "}", "{", "public:", "private:", "protected:")) or s in ("});", "};", "));", ");"):
            continue
        code, comment = code_part(line)
        cands = line_mutants(code) + statement_deletions(line, code) + shape_field_deletion(code)
        seen = set()
        for new_code, why in cands:
            new = new_code + comment if new_code != "" else ""
            if new == line or new in seen:
                continue
            seen.add(new)
            muts.append((i + 1, line, new, why))
    return text, muts


def build():
    for _ in range(4):
        b = subprocess.run(["ninja", "-C", B] + TESTS, capture_output=True, text=True)
        if b.returncode == 0:
            return True
        if "Operation timed out" not in b.stdout + b.stderr:
            return False
        time.sleep(5)
    return False


def run():
    """全部测试都绿 = 变异活下来了(True);任何一个红 / 超时 / 崩 = 咬住了(False)"""
    for t in TESTS:
        try:
            r = subprocess.run([os.path.join(B, "tests", t)], capture_output=True, text=True, env=ENV, timeout=240)
        except subprocess.TimeoutExpired:
            return False
        if r.returncode != 0:
            return False
    return True


def bump(path):
    t = time.time() + 3
    os.utime(path, (t, t))


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


def main():
    recover()
    only = [x for x in os.environ.get("ONLY", "").split("|") if x]
    rerun = None
    if os.environ.get("RERUN"):
        rerun = {(r[0], r[1], r[2], r[3]) for r in json.load(open(os.environ["RERUN"], encoding="utf-8")) if r[5] == "survived"}
    todo = []
    for spec in FILES:
        f, _, rng = spec.partition(":")
        lo, hi = (int(x) for x in rng.split("-")) if rng else (0, 10**9)
        lo = max(lo, int(os.environ.get("LOLINE", 0)))  # 接着上次中断的地方往下跑
        path = os.path.join(ROOT, f)
        _, muts = generate(path)
        for ln, old, new, why in muts:
            if not lo <= ln <= hi:
                continue
            if only and not any(o in old for o in only):
                continue
            if rerun is not None and (f, ln, old, new) not in rerun:
                continue
            todo.append((f, ln, old, new, why))
    print(f"{len(todo)} 个变异", flush=True)
    if os.environ.get("LIST"):
        for f, ln, old, new, why in todo:
            print(f"{os.path.basename(f)}:{ln}  [{why}]  {old.strip()[:100]}  =>  {new.strip()[:100]}")
        return 0
    results = []
    try:
        for f, ln, old, new, why in todo:
            path = os.path.join(ROOT, f)
            orig = open(path, encoding="utf-8").read()
            lines = orig.split("\n")
            if lines[ln - 1] != old:
                results.append([f, ln, old, new, why, "bad-anchor"])
                print("bad-anchor", f, ln, flush=True)
                continue
            with open(JOURNAL, "w", encoding="utf-8") as fh:
                json.dump({"path": path, "orig": orig}, fh, ensure_ascii=False)
            try:
                mutated = lines[: ln - 1] + ([new] if new != "" else []) + lines[ln:]
                with open(path, "w", encoding="utf-8") as fh:
                    fh.write("\n".join(mutated))
                bump(path)
                res = ("survived" if run() else "caught") if build() else "build-error"
            finally:
                with open(path, "w", encoding="utf-8") as fh:
                    fh.write(orig)
                bump(path)
                os.remove(JOURNAL)
                build()
            results.append([f, ln, old, new, why, res])
            print(res, f"{os.path.basename(f)}:{ln}", f"[{why}]", old.strip()[:80], flush=True)
            with open(OUT, "w", encoding="utf-8") as fh:
                json.dump(results, fh, ensure_ascii=False, indent=1)
    finally:
        build()
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(results, fh, ensure_ascii=False, indent=1)
    print(dict(Counter(r[5] for r in results)), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
