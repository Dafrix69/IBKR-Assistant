// ibLink.ts 的 LinkDownError:本机到 TWS 的连接断着时,下单 / 改单 / 撤单的回答。
// 只有一个类型,头文件独立:ib_session 抛它,以后的托管 / 追价 / 引擎那几处按类型认(TS 里是 `exc.name === "LinkDownError"`)。
//
// 为什么单独一个类:以前这三个调用在断线期间照样"成功"返回(Submitted),命令被库排进缓冲,重连后才一股脑发出、没有时效——
// 断线时调用方以为撤了的单其实没撤、以为改了价的单迟到几小时才改。现在断着就当场抛、不入队;调用方据此认出
// "这是链路断了、不是券商拒了",不往熔断上记。
#pragma once

#include "util/error.h"

#include <QString>

namespace ibkr::execution {

class LinkDownError : public util::JsError {
public:
    LinkDownError() : util::JsError(QStringLiteral("与 TWS 的连接已断开,正在自动重连")) {}
    /// TS 的 `exc.name`
    static const QString& name() {
        static const QString n = QStringLiteral("LinkDownError");
        return n;
    }
};

}  // namespace ibkr::execution
