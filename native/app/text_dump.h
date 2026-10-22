// 排版对照用:把窗口里看得见的每一段字(内容、在窗口里的位置与大小、字号字重、颜色)写成 JSON 数组,
// 和 React 版在浏览器里量出来的同一份(tools/text_dump.js)逐段对(tools/compare_texts.mjs)。只在 --dump-texts 时用。
#pragma once

#include <QString>

class QQuickWindow;

namespace ibkr::app {

void dumpTexts(QQuickWindow* window, const QString& path);

}  // namespace ibkr::app
