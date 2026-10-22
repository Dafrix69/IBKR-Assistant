#include "native_prompter.h"

#include <QMessageBox>
#include <QPushButton>

namespace ibkr::app {

void NativePrompter::ask(const shell::ConfirmBox& box, std::function<void(bool)> done) {
    auto* dialog = new QMessageBox(QMessageBox::Warning, box.title, box.message);
    dialog->setAttribute(Qt::WA_DeleteOnClose);
    dialog->setWindowModality(Qt::ApplicationModal);
    if (!box.detail.isEmpty()) dialog->setInformativeText(box.detail);
    QPushButton* cancel = dialog->addButton(QStringLiteral("取消"), QMessageBox::RejectRole);
    QPushButton* confirm = dialog->addButton(box.confirmLabel.isEmpty() ? QStringLiteral("确认") : box.confirmLabel, QMessageBox::AcceptRole);
    // 默认按钮与 Esc 都是「取消」:手一抖按了回车,不该发出一张单
    dialog->setDefaultButton(cancel);
    dialog->setEscapeButton(cancel);
    QObject::connect(dialog, &QMessageBox::finished, dialog, [dialog, confirm, done] { done(dialog->clickedButton() == confirm); });
    // 用 show(),不用 open():open() 会把模态改成 WindowModal,而这个框没有父窗口(主窗口是 QML 的,挂不上 QWidget),
    // 结果主窗口照样能点——再点一次「立即平仓」就是第二个框、第二张凭据、第二张平仓单。
    // ApplicationModal + show() 挡住整个应用,同 Electron 的 showMessageBox(mainWindow) 那张挡住窗口的 sheet
    dialog->show();
    dialog->raise();
    dialog->activateWindow();
}

}  // namespace ibkr::app
