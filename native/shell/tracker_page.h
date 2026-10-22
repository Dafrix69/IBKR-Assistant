// 「持仓追踪」整页摆什么(desktop/renderer-react/src/pages/Tracker.tsx 的 TrackerPage / PositionBody / LoopPulse,逐句搬):
// 账户持仓(组合一张卡、腿折叠在下面,单腿与正股各一张)、盯盘心跳、正在追踪的卡片(shell/track_card)。QML 照着画。
// 期望值:tests/fixtures/gen_tracker_page.mjs 用 SSR 把原页面渲染出来抽字,数据底子是预览台的 mock-bridge.js。
#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QSet>
#include <QString>
#include <QStringList>

namespace ibkr::shell::track {

struct PageInput {
    /// TrackerStore::snap():{ positions, positionsError, tracks, tracksError, rows, hosted, delayed, loop, pollError }
    QJsonObject tracker;
    bool connected = false;
    QString gateway = QStringLiteral("TWS");
    QJsonArray watches;
    QStringList busy;
    /// 展开了表单的那一张持仓(key);一次只展开一张
    QString openKey;
};

/// 一份持仓的卡片主体(PositionBody):{ key, title, pill: { tint, text, tri }, compact, badge: { text, tint } | null, hero, heroSub, heroNotes: [..],
///   pct: { text, tint } | null, facts: [{ value, label, text }], tracked, open, legs?: [...], legsHeader? }
QJsonObject positionModel(const QJsonObject& p, bool compact, const QString& openKey);
/// 盯盘心跳那一行:{ text, bad }
QJsonObject loopPulse(const QJsonValue& loop);
/// 整页:{ positions: { empty?, cards: [...] }, tracksError, pulse, tracks: { empty?, cards: [...] } }
QJsonObject trackerPageModel(const PageInput& in);
/// 按 React 版的文档次序吐出来的每一段字(表单收着、腿明细收着时都不渲染,同原版)
QStringList pageTexts(const QJsonObject& model);

}  // namespace ibkr::shell::track
