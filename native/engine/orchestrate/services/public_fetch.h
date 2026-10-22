// 公开数据源的 GET(events.ts 里的 defaultFetcher):发一次 GET、带 User-Agent、限时,2xx 且正文是 JSON 才交出解析后的值。
// 与 TS 的对应与不同:
//   · TS 用 fetch + AbortController;这里用 parsing/sdk_http 的 Exchange(自己说 HTTP/1.1,明文 http 只许回环,https 不限,不跟重定向)。
//   · 到点未完成:TS 的 AbortError「This operation was aborted」,同;连不上 / 回话坏了:TS 的 TypeError「fetch failed」,同。
//   · 非 2xx:TS 的话是「日历源返回 HTTP <状态码> <状态短语>」;Exchange 不暴露状态短语(「Not Found」那一截),这里只给状态码。**这一处与 TS 不同**,
//     只影响界面上 feed.error 的措辞。
//   · 回包不是 JSON:「日历源返回的不是 JSON(前 60 字:…)」,同(空白折成一个空格)。
#pragma once

#include "util/ordered_json.h"
#include "util/task.h"

#include <QString>

namespace ibkr::orchestrate {

/// failLabel:报错话里的数据源名(events 是「日历源」)
util::Task<util::OJson> publicFetch(QString url, double timeoutMs, QString userAgent, QString failLabel);

}  // namespace ibkr::orchestrate
