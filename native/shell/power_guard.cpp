#include "shell/power_guard.h"

#include "shell/jsvalue.h"

#include <QFile>
#include <QJsonDocument>
#include <QRegularExpression>
#include <QSaveFile>

#include <cmath>

using namespace Qt::StringLiterals;

namespace ibkr::shell::power {

namespace {

/// Number.isFinite(v) → Math.max(0, Math.trunc(v))
std::optional<int> finiteCount(const QJsonValue& v) {
    if (!v.isDouble() || !std::isfinite(v.toDouble())) return std::nullopt;
    return std::max(0, int(std::trunc(v.toDouble())));
}

}  // namespace

QString minutesText(double ms) {
    if (ms < 60'000) return u"%1 秒"_s.arg(jsNumberToString(std::max(0.0, jsRound(ms / 1000))));
    const qint64 min = qint64(jsRound(ms / 60'000));
    return min < 60 ? u"%1 分钟"_s.arg(min) : u"%1 小时 %2 分"_s.arg(min / 60).arg(min % 60);
}

Notice batteryNotice(int live, bool lidAwake) {
    if (lidAwake) {
        // 合盖睡眠已经关掉:合盖不停,停的是电
        return {u"正在用电池:电耗光,本机盯盘就停了"_s,
                u"有 %1 条追踪在本机盯着。合盖不会睡,但电池耗光电脑就关了。要离开很久请接上电源,或者给追踪打开「托管到券商」。"_s.arg(live)};
    }
    return {u"正在用电池:合上盖子,本机盯盘就停了"_s,
            u"有 %1 条追踪在本机盯着。用电池时合上笔记本,电脑会直接睡着,止盈止损、跟踪止损、利润回撤都不再判断。"
            "要离开请接着电源、别合盖,或者给追踪打开「托管到券商」。"_s.arg(live)};
}

Action PowerWatch::observe(const QJsonObject& args) {
    Action out;
    const QJsonValue battery = args.value("onBattery"_L1);
    if (battery.isBool() && (!onBattery || *onBattery != battery.toBool())) {
        const bool b = battery.toBool();
        out.log = !onBattery ? u"[power] 现在%1"_s.arg(b ? u"用电池"_s : u"接着电源"_s) : u"[power] %1"_s.arg(b ? u"改用电池"_s : u"接上了电源"_s);
        if (!b) warned = false;
        onBattery = b;
    }
    if (const auto n = finiteCount(args.value("live"_L1))) live = *n;
    if (args.value("lidAwake"_L1).isBool()) lidAwake = args.value("lidAwake"_L1).toBool();
    if (onBattery == true && live > 0 && !warned) {
        warned = true;
        out.notify = batteryNotice(live, lidAwake);
    }
    return out;
}

Action PowerWatch::suspend(double now) {
    suspendedAt_ = now;
    const QString power = !onBattery ? QString() : *onBattery ? u",用电池"_s : u",接着电源"_s;
    return {std::nullopt, u"[power] 系统睡眠%1;在盯的追踪 %2 条"_s.arg(power).arg(live), std::nullopt};
}

Action PowerWatch::resume(double now) {
    const QString slept = !suspendedAt_ ? QString() : u",睡了 "_s + minutesText(now - *suspendedAt_);
    suspendedAt_.reset();
    return {std::nullopt, u"[power] 系统醒来"_s + slept, std::nullopt};
}

std::optional<bool> parseSleepDisabled(const QString& text) {
    static const QRegularExpression re(uR"(^\s*SleepDisabled\s+(\d))"_s, QRegularExpression::MultilineOption);
    const auto m = re.match(text);
    if (!m.hasMatch()) return std::nullopt;
    return m.captured(1) != u"0";
}

QString pmsetScript(bool on) {
    return u"do shell script \"/usr/bin/pmset -a disablesleep %1\" with administrator privileges with prompt \"%2\""_s.arg(
        on ? u"1"_s : u"0"_s, u"Datrix 要在盯盘期间阻止合盖睡眠:合上盖子时持仓追踪照常运行。"_s);
}

bool isCancelled(const QString& stderrText, const QString& message) {
    static const QRegularExpression re(uR"(-128|User cancell?ed|用户已取消)"_s);
    return re.match(stderrText + u' ' + message).hasMatch();
}

Action LidGuard::observe(const QJsonObject& args) {
    const double now = args.value("now"_L1).toDouble();
    if (const auto n = finiteCount(args.value("live"_L1))) {
        if (*n == 0 && live > 0) declined = false;  // 这一段盯完了,下一段重新问
        live = *n;
    }
    if (live > 0) idleSince.reset();
    else if (!idleSince) idleSince = now;
    if (args.value("sleepDisabled"_L1).isBool()) {
        sleepDisabled = args.value("sleepDisabled"_L1).toBool();
        // 自己关的被人在终端里恢复了:那是人的意思,不再算自己的,这一段也不再去关
        if (!*sleepDisabled && owned) {
            owned = false;
            declined = true;
        }
    }
    if (busy || !sleepDisabled) return {};
    if (enabled && live > 0 && !*sleepDisabled && !declined) {
        busy = true;
        return {true, u"[power] 有 %1 条追踪在盯,请求关掉合盖睡眠"_s.arg(live), std::nullopt};
    }
    if (owned && *sleepDisabled && !restoreDeclined) {
        const bool idleLongEnough = live == 0 && idleSince && now - *idleSince >= kOffDelayMs;
        if (!enabled || idleLongEnough) {
            busy = true;
            return {false, u"[power] %1,请求恢复合盖睡眠"_s.arg(enabled ? u"没有追踪在盯满 10 分钟"_s : u"「盯盘时合盖不睡」已关"_s), std::nullopt};
        }
    }
    return {};
}

Action LidGuard::quitAction() {
    if (busy || !owned || sleepDisabled == false) return {};
    busy = true;
    return {false, u"[power] 退出应用,请求恢复合盖睡眠"_s, std::nullopt};
}

void LidGuard::setEnabled(bool on) {
    enabled = on;
    declined = false;
    restoreDeclined = false;
}

Action LidGuard::done(bool on, const QString& outcome, const QString& detail) {
    busy = false;
    const QString why = outcome == u"cancelled" ? u"授权框被取消"_s : !detail.isEmpty() ? detail : u"执行失败"_s;
    if (on) {
        if (outcome == u"ok") {
            owned = true;
            sleepDisabled = true;
            return {std::nullopt, u"[power] 已关掉合盖睡眠(盯盘期间)"_s,
                    Notice{u"盯盘期间合盖不睡"_s,
                           u"有 %1 条追踪在本机盯着,合上盖子也照常盯。机器会一直跑:别放进包里,用电池时电会耗光。"
                           "没有追踪在盯满 10 分钟、或退出应用时,恢复合盖睡眠。"_s.arg(live)}};
        }
        declined = true;
        return {std::nullopt, u"[power] 关掉合盖睡眠没成:"_s + why,
                Notice{u"合上盖子,本机盯盘仍会停"_s,
                       u"没有关掉合盖睡眠,这一段盯盘期间不再问。要离开请别合盖,或者给追踪打开「托管到券商」;"
                       "不想再被问,在菜单「交易 → 盯盘时合盖不睡」里关掉这一项。"_s}};
    }
    if (outcome == u"ok") {
        owned = false;
        sleepDisabled = false;
        return {std::nullopt, u"[power] 已恢复合盖睡眠"_s, std::nullopt};
    }
    restoreDeclined = true;
    return {std::nullopt, u"[power] 恢复合盖睡眠没成:"_s + why,
            Notice{u"合盖睡眠还关着"_s, u"合上盖子电脑不会睡。要恢复,在终端里运行 sudo pmset -a disablesleep 0,或者退出应用时在授权框里允许。"_s}};
}

LidGuard loadLidGuard(const QString& path) {
    QFile f(path);
    if (!f.open(QIODevice::ReadOnly)) return LidGuard();
    QJsonParseError err;
    const QJsonDocument doc = QJsonDocument::fromJson(f.readAll(), &err);
    if (err.error != QJsonParseError::NoError) return LidGuard();
    const QJsonObject o = doc.object();
    return LidGuard(o.value("enabled"_L1) != QJsonValue(false), o.value("owned"_L1) == QJsonValue(true));
}

void saveLidGuard(const QString& path, const LidGuard& guard) {
    QSaveFile f(path);
    if (!f.open(QIODevice::WriteOnly)) return;
    f.write(QJsonDocument(QJsonObject{{u"enabled"_s, guard.enabled}, {u"owned"_s, guard.owned}}).toJson(QJsonDocument::Indented));
    f.commit();
}

}  // namespace ibkr::shell::power
