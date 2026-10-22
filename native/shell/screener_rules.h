// 「扫描」一页(逐句搬):一个股票池、一次扫描、一张表——每只股一行,RS 强度与各周期的 CD 背离并排;点哪一行,下面就是它的极值偏离。
//   · pages/Screener.tsx:股票池(选中的板块或全部,成分股去重)、扫描的选项、状态行、表、行业标签卡、结尾的口径;
//   · lib/screenerRows.ts:两路结果合成一行、排序(没数的沉底)、RS 格的着色;
//   · lib/ScanTable.tsx:表的列、信号格、标签卡;
//   · lib/DeviationSection.tsx:单只的极值偏离(六个数、结论、两张图、本段的极值);
//   · lib/LeadersSection.tsx:强势股筛选(趋势模板 8 条 + VCP + RS 评级、大盘方向)。
// 数字全由引擎纯函数算;这里只管选项、合并与展示。期望值:tests/fixtures/gen_screener.mjs
#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QStringList>
#include <QTimeZone>

namespace ibkr::shell::screener {

/// TF_LABEL / TF_OPTIONS 的次序:周线、日线、1 小时、30 分、15 分
const QList<std::pair<QString, QString>>& timeframeOptions();
/// screenerRows.ts 的 num:空 / 读不成数是「—」;toFixed(digits);sign 时正数带 +
QString num(const QJsonValue& v, int digits = 2, bool sign = false);

/// 表里的行(RS 那一行打底,背离按标的并进来;只有背离那边有的股接在后面)
QJsonArray mergeRows(const QJsonValue& rs, const QJsonValue& infl);
/// key:w<窗口>(RS 那一列)/ score / hits;order:ascend / descend。没数的行不管升降都沉底,稳定排序
QJsonArray sortRows(const QJsonArray& rows, const QString& key, const QString& order);

struct DevState {
    QString symbol, free, timeframe = QStringLiteral("1d");
    QJsonValue period = 20, lookback = 120;
    bool busy = false;
    QJsonValue result;
    QString status;
};

struct PageInput {
    QJsonArray sectors;
    /// 本机记着的股票池(板块 id 或 all)
    QString sector = QStringLiteral("all");
    QString sortKey, sortOrder;
    // ---- 扫描
    QString benchmark = QStringLiteral("SPY");
    QStringList timeframes{QStringLiteral("1w"), QStringLiteral("1d")};
    QJsonValue ma = 20;
    bool busy = false;
    QString progress;
    QJsonValue rs, infl;
    // ---- 极值偏离
    DevState dev;
    // ---- 强势股
    QJsonValue leaders;
    bool leadersBusy = false;
    QString leadersError;
    QString leadersFilter = QStringLiteral("all");
    double nowMs = 0;
    QTimeZone zone = QTimeZone::systemTimeZone();
};

/// 整页的模型(字段见 screener_rules.cpp 的 pageModel 开头)
QJsonObject pageModel(const PageInput& in);
/// SSR 抽出来的那一串字(带滚动的表头在 SSR 里渲染两遍;AntD Statistic 把纯数字拆成整数与小数两段,这里照着拆)
QStringList pageTexts(const QJsonObject& page);
/// 极值偏离的两张图(JSON 形状的 spec,同 DeviationSection 的 useMemo);没有 last 是 null
QJsonValue devCharts(const QJsonValue& result);

}  // namespace ibkr::shell::screener
