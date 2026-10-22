// 「回测」一页(逐句搬):选参数、跑一次、看结果;下面一节同一个策略扫一批参数,样本内挑、样本外看。
//   · pages/Backtest.tsx:表单(标的、区间、策略与它的参数、交易品种与期权的四项、成本)、期权的口径说明、随表单生成的策略流程、跑一次;
//   · lib/RuleBuilder.tsx:自定义策略的条件搭建器(一句话生成、入场 / 出场两组条件、每个算子一个下拉 + 周期或数值),条件写成一句话(fmtCond);
//   · lib/BacktestResult.tsx:总览、交易统计、本次的条件、净值曲线、成交明细、注意;
//   · lib/SweepPanel.tsx:参数扫描的网格、样本内占比、滚动前推、挑参数的口径,结果的总览、每组的表(10 行一页)、滚动前推的每一折。
// 数字全是引擎算的(backtest.ts / backtestLab.ts);这里只管选项、拼载荷与摆。期望值:tests/fixtures/gen_backtest.mjs
#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QStringList>

namespace ibkr::shell::backtest {

/// 条件里的一个算子写成字:常数原样;指标写中文名,有周期的带「(周期)」
QString fmtOperand(const QJsonValue& o);
/// 一条条件:「左 运算 右」(运算写成 > < ≥ ≤ 上穿 下穿)
QString fmtCond(const QJsonValue& c);
/// 交易品种的中文名(labels.ts 的 BT_INST_LABELS,次序同原版)
const QList<std::pair<QString, QString>>& instLabels();
/// 搭建器的算子下拉(BT_INDICATORS)与运算下拉(BT_OPS)
const QList<std::pair<QString, QString>>& indicatorOptions();
const QList<std::pair<QString, QString>>& opOptions();
/// 这一种指标要不要填周期(BT_NEEDS_PERIOD)
bool needsPeriod(const QString& name);
/// 下拉里换了一个算子(OperandEditor 的 pick):换成常数带上原来的数;换成要周期的指标带上原来的周期(没有就 20)
QJsonObject pickOperand(const QJsonObject& operand, const QString& next);
/// 默认网格(SweepPanel 的 defaultGrid):每个参数「一半(至少 1)、本身、一倍半」
QJsonObject defaultGrid(const QJsonValue& strategy);
/// "5, 10 20" → [5, 10, 20](逗号与空白都能分——空白照 JS 的 \s,全角空格也算;原版正则里写的两个逗号都是半角的,全角逗号分不开;认不出、≤ 0 的丢掉)
QJsonArray parseValues(const QString& text);

struct PageInput {
    QJsonArray strategies;
    QString symbol, start, end, strategyKey;
    /// 参数:键 → 数或 null(清空了)
    QJsonObject params;
    /// 自定义条件:{ entry: [...], exit: [...] }
    QJsonObject rules;
    QString instType = QStringLiteral("stock");
    /// 期权的四项:dte / offset / width / risk,各是数或 null
    QJsonObject inst{{QStringLiteral("dte"), 30}, {QStringLiteral("offset"), 0}, {QStringLiteral("width"), 2}, {QStringLiteral("risk"), 10}};
    QJsonValue cost = 0;
    QJsonValue result;
    bool running = false;
    QString failure;
    // ---- 条件搭建器
    QString ruleText;
    bool generating = false;
    // ---- 参数扫描
    QString swExtra;
    /// 改过的网格(键 → 原文);没改的那几个用默认网格
    QJsonObject swGrid;
    QJsonValue swSplit = 70, swFolds = 3;
    QString swObjective = QStringLiteral("return");
    QJsonValue swResult;
    bool swRunning = false;
    QString swFailure;
    /// 结果表翻到第几页(从 1 数)
    int swPage = 1;
};

/// 默认的自定义条件:RSI(14) < 30 进、RSI(14) > 70 出
QJsonObject defaultRules();
/// 整页的模型(字段见 backtest_rules.cpp 的 pageModel 开头)
QJsonObject pageModel(const PageInput& in);
/// SSR 抽出来的那一串字
QStringList pageTexts(const QJsonObject& page);
/// 净值曲线那张图(JSON 形状的 spec,同 BacktestResult 的 useMemo);不到两个点是 null
QJsonValue equityChart(const QJsonValue& result);

/// 跑一次的载荷(Backtest.tsx 的 run):标的去空白转大写;参数只带有数的;自定义带上条件;品种总带;成本是 0 / 空就不带
QJsonObject runSpec(const PageInput& in);
/// 扫参数的载荷(SweepPanel 的 run):标的 = 上面那只 + 再加的几只;网格只带解析出数的参数;成本是 0 / 空就不带
QJsonObject sweepSpec(const PageInput& in);

}  // namespace ibkr::shell::backtest
