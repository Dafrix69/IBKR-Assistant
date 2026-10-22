#!/usr/bin/env python3
"""svc2 簇(orchestrate/services/ 第二批)的变异检验。

只在私有副本里做,绝不动项目里的源码(别的助手、验收、审查随时在编项目,会把变异编进去):
  副本 = ~/Developer/ibkr/work/mut-svc2/<WORKER>/{native, build, desktop/engine-ts/docs/prompts 的符号链接};首次运行先 rsync 一份 native/ 过去、配置编译目录。
两类变异:
  · 手选(钱路径与状态机上的):fillSync 的节流 / 欠几趟 / 往回要 7 天 / 去重前提,brokerLink 的抖动判定 / 收声 / 重试,market_data 的 TTL 与键,events 的单飞与口径,pool 的迁移……
  · 机械生成:逐行的运算符翻转(== != < <= > >= && || + -)、true/false 互换、整数常量 +1、删掉一条语句;候选太多时按固定种子抽样(MAX)。
每个变异是一处单行改动:写进副本 → 重编对应的测试 → 跑 → 记 caught / survived / build-error;finally 里还原、把文件时间往后拨几秒。
中途被杀时 finally 不会跑:改动前的原文先存进 restore-<WORKER>.json,下次启动先按它还原。
**幸存者要么补用例杀掉,要么在 WHY 表里写明为什么等价 / 到不了**;跑完没写理由的会标成 UNDOCUMENTED 并让退出码非零。

  WORKER=a python3 native/tools/mutate_svc2.py          # 跑
  CHECK=1 python3 native/tools/mutate_svc2.py           # 只核对手选锚点(原文在项目文件里恰好出现 nth 次),不编不跑
  LIST=1 python3 native/tools/mutate_svc2.py            # 只列出会跑的变异
  RESUME=1 …  SURVIVORS_FROM=a.json …  ONLY='子串|子串'  MAX=…  OUT=结果.json  SHARD=i/n
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
WORK = "/Users/dafrix/Developer/ibkr/work/mut-svc2"
WORKER = os.environ.get("WORKER", "a")
ROOT = os.path.join(WORK, WORKER)
NATIVE = os.path.join(ROOT, "native")
B = os.path.join(ROOT, "build")
OUT = os.environ.get("OUT", os.path.join(WORK, f"mutate_svc2_{WORKER}.json"))
ENV = dict(os.environ, QT_QPA_PLATFORM="offscreen")
EXE = "engine/orchestrate/services/"
# 文件 → 它的对拍测试(改了它要重编、重跑的)
MAP = {
    "fill_sync.cpp": ["tst_svc_fillsync"], "fill_sync.h": ["tst_svc_fillsync"],
    "broker_link.cpp": ["tst_svc_brokerlink"], "broker_link.h": ["tst_svc_brokerlink"],
    "market_data.cpp": ["tst_svc_marketdata", "tst_svc_trades", "tst_svc_intel"], "market_data.h": ["tst_svc_marketdata"],
    "stock_trips.cpp": ["tst_svc_trades"], "trade_history.cpp": ["tst_svc_trades"], "similar_context.cpp": ["tst_svc_trades"], "similar_context.h": ["tst_svc_trades"],
    "events.cpp": ["tst_svc_events", "tst_svc_intel"], "events.h": ["tst_svc_events"], "public_fetch.cpp": ["tst_svc_events"],
    "intel.cpp": ["tst_svc_intel"], "pool.cpp": ["tst_svc_pool"], "assignment_watch.cpp": ["tst_svc_assignment"],
    "fly_planner.cpp": ["tst_svc_flyplanner"], "iv_recorder.cpp": ["tst_svc_ivrecorder"], "idea_semantic.cpp": ["tst_svc_ideasemantic"],
    "svc_runtime.cpp": ["tst_svc_runtime"], "svc_host.cpp": ["tst_svc_fillsync"],
}
FILES = list(MAP)
TESTS = sorted({t for ts in MAP.values() for t in ts})
MAX = int(os.environ.get("MAX", "450"))

# (文件, 原文, 改成, 第几处(缺省必须恰好一处)) —— 手选
H = []


def h(f, old, new, nth=None):
    H.append((f, old, new, nth))


F, L, M, E, I, PL, A, V, FP, IS, T = ("fill_sync.cpp", "broker_link.cpp", "market_data.cpp", "events.cpp", "intel.cpp", "pool.cpp", "assignment_watch.cpp", "iv_recorder.cpp", "fly_planner.cpp", "idea_semantic.cpp", "trade_history.cpp")
# ---- fillSync(钱路径:成交同步)
h(F, "if (nowMs - lastAt_ < kMinGapMs) co_return std::nullopt;", "if (nowMs - lastAt_ <= kMinGapMs) co_return std::nullopt;")
h(F, "    lastAt_ = nowMs;\n    Task<std::optional<double>> run", "    Task<std::optional<double>> run")
h(F, "if (inflight_ && !inflight_->done()) {", "if (false) {")
h(F, "if (owed_ == 0 && nowMs - lastAt_ >= kEveryMs) owed_ = 1;", "if (owed_ == 0 && nowMs - lastAt_ > kEveryMs) owed_ = 1;")
h(F, "if (deepOwed_ == 0 && nowMs - lastDeepAt_ >= kHistoryEveryMs) deepOwed_ = 1;", "if (deepOwed_ == 0 && nowMs - lastDeepAt_ > kHistoryEveryMs) deepOwed_ = 1;")
h(F, "owed_ = kAfterChange;", "owed_ = 1;")
h(F, "deepOwed_ = kAfterChange;", "deepOwed_ = 1;")
h(F, "        if (holdings_) {", "        if (true) {")
h(F, "if (seen && (!holdings_ || *seen != *holdings_)) {", "if (seen && (*seen != *holdings_)) {") if False else None
h(F, "if (deepOwed_ > 0 && !historyOff_) rows.append", "if (!historyOff_) rows.append")
h(F, "if (!able) historyOff_ = true;", "if (able) historyOff_ = true;")
h(F, "    lastDeepAt_ = nowMs;\n", "")
h(F, "if (error != lastError_) {", "if (true) {")
h(F, "if (error != lastHistoryError_) {", "if (true) {")
h(F, "    historyOff_ = false;\n}", "}")
h(F, "    holdings_.reset();\n    owed_ = std::max(owed_, 1);", "    owed_ = std::max(owed_, 1);")
h(F, "    owed_ = std::max(owed_, 1);\n    deepOwed_ = std::max(deepOwed_, 1);\n    historyOff_", "    deepOwed_ = std::max(deepOwed_, 1);\n    historyOff_")
h(F, "        deepOwed_ = std::max(deepOwed_, 1);\n        owed_ = std::max(owed_, 1);", "        owed_ = std::max(owed_, 1);")
h(F, "const double added = store().rememberFills(rows);", "const double added = store().rememberFills(QList<OJson>());")
h(F, "if (!session->has(execution::Cap::ExecutionHistory)) continue;", "")
h(F, "if (!details) continue;", "")
h(F, "if (quantity == 0) continue;", "")
h(F, "std::sort(keys.begin(), keys.end());", "")
h(F, "if (std::isnan(quantity)) quantity = 0;", "")
h(F, "kBrokerTimeoutMs, [] { return timeoutError(); });\n        if (deepOwed_", "kBrokerTimeoutMs * 2, [] { return timeoutError(); });\n        if (deepOwed_")
h(F, "if (alive.expired() || gen != gen_ || !running_) co_return;", "if (alive.expired()) co_return;")
h(F, "if (running_) return;", "")
# ---- brokerLink(连接生命周期 / 掉线提醒 / 收声)
h(L, "if (f.lastUpAt && now - *f.lastUpAt < kStableMs) f.flaps.append(now);", "if (f.lastUpAt && now - *f.lastUpAt <= kStableMs) f.flaps.append(now);")
h(L, "if (now - t < 60'000) kept.append(t);", "if (now - t <= 60'000) kept.append(t);")
h(L, "if (f.flaps.size() >= kFlapCount) {", "if (f.flaps.size() > kFlapCount) {")
h(L, "if (now - f.summaryAt >= 60'000) {", "if (now - f.summaryAt > 60'000) {")
h(L, "    if (f.downAnnounced) return;\n", "")
h(L, "        if (!f.flapping) {\n            f.downAnnounced = false;", "        if (false) {\n            f.downAnnounced = false;")
h(L, "            engine.reconcileSoon();  // 断线期间单子可能成交或被撤了:下一轮就对账,不等满一分钟\n", "")
h(L, "if (!wanted_ || host_.broker() != router) co_return;", "if (!wanted_) co_return;")
h(L, "if (router != seenRouter_) watch(router);", "")
h(L, "        if (seen_.contains(name)) continue;\n", "")
h(L, "if (!wanted_ || retrying_) co_return;", "if (retrying_) co_return;")
h(L, "    retrying_ = true;\n", "")
h(L, "    wanted_ = true;\n    ensureTimer();\n    result.listeners", "    ensureTimer();\n    result.listeners")
h(L, "    wanted_ = false;\n    return serialVoid", "    return serialVoid")
h(L, "if (!host_.settings().broker.auto_connect) return;", "")
h(L, "if (old && BrokerRouter::kBroker != provider) {", "if (false) {") if False else None
h(L, "if (!result.connected.isEmpty()) router->warmIndexFutures();", "")
h(L, "host_.dropEngine();  // 让引擎带上 router 重建\n", "")
h(L, "if (!result.connected.isEmpty()) host_.svcEngine();", "")
h(L, "state.flapping = false;", "")
h(L, "state.quietDowns = 0;", "")
h(L, "if (f.stableTimer != 0) host_.runtime().clearTimeout(f.stableTimer);\n        f.stableTimer = host_.runtime().setTimeout", "f.stableTimer = host_.runtime().setTimeout")
h(L, "    if (f.stableTimer != 0) {\n        host_.runtime().clearTimeout(f.stableTimer);\n        f.stableTimer = 0;\n    }", "")
h(L, "        out.resolve(std::move(*value));\n        mine.resolve();", "        mine.resolve();\n        out.resolve(std::move(*value));") if False else None
# ---- marketData
h(M, "if (now - hit.at < kWallTtlMs && (!want || hit.span.value_or(0) >= *want)) co_return hit.wall;", "if (now - hit.at < kWallTtlMs) co_return hit.wall;")
h(M, "if (now - hit.at < kHistTtlMs && hit.span >= span) {", "if (now - hit.at < kHistTtlMs) {")
h(M, "if (hit.span == span) co_return hit.bars;", "if (true) co_return hit.bars;")
h(M, "if (s.left(10) >= start) out.append(b);", "out.append(b);")
h(M, "if (now - hit.at < ttlS * 1000) co_return", "if (true) co_return")
h(M, r'''ttlS = std::fmax(kPaMinInterval, std::fmin(js::num(js::prop(spec, u"seconds"_s)) / 10.0, 60.0));''', r'''ttlS = kPaMinInterval;''')
h(M, "if (!price || *price == 0 || std::isnan(*price)) co_return std::nullopt;", "if (!price) co_return std::nullopt;")
# ---- events
h(E, "if (!feedAt_) return !feedTriedAt_ || now - *feedTriedAt_ >= kRetryMs;", "if (!feedAt_) return false;")
h(E, "if (now - *feedAt_ < kFeedTtlMs) return false;", "")
h(E, "if (inflight_ && !inflight_->done()) co_return co_await Task<>(*inflight_);  // 单飞", "")
h(E, "if (crossInflight_ && !crossInflight_->done()) co_return co_await Task<>(*crossInflight_);", "")
h(E, "if (!crossAt_ || nowArg - *crossAt_ >= kCrossTtlMs) {", "if (!crossAt_) {")
h(E, "if (!crossAt_ || crossEvent_.type == OJson::Null) co_await refreshCross(nowArg, config);", "if (true) co_await refreshCross(nowArg, config);")
h(E, "if (rows.size() >= kMaxCustom) throw", "if (rows.size() > kMaxCustom) throw")
h(E, "if (!std::isfinite(linger) || linger < 5 || linger > 24 * 60) throw", "if (!std::isfinite(linger) || linger < 5) throw")
h(E, "if (force || !feedAt_) {", "if (!feedAt_) {")
h(E, r'''(js::str(js::prop(&e, u"source"_s)) == u"custom" || js::num(js::prop(&e, u"stars"_s)) >= minStars)''', r'''(js::num(js::prop(&e, u"stars"_s)) >= minStars)''')
# ---- pool / assignment / ivrecorder / flyplanner / ideaSemantic / tradeHistory
h(PL, "if (st.listWatches().size() >= ports_.maxWatch) {", "if (st.listWatches().size() > ports_.maxWatch) {")
h(PL, "if (st.listQualityStocks().size() >= ports_.maxQuality) {", "if (st.listQualityStocks().size() > ports_.maxQuality) {")
h(PL, "if (poolMigrated_) return;", "")
h(PL, "if (st.getPref(kPoolMigratedPref).type != OJson::Null) return;", "")
h(PL, "if (ports_.forgetAlert) ports_.forgetAlert(symbol);", "")
h(PL, "if (ports_.forgetAnomaly) ports_.forgetAnomaly(symbol);", "")
h(PL, "if ((js::nullish(o) ? QString() : js::str(o)) != ports_.originTracker) rows.append(w);", "rows.append(w);")
h(A, "return at.minutes >= close - kLeadMinutes && at.minutes < close;", "return at.minutes >= close - kLeadMinutes && at.minutes <= close;")
h(A, "if (!anyFresh) continue;", "")
h(A, "if (toldDate_ != at.date) {", "if (false) {")
h(V, "if (nowMs - lastLoopAt_ < kIntervalMs) co_return OJson::null();", "if (nowMs - lastLoopAt_ <= kIntervalMs) co_return OJson::null();")
h(V, "if (!anyAsk) {", "if (!anyAsk && !anyIv) {")
h(V, "if (t - lastPlanAt_.value(key, 0) < kPlanGapMs) return false;", "if (t - lastPlanAt_.value(key, 0) <= kPlanGapMs) return false;")
h(V, "if (s.read(util::dateStrAt(*lastAt_, QString::fromUtf16(util::kET))).size() == 1) s.prune();", "s.prune();")
h(V, "if (std::fabs(spot - anchor) >= kRovePoints) {", "if (std::fabs(spot - anchor) > kRovePoints) {")
h(FP, r'''if (!given.iv) throw RpcError(-32017, why + u"可以手动填上 IV 再算。"_s);''', r'''''')
h(FP, r'''warnings->append(given.cost ? why : why + u"成本请自己填,否则用的是模型价。"_s);''', r'''warnings->append(why);''')
h(FP, "if (router->upstreamOk() == false) {", "if (false) {")
h(IS, "if (llmCache_.size() >= kLlmCacheMax) llmCache_.removeFirst();", "")
h(IS, "if (out.contains(id)) continue;  // 重复的,不认", "")
h(IS, "if (ok && n < double(cand.size())) idea = &cand[qsizetype(n)];", "if (ok) idea = &cand[qsizetype(n)];")
h(IS, "if (scored[i].second >= floor)", "if (true)")
h(T, "if (!when || !byPositions.contains(id + u'|' + analysis::tradereview::etKey(*when, true))) butterflies.append(r);", "butterflies.append(r);")
H = [x for x in H if x is not None]

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
        if name.startswith(("tst_svc_", "svc_world")) and name.endswith((".cpp", ".h")):
            os.utime(os.path.join(NATIVE, "tests", name), (now, now))
    for line in r.stdout.splitlines():
        if line.startswith(">f"):
            path = os.path.join(NATIVE, line.split(" ", 1)[1].strip())
            if os.path.exists(path):
                os.utime(path, (now, now))
    if not os.path.exists(os.path.join(B, "build.ninja")):
        r = sh(["cmake", "-S", NATIVE, "-B", B, "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Debug", "-DCMAKE_CXX_COMPILER=/Library/Developer/CommandLineTools/usr/bin/clang++",
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
    return 1 if undocumented else 0


if __name__ == "__main__":
    sys.exit(main())
