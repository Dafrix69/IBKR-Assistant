// 测试里比两份 JSON:数一律按 double 比(Qt 把 "42" 读成整数、把 42.0 存成浮点,值一样就算一样),
// 对象比键的集合,数组逐个比。不一样时说出第一处不一样的路径。
#pragma once

#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonValue>
#include <QString>

namespace ibkr::test {

inline QString compact(const QJsonValue& v) {
    if (v.isObject()) return QString::fromUtf8(QJsonDocument(v.toObject()).toJson(QJsonDocument::Compact));
    if (v.isArray()) return QString::fromUtf8(QJsonDocument(v.toArray()).toJson(QJsonDocument::Compact));
    return QString::fromUtf8(QJsonDocument(QJsonArray{v}).toJson(QJsonDocument::Compact));
}

/// 一样返回空串,不一样返回"路径:期望 … 实际 …"
inline QString jsonDiff(const QJsonValue& expected, const QJsonValue& actual, const QString& path = QStringLiteral("$")) {
    const auto say = [&] { return QStringLiteral("%1: 期望 %2,实际 %3").arg(path, compact(expected), compact(actual)); };
    if (expected.isDouble() && actual.isDouble()) return expected.toDouble() == actual.toDouble() ? QString() : say();
    if (expected.type() != actual.type()) return say();
    if (expected.isObject()) {
        const QJsonObject e = expected.toObject();
        const QJsonObject a = actual.toObject();
        if (e.keys() != a.keys()) return QStringLiteral("%1: 键不一样,期望 %2,实际 %3").arg(path, e.keys().join(u','), a.keys().join(u','));
        for (auto it = e.begin(); it != e.end(); ++it) {
            const QString d = jsonDiff(it.value(), a.value(it.key()), path + u'.' + it.key());
            if (!d.isEmpty()) return d;
        }
        return {};
    }
    if (expected.isArray()) {
        const QJsonArray e = expected.toArray();
        const QJsonArray a = actual.toArray();
        if (e.size() != a.size()) return say();
        for (qsizetype i = 0; i < e.size(); ++i) {
            const QString d = jsonDiff(e[i], a[i], QStringLiteral("%1[%2]").arg(path).arg(i));
            if (!d.isEmpty()) return d;
        }
        return {};
    }
    return expected == actual ? QString() : say();
}

}  // namespace ibkr::test
