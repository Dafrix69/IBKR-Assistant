// 「新建追踪」按下「开始追踪」之后的那一串(desktop/renderer-react/src/lib/TrackForm.tsx 的 start(),逐句搬):
//   拼 tracker.add 的载荷 → 界面这头先查出来的毛病 → 托管必须先开自动平仓 → 有标的目标价且要发单时,同意的那一刻现取一次价
//   (算不出、是模型默认波动率、带警告都不往下走)→ 确认框(凭据绑的就是这份载荷)→ 建追踪 → 重读。
// 这是钱路径:载荷的键与原版一字不差(undefined 的不带,数是字符串,'' = 不设),确认框的话也一字不差。
// 期望值:tests/fixtures/gen_track_form.mjs 把原文件里的 start() 切出来跑,记下每一步,并用引擎的 zod schema 校验载荷。
// 和引擎、确认框、横幅打交道的几样由调用方注入(app 里接 Bridge,测试里换成按场景回话的假货)。
#pragma once

#include "shell/track_rules.h"

#include <QJsonObject>
#include <QString>

#include <functional>
#include <optional>

namespace ibkr::shell::track {

struct FormState {
    /// 这份持仓(positions.list 的一行):key、symbol、sec_type、quantity、account
    QJsonObject position;
    /// 全局「自动执行」开着没有(status.auto_execute):到价自动平仓的默认值跟它
    bool autoExecute = false;
    /// 人拨过「到价自动平仓」就以人拨的为准
    std::optional<bool> autoPicked;
    std::optional<double> tp, sl, trail, profitDd;
    /// 利润回撤的起算门槛,默认 10;清空 = 不设
    std::optional<double> ddArm = 10;
    bool tiers = false;
    std::optional<double> spotTarget, stopBelow, stopAbove, fraction, chaseMax;
    /// 不给 = 原版的初值:组合限价,别的市价
    std::optional<QString> orderType;
    bool host = false;
    bool brokerSpotStop = false;
    std::optional<double> spotStopLimit;
    ExitFields exits;
    /// 界面交上来的值里读不成数的那几项(见 formNumber);有就不往下走
    QStringList invalid;

    /// 界面那一份 JSON(键同 React 版表单的各个 state):没给的照原版的初值(useState(...));数字走 formNumber,
    /// 读不成的进 invalid;开关与平仓方式类型不对也进 invalid
    static FormState fromJson(const QJsonObject& position, bool autoExecute, const QJsonObject& values);
    QString orderTypeOrDefault() const;
    bool isCombo() const;
    bool derivative() const;
    bool autoClose() const;
    bool hasSpotTarget() const;
    /// 组合有标的目标价或明确选择标的条件止损才能托管(引擎 checkTargets 同一条规矩)
    bool hostAllowed() const;
    bool hostOn() const;
};

/// tracker.add 的载荷
QJsonObject buildSpec(const FormState& s);

struct FormDeps {
    /// tracker.target_preview;done(result, error) —— error 非空就是报错了
    std::function<void(const QString& key, double target, std::optional<double> chaseMax, std::function<void(const QJsonValue&, const QString&)>)> preview;
    /// 确认框(purpose = tracker.add、binding = 载荷);done(点了确认没有)
    std::function<void(const QJsonObject& options, std::function<void(bool)>)> confirm;
    /// tracker.add
    std::function<void(const QJsonObject& spec, std::function<void(const QJsonValue&, const QString&)>)> add;
    std::function<void(const QString& text, bool info)> banner;
    std::function<void(bool on)> saving;
    /// 重读追踪与持仓,读完再调 done
    std::function<void(std::function<void()> done)> reload;
    /// 建好了:新追踪的 id(回执里没有是 null)
    std::function<void(const QJsonValue& id)> created;
};

/// 按下「开始追踪」
void startTrack(const FormState& s, const FormDeps& deps);

// ---------------------------------------------------------------- 表单上摆的字
/// 表单顶上那一排关键价位(lib/TrackKeyLevels.tsx 的 TrackLevelPicker):
/// null(没有现价时不摆)| { pending: { text, button, create?, watchId?, computing } }
/// | { title, summary, strip: { levels, spot }, stopLabel, targetLabel, stopChips: [{ label, price, side, tip }], targetChips, hint }
QJsonValue levelPickerModel(const QJsonObject& position, const QJsonArray& watches, const QStringList& busy);
/// 试算回来了:{ priced: 那一份 | null, error: 原因 | null }(价算不出时原因用引擎给的,没有就一句默认的)
QJsonObject previewOutcome(const QJsonValue& result, const QString& error);
/// 标的目标价试算那一块(priced 是 previewOutcome 的 priced):[{ text, cls }],cls = strong / up / down / hint / warn;
/// priced 是空时是一行「正在试算」或出错的原因
QJsonArray previewLines(const QJsonObject& position, double target, const QJsonValue& priced, const QString& error);

}  // namespace ibkr::shell::track
