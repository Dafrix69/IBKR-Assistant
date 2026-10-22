// macro.ts:宏观行情带(TWS 流式优先,公开源兜底)、速记解析用的公开源指数现价、跨市场那一路的公开源报价。
// TS 的 async 函数在这里是 util::Task 协程;取数器(fetcher)由调用方给——TS 默认的那个(fetch + 超时 + 两句人话)是网络 I/O,
// 不在 analysis 层,这里只搬了它对回包的判断(fetchedBody)。缓存与「在途」表是进程里的一份(同 TS 的模块级 Map / Set),
// 缓存里的格子是共享的对象:macroBoard 往取回来的那一格上写 source / instrument,写的就是缓存里那一份(TS 也是),
// 之后从缓存里摊出来的格子键序跟着变——这里照样共享(shared_ptr)。
#pragma once

#include "util/ordered_json.h"
#include "util/task.h"

#include <QString>
#include <QStringList>

#include <functional>
#include <memory>
#include <optional>

namespace ibkr::analysis::macro {

/// (url, timeoutMs) → 解析好的 JSON;取不到就抛 util::JsError(话进格子的 error)
using Fetcher = std::function<util::Task<util::OJson>(const QString& url, double timeoutMs)>;

/// MACRO_SYMBOLS(键序同 TS)
const QList<util::OJson>& macroSymbols();
QStringList liveTickers();
/// Cboe delayed_quotes 载荷 → 最新价
std::optional<double> cboeLast(const util::OJson* payload);

struct BoardOptions {
    std::optional<double> timeout;  // 秒,缺省 6
    bool force = false;
    /// router.streamQuotes(tickers):回 {代码: {last, change_pct}} 或 null;可以抛(当没有)。空 = 没给 router
    std::function<util::OJson(const QStringList&)> streamQuotes;
    Fetcher fetcher;
    /// 秒;空 = Date.now() / 1000
    std::function<double()> now;
};
util::Task<util::OJson> macroBoard(BoardOptions options);

util::Task<std::optional<double>> publicIndexPrice(QString symbol, double timeout, Fetcher fetcher);
/// {代码: {last, change_pct, error?}}。TS 是 Promise.all 并发取,回包的键按各只取完的先后(微任务的拍数)排;这里按给的先后。
/// 同一个代码给两遍时 TS 两遍都去取(都没命中缓存),这里第二遍可能命中第一遍刚存的——调用方的清单是写死的、不重复
util::Task<util::OJson> publicQuotes(QStringList symbols, double timeout, Fetcher fetcher);

/// TS defaultFetcher 拿到回包之后的那段(text 是回包按 UTF-8 解出来的字,开头的 BOM 照 fetch 的 text() 去掉):不是 2xx 抛「数据源返回 HTTP …」,不是 JSON 抛「数据源返回的不是 JSON(前 60 字:…)」
util::OJson fetchedBody(bool ok, int status, const QString& statusText, const QString& text);

/// 测试用:清空缓存与在途表
void clearMacroCache();

}  // namespace ibkr::analysis::macro
