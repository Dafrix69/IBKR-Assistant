// TS 的 Record<string, T> / 普通对象:按插键的先后遍历(Object.entries / Object.keys 的次序就是它)。
// QMap / QHash 都不保这个次序,引擎里凡是"按配置里写的先后"做事的地方(账户、连接、别名)都用这个。
// 注意:JS 对象里长得像数组下标的键("1"、"20")会排到最前、按数值排——引擎的键都不是这种,这里不模拟。
#pragma once

#include <QHash>
#include <QStringList>

namespace ibkr::contract {

template <class T>
class OrderedMap {
public:
    bool contains(const QString& key) const { return values_.contains(key); }
    const T* find(const QString& key) const {
        auto it = values_.constFind(key);
        return it == values_.cend() ? nullptr : &it.value();
    }
    T* find(const QString& key) {
        auto it = values_.find(key);
        return it == values_.end() ? nullptr : &it.value();
    }
    T value(const QString& key, const T& fallback = T()) const { return values_.value(key, fallback); }
    /// 新键排在最后;已有的键换值、位置不动(同 JS 赋值)
    void insert(const QString& key, const T& value) {
        if (!values_.contains(key)) keys_.append(key);
        values_.insert(key, value);
    }
    void remove(const QString& key) {
        if (values_.remove(key)) keys_.removeOne(key);
    }
    const QStringList& keys() const { return keys_; }
    qsizetype size() const { return keys_.size(); }
    bool isEmpty() const { return keys_.isEmpty(); }
    bool operator==(const OrderedMap& o) const { return keys_ == o.keys_ && values_ == o.values_; }

private:
    QStringList keys_;
    QHash<QString, T> values_;
};

}  // namespace ibkr::contract
