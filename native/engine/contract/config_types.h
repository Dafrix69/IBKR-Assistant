// 配置里除了 contract/settings.h 那几段之外的形状(engine-ts/src/config.ts 与 contract/llm.ts、contract/follow.ts 的 interface)。
#pragma once

#include "contract/ordered_map.h"

#include <QJsonValue>
#include <QString>
#include <QStringList>

namespace ibkr::contract {

struct AccountConfig {
    QString alias;
    QString account_id;
    bool is_paper = false;
    QString connection;
    bool isDefault = false;  // TS 的 default
};

struct ConnectionConfig {
    QString name;
    QString host;
    double port = 0;
    double client_id = 0;
    bool readonly = false;
    QString broker;
};

struct FutuConfig {
    QString trd_market;
    QString security_firm;
    QString keychain_service;
    QString keychain_account;
    OrderedMap<QString> symbol_map;
};

struct BrokerConfig {
    QString provider;
    FutuConfig futu;
    bool auto_connect = true;
};

struct IndexConfig {
    QString symbol;
    QString exchange;
    QString daily_trading_class;
    QString monthly_trading_class;
    QString futures;
    QString futures_exchange;
};

struct LLMConfig {
    QString provider;
    QString model;
    QString effort;
    QJsonValue temperature = QJsonValue::Null;  // null = 不设
    QString base_url;
    double max_tokens = 0;
    double timeout_s = 0;
    QString keychain_service;
    QString keychain_account;
};

struct FollowConfig {
    bool enabled = false;
    QString channel_id;
    QStringList author_ids;
    QStringList accounts;
    double max_age_seconds = 0;
    double max_orders_per_day = 0;
    double max_risk_usd = 0;
    bool local_inbox = false;
    QString local_channel;
    bool track_fly = false;
    QString track_exit_at;
};

}  // namespace ibkr::contract
