// ideaRetrieval.ts:想法检索——打分、混合检索的合并、按时间分层抽样、知识总结的取数,与入参的纯文本整理。纯计算。
// 候选是 JS 对象 {idea, symbol_hit, text_hit, semantic_hit?},想法是 ideas 表的行(OJson);命中标记按真假读。
// **约定:idea.id 是串**(TS 用 < / > 比 id,串按 UTF-16 码元比)。created_at 按 Date.parse 读(util/intel_dateparse),不带时区的按 local 换。
#pragma once

#include "util/ordered_json.h"

#include <QList>
#include <QSet>
#include <QString>
#include <QStringList>
#include <QTimeZone>

#include <optional>

namespace ibkr::analysis::idea_retrieval {

struct PickOptions {
    double total = 100, recent = 20, buckets = 3;
};
inline constexpr PickOptions kDigestPick{100, 20, 3};

double scoreCandidate(const util::OJson& c);
QStringList matchTags(const util::OJson& c);
/// semantic:过了门槛的 id(Map 只用到 has)
QList<util::OJson> mergeSemantic(const QList<util::OJson>& candidates, const QList<util::OJson>& pool, const QSet<QString>& semantic, double limit,
                                 const QTimeZone& local = QTimeZone::systemTimeZone());
QList<util::OJson> stratify(const QList<util::OJson>& candidates, double budget, double buckets, const QTimeZone& local = QTimeZone::systemTimeZone());
/// [{idea, matched_by}],按时间从早到晚
QList<util::OJson> pickForDigest(const QList<util::OJson>& matches, const QList<util::OJson>& recentPool, const PickOptions& opts = kDigestPick,
                                 const QTimeZone& local = QTimeZone::systemTimeZone());

/// 空指针 = undefined
QStringList splitTerms(const util::OJson* q);
QStringList parseSymbols(const util::OJson* raw);
/// 没有焦点是 null
util::OJson normalizeFocus(const util::OJson* raw);
/// name 是 "since" / "until";不给是空;不是真日子抛 JsError
std::optional<QString> dayBound(const util::OJson* raw, const QString& name);

}  // namespace ibkr::analysis::idea_retrieval
