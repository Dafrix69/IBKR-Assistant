// 「回测」一页的接线(pages/Backtest.tsx、lib/RuleBuilder.tsx、lib/SweepPanel.tsx 里的状态与取数):
//   · 原版状态都在组件里(切走就卸载):setVisible(false) 清空,回来是新挂上的样子;进页读一次策略目录,没选过就选第一个;
//   · 换策略带出它的默认参数(自定义不动);区间默认近一年(起止按 UTC 的日期,同 toISOString);
//   · 跑一次:标的或起止空着就提示、不发;跑着时按钮转圈、点不动;失败把上一次的结果清掉;
//   · 条件搭建器:一句话 → 条件(backtest.parse_rules),报错同 errorWithPrefix;下拉换算子照 OperandEditor 的 pick;
//   · 扫参数:同一组标的、区间、品种与成本;结果表 10 行一页(换了结果页码不复位;短了只在显示时夹到最后一页,同 AntD 的 Table)。
// 引擎回来的对象按原文的键序读(策略参数的次序、参数组合的写法要照 Object.keys)。不下单:这一页只碰 backtest.*。模型在 shell/backtest_rules
#pragma once

#include "shell/backtest_rules.h"

#include <QJsonObject>
#include <QObject>
#include <QVariant>

#include <functional>

namespace ibkr::shell {

class Bridge;
class ChartSource;
class StatusStore;
struct EngineReply;

class BacktestController : public QObject {
    Q_OBJECT
    Q_PROPERTY(QJsonObject page READ page NOTIFY pageChanged)
    Q_PROPERTY(QObject* chart READ chart CONSTANT)

public:
    BacktestController(Bridge* bridge, StatusStore* status, QObject* parent = nullptr);

    QJsonObject page() const { return page_; }
    QObject* chart() const;

    Q_INVOKABLE void setVisible(bool on);
    // ---- 表单
    Q_INVOKABLE void setSymbol(const QString& text);
    Q_INVOKABLE void setRange(const QString& start, const QString& end);
    Q_INVOKABLE void setStrategy(const QString& key);
    Q_INVOKABLE void setParam(const QString& key, const QVariant& value);
    Q_INVOKABLE void setInstType(const QString& type);
    /// 期权的四项之一:dte / offset / width / risk
    Q_INVOKABLE void setInst(const QString& key, const QVariant& value);
    Q_INVOKABLE void setCost(const QVariant& value);
    Q_INVOKABLE void run();
    // ---- 条件搭建器(section:entry / exit;side:left / right)
    Q_INVOKABLE void setRuleText(const QString& text);
    Q_INVOKABLE void generateRules();
    Q_INVOKABLE void pickOperand(const QString& section, int index, const QString& side, const QString& choice);
    Q_INVOKABLE void setOperandNumber(const QString& section, int index, const QString& side, const QVariant& value);
    Q_INVOKABLE void setOp(const QString& section, int index, const QString& op);
    Q_INVOKABLE void removeCondition(const QString& section, int index);
    Q_INVOKABLE void addCondition(const QString& section);
    // ---- 参数扫描
    Q_INVOKABLE void setSweepExtra(const QString& text);
    Q_INVOKABLE void setSweepGrid(const QString& key, const QString& text);
    Q_INVOKABLE void setSweepSplit(const QVariant& value);
    Q_INVOKABLE void setSweepFolds(const QVariant& value);
    Q_INVOKABLE void setSweepObjective(const QString& objective);
    Q_INVOKABLE void runSweep();
    Q_INVOKABLE void setSweepPage(int page);

    /// 「今天」(毫秒);测试固定它
    std::function<double()> now;

signals:
    void pageChanged();

private:
    void reset();
    void rebuild();
    void applyStrategyDefaults();
    QJsonObject condition(const QString& section, int index) const;
    void setCondition(const QString& section, int index, const QJsonObject& cond);
    /// 回包按原文的键序读出来的 result(读不出就退回 QJsonValue 那一份)
    static QJsonValue keyedResult(const EngineReply& r);

    Bridge* bridge_;
    StatusStore* status_;
    ChartSource* chart_;
    bool visible_ = false;
    int generation_ = 0;
    backtest::PageInput in_;
    QJsonObject page_;
};

}  // namespace ibkr::shell
