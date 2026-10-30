#include "analysis/fly_entry_assist.h"

#include "util/jsformat.h"
#include "util/jsobj.h"
#include "util/py.h"

#include <algorithm>
#include <cmath>
#include <limits>

using namespace Qt::StringLiterals;

namespace ibkr::analysis::flyentry {

using util::OJson;
namespace js = util::js;

namespace {

bool finitePositive(const std::optional<double>& v) { return v && std::isfinite(*v) && *v > 0; }

QString f1(double v) { return util::jsToFixed(v, 1); }
QString f2(double v) { return util::jsToFixed(v, 2); }
/// 整数就不带小数(25 不写 25.0)
QString pts(double v) { return std::fabs(v - std::round(v)) < 1e-9 ? util::jsNumberToString(std::round(v)) : f1(v); }
QString hhmm(double minutes) {
    const int m = int(std::floor(minutes));
    return u"%1:%2"_s.arg(m / 60, 2, 10, QChar(u'0')).arg(m % 60, 2, 10, QChar(u'0'));
}
QString signedPct(double v) { return (v > 0 ? u"+"_s : v < 0 ? u"−"_s : QString()) + f2(std::fabs(v)) + u'%'; }

OJson flag(const QString& key, const QString& title, const QString& basis) {
    return js::object({{u"key"_s, js::S(key)}, {u"title"_s, js::S(title)}, {u"basis"_s, js::S(basis)}});
}

}  // namespace

const std::vector<double>& widthLadder() {
    static const std::vector<double> l{20, 25, 30, 50, 75};
    return l;
}

WidthPick pickWidth(double straddle, const Config& cfg) {
    WidthPick w;
    w.raw = cfg.width_mult * straddle;
    w.floor = cfg.width_floor_mult * straddle;
    const auto& ladder = widthLadder();
    // 离 raw 最近的档;一样近取大的那档(宁可多盖一点)
    size_t best = 0;
    for (size_t i = 1; i < ladder.size(); ++i) {
        const double d = std::fabs(ladder[i] - w.raw), bd = std::fabs(ladder[best] - w.raw);
        if (d < bd || (d == bd && ladder[i] > ladder[best])) best = i;
    }
    // 最近的那档低于下限(1.5 倍)就再上一档;没有更高的档就是盖不住
    while (ladder[best] < w.floor - 1e-9 && best + 1 < ladder.size()) ++best;
    w.pick = ladder[best];
    w.capped = w.raw > ladder.back() + 1e-9;
    return w;
}

std::optional<double> priorChangePct(const Input& in) {
    if (!finitePositive(in.priorClose) || !finitePositive(in.prevClose)) return std::nullopt;
    return (*in.priorClose / *in.prevClose - 1.0) * 100.0;
}

OJson evaluate(const Config& cfg, const Input& in) {
    OJson flags = js::array();
    QStringList notes;
    OJson width = OJson::null();
    OJson timing = OJson::null();
    const std::optional<double> change = priorChangePct(in);

    if (cfg.enabled) {
        // ---- 翼宽建议
        if (finitePositive(in.straddle)) {
            const WidthPick w = pickWidth(*in.straddle, cfg);
            QString text = u"建议翼宽 %1 点:%2 × 跨式 %3 = %4 点,取最接近的一档;下限 %5 × = %6 点"_s.arg(
                pts(w.pick), pts(cfg.width_mult), f1(*in.straddle), f1(w.raw), pts(cfg.width_floor_mult), f1(w.floor));
            if (w.capped) text += u"。%1 点已经超过最大的一档,盖不住:研究里隐含超过 25 点的日子用 50 宽,或者不开"_s.arg(f1(w.raw));
            width = js::object({
                {u"straddle"_s, js::N(util::pyRound(*in.straddle, 2))},
                {u"straddle_at"_s, js::NOrNull(in.straddleAt)},
                {u"strike"_s, js::NOrNull(in.straddleStrike)},
                {u"raw"_s, js::N(util::pyRound(w.raw, 2))},
                {u"floor"_s, js::N(util::pyRound(w.floor, 2))},
                {u"pick"_s, js::N(w.pick)},
                {u"capped"_s, js::B(w.capped)},
                {u"text"_s, js::S(text)},
                {u"basis"_s, js::S(u"研究:翼宽 1.5–2 倍跨式的蝶胜率 57%、每笔期望 +78 美元;2 倍以上 60% / +26;不到 1 倍只有两三成。"
                                   u"14:00 固定 25 宽胜率 55.6%,改成 2 × 跨式 59.4%(2022-05 至 2026-10,53,320 笔)"_s)},
            });
        } else {
            notes << (in.straddleNote.isEmpty() ? u"拿不到当日到期的平值跨式,翼宽建议先不给"_s : u"翼宽建议先不给:"_s + in.straddleNote);
        }

        // ---- 今日不开:前一日大跌后的下午
        if (change) {
            if (*change <= -cfg.prior_drop_pct && in.etMinutes >= cfg.prior_drop_after_min) {
                flags.items.append(flag(u"prior_drop"_s, u"昨日 SPX %1:研究建议今天下午不开"_s.arg(signedPct(*change)),
                                        u"前日(%1)收 %2 → 昨日(%3)收 %4。研究:前一日跌 ≥ %5% 后 13:00–14:00 入场的蝶胜率 37–47%、每笔期望 −52 ~ −83 美元;"
                                        u"测试期(2024-11 起)更差,42% / −129。大跌次日隐含波动高,同样的翼宽盖不住"_s.arg(
                                            in.prevDate, f2(*in.prevClose), in.priorDate, f2(*in.priorClose), pts(cfg.prior_drop_pct))));
            }
        } else if (!in.priorNote.isEmpty()) {
            notes << u"「大跌次日」这一条没判:"_s + in.priorNote;
        }

        // ---- 今日不开:周四中午前
        if (in.weekday == 4 && in.etMinutes < cfg.thursday_before_min) {
            flags.items.append(flag(u"thursday"_s, u"周四 %1 以前:研究建议不开"_s.arg(hhmm(cfg.thursday_before_min)),
                                    u"研究:周四中午前入场的蝶,训练期(2022-05 至 2024-10)胜率 34%、每笔期望 −163 美元,测试期(2024-11 至 2026-10)33% / −126,五年一致,没有解释"_s));
        }

        // ---- 今日不开:SPX 与 SPY 当天到期的 put 墙都离现货很近(弱信号)
        {
            QStringList missing;
            if (!finitePositive(in.straddle)) missing << u"没有跨式"_s;
            if (!finitePositive(in.spxSpot) || !finitePositive(in.spxPutWall)) missing << (in.spxWallNote.isEmpty() ? u"SPX 当天到期的 put 墙取不到"_s : in.spxWallNote);
            if (!finitePositive(in.spySpot) || !finitePositive(in.spyPutWall)) missing << (in.spyWallNote.isEmpty() ? u"SPY 当天到期的 put 墙取不到"_s : in.spyWallNote);
            // 墙是「取到的那段链里」持仓量最大的行权价:链没取到阈值之外,就分不出墙是真近还是只取到这儿。取到的最低档离现货没超过阈值,这一条判不了
            if (missing.isEmpty()) {
                const double spxReach = in.spxWindowLow ? *in.spxSpot - *in.spxWindowLow : std::numeric_limits<double>::infinity();
                const double spyReachPct = in.spyWindowLow ? (*in.spySpot - *in.spyWindowLow) / *in.spySpot * 100.0 : std::numeric_limits<double>::infinity();
                if (spxReach <= cfg.spx_put_wall_straddle_mult * *in.straddle)
                    missing << u"SPX 的链只取到 %1(离现货 %2 点),盖不住 %3 × 跨式 = %4 点%5"_s.arg(pts(*in.spxWindowLow), f1(spxReach), pts(cfg.spx_put_wall_straddle_mult),
                                                                                              f1(cfg.spx_put_wall_straddle_mult * *in.straddle), in.spxThinned ? u",而且是抽着取的"_s : QString());
                if (spyReachPct <= cfg.spy_put_wall_pct)
                    missing << u"SPY 的链只取到 %1(离现价 %2%),盖不住 %3%%4"_s.arg(pts(*in.spyWindowLow), f2(spyReachPct), pts(cfg.spy_put_wall_pct),
                                                                           in.spyThinned ? u",而且是抽着取的"_s : QString());
            }
            if (!missing.isEmpty()) {
                notes << u"「两个 put 墙都近」这一条没判:"_s + missing.join(u";"_s);
            } else {
                const double spxGap = *in.spxSpot - *in.spxPutWall;
                const double spxMult = spxGap / *in.straddle;
                const double spyPct = (*in.spySpot - *in.spyPutWall) / *in.spySpot * 100.0;
                const bool spxNear = spxGap >= 0 && spxMult <= cfg.spx_put_wall_straddle_mult;
                const bool spyNear = spyPct >= 0 && spyPct <= cfg.spy_put_wall_pct;
                if (spxNear && spyNear) {
                    flags.items.append(flag(u"put_walls"_s, u"SPX 与 SPY 当天到期的 put 墙都离现货很近:弱信号,研究建议不开"_s,
                                            u"SPX put 墙 %1 离现货 %2 点 = %3 × 跨式(≤ %4);SPY put 墙 %5 离现价 %6%(≤ %7%)。"
                                            u"研究:两墙都近的日子(约 20%)胜率训练期 52.9% / 期望 +3,测试期 43.8% / −223;区间约 ±5 个百分点,是方向一致的弱信号,不是已证实的因子"_s.arg(
                                                pts(*in.spxPutWall), f1(spxGap), f1(spxMult), pts(cfg.spx_put_wall_straddle_mult), pts(*in.spyPutWall), f2(spyPct),
                                                pts(cfg.spy_put_wall_pct))));
                }
            }
        }

        // ---- 时段提示
        if (in.etMinutes >= cfg.late_entry_min) {
            timing = js::object({{u"title"_s, js::S(u"%1 以后入场:研究里胜率略高但期望归零"_s.arg(hhmm(cfg.late_entry_min)))},
                                 {u"basis"_s, js::S(u"研究:25 宽 ATM 蝶 15:00 入场胜率 58.3%、15:30 59.1%,但盈亏比掉到 0.75,点差把期望吃光(k=0.5 时为 0);"
                                                    u"13:00–14:00 是胜率与期望的平衡点(52–56%,+24 ~ +35)"_s)}});
        }
    }

    OJson inputs = js::object({
        {u"et"_s, js::S(hhmm(in.etMinutes))},
        {u"weekday"_s, js::N(in.weekday)},
        {u"straddle"_s, js::NOrNull(in.straddle)},
        {u"prior_change_pct"_s, change ? js::N(util::pyRound(*change, 2)) : OJson::null()},
        {u"prior_date"_s, in.priorDate.isEmpty() ? OJson::null() : js::S(in.priorDate)},
        {u"spx_spot"_s, js::NOrNull(in.spxSpot)},
        {u"spx_put_wall"_s, js::NOrNull(in.spxPutWall)},
        {u"spy_spot"_s, js::NOrNull(in.spySpot)},
        {u"spy_put_wall"_s, js::NOrNull(in.spyPutWall)},
    });
    return js::object({
        {u"enabled"_s, js::B(cfg.enabled)},
        {u"width"_s, width},
        {u"flags"_s, flags},
        {u"timing"_s, timing},
        {u"notes"_s, js::strings(notes)},
        {u"inputs"_s, inputs},
    });
}

}  // namespace ibkr::analysis::flyentry
