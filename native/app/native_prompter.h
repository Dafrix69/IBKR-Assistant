// 确认框:系统原生的对话框(QMessageBox,macOS 上是 NSAlert 的样子),由界面进程自己弹,不经页面。
// 同 main.js 的 dialog.showMessageBox:警告图标、两个按钮「取消」与确认的那个,默认按钮与 Esc 都是「取消」。
#pragma once

#include "shell/bridge.h"

namespace ibkr::app {

class NativePrompter : public shell::Prompter {
public:
    void ask(const shell::ConfirmBox& box, std::function<void(bool)> done) override;
};

}  // namespace ibkr::app
