#include "orchestrate/services/assignment_watch.h"

#include "analysis/assignment_risk.h"
#include "util/jsobj.h"

#include <cmath>

namespace ibkr::orchestrate {

using namespace Qt::StringLiterals;
using util::OJson;
using util::Task;
namespace js = util::js;
namespace ar = analysis::assignment_risk;

AssignmentWatchService::~AssignmentWatchService() {
    *alive_ = false;
    stop();
}

void AssignmentWatchService::start(int tickMs) {
    if (running_) return;
    const int gen = ++gen_;
    running_ = true;
    timer_ = rt().setTimeout(tickMs, [this, alive = std::weak_ptr<bool>(alive_), tickMs, gen] {
        if (alive.expired()) return;
        util::detach(loop(tickMs, gen));
    });
}

Task<> AssignmentWatchService::loop(int tickMs, int gen) {
    const std::weak_ptr<bool> alive = alive_;
    try {
        co_await tickOnce();
    } catch (...) {
    }
    if (alive.expired() || gen != gen_ || !running_) co_return;
    timer_ = rt().setTimeout(tickMs, [this, alive, tickMs, gen] {
        if (alive.expired()) return;
        util::detach(loop(tickMs, gen));
    });
}

void AssignmentWatchService::stop() {
    gen_ += 1;
    running_ = false;
    if (timer_ != 0) rt().clearTimeout(timer_);
    timer_ = 0;
}

bool AssignmentWatchService::inWindow(const domain::EtNow& at) const {
    const double close = settings().early_close_days.contains(at.date) ? 13 * 60 : 16 * 60;
    return at.minutes >= close - kLeadMinutes && at.minutes < close;
}

Task<double> AssignmentWatchService::tickOnce(std::optional<domain::EtNow> atArg) {
    const domain::EtNow at = atArg ? *atArg : domain::nowEt();
    if (!inWindow(at)) co_return 0;
    const auto router = routerPort();
    if (!router || !router->hasSessions()) co_return 0;
    QList<OJson> rows;
    try {
        rows = co_await router->positions();
    } catch (...) {
        co_return 0;  // 读不到持仓:下一轮再看
    }
    QString today = at.date;
    today.replace(u"-"_s, QString());
    const QList<OJson> legs = ar::expiringOptionLegs(rows, today, [this](const OJson* symbol) { return settings().indexConfig(js::str(symbol)) != nullptr; });
    QStringList symbols;
    for (const OJson& l : legs) {
        if (js::num(js::prop(&l, u"quantity"_s)) < 0) {
            const QString s = js::str(js::prop(&l, u"symbol"_s));
            if (!symbols.contains(s)) symbols.append(s);
        }
    }
    if (symbols.isEmpty()) co_return 0;
    OJson spots = js::object();
    try {
        const OJson quotes = co_await router->streamQuotes(symbols);
        for (const QString& symbol : symbols) {
            if (js::nullish(&quotes)) throw util::JsError(u"Cannot read properties of null (reading '%1')"_s.arg(symbol));
            const double last = js::num(js::prop(js::prop(&quotes, symbol), u"last"_s));
            spots.set(symbol, (std::isfinite(last) && last > 0) ? js::N(last) : js::Null());
        }
    } catch (...) {
        /* 拿不到现价:照样提醒"今天到期,自己看一眼" */
    }
    if (toldDate_ != at.date) {
        told_.clear();
        toldDate_ = at.date;
    }
    double sent = 0;
    for (const OJson& notice : ar::assignmentNotices(legs, spots)) {
        const OJson* noticeLegs = js::prop(&notice, u"legs"_s);
        const bool blind = js::prop(&notice, u"spot"_s)->type == OJson::Null;
        const QString tag = blind ? u"blind"_s : u"itm"_s;
        bool anyFresh = false;
        for (const OJson& l : noticeLegs->items)
            if (!told_.contains(js::str(js::prop(&l, u"key"_s)) + u'|' + tag)) anyFresh = true;
        if (!anyFresh) continue;
        for (const OJson& l : noticeLegs->items) told_.insert(js::str(js::prop(&l, u"key"_s)) + u'|' + tag);
        const QString text = ar::noticeText(notice);
        OJson legsJson = js::array();
        for (const OJson& l : noticeLegs->items)
            legsJson.items.append(js::object({{u"strike"_s, js::copyOrNull(js::prop(&l, u"strike"_s))},
                                              {u"right"_s, js::copyOrNull(js::prop(&l, u"right"_s))},
                                              {u"quantity"_s, js::copyOrNull(js::prop(&l, u"quantity"_s))},
                                              {u"itm_by"_s, js::copyOrNull(js::prop(&l, u"itm_by"_s))}}));
        const OJson detail = js::object({{u"account"_s, js::copyOrNull(js::prop(&notice, u"account"_s))},
                                         {u"symbol"_s, js::copyOrNull(js::prop(&notice, u"symbol"_s))},
                                         {u"spot"_s, js::copyOrNull(js::prop(&notice, u"spot"_s))},
                                         {u"net_shares"_s, js::copyOrNull(js::prop(&notice, u"net_shares"_s))},
                                         {u"legs"_s, legsJson}});
        store().audit(u"engine"_s, u"assignment_risk"_s, &detail);
        try {
            eng().notifier().notify(u"到期日:空头腿可能被指派"_s, text, js::str(js::prop(&notice, u"symbol"_s)));
        } catch (...) {
            /* 通知发不出去不影响下一条 */
        }
        emitEvent(u"assignment_risk"_s, js::object({{u"account"_s, js::copyOrNull(js::prop(&notice, u"account"_s))},
                                                     {u"symbol"_s, js::copyOrNull(js::prop(&notice, u"symbol"_s))},
                                                     {u"text"_s, js::S(text)}}));
        sent += 1;
    }
    co_return sent;
}

}  // namespace ibkr::orchestrate
