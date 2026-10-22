#include "shell/track_actions.h"

#include "shell/jsvalue.h"
#include "shell/track_rules.h"

#include <memory>

using namespace Qt::StringLiterals;

namespace ibkr::shell::track {

void toggleTrack(const QJsonObject& t, const ActionDeps& deps) {
    deps.busy(u"toggle"_s);
    deps.update(QJsonObject{{u"id"_s, t.value("id"_L1)}, {u"enabled"_s, !jsTruthy(t.value("enabled"_L1))}}, [deps](const QJsonValue&, const QString& error) {
        if (!error.isEmpty()) {
            deps.banner(error, false);
            return deps.busy(QString());
        }
        deps.reload(false, [deps] { deps.busy(QString()); });
    });
}

void closeTrackNow(const QJsonObject& t, const ActionDeps& deps) {
    const QString id = jsString(t.value("id"_L1));
    const QJsonObject box{
        {u"purpose"_s, u"tracker.close_now"_s},
        {u"binding"_s, QJsonObject{{u"id"_s, t.value("id"_L1)}}},
        {u"title"_s, u"立即平仓"_s},
        {u"message"_s, u"马上把 %1 的持仓平掉?账户 %2。"_s.arg(legLabel(t.value("symbol"_L1).toString(), t.value("sec_type"_L1).toString(), t.value("contract"_L1).toObject()),
                                                          jsString(t.value("account"_L1)))},
        {u"detail"_s, u"这会立刻发出一张平仓单,和到价自动平仓走的是同一条路。"_s},
        {u"confirmLabel"_s, u"平仓"_s},
    };
    deps.confirm(box, [deps, id](bool ok) {
        if (!ok) return;
        deps.busy(u"close"_s);
        deps.closeNow(id, [deps](const QJsonValue& res, const QString& error) {
            if (!error.isEmpty()) {
                deps.banner(error, false);
                return deps.busy(QString());
            }
            const QJsonValue reason = res[u"fired"][u"reason"];
            deps.banner(u"平仓单已发出:"_s + (reason.isNull() || reason.isUndefined() ? QString() : jsString(reason)), true);
            // 持仓与交易记录一起重读(Promise.all),两样都完了才收起转圈
            auto left = std::make_shared<int>(2);
            const auto done = [deps, left] {
                if (--*left == 0) deps.busy(QString());
            };
            deps.reload(true, done);
            deps.records();
            done();
        });
    });
}

void removeTrack(const QJsonObject& t, const ActionDeps& deps) {
    const QString id = jsString(t.value("id"_L1));
    const QJsonObject box{{u"title"_s, u"删除追踪"_s},
                          {u"message"_s, u"不再追踪 %1?"_s.arg(t.value("symbol"_L1).toString())},
                          {u"detail"_s, u"只删除追踪设置,不影响持仓本身。"_s},
                          {u"confirmLabel"_s, u"删除"_s}};
    deps.confirm(box, [deps, id](bool ok) {
        if (!ok) return;
        deps.busy(u"delete"_s);
        deps.remove(id, [deps](const QJsonValue&, const QString& error) {
            if (!error.isEmpty()) {
                deps.banner(error, false);
                return deps.busy(QString());
            }
            deps.reload(false, [deps] { deps.busy(QString()); });
        });
    });
}

}  // namespace ibkr::shell::track
