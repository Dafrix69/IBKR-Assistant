// 界面(QML)到引擎的唯一一条路。照 desktop/main.js 的 rpc 与 confirm 两个通道搬,先后一步不差:
//
//   rpc:白名单 → 敏感方法要带 __confirmed(只说明调用是从这座桥上走的,**不等于用户确认过**)→ 没同意条款的钱路径不放行
//        → 要凭据的调用核销确认凭据(差一张整个拒,不白烧已有的)→ 导出路径只认刚在保存对话框里选的那一个
//        → 转给引擎;会发单的那几种超时报「结果未知」,引擎迟到的回执另外补报
//   confirm:由这里(不是页面)弹原生确认框。框上最显眼的那一行按用途写;发单的连"发的是哪句话、发到哪些账户、纸面还是实盘"
//        也由这里写——账户类别问引擎,不听页面的。用户点了确认,才按**摆给人看的那一份**内容发一张一次性凭据。
//
// Electron 版里确认框防的是"界面里跑进一段别人的脚本"(依赖被投毒)。Qt 版没有网页内容,对应的不变式是:
// 敏感方法只能经这座桥到引擎,桥自己弹框、自己发凭据。凭据的口径与 Electron 版一模一样,不加也不减。
// 这里只用 Qt Core;QML 那一层的转接在 app/qml_bridge(把 JS 值换进换出)。
#pragma once

#include "shell/confirm_grants.h"
#include "shell/consent.h"
#include "shell/engine_client.h"

#include <QJsonObject>
#include <QObject>
#include <QPointer>

#include <functional>
#include <optional>

namespace ibkr::shell {

/// 确认框上的字:全部由 Bridge 定
struct ConfirmBox {
    QString title;
    QString message;
    QString detail;
    QString confirmLabel;
};

/// 谁来弹框。界面里是原生的对话框(app/native_prompter);测试里是假的,记下框上的字、按预设回答
class Prompter {
public:
    virtual ~Prompter() = default;
    /// 默认按钮是「取消」;用户点了确认才 done(true)
    virtual void ask(const ConfirmBox& box, std::function<void(bool confirmed)> done) = 0;
};

class Bridge : public QObject {
    Q_OBJECT
public:
    Bridge(EngineClient* engine, Prompter* prompter, ConsentStore* consent, QObject* parent = nullptr);

    using RpcDone = std::function<void(const EngineReply& reply)>;
    using ConfirmDone = std::function<void(bool confirmed, const QString& error)>;

    /// 调一个引擎方法(main.js 的 rpc 通道)
    void rpc(const QString& method, const QJsonValue& params, RpcDone done);
    /// 同上,但 context 不在了就不回:各个 store 先于引擎析构时,迟到的回包(引擎停下时把在途的一并回绝)不能打到已经没了的对象上
    void rpc(QObject* context, const QString& method, const QJsonValue& params, RpcDone done);
    /// 弹确认框(main.js 的 confirm 通道)。options:title / message / detail / confirmLabel / purpose / binding
    void confirm(const QJsonObject& options, ConfirmDone done);
    void confirm(QObject* context, const QJsonObject& options, ConfirmDone done);
    /// 用户刚在保存对话框里选的导出路径:data.export 只认它,用一次作废
    void setPickedExportPath(const QString& path) { pickedExportPath_ = path; }

    /// 现在几点(测试换成假的,量凭据的一分钟过期)
    std::function<qint64()> now;
    /// 会发单的调用等多久算超时;0 = 引擎客户端的默认(120 秒,同 Electron 版)
    int outcomeTimeoutMs = 0;

signals:
    /// 会发单的调用超时之后引擎才回话:这次操作到底执行了没有
    void lateOutcome(const QString& what, bool ok, const QString& error, qint64 waitedMs);

private:
    struct BoundBox {
        bool show = false;
        ConfirmBox box;
        QJsonObject binding;
    };
    void boundConfirmText(const QString& purpose, const QJsonObject& binding, const QJsonValue& message, const QJsonValue& detail,
                          std::function<void(std::optional<BoundBox> box, const QString& error)> done);
    void forward(const QString& method, const QJsonObject& clean, RpcDone done);

    EngineClient* engine_;
    Prompter* prompter_;
    ConsentStore* consent_;
    GrantBook grants_;
    QString pickedExportPath_;
};

}  // namespace ibkr::shell
