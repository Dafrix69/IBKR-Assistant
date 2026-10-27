#include "domain/follow_inbox.h"

#include "util/js_runtime.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/tz.h"

#include <QFile>
#include <QFileInfo>
#include <QRegularExpression>

#include <algorithm>
#include <cmath>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;

namespace ibkr::domain {

namespace {
QString squashBreaks(QString s) {
    static const QRegularExpression re(u"[\\r\\n]+"_s);
    return s.replace(re, u" "_s);
}
}  // namespace

QString inboxPath(const QString& dbPath) { return QFileInfo(dbPath).path() + u'/' + kInboxFile; }

QString localAuthorId(const QString& name) { return u"local:"_s + util::jsTrim(squashBreaks(name)).left(kLocalNameMax); }

ParsedInboxLine parseInboxLine(const QString& line) {
    const auto raw = js::parse(line);
    if (!raw) return {false, {}, u"不是 JSON"_s};
    if (raw->type != OJson::Object) return {false, {}, u"不是对象"_s};
    const OJson* v = raw->get(u"v"_s);
    if (!(v && v->type == OJson::Number && v->n == 1)) return {false, {}, u"不认识的版本 v="_s + js::str(v)};
    const auto str = [&](const char16_t* k) -> std::optional<QString> {
        const OJson* x = raw->get(QString::fromUtf16(k));
        return x && x->type == OJson::String ? std::optional<QString>(x->s) : std::nullopt;
    };
    const QString key = str(u"key") ? util::jsTrim(*str(u"key")) : QString();
    if (key.isEmpty() || key.size() > 120) return {false, {}, u"key 缺了或太长"_s};
    const QString author = str(u"author") ? util::jsTrim(squashBreaks(*str(u"author"))) : QString();
    if (author.isEmpty()) return {false, {}, u"author 缺了"_s};
    const auto content = str(u"content");
    if (!content) return {false, {}, u"content 缺了"_s};
    const double sentAtMs = util::jsDateParse(str(u"seen_at").value_or(QString()));
    if (!std::isfinite(sentAtMs)) return {false, {}, u"seen_at 不是时刻"_s};
    return {true,
            js::object({{u"id"_s, js::S(u"local:"_s + key)},
                        {u"channel_id"_s, js::S(kLocalChannel)},
                        {u"author_id"_s, js::S(localAuthorId(author))},
                        {u"author_name"_s, js::S(author.left(kLocalNameMax))},
                        {u"content"_s, js::S(*content)},
                        {u"sentAtMs"_s, js::N(sentAtMs)}}),
            {}};
}

QList<OJson> readInboxTail(const QString& path, int max) {
    constexpr qint64 kTailBytes = 256 * 1024;
    QFile f(path);
    if (max <= 0 || !f.open(QIODevice::ReadOnly)) return {};
    const qint64 from = std::max<qint64>(0, f.size() - kTailBytes);
    if (!f.seek(from)) return {};
    QStringList lines = util::nodeUtf8(f.readAll()).split(u'\n');
    lines.removeLast();                     // 没有换行收尾的那一段(正写到一半,或文件本来就以换行结尾时的空串)
    if (from > 0 && !lines.isEmpty()) lines.removeFirst();  // 从中间读起的第一行不完整
    QList<OJson> out;
    for (qsizetype i = lines.size() - 1; i >= 0 && out.size() < max; --i) {
        const QString trimmed = util::jsTrim(lines[i]);
        if (trimmed.isEmpty()) continue;
        ParsedInboxLine parsed = parseInboxLine(trimmed);
        if (parsed.ok) out.prepend(std::move(parsed.message));
    }
    return out;
}

FollowInbox::FollowInbox(QString path, Hooks hooks, int intervalMs, QObject* parent)
    : QObject(parent), path_(std::move(path)), hooks_(std::move(hooks)), intervalMs_(intervalMs) {
    connect(&timer_, &QTimer::timeout, this, &FollowInbox::poll);
}

void FollowInbox::start() {
    if (timer_.isActive()) return;
    const QFileInfo fi(path_);
    offset_ = fi.exists() ? fi.size() : 0;
    partial_.clear();
    timer_.start(intervalMs_);
}

void FollowInbox::stop() { timer_.stop(); }

void FollowInbox::poll() {
    const QFileInfo fi(path_);
    if (!fi.exists()) {
        // 看不见有两种:真的还没建(脚本没起过,不算错,等它出现)与目录进不去(TS 的 statSync 报 EACCES,要报出来)
        const QFileInfo parent(fi.absolutePath());
        if (parent.exists() && !parent.isExecutable()) {
            fail(u"读不了收件文件:EACCES: permission denied, stat '%1'"_s.arg(path_));
            return;
        }
        offset_ = 0;
        return;
    }
    const qint64 size = fi.size();
    if (size < offset_) {
        offset_ = 0;  // 变短了:被清空或换了一个文件,从头读
        partial_.clear();
    }
    if (size == offset_) return;
    QFile f(path_);
    if (!f.open(QIODevice::ReadOnly) || !f.seek(offset_)) {
        fail(u"读不了收件文件:EACCES: permission denied, open '%1'"_s.arg(path_));
        return;
    }
    const QByteArray buf = f.read(size - offset_);
    offset_ += buf.size();
    const QString text = partial_ + util::nodeUtf8(buf);
    QStringList lines = text.split(u'\n');
    partial_ = lines.takeLast();  // 最后一段没换行:脚本可能正写到一半,留到下一次
    for (const QString& line : lines) {
        const QString trimmed = util::jsTrim(line);
        if (trimmed.isEmpty()) continue;
        const ParsedInboxLine parsed = parseInboxLine(trimmed);
        if (!parsed.ok) {
            fail(u"收件文件里有一行认不出(%1),跳过:%2"_s.arg(parsed.error, trimmed.left(80)));
            continue;
        }
        received += 1;
        lastAt = util::isoString(util::dateNow());
        lastError_.reset();
        if (hooks_.onMessage) hooks_.onMessage(parsed.message);
    }
}

void FollowInbox::fail(const QString& error) {
    if (lastError_ == error) return;
    lastError_ = error;
    if (hooks_.onError) hooks_.onError(error);
}

}  // namespace ibkr::domain
