#!/usr/bin/env python3
"""broker 簇(BrokerRouter:broker.h / broker.cpp / broker_session.cpp / broker_quotes.cpp / broker_positions.cpp / broker_orders.cpp)的变异检验。

只在私有副本里做,绝不动项目里的源码(别的助手、验收、审查随时在编项目,会把变异编进去):
  WORKER=<名字> 每个 worker 一份副本 ~/Developer/ibkr/work/mut-broker/<名字>/{native, build, desktop/engine-ts/docs/prompts 的符号链接}。
  首次运行先 rsync 一份 native/ 过去、配置编译目录;之后每次启动也把副本里的源码与测试同步成项目里的最新(变异之前)。
两类变异:
  · 手选(钱路径上的):BAG 一律 BUY、orderRef、带符号限价、OCA、撤单先删后撤、认领、路由、读不到不等于没有……
  · 机械生成:逐行的运算符翻转(== != < <= > >= && || + -)、true/false 互换、整数常量 +1、删掉一条语句(调用 / 赋值 / throw);
    候选太多时按固定种子抽样(MAX,默认 450)。
每个变异是一处单行改动:写进副本 → 重编 → 跑 → 记 caught / survived / build-error;finally 里还原、把文件时间往后拨几秒、重编。
中途被杀时 finally 不会跑:改动前的原文先存进 restore-<WORKER>.json,下次启动先按它还原。

  WORKER=a SHARD=0/2 python3 native/tools/mutate_broker.py      # 第 0 片(共 2 片;每片自己的 WORKER 名)
  CHECK=1 python3 native/tools/mutate_broker.py                  # 只核对手选锚点(原文在项目文件里恰好出现 nth 次),不编不跑
  LIST=1 python3 native/tools/mutate_broker.py                   # 只列出会跑的变异
  RESUME=1 …                                                     # 接着 OUT 里已有的结果往下跑
  SURVIVORS_FROM=a.json,b.json …                                  # 只跑上一轮幸存的那些(补用例之后复查)
  ONLY='子串|子串' MAX=… OUT=结果.json
"""
import json
import os
import random
import re
import shutil
import subprocess
import sys
import time
from collections import Counter

PROJECT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # IBKR-Assistant
WORK = "/Users/dafrix/Developer/ibkr/work/mut-broker"
WORKER = os.environ.get("WORKER", "a")
ROOT = os.path.join(WORK, WORKER)
NATIVE = os.path.join(ROOT, "native")
B = os.path.join(ROOT, "build")
OUT = os.environ.get("OUT", os.path.join(WORK, f"mutate_broker_{WORKER}.json"))
ENV = dict(os.environ, QT_QPA_PLATFORM="offscreen")
EXE = "engine/execution/"
FILES = ["broker.h", "broker.cpp", "broker_session.cpp", "broker_quotes.cpp", "broker_positions.cpp", "broker_orders.cpp"]
PURE, ROUTER = "tst_broker_pure", "tst_broker_scenarios"
TESTS = [PURE, ROUTER]
MAX = int(os.environ.get("MAX", "450"))

# (文件, 原文, 改成, 第几处(缺省必须恰好一处)) —— 手选
H = []


def h(f, old, new, nth=None):
    H.append((f, old, new, nth))


O, S, Q, P, R = "broker_orders.cpp", "broker_session.cpp", "broker_quotes.cpp", "broker_positions.cpp", "broker.cpp"
# ---- 下单与托管
h(O, 'order = buildOrderIntent(*parsedOrder, approved.account.account_id, signedLimit, QString(u"BUY"));', 'order = buildOrderIntent(*parsedOrder, approved.account.account_id, signedLimit, std::nullopt);')
h(O, "    order.orderRef = recordId;\n", "")
h(O, 'signedLimit = bagSignedLimit(js::str(prop(parsedOrder, u"action"_s)), optNum(prop(parsedOrder, u"lmtPrice"_s)));', 'signedLimit = optNum(prop(parsedOrder, u"lmtPrice"_s));')
h(O, "signedLimit = limitOverride;  // AUTO_MID", "signedLimit = bagSignedLimit(js::str(prop(parsedOrder, u\"action\"_s)), limitOverride);  // AUTO_MID")
h(O, "order.conditionsCancelOrder = false;", "order.conditionsCancelOrder = true;")
h(O, "order.ocaType = 1;", "order.ocaType = 2;")
h(O, 'order.outsideRth = js::isStr(st) && st->s == u"STK";', 'order.outsideRth = !(js::isStr(st) && st->s == u"STK");')
h(O, 'order.tif = u"GTC"_s;', 'order.tif = u"DAY"_s;')
h(O, 'order.action = isBag ? u"BUY"_s : itemAction;', "order.action = itemAction;")
h(O, 'order.lmtPrice = isBag ? bagSignedLimit(itemAction, optNum(prop(item, u"lmt_price"_s))) : optNum(prop(item, u"lmt_price"_s));', 'order.lmtPrice = optNum(prop(item, u"lmt_price"_s));')
h(O, "entry->order.lmtPrice = isBag ? bagSignedLimit(itemAction, lmt) : lmt;", "entry->order.lmtPrice = lmt;")
h(O, "    co_await session->cancelOrder(orderId);  // 撤单发出去了才忘掉这张单:先删再撤的话,失败后重试回 false 被当成已撤\n    hostedTrades_.remove(orderId);\n", "    hostedTrades_.remove(orderId);\n    co_await session->cancelOrder(orderId);\n")
h(O, "if (trade.orderId && *trade.orderId != 0) hostedTrades_.insert(*trade.orderId, HostedEntry{session, contract, order});", "hostedTrades_.insert(trade.orderId.value_or(0), HostedEntry{session, contract, order});", 1)
h(O, "if (trade.orderId && *trade.orderId != 0) hostedTrades_.insert(*trade.orderId, HostedEntry{session, contract, order});", "hostedTrades_.insert(trade.orderId.value_or(0), HostedEntry{session, contract, order});", 2)
h(O, "if (trade.contract.secType == u\"BAG\" && lmt) lmt = std::fabs(*lmt);", "if (trade.contract.secType == u\"BAG\" && lmt) lmt = *lmt;")
h(O, "co_await qualifyOrRaise(session, &target, true);", "co_await qualifyOrRaise(session, &target, false);")
h(O, "o.ocaType = trade.ocaType ? *trade.ocaType : 1;", "o.ocaType = trade.ocaType ? *trade.ocaType : 2;")
h(O, 'o.tif = trade.tif.isEmpty() ? u"GTC"_s : trade.tif;', "o.tif = trade.tif;")
h(O, "entry->order.orderId = orderId;", "")
h(O, 'js::isStr(priceMode) && priceMode->s == u"EXPLICIT")', 'js::isStr(priceMode) && priceMode->s != u"EXPLICIT")')
h(O, 'r.status = trade.status.isEmpty() ? u"Submitted"_s : trade.status;', "r.status = trade.status;", 1)
h(O, "if (notJsonNull(prop(item, u\"trailing_percent\"_s)) && notJsonNull(prop(item, u\"trail_stop_seed\"_s))) {", "if (notJsonNull(prop(item, u\"trailing_percent\"_s)) || notJsonNull(prop(item, u\"trail_stop_seed\"_s))) {")
h(O, "if (!trade.orderRef.startsWith(refPrefix)) continue;", "if (trade.orderRef.startsWith(refPrefix)) continue;")
h(O, "if (!session->isConnected() || !session->has(Cap::OpenTradesDetailed)) continue;", "if (!session->has(Cap::OpenTradesDetailed)) continue;")
h(O, "if (!session->isConnected()) continue;\n        for (const OpenTrade& trade", "for (const OpenTrade& trade")
# ---- 路由与会话
h(S, "if (co_await qualifyGated(session, need, kQualifyTimeoutMs, true) == QualifyAnswer::Stalled)", "if (co_await qualifyGated(session, need, kQualifyTimeoutMs, false) == QualifyAnswer::Stalled)")
h(S, "if (managed.contains(account.account_id)) {", "if (!managed.contains(account.account_id)) {")
h(S, "if (managed.isEmpty() && name == account.connection) co_return session;", "if (managed.isEmpty() && name != account.connection) co_return session;")
h(S, "conIdCache_.insert(needKeys[qsizetype(i)], *need[i]->conId);", "conIdCache_.insert(conIdKey(*need[i]), *need[i]->conId);")
h(S, "if (any && allPaper && session->has(Cap::SetBaselineMarketDataType)) {", "if ((any || allPaper) && session->has(Cap::SetBaselineMarketDataType)) {")
h(S, "    accountRoute_.clear();\n", "")
h(S, "        if (!coveredAccounts().contains(a.alias)) continue;  // TS 的 filter 回调里每个账户各算一遍\n", "")
h(S, "if (existing && existing->isConnected()) co_return existing;", "if (existing) co_return existing;")
h(S, "if (existing) co_await existing->disconnect();", "")
h(S, "if (!cached.isEmpty() && conns.contains(cached)) order.append(cached);", "")
h(S, "return exc.message() == stalledMessage() ? QualifyKnown::Stalled : QualifyKnown::No;", "return QualifyKnown::No;") if False else None
h(S, "verdict = exc.message() == stalledMessage() ? QualifyKnown::Stalled : QualifyKnown::No;", "verdict = QualifyKnown::No;")
h(S, "const int hit = conIdCache_.value(key, 0);\n    if (hit) {", "const int hit = 0;\n    if (hit) {")
h(S, "conIdCache_.insert(key, *contract->conId);", "")
h("broker.h", "static constexpr int kQuoteWaitMs = 4'000;", "static constexpr int kQuoteWaitMs = 3'000;")
h("broker.h", "static constexpr int kQualifyTimeoutMs = 12'000;", "static constexpr int kQualifyTimeoutMs = 11'000;")
h("broker.h", "static constexpr double kVolumeRetryMs = 60'000;", "static constexpr double kVolumeRetryMs = 30'000;")
h("broker.h", "static constexpr int kChainMaxWidth = 15;", "static constexpr int kChainMaxWidth = 16;")
h("broker.h", "static constexpr int kChainWaitMs = 4'000;", "static constexpr int kChainWaitMs = 3'000;")
# ---- 行情
h(Q, "for (size_t i = 0; i < subscribed; ++i) {", "for (size_t i = 0; i < opts.size(); ++i) {")
h(Q, "    if (delayedOk) session->reqMarketDataType(1);\n    if (hasOnError)", "    if (hasOnError)")
h(Q, "futuresBackoff_.insert(key, util::dateNow() + 60'000);", "futuresBackoff_.insert(key, util::dateNow() + 6'000);")
h(Q, "volumeRetry_.insert(symbol, {now + kVolumeRetryMs, u\"TWS 没有响应合约确认,稍后重试\"_s});", "volumeRetry_.insert(symbol, {now, u\"TWS 没有响应合约确认,稍后重试\"_s});")
h(Q, "session->cancelTicker(target, QString());\n    std::exception_ptr failure;", "session->cancelTicker(target);\n    std::exception_ptr failure;")
h(Q, "        session->cancelTicker(target, QString());\n    } catch (...) {\n        /* ignore */", "        session->cancelTicker(target);\n    } catch (...) {\n        /* ignore */")
h(Q, "session->cancelTicker(contract, u\"100,101,106\"_s);", "session->cancelTicker(contract);")
h(Q, "if (!resubscribed[i] && errTruthy(handles[i]->read())) {", "if (errTruthy(handles[i]->read())) {")
h(Q, "if (!legErrors.isEmpty() && anyMissing)", "if (!legErrors.isEmpty() || anyMissing)")
h(Q, "if (missing && !mdErrors->empty())", "if (missing || !mdErrors->empty())")
h(Q, "if (util::dateNow() - std::max(stream->since, stream->lastOk) > 30'000) {", "if (util::dateNow() - std::max(stream->since, stream->lastOk) > 3'000) {")
h(Q, "for (int attempt = 0; attempt < 3; ++attempt) {", "for (int attempt = 0; attempt < 2; ++attempt) {")
h(Q, "const std::optional<double> cached = co_await pollTicker(session, handle, 250);", "const std::optional<double> cached = co_await pollTicker(session, handle, 25);")
h(Q, "std::optional<double> price = co_await pollTicker(session, handle, 1200);", "std::optional<double> price = co_await pollTicker(session, handle, 1000);")
h(Q, "price = co_await pollTicker(session, delayed, 2000);", "price = co_await pollTicker(session, delayed, 1000);")
h(Q, "co_await session->settle(fresh ? 1500 : 150);", "co_await session->settle(fresh ? 1500 : 100);")
h(Q, "const QString fetchEnd = end >= todayIso ? end : todayIso;", "const QString fetchEnd = end;")
h(Q, "if (bars.bars.size() <= domain::kMinBars", "if (bars.bars.size() < domain::kMinBars") if False else None
h(Q, "if (static_cast<int>(bars.bars.size()) <= domain::kMinBars &&", "if (static_cast<int>(bars.bars.size()) < domain::kMinBars &&")
h(Q, "const bool overnight = !rth && !daily && !cfg;", "const bool overnight = !daily && !cfg;")
h(Q, "const bool stale = entry.session != session || !entry.session->isConnected();", "const bool stale = !entry.session->isConnected();")
h(Q, "if (cfg && !cfg->futures.isEmpty()) {\n        const domain::EtNow now = domain::nowEt();", "if (cfg) {\n        const domain::EtNow now = domain::nowEt();")
# ---- 持仓
h(P, "if (static_cast<qsizetype>(sessions().size()) < connectionsMap_.size()) return;", "if (static_cast<qsizetype>(sessions().size()) <= connectionsMap_.size()) return;")
h(P, "if (!account.isEmpty()) {\n            // 券商报了账号", "if (account.isEmpty()) {\n            // 券商报了账号")
h(P, "if (failure) throw BrokerError(u\"读不到持仓:%1\"_s.arg(messageOf(failure)));", "if (false) throw BrokerError(u\"读不到持仓:%1\"_s.arg(messageOf(failure)));")
h(P, "row->set(u\"market_value\"_s, mv == 0 ? js::Null() : js::N(mv));", "row->set(u\"market_value\"_s, js::N(mv));")
h(P, "const std::optional<double> bid = t.bid == 0 ? std::optional<double>(0) : cleanPrice(t.bid);", "const std::optional<double> bid = cleanPrice(t.bid);")
h(P, "if (bid && ask && *ask >= *bid) {\n            row.set", "if (bid && ask && *ask > *bid) {\n            row.set")
h(P, "if (out.contains(js::str(prop(*row, u\"key\"_s)))) continue;  // portfolio 更准", "if (false) continue;") if False else None
h(P, "if (!row || out.contains(js::str(prop(*row, u\"key\"_s)))) continue;  // portfolio 更准", "if (!row) continue;")
h(P, "if (it == hoursCache_.cend() || it.value()[0] != domain::nowEt().date) return std::nullopt;", "if (it == hoursCache_.cend()) return std::nullopt;")
h(P, "hit.value()[0] == today) {", "true) {")
h(P, "if (paper) session->reqMarketDataType(3);\n    std::exception_ptr failure;\n    try {\n        static const OJson emptyObj", "std::exception_ptr failure;\n    try {\n        static const OJson emptyObj")
h(P, "if (!(a && a->is_paper)) {\n            paper = false;\n            break;\n        }\n    }\n    if (paper) session->reqMarketDataType(3);\n    std::exception_ptr failure;\n    try {\n        static", "if (!(a && a->is_paper)) {\n            paper = true;\n            break;\n        }\n    }\n    if (paper) session->reqMarketDataType(3);\n    std::exception_ptr failure;\n    try {\n        static")
h(P, "if (!session->has(Cap::Executions)) continue;", "")
h(P, "if (row && !out.contains(js::str(prop(*row, u\"exec_id\"_s)))) out.insert", "if (row) out.insert")
h(P, "if (!js::truthy(prop(r, u\"quantity\"_s))) continue;", "") if False else None
h(R, 'if (action == u"BUY" && netMid <= 0) {', 'if (action == u"BUY" && netMid < 0) {')
h(R, 'return action == u"SELL" ? -*userLimit : *userLimit;', 'return action == u"BUY" ? -*userLimit : *userLimit;')
h(R, "if (slippage < 0) throw", "if (slippage <= 0) throw")
h(R, "limit = util::jsmath::min(limit, alignTickDown(*strikeWidthValue, tick));", "limit = util::jsmath::max(limit, alignTickDown(*strikeWidthValue, tick));")
h(R, "} else if (limit >= 0) {", "} else if (limit > 0) {")
h(R, "if (limitIsNull) throw BrokerError", "if (false) throw BrokerError")
h(R, "base.outsideRth = js::truthy(prop(spec, u\"outsideRth\"_s));", "base.outsideRth = false;")
h(R, "base.tif = js::str(prop(spec, u\"tif\"_s));", "base.tif = u\"DAY\"_s;")
h(R, "base.transmit = true;", "base.transmit = false;")
h(R, "if (legs.size() == 2) return std::fabs", "if (legs.size() == 2) return (")
h(R, "if (settings.isTradingDay(now.date) && now.seconds >= closeOf(now.date) * 60)", "if (settings.isTradingDay(now.date) && now.seconds > closeOf(now.date) * 60)")
h(R, "const auto closeOf = [&](const QString& d) { return settings.early_close_days.contains(d) ? 13 * 60 : 16 * 60; };", "const auto closeOf = [&](const QString& d) { return settings.early_close_days.contains(d) ? 12 * 60 : 16 * 60; };")
h(R, "for (int i = 0; i < 14; ++i) {", "for (int i = 0; i < 13; ++i) {")
h(R, "if (digits.match(s).hasMatch() && s.size() != 8) return", "if (digits.match(s).hasMatch() && s.size() != 9) return")
h(R, "return util::jsStringToNumber(s) * 1000;", "return util::jsStringToNumber(s);")
H = [x for x in H if x is not None]

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
    return TESTS if m["file"] in ("broker.cpp", "broker.h") else [ROUTER]


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
    r = sh(["rsync", "-a", "--delete", "--exclude=.vscode", "--exclude=build*", os.path.join(PROJECT, "native") + "/", NATIVE + "/"])
    if r.returncode != 0:
        raise SystemExit("rsync failed: " + r.stderr)
    for f in FILES:  # rsync 会把时间戳改回项目里的(比上次编出来的旧):不拨一下 ninja 会拿上次变异的目标文件当最新
        bump(os.path.join(NATIVE, EXE, f))
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
            results.append([m["kind"], m["file"], describe(m), res])
            print(res, m["kind"], m["file"], describe(m), flush=True)
            with open(OUT, "w", encoding="utf-8") as fh:
                json.dump(results, fh, ensure_ascii=False, indent=1)
    finally:
        build(TESTS)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(results, fh, ensure_ascii=False, indent=1)
    print(dict(Counter(r[3] for r in results)), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
