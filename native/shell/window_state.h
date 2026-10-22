// 窗口的位置与大小(main.js 的 loadWindowBounds / saveWindowBounds):下次打开回到上次的地方。
// 记在 userData/window-state.json,与 Electron 版同一份(哪一版里挪过窗口,另一版也认)。
// 显示器可能拔掉了、分辨率可能变了:记下的位置已经不在任何一块屏上,就退回默认居中——不然窗口开在屏幕外面找不回来。
#pragma once

#include <QList>
#include <QRect>
#include <QString>

#include <optional>

namespace ibkr::shell {

struct WindowState {
    QRect bounds;
    bool maximized = false;
};

/// 读出来、并且至少有一截落在某块屏的工作区里才返回(条件同 main.js:左右各留 80、上 20、下 60)
std::optional<WindowState> loadWindowState(const QString& path, const QList<QRect>& workAreas);
/// bounds 是还原后的那一个框(最大化、全屏时也是);写不进去就算了
void saveWindowState(const QString& path, const WindowState& state);

}  // namespace ibkr::shell
