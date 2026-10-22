// 配置(engine-ts/src/config.ts 逐句搬):读 settings.json、给默认值、校验——每一条校验的话逐字进黄金基线(golden-rpc 的
// settings.patch 那几步就比这些话),一个字不改。读配置的入口是 OJson(保序):错误里列的未知键、账户与连接的先后都按文件里的次序。
// 期望值:tests/fixtures/gen_config.mjs(原模块在一大把合法、不合法的配置上现跑)
#pragma once

#include "contract/config_types.h"
#include "contract/settings.h"
#include "util/error.h"
#include "util/ordered_json.h"

#include <QString>
#include <QStringList>

#include <optional>
#include <utility>
#include <vector>

namespace ibkr::domain {

inline constexpr int kExitConfig = 78;

/// LLM 端点的错(带 HTTP 状态码时 status 有值)
class LLMError : public util::JsError {
public:
    explicit LLMError(const QString& message, std::optional<int> status = std::nullopt) : JsError(message), status(status) {}
    std::optional<int> status;
};

/// 配置读不进来:missing = 文件不在;syntax = 不是合法 JSON;invalid = 校验不过(message 就是校验那句原话)
class ConfigLoadError : public util::JsError {
public:
    ConfigLoadError(QString kind, QString path, const QString& message) : JsError(message), kind(std::move(kind)), path(std::move(path)) {}
    QString kind;
    QString path;
};

struct EtNow {
    double epochMs = 0;
    QString date;  // 美东日历日 YYYY-MM-DD
    double minutes = 0;
    double seconds = 0;
};
EtNow etNowFromEpoch(double epochMs);
/// 可注入的时钟(契约回放在固定时刻跑);空 = 真的钟
void setClock(std::optional<double> epochMs);
std::optional<double> clockOverride();
double nowMs();
EtNow nowEt();

/// 供应商目录里配置校验要的那一点(完整目录在 parsing/providers)
struct ProviderMeta {
    bool needs_base_url;
    QString default_model;
};
const contract::OrderedMap<ProviderMeta>& providerMeta();
/// §9.4:强制 TLS,只给本机放行 http;不合规抛 LLMError
QString validateBaseUrl(const QString& url);
/// 提示词目录里版本号最大的那一版(system_vX.Y.Z.md);一版都没有回空
std::optional<QString> latestPromptVersion(const QString& promptDir);
QString defaultPromptDir();
QString defaultConfigPath();
/// 展开开头的 ~
QString expandHome(const QString& p);

inline const QString kStatusOpen = QStringLiteral("盘中");
inline const QString kStatusOutside = QStringLiteral("盘外");
inline const QString kStatusClosed = QStringLiteral("休市");
/// IBKR contractDetails.tradingHours → [开始, 结束] 的朴素分钟数对
std::vector<std::pair<double, double>> parseTradingHours(const QString& spec);
/// 按合约自己的交易时段判断此刻能不能交易;拿不到时段表回空串
QString hoursStatus(const QString& spec, const QString& tzId, double epochMs, const QString& liquid = {});

inline const QStringList kBrokerProviders{QStringLiteral("ibkr"), QStringLiteral("futu")};
double defaultBrokerPort(const QString& broker);

class Settings {
public:
    QString prompt_version = QStringLiteral("v1.0.0");
    bool prompt_follows_latest = false;
    QString prompt_dir;
    contract::LLMConfig llm;
    contract::BrokerConfig broker;
    contract::Limits limits;
    contract::Policies policies;
    contract::ProtectionsConfig protections;
    contract::RiskBudgetConfig risk_budget;
    contract::FollowConfig follow;
    std::vector<contract::AccountConfig> accounts;
    contract::OrderedMap<contract::ConnectionConfig> connections;
    contract::OrderedMap<QString> symbol_aliases;
    contract::OrderedMap<contract::IndexConfig> index_symbols;
    /// 休市日 / 提前收盘日里的字符串(判日子只认它们:TS 的 includes 是严格比较,别的类型永远对不上一个日期)
    QStringList market_holidays;
    QStringList early_close_days;
    /// 同一张表的原样(TS 的 mergeCalendar 结果:配置里写成数字、套了一层数组的也留着,排在它们 String() 的位置)
    QList<util::OJson> market_holidays_raw;
    QList<util::OJson> early_close_days_raw;
    QString db_path;
    std::optional<QString> source_path;
    QStringList config_warnings;
    QStringList paper_flag_missing;

    Settings();
    /// 这个账户实际生效的限额:全局的,再盖上 by_account 里给它写的那几项
    contract::Limits limitsFor(const QString& alias) const;
    const contract::AccountConfig* accountByAlias(const QString& alias) const;
    const contract::AccountConfig* defaultAccount() const;
    QStringList aliasList() const;
    contract::OrderedMap<contract::ConnectionConfig> connectionsFor(const QString& provider = {}) const;
    QString accountBroker(const contract::AccountConfig& account) const;
    QString promptAccountTable() const;
    QString promptSymbolTable() const;
    bool isTradingDay(const QString& dateStr) const;
    QString marketStatus(const EtNow& now) const;
    const contract::IndexConfig* indexConfig(const QString& symbol) const;
};

/// 原始配置(保序的 JSON)→ Settings;校验不过抛 JsError,话同 TS 版
Settings fromDict(const util::OJson& raw, const std::optional<QString>& source = std::nullopt);
Settings loadSettings(const QString& settingsPath = {});
QString configBackupPath(const QString& settingsPath);
/// 深合并一份补丁到配置文件:先在内存里验,验不过不落盘;落盘前把改动前那一份存成 .bak,再原子写
Settings patchConfigFile(const std::optional<QString>& settingsPath, const util::OJson& patch);
util::OJson deepMerge(const util::OJson& base, const util::OJson& patch);

}  // namespace ibkr::domain
