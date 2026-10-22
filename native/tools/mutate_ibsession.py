#!/usr/bin/env python3
"""ibsession 这一簇(ib_session / ib_api_next)的变异检验。

只在私有副本里改、在私有副本里编(qt-port-brief.md 第 3 条):别的助手与验收同时在编项目,原地改会让他们编进活的变异。
副本的样子(一次搭好,源码改了再 rsync 一遍):

  W=/Users/dafrix/Developer/ibkr/work/mut-ibsession
  mkdir -p $W && rsync -a --delete --exclude 'build*' --exclude '.vscode' /Users/dafrix/Developer/ibkr/IBKR-Assistant/native/ $W/native/
  for d in desktop engine-ts docs prompts; do ln -sfn /Users/dafrix/Developer/ibkr/IBKR-Assistant/$d $W/$d; done
  cmake -S $W/native -B $W/build -G Ninja -DCMAKE_BUILD_TYPE=Debug -DCMAKE_PREFIX_PATH=/opt/homebrew \
        -DCMAKE_CXX_COMPILER=/Library/Developer/CommandLineTools/usr/bin/clang++

每个变异是一处单行(或两三行)改动:写进去 → 重编 tst_ib_session → 跑 → 记 caught / survived;finally 里还原、
把文件时间往后拨几秒(ninja 按秒比时间戳)、重编。钱路径(下单 / 改单 / 撤单的字节、成交与佣金的转发)的变异排在前面。

  python3 native/tools/mutate_ibsession.py                 # 全部(在副本里)
  ONLY='子串|子串' python3 native/tools/mutate_ibsession.py  # 只跑 old 里含这些子串的(子串里别带换行)
  MUT_ROOT=<副本的 native> BUILD=<副本的编译目录> OUT=结果.json
"""
import json
import os
import subprocess
import sys
import time
from collections import Counter

PROJECT = "/Users/dafrix/Developer/ibkr/IBKR-Assistant/native"
WORK = "/Users/dafrix/Developer/ibkr/work/mut-ibsession"
ROOT = os.environ.get("MUT_ROOT", os.path.join(WORK, "native"))
if os.path.realpath(ROOT) == os.path.realpath(PROJECT):
    sys.exit("变异只在私有副本里做(见文件开头),不许改项目里的源码")
B = os.environ.get("BUILD", os.path.join(WORK, "build"))
OUT = os.environ.get("OUT", "/Users/dafrix/Developer/ibkr/work/ibsession/mutate_ibsession.json")
ENV = dict(os.environ, QT_QPA_PLATFORM="offscreen")
E = os.path.join(ROOT, "engine", "execution") + "/"
TEST = "tst_ib_session"
S, A, AH, SH, LD = "ib_session.cpp", "ib_api_next.cpp", "ib_api_next.h", "ib_session.h", "ib_link_down.h"

# (文件, 原文, 改成) —— 原文在文件里必须恰好出现一次
M = [
    # ---------------- 钱路径:单子的样子
    (S, '{u"orderRef"_s, js::S(order.orderRef.value_or(QString()))},', '{u"orderRef"_s, js::S(u"x"_s)},'),
    (S, 'if (order.lmtPrice) out.set(u"lmtPrice"_s, js::N(*order.lmtPrice));', 'if (order.lmtPrice) out.set(u"auxPrice"_s, js::N(*order.lmtPrice));'),
    (S, 'if (order.auxPrice) out.set(u"auxPrice"_s, js::N(*order.auxPrice));', '(void)0;'),
    (S, 'if (order.trailingPercent) out.set(u"trailingPercent"_s, js::N(*order.trailingPercent));', '(void)0;'),
    (S, 'out.set(u"ocaType"_s, js::N(order.ocaType.value_or(1)));', 'out.set(u"ocaType"_s, js::N(order.ocaType.value_or(0)));'),
    (S, 'if (!order.ocaGroup.isEmpty()) {', 'if (true) {'),
    (S, 'if (order.trailStopPrice) out.set(u"trailStopPrice"_s, js::N(*order.trailStopPrice));', '(void)0;'),
    (S, 'pc.set(u"triggerMethod"_s, js::N(0));', 'pc.set(u"triggerMethod"_s, js::N(2));'),
    (S, 'pc.set(u"conjunctionConnection"_s, js::S(u"a"_s));', 'pc.set(u"conjunctionConnection"_s, js::S(u"o"_s));'),
    (S, 'pc.set(u"type"_s, js::N(1));', 'pc.set(u"type"_s, js::N(3));'),
    (S, 'put(u"conId"_s, c.get(u"conId"_s));', '(void)0;'),
    (S, 'put(u"isMore"_s, c.get(u"isMore"_s));', 'pc.set(u"isMore"_s, js::B(true));'),
    (S, 'out.set(u"conditionsCancelOrder"_s, js::B(order.conditionsCancelOrder.value_or(false)));', 'out.set(u"conditionsCancelOrder"_s, js::B(order.conditionsCancelOrder.value_or(true)));'),
    (S, '{u"transmit"_s, js::B(order.transmit)},', '{u"transmit"_s, js::B(true)},'),
    (S, '{u"outsideRth"_s, js::B(order.outsideRth)},', '{u"outsideRth"_s, js::B(false)},'),
    (S, '{u"totalQuantity"_s, js::N(order.totalQuantity)},', '{u"totalQuantity"_s, js::N(1)},'),
    (S, '{u"account"_s, js::S(order.account)},', '{u"account"_s, js::S(QString())},'),
    (S, 'c.set(u"strValue"_s, js::S(price ? js::str(price) : u"undefined"_s));', 'c.set(u"strValue"_s, js::S(u"0"_s));'),
    (S, 'if (c.strike && *c.strike != 0 && !std::isnan(*c.strike)) o.set', 'if (c.strike) o.set'),
    (S, 'o.set(u"multiplier"_s, js::N(util::jsStringToNumber(*c.multiplier)));', 'o.set(u"multiplier"_s, js::S(*c.multiplier));'),
    (S, 'if (c.conId && *c.conId != 0) o.set', 'if (c.conId) o.set'),
    (S, 'if (c.includeExpired) o.set(u"includeExpired"_s, js::B(true));', '(void)0;'),
    (S, '{u"ratio"_s, js::N(l.ratio)}', '{u"ratio"_s, js::N(1)}'),
    (S, 'if (c.lastTradeDateOrContractMonth && !c.lastTradeDateOrContractMonth->isEmpty()) o.set', 'if (c.lastTradeDateOrContractMonth) o.set'),
    (S, '{u"totalQuantity"_s, js::N(order.totalQuantity)},', '{u"totalQuantity"_s, js::N(std::abs(order.totalQuantity))},'),
    (S, 'for (std::size_t i = 0; i < fills_->size(); ++i) {', 'for (std::size_t i = fills_->size(); i-- > 0;) {'),
    (S, 'for (std::size_t i = 0; i < commissions_->size(); ++i) {', 'for (std::size_t i = commissions_->size(); i-- > 0;) {'),
    (S, 'for (std::size_t i = 0; i < connectivityCbs_.size(); ++i) {', 'for (std::size_t i = connectivityCbs_.size(); i-- > 0;) {'),
    (S, 'for (std::size_t i = 0; i < linkCbs_.size(); ++i) {', 'for (std::size_t i = linkCbs_.size(); i-- > 0;) {'),
    (S, 'for (std::size_t i = 0; i < s->orderStatusCbs_.size(); ++i) {', 'for (std::size_t i = s->orderStatusCbs_.size(); i-- > 0;) {'),
    (S, 'for (std::size_t i = 0; i < errorCbs_.size(); ++i) {', 'for (std::size_t i = errorCbs_.size(); i-- > 0;) {'),
    # ---------------- 断线时的闸(LinkDownError):去掉 / 挪后 / 只管一半 / 话不对
    (S, '        if (!self->connected_) throw LinkDownError();\n        const OJson ibOrder = orderForWire(order);', '        (void)0;\n        const OJson ibOrder = orderForWire(order);'),
    (S, '        if (!connected_) throw LinkDownError();', '        (void)0;'),
    (S, '        if (!self->connected_) throw LinkDownError();\n        const OJson ibOrder = orderForWire(order);', '        if (!self->connected_ && order.orderId && *order.orderId != 0) throw LinkDownError();\n        const OJson ibOrder = orderForWire(order);'),
    (S, '        if (!self->connected_) throw LinkDownError();\n        const OJson ibOrder = orderForWire(order);', '        if (!self->connected_ && !(order.orderId && *order.orderId != 0)) throw LinkDownError();\n        const OJson ibOrder = orderForWire(order);'),
    (S, '        if (!self->connected_) throw LinkDownError();\n        const OJson ibOrder = orderForWire(order);', '        const OJson ibOrder = orderForWire(order);\n        if (!self->connected_) throw LinkDownError();'),
    (S, '        if (!self->connected_) throw LinkDownError();\n        const OJson ibOrder = orderForWire(order);\n        // 带着原 orderId 就是改单:IBKR 的改单语义是同一个 id 重发\n        if (order.orderId && *order.orderId != 0) {\n            self->api_->modifyOrder(*order.orderId, toIbContract(contract), ibOrder);',
     '        const OJson ibOrder = orderForWire(order);\n        // 带着原 orderId 就是改单:IBKR 的改单语义是同一个 id 重发\n        if (order.orderId && *order.orderId != 0) {\n            self->api_->modifyOrder(*order.orderId, toIbContract(contract), ibOrder);\n            if (!self->connected_) throw LinkDownError();'),
    (S, '        if (!connected_) throw LinkDownError();\n        api_->cancelOrder(orderId);', '        api_->cancelOrder(orderId);\n        if (!connected_) throw LinkDownError();'),
    (LD, 'QStringLiteral("与 TWS 的连接已断开,正在自动重连")', 'QStringLiteral("与 TWS 的连接已断开,正在自动重连了")'),
    # ---------------- 握手版本与接收缓冲的边界
    (A, 'if (serverVersion_ < 100 || serverVersion_ > 193) {', 'if (serverVersion_ < 100 || serverVersion_ > 194) {'),
    (A, 'if (serverVersion_ < 100 || serverVersion_ > 193) {', 'if (serverVersion_ < 100 || serverVersion_ >= 193) {'),
    (A, 'if (serverVersion_ < 100 || serverVersion_ > 193) {', 'if (serverVersion_ < 99 || serverVersion_ > 193) {'),
    (A, 'if (serverVersion_ < 100 || serverVersion_ > 193) {', 'if (serverVersion_ <= 100 || serverVersion_ > 193) {'),
    (A, 'if (buffer_.size() > 0xffffff) {', 'if (buffer_.size() > 0xfffffe) {'),
    (A, 'if (buffer_.size() > 0xffffff) {', 'if (buffer_.size() >= 0xffffff) {'),
    (A, 'if (buffer_.size() > 0xffffff) {', 'if (buffer_.size() > 0x1000000) {'),
    # ---------------- 生命周期:把强引用的环加回去,测试要能咬到
    (A, '[self = weak_from_this(), weak, weakMine] {', '[self = weak_from_this(), weak, weakMine, keep = mine] {'),
    (S, '    ibnext::Task<double> pending;\n    {', '    ibnext::Task<double> pending;\n    std::shared_ptr<IbApiNextSession> keep = weak.lock();\n    {'),
    (A, '    auto weak = weak_from_this();\n    const double orderId = co_await getNextValidOrderId();', '    auto weak = weak_from_this();\n    auto hold = shared_from_this();\n    const double orderId = co_await getNextValidOrderId();'),
    (A, '        auto keep = owner_.lock();  // 回调里哪怕把会话丢了,这一层也撑到这个回调跑完', '        (void)owner_;'),
    (A, '        if (alive.expired()) return;\n        auto keep = owner_.lock();\n        reConnect();', '        if (alive.expired()) return;\n        reConnect();'),
    # ---------------- 会话销毁之后的路(协程醒来时会话没了、撤单闭包、订阅的回调);LinkDownError 的类型与名字
    (S, '        if (!self) throw util::JsError(sessionClosed());', '        (void)0;'),
    (S, '            if (!s) return;\n            Runtime::Scope scope(*s->rt_);\n            s->api_->cancelOrder(id);', '            Runtime::Scope scope(*s->rt_);\n            s->api_->cancelOrder(id);'),
    (S, '            if (!s || !entry) return;\n            const QString text = err.message.left(120);', '            const QString text = err.message.left(120);'),
    (S, '            if (!s || !entry) return;\n            const QString text = err.message.left(120);', '            if (!s && !entry) return;\n            const QString text = err.message.left(120);'),
    (S, '            if (!s || !entry) return;\n            MarketDataUpdate m;', '            MarketDataUpdate m;'),
    (S, '            if (!s || !entry) return;\n            MarketDataUpdate m;', '            if (!s && !entry) return;\n            MarketDataUpdate m;'),
    (S, '        else co_return;', '        ;'),
    (S, '    else co_return std::nullopt;', '    ;'),
    (LD, 'QStringLiteral("LinkDownError")', 'QStringLiteral("LinkDownErrorX")'),
    (S, '        if (!self->connected_) throw LinkDownError();\n        const OJson ibOrder = orderForWire(order);', '        if (!self->connected_) throw util::JsError(LinkDownError().message());\n        const OJson ibOrder = orderForWire(order);'),
    (S, '        if (!connected_) throw LinkDownError();\n        api_->cancelOrder(orderId);', '        if (!connected_) throw util::JsError(LinkDownError().message());\n        api_->cancelOrder(orderId);'),
    # ---------------- 钱路径:改单、新单、撤单
    (S, 'if (order.orderId && *order.orderId != 0) {', 'if (order.orderId) {'),
    (S, 'self->api_->modifyOrder(*order.orderId, toIbContract(contract), ibOrder);', 'self->api_->modifyOrder(*order.orderId + 1, toIbContract(contract), ibOrder);'),
    (S, 'api_->cancelOrder(orderId);\n        return Task<>::resolved();', 'api_->cancelOrder(orderId + 1);\n        return Task<>::resolved();'),
    (S, '            s->api_->cancelOrder(id);', '            s->api_->cancelOrder(id + 1);'),
    (A, '    self->api_.placeOrder(orderId, contract, order);\n    co_return orderId;', '    self->api_.placeOrder(orderId + 1, contract, order);\n    co_return orderId;'),
    (A, 'auto sub = subs.items.front().second;', 'auto sub = subs.items.back().second;'),
    (A, 'return lastValueFrom<double>(sub, [](const std::any& a) { return std::any_cast<double>(a); }, -1.0);',
     'return lastValueFrom<double>(sub, [](const std::any& a) { return std::any_cast<double>(a) + 1; }, -1.0);'),
    # ---------------- 钱路径:成交与佣金
    (S, '{u"permId"_s, numOrNull(permId)}})},', '{u"permId"_s, js::N(numOr0(permId))}})},'),
    (S, '{u"filled"_s, js::N(numOr0(filled))},', '{u"filled"_s, js::N(js::num(filled))},'),
    (S, '{u"avgFillPrice"_s, js::N(numOr0(avgFillPrice))}})},', '{u"avgFillPrice"_s, js::N(numOr0(remaining))}})},'),
    (S, '{u"live"_s, js::B(js::num(rq) == -1)},', '{u"live"_s, js::B(js::num(rq) != -1)},'),
    (S, 'const OJson* rq = js::undef(reqId) ? &minusOne : reqId;', 'const OJson* rq = reqId;'),
    (S, '{u"price"_s, f(u"price"_s, js::N(0))},', '{u"price"_s, f(u"avgPrice"_s, js::N(0))},'),
    (S, '{u"shares"_s, f(u"shares"_s, js::N(0))},', '{u"shares"_s, f(u"cumQty"_s, js::N(0))},'),
    (S, '{u"cumQty"_s, f(u"cumQty"_s, OJson::null())},', '{u"cumQty"_s, f(u"cumQty"_s, js::N(0))},'),
    (S, 'if (tradesByExec_.has(execId)) return;', 'if (false) return;'),
    (S, 'if (!execId.isEmpty()) {\n        if (tradesByExec_', 'if (true) {\n        if (tradesByExec_'),
    (S, 'if (!trade || commissioned_.contains(execId)) return;', 'if (!trade) return;'),
    (S, 'cb(t, OJson::null(), r);', 'cb(t, t, r);'),
    (S, 'const OJson* contract = s->contractsByOrder_.get(js::num(evArg(a, 0)));', 'const OJson* contract = nullptr;'),
    (S, 's->contractsByOrder_.set(js::num(evArg(a, 0)), orElse(evArg(a, 1), js::object()));', 's->contractsByOrder_.set(js::num(evArg(a, 0)) + 1, orElse(evArg(a, 1), js::object()));'),
    (S, 'if (auto s = weak.lock()) s->execs_.onExecDetails(evArg(a, 0), evArg(a, 1), evArg(a, 2));', 'if (auto s = weak.lock()) s->execs_.onExecDetails(nullptr, evArg(a, 1), evArg(a, 2));'),
    # ---------------- 错误与连接状态的回调
    (S, 'if (reqId > 0) {', 'if (reqId >= 0) {'),
    (S, 'if (code == 0 || std::isnan(code)) return;\n    emitConnectivity', 'if (std::isnan(code)) return;\n    emitConnectivity'),
    (S, 'if (s->closing_ || code == 0 || std::isnan(code)) return;', 'if (code == 0 || std::isnan(code)) return;'),
    (S, 'if (!established_ || closing_) return;', 'if (closing_) return;'),
    (S, 'emitLink(false);', 'emitLink(true);'),
    (S, 'api_->setMarketDataType(mdBaseline_);', '(void)0;'),
    (S, 'for (auto& [k, live] : tickers_.items) live->data.requestedAt = rt_->now();', '(void)0;'),
    (S, 'if (!m.isEmpty()) s->managed_ = m;', '(void)m;'),
    (S, '        positionsLatest_.reset();\n        pnlLatest_.clear();', '        pnlLatest_.clear();'),
    (S, '        netLiq_.clear();\n        for (auto& [k, live]', '        for (auto& [k, live]'),
    (S, 'for (auto& [k, live] : tickers_.items) live->data = emptyTicker();', '(void)0;'),
    (S, '        self->api_->disconnect();\n        std::rethrow_exception(failed);', '        std::rethrow_exception(failed);'),
    (S, "self->api_->getManagedAccounts(), 10'000,", "self->api_->getManagedAccounts(), 9'000,"),
    (S, 'api_->setMarketDataType(type == 1 ? mdBaseline_ : type);', 'api_->setMarketDataType(type);'),
    (SH, 'inline constexpr double kIbReconnectMs = 5000;', 'inline constexpr double kIbReconnectMs = 4000;'),
    # ---------------- 行情
    (S, 'const bool optionLike = c.secType == u"OPT" || c.secType == u"FOP";', 'const bool optionLike = c.secType == u"OPT";'),
    (S, 'if (optionLike && c.tradingClass && !c.tradingClass->isEmpty())', 'if (c.tradingClass && !c.tradingClass->isEmpty())'),
    (S, "return genericTicks.isEmpty() ? base : base + u'#' + genericTicks;", "return base + u'#' + genericTicks;"),
    (S, 'return v ? v : get(u"DELAYED_"_s + name);', 'return v;'),
    (S, 'if (liveLast && !std::isnan(*liveLast)) data.delayed = false;', 'if (liveLast) data.delayed = false;'),
    (S, 'else if (get(u"DELAYED_LAST"_s)) data.delayed = true;', 'else if (get(u"DELAYED_BID"_s)) data.delayed = true;'),
    (S, 'return t->value ? *t->value : std::nan("");', 'return t->value;'),
    (S, 'const auto& delta = update.changed ? update.changed : update.added ? update.added : ticks;', 'const auto& delta = ticks;'),
    (S, 'if (gamma || iv) data.modelGreeks', 'if (gamma) data.modelGreeks'),
    (S, 'if (!data.last && data.bid > 0 && data.ask > 0)', 'if (!data.last && data.bid > 0)'),
    (S, 'if (v && !std::isnan(*v)) apply(*v);', 'if (v) apply(*v);'),
    (S, '{u"DELAYED_LAST"_s, 68}', '{u"DELAYED_LAST"_s, 67}'),
    (S, '{u"MODEL_OPTION_IV"_s, 10039}', '{u"MODEL_OPTION_IV"_s, 10040}'),
    (S, 'if (const auto* now = s->tickers_.get(key); now && *now == entry) s->tickers_.erase(key);', '(void)key;'),
    (S, 'const QString text = err.message.left(120);', 'const QString text = err.message.left(121);'),
    (S, 'if (plain && entry->data.last) s->lastFeed_', 'if (entry->data.last) s->lastFeed_'),
    (S, 'if (attached || (entry_->data.error && !entry_->data.error->isEmpty())) return entry_->data;', 'if (attached) return entry_->data;'),
    (S, "if (k == base || k.startsWith(base + u'#')) keys.append(k);", 'if (k == base) keys.append(k);'),
    (S, 'live->data.requestedAt = rt_->now();\n        tickers_.set(key, live);', 'tickers_.set(key, live);'),
    # ---------------- 持仓、净值、盈亏
    (S, 'const bool isDelta = update.added || update.changed || update.removed;', 'const bool isDelta = update.added || update.changed;'),
    (S, 'if (!table || !isDelta) {', 'if (!table) {'),
    (S, 'if (n != 0 && !std::isnan(n)) table->set(k, held(account, p));\n        else table->erase(k);', 'table->set(k, held(account, p));'),
    (S, 'each(update.removed, [&](const QString& account, const OJson& p) { table->erase(keyOf(account, p.get(u"contract"_s))); });', '(void)0;'),
    (S, '(!js::nullish(conId) ? js::str(conId) : !js::nullish(symbol) ? js::str(symbol) : QString())', '(!js::nullish(symbol) ? js::str(symbol) : QString())'),
    (S, 'if (!self->connected_) throw util::JsError(u"与 TWS 的连接已断开,正在自动重连"_s);', '(void)0;'),
    (S, 'rt->setTimeout(8000, [d, rt]', 'rt->setTimeout(7000, [d, rt]'),
    (S, '        if (self->positionsSub_) self->positionsSub_->unsubscribe();\n        self->positionsSub_.reset();\n        throw',
     '        self->positionsSub_.reset();\n        throw'),
    (S, 'contract.set(u"account"_s, js::S(p.account));', '(void)0;'),
    (S, 's->positionsLatest_.reset();', '(void)0;'),
    (S, 's->pnlLatest_.erase(accountId);', '(void)0;'),
    (S, 'if (!connected_) return std::nullopt;\n    ensureSummary();\n    ensurePnl', 'ensureSummary();\n    ensurePnl'),
    (S, 'if (amount) s->netLiq_.set(account, NetLiquidation{*amount, currency});', 's->netLiq_.set(account, NetLiquidation{amount.value_or(0), currency});'),
    (S, 'if (std::isfinite(n) && std::abs(n) < 1e300) return n;', 'if (std::isfinite(n)) return n;'),
    (S, '(js::isStr(value) && value->s.isEmpty())', 'false'),
    (S, 'out.currency = nl ? nl->currency : QString();', 'out.currency = QString();'),
    # ---------------- 主动断开
    (S, '    if (positionsSub_) positionsSub_->unsubscribe();\n    positionsSub_.reset();\n    positionsLatest_.reset();\n    api_->disconnect();',
     '    positionsSub_.reset();\n    positionsLatest_.reset();\n    api_->disconnect();'),
    (S, '        if (l->sub) l->sub->unsubscribe();', '        (void)l;'),
    # ---------------- 合约确认、K 线、深度、期权链、未成交单、往回要成交
    (S, 'if (!std::isfinite(conId) || conId <= 0) continue;', 'if (!std::isfinite(conId) || conId < 0) continue;'),
    (S, 'if (dup) continue;', '(void)dup;'),
    (S, 'if (hit.size() == 1) return hit.front();', 'if (!hit.empty()) return hit.front();'),
    (S, 'const QString wanted = util::jsTrim(name).toUpper();', 'const QString wanted = name;'),
    (S, 'for (const QString& name : {requested.tradingClass.value_or(QString()), requested.symbol}) {', 'for (const QString& name : {requested.tradingClass.value_or(QString())}) {'),
    (S, 'if (!resolved->exchange.isEmpty()) contract->exchange = resolved->exchange;', 'contract->exchange = resolved->exchange;'),
    (S, 'contract->conId = 0;  // 没有或分不出', 'contract->conId = -1;  // 没有或分不出'),
    (S, 'if (js::isNum(price) && price->n > 0) {', 'if (js::isNum(price)) {'),
    (S, '    handle->unsubscribe();\n    co_return *out;', '    co_return *out;'),
    (S, 'opts.whatToShow, opts.useRTH ? 1 : 0, 1);', 'opts.whatToShow, 0, 1);'),
    (S, 'opts.endDateTime.isEmpty() ? std::nullopt : std::optional<QString>(opts.endDateTime)', 'std::optional<QString>(opts.endDateTime)'),
    (S, 'r.volume = js::nullish(vol) ? 0 : js::num(vol);', 'r.volume = js::num(vol);'),
    (S, 'if (!std::isfinite(n) || n >= 1.7e308) return std::nullopt;', 'if (!std::isfinite(n)) return std::nullopt;'),
    (S, 'd.tif = js::strOr(f(u"tif"_s), u"GTC"_s);', 'd.tif = js::strOr(f(u"tif"_s), u"DAY"_s);'),
    (S, 'if (!got.supported) co_return std::nullopt;', '(void)0;'),
    (S, 'r.clientId = historyClientId(self->cfg_.clientId);', 'r.clientId = self->cfg_.clientId;'),
    (S, "out.reset();  // 查不到时段不该炸掉轮询", "out = std::array<QString, 3>{};  // 查不到时段不该炸掉轮询"),
    # ---------------- 库这一层:限速、命令缓冲、socket、自动重连
    (A, 'if (!(ms >= 1 && ms <= 2147483647.0)) return 1;', 'if (!(ms >= 1 && ms <= 2147483647.0)) return 2;'),
    (AH, 'int rateCount_ = 4;', 'int rateCount_ = 5;'),
    (A, 'rt_->setTimeout(100, [this, alive] {', 'rt_->setTimeout(99, [this, alive] {'),
    (A, 'if (!rateFifo_.empty()) rateCallNext(std::nullopt);\n        else rateCount_ += 1;', 'rateCount_ += 1;'),
    (A, '    while (!paused_) {\n        processing_ = true;', '    while (true) {\n        processing_ = true;'),
    (A, 'if (name == u"nextValidId") resume();', 'if (name == u"managedAccounts") resume();'),
    (A, 'else emitInfo(u"Cannot disconnect if already disconnected."_s, 504);', 'else emitInfo(u"Cannot disconnect if already disconnected."_s, 505);'),
    (A, 'if (status_ >= kConnectingStatus) socketDisconnect();', 'if (status_ >= kDisconnectingStatus) socketDisconnect();'),
    (A, '    status_ = kDisconnectingStatus;\n    pause();', '    status_ = kDisconnectingStatus;'),
    (A, 'if (tokens.last() != u"") dataFragment_ = tokens.last();', 'if (false) dataFragment_ = tokens.last();'),
    (A, 'if (serverVersion_ < 100 || serverVersion_ > 193) {', 'if (serverVersion_ < 100 || serverVersion_ > 200) {'),
    (A, 'if (status_ != kDisconnectedStatus) {\n        status_ = kDisconnectedStatus;', 'if (true) {\n        status_ = kDisconnectedStatus;'),
    (A, 'void IbApi::onSocketError(const QString& message) { emitError(message, 502); }', 'void IbApi::onSocketError(const QString& message) { emitError(message, 503); }'),
    (A, '        if (isConnected()) controllerDisconnect();', '        controllerDisconnect();'),
    (A, '        connectionState.next(Connected);\n        stopReConnectTimer();', '        connectionState.next(Connected);'),
    (A, 'if (connectionState.value() != Disconnected || !autoReconnectEnabled_) return;', 'if (connectionState.value() != Disconnected) return;'),
    (A, '    controllerDisconnect();\n    controllerConnect(currentClientId_);', '    controllerConnect(currentClientId_);'),
    (A, '        disconnect();\n        autoReconnectEnabled_ = true;', '        disconnect();'),
    (A, 'const QByteArray config = "v100..193";', 'const QByteArray config = "v100..192";'),
    (A, 'if (serverVersion_ >= 3) {', 'if (serverVersion_ >= 300) {'),
    (A, '(code->n == 1100 || code->n == 2110)', '(code->n == 1100)'),
    (A, '(e.code >= 2100 && e.code < 3000)', '(e.code >= 2100 && e.code < 2200)'),
    (A, 'e.message.contains(u"Warning:"_s)', 'false'),
    (A, 'e.code == 10090 || e.code == 10167 || e.code == 399 ||', 'e.code == 10090 || e.code == 399 ||'),
    # ---------------- 订阅
    (A, '    }\n    cancelTws();\n}', '    }\n}'),
    (A, 'if (s->index++ == 0) {', 'if (s->index++ == 1) {'),
    (A, '        first.added = v.all;', '        (void)0;'),
    (A, 'if (--observersCount_ <= 0) {', 'if (--observersCount_ < 0) {'),
    (A, '        self->lastAllValue.reset();\n        self->endEventReceived = false;', '        self->endEventReceived = false;'),
    (A, 'if (api->isConnected() && cancel_) cancel_();', 'if (cancel_) cancel_();'),
    (A, 'if (!sub && s->instanceId == instanceId) sub = s;', 'if (false) sub = s;'),
    (A, '        if (auto api = api_.lock()) reqId = api->nextReqId();\n    }', '    }'),
    (A, '    (*o.fn)(value_);\n    return id;', '    return id;'),
    # ---------------- 库的事件处理
    (A, ".split(u',');", ".split(u';');"),
    (A, 'list.remove(idx, list.size() - idx);', 'list.remove(idx, 1);'),
    (A, '} else if (!js::truthy(pos)) {', '} else if (false) {'),
    (A, '        if (!sub->endEventReceived) {\n            sub->lastAllValue = cached;\n            return;', '        if (false) {\n            sub->lastAllValue = cached;\n            return;'),
    (A, 'if (value && *value == -1 && (tickType == 1 || tickType == 66 || tickType == 2 || tickType == 67)) value.reset();',
     'if (value && *value == -1 && (tickType == 1 || tickType == 2)) value.reset();'),
    (A, 'if (std::isfinite(n)) numeric = n;', 'numeric = n;'),
    (A, 'else if (field == 13) base = 10039;', 'else if (field == 13) base = 10040;'),
    (A, 'ticks.push_back({base + 3, val(7)});  // GAMMA', 'ticks.push_back({base + 3, val(8)});  // GAMMA'),
    (A, 'else if (field == 83) base = 10045;', 'else if (field == 83) base = 10039;'),
    (A, 'if (time.startsWith(u"finished"_s)) {', 'if (time.isEmpty()) {'),
    (A, 'if (!(js::isNum(v) && v->n == -1)) setIf(bar', 'setIf(bar'),
    (A, 'arr.insert(arr.begin() + static_cast<qsizetype>(i), {key, value});', 'arr.push_back({key, value});'),
    (A, '    if (sideN == 0) {\n        cachedRows = &cached->asks;', '    if (sideN == 1) {\n        cachedRows = &cached->asks;'),
    (A, 'if (looseEq(js::path(&(*all)[i], {u"order"_s, u"permId"_s}), js::prop(order, u"permId"_s))) idx = i;', 'if (false) idx = i;'),
    (A, 'if (OJson* st = updated.get(u"orderState"_s); st && st->isObject()) setIf(*st, u"status"_s, arg(a, 1));', '(void)0;'),
    (A, '    if (!sub->endEventReceived) {\n        sub->lastAllValue = cached;\n    } else {', '    if (false) {\n        sub->lastAllValue = cached;\n    } else {'),
    (A, 'return js::num(a) == js::num(b);', 'return false;'),
    (A, 'row.set(u"multiplier"_s, js::N(util::jsParseInt(js::str(defined(arg(a, 4))), 10)));', 'setIf(row, u"multiplier"_s, arg(a, 4));'),
]

ONLY = [x for x in os.environ.get("ONLY", "").split("|") if x]
if ONLY:
    M = [m for m in M if any(o in m[1] for o in ONLY)]


def build():
    b = subprocess.run(["cmake", "--build", B, "--target", TEST, "-j6"], capture_output=True, text=True)
    return b.returncode == 0


def run():
    try:
        r = subprocess.run([os.path.join(B, "tests", TEST)], capture_output=True, text=True, env=ENV, timeout=300)
    except subprocess.TimeoutExpired:
        return False  # 卡住也算被测试咬住
    return r.returncode == 0


def bump(path):
    t = time.time() + 3
    os.utime(path, (t, t))


JOURNAL = os.path.join(WORK, ".mutate_ibsession.restore.json")


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


def main():
    recover()
    results = []
    try:
        for f, old, new in M:
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
                res = ("survived" if run() else "caught") if build() else "build-error"
            finally:
                with open(path, "w", encoding="utf-8") as fh:
                    fh.write(orig)
                bump(path)
                os.remove(JOURNAL)
            results.append([f, old, new, res])
            print(res, f, old.replace("\n", " ")[:90], flush=True)
    finally:
        build()
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(results, fh, ensure_ascii=False, indent=1)
    print(dict(Counter(r[3] for r in results)), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
