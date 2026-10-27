// 「交易指令」页摆什么、勾选怎么算(逐句搬):
//   · desktop/renderer-react/src/pages/Trade.tsx 的就绪检查表、发送条件、实盘闸门 / 保护规则的提醒、速记片段、结果卡片(ResultCards);
//   · lib/accountPick.ts 的 pickAccounts 与 store/trade.ts 读本机存的勾选、appendInstruction;
//   · lib/OrderTicket.tsx 的票据、ui/graphics.tsx 的到期损益图(PayoffChart / PayoffAxis)、lib/SimilarTrades.tsx 的历史相似交易。
// 期望值:tests/fixtures/gen_trade_page.mjs(SSR 渲染原页面抽字、原函数真跑)。QML 照着这里的模型画,不自己判断。
#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QString>
#include <QStringList>

#include <optional>

namespace ibkr::shell::trade {

// ---- 发单账户 ---------------------------------------------------------------------------------------------------
/// lib/accountPick.ts:usable 是 [{ alias, default? }],saved 是本机存的那一份(nullopt = 没存过)
QStringList pickAccounts(const QJsonArray& usable, const std::optional<QStringList>& saved);
/// store/trade.ts 的 readPicked:JSON.parse(raw || 'null'),是数组就每项 String(),别的(含存坏了)都当没存过
std::optional<QStringList> readPicked(const std::optional<QString>& raw);
/// store/status.ts 的 pickableAccounts:当前券商通道下的账户(两家都配了别名时只列生效那家)
QJsonArray pickableAccounts(const QJsonValue& status);
QString gatewayName(const QJsonValue& status);
QString brokerShortName(const QJsonValue& status);

/// lib/tradeFacts.ts 的 tradeText:历史交易结局一笔一行(想法页的「对照的交易」也用)
QString tradeFactText(const QJsonObject& fact);

// ---- 输入框 -----------------------------------------------------------------------------------------------------
/// 蝴蝶测算的「写进指令」:空着就填进去,有字就去掉尾部空白、另起一行接上
QString appendInstruction(const QString& text, const QString& line);
struct Inserted {
    QString text;
    int caret = 0;
};
/// 点速记片段:插在光标 / 选区处;追加到句尾时整句片段前补换行,逗号开头的补充片段原样接上。下标是 UTF-16(同 textarea)
Inserted insertSnippet(const QString& text, int start, int end, const QString& snippet);
/// 六个速记片段:[[显示, 插入的字], ...]
QJsonArray shorthandChips();

// ---- 损益图 -----------------------------------------------------------------------------------------------------
/// 票据上的各腿 → 损益图的腿 [{ sign: ±1, right, strike, ratio? }](单腿期权按整单方向;组合各腿写的就是实际方向)
QJsonArray payoffLegs(const QJsonObject& ticket);
/// PayoffChart + PayoffAxis。viewBox 是 600 × 120,横向拉伸、纵向按比例(SVG 没写高,高 = 宽 / 5)。
/// { width: 600, height: 120, points: [{ x, y }], zeroY, ticks: [x...], spotX: x | null, d: { line, area },
///   axis: [{ left: 0..1, leftText: "27.27%", text, spot: bool }] };没有腿时是空对象
QJsonObject payoffChart(const QJsonArray& legs, const QJsonValue& premium, const QJsonValue& spot);

// ---- 票据与结果卡片 --------------------------------------------------------------------------------------------
/// isTicket:是对象、symbol 与 action 都是字符串
bool isTicket(const QJsonValue& v);
/// OrderTicket:{ badge, symbol, buy, sideText, sub, quantity, unit, price, typeText, trigger: text | null,
///   legPills: [{ text, up }] | null(只有组合有), payoff: payoffChart | null, footnote }
QJsonObject ticketModel(const QJsonObject& ticket);
/// 一张票据摆出来的字(SSR 抽出来的次序),追加到 out
void ticketTexts(const QJsonObject& ticketModel, QStringList& out);
/// SimilarTrades 的查询参数(ideas.similar_trades):票据缺的键写 null,同原版的 ?? null
QJsonObject similarQuery(const QJsonObject& ticket);
/// 同一张票据的查询算一个键(换了单才重取)
QString similarKey(const QJsonObject& ticket);
/// SimilarTrades 摆什么:state = { res?, err? }(都没有 = 正在找)。
/// { kind: loading|error|none|list, hint, head: { strong, tally, basis }, exits, items: [{ text, aside }], lessons: [..] }
QJsonObject similarModel(const QJsonObject& state);
/// ResultCards:[{ kind: order|reject|warn|llm, tone, title, ticket?, meta?, similarKey?, body?, reason?, items? }];空了是 [{ kind: empty, text }]
QJsonArray resultCards(const QJsonObject& payload);

// ---- 整页 -------------------------------------------------------------------------------------------------------
struct PageInput {
    QJsonValue status;
    /// store/llm 的大模型目录(读不到时是上一份;从没读到是 null)
    QJsonValue llm;
    /// accounts-info 的占位账号(示例里的全零账号)
    QStringList placeholders;
    /// 本机存的勾选(nullopt = 没存过)
    std::optional<QStringList> savedPicked;
    /// store/trade 的 composer:{ text, pane, busy, working, payload, failure }
    QJsonObject composer;
    /// 每张票据的历史相似交易:similarKey → { res?, err? }
    QJsonObject similar;
    /// store/appearance.ts 的 isMac:快捷键说明是 ⌘↩ 还是 Ctrl+Enter
#ifdef Q_OS_MACOS
    bool mac = true;
#else
    bool mac = false;
#endif
};

/// { title, limits, readiness: { title, sub, steps: [{ title, done, text, action, tab }] } | null, picked, usable,
///   send: { label, warn, canExecute, blockers, tip }, hotkeys, picker: { accounts: [{ alias, on, live, tip, text }], hint } | null,
///   guard: text | null, accountPauses: text | null, chips, primer: { summary, items },
///   pane, panes, result: { kind: working|failure|cards|empty, text, cards } }
QJsonObject tradePageModel(const PageInput& in);
/// 按 React 版的文档次序吐出来的每一段字(输入框里的字也算一段,同 SSR)
QStringList pageTexts(const QJsonObject& model, const QString& composerText);

}  // namespace ibkr::shell::trade
