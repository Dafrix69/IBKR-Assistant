// 一张图的 spec(lib/Chart.tsx 的 spec 属性):页面的 controller 持有一个、算好 spec 往里放,界面的 ChartView 读它。
// spec 一变就发 changed;同一个 viewKey 的刷新,图会留住用户缩放 / 平移到的位置(shell/chart_spec 的 keepViewport)
#pragma once

#include "shell/chart_spec.h"

#include <QObject>

namespace ibkr::shell {

class ChartSource : public QObject {
    Q_OBJECT
public:
    using QObject::QObject;
    const chart::Spec& spec() const { return spec_; }
    void setSpec(chart::Spec spec) {
        spec_ = std::move(spec);
        emit changed();
    }

signals:
    void changed();

private:
    chart::Spec spec_;
};

}  // namespace ibkr::shell
