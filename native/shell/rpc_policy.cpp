#include "shell/rpc_policy.h"

#include <QHash>

namespace ibkr::shell {

using namespace Qt::StringLiterals;

const QSet<QString>& allowedRpc() {
    static const QSet<QString> set{
        u"system.status"_s, u"system.selftest"_s, u"instruction.submit"_s, u"records.list"_s, u"records.get"_s,
        u"pending.list"_s, u"pending.poll"_s, u"breaker.state"_s, u"breaker.halt"_s, u"breaker.resume"_s,
        u"broker.catalog"_s, u"broker.select"_s, u"broker.connect"_s, u"broker.disconnect"_s,
        u"tws.scan"_s, u"tws.diagnose"_s, u"tws.launch"_s,
        u"futu.scan"_s, u"futu.diagnose"_s, u"futu.launch"_s, u"futu.unlock"_s, u"futu.set_password"_s,
        u"llm.catalog"_s, u"llm.patch"_s, u"llm.test"_s, u"settings.get"_s, u"settings.patch"_s,
        u"ideas.add"_s, u"ideas.list"_s, u"ideas.update"_s, u"ideas.analyze"_s, u"ideas.digest"_s, u"ideas.digests"_s,
        u"ideas.search"_s, u"ideas.similar_trades"_s,
        u"sectors.list"_s, u"sectors.add"_s, u"sectors.delete"_s, u"sectors.pick"_s, u"sectors.quotes"_s,
        u"sectors.add_stock"_s, u"sectors.remove_stock"_s, u"sectors.set_tag"_s, u"pool.set_watch"_s,
        u"screener.rs"_s, u"screener.inflection"_s, u"screener.deviation"_s, u"screener.leaders"_s,
        u"backtest.strategies"_s, u"backtest.run"_s, u"backtest.sweep"_s, u"backtest.parse_rules"_s,
        u"book.snapshot"_s, u"options.wall"_s, u"options.fly_plan"_s, u"options.iv_recorder"_s, u"options.iv_recorder_set"_s,
        u"options.spot"_s, u"options.playbook"_s, u"options.playbook_set"_s,
        u"alerts.list"_s, u"alerts.create"_s, u"alerts.delete"_s, u"alerts.refresh"_s, u"alerts.poll"_s, u"alerts.set_touch_config"_s,
        u"pa.timeframes"_s, u"pa.analyze"_s, u"pa.comment"_s, u"macro.board"_s, u"positions.list"_s,
        u"review.candidates"_s, u"review.analyze"_s, u"review.performance"_s, u"review.signals"_s,
        u"tracker.list"_s, u"tracker.add"_s, u"tracker.update"_s, u"tracker.delete"_s, u"tracker.poll"_s,
        u"tracker.reconcile"_s, u"tracker.close_now"_s, u"tracker.target_preview"_s,
        u"quality.list"_s, u"quality.add"_s, u"quality.update"_s, u"quality.remove"_s, u"quality.set_config"_s,
        u"keychain.set"_s, u"data.export"_s, u"data.backups"_s, u"data.backup"_s,
        u"follow.status"_s, u"follow.set_token"_s, u"follow.reconnect"_s,
        u"events.list"_s, u"events.set_config"_s, u"events.add"_s, u"events.remove"_s,
        u"intel.feed"_s, u"intel.dossier"_s,
    };
    return set;
}

const QSet<QString>& sensitiveRpc() {
    static const QSet<QString> set{
        u"instruction.submit"_s, u"settings.patch"_s, u"broker.connect"_s, u"keychain.set"_s, u"tws.launch"_s, u"llm.patch"_s,
        u"broker.select"_s, u"futu.launch"_s, u"futu.unlock"_s, u"futu.set_password"_s,
        u"tracker.add"_s, u"tracker.update"_s, u"tracker.close_now"_s, u"follow.set_token"_s,
    };
    return set;
}

const QSet<QString>& outcomeUnknownRpc() {
    static const QSet<QString> set{u"instruction.submit"_s, u"tracker.add"_s, u"tracker.update"_s, u"tracker.close_now"_s};
    return set;
}

QString outcomeLabel(const QString& method) {
    static const QHash<QString, QString> labels{
        {u"instruction.submit"_s, u"发送指令"_s},
        {u"tracker.add"_s, u"建立追踪"_s},
        {u"tracker.update"_s, u"修改追踪"_s},
        {u"tracker.close_now"_s, u"立即平仓"_s},
    };
    return labels.value(method, method);
}

}  // namespace ibkr::shell
