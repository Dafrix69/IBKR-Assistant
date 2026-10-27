// 界面(QML)到引擎的唯一一条路。照 desktop/main.js 的 rpc 与 confirm 两个通道搬,先后一步不差:
//
//   rpc:白名单 → 敏感方法要带 __confirmed(只说明调用是从这座桥上走的)→ 没同意条款的钱路径不放行
//        → 导出路径只认刚在保存对话框里选的那一个 → 转给引擎;会发单的那几种超时报「结果未知」,引擎迟到的回执另外补报
//   confirm:弹原生确认框。带 purpose 的(发单、立即平仓、授权自动平仓、切券商、放宽限额、打开跟单)不弹,直接当确认过
//
// 这里只用 Qt Core;QML 那一层的转接在 app/qml_bridge(把 JS 值换进换出)。
#pragma once

#include "shell/consent.h"
#include "shell/engine_client.h"

#include <QJsonObject>
#include <QObject>
#include <QPointer>

#include <functional>

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
    /// 弹确认框(main.js 的 confirm 通道)。options:title / message / detail / confirmLabel;带 purpose 的不弹、直接回确认
    void confirm(const QJsonObject& options, ConfirmDone done);
    void confirm(QObject* context, const QJsonObject& options, ConfirmDone done);
    /// 用户刚在保存对话框里选的导出路径:data.export 只认它,用一次作废
    void setPickedExportPath(const QString& path) { pickedExportPath_ = path; }

    /// 会发单的调用等多久算超时;0 = 引擎客户端的默认(120 秒,同 Electron 版)
    int outcomeTimeoutMs = 0;

signals:
    /// 会发单的调用超时之后引擎才回话:这次操作到底执行了没有
    void lateOutcome(const QString& what, bool ok, const QString& error, qint64 waitedMs);

private:
    void forward(const QString& method, const QJsonObject& clean, RpcDone done);

    EngineClient* engine_;
    Prompter* prompter_;
    ConsentStore* consent_;
    QString pickedExportPath_;
};

}  // namespace ibkr::shell
