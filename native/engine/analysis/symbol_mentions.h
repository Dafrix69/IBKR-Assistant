// symbolMentions.ts:一句话里提到了哪几只标的(cashtag / known / alias / implied / guess 五档)。纯函数。
// TS 用的几条正则都是不带 u 的 JS 正则(按 UTF-16 码元走,/i 只折 ASCII 字母,\s 是 JS 那一组空白),
// 这里不用 QRegularExpression(PCRE 的 /i 按 Unicode 折、\s 只认 ASCII、碰到落单的代理项整条不匹配),按码元手写同样的匹配。
// 叫法表是 JS 对象(OJson,键序同 JS);值按 TS 的读法用:makeUniverse 里 String(v),extractMentions 里 symbol.toUpperCase()——
// 值不是串时命中那一刻抛 V8 的 TypeError 原话。
#pragma once

#include "util/ordered_json.h"

#include <QList>
#include <QSet>
#include <QString>
#include <QStringList>

#include <optional>
#include <vector>

namespace ibkr::analysis::symbol_mentions {

struct Mention {
    QString symbol;
    QString how;  // cashtag / known / alias / implied / guess
    QString term;
    util::OJson toJson() const;
};

struct Universe {
    /// Set 的先后(只有 has 用得着;留着先后给对拍)
    QStringList known;
    QSet<QString> knownSet;
    /// 叫法 → 代码(JS 对象)
    util::OJson aliases;
    /// 空 / "" = 不推断(TS 的 `universe.implied &&`)
    std::optional<QString> implied;
    void add(const QString& s);
    util::OJson toJson() const;
};

const util::OJson& builtinAliases();
const QStringList& builtinKnown();

bool looksLikeOptionTalk(const QString& text);
/// rawText 是 null / undefined 时调用方给 ""(同 `rawText ?? ""`)
std::vector<Mention> extractMentions(const QString& rawText, const Universe& universe);
/// known 的每一项按 String(s ?? "") 读;aliases 是对象
Universe makeUniverse(const QList<util::OJson>& known, const util::OJson& aliases = util::OJson(), const std::optional<QString>& implied = QStringLiteral("SPX"));
QStringList confidentSymbols(const std::vector<Mention>& mentions);
QStringList guessedSymbols(const std::vector<Mention>& mentions);

}  // namespace ibkr::analysis::symbol_mentions
