// engine-ts/src/rpc/perfLog.ts:RPC 的耗时分两段记——在道上排了多久、执行了多久;每 kFlushMs 写一行分位数汇总。
// 纯计算,不认识 RPC 服务器:服务器收到请求时记时刻,答完时调 record。
//
// 和 TS 的出入(只有一处):样本里有 NaN 时,JS 的 sort((a,b)=>a-b) 的结果取决于 V8 的排序实现,这边把 NaN 排在最后。
// 样本是 performance.now() 的差,不会是 NaN,测试也不喂它。
#pragma once

#include "util/ordered_json.h"

#include <QHash>
#include <QString>

#include <functional>
#include <optional>
#include <vector>

namespace ibkr::rpc {

enum class Lane { Local, Read, Trade };
/// "local" / "read" / "trade"
QString laneName(Lane lane);

/// 多久写一行汇总。十分钟:一天 144 行,够看出哪一段变慢,又不刷屏
inline constexpr double kFlushMs = 10 * 60'000;
/// 排队超过这么久才在慢请求那一行里写出来
inline constexpr double kQueueNoteMs = 100;
/// 每个方法每个窗口最多留的样本数,再多按蓄水池抽样(最大值另记,不丢)
inline constexpr int kMaxSamples = 5'000;

/// 最近秩分位数:排好序的样本里第 ⌈q·n⌉ 个。没有样本是 0
double quantile(const std::vector<double>& sorted, double q);

/// 慢请求那一行;两段都不慢回空
std::optional<QString> slowLine(const QString& method, double waitMs, double runMs, double slowMs);

class RpcTimings {
public:
    /// nowMs:窗口从这一刻算起。random:蓄水池抽样用的 [0,1) 随机数(TS 默认 Math.random;测试给固定的)
    RpcTimings(double nowMs, std::function<double()> random);

    void record(const QString& method, Lane lane, double waitMs, double runMs);
    /// {方法: {lane, n, run: {p50,p90,p99,max}, wait: {…}}},方法按 localeCompare 排
    util::OJson summary() const;
    /// 这一窗口的汇总行 `[perf] {json}`,写完清零;一个请求都没有回空。extra 是调用方递进来的计数(对象,摊在 window / methods 之后,同名的盖掉)
    std::optional<QString> flush(double nowMs, const util::OJson& extra);
    std::optional<QString> flush(double nowMs);

private:
    struct Bucket {
        Lane lane = Lane::Local;
        double n = 0;
        std::vector<double> wait, run;
        double waitMax = 0, runMax = 0;
    };
    std::vector<std::pair<QString, Bucket>> buckets_;  // Map 的插入次序
    QHash<QString, qsizetype> index_;
    double since_;
    std::function<double()> random_;
};

}  // namespace ibkr::rpc
