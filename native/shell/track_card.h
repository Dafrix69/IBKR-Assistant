// 持仓追踪页「正在追踪」的一张卡片写什么(desktop/renderer-react/src/lib/TrackCard.tsx 的 TrackCard / Gauge,
// 与 lib/TrackKeyLevels.tsx 的 TrackLevelsPanel,逐句搬)。这里只算"摆什么、说什么",QML 照着画。
// 期望值:tests/fixtures/gen_track_card.mjs 用 vite SSR 把原组件渲染成 HTML、按文档次序抽出文字;cardTexts 按同样的次序吐字来比。
#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QString>
#include <QStringList>

namespace ibkr::shell::track {

struct CardInput {
    QJsonObject track;
    /// 盯盘那一行(还没有是 { id })
    QJsonObject live;
    /// 托管对账的那一份 { orders };没有是 null
    QJsonValue hosted;
    bool delayed = false;
    bool connected = false;
    /// 券商叫什么(TWS / OpenD)
    QString gateway = QStringLiteral("TWS");
    /// 价位警告里的盯单(alerts.snap().watches)与正在算的那几条(busy)
    QJsonArray watches;
    QStringList busy;
};

/// 卡片的模型:
/// { tone, title, pill: { tint, text }, meta: [{ text, cls }], tiers: [..], stopBasis, hosted: [{ text, cls }] | null,
///   pnl: { text, pct, cls } | null, rail: [{ key, price, label, kind }] | null,
///   gauge: null | { lines: [..], spotStop, empty, rings: [{ label, value, gap, pct, closeness, tint }] },
///   levels: null | { pending: { text, button, watchId, computing } } | { summary, notes, meta, strip: { levels, spot }, watchId, computing },
///   reason, chase, blocked: [..], toggle: 暂停 / 恢复, symbol, id }
QJsonObject trackCardModel(const CardInput& in);
/// 模型按 React 版的文档次序吐出来的每一段字(价位条是浏览器才画的 SVG,不算)
QStringList cardTexts(const QJsonObject& model);

}  // namespace ibkr::shell::track
