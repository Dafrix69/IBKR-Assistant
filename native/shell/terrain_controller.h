#pragma once
#include "shell/bridge.h"
#include <QJsonArray>
namespace ibkr::shell {
class TerrainController : public QObject {
    Q_OBJECT
    Q_PROPERTY(QJsonObject model READ model NOTIFY changed)
public:
    explicit TerrainController(Bridge* bridge, QObject* parent = nullptr);
    QJsonObject model() const { return model_; }
    Q_INVOKABLE void refresh();
    Q_INVOKABLE void selectDate(const QString& date);
    Q_INVOKABLE void seek(double time);
    Q_INVOKABLE void step(int direction);
    // 测试替身也走同一个异步入口。
    std::function<void(const QJsonObject&, Bridge::RpcDone)> request;
signals:
    void changed();
private:
    void fetch(const QString& date);
    void rebuild();
    QJsonObject model_;
    QJsonArray dates_, records_;
    QString date_, error_;
    bool busy_ = false, demo_ = false;
    int generation_ = 0, rejected_ = 0;
    double cursor_ = 0, begin_ = 0, end_ = 0, low_ = 0, high_ = 1, scale_ = 1;
};
}
