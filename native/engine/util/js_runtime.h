// JS 运行时里两样"每次都不一样"的东西:Date.now() 与 crypto.randomUUID()。引擎里凡是 TS 用它们的地方都走这里,
// 测试换成可复现的(gen_*.mjs 那边也换成同一套),这样落库的 id、时刻能逐字对拍。生产代码不调 set*ForTests。
// 注意:这是**墙上的钟**——domain::setClock 注入的是"美东此刻"(契约回放用),TS 里 store 的 nowIso 用的是 Date,不听那个钟。
#pragma once

#include <QString>

#include <functional>

namespace ibkr::util {

/// Date.now()
double dateNow();
/// crypto.randomUUID():小写、带连字符的 v4
QString randomUUID();

/// 测试用:空函数 = 还原
void setDateNowForTests(std::function<double()> f);
void setRandomUUIDForTests(std::function<QString()> f);

/// store.ts 的 nowIso():UTC、到秒、"+00:00"(Python isoformat 的样子)
QString nowIsoSeconds();

}  // namespace ibkr::util
