// 全局熔断开关(engine-ts/src/killswitch.ts 逐句搬):状态在一个 JSON 文件里,界面、CLI、引擎看同一个开关,崩溃重启后照样有效。
// 券商失败与解析失败分开计数、互不清零;文件坏了按"已熔断"处理(宁可停,不乱下单);写是先写临时文件再改名。
// auto = 连续失败自动合上的(手动熔断照旧撤单;自动的不把持仓的保护一起撤了,见 TS 那段注释)。
// 期望值:tests/fixtures/gen_killswitch.mjs(原模块在同一串操作上现跑)
#pragma once

#include <QJsonObject>
#include <QString>

#include <optional>

namespace ibkr::util {

struct BreakerState {
    bool engaged = false;
    QString reason;
    QString at;
    double consecutive_failures = 0;
    double consecutive_parse_failures = 0;
    bool autoEngaged = false;  // TS 的 auto
    QJsonObject toJson() const;
};

class KillSwitch {
public:
    explicit KillSwitch(QString filePath, double threshold = 3);
    BreakerState state() const;
    bool isEngaged() const { return state().engaged; }
    BreakerState engage(const QString& reason, bool autoEngaged = false);
    BreakerState release(const QString& actor = QStringLiteral("user"));
    /// kind:"broker" / "parse"。解析成功只清解析计数,下单成功才清券商计数
    void recordSuccess(const QString& kind = QStringLiteral("broker"));
    std::optional<BreakerState> recordFailure(const QString& reason, const QString& kind = QStringLiteral("broker"));
    const QString& path() const { return path_; }
    double threshold() const { return threshold_; }

private:
    void write(const BreakerState& s) const;
    QString path_;
    double threshold_;
};

/// 本机时区、到秒的 ISO 时刻(2026-10-19T05:12:03+08:00)
QString localIsoSeconds();

}  // namespace ibkr::util
