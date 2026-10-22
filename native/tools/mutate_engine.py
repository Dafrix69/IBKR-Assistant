#!/usr/bin/env python3
"""engine 簇(engine-ts/src/engine/*.ts 的 C++ 版:hosted / callbacks / reconcile / exits / wake_guard / account_guard / closing / spot_stop / session_hours /
local_shorthand / heartbeat / clock,在 native/engine/orchestrate/)的变异检验。从 mutate_broker.py 改来,规矩一样:

只在私有副本里做,绝不动项目里的源码:~/Developer/ibkr/work/mut-engine/<WORKER>/{native, build, desktop/engine-ts/docs/prompts 的符号链接}。
副本的编译目录用 -g0(不带调试信息,省盘省时间)。每个变异是一处单行改动:写进副本 → 重编 → 跑 → caught / survived / build-error;finally 里还原、把文件时间往后拨。
中途被杀时 finally 不会跑:改动前的原文先存进 restore-<WORKER>.json,下次启动先按它还原。
两类变异:手选(钱路径:托管单状态机、退避 60 秒 / 600 秒、熔断计数与 LinkDown、重复撤单、sentOrders 账、错误码宣判、对账的宽限与去向不明、停摆阈值、
账户风控取数……)与机械生成(逐行运算符翻转、true/false 互换、整数常量 +1、删一条语句)。钱路径文件全量,其余文件按固定种子抽样。
幸存者要么补用例杀掉,要么在 REASONS 里写明为什么等价 / 为什么不可观察;输出里每个幸存者带 reason,没写的标 UNJUSTIFIED。

  WORKER=a SHARD=0/2 python3 native/tools/mutate_engine.py
  CHECK=1 python3 native/tools/mutate_engine.py                  # 只核对手选锚点,不编不跑
  LIST=1 python3 native/tools/mutate_engine.py                   # 只列出会跑的变异
  RESUME=1 …  SURVIVORS_FROM=a.json,b.json …  ONLY='子串|子串' OUT=结果.json
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
WORK = "/Users/dafrix/Developer/ibkr/work/mut-engine"
WORKER = os.environ.get("WORKER", "a")
ROOT = os.path.join(WORK, WORKER)
NATIVE = os.path.join(ROOT, "native")
B = os.path.join(ROOT, "build")
OUT = os.environ.get("OUT", os.path.join(WORK, f"mutate_engine_{WORKER}.json"))
ENV = dict(os.environ, QT_QPA_PLATFORM="offscreen")
EXE = "engine/orchestrate/"
W, P, G = "tst_engine_world", "tst_engine_pure", "tst_engine_guards"
# 文件 → (要跑的测试 [(可执行, 参数)…] 先便宜后贵, 每个文件最多抽多少个机械变异)
FILES = {
    "hosted.cpp": ([(P, ["labelsAndMath"]), (W, ["named"]), (W, ["fuzz"])], 9999),
    "callbacks.cpp": ([(W, ["named"]), (W, ["fuzz"])], 9999),
    "reconcile.cpp": ([(W, ["named"]), (W, ["fuzz"])], 9999),
    "reconcile.h": ([(W, ["named"]), (W, ["fuzz"])], 9999),
    "exits.cpp": ([(G, ["exits"]), (W, ["named"]), (W, ["fuzz"])], 9999),
    "wake_guard.cpp": ([(G, ["wakeSequences"]), (G, ["wakePure"])], 9999),
    "wake_guard.h": ([(G, ["wakeSequences"]), (G, ["wakePure"])], 9999),
    "account_guard.cpp": ([(G, ["account"])], 9999),
    "closing.cpp": ([(P, ["closing"]), (G, ["account"])], 200),
    "engine_ports.cpp": ([(P, ["labelsAndMath"]), (G, ["wakeSequences"]), (W, ["named"])], 60),
    "spot_stop.cpp": ([(P, ["spot"])], 80),
    "session_hours.cpp": ([(P, ["hours"])], 120),
    "local_shorthand.cpp": ([(P, ["shorthand"])], 80),
    "heartbeat.cpp": ([(P, ["clockAndHeartbeat"])], 60),
    "clock.cpp": ([(P, ["clockAndHeartbeat"])], 40),
}
TESTS = sorted({t for v in FILES.values() for t, _ in v[0]})
MAX = int(os.environ.get("MAX", "100000"))

# (文件, 原文, 改成, 第几处(缺省必须恰好一处)) —— 手选
H = []


def h(f, old, new, nth=None):
    H.append((f, old, new, nth))


HO, CB, RC, EX, WG, AG = "hosted.cpp", "callbacks.cpp", "reconcile.cpp", "exits.cpp", "wake_guard.cpp", "account_guard.cpp"
# ---- 托管单:退避、熔断、状态机
h(HO, "Retry{nowMs() + (own ? 600'000 : 60'000), message, false}", "Retry{nowMs() + (own ? 60'000 : 60'000), message, false}")
h(HO, "Retry{nowMs() + (own ? 600'000 : 60'000), message, false}", "Retry{nowMs() + (own ? 600'000 : 600'000), message, false}")
h(HO, "if (!own && !linkDown) {", "if (!own) {")
h(HO, "if (!own && !linkDown) {", "if (!linkDown) {")
h(HO, "if (retry->at > nowMs()) {\n                    // 刚被券商拒过", "if (retry->at >= nowMs()) {\n                    // 刚被券商拒过")
h(HO, "if (retry && retry->at > nowMs()) {\n                        // 改价刚被拒", "if (retry && retry->at >= nowMs()) {\n                        // 改价刚被拒")
h(HO, "if (!stillHosting(tid)) break;", "")
h(HO, "return !js::truthy(js::prop(&*fresh, u\"fired_at\"_s)) || tk::sweepReason(*fresh).has_value();", "return !js::truthy(js::prop(&*fresh, u\"fired_at\"_s));")
h(HO, "gate.breakerEngaged = breaker.engaged && !(breaker.autoEngaged && sweeping);", "gate.breakerEngaged = breaker.engaged;")
h(HO, "gate.alreadyFired = js::truthy(js::prop(&track, u\"fired_at\"_s)) && !sweeping;", "gate.alreadyFired = js::truthy(js::prop(&track, u\"fired_at\"_s));")
h(HO, "if (breaker.autoEngaged && onlyBreaker) {", "if (onlyBreaker) {")
h(HO, "if (breaker.autoEngaged && onlyBreaker) {", "if (breaker.autoEngaged) {")
h(HO, "gate.breakerEngaged = breaker.engaged && !breaker.autoEngaged;", "gate.breakerEngaged = breaker.engaged;")
h(HO, "gate.marketStatus = u\"盘中\"_s;\n        gate.alreadyFired = false;", "gate.marketStatus = u\"休市\"_s;\n        gate.alreadyFired = false;")
h(HO, "if (!rawPtr && tk::unreachableReason(covered, js::prop(&track, u\"account\"_s))) continue;", "if (!rawPtr) {\n            co_await cancelHostedTrack(tid, u\"持仓已不存在\"_s);\n            continue;\n        }\n        if (!rawPtr && false) continue;")
h(HO, "hostedAdopted_ = false;\n                break;", "break;")
h(HO, "if (!hostedAdopted_) co_await adoptHosted();", "if (!hostedAdopted_ && false) co_await adoptHosted();")
h(HO, "10'000, u\"券商 10 秒没有回应未成交单列表\"_s", "10'000, u\"券商 10 秒没有回应未成交单列表\"_s") if False else None
h(HO, "raceTimeout<QList<Rec>>(router->listHostedOpen(), 10'000,", "raceTimeout<QList<Rec>>(router->listHostedOpen(), 100'000,")
h(HO, "if (orderId == 0 || std::isnan(orderId)) continue;", "if (std::isnan(orderId)) continue;")
h(HO, "keep.insert(group[0]);", "keep.insert(group[group.size() - 1]);")
h(HO, "host_.sentOrders().insert(static_cast<qint64>(orderId), SentOrder{nowMs(), SentOrder::Kind::Cancel});\n            const Rec* keptId", "const Rec* keptId")
h(HO, "entry->set(u\"cancelling\"_s, js::B(true));", "entry->set(u\"cancelling\"_s, js::B(false));")
h(HO, "if (entry && !js::truthy(js::prop(&*entry, u\"cancelling\"_s))) {", "if (entry) {")
h(HO, "Retry{nowMs() + 60'000, u\"券商侧\"_s +", "Retry{nowMs() + 6'000, u\"券商侧\"_s +")
h(HO, "hostedRetryAt_.insert(tid + u\"|\"_s + kind, Retry{nowMs() + 60'000, reason, false});\n        host_.notifier().warning(symbol + u\" 的托管单改价被券商拒绝", "hostedRetryAt_.insert(tid + u\"|\"_s + kind, Retry{nowMs() + 6'000, reason, false});\n        host_.notifier().warning(symbol + u\" 的托管单改价被券商拒绝")
h(HO, "if (code != 202 && ((js::isStr(pending) && pending->s == u\"modify\") || js::truthy(js::prop(&*entry, u\"live\"_s)))) {", "if (code != 202 && (js::isStr(pending) && pending->s == u\"modify\")) {")
h(HO, "if (code != 202 && ((js::isStr(pending) && pending->s == u\"modify\") || js::truthy(js::prop(&*entry, u\"live\"_s)))) {", "if (code != 202 && js::truthy(js::prop(&*entry, u\"live\"_s))) {")
h(HO, "if (code != 202) {\n        hostedRetryAt_.insert", "if (true) {\n        hostedRetryAt_.insert")
h(HO, "entry->set(u\"pending\"_s, js::Null());\n        hostedRetryAt_", "hostedRetryAt_")
h(HO, "entry->set(u\"live\"_s, js::B(true));\n            // 部分成交", "// 部分成交")
h(HO, "if (filled && *filled > 0) entry->set(u\"filled\"_s, js::N(*filled));", "if (filled) entry->set(u\"filled\"_s, js::N(*filled));")
h(HO, "{u\"enabled\"_s, js::B(false)}}));\n        const std::optional<Rec> track = host_.store().getTrack(tid);", "{u\"enabled\"_s, js::B(true)}}));\n        const std::optional<Rec> track = host_.store().getTrack(tid);")
h(HO, "if (!sweep) {\n            Rec detail = js::object({{u\"track\"_s, js::S(tid)}});", "if (true) {\n            Rec detail = js::object({{u\"track\"_s, js::S(tid)}});")
h(HO, "if (sweep && !tk::sweepReason(track) && !js::truthy(js::prop(&track, u\"fired_at\"_s))) {", "if (sweep && !tk::sweepReason(track)) {")
h(HO, "const bool uncoveredForSure = secType == u\"BAG\" && args.state != tk::kStateTakeProfit;", "const bool uncoveredForSure = secType == u\"BAG\";")
h(HO, "(!covered && synced_.contains(tid));", "(!covered);")
h(HO, "if (!blockers.isEmpty()) {\n            // 到价了但动不了", "if (false) {\n            // 到价了但动不了")
h(HO, "if (!js::truthy(js::prop(&track, u\"fired_state\"_s))) {\n                host_.store().updateTrack(tid, js::object({{u\"fired_state\"_s, js::S(u\"blocked\"_s)}}));", "if (true) {\n                host_.store().updateTrack(tid, js::object({{u\"fired_state\"_s, js::S(u\"blocked\"_s)}}));")
h(HO, "clearBackoff(tid);\n        host_.notifier().notify(u\"追价平仓\"_s", "host_.notifier().notify(u\"追价平仓\"_s")
h(HO, "if (code != 202) {\n        hostedRetryAt_", "if (code == 202) {\n        hostedRetryAt_") 
h(HO, "item.set(u\"quantity\"_s, js::N(jsx::min(", "item.set(u\"quantity\"_s, js::N(jsx::max(")
h(HO, "if (curp && filled > 0) {", "if (curp && filled >= 0) {")
h(HO, "if (hold) desired.insert(tk::kHostedKindTp);", "")
h(HO, "host_.killswitch().recordSuccess(u\"broker\"_s);", "")
h(HO, "host_.sentOrders().insert(orderId, SentOrder{nowMs(), SentOrder::Kind::Modify});", "")
h(HO, "host_.sentOrders().insert(orderId, SentOrder{nowMs(), SentOrder::Kind::Cancel});\n        std::exception_ptr failure;", "std::exception_ptr failure;")
h(HO, "if (truthyId(result.order_id)) host_.sentOrders().insert(*result.order_id, SentOrder{nowMs(), SentOrder::Kind::Place});", "")
h(HO, "if (!ok) {\n        // 券商侧已经不认识这张单", "if (ok) {\n        // 券商侧已经不认识这张单")
h(HO, "current->set(u\"pending\"_s, js::S(u\"modify\"_s));", "")
h(HO, "host_.onIbError(js::N(*result.order_id), js::N(e.code), js::S(e.message));\n            co_return;", "host_.onIbError(js::N(*result.order_id), js::N(e.code), js::S(e.message));")
h(HO, "host_.earlyOrderErrors().remove(*result.order_id);", "")
h(HO, "if (peak) {\n            const OJson peakValue", "if (false) {\n            const OJson peakValue")
h(HO, "tid.left(8)", "tid.left(7)")
h(HO, "if (!stillHosting(tid)) break;", "if (!stillHosting(tid)) continue;")
# ---- 回报落库
h(CB, "constexpr double kAmbiguousWindowMs = 10'000;", "constexpr double kAmbiguousWindowMs = 100'000;")
h(CB, "constexpr double kChaseRefusalNotifyMs = 60'000;", "constexpr double kChaseRefusalNotifyMs = 6'000;")
h(CB, "if (nowMs() - host_.earlyOrderErrors().value(id).at > 60'000) host_.earlyOrderErrors().remove(id);", "if (nowMs() - host_.earlyOrderErrors().value(id).at > 600'000) host_.earlyOrderErrors().remove(id);")
h(CB, "if (code == 202 || code == 135) return false;", "if (code == 202) return false;")
h(CB, "const QString final = code == 202 ? u\"cancelled\"_s : u\"ibkr_error\"_s;", "const QString final = u\"ibkr_error\"_s;")
h(CB, "if (sent && !sent->contains(req)) {", "if (false) {")
h(CB, "if (!host_.finalized().contains(recordId)) {\n        host_.finalized().insert(recordId);\n        host_.store().setFinalStatus(recordId, final,", "if (true) {\n        host_.finalized().insert(recordId);\n        host_.store().setFinalStatus(recordId, final,")
h(CB, "if (final == u\"ibkr_error\") host_.notifier().rejection", "if (true) host_.notifier().rejection")
h(CB, "if (sentRecently(req)) {\n            // 没有记录", "if (true) {\n            // 没有记录")
h(CB, "if (kAmbiguousCodes.contains(code)) return sentRecently(req);", "if (kAmbiguousCodes.contains(code)) return true;")
h(CB, "if (kDataRequestCodes.contains(code)) return false;", "")
h(CB, "if (kMarketDataCodes.contains(code)) return;", "")
h(CB, "if (final == u\"filled\" && js::truthy(js::prop(os, u\"remaining\"_s))) final = u\"partially_filled\"_s;", "")
h(CB, "if (!execId.isEmpty() && host_.seenFills().contains(execId)) return;", "if (host_.seenFills().contains(execId)) return;")
h(CB, "if (!execId.isEmpty()) host_.seenFills().insert(execId);", "host_.seenFills().insert(execId);")
h(CB, "if (js::isBool(live) && !live->b) return;", "")
h(CB, "if (!execId.isEmpty() && host_.seenCommissions().contains(execId)) return;", "")
h(CB, "while (host_.unmatchedEvents().size() > 200)", "while (host_.unmatchedEvents().size() > 201)", 1)
h(CB, "while (host_.unmatchedEvents().size() > 200)", "while (host_.unmatchedEvents().size() > 201)", 2)
h(CB, "if (js::truthy(js::prop(order, u\"permId\"_s)) || js::truthy(js::prop(order, u\"orderId\"_s))) {", "if (true) {")
h(CB, "host_.hostedOrders().handleError(req, code, message);\n        host_.store().appendEvent(recordId, u\"warning\"_s,\n                                  js::object({{u\"message\"_s, js::S(u\"IBKR \"_s + codeText + u\": \"_s + message + u\"(改单 / 撤单被拒", "host_.store().appendEvent(recordId, u\"warning\"_s,\n                                  js::object({{u\"message\"_s, js::S(u\"IBKR \"_s + codeText + u\": \"_s + message + u\"(改单 / 撤单被拒")
h(CB, "if (!informational) host_.notifier().warning", "host_.notifier().warning")
h(CB, "if (code >= kInfoMin && code < kInfoMax)", "if (code >= kInfoMin && code <= kInfoMax)") if False else None
h(CB, "const bool informational = code >= kInfoMin && code < kInfoMax;", "const bool informational = code >= kInfoMin && code <= kInfoMax;")
h(CB, "if (req <= 0) return;", "if (req < 0) return;")
# ---- 对账
h(RC, "if (covered && !rec.accountId.isEmpty() && !covered->contains(rec.accountId)) continue;", "if (!rec.accountId.isEmpty() && covered && covered->contains(rec.accountId)) continue;")
h(RC, "if (covered && !rec.accountId.isEmpty() && !covered->contains(rec.accountId)) continue;", "")
h(RC, "if (pendingAtStart.contains(rec.id) || host_.pendingTriggerIds().contains(rec.id)) continue;", "if (host_.pendingTriggerIds().contains(rec.id)) continue;")
h(RC, "if (pendingAtStart.contains(rec.id) || host_.pendingTriggerIds().contains(rec.id)) continue;", "if (pendingAtStart.contains(rec.id)) continue;")
h(RC, "if (withinGrace(rec, nowMs)) continue;", "")
h(RC, "rec.lastStatusAtMs && *rec.lastStatusAtMs <= nowMs ? *rec.lastStatusAtMs : rec.createdAtMs", "rec.lastStatusAtMs ? *rec.lastStatusAtMs : rec.createdAtMs")
h(RC, "if (quantity > 0 && filledQty + 1e-9 < quantity) return Settled{false, filledQty, quantity};", "if (quantity > 0 && filledQty < quantity) return Settled{false, filledQty, quantity};")
h(RC, "if (host_.finalized().contains(rec.id)) return Settled{false, filledQty, quantity};", "")
h(RC, "if (isBag && secTypeOf(f) != u\"BAG\") continue;", "")
h(RC, "if (execId.isEmpty() || known.contains(execId)) continue;", "if (execId.isEmpty()) continue;")
h(RC, "if (rec.lastStatus == kStatusNotAtBroker) return false;", "")
h(RC, "if (!fresh && allMarked) co_return true;", "")
h(RC, "if (!fresh && nowMs - execSyncAt_ < kExecSyncEveryMs) co_return false;", "")
h(RC, "if (!missing.isEmpty() && (co_await syncExecutions(missing, nowMs))) {", "if (!missing.isEmpty()) {")
h(RC, "const bool known = (orderId && host_.orderIndex().contains(*orderId)) || (permId && host_.orderIndex().contains(*permId));", "const bool known = false;")
h(RC, "if (!isHosted(rec.signature)) return std::nullopt;", "")
h(RC, "if (ids.contains(jsx::idOf(js::prop(&rows[i], u\"order_id\"_s)).value_or(-1)) || ids.contains(jsx::idOf(js::prop(&rows[i], u\"perm_id\"_s)).value_or(-1))) return i;", "if (ids.contains(jsx::idOf(js::prop(&rows[i], u\"order_id\"_s)).value_or(-1))) return i;")
h(RC, "if (ids.isEmpty()) return {};", "")
h(RC, "const double quantity = rec.quantity > 0 ? rec.quantity :", "const double quantity = rec.quantity >= 0 ? rec.quantity :")
h(RC, "host_.replayUnmatched();", "")
h(RC, "reconcileAt_ = nowMs;\n    // 等券商回话", "// 等券商回话")
h(RC, "static constexpr double kReconcileGraceMs = 120'000;", "static constexpr double kReconcileGraceMs = 12'000;") if False else None
# ---- 停摆 / 账户风控 / 出场
h(WG, "if (!(stopped > kGapMs)) return std::nullopt;", "if (!(stopped >= kGapMs)) return std::nullopt;")
h(WG, "return WakeGap{asleep * 2 >= stopped ? GapKind::Sleep : GapKind::Stall,", "return WakeGap{asleep * 2 > stopped ? GapKind::Sleep : GapKind::Stall,")
h(WG, "const double asleep = jsx::min(stopped, jsx::max(0, stopped - (s.mono - *prevMono_)));", "const double asleep = jsx::min(stopped, stopped - (s.mono - *prevMono_));")
h(WG, "if (gap->kind == GapKind::Sleep) settle_ =", "if (true) settle_ =")
h(WG, "const bool steady = st.linkSince && s.wall - *st.linkSince >= kSettleMs;", "const bool steady = st.linkSince && s.wall - *st.linkSince > kSettleMs;")
h(WG, "if (!steady && s.wall - st.since < kSettleMaxMs) return", "if (!steady && s.wall - st.since <= kSettleMaxMs) return")
h(WG, "if (!gap && open_ && s.wall - open_->to >= kQuietMs) {", "if (!gap && open_ && s.wall - open_->to > kQuietMs) {")
h(WG, "if (live.total > ep.live.total) ep.live = live;", "ep.live = live;")
h(WG, "ep.kind = ep.asleep_ms * 2 >= ep.stopped_ms ? GapKind::Sleep : GapKind::Stall;", "ep.kind = GapKind::Sleep;")
h(WG, "if (ep.live.total == 0 || span < kNotifyMinMs) return std::nullopt;", "if (span < kNotifyMinMs) return std::nullopt;") if False else None
h(WG, "if (ep.live.total == 0 || span < kNotifyMinMs) return std::nullopt;", "if (ep.live.total == 0 || span <= kNotifyMinMs) return std::nullopt;")
h(WG, "ep.awake_ms += gap.from - ep.to;", "")
h(WG, "if (s.link != st.link) {", "if (false) {")
h(WG, "void WakeGuard::pause() {\n    prevWall_.reset();\n    prevMono_.reset();", "void WakeGuard::pause() {\n    prevWall_.reset();")
h(AG, "capped = l.max_open_risk_usd > 0 || l.max_underlying_contracts > 0;", "capped = l.max_open_risk_usd > 0;")
h(AG, "bool capped = s.limits.max_open_risk_usd > 0 || s.limits.max_underlying_contracts > 0;", "bool capped = s.limits.max_open_risk_usd > 0;")
h(AG, "if (reducesPositions(asOrder(w), alias, rows)) continue;", "")
h(AG, "const std::optional<QList<OJson>>& pick = rows ? rows : lastRows_;", "const std::optional<QList<OJson>>& pick = rows;")
h(AG, "if (!rows) out.exposure = js::Null();", "if (!rows) out.exposure = js::object();")
h(AG, "if (!daily.enabled || daily.basis != u\"account\") return std::nullopt;", "if (!daily.enabled) return std::nullopt;")
h(AG, "if (!tripped_.contains(alias)) {", "if (true) {")
h(AG, "if (std::isnan(trippedLoaded_) || trippedLoaded_ != today) {", "if (std::isnan(trippedLoaded_)) {")
h(AG, "if (accountPauses.size() == state.accountPauses.size()) return state;", "")
h(AG, "if (!accountPauses.contains(alias)) accountPauses.insert(alias, tripped_.find(alias)->pause);", "accountPauses.insert(alias, tripped_.find(alias)->pause);")
h(AG, "if (!equity.isEmpty()) out.equity = equity;", "out.equity = equity;")
h(AG, "co_return rows && reducesPositions(approved.order, approved.account.alias, *rows);", "co_return reducesPositions(approved.order, approved.account.alias, rows.value_or(QList<OJson>{}));")
h(EX, "if (!confirm || position.sec_type == u\"STK\") return price;", "if (!confirm) return price;")
h(EX, "if (it != marks_.cend() && it->round == round_) return it->out;", "")
h(EX, "if (price && prev) out = tk::isLong(position) ? jsx::min(*prev, *price) : jsx::max(*prev, *price);", "if (price && prev) out = tk::isLong(position) ? jsx::max(*prev, *price) : jsx::min(*prev, *price);")
h(EX, "if (!analysis::timeExitLapsed(targets, nowMs)) return targets;", "")
h(EX, "if (index < 0 || js::truthy(js::prop(&track, u\"enabled\"_s)) ||", "if (index < 0 ||")
h(EX, "if (before && !(std::fabs(position.quantity) < js::num(before))) return false;", "")
h(EX, "if (!(js::isStr(finalStatus) && finalStatus->s == u\"filled\")) return false;", "")
h(EX, "const bool fresh = first || (!seen.isEmpty() && !seen.contains(state));", "const bool fresh = first;")
h(EX, "if (!fresh || js::truthy(js::prop(&*fresh, u\"fired_at\"_s))) return;", "if (!fresh) return;")
h(EX, "if (fallback) out.set(u\"stop_fallback\"_s, js::B(true));", "")
h(EX, "opts.peakPrice = fallback ? std::nullopt : peakMark(", "opts.peakPrice = peakMark(")
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
    by = {}
    for c in cands:
        by.setdefault(c[0], []).append(c)
    rnd = random.Random(0xE9C1)
    for f, lst in by.items():
        rnd.shuffle(lst)
        for _f, n, newline in lst[: FILES[f][1]]:
            mut.append({"kind": "mech", "file": _f, "line": n, "newline": newline})
    return mut[: MAX]


def tests_for(m):
    return FILES[m["file"]][0]


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
    if not os.path.exists(os.path.join(B, "build.ninja")):
        r = sh(["cmake", "-S", NATIVE, "-B", B, "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Debug", "-DCMAKE_CXX_COMPILER=/Library/Developer/CommandLineTools/usr/bin/clang++",
                "-DCMAKE_OSX_SYSROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk", "-DCMAKE_MAKE_PROGRAM=/opt/homebrew/bin/ninja", "-DCMAKE_CXX_FLAGS_DEBUG=-g0",
                "-DCMAKE_PREFIX_PATH=/opt/homebrew", "-DIBKR_BUILD_UI=OFF"])
        if r.returncode != 0:
            raise SystemExit("configure failed: " + r.stdout + r.stderr)


def build(targets):
    targets = sorted({t[0] if isinstance(t, tuple) else t for t in targets})
    for _ in range(4):
        b = sh(["cmake", "--build", B, "--target", *targets, "-j4"])
        if b.returncode == 0:
            return True
        if "Operation timed out" not in b.stdout + b.stderr:
            return False
        time.sleep(5)
    return False


def run(test):
    exe, args = test if isinstance(test, tuple) else (test, [])
    r = subprocess.run([os.path.join(B, "tests", exe), *args], capture_output=True, text=True, errors="replace", env=ENV, timeout=900)
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


# 幸存者的理由:(文件, 描述里的子串, 理由)。没写的输出里标 UNJUSTIFIED
REASONS = [
    # ---- hosted.cpp
    ("hosted.cpp", "line 265:", "等价:alive 只用于「不在 alive 且不在 known」的清理判断,而 alive 里的追踪必然在这一轮的 tracks 里,known 也有它;删掉插入不改变任何判断"),
    ("hosted.cpp", "line 445:", "等价:CloseGateArgs.alreadyFired 默认就是 false,这一行是 TS 里 alreadyFired: false 的逐字照搬"),
    ("hosted.cpp", "line 290:", "等价:追价时 hold 只影响「止盈单不在计划里是否也不撤」,而追价把 take_profit 设成了追价限价,计划里必有止盈单,desired 里本来就有 tp"),
    ("hosted.cpp", "line 131:", "等价:同上(hold 在追价那一支里恒被止盈单的存在盖住)"),
    ("hosted.cpp", "line 324:", "等价:retry 是从表里拷出来的局部副本,warn 的真正清除在上一行写回表里;副本之后只读 reason"),
    ("hosted.cpp", "line 836:", "测试辅助(snapshot 的键排序),不是产品路径;QHash 的遍历次序碰巧排好的话看不出,断言用的 JS 一侧已排序"),
    ("hosted.cpp", "line 586:", "等价:循环里 i == rows.size() 时 keep.contains(i) 为假直接 continue,多走一格不读 rows[i]"),
    ("hosted.cpp", "line 626:", "不可达:closeContractIssue 已用同一个 closeContract 与同一份 schema 校验过,safeParse 在它之后不会失败(TS 同:ZodError 走不到)"),
    ("hosted.cpp", "line 497:", "等价:chase_limit 与 chase_rounds 总是一起写(syncHosted 记追价那几行),有 chase_limit 就一定有 chase_rounds,?? 0 的兜底走不到"),
    ("hosted.cpp", "line 297:", "等价:`curp && filled > 0` 里 curp 为空时 filled 的取值不被用到"),
    ("hosted.cpp", "line 807:", "不可达:onStatus 撤销分支里 entry 为空只发生在缓存与 hostedIndex 不一致时,两者总是一起增删(dropHostedEntry)"),
    # ---- callbacks.cpp
    ("callbacks.cpp", "while (host_.unmatchedEvents().size() > 200) => while (host_.unmatchedEvents().size() > 201)", "等价(replay 里的那一处):重放结束时缓冲不会比重放前大,而攒的那一处已经把它压在 200 以内,这里的上限走不到;攒的那一处由 cb_unmatched_cap_200 钉着"),
    ("callbacks.cpp", "line 62: while (host_.unmatchedEvents().size() > 201)", "等价:同上(重放里的上限走不到 201)"),
    ("callbacks.cpp", "!execId.isEmpty() && host_.seenFills().contains(execId)) return;", "等价:seenFills 里从来没有空串(只在 execId 非空时才插入),contains(\"\") 恒假"),
    ("callbacks.cpp", "line 95:", "不可达:status_timeline 的每一项都是事件折出来的对象,不会有非对象的项"),
    # ---- reconcile.cpp
    ("reconcile.cpp", "quantity >= 0 && filledQty + 1e-9 < quantity", "等价:quantity 为 0 时 filledQty + 1e-9 < 0 恒假(成交数量非负),多进一次判断不改结果"),
    # ---- wake_guard.cpp
    ("wake_guard.cpp", "line 94:", "等价:gapOf 要两个前值都在才认,pause 清掉其中任何一个就够了,清另一个多余(TS 两个都清,照搬)"),
    ("wake_guard.cpp", "line 93:", "等价:同上"),
    ("wake_guard.cpp", "line 39: if (!prevWall_ && !prevMono_)", "等价:prevWall_ 与 prevMono_ 总是一起设一起清,只有一个存在的状态不会出现"),
    ("wake_guard.cpp", "line 130:", "等价:etTime 的 seconds 缺省值没有调用方用到,调用处都显式传"),
    # ---- account_guard.cpp
    ("account_guard.cpp", "accountPauses.size() == state.accountPauses.size()) return state;", "等价(按值):TS 返回同一个对象或一份内容相同的新对象,调用方只读它的内容;内容一样"),
    ("account_guard.cpp", "line 75:", "等价:rows 在 positions() 抛出时本来就没被赋值,catch 里再置空是 TS 里 .catch(() => null) 的搬法,值不变"),
    ("account_guard.cpp", "if (!accountPauses.contains(alias)) accountPauses.insert(alias, tripped_.find(alias)->pause);", "等价:state 里已有的别名在上一步循环里已经以 state 的暂停盖进了 tripped_,两边是同一个值"),
    ("account_guard.cpp", "co_return rows && reducesPositions(approved.order, approved.account.alias, *rows);", "等价:持仓读不到时拿空表去认「是不是减仓」,空表里没有这条持仓,认出来也是假"),
    ("account_guard.cpp", "line 31:", "等价:contractsKey 自己也只取到期日的前 8 位(openRisk.ts),这里再切 8 位是 TS 里 expiryOf 的原样,多切少切都落到同一个键"),
    ("account_guard.cpp", "line 86:", "等价:全局那一项会被下面按账户的循环盖住(limitsFor 把全局值带进每个账户,配置里至少有一个账户),改它不改变 capped"),
    ("account_guard.cpp", "bool capped = s.limits", "等价:同上(全局限额由按账户的循环等价地覆盖)"),
    ("closing.cpp", "line 110:", "等价:V8 的排序只判断比较结果是否小于 0,同键相等时回 0 还是回 1 都当「不挪」"),
    ("exits.cpp", "line 81:", "等价:timeExitDue 自己就拒绝已作废(lapsed)的目标,返回的拷贝里 exit_at_ms 留不留,这一轮的判断结果相同"),
    ("reconcile.cpp", "execSyncAt_ < 1", "等价:isinf 为真时 execSyncAt_ 只可能是 -inf(从不赋 +inf),`< 0` 恒真,换成 < 1 / <= 0 不改变"),
    ("reconcile.cpp", "execSyncAt_ <= 0", "等价:同上"),
    ("wake_guard.cpp", "void WakeGuard::pause()", "等价:gapOf 要两个前值都在才认,清其中一个就够了(TS 两个都清,照搬)"),
    ("account_guard.cpp", "co_return rows && reducesPositions", "等价:持仓读不到时拿空表去认「是不是减仓」,空表里没有这条持仓,结果同为假"),
    ("account_guard.cpp", "if (!accountPauses.contains(alias))", "等价:state 里已有的别名在前一个循环里已经以 state 的暂停盖进了 tripped_,两边是同一个值"),
    # ---- closing.cpp
    ("closing.cpp", "line 25:", "等价:LegIntent.quantity 的初值每个构造处都会覆盖,默认值走不到"),
    # ---- session_hours.cpp
    ("session_hours.cpp", "line 105:", "等价:legs 既不是 null 也不是数组时(TS 里 `legs.length` 为 undefined → 当没有)这里 items 也是空,两种写法同一个结果"),
    ("session_hours.cpp", "line 31:", "不可达:TS 在 spec 为空时 `spec.outsideRth` 就抛 TypeError,订单一定带 order 字段(校验过)"),
    # ---- spot_stop.cpp / local_shorthand.cpp
    ("spot_stop.cpp", "line 34:", "等价:spot 在 indexPrice 抛出时本来就没被赋值(仍是空),catch 里再置空值不变"),
    ("local_shorthand.cpp", "line 59:", "不可达:速记解析出的每条订单都带 warnings 数组"),
    ("local_shorthand.cpp", "line 69:", "等价:localPayload 只在 try 的最后一句才赋值,抛出时它还是空"),
    ("local_shorthand.cpp", "line 63:", "不可达:速记解析出的 orders 一定是数组"),
]


def reason_for(m, res):
    if res != "survived":
        return ""
    d = describe(m)
    for f, sub, why in REASONS:
        if f == m["file"] and sub in d:
            return why
    return "UNJUSTIFIED"


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
            results.append([m["kind"], m["file"], describe(m), res, reason_for(m, res)])
            print(res, reason_for(m, res)[:60], m["kind"], m["file"], describe(m), flush=True)
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
