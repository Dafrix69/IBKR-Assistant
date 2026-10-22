// 按键原地更新的列表模型:QML 的 Repeater 拿它当 model,每一项的 modelData 是一个对象。
//
// 为什么不直接给 Repeater 一个 JS 数组:数组一换(哪怕只有一个数变了),Repeater 把所有 delegate 销毁重建——
// 持仓每秒刷一次现价,卡片里展开着的「新建追踪」表单就每秒回到初值,填好的止损在点「开始追踪」前的那一瞬被清掉。
// 这里按键比对:同一个键的那一行只换数据(delegate 不动,required property modelData 跟着变),新来的插进去、没了的删掉、次序变了挪过去。
#pragma once

#include <QAbstractListModel>
#include <QJsonArray>
#include <QJsonObject>

namespace ibkr::shell {

class KeyedListModel : public QAbstractListModel {
    Q_OBJECT
    Q_PROPERTY(int count READ count NOTIFY countChanged)

public:
    /// keyField:每一项里当键的那个字段(字符串或数)
    explicit KeyedListModel(QString keyField, QObject* parent = nullptr);

    int rowCount(const QModelIndex& parent = {}) const override;
    QVariant data(const QModelIndex& index, int role) const override;
    QHash<int, QByteArray> roleNames() const override;

    int count() const { return int(items_.size()); }
    /// 换成这一份:按键比对,同键只改数据
    void setItems(const QJsonArray& items);
    QJsonArray items() const { return items_; }

signals:
    void countChanged();

private:
    QString keyOf(const QJsonValue& item) const;

    QString keyField_;
    QJsonArray items_;
};

}  // namespace ibkr::shell
