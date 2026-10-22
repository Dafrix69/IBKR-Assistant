#include "util/notify.h"

#include "util/py.h"

#include <QProcess>

#include <cstdio>

namespace ibkr::util {

using namespace Qt::StringLiterals;

Notifier::Notifier(bool on, std::vector<Sink> extraSinks) : enabled(on), sinks(std::move(extraSinks)) {
    runOsascript = [](const QString& script) { QProcess::startDetached(u"osascript"_s, {u"-e"_s, script}); };
}

QString appleScriptQuote(const QString& text) {
    QString s = text;
    s.replace(u'\\', u"\\\\"_s).replace(u'"', u"\\\""_s).replace(u'\n', u' ');
    return u'"' + s + u'"';
}

void Notifier::notify(const QString& title, const QString& body, const QString& subtitle, bool os) {
    history.emplace_back(title, subtitle, body);
    for (const Sink& sink : sinks) sink(title, subtitle, body);
    if (!os) return;
    if (!enabled) return;
#if !defined(Q_OS_MACOS)
    std::fprintf(stderr, "%s\n", qPrintable(u"[通知] %1 | %2 | %3"_s.arg(title, subtitle, body)));
    return;
#else
    runOsascript(u"display notification %1 with title %2 subtitle %3"_s.arg(appleScriptQuote(body), appleScriptQuote(title), appleScriptQuote(subtitle.isEmpty() ? u" "_s : subtitle)));
#endif
}

void Notifier::rejection(const QString& code, const QString& message) { notify(u"指令被拒绝"_s, message, code); }
void Notifier::warning(const QString& message) { notify(u"下单提醒"_s, message, u"warning"_s); }
void Notifier::fill(const QString& symbol, const QString& action, double qty, double price, const QString& account) {
    notify(u"成交回报"_s, u"%1 %2 %3 @ %4"_s.arg(action, symbol, pyG(qty), fmtF(price, 4)), u"账户 "_s + account);
}
void Notifier::breaker(const QString& reason) { notify(u"已熔断:自动执行暂停"_s, reason, u"circuit breaker"_s); }

}  // namespace ibkr::util
