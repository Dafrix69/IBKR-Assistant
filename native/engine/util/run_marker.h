// 「上一次是不是正常退出的」:进程起来时写一个 <名字>.running,正常退出时删掉。起来时发现它还在,说明上一次没走到正常退出
// (崩了、被 kill -9、断电),就把它改名成 <名字>.crashed 留给交易纪律守护推一条「重启了」。
// 界面进程(app)与引擎(engine)各一份:引擎只看得到 stdin 关了,分不清界面是正常退出还是崩了,所以界面那份由界面自己写。
// 两个进程都放在 settings.json 所在目录的 guard-run/ 下。
#pragma once

#include <QString>

#include <optional>

namespace ibkr::util::run_marker {

/// settings.json 所在目录下的 guard-run/
QString dirFor(const QString& settingsPath);
/// 起来时调:上一次的 .running 还在就改名成 .crashed(覆盖旧的),再写这一次的 .running({pid, at})
void markRunning(const QString& dir, const QString& name);
/// 正常退出时调:删掉 .running
void markStopped(const QString& dir, const QString& name);
/// 取走一份 .crashed:回它记的上一次起来的时刻(ISO,可能为空串),并删掉文件;没有就是空
std::optional<QString> takeCrashed(const QString& dir, const QString& name);

}  // namespace ibkr::util::run_marker
