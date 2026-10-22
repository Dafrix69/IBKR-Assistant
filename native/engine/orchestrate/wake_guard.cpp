#include "orchestrate/wake_guard.h"

#include "execution/ib_link.h"
#include "util/awake_clock.h"
#include "util/jsformat.h"
#include "util/jsobj.h"
#include "util/tz.h"

#include <cmath>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;

namespace ibkr::orchestrate::wake {

namespace {
constexpr int kSymbolsShown = 5;
QString num(double v) { return util::jsNumberToString(v); }
}  // namespace

QString holdReason() {
    return u"电脑刚醒,先不判断:醒来头几秒的报价可能还是睡前的。等券商连接稳住 "_s + num(kSettleMs / 1000) + u" 秒(最长 "_s + num(kSettleMaxMs / 60'000) +
           u" 分钟)再恢复"_s;
}

double awakeClockMs(const std::vector<CpuTimes>& cpus, const QString& platform, const std::function<double()>& fallback) {
    if (platform != u"darwin") return fallback();
    double best = 0;
    for (const CpuTimes& t : cpus) best = jsx::max(best, t.user + t.nice + t.sys + t.idle + t.irq);
    return best > 0 ? best : fallback();
}

double awakeClockMs() { return static_cast<double>(util::awakeMicros()) / 1000.0; }

QString gapKindName(GapKind k) { return k == GapKind::Sleep ? u"sleep"_s : u"stall"_s; }

std::optional<WakeGap> WakeGuard::gapOf(const WakeSample& s) const {
    if (!prevWall_ || !prevMono_) return std::nullopt;
    const double stopped = s.wall - *prevWall_;
    if (!(stopped > kGapMs)) return std::nullopt;  // 墙钟往回拨也走这里
    const double asleep = jsx::min(stopped, jsx::max(0, stopped - (s.mono - *prevMono_)));
    return WakeGap{asleep * 2 >= stopped ? GapKind::Sleep : GapKind::Stall, *prevWall_, s.wall, stopped, asleep};
}

void WakeGuard::extend(const WakeGap& gap, const LiveTracks& live) {
    if (!open_) {
        open_ = WakeEpisode{gap.kind, gap.from, gap.to, 1, gap.stopped_ms, gap.asleep_ms, 0, live};
        return;
    }
    WakeEpisode& ep = *open_;
    ep.awake_ms += gap.from - ep.to;
    ep.to = gap.to;
    ep.gaps += 1;
    ep.stopped_ms += gap.stopped_ms;
    ep.asleep_ms += gap.asleep_ms;
    ep.kind = ep.asleep_ms * 2 >= ep.stopped_ms ? GapKind::Sleep : GapKind::Stall;
    if (live.total > ep.live.total) ep.live = live;
}

std::pair<QString, std::optional<Released>> WakeGuard::holdAt(const WakeSample& s) {
    if (!settle_) return {QString(), std::nullopt};
    Settle& st = *settle_;
    if (s.link != st.link) {
        st.link = s.link;
        st.linkSince = s.link.isEmpty() ? std::nullopt : std::optional<double>(s.wall);
    }
    const bool steady = st.linkSince && s.wall - *st.linkSince >= kSettleMs;
    if (!steady && s.wall - st.since < kSettleMaxMs) return {holdReason(), std::nullopt};
    const Released released{s.wall - st.since, steady};
    settle_.reset();
    return {QString(), released};
}

WakeStep WakeGuard::step(const WakeSample& s) {
    const std::optional<WakeGap> gap = gapOf(s);
    prevWall_ = s.wall;
    prevMono_ = s.mono;
    if (gap) {
        extend(*gap, s.live);
        if (gap->kind == GapKind::Sleep) settle_ = Settle{s.wall, s.link, s.link.isEmpty() ? std::nullopt : std::optional<double>(s.wall)};
    }
    auto [hold, released] = holdAt(s);
    std::optional<WakeEpisode> episode;
    if (!gap && open_ && s.wall - open_->to >= kQuietMs) {
        episode = open_;
        open_.reset();
    }
    return WakeStep{gap, hold, released, episode};
}

void WakeGuard::pause() {
    prevWall_.reset();
    prevMono_.reset();
}

LiveTracks liveTracksOf(const QList<OJson>& tracks, const std::function<bool(const QString&)>& chasing) {
    std::vector<const OJson*> live;
    for (const OJson& t : tracks) {
        if ((js::truthy(js::prop(&t, u"enabled"_s)) && !js::truthy(js::prop(&t, u"fired_at"_s))) || chasing(js::str(js::prop(&t, u"id"_s)))) live.push_back(&t);
    }
    LiveTracks out;
    out.total = static_cast<double>(live.size());
    for (const OJson* t : live) {
        if (js::truthy(js::path(t, {u"auto_close"_s, u"host_at_broker"_s}))) out.hosted += 1;
        const QString sym = js::str(js::prop(t, u"symbol"_s));
        if (!out.symbols.contains(sym)) out.symbols.append(sym);
    }
    return out;
}

QString linkOf(WakeRouter* router) {
    if (!router) return QString();
    if (router->hasConnectedNames()) return router->connectedNames().join(u',');
    return router->sessionCount() > 0 ? QString::number(router->sessionCount()) : QString();
}

// ---- 给人看的话 -------------------------------------------------------------

QString durationText(double ms) {
    if (ms < 60'000) return num(util::jsRound(ms / 1000)) + u" 秒"_s;
    const double min = util::jsRound(ms / 60'000);
    if (min < 60) return num(min) + u" 分钟"_s;
    const double h = std::floor(min / 60), m = std::fmod(min, 60);
    return m != 0 ? num(h) + u" 小时 "_s + num(m) + u" 分"_s : num(h) + u" 小时"_s;
}

namespace {

QString etTime(double ms, bool seconds = false) {
    const util::WallParts p = util::wallParts(ms, QString::fromUtf16(util::kET));
    return util::pad2(p.hour) + u":"_s + util::pad2(p.minute) + (seconds ? u":"_s + util::pad2(p.second) : QString());
}

}  // namespace

QString spanText(double from, double to, bool seconds) {
    const QString et = QString::fromUtf16(util::kET);
    const util::WallParts a = util::wallParts(from, et), b = util::wallParts(to, et);
    if (a.year == b.year && a.month == b.month && a.day == b.day) return etTime(from, seconds) + u"–"_s + etTime(to, seconds);
    const auto md = [](const util::WallParts& p) { return util::pad2(p.month) + u"-"_s + util::pad2(p.day); };
    return md(a) + u" "_s + etTime(from, seconds) + u" – "_s + md(b) + u" "_s + etTime(to, seconds);
}

QString gapLogLine(const WakeGap& g) {
    const QString why = g.kind == GapKind::Sleep ? u"其中约 "_s + durationText(g.asleep_ms) + u"电脑在睡眠;醒来先不判断,等券商连接稳住"_s
                                                  : u"电脑没睡,是引擎被挂起或卡住了"_s;
    return u"[盯盘] 节拍停了 "_s + durationText(g.stopped_ms) + u"(美东 "_s + spanText(g.from, g.to, true) + u","_s + why + u")"_s;
}

QString releasedLogLine(const Released& r) {
    return u"[盯盘] 醒后等了 "_s + durationText(r.waited_ms) + u","_s + (r.steady ? u"券商连接已稳住"_s : u"连接一直没稳住,等满了"_s) + u",恢复判断"_s;
}

QString episodeLogLine(const WakeEpisode& ep) {
    const QString woke = ep.gaps > 1 ? u",其间短暂醒过 "_s + num(ep.gaps - 1) + u" 次、共 "_s + durationText(ep.awake_ms) + u",都没有判断"_s : QString();
    return u"[盯盘] 这一段停摆结束:美东 "_s + spanText(ep.from, ep.to, true) + u",共停 "_s + durationText(ep.stopped_ms) + u"("_s +
           (ep.kind == GapKind::Sleep ? u"睡眠约 "_s + durationText(ep.asleep_ms) : u"不是睡眠"_s) + woke + u");当时在盯的追踪 "_s + num(ep.live.total) + u" 条"_s;
}

OJson episodeAudit(const WakeEpisode& ep) {
    OJson symbols = js::array();
    for (const QString& s : ep.live.symbols) symbols.items.append(js::S(s));
    return js::object({{u"kind"_s, js::S(gapKindName(ep.kind))},
                       {u"from"_s, js::S(util::isoString(ep.from))},
                       {u"to"_s, js::S(util::isoString(ep.to))},
                       {u"stopped_s"_s, js::N(util::jsRound(ep.stopped_ms / 1000))},
                       {u"asleep_s"_s, js::N(util::jsRound(ep.asleep_ms / 1000))},
                       {u"awake_s"_s, js::N(util::jsRound(ep.awake_ms / 1000))},
                       {u"gaps"_s, js::N(ep.gaps)},
                       {u"live"_s, js::N(ep.live.total)},
                       {u"hosted"_s, js::N(ep.live.hosted)},
                       {u"symbols"_s, symbols}});
}

std::optional<Notice> episodeNotice(const WakeEpisode& ep) {
    const double span = ep.to - ep.from;
    if (ep.live.total == 0 || span < kNotifyMinMs) return std::nullopt;
    const QString title = ep.kind == GapKind::Sleep ? u"电脑睡了 "_s + durationText(span) + u",本机盯盘没有运行"_s : u"盯盘停了 "_s + durationText(span);
    const QStringList firstFew = ep.live.symbols.mid(0, kSymbolsShown);
    const QString shown = firstFew.join(u"、"_s) + (ep.live.symbols.size() > kSymbolsShown ? u" 等"_s : QString());
    const QString hosted = ep.live.hosted != 0 ? u"其中 "_s + num(ep.live.hosted) + u" 条托管在券商,券商那边的单照常有效。"_s : QString();
    const QString hint = ep.kind == GapKind::Sleep ? u"用电池时合盖电脑会睡着:离开时请接电源,或打开「托管到券商」。"_s : QString();
    return Notice{title, u"美东 "_s + spanText(ep.from, ep.to) + u","_s + num(ep.live.total) + u" 条追踪("_s + shown +
                             u")没人盯:止盈止损、跟踪止损、利润回撤都没有判断。"_s + hosted + u"请核对持仓与挂单。"_s + hint};
}

void reportWake(const WakeStep& step, EngineStore& store, util::Notifier& notifier, const std::function<void(const QString&)>& log) {
    const auto say = [&](const QString& line) {
        if (log) log(line);
        else execution::logStderr(line);
    };
    if (step.gap) say(gapLogLine(*step.gap));
    if (step.released) say(releasedLogLine(*step.released));
    if (!step.episode) return;
    say(episodeLogLine(*step.episode));
    const OJson detail = episodeAudit(*step.episode);
    store.audit(u"engine"_s, u"monitor_gap"_s, &detail);
    if (const auto notice = episodeNotice(*step.episode)) notifier.notify(notice->title, notice->body, u"盯盘"_s);
}

}  // namespace ibkr::orchestrate::wake
