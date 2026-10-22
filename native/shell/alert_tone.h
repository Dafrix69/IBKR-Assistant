// 提醒的提示音(React 版 store/alerts.ts 的 playAlertTone):上穿 / 急涨升调、下破 / 急跌降调,不用看屏幕就知道方向;
// 没有方向(放量)是同一个音响两下。三角波,每个音 0.22 秒、音间 0.24 秒;包络照 Web Audio 那段写:
// 0.0001 起、20ms 指数爬到 0.6、顶住到 0.1 秒、0.22 秒指数收回 0.0001(直接开关振荡器会咔哒一声)。
// 这里合成成一段 WAV(44.1 kHz、16 位、单声道),交给平台播放(macOS 是 NSSound)。Qt 的 Multimedia 不是必装件,不靠它。
#pragma once

#include <QByteArray>
#include <QList>
#include <QString>

namespace ibkr::shell::tone {

inline constexpr int kSampleRate = 44100;
inline constexpr double kPeak = 0.6;

/// up / down / 其它(没有方向)的两个音的频率
QList<double> notesFor(const QString& direction);
/// 合成好的 16 位样本(未加 WAV 头)
QList<qint16> samples(const QString& direction);
/// 带 RIFF/WAVE 头的整段
QByteArray wav(const QString& direction);

}  // namespace ibkr::shell::tone
