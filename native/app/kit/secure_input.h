// 密码框的安全键盘输入(Dafri.Kit 的 SecureInput 单例):浏览器里 type="password" 的框获得焦点时,macOS 打开 Secure Event Input,
// 别的程序(键盘记录、辅助功能类工具)读不到按键。Qt 的 TextInput 用 Password 模式只藏字、禁复制,不开这个(qcocoa 插件不调它),
// 所以这里自己开:框拿到焦点 enable 一次、失去焦点 disable 一次。系统按调用次数配对计数,这里也记着自己开了几次,
// 应用退出前没关上的在析构里补关(一直开着会让别的程序的输入法、快捷键失灵)。macOS 以外什么都不做。
#pragma once

#include <QObject>
#include <QtQml/qqmlregistration.h>

namespace ibkr::kit {

class SecureInput : public QObject {
    Q_OBJECT
    QML_ELEMENT
    QML_SINGLETON
public:
    using QObject::QObject;
    ~SecureInput() override;
    /// 密码框的焦点变了:on = 拿到焦点
    Q_INVOKABLE void focus(bool on);
    /// 此刻自己开着几次(测试用)
    int depth() const { return depth_; }

private:
    int depth_ = 0;
};

}  // namespace ibkr::kit
