// 提醒的提示音:用系统自带的提示音(macOS 的 /System/Library/Sounds),不自己合成——合成的三角波刺耳。
// 方向照旧分得出:上穿 / 急涨、下破 / 急跌、没有方向(放量)各一个音,不用看屏幕就知道往哪边走。
#pragma once

#include <QString>

namespace ibkr::shell::tone {

/// up / down / 其它(没有方向)对应的系统提示音名
QString soundFor(const QString& direction);

}  // namespace ibkr::shell::tone
