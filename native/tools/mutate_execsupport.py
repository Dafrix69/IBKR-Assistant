#!/usr/bin/env python3
"""execsupport 簇(broker_pricing / auto_mid / account_feeds / qualify_gate / ib_link / held_streams / option_marks / ib_bars)的变异检验。

只在私有副本里做,绝不动项目里的源码(别的助手、验收、审查随时在编项目,会把变异编进去):
  WORKER=<名字> 每个 worker 一份副本 ~/Developer/ibkr/work/mut-execsupport/<名字>/{native, build, desktop/engine-ts/docs/prompts 的符号链接}。
  首次运行(或 SETUP=1)先 rsync 一份 native/ 过去、配置编译目录;之后每次启动也把副本里的源码与测试同步成项目里的最新(变异之前)。
每个变异是一处单行改动:写进副本 → 重编那个测试 → 跑 → 记 caught / survived;finally 里还原、把文件时间往后拨几秒
(ninja 按秒比时间戳)、重编。最后把各测试再重编一遍,保证留下的二进制是原样代码编的。

  WORKER=a python3 native/tools/mutate_execsupport.py              # 跑这个 worker 分到的那些文件
  CHECK=1 python3 native/tools/mutate_execsupport.py               # 只核对锚点(每个原文在项目文件里恰好出现一次),不编不跑
  FILES='held_streams.cpp|option_marks.cpp' ONLY='子串|子串' …      # 再筛
  OUT=结果.json

中途被杀(重启、kill -9)时 finally 不会跑:改动前的原文先存进副本旁的 restore.json,下次启动先按它还原。
"""
import json
import os
import shutil
import subprocess
import sys
import time
from collections import Counter

PROJECT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # IBKR-Assistant
WORK = "/Users/dafrix/Developer/ibkr/work/mut-execsupport"
WORKER = os.environ.get("WORKER", "a")
ROOT = os.path.join(WORK, WORKER)
NATIVE = os.path.join(ROOT, "native")
B = os.path.join(ROOT, "build")
OUT = os.environ.get("OUT", os.path.join(ROOT, "mutate_execsupport.json"))
ENV = dict(os.environ, QT_QPA_PLATFORM="offscreen")
EXE = "engine/execution/"

# 测试名
Q, L, A, M_, H, O, K, BR = ("tst_qualify_gate", "tst_ib_link", "tst_account_feeds", "tst_auto_mid", "tst_held_streams", "tst_option_marks", "tst_ib_bars", None)
BP = M_  # broker_pricing 与 auto_mid 同一个测试

# (文件相对 native/engine/execution/, 测试, 原文, 改成) —— 原文在文件里必须恰好出现一次
MUTANTS = [
    # ================================================================ broker_pricing.cpp
    ("broker_pricing.cpp", M_, "!std::isfinite(leg.bid) || !std::isfinite(leg.ask) || leg.bid <= 0", "!std::isfinite(leg.bid) && !std::isfinite(leg.ask) || leg.bid <= 0"),
    ("broker_pricing.cpp", M_, "!std::isfinite(leg.bid) ||", "false ||"),
    ("broker_pricing.cpp", M_, "|| !std::isfinite(leg.ask) ||", "|| false ||"),
    ("broker_pricing.cpp", M_, "leg.bid <= 0 ||", "leg.bid < 0 ||"),
    ("broker_pricing.cpp", M_, "leg.ask <= 0 ||", "leg.ask < 0 ||"),
    ("broker_pricing.cpp", M_, "leg.ask < leg.bid)", "leg.ask <= leg.bid)"),
    ("broker_pricing.cpp", M_, "return (leg.bid + leg.ask) / 2.0;", "return (leg.bid + leg.ask) / 3.0;"),
    ("broker_pricing.cpp", M_, "return v == std::trunc(v) ?", "return v != std::trunc(v) ?"),
    ("broker_pricing.cpp", M_, 'return v > 0 ? u"inf"_s : u"-inf"_s;', 'return v < 0 ? u"inf"_s : u"-inf"_s;'),
    ("broker_pricing.cpp", M_, 'if (std::isnan(v)) return u"nan"_s;', 'if (false) return u"nan"_s;'),
    ("broker_pricing.cpp", M_, 'if (legs.empty()) throw BrokerError(u"没有腿报价,无法计算中间价"_s);', 'if (false) throw BrokerError(u"没有腿报价,无法计算中间价"_s);'),
    ("broker_pricing.cpp", M_, 'const double sign = leg.action == u"BUY" ? 1.0 : -1.0;', 'const double sign = leg.action != u"BUY" ? 1.0 : -1.0;'),
    ("broker_pricing.cpp", M_, "net += sign * legMid(leg) * leg.ratio;", "net += sign * legMid(leg);"),
    ("broker_pricing.cpp", M_, "return util::pyRound(net, 4);", "return util::pyRound(net, 3);"),
    ("broker_pricing.cpp", M_, "tick <= 0 || !std::isfinite(tick)) return value;\n    // 减一点容差", "tick < 0 || !std::isfinite(tick)) return value;\n    // 减一点容差"),
    ("broker_pricing.cpp", M_, "tick <= 0 || !std::isfinite(tick)) return value;\n    return util::pyRound(std::floor", "tick < 0 || !std::isfinite(tick)) return value;\n    return util::pyRound(std::floor"),
    ("broker_pricing.cpp", M_, "if (!std::isfinite(value) || tick <= 0 || !std::isfinite(tick)) return value;\n    // 减一点容差", "if (!std::isfinite(value) && tick <= 0 || !std::isfinite(tick)) return value;\n    // 减一点容差"),
    ("broker_pricing.cpp", M_, "std::ceil(value / tick - 1e-9)", "std::ceil(value / tick + 1e-9)"),
    ("broker_pricing.cpp", M_, "std::ceil(value / tick - 1e-9)", "std::floor(value / tick - 1e-9)"),
    ("broker_pricing.cpp", M_, "std::floor(value / tick + 1e-9)", "std::floor(value / tick - 1e-9)"),
    ("broker_pricing.cpp", M_, "std::floor(value / tick + 1e-9)", "std::ceil(value / tick + 1e-9)"),
    ("broker_pricing.cpp", M_, "return util::pyRound(std::ceil(value / tick - 1e-9) * tick, 4);", "return util::pyRound(std::ceil(value / tick - 1e-9) * tick, 5);"),
    ("broker_pricing.cpp", M_, "return util::pyRound(std::floor(value / tick + 1e-9) * tick, 4);", "return util::pyRound(std::floor(value / tick + 1e-9) * tick, 3);"),
    ("broker_pricing.h", M_, "inline constexpr double kDefaultComboTick = 0.05;", "inline constexpr double kDefaultComboTick = 0.01;"),
    # ================================================================ auto_mid.cpp
    ("auto_mid.cpp", M_, 'if (legs.empty()) throw BrokerError(u"没有腿报价,无法计算立刻成交的价"_s);', 'if (false) throw BrokerError(u"没有腿报价,无法计算立刻成交的价"_s);'),
    ("auto_mid.cpp", M_, "legMid(leg);  // 坏盘口(缺一边、倒挂)在这里抛,和中间价同一道守卫", "// legMid(leg);"),
    ("auto_mid.cpp", M_, 'net += leg.action == u"BUY" ? leg.ask * leg.ratio', 'net += leg.action != u"BUY" ? leg.ask * leg.ratio'),
    ("auto_mid.cpp", M_, "leg.ask * leg.ratio : -leg.bid * leg.ratio;", "leg.bid * leg.ratio : -leg.ask * leg.ratio;"),
    ("auto_mid.cpp", M_, "leg.ask * leg.ratio : -leg.bid * leg.ratio;", "leg.ask : -leg.bid * leg.ratio;"),
    ("auto_mid.cpp", M_, "leg.ask * leg.ratio : -leg.bid * leg.ratio;", "leg.ask * leg.ratio : -leg.bid;"),
    ("auto_mid.cpp", M_, "return util::pyRound(net, 4);", "return util::pyRound(net, 3);"),
    ("auto_mid.cpp", M_, "if (!(share >= 0 && share <= 1))", "if (!(share > 0 && share <= 1))"),
    ("auto_mid.cpp", M_, "if (!(share >= 0 && share <= 1))", "if (!(share >= 0 && share < 1))"),
    ("auto_mid.cpp", M_, "if (!(share >= 0 && share <= 1))", "if (share < 0 || share > 1)"),
    ("auto_mid.cpp", M_, "让价的份额要在 0 到 1 之间(收到 %1)", "让价的份额要在 0 到 2 之间(收到 %1)"),
    ("auto_mid.cpp", M_, 'action == u"SELL" && mid >= 0', 'action == u"SELL" && mid > 0'),
    ("auto_mid.cpp", M_, 'action == u"BUY" && mid <= 0', 'action == u"BUY" && mid < 0'),
    ("auto_mid.cpp", M_, 'action == u"SELL" && mid >= 0', 'action != u"SELL" && mid >= 0'),
    ("auto_mid.cpp", M_, 'action == u"BUY" && mid <= 0', 'action != u"BUY" && mid <= 0'),
    ("auto_mid.cpp", M_, "mid + share * (natural - mid)", "mid + share * (mid - natural)"),
    ("auto_mid.cpp", M_, "mid + share * (natural - mid)", "natural + share * (natural - mid)"),
    ("auto_mid.cpp", M_, "alignTickUp(mid + share * (natural - mid), tick)", "alignTickDown(mid + share * (natural - mid), tick)"),
    ("auto_mid.cpp", M_, "alignTickUp(mid + share * (natural - mid), tick)", "alignTickUp(mid + share * (natural - mid))"),
    ("auto_mid.cpp", M_, "if (strikeWidth) limit =", "if (false) limit ="),
    ("auto_mid.cpp", M_, "alignTickDown(*strikeWidth, tick)", "alignTickUp(*strikeWidth, tick)"),
    ("auto_mid.cpp", M_, "alignTickDown(*strikeWidth, tick)", "alignTickDown(*strikeWidth)"),
    ("auto_mid.cpp", M_, "util::jsmath::min(limit,", "std::min(limit,"),
    ("auto_mid.cpp", M_, "if (limit <= 0) throw", "if (limit < 0) throw"),
    ("auto_mid.cpp", M_, "} else if (limit >= 0) {", "} else if (limit > 0) {"),
    ("auto_mid.cpp", M_, "return util::pyRound(limit, 4);", "return util::pyRound(limit, 3);"),
    ("auto_mid.cpp", M_, "非正,拒绝下单\"_s.arg(util::fmtF(limit, 4))", "非正,拒绝下单\"_s.arg(util::fmtF(limit, 3))"),
    # ================================================================ account_feeds.cpp
    ("account_feeds.cpp", A, "if (s->isConnected() && s->managedAccounts().contains(accountId))", "if (s->isConnected() || s->managedAccounts().contains(accountId))"),
    ("account_feeds.cpp", A, "if (s->isConnected() && s->managedAccounts().contains(accountId))", "if (s->managedAccounts().contains(accountId))"),
    ("account_feeds.cpp", A, "if (!session || !session->has(Cap::AccountPnl)) return std::nullopt;", "if (!session) return std::nullopt;"),
    ("account_feeds.cpp", A, "if (!session || !session->has(Cap::NetLiquidation)) return std::nullopt;", "if (!session) return std::nullopt;"),
    ("account_feeds.cpp", A, "if (!pnl || !pnl->daily || pnl->currency != u\"USD\") return std::nullopt;", "if (!pnl || pnl->currency != u\"USD\") return std::nullopt;"),
    ("account_feeds.cpp", A, "if (!pnl || !pnl->daily || pnl->currency != u\"USD\") return std::nullopt;", "if (!pnl || !pnl->daily) return std::nullopt;"),
    ("account_feeds.cpp", A, "if (!pnl || !pnl->daily || pnl->currency != u\"USD\") return std::nullopt;", "if (!pnl || !pnl->daily || pnl->currency == u\"USD\") return std::nullopt;"),
    ("account_feeds.cpp", A, "nowMs - pnl->atMs > kPnlStaleMs", "nowMs - pnl->atMs >= kPnlStaleMs"),
    ("account_feeds.cpp", A, "nowMs - pnl->atMs > kPnlStaleMs", "pnl->atMs - nowMs > kPnlStaleMs"),
    ("account_feeds.cpp", A, "? std::nullopt : pnl->daily;", "? pnl->daily : std::nullopt;"),
    ("account_feeds.cpp", A, "value->currency == u\"USD\" && value->amount > 0", "value->currency == u\"USD\" && value->amount >= 0"),
    ("account_feeds.cpp", A, "value->currency == u\"USD\" && value->amount > 0", "value->currency != u\"USD\" && value->amount > 0"),
    ("account_feeds.cpp", A, "value->currency == u\"USD\" && value->amount > 0", "value->amount > 0"),
    ("account_feeds.cpp", A, "if (value && value->currency", "if (true && value->currency"),
    ("account_feeds.h", A, "inline constexpr double kPnlStaleMs = 60'000;", "inline constexpr double kPnlStaleMs = 59'999;"),
    # ================================================================ qualify_gate.cpp
    ("qualify_gate.cpp", Q, "if (now() < *until) {", "if (now() <= *until) {"),
    ("qualify_gate.cpp", Q, "if (now() < *until) {", "if (now() > *until) {"),
    ("qualify_gate.cpp", Q, "stats().skipped += 1;", "stats().skipped += 2;"),
    ("qualify_gate.cpp", Q, "stats().probes += 1;\n            stalledUntil().set(session, now() + kQualifyRetryMs);", "stalledUntil().set(session, now() + kQualifyRetryMs);"),
    ("qualify_gate.cpp", Q, "stats().probes += 1;\n            stalledUntil().set(session, now() + kQualifyRetryMs);", "stats().probes += 1;"),
    ("qualify_gate.cpp", Q, "stats().probes += 1;\n            stalledUntil().set(session, now() + kQualifyRetryMs);", "stats().probes += 1;\n            stalledUntil().set(session, *until);"),
    ("qualify_gate.cpp", Q, "stats().timeouts += 1;\n            stalledUntil().set(session, now() + kQualifyRetryMs);", "stats().timeouts += 1;"),
    ("qualify_gate.cpp", Q, "stats().timeouts += 1;\n            stalledUntil().set(session, now() + kQualifyRetryMs);", "stats().timeouts += 1;\n            stalledUntil().set(session, now() + 2 * kQualifyRetryMs);"),
    ("qualify_gate.cpp", Q, "stats().timeouts += 1;\n", "stats().timeouts += 0;\n"),
    ("qualify_gate.cpp", Q, "        if (isTimeout(failure)) {", "        if (false) {"),
    ("qualify_gate.cpp", Q, "        stalledUntil().erase(session);\n        std::rethrow_exception(failure);", "        std::rethrow_exception(failure);"),
    ("qualify_gate.cpp", Q, "    stalledUntil().erase(session);\n    co_return QualifyAnswer::Ok;", "    co_return QualifyAnswer::Ok;"),
    ("qualify_gate.cpp", Q, "    if (!wait) {", "    if (true) {"),
    ("qualify_gate.cpp", Q, "    if (!wait) {", "    if (wait) {"),
    ("qualify_gate.cpp", Q, "if (messageOf(exc).toLower().contains(u\"timeout\")) return true;", "if (messageOf(exc).contains(u\"timeout\")) return true;"),
    ("qualify_gate.cpp", Q, "if (messageOf(exc).toLower().contains(u\"timeout\")) return true;", "if (messageOf(exc).toLower().contains(u\"timed\")) return true;"),
    ("qualify_gate.cpp", Q, "    } catch (const TimeoutError&) {\n        return true;", "    } catch (const TimeoutError&) {\n        return false;"),
    ("qualify_gate.cpp", Q, "    stats() = {};", "    // stats() = {};"),
    ("qualify_gate.cpp", Q, "if (!now) now = [] { return util::dateNow(); };", "if (!now) now = [] { return 0.0; };"),
    ("qualify_gate.h", Q, "inline constexpr double kQualifyRetryMs = 30'000;", "inline constexpr double kQualifyRetryMs = 29'000;"),
    # ================================================================ ib_link.cpp
    ("ib_link.cpp", L, "accountId.size() > 5 ?", "accountId.size() >= 5 ?"),
    ("ib_link.cpp", L, "accountId.left(2) + u\"***\"_s + accountId.right(3)", "accountId.left(3) + u\"***\"_s + accountId.right(3)"),
    ("ib_link.cpp", L, "accountId.left(2) + u\"***\"_s + accountId.right(3)", "accountId.left(2) + u\"***\"_s + accountId.right(2)"),
    ("ib_link.cpp", L, "if (!live.empty()) return live;", "if (live.size() > 1) return live;"),
    ("ib_link.cpp", L, "if (s->isConnected()) live.push_back(s);", "if (!s->isConnected()) live.push_back(s);"),
    ("ib_link.cpp", L, "names.join(u\"、\"_s)", "names.join(u\",\"_s)"),
    ("ib_link.cpp", L, "makeError(!joined.isEmpty() ?", "makeError(joined.isEmpty() ?"),
    ("ib_link.cpp", L, "(managed.isEmpty() && acct.connection == name)", "(acct.connection == name)"),
    ("ib_link.cpp", L, "(managed.isEmpty() && acct.connection == name)", "(managed.isEmpty() || acct.connection == name)"),
    ("ib_link.cpp", L, "managed.contains(acct.account_id) ||", "managed.contains(acct.account_id) &&"),
    ("ib_link.cpp", L, "if (!session->isConnected()) continue;", "// connected"),
    ("ib_link.cpp", L, "if (!seen.contains(acct.alias)) {", "if (true) {"),
    ("ib_link.cpp", L, "return *state_->down.find(keys.first());", "return *state_->down.find(keys.last());"),
    ("ib_link.cpp", L, "if (keys.isEmpty()) return std::nullopt;", "if (keys.size() < 2) return std::nullopt;"),
    ("ib_link.cpp", L, "bool upstreamLost(int code) { return code == 1100 || code == 2110; }", "bool upstreamLost(int code) { return code == 1100; }"),
    ("ib_link.cpp", L, "bool upstreamLost(int code) { return code == 1100 || code == 2110; }", "bool upstreamLost(int code) { return code == 2110; }"),
    ("ib_link.cpp", L, "bool upstreamBack(int code) { return code == 1101 || code == 1102; }", "bool upstreamBack(int code) { return code == 1101; }"),
    ("ib_link.cpp", L, "bool upstreamBack(int code) { return code == 1101 || code == 1102; }", "bool upstreamBack(int code) { return code == 1102; }"),
    ("ib_link.cpp", L, "    state_->down.remove(connection);\n    session->onConnectivity", "    session->onConnectivity"),
    ("ib_link.cpp", L, "if (upstreamLost(code)) state->down.insert(connection, code);\n        else if (upstreamBack(code)) state->down.remove(connection);", "if (upstreamLost(code)) state->down.insert(connection, code);"),
    ("ib_link.cpp", L, "if (session->has(Cap::OnLink)) {", "if (true) {"),
    ("ib_link.cpp", L, "if (up) state->down.remove(connection);", "if (!up) state->down.remove(connection);"),
    ("ib_link.cpp", L, "            onLink(up);", "            (void)up;"),
    ("ib_link.cpp", L, "    state_->down = {};", "    // clear"),
    # ================================================================ held_streams.cpp
    ("held_streams.cpp", H, "if (status == u\"盘中\") return 30'000;", "if (status == u\"盘中\") return 29'999;"),
    ("held_streams.cpp", H, "if (status == u\"盘中\") return 30'000;", "if (status == u\"盘外\") return 30'000;"),
    ("held_streams.cpp", H, "return status == u\"盘外\" || status == u\"盘前\" || status == u\"盘后\" ? 120'000 : 0;", "return status == u\"盘外\" || status == u\"盘前\" || status == u\"盘后\" ? 119'999 : 0;"),
    ("held_streams.cpp", H, "status == u\"盘外\" ||", "status == u\"盘x\" ||"),
    ("held_streams.cpp", H, "status == u\"盘前\" ||", "status == u\"盘x\" ||"),
    ("held_streams.cpp", H, "|| status == u\"盘后\" ?", "|| status == u\"盘x\" ?"),
    ("held_streams.cpp", H, "? 120'000 : 0;", "? 120'000 : 120'000;"),
    ("held_streams.cpp", H, "util::jsmath::max(t.quotedAt.value_or(0), t.requestedAt.value_or(0))", "util::jsmath::min(t.quotedAt.value_or(0), t.requestedAt.value_or(0))"),
    ("held_streams.cpp", H, "util::jsmath::max(t.quotedAt.value_or(0), t.requestedAt.value_or(0))", "t.quotedAt.value_or(0)"),
    ("held_streams.cpp", H, "if (since > 0) return now - since;", "if (since >= 0) return now - since;"),
    ("held_streams.cpp", H, "if (since > 0) return now - since;", "if (since > 0) return since - now;"),
    ("held_streams.cpp", H, "return !hasError(t) && !(silentLimitMs > 0", "return !(silentLimitMs > 0"),
    ("held_streams.cpp", H, "!(silentLimitMs > 0 &&", "!(silentLimitMs >= 0 &&"),
    ("held_streams.cpp", H, "quoteSilenceMs(t, now).value_or(0) >= silentLimitMs", "quoteSilenceMs(t, now).value_or(0) > silentLimitMs"),
    ("held_streams.cpp", H, "quoteSilenceMs(t, now).value_or(0) >= silentLimitMs", "quoteSilenceMs(t, now).value_or(1e18) >= silentLimitMs"),
    ("held_streams.cpp", H, "bool hasError(const TickerData& t) { return t.error && !t.error->isEmpty(); }", "bool hasError(const TickerData& t) { return t.error.has_value(); }"),
    ("held_streams.cpp", H, "    if (!existing) return false;", "    if (!existing) return true;"),
    ("held_streams.cpp", H, "    if (!handle) return true;", "    if (!handle) return false;"),
    ("held_streams.cpp", H, "session->isConnected() ? silentLimitMs : 0;", "silentLimitMs;"),
    ("held_streams.cpp", H, "session->isConnected() ? silentLimitMs : 0;", "session->isConnected() ? 0 : silentLimitMs;"),
    ("held_streams.cpp", H, "    if (alive(t, limit, now)) {\n        recovered(key, t);\n        return true;", "    if (alive(t, limit, now)) {\n        return true;"),
    ("held_streams.cpp", H, "    map_.remove(key);\n    const QString stream", "    const QString stream"),
    ("held_streams.cpp", H, "const QString stream = contract ? tickerKey(*contract) : QString();", "const QString stream = QString();"),
    ("held_streams.cpp", H, "if (s.session.get() == session.get() && s.handle && s.contract && tickerKey(*s.contract) == stream && alive(", "if (s.handle && s.contract && tickerKey(*s.contract) == stream && alive("),
    ("held_streams.cpp", H, "s.handle && s.contract && tickerKey(*s.contract) == stream && alive(", "s.handle && s.contract && alive("),
    ("held_streams.cpp", H, "s.handle && s.contract && tickerKey(*s.contract) == stream && alive(s.handle->read(), limit, now)", "s.handle && s.contract && tickerKey(*s.contract) == stream"),
    ("held_streams.cpp", H, "if (contract && !shared) {", "if (contract) {"),
    ("held_streams.cpp", H, "if (contract && !shared) {", "if (!shared) {"),
    ("held_streams.cpp", H, "if (!hasError(t)) session->cancelTicker(*contract, QString());", "if (hasError(t)) session->cancelTicker(*contract, QString());"),
    ("held_streams.cpp", H, "else if (!variant_) session->cancelTicker(*contract);", "else if (variant_) session->cancelTicker(*contract);"),
    ("held_streams.cpp", H, "else session->cancelTicker(*contract, *variant_);", "else session->cancelTicker(*contract, QString());"),
    ("held_streams.cpp", H, "if (!hasError(t)) noteSilent(key, quoteSilenceMs(t, now).value_or(0));", "noteSilent(key, quoteSilenceMs(t, now).value_or(0));"),
    ("held_streams.cpp", H, "if (!hasError(t)) noteSilent(key, quoteSilenceMs(t, now).value_or(0));", "if (!hasError(t)) noteSilent(key, 0);"),
    ("held_streams.cpp", H, "    if (usable(session, key, silentLimitMs)) co_return false;", "    // usable"),
    ("held_streams.cpp", H, "if (util::dateNow() < *wait) co_return false;", "if (util::dateNow() <= *wait) co_return false;"),
    ("held_streams.cpp", H, "if (util::dateNow() < *wait) co_return false;", "if (util::dateNow() > *wait) co_return false;"),
    ("held_streams.cpp", H, "        stalledUntil().set(session, util::dateNow() + kQualifyRetryMs);\n    }\n    IbContract contract = target();", "    }\n    IbContract contract = target();"),
    ("held_streams.cpp", H, "        stalledUntil().set(session, util::dateNow() + kQualifyRetryMs);\n    }\n    IbContract contract = target();", "        stalledUntil().set(session, *wait);\n    }\n    IbContract contract = target();"),
    ("held_streams.cpp", H, "if (!wait && !stalledUntil().has(session)) {", "if (!wait) {"),
    ("held_streams.cpp", H, "if (!wait && !stalledUntil().has(session)) {", "if (!stalledUntil().has(session)) {"),
    ("held_streams.cpp", H, "util::jsNumberToString(kQualifyRetryMs / 1000)", "util::jsNumberToString(kQualifyRetryMs / 100)"),
    ("held_streams.cpp", H, "        stalledUntil().set(session, util::dateNow() + kQualifyRetryMs);\n        co_return false;\n    }\n    if (stalledUntil().erase(session))", "        co_return false;\n    }\n    if (stalledUntil().erase(session))"),
    ("held_streams.cpp", H, "        stalledUntil().set(session, util::dateNow() + kQualifyRetryMs);\n        co_return false;\n    }\n    if (stalledUntil().erase(session))", "        stalledUntil().set(session, util::dateNow());\n        co_return false;\n    }\n    if (stalledUntil().erase(session))"),
    ("held_streams.cpp", H, "if (stalledUntil().erase(session)) logStderr(", "stalledUntil().erase(session); logStderr("),
    ("held_streams.cpp", H, "if (stalledUntil().erase(session)) logStderr(", "if (false) logStderr("),
    ("held_streams.cpp", H, "    if (known == QualifyKnown::No) {", "    if (known == QualifyKnown::Yes) {"),
    ("held_streams.cpp", H, "map_.insert(key, {nullptr, std::nullopt, nullptr});", "map_.insert(key, {nullptr, std::nullopt, session});"),
    ("held_streams.cpp", H, "        map_.insert(key, {nullptr, std::nullopt, nullptr});\n        co_return false;", "        map_.insert(key, {nullptr, std::nullopt, nullptr});\n        co_return true;"),
    ("held_streams.cpp", H, "    subscribe(session, key, contract);\n    co_return true;", "    co_return true;"),
    ("held_streams.cpp", H, "    subscribe(session, key, contract);\n    co_return true;", "    subscribe(session, key, contract);\n    co_return false;"),
    ("held_streams.cpp", H, "map_.insert(key, {session->subscribeTicker(contract), contract, session});", "map_.insert(key, {session->subscribeTicker(contract), contract, nullptr});"),
    ("held_streams.cpp", H, "    silent_ = {};\n    map_ = {};", "    map_ = {};"),
    ("held_streams.cpp", H, "    silent_ = {};\n    map_ = {};", "    silent_ = {};"),
    ("held_streams.cpp", H, "        if (keepSet.contains(key)) continue;", "        if (false) continue;"),
    ("held_streams.cpp", H, "        map_.remove(key);\n        silent_.remove(key);", "        map_.remove(key);"),
    ("held_streams.cpp", H, "        map_.remove(key);\n        silent_.remove(key);", "        silent_.remove(key);"),
    ("held_streams.cpp", H, "if (!handle || !contract || !session || hasError(handle->read())) continue;", "if (!handle || !contract || hasError(handle->read())) continue;"),
    ("held_streams.cpp", H, "if (!handle || !contract || !session || hasError(handle->read())) continue;", "if (!handle || !contract || !session) continue;"),
    ("held_streams.cpp", H, "if (!handle || !contract || !session || hasError(handle->read())) continue;", "if (!handle || !session || hasError(handle->read())) continue;"),
    ("held_streams.cpp", H, "if (s.session.get() == session.get() && s.contract && tickerKey(*s.contract) == stream) {", "if (s.contract && tickerKey(*s.contract) == stream) {"),
    ("held_streams.cpp", H, "if (s.session.get() == session.get() && s.contract && tickerKey(*s.contract) == stream) {", "if (s.session.get() == session.get() && s.contract) {"),
    ("held_streams.cpp", H, "        if (held) continue;", "        if (false) continue;"),
    ("held_streams.cpp", H, "if (h && !hasError(h->read())) {", "if (h) {"),
    ("held_streams.cpp", H, "if (h && !hasError(h->read())) {", "if (!hasError(h->read())) {"),
    ("held_streams.cpp", H, "        if (others) continue;", "        if (false) continue;"),
    ("held_streams.cpp", H, "if (sharedWith) {", "if (false) {"),
    ("held_streams.cpp", H, "session->cancelTicker(*contract, QString());\n            released += 1;", "session->cancelTicker(*contract);\n            released += 1;"),
    ("held_streams.cpp", H, "            released += 1;", "            released += 2;"),
    ("held_streams.cpp", H, "(silent_.contains(key) ? *silent_.find(key) : 0) + 1;", "(silent_.contains(key) ? *silent_.find(key) : 0) + 2;"),
    ("held_streams.cpp", H, "(silent_.contains(key) ? *silent_.find(key) : 0) + 1;", "1;"),
    ("held_streams.cpp", H, "if (times == 1) logStderr(", "if (times <= 2) logStderr("),
    ("held_streams.cpp", H, "util::jsNumberToString(jsRound(silence / 1000))", "util::jsNumberToString(silence / 1000)"),
    ("held_streams.cpp", H, "util::jsNumberToString(jsRound(silence / 1000))", "util::jsNumberToString(std::trunc(silence / 1000))"),
    ("held_streams.cpp", H, "return x - r >= 0.5 ? r + 1 : r;", "return x - r > 0.5 ? r + 1 : r;"),
    ("held_streams.cpp", H, "if (!times || !t.quotedAt || *t.quotedAt == 0 || std::isnan(*t.quotedAt)) return;", "if (!times || !t.quotedAt || std::isnan(*t.quotedAt)) return;"),
    ("held_streams.cpp", H, "if (!times || !t.quotedAt || *t.quotedAt == 0 || std::isnan(*t.quotedAt)) return;", "if (!times || *t.quotedAt == 0) return;"),
    ("held_streams.cpp", H, "if (!times || !t.quotedAt || *t.quotedAt == 0 || std::isnan(*t.quotedAt)) return;", "if (!t.quotedAt || *t.quotedAt == 0 || std::isnan(*t.quotedAt)) return;"),
    ("held_streams.cpp", H, "    const int n = *times;\n    silent_.remove(key);", "    const int n = *times;"),
    ("held_streams.cpp", H, "重订 %2 次后盘口回来了\"_s.arg(key, QString::number(n))", "重订 %2 次后盘口回来了\"_s.arg(key, QString::number(n + 1))"),
    # ================================================================ option_marks.cpp
    ("option_marks.cpp", O, "if (value && std::isfinite(*value) && *value > 0) return value;", "if (value && std::isfinite(*value) && *value >= 0) return value;"),
    ("option_marks.cpp", O, "if (value && std::isfinite(*value) && *value > 0) return value;", "if (value && *value > 0) return value;"),
    ("option_marks.cpp", O, "bool hasError(const TickerData& t) { return t.error && !t.error->isEmpty(); }", "bool hasError(const TickerData& t) { return t.error.has_value(); }"),
    ("option_marks.cpp", O, "    tail_ = done.task();\n", "    tail_ = Task<>::resolved();\n"),
    ("option_marks.cpp", O, "    co_await prev;\n", "    // co_await prev;\n"),
    ("option_marks.cpp", O, "    done.resolve();\n    if (failure)", "    if (failure)"),
    ("option_marks.cpp", O, "    for (const QString& k : QStringList(streams_.keys())) drop(k);\n    stopSweeper();", "    for (const QString& k : QStringList(streams_.keys())) drop(k);"),
    ("option_marks.cpp", O, "    for (const QString& k : QStringList(streams_.keys())) drop(k);\n    stopSweeper();", "    stopSweeper();"),
    ("option_marks.cpp", O, "leg.symbol + u'|' + leg.expiry + u'|' + util::jsNumberToString(leg.strike) + u'|' + leg.right + u'|' + leg.tradingClass;", "leg.symbol + u'|' + leg.expiry + u'|' + util::jsNumberToString(leg.strike) + u'|' + leg.right;"),
    ("option_marks.cpp", O, "leg.symbol + u'|' + leg.expiry + u'|' + util::jsNumberToString(leg.strike) + u'|' + leg.right + u'|' + leg.tradingClass;", "leg.symbol + u'|' + leg.expiry + u'|' + util::jsNumberToString(leg.strike) + u'|' + leg.tradingClass;"),
    ("option_marks.cpp", O, "    if (!found) return;\n    const Stream s = *found;", "    const Stream s = *found;"),
    ("option_marks.cpp", O, "s.session->cancelTicker(s.contract, kTicks);", "s.session->cancelTicker(s.contract);"),
    ("option_marks.cpp", O, "    streams_.remove(key);\n    try {", "    try {"),
    ("option_marks.cpp", O, "        if (keep.contains(key)) continue;\n        const Stream& s", "        const Stream& s"),
    ("option_marks.cpp", O, "now - s.usedAt >= kIdleMs", "now - s.usedAt > kIdleMs"),
    ("option_marks.cpp", O, "now - s.usedAt >= kIdleMs || !s.session->isConnected()", "now - s.usedAt >= kIdleMs"),
    ("option_marks.cpp", O, "now - s.usedAt >= kIdleMs || !s.session->isConnected()", "now - s.usedAt >= kIdleMs && !s.session->isConnected()"),
    ("option_marks.cpp", O, "if (!keep.contains(key)) spare.emplace_back(key, streams_.find(key)->usedAt);", "spare.emplace_back(key, streams_.find(key)->usedAt);"),
    ("option_marks.cpp", O, "[](const auto& a, const auto& b) { return a.second - b.second < 0; }", "[](const auto& a, const auto& b) { return a.second - b.second > 0; }"),
    ("option_marks.cpp", O, "streams_.size() > kMaxStreams && next < spare.size()", "streams_.size() >= kMaxStreams && next < spare.size()"),
    ("option_marks.cpp", O, "while (streams_.size() > kMaxStreams && next < spare.size())", "while (streams_.size() > kMaxStreams)"),
    ("option_marks.cpp", O, "    if (streams_.isEmpty()) stopSweeper();\n}", "}"),
    ("option_marks.cpp", O, "timers_.start(static_cast<int>(kIdleMs / 2),", "timers_.start(static_cast<int>(kIdleMs / 3),"),
    ("option_marks.cpp", O, "    if (sweeper_) return;", "    // if (sweeper_) return;"),
    ("option_marks.cpp", O, "    if (!sweeper_) return;", "    // if (!sweeper_) return;"),
    ("option_marks.cpp", O, "[this] { sweep(util::dateNow(), {}); }", "[this] { sweep(util::dateNow(), QSet<QString>(streams_.keys().begin(), streams_.keys().end())); }"),
    ("option_marks.cpp", O, "    sweeper_.reset();", "    // reset"),
    ("option_marks.cpp", O, "if (hit != conIds_.cend() && hit.value() != 0) contracts[i].conId = hit.value();", "if (false) contracts[i].conId = hit.value();"),
    ("option_marks.cpp", O, "    if (need.empty()) co_return;", "    // empty"),
    ("option_marks.cpp", O, "answered = co_await qualifyGated(session, ptrs, kQualifyTimeoutMs, false);", "answered = co_await qualifyGated(session, ptrs, kQualifyTimeoutMs, true);"),
    ("option_marks.cpp", O, "answered = co_await qualifyGated(session, ptrs, kQualifyTimeoutMs, false);", "answered = co_await qualifyGated(session, ptrs, kQualifyTimeoutMs + 1, false);"),
    ("option_marks.cpp", O, "    } catch (...) {\n        answered = QualifyAnswer::Stalled;\n    }", "    } catch (...) {\n        throw;\n    }"),
    ("option_marks.cpp", O, "    } catch (...) {\n        answered = QualifyAnswer::Stalled;\n    }", "    } catch (...) {\n        answered = QualifyAnswer::Ok;\n    }"),
    ("option_marks.cpp", O, "if (answered == QualifyAnswer::Stalled) {", "if (answered != QualifyAnswer::Stalled) {"),
    ("option_marks.cpp", O, "if (!c.conId || *c.conId == 0) {", "if (!c.conId) {"),
    ("option_marks.cpp", O, "if (!c.conId || *c.conId == 0) {", "if (c.conId && *c.conId == 0) {"),
    ("option_marks.cpp", O, "        conIds_.insert(key(legs[i]), *c.conId);", "        // conIds_"),
    ("option_marks.cpp", O, "        const Stream* s = streams_.find(k);\n        if (!s) continue;", "        const Stream* s = streams_.find(k);\n        if (!s) break;"),
    ("option_marks.cpp", O, "const std::optional<double> silence = limit > 0 ? quoteSilenceMs(t, now) : std::nullopt;", "const std::optional<double> silence = quoteSilenceMs(t, now);"),
    ("option_marks.cpp", O, "(silence && *silence >= limit)", "(silence && *silence > limit)"),
    ("option_marks.cpp", O, "s->session.get() != session.get() ||", "s->session.get() == session.get() ||"),
    ("option_marks.cpp", O, "s->session.get() != session.get() ||", "false ||"),
    ("option_marks.cpp", O, "|| hasError(t) ||", "|| false ||"),
    ("option_marks.cpp", O, "session->isConnected() ? silentLimitMs : 0;", "silentLimitMs;"),
    ("option_marks.cpp", O, "    if (!fresh.empty()) {\n        co_await qualify", "    if (true) {\n        co_await qualify"),
    ("option_marks.cpp", O, "if (delayedOk) session->reqMarketDataType(3);", "if (delayedOk) session->reqMarketDataType(2);"),
    ("option_marks.cpp", O, "if (delayedOk) session->reqMarketDataType(3);", "session->reqMarketDataType(3);"),
    ("option_marks.cpp", O, "if (!fresh.empty() && delayedOk) session->reqMarketDataType(1);", "if (delayedOk) session->reqMarketDataType(1);"),
    ("option_marks.cpp", O, "if (!fresh.empty() && delayedOk) session->reqMarketDataType(1);", "if (!fresh.empty() && delayedOk) session->reqMarketDataType(0);"),
    ("option_marks.cpp", O, "if (!fresh.empty() && delayedOk) session->reqMarketDataType(1);", "if (!fresh.empty()) session->reqMarketDataType(1);"),
    ("option_marks.cpp", O, "session->subscribeTicker(contract, kTicks);", "session->subscribeTicker(contract);"),
    ("option_marks.cpp", O, "streams_.insert(keys[i], {session, contract, handle, util::dateNow()});", "streams_.insert(keys[i], {session, contract, handle, 0});"),
    ("option_marks.cpp", O, "        startSweeper();\n        co_await waitFor", "        co_await waitFor"),
    ("option_marks.cpp", O, "        if (s) s->usedAt = util::dateNow();", "        // usedAt"),
    ("option_marks.cpp", O, "m.bid = t->bid == 0 ? std::optional<double>(0) : price(t->bid);", "m.bid = price(t->bid);"),
    ("option_marks.cpp", O, "m.bid = t->bid == 0 ? std::optional<double>(0) : price(t->bid);", "m.bid = t->bid == 0 ? std::nullopt : price(t->bid);"),
    ("option_marks.cpp", O, "m.ask = price(t->ask);", "m.ask = t->ask == 0 ? std::optional<double>(0) : price(t->ask);"),
    ("option_marks.cpp", O, "m.error = t->error;", "m.error = hasError(*t) ? t->error : std::nullopt;"),
    ("option_marks.cpp", O, "    co_await session->settle(50);", "    co_await session->settle(51);"),
    ("option_marks.cpp", O, "        co_await session->settle(250);\n        waited += 250;", "        co_await session->settle(200);\n        waited += 250;"),
    ("option_marks.cpp", O, "        co_await session->settle(250);\n        waited += 250;", "        co_await session->settle(250);\n        waited += 200;"),
    ("option_marks.cpp", O, "            ivWaited += 250;", "            ivWaited += 200;"),
    ("option_marks.cpp", O, "if (withIv() || ivWaited >= kIvWaitMs) co_return;", "if (withIv() && ivWaited >= kIvWaitMs) co_return;"),
    ("option_marks.cpp", O, "if (withIv() || ivWaited >= kIvWaitMs) co_return;", "if (withIv() || ivWaited > kIvWaitMs) co_return;"),
    ("option_marks.cpp", O, "while (waited < kQuoteWaitMs) {", "while (waited <= kQuoteWaitMs) {"),
    ("option_marks.cpp", O, "if (hasError(t)) continue;\n            if (!(price(t.ask) && (t.bid == 0 || price(t.bid)))) return false;", "if (!(price(t.ask) && (t.bid == 0 || price(t.bid)))) return false;"),
    ("option_marks.cpp", O, "if (hasError(t)) continue;\n            if (!price(t.modelGreeks", "if (!price(t.modelGreeks"),
    ("option_marks.cpp", O, "(t.bid == 0 || price(t.bid))", "(t.bid == 0 && price(t.bid))"),
    ("option_marks.cpp", O, "if (!(price(t.ask) && (t.bid == 0", "if (!(price(t.ask) || (t.bid == 0"),
    ("option_marks.h", O, "static constexpr double kIdleMs = 60'000;", "static constexpr double kIdleMs = 59'000;"),
    ("option_marks.h", O, "static constexpr int kMaxStreams = 24;", "static constexpr int kMaxStreams = 25;"),
    ("option_marks.h", O, "static constexpr double kQuoteWaitMs = 4'000;", "static constexpr double kQuoteWaitMs = 3'000;"),
    ("option_marks.h", O, "static constexpr double kIvWaitMs = 1'500;", "static constexpr double kIvWaitMs = 1'000;"),
    ("option_marks.h", O, "static constexpr int kQualifyTimeoutMs = 12'000;", "static constexpr int kQualifyTimeoutMs = 11'000;"),
    ("option_marks.h", O, 'static inline const QString kTicks = QStringLiteral("106");', 'static inline const QString kTicks = QStringLiteral("105");'),
    # ================================================================ ib_bars.cpp
    ("ib_bars.cpp", K, "if (c < u'0' || c > u'9') return false;", "if (c <= u'0' || c > u'9') return false;"),
    ("ib_bars.cpp", K, "if (c < u'0' || c > u'9') return false;", "if (c < u'0' || c >= u'9') return false;"),
    ("ib_bars.cpp", K, "if (s.size() < from + count) return false;", "if (s.size() <= from + count) return false;"),
    ("ib_bars.cpp", K, "t.remove(u'-');\n    t.remove(u':');", "t.remove(u':');"),
    ("ib_bars.cpp", K, "t.remove(u'-');\n    t.remove(u':');", "t.remove(u'-');"),
    ("ib_bars.cpp", K, "        if (!piece.isEmpty()) out.append(piece);\n        pos = m.capturedEnd();", "        out.append(piece);\n        pos = m.capturedEnd();"),
    ("ib_bars.cpp", K, "    if (!tail.isEmpty()) out.append(tail);", "    out.append(tail);"),
    ("ib_bars.cpp", K, "const QString text = util::jsTrim(value);", "const QString text = value.trimmed();"),
    ("ib_bars.cpp", K, "const QString text = util::jsTrim(value);", "const QString text = value;"),
    ("ib_bars.cpp", K, "digits[0].size() == 8 && allDigits(digits[0], 0, 8)", "digits[0].size() >= 8 && allDigits(digits[0], 0, 8)"),
    ("ib_bars.cpp", K, "digits[0].size() == 8 && allDigits(digits[0], 0, 8)", "digits[0].size() == 8"),
    ("ib_bars.cpp", K, "digits.size() > 1 && digits[1].size() >= 4 && allDigits(digits[1].left(6), 0, 6)", "digits.size() > 1 && digits[1].size() > 4 && allDigits(digits[1].left(6), 0, 6)"),
    ("ib_bars.cpp", K, "digits.size() > 1 && digits[1].size() >= 4 && allDigits(digits[1].left(6), 0, 6)", "digits.size() > 1 && allDigits(digits[1].left(6), 0, 6)"),
    ("ib_bars.cpp", K, "digits.size() > 1 && digits[1].size() >= 4 && allDigits(digits[1].left(6), 0, 6)", "digits.size() > 1 && digits[1].size() >= 4 && allDigits(digits[1].left(6), 0, 4)"),
    ("ib_bars.cpp", K, "const bool hasTz = digits.size() > 2 && digits[2].contains(u'/');", "const bool hasTz = digits.size() > 2;"),
    ("ib_bars.cpp", K, "const bool hasTz = digits.size() > 2 && digits[2].contains(u'/');", "const bool hasTz = digits.size() > 3 && digits[2].contains(u'/');"),
    ("ib_bars.cpp", K, "w.second = digits[1].mid(4, 2).toInt();", "w.second = 0;"),
    ("ib_bars.cpp", K, "w.minute = digits[1].mid(2, 2).toInt();", "w.minute = digits[1].mid(2, 1).toInt();"),
    ("ib_bars.cpp", K, "w.hour = digits[1].mid(0, 2).toInt();", "w.hour = digits[1].mid(0, 1).toInt();"),
    ("ib_bars.cpp", K, "w.day = d.mid(6, 2).toInt();", "w.day = d.mid(6, 1).toInt();"),
    ("ib_bars.cpp", K, "w.month = d.mid(4, 2).toInt();", "w.month = d.mid(4, 1).toInt();"),
    ("ib_bars.cpp", K, "util::pad2(p.hour) + u':' + util::pad2(p.minute);", "util::pad2(p.hour) + u':' + util::pad2(p.hour);"),
    ("ib_bars.cpp", K, "numStr(p.year) + u'-' + util::pad2(p.month) + u'-' + util::pad2(p.day)", "numStr(p.year) + u'-' + util::pad2(p.day) + u'-' + util::pad2(p.month)"),
    ("ib_bars.cpp", K, "return day + u' ' + digits[1].mid(0, 2) + u':' + digits[1].mid(2, 2);", "return day + u' ' + digits[1].mid(0, 2) + u':' + digits[1].mid(2, 1);"),
    ("ib_bars.cpp", K, "        return day;\n    }\n    return text;", "        return day;\n    }\n    return QString();"),
    ("ib_bars.cpp", K, "        return day;\n    }\n    return text;", "        return text;\n    }\n    return text;"),
    ("ib_bars.cpp", K, "if (std::isnan(volume) || volume == 0) volume = 0;", "if (false) volume = 0;"),
    ("ib_bars.cpp", K, "util::jsmath::max(volume, 0.0)", "util::jsmath::min(volume, 0.0)"),
    ("ib_bars.cpp", K, "util::jsmath::max(volume, 0.0)", "volume"),
    ("ib_bars.cpp", K, "for (int d = 0; d <= 4; ++d) w.push_back({at(d, 4, 0), at(d, 20, 0)});", "for (int d = 0; d <= 4; ++d) w.push_back({at(d, 4, 1), at(d, 20, 0)});"),
    ("ib_bars.cpp", K, "for (int d = 0; d <= 4; ++d) w.push_back({at(d, 4, 0), at(d, 20, 0)});", "for (int d = 0; d <= 4; ++d) w.push_back({at(d, 4, 0), at(d, 20, 1)});"),
    ("ib_bars.cpp", K, "for (int d = 0; d <= 4; ++d) w.push_back({at(d, 4, 0), at(d, 20, 0)});", "for (int d = 0; d <= 3; ++d) w.push_back({at(d, 4, 0), at(d, 20, 0)});"),
    ("ib_bars.cpp", K, "w.push_back({0, at(0, 4, 0)});", "w.push_back({0, at(0, 4, 1)});"),
    ("ib_bars.cpp", K, "for (int d = 0; d <= 3; ++d) w.push_back({at(d, 20, 0), at(d + 1, 4, 0)});", "for (int d = 0; d <= 3; ++d) w.push_back({at(d, 20, 1), at(d + 1, 4, 0)});"),
    ("ib_bars.cpp", K, "for (int d = 0; d <= 3; ++d) w.push_back({at(d, 20, 0), at(d + 1, 4, 0)});", "for (int d = 0; d <= 3; ++d) w.push_back({at(d, 20, 0), at(d + 1, 4, 1)});"),
    ("ib_bars.cpp", K, "for (int d = 0; d <= 3; ++d) w.push_back({at(d, 20, 0), at(d + 1, 4, 0)});", "for (int d = 0; d <= 2; ++d) w.push_back({at(d, 20, 0), at(d + 1, 4, 0)});"),
    ("ib_bars.cpp", K, "w.push_back({at(6, 20, 0), kWeek});", "w.push_back({at(6, 20, 1), kWeek});"),
    ("ib_bars.cpp", K, "for (int d = 0; d <= 4; ++d) w.push_back({at(d, 9, 30), at(d, 16, 0)});", "for (int d = 0; d <= 4; ++d) w.push_back({at(d, 9, 31), at(d, 16, 0)});"),
    ("ib_bars.cpp", K, "for (int d = 0; d <= 4; ++d) w.push_back({at(d, 9, 30), at(d, 16, 0)});", "for (int d = 0; d <= 4; ++d) w.push_back({at(d, 9, 30), at(d, 16, 1)});"),
    ("ib_bars.cpp", K, "for (int d = 0; d <= 4; ++d) w.push_back({at(d, 9, 30), at(d, 16, 0)});", "for (int d = 0; d <= 3; ++d) w.push_back({at(d, 9, 30), at(d, 16, 0)});"),
    ("ib_bars.cpp", K, "w.push_back({0, at(0, 9, 30)});", "w.push_back({0, at(0, 9, 31)});"),
    ("ib_bars.cpp", K, "for (int d = 0; d <= 3; ++d) w.push_back({at(d, 16, 0), at(d + 1, 9, 30)});", "for (int d = 0; d <= 3; ++d) w.push_back({at(d, 16, 1), at(d + 1, 9, 30)});"),
    ("ib_bars.cpp", K, "for (int d = 0; d <= 3; ++d) w.push_back({at(d, 16, 0), at(d + 1, 9, 30)});", "for (int d = 0; d <= 3; ++d) w.push_back({at(d, 16, 0), at(d + 1, 9, 31)});"),
    ("ib_bars.cpp", K, "for (int d = 0; d <= 3; ++d) w.push_back({at(d, 16, 0), at(d + 1, 9, 30)});", "for (int d = 0; d <= 2; ++d) w.push_back({at(d, 16, 0), at(d + 1, 9, 30)});"),
    ("ib_bars.cpp", K, "w.push_back({at(4, 16, 0), at(4, 17, 0)});", "w.push_back({at(4, 16, 0), at(4, 17, 1)});"),
    ("ib_bars.cpp", K, "w.push_back({at(4, 16, 0), at(4, 17, 0)});", "w.push_back({at(4, 16, 1), at(4, 17, 0)});"),
    ("ib_bars.cpp", K, "w.push_back({at(6, 18, 0), kWeek});", "w.push_back({at(6, 18, 1), kWeek});"),
    ("ib_bars.cpp", K, "if (minute >= from && minute < to) return true;", "if (minute > from && minute < to) return true;"),
    ("ib_bars.cpp", K, "if (minute >= from && minute < to) return true;", "if (minute >= from && minute <= to) return true;"),
    ("ib_bars.cpp", K, "if (to == kWeek && wraps) continue;", "if (to == kWeek) continue;"),
    ("ib_bars.cpp", K, "if (to == kWeek && wraps) continue;", "if (wraps) continue;"),
    ("ib_bars.cpp", K, "if (to == kWeek && wraps) continue;", "// wraps"),
    ("ib_bars.cpp", K, "if (to <= wm.minute) last = util::jsmath::max(last, to);", "if (to < wm.minute) last = util::jsmath::max(last, to);"),
    ("ib_bars.cpp", K, "if (to <= wm.minute) last = util::jsmath::max(last, to);", "if (to <= wm.minute) last = util::jsmath::min(last, to);"),
    ("ib_bars.cpp", K, "        last = util::jsmath::max(last, to - kWeek);  // 上一周的", "        // 上一周的"),
    ("ib_bars.cpp", K, "const double dayOffset = std::floor(last / kDay);", "const double dayOffset = std::trunc(last / kDay);"),
    ("ib_bars.cpp", K, "w.hour = std::floor(inDay / 60);", "w.hour = std::floor(inDay / 61);"),
    ("ib_bars.cpp", K, "w.minute = std::fmod(inDay, 60);", "w.minute = std::fmod(inDay, 61);"),
    ("ib_bars.cpp", K, "[](const auto& w) { return w.first == 0; }", "[](const auto& w) { return w.first == 1; }"),
    ("ib_bars.cpp", K, "const double ms = util::dateUtc(p.year, p.month - 1, p.day) - weekday * 86'400'000.0;", "const double ms = util::dateUtc(p.year, p.month - 1, p.day);"),
    ("ib_bars.cpp", K, "c.exchange = kOvernightExchange;", "c.exchange = t.exchange;"),
    ("ib_bars.cpp", K, "    c.currency = t.currency;\n    return c;", "    return c;"),
    ("ib_bars.cpp", K, "    c.secType = t.secType;\n    c.symbol = t.symbol;", "    c.symbol = t.symbol;"),
    ("ib_bars.cpp", K, "if (overnight.empty()) return day;", "// overnight.empty"),
    ("ib_bars.cpp", K, "for (const SessionBar& bar : overnight) byTime.insert(bar.time, bar);\n    for (const SessionBar& bar : day) byTime.insert(bar.time, bar);", "for (const SessionBar& bar : day) byTime.insert(bar.time, bar);\n    for (const SessionBar& bar : overnight) byTime.insert(bar.time, bar);"),
    ("ib_bars.cpp", K, "bool lessTime(const SessionBar& a, const SessionBar& b) { return a.time < b.time; }", "bool lessTime(const SessionBar& a, const SessionBar& b) { return a.time > b.time; }"),
    ("ib_bars.cpp", K, "if (bar.time < s->first) s->first = bar.time;", "if (bar.time > s->first) s->first = bar.time;"),
    ("ib_bars.cpp", K, "if (bar.time > s->last.time) s->last = bar;", "if (bar.time < s->last.time) s->last = bar;"),
    ("ib_bars.cpp", K, "const QString date = bar.time.left(10);", "const QString date = bar.time.left(9);"),
    ("ib_bars.cpp", K, "if (fut && fut->close > 0 && s.last.close > 0) basis", "if (fut && (fut->close > 0 || s.last.close > 0)) basis"),
    ("ib_bars.cpp", K, "if (fut && fut->close > 0 && s.last.close > 0) basis", "if (fut && fut->close > 0) basis"),
    ("ib_bars.cpp", K, "if (fut && fut->close > 0 && s.last.close > 0) basis", "if (fut && s.last.close > 0) basis"),
    ("ib_bars.cpp", K, "if (fut && fut->close > 0 && s.last.close > 0) basis", "if (fut && fut->close >= 0 && s.last.close > 0) basis"),
    ("ib_bars.cpp", K, "util::pyRound(fut->close - s.last.close, 4)", "util::pyRound(fut->close - s.last.close, 3)"),
    ("ib_bars.cpp", K, "util::pyRound(fut->close - s.last.close, 4)", "util::pyRound(s.last.close - fut->close, 4)"),
    ("ib_bars.cpp", K, "return a.last < b.last; });", "return a.last > b.last; });"),
    ("ib_bars.cpp", K, "if (own && bar.time >= own->first && bar.time <= own->last.time) continue;", "if (own && bar.time > own->first && bar.time <= own->last.time) continue;"),
    ("ib_bars.cpp", K, "if (own && bar.time >= own->first && bar.time <= own->last.time) continue;", "if (own && bar.time >= own->first && bar.time < own->last.time) continue;"),
    ("ib_bars.cpp", K, "if (own && bar.time >= own->first && bar.time <= own->last.time) continue;", "if (own && bar.time >= own->first || bar.time <= own->last.time) continue;"),
    ("ib_bars.cpp", K, "if (own && bar.time >= own->first && bar.time <= own->last.time) continue;", "if (bar.time >= own->first && bar.time <= own->last.time) continue;"),
    ("ib_bars.cpp", K, "if (c.last < bar.time) before = &c;", "if (c.last <= bar.time) before = &c;"),
    ("ib_bars.cpp", K, "            else break;\n        }\n        if (!before || !before->basis) continue;", "            else continue;\n        }\n        if (!before || !before->basis) continue;"),
    ("ib_bars.cpp", K, "if (!before || !before->basis) continue;", "if (!before) continue;"),
    ("ib_bars.cpp", K, "if (!before || !before->basis) continue;", "if (!before->basis) continue;"),
    ("ib_bars.cpp", K, "derived.push_back({bar.time, util::pyRound(bar.open - b, 2), util::pyRound(bar.high - b, 2), util::pyRound(bar.low - b, 2),\n                           util::pyRound(bar.close - b, 2), 0});", "derived.push_back({bar.time, util::pyRound(bar.open - b, 3), util::pyRound(bar.high - b, 2), util::pyRound(bar.low - b, 2),\n                           util::pyRound(bar.close - b, 2), 0});"),
    ("ib_bars.cpp", K, "util::pyRound(bar.high - b, 2)", "util::pyRound(bar.high + b, 2)"),
    ("ib_bars.cpp", K, "util::pyRound(bar.low - b, 2)", "util::pyRound(bar.low - b, 1)"),
    ("ib_bars.cpp", K, "util::pyRound(bar.close - b, 2), 0});", "util::pyRound(bar.close - b, 2), 1});"),
    ("ib_bars.cpp", K, "latestBasis = BasisPoint{b, before->last};", "latestBasis = BasisPoint{b, before->first};"),
    ("ib_bars.cpp", K, "if (!result.spans.empty() && i > 0 && result.bars[i - 1].time == result.spans.back().to)", "if (!result.spans.empty() && result.bars[i - 1].time == result.spans.back().to)"),
    ("ib_bars.cpp", K, "if (!result.spans.empty() && i > 0 && result.bars[i - 1].time == result.spans.back().to)", "if (i > 0 && result.bars[i - 1].time == result.spans.back().to)"),
    ("ib_bars.cpp", K, "if (!result.spans.empty() && i > 0 && result.bars[i - 1].time == result.spans.back().to)", "if (!result.spans.empty() && i > 0)"),
    ("ib_bars.cpp", K, "else result.spans.push_back({bar.time, bar.time});", "else result.spans.push_back({bar.time, bar.time});\n        (void)0;"),
    ("ib_bars.cpp", K, "result.newestDerived = !result.bars.empty() && isDerived.contains(result.bars.back().time);", "result.newestDerived = isDerived.contains(result.bars.back().time);"),
    ("ib_bars.cpp", K, "result.newestDerived = !result.bars.empty() && isDerived.contains(result.bars.back().time);", "result.newestDerived = !result.bars.empty() && isDerived.contains(result.bars.front().time);"),
    ("ib_bars.cpp", K, "if (req.futures) co_return co_await fetchIndex(session, req, *req.futures);", "if (false) co_return co_await fetchIndex(session, req, *req.futures);"),
    ("ib_bars.cpp", K, "    if (!req.overnight) {\n        bars = co_await leg(", "    if (req.overnight) {\n        bars = co_await leg("),
    ("ib_bars.cpp", K, "const std::vector<SessionBar> day = co_await dayTask;\n        const std::vector<SessionBar> night = co_await nightTask;", "const std::vector<SessionBar> night = co_await nightTask;\n        const std::vector<SessionBar> day = co_await dayTask;"),
    ("ib_bars.cpp", K, "if (session->has(Cap::QuoteDelayed)) out.feed = feedOf(session->quoteDelayed(req.target));", "out.feed = feedOf(session->quoteDelayed(req.target));"),
    ("ib_bars.cpp", K, "if (session->has(Cap::QuoteDelayed)) out.feed = feedOf(session->quoteDelayed(result.newestDerived ? futures : req.target));", "out.feed = feedOf(session->quoteDelayed(result.newestDerived ? futures : req.target));"),
    ("ib_bars.cpp", K, "session->quoteDelayed(result.newestDerived ? futures : req.target)", "session->quoteDelayed(result.newestDerived ? req.target : futures)"),
    ("ib_bars.cpp", K, "session->quoteDelayed(result.newestDerived ? futures : req.target)", "session->quoteDelayed(futures)"),
    ("ib_bars.cpp", K, "return !delayed ? BarsFeed::Unknown : (*delayed ? BarsFeed::Delayed : BarsFeed::Live);", "return !delayed ? BarsFeed::Unknown : (*delayed ? BarsFeed::Live : BarsFeed::Delayed);"),
    ("ib_bars.cpp", K, "return !delayed ? BarsFeed::Unknown : (*delayed ? BarsFeed::Delayed : BarsFeed::Live);", "return !delayed ? BarsFeed::Live : (*delayed ? BarsFeed::Delayed : BarsFeed::Live);"),
    ("ib_bars.cpp", K, "const QString label = util::jsTrim(futures.symbol + u' ' + futures.lastTradeDateOrContractMonth.value_or(QString()));", "const QString label = futures.symbol + u' ' + futures.lastTradeDateOrContractMonth.value_or(QString());"),
    ("ib_bars.cpp", K, "if (result.derived > 0 && result.latestBasis) {", "if (result.derived >= 0 && result.latestBasis) {"),
    ("ib_bars.cpp", K, "if (result.derived > 0 && result.latestBasis) {", "if (result.latestBasis) {"),
    ("ib_bars.cpp", K, "if (result.derived > 0 && result.latestBasis) {", "if (result.derived > 0) {"),
    ("ib_bars.cpp", K, "numStr(util::pyRound(result.latestBasis->basis, 2))", "numStr(util::pyRound(result.latestBasis->basis, 1))"),
    ("ib_bars.cpp", K, "} else if (error) {", "} else if (!error) {"),
    ("ib_bars.cpp", K, "error->left(160)", "error->left(161)"),
    ("ib_bars.cpp", K, "out.proxy = PaProxy{label, result.derived, note, result.spans};", "out.proxy = PaProxy{label, result.derived, note, {}};"),
    ("ib_bars.cpp", K, "const QString* error = proxyErrors.find(symbol);", "const QString* error = overnightErrors.find(symbol);"),
    ("ib_bars.cpp", K, "if (req.nowMs < *retryAt) co_return std::vector<SessionBar>{};", "if (req.nowMs <= *retryAt) co_return std::vector<SessionBar>{};"),
    ("ib_bars.cpp", K, "if (req.nowMs < *retryAt) co_return std::vector<SessionBar>{};", "if (req.nowMs > *retryAt) co_return std::vector<SessionBar>{};"),
    ("ib_bars.cpp", K, "retryAt_.insert(key, req.nowMs + kOvernightRetryMs);", "retryAt_.insert(key, req.nowMs + 2 * kOvernightRetryMs);"),
    ("ib_bars.cpp", K, "        errors->insert(symbol, errorText(failure));", "        // errors"),
    ("ib_bars.cpp", K, "    retryAt_.remove(key);\n    errors->remove(symbol);", "    errors->remove(symbol);"),
    ("ib_bars.cpp", K, "    retryAt_.remove(key);\n    errors->remove(symbol);", "    retryAt_.remove(key);"),
    ("ib_bars.cpp", K, "const QString key = symbol + u'|' + legName(kind);", "const QString key = symbol;"),
    ("ib_bars.cpp", K, "req.barSizeSetting + u'|' + req.durationStr + u'|' + req.endDateTime", "req.barSizeSetting + u'|' + req.endDateTime"),
    ("ib_bars.cpp", K, "req.barSizeSetting + u'|' + req.durationStr + u'|' + req.endDateTime", "req.durationStr + u'|' + req.endDateTime"),
    ("ib_bars.cpp", K, "req.barSizeSetting + u'|' + req.durationStr + u'|' + req.endDateTime", "req.barSizeSetting + u'|' + req.durationStr"),
    ("ib_bars.cpp", K, "(req.useRTH ? u\"true\"_s : u\"false\"_s) + u'|' + legName(kind);", "legName(kind);"),
    ("ib_bars.cpp", K, "(req.useRTH ? u\"true\"_s : u\"false\"_s) + u'|' + legName(kind);", "(req.useRTH ? u\"true\"_s : u\"false\"_s);"),
    ("ib_bars.cpp", K, "const QString key = c.secType + u'|' + c.symbol + u'|' + c.exchange + u'|' + c.lastTradeDateOrContractMonth.value_or(QString()) + u'|' +", "const QString key = c.secType + u'|' + c.symbol + u'|' + c.lastTradeDateOrContractMonth.value_or(QString()) + u'|' +"),
    ("ib_bars.cpp", K, "const QString key = c.secType + u'|' + c.symbol + u'|' + c.exchange + u'|' + c.lastTradeDateOrContractMonth.value_or(QString()) + u'|' +", "const QString key = c.secType + u'|' + c.symbol + u'|' + c.exchange + u'|' +"),
    ("ib_bars.cpp", K, "const QString key = c.secType + u'|' + c.symbol + u'|' + c.exchange + u'|' + c.lastTradeDateOrContractMonth.value_or(QString()) + u'|' +", "const QString key = c.symbol + u'|' + c.exchange + u'|' + c.lastTradeDateOrContractMonth.value_or(QString()) + u'|' +"),
    ("ib_bars.cpp", K, "if (closedSince && hit->fetchedAt >= *closedSince + kDelayedFeedMaxMs) co_return hit->bars;", "if (closedSince && hit->fetchedAt > *closedSince + kDelayedFeedMaxMs) co_return hit->bars;"),
    ("ib_bars.cpp", K, "if (closedSince && hit->fetchedAt >= *closedSince + kDelayedFeedMaxMs) co_return hit->bars;", "if (hit->fetchedAt >= *closedSince + kDelayedFeedMaxMs) co_return hit->bars;"),
    ("ib_bars.cpp", K, "if (closedSince && hit->fetchedAt >= *closedSince + kDelayedFeedMaxMs) co_return hit->bars;", "if (closedSince && hit->fetchedAt >= *closedSince) co_return hit->bars;"),
    ("ib_bars.cpp", K, "    opts.endDateTime = req.endDateTime;\n", "    opts.endDateTime = req.durationStr;\n"),
    ("ib_bars.cpp", K, "    opts.durationStr = req.durationStr;\n", "    opts.durationStr = req.endDateTime;\n"),
    ("ib_bars.cpp", K, "    opts.barSizeSetting = req.barSizeSetting;\n", ""),
    ("ib_bars.cpp", K, "    opts.whatToShow = req.whatToShow;\n", ""),
    ("ib_bars.cpp", K, "    opts.useRTH = req.useRTH;\n", ""),
    ("ib_bars.cpp", K, "    idle_.remove(key);\n    if (closedSince) {", "    if (closedSince) {"),
    ("ib_bars.cpp", K, "    if (closedSince) {\n        idle_.insert(key, {bars, req.nowMs});", "    if (true) {\n        idle_.insert(key, {bars, req.nowMs});"),
    ("ib_bars.cpp", K, "idle_.insert(key, {bars, req.nowMs});", "idle_.insert(key, {bars, 0});"),
    ("ib_bars.cpp", K, "while (idle_.size() > kIdleMax) {", "while (idle_.size() >= kIdleMax) {"),
    ("ib_bars.cpp", K, "idle_.remove(idle_.keys().first());", "idle_.remove(idle_.keys().last());"),
    ("ib_bars.cpp", K, "constexpr int kIdleMax = 64;", "constexpr int kIdleMax = 63;"),
    ("ib_bars.cpp", K, "constexpr int kIdleMax = 64;", "constexpr int kIdleMax = 65;"),
    ("ib_bars.cpp", K, "for (const RawBar& r : raw) bars.push_back(toSessionBar(r));", "for (const RawBar& r : raw) bars.push_back(toSessionBar(r)); if (!bars.empty()) bars.pop_back();"),
    ("ib_bars.cpp", K, "if (message.contains(u\"162\") || message.contains(u\"354\")", "if (message.contains(u\"163\") || message.contains(u\"354\")"),
    ("ib_bars.cpp", K, "|| message.contains(u\"354\") ||", "|| message.contains(u\"355\") ||"),
    ("ib_bars.cpp", K, "lowered.contains(u\"permission\")", "message.contains(u\"permission\")"),
    ("ib_bars.cpp", K, "lowered.contains(u\"permission\") || lowered.contains(u\"subscri\")", "lowered.contains(u\"permission\")"),
    ("ib_bars.cpp", K, "lowered.contains(u\"subscri\")", "lowered.contains(u\"subscrib\")"),
    ("ib_bars.cpp", K, "message.left(200);", "message.left(201);"),
    ("ib_bars.cpp", K, "K 线失败:\"_s + message.left(300);", "K 线失败:\"_s + message.left(299);"),
    ("ib_bars.h", K, "inline constexpr double kOvernightRetryMs = 30 * 60'000;", "inline constexpr double kOvernightRetryMs = 29 * 60'000;"),
    ("ib_bars.h", K, "inline constexpr double kDelayedFeedMaxMs = 20 * 60'000;", "inline constexpr double kDelayedFeedMaxMs = 19 * 60'000;"),
    ("ib_bars.h", K, 'inline const QString kOvernightExchange = QStringLiteral("OVERNIGHT");', 'inline const QString kOvernightExchange = QStringLiteral("OVERNIGHT2");'),
    # ---- 验收补的
    ("account_feeds.cpp", A, "if (!pnl || !pnl->daily || pnl->currency != u\"USD\") return std::nullopt;", "if (!pnl || !pnl->daily && pnl->currency != u\"USD\") return std::nullopt;"),
    ("account_feeds.cpp", A, "if (!pnl || !pnl->daily || pnl->currency != u\"USD\") return std::nullopt;", "if (!pnl || (pnl->currency != u\"USD\" && pnl->atMs < 0)) return std::nullopt;"),
    ("account_feeds.cpp", A, "if (value && value->currency == u\"USD\" && value->amount > 0) return value->amount;", "if (value && (value->currency == u\"USD\" || value->amount > 0)) return value->amount;"),
    ("ib_bars.cpp", K, "if (bar.time > s->last.time) s->last = bar;", "if (bar.time >= s->last.time) s->last = bar;"),
    ("ib_bars.cpp", K, "if (bar.time < s->first) s->first = bar.time;", "if (bar.time <= s->first) s->first = bar.time;"),
    ("ib_bars.cpp", K, "if (result.derived > 0 && result.latestBasis) {", "if (result.derived >= 0) {"),
    ("ib_bars.cpp", K, "if (result.derived > 0 && result.latestBasis) {", "if (true) {"),
    ("ib_bars.cpp", K, "for (const SessionBar& bar : day) byTime.insert(bar.time, bar);", "for (const SessionBar& bar : day) if (!byTime.contains(bar.time)) byTime.insert(bar.time, bar);"),
]

TESTS = [Q, L, A, M_, H, O, K]

FILES = [x for x in os.environ.get("FILES", "").split("|") if x]
ONLY = [x for x in os.environ.get("ONLY", "").split("|") if x]
# 默认的分工:a = held_streams + option_marks;b = ib_bars;c = 其余
WORKER_FILES = {
    "d": ["account_feeds.cpp", "ib_bars.cpp"],
    "a": ["held_streams.cpp", "option_marks.cpp", "option_marks.h"],
    "b": ["ib_bars.cpp", "ib_bars.h"],
    "c": ["broker_pricing.cpp", "broker_pricing.h", "auto_mid.cpp", "account_feeds.cpp", "account_feeds.h", "qualify_gate.cpp", "qualify_gate.h", "ib_link.cpp"],
}
MUT = [m for m in MUTANTS if (m[0] in (FILES or WORKER_FILES.get(WORKER, [])))]
if ONLY:
    MUT = [m for m in MUT if any(o in m[2] for o in ONLY)]
if os.environ.get("RERUN"):
    # 只重跑上一轮没被杀掉的,以及上一轮没有的(新加的)变异
    prev = {}
    for w in ("a", "b", "c"):
        fp = os.path.join(WORK, w, os.environ.get("PREVNAME", "mutate_execsupport.json"))
        if os.path.exists(fp):
            for f_, old_, new_, res_ in json.load(open(fp, encoding="utf-8")):
                prev[(f_, old_, new_)] = res_
    MUT = [m for m in MUT if prev.get((m[0], m[2], m[3])) != "caught"]


def check():
    bad = 0
    for f, test, old, new in MUTANTS:
        path = os.path.join(PROJECT, "native", EXE, f)
        n = open(path, encoding="utf-8").read().count(old)
        if n != 1 or old == new:
            bad += 1
            print(f"bad-anchor({n})", f, old.replace("\n", "\\n")[:100])
    print("anchors checked:", len(MUTANTS), "bad:", bad)
    return 1 if bad else 0


def sh(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def setup():
    """副本:rsync native/、符号链接、配置。每次启动都同步一遍(变异之前的最新原文)。"""
    assert ROOT.startswith(WORK), ROOT
    os.makedirs(ROOT, exist_ok=True)
    for name in ("desktop", "engine-ts", "docs", "prompts"):
        link = os.path.join(ROOT, name)
        if not os.path.lexists(link):
            os.symlink(os.path.join(PROJECT, name), link)
    r = sh(["rsync", "-a", "--delete", "--exclude=.vscode", "--exclude=build*", os.path.join(PROJECT, "native") + "/", NATIVE + "/"])
    if r.returncode != 0:
        raise SystemExit("rsync failed: " + r.stderr)
    if not os.path.exists(os.path.join(B, "build.ninja")):
        r = sh(["cmake", "-S", NATIVE, "-B", B, "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Debug", "-DCMAKE_CXX_COMPILER=/Library/Developer/CommandLineTools/usr/bin/clang++",
                "-DCMAKE_PREFIX_PATH=/opt/homebrew", "-DIBKR_BUILD_UI=OFF"])
        if r.returncode != 0:
            raise SystemExit("configure failed: " + r.stdout + r.stderr)


def build(targets):
    """编;iCloud 读超时就再试几次(不是代码的错)。"""
    for _ in range(4):
        b = sh(["cmake", "--build", B, "--target", *targets, "-j4"])
        if b.returncode == 0:
            return True
        if "Operation timed out" not in b.stdout + b.stderr:
            sys.stderr.write((b.stdout + b.stderr)[-1500:])
            return False
        time.sleep(5)
    return False


def run(test):
    r = subprocess.run([os.path.join(B, "tests", test)], capture_output=True, text=True, env=ENV, timeout=900)
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


def main():
    if os.environ.get("CHECK"):
        return check()
    recover()
    setup()
    if not build(TESTS):
        raise SystemExit("baseline build failed")
    for t in TESTS:
        if not run(t):
            raise SystemExit(f"baseline {t} is red")
    results = []
    try:
        for f, test, old, new in MUT:
            path = os.path.join(NATIVE, EXE, f)
            assert path.startswith(WORK)
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
                res = ("survived" if run(test) else "caught") if build([test]) else "build-error"
            finally:
                with open(path, "w", encoding="utf-8") as fh:
                    fh.write(orig)
                bump(path)
                os.remove(JOURNAL)
                build([test])
            results.append([f, old, new, res])
            print(res, f, old.replace("\n", " ")[:90], "=>", new.replace("\n", " ")[:60], flush=True)
    finally:
        build(TESTS)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(results, fh, ensure_ascii=False, indent=1)
    print(dict(Counter(r[3] for r in results)), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
