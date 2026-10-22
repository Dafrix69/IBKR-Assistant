// 给人看之前遮账号。规则同 desktop/redact.js 的 maskAccount:留开头的字母与末三位,
// DU1234567 → DU***567,U1234567 → U***567,纯数字的 28190044 → ***044;五个字符及以下整个遮掉。
// 用例对着 engine-ts/tests/desktop-redact.spec.ts 的那几条。
#pragma once

#include <QString>

namespace ibkr::util {

QString maskAccount(const QString& id);

/// 逗号分隔的账户表,逐个遮
QString maskAccountList(const QString& list);

/// 一段文字里长得像 IBKR 账号的串(U / DU / F / DF / I + 数字)留头尾、中间遮掉。
/// 同 desktop/redact.js 的 IBKR_ACCOUNT:TWS 的报错原文里有时带着账号
QString maskAccountLikeIds(QString text);

}  // namespace ibkr::util
