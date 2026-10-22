// 盯盘的提前醒:期权行情推送一到,不等下一拍就判一次"该不该马上跑一轮",以及追价按跌速多让要的那几笔立刻成交价。
// C++ 先有(TS 版没有;docs/features/tracker.md「快速下跌的追价」「盯盘节拍」)。
//
// 节拍器一秒一轮,行情在两拍之间冲过止盈 / 回撤线,最多要等一秒多才看见;快速下跌时这一秒就是追不上的那一截。
// 这里**不做任何交易决定**:只从常驻订阅的缓存里拼出这只蝶此刻的价,拿盯盘同一个纯函数(tracker::evaluate + withTier)问一句,
// 越线了(或者正在追价、价又动了、离上次改价够了一个间隔)就叫节拍器马上排一轮——判触发、过闸门、发单、追价,全走那一轮原样的代码。
// 所以这一路出错的最坏结果是"多跑一轮"或"没提前醒",不会多发一张单。
// 只看期权与组合(推送来自期权行情流);标的目标价 / 标的止损价看的是指数,不在这里提前醒,照节拍判。状态只在内存里。
#pragma once

#include "analysis/tracker_rules.h"
#include "domain/config.h"
#include "orchestrate/tracker.h"
#include "util/ordered_json.h"

#include <QHash>
#include <QList>
#include <QString>

#include <functional>
#include <optional>

namespace ibkr::orchestrate {

class EngineRouter;

class FastExit {
public:
    using Rec = util::OJson;
    /// router 现取(券商会重连、引擎会换 router);wake = 推送判定该醒了
    FastExit(std::function<EngineRouter*()> router, std::function<void()> wake) : router_(std::move(router)), wake_(std::move(wake)) {}
    ~FastExit() { stop(); }
    FastExit(const FastExit&) = delete;
    FastExit& operator=(const FastExit&) = delete;

    /// 跟上此刻的 router:换了就把推送接到新的上。每一轮开头叫一次,幂等
    void attach();
    /// 节拍器停了:撤掉推送、清空要盯的
    void stop();
    /// 这一轮还没排出结果(醒后等待、没有追踪、读不到持仓):先不盯
    void disarm() { watches_.clear(); }
    /// 按这一轮的结果排要盯的追踪。rows = 盯盘这一轮的行(追踪 + 结论 + 持仓行);positions = 同一轮的持仓(含组合行);
    /// tp(tid) = 标的目标价这一轮落在哪个止盈价上(只认市场价算出来的);chasing(tid) = 引擎的追价表里有没有它(这一轮刚发的平仓单,行里看不出来)
    void arm(const QList<Rec>& rows, const Rec& positions, const std::function<std::optional<double>(const QString&)>& tp, const domain::EtNow& at,
             const std::function<bool(const QString&)>& chasing);
    /// 从缓存拼价、问一句;该醒就叫 wake。同步,测试直接叫它
    void check(double nowMs);
    /// 追价与首单要多让多少:先把这一笔立刻成交价记下,再按"一个改价间隔之前到此刻跌了多少"× 倍数(auto_close.chase_lead,没填按 1)
    double leadFor(const Rec& raw, const tracker::Position& position, double natural, const Rec& autoClose, double nowMs);

private:
    struct Watch {
        QString tid, key;
        QList<Rec> legRows;
        tracker::Position position;
        tracker::TargetStructure structure;
        Rec targets, autoClose;
        std::optional<double> peak;
        double minute = 0;
        bool chasing = false;
        double roundAt = 0;
        std::optional<double> roundNatural;
        bool woke = false;
    };
    void onTick();
    void observe(const QString& key, double natural, double nowMs);
    Rec legBook(const Watch& w, const Rec& book) const;
    std::optional<double> midOf(const Watch& w, const Rec& book) const;

    std::function<EngineRouter*()> router_;
    std::function<void()> wake_;
    QList<Watch> watches_;
    QHash<QString, QList<analysis::NaturalObs>> obs_;
    EngineRouter* attachedTo_ = nullptr;
    std::function<void()> detach_;
    bool queued_ = false;
    std::shared_ptr<bool> alive_ = std::make_shared<bool>(true);
};

}  // namespace ibkr::orchestrate
