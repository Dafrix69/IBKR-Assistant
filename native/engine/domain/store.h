// 交易记录落库(engine-ts/src/store.ts 逐句搬)。审计要求"只增不改":trade_records / record_events / audit_log 由触发器拒绝 UPDATE / DELETE,
// 状态变化一律 append 成事件,读的时候 foldEvents 折成记录。表结构逐字照抄(旧库直接打开是验收标准)。
// 记录、成交行、事件的 payload 都是 JS 对象(OJson,键序同 JS);读出来的行同 TS 的 `{...row}`:结果列的先后、JSON 列就地解开。
// 时刻(nowIso)用墙上的钟(util::dateNow),不用注入的美东钟;id 用 util::randomUUID——两样测试都换成可复现的。
#pragma once

#include "domain/imported_trades.h"
#include "domain/log_stores.h"
#include "domain/risk_queries.h"
#include "util/ordered_json.h"
#include "util/sqlite.h"

#include <QSet>
#include <QString>
#include <QStringList>

#include <memory>
#include <optional>

namespace ibkr::domain {

extern const char16_t* const kStoreSchema;
const QSet<QString>& terminalStatuses();
inline const QStringList kIdeaStatuses{QStringLiteral("active"), QStringLiteral("done"), QStringLiteral("archived")};

/// §9.3 日志脱敏:DU1234567 → DU***567
QString redactAccount(const QString& accountId);

class TradeStore {
public:
    static constexpr int kQualityNoteMax = 60;
    static constexpr int kQualityEventsKeep = 50;

    /// safety:真应用开库时给 true(拒绝比软件新的库、查完整性、备份、盖版本号;打不开时抛 StoreOpenError)
    explicit TradeStore(QString dbPath, bool safety = false);
    ~TradeStore();

    const QString dbPath;
    ImportedTradesStore& imports() { return *imports_; }
    IdeaVectorStore& vectors() { return *vectors_; }
    SignalLogStore& signalLog() { return *signals_; }  // TS 的 store.signals(signals 是 Qt 的宏)
    FollowLogStore& follow() { return *follow_; }
    MessageLogStore& messages() { return *messages_; }
    RiskQueries& risk() { return *risk_; }
    util::sqlite::Database& db() { return *db_; }

    void close();
    util::OJson backupNow(const QString& reason);

    // ---- 写入
    /// 同 TS:会改调用方的 record(补上 id 与 created_at)
    QString createRecord(util::OJson& record);
    void appendEvent(const QString& recordId, const QString& kind, const util::OJson& payload);
    void markSubmitIntent(const QString& recordId);
    void setFinalStatus(const QString& recordId, const QString& status, const std::optional<QString>& errorDetail = std::nullopt);
    double rememberFills(const QList<util::OJson>& rows);
    QList<util::OJson> listFills();
    double countFills();
    QList<util::OJson> fillsByOrderRef(const QString& orderRef, double limit = 500);
    /// detail 空 = {}
    void audit(const QString& actor, const QString& action, const util::OJson* detail = nullptr);

    // ---- 价位警告
    util::OJson addWatch(QString symbol, double step = 0, const QString& origin = {});
    QList<util::OJson> listWatches();
    std::optional<util::OJson> getWatch(const QString& watchId);
    bool updateWatch(const QString& watchId, const util::OJson& fields);
    bool deleteWatch(const QString& watchId);

    // ---- 持仓追踪
    util::OJson addTrack(const util::OJson& track);
    QList<util::OJson> listTracks();
    std::optional<util::OJson> getTrack(const QString& trackId);
    bool updateTrack(const QString& trackId, const util::OJson& fields);
    bool deleteTrack(const QString& trackId);

    // ---- 优质股追踪
    util::OJson addQualityStock(QString symbol, const util::OJson* note = nullptr);
    QList<util::OJson> listQualityStocks();
    std::optional<util::OJson> getQualityStock(const QString& stockId);
    bool updateQualityStock(const QString& stockId, const util::OJson& fields);
    bool deleteQualityStock(const QString& stockId);

    // ---- 界面级偏好
    /// 没有这个键、或存的不是合法 JSON,都回 null
    util::OJson getPref(const QString& key);
    void setPref(const QString& key, const util::OJson* value);

    // ---- 自定义板块
    util::OJson addSector(QString name);
    std::optional<util::OJson> getSector(const QString& sectorId);
    QList<util::OJson> listSectors();
    QStringList symbolsInSectors();
    bool setSectorStocks(const QString& sectorId, const util::OJson& stocks);
    bool deleteSector(const QString& sectorId);

    // ---- 想法
    util::OJson addIdea(QString text, const std::optional<QStringList>& symbols = std::nullopt);
    QList<util::OJson> listIdeas(const std::optional<QString>& status = std::nullopt, double limit = 200);
    std::optional<util::OJson> getIdea(const QString& ideaId);
    bool setIdeaSymbols(const QString& ideaId, const QStringList& symbols);
    bool setIdeaAnalysis(const QString& ideaId, const util::OJson& analysis);
    bool setIdeaStatus(const QString& ideaId, const QString& status);
    /// filter:{statuses?, since?, until?, symbols?, terms?, limit?};行:{idea, symbol_hit, text_hit}
    QList<util::OJson> searchIdeas(const util::OJson& filter);
    util::OJson addIdeaDigest(const QString& scope, const QStringList& ideaIds, const util::OJson& digest, const util::OJson* focus = nullptr,
                              const util::OJson* trades = nullptr);
    QList<util::OJson> listIdeaDigests(double limit = 20);

    // ---- 读取
    std::optional<util::OJson> getRecord(const QString& recordId);
    QList<util::OJson> listRecords(double limit = 50);
    QList<util::OJson> recentOrders(double windowMinutes, double nowMs) { return risk_->recentOrders(windowMinutes, nowMs); }
    /// {id, symbol, accountId, quantity, createdAtMs, lastStatus, lastStatusAtMs, signature}
    QList<util::OJson> listWorkingRecords(double maxAgeDays = 7, std::optional<double> nowMs = std::nullopt, double limit = 200);
    QList<util::OJson> recentCloses(double sinceMs, double nowMs) { return risk_->recentCloses(sinceMs, nowMs); }
    QList<util::OJson> closeTraces(double limit = 2000);
    QList<util::OJson> plannedStops();
    QList<util::OJson> realizedPnlEvents(double sinceMs, double nowMs) { return risk_->realizedPnlEvents(sinceMs, nowMs); }

    // ---- 导出 / 删除(§9.3)
    util::OJson exportAll();
    void purgeEverything(const QString& confirm);
    void rawExec(const QString& sql, const util::sqlite::Binds& params = {});

private:
    void migrate();
    bool ensureIdeasFts();
    QStringList ideaIdsMatching(const QStringList& terms);
    util::OJson foldEvents(const QString& recordId, util::OJson record);
    QList<std::pair<QString, QString>> execSecTypes(const QList<util::OJson>& execIds);

    std::unique_ptr<util::sqlite::Database> db_;
    bool ideasFts_ = false;
    std::unique_ptr<ImportedTradesStore> imports_;
    std::unique_ptr<IdeaVectorStore> vectors_;
    std::unique_ptr<SignalLogStore> signals_;
    std::unique_ptr<FollowLogStore> follow_;
    std::unique_ptr<MessageLogStore> messages_;
    std::unique_ptr<RiskQueries> risk_;
};

}  // namespace ibkr::domain
