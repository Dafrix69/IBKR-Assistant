// 「交易分析」一页(逐句搬):选一笔(蝴蝶或股票)→ 引擎 review.analyze 复盘 → 摆出结论。
//   · pages/Review.tsx:类型筛选、选哪一笔(candidateLabel / stockLabel 的写法)、周期、EM、同步成交、分析;附带本地未成交的开关;
//     新鲜度一行(读候选时写「本次新增 … · 库内成交 …」,分析后写「周期 · 几根 · 结局」);
//   · lib/ReviewResult.tsx:蝶的结果(本地记录的提醒、六格读数、两张图、止盈策略那一段、结论卡片、明细、备注)与股票的结果;
//   · lib/reviewCharts.tsx:股价、标的、蝶价三张图的 spec。
// 数字全是引擎算的(tradereview.ts / flyexit.ts);这里只管选项、写法与摆。期望值:tests/fixtures/gen_review.mjs
#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QStringList>
#include <QTimeZone>

namespace ibkr::shell::review {

/// 下拉里一笔的写法(Review.tsx 的 candidateLabel / stockLabel)
QString candidateLabel(const QJsonValue& c, double nowMs, const QTimeZone& zone);
/// 引擎给的结论档配什么色(REVIEW_TONE):good → ok,warn / bad / info 照旧,认不出是 info
QString findingTone(const QJsonValue& tone);
/// 周期下拉(TF_OPTIONS)与类型分段(KIND_OPTIONS)
const QList<std::pair<QString, QString>>& timeframeOptions();
const QList<std::pair<QString, QString>>& kindOptions();

struct PageInput {
    QJsonArray candidates;
    QString selected, timeframe = QStringLiteral("auto"), kind = QStringLiteral("all");
    /// EM:数或 null(空着 = 自动)
    QJsonValue em;
    bool includeLocal = false;
    QString freshness = QStringLiteral("—");
    /// 有没有连 TWS:null 是还没读回来
    QJsonValue available;
    QJsonValue data;
    QString error;
    bool loading = false;
    double nowMs = 0;
    QTimeZone zone = QTimeZone::systemTimeZone();
};

/// 筛过类型的候选(kind = all 全要;缺 kind 的算蝴蝶)
QJsonArray shownCandidates(const QJsonArray& candidates, const QString& kind);
/// 整页的模型(字段见 review_rules.cpp 的 pageModel 开头)
QJsonObject pageModel(const PageInput& in);
/// SSR 抽出来的那一串字
QStringList pageTexts(const QJsonObject& page);

/// 三张图的 spec(JSON 形状,同 reviewCharts.tsx 的 useMemo);不够两根是 null
QJsonValue stockChart(const QJsonValue& r);
QJsonValue underlyingChart(const QJsonValue& r);
QJsonValue flyChart(const QJsonValue& r);

}  // namespace ibkr::shell::review
