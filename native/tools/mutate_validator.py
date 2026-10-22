#!/usr/bin/env python3
"""validator 这一簇(parsing/validator、analysis/performance)的变异检验。

每个变异是一处单行改动:写进去 → 重编那个测试 → 跑 → 记 caught / survived;finally 里还原、把文件时间往后拨几秒
(ninja 按秒比时间戳)、重编。最后再把两个测试各重编一遍,保证留下的二进制是原样代码编的。

  python3 native/tools/mutate_validator.py                 # 全部
  GROUP=validator|performance python3 native/tools/mutate_validator.py
  ONLY='子串|子串' python3 native/tools/mutate_validator.py  # 只跑 old 里含这些子串的
  RERUN=上一次的结果.json python3 native/tools/mutate_validator.py  # 只重跑上一次没咬住的
结果 json 每行 [文件, old, new, 结果, 理由];结果是 survived 的必须有理由(见 WHY),否则退出码 2。
  BUILD=编译目录(默认 ~/Developer/ibkr/work/build-validator)  OUT=结果.json

中途被杀(重启、kill -9)时 finally 不会跑:改动前的原文先存进 tools/.mutate_validator[.GROUP].restore.json
(两组分开记,可以各用一个编译目录同时跑),
下次启动先按它还原;正常跑完删掉它。
"""
import json
import os
import subprocess
import sys
import time
from collections import Counter

# 只在私有副本里改(brief 第 3 条):NATIVE 指向副本里的 native/,默认 ~/Developer/ibkr/work/mut-validator/native
ROOT = os.environ.get("NATIVE", "/Users/dafrix/Developer/ibkr/work/mut-validator/native")
B = os.environ.get("BUILD", "/Users/dafrix/Developer/ibkr/work/mut-validator/build")
OUT = os.environ.get("OUT", os.path.join(B, "mutate_validator.json"))
ENV = dict(os.environ, QT_QPA_PLATFORM="offscreen")
V, PF = "tst_validator", "tst_performance_engine"
FILES = {
    "validator.cpp": os.path.join(ROOT, "engine", "parsing", "validator.cpp"),
    "performance.cpp": os.path.join(ROOT, "engine", "analysis", "performance.cpp"),
}

# (文件, 测试, 原文, 改成) —— 原文在文件里必须恰好出现一次
MV = [
    # ---- 小工具
    ("validator.cpp", V, "bool notNull(const OJson* v) { return !(v && v->type == OJson::Null); }", "bool notNull(const OJson* v) { return v && v->type != OJson::Null; }"),
    ("validator.cpp", V, "case OJson::Number: return a->n == b->n || (std::isnan(a->n) && std::isnan(b->n));", "case OJson::Number: return a->n == b->n;"),
    ("validator.cpp", V, "util::market::jsSort(legs, [](const OJson* a, const OJson* b) { return Nx(*a, u\"strike\") - Nx(*b, u\"strike\"); });",
     "util::market::jsSort(legs, [](const OJson* a, const OJson* b) { return Nx(*b, u\"strike\") - Nx(*a, u\"strike\"); });"),
    ("validator.cpp", V, "return std::isfinite(v) && v > 0 ? std::optional<double>(v) : std::nullopt;", "return std::isfinite(v) && v >= 0 ? std::optional<double>(v) : std::nullopt;"),
    ("validator.cpp", V, "return std::isfinite(*value) && *value > 0 ? value : std::nullopt;", "return *value > 0 ? value : std::nullopt;"),
    # ---- 参考价
    ("validator.cpp", V, "if (isStrEq(P(spec, u\"action\"), u\"BUY\") && buyCapped && limit) return limit;", "if (buyCapped && limit) return limit;"),
    ("validator.cpp", V, "const bool buyCapped = isStrEq(orderType, u\"LMT\") || isStrEq(orderType, u\"STP LMT\");", "const bool buyCapped = isStrEq(orderType, u\"LMT\");"),
    ("validator.cpp", V, "const bool stopIsPrice = isStrEq(orderType, u\"STP\") || isStrEq(orderType, u\"STP LMT\");", "const bool stopIsPrice = isStrEq(orderType, u\"STP\");"),
    ("validator.cpp", V, "for (const double c : candidates) m = jsmath::max(m, c);", "for (const double c : candidates) m = jsmath::min(m == -INFINITY ? c : m, c);"),
    ("validator.cpp", V, "if (!isStrEq(t, u\"LMT\") && !isStrEq(t, u\"STP LMT\")) return std::nullopt;", "if (!isStrEq(t, u\"LMT\")) return std::nullopt;"),
    ("validator.cpp", V, "if (isStrEq(t, u\"STP\") || isStrEq(t, u\"TRAIL\")) {", "if (isStrEq(t, u\"STP\")) {"),
    # ---- 合约要素
    ("validator.cpp", V, "if (!isStrEq(sec, u\"OPT\") && !isStrEq(sec, u\"BAG\")) return {};", "if (!isStrEq(sec, u\"OPT\")) return {};"),
    ("validator.cpp", V, "for (const OJson* l : legsOf(contract)) values.push_back(P(*l, u\"multiplier\"));", "for (const OJson* l : legsOf(contract)) (void)l;"),
    ("validator.cpp", V, "if (util::weekdayOfDate(dateIso) != 4) return false;", "if (util::weekdayOfDate(dateIso) != 3) return false;"),
    ("validator.cpp", V, "return day >= 15 && day <= 21;", "return day >= 15 && day <= 22;"),
    ("validator.cpp", V, "for (int i = 0; i < 10; i++) {", "for (int i = 0; i < 1; i++) {"),
    ("validator.cpp", V, "return prevTradingDay(*thirdFri, settings) == dateIso;", "return *thirdFri == dateIso;"),
    ("validator.cpp", V, "if (expected.isEmpty()) return {true, {}};", "if (expected.isEmpty()) return {false, expected};"),
    ("validator.cpp", V, "if (given.isEmpty()) return {false, expected};", "if (given.isEmpty()) return {true, {}};"),
    ("validator.cpp", V, "if (!daily.isEmpty() && given == daily.toUpper()) return {false, daily};", "if (false) return {false, daily};"),
    ("validator.cpp", V, "if (!c.isEmpty() && !classes.contains(c)) classes << c;", "if (!classes.contains(c)) classes << c;"),
    ("validator.cpp", V, "if (classes.size() <= 1) return {};", "if (classes.size() <= 2) return {};"),
    ("validator.cpp", V, "std::fabs(a->n - b->n) >= 0.005;", "std::fabs(a->n - b->n) > 0.005;"),
    ("validator.cpp", V, "return js::isNum(a) && js::isNum(b) && std::isfinite", "return std::isfinite"),
    ("validator.cpp", V, "if (!js::nullish(own)) return js::str(own).left(8);", "if (!js::nullish(own)) return js::str(own);"),
    ("validator.cpp", V, "if (js::isNum(b) && a == b->n) return true;", "if (a == js::num(b)) return true;"),
    ("validator.cpp", V, "if (base == 0 || std::isnan(base)) base = 1.0;", "if (std::isnan(base)) base = 1.0;"),
    ("validator.cpp", V, "return std::fabs(a - bn) / base <= tolerance;", "return std::fabs(a - bn) / base < tolerance;"),
    ("validator.cpp", V, "if (!seen.contains(issue.message)) seen << issue.message;", "seen << issue.message;"),
    # ---- 构造与时段
    ("validator.cpp", V, "for (const auto& [k, v] : snapshot->fields) snapshot_.insert(k.toUpper(), js::num(&v));", "for (const auto& [k, v] : snapshot->fields) snapshot_.insert(k, js::num(&v));"),
    ("validator.cpp", V, "if (got && !got->isEmpty()) return *got;", "if (got) return *got;"),
    ("validator.cpp", V, "if (double(index) >= lim) {", "if (double(index) > lim) {"),
    ("validator.cpp", V, "+ n2s(double(index) + 1) +", "+ n2s(double(index)) +"),
    ("validator.cpp", V, "seenInBatch.insert(approved->signature, js::num(js::path(&order, {u\"order\"_s, u\"totalQuantity\"_s})));", "(void)0;"),
    # ---- validateOne
    ("validator.cpp", V, "if (confidence < minConf) {", "if (confidence <= minConf) {"),
    ("validator.cpp", V, "if (aliases.isEmpty()) aliases = u\"(未配置)\"_s;", "if (false) aliases = u\"(未配置)\"_s;"),
    ("validator.cpp", V, "} else if (!account->is_paper && !settings_.policies.allow_live_trading) {", "} else if (!account->is_paper) {"),
    ("validator.cpp", V, "const QString unflagged = settings_.paper_flag_missing.contains(account->alias)", "const QString unflagged = !settings_.paper_flag_missing.contains(account->alias)"),
    ("validator.cpp", V, "if (isStrEq(P(contract, u\"secType\"), u\"BAG\")) issues.append(checkSpread(contract, spec));", "if (false) issues.append(checkSpread(contract, spec));"),
    ("validator.cpp", V, "if (notNull(P(order, u\"trigger\"))) issues.append(checkTrigger(order, warnings));", "if (false) issues.append(checkTrigger(order, warnings));"),
    ("validator.cpp", V, "const contract::Limits limits = account == nullptr ? settings_.limits : settings_.limitsFor(account->alias);", "const contract::Limits limits = settings_.limits;"),
    ("validator.cpp", V, "if (account != nullptr && limitIssues.isEmpty()) issues.append(", "if (account != nullptr) issues.append("),
    ("validator.cpp", V, "issues.append(checkDuplicate(order, signature, seenInBatch ? *seenInBatch : QHash<QString, double>{}));", "issues.append(checkDuplicate(order, signature, QHash<QString, double>{}));"),
    ("validator.cpp", V, "if (util::jsTrim(Sx(order, u\"reason\")).isEmpty()) warnings", "if (Sx(order, u\"reason\").isEmpty()) warnings"),
    ("validator.cpp", V, "if (!issues.isEmpty() || account == nullptr) return {issues, std::nullopt};", "if (!issues.isEmpty()) return {issues, std::nullopt};"),
    ("validator.cpp", V, "countInBatch(order, account->alias, notional);", "(void)notional;"),
    ("validator.cpp", V, "merged << warnings;", "merged = warnings;"),
    # ---- checkContract
    ("validator.cpp", V, "if (js::truthy(P(contract, u\"lastTradeDateOrContractMonth\"))) expirySlots", "if (false) expirySlots"),
    ("validator.cpp", V, "if (expiry < today) {", "if (expiry <= today) {"),
    ("validator.cpp", V, "} else if (!settings_.isTradingDay(expiry)) {", "} else if (false) {"),
    ("validator.cpp", V, "if (indexCfg && !expirySlots.empty()) {", "if (indexCfg) {"),
    ("validator.cpp", V, "if (reviewed.keep || (js::isStr(current) && current->s == reviewed.value)) continue;", "if (reviewed.keep) continue;"),
    ("validator.cpp", V, "const QString shown = current && current->type == OJson::Null ? u\"None\"_s", "const QString shown = !current ? u\"None\"_s"),
    ("validator.cpp", V, "slot->set(u\"tradingClass\"_s, OJson::string(reviewed.value));", "(void)slot;"),
    # ---- 价差
    ("validator.cpp", V, "if (isStrEq(strategy, u\"BUTTERFLY\")) return checkButterfly(contract, order);", "if (false) return checkButterfly(contract, order);"),
    ("validator.cpp", V, "if (legs.size() != 2) return {bad(", "if (legs.size() < 2) return {bad("),
    ("validator.cpp", V, "if (buys.size() != 1 || sells.size() != 1) return", "if (buys.size() != 1) return"),
    ("validator.cpp", V, "if (!js::strictEqual(P(buy, u\"right\"), P(sell, u\"right\"))) issues", "if (false) issues"),
    ("validator.cpp", V, "if (!js::strictEqual(P(buy, u\"lastTradeDateOrContractMonth\"), P(sell, u\"lastTradeDateOrContractMonth\"))) issues", "if (false) issues"),
    ("validator.cpp", V, "if (js::strictEqual(P(buy, u\"strike\"), P(sell, u\"strike\"))) issues", "if (false) issues"),
    ("validator.cpp", V, "if (!isNumEq(P(buy, u\"ratio\"), 1) || !isNumEq(P(sell, u\"ratio\"), 1)) issues", "if (!isNumEq(P(buy, u\"ratio\"), 1)) issues"),
    ("validator.cpp", V, "const bool ok = call ? (debit ? buyK < sellK : buyK > sellK) : (debit ? buyK > sellK : buyK < sellK);",
     "const bool ok = call ? (debit ? buyK < sellK : buyK > sellK) : (debit ? buyK < sellK : buyK > sellK);"),
    ("validator.cpp", V, "if (isStrEq(P(order, u\"price_mode\"), u\"AUTO_MID\") && notNull(lmt)) issues", "if (false) issues"),
    ("validator.cpp", V, "if (isStrEq(P(order, u\"price_mode\"), u\"EXPLICIT\") && notNull(lmt) && debit) {", "if (isStrEq(P(order, u\"price_mode\"), u\"EXPLICIT\") && notNull(lmt)) {"),
    ("validator.cpp", V, "        if (js::num(lmt) > width) {", "        if (js::num(lmt) >= width) {"),
    ("validator.cpp", V, "if (legs.size() != 3) return {bad(", "if (legs.size() < 3) return {bad("),
    ("validator.cpp", V, "if (!isStrEq(P(order, u\"action\"), u\"BUY\")) issues.append(bad(u\"仅支持买入", "if (false) issues.append(bad(u\"仅支持买入"),
    ("validator.cpp", V, "if (distinctCount(field(u\"right\")) != 1) issues", "if (false) issues"),
    ("validator.cpp", V, "if (distinctCount(field(u\"lastTradeDateOrContractMonth\")) != 1) issues", "if (false) issues"),
    ("validator.cpp", V, "if (distinctCount(field(u\"strike\")) != 3) issues", "if (false) issues"),
    ("validator.cpp", V, "|| !isStrEq(P(hi, u\"action\"), u\"BUY\") ||", "||"),
    ("validator.cpp", V, "|| !isNumEq(P(mid, u\"ratio\"), 2))", "|| !isNumEq(P(mid, u\"ratio\"), 1))"),
    ("validator.cpp", V, "if (std::fabs(wingLo - wingHi) > 0.01) {", "if (std::fabs(wingLo - wingHi) >= 0.01) {"),
    ("validator.cpp", V, "        if (js::num(lmt) > wingLo) {", "        if (js::num(lmt) >= wingLo) {"),
    ("validator.cpp", V, "if (legs.size() != 4) return {bad(", "if (legs.size() < 4) return {bad("),
    ("validator.cpp", V, "if (!isStrEq(P(order, u\"action\"), u\"SELL\")) issues.append(bad(u\"仅支持卖出", "if (false) issues.append(bad(u\"仅支持卖出"),
    ("validator.cpp", V, "if (distinctCount(expiries) != 1) issues", "if (false) issues"),
    ("validator.cpp", V, "{ return !isNumEq(P(*l, u\"ratio\"), 1); })) issues", "{ return !isNumEq(P(*l, u\"ratio\"), 1) && false; })) issues"),
    ("validator.cpp", V, "if (distinctCount(strikes) != 4) issues", "if (distinctCount(strikes) < 3) issues"),
    ("validator.cpp", V, "if (puts.size() != 2 || calls.size() != 2) issues", "if (puts.size() != 2) issues"),
    ("validator.cpp", V, "if (Nx(*puts.back(), u\"strike\") >= Nx(*calls.front(), u\"strike\")) issues", "if (Nx(*puts.back(), u\"strike\") > Nx(*calls.front(), u\"strike\")) issues"),
    ("validator.cpp", V, "if (!isStrEq(P(*puts[0], u\"action\"), u\"BUY\") || !isStrEq(P(*puts[1], u\"action\"), u\"SELL\"))", "if (!isStrEq(P(*puts[0], u\"action\"), u\"BUY\"))"),
    ("validator.cpp", V, "if (!isStrEq(P(*calls[0], u\"action\"), u\"SELL\") || !isStrEq(P(*calls[1], u\"action\"), u\"BUY\"))", "if (!isStrEq(P(*calls[1], u\"action\"), u\"BUY\"))"),
    # ---- 触发
    ("validator.cpp", V, "if (settings_.policies.require_trigger_price_verification) {", "if (true) {"),
    ("validator.cpp", V, "const bool priceTruthy = price != 0 && !std::isnan(price);", "const bool priceTruthy = price != 0;"),
    ("validator.cpp", V, "if (gapBps < settings_.policies.trigger_min_gap_bps) {", "if (gapBps <= settings_.policies.trigger_min_gap_bps) {"),
    ("validator.cpp", V, "const QString expected = price < value ? u\">=\"_s : u\"<=\"_s;", "const QString expected = price <= value ? u\">=\"_s : u\"<=\"_s;"),
    # ---- 预算与批内累计
    ("validator.cpp", V, "if (!extras_.equity) return cfg;", "if (true) return cfg;"),
    ("validator.cpp", V, "if (v > 0) merged.insert(alias, v);", "merged.insert(alias, v);"),
    ("validator.cpp", V, "if (extras_.isReduction && extras_.isReduction(order, alias)) {\n        if (extras_.consumeReduction)", "if (false) {\n        if (extras_.consumeReduction)"),
    ("validator.cpp", V, "if (extras_.consumeReduction) extras_.consumeReduction(order, alias);", "(void)0;"),
    ("validator.cpp", V, "batchRisk_.insert(alias, batchRisk_.value(alias, 0) + notional);", "(void)0;"),
    ("validator.cpp", V, "batchContracts_.insert(key, batchContracts_.value(key, 0) + Nx(*P(order, u\"order\"), u\"totalQuantity\"));", "(void)key;"),
    # ---- 在手上限
    ("validator.cpp", V, "if (!(limits.max_open_risk_usd > 0) && !(limits.max_underlying_contracts > 0)) return {};", "if (!(limits.max_open_risk_usd > 0)) return {};"),
    ("validator.cpp", V, "if (!extras_.capNote.isEmpty()) warnings << extras_.capNote;", "(void)0;"),
    ("validator.cpp", V, "if (!extras_.exposure || (extras_.isReduction && extras_.isReduction(order, alias))) return {};", "if (!extras_.exposure) return {};"),
    ("validator.cpp", V, "if (limits.max_open_risk_usd > 0 && !util::market::onObjectPrototype(alias)) {", "if (limits.max_open_risk_usd > 0) {"),
    ("validator.cpp", V, "+ batchRisk_.value(alias, 0);", ";"),
    ("validator.cpp", V, "if (held + notional > limits.max_open_risk_usd) {", "if (held + notional >= limits.max_open_risk_usd) {"),
    ("validator.cpp", V, "+ batchContracts_.value(key, 0);", ";"),
    ("validator.cpp", V, "if (held + qty > limits.max_underlying_contracts) {", "if (held + qty >= limits.max_underlying_contracts) {"),
    # ---- 限额
    ("validator.cpp", V, "notional = qty * domain::models::multiplierValue(contract) * js::num(lmt);", "notional = qty * js::num(lmt);"),
    ("validator.cpp", V, "jsmath::max(width - js::num(lmt), 0.0);", "(width - js::num(lmt));"),
    ("validator.cpp", V, "notional = qty * domain::models::multiplierValue(contract) * width;", "notional = qty * 100 * width + 0.01;"),
    ("validator.cpp", V, "if (!isStrEq(P(contract, u\"right\"), u\"P\")) {", "if (isStrEq(P(contract, u\"right\"), u\"C\")) {"),
    ("validator.cpp", V, "if (!js::truthy(strike) || js::num(strike) <= 0) {", "if (js::num(strike) < 0) {"),
    ("validator.cpp", V, "notional = qty * domain::models::multiplierValue(contract) * js::num(strike);", "notional = qty * 100 * js::num(strike) + 1;"),
    ("validator.cpp", V, "if (qty > limits.max_mkt_shares) {", "if (qty >= limits.max_mkt_shares) {"),
    ("validator.cpp", V, "return {0.0, {{u\"EXCEEDS_LIMIT\"_s, orderType == u\"MKT\"", "return {0.0, {{u\"EXCEEDS_LIMIT\"_s, orderType != u\"TRAIL\""),
    ("validator.cpp", V, "notional = qty * *ref;", "notional = *ref;"),
    ("validator.cpp", V, "if (notional > limits.max_order_notional) {", "if (notional >= limits.max_order_notional) {"),
    ("validator.cpp", V, "&& Nx(spec, u\"totalQuantity\") > limits.max_option_contracts) {", "&& Nx(spec, u\"totalQuantity\") >= limits.max_option_contracts) {"),
    ("validator.cpp", V, "if ((isStrEq(secType, u\"OPT\") || isStrEq(secType, u\"BAG\")) && Nx", "if ((isStrEq(secType, u\"OPT\")) && Nx"),
    # ---- 时段
    ("validator.cpp", V, "if (isStrEq(P(order, u\"execution_type\"), u\"CONDITIONAL\")) {", "if (false) {"),
    ("validator.cpp", V, "if (policy == u\"reject_all\") return", "if (false) return"),
    ("validator.cpp", V, "if (policy == u\"reject_market_orders\" && mkt) {", "if (mkt) {"),
    ("validator.cpp", V, "if (extended && !outsideRth) {", "if (!outsideRth) {"),
    ("validator.cpp", V, "if (extended && outsideRth && mkt) {", "if (outsideRth && mkt) {"),
    # ---- 重复
    ("validator.cpp", V, "if (qtyClose(qty, &prev, limits.duplicate_qty_tolerance)) {", "if (true) {"),
    ("validator.cpp", V, "if (!(js::isStr(sig) && sig->s == signature)) continue;", "if (!js::isStr(sig)) continue;"),
    ("validator.cpp", V, "if (nowEt_.epochMs - Nx(recent, u\"createdAtMs\") > windowMs) continue;", "if (nowEt_.epochMs - Nx(recent, u\"createdAtMs\") >= windowMs) continue;"),
    ("validator.cpp", V, "if (!qtyClose(qty, quantity, limits.duplicate_qty_tolerance)) continue;", "(void)0;"),
    ("validator.cpp", V, "if (isStrEq(finalStatus, u\"cancelled\") && differentPrice(", "if (differentPrice("),
    ("validator.cpp", V, "if (finalStatus && finalStatus->type == OJson::Null) {", "if (!finalStatus || finalStatus->type == OJson::Null) {"),
    # ---- 指纹与宽度
    ("validator.cpp", V, "parts << js::strOr(P(contract, u\"lastTradeDateOrContractMonth\"), QString()) << (js::nullish(strike) ? util::pyG(0) : js::pyG(strike))",
     "parts << js::strOr(P(contract, u\"lastTradeDateOrContractMonth\"), QString()) << js::pyG(strike)"),
    ("validator.cpp", V, "for (const OJson* leg : sortedByStrike(legsOf(contract)))", "for (const OJson* leg : legsOf(contract))"),
    ("validator.cpp", V, "if (isStrEq(strategy, u\"VERTICAL\") && legs.size() == 2) return std::fabs(", "if (isStrEq(strategy, u\"VERTICAL\") && legs.size() == 2) return ("),
    ("validator.cpp", V, "if (isStrEq(strategy, u\"BUTTERFLY\") && legs.size() == 3) return Nx(*legs[1], u\"strike\") - Nx(*legs[0], u\"strike\");",
     "if (isStrEq(strategy, u\"BUTTERFLY\") && legs.size() == 3) return Nx(*legs[2], u\"strike\") - Nx(*legs[0], u\"strike\");"),
    ("validator.cpp", V, "return jsmath::max(Nx(*puts[1], u\"strike\") - Nx(*puts[0], u\"strike\"), Nx(*calls[1], u\"strike\") - Nx(*calls[0], u\"strike\"));",
     "return Nx(*puts[1], u\"strike\") - Nx(*puts[0], u\"strike\");"),
    # ---- 验收补的(第二轮)
    ("validator.cpp", V, "if (!isNumEq(P(lo, u\"ratio\"), 1) || !isNumEq(P(hi, u\"ratio\"), 1) || !isNumEq(P(mid, u\"ratio\"), 2))", "if (!isNumEq(P(hi, u\"ratio\"), 1) || !isNumEq(P(mid, u\"ratio\"), 2))"),
    ("validator.cpp", V, "if (!isNumEq(P(lo, u\"ratio\"), 1) || !isNumEq(P(hi, u\"ratio\"), 1) || !isNumEq(P(mid, u\"ratio\"), 2))", "if (!isNumEq(P(lo, u\"ratio\"), 1) || !isNumEq(P(mid, u\"ratio\"), 2))"),
    ("validator.cpp", V, "if (!isNumEq(P(lo, u\"ratio\"), 1) || !isNumEq(P(hi, u\"ratio\"), 1) || !isNumEq(P(mid, u\"ratio\"), 2))", "if ((!isNumEq(P(lo, u\"ratio\"), 1) && !isNumEq(P(hi, u\"ratio\"), 1)) || !isNumEq(P(mid, u\"ratio\"), 2))"),
    ("validator.cpp", V, "if (!isNumEq(P(lo, u\"ratio\"), 1) || !isNumEq(P(hi, u\"ratio\"), 1) || !isNumEq(P(mid, u\"ratio\"), 2))", "if (!isNumEq(P(lo, u\"ratio\"), 1) || (!isNumEq(P(hi, u\"ratio\"), 1) && !isNumEq(P(mid, u\"ratio\"), 2)))"),
    ("validator.cpp", V, "if (!isNumEq(P(lo, u\"ratio\"), 1) || !isNumEq(P(hi, u\"ratio\"), 1) || !isNumEq(P(mid, u\"ratio\"), 2))", "if (!isNumEq(P(lo, u\"ratio\"), 1) && !isNumEq(P(hi, u\"ratio\"), 1) && !isNumEq(P(mid, u\"ratio\"), 2))"),
    ("validator.cpp", V, "if (isStrEq(P(spec, u\"price_mode\"), u\"EXPLICIT\") && notNull(lmt)) {", "if (isStrEq(P(spec, u\"price_mode\"), u\"EXPLICIT\") || notNull(lmt)) {"),
    ("validator.cpp", V, "for (int day = 15; day <= 21; day++) {", "for (int day = 15; day < 21; day++) {"),
    ("validator.cpp", V, "for (int day = 15; day <= 21; day++) {", "for (int day = 16; day <= 21; day++) {"),
    ("validator.cpp", V, "return day >= 15 && day <= 21;", "return day >= 16 && day <= 21;"),
    ("validator.cpp", V, "return day >= 15 && day <= 21;", "return day >= 15 && day <= 20;"),
    ("validator.cpp", V, "if (limits.max_open_risk_usd > 0 && !util::market::onObjectPrototype(alias)) {", "if (limits.max_open_risk_usd > 0 && !util::market::onObjectPrototype(alias.toLower())) {"),
]

# ---- performance.cpp(analysis/performance)
MP = [(("performance.cpp", PF) + m) for m in [
    # ---- 小工具
    ("if (js::nullish(v) || (v->type == OJson::String && v->s.isEmpty())) return std::nullopt;", "if (js::nullish(v)) return std::nullopt;"),
    ("return std::isfinite(out) ? std::optional<double>(out) : std::nullopt;", "return std::optional<double>(out);"),
    ("if (std::isnan(a) || std::isnan(b) || b < a) return std::nullopt;", "if (std::isnan(a) || std::isnan(b)) return std::nullopt;"),
    ("return util::pyRound((b - a) / 60'000, 1);", "return util::pyRound((b - a) / 60'000, 0);"),
    ("    if (risk && *risk > 0) {", "    if (risk && *risk >= 0) {"),
    ("t.r_missing = risk ? u\"no_cost\"_s : why;", "t.r_missing = why;"),
    ("return {tr::onObjectPrototype(id), nullptr, nullptr};", "return {false, nullptr, nullptr};"),
    ("QString outcome(const LedgerTrade& t) { return std::fabs(t.pnl) < kFlatUsd ?", "QString outcome(const LedgerTrade& t) { return std::fabs(t.pnl) <= kFlatUsd ?"),
    ("std::optional<double> ratio(double a, double b) { return b > 0 ?", "std::optional<double> ratio(double a, double b) { return b >= 0 ?"),
    ("return s.size() % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;", "return s[mid];"),
    ("if (decided < kMinGroup || !winRate || !payoff || *payoff <= 0) return std::nullopt;", "if (decided <= kMinGroup || !winRate || !payoff || *payoff <= 0) return std::nullopt;"),
    ("return util::pyRound(*winRate - (1 - *winRate) / *payoff, 3);", "return util::pyRound(*winRate - (1 - *winRate) / *payoff, 2);"),
    ("if (label == u\"尾盘一小时\") return u\"close60\"_s;", "if (label == u\"尾盘一小时\") return u\"close\"_s;"),
    ("    if (wd < 0) wd += 7;", "    (void)0;"),
    ("const double days = std::floor(ms / 86'400'000);", "const double days = std::floor(ms / 86'400'000) + 1;"),
    ("return v < 0 ? u\"-$\"_s + s : u\"$\"_s + s;", "return v <= 0 ? u\"-$\"_s + s : u\"$\"_s + s;"),
    ("    return ci && ci->hi < 0;", "    return ci && ci->hi <= 0;"),
    ("if (split.quick.size() < 5 || split.rest.size() < 5) return std::nullopt;", "if (split.quick.size() < 5) return std::nullopt;"),
    ("if (q && r && *q < 0 && clearlyWorse(split.quick, split.rest)) return Verdict{*q, *r};", "if (q && r && clearlyWorse(split.quick, split.rest)) return Verdict{*q, *r};"),
    # ---- 结论
    ("if (!s.expectancy || s.wins + s.losses < 5) return std::nullopt;", "if (!s.expectancy || s.wins + s.losses < 4) return std::nullopt;"),
    ("(kinds.size() > 1 ? u\"这是按美元算的", "(kinds.size() > 0 ? u\"这是按美元算的"),
    ("    if (ci && ci->lo > 0) {\n        return Finding{u\"expectancy\"", "    if (ci && ci->lo >= 0) {\n        return Finding{u\"expectancy\""),
    ("    if (ci && ci->hi < 0) {\n        return Finding{u\"expectancy\"", "    if (ci && ci->hi <= 0) {\n        return Finding{u\"expectancy\""),
    ("const std::optional<double> kelly = report.r_stats.kelly ? report.r_stats.kelly : report.kelly;", "const std::optional<double> kelly = report.kelly;"),
    ("const std::optional<Interval> ci = byR ? report.r_stats.expectancy_ci : report.stats.expectancy_ci;", "const std::optional<Interval> ci = report.stats.expectancy_ci;"),
    ("(report.kind.size() > 1 ? u\"(品种混着时", "(report.kind.size() > 2 ? u\"(品种混着时"),
    ("    if (ci && ci->hi < 0) {\n        return Finding{u\"kelly\"", "    if (ci && ci->hi < -1) {\n        return Finding{u\"kelly\""),
    ("    if (!ci || ci->lo <= 0) {", "    if (!ci || ci->lo < 0) {"),
    ("(*kelly > 0 ? u\"这点样本撑不起它给的这个数。\"_s", "(*kelly >= 0 ? u\"这点样本撑不起它给的这个数。\"_s"),
    ("n2s(util::pyRound(*kelly * 25, 1))", "n2s(util::pyRound(*kelly * 20, 1))"),
    ("if (s.payoff_ratio && *s.payoff_ratio < 1 && s.win_rate && s.breakeven_win_rate && *s.win_rate < *s.breakeven_win_rate + 5) {",
     "if (s.payoff_ratio && *s.payoff_ratio < 1 && s.win_rate && s.breakeven_win_rate && *s.win_rate < *s.breakeven_win_rate + 4) {"),
    ("(gap >= 0 ? u\"胜率只比保本线高 \"_s", "(gap > 0 ? u\"胜率只比保本线高 \"_s"),
    ("(cov.with_r < cov.trades ? u\"有 R 的只是 \"_s", "(cov.with_r <= cov.trades ? u\"有 R 的只是 \"_s"),
    ("(cov.flats != 0 ? u\"其中 \"_s", "(false ? u\"其中 \"_s"),
    ("const QString mixed = cov.max_loss != 0 && cov.stop != 0", "const QString mixed = cov.max_loss != 0 || cov.stop != 0"),
    ("*r.sqn >= 2.5 ? u\"good\"_s : *r.sqn >= 1.6 ? u\"info\"_s : u\"warn\"_s", "*r.sqn >= 2.5 ? u\"good\"_s : *r.sqn >= 1.7 ? u\"info\"_s : u\"warn\"_s"),
    ("const Trades latest = sliceTrades(trades, -kRecentWindow, n);", "const Trades latest = sliceTrades(trades, -kRecentWindow + 1, n);"),
    ("const Trades earlier = sliceTrades(trades, 0, -kRecentWindow);", "const Trades earlier = sliceTrades(trades, 0, n);"),
    ("if (rec < 0 && all > 0 && clearlyWorse(latest, earlier)) {", "if (rec < 0 && clearlyWorse(latest, earlier)) {"),
    ("} else if (rec > all && rec > 0 && clearlyWorse(earlier, latest)) {", "} else if (rec > 0 && clearlyWorse(earlier, latest)) {"),
    ("if (losses.size() >= 5 && s.gross_loss > 0 && s.avg_loss) {", "if (losses.size() >= 6 && s.gross_loss > 0 && s.avg_loss) {"),
    ("for (size_t i = 0; i < std::min<size_t>(3, losses.size()); ++i) sum3 = sum3 + losses[i];", "for (size_t i = 0; i < std::min<size_t>(2, losses.size()); ++i) sum3 = sum3 + losses[i];"),
    ("const bool concentrated = losses.size() >= 10 && share >= 0.5;", "const bool concentrated = losses.size() >= 10 && share > 0.5;"),
    ("if (concentrated || worst <= *s.avg_loss * 3) {", "if (concentrated || worst < *s.avg_loss * 3) {"),
    ("if (dd.max > 0 && trades.size() >= 10) {", "if (dd.max > 0 && trades.size() >= 11) {"),
    ("if (dd.recovery_factor && *dd.recovery_factor >= 2) {", "if (dd.recovery_factor && *dd.recovery_factor > 2) {"),
    ("if (worstDay && avgLosingDay && report.per_day.days >= 5 && worstDay->pnl < 0 && worstDay->pnl <= *avgLosingDay * 3) {",
     "if (worstDay && avgLosingDay && report.per_day.days >= 5 && worstDay->pnl < 0 && worstDay->pnl < *avgLosingDay * 3) {"),
    ("const double busyCut = jsmath::max(4, med * 2);", "const double busyCut = jsmath::max(3, med * 2);"),
    ("if (c >= busyCut && !busyDays.contains(d)) busyDays << d;", "if (c > busyCut && !busyDays.contains(d)) busyDays << d;"),
    ("    if (busyDays.size() >= 3) {", "    if (busyDays.size() >= 4) {"),
    ("if (perBusy && perOther && *perBusy < 0 && clearlyWorse(busy, other)) {", "if (perBusy && perOther && clearlyWorse(busy, other)) {"),
    ("if (g.trades >= kMinGroup && g.expectancy && g.key != u\"off\") sessions", "if (g.trades >= kMinGroup && g.expectancy) sessions"),
    ("for (const Row& b : sessions) best = b.e > best.e ? b : best;", "for (const Row& b : sessions) best = b.e >= best.e ? b : best;"),
    ("1 - (1 - inf::kConfidence) / pairs)) return std::nullopt;", "inf::kConfidence)) return std::nullopt;"),
    ("if (!(worst.e < 0 && best.e > 0) ||", "if (!(worst.e < 0) ||"),
    ("if (outcome(*t) == o && t->hold_minutes) rows.push_back({dayOf(*t), *t->hold_minutes});", "if (outcome(*t) == o && t->hold_minutes) rows.push_back({t->id, *t->hold_minutes});"),
    ("if (holdWin && holdLoss && winHolds.size() >= 5 && lossHolds.size() >= 5) {", "if (holdWin && holdLoss && winHolds.size() >= 5 && lossHolds.size() >= 6) {"),
    ("if (*holdLoss > *holdWin * 1.5 && z >= inf::kZ95) {", "if (*holdLoss > *holdWin * 1.5) {"),
    ("} else if (*holdWin >= *holdLoss * 1.5 && z <= -inf::kZ95) {", "} else if (*holdWin >= *holdLoss * 1.5) {"),
    ("const double lossRate = size.afterLoss != 0 ? size.upAfterLoss / size.afterLoss : 0;", "const double lossRate = size.afterLoss != 0 ? size.upAfterLoss / size.afterLoss : 1;"),
    ("if (size.afterLoss >= 5 && size.afterWin >= 5 && lossRate >= 0.3 && lossRate - winRate >= 0.1 && gap && gap->lo > 0) {",
     "if (size.afterLoss >= 5 && lossRate >= 0.3 && lossRate - winRate >= 0.1 && gap && gap->lo > 0) {"),
    ("    if (s.trades == 0) return out;\n    if (s.trades < kMinSample) {", "    if (s.trades == 0) return out;\n    if (s.trades <= kMinSample) {"),
    # ---- 保护规则建议
    ("double ceil10(double v) { return std::ceil(v / 10) * 10; }", "double ceil10(double v) { return std::round(v / 10) * 10; }"),
    ("(replay.skipped_pnl < 0   ? u\"拦下它们少亏 \"_s", "(replay.skipped_pnl <= 0   ? u\"拦下它们少亏 \"_s"),
    ("(replay.unknown_open != 0 ? u\";另有 \"_s", "(false ? u\";另有 \"_s"),
    ("    if (avgLosingDay && worstDay && losingDays.size() >= 5) {", "    if (avgLosingDay && worstDay && losingDays.size() >= 4) {"),
    ("const double line = ceil10(std::fabs(*avgLosingDay) * 2);", "const double line = ceil10(std::fabs(*avgLosingDay) * 3);"),
    ("[&](double v) { return v <= -line; });", "[&](double v) { return v < -line; });"),
    ("const bool looser = !cur || !cur->enabled || cur->max_loss_usd > line;", "const bool looser = !cur || !cur->enabled;"),
    ("if ((streak >= 4 || revenge) && !(current && current->stoploss_guard.enabled)) {", "if ((streak >= 4 || revenge)) {"),
    ("if (streak >= 4) why << u\"最长连亏 \"_s", "if (streak >= 5) why << u\"最长连亏 \"_s"),
    ("(bursts != 0 ? QString() : u\":按亏损了结来数", "(true ? QString() : u\":按亏损了结来数"),
    ("if (sameVerdict && (!cool || !cool->enabled || cool->minutes < kRevengeMinutes)) {", "if (sameVerdict && (!cool || !cool->enabled)) {"),
    ("if (gross) notes << n2s(double(gross))", "if (false) notes << n2s(double(gross))"),
    # ---- 账本
    ("if (link.truthy && isStrEq(link.role, u\"exit\")) continue;", "if (isStrEq(link.role, u\"exit\")) continue;"),
    ("const double mult = num(P(profile, u\"multiplier\")).value_or(100);", "const double mult = 100;"),
    ("const double qty = num(P(profile, u\"qty\")).value_or(1);", "const double qty = 1;"),
    ("exitComm = num(js::path(peer, {u\"ibkr\"_s, u\"total_commission\"_s}));", "exitComm = 0;"),
    ("} else if (now >= tr::expiryClose(profile)) {", "} else if (now > tr::expiryClose(profile)) {"),
    ("            exitComm = 0;  // 到期结算没有平仓佣金", "            (void)0;"),
    ("if (!debit || !exitPrice || !closedAt) {", "if (!exitPrice || !closedAt) {"),
    ("const double gross = (buy ? 1 : -1) * (*exitPrice - *debit) * mult * qty;", "const double gross = (*exitPrice - *debit) * mult * qty;"),
    ("const double pnl = util::pyRound(gross - openComm.value_or(0) - exitComm.value_or(0), 2);", "const double pnl = util::pyRound(gross - openComm.value_or(0), 2);"),
    ("else if (js::truthy(P(profile, u\"symmetric\")) && width && *width > *debit) risk", "else if (width && *width > *debit) risk"),
    ("t.net_of_commission = openComm.has_value() && exitComm.has_value();", "t.net_of_commission = openComm.has_value();"),
    ("t.exposure = util::pyRound(risk ? *risk : *debit * mult * qty, 2);", "t.exposure = util::pyRound(*debit * mult * qty, 2);"),
    ("t.paper = js::truthy(js::path(&record, {u\"account\"_s, u\"is_paper\"_s}));", "t.paper = false;"),
    ("if (s.symbol != symbol || (s.sec_type && *s.sec_type != u\"STK\")) continue;", "if (s.symbol != symbol) continue;"),
    ("if (s.account && !alias.isEmpty() && *s.account != alias) continue;", "if (s.account && *s.account != alias) continue;"),
    ("if (std::isnan(at) || at < *from || at > *to) continue;", "if (std::isnan(at) || at < *from) continue;"),
    ("if (!(isShort ? s.stop > *entry : s.stop < *entry)) continue;", "if (!(isShort ? s.stop >= *entry : s.stop < *entry)) continue;"),
    ("if (!first || at < first->first) first = {at, s.stop};", "if (!first || at <= first->first) first = {at, s.stop};"),
    ("if (first->first - *from <= kInitialStopMinutes * 60'000) return {first->second, false};", "if (first->first - *from < kInitialStopMinutes * 60'000) return {first->second, false};"),
    ("if (js::truthy(P(trip, u\"carried\")) || !realized) {", "if (!realized) {"),
    ("const bool sized = entry && qty && *qty > 0;", "const bool sized = entry && qty;"),
    ("std::optional<double>(std::fabs(*entry - *planned.stop) * *qty)", "std::optional<double>((*entry - *planned.stop) * *qty)"),
    ("riskFields(t, pnl, risk, u\"stop\"_s, !sized ? u\"no_cost\"_s : planned.late ? u\"late_stop\"_s : u\"no_stop\"_s);", "riskFields(t, pnl, risk, u\"stop\"_s, !sized ? u\"no_cost\"_s : u\"no_stop\"_s);"),
    ("t.label = Sx(trip, u\"symbol\") + u' ' + (isStrEq(P(trip, u\"side\"), u\"SHORT\") ? u\"做空\"_s : u\"做多\"_s);", "t.label = Sx(trip, u\"symbol\") + u\" 做多\"_s;"),
    ("|| isStrEq(P(p, u\"exit\"), u\"持仓中\") || !js::truthy(P(p, u\"closed_et\"))) {", "|| !js::truthy(P(p, u\"closed_et\"))) {"),
    ("&& js::num(qtyP) > 0 ? std::optional<double>(js::num(qtyP)) : std::nullopt;", "? std::optional<double>(js::num(qtyP)) : std::nullopt;"),
    ("&& js::num(np) > 0 ? std::optional<double>(js::num(np) * 100 * *qty) : std::nullopt;", "&& js::num(np) >= 0 ? std::optional<double>(js::num(np) * 100 * *qty) : std::nullopt;"),
    ("&& !Sx(p, u\"direction\").contains(u\"贷方\"_s) ? debit : std::nullopt;", "? debit : std::nullopt;"),
    ("t.hold_minutes = js::nullish(holdMin) ? minutesBetween(openedAt, closedAt) : std::optional<double>(js::num(holdMin));", "t.hold_minutes = minutesBetween(openedAt, closedAt);"),
    ("if (isStrEq(js::propStrict(&r, u\"action\"_s), u\"开仓\")) continue;", "if (false) continue;"),
    ("(js::truthy(P(r, u\"direction\")) ? u'(' + Sx(r, u\"direction\") + u')' : QString())", "(u'(' + Sx(r, u\"direction\") + u')')"),
    ("return a.closed_at < b.closed_at ? -1 : a.closed_at > b.closed_at ? 1 : a.id < b.id ? -1 : 1;", "return a.closed_at < b.closed_at ? -1 : a.closed_at > b.closed_at ? 1 : 0;"),
    # ---- 统计
    ("grossLoss += -t->pnl;", "grossLoss += t->pnl;"),
    ("            runL = 0;\n            largestWin", "            (void)0;\n            largestWin"),
    ("largestWin = largestWin ? jsmath::max(*largestWin, t->pnl) : t->pnl;", "largestWin = t->pnl;"),
    ("largestLoss = largestLoss ? jsmath::min(*largestLoss, t->pnl) : t->pnl;", "largestLoss = t->pnl;"),
    ("maxL = jsmath::max(maxL, runL);", "maxL = runL;"),
    ("if (o != u\"flat\") hits.push_back({o == u\"win\", dayOf(*t)});", "hits.push_back({o == u\"win\", dayOf(*t)});"),
    ("const std::optional<double> payoff = avgWin && avgLoss && *avgLoss < 0 ? std::optional<double>(*avgWin / -*avgLoss) : std::nullopt;",
     "const std::optional<double> payoff = avgWin && avgLoss ? std::optional<double>(*avgWin / -*avgLoss) : std::nullopt;"),
    ("if (decided != 0) s.win_rate = util::pyRound((wins / decided) * 100, 1);", "if (decided != 0) s.win_rate = util::pyRound((wins / s.trades) * 100, 1);"),
    ("s.win_rate_ci = roundedOpt(inf::clusteredWilsonInterval(hits), 1, 100);", "s.win_rate_ci = roundedOpt(inf::clusteredWilsonInterval(hits), 2, 100);"),
    ("if (decided != 0) s.expectancy = util::pyRound((grossProfit - grossLoss) / decided, 2);", "if (decided != 0) s.expectancy = util::pyRound((grossProfit - grossLoss) / s.trades, 2);"),
    ("if (payoff) s.breakeven_win_rate = util::pyRound(100 / (1 + *payoff), 1);", "if (payoff) s.breakeven_win_rate = util::pyRound(100 / *payoff, 1);"),
    ("    if (*sqn < 1.6) return u\"差\"_s;", "    if (*sqn <= 1.6) return u\"差\"_s;"),
    ("    if (*sqn < 5.1) return u\"优秀\"_s;", "    if (*sqn < 5.0) return u\"优秀\"_s;"),
    ("if (t->r && outcome(*t) != u\"flat\") rows.push_back", "if (t->r) rows.push_back"),
    ("for (const double r : rs) acc = acc + jsmath::pow(r - m, 2);", "for (const double r : rs) acc = acc + std::fabs(r - m);"),
    ("sd = std::sqrt(acc / double(rs.size() - 1));", "sd = std::sqrt(acc / double(rs.size()));"),
    ("if (rs.size() >= 10 && sd && *sd > 0) sqn", "if (rs.size() >= 9 && sd && *sd > 0) sqn"),
    ("std::sqrt(jsmath::min(double(rs.size()), 100))", "std::sqrt(double(rs.size()))"),
    ("const std::optional<double> payoff = !wins.empty() && avgLoss && *avgLoss < 0 ? std::optional<double>(mean(wins) / -*avgLoss) : std::nullopt;",
     "const std::optional<double> payoff = avgLoss && *avgLoss < 0 && !wins.empty() ? std::optional<double>(mean(wins) / *avgLoss * -1 + 0.001) : std::nullopt;"),
    ("out.kelly = kellyFrom(double(rows.size()), winRate, payoff);", "out.kelly = kellyFrom(double(rows.size()) + 1, winRate, payoff);"),
    ("if (outcome(*t) == u\"flat\") c.flats += 1;", "(void)0;"),
    ("if (t->risk_basis == u\"stop\") c.stop += 1;", "(void)0;"),
    ("if (n != 0) c.missing.append(", "c.missing.append("),
    ("        if (equity > peak) {", "        if (equity >= peak) {"),
    ("        if (dd > maxDd) {", "        if (dd >= maxDd) {"),
    ("if (maxDd > 0) out.drawdown.recovery_factor = util::pyRound(equity / maxDd, 2);", "if (maxDd > 0) out.drawdown.recovery_factor = util::pyRound(equity / maxDd, 1);"),
    ("out.drawdown.current = util::pyRound(peak - equity, 2);", "out.drawdown.current = util::pyRound(maxDd, 2);"),
    ("if (!out.best_day || v > out.best_day->pnl) out.best_day", "if (!out.best_day || v >= out.best_day->pnl) out.best_day"),
    ("if (!out.worst_day || v < out.worst_day->pnl) out.worst_day", "if (!out.worst_day || v <= out.worst_day->pnl) out.worst_day"),
    ("        if (v < 0) losing.push_back(v);", "        if (v <= 0) losing.push_back(v);"),
    ("return p.second > 0; }));", "return p.second >= 0; }));"),
    ("std::optional<double>(opts.now - *opts.days * 86'400'000) : std::nullopt;", "std::optional<double>(opts.now - *opts.days * 86'400'000 + 1) : std::nullopt;"),
    ("if (!(opts.scope == u\"all\" || (opts.scope == u\"paper\") == t->paper)) continue;", "if (!(opts.scope == u\"all\" || (opts.scope == u\"paper\") || !t->paper)) continue;"),
    ("if (since && !(dateParse(t->closed_at) >= *since)) continue;", "if (since && !(dateParse(t->closed_at) > *since)) continue;"),
    ("if (outcome(*decided[size_t(i)]) != outcome(*last)) break;", "(void)0;"),
    ("if (outcome(*t) == o && t->hold_minutes) xs.push_back(*t->hold_minutes);", "if (t->hold_minutes) xs.push_back(*t->hold_minutes);"),
    ("if (qint64(trades.size()) >= kRecentWindow * 2) rep.recent", "if (qint64(trades.size()) > kRecentWindow * 2) rep.recent"),
    ("return double(kSessionOrder.indexOf(a.key)) - double(kSessionOrder.indexOf(b.key));", "return 0.0;"),
    ("return util::jsStringToNumber(a.key) - util::jsStringToNumber(b.key);", "return 0.0;"),
    ("return d != 0 && !std::isnan(d) ? d : double(util::localeCompare(a.key, b.key));", "return d;"),
    ("symbol = QList<PerfGroup>(v.begin(), v.begin() + std::min<qsizetype>(qsizetype(v.size()), 12));", "symbol = QList<PerfGroup>(v.begin(), v.begin() + std::min<qsizetype>(qsizetype(v.size()), 11));"),
    ("for (long long i = qint64(trades.size()) - 1, n = 0; i >= 0 && n < kMaxLedgerRows; --i, ++n)", "for (long long i = qint64(trades.size()) - 1, n = 0; i >= 0 && n < kMaxLedgerRows - 1; --i, ++n)"),
    # ---- 规则用的几样
    ("[&](const auto& c) { return c.first != t && open >= c.second && open - c.second <= kRevengeMinutes * 60'000; });",
     "[&](const auto& c) { return c.first != t && open >= c.second && open - c.second < kRevengeMinutes * 60'000; });"),
    ("            return c.first != t && open >= c.second && open - c.second <= kRevengeMinutes * 60'000;", "            return open >= c.second && open - c.second <= kRevengeMinutes * 60'000;"),
    ("util::market::jsSort(rows, [](const Row& a, const Row& b) { return a.opened - b.opened; });", "(void)0;"),
    ("medians.insert(kind, median(xs).value_or(0));", "medians.insert(kind, 0);"),
    ("            if (cat > cur.opened) break;", "            if (cat >= cur.opened) break;"),
    ("            if (ct == cur.t) continue;", "            (void)0;"),
    ("            if (!lastAt || !(cat == *lastAt)) {", "            if (!lastAt) {"),
    ("if (!lastAt || has(*lastAt)) continue;", "if (!lastAt) continue;"),
    ("const bool up = med > 0 && cur.exposure > med * 1.5;", "const bool up = med > 0 && cur.exposure >= med * 1.5;"),
    ("        if (net <= -kFlatUsd) {", "        if (net < -kFlatUsd) {"),
    ("        if (net >= kFlatUsd) {", "        if (net > 0) {"),
    ("return d != 0 && !std::isnan(d) ? d : dateParse(a.first->closed_at) - dateParse(b.first->closed_at);", "return d;"),
    ("                if (c.second > o.second) break;", "                if (c.second >= o.second) break;"),
    ("if (c.first != o.first && !isSkipped(c.first)) realized += c.first->pnl;", "if (c.first != o.first) realized += c.first->pnl;"),
    ("if (-realized >= line && !isSkipped(o.first)) skipped.push_back(o.first);", "if (-realized > line && !isSkipped(o.first)) skipped.push_back(o.first);"),
    ("if (hit && !c.first->opened_at) out.unknown_open += 1;", "if (!c.first->opened_at) out.unknown_open += 1;"),
    ("            if (-realized >= line) hit = true;", "            if (-realized > line) hit = true;"),
    ("while ((lo < at.size() ? at[lo] : now) <= now - lookbackMinutes * 60'000) lo += 1;", "while ((lo < at.size() ? at[lo] : now) < now - lookbackMinutes * 60'000) lo += 1;"),
    ("if (double(hi) - double(lo) + 1 < count) continue;", "if (double(hi) - double(lo) < count) continue;"),
    ("if (now >= pausedUntil) bursts += 1;", "if (now > pausedUntil) bursts += 1;"),
    ("pausedUntil = now + pauseMinutes * 60'000;", "pausedUntil = now;"),
    # ---- 验收补的(第二轮)
    ("if (std::isnan(a) || std::isnan(b) || b < a) return std::nullopt;", "if (std::isnan(a) || std::isnan(b) || b <= a) return std::nullopt;"),
    ("if (outcome(*t) == o && t->hold_minutes) rows.push_back({dayOf(*t), *t->hold_minutes});", "if (outcome(*t) == o && t->hold_minutes && *t->hold_minutes > 0) rows.push_back({dayOf(*t), *t->hold_minutes});"),
    ("if (outcome(*t) == o && t->hold_minutes) xs.push_back(*t->hold_minutes);", "if (outcome(*t) == o && t->hold_minutes && *t->hold_minutes > 0) xs.push_back(*t->hold_minutes);"),
    ("t.hold_minutes = js::nullish(holdMin) ? minutesBetween(openedAt, closedAt) : std::optional<double>(js::num(holdMin));", "t.hold_minutes = !js::truthy(holdMin) ? minutesBetween(openedAt, closedAt) : std::optional<double>(js::num(holdMin));"),
    ("report.per_day.days >= 5", "report.per_day.days > 5"),
    ("winHolds.size() >= 5", "winHolds.size() > 5"),
    ("*width > *debit", "*width >= *debit"),
    ("const bool up = med > 0 &&", "const bool up = med >= 0 &&"),
    ("rec < 0 && all > 0", "rec < 0 && all >= 0"),
]]

GROUP = os.environ.get("GROUP", "")
M = (MV if GROUP in ("", "validator") else []) + (MP if GROUP in ("", "performance") else [])
# RERUN=上一次的结果.json:只跑那一次没咬住的(survived / build-error)
if os.environ.get("RERUN"):
    with open(os.environ["RERUN"], encoding="utf-8") as fh:
        _left = {(r[0], r[1], r[2]) for r in json.load(fh) if r[3] != "caught"}
    M = [m for m in M if (m[0], m[2], m[3]) in _left]
ONLY = [x for x in os.environ.get("ONLY", "").split("|") if x]
if ONLY:
    M = [m for m in M if any(o in m[2] for o in ONLY)]


# ---------------------------------------------------------------------------------------------
# 幸存的变异为什么不用管:(文件, old 里含的子串, new 里含的子串, 理由)。按顺序取第一条匹配的。
# 幸存而这里没有理由的,跑完会打出 UNDOCUMENTED 并以退出码 2 结束:要么补一个能咬住它的用例,要么在这里写清楚它为什么等价 / 到不了。
# 理由写的是论证,不是"没咬住":后来的人不用重新判一遍。
WHY = [
    ("validator.cpp", "return day >= 15 && day <= 21;", "day <= 22",
     "等价:isThirdFriday 只被 thirdFridayOfMonth 调用,而它只递 15–21 号进来;22 号永远进不来(私有函数,没有别的调用方)"),
    ("validator.cpp", "if (base == 0 || std::isnan(base)) base = 1.0;", "if (std::isnan(base)) base = 1.0;",
     "等价:base == 0 只在 a、b 都是 0 时出现,而那时开头的 a === b 已经返回 true,走不到这一行"),
    ("validator.cpp", "if (!issues.isEmpty() || account == nullptr) return {issues, std::nullopt};", "if (!issues.isEmpty()) return {issues, std::nullopt};",
     "等价:account 为空时第 2 步一定写进一条 UNKNOWN_ACCOUNT,issues 不会是空的;后面那半句只是给读代码的人(与 TS 的类型收窄)看的"),
    ("validator.cpp", "if (indexCfg && !expirySlots.empty()) {", "if (indexCfg) {",
     "等价:没有任何到期日槽时里面的循环一次也不进,什么都不做"),
    ("validator.cpp", "if (buys.size() != 1 || sells.size() != 1) return", "if (buys.size() != 1) return",
     "等价:这里腿数已经是 2、action 只有 BUY / SELL 两种(schema 保证),buys == 1 ⇔ sells == 1;非 BUY / SELL 的 action 过不了 schema"),
    ("validator.cpp", "Nx(*puts.back(), u\"strike\") >= Nx(*calls.front(), u\"strike\")", "> Nx(*calls.front()",
     "等价:走到这一行的前提是四个行权价互不相同(前面的 distinctCount 已经拦掉重复),所以 Put 侧最高价与 Call 侧最低价不会相等;NaN 时两个比较都是假"),
    ("validator.cpp", "if (isStrEq(strategy, u\"VERTICAL\") && legs.size() == 2) return std::fabs(", "return (",
     "等价:legs 已按行权价升序排好,legs[1] − legs[0] 不会是负数,fabs 是空操作(NaN 时 fabs(NaN) 也还是 NaN)"),
    # ---- performance
    ("performance.cpp", "return ci && ci->hi < 0;", "ci->hi <= 0",
     "到不了:t 区间的上端点正好是 0.0,要求 平均 − t·se 精确等于 0(t 是无理数的分位数),浮点数据凑不出"),
    ("performance.cpp", "ci->lo > 0", ">= 0", "到不了:区间下端点正好是 0.0,同上(平均 − t·se 精确为 0)"),
    ("performance.cpp", "ci->hi < 0", "<= 0", "到不了:区间上端点正好是 0.0,同上"),
    ("performance.cpp", "ci->lo <= 0", "ci->lo < 0", "到不了:区间下端点正好是 0.0,同上"),
    ("performance.cpp", "} else if (rec > all && rec > 0 && clearlyWorse(earlier, latest)) {", "} else if (rec > 0 && clearlyWorse(earlier, latest)) {",
     "等价:clearlyWorse(earlier, latest) 成立要求 earlier 的每笔均值明显低于 latest 的,而全部样本的均值 all 是这两段的加权平均,必然 < latest 的均值 rec;所以 rec > all 已被它蕴含"),
    ("performance.cpp", "size.upAfterLoss / size.afterLoss : 0;", "size.afterLoss : 1;",
     "等价:lossRate 只在 size.afterLoss >= 5 之后才被读(&& 短路),afterLoss == 0 的那个分支值不会被用到"),
    ("performance.cpp", "if (link.truthy && isStrEq(link.role, u\"exit\")) continue;", "if (isStrEq(link.role, u\"exit\")) continue;",
     "等价:link.truthy 为假时 role 是空指针,isStrEq(空) 本来就是假"),
    ("performance.cpp", "avgWin && avgLoss && *avgLoss < 0 ?", "avgWin && avgLoss ?",
     "等价:avgLoss = −grossLoss / losses,而每笔亏损的 pnl ≤ −1(FLAT_USD),grossLoss > 0,avgLoss 恒为负"),
    ("performance.cpp", "return d != 0 && !std::isnan(d) ? d : dateParse(a.first->closed_at)", "return d;",
     "等价:同一开仓时刻的几笔,「到线之前的了结」里只有开平同刻的那几笔会互相计入(c.at > o.at 就 break),它们的了结时刻也相同,稳定排序下次序不变;了结更晚的那几笔从不进别人的已实现盈亏,它们排前排后都不改变别人是否被拦"),
]


def why(f, old, new):
    for wf, wo, wn, reason in WHY:
        if wf == f and wo in old and wn in new:
            return reason
    return None


def build(test):
    for _ in range(4):
        b = subprocess.run(["cmake", "--build", B, "--target", test, "-j4"], capture_output=True, text=True)
        if b.returncode == 0:
            return True
        if "Operation timed out" not in b.stdout + b.stderr:
            return False
        time.sleep(5)
    return False


def run(test):
    try:
        r = subprocess.run([os.path.join(B, "tests", test)], capture_output=True, text=True, env=ENV, timeout=600)
    except subprocess.TimeoutExpired:
        return False
    return r.returncode == 0


def bump(path):
    t = time.time() + 3
    os.utime(path, (t, t))


JOURNAL = os.path.join(ROOT, "tools", f".mutate_validator{('.' + GROUP) if GROUP else ''}.restore.json")


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
    results = []
    tests = sorted({m[1] for m in M})
    try:
        for f, test, old, new in M:
            path = FILES[f]
            orig = open(path, encoding="utf-8").read()
            n = orig.count(old)
            if n != 1:
                results.append([f, old, new, f"bad-anchor({n})", None])
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
            reason = why(f, old, new) if res == "survived" else None
            results.append([f, old, new, res, reason])
            print(res, f, old.replace("\n", " ")[:90], ("  <= " + reason[:60]) if reason else ("  <= UNDOCUMENTED" if res == "survived" else ""), flush=True)
    finally:
        for t in tests:
            build(t)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(results, fh, ensure_ascii=False, indent=1)
    print(dict(Counter(r[3] for r in results)), flush=True)
    undocumented = [r for r in results if r[3] == "survived" and not r[4]]
    if undocumented:
        print(f"UNDOCUMENTED survivors: {len(undocumented)}(补用例,或在 WHY 里写理由)", flush=True)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
