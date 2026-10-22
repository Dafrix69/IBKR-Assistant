// 「情报」一页、全站共用的标的档案抽屉与 ⌘K 查标的怎么摆(逐句搬):
//   · pages/Intel.tsx:页头(查标的、刷新)、没连券商 / 时间线没读到、种类分段、只看持仓、关键字、条数、常被提到;
//   · lib/IntelTimeline.tsx:按天分组的时间线,一条一行(种类、来源、标的胶囊、时刻、原文、结果 / 涨跌 / 说明、写进指令框);
//   · lib/SymbolDossier.tsx:档案(此刻的价、标签、持仓、追踪、在途单、接下来的事、价位、最近异动、想法、时间线);
//   · shell/DossierHost.tsx 的 Lookup:查标的(提示、持仓、最近查过的)。
// 输入是 store/intel 的状态(shell/feed_stores 的 IntelStore::state(),同一个形状);规则函数在 shell/intel_rules。
// 期望值:tests/fixtures/gen_intel.mjs
#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QStringList>
#include <QTimeZone>

namespace ibkr::shell::intel {

/// ⌘ / Ctrl+(store/appearance 的 MOD_KEY)
QString modKey();

/// 时间线(IntelTimeline):{ empty } 或 { groups: [{ label, count, rows: [行] }] };current 是档案里的那只(胶囊描边)
QJsonObject timelineModel(const QJsonArray& items, double now, const QString& current, const QString& empty, const QTimeZone& tz);
QStringList timelineTexts(const QJsonObject& timeline);

/// 情报页。state:IntelStore::state();query:关键字;connected:券商连着没有
QJsonObject pageModel(const QJsonObject& state, const QString& query, bool connected, double nowMs, const QTimeZone& tz = QTimeZone::systemTimeZone());
QStringList pageTexts(const QJsonObject& page);

/// 档案抽屉(state.dossier 不是 null 时)
QJsonObject dossierModel(const QJsonObject& dossier, const QTimeZone& tz = QTimeZone::systemTimeZone());
QStringList dossierTexts(const QJsonObject& model);

/// 查标的(state.lookupOpen 时)。text:敲的字
QJsonObject lookupModel(const QJsonObject& state, const QString& text);
QStringList lookupTexts(const QJsonObject& model);

}  // namespace ibkr::shell::intel
