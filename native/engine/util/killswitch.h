// 全局熔断开关(engine-ts/src/killswitch.ts 逐句搬):状态在一个 JSON 文件里,界面、CLI、引擎看同一个开关,崩溃重启后照样有效。
// 只有手动熔断:连续失败不再自动合上。文件坏了按"已熔断"处理(宁可停,不乱下单);写是先写临时文件再改名。
// 老版本写下的自动熔断(文件里 auto=true)读出来按没熔断算。
#pragma once

#include <QJsonObject>
#include <QString>

namespace ibkr::util {

struct BreakerState {
    bool engaged = false;
    QString reason;
    QString at;
    QJsonObject toJson() const;
};

class KillSwitch {
public:
    explicit KillSwitch(QString filePath);
    BreakerState state() const;
    bool isEngaged() const { return state().engaged; }
    BreakerState engage(const QString& reason);
    BreakerState release(const QString& actor = QStringLiteral("user"));
    const QString& path() const { return path_; }

private:
    void write(const BreakerState& s) const;
    QString path_;
};

/// 本机时区、到秒的 ISO 时刻(2026-10-19T05:12:03+08:00)
QString localIsoSeconds();

}  // namespace ibkr::util
