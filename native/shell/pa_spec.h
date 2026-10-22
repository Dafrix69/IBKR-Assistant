// K 线读盘的图(lib/chart/paSpec.ts,逐句搬):把引擎 pa.analyze 的回包翻成图的 spec。图上每条线都对应引擎算出的一个字段:
//   bars → 蜡烛与量能   ma → 均线(与 bars 逐根对齐)   levels → 关键位虚线(支撑涨色 / 阻力跌色)
//   fvgs → FVG 色块      order_block → 订单块         swings → 摆动点(最近 8 个)   last → 现价
//   forming → 最后一根没进判定:还在走是「形成中」,延迟行情数据没到齐是「未到齐」
//   proxy.spans → 指数的盘外按期货推算的那几段:灰色竖带,写「ES 推算」
// 期望值:tests/fixtures/gen_market.mjs 的 specs
#pragma once

#include "shell/chart_spec.h"

#include <QJsonObject>

namespace ibkr::shell::pa {

/// JSON 形状的那一份(同 paSpec 的返回,少了 header 回调;没有的键不写,同 JSON.stringify 丢掉 undefined)
QJsonObject specJson(const QJsonValue& r);
/// 图用的 spec:specJson 再接上顶部的均线读数(header)
chart::Spec spec(const QJsonValue& r);

}  // namespace ibkr::shell::pa
