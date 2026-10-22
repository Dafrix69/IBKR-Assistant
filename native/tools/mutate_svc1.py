#!/usr/bin/env python3
"""svc1 簇(跟单 follow / 价位提醒 alerts / 异动 anomaly / 日内剧本 playbook 的服务层)的变异检验。

只在私有副本里做,绝不动项目里的源码(别的助手、验收、审查随时在编项目,会把变异编进去):
  副本 = ~/Developer/ibkr/work/mut-svc1/<SVC>/{native, build, desktop/engine-ts/docs/prompts 的符号链接}。每个 service 一份(SVC=follow 等),编译目录各自一个。
  首次运行先 rsync 一份 native/ 过去、配置编译目录(只编对应的测试目标:slim);之后每次启动把副本里的源码与测试同步成项目里的最新(变异之前)。
两类变异:
  · 手选(钱路径上的授权闸、localOnly 标记、去重、收回授权、重试上限、定时节拍……):见 HAND;
  · 机械生成:逐行的运算符翻转(== != < <= > >= && || + -)、true/false 互换、整数常量 +1、删掉一条语句;候选太多时按固定种子抽样(MAX)。
每个变异是一处单行改动:写进副本 → 重编 → 跑(SVC1_FAILFAST=1:第一个场景不一样就结束)→ 记 caught / survived / build-error;finally 里还原、把文件时间往后拨几秒。
中途被杀时 finally 不会跑:改动前的原文先存进 restore-<SVC>.json,下次启动先按它还原。
幸存者每个要记一条理由(REASONS:子串 → 理由);没有理由的标成 "待审",补用例杀掉或写明为什么等价。

  SVC=follow python3 native/tools/mutate_svc1.py        # 跑
  SVC=follow CHECK=1 python3 native/tools/mutate_svc1.py # 只核对手选锚点(原文恰好出现 nth 次),不编不跑
  SVC=follow LIST=1 python3 native/tools/mutate_svc1.py  # 只列出会跑的变异
  RESUME=1 …   接着 OUT 里已有的结果往下跑      ONLY='子串|子串' MAX=… SHARD=i/n OUT=结果.json
"""
import json
import os
import random
import re
import shutil
import subprocess
import sys
import time

PROJECT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # IBKR-Assistant
WORK = "/Users/dafrix/Developer/ibkr/work/mut-svc1"
SVC = os.environ.get("SVC", "follow")
ROOT = os.path.join(WORK, SVC)
NATIVE = os.path.join(ROOT, "native")
B = os.path.join(ROOT, "build")
OUT = os.environ.get("OUT", os.path.join(WORK, f"mutate_svc1_{SVC}.json"))
ENV = {k: v for k, v in os.environ.items() if k != "ONLY"}  # ONLY 是本脚本挑变异用的,别传给测试(测试拿它挑场景)
ENV.update(QT_QPA_PLATFORM="offscreen", SVC1_FAILFAST="1")
EXE = "engine/orchestrate/services/"
MAX = int(os.environ.get("MAX", "220"))
SERVICES = {
    "follow": {"files": ["follow_service.cpp", "follow_service.h"], "test": "tst_svc_follow"},
    "alerts": {"files": ["alerts_service.cpp", "alerts_service.h"], "test": "tst_svc_alerts"},
    "anomaly": {"files": ["anomaly_service.cpp", "anomaly_service.h"], "test": "tst_svc_anomaly"},
    "playbook": {"files": ["playbook_service.cpp", "playbook_service.h"], "test": "tst_svc_playbook"},
}
FILES = SERVICES[SVC]["files"]
TEST = SERVICES[SVC]["test"]

H = []  # (文件, 原文, 改成, 第几处(缺省必须恰好一处))


def h(f, old, new, nth=None):
    H.append((SVC, f, old, new, nth))


F, A = "follow_service.cpp", "alerts_service.cpp"
# ---- follow:钱路径
h(F, "InstructionScope{true}", "InstructionScope{false}")                       # 跟单那一趟必须带 localOnly:Discord 文字到不了大模型
h(F, "if (st.follow().has(message.id)) co_return;", "")                          # 库里已处理过的消息不再发
h(F, "if (handled_.contains(message.id)) return chain_;", "")                    # 进程内去重(断线补发)
h(F, "if (!cfg.enabled || !cfg.track_fly) {", "if (!cfg.enabled && !cfg.track_fly) {")  # 收回授权:关掉任何一个,在等的一律放弃
h(F, "if (!cfg.enabled || !cfg.track_fly) {", "if (!cfg.track_fly) {")
h(F, "if (!cfg.track_fly || !js::isArr(&submitted) || submitted.items.isEmpty()) return std::nullopt;", "if (!js::isArr(&submitted) || submitted.items.isEmpty()) return std::nullopt;")
h(F, 'if (!signal || signal->leader.side != u"debit") continue;', 'if (!signal) continue;')  # 贷方价差不建追踪
h(F, "gates.autoExecute = settings().policies.auto_execute;", "gates.autoExecute = true;")
h(F, "gates.connected = router && router->hasSessions();", "gates.connected = true;")
h(F, "if (breaker.engaged) gates.breaker = breaker.reason;", "")
h(F, 'if (!symbol || !snap.get(*symbol)) {', 'if (!symbol) {')                 # 拿不到现价不跟
h(F, "if (edge) {", "if (false) {")                                             # 百位边上的「N蝴蝶」不跟
h(F, "if (meta.relativeCenter) {", "if (false) {")
h(F, "if (stale) {", "if (false) {")
h(F, "const OJson payload = co_await eng().tryLocalShorthand(text, snap, at, meta);", "const OJson payload = OJson::null();")
h(F, "accounts = eng().resolveFanoutAccounts(settings(), cfg.accounts);", "accounts = cfg.accounts;")
h(F, "result = co_await eng().handleInstruction(text, u\"discord\"_s, at, snap, accounts, false, InstructionScope{true});", "result = co_await eng().handleInstruction(text, u\"discord\"_s, at, snap, accounts, true, InstructionScope{true});")
h(F, "text, u\"discord\"_s, at, snap", "message.content, u\"discord\"_s, at, snap")
h(F, "const QString text = pf::orderText(message.content);", "const QString text = message.content;")
h(F, 'static constexpr int kTrackAddAttempts = 10;', 'static constexpr int kTrackAddAttempts = 9;') if False else None
h("follow_service.h", "static constexpr int kTrackAddAttempts = 10;", "static constexpr int kTrackAddAttempts = 11;")
h("follow_service.h", "static constexpr int kTrackPollMs = 3000;", "static constexpr int kTrackPollMs = 2000;")
h("follow_service.h", "static constexpr int kSeenMax = 30;", "static constexpr int kSeenMax = 29;")
h("follow_service.h", "static constexpr int kHandledMax = 2000;", "static constexpr int kHandledMax = 1999;")
h(F, "refused = e.code() == -32602;", "refused = e.code() != -32602;")
h(F, "retryable = e.code() == -32602 && e.message().startsWith(u\"到点平仓\"_s);", "retryable = e.message().startsWith(u\"到点平仓\"_s);")
h(F, "if (!refused && failures < kTrackAddAttempts) {", "if (failures < kTrackAddAttempts) {")
h(F, "if (!exitAt.isEmpty()) {\n                try {", "if (true) {\n                try {")
h(F, "const bool readable = rows && (!covered || covered->contains(item.account));", "const bool readable = rows.has_value();")
h(F, "const double misses = (order.filled && order.final_ && held.has_value() && !*held) ? double(trackMisses_.value(item.record_id, 0)) + 1 : 0;", "const double misses = 0;")
h(F, "if (!order.final_) {\n        pf::PendingTrack t = item;", "if (order.final_) {\n        pf::PendingTrack t = item;")
h(F, "if (!item.settled_fills && orders.value(item.record_id).filled) needRows = true;", "if (orders.value(item.record_id).filled) needRows = true;")
h(F, "paper = !managed.isEmpty() && std::all_of(", "paper = managed.isEmpty() || std::all_of(")
h(F, "return id.startsWith(u'D');", "return id.startsWith(u'U');")
h(F, "settings().broker.provider != u\"ibkr\"", "settings().broker.provider == u\"ibkr\"")
h(F, "if (isBrokerLike(failure)) co_return;", "")
h(F, "if (quotedOutcome(js::str(entry->get(u\"outcome\"_s)))) return;", "") if False else None
h(F, "if (!quotedOutcome(js::str(entry->get(u\"outcome\"_s)))) return;", "")
h(F, "if (gatewayId_ == id) util::detach(onMessage(message));", "util::detach(onMessage(message));")
h(F, "if (gatewayId_ == id) onPhase(phase, error);", "onPhase(phase, error);")
h(F, "if (inboxId_ == id) util::detach(onMessage(message));", "util::detach(onMessage(message));")
h(F, "if (!started_ || settings().follow.channel_id.isEmpty()) co_return;", "if (settings().follow.channel_id.isEmpty()) co_return;")
h(F, "if (!started_) co_return;\n    syncInbox();", "syncInbox();")
h(F, "if (gateway_ && !restart) co_return;", "if (gateway_) co_return;")
h(F, "armTrackTimer();\n    util::detach(sync());", "util::detach(sync());")
h(F, "if (!started_ || trackTimer_ != 0) return;", "if (trackTimer_ != 0) return;")
h(F, "if (pendingCount() > 0) armTrackTimer();", "armTrackTimer();")
h(F, "if (trackTimer_ != 0) rt().clearTimeout(trackTimer_);", "")
h(F, 'if (verdict == u"wait") co_return item;\n        if (verdict == u"absorbed")', 'if (verdict == u"wait") co_return std::nullopt;\n        if (verdict == u"absorbed")')
h(F, 'if (verdict == u"covered" && existing) {', 'if (verdict == u"covered") {') if False else None
h(F, "if (outcome == u\"retry\") co_return item;", "")
h(F, "if (dump(next) != dump(items)) savePending(next);", "savePending(next);")
h(F, "if (!known.contains(item.record_id)) next.push_back(item);", "")
h(F, "if (!live.contains(id)) book->remove(id);", "")
h(F, "if (!waiting.empty()) {", "if (true) {")
h(F, "if (!item.settled_fills) waiting.push_back(item);", "waiting.push_back(item);")
h(F, "st.audit(u\"engine\"_s, u\"follow_track\"_s, &detail);", "")
h(F, "if (!st.follow().add(entry)) return std::nullopt;", "st.follow().add(entry);")
h(F, "if (tracking) result.detail = result.detail + u\";\"_s + tracking->note;", "")
h(F, "if (tracking && !tracking->items.empty()) {", "if (tracking) {")
# ---- 发单之后的 try 边界(C++ 独有:用户 2026-10 决定)
h(F, "postWarn(message, u\"llm\"_s, std::current_exception());", "throw;")
h(F, "postWarn(message, u\"outcome\"_s, std::current_exception());", "throw;")
h(F, "postWarn(message, u\"conclude\"_s, std::current_exception());", "throw;")
h(F, "if (!postSubmit) return fn();", "return fn();")
h(F, "conclude(message, r, payload, submitted, true);", "conclude(message, r, payload, submitted, false);")
h(F, "if (!store().follow().has(message.id)) finish(message, r, true);", "")
h(F, "    if (!failure) {\n        postSubmit(message, result, payload, decision.summary);\n        co_return;\n    }", "    if (!failure) {\n        failure = std::make_exception_ptr(util::JsError(u\"x\"_s));\n        postSubmit(message, result, payload, decision.summary);\n    }")
h(F, "store().audit(u\"engine\"_s, u\"follow_post_submit_error\"_s, &detail);", "")
# ---- alerts
h(A, "if (!inWindow || !router || !router->hasSessions()) co_return std::nullopt;", "if (!router || !router->hasSessions()) co_return std::nullopt;", 1)
h(A, "if (tried != levelTried_.constEnd() && nowMs - *tried < kLevelsBackoffMs) return false;", "")
h(A, "if (nowMs < openMs) return false;", "")
h(A, "return !std::isfinite(at) || at < openMs;", "return at < openMs;")
h(A, "if (!js::truthy(watch.get(u\"enabled\"_s))) return false;", "")
h(A, "if (!fallback || *fallback == 0 || std::isnan(*fallback)) {", "if (!fallback) {")
h(A, "wallError = svc1::slice(excMessage(wallFailure), 300);", "wallError = excMessage(wallFailure);")
h(A, "if (history) saveTouchBook(js::str(watch.get(u\"id\"_s)), *history, today);", "")
h(A, "if (touched.contains(level.source)) nextStates.set(", "if (false) nextStates.set(")
h(A, "if (session && linked.sample.settled) {", "if (session) {")
h(A, "const double stamp = nowMs - std::fmod(nowMs, 1000.0);", "const double stamp = nowMs;")
h(A, "eng().notify(title, js::str(event.get(u\"text\"_s)), QString(), false);", "eng().notify(title, js::str(event.get(u\"text\"_s)), QString(), true);")
h(A, "if (all.size() > 50) all = all.mid(all.size() - 50);", "")
h(A, "if (watching.isEmpty()) ", "") if False else None
h(A, "if (levelsStatusOf", "") if False else None
h(A, "if (watches.size() >= kMaxWatch) {", "if (watches.size() > kMaxWatch) {")
h("alerts_service.h", "static constexpr int kMaxWatch = 30;", "static constexpr int kMaxWatch = 31;")
h("alerts_service.h", "static constexpr double kLevelsBackoffMs = 600'000;", "static constexpr double kLevelsBackoffMs = 599'000;")
h("alerts_service.h", "static constexpr double kTouchBackoffMs = 1'800'000;", "static constexpr double kTouchBackoffMs = 1'700'000;")

# ---- anomaly
N = "anomaly_service.cpp"
h(N, "const bool inWindow = settings().isTradingDay(et.date) && minute >= -kAnomalyWarmupMinutes && minute < sessionMinutes + kAnomalyTailMinutes;", "const bool inWindow = minute >= -kAnomalyWarmupMinutes && minute < sessionMinutes + kAnomalyTailMinutes;")
h(N, "const bool inWindow = settings().isTradingDay(et.date) && minute >= -kAnomalyWarmupMinutes && minute < sessionMinutes + kAnomalyTailMinutes;", "const bool inWindow = settings().isTradingDay(et.date) && minute > -kAnomalyWarmupMinutes && minute < sessionMinutes + kAnomalyTailMinutes;")
h(N, "if (gen != gen_ || !loop_.running) co_return;", "if (!loop_.running) co_return;")
h(N, "if (!source || !source->supportsVolumeQuotes()) {", "if (!source) {")
h(N, "const bool fresh = samples.size() < 2;", "const bool fresh = false;")
h(N, "const bool stale = lastTradeAt && staleMs > kQuoteStaleMs;", "const bool stale = false;")
h(N, "a.suppress = fresh || stale;", "a.suppress = fresh;")
h(N, "const double effMinute = delayedTrue ? minute - kDelayedShiftMinutes : minute;", "const double effMinute = minute;")
h(N, "const double sessionMinutes = settings().early_close_days.contains(et.date) ? 210 : 390;", "const double sessionMinutes = 390;")
h(N, "source->releaseVolumeStreams(symbols);", "")
h("anomaly_service.h", "static constexpr double kQuoteStaleMs = 15 * 60'000;", "static constexpr double kQuoteStaleMs = 14 * 60'000;")
h("anomaly_service.h", "static constexpr double kDelayedShiftMinutes = 15;", "static constexpr double kDelayedShiftMinutes = 14;")
# ---- playbook
P = "playbook_service.cpp"
h(P, "if (!enabled()) co_return idle(u\"已关闭\"_s);", "")
h(P, "if (afterClose >= kPriorDelayMin && afterClose < kPriorDelayMin + kPriorWindowMin) {", "if (afterClose > kPriorDelayMin && afterClose < kPriorDelayMin + kPriorWindowMin) {")
h(P, "if (afterClose >= kPriorDelayMin && afterClose < kPriorDelayMin + kPriorWindowMin) {", "if (afterClose >= kPriorDelayMin && afterClose <= kPriorDelayMin + kPriorWindowMin) {")
h(P, "if (et.minutes < kOpenMin) co_return idle(u\"等 09:35 的盘初定价\"_s);", "if (et.minutes <= kOpenMin) co_return idle(u\"等 09:35 的盘初定价\"_s);")
h(P, "if (day->prior && *spot == day->prior->b.anchor) co_return", "if (false) co_return")
h(P, "const bool onTime = (et.seconds - kOpenMin * 60) * 1000 <= kLiveAnchorMs;", "const bool onTime = (et.seconds - kOpenMin * 60) * 1000 < kLiveAnchorMs;")
h(P, "const bool barDone = et.minutes > kOpenMin;", "const bool barDone = et.minutes >= kOpenMin;")
h(P, "static constexpr double kRetryMs = 30'000;", "static constexpr double kRetryMs = 29'000;") if False else None
h("playbook_service.h", "static constexpr double kRetryMs = 30'000;", "static constexpr double kRetryMs = 29'000;")
h("playbook_service.h", "static constexpr double kBackfillRetryMs = 10 * 60'000;", "static constexpr double kBackfillRetryMs = 9 * 60'000;")
h("playbook_service.h", "static constexpr double kWallWidth = 15;", "static constexpr double kWallWidth = 14;")
h("playbook_service.h", "static constexpr qsizetype kMaxEvents = 50;", "static constexpr qsizetype kMaxEvents = 49;")
h("playbook_service.h", "static constexpr double kFrameMin = 5;", "static constexpr double kFrameMin = 6;")
h("playbook_service.h", "static constexpr double kLiveAnchorMs = 2.0 * kTickMs;", "static constexpr double kLiveAnchorMs = 1.0 * kTickMs;")
h(P, "const bool delayedOk = managed.size() > 0 && every;", "const bool delayedOk = every;")
h(P, "if (!due(*day, u\"anchor\"_s, nowMs, kBackfillRetryMs)) co_return;", "")
H[:] = [x for x in H if x is not None and x[1] in FILES]

# 幸存者理由(子串 → 理由)。补完用例后留下的才写在这里
REASONS = [
    # ---- follow
    ("if (handled_.contains(message.id)) return chain_;", "进程内去重只是快路:库里 follow.has 在 process 开头同样拦下,重复的那条排到队里走一遍也不发、不记"),
    ("kHandledMax = 1999", "进程内已处理表的容量只影响快路;被挤出去的 id 再来时库里 has 照样拦"),
    ("if (!live.contains(id)) book->remove(id);", "只清内存里的重试计数;记录 id 唯一,不再出现,没有可观察的差别"),
    ("if (!contract.success && !order.success) return std::nullopt;", "任一 safeParse 失败时 data 为空,leaderPrice 对空对象一律回空:|| 与 && 无法区分"),
    ("rowFound->get(u\"quantity\"_s)) : 1;", "只在 verdict == create 时用,那时持仓行一定找到了,另一支走不到"),
    ("orders.value(item.record_id) : OrderFacts", "orders 里对每个待建的项都有一条,缺省支走不到"),
    ("double(fillsV->items.size()) : 1;", "foldEvents 保证 ibkr.fills 是数组,另一支走不到"),
    ("line 467: ;", "删掉 handled_.insert:同 handled_ 快路,库里 has 照样拦,等价"),
    ("line 468: ;", "删掉 handledOrder_.push_back:顺序表只在已处理表满 2000 个时才用到,等价"),
    ("if (!record && record->type != OJson::Object) return {false, true, 0};", "记录缺失时对空 optional 取值是未定义行为,实际读出的不是 Object,同样回「走完了、没成交」;正常编出来的二进制里不可区分"),
    ("(order.filled && order.final_ || held.has_value() && !*held)", "misses 只在 pendingVerdict 里与 filled && final && held == false 同时成立时才有用,别的组合下数不数都一样"),
    ("(order.filled && order.final_ && held.has_value() || !*held)", "同上;held 为空时对空 optional 取值是未定义行为,读出来是假"),
    ("bool filled = true, final_ = false;", "Facts 的缺省值每处构造都被覆盖"),
    ("bool paper = true;", "paper 在 try 里先赋值;marketSession 抛了就直接 co_return,缺省值用不到"),
    ("if (!store().follow().has(message.id)) finish(message, r, true);", "尽力补写一次:写不进去是库一直坏着(脚本里的触发器),补写同样失败,看不出差别;库只坏一下的情形离线造不出来"),
    ("详见审计 follow_post_submit_error)\"_s, decisionSummary, ids, false}", "C++ 独有的兜底结果,键序只影响 emit 载荷里 entry 的次序,这条不与 TS 对拍"),
    # ---- alerts
    ("if (!(js::isStr(asOf) || asOf->s == prevDay)) return out;", "bookLineFor 开头有同一道 as_of 核对,这里是重复的前置检查(TS 只在 withBookSums 里查一次),去掉一道结果不变"),
    ("if (!(js::isStr(asOf) || asOf->s == prevDay)) return levels;", "同上:bookLineFor 里还有同一道核对"),
    ("line 51: ;", "priority 只有 reroundLevels / buildLevels 的合并用,storedLevel 出来的价位只进 evaluate,evaluate 不读它"),
    ("if (js::isStr(trig) || trig->s == u\"touch\") touched.insert", "多落防的是已经报过穿越的那些线,evaluate 已经把它们按同一个值落防(armed=false, last_fired_at=nowTs),等价"),
    ("? true : svc1::lengthOf(levels) != 0) ? u\"ok\"_s : u\"pending\"_s;", "levels 为 null 只会出自手改的库;库里写的永远是数组"),
    ("bool anyMa = true;", "初值为真时走 withBookSumsRaw,没有均线价位的行经它映射后与原行逐项相同,输出一样"),
    # ---- anomaly(结论来自负责这份移植的助手逐条核对)
    ("staleMs = lastTradeAt ? nowMs - *lastTradeAt : 1;", "staleMs 只在 lastTradeAt 有值时才用,另一支的值没人读"),
    ("line 62:", "evaluateAnomalies 不读 high"),
    ("line 63:", "evaluateAnomalies 不读 low"),
    ("value_or(1) * 1000", "tradedMs 取 0 或 1000 都远小于 openMs 与 nowMs,进不了任何比较"),
    ("all.size() - 51", "TradeStore::updateQualityStock 自己把事件截到 50 条,服务这一道 slice(-50) 没有可观察的效果"),
    ("line 182: ;", "stop 里 timer_.reset():之后对已死的 id 调 clearTimeout 不记日志,世界不复用 id"),
    ("line 230: ;", "dropMarket 里 marketSamples_.clear():同函数里 marketRef_ 一并复位,下一轮 marketMove 新建参照时本来就清样本"),
    ("line 109: ;", "ref.changedAt 缺省时读的是 tickedAt,同为 nowMs"),
    # ---- playbook(同上)
    ("gen_ += 2;", "gen_ 只比相等"),
    ("line 35: ;", "db_path 在文件系统根目录:测试世界的库永远在临时目录里,根目录写 /playbook 离线测不了"),
    ("mids.size() >", "走到这一行时 mids 一定有两个元素,条件恒真"),
    ("mids.size() >=", "走到这一行时 mids 一定有两个元素,条件恒真"),
    ("line 595: ;", "dayFor 在 snapshot 里不会抛(读日志的坏行被跳过),catch 里的赋值是死代码"),
    ("kMaxEvents) day->events.erase", "事件数恰为上限时 erase 的是空区间,> 与 >= 等价"),
]

MECH_RULES = [(" == ", " != "), (" != ", " == "), (" <= ", " < "), (" >= ", " > "), (" < ", " <= "), (" > ", " >= "), (" && ", " || "), (" || ", " && "), (" + ", " - "), (" - ", " + ")]


def mask(line):
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
            if not st or st.startswith(("//", "#", "/*", "*", "}", "{")) or f.endswith(".h") and not re.search(r"constexpr", st):
                continue
            m = mask(line)
            for a, b in MECH_RULES:
                for mt in re.finditer(re.escape(a), m):
                    cands.append((f, n, line[: mt.start()] + b + line[mt.end():]))
            for mt in re.finditer(r"\b(true|false)\b", m):
                cands.append((f, n, line[: mt.start()] + ("false" if mt.group(1) == "true" else "true") + line[mt.end():]))
            for mt in re.finditer(r"(?<![\w.'])(\d+)(?![\w.'])", m):
                cands.append((f, n, line[: mt.start()] + str(int(mt.group(1)) + 1) + line[mt.end():]))
            if re.match(r"^(throw |[A-Za-z_][\w:>.\-]*(\(|\[| = ))", st) and st.endswith(";") and not re.match(r"^(return|co_return|const|auto|else|QString|std::|OJson|bool|int|double|static|QStringList)\b", st) and "{" not in st:
                cands.append((f, n, re.match(r"\s*", line).group(0) + ";"))
    return cands


def build_list():
    mut = []
    for _, f, old, new, nth in H:
        mut.append({"kind": "hand", "file": f, "old": old, "new": new, "nth": nth})
    cands = mech_candidates()
    random.Random(0x5C1).shuffle(cands)
    for f, n, newline in cands[: max(0, MAX - len(H))]:
        mut.append({"kind": "mech", "file": f, "line": n, "newline": newline})
    return mut


def check():
    bad = 0
    for _, f, old, new, nth in H:
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
    # rsync 的目标是 NATIVE(在 WORK 之内,不是符号链接);--delete 只清副本里的
    assert os.path.realpath(NATIVE).startswith(os.path.realpath(WORK))
    r = sh(["rsync", "-a", "--delete", "--exclude=.vscode", "--exclude=build*", os.path.join(PROJECT, "native") + "/", NATIVE + "/"])
    if r.returncode != 0:
        raise SystemExit("rsync failed: " + r.stderr)
    if not os.path.exists(os.path.join(B, "build.ninja")):
        r = sh(["cmake", "-S", NATIVE, "-B", B, "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Debug", "-DCMAKE_CXX_COMPILER=/Library/Developer/CommandLineTools/usr/bin/clang++",
                "-DCMAKE_OSX_SYSROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk", "-DCMAKE_PREFIX_PATH=/opt/homebrew", "-DCMAKE_MAKE_PROGRAM=/opt/homebrew/bin/ninja", "-DIBKR_BUILD_UI=OFF"])
        if r.returncode != 0:
            raise SystemExit("configure failed: " + r.stdout + r.stderr)


def build():
    for _ in range(4):
        b = sh(["/opt/homebrew/bin/ninja", "-C", B, TEST])
        if b.returncode == 0:
            return True
        if "Operation timed out" not in b.stdout + b.stderr:
            return False
        time.sleep(5)
    return False


def run():
    r = subprocess.run([os.path.join(B, "tests", TEST)], capture_output=True, text=True, errors="replace", env=ENV, timeout=900)
    if r.returncode != 0 and os.environ.get("SHOW_RED"):
        print((r.stdout + r.stderr)[-1500:], flush=True)
    return r.returncode == 0


def bump(path):
    t = time.time() + 3
    os.utime(path, (t, t))


JOURNAL = os.path.join(WORK, f"restore-{SVC}.json")


def recover():
    if not os.path.exists(JOURNAL):
        return
    with open(JOURNAL, encoding="utf-8") as fh:
        j = json.load(fh)
    assert j["path"].startswith(WORK)
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


def reason_of(desc):
    for sub, why in REASONS:
        if sub in desc:
            return why
    return "待审"


def report():
    """REPORT=a.json,b.json,…:按先后合并(后面的盖前面的),打印计数与每个幸存者的理由;有「待审」就退出码 1"""
    merged = {}
    for path in os.environ["REPORT"].split(","):
        for r in json.load(open(path, encoding="utf-8")):
            merged[(r[1], r[2])] = r
    from collections import Counter
    print(Counter(r[3] for r in merged.values()))
    todo = 0
    for (f, d), r in merged.items():
        if r[3] == "survived":
            why = reason_of(d)
            todo += why == "待审"
            print(f"  幸存 {f} {d[:110]}\n      理由:{why}")
    return 1 if todo else 0


def main():
    if os.environ.get("REPORT"):
        return report()
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
    if not build():
        raise SystemExit("baseline build failed")
    if not run():
        raise SystemExit("baseline is red")
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
                results.append([m["kind"], m["file"], describe(m), "bad-anchor", ""])
                print("bad-anchor", m["file"], describe(m), flush=True)
                continue
            with open(JOURNAL, "w", encoding="utf-8") as fh:
                json.dump({"path": path, "orig": orig}, fh, ensure_ascii=False)
            try:
                with open(path, "w", encoding="utf-8") as fh:
                    fh.write(mutated)
                bump(path)
                if not build():
                    res = "build-error"
                else:
                    res = "survived" if run() else "caught"
            finally:
                with open(path, "w", encoding="utf-8") as fh:
                    fh.write(orig)
                bump(path)
                os.remove(JOURNAL)
            why = reason_of(describe(m)) if res == "survived" else ""
            results.append([m["kind"], m["file"], describe(m), res, why])
            print(res, m["kind"], m["file"], describe(m), why, flush=True)
            with open(OUT, "w", encoding="utf-8") as fh:
                json.dump(results, fh, ensure_ascii=False, indent=1)
    finally:
        build()
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(results, fh, ensure_ascii=False, indent=1)
    from collections import Counter
    print(Counter(r[3] for r in results))
    return 0


if __name__ == "__main__":
    sys.exit(main())
