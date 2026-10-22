// 价位条的排版(desktop/renderer-react/src/lib/LevelStrip.tsx 的 buildLevelStripSvg,逐句搬):
// 一只标的的墙、均线、整数关口、52 周高低、自己设的线和现价摆在一条横轴上——标签钉在各自的价位上,同侧按位置推开,
// 推不开的抬到第二层;现价 ±12% 内是核心区,远处的价位进两端的压缩区、轴上画断口。
// 产出和原版同样的一棵 SVG 元素树(QML 那边照它画),量字宽由调用方给(界面用真字体,测试用固定规则)。
// 期望值:tests/fixtures/gen_level_strip.mjs 把原函数切出来在假 DOM 里跑。
#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QString>

#include <functional>
#include <optional>

namespace ibkr::shell::levels {

/// 量一段字的宽度:text、是不是等宽字体、字重;字号固定 10
using Measure = std::function<double(const QString& text, bool mono, int weight)>;

/// 测试与生成器共用的量法:ASCII 每个 6、别的每个 10
double measureFixed(const QString& text, bool mono, int weight);

/// 价位条的 SVG 元素树:{ tag, attrs: { 名: 字符串 }, text?, children: [...] };没有可画的是空对象
QJsonObject buildLevelStrip(const QJsonArray& levels, std::optional<double> spot, double width, const Measure& measure);

}  // namespace ibkr::shell::levels
