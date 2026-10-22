// shorthand.ts:本地速记解析(语法 v7)——固定的蝴蝶 / 贷方价差行话跳过大模型。红线只有一条:绝不猜,
// 整条指令必须被语法完整覆盖,否则回 null 交给大模型。产出与大模型同形,走同一套校验。
#pragma once

#include "domain/config.h"
#include "util/ordered_json.h"

#include <QString>
#include <QStringList>

namespace ibkr::parsing::shorthand {

inline const QString kLocalModel = QStringLiteral("local-shorthand");
inline const QString kGrammarVersion = QStringLiteral("shorthand-v7");

bool looksLikeShorthand(const QString& text);
bool looksLikeOrder(const QString& text);
bool spreadWithoutType(const QString& text);
QStringList shorthandSymbols(const QString& instruction);

struct ShorthandMeta {
    bool relativeCenter = false;
    bool set = false;  // 解析有没有写过它(TS 里 meta 只在走到那一步时才被赋值)
};
/// 命中 → 与大模型同形的 payload;不确定 → null。snapshot:{代码: 现价}(松的 JSON 对象)
util::OJson tryParseShorthand(const QString& instruction, const util::OJson& snapshot, const domain::EtNow& moment, ShorthandMeta* meta = nullptr);

}  // namespace ibkr::parsing::shorthand
