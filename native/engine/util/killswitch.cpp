#include "util/killswitch.h"
#include "util/js_runtime.h"
#include <QTimeZone>

#include "util/error.h"
#include "util/jsvalue.h"

#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QSaveFile>

#include <cmath>

namespace ibkr::util {

using namespace Qt::StringLiterals;

QJsonObject BreakerState::toJson() const {
    return {{u"engaged"_s, engaged}, {u"reason"_s, reason}, {u"at"_s, at}};
}

KillSwitch::KillSwitch(QString filePath) : path_(std::move(filePath)) {
    QDir().mkpath(QFileInfo(path_).absolutePath());
}

BreakerState KillSwitch::state() const {
    QFile f(path_);
    if (!f.exists()) return {};
    if (!f.open(QIODevice::ReadOnly)) return {true, u"熔断状态文件损坏,已按安全侧处理"_s, {}};
    // JSON.parse 认顶层的标量;QJsonDocument 不认——包一层数组再读
    QJsonParseError err;
    const QJsonDocument doc = QJsonDocument::fromJson("[" + f.readAll() + "]", &err);
    if (err.error != QJsonParseError::NoError || doc.array().size() != 1) return {true, u"熔断状态文件损坏,已按安全侧处理"_s, {}};
    const QJsonValue raw = doc.array().at(0);
    const QJsonObject o = raw.toObject();  // 标量 / 数组:读哪一格都是 undefined
    BreakerState s;
    // 老版本连续失败自动合上的(auto=true):自动熔断已撤掉,不再挡
    s.engaged = jsTruthy(o.value(u"engaged")) && o.value(u"auto") != QJsonValue(true);
    s.reason = o.value(u"reason").isUndefined() || o.value(u"reason").isNull() ? QString() : jsString(o.value(u"reason"));
    s.at = o.value(u"at").isUndefined() || o.value(u"at").isNull() ? QString() : jsString(o.value(u"at"));
    // 顶层是数组或字符串时,TS 的 raw["at"] 取到的是 Array.prototype.at / String.prototype.at 这个函数,String() 出来是它的源码。
    // 文件是引擎自己写的,碰不到;照原样留着,对拍才对得上
    if (raw.isArray() || raw.isString()) s.at = u"function at() { [native code] }"_s;
    return s;
}

BreakerState KillSwitch::engage(const QString& reason) {
    const BreakerState next{true, reason, localIsoSeconds()};
    write(next);
    return next;
}

BreakerState KillSwitch::release(const QString& actor) {
    const BreakerState next{false, u"由 %1 手动解除"_s.arg(actor), localIsoSeconds()};
    write(next);
    return next;
}

void KillSwitch::write(const BreakerState& s) const {
    // 原子写:先写临时文件再改名,崩溃不会留下半截 JSON。键序同 TS 的 JSON.stringify
    const QString payload =
        u"{\"engaged\":%1,\"reason\":%2,\"at\":%3}"_s.arg(s.engaged ? u"true"_s : u"false"_s, jsonQuote(s.reason), jsonQuote(s.at));
    // QSaveFile:写进旁边的临时文件、写完整了才原子地换上去(TS 版是 .json.tmp + rename,同一个意思;Windows 上 rename 不能覆盖已有文件)
    // 写不进去必须抛:TS 的 writeFileSync / renameSync 失败一路抛到 breaker.halt,界面报错;吞掉的话界面显示「已熔断」,
    // 下一拍盯盘现读文件读到的却是没熔断,托管单照发。抛的话照 Node 的 fs 错误的样子(errno 名、说明、动作、路径)
    QSaveFile f(path_);
    const QString tmp = (path_.endsWith(u".json"_s) ? path_.chopped(5) : path_) + u".json.tmp"_s;
    const auto fail = [&](const QString& action, const QString& target) {
        const bool denied = f.error() == QFileDevice::PermissionsError || !QFileInfo(QFileInfo(path_).absolutePath()).isWritable();
        const bool missing = !QFileInfo::exists(QFileInfo(path_).absolutePath());
        const QString code = missing ? u"ENOENT: no such file or directory"_s : denied ? u"EACCES: permission denied"_s : u"EIO: i/o error"_s;
        throw JsError(u"%1, %2 '%3'"_s.arg(code, action, target));
    };
    if (!f.open(QIODevice::WriteOnly)) fail(u"open"_s, tmp);
    if (f.write(payload.toUtf8()) < 0) fail(u"write"_s, tmp);
    if (!f.commit()) fail(u"rename"_s, tmp + u"' -> '"_s + path_);
}

QString localIsoSeconds() {
    const QDateTime d = QDateTime::fromMSecsSinceEpoch(static_cast<qint64>(std::floor(dateNow())), QTimeZone::systemTimeZone());  // 读可注入的钟(同 TS 的 new Date(),测试拨得动)
    const int off = d.offsetFromUtc() / 60;
    const auto pad = [](int n) { return QString::number(std::abs(n)).rightJustified(2, u'0'); };
    return u"%1-%2-%3T%4:%5:%6%7%8:%9"_s.arg(d.date().year()).arg(pad(d.date().month()), pad(d.date().day()), pad(d.time().hour()), pad(d.time().minute()),
                                                                     pad(d.time().second()), off >= 0 ? u"+"_s : u"-"_s, pad(off / 60), pad(off % 60));
}

}  // namespace ibkr::util
