// 「绩效体检」一页(逐句搬):已了结交易的美元账本 → 冠军交易员天天盯的那几个数 → 行为上的毛病。
//   · pages/Performance.tsx:范围(实盘 / 模拟 / 都要)、品种、天数、重新计算、分享卡片;读着 / 算不出来 / 空;实盘模拟混算的提醒;
//   · lib/PerformanceParts.tsx:体检结论、核心数字(十八格 + 两行说明)、平仓权益曲线、分组(品种表多几栏)、账本(20 笔一页);
//   · lib/PerformanceExtras.tsx:保护规则建议(按建议填入 → settings.patch,只带那一条规则)、自动平仓的执行损耗;
//   · lib/PositionSizer.tsx + sizing.ts:仓位计算器(固定风险比例);
//   · lib/SignalScorecard.tsx:信号成绩单(点了才算);
//   · lib/shareCardDraw.ts:分享卡片的副标题与页脚(画在 app/pages/ShareCard.qml)。
// 数字与结论全是引擎 review.performance / review.signals 算的;这里只管选范围、摆与几处写法。期望值:tests/fixtures/gen_performance.mjs
#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QStringList>
#include <QTimeZone>

#include <optional>

namespace ibkr::shell::performance {

/// 带符号的美元:+$1,234.50 / -$85.00;空或不是有限数是「—」
QString usd(const QJsonValue& v);

/// 仓位计算器(sizing.ts 的 sizePosition):先定这一笔最多亏账户的百分之几,再倒推做几份
struct Sizing {
    double budget = 0, units = 0, actualRisk = 0, actualPct = 0;
    std::optional<double> streakDrawdownPct;
};
std::optional<Sizing> sizePosition(const QJsonValue& equity, const QJsonValue& riskPct, const QJsonValue& unitRisk, const QJsonValue& losingStreak);

/// 账本里风险固定那些蝶的每份风险中位数(仓位计算器的起手值);没有是 null
QJsonValue typicalUnitRisk(const QJsonValue& r);

/// 保护规则建议:规则名、一句话、只带这一条规则的 settings.patch
QString ruleLabel(const QString& rule);
QString adviceText(const QJsonValue& advice);
QJsonObject advicePatch(const QJsonValue& advice);

/// 分享卡片(shareCardDraw.ts 的 cardSubtitle / cardFootnote)
QString cardSubtitle(const QJsonValue& r, const QString& scope, const QString& kind, int days);
QString cardFootnote(const QJsonValue& r);
/// 存图时的文件名(main.js 的 image-export):控制字符、路径分隔符与 Windows 保留字符换成下划线,最多 60 个 UTF-16 码元,空了是「交易体检」
QString safeImageName(const QString& name);

struct PageInput {
    QString scope = QStringLiteral("all"), kind = QStringLiteral("all");
    int days = 0;
    QJsonValue data;
    QString error;
    bool loading = false;
    /// 正在按建议填入的那一条规则
    QString adviceBusy;
    // ---- 仓位计算器(权益与比例记在本机;每份最大亏损的起手值是账本里的中位数,换了数据重来)
    QJsonValue sizerEquity, sizerPct = 1, sizerUnit;
    // ---- 信号成绩单
    QJsonValue signalData;
    bool signalsLoading = false;
    QString signalsError;
    // ---- 两张表的页码(从 1 数)
    int ledgerPage = 1, execPage = 1;
    double nowMs = 0;
    QTimeZone zone = QTimeZone::systemTimeZone();
};

/// 整页的模型(字段见 performance_rules.cpp 的 pageModel 开头)
QJsonObject pageModel(const PageInput& in);
/// SSR 抽出来的那一串字
QStringList pageTexts(const QJsonObject& page);
/// 平仓权益曲线的 spec(JSON 形状,同 EquitySection 的 useMemo);不到两笔是 null
QJsonValue equityChart(const QJsonValue& r);

}  // namespace ibkr::shell::performance
