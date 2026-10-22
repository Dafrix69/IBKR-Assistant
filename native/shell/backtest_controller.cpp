#include "shell/backtest_controller.h"

#include "shell/bridge.h"
#include "shell/chart_source.h"
#include "shell/chart_spec.h"
#include "shell/jsvalue.h"
#include "shell/ordered_json.h"
#include "shell/status_store.h"

#include <QDateTime>
#include <QPointer>

namespace ibkr::shell {

using namespace Qt::StringLiterals;

namespace {

QJsonValue numberOrNull(const QVariant& v) {
    if (!v.isValid() || v.isNull()) return QJsonValue(QJsonValue::Null);
    bool ok = false;
    const double d = v.toDouble(&ok);
    return ok ? QJsonValue(d) : QJsonValue(QJsonValue::Null);
}

/// Date.prototype.toISOString().slice(0, 10):UTC 的日期
QString isoDate(double ms) { return QDateTime::fromMSecsSinceEpoch(qint64(ms), QTimeZone::UTC).toString(u"yyyy-MM-dd"_s); }

}  // namespace

BacktestController::BacktestController(Bridge* bridge, StatusStore* status, QObject* parent)
    : QObject(parent), bridge_(bridge), status_(status), chart_(new ChartSource(this)) {
    now = [] { return double(QDateTime::currentMSecsSinceEpoch()); };
    reset();
}

QObject* BacktestController::chart() const { return chart_; }

QJsonValue BacktestController::keyedResult(const EngineReply& r) {
    if (const auto o = parseOJson(QString::fromUtf8(r.raw)); o && o->isObject())
        if (const OJson* res = o->get(u"result"_s)) return res->toQJsonKeyed();
    return r.result;
}

void BacktestController::reset() {
    in_ = backtest::PageInput{};
    in_.start = isoDate(now() - 365 * 86400e3);
    in_.end = isoDate(now());
    in_.rules = backtest::defaultRules();
    chart_->setSpec({});
    rebuild();
}

void BacktestController::setVisible(bool on) {
    if (on == visible_) return;
    visible_ = on;
    ++generation_;
    reset();
    if (!on) return;
    const int gen = generation_;
    QPointer<BacktestController> self(this);
    bridge_->rpc(this, u"backtest.strategies"_s, QJsonObject{}, [self, gen](const EngineReply& r) {
        if (!self || gen != self->generation_) return;
        if (!r.ok) {
            if (self->status_) self->status_->showError(u"读取策略目录失败:"_s + r.error);
            return;
        }
        self->in_.strategies = keyedResult(r)[u"strategies"_s].toArray();
        if (!self->in_.strategies.isEmpty() && self->in_.strategyKey.isEmpty()) self->in_.strategyKey = self->in_.strategies.first()[u"key"_s].toString();
        // 原版的 effect 依赖是 strategy 这个对象:目录一读回来就照它摆一遍默认参数
        self->applyStrategyDefaults();
        self->rebuild();
    });
}

void BacktestController::applyStrategyDefaults() {
    for (const QJsonValue& s : std::as_const(in_.strategies)) {
        if (s[u"key"_s].toString() != in_.strategyKey) continue;
        if (in_.strategyKey == u"custom") return;
        in_.params = s[u"params"_s].toObject();
        in_.params.remove(u"__keys"_s);
        return;
    }
}

void BacktestController::setSymbol(const QString& text) {
    in_.symbol = text.left(12);
    rebuild();
}

void BacktestController::setRange(const QString& start, const QString& end) {
    if (start.isEmpty() || end.isEmpty()) return;
    in_.start = start;
    in_.end = end;
    rebuild();
}

void BacktestController::setStrategy(const QString& key) {
    if (key == in_.strategyKey) return;
    // 离开自定义:原版的条件搭建器卸载,一句话的输入框与「生成中」跟着没了(在途的那一次回来照样把条件写进去,同原版的 onChange)
    if (in_.strategyKey == u"custom" && key != u"custom") {
        in_.ruleText.clear();
        in_.generating = false;
    }
    in_.strategyKey = key;
    applyStrategyDefaults();
    rebuild();
}

void BacktestController::setParam(const QString& key, const QVariant& value) {
    in_.params.insert(key, numberOrNull(value));
    rebuild();
}

void BacktestController::setInstType(const QString& type) {
    in_.instType = type;
    rebuild();
}

void BacktestController::setInst(const QString& key, const QVariant& value) {
    in_.inst.insert(key, numberOrNull(value));
    rebuild();
}

void BacktestController::setCost(const QVariant& value) {
    in_.cost = numberOrNull(value);
    rebuild();
}

void BacktestController::run() {
    if (in_.running) return;
    const QString sym = jsTrim(in_.symbol).toUpper();
    if (sym.isEmpty() || in_.start.isEmpty() || in_.end.isEmpty()) {
        if (status_) status_->showInfo(u"请填写标的与起止日期"_s);
        return;
    }
    in_.running = true;
    in_.failure.clear();
    rebuild();
    const int gen = generation_;
    QPointer<BacktestController> self(this);
    bridge_->rpc(this, u"backtest.run"_s, backtest::runSpec(in_), [self, gen](const EngineReply& r) {
        if (!self || gen != self->generation_) return;
        if (r.ok) {
            self->in_.result = keyedResult(r);
        } else {
            self->in_.result = QJsonValue::Null;
            self->in_.failure = r.error;
        }
        self->in_.running = false;
        const QJsonValue spec = backtest::equityChart(self->in_.result);
        self->chart_->setSpec(spec.isObject() ? chart::specFromJson(spec.toObject()) : chart::Spec{});
        self->rebuild();
    });
}

// ---- 条件搭建器 ------------------------------------------------------------------------------------

void BacktestController::setRuleText(const QString& text) {
    in_.ruleText = text.left(1000);
    rebuild();
}

void BacktestController::generateRules() {
    const QString t = jsTrim(in_.ruleText);
    if (t.isEmpty() || in_.generating) return;
    in_.generating = true;
    rebuild();
    const int gen = generation_;
    QPointer<BacktestController> self(this);
    bridge_->rpc(this, u"backtest.parse_rules"_s, QJsonObject{{u"text"_s, t}}, [self, gen](const EngineReply& r) {
        if (!self || gen != self->generation_) return;
        if (r.ok) {
            self->in_.rules = r.result[u"rules"_s].toObject();
        } else if (self->status_) {
            // errorWithPrefix:报错本身已经带着这句开头就不再加
            const QString prefix = u"条件生成失败:"_s;
            self->status_->showError(r.error.startsWith(prefix) ? r.error : prefix + r.error);
        }
        self->in_.generating = false;
        self->rebuild();
    });
}

QJsonObject BacktestController::condition(const QString& section, int index) const {
    return in_.rules.value(section).toArray().at(index).toObject();
}

void BacktestController::setCondition(const QString& section, int index, const QJsonObject& cond) {
    QJsonArray list = in_.rules.value(section).toArray();
    if (index < 0 || index >= list.size()) return;
    list[index] = cond;
    in_.rules.insert(section, list);
    rebuild();
}

void BacktestController::pickOperand(const QString& section, int index, const QString& side, const QString& choice) {
    QJsonObject c = condition(section, index);
    if (c.isEmpty()) return;
    c.insert(side, backtest::pickOperand(c.value(side).toObject(), choice));
    setCondition(section, index, c);
}

void BacktestController::setOperandNumber(const QString& section, int index, const QString& side, const QVariant& value) {
    QJsonObject c = condition(section, index);
    if (c.isEmpty()) return;
    QJsonObject o = c.value(side).toObject();
    // 清空了是 undefined:那个键不出现(原版 { ...operand, value: undefined } 序列化时丢掉)
    const QString key = o.value(u"kind"_s).toString() == u"const" ? u"value"_s : u"period"_s;
    const QJsonValue n = numberOrNull(value);
    if (n.isNull()) o.remove(key);
    else o.insert(key, n);
    c.insert(side, o);
    setCondition(section, index, c);
}

void BacktestController::setOp(const QString& section, int index, const QString& op) {
    QJsonObject c = condition(section, index);
    if (c.isEmpty()) return;
    c.insert(u"op"_s, op);
    setCondition(section, index, c);
}

void BacktestController::removeCondition(const QString& section, int index) {
    QJsonArray list = in_.rules.value(section).toArray();
    if (index < 0 || index >= list.size()) return;
    list.removeAt(index);
    in_.rules.insert(section, list);
    rebuild();
}

void BacktestController::addCondition(const QString& section) {
    QJsonArray list = in_.rules.value(section).toArray();
    list.append(QJsonObject{{u"left"_s, QJsonObject{{u"kind"_s, u"indicator"_s}, {u"name"_s, u"close"_s}}}, {u"op"_s, u">"_s},
                            {u"right"_s, QJsonObject{{u"kind"_s, u"indicator"_s}, {u"name"_s, u"sma"_s}, {u"period"_s, 50}}}});
    in_.rules.insert(section, list);
    rebuild();
}

// ---- 参数扫描 ------------------------------------------------------------------------------------

void BacktestController::setSweepExtra(const QString& text) {
    in_.swExtra = text;
    rebuild();
}

void BacktestController::setSweepGrid(const QString& key, const QString& text) {
    in_.swGrid.insert(key, text);
    rebuild();
}

void BacktestController::setSweepSplit(const QVariant& value) {
    in_.swSplit = numberOrNull(value);
    rebuild();
}

void BacktestController::setSweepFolds(const QVariant& value) {
    in_.swFolds = numberOrNull(value);
    rebuild();
}

void BacktestController::setSweepObjective(const QString& objective) {
    in_.swObjective = objective;
    rebuild();
}

void BacktestController::setSweepPage(int page) {
    in_.swPage = std::max(1, page);
    rebuild();
}

void BacktestController::runSweep() {
    // 没选可扫的策略、没填标的:按钮本来就点不动
    if (in_.swRunning || !page_.value("sweep"_L1)[u"sweepable"_s].toBool() || jsTrim(in_.symbol).isEmpty()) return;
    in_.swRunning = true;
    in_.swFailure.clear();
    rebuild();
    const int gen = generation_;
    QPointer<BacktestController> self(this);
    bridge_->rpc(this, u"backtest.sweep"_s, backtest::sweepSpec(in_), [self, gen](const EngineReply& r) {
        if (!self || gen != self->generation_) return;
        if (r.ok) {
            self->in_.swResult = keyedResult(r);
        } else {
            self->in_.swResult = QJsonValue::Null;
            self->in_.swFailure = r.error;
        }
        self->in_.swRunning = false;
        self->rebuild();
    });
}

void BacktestController::rebuild() {
    // 页码:新结果短了只在显示时夹到最后一页,记着的那一页不动——再来一份长的又回到原来那页(同 AntD 的 usePagination)
    page_ = backtest::pageModel(in_);
    emit pageChanged();
}

}  // namespace ibkr::shell
