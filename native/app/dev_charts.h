// 开发与截图对比用(--open chart:<n>):把 tests/fixtures/chart_scale_cases.json 的第 n 个场景放进一张图,
// 和浏览器里量的 React 版(tools/chart_harness.mjs)同一份 spec、同一个尺寸。不读不写用户的任何东西
#pragma once

#include "shell/chart_source.h"

#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QObject>
#include <QVariantMap>

namespace ibkr::app {

class DevCharts : public QObject {
    Q_OBJECT
    Q_PROPERTY(QObject* source READ source CONSTANT)
public:
    DevCharts(QString casesPath, QObject* parent = nullptr) : QObject(parent), path_(std::move(casesPath)) {}
    QObject* source() { return &source_; }
    /// 第 n 个场景:{ name, w, h };读不到是空
    Q_INVOKABLE QVariantMap load(int n) {
        QFile f(path_);
        if (!f.open(QIODevice::ReadOnly)) return {};
        const QJsonObject c = QJsonDocument::fromJson(f.readAll()).array().at(n).toObject();
        if (c.isEmpty()) return {};
        source_.setSpec(shell::chart::specFromJson(c.value(u"spec").toObject()));
        return {{QStringLiteral("name"), c.value(u"name").toString()}, {QStringLiteral("w"), c.value(u"w").toDouble()}, {QStringLiteral("h"), c.value(u"h").toDouble()}};
    }

private:
    QString path_;
    shell::ChartSource source_;
};

}  // namespace ibkr::app
