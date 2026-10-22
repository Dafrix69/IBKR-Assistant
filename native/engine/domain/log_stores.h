// 交易库里四张只增不改的小表,各自一份 TS 文件,这里放在一起(每个类对着一个文件逐句搬):
//   SignalLogStore ← signalLog.ts(价位提醒 / 盯异动 / 强势股 / K线 PA 的每一条信号)
//   FollowLogStore ← followLog.ts(跟单日志与盘口表)
//   MessageLogStore ← messageLog.ts(情报的消息底账)
//   IdeaVectorStore ← ideaVectors.ts(想法的嵌入向量,Float32 存 BLOB)
// 入参是 JS 对象(TS 的接口形状,字段缺了就是 undefined → 绑成 NULL);返回的行也是 JS 对象,字段与先后同 TS 的对象字面量。
#pragma once

#include "util/ordered_json.h"
#include "util/sqlite.h"

#include <QHash>
#include <QString>
#include <QVector>

#include <optional>
#include <utility>

namespace ibkr::domain {

class SignalLogStore {
public:
    explicit SignalLogStore(util::sqlite::Database& db);
    void log(const QList<util::OJson>& entries);
    double logOnce(const QList<util::OJson>& entries, const QString& since);
    QList<util::OJson> listWithSeq(const std::optional<QString>& since = std::nullopt, double limit = 20'000);
    QList<util::OJson> list(const std::optional<QString>& since = std::nullopt, double limit = 20'000);

private:
    QList<util::OJson> listImpl(const std::optional<QString>& since, double limit, bool withSeq);
    util::sqlite::Database& db_;
};

inline constexpr int kFollowTextMax = 200;

class FollowLogStore {
public:
    explicit FollowLogStore(util::sqlite::Database& db);
    bool has(const QString& messageId);
    bool add(const util::OJson& entry);
    bool addQuote(const QString& messageId, const QString& at, const util::OJson& quote);
    /// 消息 id → {outcome, detail, summary},Map 的先后
    QList<std::pair<QString, util::OJson>> verdictsFor(const QStringList& messageIds);
    double sentSince(const QString& since);
    QList<util::OJson> recent(double limit = 30);

private:
    util::sqlite::Database& db_;
};

inline constexpr int kMessageTextMax = 300;

class MessageLogStore {
public:
    explicit MessageLogStore(util::sqlite::Database& db);
    bool has(const QString& messageId);
    bool add(const util::OJson& entry);
    /// opts:{limit?, symbol?, since?}
    QList<util::OJson> recent(const util::OJson& opts = {});
    double count();
    double countSince(const QString& since, const std::optional<QString>& symbol = std::nullopt);

private:
    util::sqlite::Database& db_;
};

/// 原文指纹:sha1 的前 16 位十六进制
QString textHash(const QString& text);

class IdeaVectorStore {
public:
    explicit IdeaVectorStore(util::sqlite::Database& db);
    /// ideas:[{id, text}];id → 向量(Map 的先后)
    QList<std::pair<QString, QVector<float>>> get(const QString& model, const QList<std::pair<QString, QString>>& ideas);
    void put(const QString& ideaId, const QString& text, const QString& model, const QVector<double>& vec);
    double count(const QString& model);

private:
    util::sqlite::Database& db_;
};

}  // namespace ibkr::domain
