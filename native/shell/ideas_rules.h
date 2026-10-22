// 「想法」一页(pages/Ideas.tsx,逐句搬):随手记的列表、检索的命中方式、每条想法的 AI 分析(行情事实与 AI 叙事分开标注)、最新一次知识总结。
// 只摆,不判断;想法、分析、总结的形状在引擎契约里(engine-ts/src/contract/ideas.ts),analysis 与 digest 是库里的 JSON 列、可能缺键,
// 这里每一项都按"可能没有"来摆。期望值:tests/fixtures/gen_ideas.mjs
#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QSet>
#include <QStringList>
#include <QTimeZone>

namespace ibkr::shell::ideas {

struct PageInput {
    /// active / all
    QString filter = QStringLiteral("active");
    QJsonArray ideas;
    QString loadError;
    /// ideas.digests 的 digests(新的在前)
    QJsonArray digests;
    QString query;
    /// 想法 id → 命中方式(symbol / text / semantic / recent)
    QJsonObject matched;
    QSet<QString> analyzing;
    bool digesting = false;
    bool withTrades = true;
    double nowMs = 0;
    QTimeZone zone = QTimeZone::systemTimeZone();
};

/// { filter, query, withTrades, digesting, digestButton,
///   digest: null | { title, sections: [{ title, items }], meta: [{ text, title? }] },
///   empty: ""(有卡片)| 那句话, cards: [{ id, title, status, statusTint, text, meta, analysis, active, analyzing, analyzeLabel }] }
/// analysis: null | { title, facts: [..], thesis, sections, suggestion, meta }
QJsonObject pageModel(const PageInput& in);
/// SSR 抽出来的那一串字
QStringList pageTexts(const QJsonObject& page);

}  // namespace ibkr::shell::ideas
