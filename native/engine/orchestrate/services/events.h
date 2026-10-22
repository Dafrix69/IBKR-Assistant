// services/events.ts 逐句搬:重要事件的编排——拉公开日历、读写偏好表里的口径与自定义事件、合成一份清单给界面。只读、不发单。
// 纯计算在 analysis/econ_calendar(内置日程、日历源的解析、合并)与 cross_market;提醒的节拍不在这里(弹窗、声音、倒计时都在界面)。
//  · 日历源(Forex Factory 本周 JSON)陈旧即返、后台刷新:4 小时一拉,失败半小时后再试;从没拉到过的那一次同步等(最多 8 秒)。
//  · 跨市场:美股当日涨跌从行情带读(连着 TWS 是流式,否则公开源),ETF 的报价连着券商问券商,否则走公开源;在窗口里一分钟判一次。
// 期望值:tests/fixtures/gen_svc_events.mjs(原 EventsService 对着脚本驱动的假 router / 假取数器、真的交易库、虚拟钟现跑),tests/tst_svc_events.cpp。
//
// 与 TS 的对应与不同:
//   · 事件 / 配置 / 清单是 JS 对象:OJson(键序同 TS 的对象字面量)。fetcher 是 analysis::macro::Fetcher(url, 毫秒 → Task<OJson>);缺省的取数器
//     是 publicFetch(Exchange,见 public_fetch.h 里与 fetch 的差别)。
//   · Date.now() / Math.random() → nowFn(缺省 util::dateNow)/ runtime().random()。add 里的 id `custom:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
//     用文件内的 toRadix(V8 DoubleToRadixCString 的算法;util/jsformat 没有进制转换——建议主会话收进去)。
//   · macroBoard 的 router 面:TS 传 `{ streamQuotes: () => live }`(同步),这里 BoardOptions.streamQuotes 同。macro 模块自己有进程级缓存(clearMacroCache)。
//   · inflight(日历拉取 / 跨市场判断):TS 在 async 函数里 finally 清;这里看 Task::done()。同一时刻的两次 list 拿同一个在途的 Task。
//   · `void this.refreshFeed()`(后台刷新):util::detach,错误吞掉(refreshFeed 自己已把失败记进 feedError,不会抛)。
#pragma once

#include "analysis/macro.h"
#include "orchestrate/services/svc_host.h"

#include <QList>

#include <functional>
#include <optional>

namespace ibkr::orchestrate {

/// Number.prototype.toString(radix)(非负有限数;V8 的算法)。util/jsformat 没有进制转换,暂放这里,建议主会话收进去
QString toRadixString(double value, int radix);

class EventsService : public SvcBase {
public:
    static inline const QString kConfigPref = QStringLiteral("events_config");
    static inline const QString kCustomPref = QStringLiteral("events_custom");
    /// 公开日历:本周所有国家的宏观事件,带影响档位与预期前值。隐私说明里有它(docs/legal/privacy.md)
    static inline const QString kFeedUrl = QStringLiteral("https://nfs.faireconomy.media/ff_calendar_thisweek.json");
    static constexpr double kFeedTtlMs = 4 * 60 * 60'000.0;
    static constexpr double kRetryMs = 30 * 60'000.0;
    static constexpr double kTimeoutMs = 8'000;
    /// 清单的窗口:昨天起、两周止
    static constexpr double kLookbackMs = 24 * 60 * 60'000.0;
    static constexpr double kHorizonMs = 14 * 24 * 60 * 60'000.0;
    static constexpr int kMaxCustom = 50;
    static constexpr double kCrossTtlMs = 60'000;

    explicit EventsService(SvcHost& host);

    /// 取数器(测试换成脚本驱动的)与时钟
    analysis::macro::Fetcher fetcher;
    std::function<double()> nowFn;

    // ---- 口径
    util::OJson config();
    util::OJson setConfig(const util::OJson& input);

    // ---- 自定义事件
    struct AddParams {
        QString title, date_et, time_et;
        std::optional<QString> note;
        std::optional<QString> impact;  // high / medium
        std::optional<double> linger_min;
    };
    util::OJson add(const AddParams& params);
    bool remove(const QString& id);

    // ---- 清单
    util::Task<util::OJson> list(bool force = false);

private:
    struct CustomRow {
        QString id, title, date_et, time_et, note, impact;
        double linger_min = 0;
    };
    QList<CustomRow> customRows();
    QList<util::OJson> customEvents();
    bool feedStale(double now) const;
    util::Task<> refreshFeed();
    util::Task<> refreshCross(double now, util::OJson config);
    struct CrossResult {
        util::OJson event;
        util::OJson status;
    };
    util::Task<CrossResult> cross(double now, util::OJson config);
    double now() const { return nowFn(); }

    QList<util::OJson> feedRows_;
    std::optional<double> feedAt_, feedTriedAt_;
    std::optional<QString> feedError_;
    std::optional<util::Task<>> inflight_;
    util::OJson crossEvent_ = util::OJson::null();
    std::optional<double> crossAt_;
    std::optional<QString> crossError_;
    std::optional<util::Task<>> crossInflight_;
};

}  // namespace ibkr::orchestrate
