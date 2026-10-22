#include "shell/keyed_list_model.h"

#include "shell/jsvalue.h"

#include <QSet>

namespace ibkr::shell {

namespace {
constexpr int kDataRole = Qt::UserRole + 1;
}

KeyedListModel::KeyedListModel(QString keyField, QObject* parent) : QAbstractListModel(parent), keyField_(std::move(keyField)) {}

int KeyedListModel::rowCount(const QModelIndex& parent) const { return parent.isValid() ? 0 : int(items_.size()); }

QVariant KeyedListModel::data(const QModelIndex& index, int role) const {
    if (!index.isValid() || index.row() >= items_.size() || role != kDataRole) return {};
    return items_.at(index.row()).toObject().toVariantMap();
}

QHash<int, QByteArray> KeyedListModel::roleNames() const { return {{kDataRole, QByteArrayLiteral("modelData")}}; }

QString KeyedListModel::keyOf(const QJsonValue& item) const { return jsString(item.toObject().value(keyField_)); }

void KeyedListModel::setItems(const QJsonArray& next) {
    const int before = int(items_.size());
    // 1. 新的一份里没有的键:删掉(从后往前,行号不乱)
    QSet<QString> nextKeys;
    for (const QJsonValue& v : next) nextKeys.insert(keyOf(v));
    for (int i = int(items_.size()) - 1; i >= 0; --i) {
        if (nextKeys.contains(keyOf(items_.at(i)))) continue;
        beginRemoveRows({}, i, i);
        items_.removeAt(i);
        endRemoveRows();
    }
    // 2. 按新的次序逐行对齐:同键在别处就挪过来,没有就插进来;到位之后数据不同才换
    for (int i = 0; i < next.size(); ++i) {
        const QString key = keyOf(next.at(i));
        int at = -1;
        for (int j = i; j < items_.size(); ++j) {
            if (keyOf(items_.at(j)) == key) {
                at = j;
                break;
            }
        }
        if (at < 0) {
            beginInsertRows({}, i, i);
            items_.insert(i, next.at(i));
            endInsertRows();
            continue;
        }
        if (at != i) {
            beginMoveRows({}, at, at, {}, i);
            const QJsonValue moved = items_.at(at);
            items_.removeAt(at);
            items_.insert(i, moved);
            endMoveRows();
        }
        if (items_.at(i) != next.at(i)) {
            items_[i] = next.at(i);
            emit dataChanged(index(i), index(i), {kDataRole});
        }
    }
    // 3. 同一个键出现过两次、新的一份里只剩一次:多出来的在尾巴上
    if (items_.size() > next.size()) {
        beginRemoveRows({}, int(next.size()), int(items_.size()) - 1);
        while (items_.size() > next.size()) items_.removeLast();
        endRemoveRows();
    }
    if (before != items_.size()) emit countChanged();
}

}  // namespace ibkr::shell
