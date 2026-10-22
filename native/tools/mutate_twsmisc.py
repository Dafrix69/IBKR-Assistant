#!/usr/bin/env python3
"""twsmisc 这一簇(ib_contracts / ib_exec_history / tws_detect)的变异检验。

每个变异是一处单行改动:写进去 → 重编那个测试 → 跑 → 记 caught / survived;finally 里还原、把文件时间往后拨几秒
(ninja 按秒比时间戳)、重编。最后再把三个测试各重编一遍,保证留下的二进制是原样代码编的。

  python3 native/tools/mutate_twsmisc.py                 # 全部
  ONLY='子串|子串' python3 native/tools/mutate_twsmisc.py  # 只跑 old 里含这些子串的
  MUT_ROOT=私有拷贝目录(默认 ~/Developer/ibkr/work/mut-twsmisc)  BUILD=编译目录(默认 MUT_ROOT/build)  OUT=结果.json

每次启动先把项目里的 native/(不含大夹具)同步进 MUT_ROOT 下的拷贝(只增改,不删),变异与重编都在拷贝里;
项目里的源码不动。中途被杀(重启、kill -9)时 finally 不会跑:改动前的原文先存进拷贝里的 .restore.json,下次启动先按它还原。
同步只用 rsync -a(不带 --delete),也不跟符号链接出去。
"""
import json
import os
import subprocess
import sys
import time
from collections import Counter

SRC_NATIVE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 项目里的 native/(只读,绝不改)
SRC_REPO = os.path.dirname(SRC_NATIVE)
# 变异只在私有拷贝里做:项目里的源码从头到尾不被碰,杀在半路也不会留下变异
WORK = os.environ.get("MUT_ROOT", "/Users/dafrix/Developer/ibkr/work/mut-twsmisc")
ROOT = os.path.join(WORK, "IBKR-Assistant", "native")
B = os.environ.get("BUILD", os.path.join(WORK, "build"))
OUT = os.environ.get("OUT", os.path.join(WORK, "mutate_twsmisc.json"))
ENV = dict(os.environ, QT_QPA_PLATFORM="offscreen")
E = os.path.join(ROOT, "engine", "execution") + "/"
C, H, T = "tst_ib_contracts", "tst_ib_exec_history", "tst_tws_detect"

# (文件, 测试, 原文, 改成) —— 原文在文件里必须恰好出现一次
M = [
    # ---- ib_contracts.cpp
    ("ib_contracts.cpp", C, "const double firstFriday = 1 + std::fmod(4 - wd + 7, 7);", "const double firstFriday = 1 + std::fmod(4 - wd + 6, 7);"),
    ("ib_contracts.cpp", C, "thirdFriday(year, month) > dateStr", "thirdFriday(year, month) >= dateStr"),
    ("ib_contracts.cpp", C, "std::fmod(month, 3) == 0 &&", "std::fmod(month, 3) == 1 &&"),
    ("ib_contracts.cpp", C, "for (int i = 0; i < 8; i += 1) {", "for (int i = 0; i < 7; i += 1) {"),
    ("ib_contracts.cpp", C, 'c.exchange = cfg.futures_exchange.isEmpty() ? u"CME"_s : cfg.futures_exchange;', "c.exchange = cfg.futures_exchange;"),
    ("ib_contracts.cpp", C, '{2,10})\\\\z"_s', '{2,11})\\\\z"_s'),
    ("ib_contracts.cpp", C, "{1,12})@([A-Z]{2,12})", "{1,13})@([A-Z]{2,12})"),
    ("ib_contracts.cpp", C, "if (name == upper) return 0;", "if (name == upper) return 1;"),
    ("ib_contracts.cpp", C, "if (cfg && name == cfg->monthly_trading_class) return 1;", "if (cfg && name == cfg->monthly_trading_class) return 2;"),
    ("ib_contracts.cpp", C, "if (!prefer.isEmpty() && onExpiry.contains(prefer)) return prefer;", "if (onExpiry.contains(prefer)) return prefer;"),
    ("ib_contracts.cpp", C, "static_cast<double>(expiriesOf(byClass, b).size()) - static_cast<double>(expiriesOf(byClass, a).size());",
     "static_cast<double>(expiriesOf(byClass, a).size()) - static_cast<double>(expiriesOf(byClass, b).size());"),
    ("ib_contracts.cpp", C, "return n != 0 ? n : util::localeCompare(a, b);", "return n != 0 ? n : util::localeCompare(b, a);"),
    ("ib_contracts.cpp", C, "if (std::abs(q - util::jsRound(q)) < 1e-6) return step;", "if (std::abs(q - util::jsRound(q)) < 1e-5) return step;"),
    ("ib_contracts.cpp", C, "for (const double m : {5.0, 2.5, 1.0})", "for (const double m : {5.0, 2.0, 1.0})"),
    ("ib_contracts.cpp", C, "if (std::isfinite(k) && k > 0 && std::find", "if (std::isfinite(k) && k >= 0 && std::find"),
    ("ib_contracts.cpp", C, "if (dist(sorted[i]) < dist(sorted[nearest])) nearest = i;", "if (dist(sorted[i]) <= dist(sorted[nearest])) nearest = i;"),
    ("ib_contracts.cpp", C, "jsSlice(sorted, util::jsmath::max(0, near - width), near + width + 1);", "jsSlice(sorted, util::jsmath::max(0, near - width), near + width);"),
    ("ib_contracts.cpp", C, "if (!span || !(*span > 0)) return plain;", "if (!span || *span < 0) return plain;"),
    ("ib_contracts.cpp", C, "if (dist(k) <= *span) wanted.push_back(k);", "if (dist(k) < *span) wanted.push_back(k);"),
    ("ib_contracts.cpp", C, "if (covered(wFirst) && covered(wLast)) return plain;", "if (covered(wFirst) || covered(wLast)) return plain;"),
    ("ib_contracts.cpp", C, "const double budget = 2 * width + 1;", "const double budget = 2 * width;"),
    ("ib_contracts.cpp", C, "return k == atm ? -1 : dist(k) / strikeRoundness(k);", "return k == atm ? 0 : dist(k) / strikeRoundness(k);"),
    ("ib_contracts.cpp", C, "if (r != 0 && !std::isnan(r)) return r;", "if (r != 0) return r;"),
    ("ib_contracts.cpp", C, "if (d != 0 && !std::isnan(d)) return d;", "if (d != 0) return d;"),
    ("ib_contracts.cpp", C, "if (contract.strike && *contract.strike != 0 && !std::isnan(*contract.strike))", "if (contract.strike && !std::isnan(*contract.strike))"),
    ("ib_contracts.cpp", C, 'QStringList parts{contract.symbol.isEmpty() ? u"?"_s : contract.symbol,', "QStringList parts{contract.symbol,"),
    # ---- ib_exec_history.cpp
    ("ib_exec_history.cpp", H, "constexpr double kInManagedAccts = 15;", "constexpr double kInManagedAccts = 14;"),
    ("ib_exec_history.cpp", H, "constexpr double kInExecutionDataEnd = 55;", "constexpr double kInExecutionDataEnd = 56;"),
    ("ib_exec_history.cpp", H, "constexpr quint32 kFrameMax = 16 * 1024 * 1024;", "constexpr quint32 kFrameMax = 16 * 1024 * 1024 + 1;"),
    ("ib_exec_history.cpp", H, "constexpr qsizetype kExecutionFieldsMin = 27;", "constexpr qsizetype kExecutionFieldsMin = 26;"),
    ("ib_exec_history.cpp", H, "if (buffer.size() - at - 4 < static_cast<qsizetype>(size)) break;", "if (buffer.size() - at - 4 <= static_cast<qsizetype>(size)) break;"),
    ("ib_exec_history.cpp", H, "if (fields.last().isEmpty()) fields.removeLast();", "if (false) fields.removeLast();"),
    ("ib_exec_history.cpp", H, 'if (right == u"C" || right == u"P")', 'if (right == u"C")'),
    ("ib_exec_history.cpp", H, "return std::isfinite(n) ? n : 0;", "return n;"),
    ("ib_exec_history.cpp", H, "days_(util::jsmath::min(kHistoryDaysMax, util::jsmath::max(1, std::trunc(days)))),", "days_(util::jsmath::min(kHistoryDaysMax, util::jsmath::max(1, days))),"),
    ("ib_exec_history.cpp", H, "if (!std::isfinite(serverVersion_) || serverVersion_ < kHistoryMinVersion)", "if (!std::isfinite(serverVersion_) || serverVersion_ <= kHistoryMinVersion)"),
    ("ib_exec_history.cpp", H, "if (serverVersion_ < kHistoryMaxVersion) return succeed(false);", "if (serverVersion_ <= kHistoryMaxVersion) return succeed(false);"),
    ("ib_exec_history.cpp", H, "if ((id == kInNextValidId || id == kInManagedAccts) && !asked_) {", "if ((id == kInNextValidId || id == kInManagedAccts)) {"),
    ("ib_exec_history.cpp", H, "if (got->reqId == reqId) details_.push_back(got->detail);", "details_.push_back(got->detail);"),
    ("ib_exec_history.cpp", H, "if (numberAt(fields, 2) == reqId) succeed(true);", "succeed(true);"),
    ("ib_exec_history.cpp", H, "if (numberAt(fields, 1) == reqId) return fail(", "if (numberAt(fields, 1) != reqId) return fail("),
    ("ib_exec_history.cpp", H, "if (!(code >= 2100 && code < 2200)) notice_ = text;", "if (!(code > 2100 && code < 2200)) notice_ = text;"),
    ("ib_exec_history.cpp", H, "util::jsTrim(fields.value(2) + u' ' + fields.value(3)).left(200);", "util::jsTrim(fields.value(2) + u' ' + fields.value(3)).left(201);"),
    ("ib_exec_history.cpp", H, "fields.join(u' ').left(80)", "fields.join(u' ').left(79)"),
    ("ib_exec_history.cpp", H, "util::jsRound(timeoutMs_ / 1000)", "std::trunc(timeoutMs_ / 1000)"),
    ("ib_exec_history.cpp", H, "const SplitFrames cut = splitFrames(pending_.size() ? pending_ + chunk : chunk);", "const SplitFrames cut = splitFrames(chunk);"),
    ("ib_exec_history.cpp", H, "if (!(ms >= 1 && ms <= 2147483647.0)) return 1;", "if (!(ms >= 1)) return 1;"),
    ("ib_exec_history.cpp", H, "return std::trunc(ms);", "return ms + 0.5;"),
    ("ib_exec_history.cpp", H, "const bool ok = std::isfinite(port) && port >= 0 && port <= 0xFFFF && std::trunc(port) == port;", "const bool ok = std::isfinite(port) && port >= 0 && port <= 0xFFFF;"),
    # ---- tws_detect.cpp
    # 端口排序走共享的 util::market::jsSort(V8 的走法):比较函数反过来、换成 std::sort(NaN 的次序看算法)
    ("tws_detect.cpp", T, "util::market::jsSort(ports, [](double a, double b) { return a - b; });", "util::market::jsSort(ports, [](double a, double b) { return b - a; });"),
    ("tws_detect.cpp", T, "util::market::jsSort(ports, [](double a, double b) { return a - b; });", "std::sort(ports.begin(), ports.end(), [](double a, double b) { return a - b < 0; });"),
    ("tws_detect.cpp", T, "if (!found && !objectProtoNames().contains(connectionName))", "if (!found)"),
    ("tws_detect.cpp", T, "if (err->code >= 500 && err->code < 600)", "if (err->code >= 500 && err->code < 599)"),
    ("tws_detect.cpp", T, "if (err->code >= 500 && err->code < 600)", "if (err->code > 500 && err->code < 600)"),
    ("tws_detect.cpp", T, "if (v < tws::kMinVersion || v > tws::kMainMaxVersion) return reject(", "if (v < tws::kMinVersion) return reject("),
    ("tws_detect.cpp", T, "if (v < tws::kMinVersion || v > tws::kMainMaxVersion) return reject(", "if (v < tws::kMinVersion || v >= tws::kMainMaxVersion) return reject("),
    ("tws_detect.cpp", T, "if (buffer_.size() > 0xffffff) {", "if (false) {"),
    ("tws_detect.cpp", T, "if (buffer_.size() > 0xffffff) {", "if (buffer_.size() >= 0xffffff) {"),
    ("tws_detect.cpp", T, "if (text.contains(code)) return {text.isEmpty() ? name : text, hint, code};", "if (text.contains(code)) return {text, hint, code};"),
    ("tws_detect.cpp", T, 'if (exc.code == u"ECONNREFUSED" || lowered.contains(u"refused"))', 'if (exc.code == u"ECONNREFUSED")'),
    ("tws_detect.cpp", T, 'if (lowered.contains(u"timeout") || name.toLower().contains(u"timeout")) {', 'if (lowered.contains(u"timeout")) {'),
    ("tws_detect.cpp", T, "const QString name = exc.name.isEmpty() ? exc.ctorName : exc.name;", "const QString name = exc.name;"),
    ("tws_detect.cpp", T, "if (!pattern) return false;\n    try {", "try {"),
    ("tws_detect.cpp", T, "return proc.status == 0 && !util::jsTrim(proc.stdoutText).isEmpty();", "return proc.status == 0;"),
    ("tws_detect.cpp", T, 'if (!asciiContainsI(pathBasename(p), u"uninstall"_s))', 'if (!pathBasename(p).contains(u"uninstall"_s))'),
    ("tws_detect.cpp", T, "app.paths = found.mid(0, 5);", "app.paths = found.mid(0, 4);"),
    ("tws_detect.cpp", T, "if (sys.existsSync(m)) out.append(m);", "out.append(m);"),
    ("tws_detect.cpp", T, "std::sort(out.begin(), out.end());\n        return out;\n    } catch", "return out;\n    } catch"),
    ("tws_detect.cpp", T, 'if (sys.platform != u"darwin" && !kWin) throw', 'if (sys.platform != u"darwin") throw'),
    ("tws_detect.cpp", T, "if (proc.status != 0) {\n                const QString err", "if (proc.status.value_or(0) != 0) {\n                const QString err"),
    ("tws_detect.cpp", T, "if (name.startsWith(u'.') && !seg.startsWith(u'.')) continue;", "if (false) continue;"),
    ("tws_detect.cpp", T, "if (!has) entries.push_back(", "if (true) entries.push_back("),
    ("tws_detect.cpp", T, "if (!probe.open) {\n        ConnectErrorInfo err;", "if (false) {\n        ConnectErrorInfo err;"),
    ("tws_detect.cpp", T, '(cfg ? cfg->client_id : std::nan("")) + 90', '(cfg ? cfg->client_id : std::nan("")) + 91'),
    ("tws_detect.cpp", T, "options.timeoutMs.value_or(8000)", "options.timeoutMs.value_or(8001)"),
    ("tws_detect.cpp", T, "if (!r.resolved && r.connection == connectionName) missing.append(r.alias);", "if (!r.resolved) missing.append(r.alias);"),
    ("tws_detect.cpp", T, "std::sort(unmapped.begin(), unmapped.end());", "(void)unmapped;"),
    ("tws_detect.cpp", T, "if (connectionName && account.connection != *connectionName) continue;", "if (false) continue;"),
    ("tws_detect.cpp", T, 'if (ports.isEmpty()) ports = u"7497"_s;', "(void)ports;"),
]

ONLY = [x for x in os.environ.get("ONLY", "").split("|") if x]
if ONLY:
    M = [m for m in M if any(o in m[2] for o in ONLY)]


def build(test):
    """编一个测试;iCloud 读超时就再试几次(不是代码的错)。"""
    for _ in range(4):
        b = subprocess.run(["cmake", "--build", B, "--target", test, "-j4"], capture_output=True, text=True)
        if b.returncode == 0:
            return True
        if "Operation timed out" not in b.stdout + b.stderr:
            return False
        time.sleep(5)
    return False


def run(test):
    r = subprocess.run([os.path.join(B, "tests", test)], capture_output=True, text=True, env=ENV, timeout=600)
    return r.returncode == 0


def bump(path):
    t = time.time() + 3
    os.utime(path, (t, t))


JOURNAL = os.path.join(WORK, ".mutate_twsmisc.restore.json")


def recover():
    """上次被杀在半路:把记下的原文写回去"""
    if not os.path.exists(JOURNAL):
        return
    with open(JOURNAL, encoding="utf-8") as fh:
        j = json.load(fh)
    with open(j["path"], "w", encoding="utf-8") as fh:
        fh.write(j["orig"])
    bump(j["path"])
    os.remove(JOURNAL)
    print("recovered", j["path"], flush=True)


def sync():
    """项目 native/ → 私有拷贝(夹具只带这一簇要的三份;engine-ts 的契约类型目录是测试要读的);再配置一次编译目录"""
    os.makedirs(os.path.dirname(ROOT), exist_ok=True)
    fx = "tests/fixtures/"
    subprocess.run(["rsync", "-a", "--no-links", "--exclude=.git", "--exclude=.vscode", "--exclude=.claude", "--exclude=build*", "--exclude=" + fx + "*.json",
                    "--exclude=" + fx + "ssr", SRC_NATIVE + "/", ROOT + "/"], check=True)
    for f in ("ib_contracts.json", "ib_exec_history.json", "tws_detect.json"):
        subprocess.run(["cp", "-p", os.path.join(SRC_NATIVE, fx, f), os.path.join(ROOT, fx, f)], check=True)
    contract_dst = os.path.join(os.path.dirname(ROOT), "engine-ts", "src")
    os.makedirs(contract_dst, exist_ok=True)
    subprocess.run(["rsync", "-a", "--no-links", os.path.join(SRC_REPO, "engine-ts", "src", "contract"), contract_dst + "/"], check=True)
    r = subprocess.run(["cmake", "-S", ROOT, "-B", B, "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Debug", "-DCMAKE_PREFIX_PATH=/opt/homebrew",
                        "-DCMAKE_MAKE_PROGRAM=/opt/homebrew/bin/ninja",
                        "-DCMAKE_C_COMPILER=/Library/Developer/CommandLineTools/usr/bin/clang",
                        "-DCMAKE_CXX_COMPILER=/Library/Developer/CommandLineTools/usr/bin/clang++",
                        "-DCMAKE_OSX_SYSROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk", "-DIBKR_BUILD_UI=OFF"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit("cmake 配置失败:\n" + r.stdout[-2000:] + r.stderr[-2000:])


def main():
    os.makedirs(WORK, exist_ok=True)
    recover()
    sync()
    results = []
    try:
        for f, test, old, new in M:
            path = E + f
            orig = open(path, encoding="utf-8").read()
            n = orig.count(old)
            if n != 1:
                results.append([f, old, new, f"bad-anchor({n})"])
                print(f"bad-anchor({n})", f, old[:80], flush=True)
                continue
            with open(JOURNAL, "w", encoding="utf-8") as fh:
                json.dump({"path": path, "orig": orig}, fh, ensure_ascii=False)
            try:
                with open(path, "w", encoding="utf-8") as fh:
                    fh.write(orig.replace(old, new))
                bump(path)
                res = ("survived" if run(test) else "caught") if build(test) else "build-error"
            finally:
                with open(path, "w", encoding="utf-8") as fh:
                    fh.write(orig)
                bump(path)
                os.remove(JOURNAL)
                build(test)
            results.append([f, old, new, res])
            print(res, f, old.replace("\n", " ")[:90], flush=True)
    finally:
        for t in (C, H, T):
            build(t)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(results, fh, ensure_ascii=False, indent=1)
    print(dict(Counter(r[3] for r in results)), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
