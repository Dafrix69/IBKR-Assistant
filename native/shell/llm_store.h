// 大模型目录与当前配置(store/llm.ts):启动就读一次,引擎报 llm 事件时重读。交易指令页的就绪清单要知道 Key 配没配。
// 读不到时留着上一份,横幅说一句(同原版)。
#pragma once

#include <QJsonValue>
#include <QObject>

namespace ibkr::shell {

class Bridge;
class StatusStore;

class LlmStore : public QObject {
    Q_OBJECT
    /// 引擎的 llm.catalog;还没读到是 null
    Q_PROPERTY(QJsonValue catalog READ catalog NOTIFY changed)

public:
    LlmStore(Bridge* bridge, StatusStore* status, QObject* parent = nullptr);
    QJsonValue catalog() const { return catalog_; }
    Q_INVOKABLE void load();
    void onEngineEvent(const QString& event, const QJsonValue& data);

signals:
    void changed();

private:
    Bridge* bridge_;
    StatusStore* status_;
    QJsonValue catalog_;
};

}  // namespace ibkr::shell
