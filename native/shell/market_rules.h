// 「行情」一页(逐句搬):
//   · pages/Market.tsx:上面一个标的的 K 线读盘,下面「关注的盘口」;
//   · lib/PaPanel.tsx:新鲜度一行、结果的各张卡片(结论、K 线、盘口、判断依据、结构、流动性与形态、关键价位、高周期、局限、AI 解读);
//   · lib/PaVerdict.tsx:三个子分 + 高周期并排、正在形成的那一根、按子分分组的判断依据;
//   · lib/marketBits.tsx 的 BookBody / BookSide:一档摘要 + 买卖各五档(上面那张盘口与盘口墙共用);
//   · lib/BookWall.tsx:关注表(本机记着,最多 12 只)与每只一张卡片。
// 判断全在引擎(pa.analyze 的回包),这里只摆;期望值:tests/fixtures/gen_market.mjs
#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QSet>
#include <QStringList>

namespace ibkr::shell::market {

/// 关注的盘口最多几只(BookWall 的 add)
constexpr int kMaxBooks = 12;

/// paFreshness:「最后一根 … · 3 分钟前 · 已收盘 159 根 · 含盘前盘后 · 引擎缓存」
QString freshness(const QJsonObject& r);

/// 关注表(localStorage 的 dafri-book-symbols 那一串):JSON 数组按 String() 逐个取,别的一律当空
QStringList readSymbols(const QString& raw);

/// 一只的盘口(BookBody):{ kind: none | error | ok, text(none / error 的那句), meta: [..], bid, ask,
///   depth: null | { bids: [{ price, size, pct }], asks: [...] }, note }
/// cell 是 book.snapshot 的回包,或 { error },或没有(undefined)
QJsonObject bookBody(const QJsonValue& cell, bool loading);

struct PageInput {
    // ---- K 线读盘那一节
    QString symbol;
    QString timeframe = QStringLiteral("5m");
    bool rth = false;
    QJsonArray timeframes;
    /// pa.analyze 的回包(没有 = 还没分析过 / 出错清掉了)
    QJsonValue data;
    QString error;
    bool loading = false;
    /// pa.comment 的 comment 加上 model(没有 = 没解读过)
    QJsonValue comment;
    bool commenting = false;
    // ---- 盘口
    QStringList books;
    /// 标的 → 快照 / { error }
    QJsonObject bookData;
    QSet<QString> bookLoading;
    // ---- 参考资料开没开(手动点过的;没点过按默认)
    std::optional<bool> introOpen, legendOpen, bookPrimerOpen;
};

/// 整页的模型(字段见 market_rules.cpp 的 pageModel 开头)
QJsonObject pageModel(const PageInput& in);
/// SSR 抽出来的那一串字(整页,照 DOM 次序)
QStringList pageTexts(const QJsonObject& page);

}  // namespace ibkr::shell::market
