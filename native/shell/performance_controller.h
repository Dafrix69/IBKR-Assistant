// 「绩效体检」一页的接线(pages/Performance.tsx、lib/PerformanceExtras.tsx 的 AdviceSection、lib/PositionSizer.tsx、lib/SignalScorecard.tsx):
//   · 原版状态都在组件里(切走就卸载):setVisible(false) 清空;范围 / 品种 / 天数记在本机(perf/scope、perf/kind、perf/days),回来照读;
//   · 进页、换范围 / 品种 / 天数、点「重新计算」都读一次 review.performance({ scope, kind, days? });读着时上一次的结果留着;
//     几次在途时谁后回来谁算数,loading 在任何一次回来时落下(同原版 useCallback + finally,不加新旧判断);
//   · 按建议填入:先弹确认框(只挡新单、永远不挡平仓),点了才 settings.patch,只带那一条规则;成了横幅 + 刷新状态 + 重新计算,失败横幅说设置未改动;
//   · 仓位计算器:权益与比例记在本机(sizer/equity、sizer/pct;不是正数就当没填,比例兜底 1),每份最大亏损的起手值是账本里蝶的每份风险中位数,
//     这个中位数一变就回到它(原版 key={typicalUnitRisk} 重挂);
//   · 信号成绩单:点了才算(review.signals({ days? }),要连 TWS 取日线),换天数不清上一次的成绩单。
// 不下单:这一页只碰 review.performance / review.signals,以及经确认框的 settings.patch(保护规则只会收紧)。模型在 shell/performance_rules
#pragma once

#include "shell/performance_rules.h"

#include <QObject>
#include <QVariant>

#include <functional>

namespace ibkr::shell {

class Bridge;
class ChartSource;
class StatusStore;

class PerformanceController : public QObject {
    Q_OBJECT
    Q_PROPERTY(QJsonObject page READ page NOTIFY pageChanged)
    Q_PROPERTY(QObject* equityChart READ equityChart CONSTANT)

public:
    PerformanceController(Bridge* bridge, StatusStore* status, QString settingsPath, QObject* parent = nullptr);

    QJsonObject page() const { return page_; }
    QObject* equityChart() const;
    /// 分享卡片要的原始结果(画在 QML 里)
    Q_INVOKABLE QJsonValue data() const { return in_.data; }
    Q_INVOKABLE QString cardSubtitle() const;
    Q_INVOKABLE QString cardFootnote() const;

    Q_INVOKABLE void setVisible(bool on);
    Q_INVOKABLE void setScope(const QString& scope);
    Q_INVOKABLE void setKind(const QString& kind);
    Q_INVOKABLE void setDays(int days);
    /// 「重新计算」
    Q_INVOKABLE void reload();
    /// 「按建议填入」(rule:daily_loss / stoploss_guard / cooldown)
    Q_INVOKABLE void applyAdvice(const QString& rule);
    /// 「给信号打分」/「重新打分」
    Q_INVOKABLE void scoreSignals();
    Q_INVOKABLE void setSizerEquity(const QVariant& v);
    Q_INVOKABLE void setSizerPct(const QVariant& v);
    Q_INVOKABLE void setSizerUnit(const QVariant& v);
    Q_INVOKABLE void setLedgerPage(int page);
    Q_INVOKABLE void setExecPage(int page);

    /// 分享卡片的「拷贝图片」/「存为 PNG」(main.js 的 image-export):只收 data:image/png;base64,、不超过 12 MB;
    /// 存的路径由保存对话框定(界面递不进路径)。回 { ok } / { ok, path } / { ok: false, canceled } / { ok: false, error },成败另弹一句提示
    Q_INVOKABLE QJsonObject exportImage(const QString& action, const QString& dataUrl, const QString& name);
    /// 分享卡片抓成图之后写到哪(壳定的临时文件;界面只能往这一个地方写)
    Q_INVOKABLE QString cardImagePath() const;
    /// 同 exportImage,图从 cardImagePath() 读(读完删掉);卡片的字是 Text 层、整张 grabToImage,拿不到 data URL
    Q_INVOKABLE QJsonObject exportCard(const QString& action, const QString& name);

    std::function<double()> now;
    QTimeZone zone = QTimeZone::systemTimeZone();
    /// 保存对话框:(标题, 默认路径, 过滤) → 选的路径,取消是空。壳给(QFileDialog);测试换成假的
    std::function<QString(const QString& title, const QString& defaultPath, const QString& filter)> pickSavePath;
    /// 把 PNG 放进剪贴板(path 空)或写到 path;回错误的一句,成了是空。壳给(QImage + QClipboard);测试换成假的
    std::function<QString(const QByteArray& png, const QString& path)> imageWriter;
    /// 「下载」目录(保存对话框的起点)
    std::function<QString()> downloadsDir;

signals:
    void pageChanged();

private:
    QJsonObject exportPng(const QString& action, const QByteArray& png, const QString& name);
    void reset();
    void rebuild();
    void load();
    QString read(const QString& key) const;
    void write(const QString& key, const QVariant& value) const;

    Bridge* bridge_;
    StatusStore* status_;
    ChartSource* equityChart_;
    QString settingsPath_;
    bool visible_ = false;
    int generation_ = 0;
    performance::PageInput in_;
    QJsonObject page_;
};

}  // namespace ibkr::shell
