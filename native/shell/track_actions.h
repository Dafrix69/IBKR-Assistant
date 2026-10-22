// 追踪卡片上三个按钮按下去做什么(desktop/renderer-react/src/lib/TrackCard.tsx 的 toggle / closeNow / remove,逐句搬):
// 暂停 / 恢复、立即平仓(会真的发单:确认框绑这条追踪的 id)、删除追踪。和引擎、确认框、横幅打交道的几样由调用方注入。
// 期望值:tests/fixtures/gen_track_actions.mjs 把原文件里的三个函数切出来跑,记下每一步。
#pragma once

#include <QJsonObject>
#include <QJsonValue>
#include <QString>

#include <functional>

namespace ibkr::shell::track {

struct ActionDeps {
    using Reply = std::function<void(const QJsonValue& result, const QString& error)>;
    /// 确认框;done(点了确认没有)
    std::function<void(const QJsonObject& options, std::function<void(bool)>)> confirm;
    /// tracker.update { id, enabled }
    std::function<void(const QJsonObject& spec, Reply)> update;
    /// tracker.close_now { id }
    std::function<void(const QString& id, Reply)> closeNow;
    /// tracker.delete { id }
    std::function<void(const QString& id, Reply)> remove;
    /// 重读追踪(refreshPositions:顺带重读持仓),读完再调 done
    std::function<void(bool refreshPositions, std::function<void()> done)> reload;
    /// 交易记录跟着重读
    std::function<void()> records;
    std::function<void(const QString& text, bool info)> banner;
    /// 哪个按钮在转圈:toggle / close / delete;空 = 没有
    std::function<void(const QString& busy)> busy;
};

void toggleTrack(const QJsonObject& track, const ActionDeps& deps);
void closeTrackNow(const QJsonObject& track, const ActionDeps& deps);
void removeTrack(const QJsonObject& track, const ActionDeps& deps);

}  // namespace ibkr::shell::track
